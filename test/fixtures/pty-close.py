# Run a command on a real pty, wait for a marker in its output, then close
# the terminal (the kernel sends SIGHUP) and report how it exited.
# Usage: pty-close.py [--ctrl-c] <marker> <command...>; prints JSON on stdout.
# With --ctrl-c, presses Ctrl-C twice at the marker instead of closing.
import json, os, pty, select, sys, time

args = sys.argv[1:]
ctrl_c = args[0] == "--ctrl-c"
if ctrl_c:
    args = args[1:]
marker = args[0].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(args[1], args[1:])
out = b""
deadline = time.time() + 40
while time.time() < deadline and marker not in out:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            out += os.read(fd, 4096)
        except OSError:
            break
started = time.time()
if ctrl_c:
    os.write(fd, b"\x03")
    time.sleep(0.05)
    os.write(fd, b"\x03")
    # Keep draining so the child never blocks on a full terminal.
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                out += os.read(fd, 4096)
            except OSError:
                pass
else:
    time.sleep(1.0)
    started = time.time()
    os.close(fd)
    _, status = os.waitpid(pid, 0)
print(json.dumps({"seen": marker in out, "seconds": time.time() - started, "exitcode": os.waitstatus_to_exitcode(status), "output": out.decode(errors="replace")[-2000:]}))
