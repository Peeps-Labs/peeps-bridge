/**
 * Fields whose contents must not leave this machine (review rounds 1-3).
 *
 * Playwright redacts a secret only while a field holds exactly its value. A
 * Backspace, Home + Delete, or a `maxlength` shorter than the secret leaves a
 * value that is no longer the secret, and the snapshot shows it. So the
 * runner tracks, by element handle:
 * - every element the agent filled from a secret (resolved on the active
 *   tab, from the snapshot the agent took the ref from);
 * - every editable element on the active tab whose contents hold a secret or
 *   a run of its characters, found by a scan after each call, so a secret
 *   that lands somewhere by any route (a page copying it, a paste) is tracked
 *   before it can be edited there.
 * Every value a tracked element has held is kept for the session: its line is
 * hidden wherever it shows, and values of `MIN_SCRUBBED_LENGTH` or more are
 * scrubbed from the whole result.
 *
 * A password field (`input[type=password]`) with no secret in it only has its
 * own snapshot line hidden; its value is not remembered or scrubbed
 * elsewhere, so "1" or "test" typed into one hides nothing else.
 *
 * Refs are only resolved against the active tab's latest snapshot: Playwright
 * numbers them per snapshot, so a later page's `e5` is a different element.
 *
 * Reading a page runs JavaScript in it, which an open dialog blocks. So
 * nothing is read while a dialog is open, and every read is bounded.
 */

import type { BrowserContext, ElementHandle, Frame, Page } from "playwright-core";

import { activePage, dialogOpen } from "./mcp-patches.js";
import { runLength, type Secrets } from "./secrets.js";
import { parseLine, roleAndName, withValue } from "./snapshot-lines.js";

export const HIDDEN = "[hidden by peeps-bridge]";
/** Shorter values are hidden on their own field's line, not elsewhere. */
export const MIN_SCRUBBED_LENGTH = 4;
/** The longest any one read of the page may take. */
export const READ_TIMEOUT_MS = 500;

