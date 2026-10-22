import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

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
}

type RawServer = Partial<Omit<ServerConfig, "name" | "order" | "venv">> & { enabled?: boolean; venv?: boolean | string[] };

const defaultVenvNames = [".venv", "venv", "env"];

function venvNames(venv: boolean | string[] | undefined): string[] | undefined {
    if (venv === true) return defaultVenvNames;
    return Array.isArray(venv) && venv.length > 0 ? venv : undefined;
}
type RawFormatter = Partial<Omit<FormatterConfig, "name">> & { enabled?: boolean };

export function readServers(): Map<string, ServerConfig> {
    const servers = new Map<string, ServerConfig>();
    for (const [name, s] of enabledEntries<RawServer>("servers")) {
        servers.set(name, {
            name,
            command: s.command!.map(expandHome),
            languages: s.languages ?? [],
            filePatterns: normalizePatterns(s.filePatterns),
            rootMarkers: s.rootMarkers ?? [],
            singleFileSupport: s.singleFileSupport ?? true,
            fallbackRoot: s.fallbackRoot ? expandHome(s.fallbackRoot) : undefined,
            settings: expandDottedKeys(s.settings ?? {}) as Record<string, unknown>,
            initializationOptions: s.initializationOptions,
            env: withExtraPaths(s.env),
            disabledCapabilities: s.disabledCapabilities ?? [],
            format: s.format ?? "fallback",
            multiRoot: s.multiRoot ?? true,
            venv: venvNames(s.venv),
            order: servers.size,
        });
    }
    return servers;
}

// Settings order is the chain order when several formatters match one file.
export function readFormatters(): FormatterConfig[] {
    return enabledEntries<RawFormatter>("formatters").map(([name, f]) => ({
        name,
        command: f.command!.map(expandHome),
        languages: f.languages ?? [],
        filePatterns: normalizePatterns(f.filePatterns),
        rootMarkers: f.rootMarkers ?? [],
        requireRoot: f.requireRoot ?? false,
        stdin: f.stdin ?? true,
        exitCodes: f.exitCodes ?? [0],
        env: withExtraPaths(f.env),
    }));
}

function enabledEntries<T extends { enabled?: boolean; command?: string[] }>(key: string): [string, T][] {
    const raw = vscode.workspace.getConfiguration("generalLsp").get<Record<string, T>>(key, {});
    return Object.entries(raw).filter(([, v]) => v.enabled !== false && Array.isArray(v.command) && v.command.length > 0);
}

// A bare "*.zig" would only match against the full path, so anchor it anywhere.
export function normalizePatterns(patterns: string[] | undefined): string[] {
    return (patterns ?? []).map((p) => (p.includes("/") ? p : `**/${p}`));
}

// generalLsp.extraPaths is searched after PATH, like Mason's PATH = "append".
export function withExtraPaths(env: Record<string, string> | undefined): Record<string, string> {
    const out = Object.fromEntries(Object.entries(env ?? {}).map(([k, v]) => [k, expandHome(v)]));
    const extra = vscode.workspace.getConfiguration("generalLsp").get<string[]>("extraPaths", []).map(expandHome);
    if (extra.length > 0) out.PATH = [out.PATH ?? process.env.PATH ?? "", ...extra].join(path.delimiter);
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
    if (Array.isArray(value)) return value.map((v) => expandRootVars(v, root)) as T;
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandRootVars(v, root)])) as T;
    }
    return value;
}

// Position only affects formatting priority, which is read live, so reordering restarts nothing.
export function sameConfig(a: ServerConfig, b: ServerConfig): boolean {
    return JSON.stringify({ ...a, order: 0 }) === JSON.stringify({ ...b, order: 0 });
}

// Mirrors lspconfig: walk the dotted section path, falling back to a literal key.
export function lookupSection(settings: Record<string, unknown>, section: string | undefined): unknown {
    if (!section) return settings;
    let cur: unknown = settings;
    for (const key of section.split(".")) {
        if (cur === null || typeof cur !== "object" || !(key in cur)) return settings[section] ?? null;
        cur = (cur as Record<string, unknown>)[key];
    }
    return cur ?? null;
}

export function expandHome(arg: string): string {
    const expanded = arg.replaceAll("${userHome}", os.homedir());
    return expanded === "~" || expanded.startsWith("~/") ? os.homedir() + expanded.slice(1) : expanded;
}

// VS Code-style flat keys ("rust-analyzer.check.command") become nested objects, so both styles work.
function expandDottedKeys(value: unknown): unknown {
    if (!isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        const nested = key.split(".").reduceRight<unknown>((acc, part) => ({ [part]: acc }), expandDottedKeys(v));
        deepMerge(out, nested as Record<string, unknown>);
    }
    return out;
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>): Record<string, unknown> {
    for (const [k, v] of Object.entries(src)) {
        const cur = target[k];
        target[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
    }
    return target;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}
