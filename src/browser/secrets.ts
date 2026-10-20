/**
 * Sign-in values stay on this machine (design §7.2). The person names them on
 * the command line as `--sign-in-secret NAME=ENV_VAR`; the runner reads each
 * variable and hands the values to Playwright MCP in memory as its `secrets`
 * map, so the agent types the NAME and Playwright fills in the value.
 *
 * Playwright's own redaction is a plain string replace it calls "not a
 * security feature", and it misses the encoded forms a request log or a page
 * shows. So every result is also scrubbed here, of every form below, before
 * it is posted to Peeps or printed.
 */

const SPEC = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z_][A-Za-z0-9_]*)$/;

export type Secrets = Record<string, string>;

export function loadSecrets(specs: string[], env: NodeJS.ProcessEnv): Secrets {
  const secrets: Secrets = {};
  for (const spec of specs) {
    const match = SPEC.exec(spec);
    if (!match) throw new Error(`--sign-in-secret takes NAME=ENV_VAR, e.g. SHOP_PASSWORD=MY_APP_PASSWORD; got ${JSON.stringify(spec)}`);
    const [, name, variable] = match as unknown as [string, string, string];
    if (Object.hasOwn(secrets, name)) throw new Error(`--sign-in-secret names ${name} twice`);
    const value = env[variable];
    if (!value) throw new Error(`--sign-in-secret ${name}: the environment variable ${variable} is not set (or is empty) in this shell`);
    secrets[name] = value;
  }
  return secrets;
}

/** Every form a value is likely to appear in, longest first. */
function variants(value: string): string[] {
  const html = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const forms = new Set([
    value,
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
    JSON.stringify(value).slice(1, -1),
    html,
    html.replace(/&#39;/g, "&#x27;"),
  ]);
  return [...forms].filter((form) => form.length > 0);
}

/** A function that replaces every secret value with `<secret>NAME</secret>`. */
export function makeScrubber(secrets: Secrets): (text: string) => string {
  const pairs = Object.entries(secrets)
    .flatMap(([name, value]) => variants(value).map((form) => [form, `<secret>${name}</secret>`] as const))
    .sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const [form, replacement] of pairs) out = out.split(form).join(replacement);
    return out;
  };
}
