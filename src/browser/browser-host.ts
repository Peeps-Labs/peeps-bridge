/**
 * The browser this runner drives, and the Playwright MCP server that drives
 * it, both in this process (design §6.6).
 *
 * The runner launches Chromium itself and owns its one BrowserContext, so it
 * can police it: headless, a fresh profile in the scratch directory (never the person's own),
 * every request through the origin proxy (`origin-proxy.ts`), `context.route`
 * as the first check, service workers and downloads blocked. `@playwright/mcp`
 * is hosted with `createConnection(config, () => context)` and works in a
 * scratch directory under the OS temp dir, removed on close, so nothing it
 * writes lands in the person's checkout.
 *
 * Settings mirror Peeps' cloud discovery (`agent-mcp-config.ts`): viewport
 * 1366x768, navigation 15 s, actions 10 s, third-party cookies allowed. Image
 * responses are omitted on top of that (pixels stay here, design §7.3).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

import { McpLink, type McpServerLike } from "./mcp-link.js";
import { OriginPolicy } from "./origin-policy.js";
import { startOriginProxy, type OriginProxy } from "./origin-proxy.js";
import { registerSession } from "./mcp-patches.js";
import { collectText, shapeResult, type TextResult } from "./results.js";
import { SecretFields } from "./secret-fields.js";
import { longestFirst, makeScrubber, type Secrets } from "./secrets.js";

const require = createRequire(import.meta.url);

export const VIEWPORT = { width: 1366, height: 768 } as const;
export const NAVIGATION_TIMEOUT_MS = 15_000;
export const ACTION_TIMEOUT_MS = 10_000;

export interface BrowserHostOptions {
  policy: OriginPolicy;
  secrets: Secrets;
  /** The bridge package's version, for the MCP handshake. */
  version: string;
  /** Test seam: where the scratch directory goes. */
  tmpRoot?: string;
  warn?: (line: string) => void;
  /**
   * Told the scratch directory the moment it exists, before the browser
   * starts, so a forced exit during startup can still remove it.
   */
  onScratch?: (directory: string) => void;
}

export interface BrowserHost {
  /** The scratch directory the MCP server works in. */
  readonly workspace: string;
  readonly browser: Browser;
  /** The one BrowserContext the runner owns (a persistent one, in the scratch directory). */
  readonly context: BrowserContext;
  /** Whether Chromium runs inside its own sandbox. */
  readonly sandboxed: boolean;
  /** Run one already-allowed tool call and shape its result for Peeps. */
  callTool(name: string, args: Record<string, unknown>): Promise<TextResult>;
  scrub(text: string): string;
  /**
   * What `close()` would remove, for a synchronous last-resort cleanup (a
   * forced exit, the watchdog): the scratch directory, which holds the
   * Chromium profile too, so nothing outside it is ever touched.
   */
  scratchPaths(): string[];
  close(): Promise<void>;
}

/** `page-*.yml` snapshot files in the output directory, with their mtimes. */
function snapshotFiles(output: string): Map<string, number> {
  const files = new Map<string, number>();
  let names: string[] = [];
  try {
    names = fs.readdirSync(output);
  } catch {
    return files;
  }
  for (const name of names) {
    if (!/^page-[^/\\]+\.yml$/.test(name)) continue;
    try {
      files.set(path.join(output, name), fs.statSync(path.join(output, name)).mtimeMs);
    } catch {
      // Gone already.
    }
  }
  return files;
}

const EVERYWHERE = new Set(["browser_console_messages", "browser_network_requests"]);

const SERVICE_WORKER_BLOCK = `(() => {
  if (typeof ServiceWorkerContainer === "undefined") return;
  const refuse = () => Promise.reject(new DOMException("Service workers are blocked by peeps-bridge", "SecurityError"));
  Object.defineProperty(ServiceWorkerContainer.prototype, "register", { value: refuse, writable: false, configurable: false });
})();`;

type CreateConnection = (config: object, contextGetter: () => Promise<BrowserContext>) => Promise<McpServerLike>;

