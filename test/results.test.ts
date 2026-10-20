import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RESULT_CAP_BYTES, shapeResult } from "../src/browser/results.js";
import { loadSecrets, makeScrubber } from "../src/browser/secrets.js";

let workspace: string;
let outside: string;

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-results-"));
  fs.mkdirSync(path.join(workspace, "output"));
  fs.writeFileSync(path.join(workspace, "output", "page-1.yml"), '- heading "Checkout" [level=1] [ref=e2]\n');
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-outside-"));
  fs.writeFileSync(path.join(outside, "secret.yml"), "PRIVATE KEY\n");
});
after(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

const text = (t: string) => ({ content: [{ type: "text", text: t }] });
const noScrub = (s: string) => s;

describe("shapeResult", () => {
  it("inlines the snapshot file the action wrote", () => {
    const shaped = shapeResult(text("### Page\n- Page URL: http://localhost:3000/checkout\n### Snapshot\n- [Snapshot](output/page-1.yml)"), { workspace, scrub: noScrub });
    assert.deepEqual(shaped.content.length, 1);
    assert.match(shaped.content[0]!.text, /### Snapshot\n```yaml\n- heading "Checkout" \[level=1\] \[ref=e2\]\n```/);
    assert.doesNotMatch(shaped.content[0]!.text, /\]\(output/);
    assert.equal(shaped.isError, undefined);
  });

  it("never reads a snapshot link that points outside the workspace", () => {
    const rel = path.relative(workspace, path.join(outside, "secret.yml"));
    const shaped = shapeResult(text(`### Snapshot\n- [Snapshot](${rel})`), { workspace, scrub: noScrub });
    assert.doesNotMatch(shaped.content[0]!.text, /PRIVATE KEY/);
    assert.match(shaped.content[0]!.text, /snapshot was not available/);
    const absolute = shapeResult(text(`- [Snapshot](${path.join(outside, "secret.yml")})`), { workspace, scrub: noScrub });
    assert.doesNotMatch(absolute.content[0]!.text, /PRIVATE KEY/);
  });

  it("drops links to other files on this machine", () => {
    const shaped = shapeResult(text("- New console entries: output/console-1.log#L1-L4\n- [Console](output/console.log)\n- [Docs](https://example.com/x)"), {
      workspace,
      scrub: noScrub,
    });
    const out = shaped.content[0]!.text;
    assert.match(out, /- New console entries: call browser_console_messages to read them/);
    assert.doesNotMatch(out, /console-1\.log/);
    assert.match(out, /- Console: \(a file on the runner; not sent\)/);
    assert.match(out, /\[Docs\]\(https:\/\/example\.com\/x\)/);
  });

  it("keeps text parts and isError only", () => {
    const shaped = shapeResult(
      { content: [{ type: "text", text: "### Error\nboom" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "more" }], isError: true },
      { workspace, scrub: noScrub },
    );
    assert.deepEqual(shaped, { content: [{ type: "text", text: "### Error\nboom\nmore" }], isError: true });
  });

  it("answers an error when the server returned no text at all", () => {
    const shaped = shapeResult({ content: [] }, { workspace, scrub: noScrub });
    assert.equal(shaped.isError, true);
    assert.match(shaped.content[0]!.text, /no text/);
    assert.equal(shapeResult({} as never, { workspace, scrub: noScrub }).isError, true);
  });

  it("names blocked origins so the agent learns why", () => {
    const shaped = shapeResult(text("### Result\nok"), { workspace, scrub: noScrub, blocked: ["https://evil.example", "https://evil.example", "intranet:443"] });
    assert.match(shaped.content[0]!.text, /blocked requests to origins outside this session's allowed list: https:\/\/evil\.example, intranet:443/);
  });

  it("caps the result at 200 KB with a truncation marker", () => {
    const big = "### Snapshot\n" + "- generic [ref=e1]: lorem ipsum\n".repeat(20_000);
    const shaped = shapeResult(text(big), { workspace, scrub: noScrub });
    const out = shaped.content[0]!.text;
    assert.ok(Buffer.byteLength(JSON.stringify(out)) <= RESULT_CAP_BYTES, `encoded ${Buffer.byteLength(JSON.stringify(out))}`);
    assert.match(out, /\[TRUNCATED by peeps-bridge: the result was \d+ bytes; capped at 204800\]$/);
    assert.ok(out.startsWith("### Snapshot\n- generic"));
  });

  it("caps on the encoded size, so escapes cannot push it past the route's limit", () => {
    const shaped = shapeResult(text("\u0001".repeat(150_000)), { workspace, scrub: noScrub });
    assert.ok(Buffer.byteLength(JSON.stringify(shaped.content[0]!.text)) <= RESULT_CAP_BYTES);
  });

  it("scrubs before truncating, so a cut never leaves part of a secret", () => {
    const scrub = makeScrubber({ SHOP_PASSWORD: "Peeps-Test-2026!" });
    const filler = "x".repeat(RESULT_CAP_BYTES - 200);
    const shaped = shapeResult(text(filler + "Peeps-Test-2026!".repeat(40)), { workspace, scrub });
    assert.doesNotMatch(shaped.content[0]!.text, /Peeps-Te/);
  });

  it("leaves a small result untouched apart from scrubbing", () => {
    assert.deepEqual(shapeResult(text("### Result\nfine"), { workspace, scrub: noScrub }), { content: [{ type: "text", text: "### Result\nfine" }] });
  });
});

describe("secrets", () => {
  it("reads the named environment variables", () => {
    const secrets = loadSecrets(["SHOP_EMAIL=E2E_EMAIL", "SHOP_PASSWORD=E2E_PASSWORD"], { E2E_EMAIL: "shopper@example.test", E2E_PASSWORD: "Peeps-Test-2026!" });
    assert.deepEqual(secrets, { SHOP_EMAIL: "shopper@example.test", SHOP_PASSWORD: "Peeps-Test-2026!" });
  });

  it("refuses a missing or empty variable without printing any value", () => {
    assert.throws(() => loadSecrets(["P=NOPE"], {}), /NOPE is not set/);
    assert.throws(() => loadSecrets(["P=EMPTY"], { EMPTY: "" }), /EMPTY is not set/);
  });

  it("refuses malformed or duplicate specs", () => {
    assert.throws(() => loadSecrets(["P"], {}), /NAME=ENV_VAR/);
    assert.throws(() => loadSecrets(["P=1BAD"], {}), /NAME=ENV_VAR/);
    assert.throws(() => loadSecrets(["bad name=X"], { X: "v" }), /NAME=ENV_VAR/);
    assert.throws(() => loadSecrets(["P=X", "P=Y"], { X: "a", Y: "b" }), /twice/);
  });

  it("scrubs a value in every encoding a page or a request log shows it in", () => {
    const scrub = makeScrubber({ SHOP_PASSWORD: "Peeps-Test-2026!", NOTE: 'a "quoted" & <b> value' });
    assert.equal(scrub("pw=Peeps-Test-2026!"), "pw=<secret>SHOP_PASSWORD</secret>");
    assert.equal(scrub("password=Peeps-Test-2026%21&x=1"), "password=<secret>SHOP_PASSWORD</secret>&x=1");
    assert.equal(scrub('{"note":"a \\"quoted\\" & <b> value"}'), '{"note":"<secret>NOTE</secret>"}');
    assert.equal(scrub("a &quot;quoted&quot; &amp; &lt;b&gt; value"), "<secret>NOTE</secret>");
    assert.equal(scrub("note=a+%22quoted%22+%26+%3Cb%3E+value"), "note=<secret>NOTE</secret>");
    assert.equal(scrub("nothing here"), "nothing here");
  });

  it("scrubs the longer of two overlapping values first", () => {
    const scrub = makeScrubber({ SHORT: "abc", LONG: "abcdef" });
    assert.equal(scrub("abcdef abc"), "<secret>LONG</secret> <secret>SHORT</secret>");
  });

  it("is a no-op without secrets", () => {
    assert.equal(makeScrubber({})("anything"), "anything");
  });
});
