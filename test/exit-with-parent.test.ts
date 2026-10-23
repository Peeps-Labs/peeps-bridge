import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FakeBridge, SESSION_ID, call } from "./helpers/fake-bridge.js";
import { startSites } from "./helpers/sites.js";
import { REAPERS, readName, readPpid } from "../src/parent-watch.js";

const GRANT = "Bearer b1.1790000000000.c2lnbmF0dXJl";

/** Processes whose command line contains `text` (the runner's --server, Chromium's profile path). */
const processesWith = (text: string) => {
  try {
    return execFileSync("pgrep", ["-f", "--", text], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
};

async function waitFor(condition: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function underStandIn(mode: "npm" | "npm-exec" | "direct" | "npm-dies-at-once", kill: NodeJS.Signals | null, group = false) {
  const sites = await startSites();
  const bridge = await new FakeBridge().start();
  bridge.callReplies.push(call(1, "browser_snapshot", {}), ...Array.from({ length: 40 }, () => ({ status: 204, delayMs: 1000 })));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-parent-"));
  const standIn = spawn(
    process.execPath,
    ["--import", "tsx", "test/fixtures/npx-stand-in.ts", mode, "--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`],
    { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "pipe"], detached: group },
  );
  let output = "";
  standIn.stdout.on("data", (c) => (output += c));
  standIn.stderr.on("data", (c) => (output += c));
  const runner = `src/bin.ts --server ${bridge.url}`;
  try {
    if (kill) {
      assert.ok(await waitFor(() => /#1 /.test(output), 30_000), output);
      assert.ok(processesWith(tmp).length > 0, "Chromium is running");
      if (mode === "npm") {
        // npm's shell really is between them, whatever /bin/sh is here.
        const [pid] = processesWith(runner);
        assert.ok(pid, output);
        const parent = readPpid(pid);
        assert.ok(parent !== null && parent !== standIn.pid && ["sh", "dash", "bash"].includes(readName(parent) ?? ""), `the runner's parent is ${parent} (${parent && readName(parent)})`);
        assert.equal(readPpid(parent), standIn.pid);
      }
      // A terminal's Ctrl-C signals the whole process group.
      if (group) process.kill(-standIn.pid!, kill);
      else standIn.kill(kill);
    } else {
      // The stand-in kills itself; the runner is up by now or about to be.
      assert.ok(await waitFor(() => processesWith(runner).length > 0, 10_000), output);
    }
    const killed = Date.now();
    const gone = await waitFor(() => processesWith(runner).length === 0 && processesWith(tmp).length === 0, kill ? 15_000 : 30_000);
    const took = Date.now() - killed;
    return { bridge, output: () => output, gone, took, leftovers: fs.readdirSync(tmp).filter((d) => d.startsWith("peeps-bridge-") || d.startsWith("playwright_chromiumdev_profile-")) };
  } finally {
    for (const pid of [...processesWith(runner), ...processesWith(tmp)]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone.
      }
    }
    await bridge.stop();
    await sites.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assertStoppedCleanly(result: Awaited<ReturnType<typeof underStandIn>>) {
  const { bridge, output } = result;
  assert.ok(result.gone, `the runner or Chromium is still running ${result.took} ms later:\n${output()}`);
  assert.ok(result.took < 8_000, `took ${result.took} ms`);
  assert.match(output(), /the process that started the runner exited; stopping/);
  const detaches = bridge.of("detach");
  assert.equal(detaches.length, 1, output());
  assert.equal(detaches[0]!.headers.authorization, GRANT);
  assert.equal(detaches[0]!.headers["x-peeps-runner-instance"], bridge.of("calls")[0]!.headers["x-peeps-runner-instance"]);
  assert.deepEqual(result.leftovers, []);
}

/** The name of what an orphan is re-parented to here: a `sleep` whose shell has exited. */
function orphanReaper(): string | null {
  if (process.platform === "win32") return null;
  const pid = Number(execFileSync("sh", ["-c", "sleep 5 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).trim());
  try {
    const parent = readPpid(pid);
    return parent === null ? null : readName(parent);
  } finally {
    process.kill(pid, "SIGKILL");
  }
}
const reaper = orphanReaper();

describe("the runner exits with the process that started it", { skip: process.platform === "win32" }, () => {
  it("when npx is killed outright (SIGKILL), though npm's sh -c survives it", async () => {
    assertStoppedCleanly(await underStandIn("npm", "SIGKILL"));
  });

  it("when npx gets SIGTERM, which npm passes to its sh -c only", async () => {
    assertStoppedCleanly(await underStandIn("npm", "SIGTERM"));
  });

  it("when the process that started it directly is killed", async () => {
    assertStoppedCleanly(await underStandIn("direct", "SIGKILL"));
  });

  it("adds nothing to a stop already under way: a terminal's Ctrl-C reaches npx and the runner together", async () => {
    const result = await underStandIn("npm", "SIGINT", true);
    assert.ok(result.gone, result.output());
    // Whichever the runner saw first, the signal or its parent going: one
    // orderly stop, never escalated to the forced one.
    assert.equal(result.output().match(/stopping/g)?.length, 1, result.output());
    assert.doesNotMatch(result.output(), /closing the browser now/);
    assert.equal(result.bridge.of("detach").length, 1);
  });

  it("stops in order on one Ctrl-C where npx is the runner's parent, though npm forwards a second copy of it", async () => {
    const result = await underStandIn("npm-exec", "SIGINT", true);
    assert.ok(result.gone, result.output());
    assert.doesNotMatch(result.output(), /closing the browser now/);
    assert.equal(result.output().match(/stopping/g)?.length, 1, result.output());
    assert.equal(result.bridge.of("detach").length, 1, result.output());
  });

  // Before the runner looks, only the name of what adopted it tells it the
  // launcher is gone. Where orphans go to something unlisted (a container
  // with no init, an agent that is a subreaper) it cannot tell, and does not
  // stop: by design, as a direct start under init looks the same.
  it("when the launcher dies before the runner has even loaded", { skip: !REAPERS.has(reaper ?? "") && `orphans here go to ${reaper ?? "an unknown process"}, which is not a known reaper` }, async () => {
    const result = await underStandIn("npm-dies-at-once", null);
    assert.ok(result.gone, `the runner or Chromium is still running ${result.took} ms later:\n${result.output()}`);
    // Its last line may still be in the pipe.
    await waitFor(() => /exited/.test(result.output()), 2_000);
    assert.match(result.output(), /the process that started the runner exited/);
    assert.doesNotMatch(result.output(), /#1 /);
    // Nothing was served; if it got as far as attaching, it detached.
    assert.equal(result.bridge.of("detach").length, result.bridge.of("attach").length, result.output());
    assert.deepEqual(result.leftovers, []);
  });
});
