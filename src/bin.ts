#!/usr/bin/env node
/**
 * The `peeps-bridge` command.
 *
 * Ctrl-C stops polling and lets the call in hand finish, so Peeps gets its
 * answer. A second Ctrl-C, or `STOP_DEADLINE_MS` after the first, closes the
 * browser and exits at once even if that call is stuck. If the event loop
 * itself is blocked, so that no handler can run, the watchdog thread kills
 * the process (`watchdog.ts`). SIGTERM and SIGHUP stop it as Ctrl-C does.
 */

import fs from "node:fs";

import type { BrowserHost } from "./browser/browser-host.js";
import { main } from "./cli.js";
import { startEventLoopWatchdog } from "./watchdog.js";

const STOP_DEADLINE_MS = 10_000;
const CLOSE_GRACE_MS = 3_000;
const STALL_MS = 30_000;

const watchdog = startEventLoopWatchdog({ stallMs: STALL_MS });
const stop = new AbortController();
let host: BrowserHost | null = null;
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
  await Promise.race([host?.close(), new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS))]);
  // Whatever close() did not get to: the scratch and profile directories.
  for (const directory of host?.scratchPaths() ?? []) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Nothing more to do on the way out.
    }
  }
  process.exit(130);
};

const onSignal = () => {
  if (stop.signal.aborted) {
    void force();
    return;
  }
  process.stdout.write("\n[peeps] stopping after the current action (Ctrl-C again to stop at once)\n");
  stop.abort();
  setTimeout(() => void force(), STOP_DEADLINE_MS).unref();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
// The terminal closing: the same orderly stop (Playwright's handler is off).
process.on("SIGHUP", onSignal);
// After SIGHUP the terminal is gone: a failed write must not stop the cleanup.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const code = await main(
  process.argv.slice(2),
  process.env,
  { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
  {
    signal: stop.signal,
    onHost: (h) => {
      host = h;
      for (const directory of h.scratchPaths()) watchdog.scratch(directory);
    },
  },
);
watchdog.stop();
process.exit(forcing ? 130 : code);
