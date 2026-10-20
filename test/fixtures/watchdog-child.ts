// Child process for watchdog.test.ts: `stall` blocks the event loop for good,
// `healthy` keeps it turning and exits on its own.
import fs from "node:fs";
import { startEventLoopWatchdog } from "../../src/watchdog.js";

const [mode, scratch] = process.argv.slice(2);
const watchdog = startEventLoopWatchdog({ stallMs: 400 });
watchdog.scratch(scratch!);
fs.mkdirSync(scratch!, { recursive: true });
if (mode === "stall") {
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
