/**
 * Sign-in values (design §7.2). The person names them on the command line as
 * `--sign-in-secret NAME=ENV_VAR`; the runner reads each variable and hands
 * the values to Playwright MCP in memory as its `secrets` map, so the agent
 * types the NAME and Playwright fills in the value.
 *
 * Playwright's own redaction is a plain string replace it calls "not a
 * security feature". It misses encoded forms, and anything the agent does to
 * the field afterwards (a Backspace, a `maxlength` that truncated it) leaves a
 * value that is no longer the whole secret. So every result is also scrubbed
 * here, before it is posted or printed, of:
 * - the value in each form below (plain, URL, form, JSON, HTML, entities);
 * - any run of consecutive characters of a secret at least `runLength` long
 *   (6, or half a short secret, never under 3), so a truncated or edited
 *   value is caught. Where depends on `runs`: everywhere (console and network
 *   output, printed lines), or with `"fields"` only in the places a typed
 *   value shows up in a snapshot: the value of an editable field's line
 *   (textbox, searchbox, combobox, spinbutton) and the Page URL and Page
 *   Title lines. Not in accessible names, headings or other page text, where
 *   it hid ordinary words ("Password" for a secret containing "password");
 * - extra values the caller passes: the current contents of fields that were
 *   filled from a secret, and of password fields (`secret-fields.ts`).
 *
 * A `<secret>X</secret>` marker is kept as it is only when X is a configured
 * name or the field label; anything else between the tags (a page, or the
 * agent's keystrokes, wrapping part of a value) is scrubbed like any text.
 */

const SPEC = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_][A-Za-z0-9_]*)$/;

export type Secrets = Record<string, string>;

/** How a secret field's contents are labelled when scrubbed. */
export const FIELD_LABEL = "a secret field";

export function loadSecrets(specs: string[], env: NodeJS.ProcessEnv): Secrets {
  const secrets: Secrets = {};
  for (const spec of specs) {
    const match = SPEC.exec(spec);
    if (!match) throw new Error(`--sign-in-secret takes NAME=ENV_VAR, e.g. SHOP_PASSWORD=MY_APP_PASSWORD; got ${JSON.stringify(spec)}`);
    const [, name, variable] = match as unknown as [string, string, string];
    if (Object.hasOwn(secrets, name)) throw new Error(`--sign-in-secret names ${name} twice`);
    const value = env[variable];
    if (!value) throw new Error(`--sign-in-secret ${name}: the environment variable ${variable} is not set (or is empty) in this shell`);
    secrets[name] = value;
  }
  return secrets;
}

/**
 * The map in the order Playwright MCP should redact it: longest value first,
 * so a secret that contains another is replaced whole, not as
 * `<secret>SHORT</secret>-rest-of-the-longer-one`.
 */
export function longestFirst(secrets: Secrets): Secrets {
  return Object.fromEntries(Object.entries(secrets).sort((a, b) => b[1].length - a[1].length));
}

const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const codePoints = (text: string) => [...text].map((c) => c.codePointAt(0)!);

