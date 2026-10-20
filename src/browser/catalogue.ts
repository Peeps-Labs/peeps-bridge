/**
 * The browser tools this runner serves: the fifteen of Peeps' local-discovery
 * catalogue (Peeps `src/server/agent-bridge/bridge-browser-catalogue.ts`),
 * mirroring `@playwright/mcp` 0.0.69. Enforced here as well as on Peeps, so a
 * compromised or buggy server cannot widen what the browser on this machine
 * will do (design §6.3, "defence in depth").
 *
 * Deliberately absent: `browser_run_code` (runs code in this Node process),
 * `browser_evaluate`, `browser_file_upload` (reads local files),
 * `browser_install`, `browser_take_screenshot` (pixels stay here),
 * `browser_close` (the runner owns the browser) and `browser_resize`. The
 * `filename` argument of `browser_snapshot`, `browser_console_messages` and
 * `browser_network_requests` is dropped: it writes a file under the working
 * directory. Any argument a schema does not declare is refused, which also
 * refuses `_meta` (playwright-core reads `_meta.cwd` as a per-call workspace).
 *
 * A test compares these schemas with the installed package's own, so bumping
 * `@playwright/mcp` fails until this file and Peeps' copy are updated.
 */

/** The `@playwright/mcp` version Peeps' catalogue mirrors. */
export const PINNED_PLAYWRIGHT_MCP_VERSION = "0.0.69";

export interface JsonSchema {
  type?: "object" | "string" | "number" | "boolean" | "array";
  description?: string;
  default?: unknown;
  enum?: readonly string[];
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: false;
  items?: JsonSchema;
}

export interface BrowserToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema & { type: "object"; properties: Record<string, JsonSchema>; additionalProperties: false };
}

