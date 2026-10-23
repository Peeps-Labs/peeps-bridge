# Changelog

## 0.1.2 (2026-10-23)

- The runner stops when the process that started it exits (PQA-2551). A
  coding agent that ended its background job by killing the npx process
  left the runner polling with a live browser: npm forwards SIGINT and
  SIGTERM to the command it runs, but on Linux that is its `sh -c` (dash),
  which swallows them and outlives npx, and a SIGKILL of npx reaches
  nobody. The runner now checks about once a second (on an unref'd
  timer) whether its parent is still the one it started with, and, when npm
  started it through a `sh -c` that does not exec it (dash, Linux's usual
  `/bin/sh`, which outlives a killed npx), whether that shell's parent is
  still npx. When one has gone, it prints `the process that started the
  runner exited; stopping` and stops as on SIGTERM: the call in hand is
  answered, the one best-effort detach is sent (0.1.1's rules), the browser
  closes and the runner exits. A stop already under way is left alone. A
  runner started directly from a shell stops when that shell exits; nothing
  above npx is watched, so npx outliving the shell that ran it leaves the
  runner going. Windows does not re-parent processes, so there the watch
  never fires. No opt-out flag.
- The parents are recorded before the runner loads anything heavy (it
  imports the rest afterwards), so a launcher that dies while a cold npx is
  still loading it is caught too; and a runner that, started by npx, finds
  itself already under init or a subreaper (`systemd`, `launchd`, `tini` …)
  exits before attaching. A direct start is never judged that way, since a
  runner daemonised on purpose looks the same.
- A failure to read `/proc` other than the process being gone (EMFILE, EIO,
  EACCES) skips that check instead of stopping a healthy runner.
- Only a second signal more than 500 ms after the first forces a stop. Where
  /bin/sh execs the command (macOS, Fedora) the runner is npx's own child,
  and one terminal Ctrl-C reaches it twice, from the terminal and forwarded
  by npm; that, or the parent watch beginning the stop as the same Ctrl-C
  arrives, is one orderly stop, not a forced one.
- npx launch is recognised by npm's script being `peeps-bridge`
  (`npm_lifecycle_script`), not by npm's variables alone, which a harness
  that npx started passes on to anything it starts.
- A stop that begins while the runner is still loading exits before the
  Chromium check or any browser is started.

## 0.1.1 (2026-10-22)

- Stopping the runner ends the session at Peeps at once (PQA-2427). On
  Ctrl-C, SIGTERM or SIGHUP (or when a stuck browser call makes the runner
  stop), after the call in hand is answered and before the browser closes,
  the runner sends one `POST /api/v1/bridge/sessions/<id>/detach` with its
  grant and `x-peeps-runner-instance`, following no redirect, with at most 3
  seconds for the whole of it (the grant lookup included). A forced stop (the
  10-second deadline, or a second Ctrl-C) sends it alongside closing the
  browser, with the call possibly still in hand, and exits after at most 3
  seconds either way. It is sent at most once per session, and never after
  the runner itself left for a 410, an expiry or lost contact. Whatever Peeps
  answers (a refusal, a network error, a timeout) is one log line and the
  runner exits anyway. It is best effort: when a detach does not arrive,
  Peeps presumes the runner gone after 3 minutes of silence, as before.
- `@peepsai/bridge/protocol`: `runBridgeSession` takes `detachOnStop` (off by
  default; Peeps refuses a detach from CI), `exposeDetach` (the same
  once-only detach, for a forced exit) and a `detachTimeoutMs` seam.

## 0.1.0 (2026-10-21)

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
