import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stallDecision } from "../src/watchdog.js";

function runChild(mode: "stall" | "healthy" | "chromium") {
  const scratch = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bridge-watchdog-")), "scratch");
  const child = spawn(process.execPath, ["--import", "tsx", "test/fixtures/watchdog-child.ts", mode, scratch], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const started = Date.now();
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; ms: number; scratch: string }>((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal, output, ms: Date.now() - started, scratch })),
  );
}

describe("the event-loop watchdog", () => {
  it("kills a runner whose event loop is stuck, removing its scratch directory first", async () => {
    const result = await runChild("stall");
    assert.equal(result.signal, "SIGKILL", result.output);
    assert.match(result.output, /stalling/);
    assert.match(result.output, /event loop has been blocked/);
    assert.equal(fs.existsSync(result.scratch), false);
    assert.ok(result.ms < 10_000);
    fs.rmSync(path.dirname(result.scratch), { recursive: true, force: true });
  });

  it("kills Chromium too, so nothing is left under the scratch directory (4 runs)", async () => {
    for (let run = 0; run < 4; run++) {
      const result = await runChild("chromium");
      assert.equal(result.signal, "SIGKILL", result.output);
      // Long enough for an orphaned Chromium to recreate its profile.
      await new Promise((r) => setTimeout(r, 2000));
      assert.equal(fs.existsSync(result.scratch), false, `run ${run}: ${fs.existsSync(result.scratch) ? fs.readdirSync(result.scratch, { recursive: true }).slice(0, 5).join(", ") : ""}`);
      fs.rmSync(path.dirname(result.scratch), { recursive: true, force: true });
    }
  });

  it("leaves a healthy runner alone, and does not keep it alive", async () => {
    const result = await runChild("healthy");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /done/);
    fs.rmSync(path.dirname(result.scratch), { recursive: true, force: true });
  });
});

describe("the watchdog's stall decision", () => {
  const TICK = 1000;
  const STALL = 30_000;

  it("declares a stall when the heartbeat stops while the worker keeps ticking", () => {
    let state = { lastTick: 0, resumedAt: 0 };
    let kill = false;
    for (let now = TICK; now <= 31_000 && !kill; now += TICK) ({ state, kill } = stallDecision(state, now, 0, STALL, TICK));
    assert.equal(kill, true);
  });

  it("does not, right after the whole machine was suspended (both threads' clocks jumped)", () => {
    // Laptop sleep: the worker's own tick arrives 2 hours late, and the
    // heartbeat is as old as the sleep.
    const before = 10_000;
    let { state, kill } = stallDecision({ lastTick: before, resumedAt: 0 }, before + 2 * 3600_000, before, STALL, TICK);
    assert.equal(kill, false);
    // The main thread resumes beating: still fine afterwards.
    ({ state, kill } = stallDecision(state, before + 2 * 3600_000 + TICK, before + 2 * 3600_000 + 500, STALL, TICK));
    assert.equal(kill, false);
  });

  it("still catches a real stall that starts after the machine resumed", () => {
    const resumed = 2 * 3600_000;
    let { state, kill } = stallDecision({ lastTick: 0, resumedAt: 0 }, resumed, 0, STALL, TICK);
    assert.equal(kill, false);
    for (let now = resumed + TICK; now <= resumed + 31_000 && !kill; now += TICK) ({ state, kill } = stallDecision(state, now, 0, STALL, TICK));
    assert.equal(kill, true);
  });
});
