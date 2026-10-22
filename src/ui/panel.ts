import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { State } from "vscode-languageclient/node";
import which from "which";
import * as os from "node:os";
import * as clients from "../clients";
import { expandHome, expandRootVars, normalizePatterns, readServers, withExtraPaths } from "../config";
import { formatPlan } from "../formatting";
import * as logs from "../logs";
import { isInside } from "../root";
import type {
    BufferInfo,
    BufferServer,
    ClientInfo,
    Entry,
    HostMessage,
    Kind,
    LogLine,
    ProcessInfo,
    Raw,
    Status,
    UiMessage,
    UiState,
} from "./protocol";
import * as store from "./store";

export interface PanelActions {
    reloadAll(): Promise<void>;
    restartServer(name: string): Promise<void>;
    stopServer(name: string): Promise<void>;
    // Attach open files again, starting whatever servers they now need.
    reattach(): void;
}

interface Session {
    post(message: HostMessage): void;
    watchLog(server: string | undefined): void;
}

let panel: vscode.WebviewPanel | undefined;
let lastActions: PanelActions | undefined;

// Lets tests drive the same handlers the webview uses, without a webview.
export function dispatch(message: UiMessage): Promise<void> {
    if (!lastActions) throw new Error("Settings panel was never opened");
    return handle(message, lastActions, { post: () => {}, watchLog: () => {} });
}
// Incremented when the webview script has booted, which proves it runs under the CSP.
let readyCount = 0;

export function webviewReadyCount(): number {
    return readyCount;
}

export function openSettingsPanel(extensionUri: vscode.Uri, actions: PanelActions): vscode.WebviewPanel {
    lastActions = actions;
    if (panel) {
        panel.reveal();
        return panel;
    }
    const webviewRoot = vscode.Uri.joinPath(extensionUri, "dist", "webview");
    const created = vscode.window.createWebviewPanel("generalLsp.settings", "General LSP", vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [webviewRoot],
    });
    panel = created;
    created.iconPath = vscode.Uri.joinPath(extensionUri, "dist", "webview", "icon.svg");
    created.webview.html = html(created.webview, webviewRoot);

    // Server state flips several times per start; one update per burst is enough.
    let timer: NodeJS.Timeout | undefined;
    const post = (message: HostMessage) => void created.webview.postMessage(message);
    const postState = () => {
        clearTimeout(timer);
        timer = setTimeout(() => post({ type: "state", state: uiState() }), 50);
    };

    // Only the log on screen streams; chatty servers would otherwise flood the webview.
    let watched: string | undefined;
    let pending: LogLine[] = [];
    let logTimer: NodeJS.Timeout | undefined;
    const flushLog = () => {
        logTimer = undefined;
        if (watched && pending.length > 0) post({ type: "log", server: watched, lines: pending, reset: false });
        pending = [];
    };
    const session: Session = {
        post,
        watchLog: (server) => {
            watched = server;
            pending = [];
            if (server) post({ type: "log", server, lines: logs.lines(server).slice(-2000), reset: true });
        },
    };

    const subscriptions = [
        logs.onDidAppend(({ name, lines }) => {
            if (name !== watched) return;
            pending.push(...lines);
            logTimer ??= setTimeout(flushLog, 100);
        }),
        clients.onDidChange(postState),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration("generalLsp")) postState();
        }),
        // The Buffers tab follows what is open and focused.
        vscode.workspace.onDidOpenTextDocument(postState),
        vscode.workspace.onDidCloseTextDocument(postState),
        vscode.window.onDidChangeActiveTextEditor(postState),
        vscode.window.tabGroups.onDidChangeTabs(postState),
        created.webview.onDidReceiveMessage(async (message: UiMessage) => {
            try {
                if (message.type === "ready") {
                    readyCount++;
                    post({ type: "state", state: uiState() });
                }
                else await handle(message, actions, session);
            } catch (err) {
                post({ type: "error", message: err instanceof Error ? err.message : String(err) });
            }
        }),
    ];
    created.onDidDispose(() => {
        clearTimeout(timer);
        clearTimeout(logTimer);
        subscriptions.forEach((s) => s.dispose());
        panel = undefined;
    });
    return created;
}

