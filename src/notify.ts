import * as vscode from "vscode";
import * as logs from "./logs";
import type { NoticeInfo as Notice } from "./ui/protocol";

type NoticeLevel = Notice["level"];

const limit = 100;
// The same problem repeating (format on save, a crash loop) pops up once per this long, not on every occurrence.
const quietMs = 5 * 60_000;
const notices: Notice[] = [];
const toastedAt = new Map<string, number>();
const changed = new vscode.EventEmitter<void>();
// Separate so marking notices seen updates the status bar without rebuilding the whole settings UI.
const seenChanged = new vscode.EventEmitter<void>();
let seq = 0;
let unseen = 0;
let unseenLevel: NoticeLevel | undefined;

export const onDidChange = changed.event;
export const onDidChangeSeen = seenChanged.event;

export function list(): Notice[] {
	return notices;
}

export function unseenCount(): number {
	return unseen;
}

// The worst level among unseen notices, for the badge colour.
export function unseenSeverity(): NoticeLevel | undefined {
	return unseenLevel;
}

export function markSeen(): void {
	if (unseen === 0) return;
	unseen = 0;
	unseenLevel = undefined;
	seenChanged.fire();
}

export function clear(): void {
	notices.length = 0;
	unseen = 0;
	unseenLevel = undefined;
	changed.fire();
}

// After settings change, a problem that is still there deserves a fresh pop-up.
export function forgetToasts(): void {
	toastedAt.clear();
}

export function log(): vscode.LogOutputChannel {
	return logs.channel("general-lsp", "General LSP");
}

export function report(
	level: NoticeLevel,
	source: string,
	message: string,
	options: { key?: string; toast?: boolean } = {},
): void {
	const last = notices[0];
	if (
		last &&
		last.level === level &&
		last.source === source &&
		last.message === message
	) {
		last.count++;
		last.time = Date.now();
	} else {
		notices.unshift({
			seq: seq++,
			time: Date.now(),
			level,
			source,
			message,
			count: 1,
		});
		notices.length = Math.min(notices.length, limit);
	}
	unseen++;
	if (unseenLevel !== "error") unseenLevel = level;
	log()[level === "error" ? "error" : "warn"](`[${source}] ${message}`);
	changed.fire();
	if (options.toast !== false)
		toast(
			level,
			source,
			message,
			options.key ?? `${level}:${source}:${message}`,
		);
}

export function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function error(source: string, err: unknown, context: string): void {
	report("error", source, `${context}: ${errorText(err)}`);
	if (err instanceof Error && err.stack) log().error(err.stack);
}

function toast(
	level: NoticeLevel,
	source: string,
	message: string,
	key: string,
): void {
	const now = Date.now();
	if (now - (toastedAt.get(key) ?? 0) < quietMs) return;
	// Keys can embed file names, so drop expired ones rather than keep every message of a long session.
	for (const [k, at] of toastedAt) if (now - at >= quietMs) toastedAt.delete(k);
	toastedAt.set(key, now);
	const show =
		level === "error"
			? vscode.window.showErrorMessage
			: vscode.window.showWarningMessage;
	void show(
		`General LSP · ${source}: ${message}`,
		"Show problems",
		"Show log",
	).then((choice) => {
		if (choice === "Show problems")
			void vscode.commands.executeCommand(
				"generalLsp.openSettings",
				"problems",
			);
		else if (choice === "Show log") log().show();
	});
}

export function dispose(): void {
	changed.dispose();
	seenChanged.dispose();
}
