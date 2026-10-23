import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { launcherGone, procRead, ps, readName, readPpid, startParentWatch, watchedChain, type WatchedEdge } from "../src/parent-watch.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What npm 11 sets for `npx -y @peepsai/bridge@x` and `npx --package=… peeps-bridge`. */
const SCRIPT = '"peeps-bridge"';

describe("startParentWatch", () => {
  const chain: WatchedEdge[] = [{ pid: 100, ppid: 50 }];

  it("does not fire while every watched parent stays the same", async () => {
    let fired = 0;
    const watch = startParentWatch({ chain, readPpid: () => 50, intervalMs: 10, onGone: () => fired++ });
    await tick(100);
    watch.stop();
    assert.equal(fired, 0);
  });

  it("fires once when a parent changes (re-parented to init or a subreaper), however long it stays changed", async () => {
    let ppid = 50;
    let fired = 0;
    const watch = startParentWatch({ chain, readPpid: () => ppid, intervalMs: 10, onGone: () => fired++ });
    await tick(40);
    assert.equal(fired, 0);
    ppid = 1;
    await tick(100);
    watch.stop();
    assert.equal(fired, 1);
  });

  it("fires when a watched ancestor is gone, and for any edge of the chain", async () => {
    let fired = 0;
    const watch = startParentWatch({
      chain: [
        { pid: 100, ppid: 50 },
        { pid: 50, ppid: 7 },
      ],
      readPpid: (pid) => (pid === 100 ? 50 : null),
      intervalMs: 10,
      onGone: () => fired++,
    });
    await tick(60);
    watch.stop();
    assert.equal(fired, 1);
  });

  it("does not fire when it cannot tell (the reader throws)", async () => {
    let fired = 0;
    const watch = startParentWatch({
      chain,
      readPpid: () => {
        throw new Error("no ps");
      },
      intervalMs: 10,
      onGone: () => fired++,
    });
    await tick(60);
    watch.stop();
    assert.equal(fired, 0);
  });

  it("does not fire when the OS cannot answer for a moment (EMFILE): that is not a parent gone", async () => {
    let fired = 0;
    const emfile = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    const watch = startParentWatch({
      chain,
      readPpid: (pid) => readPpid(pid, { proc: () => { throw emfile; }, ps }),
      intervalMs: 10,
      onGone: () => fired++,
    });
    await tick(60);
    watch.stop();
    assert.equal(fired, 0);
  });

  it("never fires after stop()", async () => {
    let fired = 0;
    const watch = startParentWatch({ chain, readPpid: () => 1, intervalMs: 30, onGone: () => fired++ });
    watch.stop();
    await tick(100);
    assert.equal(fired, 0);
  });

  it("never keeps the process alive", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "-e", `import("./src/parent-watch.ts").then((m) => m.startParentWatch({ chain: [{ pid: process.pid, ppid: process.ppid }], readPpid: m.readPpid, onGone: () => {} }))`],
      { stdio: "ignore" },
    );
    const started = Date.now();
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000);
  });
});

describe("watchedChain", () => {
  const names: Record<number, string> = { 50: "sh", 60: "node" };
  const ppids: Record<number, number> = { 50: 40, 60: 40 };
  const base = { pid: 100, readPpid: (pid: number) => ppids[pid] ?? null, readName: (pid: number) => names[pid] ?? null };

  it("watches the runner's own parent", () => {
    assert.deepEqual(watchedChain({ ...base, ppid: 60, env: {} }), [{ pid: 100, ppid: 60 }]);
  });

  it("also watches npx above the sh -c that npm puts between them, which outlives a killed npx", () => {
    assert.deepEqual(watchedChain({ ...base, ppid: 50, env: { npm_command: "exec", npm_lifecycle_script: SCRIPT } }), [
      { pid: 100, ppid: 50 },
      { pid: 50, ppid: 40 },
    ]);
  });

  it("watches nothing above the parent when npx started the runner directly, or no npx is involved", () => {
    assert.deepEqual(watchedChain({ ...base, ppid: 60, env: { npm_command: "exec", npm_lifecycle_script: SCRIPT } }), [{ pid: 100, ppid: 60 }]);
    // `node dist/bin.js` from a shell: the shell is the parent, and only it.
    assert.deepEqual(watchedChain({ ...base, ppid: 50, env: {} }), [{ pid: 100, ppid: 50 }]);
  });

  it("recognises npx by npm_lifecycle_event alone, and bash as npm's shell", () => {
    const bash = { ...base, readName: (pid: number) => (pid === 50 ? "bash" : null) };
    assert.deepEqual(watchedChain({ ...bash, ppid: 50, env: { npm_lifecycle_event: "npx", npm_lifecycle_script: SCRIPT } }), [
      { pid: 100, ppid: 50 },
      { pid: 50, ppid: 40 },
    ]);
  });

  it("takes the runner for npx's only when npm's script is peeps-bridge, not a harness that npx started", () => {
    // `npx playwright test` whose test starts peeps-bridge: npm's variables are inherited.
    assert.deepEqual(watchedChain({ ...base, ppid: 50, env: { npm_command: "exec", npm_lifecycle_event: "npx", npm_lifecycle_script: "playwright test" } }), [{ pid: 100, ppid: 50 }]);
    assert.deepEqual(watchedChain({ ...base, ppid: 50, env: { npm_command: "exec" } }), [{ pid: 100, ppid: 50 }]);
    assert.deepEqual(watchedChain({ ...base, ppid: 50, env: { npm_command: "exec", npm_lifecycle_script: "peeps-bridge --server x" } }), [
      { pid: 100, ppid: 50 },
      { pid: 50, ppid: 40 },
    ]);
  });

  it("watches only the parent when the shell's parent cannot be read", () => {
    assert.deepEqual(watchedChain({ ...base, ppid: 50, env: { npm_command: "exec", npm_lifecycle_script: SCRIPT }, readPpid: () => null }), [{ pid: 100, ppid: 50 }]);
    assert.deepEqual(
      watchedChain({
        ...base,
        ppid: 50,
        env: { npm_command: "exec", npm_lifecycle_script: SCRIPT },
        readPpid: () => {
          throw new Error("no ps");
        },
      }),
      [{ pid: 100, ppid: 50 }],
    );
  });
});

