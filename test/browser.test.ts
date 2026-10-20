/**
 * Real Chromium, real local servers: the origin policy, secrets, snapshot
 * inlining and the size cap, driven through the same handler the runner uses.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startBrowserHost, type BrowserHost } from "../src/browser/browser-host.js";
import { OriginPolicy } from "../src/browser/origin-policy.js";
import { RESULT_CAP_BYTES } from "../src/browser/results.js";
import { createCallHandler } from "../src/runner.js";
import type { CallOutcome } from "../src/protocol/index.js";
import { startSites, type Sites } from "./helpers/sites.js";

const PASSWORD = "Peeps-Test-2026!";

let sites: Sites;
let host: BrowserHost;
let tmpRoot: string;
let lines: string[];
let seq = 0;
let handle: ReturnType<typeof createCallHandler>;

before(async () => {
  sites = await startSites();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-browser-test-"));
  const policy = OriginPolicy.from(`${sites.appUrl}/`, []);
  host = await startBrowserHost({ policy, secrets: { SHOP_PASSWORD: PASSWORD }, version: "test", tmpRoot });
  handle = createCallHandler({ host, policy, secretNames: new Set(["SHOP_PASSWORD"]), print: (l) => lines.push(l) });
});
after(async () => {
  await host?.close();
  await sites?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
beforeEach(() => {
  lines = [];
});

const run = (tool: string, args: Record<string, unknown> = {}) => handle({ id: `call-${++seq}`, seq, tool, args });
const textOf = (outcome: CallOutcome) => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return ((outcome as { result: { content: { text: string }[] } }).result.content[0]!.text);
};
const isError = (outcome: CallOutcome) => (outcome as { result: { isError?: boolean } }).result.isError === true;

/** The ref of the first snapshot line matching `pattern`. */
const refOf = (snapshot: string, pattern: RegExp) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in\n${snapshot}`);
  return /\[ref=(e\d+)\]/.exec(line)![1]!;
};

describe("browsing the target", () => {
  it("navigates and inlines the action's snapshot", async () => {
    const text = textOf(await run("browser_navigate", { url: `${sites.appUrl}/` }));
    assert.match(text, /### Snapshot\n```yaml\n/);
    assert.match(text, /heading "Shop"/);
    assert.doesNotMatch(text, /\]\(.*\.yml\)/);
    assert.deepEqual(lines, [`#${seq} navigate to ${sites.appUrl}/ on /`]);
  });

  it("clicks, with the new snapshot inline", async () => {
    const page = textOf(await run("browser_snapshot"));
    const text = textOf(await run("browser_click", { ref: refOf(page, /button "Place order"/), element: "Place order" }));
    assert.match(text, /paragraph.*clicked|clicked/);
    assert.match(lines.at(-1)!, /click 'Place order' on \/$/);
  });

  it("writes only inside its scratch directory, never the working directory", async () => {
    assert.ok(host.workspace.startsWith(tmpRoot));
    const written = fs.readdirSync(host.workspace, { recursive: true }).map(String);
    assert.ok(written.some((f) => /page-.*\.yml$/.test(f)), written.join(", "));
    assert.equal(fs.existsSync(path.join(process.cwd(), ".playwright-mcp")), false);
  });

  it("follows an allowed redirect", async () => {
    const text = textOf(await run("browser_navigate", { url: `${sites.appUrl}/redirect-in` }));
    assert.match(text, /heading "Landed"/);
    assert.match(text, /- Page URL: .*\/landing/);
  });

  it("loads allowed subresources and blocks the rest, which never reach the other origin", async () => {
    const before = sites.intranetConnections();
    await run("browser_navigate", { url: `${sites.appUrl}/subresources` });
    await run("browser_wait_for", { text: "same fetch" });
    const text = textOf(await run("browser_wait_for", { text: "cross fetch" }));
    assert.match(text, /same fetch pong/);
    assert.match(text, /cross fetch blocked/);
    assert.equal(sites.intranetConnections(), before);
  });

  it("opens an allowed WebSocket and refuses another origin's", async () => {
    const before = sites.intranetConnections();
    await run("browser_navigate", { url: `${sites.appUrl}/sockets` });
    await run("browser_wait_for", { text: "allowed ws open" });
    const text = textOf(await run("browser_wait_for", { text: "other ws error" }));
    assert.doesNotMatch(text, /other ws open/);
    assert.equal(sites.intranetConnections(), before);
  });

  it("blocks service workers", async () => {
    await run("browser_navigate", { url: `${sites.appUrl}/service-worker` });
    const text = textOf(await run("browser_wait_for", { text: "service worker:" }));
    assert.match(text, /prototype register refused/);
    assert.match(text, /service worker: 0 registered/);
    assert.equal(sites.serviceWorkerFetches(), 0);
  });
});

