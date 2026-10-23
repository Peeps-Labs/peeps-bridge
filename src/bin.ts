#!/usr/bin/env node
/**
 * The `peeps-bridge` command.
 *
 * Ctrl-C stops polling and lets the call in hand finish, so Peeps gets its
 * answer, then tells Peeps the runner is leaving (`detachOnStop`, bounded by
 * its own short deadline) before the browser closes. A second Ctrl-C, or
 * `STOP_DEADLINE_MS` after the first, closes the browser and exits at once
 * even if that call is stuck, telling Peeps alongside the close (best effort,
 * within `CLOSE_GRACE_MS`, and never a second time). If the event loop
 * itself is blocked, so that no handler can run, the watchdog thread kills
 * the process (`watchdog.ts`). SIGTERM and SIGHUP stop it as Ctrl-C does,
 * and so does the process that started it exiting (`parent-watch.ts`). npm
 * forwards SIGINT and SIGTERM to its child, but on Linux that is its `sh -c`
 * (dash), which swallows them and outlives npx, and a SIGKILL of npx reaches
 * nobody: an agent that kills npx would otherwise leave the runner polling
 * with a live browser. Where the shell execs the runner (macOS), npm's
 * forwarded copy of a Ctrl-C is not taken for a second one
 * (`stop-control.ts`).
 */

// Only light imports here: the parents are recorded before the runner loads
// anything heavy (`cli.js`, Playwright, which take a moment, longer on a cold
// npx), so that a launcher dying meanwhile is seen as a change. A static
// import would not do: ESM loads the whole static graph before running any.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

import type { BrowserHost } from "./browser/browser-host.js";
import { launcherGone, readName, readPpid, startParentWatch, watchedChain } from "./parent-watch.js";
import { stopControl } from "./stop-control.js";
import { killDescendants, startEventLoopWatchdog } from "./watchdog.js";

const snapshot = { pid: process.pid, ppid: process.ppid, env: process.env, readPpid, readName };
const chain = watchedChain(snapshot);
// npx already gone before the runner looked: there is nothing to serve for.
if (launcherGone(snapshot)) {
  // The launcher's pipe may have gone with it (EPIPE): exit all the same.
  try {
    fs.writeSync(1, "[peeps] the process that started the runner exited; stopping\n");
  } catch {
    // Nobody left to tell.
  }
  process.exit(0);
}

const STOP_DEADLINE_MS = 10_000;
const CLOSE_GRACE_MS = 3_000;
const STALL_MS = 30_000;

const watchdog = startEventLoopWatchdog({ stallMs: STALL_MS });
const stop = new AbortController();
let host: BrowserHost | null = null;
/** The session's once-only detach, from the moment the session starts. */
let detachNow: (() => Promise<void>) | null = null;
/** Known from the moment it exists, so a stop during startup removes it too. */
const scratch: string[] = [];
let forcing = false;

const force = async () => {
  if (forcing) return;
  forcing = true;
  // Synchronous: process.exit below would drop a pending pipe write. The
  // terminal may be gone (EIO after SIGHUP): the cleanup must still run.
  try {
    fs.writeSync(1, "[peeps] closing the browser now\n");
  } catch {
    // Nobody left to tell.
  }
  // Tell Peeps alongside the close: a no-op if a detach was already sent (the
  // in-flight one is awaited instead), if the session is over, or before it
  // attached.
  await Promise.race([Promise.all([host?.close(), detachNow?.()]), new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS))]);
  // Whatever close() did not get to. Chromium first (it may still be
  // starting): alive, it would recreate its profile after the removal.
  killDescendants(process.pid, execFileSync as never, (line) => {
    try {
      fs.writeSync(2, `${line}\n`);
    } catch {
      // The terminal is gone.
    }
  });
  for (const directory of scratch) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Nothing more to do on the way out.
    }
  }
  process.exit(130);
};

/**
 * The orderly stop: the call in hand is answered, Peeps is told, the browser
 * closes. Only a second signal forces it (`stop-control.ts`).
 */
const control = stopControl({
  begin: (reason) => {
    parentWatch.stop();
    process.stdout.write(
      reason === "signal" ? "\n[peeps] stopping after the current action (Ctrl-C again to stop at once)\n" : "[peeps] the process that started the runner exited; stopping\n",
    );
    stop.abort();
    setTimeout(() => void force(), STOP_DEADLINE_MS).unref();
  },
  force: () => void force(),
});
const onSignal = () => control.signal();
const parentWatch = startParentWatch({ chain, readPpid, onGone: () => control.parentGone() });
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
// The terminal closing: the same orderly stop (Playwright's handler is off).
process.on("SIGHUP", onSignal);
// After SIGHUP the terminal is gone: a failed write must not stop the cleanup.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const { main } = await import("./cli.js");
// Stopped while it was loading: leave before any browser is started.
if (stop.signal.aborted && !forcing) {
  watchdog.stop();
  parentWatch.stop();
  process.exit(0);
}
const code = await main(
  process.argv.slice(2),
  process.env,
  { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
  {
    signal: stop.signal,
    onScratch: (directory) => {
      scratch.push(directory);
      watchdog.scratch(directory);
    },
    onHost: (h) => {
      host = h;
    },
    onDetach: (d) => {
      detachNow = d;
    },
  },
);
watchdog.stop();
parentWatch.stop();
process.exit(forcing ? 130 : code);
