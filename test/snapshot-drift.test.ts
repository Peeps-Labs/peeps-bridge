/**
 * Drift test for `snapshot-lines.ts`: render a deliberately awkward page with
 * real Chromium, parse the snapshot YAML with a real YAML parser, and check
 * that our one-line parser agrees on every node's role, name, attributes, ref
 * and value. If Playwright changes how it writes snapshots, this fails.
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { isMap, isScalar, isSeq, parseDocument, type Node as YamlNode } from "yaml";

import { startBrowserHost, type BrowserHost } from "../src/browser/browser-host.js";
import { OriginPolicy } from "../src/browser/origin-policy.js";
import { parseLine } from "../src/browser/snapshot-lines.js";

const AWKWARD = `<!doctype html><html><head><title>Awkward: "title" # \\ - ü</title></head><body>
<h1>Heading: with colon</h1>
<h2>"Quoted" and 'single' and \\ backslash</h2>
<h3># hash first</h3>
<h4>- dash first</h4>
<h5>/api/v1/</h5>
<p>Ünïcödé — 日本語 🔑 text</p>
<p>123</p>
<p>true</p>
<p>  padded  </p>
<a href="/a:b?c=d#e">Link: to "somewhere" # 1</a>
<ul><li>one: 1</li><li>two</li><li>- three</li></ul>
<label>Password: required <input type="password" value="pa:ss #word"></label>
<label>It's "quoted": yes <input value="line1"></label>
<label>Back\\slash <input value="C:\\temp\\x"></label>
<label>Hash # name <input value="# not a comment"></label>
<label>Unicode ü 🔑 <input value="ü 🔑 value"></label>
<label>Dash <input value="- dash value"></label>
<label>Number <input value="42"></label>
<label>Colon value <input value="a: b"></label>
<textarea aria-label="Multi: line">first line
second: line
third # line</textarea>
<div contenteditable="true" aria-label="Rich: editor"><p>para one: x</p><p>para "two"</p></div>
<div contenteditable="true">leaf: editable 'text'</div>
<button aria-pressed="true">Toggle: on</button>
<input type="checkbox" checked aria-label="Check: me">
<select aria-label="Pick: one"><option>a: 1</option><option selected>b: "2"</option></select>
<details open><summary>Details: open</summary><p>inside</p></details>
<iframe srcdoc="<h1>Frame: heading</h1><label>Frame pass <input type=password value='fr:ame'></label><p>frame &quot;text&quot;</p>"></iframe>
</body></html>`;

let server: http.Server;
let url = "";
let host: BrowserHost;
let tmpRoot: string;

before(async () => {
  server = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(AWKWARD));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-drift-"));
  host = await startBrowserHost({ policy: OriginPolicy.from(url, []), secrets: {}, version: "test", tmpRoot });
});
after(async () => {
  await host?.close();
  server?.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

interface Expected {
  role: string | null;
  name: string | null;
  attrs: string[];
  ref: string | null;
  value: string | null;
  opensChildren: boolean;
}

/** What the YAML parser says each node (in document order) is. */
function fromYaml(text: string): Expected[] {
  const doc = parseDocument(text);
  assert.deepEqual(doc.errors, [], "Playwright's snapshot is not valid YAML");
  const out: Expected[] = [];
  const visit = (seq: YamlNode | null) => {
    assert.ok(isSeq(seq), "every level of a snapshot is a sequence");
    for (const item of seq.items) {
      if (isScalar(item)) {
        out.push({ ...fromKey(String(item.value)), value: null, opensChildren: false });
      } else if (isMap(item)) {
        assert.equal(item.items.length, 1, "a snapshot node is a one-key map");
        const pair = item.items[0]!;
        const key = String((pair.key as { value: unknown }).value);
        if (isSeq(pair.value)) {
          out.push({ ...fromKey(key), value: null, opensChildren: true });
          visit(pair.value);
        } else {
          const v = pair.value === null ? null : (pair.value as { value: unknown }).value;
          out.push({ ...fromKey(key), value: v === null ? null : String(v), opensChildren: false });
        }
      } else {
        assert.fail(`unexpected YAML node ${String(item)}`);
      }
    }
  };
  visit(doc.contents);
  return out;
}

/** The key's parts, the way Playwright builds it (createKey in the injected script). */
function fromKey(key: string): Omit<Expected, "value" | "opensChildren"> {
  const m = /^([a-z]+)(?: ("(?:[^"\\]|\\.)*"|\/.*\/(?= \[|$)))?((?: \[[^\]]*\])*)$/.exec(key);
  if (!m) return { role: /^[a-z]+$/.test(key) ? key : null, name: null, attrs: [], ref: null };
  const name = m[2] === undefined ? null : m[2].startsWith('"') ? (JSON.parse(m[2]) as string) : m[2];
  const attrs = [...(m[3] ?? "").matchAll(/\[([^\]]*)\]/g)].map((a) => a[1]!);
  const ref = attrs.find((a) => a.startsWith("ref="))?.slice(4) ?? null;
  return { role: m[1]!, name, attrs, ref };
}

function fromOurs(text: string): Expected[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const p = parseLine(line);
      assert.ok(p, `snapshot-lines.ts could not parse: ${line}`);
      return { role: p.role, name: p.name, attrs: p.attrs, ref: p.ref, value: p.value, opensChildren: p.opensChildren };
    });
}

function assertAgree(snapshot: string) {
  const yaml = fromYaml(snapshot);
  const ours = fromOurs(snapshot);
  assert.equal(ours.length, yaml.length, "one parsed line per YAML node");
  const lines = snapshot.split("\n").filter((l) => l.trim() !== "");
  for (const [i, expected] of yaml.entries()) {
    // A property line (`/url: …`) is not a role; both must agree it has none.
    assert.deepEqual(ours[i], expected, `line ${i + 1}: ${lines[i]}`);
  }
}

describe("snapshot-lines.ts against a real YAML parser", () => {
  it("agrees on every line of page.ariaSnapshot({ mode: 'ai' })", async () => {
    await host.callTool("browser_navigate", { url });
    const page = host.context.pages()[0]!;
    const snapshot = await (page as unknown as { ariaSnapshot(o: object): Promise<string> }).ariaSnapshot({ mode: "ai" });
    // The awkward cases are really there, or the test proves nothing.
    for (const needle of [`'textbox "Password: required"`, `heading "Heading: with colon"`, "日本語", "pa:ss #word", "/api/v1/"]) {
      assert.ok(snapshot.includes(needle) || /hidden/.test(needle), `the page did not produce ${needle}:\n${snapshot}`);
    }
    assertAgree(snapshot);
  });

  it("agrees on every line of the snapshot file @playwright/mcp writes (iframes stitched in)", async () => {
    await host.callTool("browser_snapshot", {});
    const output = path.join(host.workspace, "output");
    const latest = fs
      .readdirSync(output)
      .filter((n) => /^page-.*\.yml$/.test(n))
      .map((n) => path.join(output, n))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]!;
    const snapshot = fs.readFileSync(latest, "utf8");
    assert.match(snapshot, /\[ref=f\d+e\d+\]/, "the iframe's nodes are in MCP's snapshot");
    assertAgree(snapshot);
  });
});