/** Every form a value is likely to appear in. */
function variants(value: string): string[] {
  const uri = encodeURIComponent(value);
  const form = new URLSearchParams({ v: value }).toString().slice(2);
  const json = JSON.stringify(value).slice(1, -1);
  const escaped = html(value);
  const forms = new Set([
    value,
    uri,
    form,
    json,
    json.replace(/\//g, "\\/"),
    escaped,
    escaped.replace(/&#39;/g, "&#x27;"),
    html(uri),
    html(form),
    codePoints(value).map((c) => `&#${c};`).join(""),
    codePoints(value).map((c) => `&#x${c.toString(16)};`).join(""),
    codePoints(value).map((c) => `&#x${c.toString(16).toUpperCase()};`).join(""),
    [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
    [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`).join(""),
  ]);
  return [...forms].filter((f) => f.length > 0);
}

/** The shortest run of a secret's characters that is redacted on its own. */
export function runLength(secret: string): number | null {
  if (secret.length <= 3) return null;
  return Math.max(3, Math.min(6, Math.floor(secret.length / 2)));
}

// Placeholders are private-use characters only, so no secret's run can match
// inside one.
const token = (n: number) => `${[...n.toString(16)].map((d) => String.fromCharCode(0xe010 + parseInt(d, 16))).join("")}`;
const TOKEN = /([-]+)/g;
const MARKER = /<secret>([^<>\n]{1,100})<\/secret>/g;
const PAGE_LINE = /^(\s*- Page (?:URL|Title): )(.*)$/;
// Linear: a literal role, an optional quoted name, then bracketed attributes.
const EDITABLE_LINE = /^(\s*- (?:textbox|searchbox|combobox|spinbutton)(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]\n]*\])*: )(.*)$/;

export interface ScrubOptions {
  /** Further values to remove exactly (secret and password fields' contents). */
  extraValues?: readonly string[];
  /** Where the run rule applies; everywhere by default. */
  runs?: "everywhere" | "fields";
}

/**
 * A function that replaces every secret value (and every extra value) with
 * `<secret>NAME</secret>`.
 */
export function makeScrubber(secrets: Secrets): (text: string, options?: ScrubOptions) => string {
  const entries = Object.entries(secrets);
  const names = new Set([...Object.keys(secrets), FIELD_LABEL]);
  const pairs = entries.flatMap(([name, value]) => variants(value).map((form) => [form, `<secret>${name}</secret>`] as const));
  const runs = entries.flatMap(([name, value]) => {
    const k = runLength(value);
    if (k === null) return [];
    const grams = new Set<string>();
    for (let i = 0; i + k <= value.length; i++) grams.add(value.slice(i, i + k));
    return [{ name, k, grams }];
  });

  return (text, { extraValues = [], runs: scope = "everywhere" } = {}) => {
    const all = [...pairs, ...extraValues.flatMap((value) => variants(value).map((form) => [form, `<secret>${FIELD_LABEL}</secret>`] as const))].sort(
      (a, b) => b[0].length - a[0].length,
    );
    if (all.length === 0) return text;
    const saved: string[] = [];
    const keep = (replacement: string) => {
      saved.push(replacement);
      return token(saved.length - 1);
    };
    // Playwright's own markers are kept; a marker around anything but a
    // configured name is ordinary text.
    let out = text.replace(MARKER, (marker, inner: string) => (names.has(inner) ? keep(marker) : marker));
    for (const [form, replacement] of all) {
      if (out.includes(form)) out = out.split(form).join(keep(replacement));
    }
    const applyRuns = (part: string) => {
      for (const { name, k, grams } of runs) part = redactRuns(part, k, grams, () => keep(`<secret>${name}</secret>`));
      return part;
    };
    if (runs.length > 0) {
      out =
        scope === "everywhere"
          ? applyRuns(out)
          : out
              .split("\n")
              .map((line) => {
                const match = PAGE_LINE.exec(line) ?? EDITABLE_LINE.exec(line);
                return match ? match[1]! + applyRuns(match[2]!) : line;
              })
              .join("\n");
    }
    return out.replace(TOKEN, (_t, digits: string) => saved[parseInt([...digits].map((d) => (d.charCodeAt(0) - 0xe010).toString(16)).join(""), 16)]!);
  };
}

/** Replace every maximal span covered by k-length runs found in `grams`. */
function redactRuns(text: string, k: number, grams: Set<string>, replacement: () => string): string {
  if (text.length < k) return text;
  const covered = new Uint8Array(text.length);
  let any = false;
  for (let i = 0; i + k <= text.length; i++) {
    if (grams.has(text.slice(i, i + k))) {
      covered.fill(1, i, i + k);
      any = true;
    }
  }
  if (!any) return text;
  let out = "";
  for (let i = 0; i < text.length; ) {
    if (!covered[i]) {
      out += text[i];
      i += 1;
      continue;
    }
    while (i < text.length && covered[i]) i += 1;
    out += replacement();
  }
  return out;
}
