import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { DocumentFormattingRequest, DocumentRangeFormattingRequest } from "vscode-languageclient/node";
import which from "which";
import * as clients from "./clients";
import { expandRootVars, type FormatMode, type FormatterConfig } from "./config";
import { findRoot } from "./root";

const timeoutMs = 10_000;
let formatters: FormatterConfig[] = [];
let registration: vscode.Disposable | undefined;
let registeredKey = "";
const reportedMissing = new Set<string>();

export function setFormatters(next: FormatterConfig[]): void {
    formatters = next;
    reportedMissing.clear();
    refresh();
}

// VS Code only auto-picks a formatter when exactly one provider matches, so the extension registers just one.
export function refresh(): void {
    const capable = (kind: clients.FormatKind) =>
        clients
            .runningClients()
            .filter((rc) => clients.canFormat(rc, kind))
            .flatMap(clients.documentFilters);
    const documentSelector = [...formatters.flatMap(filters), ...capable("document")];
    const rangeSelector = capable("range");
    const key = JSON.stringify([documentSelector, rangeSelector]);
    if (key === registeredKey) return;
    registeredKey = key;
    registration?.dispose();
    registration = vscode.Disposable.from(
        vscode.languages.registerDocumentFormattingEditProvider(documentSelector, {
            provideDocumentFormattingEdits: formatDocument,
        }),
        vscode.languages.registerDocumentRangeFormattingEditProvider(rangeSelector, {
            provideDocumentRangeFormattingEdits: formatRange,
        }),
    );
}

export function dispose(): void {
    registration?.dispose();
}

function filters(f: FormatterConfig): vscode.DocumentFilter[] {
    return [
        ...f.languages.map((language) => ({ scheme: "file", language })),
        ...f.filePatterns.map((pattern) => ({ scheme: "file", pattern })),
    ];
}

// A "prefer" server beats CLI formatters; otherwise servers are only the fallback, like conform's lsp_format.
function pickServer(doc: vscode.TextDocument, kind: clients.FormatKind): clients.RunningClient | undefined {
    const candidates = clients.formattingClients(doc, kind);
    return candidates.find((rc) => rc.server.format === "prefer") ?? candidates[0];
}

function chainFor(doc: vscode.TextDocument): FormatterConfig[] {
    return formatters.filter((f) => vscode.languages.match(filters(f), doc) > 0);
}

type Decision = { chain: FormatterConfig[]; server?: undefined } | { chain?: undefined; server?: clients.RunningClient };

// The one place that decides who formats a document; the settings UI shows this same decision.
function decide(doc: vscode.TextDocument): Decision {
    const server = pickServer(doc, "document");
    if (server?.server.format === "prefer") return { server };
    const chain = chainFor(doc);
    return chain.length > 0 ? { chain } : { server };
}

export type FormatPlan =
    | { kind: "chain"; steps: { name: string; installed: boolean }[] }
    | { kind: "server"; server: string; mode: FormatMode }
    | { kind: "none" };

export function formatPlan(doc: vscode.TextDocument): FormatPlan {
    const decision = decide(doc);
    if (decision.chain) {
        return { kind: "chain", steps: decision.chain.map((f) => ({ name: f.name, installed: isInstalled(f) })) };
    }
    if (decision.server) return { kind: "server", server: decision.server.server.name, mode: decision.server.server.format };
    return { kind: "none" };
}

function isInstalled(f: FormatterConfig): boolean {
    const cmd = f.command[0];
    return cmd.includes("${") || which.sync(cmd, { nothrow: true, path: f.env.PATH ?? process.env.PATH }) !== null;
}

async function formatDocument(
    doc: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
): Promise<vscode.TextEdit[] | undefined> {
    const { chain, server: rc } = decide(doc);
    if (chain) return runChain(chain, doc, token);
    if (!rc) return undefined;
    const c2p = rc.client.code2ProtocolConverter;
    const edits = await rc.client.sendRequest(
        DocumentFormattingRequest.type,
        { textDocument: c2p.asTextDocumentIdentifier(doc), options: c2p.asFormattingOptions(options, fileOptions(doc)) },
        token,
    );
    return rc.client.protocol2CodeConverter.asTextEdits(edits, token);
}

