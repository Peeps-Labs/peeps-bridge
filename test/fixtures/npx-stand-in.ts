// Stands in for npx in exit-with-parent.test.ts. `npm` mode starts the runner
// as npm exec does on Linux: through `sh -c`, with npm's environment,
// forwarding SIGTERM to the shell only (which dies without passing it on).
// The command ends in `; exit $?` so that no shell can exec it (bash, macOS'
// and Fedora's /bin/sh, would): the shell stays between them, as dash's does,
// and outlives a killed npx. `direct` mode starts the runner as its own child.
// `npm-exec` starts it as npm does where /bin/sh execs the command (macOS,
// Fedora): the runner is npx's own child, with npm's environment, and gets
// both the terminal's signal and npm's forwarded copy. `npm-dies-at-once`
// kills itself 50 ms after starting the runner, before the runner has loaded.
import { spawn } from "node:child_process";

const [mode, ...args] = process.argv.slice(2);
const runner = [process.execPath, "--import", "tsx", "src/bin.ts", ...args];
const npmEnv = { ...process.env, npm_command: "exec", npm_lifecycle_event: "npx", npm_lifecycle_script: '"peeps-bridge"' };
const child =
  mode === "direct" || mode === "npm-exec"
    ? spawn(runner[0]!, runner.slice(1), { stdio: "inherit", ...(mode === "npm-exec" ? { env: npmEnv } : {}) })
    : spawn(`${runner.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}; exit $?`, { shell: "/bin/sh", stdio: "inherit", env: npmEnv });
// As npm does (@npmcli/run-script's signal manager): pass both on.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}
child.on("exit", (code) => process.exit(code ?? 1));
if (mode === "npm-dies-at-once") setTimeout(() => process.kill(process.pid, "SIGKILL"), 50);