async function handle(message: UiMessage, actions: PanelActions, session: Session): Promise<void> {
    switch (message.type) {
        case "save":
            await store.saveEntry(message.kind, message.scope, message.name, message.raw, message.previousName);
            session.post({ type: "saved", kind: message.kind, name: message.name });
            return;
        case "watchLog":
            return session.watchLog(message.server);
        case "clearLog":
            logs.clear(message.server);
            return session.watchLog(message.server);
        case "stopProcess": {
            const rc = clients.runningClients().find((c) => c.id === message.id);
            if (rc) await clients.stop(rc);
            return;
        }
        case "restartProcess": {
            const rc = clients.runningClients().find((c) => c.id === message.id);
            if (rc) await clients.stop(rc);
            return actions.reattach();
        }
        case "delete": {
            const choice = await vscode.window.showWarningMessage(
                `Delete ${message.kind} '${message.name}' from settings.json?`,
                { modal: true },
                "Delete",
            );
            if (choice) await store.deleteEntry(message.kind, message.name);
            return;
        }
        case "move":
            return store.moveEntry(message.kind, message.name, message.delta);
        case "setEnabled":
            return store.setEnabled(message.kind, message.name, message.enabled);
        case "restart":
            return actions.restartServer(message.name);
        case "stop":
            return actions.stopServer(message.name);
        case "reloadAll":
            return actions.reloadAll();
        case "showOutput":
            return clients.output(message.name).show();
        case "openJson":
            await vscode.commands.executeCommand("workbench.action.openSettingsJson");
            return;
        case "openFile":
            // Beside the panel, so the Buffers tab stays visible.
            await vscode.window.showTextDocument(vscode.Uri.parse(message.uri), { viewColumn: vscode.ViewColumn.Beside });
            return;
        case "saveExtraPaths":
            return store.saveExtraPaths(message.paths);
    }
}

export function uiState(): UiState {
    const extraPaths = vscode.workspace.getConfiguration("generalLsp").get<string[]>("extraPaths", []);
    return {
        servers: store.entries("server").map((e) => entry("server", e.name, e.scope, e.raw)),
        formatters: store.entries("formatter").map((e) => entry("formatter", e.name, e.scope, e.raw)),
        buffers: buffers(),
        processes: processes(),
        extraPaths: extraPaths.map((p) => ({ path: p, exists: fs.existsSync(expandHome(p)) })),
        hasWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
    };
}

