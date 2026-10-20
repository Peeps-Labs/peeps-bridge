import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runChild(mode: "stall" | "healthy") {
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

  it("leaves a healthy runner alone, and does not keep it alive", async () => {
    const result = await runChild("healthy");
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /done/);
    fs.rmSync(path.dirname(result.scratch), { recursive: true, force: true });
  });
});
