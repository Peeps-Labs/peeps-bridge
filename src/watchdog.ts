/**
 * The last line of defence for Ctrl-C: if this process's event loop stops
 * turning (a synchronous call that never returns), no signal handler, timer
 * or browser cleanup can run. A worker thread, which has its own loop, sees
 * the main loop's heartbeat stop, removes the scratch directory, and kills the
 * process. Chromium exits with its parent (Playwright drives it over a pipe).
 *
 * A laptop that sleeps suspends both threads. Times are monotonic
 * (`performance`), which on Linux and macOS do not advance during suspend;
 * and where a clock does jump, the worker sees its own tick arrive late and
 * gives the main thread a full `stallMs` from the resume before calling it a
 * stall (`stallDecision`).
 *
 * Nothing the runner does legitimately blocks the loop for more than a
 * moment: browser calls are asynchronous and bounded by their own timeouts.
 */

import { Worker } from "node:worker_threads";

export interface Watchdog {
  /** A directory to remove before killing the process. */
  scratch(directory: string): void;
  stop(): void;
}

export interface StallState {
  /** When the worker last ticked. */
  lastTick: number;
  /** When the worker last found it had been suspended. */
  resumedAt: number;
}

/**
 * One worker tick: is the main thread stalled? Pure, and serialised into the
 * worker with `toString()`, so it may use nothing outside itself.
 */
export function stallDecision(state: StallState, now: number, beat: number, stallMs: number, tickMs: number): { state: StallState; kill: boolean } {
  const suspended = now - state.lastTick > tickMs * 4;
  const resumedAt = suspended ? now : state.resumedAt;
  const since = Math.max(beat, resumedAt);
  return { state: { lastTick: now, resumedAt }, kill: now - since >= stallMs };
}

/**
 * Kill every process descended from `pid` (Chromium and its helpers), so
 * none outlives a forced exit and recreates files under the scratch
 * directory. POSIX only (`pgrep -P`); elsewhere it does nothing. Serialised
 * into the worker too, so it takes its `execFileSync` as an argument.
 */
export function killDescendants(pid: number, exec: (file: string, args: string[], options: object) => string): void {
  // No inner named functions: this is serialised with toString(), and a
  // bundler's name-keeping helper would not exist in the worker.
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    let out = "";
    try {
      out = exec("pgrep", ["-P", String(parent)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    for (const child of out.split(/\s+/).filter(Boolean).map(Number)) {
      found.push(child);
      queue.push(child);
    }
  }
  for (const child of found) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const stallDecision = ${stallDecision.toString()};
const killDescendants = ${killDescendants.toString()};
const beat = new Float64Array(workerData.shared);
const now = () => performance.timeOrigin + performance.now();
const scratch = [];
parentPort.on("message", (directory) => scratch.push(directory));
let state = { lastTick: now(), resumedAt: 0 };
setInterval(() => {
  const t = now();
  const decision = stallDecision(state, t, beat[0], workerData.stallMs, workerData.tickMs);
  state = decision.state;
  if (!decision.kill) return;
  // The terminal may be gone (EIO): the cleanup and the kill must still run.
  try {
    fs.writeSync(2, "\\n[peeps] the runner's event loop has been blocked for " + Math.round((t - beat[0]) / 1000) + " s; closing the browser and exiting.\\n");
  } catch {}
  // Chromium first: alive, it would recreate its profile after the rmSync.
  try { killDescendants(workerData.pid, require("node:child_process").execFileSync); } catch {}
  for (const directory of scratch) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
  process.kill(workerData.pid, "SIGKILL");
}, workerData.tickMs);
`;

export function startEventLoopWatchdog(options: { stallMs: number }): Watchdog {
  const shared = new SharedArrayBuffer(8);
  const beat = new Float64Array(shared);
  const tick = () => {
    beat[0] = performance.timeOrigin + performance.now();
  };
  tick();
  const heartbeat = setInterval(tick, Math.max(25, Math.floor(options.stallMs / 8)));
  heartbeat.unref();
  const tickMs = Math.min(1000, Math.max(50, Math.floor(options.stallMs / 4)));
  const worker = new Worker(WORKER, { eval: true, workerData: { shared, stallMs: options.stallMs, tickMs, pid: process.pid } });
  worker.unref();
  return {
    scratch: (directory) => worker.postMessage(directory),
    stop: () => {
      clearInterval(heartbeat);
      void worker.terminate();
    },
  };
}
