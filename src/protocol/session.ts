/**
 * The bridge protocol, runner side: attach to a Peeps agent session, long-poll
 * for tool calls, run each one, post its outcome, and leave when Peeps ends
 * the session, when it expires, or when Peeps cannot be reached.
 *
 * It knows nothing about browsers or files: a caller supplies the tools it
 * offers and a `handle` that runs one call. `peeps-action`'s CI agent and the
 * local `peeps-bridge` runner share it.
 *
 * The server's contract (Peeps `src/app/api/v1/bridge/sessions/[sessionId]/*`):
 * - `POST …/attach` `{ tools, runnerInfo }` → `{ sessionId, kind, expiresAt }`.
 * - `GET …/calls?wait=25` → `{ call }`, 204 when idle, 410 when over. Every
 *   poll is the heartbeat; a runner silent for 3 minutes is presumed dead, so
 *   the backoff below stays far inside that.
 * - `POST …/calls/<id>/result` `{ ok: true, result }` or `{ ok: false, error }`.
 *   It is also a heartbeat, and answers 410 once the session is over.
 * - `POST …/detach` (no body): a local runner that stops (Ctrl-C) says so, so
 *   Peeps ends the session at once instead of waiting out the heartbeat.
 *   200 `{ sessionId, status }`, `status` being `ended` or `already_over`; it
 *   is idempotent, and ends the session even with a call outstanding. Peeps
 *   refuses it for CI (403 `local_runner_only`). Sent at most once, only with
 *   `detachOnStop`, only to a session this runner attached to: on a stop,
 *   after the call in hand is answered, or earlier through `exposeDetach`
 *   for a forced exit. One short deadline covers it, no retry: a failure is
 *   one log line and the runner leaves anyway. Never after the runner itself
 *   left for a 410, expiry, lost contact or a refusal: the session is already
 *   over, or this runner may not speak for it. (A stop after `expiresAt`
 *   passed but before the runner noticed does detach; that is harmless.)
 * - 401 `invalid_token` (any failed grant or authority check), 409
 *   `other_runner` / `other_job` / `playwright_mcp_version`, 404 `not_found`.
 */

export interface BridgeToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BridgeCall {
  id: string;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
}

export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: string };

export interface BridgeSessionOptions {
  /** Peeps' base URL, e.g. `https://app.peepsai.com`. */
  server: string;
  sessionId: string;
  /** The full `Authorization` header value; called before every request. */
  authorization: () => string | Promise<string>;
  /** Extra headers on every request (a local runner's `x-peeps-runner-instance`). */
  headers?: Record<string, string>;
  tools: BridgeToolSpec[];
  runnerInfo: Record<string, unknown>;
  handle: (call: BridgeCall) => Promise<CallOutcome>;
  log: (line: string) => void;
  /** Stops the loop; a call in hand is still answered. */
  signal?: AbortSignal;
  /** Test seams. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onPoll?: () => void;
  /**
   * How long one request may take before it counts as a transport error, so a
   * connection that went silent (a laptop waking from sleep) cannot hang the
   * runner. Comfortably above the 25-second long poll.
   */
  requestTimeoutMs?: number;
  /**
   * Tell Peeps when the signal stops the runner (`POST …/detach`), so the
   * session ends at once. A local runner's; Peeps refuses it for CI.
   */
  detachOnStop?: boolean;
  /** How long the whole detach may take; short, so it never holds up exit. */
  detachTimeoutMs?: number;
  /**
   * Hands the caller `detachNow`, the same once-only detach a stop sends, for
   * a forced exit that cannot wait for the loop (a call in hand that will not
   * finish). It does nothing unless `detachOnStop` is set, before the runner
   * attached, after it left (410, expiry, lost contact, a refusal) or once a
   * detach was sent; it never rejects.
   */
  exposeDetach?: (detachNow: () => Promise<void>) => void;
}

export type SessionEndReason =
  /** Peeps ended the session (410). */
  | "session_over"
  /** The session's `expiresAt` passed. */
  | "expired"
  /** 8 consecutive transport errors. */
  | "lost_contact"
  /** The caller's signal aborted (Ctrl-C). */
  | "stopped";

export interface SessionEnd {
  reason: SessionEndReason;
  handled: number;
}

/** Peeps refused this runner; retrying will not help. */
export class BridgeRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeRefusedError";
  }
}

export const LONG_POLL_SECONDS = 25;
export const MAX_TRANSPORT_ERRORS = 8;
/** The result route's own limit on `error`. */
const MAX_ERROR_CHARS = 4000;
const RESULT_ATTEMPTS = 3;
/**
 * The most the whole detach may take, authorization included: no longer than
 * the bin's 3-second close grace, so a forced exit never waits on it longer.
 */
