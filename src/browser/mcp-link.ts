/**
 * A minimal in-process MCP client for the server `createConnection` returns,
 * so `@playwright/mcp` runs inside this process with no stdio child and no
 * extra dependency. It speaks just what the runner needs: `initialize`,
 * `tools/call`, and an answer to the server's `roots/list`, which is how the
 * server learns its working directory (the scratch directory, never the
 * person's checkout).
 */

import { pathToFileURL } from "node:url";

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The transport shape the MCP SDK's `Server.connect` accepts. */
interface Transport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export interface McpServerLike {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export interface CallToolResult {
  content?: unknown;
  isError?: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";

export class McpLink {
  private nextId = 1;
  private readonly pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;
  private readonly transport: Transport;

  private constructor(
    private readonly server: McpServerLike,
    private readonly rootDirectory: string,
  ) {
    this.transport = {
      start: async () => {},
      send: async (message) => this.receive(message),
      close: async () => {
        this.closed = true;
        this.transport.onclose?.();
      },
    };
  }

  static async connect(server: McpServerLike, rootDirectory: string, clientVersion: string): Promise<McpLink> {
    const link = new McpLink(server, rootDirectory);
    await server.connect(link.transport);
    await link.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: {} },
      clientInfo: { name: "peeps-bridge", version: clientVersion },
    });
    link.deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    return link;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.request("tools/call", { name, arguments: args })) as CallToolResult;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const { reject } of this.pending.values()) reject(new Error("The browser connection closed."));
    this.pending.clear();
    await this.server.close();
    this.closed = true;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("The browser connection is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.deliver({ jsonrpc: "2.0", id, method, params });
    });
  }

  private deliver(message: JsonRpcMessage): void {
    queueMicrotask(() => this.transport.onmessage?.(message));
  }

  /** A message from the server. */
  private receive(message: JsonRpcMessage): void {
    if (message.method === undefined && message.id !== undefined) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id === undefined) return; // A notification (progress, logging): nothing to do.
    if (message.method === "roots/list") {
      this.deliver({ jsonrpc: "2.0", id: message.id, result: { roots: [{ uri: pathToFileURL(this.rootDirectory).href, name: "scratch" }] } });
    } else if (message.method === "ping") {
      this.deliver({ jsonrpc: "2.0", id: message.id, result: {} });
    } else {
      this.deliver({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `peeps-bridge does not serve ${message.method}` } });
    }
  }
}
