import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main, parseCli, runnerInfo, safeIo } from "../src/cli.js";
import { FakeBridge, SESSION_ID, call, type Reply } from "./helpers/fake-bridge.js";
import { startSites, type Sites } from "./helpers/sites.js";

const GRANT = "Bearer b1.1790000000000.c2lnbmF0dXJl";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("parseCli", () => {
  const base = ["--server", "https://app.peepsai.com", "--session", SESSION_ID, "--target-url", "http://localhost:3000/"];

  it("parses the minimal command", () => {
    const parsed = parseCli(base);
    assert.deepEqual(parsed, {
      kind: "run",
      server: "https://app.peepsai.com",
      sessionId: SESSION_ID,
      targetUrl: "http://localhost:3000/",
      allowOrigins: [],
      signInSecrets: [],
    });
  });

  it("takes repeated --allow-origin and --sign-in-secret", () => {
    const parsed = parseCli([...base, "--allow-origin", "https://a.example", "--allow-origin", "https://b.example", "--sign-in-secret", "P=MY_P"]);
    assert.equal(parsed.kind, "run");
    assert.deepEqual(parsed.kind === "run" && parsed.allowOrigins, ["https://a.example", "https://b.example"]);
    assert.deepEqual(parsed.kind === "run" && parsed.signInSecrets, ["P=MY_P"]);
  });

  it("answers --help and --version", () => {
    assert.equal(parseCli(["--help"]).kind, "help");
    assert.equal(parseCli(["--version"]).kind, "version");
  });

  it("refuses a grant on the command line", () => {
    assert.throws(() => parseCli([...base, "--grant", "b1.x.y"]), /PEEPS_RUNNER_GRANT/);
    assert.throws(() => parseCli([...base, "--token=b1.x.y"]), /PEEPS_RUNNER_GRANT/);
  });

  it("refuses missing or malformed options", () => {
    assert.throws(() => parseCli(["--session", SESSION_ID, "--target-url", "http://localhost:3000/"]), /--server is required/);
    assert.throws(() => parseCli(["--server", "https://x", "--target-url", "http://localhost:3000/"]), /--session is required/);
    assert.throws(() => parseCli(["--server", "https://x", "--session", SESSION_ID]), /--target-url is required/);
    assert.throws(() => parseCli([...base.slice(0, 2), "--session", "not-a-uuid", ...base.slice(4)]), /--session must be the session id/);
    assert.throws(() => parseCli(["--server", "http://app.peepsai.com", ...base.slice(2)]), /--server must be https/);
    assert.throws(() => parseCli(["--server", "ftp://x", ...base.slice(2)]), /--server must be https/);
    assert.throws(() => parseCli([...base, "--bogus"]), /Unknown option/);
    assert.throws(() => parseCli([...base, "extra"]), /Unexpected argument at position 7/);
    // A stray positional could be a grant pasted in the wrong place: never echoed.
    assert.throws(() => parseCli([...base, "b1.1790000000000.c2lnbmF0dXJl"]), (e: Error) => !e.message.includes("b1.1790000000000"));
  });

  it("allows plain http only for a Peeps server on this machine", () => {
    const parsed = parseCli(["--server", "http://localhost:3123", ...base.slice(2)]);
    assert.equal(parsed.kind === "run" && parsed.server, "http://localhost:3123");
    assert.equal(parseCli(["--server", "http://127.0.0.1:3123/", ...base.slice(2)]).kind, "run");
  });
});

describe("runnerInfo", () => {
  it("reports the versions it loaded and the OS, and nothing that names this machine's user or paths", () => {
    const info = runnerInfo();
    assert.equal(info.playwrightMcp, "0.0.69");
    assert.match(String(info.playwrightCore), /^1\.59\./);
    assert.match(String(info.bridge), /^\d+\.\d+\.\d+/);
    assert.equal(info.os, process.platform);
    const text = JSON.stringify(info);
    assert.doesNotMatch(text, new RegExp(os.userInfo().username));
    assert.doesNotMatch(text, /[/\\]home[/\\]|[/\\]Users[/\\]|[A-Z]:\\/);
    assert.deepEqual(Object.keys(info).sort(), ["arch", "bridge", "node", "os", "playwrightCore", "playwrightMcp"]);
  });
});