export const BROWSER_CATALOGUE: readonly BrowserToolDefinition[] =
  [
    {
      name: "browser_navigate",
      description: "Navigate to a URL",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to navigate to",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_navigate_back",
      description: "Go back to the previous page in the history",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Capture accessibility snapshot of the current page, this is better than screenshot",
      inputSchema: {
        type: "object",
        properties: {
          depth: {
            description: "Limit the depth of the snapshot tree",
            type: "number",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_click",
      description: "Perform click on a web page",
      inputSchema: {
        type: "object",
        properties: {
          element: {
            description:
              "Human-readable element description used to obtain permission to interact with the element",
            type: "string",
          },
          ref: {
            type: "string",
            description:
              "Exact target element reference from the page snapshot",
          },
          doubleClick: {
            description:
              "Whether to perform a double click instead of a single click",
            type: "boolean",
          },
          button: {
            description: "Button to click, defaults to left",
            type: "string",
            enum: ["left", "right", "middle"],
          },
          modifiers: {
            description: "Modifier keys to press",
            type: "array",
            items: {
              type: "string",
              enum: ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"],
            },
          },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_type",
      description: "Type text into editable element",
      inputSchema: {
        type: "object",
        properties: {
          element: {
            description:
              "Human-readable element description used to obtain permission to interact with the element",
            type: "string",
          },
          ref: {
            type: "string",
            description:
              "Exact target element reference from the page snapshot",
          },
          text: {
            type: "string",
            description: "Text to type into the element",
          },
          submit: {
            description: "Whether to submit entered text (press Enter after)",
            type: "boolean",
          },
          slowly: {
            description:
              "Whether to type one character at a time. Useful for triggering key handlers in the page. By default entire text is filled in at once.",
            type: "boolean",
          },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_fill_form",
      description: "Fill multiple form fields",
      inputSchema: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  description: "Human-readable field name",
                },
                type: {
                  type: "string",
                  enum: ["textbox", "checkbox", "radio", "combobox", "slider"],
                  description: "Type of the field",
                },
                ref: {
                  type: "string",
                  description:
                    "Exact target field reference from the page snapshot",
                },
                selector: {
                  description:
                    'CSS or role selector for the field element, when "ref" is not available. Either "selector" or "ref" is required.',
                  type: "string",
                },
                value: {
                  type: "string",
                  description:
                    "Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option.",
                },
              },
              required: ["name", "type", "ref", "value"],
              additionalProperties: false,
            },
            description: "Fields to fill in",
          },
        },
        required: ["fields"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_press_key",
      description: "Press a key on the keyboard",
      inputSchema: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Name of the key to press or a character to generate, such as `ArrowLeft` or `a`",
          },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_select_option",
      description: "Select an option in a dropdown",
      inputSchema: {
        type: "object",
        properties: {
          element: {
            description:
              "Human-readable element description used to obtain permission to interact with the element",
            type: "string",
          },
          ref: {
            type: "string",
            description:
              "Exact target element reference from the page snapshot",
          },
          values: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Array of values to select in the dropdown. This can be a single value or multiple values.",
          },
        },
        required: ["ref", "values"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_hover",
      description: "Hover over element on page",
      inputSchema: {
        type: "object",
        properties: {
          element: {
            description:
              "Human-readable element description used to obtain permission to interact with the element",
            type: "string",
          },
          ref: {
            type: "string",
            description:
              "Exact target element reference from the page snapshot",
          },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_drag",
      description: "Perform drag and drop between two elements",
      inputSchema: {
        type: "object",
        properties: {
          startElement: {
            type: "string",
            description:
              "Human-readable source element description used to obtain the permission to interact with the element",
          },
          startRef: {
            type: "string",
            description:
              "Exact source element reference from the page snapshot",
          },
          endElement: {
            type: "string",
            description:
              "Human-readable target element description used to obtain the permission to interact with the element",
          },
          endRef: {
            type: "string",
            description:
              "Exact target element reference from the page snapshot",
          },
        },
        required: ["startElement", "startRef", "endElement", "endRef"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_wait_for",
      description:
        "Wait for text to appear or disappear or a specified time to pass",
      inputSchema: {
        type: "object",
        properties: {
          time: {
            description: "The time to wait in seconds",
            type: "number",
          },
          text: {
            description: "The text to wait for",
            type: "string",
          },
          textGone: {
            description: "The text to wait for to disappear",
            type: "string",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_handle_dialog",
      description: "Handle a dialog",
      inputSchema: {
        type: "object",
        properties: {
          accept: {
            type: "boolean",
            description: "Whether to accept the dialog.",
          },
          promptText: {
            description: "The text of the prompt in case of a prompt dialog.",
            type: "string",
          },
        },
        required: ["accept"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_tabs",
      description: "List, create, close, or select a browser tab.",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "new", "close", "select"],
            description: "Operation to perform",
          },
          index: {
            description:
              "Tab index, used for close/select. If omitted for close, current tab is closed.",
            type: "number",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_console_messages",
      description: "Returns all console messages",
      inputSchema: {
        type: "object",
        properties: {
          level: {
            default: "info",
            description:
              'Level of the console messages to return. Each level includes the messages of more severe levels. Defaults to "info".',
            type: "string",
            enum: ["error", "warning", "info", "debug"],
          },
          all: {
            description:
              "Return all console messages since the beginning of the session, not just since the last navigation. Defaults to false.",
            type: "boolean",
          },
        },
        required: ["level"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_network_requests",
      description: "Returns all network requests since loading the page",
      inputSchema: {
        type: "object",
        properties: {
          static: {
            default: false,
            description:
              "Whether to include successful static resources like images, fonts, scripts, etc. Defaults to false.",
            type: "boolean",
          },
          requestBody: {
            default: false,
            description: "Whether to include request body. Defaults to false.",
            type: "boolean",
          },
          requestHeaders: {
            default: false,
            description:
              "Whether to include request headers. Defaults to false.",
            type: "boolean",
          },
          filter: {
            description:
              'Only return requests whose URL matches this regexp (e.g. "/api/.*user").',
            type: "string",
          },
        },
        required: ["static", "requestBody", "requestHeaders"],
        additionalProperties: false,
      },
    },
  ];
