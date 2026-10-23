import * as vscode from "vscode";
import type { Kind, Raw, Scope } from "./protocol";

type Entries = [string, Raw][];

const settingKeys: Record<Kind, string> = {
	server: "servers",
	formatter: "formatters",
};

function config(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration("generalLsp");
}

function target(scope: Scope): vscode.ConfigurationTarget {
	return scope === "workspace"
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
}

function scopeValues(kind: Kind): {
	user: Record<string, Raw>;
	workspace: Record<string, Raw>;
} {
	const inspected = config().inspect<Record<string, Raw>>(settingKeys[kind]);
	return {
		user: inspected?.globalValue ?? {},
		workspace: inspected?.workspaceValue ?? {},
	};
}

// The workspace definition wins over the user one, so that is where edits must land.
export function scopeOf(kind: Kind, name: string): Scope | undefined {
	const values = scopeValues(kind);
	if (name in values.workspace) return "workspace";
	if (name in values.user) return "user";
	return undefined;
}

// Rewrites one scope's object; entry order is kept because it decides formatter chains and server priority.
async function update(
	kind: Kind,
	scope: Scope,
	edit: (entries: Entries) => Entries,
): Promise<void> {
	const current = Object.entries(scopeValues(kind)[scope]);
	const next = edit(current);
	// VS Code drops writes equal to the current value, ignoring key order, so a pure reorder needs a real change first.
	if (
		unordered(current) === unordered(next) &&
		current.some(([name], i) => name !== next[i][0])
	) {
		const marked = next.map(([name, raw], i): [string, Raw] => [
			name,
			i === 0 ? { ...raw, [reorderMarker]: true } : raw,
		]);
		await config().update(
			settingKeys[kind],
			Object.fromEntries(marked),
			target(scope),
		);
	}
	await config().update(
		settingKeys[kind],
		Object.fromEntries(next),
		target(scope),
	);
}

// Unknown keys are ignored when settings are read, so this transient one restarts nothing.
const reorderMarker = "__reordering";

function unordered(entries: Entries): string {
	return JSON.stringify(
		entries
			.map(([n, r]) => [n, sortKeys(r)])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
	);
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => [k, sortKeys(v)]),
	);
}

export async function saveEntry(
	kind: Kind,
	scope: Scope,
	name: string,
	raw: Raw,
	previousName?: string,
): Promise<void> {
	const existing = scopeOf(kind, name);
	if (name !== previousName && existing)
		throw new Error(`A ${kind} named '${name}' already exists.`);
	await update(kind, scope, (entries) => {
		const at = entries.findIndex(([n]) => n === (previousName ?? name));
		if (at < 0) return [...entries, [name, raw]];
		return entries.map((e, i) => (i === at ? [name, raw] : e));
	});
}

export async function deleteEntry(kind: Kind, name: string): Promise<void> {
	const scope = scopeOf(kind, name);
	if (scope)
		await update(kind, scope, (entries) => entries.filter(([n]) => n !== name));
}

export async function moveEntry(
	kind: Kind,
	name: string,
	delta: -1 | 1,
): Promise<void> {
	const scope = scopeOf(kind, name);
	if (!scope) return;
	await update(kind, scope, (entries) => {
		const from = entries.findIndex(([n]) => n === name);
		const to = from + delta;
		if (from < 0 || to < 0 || to >= entries.length) return entries;
		const next = [...entries];
		[next[from], next[to]] = [next[to], next[from]];
		return next;
	});
}

// Enabling drops the key rather than writing `true`, keeping settings.json as the user wrote it.
export async function setEnabled(
	kind: Kind,
	name: string,
	enabled: boolean,
): Promise<void> {
	const scope = scopeOf(kind, name);
	if (!scope) return;
	await update(kind, scope, (entries) =>
		entries.map(([n, raw]) => {
			if (n !== name) return [n, raw];
			const { enabled: _, ...rest } = raw;
			return [n, enabled ? rest : { ...rest, enabled: false }];
		}),
	);
}

export async function saveExtraPaths(paths: string[]): Promise<void> {
	const inspected = config().inspect<string[]>("extraPaths");
	const scope: Scope =
		inspected?.workspaceValue !== undefined ? "workspace" : "user";
	await config().update("extraPaths", paths, target(scope));
}

export function entries(
	kind: Kind,
): { name: string; scope: Scope; raw: Raw }[] {
	const values = scopeValues(kind);
	// Same precedence as VS Code's merge: a workspace entry replaces the user entry of that name.
	const merged = new Map<string, { scope: Scope; raw: Raw }>();
	for (const [name, raw] of Object.entries(values.user))
		merged.set(name, { scope: "user", raw });
	for (const [name, raw] of Object.entries(values.workspace))
		merged.set(name, { scope: "workspace", raw });
	return [...merged].map(([name, v]) => ({ name, ...v }));
}