const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const EDITABLE = "input:not([type=hidden]), textarea, [contenteditable]:not([contenteditable=false])";


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
  frame: Frame | null;
  key: string | null;
  /** The ref its line had in the latest snapshot that showed it. */
  lastRef: string | null;
}

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box | null, b: Box | null) => !!a && !!b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export class SecretFields {
  private tracked: Tracked[] = [];
  /** Every value a tracked element has held. */
  private readonly history = new Set<string>();
  /** ref -> `role "name"`, from the latest snapshot. */
  private latest = new Map<string, string>();
  /** Refs whose line the current result must hide. */
  private hiddenRefs = new Set<string>();
  /** A dialog stopped the reads: hide every editable field's value instead. */
  private blind = false;
  private readonly runs: { value: string; grams: Set<string> }[];

  constructor(
    private readonly context: BrowserContext,
    private readonly secrets: Secrets,
  ) {
    this.runs = Object.values(secrets).map((value) => {
      const k = runLength(value);
      const grams = new Set<string>();
      if (k !== null) for (let i = 0; i + k <= value.length; i++) grams.add(value.slice(i, i + k));
      return { value, grams };
    });
  }

  /** The refs a call fills from a secret. */
  secretRefs(tool: string, args: Record<string, unknown>): string[] {
    const names = new Set(Object.keys(this.secrets));
    const refs: string[] = [];
    if (tool === "browser_type" && typeof args.text === "string" && names.has(args.text)) refs.push(String(args.ref));
    if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
      for (const field of args.fields as { ref?: unknown; value?: unknown }[]) {
        if (typeof field.value === "string" && names.has(field.value)) refs.push(String(field.ref));
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
      if (handle) await this.track(handle, page, this.latest.get(ref) ?? null, ref);
    }
  }

  /**
   * Whether dragging from a ref could carry a secret or password field's text:
   * the element is, contains or overlaps one on the active tab. Unknown
   * counts as yes; a field on another tab or frame is not compared.
   */
  async isSensitive(ref: string): Promise<boolean> {
    const page = this.page();
    if (!page) return true;
    const start = await this.resolve(page, ref);
    if (!start) return true;
    try {
      const frame = await bounded(start.ownerFrame(), null);
      if (await bounded(start.evaluate((el) => (el as Element).matches("input[type=password]") || !!(el as Element).querySelector("input[type=password]")), true)) return true;
      const box = await bounded(start.boundingBox(), null);
      for (const t of this.tracked) {
        if (t.page !== page) continue;
        if (t.frame === frame && (await bounded(start.evaluate((a, b) => a === b || a.contains(b), t.handle), true))) return true;
        if (overlap(box, await bounded(t.handle.boundingBox(), null))) return true;
      }
      for (const f of page.frames()) {
        const passwords = await bounded(f.locator("input[type=password]").all(), []);
        for (const p of passwords) if (overlap(box, await bounded(p.boundingBox(), null))) return true;
      }
      return false;
    } finally {
      void start.dispose().catch(() => {});
    }
  }

  /**
   * After a call, with the result's text (snapshot inlined): read the tracked
   * elements, scan for a secret that landed elsewhere, and work out which
   * lines of this result are a tracked or password field's own.
   */
  async refresh(text: string): Promise<void> {
    this.hiddenRefs = new Set();
    // A dialog blocks the page's JavaScript: a read would wait for ever. With
    // nothing read, every editable field's value is hidden in this result.
    this.blind = dialogOpen(this.context);
    if (this.blind) return;

    const alive: Tracked[] = [];
    for (const t of this.tracked) {
      const value = await bounded(t.handle.evaluate(readValue), null as string | null);
      if (value === null && (t.page.isClosed() || !(await bounded(t.handle.evaluate(() => true), false)))) continue;
      alive.push(t);
      if (value) this.history.add(value);
    }
    this.tracked = alive;

    const page = this.page();
    if (!page) return;
    await this.scan(page);

    const lines = text.split("\n");
    const parsed = lines.map(parseLine);
    const refLine = new Map<string, number>();
    for (const [i, p] of parsed.entries()) if (p?.ref) refLine.set(p.ref, i);

    // Each tracked element's own line in this snapshot: its last known ref
    // first (Playwright keeps an element's ref while it lives), otherwise a
    // bounded search among the lines that can hold text, leaves included (an
    // unnamed contenteditable is `- generic [ref=e2]: text`).
    const found = new Set<Tracked>();
    for (const t of this.tracked) {
      if (t.page !== page || !t.lastRef || !refLine.has(t.lastRef)) continue;
      const handle = await this.resolve(page, t.lastRef);
      if (handle && (await this.trackedFor(handle)) === t) {
        this.hiddenRefs.add(t.lastRef);
        found.add(t);
      }
      void handle?.dispose().catch(() => {});
    }
    if (this.tracked.some((t) => t.page === page && !found.has(t))) {
      let looked = 0;
      for (const [i, p] of parsed.entries()) {
        if (!p?.ref || this.hiddenRefs.has(p.ref)) continue;
        const next = parsed[i + 1];
        const holdsText = p.value !== null || (next !== undefined && next !== null && next.indent > p.indent);
        if (!holdsText) continue;
        if (++looked > 200) break;
        const handle = await this.resolve(page, p.ref);
        if (!handle) continue;
        const t = await this.trackedFor(handle);
        void handle.dispose().catch(() => {});
        if (t) {
          this.hiddenRefs.add(p.ref);
          t.lastRef = p.ref;
          t.key ??= roleAndName(p);
        }
      }
    }

    // Every editable field's own line: a password field, or one the runner
    // cannot identify, is hidden.
    for (const p of parsed) {
      if (!p?.ref || p.value === null || !p.role || !EDITABLE_ROLES.has(p.role) || this.hiddenRefs.has(p.ref)) continue;
      const handle = await this.resolve(page, p.ref);
      if (!handle) {
        this.hiddenRefs.add(p.ref);
        continue;
      }
      try {
        if (await bounded(handle.evaluate((el) => el instanceof HTMLInputElement && el.type === "password"), true)) {
          this.hiddenRefs.add(p.ref);
          continue;
        }
        const t = await this.trackedFor(handle);
        if (t) {
          this.hiddenRefs.add(p.ref);
          t.lastRef = p.ref;
          t.key ??= roleAndName(p);
        }
      } finally {
        void handle.dispose().catch(() => {});
      }
    }
  }

  /** Why this result's field values are hidden wholesale, if they are. */
  blindReason(): string | null {
    return this.blind ? "Field values are hidden in this result because a dialog is open, which stops the runner from reading the page. Handle the dialog, then take a snapshot." : null;
  }

  /** Values to scrub from a whole result: everything a tracked field has held. */
  scrubbable(): string[] {
    return [...this.history].filter((value) => value.length >= MIN_SCRUBBED_LENGTH);
  }

  /** Hide the value on every line of a tracked or password field. */
  mask(text: string): string {
    const lines = text.split("\n");
    const parsed = lines.map(parseLine);
    if (text.includes("### Snapshot")) {
      this.latest = new Map();
      for (const p of parsed) {
        const key = roleAndName(p);
        if (p?.ref && key) this.latest.set(p.ref, key);
      }
    }
    const page = this.page();
    const keys = new Set(this.tracked.filter((t) => t.key && t.page === page).map((t) => t.key!));
    const out: string[] = [];
    // While set, lines indented deeper than this belong to a hidden element.
    let hiddenBelow = -1;
    for (const [i, line] of lines.entries()) {
      const p = parsed[i];
      const indent = line.length - line.trimStart().length;
      if (hiddenBelow >= 0) {
        if (indent > hiddenBelow && line.trim() !== "") continue;
        hiddenBelow = -1;
      }
      if (!p) {
        out.push(line);
        continue;
      }
      const key = roleAndName(p);
      // The element itself is tracked (or a password field): its value and
      // everything nested under it (a contenteditable's text and blocks).
      if ((p.ref !== null && this.hiddenRefs.has(p.ref)) || (key !== null && keys.has(key))) {
        hiddenBelow = indent;
        out.push(p.opensChildren || p.value !== null ? withValue(p, HIDDEN) : line);
        continue;
      }
      if (p.value === null) {
        out.push(line);
        continue;
      }
      const editable = p.role !== null && EDITABLE_ROLES.has(p.role);
      const sensitive = (this.blind && editable) || (p.value.length >= MIN_SCRUBBED_LENGTH && this.history.has(p.value));
      out.push(sensitive ? withValue(p, HIDDEN) : line);
    }
    return out.join("\n");
  }

  /** Track every editable element on the page that holds a secret or a run of one. */
  private async scan(page: Page): Promise<void> {
    if (this.runs.length === 0) return;
    for (const frame of page.frames()) {
      const editables = frame.locator(EDITABLE);
      const values = await bounded(editables.evaluateAll((els) => els.map((el) => ((el as HTMLElement).isContentEditable ? (el.textContent ?? "") : String((el as HTMLInputElement).value ?? "")))), [] as string[]);
      for (const [index, value] of values.entries()) {
        if (!value || !this.holdsSecret(value)) continue;
        const handle = await bounded(editables.nth(index).elementHandle({ timeout: READ_TIMEOUT_MS }), null);
        if (handle && !(await this.trackedFor(handle))) await this.track(handle, page, null);
        this.history.add(value);
      }
    }
  }

  private holdsSecret(value: string): boolean {
    return this.runs.some(({ value: secret, grams }) => {
      if (value.includes(secret)) return true;
      const k = grams.values().next().value?.length ?? 0;
      if (k === 0) return false;
      for (let i = 0; i + k <= value.length; i++) if (grams.has(value.slice(i, i + k))) return true;
      return false;
    });
  }

  private async track(handle: ElementHandle, page: Page, key: string | null, lastRef: string | null = null): Promise<void> {
    this.tracked.push({ handle, page, frame: await bounded(handle.ownerFrame(), null), key, lastRef });
  }

  /** The tracked entry for this element, compared only within its frame. */
  private async trackedFor(handle: ElementHandle): Promise<Tracked | undefined> {
    const frame = await bounded(handle.ownerFrame(), null);
    for (const t of this.tracked) {
      if (t.frame !== frame) continue;
      if (await bounded(handle.evaluate((a, b) => a === b, t.handle), false)) return t;
    }
    return undefined;
  }

  private page(): Page | undefined {
    const active = activePage(this.context);
    if (active) return active;
    const pages = this.context.pages();
    return pages.length === 1 ? pages[0] : undefined;
  }

  private resolve(page: Page, ref: string): Promise<ElementHandle | null> {
    // `aria-ref` resolves against the page's latest snapshot, the one the
    // agent (and this result) took its refs from.
    return bounded(page.locator(`aria-ref=${ref}`).elementHandle({ timeout: READ_TIMEOUT_MS }), null, READ_TIMEOUT_MS * 2);
  }
}

function readValue(el: Element): string {
  return (el as HTMLElement).isContentEditable ? (el.textContent ?? "") : "value" in el ? String((el as HTMLInputElement).value) : (el.textContent ?? "");
}
