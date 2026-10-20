/**
 * The last line of defence for Ctrl-C: if this process's event loop stops
 * turning (a synchronous call that never returns), no signal handler, timer
 * or browser cleanup can run. A worker thread, which has its own loop, sees
 * the main loop's heartbeat stop, removes the scratch directory, and kills the
 * process. Chromium exits with its parent (Playwright drives it over a pipe).
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

const WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const beat = new BigInt64Array(workerData.shared);
const scratch = [];
parentPort.on("message", (directory) => scratch.push(directory));
setInterval(() => {
  const silent = Date.now() - Number(Atomics.load(beat, 0));
  if (silent < workerData.stallMs) return;
  fs.writeSync(2, "\\n[peeps] the runner's event loop has been blocked for " + Math.round(silent / 1000) + " s; closing the browser and exiting.\\n");
  for (const directory of scratch) {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
  process.kill(workerData.pid, "SIGKILL");
}, Math.min(1000, Math.max(50, Math.floor(workerData.stallMs / 4))));
`;

export function startEventLoopWatchdog(options: { stallMs: number }): Watchdog {
  const shared = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(shared);
  const tick = () => Atomics.store(beat, 0, BigInt(Date.now()));
  tick();
  const heartbeat = setInterval(tick, Math.max(25, Math.floor(options.stallMs / 8)));
  heartbeat.unref();
  const worker = new Worker(WORKER, { eval: true, workerData: { shared, stallMs: options.stallMs, pid: process.pid } });
  worker.unref();
  return {
    scratch: (directory) => worker.postMessage(directory),
    stop: () => {
      clearInterval(heartbeat);
      void worker.terminate();
    },
  };
}
