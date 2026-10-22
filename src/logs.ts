import * as vscode from "vscode";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "output";

export interface LogLine {
    time: number;
    level: LogLevel;
    text: string;
}

const limit = 5000;
const buffers = new Map<string, LogLine[]>();
// stderr arrives in arbitrary chunks; hold the unfinished last line until its newline shows up.
const partial = new Map<string, string>();
const appended = new vscode.EventEmitter<{ name: string; lines: LogLine[] }>();

export const onDidAppend = appended.event;

export function lines(name: string): LogLine[] {
    return buffers.get(name) ?? [];
}

export function clear(name: string): void {
    buffers.delete(name);
    partial.delete(name);
}

function record(name: string, level: LogLevel, text: string): void {
    const now = Date.now();
    const added = text.split(/\r?\n/).map((t) => ({ time: now, level, text: t }));
    const buffer = buffers.get(name) ?? [];
    buffer.push(...added);
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
    buffers.set(name, buffer);
    appended.fire({ name, lines: added });
}

function recordChunk(name: string, chunk: string): void {
    const text = (partial.get(name) ?? "") + chunk;
    const end = text.lastIndexOf("\n");
    if (end < 0) {
        partial.set(name, text);
        return;
    }
    partial.set(name, text.slice(end + 1));
    record(name, "output", text.slice(0, end));
}

const levels = new Set<string | symbol>(["trace", "debug", "info", "warn", "error"]);

// VS Code can't read an output channel back, so everything written to it is also kept here for the settings UI.
export function capture(name: string, channel: vscode.LogOutputChannel): vscode.LogOutputChannel {
    return new Proxy(channel, {
        get(target, prop) {
            if (levels.has(prop)) {
                return (message: string | Error, ...args: unknown[]) => {
                    const text = [message instanceof Error ? (message.stack ?? message.message) : message, ...args]
                        .map(String)
                        .join(" ");
                    record(name, prop as LogLevel, text);
                    (target[prop as "info"] as (m: string | Error, ...a: unknown[]) => void)(message, ...args);
                };
            }
            if (prop === "append") {
                return (value: string) => {
                    recordChunk(name, value);
                    target.append(value);
                };
            }
            if (prop === "appendLine") {
                return (value: string) => {
                    record(name, "output", value);
                    target.appendLine(value);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
