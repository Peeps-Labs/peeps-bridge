/**
 * Real Chromium, for the findings of review round 4 (probes p16, p19).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { refOf, session } from "./helpers/session.js";
import { startSites, type Sites } from "./helpers/sites.js";

const PW = "Zq8vK3mW9xT2";

let sites: Sites;
let tmpRoot: string;

before(async () => {
  sites = await startSites();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-review4-test-"));
});
after(async () => {
  await sites?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("a secret edited inside a role-less contenteditable", () => {
  it("does not show on the element's child lines", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/rich` });
      await s.run("browser_type", { ref: refOf(page, /"Rich"/), element: "Rich", text: "PW" });
      await s.run("browser_press_key", { key: "End" });
      await s.run("browser_press_key", { key: "Enter" });
      for (const c of "notes") await s.run("browser_press_key", { key: c });
      await s.run("browser_press_key", { key: "ArrowUp" });
      await s.run("browser_press_key", { key: "End" });
      await s.run("browser_press_key", { key: "Backspace" });
      const snap = await s.run("browser_snapshot");
      assert.match(snap, /"Rich"/);
      assert.doesNotMatch(s.everything(), /Zq8vK3mW9xT|Zq8vK3|q8vK3m/);
    } finally {
      await s.host.close();
    }
  });
});

describe("forged snapshot links", () => {
  it("in a page's console never make the runner read the browser profile", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/forge` });
      const log = await s.run("browser_console_messages", { level: "info" });
      assert.match(log, /\[LOG\] x/);
      assert.doesNotMatch(s.everything(), /os_crypt|SQLite format|"profile":|browser":\{/);
      assert.doesNotMatch(log, /```yaml/);
    } finally {
      await s.host.close();
    }
  });
});

describe("dialogs", () => {
  it("say why field values are hidden while one is open", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/dialog` });
      const clicked = await s.run("browser_click", { ref: refOf(page, /button "Open alert"/), element: "Open alert" });
      assert.match(clicked, /dialog is open/);
      await s.run("browser_handle_dialog", { accept: true });
    } finally {
      await s.host.close();
    }
  });
});
