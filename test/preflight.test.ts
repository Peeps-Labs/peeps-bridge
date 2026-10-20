import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { chromiumExecutablePath, chromiumPreflight, installCommand, PLAYWRIGHT_CORE_VERSION } from "../src/browser/preflight.js";

describe("chromiumPreflight", () => {
  it("passes when this playwright-core's headless Chromium is installed", () => {
    const executable = chromiumExecutablePath();
    assert.ok(executable && fs.existsSync(executable), "the test machine has Chromium installed");
    assert.deepEqual(chromiumPreflight(), { ok: true });
  });

  it("names the exact install command and its size when Chromium is missing", () => {
    for (const result of [chromiumPreflight(null), chromiumPreflight("/nowhere/chrome", () => false)]) {
      assert.equal(result.ok, false);
      const message = (result as { message: string }).message;
      assert.ok(message.includes(`npx -y playwright-core@${PLAYWRIGHT_CORE_VERSION} install --only-shell chromium`));
      assert.match(message, /MB/);
      assert.match(message, /does not install it for you/);
    }
  });

  it("pins the install command to the playwright-core version", () => {
    assert.equal(installCommand("1.2.3"), "npx -y playwright-core@1.2.3 install --only-shell chromium");
  });
});
