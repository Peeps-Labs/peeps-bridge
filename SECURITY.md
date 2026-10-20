# Security

This runner drives a browser on your machine, inside your network, on behalf
of an agent that runs on Peeps. This document says plainly what it sends to
Peeps and what Peeps can make it do, so that you can decide whether that trade
is one you want.

If you are reviewing this before running it, the two sections that matter are
"What leaves your machine" and "What Peeps can do on your machine".

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository, under
the Security tab. Do not open a public issue for a security problem.

## Authentication

The runner authenticates with a **grant** that Peeps' `start_local_discovery`
returns once, for one session. It is signed by Peeps over that session, the
project, the person who started it and the MCP client they used, and it
expires when the session does (at most 45 minutes).

Consequences worth knowing:

- The grant is read from the `PEEPS_RUNNER_GRANT` environment variable only.
  The runner refuses one on the command line, where any process on the
  machine could read it. It is never written to disk or printed.
- Every request carries it in an `Authorization` header, never in a URL.
- Peeps re-checks, on every request, that the session is live and that the
  person may still run it: a member of the project's organization with the
  Contributor role or above, an enabled MCP connection whose consent covers
  local runs, and the feature turned on. Revoking the MCP connection, a role
  change, or Peeps ending the session stops the runner within one poll
  (at most about 25 seconds).
- Each runner process names itself with a random id. Peeps serves a session's
  calls to the first process that attaches and refuses any other, so a second
  copy of the command, or a restarted one, cannot take over the session. A
  restarted runner exits and tells you to start a new session.
- Every connection is outbound. The runner listens on no port reachable from
  outside your machine; its one listener is the origin proxy below, bound to
  `127.0.0.1` for the browser it launched.

## What leaves your machine

| Sent to Peeps | When |
| --- | --- |
| The text of pages the browser visits (accessibility snapshots, page titles and URLs) | After every browser action |
| Console messages and network request summaries (URLs, methods, statuses; request bodies and headers only when the agent asks for them). Requests to other origins are left out, and `authorization`, `proxy-authorization`, `cookie` and `set-cookie` values are replaced | When the agent asks for them |
| Error messages from the browser | When an action fails |
| The runner's version, the `@playwright/mcp` and `playwright-core` versions it loaded, Node's version, OS and CPU architecture | When it attaches |
| A list of origins the runner blocked during an action | When it blocked one |

Two of those deserve emphasis.

**Page text goes to Peeps and to the model provider Peeps uses.** That is the
point: the agent reads pages to propose tests. When you point the runner at
work you have not released, that is unreleased page text. Peeps keeps a local
session's call results for 7 days, then clears them.

**Request bodies can contain what your pages send.** If the agent asks for
network requests with bodies, form posts are included. The runner removes the
values of the sign-in secrets you named (below), but not other data your app
puts in a request.

**Not sent:** screenshots or any other image (the screenshot tool is refused
and image responses are turned off), files from your machine, your source
code, and environment variables other than the sign-in secrets you name. A
sign-in secret is kept out of what is sent by accident, but an agent set on
reading it can (see "Sign-in secrets").

## What Peeps can do on your machine

Only for the duration of one session, and only through a browser.

- **Fifteen browser tools.** Navigate, go back, read the page, click, type,
  fill a form, press a key, select an option, hover, drag, wait, answer a
  dialog, manage tabs, read console messages, read network requests. The
  runner checks every call against its own copy of these tools' schemas,
  independently of Peeps, so a compromised or mistaken server cannot widen
  them.
