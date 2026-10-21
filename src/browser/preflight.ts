/**
 * Before anything else: is the Chromium this runner's playwright-core drives
 * installed? If not, say exactly how to install it and how big it is, and
 * stop. The runner never downloads a browser on its own.
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const PLAYWRIGHT_CORE_VERSION: string = (require("playwright-core/package.json") as { version: string }).version;

export function installCommand(version = PLAYWRIGHT_CORE_VERSION): string {
  return `npx -y playwright-core@${version} install --only-shell chromium`;
}

/** Where the headless Chromium for this playwright-core lives, or null. */
export function chromiumExecutablePath(): string | null {
  const { registry } = require("playwright-core/lib/server/registry/index") as {
    registry: { findExecutable(name: string): { executablePath(language: string): string | undefined } | undefined };
  };
  return registry.findExecutable("chromium-headless-shell")?.executablePath("javascript") ?? null;
}

export type Preflight = { ok: true } | { ok: false; message: string };

export function chromiumPreflight(executablePath: string | null = chromiumExecutablePath(), exists: (p: string) => boolean = fs.existsSync): Preflight {
  if (executablePath && exists(executablePath)) return { ok: true };
  return {
    ok: false,
    message: [
      `peeps-bridge needs Chromium for playwright-core ${PLAYWRIGHT_CORE_VERSION}, and it is not installed.`,
      "Install it with:",
      "",
      `  ${installCommand()}`,
      "",
      "That downloads Chrome Headless Shell (about 100-120 MB; about 260 MB on disk) into Playwright's",
      "browser cache, shared with other Playwright installs. peeps-bridge does not install it for you.",
      "Then run the peeps-bridge command again.",
    ].join("\n"),
  };
}
