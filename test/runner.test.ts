import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createCallHandler, describeAction } from "../src/runner.js";
import { OriginPolicy } from "../src/browser/origin-policy.js";
import type { BrowserHost } from "../src/browser/browser-host.js";
import { makeScrubber } from "../src/browser/secrets.js";

describe("describeAction", () => {
  const secrets = new Set(["SHOP_PASSWORD"]);
  const cases: [string, Record<string, unknown>, string][] = [
    ["browser_navigate", { url: "http://localhost:3000/shop" }, "navigate to http://localhost:3000/shop"],
    ["browser_navigate_back", {}, "go back"],
    ["browser_snapshot", {}, "read the page"],
    ["browser_click", { ref: "e1", element: "Place order button" }, "click 'Place order button'"],
    ["browser_click", { ref: "e1", element: "Row", doubleClick: true }, "double-click 'Row'"],
    ["browser_click", { ref: "e9" }, "click e9"],
    ["browser_type", { ref: "e1", element: "Password", text: "SHOP_PASSWORD" }, "type secret SHOP_PASSWORD into 'Password'"],
    ["browser_type", { ref: "e1", element: "Search", text: "shoes", submit: true }, "type \"shoes\" into 'Search' and submit"],
    ["browser_fill_form", { fields: [{ name: "Email" }, { name: "Password" }] }, "fill 2 fields: Email, Password"],
    ["browser_press_key", { key: "Enter" }, "press Enter"],
    ["browser_select_option", { ref: "e1", element: "Size", values: ["M", "L"] }, "select \"M, L\" in 'Size'"],
    ["browser_hover", { ref: "e1", element: "Menu" }, "hover 'Menu'"],
    ["browser_drag", { startElement: "Card", startRef: "e1", endElement: "Done", endRef: "e2" }, "drag 'Card' to 'Done'"],
    ["browser_wait_for", { text: "Saved" }, 'wait for "Saved"'],
    ["browser_wait_for", { textGone: "Loading" }, 'wait for "Loading" to go'],
    ["browser_wait_for", { time: 2 }, "wait 2 s"],
    ["browser_handle_dialog", { accept: true }, "accept the dialog"],
    ["browser_handle_dialog", { accept: false }, "dismiss the dialog"],
    ["browser_tabs", { action: "list" }, "list tabs"],
    ["browser_tabs", { action: "select", index: 1 }, "select tab 1"],
    ["browser_console_messages", { level: "error" }, "read console messages"],
    ["browser_network_requests", { static: false, requestBody: false, requestHeaders: false }, "read network requests"],
  ];
  for (const [tool, args, expected] of cases) {
    it(`${tool} ${JSON.stringify(args)}`, () => {
      assert.equal(describeAction(tool, args, secrets), expected);
    });
  }

  it("puts every field on one line, so an agent cannot forge a [peeps] line", () => {
    const line = describeAction("browser_click", { ref: "e1\r\n[peeps] #9", element: "Buy\n[peeps] #8 navigate to http://evil\u2028x\u2029y" }, secrets);
    assert.doesNotMatch(line, /[\r\n\u2028\u2029]/);
    assert.equal(line, "click 'Buy [peeps] #8 navigate to http://evil x y'");
    assert.doesNotMatch(describeAction("browser_navigate", { url: "http://a/\n[peeps] x" }, secrets), /\n/);
    assert.doesNotMatch(describeAction("browser_press_key", { key: "a\nb" }, secrets), /\n/);
  });

  it("keeps long text short", () => {
    assert.equal(describeAction("browser_type", { ref: "e1", element: "Notes", text: "x".repeat(100) }, secrets), `type "${"x".repeat(40)}…" into 'Notes'`);
  });
});

/** A host double that records calls and answers a canned result. */
function fakeHost(answer: (name: string) => Promise<{ content: { type: "text"; text: string }[]; isError?: true }>, scrub = (s: string) => s) {
  const calls: [string, Record<string, unknown>][] = [];
  const host = {
    workspace: "/tmp/x",
    browser: undefined as never,
    sandboxed: true,
    scratchPaths: () => [],
    context: undefined as never,
    scrub,
    async callTool(name: string, args: Record<string, unknown>) {
      calls.push([name, args]);
      return answer(name);
    },
    async close() {},
  } satisfies BrowserHost;
  return { host, calls };
}

