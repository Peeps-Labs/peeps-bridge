/**
 * Real Chromium, for the findings of review round 3 (probes p9-p14).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { activePage } from "../src/browser/mcp-patches.js";
import { refOf, session } from "./helpers/session.js";
import { startSites, type Sites } from "./helpers/sites.js";

const PW = "Zq8vK3mW9xT2";

let sites: Sites;
let tmpRoot: string;

before(async () => {
  sites = await startSites();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-review3-test-"));
});
after(async () => {
  await sites?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("moving a secret out of its field", () => {
  it("refuses a drag that starts on an element containing or overlapping the field", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/wrap` });
      await s.run("browser_type", { ref: refOf(page, /textbox "A"/), element: "A", text: "PW" });
      await s.run("browser_press_key", { key: "ControlOrMeta+a" });
      const dragged = await s.call("browser_drag", { startElement: "Wrap", startRef: refOf(page, /group "Wrap"/), endElement: "B", endRef: refOf(page, /textbox "B"/) });
      assert.match(JSON.stringify(dragged), /refused/);
      assert.equal(await s.host.context.pages()[0]!.locator("#b").inputValue(), "");
    } finally {
      await s.host.close();
    }
  });

  it("refuses a middle click (Linux primary-selection paste)", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/wrap` });
      await s.run("browser_type", { ref: refOf(page, /textbox "A"/), element: "A", text: "PW" });
      await s.run("browser_press_key", { key: "ControlOrMeta+a" });
      const clicked = await s.call("browser_click", { ref: refOf(page, /textbox "B"/), element: "B", button: "middle" });
      assert.match(JSON.stringify(clicked), /refused/);
      assert.equal(await s.host.context.pages()[0]!.locator("#b").inputValue(), "");
    } finally {
      await s.host.close();
    }
  });

  it("tracks any field the secret lands in, whatever moved it there, before it can be edited", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/wrap` });
      await s.run("browser_type", { ref: refOf(page, /textbox "A"/), element: "A", text: "PW" });
      // The page itself copies it (any route that lands it whole).
      await s.run("browser_click", { ref: refOf(page, /button "Copy A to B"/), element: "Copy A to B" });
      await s.run("browser_click", { ref: refOf(page, /textbox "B"/), element: "B" });
      await s.run("browser_press_key", { key: "End" });
      for (let i = 0; i < PW.length - 1; i++) {
        await s.run("browser_press_key", { key: "ArrowLeft" });
        await s.run("browser_press_key", { key: "." });
        await s.run("browser_press_key", { key: "ArrowLeft" });
      }
      const snap = await s.run("browser_snapshot");
      assert.match(snap, /textbox "B" [^\n]*: \[hidden by peeps-bridge\]/);
      assert.ok(!s.everything().includes([...PW].join(".")), "the interleaved secret was readable");
      assert.doesNotMatch(s.everything(), /Zq8vK3/);
    } finally {
      await s.host.close();
    }
  });
});

describe("open tabs", () => {
  it("a truncated secret in another tab's URL or title is redacted", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/done` });
      await s.run("browser_tabs", { action: "new" });
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/getform` });
      await s.run("browser_type", { ref: refOf(page, /textbox "Key"/), element: "Key", text: "PW", submit: true });
      await s.run("browser_tabs", { action: "list" });
      assert.match(s.everything(), /Open tabs|\(current\)/);
      assert.doesNotMatch(s.everything(), /Zq8vK3mW9x/);
    } finally {
      await s.host.close();
    }
  });
});

describe("password fields without secrets", () => {
  it("hide only their own line, and nothing after they are gone", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      let page = await s.run("browser_navigate", { url: `${sites.appUrl}/signup` });
      const ref = refOf(page, /textbox "Password"/);
      for (const text of ["1", "test", "1234"]) await s.run("browser_type", { ref, element: "Password", text });
      page = await s.run("browser_snapshot");
      assert.match(page, /textbox "Password" [^\n]*: \[hidden by peeps-bridge\]/);
      const news = await s.run("browser_navigate", { url: `${sites.appUrl}/news` });
      assert.doesNotMatch(news, /hidden by peeps-bridge|<secret>/);
      for (const text of [/heading "Latest tests"/, /paragraph [^\n]*: "?1"?$/m, /paragraph [^\n]*: test/, /Order 1234 shipped/, /textbox "Code" [^\n]*: "?1"?$/m]) assert.match(news, text);
    } finally {
      await s.host.close();
    }
  });
});

describe("file choosers", () => {
  it("are cancelled, so the tab is not blocked and the agent is told", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/upload` });
      const chose = await s.run("browser_click", { ref: refOf(page, /button "Attach"|"Attach"/), element: "Attach" });
      const after = await s.run("browser_click", { ref: refOf(page, /button "After"/), element: "After" });
      assert.match(chose + after, /refused (a|an) (file )?upload/);
      assert.match(after, /clicked after/);
      assert.doesNotMatch(after, /modal state/);
    } finally {
      await s.host.close();
    }
  });
});

describe("tabs and handles", () => {
  it("knows the MCP server's active tab after a navigation", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/` });
      assert.ok(activePage(s.host.context));
      assert.match(activePage(s.host.context)!.url(), /\/$/);
    } finally {
      await s.host.close();
    }
  });

  it("does not refuse a drag on one tab because a tracked field lives on another", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/tokens` });
      await s.run("browser_tabs", { action: "new" });
      const second = await s.run("browser_navigate", { url: `${sites.appUrl}/tokens` });
      await s.run("browser_type", { ref: refOf(second, /textbox "Token"/), element: "Token", text: "PW" });
      await s.run("browser_tabs", { action: "select", index: 0 });
      const first = await s.run("browser_snapshot");
      const dragged = await s.call("browser_drag", { startElement: "Token", startRef: refOf(first, /textbox "Token"/), endElement: "Other", endRef: refOf(first, /textbox "Other"/) });
      assert.doesNotMatch(JSON.stringify(dragged), /refused/);
    } finally {
      await s.host.close();
    }
  });
});

describe("the profile directory", () => {
  it("lives inside the runner's scratch directory, so cleanup never touches anyone else's", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      for (const p of s.host.scratchPaths()) assert.ok(p === s.host.workspace || p.startsWith(s.host.workspace + path.sep), p);
      assert.ok(fs.readdirSync(s.host.workspace).includes("profile"));
    } finally {
      await s.host.close();
    }
  });
});