function buffers(): BufferInfo[] {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const inTabs = new Set(
        vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .map((t) => (t.input instanceof vscode.TabInputText ? t.input.uri.toString() : undefined)),
    );
    const configured = readServers();
    const entries = store.entries("server");
    const list = vscode.workspace.textDocuments
        .filter((doc) => doc.uri.scheme === "file")
        .map((doc): BufferInfo => {
            const uri = doc.uri.toString();
            return {
                uri,
                path: displayPath(doc.uri),
                language: doc.languageId,
                active: uri === active,
                hidden: !inTabs.has(uri),
                servers: entries.flatMap((e) => bufferServer(doc, e.name, e.raw, configured)),
                format: formatPlan(doc),
            };
        });
    // Focused file first, then what's in tabs, then hidden buffers.
    const rank = (b: BufferInfo) => (b.active ? 0 : b.hidden ? 2 : 1);
    return list.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

function bufferServer(
    doc: vscode.TextDocument,
    name: string,
    raw: Raw,
    configured: ReturnType<typeof readServers>,
): BufferServer[] {
    const filters = {
        languages: asStrings(raw.languages),
        filePatterns: normalizePatterns(asStrings(raw.filePatterns)),
    };
    if (!clients.matches(filters, doc)) return [];
    const rc = clients.clientsFor(doc).find((c) => c.server.name === name);
    if (rc) {
        const state = rc.client.state === State.Running ? "running" : rc.client.state === State.Starting ? "starting" : "stopped";
        // The folder that owns this file, i.e. the longest one containing it (or the fallback root).
        const root =
            rc.folders.filter((f) => isInside(doc.uri.fsPath, f)).sort((a, b) => b.length - a.length)[0] ?? rc.root;
        return [{ name, state, root: tildify(root), venv: rc.venv && tildify(rc.venv) }];
    }
    if (raw.enabled === false) return [{ name, state: "disabled" }];
    if (resolveBinary(raw) === null) return [{ name, state: "missing" }];
    const server = configured.get(name);
    if (server && !clients.hasRoot(server, doc.uri)) return [{ name, state: "noRoot" }];
    return [{ name, state: "pending" }];
}

function displayPath(uri: vscode.Uri): string {
    const relative = vscode.workspace.asRelativePath(uri, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
    return relative === uri.fsPath ? tildify(uri.fsPath) : relative;
}

function tildify(p: string): string {
    const home = os.homedir();
    return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

function asStrings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function processes(): ProcessInfo[] {
    return clients
        .runningClients()
        .map(
            (rc): ProcessInfo => ({
                id: rc.id,
                server: rc.server.name,
                state: clientState(rc),
                pid: rc.pid,
                startedAt: rc.startedAt,
                restarts: rc.restarts,
                argv: rc.argv,
                cwd: tildify(rc.root),
                venv: rc.venv && tildify(rc.venv),
                folders: rc.folders.map(tildify),
                files: [...rc.docs].map((uri) => ({ uri, path: displayPath(vscode.Uri.parse(uri)) })),
                capabilities: rc.advertised,
                disabled: rc.server.disabledCapabilities,
                config: effectiveConfig(rc),
            }),
        )
        .sort((a, b) => a.server.localeCompare(b.server) || a.id - b.id);
}

// The server's settings as this one process sees them: per-root variables expanded, venv applied.
function effectiveConfig(rc: clients.RunningClient): Raw {
    const s = rc.server;
    const config: Raw = {
        command: rc.argv,
        cwd: rc.root,
        venv: rc.venv,
        env: rc.envOverrides,
        languages: s.languages,
        filePatterns: s.filePatterns,
        rootMarkers: s.rootMarkers,
        singleFileSupport: s.singleFileSupport,
        multiRoot: s.multiRoot,
        fallbackRoot: s.fallbackRoot,
        format: s.format,
        disabledCapabilities: s.disabledCapabilities,
        initializationOptions: expandRootVars(s.initializationOptions, rc.root),
        settings: expandRootVars(s.settings, rc.root),
    };
    return Object.fromEntries(
        Object.entries(config).filter(
            ([, v]) =>
                v !== undefined &&
                !(Array.isArray(v) && v.length === 0) &&
                !(v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0),
        ),
    );
}

function clientState(rc: clients.RunningClient): ClientInfo["state"] {
    return rc.client.state === State.Running ? "running" : rc.client.state === State.Starting ? "starting" : "stopped";
}

function entry(kind: Kind, name: string, scope: Entry["scope"], raw: Raw): Entry {
    const binary = resolveBinary(raw);
    const live = kind === "server" ? clients.runningClients().filter((rc) => rc.server.name === name) : [];
    const infos: ClientInfo[] = live.map((rc) => ({
        state: rc.client.state === State.Running ? "running" : rc.client.state === State.Starting ? "starting" : "stopped",
        pid: rc.pid,
        folders: [...rc.folders],
        files: rc.docs.size,
        venv: rc.venv && tildify(rc.venv),
    }));
    return { name, scope, raw, binary, clients: infos, status: status(raw, binary, infos) };
}

function status(raw: Raw, binary: Entry["binary"], infos: ClientInfo[]): Status {
    if (raw.enabled === false) return "disabled";
    if (infos.some((c) => c.state === "running")) return "running";
    if (infos.some((c) => c.state === "starting")) return "starting";
    if (infos.length > 0) return "stopped";
    return binary === null ? "missing" : "idle";
}

function resolveBinary(raw: Raw): Entry["binary"] {
    const command = Array.isArray(raw.command) ? (raw.command as unknown[]) : [];
    if (typeof command[0] !== "string" || command[0] === "") return null;
    if (command[0].includes("${root")) return undefined;
    const env = withExtraPaths(raw.env as Record<string, string> | undefined);
    return which.sync(expandHome(command[0]), { nothrow: true, path: env.PATH ?? process.env.PATH }) ?? null;
}

function html(webview: vscode.Webview, root: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, file));
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${asset("main.css")}">
<title>General LSP</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${asset("main.js")}"></script>
</body>
</html>`;
}
