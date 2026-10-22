import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { FakeBridge, SESSION_ID, call } from "./helpers/fake-bridge.js";
import { BridgeRefusedError, runBridgeSession, type BridgeSessionOptions } from "../src/protocol/index.js";

const INSTANCE = "33333333-3333-4333-8333-333333333333";

let bridge: FakeBridge;
let lines: string[];
let sleeps: number[];

beforeEach(async () => {
  bridge = await new FakeBridge().start();
  lines = [];
  sleeps = [];
});
afterEach(() => bridge.stop());

function options(overrides: Partial<BridgeSessionOptions> = {}): BridgeSessionOptions {
  return {
    server: bridge.url,
    sessionId: SESSION_ID,
    authorization: () => "Bearer b1.123.abc",
    headers: { "x-peeps-runner-instance": INSTANCE },
    tools: [{ name: "browser_snapshot", description: "d", inputSchema: { type: "object" } }],
    runnerInfo: { playwrightMcp: "0.0.69", os: "linux" },
    handle: async () => ({ ok: true, result: { content: [{ type: "text", text: "ok" }] } }),
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
}

describe("attach", () => {
  it("announces tools and runnerInfo with the grant and the instance header", async () => {
    await runBridgeSession(options());
    const [attach] = bridge.of("attach");
    assert.equal(attach!.method, "POST");
    assert.equal(attach!.path, `/api/v1/bridge/sessions/${SESSION_ID}/attach`);
    assert.equal(attach!.headers.authorization, "Bearer b1.123.abc");
    assert.equal(attach!.headers["x-peeps-runner-instance"], INSTANCE);
    assert.deepEqual(attach!.body, {
      tools: [{ name: "browser_snapshot", description: "d", inputSchema: { type: "object" } }],
      runnerInfo: { playwrightMcp: "0.0.69", os: "linux" },
    });
  });

  it("accepts an async authorization provider (a CI job's OIDC token)", async () => {
    await runBridgeSession(options({ authorization: async () => "Bearer oidc-jwt" }));
    assert.equal(bridge.of("attach")[0]!.headers.authorization, "Bearer oidc-jwt");
  });

  it("refuses a playwright_mcp_version mismatch with the server's message and next step", async () => {
    bridge.attachReplies.push({
      status: 409,
      body: {
        error: "playwright_mcp_version",
        expected: "0.0.69",
        reported: "0.0.70",
        message: "This runner loaded @playwright/mcp 0.0.70; Peeps needs exactly 0.0.69.",
        next: "Run the exact runner command start_local_discovery returned.",
      },
    });
    const error = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRefusedError);
    assert.equal(error.code, "playwright_mcp_version");
    assert.equal(error.status, 409);
    assert.match(error.message, /Peeps needs exactly 0\.0\.69/);
    assert.match(error.message, /start_local_discovery/);
    assert.equal(bridge.of("calls").length, 0);
  });

  it("refuses other_runner and tells the person to start a fresh session", async () => {
    bridge.attachReplies.push({ status: 409, body: { error: "other_runner" } });
    const error = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRefusedError);
    assert.equal(error.code, "other_runner");
    assert.match(error.message, /another runner/i);
    assert.match(error.message, /start_local_discovery/);
  });

  it("refuses invalid_token without guessing which check failed", async () => {
    bridge.attachReplies.push({ status: 401, body: { error: "invalid_token" } });
    const error = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRefusedError);
    assert.equal(error.code, "invalid_token");
    assert.match(error.message, /PEEPS_RUNNER_GRANT/);
  });

  it("refuses not_found and an unknown 4xx with its code", async () => {
    bridge.attachReplies.push({ status: 404, body: { error: "not_found" } });
    const notFound = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(notFound instanceof BridgeRefusedError);
    assert.equal(notFound.code, "not_found");

    bridge.attachReplies.push({ status: 400, body: { error: "invalid_runner_instance" } });
    const bad = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(bad instanceof BridgeRefusedError);
    assert.equal(bad.code, "invalid_runner_instance");

    bridge.attachReplies.push({ status: 418 });
    const odd = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(odd instanceof BridgeRefusedError);
    assert.equal(odd.code, "http_418");
  });

  it("ends quietly when the session is already over at attach", async () => {
    bridge.attachReplies.push({ status: 410, body: { error: "session_over" } });
    const end = await runBridgeSession(options());
    assert.deepEqual(end, { reason: "session_over", handled: 0 });
  });

  it("retries a transport error on attach, then gives up after 8 in a row", async () => {
    bridge.attachReplies.push("drop", { status: 503 });
    await runBridgeSession(options());
    assert.equal(bridge.of("attach").length, 3);

    bridge.requests.length = 0;
    bridge.attachReplies.push(...Array.from({ length: 8 }, () => "drop" as const));
    const end = await runBridgeSession(options());
    assert.equal(end.reason, "lost_contact");
    assert.equal(bridge.of("attach").length, 8);
  });
});

