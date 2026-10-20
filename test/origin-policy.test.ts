import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { OriginPolicy, parseAllowedOrigin } from "../src/browser/origin-policy.js";

describe("parseAllowedOrigin", () => {
  it("normalises an origin", () => {
    assert.equal(parseAllowedOrigin("https://Auth.Example.com"), "https://auth.example.com");
    assert.equal(parseAllowedOrigin("https://auth.example.com:443/"), "https://auth.example.com");
    assert.equal(parseAllowedOrigin("http://localhost:3000"), "http://localhost:3000");
  });

  for (const bad of ["auth.example.com", "ftp://x.example", "https://x.example/path", "https://x.example/?q", "https://*.example.com", "https://user:pw@x.example", "file:///tmp", ""]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => parseAllowedOrigin(bad), /--allow-origin/);
    });
  }
});

describe("OriginPolicy", () => {
  const policy = OriginPolicy.from("http://localhost:3000/shop?x=1", ["https://auth.example.com"]);

  it("lists its origins", () => {
    assert.deepEqual(policy.origins, ["http://localhost:3000", "https://auth.example.com"]);
  });

  it("allows the target's origin and the extra ones", () => {
    assert.equal(policy.allowsUrl("http://localhost:3000/checkout"), true);
    assert.equal(policy.allowsUrl("http://LOCALHOST:3000/"), true);
    assert.equal(policy.allowsUrl("https://auth.example.com/login"), true);
    assert.equal(policy.allowsUrl("https://auth.example.com:443/login"), true);
  });

  it("allows WebSockets to an allowed origin", () => {
    assert.equal(policy.allowsUrl("ws://localhost:3000/_next/webpack-hmr"), true);
    assert.equal(policy.allowsUrl("wss://auth.example.com/socket"), true);
    assert.equal(policy.allowsUrl("ws://localhost:4000/"), false);
  });

  it("refuses other ports, schemes, hosts and tricks", () => {
    assert.equal(policy.allowsUrl("http://localhost:3001/"), false);
    assert.equal(policy.allowsUrl("https://localhost:3000/"), false);
    assert.equal(policy.allowsUrl("http://127.0.0.1:3000/"), false);
    assert.equal(policy.allowsUrl("http://localhost:3000@evil.example/"), false);
    assert.equal(policy.allowsUrl("http://evil.example/?http://localhost:3000"), false);
    assert.equal(policy.allowsUrl("http://auth.example.com/"), false);
    assert.equal(policy.allowsUrl("http://169.254.169.254/latest/meta-data"), false);
    assert.equal(policy.allowsUrl("file:///etc/passwd"), false);
    assert.equal(policy.allowsUrl("data:text/plain,x"), false);
    assert.equal(policy.allowsUrl("not a url"), false);
  });

  it("allows a CONNECT tunnel only to an allowed host and port", () => {
    assert.equal(policy.allowsAuthority("auth.example.com:443"), true);
    assert.equal(policy.allowsAuthority("localhost:3000"), true);
    assert.equal(policy.allowsAuthority("AUTH.example.com:443"), true);
    assert.equal(policy.allowsAuthority("auth.example.com:8443"), false);
    assert.equal(policy.allowsAuthority("evil.example:443"), false);
    assert.equal(policy.allowsAuthority("auth.example.com"), false);
    assert.equal(policy.allowsAuthority("garbage"), false);
  });

  it("handles IPv6 literals", () => {
    const v6 = OriginPolicy.from("http://[::1]:5173/", []);
    assert.equal(v6.allowsUrl("http://[::1]:5173/app"), true);
    assert.equal(v6.allowsAuthority("[::1]:5173"), true);
    assert.equal(v6.allowsAuthority("[::1]:5174"), false);
  });

  it("names the origin of a URL for messages", () => {
    assert.equal(OriginPolicy.originOf("https://evil.example/a?b"), "https://evil.example");
    assert.equal(OriginPolicy.originOf("ws://evil.example:81/x"), "ws://evil.example:81");
    assert.equal(OriginPolicy.originOf("nonsense"), "nonsense");
  });

  it("refuses a target URL that is not http(s)", () => {
    assert.throws(() => OriginPolicy.from("file:///tmp/index.html", []), /--target-url/);
    assert.throws(() => OriginPolicy.from("localhost:3000", []), /--target-url/);
  });
});
