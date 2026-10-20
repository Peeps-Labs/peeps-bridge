# @peepsai/bridge

Lets Peeps' discovery agent explore the app you are building on your own
machine, at `localhost`, without opening your machine to the internet.

The agent keeps running on Peeps. Only its browser runs here: this package
starts a headless Chromium, connects **out** to Peeps, and performs the
browser actions Peeps asks for, one at a time, printing each one. When the
session ends it closes the browser and exits.

You normally do not type the command yourself. Your coding agent calls the
Peeps MCP tool `start_local_discovery`, which returns the exact command and
the grant for one session, and runs it.

## The command

```sh
PEEPS_RUNNER_GRANT=<grant> npx -y @peepsai/bridge@0.1.0 \
  --server https://app.peepsai.com \
  --session <session id> \
  --target-url http://localhost:3000 \
  [--allow-origin https://auth.example.com]... \
  [--sign-in-secret SHOP_PASSWORD=MY_APP_PASSWORD]...
```

| Option | What it does |
| --- | --- |
| `--server` | Peeps' address. `https://`, or `http://` only for a Peeps running on this machine. |
| `--session` | The session `start_local_discovery` started. |
| `--target-url` | Your app. The browser may reach this origin (scheme, host and port) and nothing else. |
| `--allow-origin` | Another origin the browser may reach, such as your sign-in provider. Repeatable. |
| `--sign-in-secret NAME=ENV_VAR` | Lets the agent sign in without seeing the password: it types `NAME`, and the browser fills in the value of `ENV_VAR` from your shell. Repeatable. |
| `PEEPS_RUNNER_GRANT` | The session's grant, from the environment only. A grant on the command line is refused, because any process on the machine can read command lines. |

While it runs you see one line per action:

```
[peeps] peeps-bridge 0.1.0: serving session 6f1c… for https://app.peepsai.com
[peeps] the browser may reach: http://localhost:3000
[peeps] attached to session 6f1c… (discover); it expires at 2026-10-20T15:45:00.000Z
[peeps] #1 navigate to http://localhost:3000/ on /
[peeps] #2 click 'Add to cart' on /products/1
[peeps] #3 type secret SHOP_PASSWORD into 'Password' on /login
```

Press Ctrl-C to stop. The action in progress finishes, the browser closes and
the runner exits. Press it again to close the browser at once.

## What it can and cannot do

In plain words:

- **Outbound only.** It opens no port. It polls Peeps over HTTPS for the next
  browser action and posts the result back. Nothing on the internet can
  connect to it.
- **A browser and nothing else.** It offers fifteen browser tools (navigate,
  go back, read the page, click, type, fill a form, press a key, select,
  hover, drag, wait, answer a dialog, tabs, console messages, network
  requests). It has no shell, no file access and no way to run code on your
  machine: the Playwright tools that run code, read files, upload files, take
  screenshots, install browsers or close the browser are refused here, even if
  Peeps asked for them, and so is any argument the tools do not declare (such
  as `filename`, which would write into your working directory).
- **An isolated browser.** A fresh, in-memory Chromium profile: never your own
  browser, cookies or extensions. Service workers and downloads are blocked.
  It uses Chromium's sandbox where your OS allows it and says so when it
  cannot.
- **Your app only.** Every request the browser makes, including redirects,
  images, scripts, `fetch` calls and WebSockets, goes through a small proxy
  inside the runner that refuses any origin other than `--target-url`'s and
  the ones you add with `--allow-origin`. That keeps the agent, and any page it
  visits, away from the rest of your network: other local services, your
  intranet, cloud metadata endpoints.
- **Secrets stay local.** A value named with `--sign-in-secret` is read from
  your environment and kept in memory. The agent only ever sees the name. The
  runner also removes the value, in plain, URL-encoded, form-encoded, JSON and
  HTML-escaped forms, from every result before it leaves your machine and from
  every line it prints.
- **Short-lived.** The grant works for one session, one person and one MCP
  connection, and only while the session lasts (at most 45 minutes). Peeps
  checks it on every request, so revoking the MCP connection, losing your
  role, or Peeps ending the session stops the runner within one poll.

What **does** leave your machine: the text of the pages the browser visits
(accessibility snapshots), and console messages and network request summaries
when the agent asks for them. That is what the agent reads to propose tests. For work you
have not released yet, that is unreleased page text, and it goes to Peeps and
to the model provider Peeps uses. Screenshots are never sent.

See [SECURITY.md](SECURITY.md) for the detail.

## Requirements

- Node.js 22 or later.
- The Chromium build Playwright uses. If it is missing, the runner stops and
  prints the exact command, which is
  `npx -y playwright-core@<version> install --only-shell chromium` (about
  100-120 MB to download). It never installs a browser on its own.

## Troubleshooting

| You see | What to do |
| --- | --- |
| `needs Chromium … and it is not installed` | Run the install command it prints, then the runner command again. |
| `PEEPS_RUNNER_GRANT is not set` | Run the command with the environment `start_local_discovery` returned. |
| `Another runner is already serving this session` | A session is served by one runner process only, so a runner that was stopped or restarted cannot take it back. Ask your coding agent to run `start_local_discovery` again. |
| `Peeps did not accept PEEPS_RUNNER_GRANT` | The grant is for another session, mistyped, or no longer valid (connection revoked, role changed, local discovery turned off). Start a new session. |
| `loaded @playwright/mcp …; Peeps needs exactly …` | Use the exact versioned command `start_local_discovery` returned, not `@latest`. |
| `browser_navigate refused: … is not an allowed origin` | The agent tried to leave your app. If it needs that origin (a sign-in provider), add `--allow-origin <origin>` and start again. |
| `blocked requests to origins outside this session's allowed list` | The page loaded something from another origin (a CDN, analytics, SSO). Add it with `--allow-origin` if the page needs it. |
| `peeps-bridge could not reach http://localhost:…` in a page | Nothing answered at `--target-url`. Is your dev server running, on that port? |
| `Lost contact with Peeps` | Eight requests in a row failed (network down, laptop asleep). Start a new session. |
| `Chromium's sandbox is not available on this machine` | Common on Linux where unprivileged user namespaces are restricted. The runner continues without it; the origin proxy and the tool allowlist still apply. |

## For integrators: the protocol module

`@peepsai/bridge/protocol` is the runner side of Peeps' agent bridge with no
browser in it: attach, long-poll for calls, post results, back off on
transport errors, and stop on 410, expiry, eight consecutive transport errors
or an abort signal. `peeps-action`'s CI agent is meant to use it too.

```ts
import { runBridgeSession } from "@peepsai/bridge/protocol";

const end = await runBridgeSession({
  server, sessionId,
  authorization: () => `Bearer ${token}`,
  tools, runnerInfo,
  handle: async (call) => ({ ok: true, result: await run(call) }),
  log: console.log,
  signal,
});
```

## Development

```sh
npm ci
npx -y playwright-core@$(node -p "require('playwright-core/package.json').version") install --only-shell chromium
npm run lint && npm run typecheck && npm test && npm run build
npm run test:coverage   # with thresholds
```

Tests use Node's own runner with `tsx`. The browser tests launch real
Chromium against small local servers.

## License

MIT
