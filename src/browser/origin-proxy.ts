/**
 * The authoritative origin check: an HTTP forward proxy on loopback that
 * Chromium sends everything through (`--proxy-server`, with
 * `--proxy-bypass-list=<-loopback>` so localhost is not exempt). Redirects,
 * subresources, WebSockets and service-worker fetches all arrive here as
 * ordinary proxy requests, so a host outside the policy is refused whatever
 * asked for it. `context.route` in front of it is only the fast first check
 * (design §7.1).
 *
 * - `http:` requests arrive in absolute form and are forwarded or refused 403.
 * - `https:` and WebSocket traffic arrives as `CONNECT host:port`; the tunnel
 *   opens only to an allowed host and port. TLS is not intercepted.
 * - An absolute-form `Upgrade` request is checked the same way.
 */

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { OriginPolicy } from "./origin-policy.js";

export interface OriginProxy {
  /** `http://127.0.0.1:<port>`, for Chromium's `--proxy-server`. */
  url: string;
  close(): Promise<void>;
}

/** Hop-by-hop headers, and the proxy's own, are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const refusalBody = (what: string) => `Blocked by peeps-bridge: ${what} is not an allowed origin for this session.\n`;

export async function startOriginProxy(policy: OriginPolicy, onRefused: (originOrAuthority: string) => void): Promise<OriginProxy> {
  const sockets = new Set<net.Socket | Duplex>();
  const track = (socket: net.Socket | Duplex) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };

  const server = http.createServer((req, res) => {
    const target = absoluteTarget(req.url);
    if (!target) {
      res.writeHead(400, { "content-type": "text/plain" }).end("peeps-bridge's proxy only serves proxy requests.\n");
      return;
    }
    if (!policy.allowsUrl(target.href)) {
      onRefused(target.origin);
      res.writeHead(403, { "content-type": "text/plain" }).end(refusalBody(target.origin));
      return;
    }
    const headers = forwardableHeaders(req.headers);
    const upstream = http.request(
      { host: target.hostname.replace(/^\[|\]$/g, ""), port: target.port || 80, method: req.method, path: target.pathname + target.search, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, forwardableHeaders(upstreamRes.headers));
        upstreamRes.pipe(res);
      },
    );
    upstream.on("socket", track);
    upstream.on("error", () => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`peeps-bridge could not reach ${target.origin}.\n`);
    });
    // The browser went away (a closed tab, an SSE stream it dropped): so does
    // the upstream request, rather than streaming into nowhere.
    res.on("close", () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    const authority = req.url ?? "";
    if (!policy.allowsAuthority(authority)) {
      onRefused(authority);
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${refusalBody(authority)}`);
      return;
    }
    const separator = authority.lastIndexOf(":");
    const host = authority.slice(0, separator).replace(/^\[|\]$/g, "");
    const upstream = net.connect(Number(authority.slice(separator + 1)), host);
    track(upstream);
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    client.on("close", () => upstream.destroy());
  });

  server.on("upgrade", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    track(client);
    client.on("error", () => client.destroy());
    const target = absoluteTarget(req.url);
    if (!target || !policy.allowsUrl(target.href)) {
      if (target) onRefused(target.origin);
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\n${refusalBody(target?.origin ?? "that")}`);
      return;
    }
    const upstream = net.connect(Number(target.port || 80), target.hostname.replace(/^\[|\]$/g, ""));
    track(upstream);
    upstream.on("connect", () => {
      const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i]!;
        if (/^proxy-/i.test(name)) continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  server.on("connection", track);
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * An absolute-form `http:` request target, or null. (`https:` always arrives
 * as CONNECT; the proxy never speaks TLS upstream itself.)
 */
function absoluteTarget(requestUrl: string | undefined): URL | null {
  if (!requestUrl || !/^http:\/\//i.test(requestUrl)) return null;
  try {
    return new URL(requestUrl);
  } catch {
    return null;
  }
}

function forwardableHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const connectionListed = String(headers.connection ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || connectionListed.includes(name)) continue;
    out[name] = value;
  }
  return out;
}