describe("terminal safety", () => {
  it("strips control characters from every printed line, out and err", async () => {
    const t = io();
    const safe = safeIo(t.io);
    safe.out("click '\x1b]52;c;ZXZpbA==\x07Place order' \x1b[2K\rfake line\x9b31m\x7f");
    safe.err("refused \x1b[31mred\x1b[0m\u202edesrever");
    assert.deepEqual(t.out, ["click ']52;c;ZXZpbA==Place order' [2Kfake line31m"]);
    assert.deepEqual(t.err, ["refused [31mred[0mdesrever"]);
  });

  it("keeps newlines and tabs, which help and preflight messages use", () => {
    const t = io();
    safeIo(t.io).out("a\n\tb");
    assert.deepEqual(t.out, ["a\n\tb"]);
  });

  it("covers what main prints from the server, such as a refusal's message", async () => {
    const bridge = await new FakeBridge().start();
    try {
      bridge.attachReplies.push({ status: 409, body: { error: "playwright_mcp_version", message: "bad \x1b]52;c;cm0gLXJmIH4=\x07version", next: "\x1b[2K\rrun this" } });
      const t = io();
      const code = await main(["--server", bridge.url, "--session", SESSION_ID, "--target-url", "http://localhost:1/"], { PEEPS_RUNNER_GRANT: GRANT }, t.io, {
        preflight: () => ({ ok: true }),
      });
      assert.equal(code, 1);
      // eslint-disable-next-line no-control-regex -- asserting none are left
      assert.doesNotMatch(t.err.join("\n") + t.out.join("\n"), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
      assert.match(t.err.join("\n"), /bad \]52;c;cm0gLXJmIH4=version/);
    } finally {
      await bridge.stop();
    }
  });
});

describe("main, before the browser", () => {
  const args = ["--server", "https://app.peepsai.com", "--session", SESSION_ID, "--target-url", "http://localhost:3000/"];

  it("prints help and exits 0", async () => {
    const t = io();
    assert.equal(await main(["--help"], {}, t.io), 0);
    assert.match(t.out.join("\n"), /PEEPS_RUNNER_GRANT/);
    assert.match(t.out.join("\n"), /--allow-origin/);
  });

  it("prints its version", async () => {
    const t = io();
    assert.equal(await main(["--version"], {}, t.io), 0);
    assert.match(t.out[0]!, /^\d+\.\d+\.\d+/);
  });

  it("exits 2 on a usage error", async () => {
    const t = io();
    assert.equal(await main(["--nope"], {}, t.io), 2);
    assert.match(t.err.join("\n"), /Unknown option/);
  });

  it("exits 2 without a grant", async () => {
    const t = io();
    assert.equal(await main(args, {}, t.io), 2);
    assert.match(t.err.join("\n"), /PEEPS_RUNNER_GRANT is not set/);
  });

  it("exits 2 when a named secret's variable is missing", async () => {
    const t = io();
    assert.equal(await main([...args, "--sign-in-secret", "P=NOT_SET_HERE"], { PEEPS_RUNNER_GRANT: GRANT }, t.io), 2);
    assert.match(t.err.join("\n"), /NOT_SET_HERE is not set/);
  });

  it("exits 2 on a bad --allow-origin", async () => {
    const t = io();
    assert.equal(await main([...args, "--allow-origin", "https://x.example/path"], { PEEPS_RUNNER_GRANT: GRANT }, t.io), 2);
    assert.match(t.err.join("\n"), /--allow-origin takes an origin/);
  });

  it("exits 1 with the install command when Chromium is missing", async () => {
    const t = io();
    const code = await main(args, { PEEPS_RUNNER_GRANT: GRANT }, t.io, { preflight: () => ({ ok: false, message: "install it with npx -y playwright-core@1 install" }) });
    assert.equal(code, 1);
    assert.match(t.err.join("\n"), /install it with/);
  });
});

