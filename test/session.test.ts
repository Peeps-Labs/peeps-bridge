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

  it("keeps every backoff well inside the 3-minute heartbeat expiry", async () => {
    bridge.callReplies.push(...Array.from({ length: 8 }, () => "drop" as const));
    await runBridgeSession(options());
    assert.ok(sleeps.reduce((a, b) => a + b, 0) < 3 * 60 * 1000);
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
