/**
 * Fields whose contents must not leave this machine (review rounds 1 and 2).
 *
 * Playwright redacts a secret only while a field holds exactly its value. A
 * Backspace, Home + Delete, or a `maxlength` shorter than the secret leaves a
 * value that is no longer the secret, and the snapshot shows it. So the
 * runner keeps:
 * - a handle to every element the agent filled from a secret (resolved on the
 *   active tab, from the snapshot the agent took the ref from), with that
 *   element's role and accessible name;
 * - the value of every password field (`input[type=password]`) on every page
 *   and frame;
 * - every value either has ever held, for the rest of the session.
 *
 * Refs are not tracked: Playwright numbers them per snapshot, so a later
 * page's `e5` is a different element. A snapshot line is hidden when it shows
 * one of those values, or when it has a tracked element's role and name on
 * the same page while that element is still there (a re-rendered field).
 * Values of `MIN_SCRUBBED_LENGTH` or more are also scrubbed from the whole
 * result: console, network, errors.
 *
 * Reading a field runs JavaScript in the page, which an open dialog blocks.
 * So nothing is read while a dialog is open, and every read is bounded.
 */

import type { BrowserContext, ElementHandle, Page } from "playwright-core";

import { activePage, dialogOpen } from "./mcp-patches.js";

export const HIDDEN = "[hidden by peeps-bridge]";
/** Shorter values are hidden on their own line, not everywhere. */
export const MIN_SCRUBBED_LENGTH = 4;
/** The longest any one read of the page may take. */
export const READ_TIMEOUT_MS = 500;

// Playwright's own line shape: `- role "name" [attr] [ref=e4]: value`.
// Linear: a literal role, an optional quoted name, then bracketed attributes.
const VALUE_LINE = /^(\s*- [a-z]+(?: "(?:[^"\\]|\\.)*")?(?: \[[^\]\n]*\])*)(: )(.*)$/;
const ROLE_NAME = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/;
const REF = /\[ref=([a-z0-9]+)\]/;

const roleName = (line: string): string | null => {
  const match = ROLE_NAME.exec(line);
  return match?.[2] ? `${match[1]} "${match[2]}"` : null;
};

/** A promise's value, or `fallback` once it rejects or takes too long. */
export function bounded<T>(promise: Promise<T>, fallback: T, ms = READ_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

interface Tracked {
  handle: ElementHandle;
  page: Page;
  key: string | null;
}

export class SecretFields {
  private tracked: Tracked[] = [];
  /** Values the tracked and password fields hold now. */
  private current = new Set<string>();
  /** Every value they have ever held. */
  private readonly history = new Set<string>();
  /** ref -> `role "name"`, from the latest snapshot only. */
  private latest = new Map<string, string>();

  constructor(
    private readonly context: BrowserContext,
    private readonly secretNames: ReadonlySet<string>,
  ) {}

  /** The refs a call fills from a secret. */
  secretRefs(tool: string, args: Record<string, unknown>): string[] {
    const refs: string[] = [];
    if (tool === "browser_type" && typeof args.text === "string" && this.secretNames.has(args.text)) refs.push(String(args.ref));
    if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
      for (const field of args.fields as { ref?: unknown; value?: unknown }[]) {
        if (typeof field.value === "string" && this.secretNames.has(field.value)) refs.push(String(field.ref));
      }
    }
    return refs;
  }

  /** Before a call: remember the elements it fills from a secret. */
  async before(tool: string, args: Record<string, unknown>): Promise<void> {
    const page = this.page();
    if (!page) return;
    for (const ref of this.secretRefs(tool, args)) {
      const handle = await this.resolve(page, ref);
      if (handle) this.tracked.push({ handle, page, key: this.latest.get(ref) ?? null });
    }
  }

  /**
   * Whether a ref on the active tab is a tracked element or a password field
   * (one whose text must not be dragged elsewhere). Unknown counts as yes.
   */
  async isSensitive(ref: string): Promise<boolean> {
    const page = this.page();
    if (!page) return true;
    const handle = await this.resolve(page, ref);
    if (!handle) return true;
    try {
      for (const t of this.tracked) {
        if (await bounded(handle.evaluate((a, b) => a === b, t.handle), true)) return true;
      }
      return await bounded(
        handle.evaluate((el) => el instanceof HTMLInputElement && el.type === "password"),
        true,
      );
    } finally {
      void handle.dispose().catch(() => {});
    }
  }

  /** After a call: read the tracked and password fields' values. */
  async refresh(): Promise<void> {
    // A dialog blocks the page's JavaScript: a read would wait for ever.
    if (dialogOpen(this.context)) return;
    const values = new Set<string>();
    const alive: Tracked[] = [];
    for (const t of this.tracked) {
      const value = await bounded(
        t.handle.evaluate((el) => ("value" in el ? String((el as HTMLInputElement).value) : (el.textContent ?? ""))),
        null as string | null,
      );
      // A handle that cannot be read any more (the page navigated) is dropped.
      if (value === null && (t.page.isClosed() || !(await bounded(t.handle.evaluate(() => true), false)))) continue;
      alive.push(t);
      if (value) values.add(value);
    }
    this.tracked = alive;
    for (const page of this.context.pages()) {
      for (const frame of page.frames()) {
        const found = await bounded(
          frame.locator("input[type=password]").evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value)),
          [] as string[],
        );
        for (const value of found) if (value) values.add(value);
      }
    }
    this.current = values;
    for (const value of values) this.history.add(value);
  }

  /** Values to scrub from a whole result: everything ever seen, long enough. */
  scrubbable(): string[] {
    return [...this.history].filter((value) => value.length >= MIN_SCRUBBED_LENGTH);
  }

  /** Hide the value on every snapshot line of a sensitive field. */
  mask(text: string): string {
    const lines = text.split("\n");
    if (text.includes("### Snapshot")) {
      this.latest = new Map();
      for (const line of lines) {
        const ref = REF.exec(line)?.[1];
        const name = roleName(line);
        if (ref && name) this.latest.set(ref, name);
      }
    }
    const page = this.page();
    const keys = new Set(this.tracked.filter((t) => t.key && t.page === page).map((t) => t.key!));
    return lines
      .map((line) => {
        const match = VALUE_LINE.exec(line);
        if (!match) return line;
        const value = match[3]!;
        const unquoted = /^"(.*)"$/.exec(value)?.[1];
        const name = roleName(line);
        const sensitive = this.history.has(value) || (unquoted !== undefined && this.history.has(unquoted)) || (name !== null && keys.has(name));
        return sensitive ? `${match[1]}${match[2]}${HIDDEN}` : line;
      })
      .join("\n");
  }

  private page(): Page | undefined {
    const active = activePage(this.context);
    if (active) return active;
    const pages = this.context.pages();
    return pages.length === 1 ? pages[0] : undefined;
  }

  private resolve(page: Page, ref: string): Promise<ElementHandle | null> {
    // `aria-ref` resolves against the page's latest snapshot, the one the
    // agent took the ref from.
    return bounded(page.locator(`aria-ref=${ref}`).elementHandle({ timeout: READ_TIMEOUT_MS }), null, READ_TIMEOUT_MS * 2);
  }
}
