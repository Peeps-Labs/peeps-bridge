/**
 * Real Chromium, for the findings of review round 5.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startBrowserHost } from "../src/browser/browser-host.js";
import { OriginPolicy } from "../src/browser/origin-policy.js";
import { refOf, session } from "./helpers/session.js";
import { startSites, type Sites } from "./helpers/sites.js";

const PW = "Zq8vK3mW9xT2";

let sites: Sites;
let tmpRoot: string;

before(async () => {
  sites = await startSites();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-review5-test-"));
});
after(async () => {
  await sites?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("accessible names containing ': ' (YAML-quoted keys)", () => {
  it("still hide a password field's value and a secret field's edited value", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/colons` });
      assert.match(page, /'textbox "Password: required" \[ref=e\d+\]': \[hidden by peeps-bridge\]/);
      assert.doesNotMatch(page, /prefilled-pass-99/);
      await s.run("browser_type", { ref: refOf(page, /textbox "Key: main"/), element: "Key: main", text: "PW" });
      for (let i = 0; i < 9; i++) await s.run("browser_press_key", { key: "Backspace" });
      const snap = await s.run("browser_snapshot");
      assert.match(snap, /'textbox "Key: main" \[[^\n]*': \[hidden by peeps-bridge\]/);
      assert.doesNotMatch(s.everything(), /Zq8vK|: Zq8\b/);
    } finally {
      await s.host.close();
    }
  });
});

describe("an unnamed leaf contenteditable", () => {
  it("hides a secret edited down to three characters", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/leaf` });
      const line = page.split("\n").find((l) => /- generic \[ref=e\d+\]: draft$/.test(l.trimEnd()));
      assert.ok(line, page);
      await s.run("browser_type", { ref: /\[ref=(e\d+)\]/.exec(line)![1]!, element: "editor", text: "PW" });
      await s.run("browser_press_key", { key: "End" });
      for (let i = 0; i < 9; i++) await s.run("browser_press_key", { key: "Backspace" });
      const snap = await s.run("browser_snapshot");
      assert.match(snap, /hidden by peeps-bridge/);
      assert.doesNotMatch(s.everything(), /: Zq8\b|"Zq8"|Zq8vK/);
    } finally {
      await s.host.close();
    }
  });
});

describe("a call that never ends", () => {
  it("returns an error at the deadline and says the browser is stuck", async () => {
    let stuck = 0;
    const policy = OriginPolicy.from(`${sites.appUrl}/`, []);
    const host = await startBrowserHost({ policy, secrets: {}, version: "test", tmpRoot, callDeadlineMs: 3000, onStuck: () => (stuck += 1) });
    try {
      await host.callTool("browser_navigate", { url: `${sites.appUrl}/spin` });
      await new Promise((r) => setTimeout(r, 1000));
      const started = Date.now();
      const result = await host.callTool("browser_tabs", { action: "list" });
      assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /did not finish within 3 s/);
      assert.equal(stuck, 1);
    } finally {
      const closing = Date.now();
      await host.close();
      assert.ok(Date.now() - closing < 15_000, `close took ${Date.now() - closing} ms`);
    }
  });
});

describe("the call deadline", () => {
  it("covers the runner's own field reads, not only the browser call", async () => {
    const inputs = Array.from({ length: 1500 }, (_, i) => `<label>F${i} <input value="v${i}"></label>`).join("");
    const http = await import("node:http");
    const server = http.createServer((_q, r) => r.writeHead(200, { "content-type": "text/html" }).end(inputs));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://localhost:${(server.address() as import("node:net").AddressInfo).port}/`;
    let stuck = 0;
    const host = await startBrowserHost({ policy: OriginPolicy.from(url, []), secrets: {}, version: "test", tmpRoot, callDeadlineMs: 2500, onStuck: () => (stuck += 1) });
    try {
      const started = Date.now();
      const result = await host.callTool("browser_navigate", { url });
      assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /did not finish within 3 s|did not finish within 2 s/);
      assert.equal(stuck, 1);
    } finally {
      await host.close();
      server.close();
    }
  });
});

describe("the dialog note", () => {
  it("has its own heading, not Blocked", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/dialog` });
      const clicked = await s.run("browser_click", { ref: refOf(page, /button "Open alert"/), element: "Open alert" });
      assert.match(clicked, /### Note\n- Field values are hidden in this result because a dialog is open/);
      assert.doesNotMatch(clicked, /### Blocked/);
      await s.run("browser_handle_dialog", { accept: true });
    } finally {
      await s.host.close();
    }
  });
});