describe("serving calls", () => {
  it("long-polls with wait=25, runs each call and posts its outcome", async () => {
    bridge.callReplies.push({ status: 204 }, call(1, "browser_snapshot", { depth: 2 }), call(2));
    const seen: unknown[] = [];
    const end = await runBridgeSession(
      options({
        handle: async (c) => {
          seen.push([c.seq, c.tool, c.args]);
          return { ok: true, result: { content: [{ type: "text", text: `#${c.seq}` }] } };
        },
      }),
    );
    assert.deepEqual(end, { reason: "session_over", handled: 2 });
    assert.deepEqual(seen, [
      [1, "browser_snapshot", { depth: 2 }],
      [2, "browser_snapshot", {}],
    ]);
    for (const poll of bridge.of("calls")) {
      assert.equal(poll.method, "GET");
      assert.equal(poll.path, `/api/v1/bridge/sessions/${SESSION_ID}/calls?wait=25`);
      assert.equal(poll.headers["x-peeps-runner-instance"], INSTANCE);
    }
    const results = bridge.of("result");
    assert.equal(results.length, 2);
    assert.equal(results[0]!.path, `/api/v1/bridge/sessions/${SESSION_ID}/calls/22222222-2222-4222-8222-000000000001/result`);
    assert.deepEqual(results[0]!.body, { ok: true, result: { content: [{ type: "text", text: "#1" }] } });
    assert.equal(results[1]!.headers.authorization, "Bearer b1.123.abc");
  });

  it("posts a handler that throws as { ok: false, error }", async () => {
    bridge.callReplies.push(call(1));
    await runBridgeSession(
      options({
        handle: async () => {
          throw new Error("browser crashed");
        },
      }),
    );
    assert.deepEqual(bridge.of("result")[0]!.body, { ok: false, error: "browser crashed" });
  });

  it("caps an error message at the route's 4000 characters", async () => {
    bridge.callReplies.push(call(1));
    await runBridgeSession(options({ handle: async () => ({ ok: false, error: "x".repeat(5000) }) }));
    const body = bridge.of("result")[0]!.body as { error: string };
    assert.ok(body.error.length <= 4000);
  });

  it("ends when Peeps answers 410 to a result", async () => {
    bridge.callReplies.push(call(1), call(2));
    bridge.resultReplies.push({ status: 410, body: { error: "session_over" } });
    const end = await runBridgeSession(options());
    assert.deepEqual(end, { reason: "session_over", handled: 1 });
    assert.equal(bridge.of("calls").length, 1);
  });

  it("retries a result that could not be delivered", async () => {
    bridge.callReplies.push(call(1));
    bridge.resultReplies.push("drop", { status: 502 });
    await runBridgeSession(options());
    assert.equal(bridge.of("result").length, 3);
  });

  it("stops retrying a result after 3 attempts and keeps serving", async () => {
    bridge.callReplies.push(call(1), call(2));
    bridge.resultReplies.push("drop", "drop", "drop");
    const end = await runBridgeSession(options());
    assert.equal(end.handled, 2);
    assert.equal(bridge.of("result").length, 4);
    assert.ok(lines.some((l) => /could not deliver the result of #1/.test(l)));
  });

  it("treats a 401 on a poll as lost authority", async () => {
    bridge.callReplies.push({ status: 401, body: { error: "invalid_token" } });
    const error = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRefusedError);
    assert.equal(error.code, "invalid_token");
  });

  it("treats a 409 on a result as another runner holding the session", async () => {
    bridge.callReplies.push(call(1));
    bridge.resultReplies.push({ status: 409, body: { error: "other_runner" } });
    const error = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRefusedError);
    assert.equal(error.code, "other_runner");
  });
});

