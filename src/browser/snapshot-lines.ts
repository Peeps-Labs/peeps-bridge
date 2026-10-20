/**
 * One line of Playwright's aria snapshot YAML, parsed in a single linear
 * pass. Playwright writes a node as `- role "name" [attr] [ref=e3]` with an
 * optional `: value`, and quotes the whole key when it needs YAML quoting
 * (`yamlEscapeKeyIfNeeded`): `- 'textbox "Password: required" [ref=e3]': v`,
 * with `'` doubled inside. A value that needs quoting is double-quoted with
 * backslash escapes (`yamlEscapeValueIfNeeded`). Every caller that reads a
 * line's role, name, ref or value goes through here, so both shapes are
 * always understood.
 */

export interface ParsedLine {
  /** Leading spaces. */
  indent: number;
  /** The line up to (not including) `: value` or a trailing `:`. */
  head: string;
  role: string | null;
  /** The accessible name, unescaped; null when there is none. */
  name: string | null;
  ref: string | null;
  /** The value, unquoted; null when the line has none. */
  value: string | null;
  /** The value exactly as written. */
  rawValue: string | null;
  /** The node has children (`key:` with nothing after the colon). */
  opensChildren: boolean;
}

const KEY = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/;
const REF = /\[ref=([a-z0-9]+)\]/;

export function parseLine(line: string): ParsedLine | null {
  let i = 0;
  while (line[i] === " ") i++;
  if (line[i] !== "-" || line[i + 1] !== " ") return null;
  const indent = i;
  i += 2;
  let key: string;
  let after: string;
  if (line[i] === "'") {
    // A single-quoted key: '' is a quote, the first lone ' ends it.
    let j = i + 1;
    let out = "";
    for (;;) {
      if (j >= line.length) return null;
      if (line[j] === "'") {
        if (line[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        break;
      }
      out += line[j];
      j += 1;
    }
    key = out;
    after = line.slice(j + 1);
    i = j + 1;
  } else {
    // An unquoted key ends at the first ": " or a trailing ":".
    const separator = line.indexOf(": ", i);
    const end = separator >= 0 ? separator : line.endsWith(":") ? line.length - 1 : line.length;
    key = line.slice(i, end);
    after = line.slice(end);
    i = end;
  }
  const head = line.slice(0, i);
  const k = KEY.exec(key);
  let rawValue: string | null = null;
  let opensChildren = false;
  if (after.startsWith(": ")) rawValue = after.slice(2);
  else if (after === ":") opensChildren = true;
  else if (after !== "") return null;
  return {
    indent,
    head,
    role: k?.[1] ?? null,
    name: k?.[2] !== undefined ? unescapeName(k[2]) : null,
    ref: REF.exec(key)?.[1] ?? null,
    value: rawValue === null ? null : unquoteValue(rawValue),
    rawValue,
    opensChildren,
  };
}

/** The line with its value replaced. */
export function withValue(line: ParsedLine, value: string): string {
  return `${line.head}: ${value}`;
}

/** `role "name"`, for matching an element across snapshots of one page. */
export function roleAndName(line: ParsedLine | null): string | null {
  return line?.role && line.name ? `${line.role} "${line.name}"` : null;
}

const unescapeName = (name: string) => name.replace(/\\(.)/g, "$1");

function unquoteValue(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  try {
    return JSON.parse(raw.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1")) as string;
  } catch {
    return raw.slice(1, -1);
  }
}
