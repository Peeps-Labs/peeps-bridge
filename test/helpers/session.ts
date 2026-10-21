/** A real browser host behind the runner's call handler, for browser tests. */
import assert from "node:assert/strict";

import { startBrowserHost } from "../../src/browser/browser-host.js";
import { OriginPolicy } from "../../src/browser/origin-policy.js";
import { createCallHandler } from "../../src/runner.js";
import type { CallOutcome } from "../../src/protocol/index.js";

export const textOf = (outcome: CallOutcome) => {
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  return (outcome as { result: { content: { text: string }[] } }).result.content[0]!.text;
};

export const refOf = (snapshot: string, pattern: RegExp) => {
  const line = snapshot.split("\n").find((l) => pattern.test(l));
  assert.ok(line, `no line matching ${pattern} in\n${snapshot}`);
  return /\[ref=([a-z0-9]+)\]/.exec(line)![1]!;
};

export async function session(appUrl: string, secrets: Record<string, string>, tmpRoot: string) {
  const policy = OriginPolicy.from(`${appUrl}/`, []);
  const host = await startBrowserHost({ policy, secrets, version: "test", tmpRoot });
  const lines: string[] = [];
  const all: string[] = [];
  const handle = createCallHandler({ host, policy, secretNames: new Set(Object.keys(secrets)), print: (l) => lines.push(l) });
  let seq = 0;
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const outcome = await handle({ id: `c${++seq}`, seq, tool, args });
    all.push(JSON.stringify(outcome));
    return outcome;
  };
  const run = async (tool: string, args: Record<string, unknown> = {}) => textOf(await call(tool, args));
  return { host, run, call, lines, all, everything: () => all.join("\n") + lines.join("\n") };
}
