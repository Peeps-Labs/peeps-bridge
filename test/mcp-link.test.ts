import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { McpLink, type McpServerLike } from "../src/browser/mcp-link.js";

/** A server double that speaks JSON-RPC through whatever transport it is given. */
function fakeServer(onRequest: (message: { id?: number; method?: string; params?: unknown }, reply: (m: object) => void) => void) {
  let transport: { send(m: object): Promise<void>; onmessage?: (m: object) => void } | null = null;
  let closed = false;
  const server: McpServerLike & { closed: () => boolean; ask(m: object): void } = {
    async connect(t) {
      transport = t as never;
      t.onmessage = (m) => onRequest(m as never, (r) => void transport!.send(r));
      await t.start();
    },
    async close() {
      closed = true;
    },
    closed: () => closed,
    ask: (m) => void transport!.send(m),
  };
  return server;
}

describe("McpLink", () => {
  it("initialises, answers roots/list with the scratch directory and relays tools/call", async () => {
    const seen: string[] = [];
    let rootsAnswer: unknown;
    const server = fakeServer((m, reply) => {
      if (m.method) seen.push(m.method);
      if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "x", version: "1" } } });
      if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "done" }] } });
      if (m.id === 900) rootsAnswer = m;
    });
    const link = await McpLink.connect(server, "/tmp/scratch dir", "test");
    server.ask({ jsonrpc: "2.0", id: 900, method: "roots/list" });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((rootsAnswer as { result: unknown }).result, { roots: [{ uri: "file:///tmp/scratch%20dir", name: "scratch" }] });
    assert.deepEqual(await link.callTool("browser_snapshot", {}), { content: [{ type: "text", text: "done" }] });
    assert.deepEqual(seen, ["initialize", "notifications/initialized", "tools/call"]);
  });

  it("answers ping, refuses other server requests, and ignores notifications and stray replies", async () => {
    const answers = new Map<number, unknown>();
    const server = fakeServer((m, reply) => {
      if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: {} });
      else if (m.id !== undefined && !m.method) answers.set(m.id, m);
    });
    await McpLink.connect(server, "/tmp", "test");
    server.ask({ jsonrpc: "2.0", id: 1, method: "ping" });
    server.ask({ jsonrpc: "2.0", id: 2, method: "sampling/createMessage" });
    server.ask({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    server.ask({ jsonrpc: "2.0", id: 12345, result: {} });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual((answers.get(1) as { result: unknown }).result, {});
    assert.match(JSON.stringify(answers.get(2)), /does not serve sampling\/createMessage/);
  });

  it("rejects a JSON-RPC error, and every call after close", async () => {
    const server = fakeServer((m, reply) => {
      if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: {} });
      if (m.method === "tools/call") reply({ jsonrpc: "2.0", id: m.id, error: { code: -1, message: "nope" } });
    });
    const link = await McpLink.connect(server, "/tmp", "test");
    await assert.rejects(link.callTool("x", {}), /nope/);
    await link.close();
    assert.equal(server.closed(), true);
    await assert.rejects(link.callTool("x", {}), /closed/);
    await link.close();
  });

  it("fails a call in flight when the link closes", async () => {
    const server = fakeServer((m, reply) => {
      if (m.method === "initialize") reply({ jsonrpc: "2.0", id: m.id, result: {} });
    });
    const link = await McpLink.connect(server, "/tmp", "test");
    const pending = link.callTool("browser_wait_for", { time: 30 });
    await link.close();
    await assert.rejects(pending, /closed/);
  });
});
