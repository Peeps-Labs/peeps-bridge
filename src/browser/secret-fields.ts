/**
 * Fields whose contents must not leave this machine (review round 1, M1).
 *
 * Playwright redacts a secret only while the field holds exactly its value.
 * A Backspace, Home + Delete, or a `maxlength` shorter than the secret leaves
 * a value that is no longer the secret, and the snapshot shows it. So the
 * runner keeps track of:
 * - every field the agent filled from a secret: its ref and its role and
 *   accessible name (from the snapshots it has seen), and a handle to the
 *   element itself, for the rest of the session;
 * - every password field (`input[type=password]`) on every page and frame.
 *
 * After each call it reads their current contents. A snapshot line for one of
 * those fields, or showing one of those contents, has its value hidden; and
 * the contents are scrubbed from the whole result (console, network, errors)
 * when at least `MIN_SCRUBBED_LENGTH` long, shorter ones only where they are a
 * field's value.
 */

import type { BrowserContext, ElementHandle } from "playwright-core";

export const HIDDEN = "[hidden by peeps-bridge]";
/** Shorter contents are hidden in their field's line but not everywhere. */
export const MIN_SCRUBBED_LENGTH = 4;

// `- textbox "Name" [active] [ref=e4]: value`
const VALUE_LINE = /^(\s*- [^\n]*?\[ref=([a-z0-9]+)\](?: \[[^\]\n]*\])*)(: )(.*)$/;
const ROLE_NAME = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/;
const REF_LINE = /^\s*- [^\n]*?\[ref=([a-z0-9]+)\]/;

const roleName = (line: string): string | null => {
  const match = ROLE_NAME.exec(line);
  return match?.[2] ? `${match[1]} "${match[2]}"` : null;
};

export class SecretFields {
  private readonly refs = new Set<string>();
  private readonly names = new Set<string>();
  private readonly handles: ElementHandle[] = [];
  /** ref -> `role "name"`, from every snapshot seen. */
  private readonly seen = new Map<string, string>();
  private contents: string[] = [];

  constructor(
    private readonly context: BrowserContext,
    private readonly secretNames: ReadonlySet<string>,
  ) {}

  /** Before a call: remember the fields it fills from a secret. */
  async before(tool: string, args: Record<string, unknown>): Promise<void> {
    const refs: string[] = [];
    if (tool === "browser_type" && typeof args.text === "string" && this.secretNames.has(args.text)) refs.push(String(args.ref));
    if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
      for (const field of args.fields as { ref?: unknown; value?: unknown }[]) {
        if (typeof field.value === "string" && this.secretNames.has(field.value)) refs.push(String(field.ref));
      }
    }
    for (const ref of refs) {
      this.refs.add(ref);
      const name = this.seen.get(ref);
      if (name) this.names.add(name);
      for (const page of this.context.pages()) {
        // `aria-ref` resolves against the page's latest snapshot, the one the
        // agent took the ref from.
        const handle = await page
          .locator(`aria-ref=${ref}`)
          .elementHandle({ timeout: 500 })
          .catch(() => null);
        if (handle) this.handles.push(handle);
      }
    }
  }

  /** After a call: read the current contents of every secret and password field. */
  async refresh(): Promise<void> {
    const contents = new Set<string>();
    for (const handle of [...this.handles]) {
      const value = await handle
        .evaluate((el) => ("value" in el ? String((el as HTMLInputElement).value) : (el.textContent ?? "")))
        .catch(() => null);
      if (value === null) this.handles.splice(this.handles.indexOf(handle), 1);
      else if (value) contents.add(value);
    }
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        const values = await frame
          .locator("input[type=password]")
          .evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
          .catch(() => [] as string[]);
        for (const value of values) if (value) contents.add(value);
      }
    }
    this.contents = [...contents];
  }

  /** The contents to scrub from a whole result. */
  scrubbable(): string[] {
    return this.contents.filter((value) => value.length >= MIN_SCRUBBED_LENGTH);
  }

  /** Hide the value on every snapshot line of a tracked field. */
  mask(text: string): string {
    const lines = text.split("\n");
    for (const line of lines) {
      const ref = REF_LINE.exec(line)?.[1];
      const name = roleName(line);
      if (ref && name) this.seen.set(ref, name);
      if (ref && name && this.refs.has(ref)) this.names.add(name);
    }
    const contents = new Set(this.contents);
    return lines
      .map((line) => {
        const match = VALUE_LINE.exec(line);
        if (!match) return line;
        const [, prefix, ref, separator, value] = match as unknown as [string, string, string, string, string];
        const name = roleName(line);
        const unquoted = /^"(.*)"$/.exec(value)?.[1];
        const sensitive =
          this.refs.has(ref) || (name !== null && this.names.has(name)) || contents.has(value) || (unquoted !== undefined && contents.has(unquoted));
        return sensitive ? `${prefix}${separator}${HIDDEN}` : line;
      })
      .join("\n");
  }
}
