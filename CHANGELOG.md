# Changelog

## 0.1.0 (unreleased)

First release: the runner for Peeps local discovery (PQA-2314).

- `peeps-bridge` command: serves one Peeps bridge session's browser tools
  from this machine, with the grant read from `PEEPS_RUNNER_GRANT` only.
- Hosts `@playwright/mcp` 0.0.69 in-process (pinned and imported, never
  fetched), with a runner-owned headless Chromium: a fresh profile in a scratch directory,
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
- Review round 2: the threat model for sign-in secrets is stated (accidents
  and cheap routes, not a determined agent); fields are followed by element
  instead of ref; values seen once stay scrubbed; a dialog no longer stalls a
  call; clipboard keys, dragging out of a secret field and `fields[].selector`
  are refused; the run rule is limited to console, network, URL, title and
  field values; the network log is rendered by the runner; SIGHUP stops
  cleanly.
- Review round 3: a secret is tracked in any field it lands in; middle
  clicks and drags from around a secret field are refused; tab titles and
  URLs get the run rule; password fields with no secret hide only their own
  line; the Chromium profile lives in the scratch directory; file choosers
  are cancelled; broken upstream responses end the browser's; the watchdog
  tolerates sleep; cleanup survives a closed terminal.
- Review round 4: lines nested under a secret field are hidden; only snapshot
  files written during the call are inlined; a forced exit or the watchdog
  kills Chromium before removing the scratch directory, from the moment it
  exists; JSON escapes are generated per UTF-16 code unit; unidentified
  fields are hidden; patched internals are checked at startup.
- Review round 5: snapshot lines are parsed in both of Playwright's key
  forms (plain and YAML-quoted); an unnamed leaf contenteditable is found by
  its own line; values with a lone surrogate no longer break scrubbing; the
  ensure_ascii JSON form is scrubbed; each browser call has a 90 s deadline
  after which the browser is closed and the session ended; a failed kill of
  Chromium is reported; the dialog note has its own heading.
- `@peepsai/bridge/protocol`: the bridge protocol loop with no browser
  dependency, for `peeps-action` to share.