- **Refused, whatever Peeps asks:** running code (`browser_run_code`, which
  would run in the runner's own Node process, and `browser_evaluate`),
  uploading files (`browser_file_upload`, which reads local files),
  screenshots, installing browsers, closing the browser, resizing it, any
  argument the tools do not declare (including `filename`, which would write
  output into your working directory, `_meta`, and the network log's `filter`,
  which Playwright compiles as a regular expression in the runner's own
  thread, where a pathological one would freeze it), and navigation to
  anything but an `http:` or `https:` URL.
- **No shell and no file access.** Playwright MCP writes its snapshots to a
  scratch directory under your OS temp directory, which the runner deletes when
  it exits. Nothing is written to your checkout.
- **An isolated browser.** A fresh, in-memory Chromium profile: none of your
  own browser's cookies, logins or extensions. Service workers are blocked
  (Playwright's own block is extended to the `ServiceWorkerContainer`
  prototype, which a page could otherwise use to get around it), as are
  downloads. Chromium runs inside its own sandbox where the OS allows it; on
  Linux systems that restrict unprivileged user namespaces it cannot, and the
  runner says so when it starts.

### The origin policy

The browser may reach the origin of `--target-url` (scheme, host and port
exactly) and the origins you add with `--allow-origin`. Nothing else. The
runner prints the list when it starts (`the browser may reach: …`): read it
before letting the session run. Without
this, the agent, or a page it visits, could steer a browser that sits inside
your network to other local services, intranet hosts or cloud metadata
endpoints and read them back as page text.

It is enforced in three layers:

1. **An allowlisting forward proxy inside the runner** is the authoritative
   check. Chromium is launched with every request going through it, loopback
   included (`--proxy-bypass-list=<-loopback>`), so redirects, images,
   scripts, `fetch` calls, WebSockets and anything a page starts on its own
   are checked. Plain HTTP requests to another origin get a 403 page; HTTPS
   and WebSocket tunnels (`CONNECT`) open only to an allowed host and port.
   TLS is not intercepted.
2. **Request interception in the browser context** refuses other origins
   before they leave the browser and names them in the tool result, so the
   agent learns why.
3. **The runner checks `browser_navigate`** against the policy before the
   browser moves.
4. **WebRTC sends nothing around the proxy.** Chromium runs with
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, so a page
   cannot reach a host directly over UDP (STUN, ICE); a test proves no packet
   reaches a disallowed UDP listener.

The tests prove the proxy with real Chromium: a redirect to a disallowed
origin, a disallowed image and `fetch`, a disallowed WebSocket and a redirect
to a disallowed HTTPS origin never open a connection to that origin, while an
allowed redirect, subresource and WebSocket work.

Limits worth knowing: the policy compares host names, not addresses, so an
allowed host name whose DNS you do not control could be re-pointed by whoever
does. `localhost` and `127.0.0.1` are different origins; allow the one your app
uses.

### Sign-in secrets

**The threat model, in one line:** the runner protects a sign-in secret
against accidental disclosure and closes every cheap deliberate route to it.
It does not stop a determined, hostile agent from reading it. Use a test
account, never real credentials.

`--sign-in-secret NAME=ENV_VAR` reads `ENV_VAR` from your shell and gives the
value to Playwright MCP in memory. The agent types `NAME`; Playwright fills in
the value. The agent is not given the value, and it is not in the call
arguments Peeps stores.

The value is in the page, though, and pages show what is typed into them.
Playwright replaces an exact match with `<secret>NAME</secret>` by plain
string replacement, which its own documentation calls "a convenience and not
a security feature". On every result before it is posted, and every line it
prints, the runner also removes:

- the value in plain, URL-encoded, form-encoded, JSON-escaped (`\uXXXX` and
  `\/` too), HTML-escaped and HTML numeric-entity forms, everywhere;
- any run of 6 or more consecutive characters of the value (half the value
  for one shorter than 12, never under 3) in console output, the network log,
  printed lines, the Page URL and title, and the values of form fields. Not
  in other page text, where it would hide ordinary words (a secret containing
  `password` would hide the word "password");
- the contents of every field the value was typed into, and of every password
  field (`input[type=password]`) on every page and frame, and every value
  those fields have held during the session: hidden on the field's snapshot
  line whatever their length, and removed from the whole result when 4 or more
  characters long. Fields are followed by element, not by Playwright's `ref`,
  which restarts with every page;
- a `<secret>…</secret>` marker gets no exemption unless it names a
  configured secret.

The runner also refuses copy, cut and paste keys (in every spelling), dragging
out of a secret or password field, choosing a form field by CSS selector
instead of `ref` (which would escape the tracking), and typing a secret one
character at a time (it is filled at once, so a page sees no prefixes).

**What this does not cover.** An agent can edit a field key by key, for
example inserting a character between each of the secret's, so that no run of
6 is left and the field's contents are no longer what was typed; each
snapshot then shows the secret a piece at a time. A page that transforms the
value (hashes it, upper-cases it, reverses it, splits it across elements)
can reveal it in that form. And `browser_wait_for` with a `text` answers yes
or no to "is this text on the page", which an agent can use to test guesses
about any page text. None of these happens by accident; all of them are
available to an agent that sets out to read the value.

## What you see

The runner prints one line per action ("click 'Place order' on /checkout",
"type secret SHOP_PASSWORD into 'Password'"), so you can watch everything
Peeps drives. Control characters are stripped from everything it prints,
because much of it comes from Peeps or from pages, and a terminal obeys escape
sequences (OSC 52 writes your clipboard).

Ctrl-C lets the action in hand finish, for at most 10 seconds, then closes the
browser; a second Ctrl-C closes it at once. If the runner's event loop were
ever blocked so that no handler could run, a watchdog thread removes the
scratch directory and kills the process after 30 seconds.

The runner never follows an HTTP redirect from Peeps: a redirect would re-send
the grant to wherever it pointed.

## Supply chain

- Run it as the exact, versioned command `start_local_discovery` returns
  (`npx -y @peepsai/bridge@<version>`), never `@latest`. Peeps refuses a runner
  whose `@playwright/mcp` is not the version its tool schemas mirror.
- `@playwright/mcp` and `playwright-core` are exact-pinned dependencies,
  imported from the package, never fetched with `npx` at run time.
- The runner does not download a browser. If Chromium is missing it prints
  the exact install command and stops.
- The published package contains only `dist/`, compiled from `src/` by
  `npm run build`, and the documentation files.
