import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertMcpContext, patchable } from "../src/browser/mcp-patches.js";

describe("the playwright-core internals the runner patches", () => {
  it("are checked at patch time, so a rename fails at startup", () => {
    assert.equal(typeof patchable({ f: () => {} }, "f", "Tab"), "function");
    assert.throws(() => patchable({}, "_downloadStarted", "Tab"), /Tab\._downloadStarted is not a function/);
    assert.throws(() => patchable({ setModalState: 1 }, "setModalState", "Tab"), /changed shape/);
  });

  it("throws when the MCP backend's context is not the shape the runner relies on", () => {
    assert.throws(() => assertMcpContext(undefined), /changed shape/);
    assert.throws(() => assertMcpContext({ currentTab: () => undefined }), /changed shape/);
    assert.doesNotThrow(() => assertMcpContext({ currentTab: () => undefined, tabs: () => [] }));
  });
});
