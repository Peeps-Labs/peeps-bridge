# Run a command on a real pty, wait for a marker in its output, then close
# the terminal (the kernel sends SIGHUP) and report how it exited.
# Usage: pty-close.py <marker> <command...>; prints JSON on stdout.
import json, os, pty, select, sys, time

marker = sys.argv[1].encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out = b""
deadline = time.time() + 40
while time.time() < deadline and marker not in out:
    r, _, _ = select.select([fd], [], [], 0.5)
    if r:
        try:
            out += os.read(fd, 4096)
        except OSError:
            break
time.sleep(1.0)
started = time.time()
os.close(fd)
_, status = os.waitpid(pid, 0)
print(json.dumps({"seen": marker in out, "seconds": time.time() - started, "exitcode": os.waitstatus_to_exitcode(status), "output": out.decode(errors="replace")[-2000:]}))
