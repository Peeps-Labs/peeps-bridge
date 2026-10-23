/**
 * Who may stop the runner, and when a stop is forced. A signal (Ctrl-C,
 * SIGTERM, SIGHUP) or the launcher going away begins the orderly stop, once.
 * Only a second signal forces it, and only one that comes more than
 * `DUPLICATE_MS` after the first:
 * - a terminal's Ctrl-C reaches npx and the runner together, so the parent
 *   watch may begin the stop a moment before that same Ctrl-C arrives;
 * - where /bin/sh execs the command (macOS, Fedora) the runner is npx's own
 *   child, and npm forwards the Ctrl-C it got from the terminal, so the
 *   runner gets the same Ctrl-C twice, milliseconds apart.
 * Neither is the person pressing Ctrl-C again.
 */

export type StopReason = "signal" | "parent";

/** npm's forwarded copy lands within milliseconds; a person is slower. */
export const DUPLICATE_MS = 500;

export function stopControl(options: { begin: (reason: StopReason) => void; force: () => void; now?: () => number }) {
  const now = options.now ?? (() => performance.now());
  let begun = false;
  let firstSignalAt: number | null = null;
  const begin = (reason: StopReason) => {
    if (begun) return;
    begun = true;
    options.begin(reason);
  };
  return {
    signal() {
      if (firstSignalAt !== null) {
        if (now() - firstSignalAt >= DUPLICATE_MS) options.force();
        return;
      }
      firstSignalAt = now();
      begin("signal");
    },
    parentGone() {
      begin("parent");
    },
    begun: () => begun,
  };
}
