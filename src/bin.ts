#!/usr/bin/env node
/**
 * The `peeps-bridge` command. Ctrl-C stops polling, answers the call in hand
 * and closes the browser; a second Ctrl-C closes the browser at once.
 */

import type { BrowserHost } from "./browser/browser-host.js";
import { main } from "./cli.js";

const stop = new AbortController();
let host: BrowserHost | null = null;
let signals = 0;
const onSignal = () => {
  signals += 1;
  if (signals === 1) {
    process.stdout.write("\n[peeps] stopping...\n");
    stop.abort();
  } else {
    void host?.close();
  }
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
    },
  },
);
process.exit(code);
