# Changelog

## 0.1.0 (unreleased)

First release: the runner for Peeps local discovery (PQA-2314).

- `peeps-bridge` command: serves one Peeps bridge session's browser tools
  from this machine, with the grant read from `PEEPS_RUNNER_GRANT` only.
- Hosts `@playwright/mcp` 0.0.69 in-process (pinned and imported, never
  fetched), with a runner-owned headless Chromium: in-memory profile,
  1366x768, 15 s navigation and 10 s action timeouts, no image responses,
  service workers and downloads blocked, Chromium's sandbox where the OS
  allows it, and a scratch working directory removed on exit.
- Fifteen allowed browser tools, checked against their schemas on the runner;
  any other tool, `filename`, and any undeclared argument are refused.
- Origin policy enforced by an allowlisting forward proxy inside the runner
  (loopback included), with `context.route` as the first check.
- Results: the action's snapshot inlined, local file links dropped, blocked
  origins named, secret values scrubbed in every common encoding, capped at
  200 KB.
- Review round 1: secret and password fields are hidden and their contents
  scrubbed, runs of a secret's characters are redacted, WebRTC sends no UDP
  around the proxy, page downloads are refused without crashing, the network
  log keeps allowed origins only and drops credential headers, `filter` is
  refused, output is stripped of terminal control characters, redirects from
  Peeps are never followed, and Ctrl-C has a deadline and a watchdog.
- `@peepsai/bridge/protocol`: the bridge protocol loop with no browser
  dependency, for `peeps-action` to share.
