import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { BROWSER_CATALOGUE, PINNED_PLAYWRIGHT_MCP_VERSION } from "../src/browser/catalogue.js";
import { ALLOWED_TOOLS, refuseCall } from "../src/browser/allowlist.js";

const require = createRequire(import.meta.url);

describe("the tool allowlist", () => {
  it("is exactly the fifteen catalogue tools", () => {
    assert.deepEqual([...ALLOWED_TOOLS].sort(), [
      "browser_click",
      "browser_console_messages",
      "browser_drag",
      "browser_fill_form",
      "browser_handle_dialog",
      "browser_hover",
      "browser_navigate",
      "browser_navigate_back",
      "browser_network_requests",
      "browser_press_key",
      "browser_select_option",
      "browser_snapshot",
      "browser_tabs",
      "browser_type",
      "browser_wait_for",
    ]);
  });

  for (const tool of [
    "browser_run_code",
    "browser_evaluate",
    "browser_file_upload",
    "browser_install",
    "browser_take_screenshot",
    "browser_close",
    "browser_resize",
    "shell",
    "__proto__",
  ]) {
    it(`refuses ${tool}`, () => {
      assert.match(refuseCall(tool, {}) ?? "", /not available/);
    });
  }

  it("accepts well-formed calls", () => {
    assert.equal(refuseCall("browser_navigate", { url: "http://localhost:3000/" }), null);
    assert.equal(refuseCall("browser_snapshot", {}), null);
    assert.equal(refuseCall("browser_snapshot", { depth: 3 }), null);
    assert.equal(refuseCall("browser_click", { ref: "e1", element: "Buy", button: "left", modifiers: ["Shift"] }), null);
    assert.equal(
      refuseCall("browser_fill_form", {
        fields: [{ name: "Email", type: "textbox", ref: "e2", value: "SHOP_EMAIL" }],
      }),
      null,
    );
    assert.equal(refuseCall("browser_network_requests", { static: false, requestBody: false, requestHeaders: false }), null);
  });

  for (const tool of ["browser_snapshot", "browser_console_messages", "browser_network_requests"]) {
    it(`refuses filename on ${tool}`, () => {
      assert.match(refuseCall(tool, { filename: "../../src/index.ts" }) ?? "", /does not take filename/);
    });
  }

  it("refuses _meta, which playwright-core reads as a per-call working directory", () => {
    assert.match(refuseCall("browser_snapshot", { _meta: { cwd: "/" } }) ?? "", /does not take _meta/);
  });

  it("refuses arguments that do not match the schema", () => {
    assert.match(refuseCall("browser_snapshot", { depth: "deep" }) ?? "", /depth must be a number/);
    assert.match(refuseCall("browser_click", {}) ?? "", /ref is required/);
    assert.match(refuseCall("browser_click", { ref: "e1", button: "back" }) ?? "", /button must be one of/);
    assert.match(refuseCall("browser_click", { ref: "e1", modifiers: ["Hyper"] }) ?? "", /modifiers\[0\] must be one of/);
    assert.match(refuseCall("browser_click", { ref: "e1", modifiers: "Shift" }) ?? "", /modifiers must be an array/);
    assert.match(refuseCall("browser_type", { ref: "e1", text: 5 }) ?? "", /text must be a string/);
    assert.match(refuseCall("browser_type", { ref: "e1", text: "x", submit: "yes" }) ?? "", /submit must be a boolean/);
    assert.match(
      refuseCall("browser_fill_form", { fields: [{ name: "a", type: "textbox", ref: "e1", value: "v", filename: "x" }] }) ?? "",
      /fields\[0\] does not take filename/,
    );
    assert.match(refuseCall("browser_fill_form", { fields: ["x"] }) ?? "", /fields\[0\] must be an object/);
    assert.match(refuseCall("browser_snapshot", { depth: Number.NaN }) ?? "", /depth must be a number/);
  });

  it("refuses non-object arguments", () => {
    assert.match(refuseCall("browser_snapshot", null as unknown as Record<string, unknown>) ?? "", /must be an object/);
    assert.match(refuseCall("browser_snapshot", [] as unknown as Record<string, unknown>) ?? "", /must be an object/);
  });

  for (const url of ["file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "view-source:http://localhost/", "chrome://settings", "localhost:3000", "not a url"]) {
    it(`refuses to navigate to ${url}`, () => {
      assert.match(refuseCall("browser_navigate", { url }) ?? "", /only opens http:\/\/ and https:\/\/ URLs/);
    });
  }
});

describe("the catalogue against the installed @playwright/mcp", () => {
  it("loads the pinned version", () => {
    assert.equal(require("@playwright/mcp/package.json").version, PINNED_PLAYWRIGHT_MCP_VERSION);
  });

  it("declares every tool with the installed schema, minus filename", () => {
    // The tools `createConnection` serves: `filteredTools` drops skill-only
    // tools and the `selector` arguments the MCP server does not offer.
    const { filteredTools, toMcpTool } = require("playwright-core/lib/tools/exports") as {
      filteredTools: (config: object) => { schema: unknown }[];
      toMcpTool: (schema: unknown) => { name: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };
    };
    const installed = new Map(filteredTools({}).map((t) => toMcpTool(t.schema)).map((t) => [t.name, t]));
    for (const tool of BROWSER_CATALOGUE) {
      const upstream = installed.get(tool.name);
      assert.ok(upstream, `${tool.name} is not in the installed package`);
      const upstreamProperties = { ...upstream.inputSchema.properties };
      delete upstreamProperties.filename;
      assert.deepEqual(
        JSON.parse(JSON.stringify(tool.inputSchema.properties)),
        JSON.parse(JSON.stringify(upstreamProperties)),
        `${tool.name}'s properties drifted`,
      );
      assert.equal(tool.description, (upstream as unknown as { description: string }).description);
      assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), [...(upstream.inputSchema.required ?? [])].filter((k) => k !== "filename").sort());
    }
  });
});
