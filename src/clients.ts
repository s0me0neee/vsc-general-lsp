import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
    CancellationToken,
    DidChangeConfigurationNotification,
    DidChangeWorkspaceFoldersNotification,
    DidOpenTextDocumentNotification,
    ExecuteCommandRequest,
    LanguageClient,
    RevealOutputChannelOn,
    State,
    StreamMessageReader,
    StreamMessageWriter,
    WorkspaceFoldersRequest,
    vsdiag,
    type DocumentSelector,
    type LanguageClientOptions,
    type MessageReader,
    type Middleware,
    type ServerOptions,
    type WorkspaceFolder,
} from "vscode-languageclient/node";
import which from "which";
import { expandRootVars, lookupSection, type ServerConfig } from "./config";
import { reap, spawnServer } from "./processes";
import * as logs from "./logs";
import { findRoot, findVenv } from "./root";

export type FormatKind = "document" | "range";

export interface RunningClient {
    // Stable handle for the UI; the pid changes whenever languageclient restarts a crashed server.
    id: number;
    server: ServerConfig;
    argv: string[];
    // What the process gets on top of VS Code's own environment.
    envOverrides: Record<string, string>;
    startedAt: number;
    restarts: number;
    // Provider capabilities as the server advertised them, before anything was stripped.
    advertised: string[];
    // First workspace folder: the process cwd and what ${root} expands to.
    root: string;
    folders: string[];
    // A fallbackRoot client only ever serves loose files.
    isolated: boolean;
    // The virtualenv this process was launched inside, if the server asks for one.
    venv?: string;
    // Files assigned to this client, and the subset the server has actually been sent didOpen for.
    docs: Set<string>;
    opened: Set<string>;
    client: LanguageClient;
    pid?: number;
    canAddFolders: boolean;
    started: boolean;
    ready: Promise<void>;
    // Formatting is taken away from languageclient so the extension exposes one provider per file.
    formatting: { static: Set<FormatKind>; dynamic: Map<string, FormatKind> };
}

interface Placement {
    root: string;
    isolated: boolean;
    venv?: string;
}

const formatMethods: Record<string, FormatKind> = {
    "textDocument/formatting": "document",
    "textDocument/rangeFormatting": "range",
};

// Middleware hooks whose first argument is the document; unowned documents get no answer.
const documentHooks = [
    "provideCompletionItem",
    "provideHover",
    "provideSignatureHelp",
    "provideDefinition",
    "provideReferences",
    "provideDocumentHighlights",
    "provideDocumentSymbols",
    "provideCodeActions",
    "provideCodeLenses",
    "provideDocumentFormattingEdits",
    "provideDocumentRangeFormattingEdits",
    "provideDocumentRangesFormattingEdits",
    "provideOnTypeFormattingEdits",
    "provideRenameEdits",
    "prepareRename",
    "provideDocumentLinks",
    "provideTypeDefinition",
    "provideImplementation",
    "provideDocumentColors",
    "provideFoldingRanges",
    "provideDeclaration",
    "provideSelectionRanges",
    "prepareCallHierarchy",
    "provideDocumentSemanticTokens",
    "provideDocumentSemanticTokensEdits",
    "provideDocumentRangeSemanticTokens",
    "provideLinkedEditingRange",
    "prepareTypeHierarchy",
    "provideInlineValues",
    "provideInlayHints",
    "provideInlineCompletionItems",
] as const;

const running = new Set<RunningClient>();
let nextId = 1;
// Server name + root → the client serving it; pending while a host decides whether to take the folder.
const roots = new Map<string, Promise<RunningClient | undefined>>();
const outputs = new Map<string, vscode.LogOutputChannel>();
const reportedMissing = new Set<string>();
const changed = new vscode.EventEmitter<void>();
// Server command ids are global in VS Code; each is registered once and routed to one of its owners.
const commands = new Map<string, { owners: Set<RunningClient>; registration: vscode.Disposable }>();

export const onDidChange = changed.event;

export function runningClients(): RunningClient[] {
    return [...running];
}

export function matches(server: Pick<ServerConfig, "languages" | "filePatterns">, doc: vscode.TextDocument): boolean {
    const selector = serverFilters(server);
    return selector.length > 0 && vscode.languages.match(selector, doc) > 0;
}

