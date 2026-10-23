import * as vscode from "vscode";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "output";

export interface LogLine {
    // Unique and increasing, so the UI can key rows that scroll out of the ring buffer.
    seq: number;
    time: number;
    level: LogLevel;
    text: string;
}

const limit = 5000;
// Trimmed in steps rather than on every line, which would shift the whole buffer each time once it's full.
const trimSlack = 1000;
// An unfinished stderr line (a prompt, or a crash message with no newline) still shows up after this long.
const partialFlushMs = 500;
const buffers = new Map<string, LogLine[]>();
const channels = new Map<string, vscode.LogOutputChannel>();
const appended = new vscode.EventEmitter<{ name: string; lines: LogLine[] }>();
let seq = 0;

export const onDidAppend = appended.event;

export function lines(name: string): LogLine[] {
    return buffers.get(name) ?? [];
}

export function clear(name: string): void {
    buffers.delete(name);
}

// Drops logs of servers that no longer exist in settings.
export function retain(names: Set<string>): void {
    for (const name of buffers.keys()) if (!names.has(name)) clear(name);
}

// Holds back one stream's unfinished last line; per stream, so two processes can't glue theirs together.
export function lineSplitter(onLines: (text: string) => void): { write(chunk: string): void; flush(): void } {
    let rest = "";
    let timer: NodeJS.Timeout | undefined;
    const flush = () => {
        clearTimeout(timer);
        if (rest !== "") onLines(rest);
        rest = "";
    };
    return {
        write(chunk) {
            clearTimeout(timer);
            const text = rest + chunk;
            const end = text.lastIndexOf("\n");
            if (end >= 0) onLines(text.slice(0, end));
            rest = text.slice(end + 1);
            if (rest !== "") timer = setTimeout(flush, partialFlushMs);
        },
        flush,
    };
}

// One captured output channel per log name: each server, the formatters, and General LSP itself.
export function channel(name: string, title: string): vscode.LogOutputChannel {
    let found = channels.get(name);
    if (!found) {
        found = capture(name, vscode.window.createOutputChannel(title, { log: true }));
        channels.set(name, found);
    }
    return found;
}

export function dispose(): void {
    channels.forEach((c) => c.dispose());
    channels.clear();
    appended.dispose();
}

function record(name: string, level: LogLevel, text: string): void {
    const now = Date.now();
    const added = text.split(/\r?\n/).map((t) => ({ seq: seq++, time: now, level, text: t }));
    const buffer = buffers.get(name) ?? [];
    buffer.push(...added);
    if (buffer.length > limit + trimSlack) buffer.splice(0, buffer.length - limit);
    buffers.set(name, buffer);
    appended.fire({ name, lines: added });
}

const levels = new Set<string | symbol>(["trace", "debug", "info", "warn", "error"]);

// VS Code can't read an output channel back, so everything written to it is also kept here for the settings UI.
function capture(name: string, channel: vscode.LogOutputChannel): vscode.LogOutputChannel {
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
            if (prop === "append" || prop === "appendLine") {
                return (value: string) => {
                    // Process output goes through a per-stream lineSplitter first, so this text is whole lines.
                    record(name, "output", value.replace(/\r?\n$/, ""));
                    target[prop](value);
                };
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
