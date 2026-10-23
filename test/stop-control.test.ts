import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { stopControl } from "../src/stop-control.js";

function control() {
  const events: string[] = [];
  const clock = { now: 1_000 };
  const c = stopControl({ begin: (why) => events.push(`begin:${why}`), force: () => events.push("force"), now: () => clock.now });
  return { c, events, clock };
}

describe("stopControl", () => {
  it("a signal begins the orderly stop; a second signal forces it", () => {
    const { c, events, clock } = control();
    c.signal();
    clock.now += 2_000;
    c.signal();
    assert.deepEqual(events, ["begin:signal", "force"]);
  });

  it("does not take npm's forwarded copy of the same Ctrl-C for a second one", () => {
    const { c, events, clock } = control();
    c.signal();
    // npx is the runner's parent where /bin/sh execs it: the terminal's
    // Ctrl-C arrives, and npm forwards it again a few milliseconds later.
    clock.now += 5;
    c.signal();
    clock.now += 400;
    c.signal();
    assert.deepEqual(events, ["begin:signal"]);
    // A real second Ctrl-C, later, still forces.
    clock.now += 200;
    c.signal();
    assert.deepEqual(events, ["begin:signal", "force"]);
  });

  it("a parent gone begins the orderly stop once, and a signal right after it does not force (the same Ctrl-C reaching both)", () => {
    const { c, events, clock } = control();
    c.parentGone();
    c.signal();
    c.parentGone();
    assert.deepEqual(events, ["begin:parent"]);
    clock.now += 2_000;
    c.signal();
    assert.deepEqual(events, ["begin:parent", "force"]);
  });

  it("a parent gone after a signal changes nothing", () => {
    const { c, events } = control();
    c.signal();
    c.parentGone();
    assert.deepEqual(events, ["begin:signal"]);
    assert.equal(c.begun(), true);
  });
});
