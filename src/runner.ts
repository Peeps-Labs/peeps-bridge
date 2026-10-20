/**
 * One bridge call, end to end on this machine: refuse anything outside the
 * allowlist or the origin policy before the browser sees it, run the rest in
 * the browser, and print one line saying what was done, so the person
 * watching the terminal sees everything Peeps drives.
 */

import { refuseCall } from "./browser/allowlist.js";
import type { BrowserHost } from "./browser/browser-host.js";
import { OriginPolicy } from "./browser/origin-policy.js";
import type { BridgeCall, CallOutcome } from "./protocol/index.js";

export interface CallHandlerOptions {
  host: BrowserHost;
  policy: OriginPolicy;
  /** The secret names the agent may type in place of a value. */
  secretNames: ReadonlySet<string>;
  print: (line: string) => void;
}

const refusal = (text: string): CallOutcome => ({ ok: true, result: { content: [{ type: "text", text }], isError: true } });

export function createCallHandler(options: CallHandlerOptions): (call: BridgeCall) => Promise<CallOutcome> {
  const { host, policy, secretNames } = options;
  const print = (line: string) => options.print(host.scrub(line));

  return async (call) => {
    const args = call.args;
    const refused = refuseCall(call.tool, args);
    if (refused) {
      print(`#${call.seq} refused ${call.tool}`);
      return refusal(refused);
    }
    const action = describeAction(call.tool, args, secretNames);
    if (call.tool === "browser_navigate" && !policy.allowsUrl(String(args.url))) {
      print(`#${call.seq} refused ${action}`);
      return refusal(
        `browser_navigate refused: ${OriginPolicy.originOf(String(args.url))} is not an allowed origin for this session. ` +
          `Allowed: ${policy.origins.join(", ")}. The person running peeps-bridge can add one with --allow-origin.`,
      );
    }
    try {
      const result = await host.callTool(call.tool, args);
      const where = pageLocation(result.content.map((p) => p.text).join("\n"), policy);
      print(`#${call.seq} ${action}${where ? ` on ${where}` : ""}${result.isError ? " (failed)" : ""}`);
      return { ok: true, result };
    } catch (error) {
      print(`#${call.seq} ${action} (failed)`);
      return { ok: false, error: host.scrub(error instanceof Error ? error.message : String(error)) };
    }
  };
}

/** The page a result says the browser is on: a path for the target, else the URL. */
function pageLocation(text: string, policy: OriginPolicy): string | null {
  const match = /^- Page URL: (\S+)/m.exec(text);
  if (!match) return null;
  try {
    const url = new URL(match[1]!);
    return url.origin === policy.origins[0] ? url.pathname + url.search : url.href;
  } catch {
    return match[1]!;
  }
}

const quote = (text: unknown) => {
  const s = String(text);
  return `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;
};

const target = (element: unknown, ref: unknown) => (typeof element === "string" && element ? `'${element}'` : String(ref));

/** Plain words for one call, e.g. "click 'Place order'". */
export function describeAction(tool: string, args: Record<string, unknown>, secretNames: ReadonlySet<string>): string {
  switch (tool) {
    case "browser_navigate":
      return `navigate to ${String(args.url)}`;
    case "browser_navigate_back":
      return "go back";
    case "browser_snapshot":
      return "read the page";
    case "browser_click":
      return `${args.doubleClick ? "double-click" : args.button === "right" ? "right-click" : "click"} ${target(args.element, args.ref)}`;
    case "browser_type": {
      const text = typeof args.text === "string" && secretNames.has(args.text) ? `secret ${args.text}` : quote(args.text);
      return `type ${text} into ${target(args.element, args.ref)}${args.submit ? " and submit" : ""}`;
    }
    case "browser_fill_form": {
      const fields = Array.isArray(args.fields) ? (args.fields as { name?: unknown }[]) : [];
      return `fill ${fields.length} field${fields.length === 1 ? "" : "s"}: ${fields.map((f) => String(f.name)).join(", ")}`;
    }
    case "browser_press_key":
      return `press ${String(args.key)}`;
    case "browser_select_option":
      return `select ${quote((args.values as unknown[]).join(", "))} in ${target(args.element, args.ref)}`;
    case "browser_hover":
      return `hover ${target(args.element, args.ref)}`;
    case "browser_drag":
      return `drag ${target(args.startElement, args.startRef)} to ${target(args.endElement, args.endRef)}`;
    case "browser_wait_for":
      if (typeof args.text === "string") return `wait for ${quote(args.text)}`;
      if (typeof args.textGone === "string") return `wait for ${quote(args.textGone)} to go`;
      return `wait ${String(args.time)} s`;
    case "browser_handle_dialog":
      return args.accept ? "accept the dialog" : "dismiss the dialog";
    case "browser_tabs":
      return args.action === "list" ? "list tabs" : args.action === "new" ? "open a tab" : `${String(args.action)} tab ${args.index ?? "(current)"}`;
    case "browser_console_messages":
      return "read console messages";
    case "browser_network_requests":
      return "read network requests";
    default:
      return tool;
  }
}
