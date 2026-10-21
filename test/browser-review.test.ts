/**
 * Real Chromium, for the findings of review round 1 that were proven in a
 * browser: secrets recovered by editing a field, password fields, overlapping
 * secrets, WebRTC around the proxy, a page-started download, and the network
 * log's origins and credential headers.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startBrowserHost } from "../src/browser/browser-host.js";
import { OriginPolicy } from "../src/browser/origin-policy.js";
import { createCallHandler } from "../src/runner.js";
import type { CallOutcome } from "../src/protocol/index.js";
import { startSites, type Sites } from "./helpers/sites.js";

const PW = "Hunter2-Correct-Horse";

let sites: Sites;
let tmpRoot: string;

before(async () => {
  sites = await startSites();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-review-test-"));
});
after(async () => {
  await sites?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const textOf = (outcome: CallOutcome) => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return (outcome as { result: { content: { text: string }[] } }).result.content[0]!.text;
};
const refOf = (snapshot: string, pattern: RegExp) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in\n${snapshot}`);
  return /\[ref=([a-z0-9]+)\]/.exec(line)![1]!;
};

async function session(secrets: Record<string, string>) {
  const policy = OriginPolicy.from(`${sites.appUrl}/`, []);
  const host = await startBrowserHost({ policy, secrets, version: "test", tmpRoot });
  const lines: string[] = [];
  const handle = createCallHandler({ host, policy, secretNames: new Set(Object.keys(secrets)), print: (l) => lines.push(l) });
  let seq = 0;
  const run = async (tool: string, args: Record<string, unknown> = {}) => textOf(await handle({ id: `c${++seq}`, seq, tool, args }));
  return { host, run, lines };
}

/** Everything a session sent and printed, for leak checks. */
const assertNoRun = (everything: string, value: string, minimum: number) => {
  for (let i = 0; i + minimum <= value.length; i++) {
    assert.ok(!everything.includes(value.slice(i, i + minimum)), `"${value.slice(i, i + minimum)}" leaked`);
  }
};

describe("a secret typed into a field cannot be read back", () => {
  let s: Awaited<ReturnType<typeof session>>;
  const seen: string[] = [];
  before(async () => {
    s = await session({ PW });
  });
  after(() => s.host.close());

  it("after a Backspace", async () => {
    const page = await s.run("browser_navigate", { url: `${sites.appUrl}/fields` });
    await s.run("browser_type", { ref: refOf(page, /textbox "Plain"/), element: "Plain", text: "PW" });
    seen.push(await s.run("browser_press_key", { key: "Backspace" }));
    const snap = await s.run("browser_snapshot");
    seen.push(snap);
    assert.match(snap, /textbox "Plain" [^\n]*: \[hidden by peeps-bridge\]/);
    assertNoRun(snap, PW, 4);
  });

  it("after Home and Delete", async () => {
    const page = await s.run("browser_navigate", { url: `${sites.appUrl}/fields` });
    const ref = refOf(page, /textbox "Plain"/);
    await s.run("browser_type", { ref, element: "Plain", text: "PW" });
    await s.run("browser_press_key", { key: "Home" });
    seen.push(await s.run("browser_press_key", { key: "Delete" }));
    seen.push(await s.run("browser_snapshot"));
    assertNoRun(seen.join("\n"), PW, 4);
  });

  it("when maxlength truncated it, and after editing the remnant", async () => {
    const page = await s.run("browser_navigate", { url: `${sites.appUrl}/fields` });
    seen.push(await s.run("browser_type", { ref: refOf(page, /textbox "Short"/), element: "Short", text: "PW" }));
    seen.push(await s.run("browser_press_key", { key: "Backspace" }));
    const snap = await s.run("browser_snapshot");
    seen.push(snap, await s.run("browser_console_messages", { level: "debug", all: true }));
    assert.match(snap, /textbox "Short" [^\n]*: \[hidden by peeps-bridge\]/);
    // "Hunte" is shorter than the run rule's 6: the field's own contents are scrubbed everywhere.
    assert.doesNotMatch(seen.join("\n"), /Hunte/);
  });

  it("in no posted result or printed line of the whole session", () => {
    assertNoRun(seen.join("\n") + s.lines.join("\n"), PW, 4);
  });
});

describe("password fields", () => {
  it("never show their value, filled from a secret or not", async () => {
    const s = await session({ PW });
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/fields` });
      assert.match(page, /textbox "Saved" [^\n]*: \[hidden by peeps-bridge\]/);
      assert.doesNotMatch(page, /pre-filled-saved/);
      await s.run("browser_type", { ref: refOf(page, /textbox "Password"/), element: "Password", text: "an-ordinary-value" });
      const snap = await s.run("browser_snapshot");
      assert.match(snap, /textbox "Password" [^\n]*: \[hidden by peeps-bridge\]/);
      // Only the field's own line: a password with no secret in it is not
      // remembered or scrubbed elsewhere (review round 3), so the page's echo stays.
      assert.match(snap, /textbox "Plain"/);
    } finally {
      await s.host.close();
    }
  });
});

describe("overlapping secrets", () => {
  it("are redacted whole, longest first, in Playwright's own redaction too", async () => {
    const s = await session({ FIRST: "test-password", SECOND: "test-password-private-suffix" });
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/fields` });
      await s.run("browser_type", { ref: refOf(page, /textbox "Plain"/), element: "Plain", text: "SECOND" });
      const snap = await s.run("browser_snapshot");
      assert.match(snap, /Typed: <secret>SECOND<\/secret>/);
      assert.doesNotMatch(snap, /private-suffix/);
    } finally {
      await s.host.close();
    }
  });
});

describe("WebRTC", () => {
  it("sends no UDP around the origin proxy", async () => {
    const udp = dgram.createSocket("udp4");
    let packets = 0;
    udp.on("message", () => (packets += 1));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const s = await session({});
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/webrtc?port=${udp.address().port}` });
      await s.run("browser_wait_for", { time: 3 });
      assert.equal(packets, 0);
    } finally {
      await s.host.close();
      udp.close();
    }
  });
});

describe("downloads", () => {
  it("are refused without crashing the runner", async () => {
    const s = await session({});
    try {
      const page = await s.run("browser_navigate", { url: `${sites.appUrl}/download` });
      const clicked = await s.run("browser_click", { ref: refOf(page, /link "Get the file"/), element: "Get the file" });
      await s.run("browser_wait_for", { time: 1 });
      const after = await s.run("browser_snapshot");
      assert.match(clicked + after, /refused a download/);
      const output = path.join(s.host.workspace, "output");
      assert.equal(fs.existsSync(output) && fs.readdirSync(output, { recursive: true }).map(String).some((f) => f.includes("file")), false);
    } finally {
      await s.host.close();
    }
  });
});

describe("the network log", () => {
  it("lists only allowed origins and redacts credential headers", async () => {
    const s = await session({});
    try {
      await s.run("browser_navigate", { url: `${sites.appUrl}/network` });
      await s.run("browser_wait_for", { text: "same done" });
      await s.run("browser_wait_for", { text: "cross done" });
      const log = await s.run("browser_network_requests", { static: true, requestBody: true, requestHeaders: true });
      assert.match(log, /\/api => \[200\]/);
      assert.doesNotMatch(log, new RegExp(sites.intranetUrl.replace(/[.:/]/g, "\\$&")));
      assert.match(log, /authorization: \[redacted by peeps-bridge\]/);
      assert.match(log, /cookie: \[redacted by peeps-bridge\]/);
      assert.doesNotMatch(log, /token-value-123456|cookie-value-abcdef/);
    } finally {
      await s.host.close();
    }
  });
});
