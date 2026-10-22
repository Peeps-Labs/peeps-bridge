/**
 * A scripted stand-in for Peeps' four bridge routes, for protocol tests.
 * Each route answers from a queue of replies; an empty `calls` queue answers
 * 410 so a test that forgets to end the session still terminates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export type Reply =
  | { status: number; body?: unknown; delayMs?: number; headers?: Record<string, string> }
  /** Close the connection without an answer: a transport error. */
  | "drop";

export interface Recorded {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

export class FakeBridge {
  readonly requests: Recorded[] = [];
  attachReplies: Reply[] = [];
  callReplies: Reply[] = [];
  resultReplies: Reply[] = [];
  detachReplies: Reply[] = [];
  /** Called as each request arrives, before it is answered. */
  onRequest?: (request: Recorded) => void;
  private server: http.Server | null = null;
  /** Delayed replies not yet sent; stop() clears them so none outlives it. */
  private timers = new Set<NodeJS.Timeout>();
  url = "";

  defaultAttach(): Reply {
    return {
      status: 200,
      body: {
        sessionId: "11111111-1111-4111-8111-111111111111",
        kind: "discover",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        baseSha: null,
      },
    };
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const url = new URL(req.url ?? "/", "http://fake");
        const recorded: Recorded = {
          method: req.method ?? "",
          path: url.pathname + url.search,
          headers: req.headers,
          body: text ? JSON.parse(text) : undefined,
        };
        this.requests.push(recorded);
        this.onRequest?.(recorded);
        let reply: Reply | undefined;
        if (url.pathname.endsWith("/detach")) reply = this.detachReplies.shift() ?? { status: 200, body: { sessionId: SESSION_ID, status: "ended" } };
        else if (url.pathname.endsWith("/attach")) reply = this.attachReplies.shift() ?? this.defaultAttach();
        else if (url.pathname.endsWith("/result")) reply = this.resultReplies.shift() ?? { status: 200, body: { accepted: true } };
        else if (url.pathname.endsWith("/calls")) reply = this.callReplies.shift() ?? { status: 410, body: { error: "session_over" } };
        else reply = { status: 404, body: { error: "no_route" } };
        const send = () => {
          if (reply === "drop") {
            req.socket.destroy();
            return;
          }
          if (reply!.body === undefined) {
            res.writeHead(reply!.status, reply!.headers).end();
            return;
          }
          res.writeHead(reply!.status, { "content-type": "application/json", ...reply!.headers }).end(JSON.stringify(reply!.body));
        };
        if (reply !== "drop" && reply.delayMs) {
          const timer = setTimeout(() => {
            this.timers.delete(timer);
            send();
          }, reply.delayMs);
          this.timers.add(timer);
        }
        else send();
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** Requests to one route kind. */
  of(kind: "attach" | "calls" | "result" | "detach"): Recorded[] {
    return this.requests.filter((r) =>
      kind === "attach" || kind === "detach"
        ? r.path.endsWith(`/${kind}`)
        : kind === "result"
          ? r.path.endsWith("/result")
          : r.path.includes("/calls?") || r.path.endsWith("/calls"),
    );
  }
}

export const SESSION_ID = "11111111-1111-4111-8111-111111111111";
export const call = (seq: number, tool = "browser_snapshot", args: Record<string, unknown> = {}) => ({
  status: 200,
  body: { call: { id: `22222222-2222-4222-8222-${String(seq).padStart(12, "0")}`, seq, tool, args } },
});
