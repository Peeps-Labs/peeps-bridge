/**
 * Two small local sites for the real-Chromium tests: `app`, the target the
 * session allows, and `intranet`, an origin it does not. `intranet` counts
 * every connection it receives, so a test can prove the browser never
 * reached it at all, not merely that a page did not show it.
 */

import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Sites {
  appUrl: string;
  intranetUrl: string;
  intranetConnections: () => number;
  /** Requests for the service-worker script: Chromium fetches it only to install one. */
  serviceWorkerFetches: () => number;
  close(): Promise<void>;
}

const page = (body: string) => `<!doctype html><html><head><title>Test shop</title>
<script>function mark(t){const p=document.createElement('p');p.textContent=t;document.body.appendChild(p);}</script></head><body>${body}</body></html>`;

export async function startSites(): Promise<Sites> {
  let intranetConnections = 0;
  const intranet = http.createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>SECRET INTRANET PAGE</h1>"));
  intranet.on("connection", () => (intranetConnections += 1));
  intranet.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((resolve) => intranet.listen(0, "127.0.0.1", resolve));
  const intranetUrl = `http://127.0.0.1:${(intranet.address() as AddressInfo).port}`;

  let appUrl = "";
  let serviceWorkerFetches = 0;
  const app = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", appUrl);
    const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(page(body));
    switch (url.pathname) {
      case "/":
        return html(`<h1>Shop</h1><a href="/landing">Landing</a><button onclick="mark('clicked')">Place order</button>`);
      case "/redirect-out":
        return res.writeHead(302, { location: `${intranetUrl}/secret` }).end();
      case "/redirect-out-https":
        return res.writeHead(302, { location: `${intranetUrl.replace("http:", "https:")}/secret` }).end();
      case "/redirect-in":
        return res.writeHead(302, { location: "/landing" }).end();
      case "/landing":
        return html("<h1>Landed</h1>");
      case "/api":
        return res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" }).end("pong");
      case "/subresources":
        return html(`<h1>Subresources</h1><img src="${intranetUrl}/pixel.png" alt="tracker">
<script>
fetch('${intranetUrl}/api').then(r=>r.text()).then(t=>mark('cross fetch '+t),()=>mark('cross fetch blocked'));
fetch('/api').then(r=>r.text()).then(t=>mark('same fetch '+t));
</script>`);
      case "/sockets":
        return html(`<h1>Sockets</h1>
<script>
const ok=new WebSocket('ws://'+location.host+'/sock'); ok.onopen=()=>mark('allowed ws open'); ok.onerror=()=>mark('allowed ws error');
const bad=new WebSocket('${intranetUrl.replace("http:", "ws:")}/sock'); bad.onopen=()=>mark('other ws open'); bad.onerror=()=>mark('other ws error');
</script>`);
      case "/service-worker":
        return html(`<h1>Service worker</h1>
<script>
(async()=>{
  if(!navigator.serviceWorker){mark('service worker: unavailable');return;}
  try{await navigator.serviceWorker.register('/sw.js')}catch(e){}
  try{await ServiceWorkerContainer.prototype.register.call(navigator.serviceWorker,'/sw.js');mark('prototype register resolved')}catch(e){mark('prototype register refused')}
  const regs=await navigator.serviceWorker.getRegistrations();
  mark('service worker: '+regs.length+' registered');
})();
</script>`);
      case "/sw.js":
        serviceWorkerFetches += 1;
        return res.writeHead(200, { "content-type": "text/javascript" }).end("self.addEventListener('fetch',()=>{});");
      case "/login":
        if (req.method === "POST") {
          let body = "";
          req.on("data", (c) => (body += c));
          req.on("end", () => html(`<h1>Signed in</h1><p>Server saw: ${body.replace(/</g, "&lt;")}</p>`));
          return;
        }
        return html(`<h1>Sign in</h1><form method="post" action="/login">
<label>Password <input name="password" type="text" oninput="document.getElementById('echo').textContent='Typed: '+this.value"></label>
<p id="echo"></p><button type="submit">Sign in</button></form>`);
      case "/big":
        return html("<h1>Big</h1>" + Array.from({ length: 6000 }, (_, i) => `<p>Paragraph ${i} with some filler text to make the snapshot large.</p>`).join(""));
      default:
        return res.writeHead(404).end("not found");
    }
  });
  const upgraded = new Set<import("node:stream").Duplex>();
  app.on("upgrade", (req, socket) => {
    upgraded.add(socket);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  appUrl = `http://localhost:${(app.address() as AddressInfo).port}`;

  return {
    appUrl,
    intranetUrl,
    intranetConnections: () => intranetConnections,
    serviceWorkerFetches: () => serviceWorkerFetches,
    close: async () => {
      for (const socket of upgraded) socket.destroy();
      app.closeAllConnections();
      intranet.closeAllConnections();
      await Promise.all([new Promise((r) => app.close(r)), new Promise((r) => intranet.close(r))]);
    },
  };
}
