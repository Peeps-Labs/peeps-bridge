/**
 * Real Chromium, for the findings of review round 2 that were proven in a
 * browser (probes p1-p8).
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

import { OriginPolicy } from "../src/browser/origin-policy.js";
import { startOriginProxy } from "../src/browser/origin-proxy.js";
import { refOf, session } from "./helpers/session.js";
import { startSites, type Sites } from "./helpers/sites.js";

const PW = "Zq8vK3mW9xT2";

let sites: Sites;
let tmpRoot: string;

before(async () => {
  sites = await startSites();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-review2-test-"));
});
after(async () => {
  await sites?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const withDeadline = <T>(promise: Promise<T>, ms: number, what: string) =>
  Promise.race([promise, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms))]);

describe("dialogs", () => {
  for (const secrets of [{ PW }, {}] as Record<string, string>[]) {
    it(`an alert does not stall the call, and can then be handled (${Object.keys(secrets).length ? "with" : "without"} secrets)`, async () => {
      const s = await session(sites.appUrl, secrets, tmpRoot);
      try {
        const page = await s.run("browser_navigate", { url: `${sites.appUrl}/dialog` });
        if (Object.keys(secrets).length) await s.run("browser_type", { ref: refOf(page, /textbox "Note"/), element: "Note", text: "PW" });
        const clicked = await withDeadline(s.run("browser_click", { ref: refOf(page, /button "Open alert"/), element: "Open alert" }), 8000, "the click");
        assert.match(clicked, /alert/i);
        const handled = await withDeadline(s.run("browser_handle_dialog", { accept: true }), 8000, "handling the dialog");
        assert.doesNotMatch(handled, /### Error/);
        await withDeadline(s.run("browser_snapshot"), 8000, "the next snapshot");
      } finally {
        await s.host.close();
      }
    });
  }
});

describe("values seen once stay scrubbed", () => {
  it("in the whole console history after the field has gone", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/logged` });
      await s.run("browser_type", { ref: refOf(page, /textbox "Plain"/), element: "Plain", text: "PW" });
      // Down to "Zq8vK": shorter than the run rule's 6, so only the field's
      // remembered contents can catch it.
      for (let i = 0; i < 7; i++) await s.run("browser_press_key", { key: "Backspace" });
      await s.run("browser_navigate", { url: `${sites.appUrl}/paragraphs` });
      const log = await s.run("browser_console_messages", { level: "debug", all: true });
      assert.match(log, /input plain = /);
      assert.doesNotMatch(log, /Zq8vK/);
    } finally {
      await s.host.close();
    }
  });
});

describe("tracking does not leak across pages", () => {
  it("a later page's element with a tracked field's ref is not hidden", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/logged` });
      const ref = refOf(page, /textbox "Plain"/);
      await s.run("browser_type", { ref, element: "Plain", text: "PW" });
      const other = await s.run("browser_navigate", { url: `${sites.appUrl}/paragraphs` });
      const line = other.split("\n").find((l) => l.includes(`[ref=${ref}]`));
      assert.ok(line, other);
      assert.doesNotMatch(line, /hidden by peeps-bridge/);
      assert.doesNotMatch(other, /hidden by peeps-bridge/);
    } finally {
      await s.host.close();
    }
  });
});

describe("clipboard and drag", () => {
  it("refuses dragging a secret field's text into another field", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/drag` });
      const a = refOf(page, /textbox "A"/);
      const b = refOf(page, /textbox "B"/);
      await s.run("browser_type", { ref: a, element: "A", text: "PW" });
      await s.run("browser_press_key", { key: "ControlOrMeta+a" });
      const dragged = await s.call("browser_drag", { startElement: "A", startRef: a, endElement: "B", endRef: b });
      assert.match(JSON.stringify(dragged), /refused/);
      const value = await s.host.context.pages()[0]!.locator("textarea[name=b]").inputValue();
      assert.equal(value, "");
    } finally {
      await s.host.close();
    }
  });

  it("refuses copy, cut and paste keys, so a secret cannot be pasted into an untracked field", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      for (const key of ["Control+c", "Control+V", "Meta+x", "ControlOrMeta+KeyC", "Control+Insert", "Shift+Insert", "Shift+Delete", "Copy", "Paste"]) {
        assert.match(JSON.stringify(await s.call("browser_press_key", { key })), /refused/, key);
      }
    } finally {
      await s.host.close();
    }
  });
});

describe("the run rule is narrow", () => {
  it("does not hide page words that share characters with a secret", async () => {
    const s = await session(sites.appUrl, { FIRST: "test-password" }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/labels` });
      assert.match(page, /textbox "Password"/);
      assert.match(page, /Reset your password/);
    } finally {
      await s.host.close();
    }
  });

  it("still catches an edited secret in the console and in a field's value", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/logged` });
      await s.run("browser_type", { ref: refOf(page, /textbox "Plain"/), element: "Plain", text: "PW" });
      await s.run("browser_press_key", { key: "Backspace" });
      await s.run("browser_press_key", { key: "Backspace" });
      const log = await s.run("browser_console_messages", { level: "debug", all: true });
      assert.match(log, /input plain = /);
      assert.doesNotMatch(s.everything(), /Zq8vK3mW9/);
    } finally {
      await s.host.close();
    }
  });
});

describe("typing a secret slowly", () => {
  it("fills it at once, so the page sees no per-character input", async () => {
    const s = await session(sites.appUrl, { PW }, tmpRoot);
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/logged` });
      await s.run("browser_type", { ref: refOf(page, /textbox "Plain"/), element: "Plain", text: "PW", slowly: true });
      const log = await s.run("browser_console_messages", { level: "debug", all: true });
      assert.equal((log.match(/input plain = /g) ?? []).length, 1, log);
    } finally {
      await s.host.close();
    }
  });
});

describe("the network log, rendered by the runner", () => {
  it("cannot be steered by body text that looks like an entry or a section", async () => {
    const s = await session(sites.appUrl, {}, tmpRoot);
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/bodies` });
      await s.run("browser_wait_for", { text: "same posted" });
      await s.run("browser_wait_for", { text: "cross posted" });
      const log = await s.run("browser_network_requests", { static: false, requestBody: true, requestHeaders: false });
      assert.doesNotMatch(log, /LEAKED-BODY-TEXT/);
      assert.doesNotMatch(log, /\/collect/);
      // The allowed request's body is there, every line indented.
      assert.match(log, /\n {4}first\n {4}\[GET\] .*\/fake\n {4}### Snapshot\n {4}last/);
      assert.match(log, /left out/);
    } finally {
      await s.host.close();
    }
  });
});

describe("WebRTC, positive control", () => {
  it("without the runner's flag, the same page does send UDP (so the runner's zero is meaningful)", async () => {
    const udp = dgram.createSocket("udp4");
    let packets = 0;
    udp.on("message", () => (packets += 1));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const proxy = await startOriginProxy(OriginPolicy.from(`${sites.appUrl}/`, []), () => {});
    const browser = await chromium.launch({ headless: true, proxy: { server: proxy.url, bypass: "<-loopback>" } });
    try {
      const page = await browser.newPage();
      await page.goto(`${sites.appUrl}/webrtc?port=${udp.address().port}`);
      await page.waitForTimeout(3000);
      assert.ok(packets > 0, "no UDP without the flag: the WebRTC test would prove nothing");
    } finally {
      await browser.close();
      await proxy.close();
      udp.close();
    }
  });
});
