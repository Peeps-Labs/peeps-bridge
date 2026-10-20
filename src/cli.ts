/**
 * `peeps-bridge`: serve one Peeps local-discovery session's browser tools
 * from this machine.
 *
 *   PEEPS_RUNNER_GRANT=<grant> npx -y @peepsai/bridge@<version> \
 *     --server https://app.peepsai.com --session <id> --target-url http://localhost:3000 \
 *     [--allow-origin https://auth.example.com]... [--sign-in-secret NAME=ENV_VAR]...
 *
 * The grant is read from the environment only: on the command line it would
 * be visible to every process on the machine (`ps`).
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";

import { BROWSER_CATALOGUE } from "./browser/catalogue.js";
import { startBrowserHost, type BrowserHost, type BrowserHostOptions } from "./browser/browser-host.js";
import { OriginPolicy } from "./browser/origin-policy.js";
import { chromiumPreflight, PLAYWRIGHT_CORE_VERSION, type Preflight } from "./browser/preflight.js";
import { loadSecrets } from "./browser/secrets.js";
import { BridgeRefusedError, runBridgeSession } from "./protocol/index.js";
import { createCallHandler } from "./runner.js";

const require = createRequire(import.meta.url);

export const VERSION: string = (require("../package.json") as { version: string }).version;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const HELP = `peeps-bridge ${VERSION}: run a Peeps agent's browser on this machine

Usage:
  PEEPS_RUNNER_GRANT=<grant> peeps-bridge --server <url> --session <id> --target-url <url>
      [--allow-origin <origin>]... [--sign-in-secret NAME=ENV_VAR]...

Your coding agent's start_local_discovery returns this command with every value filled in.

Options:
  --server <url>                  Peeps, e.g. https://app.peepsai.com
  --session <id>                  The session start_local_discovery started
  --target-url <url>              Your app, e.g. http://localhost:3000. The browser may
                                  reach this origin and nothing else...
  --allow-origin <origin>         ...except origins you add here, e.g. an SSO host
                                  https://auth.example.com. Repeatable.
  --sign-in-secret NAME=ENV_VAR   Let the agent type NAME; the browser fills in the value
                                  of ENV_VAR from this shell. The value never leaves this
                                  machine. Repeatable.
  --help, --version

Environment:
  PEEPS_RUNNER_GRANT              The session's grant (never pass it as an argument)

Ctrl-C stops the runner and closes its browser.`;

export type Cli =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; server: string; sessionId: string; targetUrl: string; allowOrigins: string[]; signInSecrets: string[] };

export function parseCli(argv: string[]): Cli {
  for (const arg of argv) {
    if (/^--(grant|token|runner-grant|authorization)(=|$)/i.test(arg)) {
      throw new Error("The grant is read from PEEPS_RUNNER_GRANT only, never from the command line, where any process on this machine could read it.");
    }
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        server: { type: "string" },
        session: { type: "string" },
        "target-url": { type: "string" },
        "allow-origin": { type: "string", multiple: true },
        "sign-in-secret": { type: "string", multiple: true },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/unexpected argument/i.test(message)) throw new Error(`Unexpected argument. ${message.split(". ")[0]}. See --help.`);
    throw new Error(`${message.replace(/^Unknown option/i, "Unknown option")} See --help.`);
  }
  const { values } = parsed;
  if (values.help) return { kind: "help" };
  if (values.version) return { kind: "version" };
  if (!values.server) throw new Error("--server is required. See --help.");
  if (!values.session) throw new Error("--session is required. See --help.");
  if (!values["target-url"]) throw new Error("--target-url is required. See --help.");
  if (!UUID.test(values.session)) throw new Error("--session must be the session id start_local_discovery returned (a UUID).");
  let server: URL;
  try {
    server = new URL(values.server);
  } catch {
    throw new Error("--server must be https:// (or http:// on this machine).");
  }
  if (!(server.protocol === "https:" || (server.protocol === "http:" && LOOPBACK.has(server.hostname)))) {
    throw new Error("--server must be https:// (or http:// on this machine).");
  }
  return {
    kind: "run",
    server: server.origin,
    sessionId: values.session,
    targetUrl: values["target-url"],
    allowOrigins: values["allow-origin"] ?? [],
    signInSecrets: values["sign-in-secret"] ?? [],
  };
}

/** What the runner tells Peeps about itself: versions and OS, never paths or names. */
export function runnerInfo(): Record<string, string> {
  return {
    bridge: VERSION,
    // The copy `createConnection` is loaded from, not a constant.
    playwrightMcp: (require("@playwright/mcp/package.json") as { version: string }).version,
    playwrightCore: PLAYWRIGHT_CORE_VERSION,
    node: process.version,
    os: process.platform,
    arch: process.arch,
  };
}

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface MainDeps {
  preflight?: () => Preflight;
  tmpRoot?: string;
  /** Aborts the session (the bin wires Ctrl-C to it). */
  signal?: AbortSignal;
  /** Called once the browser is up, so a second Ctrl-C can close it at once. */
  onHost?: (host: BrowserHost) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Run the CLI; answers the exit code. */
export async function main(argv: string[], env: NodeJS.ProcessEnv, io: Io, deps: MainDeps = {}): Promise<number> {
  let cli: Cli;
  let policy: OriginPolicy;
  let secrets: Record<string, string>;
  let authorization: string;
  try {
    cli = parseCli(argv);
    if (cli.kind === "help") {
      io.out(HELP);
      return 0;
    }
    if (cli.kind === "version") {
      io.out(VERSION);
      return 0;
    }
    const grant = env.PEEPS_RUNNER_GRANT?.trim();
    if (!grant) throw new Error("PEEPS_RUNNER_GRANT is not set. Use the command and environment start_local_discovery returned.");
    authorization = /^Bearer /i.test(grant) ? grant : `Bearer ${grant}`;
    policy = OriginPolicy.from(cli.targetUrl, cli.allowOrigins);
    secrets = loadSecrets(cli.signInSecrets, env);
  } catch (error) {
    io.err(`peeps-bridge: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const preflight = (deps.preflight ?? chromiumPreflight)();
  if (!preflight.ok) {
    io.err(preflight.message);
    return 1;
  }

  const print = (line: string) => io.out(`[peeps] ${line}`);
  print(`peeps-bridge ${VERSION}: serving session ${cli.sessionId} for ${cli.server}`);
  print(`the browser may reach: ${policy.origins.join(", ")}`);
  if (Object.keys(secrets).length > 0) print(`sign-in secrets the agent may type by name: ${Object.keys(secrets).join(", ")}`);
  print("press Ctrl-C to stop");

  let host: BrowserHost | null = null;
  try {
    const hostOptions: BrowserHostOptions = { policy, secrets, version: VERSION, warn: print, ...(deps.tmpRoot ? { tmpRoot: deps.tmpRoot } : {}) };
    host = await startBrowserHost(hostOptions);
    deps.onHost?.(host);
    const end = await runBridgeSession({
      server: cli.server,
      sessionId: cli.sessionId,
      authorization: () => authorization,
      headers: { "x-peeps-runner-instance": randomUUID() },
      tools: BROWSER_CATALOGUE.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as unknown as Record<string, unknown> })),
      runnerInfo: runnerInfo(),
      handle: createCallHandler({ host, policy, secretNames: new Set(Object.keys(secrets)), print }),
      log: (line) => print(host ? host.scrub(line) : line),
      ...(deps.signal ? { signal: deps.signal } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    // The protocol has already said why it ended, except for a stop.
    if (end.reason === "stopped") print(`stopped after ${end.handled} call(s)`);
    return end.reason === "lost_contact" ? 1 : 0;
  } catch (error) {
    if (error instanceof BridgeRefusedError) {
      io.err(`peeps-bridge: ${error.message}`);
      return 1;
    }
    io.err(`peeps-bridge: ${host ? host.scrub(String(error instanceof Error ? error.message : error)) : String(error instanceof Error ? error.message : error)}`);
    return 1;
  } finally {
    await host?.close();
  }
}
