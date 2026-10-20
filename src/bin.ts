#!/usr/bin/env node
/**
 * The `peeps-bridge` command.
 *
 * Ctrl-C stops polling and lets the call in hand finish, so Peeps gets its
 * answer. A second Ctrl-C, or `STOP_DEADLINE_MS` after the first, closes the
 * browser and exits at once even if that call is stuck. If the event loop
 * itself is blocked, so that no handler can run, the watchdog thread kills
 * the process (`watchdog.ts`).
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
  // Synchronous: process.exit below would drop a pending pipe write.
  fs.writeSync(1, "[peeps] closing the browser now\n");
  await Promise.race([host?.close(), new Promise((resolve) => setTimeout(resolve, CLOSE_GRACE_MS))]);
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

const code = await main(
  process.argv.slice(2),
  process.env,
  { out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`) },
  {
    signal: stop.signal,
    onHost: (h) => {
      host = h;
      watchdog.scratch(h.workspace);
    },
  },
);
watchdog.stop();
process.exit(forcing ? 130 : code);