// Whether the file would get a root at all; without one a gated server never attaches.
export function hasRoot(server: ServerConfig, uri: vscode.Uri): boolean {
    return resolveRoot(server, uri) !== undefined;
}

export function clientsFor(doc: vscode.TextDocument): RunningClient[] {
    const uri = doc.uri.toString();
    return runningClients().filter((rc) => rc.docs.has(uri));
}

export function canFormat(rc: RunningClient, kind: FormatKind): boolean {
    if (rc.server.format === "never") return false;
    return rc.formatting.static.has(kind) || [...rc.formatting.dynamic.values()].includes(kind);
}

// In settings order, so the first one is the server that formats.
export function formattingClients(doc: vscode.TextDocument, kind: FormatKind): RunningClient[] {
    return clientsFor(doc)
        .filter((rc) => rc.client.isRunning() && canFormat(rc, kind))
        .sort((a, b) => a.server.order - b.server.order);
}

export function documentFilters(rc: RunningClient): vscode.DocumentFilter[] {
    return serverFilters(rc.server);
}

// Like nvim: every file is attached to exactly one client per server, chosen by its root.
export function attach(server: ServerConfig, doc: vscode.TextDocument): void {
    if (!matches(server, doc)) return;
    const uri = doc.uri.toString();
    if (runningClients().some((rc) => rc.server.name === server.name && rc.docs.has(uri))) return;
    const placement = resolveRoot(server, doc.uri);
    if (!placement) return;
    const key = rootKey(server.name, placement.root);
    let pending = roots.get(key);
    if (!pending) {
        pending = place(server, placement);
        roots.set(key, pending);
    }
    void pending.then((rc) => {
        if (rc) assign(rc, doc);
        // A missing binary is retried on the next file instead of being remembered forever.
        else if (roots.get(key) === pending) roots.delete(key);
    });
}

export async function stop(rc: RunningClient): Promise<void> {
    // Removed synchronously so a reattach in the same tick spawns a fresh client.
    running.delete(rc);
    for (const folder of rc.folders) roots.delete(rootKey(rc.server.name, folder));
    removeCommands(rc);
    changed.fire();
    try {
        await rc.client.dispose(2000);
    } catch (err) {
        output(rc.server.name).warn(`Stopping ${rc.root}: ${err}`);
    }
    // Catches servers that ignored `exit` and anything they spawned.
    reap(rc.pid);
}

export async function stopAll(): Promise<void> {
    await Promise.all(runningClients().map(stop));
}

export function forgetMissing(): void {
    reportedMissing.clear();
}

export function output(name: string): vscode.LogOutputChannel {
    let channel = outputs.get(name);
    if (!channel) {
        channel = logs.capture(name, vscode.window.createOutputChannel(`General LSP: ${name}`, { log: true }));
        outputs.set(name, channel);
    }
    return channel;
}

export function disposeOutputs(): void {
    outputs.forEach((o) => o.dispose());
    outputs.clear();
    changed.dispose();
}

function serverFilters(server: Pick<ServerConfig, "languages" | "filePatterns">): vscode.DocumentFilter[] {
    return [
        ...server.languages.map((language) => ({ scheme: "file", language })),
        ...server.filePatterns.map((pattern) => ({ scheme: "file", pattern })),
    ];
}

function rootKey(name: string, root: string): string {
    return `${name}\0${root}`;
}

function resolveRoot(server: ServerConfig, uri: vscode.Uri): Placement | undefined {
    const placement = rootOnly(server, uri);
    if (!placement || placement.isolated || !server.venv) return placement;
    return { ...placement, venv: findVenv(placement.root, server.venv) };
}

function rootOnly(server: ServerConfig, uri: vscode.Uri): Placement | undefined {
    const file = uri.fsPath;
    const markerRoot = server.rootMarkers.length > 0 ? findRoot(file, server.rootMarkers) : undefined;
    if (markerRoot) return { root: markerRoot, isolated: false };
    if (server.fallbackRoot) {
        fs.mkdirSync(server.fallbackRoot, { recursive: true });
        return { root: server.fallbackRoot, isolated: true };
    }
    // Without single-file support, markers gate attachment (e.g. denols only under deno.json).
    if (server.rootMarkers.length > 0 && !server.singleFileSupport) return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (folder) return { root: folder, isolated: false };
    return server.singleFileSupport ? { root: path.dirname(file), isolated: false } : undefined;
}