describe("staying alive and leaving", () => {
  it("backs off on transport errors and resets the count after a good poll", async () => {
    bridge.callReplies.push(
      ...Array.from({ length: 7 }, () => "drop" as const),
      { status: 204 },
      ...Array.from({ length: 7 }, () => ({ status: 500 })),
      { status: 410, body: { error: "session_over" } },
    );
    const end = await runBridgeSession(options());
    assert.equal(end.reason, "session_over");
    assert.deepEqual(sleeps, [2000, 4000, 6000, 8000, 10000, 12000, 14000, 2000, 4000, 6000, 8000, 10000, 12000, 14000]);
  });

  it("leaves after 8 consecutive transport errors", async () => {
    bridge.callReplies.push(...Array.from({ length: 8 }, () => "drop" as const));
    const end = await runBridgeSession(options());
    assert.deepEqual(end, { reason: "lost_contact", handled: 0 });
    assert.equal(bridge.of("calls").length, 8);
    assert.ok(lines.some((l) => /lost contact/i.test(l)));
  });

  it("keeps the backoff inside the 3-minute heartbeat expiry; the worst case is the request timeouts plus the backoff", async () => {
    bridge.callReplies.push(...Array.from({ length: 8 }, () => "drop" as const));
    await runBridgeSession(options());
    const backoff = sleeps.reduce((a, b) => a + b, 0);
    assert.equal(backoff, 56_000);
    // Between two heartbeats that did arrive there can be one timed-out poll
    // (60 s) and one backoff (at most 14 s): far inside 3 minutes. Eight in a
    // row (8 x 60 s + 56 s, about 9 minutes) end the run as lost contact, by
    // which time Peeps has expired the session anyway.
    assert.ok(60_000 + 14_000 < 3 * 60 * 1000);
  });

  it("leaves when the session's expiresAt has passed", async () => {
    let now = Date.parse("2026-10-20T10:00:00Z");
    bridge.attachReplies.push({
      status: 200,
      body: { sessionId: SESSION_ID, kind: "discover", expiresAt: "2026-10-20T10:45:00Z" },
    });
    bridge.callReplies.push({ status: 204 }, { status: 204 }, { status: 204 });
    const end = await runBridgeSession(
      options({
        now: () => now,
        handle: async () => ({ ok: true, result: {} }),
        sleep: async () => {},
        // Each poll advances the clock 30 minutes.
        onPoll: () => {
          now += 30 * 60 * 1000;
        },
      }),
    );
    assert.equal(end.reason, "expired");
    assert.equal(bridge.of("calls").length, 2);
  });

  it("stops when the signal aborts, cancelling the long poll", async () => {
    bridge.callReplies.push({ status: 204, delayMs: 5000 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const end = await runBridgeSession(options({ signal: controller.signal }));
    assert.deepEqual(end, { reason: "stopped", handled: 0 });
    assert.ok(Date.now() - started < 2000);
  });

  it("answers the call in hand before stopping", async () => {
    bridge.callReplies.push(call(1));
    const controller = new AbortController();
    const end = await runBridgeSession(
      options({
        signal: controller.signal,
        handle: async () => {
          controller.abort();
          return { ok: false, error: "The person stopped the runner." };
        },
      }),
    );
    assert.deepEqual(end, { reason: "stopped", handled: 1 });
    assert.deepEqual(bridge.of("result")[0]!.body, { ok: false, error: "The person stopped the runner." });
  });

  it("stops before attaching when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const end = await runBridgeSession(options({ signal: controller.signal }));
    assert.equal(end.reason, "stopped");
    assert.equal(bridge.requests.length, 0);
  });

  it("does not send a trailing slash or double slash when the server URL ends with /", async () => {
    await runBridgeSession(options({ server: `${bridge.url}/` }));
    assert.equal(bridge.of("attach")[0]!.path, `/api/v1/bridge/sessions/${SESSION_ID}/attach`);
  });
});

describe("edges", () => {
  it("names a refusal whose body is not JSON by its status", async () => {
    bridge.attachReplies.push({ status: 403, body: undefined });
    const error = await runBridgeSession(options()).catch((e: unknown) => e);
    assert.ok(error instanceof BridgeRefusedError);
    assert.equal(error.code, "http_403");
    assert.match(error.message, /refused this runner \(403 http_403\)/);
  });

  it("wakes from a backoff when stopped (the real sleep)", async () => {
    bridge.callReplies.push("drop");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const { sleep: _unused, ...rest } = options({ signal: controller.signal });
    const end = await runBridgeSession(rest);
    assert.equal(end.reason, "stopped");
    assert.ok(Date.now() - started < 1500, "the 2 s backoff was cut short");
  });

  it("ignores a 200 poll without a call", async () => {
    bridge.callReplies.push({ status: 200, body: {} }, call(1));
    const end = await runBridgeSession(options());
    assert.equal(end.handled, 1);
  });
});

describe("a silent network", () => {
  it("counts a request that never answers as a transport error, so a dropped connection cannot hang the runner", async () => {
    bridge.callReplies.push({ status: 204, delayMs: 2000 }, call(1));
    const end = await runBridgeSession(options({ requestTimeoutMs: 300 }));
    assert.equal(end.handled, 1);
    assert.ok(lines.some((l) => /poll failed \(1\/8\)/.test(l)), lines.join("\n"));
  });
});

describe("redirects", () => {
  it("never follows one: a 307 would re-send the grant, the instance id and the body to another origin", async () => {
    const elsewhere = await new FakeBridge().start();
    try {
      bridge.attachReplies.push({ status: 307, body: { location: "ignored" }, headers: { location: `${elsewhere.url}/api/v1/bridge/sessions/${SESSION_ID}/attach` } });
      const error = await runBridgeSession(options()).catch((e: unknown) => e);
      assert.ok(error instanceof BridgeRefusedError);
      assert.equal(error.code, "redirect");
      assert.match(error.message, /redirect/i);
      assert.match(error.message, /--server/);
      assert.equal(elsewhere.requests.length, 0);
    } finally {
      await elsewhere.stop();
    }
  });
});

describe("detach on stop", () => {
  const GRANT_TEXT = "b1.123.abc";
  /** A local runner that stops once call 1 is in hand, or while idle. */
  const stopping = (overrides: Partial<BridgeSessionOptions> = {}) => {
    const controller = new AbortController();
    return {
      controller,
      options: options({
        detachOnStop: true,
        signal: controller.signal,
        handle: async () => {
          controller.abort();
          return { ok: true, result: { content: [{ type: "text", text: "done" }] } };
        },
        ...overrides,
      }),
    };
  };

  it("tells Peeps once, with the grant and the instance header, after the call in hand is answered", async () => {
    bridge.callReplies.push(call(1));
    const { options: o } = stopping();
    const end = await runBridgeSession(o);
    assert.deepEqual(end, { reason: "stopped", handled: 1 });
    const detaches = bridge.of("detach");
    assert.equal(detaches.length, 1);
    const [detach] = detaches;
    assert.equal(detach!.method, "POST");
    assert.equal(detach!.path, `/api/v1/bridge/sessions/${SESSION_ID}/detach`);
    assert.equal(detach!.headers.authorization, `Bearer ${GRANT_TEXT}`);
    assert.equal(detach!.headers["x-peeps-runner-instance"], INSTANCE);
    // After the result of the call in hand, and nothing after it.
    assert.deepEqual(
      bridge.requests.map((r) => r.path.split("/").pop()),
      ["attach", "calls?wait=25", "result", "detach"],
    );
    assert.ok(lines.some((l) => /Peeps ended the session/.test(l)), lines.join("\n"));
  });

  it("tells Peeps when stopped while idle, cancelling the long poll", async () => {
    bridge.callReplies.push({ status: 204, delayMs: 5000 });
    const { controller, options: o } = stopping();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const end = await runBridgeSession(o);
    assert.equal(end.reason, "stopped");
    assert.equal(bridge.of("detach").length, 1);
    assert.ok(Date.now() - started < 2000);
  });

  it("says when the session was already over at Peeps", async () => {
    bridge.callReplies.push(call(1));
    bridge.detachReplies.push({ status: 200, body: { sessionId: SESSION_ID, status: "already_over" } });
    await runBridgeSession(stopping().options);
    assert.ok(lines.some((l) => /already over/.test(l)), lines.join("\n"));
  });

  it("is not sent unless the caller asks (a CI runner, which Peeps refuses with local_runner_only)", async () => {
    bridge.callReplies.push(call(1));
    const { options: o } = stopping({ detachOnStop: undefined });
    assert.equal((await runBridgeSession(o)).reason, "stopped");
    assert.equal(bridge.of("detach").length, 0);
  });

  for (const [status, error] of [
    [401, "invalid_token"],
    [400, "invalid_runner_instance"],
    [409, "other_runner"],
    [404, "not_found"],
    [403, "local_runner_only"],
  ] as const) {
    it(`logs one line for a ${status} ${error} and still stops`, async () => {
      bridge.callReplies.push(call(1));
      bridge.detachReplies.push({ status, body: { error } });
      const end = await runBridgeSession(stopping().options);
      assert.deepEqual(end, { reason: "stopped", handled: 1 });
      assert.equal(bridge.of("detach").length, 1);
      const said = lines.filter((l) => /end the session/i.test(l));
      assert.equal(said.length, 1, lines.join("\n"));
      assert.match(said[0]!, new RegExp(`${status} ${error}`));
      assert.doesNotMatch(lines.join("\n"), new RegExp(GRANT_TEXT.replace(/\./g, "\\.")));
    });
  }

  it("logs one line for a network error and still stops, without retrying", async () => {
    bridge.callReplies.push(call(1));
    bridge.detachReplies.push("drop");
    const end = await runBridgeSession(stopping().options);
    assert.equal(end.reason, "stopped");
    assert.equal(bridge.of("detach").length, 1);
    const said = lines.filter((l) => /end the session/i.test(l));
    assert.equal(said.length, 1, lines.join("\n"));
    assert.doesNotMatch(lines.join("\n"), /b1\.123\.abc/);
  });

  it("gives up on a detach that does not answer within its short timeout", async () => {
    bridge.callReplies.push(call(1));
    bridge.detachReplies.push({ status: 200, body: { status: "ended" }, delayMs: 5000 });
    const started = Date.now();
    const end = await runBridgeSession(stopping({ detachTimeoutMs: 300 }).options);
    assert.equal(end.reason, "stopped");
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    const said = lines.filter((l) => /end the session/i.test(l));
    assert.equal(said.length, 1, lines.join("\n"));
    assert.match(said[0]!, /no answer within/);
  });

  it("defaults to a short timeout, far under the 10-second stop deadline", async () => {
    bridge.callReplies.push(call(1));
    bridge.detachReplies.push({ status: 200, body: { status: "ended" }, delayMs: 8000 });
    const started = Date.now();
    await runBridgeSession(stopping().options);
    const took = Date.now() - started;
    assert.ok(took < 5000, `took ${took} ms`);
  });

  it("never follows a redirect on detach", async () => {
    const elsewhere = await new FakeBridge().start();
    try {
      bridge.callReplies.push(call(1));
      bridge.detachReplies.push({ status: 307, body: {}, headers: { location: `${elsewhere.url}/api/v1/bridge/sessions/${SESSION_ID}/detach` } });
      const end = await runBridgeSession(stopping().options);
      assert.equal(end.reason, "stopped");
      assert.equal(elsewhere.requests.length, 0);
      assert.equal(lines.filter((l) => /end the session/i.test(l)).length, 1, lines.join("\n"));
    } finally {
      await elsewhere.stop();
    }
  });

  it("is not sent after a 410 on a poll or on the result of the call in hand", async () => {
    bridge.callReplies.push({ status: 410, body: { error: "session_over" } });
    assert.equal((await runBridgeSession(options({ detachOnStop: true }))).reason, "session_over");

    bridge.callReplies.push(call(1));
    bridge.resultReplies.push({ status: 410, body: { error: "session_over" } });
    assert.equal((await runBridgeSession(stopping().options)).reason, "session_over");
    assert.equal(bridge.of("detach").length, 0);
  });

  it("is not sent after the session expired", async () => {
    bridge.attachReplies.push({ status: 200, body: { sessionId: SESSION_ID, kind: "discover", expiresAt: "2000-01-01T00:00:00Z" } });
    assert.equal((await runBridgeSession(options({ detachOnStop: true }))).reason, "expired");
    assert.equal(bridge.of("detach").length, 0);
  });

  it("is not sent after lost contact", async () => {
    bridge.callReplies.push(...Array.from({ length: 8 }, () => "drop" as const));
    assert.equal((await runBridgeSession(options({ detachOnStop: true }))).reason, "lost_contact");
    assert.equal(bridge.of("detach").length, 0);
  });

  it("is not sent after Peeps refused the runner, or before it attached", async () => {
    bridge.callReplies.push({ status: 401, body: { error: "invalid_token" } });
    await runBridgeSession(options({ detachOnStop: true })).catch(() => {});

    const controller = new AbortController();
    controller.abort();
    await runBridgeSession(options({ detachOnStop: true, signal: controller.signal }));
    assert.equal(bridge.of("detach").length, 0);
  });
});

describe("detach deadline and detachNow", () => {
  it("bounds the whole detach, the authorization lookup included, by its timeout", async () => {
    bridge.callReplies.push(call(1));
    const controller = new AbortController();
    const started = Date.now();
    const end = await runBridgeSession(
      options({
        detachOnStop: true,
        detachTimeoutMs: 300,
        signal: controller.signal,
        // Fine until the call in hand is answered; then it never answers.
        authorization: () => (bridge.of("result").length > 0 ? new Promise<string>(() => {}) : "Bearer b1.123.abc"),
        handle: async () => {
          controller.abort();
          return { ok: true, result: {} };
        },
      }),
    );
    assert.equal(end.reason, "stopped");
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    const said = lines.filter((l) => /end the session/i.test(l));
    assert.equal(said.length, 1, lines.join("\n"));
    assert.match(said[0]!, /no answer within 0\.3 s/);
  });

  it("logs a 200 with an unknown status neutrally", async () => {
    bridge.callReplies.push(call(1));
    bridge.detachReplies.push({ status: 200, body: { status: "something_new" } });
    const controller = new AbortController();
    await runBridgeSession(
      options({
        detachOnStop: true,
        signal: controller.signal,
        handle: async () => {
          controller.abort();
          return { ok: true, result: {} };
        },
      }),
    );
    assert.ok(!lines.some((l) => /Peeps ended the session/.test(l)), lines.join("\n"));
    assert.ok(lines.some((l) => /Peeps answered/.test(l)), lines.join("\n"));
  });

  /** A session whose call 1 waits until released; `detachNow` exposed. */
  function held(extra: Partial<BridgeSessionOptions> = {}) {
    let detachNow: (() => Promise<void>) | null = null;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let inHand!: () => void;
    const handling = new Promise<void>((r) => (inHand = r));
    const controller = new AbortController();
    const run = runBridgeSession(
      options({
        detachOnStop: true,
        signal: controller.signal,
        exposeDetach: (d) => (detachNow = d),
        handle: async () => {
          inHand();
          await released;
          return { ok: true, result: {} };
        },
        ...extra,
      }),
    );
    return { run, controller, release, handling, detachNow: () => detachNow!() };
  }

  it("detachNow tells Peeps while a call is still in hand, and the stop that follows sends no second one", async () => {
    bridge.callReplies.push(call(1));
    const s = held();
    await s.handling;
    s.controller.abort();
    await s.detachNow();
    assert.equal(bridge.of("detach").length, 1);
    assert.equal(bridge.of("result").length, 0, "sent with the call still outstanding");
    s.release();
    assert.equal((await s.run).reason, "stopped");
    await s.detachNow();
    assert.equal(bridge.of("detach").length, 1);
  });

  it("detachNow called twice at once sends one", async () => {
    bridge.callReplies.push(call(1));
    bridge.detachReplies.push({ status: 200, body: { status: "ended" }, delayMs: 200 });
    const s = held();
    await s.handling;
    await Promise.all([s.detachNow(), s.detachNow()]);
    assert.equal(bridge.of("detach").length, 1);
    s.release();
    await s.run;
  });

  it("detachNow does nothing before the runner attached, without detachOnStop, or after it left", async () => {
    // Before attach.
    let early: (() => Promise<void>) | null = null;
    bridge.attachReplies.push({ ...(bridge.defaultAttach() as { status: number; body: unknown }), delayMs: 300 });
    const run = runBridgeSession(options({ detachOnStop: true, exposeDetach: (d) => (early = d) }));
    await early!();
    await run;
    // Without detachOnStop.
    bridge.callReplies.push(call(1));
    const ci = held({ detachOnStop: undefined });
    await ci.handling;
    await ci.detachNow();
    ci.release();
    await ci.run;
    // After a 410, an expiry, lost contact and a refusal.
    const after = async (o: Partial<BridgeSessionOptions>) => {
      let d: (() => Promise<void>) | null = null;
      await runBridgeSession(options({ detachOnStop: true, exposeDetach: (x) => (d = x), ...o })).catch(() => {});
      await d!();
    };
    bridge.callReplies.push({ status: 410, body: { error: "session_over" } });
    await after({});
    bridge.attachReplies.push({ status: 200, body: { sessionId: SESSION_ID, kind: "discover", expiresAt: "2000-01-01T00:00:00Z" } });
    await after({});
    bridge.callReplies.push(...Array.from({ length: 8 }, () => "drop" as const));
    await after({});
    bridge.callReplies.push({ status: 401, body: { error: "invalid_token" } });
    await after({});
    assert.equal(bridge.of("detach").length, 0);
  });
});