describe("main, serving a session", () => {
  let sites: Sites;
  let bridge: FakeBridge;
  let tmp: string;

  before(async () => {
    sites = await startSites();
  });
  after(() => sites.close());
  beforeEach(async () => {
    bridge = await new FakeBridge().start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cli-"));
  });
  afterEach(async () => {
    await bridge.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const command = () => ["--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`, "--sign-in-secret", "SHOP_PASSWORD=E2E_SHOP_PASSWORD"];

  it("attaches, serves calls, prints one line each, and exits 0 when Peeps ends the session", async () => {
    bridge.callReplies.push(call(1, "browser_navigate", { url: `${sites.appUrl}/login` }));
    const t = io();
    const code = await main(command(), { PEEPS_RUNNER_GRANT: "b1.1790000000000.c2ln", E2E_SHOP_PASSWORD: "Peeps-Test-2026!" }, t.io, { tmpRoot: tmp });
    assert.equal(code, 0);

    const [attach] = bridge.of("attach");
    // A bare grant gets its scheme; the instance id is a fresh UUID.
    assert.equal(attach!.headers.authorization, "Bearer b1.1790000000000.c2ln");
    assert.match(String(attach!.headers["x-peeps-runner-instance"]), /^[0-9a-f-]{36}$/);
    const body = attach!.body as { tools: { name: string }[]; runnerInfo: Record<string, unknown> };
    assert.equal(body.tools.length, 15);
    assert.equal(body.runnerInfo.playwrightMcp, "0.0.69");

    const result = bridge.of("result")[0]!.body as { ok: boolean; result: { content: { text: string }[] } };
    assert.equal(result.ok, true);
    assert.match(result.result.content[0]!.text, /```yaml\n[\s\S]*heading "Sign in"/);

    const out = t.out.join("\n");
    assert.match(out, /serving session 11111111/);
    assert.match(out, new RegExp(`may reach: ${sites.appUrl.replace(/[.:/]/g, "\\$&")}`));
    assert.match(out, /#1 navigate to .*\/login on \/login/);
    assert.match(out, /Peeps ended the session/);
    // The scratch directory is gone.
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("types a secret that never reaches a posted result or the terminal", async () => {
    bridge.callReplies.push(call(1, "browser_navigate", { url: `${sites.appUrl}/login` }));
    // e5 is the sign-in page's password textbox (see browser.test.ts for a lookup).
    bridge.callReplies.push(call(2, "browser_type", { ref: "e5", element: "Password", text: "SHOP_PASSWORD", submit: true }));
    bridge.callReplies.push(call(3, "browser_network_requests", { static: false, requestBody: true, requestHeaders: true }));
    const t = io();
    const code = await main(command(), { PEEPS_RUNNER_GRANT: GRANT, E2E_SHOP_PASSWORD: "Peeps-Test-2026!" }, t.io, { tmpRoot: tmp });
    assert.equal(code, 0);
    const posted = JSON.stringify(bridge.of("result").map((r) => r.body));
    assert.match(posted, /Server saw: password=<secret>SHOP_PASSWORD<\/secret>/);
    assert.doesNotMatch(posted + t.out.join("\n") + t.err.join("\n"), /Peeps-Test-2026/);
    assert.match(t.out.join("\n"), /type secret SHOP_PASSWORD into 'Password' and submit/);
  });

  it("answers a call that hangs past the deadline, then closes the browser and exits 1", async () => {
    bridge.callReplies.push(call(1, "browser_navigate", { url: `${sites.appUrl}/spin` }), call(2, "browser_wait_for", { time: 1 }), call(3, "browser_tabs", { action: "list" }), call(4, "browser_snapshot", {}));
    const t = io();
    const code = await main(command(), { PEEPS_RUNNER_GRANT: GRANT, E2E_SHOP_PASSWORD: "x" }, t.io, { tmpRoot: tmp, callDeadlineMs: 3000 });
    assert.equal(code, 1);
    const results = bridge.of("result").map((r) => JSON.stringify(r.body));
    // The page's loop stalls the first call that reads it (a snapshot or the
    // tab list): that call is answered at the deadline, and it is the last.
    const stuckAt = results.findIndex((r) => /did not finish within 3 s/.test(r));
    assert.ok(stuckAt >= 0, results.join("\n"));
    assert.equal(results.length, stuckAt + 1);
    assert.ok(bridge.of("calls").length <= stuckAt + 1);
    assert.match(t.out.join("\n"), /the browser stopped responding/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("exits 1 with the next step when Peeps refuses the runner", async () => {
    bridge.attachReplies.push({ status: 409, body: { error: "other_runner" } });
    const t = io();
    const code = await main(command(), { PEEPS_RUNNER_GRANT: GRANT, E2E_SHOP_PASSWORD: "x" }, t.io, { tmpRoot: tmp });
    assert.equal(code, 1);
    assert.match(t.err.join("\n"), /start_local_discovery again/);
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it("exits 1 when it loses contact with Peeps", async () => {
    await bridge.stop();
    const t = io();
    const code = await main(["--server", "http://127.0.0.1:9", ...command().slice(2)], { PEEPS_RUNNER_GRANT: GRANT, E2E_SHOP_PASSWORD: "x" }, t.io, {
      tmpRoot: tmp,
      sleep: async () => {},
    });
    assert.equal(code, 1);
    assert.match(t.out.join("\n"), /lost contact/);
  });
});

describe("the peeps-bridge process", () => {
  it("stops cleanly on Ctrl-C, closing the browser and its scratch directory", async () => {
    const sites = await startSites();
    const bridge = await new FakeBridge().start();
    // Idle polls, so the runner is waiting when the signal arrives.
    bridge.callReplies.push(...Array.from({ length: 20 }, () => ({ status: 204, delayMs: 1000 })));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-proc-"));
    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/bin.ts", "--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`],
        { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      const deadline = Date.now() + 30_000;
      while (!/attached/.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.match(output, /attached/);
      assert.ok(fs.readdirSync(tmp).some((d) => d.startsWith("peeps-bridge-")));
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      child.kill("SIGINT");
      const code = await exited;
      assert.equal(code, 0, output);
      assert.match(output, /stopped/);
      assert.deepEqual(
        fs.readdirSync(tmp).filter((d) => d.startsWith("peeps-bridge-")),
        [],
      );
    } finally {
      await bridge.stop();
      await sites.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stops at once on a second Ctrl-C, even while a call is stuck", async () => {
    const sites = await startSites();
    const bridge = await new FakeBridge().start();
    bridge.callReplies.push(call(1, "browser_navigate", { url: `${sites.appUrl}/` }), call(2, "browser_wait_for", { time: 30 }));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-proc-"));
    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/bin.ts", "--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`],
        { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      const deadline = Date.now() + 30_000;
      while (!/#1 navigate/.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 500));
      const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
      const started = Date.now();
      child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 300));
      child.kill("SIGINT");
      const code = await exited;
      assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
      assert.equal(code, 130, output);
      assert.match(output, /closing the browser now/);
      assert.deepEqual(
        fs.readdirSync(tmp).filter((d) => d.startsWith("peeps-bridge-") || d.startsWith("playwright_chromiumdev_profile-")),
        [],
      );
    } finally {
      await bridge.stop();
      await sites.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  /** Start the real command against a fake bridge; resolves once call 1 has run. */
  async function startProcess(calls: Reply[]) {
    const sites = await startSites();
    const bridge = await new FakeBridge().start();
    bridge.callReplies.push(...calls);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-proc-"));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/bin.ts", "--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`],
      { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (c) => (output += c));
    child.stderr.on("data", (c) => (output += c));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    const deadline = Date.now() + 30_000;
    while (!/#1 /.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 500));
    return {
      child,
      exited,
      output: () => output,
      leftovers: () => fs.readdirSync(tmp).filter((d) => d.startsWith("peeps-bridge-") || d.startsWith("playwright_chromiumdev_profile-")),
      cleanup: async () => {
        child.kill("SIGKILL");
        await bridge.stop();
        await sites.close();
        fs.rmSync(tmp, { recursive: true, force: true });
      },
    };
  }

  it("stops on one Ctrl-C within the 10-second deadline, even while a call is stuck", async () => {
    const p = await startProcess([call(1, "browser_snapshot", {}), call(2, "browser_wait_for", { time: 30 })]);
    try {
      await new Promise((r) => setTimeout(r, 500));
      const started = Date.now();
      p.child.kill("SIGINT");
      const { code } = await p.exited;
      const took = Date.now() - started;
      assert.ok(took >= 9_000 && took < 16_000, `took ${took} ms`);
      assert.equal(code, 130, p.output());
      assert.deepEqual(p.leftovers(), []);
    } finally {
      await p.cleanup();
    }
  });

  it("stops cleanly on SIGHUP (the terminal closing), like Ctrl-C", async () => {
    const p = await startProcess([call(1, "browser_snapshot", {}), ...Array.from({ length: 20 }, () => ({ status: 204, delayMs: 1000 }))]);
    try {
      p.child.kill("SIGHUP");
      const { code, signal } = await p.exited;
      assert.equal(signal, null, p.output());
      assert.equal(code, 0, p.output());
      assert.match(p.output(), /stopping/);
      assert.deepEqual(p.leftovers(), []);
    } finally {
      await p.cleanup();
    }
  });

  it("cleans up when its terminal closes, though writing to it then fails (real pty)", { skip: process.platform === "win32" }, async () => {
    const sites = await startSites();
    const bridge = await new FakeBridge().start();
    bridge.callReplies.push(call(1, "browser_snapshot", {}), call(2, "browser_wait_for", { time: 30 }));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pty-"));
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const py = spawn(
          "python3",
          ["test/fixtures/pty-close.py", "#1 ", process.execPath, "--import", "tsx", "src/bin.ts", "--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`],
          { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        py.stdout.on("data", (c) => (out += c));
        py.on("error", reject);
        py.on("exit", () => resolve(out));
      });
      const report = JSON.parse(result) as { seen: boolean; seconds: number; exitcode: number; output: string };
      assert.ok(report.seen, report.output);
      assert.ok(report.seconds < 16, `took ${report.seconds} s`);
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(fs.readdirSync(tmp).filter((d) => d.startsWith("peeps-bridge-")), []);
    } finally {
      await bridge.stop();
      await sites.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("never deletes a Chromium profile directory another program made", async () => {
    const sites = await startSites();
    const bridge = await new FakeBridge().start();
    bridge.callReplies.push(call(1, "browser_snapshot", {}), call(2, "browser_wait_for", { time: 30 }));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-proc-"));
    const someoneElses = path.join(tmp, "playwright_chromiumdev_profile-someone-else");
    const anotherOne = path.join(tmp, "playwright_chromiumdev_profile-another-one");
    fs.mkdirSync(someoneElses);
    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/bin.ts", "--server", bridge.url, "--session", SESSION_ID, "--target-url", `${sites.appUrl}/`],
        { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.stderr.on("data", (c) => (output += c));
      // Made while the runner is starting its browser: the moment anything
      // appears in the shared temp directory.
      // ...and one made while the runner starts its browser, the moment
      // anything else appears in the shared temp directory.
      const watcher = fs.watch(tmp, (_event, name) => {
        if (!String(name).endsWith("another-one") && !fs.existsSync(anotherOne)) fs.mkdirSync(anotherOne);
      });
      const deadline = Date.now() + 30_000;
      while (!/#1 /.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      const exited = new Promise((resolve) => child.on("exit", resolve));
      child.kill("SIGINT");
      await new Promise((r) => setTimeout(r, 300));
      child.kill("SIGINT");
      await exited;
      watcher.close();
      assert.equal(fs.existsSync(someoneElses), true);
      assert.equal(fs.existsSync(anotherOne), true);
    } finally {
      await bridge.stop();
      await sites.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("cleans up when Ctrl-C is pressed twice while the browser is still starting (real pty)", { skip: process.platform === "win32" }, async () => {
    const bridge = await new FakeBridge().start();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pty-"));
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const py = spawn(
          "python3",
          ["test/fixtures/pty-close.py", "--ctrl-c", "press Ctrl-C to stop", process.execPath, "--import", "tsx", "src/bin.ts", "--server", bridge.url, "--session", SESSION_ID, "--target-url", "http://localhost:9/"],
          { env: { ...process.env, PEEPS_RUNNER_GRANT: GRANT, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ["ignore", "pipe", "inherit"] },
        );
        let out = "";
        py.stdout.on("data", (c) => (out += c));
        py.on("error", reject);
        py.on("exit", () => resolve(out));
      });
      const report = JSON.parse(result) as { seen: boolean; seconds: number; exitcode: number; output: string };
      assert.ok(report.seen, report.output);
      // Long enough for an orphaned Chromium to recreate its profile.
      await new Promise((r) => setTimeout(r, 3000));
      assert.deepEqual(fs.readdirSync(tmp).filter((d) => d.startsWith("peeps-bridge-")), [], report.output);
    } finally {
      await bridge.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