const DETACH_TIMEOUT_MS = 3_000;

class SessionOver extends Error {}
class Stopped extends Error {}

interface Answer {
  status: number;
  body: unknown;
}

const backoffMs = (consecutiveErrors: number) => 2000 * consecutiveErrors;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function runBridgeSession(options: BridgeSessionOptions): Promise<SessionEnd> {
  const { signal, log } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, signal));
  const base = options.server.replace(/\/+$/, "");
  const sessionPath = `/api/v1/bridge/sessions/${encodeURIComponent(options.sessionId)}`;
  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  let handled = 0;
  let transportErrors = 0;
  let attachedOnce = false;
  /** The session ended without a stop (410, expiry, lost contact, refusal). */
  let left = false;
  let detaching: Promise<void> | null = null;
  /**
   * Tell Peeps the runner is leaving: at most once per session, only with
   * `detachOnStop`, only once attached and not after the runner left for any
   * reason but a stop. A second caller gets the first one's promise. Never
   * rejects.
   */
  const detachNow = (): Promise<void> => {
    if (!options.detachOnStop || !attachedOnce || left) return Promise.resolve();
    detaching ??= detach();
    return detaching;
  };
  options.exposeDetach?.(detachNow);

  /**
   * One request. Answers the response, or null for a transport error (no
   * answer, or a 5xx/429 from something between us and Peeps).
   */
  const request = async (
    method: "GET" | "POST",
    path: string,
    body: unknown,
    abortable: boolean,
  ): Promise<Answer | null> => {
    try {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...options.headers,
          authorization: await options.authorization(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Never follow: a 307/308 would re-send the grant, the instance id
        // and the body to wherever it points.
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), ...(abortable && signal ? [signal] : [])]),
      });
      const text = await response.text();
      if (response.status >= 300 && response.status < 400) return { status: response.status, body: { error: "redirect" } };
      if (response.status >= 500 || response.status === 429) return null;
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: response.status, body: parsed };
    } catch {
      if (abortable && signal?.aborted) throw new Stopped();
      return null;
    }
  };

  /** A transport error: count it, back off, or give up. */
  const transportError = async (what: string): Promise<boolean> => {
    transportErrors += 1;
    if (transportErrors >= MAX_TRANSPORT_ERRORS) {
      log(`lost contact with Peeps after ${transportErrors} failed attempts in a row; leaving`);
      return false;
    }
    log(`${what} failed (${transportErrors}/${MAX_TRANSPORT_ERRORS}); retrying`);
    await sleep(backoffMs(transportErrors));
    return true;
  };

  /** A non-2xx answer that is not a transport error. */
  const refusal = (answer: Answer): never => {
    if (answer.status === 410) throw new SessionOver();
    throw refusalError(answer);
  };

  /** Serve until the session ends or the signal stops it. */
  const serve = async (): Promise<SessionEnd> => {
    try {
      if (signal?.aborted) throw new Stopped();

      // Attach.
      let attached: { kind?: string; expiresAt?: string } | null = null;
      while (!attached) {
        const answer = await request("POST", `${sessionPath}/attach`, { tools: options.tools, runnerInfo: options.runnerInfo }, true);
        if (!answer) {
          if (!(await transportError("attach"))) return { reason: "lost_contact", handled };
          continue;
        }
        if (answer.status !== 200) refusal(answer);
        attached = (answer.body ?? {}) as { kind?: string; expiresAt?: string };
      }
      transportErrors = 0;
      attachedOnce = true;
      const expiresAt = attached.expiresAt ? Date.parse(attached.expiresAt) : Number.POSITIVE_INFINITY;
      log(`attached to session ${options.sessionId} (${attached.kind ?? "unknown kind"}); it expires at ${attached.expiresAt ?? "an unknown time"}`);

      for (;;) {
        if (signal?.aborted) throw new Stopped();
        if (now() >= expiresAt) {
          log("the session's time is up; leaving");
          return { reason: "expired", handled };
        }
        options.onPoll?.();
        const answer = await request("GET", `${sessionPath}/calls?wait=${LONG_POLL_SECONDS}`, undefined, true);
        if (!answer) {
          if (!(await transportError("poll"))) return { reason: "lost_contact", handled };
          continue;
        }
        transportErrors = 0;
        if (answer.status === 204) continue;
        if (answer.status !== 200) refusal(answer);
        const call = (answer.body as { call?: BridgeCall } | null)?.call;
        if (!call) continue;

        let outcome: CallOutcome;
        try {
          outcome = await options.handle(call);
        } catch (error) {
          outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (!outcome.ok) outcome = { ok: false, error: outcome.error.slice(0, MAX_ERROR_CHARS) };
        handled += 1;

        // Not abortable: a call in hand is answered even while stopping.
        for (let attempt = 1; ; attempt++) {
          const posted = await request("POST", `${sessionPath}/calls/${encodeURIComponent(call.id)}/result`, outcome, false);
          if (posted) {
            if (posted.status !== 200) refusal(posted);
            break;
          }
          if (attempt >= RESULT_ATTEMPTS) {
            log(`could not deliver the result of #${call.seq} after ${attempt} attempts`);
            break;
          }
          await sleep(backoffMs(attempt));
        }
      }
    } catch (error) {
      if (error instanceof SessionOver) {
        log(`Peeps ended the session after ${handled} call(s)`);
        return { reason: "session_over", handled };
      }
      if (error instanceof Stopped) return { reason: "stopped", handled };
      throw error;
    }
  };

  let end: SessionEnd;
  try {
    end = await serve();
  } catch (error) {
    left = true;
    throw error;
  }
  if (end.reason === "stopped") await detachNow();
  else left = true;
  return end;

  /**
   * Once, on a stop: tell Peeps, and leave whatever it answers. Not
   * abortable by the stop signal (it is the stop), not retried, and never
   * followed to a redirect (it carries the grant).
   */
  async function detach(): Promise<void> {
    const timeoutMs = options.detachTimeoutMs ?? DETACH_TIMEOUT_MS;
    const cannot = (why: string) => log(`could not end the session at Peeps (${why}); leaving anyway`);
    // One deadline for all of it, the authorization lookup included (a CI
    // provider's token fetch could stall).
    const deadline = AbortSignal.timeout(timeoutMs);
    const timedOut = new Promise<never>((_, reject) => deadline.addEventListener("abort", () => reject(deadline.reason as Error), { once: true }));
    timedOut.catch(() => {});
    let status: number;
    let body: unknown = null;
    try {
      const authorization = await Promise.race([Promise.resolve(options.authorization()), timedOut]);
      const response = await fetch(`${base}${sessionPath}/detach`, {
        method: "POST",
        headers: { ...options.headers, authorization },
        redirect: "manual",
        signal: deadline,
      });
      status = response.status;
      try {
        body = JSON.parse(await response.text());
      } catch {
        body = null;
      }
    } catch {
      cannot(deadline.aborted ? `no answer within ${timeoutMs / 1000} s` : "no answer");
      return;
    }
    const answer = (body ?? {}) as { status?: unknown; error?: unknown };
    if (status === 200) {
      log(answer.status === "ended" ? "Peeps ended the session" : answer.status === "already_over" ? "the session was already over at Peeps" : "Peeps answered the detach");
      return;
    }
    // The code comes from the server: printed only if it looks like one.
    const code = typeof answer.error === "string" && /^[a-z0-9_]{1,64}$/.test(answer.error) ? answer.error : `http_${status}`;
    cannot(`${status} ${code}`);
  }

}

