import * as path from "node:path";
import which from "which";

// `which` stats every PATH entry, and the settings UI asks about the same commands on each refresh.
const ttlMs = 5000;
const cache = new Map<string, { path: string | null; at: number }>();

export function findExecutable(cmd: string, searchPath: string | undefined): string | null {
    const key = `${cmd}\0${searchPath ?? ""}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.path;
    const found = which.sync(cmd, { nothrow: true, path: searchPath ?? process.env.PATH }) ?? null;
    cache.set(key, { path: found, at: Date.now() });
    return found;
}

// After settings change or Reload all, a just-installed binary must be found immediately.
export function forgetExecutables(): void {
    cache.clear();
}

// "./node_modules/.bin/x" means relative to the project, not to the extension host's working directory.
export function isProjectRelative(cmd: string): boolean {
    return cmd.startsWith("./") || cmd.startsWith("../");
}

export function relativeTo(base: string, cmd: string): string {
    return isProjectRelative(cmd) ? path.resolve(base, cmd) : cmd;
}