// What `source venv/bin/activate` does, applied to the server's environment.
function activate(env: Record<string, string>, venv: string | undefined): Record<string, string> {
    if (!venv) return env;
    const bin = path.join(venv, process.platform === "win32" ? "Scripts" : "bin");
    return { ...env, VIRTUAL_ENV: venv, PATH: [bin, env.PATH ?? process.env.PATH ?? ""].join(path.delimiter) };
}

// A new root joins a running client as a workspace folder when the server supports it, else gets its own.
async function place(server: ServerConfig, placement: Placement): Promise<RunningClient | undefined> {
    if (server.multiRoot && !placement.isolated) {
        // One process has one VIRTUAL_ENV, so roots with different venvs can't share it.
        const host = runningClients().find(
            (rc) => rc.server.name === server.name && !rc.isolated && rc.venv === placement.venv,
        );
        if (host) {
            await host.ready;
            if (running.has(host) && host.canAddFolders) {
                addFolder(host, placement.root);
                return host;
            }
        }
    }
    return spawn(server, placement);
}

function spawn(server: ServerConfig, placement: Placement): RunningClient | undefined {
    const [cmd, ...args] = server.command.map((arg) => expandRootVars(arg, placement.root));
    const env = activate(server.env, placement.venv);
    // Resolved against the activated PATH, so a project-pinned ruff/ty in the venv wins.
    const resolved = resolveCommand(server, cmd, env.PATH);
    if (!resolved) return undefined;
    const rc = {
        id: nextId++,
        server,
        argv: [resolved, ...args],
        envOverrides: expandRootVars(env, placement.root),
        startedAt: Date.now(),
        restarts: 0,
        advertised: [],
        root: placement.root,
        folders: [placement.root],
        isolated: placement.isolated,
        venv: placement.venv,
        docs: new Set(),
        opened: new Set(),
        canAddFolders: false,
        started: false,
        formatting: { static: new Set(), dynamic: new Map() },
    } as unknown as RunningClient;
    rc.client = createClient(rc, [resolved, ...args], env);
    running.add(rc);
    rc.client.onDidChangeState(({ oldState, newState }) => {
        if (oldState === State.Running && newState === State.Starting) rc.restarts++;
        if (newState === State.Running) {
            // After the state flips, languageclient still sends `initialized` and opens what it owns in this tick.
            setTimeout(() => {
                if (!rc.client.isRunning()) return;
                rc.started = true;
                flushOpens(rc);
            });
        } else {
            rc.started = false;
            rc.opened.clear();
        }
        changed.fire();
    });
    rc.ready = start(rc);
    return rc;
}

function addFolder(rc: RunningClient, root: string): void {
    rc.folders.push(root);
    void rc.client.sendNotification(DidChangeWorkspaceFoldersNotification.type, {
        event: { added: [workspaceFolder(root)], removed: [] },
    });
    changed.fire();
}

function assign(rc: RunningClient, doc: vscode.TextDocument): void {
    if (doc.isClosed || !running.has(rc)) return;
    rc.docs.add(doc.uri.toString());
    // languageclient already skipped this file's didOpen while it had no owner.
    if (rc.started) flushOpens(rc);
    changed.fire();
}

function flushOpens(rc: RunningClient): void {
    for (const doc of vscode.workspace.textDocuments) {
        const uri = doc.uri.toString();
        if (!rc.docs.has(uri) || rc.opened.has(uri)) continue;
        rc.opened.add(uri);
        const params = rc.client.code2ProtocolConverter.asOpenTextDocumentParams(doc);
        void rc.client.sendNotification(DidOpenTextDocumentNotification.type, params);
    }
}

function workspaceFolder(root: string): WorkspaceFolder {
    return { uri: vscode.Uri.file(root).toString(), name: path.basename(root) };
}

