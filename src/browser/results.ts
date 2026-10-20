/**
 * What a browser call sends back to Peeps: the tool result's text, with the
 * snapshot file the action wrote inlined (no `@playwright/mcp` 0.0.69 option
 * inlines it), links to other files on this machine dropped, refused origins
 * named, every secret value scrubbed, and the whole capped at 200 KB with a
 * marker. Only text parts and `isError` survive; an image never leaves.
 */

import fs from "node:fs";
import path from "node:path";

/** Under the result route's 512 KB body limit, with room for the envelope. */
export const RESULT_CAP_BYTES = 200 * 1024;

export interface TextResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

export interface ShapeOptions {
  /** The scratch directory the MCP server writes into. */
  workspace: string;
  scrub: (text: string) => string;
  /** Applied to the text before scrubbing (secret-field masking, network filtering). */
  transform?: (text: string) => string;
  /** Origins the runner refused during this call. */
  blocked?: string[];
  /** Other things the runner refused (a download), one line each. */
  notes?: string[];
}

const REDACTED = "[redacted by peeps-bridge]";
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);
const REQUEST_LINE = /^\[[A-Z]+\] (\S+)/;

/**
 * `browser_network_requests` output limited to the allowed origins (design
 * §7.1), with credential headers redacted. An entry starts at its
 * `[METHOD] url` line and runs to the next entry or section; a request to
 * any other origin (a refused one included) is left out whole.
 */
export function filterNetworkLog(text: string, allowsUrl: (url: string) => boolean): string {
  const out: string[] = [];
  let keeping = true;
  let dropped = 0;
  let inNetwork = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("### ")) {
      if (inNetwork && dropped > 0) out.push(`- ${dropped} request${dropped === 1 ? "" : "s"} to another origin ${dropped === 1 ? "was" : "were"} left out`);
      inNetwork = line === "### Result";
      dropped = 0;
      keeping = true;
      out.push(line);
      continue;
    }
    const request = inNetwork ? REQUEST_LINE.exec(line) : null;
    if (request) {
      keeping = allowsUrl(request[1]!);
      if (!keeping) dropped += 1;
    }
    if (!keeping) continue;
    const header = inNetwork ? /^( {4}([^:\s]+): ).*$/.exec(line) : null;
    out.push(header && CREDENTIAL_HEADERS.has(header[2]!.toLowerCase()) ? `${header[1]}${REDACTED}` : line);
  }
  if (inNetwork && dropped > 0) out.push(`- ${dropped} request${dropped === 1 ? "" : "s"} to another origin ${dropped === 1 ? "was" : "were"} left out`);
  return out.join("\n");
}

const SNAPSHOT_LINK = /^- \[Snapshot\]\(([^)\n]+)\)$/gm;
const CONSOLE_LINK = /^- New console entries: .*$/gm;
const FILE_LINK = /^- \[([^\]\n]+)\]\((?![a-z][a-z0-9+.-]*:\/\/)[^)\n]+\)$/gim;

export function shapeResult(raw: { content?: unknown; isError?: unknown }, options: ShapeOptions): TextResult {
  const parts = Array.isArray(raw?.content) ? (raw.content as { type?: unknown; text?: unknown }[]) : [];
  const texts = parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text as string);
  if (texts.length === 0) {
    return { content: [{ type: "text", text: "The browser returned no text for this call." }], isError: true };
  }

  let text = texts
    .join("\n")
    .replace(SNAPSHOT_LINK, (_line, link: string) => {
      const yaml = readInside(options.workspace, link);
      return yaml === null ? "(the snapshot was not available)" : "```yaml\n" + yaml.replace(/\n$/, "") + "\n```";
    })
    .replace(CONSOLE_LINK, "- New console entries: call browser_console_messages to read them")
    .replace(FILE_LINK, (_line, title: string) => `- ${title}: (a file on the runner; not sent)`);

  const blocked = [...new Set(options.blocked ?? [])];
  const notes = [...new Set(options.notes ?? [])];
  if (blocked.length > 0 || notes.length > 0) {
    text += "\n### Blocked";
    if (blocked.length > 0) {
      text += `\n- The runner blocked requests to origins outside this session's allowed list: ${blocked.join(", ")}. The person can allow one with --allow-origin.`;
    }
    for (const note of notes) text += `\n- ${note}`;
  }

  if (options.transform) text = options.transform(text);
  text = cap(options.scrub(text));
  return raw.isError === true ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** A file's text, only when it resolves inside `root`. */
function readInside(root: string, link: string): string | null {
  const resolved = path.resolve(root, link);
  const realRoot = fs.realpathSync(root);
  let real: string;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    return null;
  }
  if (!real.startsWith(realRoot + path.sep)) return null;
  try {
    return fs.readFileSync(real, "utf8");
  } catch {
    return null;
  }
}

const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));

function cap(text: string): string {
  const total = encodedBytes(text);
  if (total <= RESULT_CAP_BYTES) return text;
  const marker = `\n[TRUNCATED by peeps-bridge: the result was ${Buffer.byteLength(text)} bytes; capped at ${RESULT_CAP_BYTES}]`;
  const budget = RESULT_CAP_BYTES - encodedBytes(marker);
  let cut = Math.floor((text.length * budget) / total);
  while (cut > 0 && encodedBytes(text.slice(0, cut)) > budget) cut = Math.floor(cut * 0.95);
  // Never end on half a surrogate pair.
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1]!)) cut -= 1;
  return text.slice(0, cut) + marker;
}