async function formatRange(
    doc: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
): Promise<vscode.TextEdit[] | undefined> {
    const rc = pickServer(doc, "range");
    if (!rc) return undefined;
    // Formatters only do whole files; mixing in an LSP style on paste would fight them.
    if (rc.server.format !== "prefer" && chainFor(doc).length > 0) return undefined;
    const c2p = rc.client.code2ProtocolConverter;
    const edits = await rc.client.sendRequest(
        DocumentRangeFormattingRequest.type,
        {
            textDocument: c2p.asTextDocumentIdentifier(doc),
            range: c2p.asRange(range),
            options: c2p.asFormattingOptions(options, fileOptions(doc)),
        },
        token,
    );
    return rc.client.protocol2CodeConverter.asTextEdits(edits, token);
}

function fileOptions(doc: vscode.TextDocument) {
    const files = vscode.workspace.getConfiguration("files", doc);
    return {
        trimTrailingWhitespace: files.get<boolean>("trimTrailingWhitespace"),
        trimFinalNewlines: files.get<boolean>("trimFinalNewlines"),
        insertFinalNewline: files.get<boolean>("insertFinalNewline"),
    };
}

async function runChain(
    chain: FormatterConfig[],
    doc: vscode.TextDocument,
    token: vscode.CancellationToken,
): Promise<vscode.TextEdit[] | undefined> {
    const original = doc.getText();
    let text = original;
    for (const f of chain) {
        try {
            text = await runFormatter(f, doc, text, token);
        } catch (err) {
            if (token.isCancellationRequested) return undefined;
            clients.output("formatters").error(`${f.name} on ${doc.uri.fsPath}: ${err instanceof Error ? err.message : err}`);
            vscode.window.setStatusBarMessage(`$(error) Formatter ${f.name} failed, see General LSP: formatters`, 5000);
            return undefined;
        }
    }
    if (text === original) return [];
    // VS Code reduces this to minimal edits itself, so cursors and folds survive.
    return [vscode.TextEdit.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(original.length)), text)];
}

async function runFormatter(
    f: FormatterConfig,
    doc: vscode.TextDocument,
    input: string,
    token: vscode.CancellationToken,
): Promise<string> {
    const file = doc.uri.fsPath;
    const root = f.rootMarkers.length > 0 ? findRoot(file, f.rootMarkers) : undefined;
    if (!root && f.requireRoot) return input;
    const cwd = root ?? vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? path.dirname(file);
    // Non-stdin formatters edit a sibling copy, so config discovery still sees the real directory.
    const target = f.stdin ? file : path.join(path.dirname(file), `.general-lsp.${randomUUID().slice(0, 8)}.${path.basename(file)}`);
    const env = { ...process.env, ...expandRootVars(f.env, cwd) };
    const [cmd, ...args] = f.command.map((arg) => expandRootVars(expandFileVars(arg, target), cwd));
    const resolved = which.sync(cmd, { nothrow: true, path: env.PATH });
    // Like conform, an uninstalled formatter is skipped rather than failing the chain.
    if (!resolved) {
        if (!reportedMissing.has(f.name)) {
            reportedMissing.add(f.name);
            clients.output("formatters").warn(`${f.name}: '${cmd}' not found on PATH or generalLsp.extraPaths, skipping`);
        }
        return input;
    }
    if (f.stdin) {
        const output = await run(resolved, args, cwd, env, input, f.exitCodes, token);
        if (output === "" && input !== "") throw new Error("returned empty output");
        return output;
    }
    await fs.writeFile(target, input);
    try {
        await run(resolved, args, cwd, env, "", f.exitCodes, token);
        return await fs.readFile(target, "utf8");
    } finally {
        await fs.rm(target, { force: true });
    }
}

function expandFileVars(arg: string, file: string): string {
    return arg
        .replaceAll("${fileDirname}", path.dirname(file))
        .replaceAll("${fileBasename}", path.basename(file))
        .replaceAll("${file}", file);
}

function run(
    cmd: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    input: string,
    exitCodes: number[],
    token: vscode.CancellationToken,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env, timeout: timeoutMs, windowsHide: true });
        const cancel = token.onCancellationRequested(() => child.kill());
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code, signal) => {
            cancel.dispose();
            if (code !== null && exitCodes.includes(code)) resolve(stdout);
            else reject(new Error(`exited with ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
        });
        // A formatter may exit before reading all of stdin.
        child.stdin.on("error", () => {});
        child.stdin.end(input);
    });
}
