// Runs beside the extension host; stdin EOF means the host is gone, however it died.
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";

const groups = new Set<number>();

readline
	.createInterface({ input: process.stdin })
	.on("line", (line) => {
		const pid = Number(line.slice(1));
		if (!Number.isInteger(pid) || pid <= 0) return;
		if (line[0] === "+") groups.add(pid);
		else groups.delete(pid);
	})
	.on("close", killAll);

// Ctrl-C/hangup of a terminal-launched editor must not take the watchdog down before the servers.
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
process.on("SIGTERM", killAll);

function killAll(): void {
	if (process.platform === "win32") {
		for (const pid of groups)
			spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
				stdio: "ignore",
			});
		process.exit(0);
	}
	signalAll("SIGTERM");
	setTimeout(() => {
		signalAll("SIGKILL");
		process.exit(0);
	}, 1000);
}

function signalAll(signal: NodeJS.Signals): void {
	for (const pid of groups) {
		try {
			process.kill(-pid, signal);
		} catch {}
	}
}
