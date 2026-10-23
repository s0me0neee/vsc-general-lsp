import * as fs from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import type { RootMarker } from "./config";

// Marker groups are tried in priority order; within a group the nearest ancestor wins.
export function findRoot(
	file: string,
	markers: RootMarker[],
): string | undefined {
	for (const group of markers) {
		const matches = markerMatcher(Array.isArray(group) ? group : [group]);
		for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
			if (matches(dir)) return dir;
			if (path.dirname(dir) === dir) break;
		}
	}
	return undefined;
}

// Nearest virtualenv at or above the root, like the one an activated shell would have; uv workspaces keep it at the top.
export function findVenv(root: string, names: string[]): string | undefined {
	for (let dir = root; ; dir = path.dirname(dir)) {
		for (const name of names) {
			if (fs.existsSync(path.join(dir, name, "pyvenv.cfg")))
				return path.join(dir, name);
		}
		if (path.dirname(dir) === dir) return undefined;
	}
}

export function isInside(file: string, root: string): boolean {
	const rel = path.relative(root, file);
	return (
		rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
	);
}

function markerMatcher(names: string[]): (dir: string) => boolean {
	const literals = names.filter((n) => !picomatch.scan(n).isGlob);
	const globs = names.filter((n) => picomatch.scan(n).isGlob);
	const isMatch =
		globs.length > 0 ? picomatch(globs, { dot: true }) : undefined;
	return (dir) => {
		if (literals.some((n) => fs.existsSync(path.join(dir, n)))) return true;
		if (!isMatch) return false;
		try {
			return fs.readdirSync(dir).some((entry) => isMatch(entry));
		} catch {
			return false;
		}
	};
}
