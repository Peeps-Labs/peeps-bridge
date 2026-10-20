/**
 * The origins the browser may reach: the target URL's own, plus any the
 * person passed with `--allow-origin` (an SSO host, say). Nothing else, so a
 * page or an agent cannot steer this browser at intranet hosts or cloud
 * metadata and read them back through snapshots (design §7.1).
 *
 * Matching is exact on scheme, host and port. A WebSocket counts as its HTTP
 * twin (`ws:` as `http:`, `wss:` as `https:`), and a CONNECT tunnel, which
 * names only host and port, is allowed when an allowed origin has both.
 */

const WS_TO_HTTP: Record<string, string> = { "ws:": "http:", "wss:": "https:" };

function webUrl(text: string): URL | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url : null;
}

/** An `--allow-origin` value as a normalised origin, or throws. */
export function parseAllowedOrigin(text: string): string {
  const url = webUrl(text);
  const isBareOrigin =
    url !== null &&
    !url.username &&
    !url.password &&
    (url.pathname === "/" || url.pathname === "") &&
    !url.search &&
    !url.hash &&
    !text.includes("*") &&
    !/[?#]/.test(text);
  if (!url || !isBareOrigin) {
    throw new Error(`--allow-origin takes an origin such as https://auth.example.com (scheme, host and optional port, nothing else); got ${JSON.stringify(text)}`);
  }
  return url.origin;
}

export class OriginPolicy {
  private readonly allowed: Set<string>;
  /** `host:port` pairs, for CONNECT. */
  private readonly authorities: Set<string>;

  private constructor(readonly origins: string[]) {
    this.allowed = new Set(origins);
    this.authorities = new Set(
      origins.map((origin) => {
        const url = new URL(origin);
        return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
      }),
    );
  }

  static from(targetUrl: string, allowOrigins: string[]): OriginPolicy {
    const target = webUrl(targetUrl);
    if (!target) throw new Error(`--target-url must be a full http:// or https:// URL; got ${JSON.stringify(targetUrl)}`);
    const origins = [target.origin, ...allowOrigins.map(parseAllowedOrigin)];
    return new OriginPolicy([...new Set(origins)]);
  }

  /** The origin of a URL, for messages; the text itself when it has none. */
  static originOf(text: string): string {
    try {
      const url = new URL(text);
      return url.host ? `${url.protocol}//${url.host}` : text;
    } catch {
      return text;
    }
  }

  allowsUrl(text: string): boolean {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return false;
    }
    const protocol = WS_TO_HTTP[url.protocol] ?? url.protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
    if (url.username || url.password) return false;
    // Re-parse as HTTP so default ports normalise the same way for ws(s).
    const asHttp = new URL(`${protocol}//${url.host}`);
    return this.allowed.has(asHttp.origin);
  }

  /** A CONNECT request's `host:port`. */
  allowsAuthority(authority: string): boolean {
    const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+):(\d{1,5})$/.exec(authority);
    if (!match) return false;
    let host: string;
    try {
      host = new URL(`http://${match[1]}`).hostname;
    } catch {
      return false;
    }
    return this.authorities.has(`${host}:${Number(match[2])}`);
  }
}
