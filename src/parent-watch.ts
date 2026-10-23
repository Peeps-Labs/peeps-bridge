/**
 * Stop when the process that started the runner exits.
 *
 * A coding agent that stops its background job kills the npx process. npm
 * forwards SIGINT and SIGTERM to the child it started, but on Linux that
 * child is npm's `sh -c` (dash), which neither passes them on nor exits
 * until the runner does, and a SIGKILL of npx reaches nobody: the runner,
 * orphaned, would keep polling with a live browser. So the runner watches its parent. An orphan is
 * re-parented (to init, or to a subreaper such as systemd's user manager), so
 * a parent pid that differs from the one recorded at start means the parent
 * is gone. `process.ppid` is read from the OS on every access (Node 22, 24).
 *
 * npm runs the command through `sh -c`. Where that shell does not exec it
 * (dash, Linux's usual `/bin/sh`), the shell sits between npx and the runner
 * and outlives a killed npx: the runner's own parent never changes. So when
 * npm started the runner and its parent is a shell, the shell's parent (npx)
 * is watched as well. Nothing above npx is watched: npx outliving the shell
 * that ran it (`nohup`, a backgrounded job) keeps the runner going.
 *
 * The snapshot is taken before the runner loads anything heavy (`bin.ts`
 * imports the rest only afterwards), and a launcher already gone by then is
 * caught by `launcherGone`.
 *
 * Windows does not re-parent, so there the watch never fires.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** `pid`'s parent was `ppid` when the runner started. */
export interface WatchedEdge {
  pid: number;
  ppid: number;
}

/** A process's parent pid; null when there is no such process; throws when it cannot tell. */
export type PpidReader = (pid: number) => number | null;

const SHELLS = new Set(["sh", "dash", "bash", "zsh", "ash", "ksh"]);
/** What an orphan is re-parented to: init, launchd, a user manager, a container's init. */
export const REAPERS = new Set(["systemd", "init", "launchd", "tini", "dumb-init", "docker-init", "catatonit"]);

/**
 * Where there is no `/proc` (macOS): `ps`, which answers 1 with no output for
 * a process that does not exist. Exported for its test.
 */
export function ps(field: "ppid" | "comm", pid: number): string | null {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (error) {
    if ((error as { status?: unknown }).status === 1) return null;
    throw error;
  }
}

/**
 * Read `/proc/<pid>/<file>` (Linux). Undefined where there is no `/proc`;
 * null when the process does not exist (ENOENT, ESRCH). Any other failure
 * (EMFILE, EIO, EACCES) is thrown: it says nothing about the process, so the
 * watch skips that tick instead of taking it for a parent gone.
 */
export function procRead(
  pid: number,
  file: "stat" | "comm",
  read: (path: string, encoding: "utf8") => string = fs.readFileSync,
  hasProc: () => boolean = () => fs.existsSync("/proc/self/stat"),
): string | null | undefined {
  if (!hasProc()) return undefined;
  try {
    return read(`/proc/${pid}/${file}`, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT" || code === "ESRCH") return null;
    throw error;
  }
}

/** How a process is looked up; injectable for tests. */
export interface ProcessIo {
  proc: (pid: number, file: "stat" | "comm") => string | null | undefined;
  ps: (field: "ppid" | "comm", pid: number) => string | null;
}

const OS: ProcessIo = { proc: (pid, file) => procRead(pid, file), ps };

export function readPpid(pid: number, io: ProcessIo = OS): number | null {
  if (pid === process.pid) return process.ppid;
  const stat = io.proc(pid, "stat");
  // `pid (comm) state ppid …`; comm may itself contain ") ".
  if (stat !== undefined) return stat === null ? null : Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  const out = io.ps("ppid", pid);
  return out === null ? null : Number(out);
}

/** A process's command name (`sh`, `node`), or null if there is none or it cannot tell. */
export function readName(pid: number, io: ProcessIo = OS): string | null {
  try {
    const comm = io.proc(pid, "comm");
    if (comm !== undefined) return comm === null ? null : comm.trim();
    const out = io.ps("comm", pid);
    // macOS prints the path.
    return out === null ? null : path.basename(out);
  } catch {
    return null;
  }
}

/**
 * Started by `npx` / `npm exec` as this command, so a launcher should be
 * there. npm's variables are inherited, so a harness that npx started and
 * that then starts the runner itself also has them: npm's script (npm 11 sets
 * `"peeps-bridge"`, quotes included) tells the two apart.
 */
const npmLaunched = (env: NodeJS.ProcessEnv) =>
  (env.npm_command === "exec" || env.npm_lifecycle_event === "npx") && /^"?peeps-bridge(?:"|\s|$)/.test(env.npm_lifecycle_script ?? "");

/** The parent links to watch, recorded once at start. */
export function watchedChain(options: { pid: number; ppid: number; env: NodeJS.ProcessEnv; readPpid: PpidReader; readName: (pid: number) => string | null }): WatchedEdge[] {
  const chain: WatchedEdge[] = [{ pid: options.pid, ppid: options.ppid }];
  if (!npmLaunched(options.env) || !SHELLS.has(options.readName(options.ppid) ?? "")) return chain;
  let npx: number | null;
  try {
    npx = options.readPpid(options.ppid);
  } catch {
    npx = null;
  }
  if (npx !== null) chain.push({ pid: options.ppid, ppid: npx });
  return chain;
}

/**
 * Did the launcher exit before the runner first looked? Only asked of an npx
 * launch, where npx (or npm's shell under it) must be the parent: there, a
 * parent that is init or a subreaper (told by its name, `systemd`, `launchd`
 * …) means npx is gone. A direct start is never judged: a runner daemonised
 * under init on purpose looks exactly the same. When npx is itself a
 * container's PID 1 it is `node`, not a reaper; a reaper the list does not
 * name, or a process it cannot read, is not judged gone either.
 */
export function launcherGone(options: { pid: number; ppid: number; env: NodeJS.ProcessEnv; readPpid: PpidReader; readName: (pid: number) => string | null }): boolean {
  if (!npmLaunched(options.env)) return false;
  const reaper = (pid: number | null) => pid !== null && REAPERS.has(options.readName(pid) ?? "");
  if (reaper(options.ppid)) return true;
  if (!SHELLS.has(options.readName(options.ppid) ?? "")) return false;
  try {
    return reaper(options.readPpid(options.ppid));
  } catch {
    return false;
  }
}

/**
 * Check the chain every `intervalMs`; call `onGone` once, the first time a
 * watched process has a different parent or is gone. Never keeps the process
 * alive; a reader that cannot tell is not a change.
 */
export function startParentWatch(options: { chain: WatchedEdge[]; readPpid: PpidReader; intervalMs?: number; onGone: () => void }): { stop(): void } {
  const timer = setInterval(() => {
    for (const edge of options.chain) {
      let now: number | null;
      try {
        now = options.readPpid(edge.pid);
      } catch {
        continue;
      }
      if (now !== edge.ppid) {
        clearInterval(timer);
        options.onGone();
        return;
      }
    }
  }, options.intervalMs ?? 1_000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