describe("reading another process's parent and name", () => {
  it("reads this process's parent live, and another process's from the OS", () => {
    assert.equal(readPpid(process.pid), process.ppid);
    assert.equal(typeof readPpid(process.ppid), "number");
    assert.ok((readName(process.pid) ?? "").length > 0);
  });

  it("answers null for a process that does not exist", () => {
    assert.equal(readPpid(2 ** 22 + 12345), null);
    assert.equal(readName(2 ** 22 + 12345), null);
  });

  it("reads them with ps where there is no /proc (macOS)", () => {
    assert.equal(Number(ps("ppid", process.pid)), process.ppid);
    assert.ok((ps("comm", process.pid) ?? "").length > 0);
    assert.equal(ps("ppid", 2 ** 22 + 12345), null);
  });

  it("names a process by the base name ps gives (macOS prints a path)", () => {
    assert.equal(readName(42, { proc: () => undefined, ps: () => "/bin/bash" }), "bash");
    assert.equal(readName(42, { proc: () => undefined, ps: () => null }), null);
  });

  it("reads /proc as gone only when the process is (ENOENT, ESRCH), and rethrows anything else, on any OS", () => {
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    const hasProc = () => true;
    assert.equal(procRead(42, "stat", failing("ENOENT"), hasProc), null);
    assert.equal(procRead(42, "stat", failing("ESRCH"), hasProc), null);
    assert.throws(() => procRead(42, "stat", failing("EMFILE"), hasProc), /EMFILE/);
    assert.throws(() => procRead(42, "stat", failing("EACCES"), hasProc), /EACCES/);
    // So a parent read fails rather than answering "gone".
    assert.throws(() => readPpid(42, { proc: (pid, file) => procRead(pid, file, failing("EIO"), hasProc), ps }), /EIO/);
  });

  it("reads nothing from /proc where there is none (macOS), so ps is asked instead", () => {
    let read = 0;
    assert.equal(
      procRead(42, "stat", () => {
        read++;
        return "x";
      }, () => false),
      undefined,
    );
    assert.equal(read, 0);
    assert.equal(procRead(42, "comm", () => "sh\n", () => true), "sh\n");
  });
});

describe("launcherGone: the launcher exited before the runner looked", () => {
  const names: Record<number, string> = { 1: "systemd", 2: "launchd", 50: "sh", 60: "node", 70: "npm exec peeps-", 80: "tini" };
  const ppids: Record<number, number> = { 50: 60 };
  const look = (ppid: number, env: NodeJS.ProcessEnv, overrides: Record<number, number> = {}) =>
    launcherGone({ pid: 100, ppid, env, readPpid: (pid) => ({ ...ppids, ...overrides })[pid] ?? null, readName: (pid) => names[pid] ?? null });
  const npx = { npm_command: "exec", npm_lifecycle_script: SCRIPT };

  it("is false while npx, or npm's shell under npx, is the parent", () => {
    assert.equal(look(60, npx), false);
    assert.equal(look(70, npx), false);
    assert.equal(look(50, npx), false);
  });

  it("is true under npx when the runner, or npm's shell, already belongs to init or a subreaper", () => {
    assert.equal(look(1, npx), true);
    assert.equal(look(2, { npm_lifecycle_event: "npx", npm_lifecycle_script: SCRIPT }), true);
    assert.equal(look(80, npx), true);
    assert.equal(look(50, npx, { 50: 1 }), true);
  });

  it("is false for a direct start, even one daemonised under init: only an npx launch says a launcher should be there", () => {
    assert.equal(look(1, {}), false);
    assert.equal(look(1, { npm_command: "exec", npm_lifecycle_script: "playwright test" }), false);
    assert.equal(look(50, {}, { 50: 1 }), false);
  });

  it("is false when npx itself is a container's PID 1, or when it cannot tell", () => {
    assert.equal(launcherGone({ pid: 100, ppid: 1, env: npx, readPpid: () => null, readName: () => "node" }), false);
    assert.equal(launcherGone({ pid: 100, ppid: 50, env: npx, readPpid: () => { throw new Error("no ps"); }, readName: (pid) => names[pid] ?? null }), false);
    assert.equal(look(99, npx), false);
  });
});
