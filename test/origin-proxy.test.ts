import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { OriginPolicy } from "../src/browser/origin-policy.js";
import { startOriginProxy, type OriginProxy } from "../src/browser/origin-proxy.js";

let allowed: http.Server;
let other: http.Server;
let allowedPort: number;
let otherPort: number;
let proxy: OriginProxy;
const refused: string[] = [];

const listen = async (server: http.Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};

before(async () => {
  allowed = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-seen-proxy-header": String(req.headers["proxy-authorization"] ?? "none") });
    res.end(`allowed ${req.method} ${req.url}`);
  });
  other = http.createServer((_req, res) => res.end("SECRET INTRANET PAGE"));
  allowedPort = await listen(allowed);
  otherPort = await listen(other);
  proxy = await startOriginProxy(OriginPolicy.from(`http://127.0.0.1:${allowedPort}/`, []), (origin) => refused.push(origin));
});

after(async () => {
  await proxy.close();
  allowed.close();
  other.close();
});

/** A request in proxy (absolute-URI) form. */
function viaProxy(target: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const proxyUrl = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: proxyUrl.hostname, port: proxyUrl.port, method: "GET", path: target, headers: { host: new URL(target).host, ...headers } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A raw request line to the proxy, answered with its status line. */
function raw(request: string): Promise<string> {
  const proxyUrl = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxyUrl.port), proxyUrl.hostname, () => socket.write(request));
    let data = "";
    socket.on("data", (c) => {
      data += c;
      if (data.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(data.split("\r\n")[0]!);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
  });
}

describe("the origin proxy", () => {
  it("listens on loopback only", () => {
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("forwards a request to an allowed origin", async () => {
    const res = await viaProxy(`http://127.0.0.1:${allowedPort}/shop?q=1`);
    assert.equal(res.status, 200);
    assert.equal(res.body, "allowed GET /shop?q=1");
  });

  it("does not forward proxy credentials upstream", async () => {
    const res = await viaProxy(`http://127.0.0.1:${allowedPort}/`, { "proxy-authorization": "Basic Zm9vOmJhcg==" });
    assert.equal(res.headers["x-seen-proxy-header"], "none");
  });

  it("refuses a request to any other origin, and reports it", async () => {
    const res = await viaProxy(`http://127.0.0.1:${otherPort}/`);
    assert.equal(res.status, 403);
    assert.doesNotMatch(res.body, /SECRET/);
    assert.match(res.body, /not an allowed origin/);
    assert.ok(refused.includes(`http://127.0.0.1:${otherPort}`));
  });

  it("opens a CONNECT tunnel only to an allowed host and port", async () => {
    assert.match(await raw(`CONNECT 127.0.0.1:${allowedPort} HTTP/1.1\r\nHost: 127.0.0.1:${allowedPort}\r\n\r\n`), /^HTTP\/1\.1 200/);
    assert.match(await raw(`CONNECT 127.0.0.1:${otherPort} HTTP/1.1\r\nHost: 127.0.0.1:${otherPort}\r\n\r\n`), /^HTTP\/1\.1 403/);
    assert.ok(refused.includes(`127.0.0.1:${otherPort}`));
  });

  it("refuses an upgrade (WebSocket) to another origin", async () => {
    const line = await raw(
      `GET http://127.0.0.1:${otherPort}/socket HTTP/1.1\r\nHost: 127.0.0.1:${otherPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    );
    assert.match(line, /^HTTP\/1\.1 403/);
  });

  it("refuses a request that is not in proxy form", async () => {
    assert.match(await raw(`GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`), /^HTTP\/1\.1 400/);
  });

  it("answers 502 when an allowed origin is down", async () => {
    const dead = net.createServer();
    const deadPort = await new Promise<number>((resolve) => dead.listen(0, "127.0.0.1", () => resolve((dead.address() as AddressInfo).port)));
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const p = await startOriginProxy(OriginPolicy.from(`http://127.0.0.1:${deadPort}/`, []), () => {});
    try {
      const proxyUrl = new URL(p.url);
      const status = await new Promise<number>((resolve, reject) => {
        http
          .request({ host: proxyUrl.hostname, port: proxyUrl.port, path: `http://127.0.0.1:${deadPort}/` }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", reject)
          .end();
      });
      assert.equal(status, 502);
      const proxyHost = new URL(p.url);
      const line = await new Promise<string>((resolve) => {
        const s = net.connect(Number(proxyHost.port), proxyHost.hostname, () => s.write(`CONNECT 127.0.0.1:${deadPort} HTTP/1.1\r\n\r\n`));
        let d = "";
        s.on("data", (c) => (d += c));
        s.on("close", () => resolve(d.split("\r\n")[0] ?? ""));
      });
      assert.match(line, /^HTTP\/1\.1 502/);
    } finally {
      await p.close();
    }
  });
});

describe("the origin proxy's request forms", () => {
  it("refuses an https URL in absolute form (https only travels through CONNECT)", async () => {
    assert.match(await raw(`GET https://127.0.0.1:${allowedPort}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`), /^HTTP\/1\.1 400/);
  });
});
