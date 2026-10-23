import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { errorText } from "./notify";

export type RootMarker = string | string[];

export interface ServerConfig {
	name: string;
	command: string[];
	languages: string[];
	filePatterns: string[];
	rootMarkers: RootMarker[];
	singleFileSupport: boolean;
	fallbackRoot?: string;
	settings: Record<string, unknown>;
	initializationOptions: unknown;
	env: Record<string, string>;
	disabledCapabilities: string[];
	format: FormatMode;
	// New roots join a running client as workspace folders instead of spawning another process.
	multiRoot: boolean;
	// Virtualenv directory names to activate for each root, or undefined to launch as-is.
	venv?: string[];
	// Position in settings; the first server able to format a file is the one used.
	order: number;
}

// fallback: only when no CLI formatter matches; prefer: even when one does; never: not at all.
export type FormatMode = "fallback" | "prefer" | "never";

export interface FormatterConfig {
	name: string;
	command: string[];
	languages: string[];
	filePatterns: string[];
	rootMarkers: RootMarker[];
	requireRoot: boolean;
	stdin: boolean;
	exitCodes: number[];
	env: Record<string, string>;
	timeoutMs: number;
}

const defaultVenvNames = [".venv", "venv", "env"];
const formatModes: FormatMode[] = ["fallback", "prefer", "never"];

// Problems are collected rather than thrown, so one bad entry can't stop every other server.
export function readServers(
	problems: string[] = [],
): Map<string, ServerConfig> {
	const servers = parseEntries(
		"servers",
		problems,
		(name, field, s, order): ServerConfig => {
			const fallbackRoot = field.string("fallbackRoot");
			return {
				name,
				command: field.command(),
				languages: field.strings("languages"),
				filePatterns: normalizePatterns(field.strings("filePatterns")),
				rootMarkers: field.markers(),
				singleFileSupport: field.boolean("singleFileSupport") ?? true,
				fallbackRoot: fallbackRoot && expandHome(fallbackRoot),
				settings: expandDottedKeys(field.object("settings") ?? {}),
				initializationOptions: s.initializationOptions,
				env: withExtraPaths(field.env()),
				disabledCapabilities: field.strings("disabledCapabilities"),
				format: field.oneOf("format", formatModes) ?? "fallback",
				multiRoot: field.boolean("multiRoot") ?? true,
				venv: field.venv(),
				order,
			};
		},
	);
	return new Map(servers.map((s) => [s.name, s]));
}

// Settings order is the chain order when several formatters match one file.
export function readFormatters(problems: string[] = []): FormatterConfig[] {
	return parseEntries("formatters", problems, (name, field) => ({
		name,
		command: field.command(),
		languages: field.strings("languages"),
		filePatterns: normalizePatterns(field.strings("filePatterns")),
		rootMarkers: field.markers(),
		requireRoot: field.boolean("requireRoot") ?? false,
		stdin: field.boolean("stdin") ?? true,
		exitCodes: field.numbers("exitCodes") ?? [0],
		env: withExtraPaths(field.env()),
		timeoutMs: field.number("timeout") ?? 10_000,
	}));
}

// Builds each enabled entry; one with a malformed field is skipped and reported.
function parseEntries<T>(
	key: string,
	problems: string[],
	build: (
		name: string,
		field: ReturnType<typeof fields>,
		raw: Record<string, unknown>,
		index: number,
	) => T,
): T[] {
	const raw = vscode.workspace
		.getConfiguration("generalLsp")
		.get<Record<string, unknown>>(key, {});
	const built: T[] = [];
	for (const [name, value] of Object.entries(raw)) {
		if (!isPlainObject(value)) {
			problems.push(`${key}.${name}: expected an object, skipped`);
			continue;
		}
		if (value.enabled === false) continue;
		try {
			built.push(build(name, fields(name, value), value, built.length));
		} catch (err) {
			problems.push(`${key}.${name}: ${errorText(err)}, skipped`);
		}
	}
	return built;
}

