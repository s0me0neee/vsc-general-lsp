import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

const isWindows = process.platform === "win32";
let watchdog: ChildProcess | undefined;

export function startWatchdog(): void {
  watchdog = spawn(process.execPath, [path.join(__dirname, "watchdog.js")], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "ignore", "ignore"],
    // Own session so signals aimed at the editor's process group don't reach it.
    detached: !isWindows,
    windowsHide: true,
  });
  watchdog.stdin?.on("error", () => {});
  watchdog.unref();
}

// Each server leads its own process group so its whole tree can be signalled, even orphaned children.
export function spawnServer(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn(command, args, { cwd, env, detached: !isWindows, windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", () => {
      const pid = child.pid!;
      watchdog?.stdin?.write(`+${pid}\n`);
      child.on("exit", () => reap(pid));
      resolve(child);
    });
  });
}

// Terminates whatever is left of a server's tree; the watchdog keeps tracking it until that succeeds.
export function reap(pid: number | undefined): void {
  if (pid === undefined) return;
  if (isWindows) {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    watchdog?.stdin?.write(`-${pid}\n`);
    return;
  }
  if (!signalGroup(pid, "SIGTERM")) return untrack(pid);
  setTimeout(() => {
    signalGroup(pid, "SIGKILL");
    untrack(pid);
  }, 1000).unref();
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function untrack(pid: number): void {
  watchdog?.stdin?.write(`-${pid}\n`);
}
