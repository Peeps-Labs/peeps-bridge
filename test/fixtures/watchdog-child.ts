// Child process for watchdog.test.ts: `stall` blocks the event loop for good,
// `healthy` keeps it turning and exits on its own.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { startEventLoopWatchdog } from "../../src/watchdog.js";

const [mode, scratch] = process.argv.slice(2);
const watchdog = startEventLoopWatchdog({ stallMs: mode === "chromium" ? 1500 : 400 });
watchdog.scratch(scratch!);
fs.mkdirSync(scratch!, { recursive: true });
if (mode === "chromium") {
  // A real browser with its profile in the scratch directory, as the runner has.
  const context = await chromium.launchPersistentContext(path.join(scratch!, "profile"), { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  await context.pages()[0]!.goto("data:text/html,<h1>x</h1>");
  process.stdout.write("stalling\n");
  for (;;) {
    // Blocked for good, with Chromium alive.
  }
} else if (mode === "stall") {
  setTimeout(() => {
    process.stdout.write("stalling\n");
    for (;;) {
      // A synchronous loop that never yields, like a catastrophic regex.
    }
  }, 200);
} else {
  const timer = setInterval(() => {}, 100);
  setTimeout(() => {
    clearInterval(timer);
    process.stdout.write("done\n");
    process.exit(0);
  }, 1500);
}