describe("the origin proxy, through Chromium", () => {
  it("refuses a redirect to a disallowed origin, which context.route does not see", async () => {
    const before = sites.intranetConnections();
    const outcome = await run("browser_navigate", { url: `${sites.appUrl}/redirect-out` });
    const text = textOf(outcome);
    assert.doesNotMatch(text, /SECRET INTRANET/);
    assert.match(text, /Blocked by peeps-bridge|blocked requests/);
    assert.match(text, new RegExp(`blocked requests to origins outside this session's allowed list: ${sites.intranetUrl.replace(/[.:/]/g, "\\$&")}`));
    assert.equal(sites.intranetConnections(), before);
  });

  it("refuses a redirect to a disallowed https origin at CONNECT", async () => {
    const before = sites.intranetConnections();
    const outcome = await run("browser_navigate", { url: `${sites.appUrl}/redirect-out-https` });
    assert.doesNotMatch(JSON.stringify(outcome), /SECRET INTRANET/);
    assert.match(JSON.stringify(outcome), new RegExp(new URL(sites.intranetUrl).host.replace(/[.:]/g, "\\$&")));
    assert.equal(sites.intranetConnections(), before);
    // Chromium commits its error page after the tool returns; let it land.
    await run("browser_wait_for", { time: 1 });
  });

  it("refuses a direct navigation to another origin before the browser moves", async () => {
    const before = sites.intranetConnections();
    const outcome = await run("browser_navigate", { url: `${sites.intranetUrl}/secret` });
    assert.ok(isError(outcome));
    assert.match(textOf(outcome), /is not an allowed origin for this session/);
    assert.equal(sites.intranetConnections(), before);
  });

  it("refuses non-http(s) navigation", async () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<h1>x</h1>", "javascript:alert(1)"]) {
      const outcome = await run("browser_navigate", { url });
      assert.ok(isError(outcome));
      assert.match(textOf(outcome), /only opens http:\/\/ and https:\/\/ URLs/);
    }
  });
});

describe("secrets", () => {
  it("types a secret by name, and its value never appears in a result or a printed line", async () => {
    const page = textOf(await run("browser_navigate", { url: `${sites.appUrl}/login` }));
    const typed = await run("browser_type", { ref: refOf(page, /textbox "Password"/), element: "Password", text: "SHOP_PASSWORD" });
    const afterTyping = textOf(await run("browser_snapshot"));
    // The page really received the value: it echoes it, scrubbed.
    assert.match(afterTyping, /Typed: <secret>SHOP_PASSWORD<\/secret>/);
    const submitted = await run("browser_click", { ref: refOf(afterTyping, /button "Sign in"/), element: "Sign in" });
    const signedIn = textOf(submitted);
    assert.match(signedIn, /Server saw: password=<secret>SHOP_PASSWORD<\/secret>/);
    const network = await run("browser_network_requests", { static: false, requestBody: true, requestHeaders: true });
    const console = await run("browser_console_messages", { level: "debug", all: true });
    const everything = JSON.stringify([page, typed, afterTyping, submitted, network, console]) + lines.join("\n");
    assert.doesNotMatch(everything, /Peeps-Test-2026/);
    assert.doesNotMatch(everything, /Peeps-Test-2026%21/);
    assert.ok(lines.some((l) => l.includes("type secret SHOP_PASSWORD into 'Password'")));
  });
});

describe("size", () => {
  it("caps a huge page at 200 KB with a marker", async () => {
    const outcome = await run("browser_navigate", { url: `${sites.appUrl}/big` });
    const text = textOf(outcome);
    assert.ok(Buffer.byteLength(JSON.stringify(text)) <= RESULT_CAP_BYTES);
    assert.match(text, /\[TRUNCATED by peeps-bridge/);
  });
});

describe("the sandbox", () => {
  it("uses Chromium's sandbox where the OS allows it, and says so where it does not", async () => {
    const warnings: string[] = [];
    const own = await startBrowserHost({ policy: OriginPolicy.from(`${sites.appUrl}/`, []), secrets: {}, version: "test", tmpRoot, warn: (l) => warnings.push(l) });
    try {
      assert.equal(typeof own.sandboxed, "boolean");
      assert.equal(warnings.length, own.sandboxed ? 0 : 1);
    } finally {
      await own.close();
    }
  });
});

describe("closing", () => {
  it("kills the browser and removes the scratch directory", async () => {
    const policy = OriginPolicy.from(`${sites.appUrl}/`, []);
    const own = await startBrowserHost({ policy, secrets: {}, version: "test", tmpRoot });
    const ownHandle = createCallHandler({ host: own, policy, secretNames: new Set(), print: () => {} });
    textOf(await ownHandle({ id: "x", seq: 1, tool: "browser_navigate", args: { url: `${sites.appUrl}/` } }));
    assert.equal(own.browser.isConnected(), true);
    await own.close();
    assert.equal(own.browser.isConnected(), false);
    assert.equal(fs.existsSync(own.workspace), false);
    await own.close(); // idempotent
  });
});