function resolveCommand(server: ServerConfig, cmd: string, searchPath: string | undefined): string | undefined {
    const resolved = which.sync(cmd, { nothrow: true, path: searchPath });
    if (resolved) return resolved;
    if (!reportedMissing.has(server.name)) {
        reportedMissing.add(server.name);
        void vscode.window
            .showErrorMessage(`General LSP: '${cmd}' for server '${server.name}' was not found on PATH.`, "Open Settings")
            .then((choice) => {
                if (choice) void vscode.commands.executeCommand("generalLsp.openSettings");
            });
    }
    return undefined;
}

// The client's selector is the server's languages everywhere; ownership narrows it to the assigned files.
function ownershipMiddleware(rc: RunningClient): Middleware {
    const owns = (doc: vscode.TextDocument | vscode.Uri) =>
        rc.opened.has(("uri" in doc ? doc.uri : doc).toString());
    const guarded = Object.fromEntries(
        documentHooks.map((name) => [
            name,
            (doc: vscode.TextDocument, ...rest: unknown[]) => {
                const next = rest.pop() as (...args: unknown[]) => unknown;
                return owns(doc) ? next(doc, ...rest) : undefined;
            },
        ]),
    );
    return {
        ...guarded,
        provideDiagnostics: (doc, previousResultId, token, next) =>
            owns(doc) ? next(doc, previousResultId, token) : { kind: vsdiag.DocumentDiagnosticReportKind.full, items: [] },
        didOpen: async (doc, next) => {
            const uri = doc.uri.toString();
            if (!rc.docs.has(uri) || rc.opened.has(uri)) return;
            rc.opened.add(uri);
            await next(doc);
        },
        didChange: async (event, next) => {
            if (owns(event.document)) await next(event);
        },
        willSave: async (event, next) => {
            if (owns(event.document)) await next(event);
        },
        willSaveWaitUntil: (event, next) => (owns(event.document) ? next(event) : Promise.resolve([])),
        didSave: async (doc, next) => {
            if (owns(doc)) await next(doc);
        },
        didClose: async (doc, next) => {
            const uri = doc.uri.toString();
            rc.docs.delete(uri);
            if (rc.opened.delete(uri)) await next(doc);
            changed.fire();
        },
    } as Middleware;
}