function refusalError(answer: Answer): BridgeRefusedError {
  const body = (answer.body ?? {}) as { error?: unknown; message?: unknown; next?: unknown };
  const code = typeof body.error === "string" ? body.error : `http_${answer.status}`;
  const message = REFUSAL_COPY[code]?.(body) ?? `Peeps refused this runner (${answer.status} ${code}).`;
  return new BridgeRefusedError(answer.status, code, message);
}

const REFUSAL_COPY: Record<string, (body: { message?: unknown; next?: unknown }) => string> = {
  invalid_token: () =>
    "Peeps did not accept PEEPS_RUNNER_GRANT for this session. The grant may be mistyped or for another session, " +
    "or the person who started it can no longer run it (connection revoked, role changed, or local discovery turned off). " +
    "Ask your coding agent to run start_local_discovery again and use the command and grant it returns.",
  invalid_runner_instance: () => "Peeps refused this runner's instance id. This is a bug in the runner; please report it.",
  not_found: () => "Peeps has no such session. Check --session against what start_local_discovery returned.",
  other_runner: () =>
    "Another runner is already serving this session, and a session is served by one runner process only, " +
    "so a runner that was stopped or restarted cannot take it back. " +
    "Ask your coding agent to run start_local_discovery again for a fresh session and command.",
  redirect: () =>
    "Peeps answered with a redirect, which the runner never follows (it would send the grant to wherever it points). " +
    "Check --server: use the exact https:// address start_local_discovery returned.",
  other_job: () => "Another CI job is already serving this session.",
  playwright_mcp_version: (body) =>
    [typeof body.message === "string" ? body.message : "This runner's @playwright/mcp version is not the one Peeps needs.", typeof body.next === "string" ? body.next : ""]
      .filter(Boolean)
      .join(" "),
};
