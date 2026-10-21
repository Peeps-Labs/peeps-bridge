/**
 * Which browser calls this runner will make: only the catalogue's tools, only
 * with arguments their schemas declare and accept, and `browser_navigate`
 * only to an http(s) URL. Checked before anything reaches the browser.
 */

import { BROWSER_CATALOGUE, type JsonSchema } from "./catalogue.js";

const BY_NAME = new Map(BROWSER_CATALOGUE.map((tool) => [tool.name, tool]));

export const ALLOWED_TOOLS: ReadonlySet<string> = new Set(BY_NAME.keys());

/** Why this call is refused, or null when it may run. */
export function refuseCall(tool: string, args: Record<string, unknown>): string | null {
  const definition = BY_NAME.get(tool);
  if (!definition) return `${tool} is not available on this runner.`;
  const problem = check(definition.inputSchema, args, "arguments");
  if (problem) return `${tool} was refused by the runner: ${problem}.`;
  if (tool === "browser_click" && args.button === "middle") {
    return "browser_click was refused by the runner: a middle click pastes the primary selection on Linux, which could move a field's text where it is not hidden.";
  }
  if (tool === "browser_press_key" && isClipboardKey(String(args.key))) {
    return "browser_press_key was refused by the runner: clipboard keys (copy, cut, paste) are not available, so a field's text cannot be moved to where it is not hidden.";
  }
  if (tool === "browser_navigate" && !isWebUrl(args.url)) {
    return "browser_navigate only opens http:// and https:// URLs; give the full URL.";
  }
  return null;
}

export function isWebUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The subset of JSON Schema the catalogue uses; anything else fails closed. */
function check(schema: JsonSchema, value: unknown, path: string): string | null {
  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      const label = path === "arguments" ? "it" : path;
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(properties, key)) return `${label} does not take ${key}`;
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(record, key)) return `${key} is required`;
      }
      for (const [key, property] of Object.entries(properties)) {
        if (!Object.hasOwn(record, key)) continue;
        const problem = check(property, record[key], path === "arguments" ? key : `${path}.${key}`);
        if (problem) return problem;
      }
      return null;
    }
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (const [index, item] of value.entries()) {
        const problem = check(schema.items ?? {}, item, `${path}[${index}]`);
        if (problem) return problem;
      }
      return null;
    }
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(", ")}`;
      return null;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${path} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be a boolean`;
    default:
      return `${path} has a schema this runner does not understand`;
  }
}

const COMMAND_MODIFIERS = new Set(["control", "ctrl", "meta", "cmd", "command", "controlormeta", "os"]);
const CLIPBOARD_KEYS = new Set(["copy", "cut", "paste"]);

/**
 * Copy, cut or paste in any spelling Playwright accepts: Control/Meta (or
 * ControlOrMeta) with C, X, V or Insert, Shift with Insert or Delete, and the
 * Copy, Cut and Paste keys themselves.
 */
export function isClipboardKey(key: string): boolean {
  const parts = key.length > 1 && key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
  const main = (parts.pop() ?? "").toLowerCase().replace(/^key([a-z])$/, "$1");
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  if (CLIPBOARD_KEYS.has(main)) return true;
  const command = [...modifiers].some((m) => COMMAND_MODIFIERS.has(m));
  if (command && ["c", "x", "v", "insert"].includes(main)) return true;
  return modifiers.has("shift") && (main === "insert" || main === "delete");
}
