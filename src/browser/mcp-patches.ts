/**
 * Where the runner reaches into `@playwright/mcp` 0.0.69 (playwright-core's
 * `lib/tools`), all in one place. Each patch is applied once per process and
 * looks up the session it belongs to by the Playwright BrowserContext.
 *
 * - Downloads: `acceptDownloads: false` still emits the event, and the tab's
 *   unawaited `download.saveAs()` then rejects, an unhandled rejection that
 *   kills the process. The tab now cancels it and tells the session.
 * - File choosers: cancelled instead of leaving the tab in a modal state.
 * - The MCP Context: captured when its backend initialises, so the runner
 *   knows the active tab and whether a dialog (a modal state) is open.
 * - `browser_network_requests`: rendered here instead of by playwright-core,
 *   so a request to another origin is never rendered at all (no parsing of
 *   text a page controls), credential headers are redacted, and body lines
 *   are indented so none can pass for an entry or a section. Its `filter`
 *   argument, which playwright-core compiles with `new RegExp`, never exists.
 */

import { createRequire } from "node:module";
import type { BrowserContext, Page } from "playwright-core";

const require = createRequire(import.meta.url);

interface McpTab {
  page: Page;
  modalStates(): unknown[];
  requests(): Promise<PwRequest[]>;
}
interface McpContext {
  currentTab(): McpTab | undefined;
  tabs(): McpTab[];
}
interface PwRequest {
  url(): string;
  method(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
  existingResponse(): { status(): number; statusText(): string } | null;
  headers(): Record<string, string>;
  postData(): string | null;
}
interface McpResponse {
  addResult(title: string, data: string, file: { prefix: string; ext: string }): Promise<void>;
  addError(text: string): void;
}

export interface SessionHooks {
  allowsUrl(url: string): boolean;
  onDownloadRefused(name: string): void;
  onUploadRefused(): void;
}

const sessions = new WeakMap<BrowserContext, SessionHooks>();
const contexts = new WeakMap<BrowserContext, McpContext>();
let applied = false;

export const REDACTED = "[redacted by peeps-bridge]";
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

/** Register a session's BrowserContext; applies the patches on first use. */
export function registerSession(context: BrowserContext, hooks: SessionHooks): void {
  applyPatches();
  sessions.set(context, hooks);
}

/** The page of the MCP server's active tab, once it has one. */
export function activePage(context: BrowserContext): Page | undefined {
  return contexts.get(context)?.currentTab()?.page;
}

/** Whether a tab is showing a dialog, which blocks the page's JavaScript. */
export function dialogOpen(context: BrowserContext): boolean {
  return contexts.get(context)?.tabs().some((tab) => tab.modalStates().length > 0) ?? false;
}

const SHAPE = "peeps-bridge: @playwright/mcp's internals have changed shape";

/** The function at `owner[key]`, or a startup error naming it. */
export function patchable(owner: Record<string, unknown>, key: string, ownerName: string): (...args: never[]) => unknown {
  const original = owner[key];
  if (typeof original !== "function") throw new Error(`${SHAPE}: ${ownerName}.${key} is not a function`);
  return original as (...args: never[]) => unknown;
}

/** The MCP backend's context, or an error if it is not the shape relied on. */
export function assertMcpContext(context: unknown): asserts context is McpContext {
  const c = context as Partial<Record<"currentTab" | "tabs", unknown>> | undefined;
  if (typeof c?.currentTab !== "function" || typeof c?.tabs !== "function") {
    throw new Error(`${SHAPE} (no context with currentTab and tabs)`);
  }
}

function applyPatches(): void {
  if (applied) return;
  applied = true;
  const exports = require("playwright-core/lib/tools/exports") as {
    Tab: { prototype: Record<string, unknown> };
    BrowserBackend: { prototype: Record<string, unknown> };
    browserTools: { schema: { name: string }; handle: (context: unknown, params: unknown, response: unknown) => Promise<void> }[];
  };

  patchable(exports.Tab.prototype, "_downloadStarted", "Tab");
  exports.Tab.prototype._downloadStarted = async function (download: { suggestedFilename(): string; cancel(): Promise<void>; page(): Page }) {
    await download.cancel().catch(() => {});
    sessions.get(download.page().context())?.onDownloadRefused(download.suggestedFilename());
  };

  const initialize = patchable(exports.BrowserBackend.prototype, "initialize", "BrowserBackend") as unknown as (this: { browserContext: BrowserContext; _context: McpContext }, ...args: unknown[]) => Promise<void>;
  exports.BrowserBackend.prototype.initialize = async function (this: { browserContext: BrowserContext; _context: McpContext }, ...args: unknown[]) {
    await initialize.apply(this, args);
    // Fail loudly: without the context the runner cannot tell the active tab
    // or an open dialog, and secret-field tracking would quietly weaken.
    assertMcpContext(this._context);
    contexts.set(this.browserContext, this._context);
  };

  // Uploads are refused (no browser_file_upload), but a page's file chooser
  // would leave the tab in a modal state that only that tool clears. Cancel
  // the chooser instead, and say so in the next result.
  const setModalState = patchable(exports.Tab.prototype, "setModalState", "Tab") as unknown as (this: McpTab, state: { type: string; fileChooser?: { setFiles(files: string[]): Promise<void> } }) => void;
  exports.Tab.prototype.setModalState = function (this: McpTab, state: { type: string; fileChooser?: { setFiles(files: string[]): Promise<void> } }) {
    if (state.type !== "fileChooser") return setModalState.call(this, state);
    void state.fileChooser?.setFiles([]).catch(() => {});
    sessions.get(this.page.context())?.onUploadRefused();
  };

  const network = exports.browserTools.find((tool) => tool.schema.name === "browser_network_requests");
  if (!network) throw new Error(`${SHAPE}: no browser_network_requests tool`);
  patchable(network as unknown as Record<string, unknown>, "handle", "browser_network_requests");
  network.handle = async (context, params, response) => {
    const tab = await (context as { ensureTab(): Promise<McpTab> }).ensureTab();
    const r = response as McpResponse;
    if (tab.modalStates().length) {
      r.addError('Error: Tool "browser_network_requests" does not handle the modal state.');
      return;
    }
    const hooks = sessions.get(tab.page.context());
    const p = params as { static?: boolean; requestBody?: boolean; requestHeaders?: boolean };
    await r.addResult("Network", renderNetworkLog(await tab.requests(), p, (url) => hooks?.allowsUrl(url) ?? false), { prefix: "network", ext: "log" });
  };
}

/** The network log, for allowed origins only. Exported for tests. */
export function renderNetworkLog(
  requests: PwRequest[],
  params: { static?: boolean; requestBody?: boolean; requestHeaders?: boolean },
  allowsUrl: (url: string) => boolean,
): string {
  const text: string[] = [];
  let left = 0;
  for (const request of requests) {
    const response = request.existingResponse();
    const successful = !request.failure() && !!response && response.status() < 400;
    const isFetch = ["fetch", "xhr"].includes(request.resourceType());
    if (!params.static && !isFetch && successful) continue;
    if (!allowsUrl(request.url())) {
      left += 1;
      continue;
    }
    let entry = `[${request.method().toUpperCase()}] ${request.url()}`;
    if (response) entry += ` => [${response.status()}] ${response.statusText()}`;
    else if (request.failure()) entry += ` => [FAILED] ${request.failure()?.errorText ?? "Unknown error"}`;
    if (params.requestHeaders) {
      const headers = Object.entries(request.headers()).map(([k, v]) => `    ${k}: ${CREDENTIAL_HEADERS.has(k.toLowerCase()) ? REDACTED : oneLine(v)}`);
      if (headers.length) entry += `\n  Request headers:\n${headers.join("\n")}`;
    }
    if (params.requestBody) {
      const body = request.postData();
      // Every body line indented: none can start a new entry or section.
      if (body) entry += `\n  Request body:\n${body.split(/\r\n|\r|\n|\u2028|\u2029/).map((line) => `    ${line}`).join("\n")}`;
    }
    text.push(entry);
  }
  if (left > 0) text.push(`(${left} request${left === 1 ? "" : "s"} to other origins left out)`);
  return text.join("\n");
}

const oneLine = (value: string) => value.replace(/[\r\n\u2028\u2029]+/g, " ");