function fields(where: string, raw: Record<string, unknown>) {
	const fail = (key: string, expected: string): never => {
		throw new Error(`'${key}' must be ${expected} (in ${where})`);
	};
	const strings = (key: string): string[] => {
		const v = raw[key];
		if (v === undefined) return [];
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
			return fail(key, "a list of strings");
		return v;
	};
	return {
		strings,
		command: () => {
			const command = strings("command");
			if (command.length === 0 || command[0] === "")
				return fail("command", "a non-empty list of strings");
			return command.map(expandHome);
		},
		markers: (): RootMarker[] => {
			const v = raw.rootMarkers;
			if (v === undefined) return [];
			const ok =
				Array.isArray(v) &&
				v.every(
					(m) =>
						typeof m === "string" ||
						(Array.isArray(m) && m.every((x) => typeof x === "string")),
				);
			return ok
				? (v as RootMarker[])
				: fail("rootMarkers", "a list of names or lists of names");
		},
		boolean: (key: string): boolean | undefined => {
			const v = raw[key];
			return v === undefined || typeof v === "boolean"
				? v
				: fail(key, "true or false");
		},
		string: (key: string): string | undefined => {
			const v = raw[key];
			return v === undefined || typeof v === "string"
				? v
				: fail(key, "a string");
		},
		number: (key: string): number | undefined => {
			const v = raw[key];
			return v === undefined || (typeof v === "number" && v > 0)
				? v
				: fail(key, "a positive number");
		},
		numbers: (key: string): number[] | undefined => {
			const v = raw[key];
			if (v === undefined) return undefined;
			return Array.isArray(v) && v.every(Number.isInteger)
				? v
				: fail(key, "a list of integers");
		},
		object: (key: string): Record<string, unknown> | undefined => {
			const v = raw[key];
			return v === undefined || isPlainObject(v) ? v : fail(key, "an object");
		},
		env: (): Record<string, string> | undefined => {
			const v = raw.env;
			if (v === undefined) return undefined;
			const ok =
				isPlainObject(v) &&
				Object.values(v).every((x) => typeof x === "string");
			return ok
				? (v as Record<string, string>)
				: fail("env", "an object of strings");
		},
		oneOf: <T extends string>(key: string, options: T[]): T | undefined => {
			const v = raw[key];
			return v === undefined || options.includes(v as T)
				? (v as T | undefined)
				: fail(key, options.join(", "));
		},
		venv: (): string[] | undefined => {
			const v = raw.venv;
			if (v === undefined || v === false) return undefined;
			if (v === true) return defaultVenvNames;
			const names = strings("venv");
			return names.length > 0 ? names : undefined;
		},
	};
}

// Globs match against absolute paths, so anything not already anchored can sit at any depth: "*.zig", "src/*.x".
export function normalizePatterns(patterns: string[] | undefined): string[] {
	return (patterns ?? []).map((p) =>
		p.startsWith("/") || p.startsWith("**/") || /^[A-Za-z]:/.test(p)
			? p
			: `**/${p}`,
	);
}

// generalLsp.extraPaths is searched after PATH, like Mason's PATH = "append".
export function withExtraPaths(
	env: Record<string, string> | undefined,
): Record<string, string> {
	const out = Object.fromEntries(
		Object.entries(env ?? {}).map(([k, v]) => [k, expandHome(v)]),
	);
	const extra = vscode.workspace
		.getConfiguration("generalLsp")
		.get<string[]>("extraPaths", [])
		.map(expandHome);
	if (extra.length > 0)
		out.PATH = [out.PATH ?? process.env.PATH ?? "", ...extra].join(
			path.delimiter,
		);
	return out;
}

// Fills ${root}, ${rootName} and ${rootUri}, known only once a file picks the server's root.
export function expandRootVars<T>(value: T, root: string): T {
	if (typeof value === "string") {
		return value
			.replaceAll("${rootUri}", vscode.Uri.file(root).toString())
			.replaceAll("${rootName}", path.basename(root))
			.replaceAll("${root}", root) as T;
	}
	if (Array.isArray(value))
		return value.map((v) => expandRootVars(v, root)) as T;
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, expandRootVars(v, root)]),
		) as T;
	}
	return value;
}

// Position only affects formatting priority, which is read live, so reordering restarts nothing.
export function sameConfig(a: ServerConfig, b: ServerConfig): boolean {
	return (
		JSON.stringify({ ...a, order: 0 }) === JSON.stringify({ ...b, order: 0 })
	);
}

// Mirrors lspconfig: walk the dotted section path, falling back to a literal key.
export function lookupSection(
	settings: Record<string, unknown>,
	section: string | undefined,
): unknown {
	if (!section) return settings;
	let cur: unknown = settings;
	for (const key of section.split(".")) {
		if (cur === null || typeof cur !== "object" || !(key in cur))
			return settings[section] ?? null;
		cur = (cur as Record<string, unknown>)[key];
	}
	return cur ?? null;
}

export function expandHome(arg: string): string {
	const expanded = arg.replaceAll("${userHome}", os.homedir());
	return expanded === "~" || expanded.startsWith("~/")
		? os.homedir() + expanded.slice(1)
		: expanded;
}

// VS Code-style flat keys ("rust-analyzer.check.command") become nested objects, so both styles work.
// Only top-level keys are section paths; deeper keys like yaml.schemas URLs or globs keep their dots.
function expandDottedKeys(
	value: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(value)) {
		// A copy, because merging writes into it and VS Code's configuration values are read-only proxies.
		const nested = key
			.split(".")
			.reduceRight<unknown>((acc, part) => ({ [part]: acc }), plainCopy(v));
		deepMerge(out, nested as Record<string, unknown>);
	}
	return out;
}

// structuredClone and JSON.stringify both choke on VS Code's configuration proxies; enumerating them works.
function plainCopy(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(plainCopy);
	if (isPlainObject(value))
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [k, plainCopy(v)]),
		);
	return value;
}

function deepMerge(
	target: Record<string, unknown>,
	src: Record<string, unknown>,
): Record<string, unknown> {
	for (const [k, v] of Object.entries(src)) {
		const cur = target[k];
		target[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
	}
	return target;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