export async function startBrowserHost(options: BrowserHostOptions): Promise<BrowserHost> {
  const { policy } = options;
  const workspace = fs.mkdtempSync(path.join(options.tmpRoot ?? os.tmpdir(), "peeps-bridge-"));
  options.onScratch?.(workspace);
  const output = path.join(workspace, "output");
  const scrubSecrets = makeScrubber(options.secrets);
  const blocked: string[] = [];
  const notes: string[] = [];
  let fields: SecretFields | null = null;
  const scrub = (text: string) => scrubSecrets(text, { extraValues: fields?.scrubbable() ?? [] });
  const scratch = [workspace];
  const cleanups: (() => Promise<unknown> | unknown)[] = [() => fs.rmSync(workspace, { recursive: true, force: true })];
  const cleanup = async () => {
    for (const step of cleanups.reverse()) {
      try {
        await step();
      } catch {
        // Keep going: every later step still has to run.
      }
    }
  };

  try {
    const proxy: OriginProxy = await startOriginProxy(policy, (origin) => blocked.push(origin));
    cleanups.push(() => proxy.close());

    // The profile lives in the scratch directory: a fresh, empty profile per
    // session (never the person's own), and the only Chromium files on disk
    // are ones the runner made and removes. Playwright's own launch() would
    // put it in the shared temp directory instead.
    const profile = path.join(workspace, "profile");
    const launch = (chromiumSandbox: boolean) =>
      chromium.launchPersistentContext(profile, {
        headless: true,
        viewport: VIEWPORT,
        serviceWorkers: "block",
        acceptDownloads: false,
        chromiumSandbox,
        // The runner decides what Ctrl-C does (finish the call in hand, then
        // close); Playwright's own handler would kill the browser at once.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        // Loopback through the proxy too: the target is usually localhost, and
        // so is much of what the policy must keep the browser away from.
        proxy: { server: proxy.url, bypass: "<-loopback>" },
        args: [
          "--disable-features=ThirdPartyCookieBlocking",
          // WebRTC sends UDP straight to any host a page names (STUN, ICE),
          // around the proxy. Only proxied traffic: with an HTTP proxy that
          // means no UDP at all, and TURN over TCP goes through the proxy's
          // CONNECT check. Pages can still use WebRTC APIs; they just cannot
          // reach anyone the policy does not allow.
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      });
    // Chromium's own sandbox where the OS allows it (Playwright turns it off
    // by default). Some Linux setups forbid the user namespaces it needs.
    let sandboxed = true;
    let context: BrowserContext;
    try {
      context = await launch(true);
    } catch (error) {
      if (!/sandbox/i.test(String(error))) throw error;
      sandboxed = false;
      options.warn?.("Chromium's sandbox is not available on this machine (common on Linux without unprivileged user namespaces); running without it.");
      fs.rmSync(profile, { recursive: true, force: true });
      context = await launch(false);
    }
    cleanups.push(() => context.close());
    const browser = context.browser()!;
    // Playwright's `serviceWorkers: "block"` only replaces `register` on the
    // `navigator.serviceWorker` instance, which a page bypasses through
    // `ServiceWorkerContainer.prototype.register` (tested). Refuse there too.
    await context.addInitScript(SERVICE_WORKER_BLOCK);
    // Before createConnection: the network tool is replaced as it is created.
    registerSession(context, {
      allowsUrl: (url) => policy.allowsUrl(url),
      onDownloadRefused: (name) => notes.push(`The runner refused a download (${name}): downloads are blocked in local discovery.`),
      onUploadRefused: () => notes.push("The runner refused a file upload: the file chooser was cancelled, because uploads are not available in local discovery."),
    });
    fields = new SecretFields(context, options.secrets);
    // The fast first check, with a clear refusal; the proxy is the real one
    // (this does not see redirects).
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (policy.allowsUrl(url)) return route.fallback();
      blocked.push(OriginPolicy.originOf(url));
      return route.abort("blockedbyclient");
    });

    const { createConnection } = require("@playwright/mcp") as { createConnection: CreateConnection };
    const server = await createConnection(
      {
        browser: { browserName: "chromium", isolated: false },
        outputDir: output,
        // Longest first: Playwright redacts in insertion order, and a shorter
        // secret inside a longer one would otherwise split it.
        secrets: longestFirst(options.secrets),
        imageResponses: "omit",
        timeouts: { navigation: NAVIGATION_TIMEOUT_MS, action: ACTION_TIMEOUT_MS },
      },
      async () => context,
    );
    const link = await McpLink.connect(server, workspace, options.version);
    cleanups.push(() => link.close());

    let closing: Promise<void> | null = null;
    return {
      workspace,
      browser,
      context,
      sandboxed,
      scrub,
      scratchPaths: () => [...scratch],
      async callTool(name, rawArgs) {
        blocked.length = 0;
        const tracked = fields!;
        let args = rawArgs;
        if (name === "browser_type" && args.slowly && tracked.secretRefs(name, args).length > 0) {
          // One fill: typed one character at a time, a page sees (and can log)
          // every prefix of the secret.
          const { slowly: _slowly, ...rest } = args;
          args = rest;
        }
        if (name === "browser_drag" && (await tracked.isSensitive(String(args.startRef)))) {
          return {
            content: [{ type: "text", text: "browser_drag was refused by the runner: dragging from a field holding a secret or a password could move its text where it is not hidden." }],
            isError: true,
          };
        }
        await tracked.before(name, args);
        const before = snapshotFiles(output);
        const raw = await link.callTool(name, args);
        // Only snapshot files @playwright/mcp wrote during this call may be
        // inlined: a link in the text is not authority to read a file.
        const written = new Set([...snapshotFiles(output)].filter(([file, mtime]) => before.get(file) !== mtime).map(([file]) => file));
        const text = collectText(raw, workspace, written);
        await tracked.refresh(text ?? "");
        const blind = tracked.blindReason();
        if (blind) notes.push(blind);
        const refused = notes.splice(0);
        const runs = EVERYWHERE.has(name) ? "everywhere" : "fields";
        return shapeResult(text === null ? raw : { content: [{ type: "text", text }], isError: raw.isError }, {
          workspace,
          scrub: (text) => scrubSecrets(text, { extraValues: tracked.scrubbable(), runs }),
          blocked: [...blocked],
          notes: refused,
          transform: (text) => tracked.mask(text),
        });
      },
      close() {
        // One cleanup, however many callers (Ctrl-C and the normal exit race).
        closing ??= cleanup();
        return closing;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