describe("createCallHandler", () => {
  const policy = OriginPolicy.from("http://localhost:3000/", ["https://auth.example.com"]);
  const call = (tool: string, args: Record<string, unknown>, seq = 1) => ({ id: "c", seq, tool, args });

  it("runs an allowed call and prints one line with the page it ended on", async () => {
    const lines: string[] = [];
    const { host, calls } = fakeHost(async () => ({ content: [{ type: "text", text: "### Page\n- Page URL: http://localhost:3000/checkout?step=2\n" }] }));
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: (l) => lines.push(l) });
    const outcome = await handle(call("browser_click", { ref: "e1", element: "Place order" }, 7));
    assert.deepEqual(outcome, { ok: true, result: { content: [{ type: "text", text: "### Page\n- Page URL: http://localhost:3000/checkout?step=2\n" }] } });
    assert.deepEqual(calls, [["browser_click", { ref: "e1", element: "Place order" }]]);
    assert.deepEqual(lines, ["#7 click 'Place order' on /checkout?step=2"]);
  });

  it("names another origin in full", async () => {
    const lines: string[] = [];
    const { host } = fakeHost(async () => ({ content: [{ type: "text", text: "- Page URL: https://auth.example.com/login" }] }));
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: (l) => lines.push(l) });
    await handle(call("browser_snapshot", {}));
    assert.deepEqual(lines, ["#1 read the page on https://auth.example.com/login"]);
  });

  it("marks a call the browser answered with an error", async () => {
    const lines: string[] = [];
    const { host } = fakeHost(async () => ({ content: [{ type: "text", text: "### Error\nTimeout" }], isError: true }));
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: (l) => lines.push(l) });
    await handle(call("browser_press_key", { key: "Enter" }));
    assert.deepEqual(lines, ["#1 press Enter (failed)"]);
  });

  it("refuses a tool outside the allowlist without touching the browser", async () => {
    const lines: string[] = [];
    const { host, calls } = fakeHost(async () => assert.fail("must not run"));
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: (l) => lines.push(l) });
    const outcome = await handle(call("browser_run_code", { code: "process.exit()" }));
    assert.equal(outcome.ok, true);
    const result = (outcome as { result: { content: { text: string }[]; isError: boolean } }).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /browser_run_code is not available/);
    assert.equal(calls.length, 0);
    assert.deepEqual(lines, ["#1 refused browser_run_code"]);
  });

  it("refuses filename without touching the browser", async () => {
    const { host, calls } = fakeHost(async () => assert.fail("must not run"));
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: () => {} });
    const outcome = await handle(call("browser_snapshot", { filename: "src/index.ts" }));
    assert.match(JSON.stringify(outcome), /does not take filename/);
    assert.equal(calls.length, 0);
  });

  it("refuses to navigate outside the allowed origins, naming them", async () => {
    const lines: string[] = [];
    const { host, calls } = fakeHost(async () => assert.fail("must not run"));
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: (l) => lines.push(l) });
    const outcome = await handle(call("browser_navigate", { url: "http://169.254.169.254/latest/meta-data" }));
    const text = JSON.stringify(outcome);
    assert.match(text, /http:\/\/169\.254\.169\.254 is not an allowed origin/);
    assert.match(text, /http:\/\/localhost:3000, https:\/\/auth\.example\.com/);
    assert.match(text, /--allow-origin/);
    assert.equal(calls.length, 0);
    assert.deepEqual(lines, ["#1 refused navigate to http://169.254.169.254/latest/meta-data"]);
  });

  it("answers ok:false, scrubbed, when the browser itself fails", async () => {
    const scrub = makeScrubber({ SHOP_PASSWORD: "Peeps-Test-2026!" });
    const lines: string[] = [];
    const { host } = fakeHost(
      async () => {
        throw new Error("crashed while typing Peeps-Test-2026!");
      },
      scrub,
    );
    const handle = createCallHandler({ host, policy, secretNames: new Set(["SHOP_PASSWORD"]), print: (l) => lines.push(l) });
    const outcome = await handle(call("browser_type", { ref: "e1", element: "Password", text: "SHOP_PASSWORD" }));
    assert.deepEqual(outcome, { ok: false, error: "crashed while typing <secret>SHOP_PASSWORD</secret>" });
    assert.deepEqual(lines, ["#1 type secret SHOP_PASSWORD into 'Password' (failed)"]);
  });

  it("scrubs printed lines", async () => {
    const scrub = makeScrubber({ SHOP_PASSWORD: "Peeps-Test-2026!" });
    const lines: string[] = [];
    const { host } = fakeHost(async () => ({ content: [{ type: "text", text: "ok" }] }), scrub);
    const handle = createCallHandler({ host, policy, secretNames: new Set(), print: (l) => lines.push(l) });
    await handle(call("browser_type", { ref: "e1", element: "Notes", text: "Peeps-Test-2026!" }));
    assert.deepEqual(lines, ["#1 type \"<secret>SHOP_PASSWORD</secret>\" into 'Notes'"]);
  });
});