function createClient(rc: RunningClient, argv: string[], serverEnv: Record<string, string>): LanguageClient {
    const { server, root } = rc;
    const documentSelector = serverFilters(server).map((f) => ({ ...f })) as DocumentSelector;
    const env: NodeJS.ProcessEnv = { ...process.env, ...expandRootVars(serverEnv, root) };
    // An activated venv never runs with an inherited PYTHONHOME, which would point Python elsewhere.
    if (rc.venv) delete env.PYTHONHOME;
    const settings = expandRootVars(server.settings, root);
    const channel = output(server.name);
    // Called again on every languageclient-initiated restart.
    const serverOptions: ServerOptions = async () => {
        const child = await spawnServer(argv[0], argv.slice(1), root, env);
        rc.pid = child.pid;
        child.stderr!.on("data", (data) => channel.append(String(data)));
        const reader = onInitializeResult(new StreamMessageReader(child.stdout!), (capabilities) => {
            rc.advertised = Object.keys(capabilities).filter((k) => k.endsWith("Provider") && capabilities[k]);
            for (const name of server.disabledCapabilities) delete capabilities[name];
            rc.formatting = { static: new Set(), dynamic: new Map() };
            if (capabilities.documentFormattingProvider) rc.formatting.static.add("document");
            if (capabilities.documentRangeFormattingProvider) rc.formatting.static.add("range");
            delete capabilities.documentFormattingProvider;
            delete capabilities.documentRangeFormattingProvider;
            const folders = (capabilities.workspace as { workspaceFolders?: { supported?: boolean; changeNotifications?: unknown } })
                ?.workspaceFolders;
            rc.canAddFolders = Boolean(folders?.supported && folders.changeNotifications);
            // languageclient registers these globally, so a second client of the same server would fail to start.
            const provider = capabilities.executeCommandProvider as { commands?: string[] } | undefined;
            delete capabilities.executeCommandProvider;
            addCommands(rc, provider?.commands ?? []);
        });
        return { reader, writer: new StreamMessageWriter(child.stdin!) };
    };
    const clientOptions: LanguageClientOptions = {
        documentSelector,
        workspaceFolder: { uri: vscode.Uri.file(root), name: path.basename(root), index: 0 },
        initializationOptions: expandRootVars(server.initializationOptions, root),
        outputChannel: channel,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        middleware: {
            ...ownershipMiddleware(rc),
            workspace: {
                configuration: (params) => params.items.map((item) => lookupSection(settings, item.section)),
            },
            handleRegisterCapability: async (params, next) => {
                const registrations = params.registrations.filter((r) => {
                    // No languageclient feature handles this once the client is pinned to a folder; we send it ourselves.
                    if (r.method === DidChangeWorkspaceFoldersNotification.method) {
                        rc.canAddFolders = true;
                        return false;
                    }
                    const kind = formatMethods[r.method];
                    if (kind) rc.formatting.dynamic.set(r.id, kind);
                    return !kind;
                });
                changed.fire();
                await next({ registrations }, CancellationToken.None);
            },
            handleUnregisterCapability: async (params, next) => {
                const unregisterations = params.unregisterations.filter(
                    (u) => u.method !== DidChangeWorkspaceFoldersNotification.method && !rc.formatting.dynamic.delete(u.id),
                );
                changed.fire();
                await next({ unregisterations }, CancellationToken.None);
            },
        },
    };
    const client = new LanguageClient(`generalLsp.${server.name}`, server.name, serverOptions, clientOptions);
    // Pinning the client to one folder drops languageclient's folder support, so advertise and answer it here.
    client.registerFeature({
        fillClientCapabilities: (capabilities) => {
            capabilities.workspace = { ...capabilities.workspace, workspaceFolders: true };
        },
        fillInitializeParams: (params) => {
            params.workspaceFolders = rc.folders.map(workspaceFolder);
        },
        initialize: () => {},
        getState: () => ({ kind: "static" }),
        clear: () => {},
    });
    client.onRequest(WorkspaceFoldersRequest.type, () => rc.folders.map(workspaceFolder));
    return client;
}

// languageclient has no hook between the initialize result and feature registration, so edit the message itself.
function onInitializeResult(reader: MessageReader, edit: (capabilities: Record<string, unknown>) => void): MessageReader {
    return {
        onError: reader.onError,
        onClose: reader.onClose,
        onPartialMessage: reader.onPartialMessage,
        listen: (callback) =>
            reader.listen((message) => {
                const capabilities = (message as { result?: { capabilities?: Record<string, unknown> } }).result
                    ?.capabilities;
                if (capabilities) edit(capabilities);
                callback(message);
            }),
        dispose: () => reader.dispose(),
    };
}

function addCommands(rc: RunningClient, ids: string[]): void {
    for (const id of ids) {
        let entry = commands.get(id);
        if (!entry) {
            const owners = new Set<RunningClient>();
            const registration = vscode.commands.registerCommand(id, (...args: unknown[]) => {
                const doc = vscode.window.activeTextEditor?.document;
                const target = (doc && clientsFor(doc).find((c) => owners.has(c))) ?? owners.values().next().value;
                return target?.client.sendRequest(ExecuteCommandRequest.type, { command: id, arguments: args });
            });
            entry = { owners, registration };
            commands.set(id, entry);
        }
        entry.owners.add(rc);
    }
}

function removeCommands(rc: RunningClient): void {
    for (const [id, entry] of commands) {
        entry.owners.delete(rc);
        if (entry.owners.size > 0) continue;
        entry.registration.dispose();
        commands.delete(id);
    }
}

async function start(rc: RunningClient): Promise<void> {
    try {
        await rc.client.start();
        // Push settings too, for servers that never pull via workspace/configuration (lspconfig does the same).
        if (Object.keys(rc.server.settings).length > 0) {
            const settings = expandRootVars(rc.server.settings, rc.root);
            await rc.client.sendNotification(DidChangeConfigurationNotification.type, { settings });
        }
    } catch (err) {
        output(rc.server.name).error(`Failed to start in ${rc.root}: ${err}`);
    }
}
