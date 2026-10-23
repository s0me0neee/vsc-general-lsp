// Shared by the extension host and the settings webview; keep it free of vscode and DOM imports.

export type Kind = "server" | "formatter";
export type Scope = "user" | "workspace";
export type Status = "running" | "starting" | "stopped" | "idle" | "disabled" | "missing";
export type Raw = Record<string, unknown>;

export interface ClientInfo {
    state: "running" | "starting" | "stopped";
    pid?: number;
    folders: string[];
    files: number;
    venv?: string;
}

export interface Entry {
    name: string;
    scope: Scope;
    // Exactly what settings.json holds, so unknown keys survive a round trip through the form.
    raw: Raw;
    status: Status;
    // Resolved executable, null when not found, undefined when it depends on ${root}.
    binary: string | null | undefined;
    clients: ClientInfo[];
}

export interface BufferServer {
    name: string;
    // Attached client state, or why a matching server isn't attached.
    state: ClientInfo["state"] | "disabled" | "missing" | "noRoot" | "pending";
    root?: string;
    venv?: string;
}

export type BufferFormat =
    | { kind: "chain"; steps: { name: string; installed: boolean }[] }
    | { kind: "server"; server: string; mode: "fallback" | "prefer" | "never" }
    | { kind: "none" };

export interface BufferInfo {
    uri: string;
    path: string;
    language: string;
    active: boolean;
    // Loaded in memory but not shown in any editor tab, like an nvim hidden buffer.
    hidden: boolean;
    servers: BufferServer[];
    format: BufferFormat;
}

export interface ProcessInfo {
    id: number;
    server: string;
    state: ClientInfo["state"];
    pid?: number;
    startedAt: number;
    restarts: number;
    argv: string[];
    cwd: string;
    venv?: string;
    folders: string[];
    files: { uri: string; path: string }[];
    // Provider capabilities the server advertised; ones in `disabled` were stripped by disabledCapabilities.
    capabilities: string[];
    disabled: string[];
    // The configuration this process actually runs with, variables expanded.
    config: Raw;
}

export interface LogLine {
    seq: number;
    time: number;
    level: "trace" | "debug" | "info" | "warn" | "error" | "output";
    text: string;
}

export interface NoticeInfo {
    seq: number;
    time: number;
    level: "error" | "warning";
    // What it's about: a server or formatter name, "settings", or "general-lsp" for the extension itself.
    source: string;
    message: string;
    // How often the same problem happened in a row.
    count: number;
}

export interface UiState {
    servers: Entry[];
    formatters: Entry[];
    buffers: BufferInfo[];
    processes: ProcessInfo[];
    notices: NoticeInfo[];
    unseenNotices: number;
    unseenSeverity?: NoticeInfo["level"];
    extraPaths: { path: string; exists: boolean }[];
    hasWorkspace: boolean;
}

export type UiMessage =
    | { type: "ready" }
    | { type: "save"; kind: Kind; name: string; previousName?: string; scope: Scope; raw: Raw }
    | { type: "delete"; kind: Kind; name: string }
    | { type: "move"; kind: Kind; name: string; delta: -1 | 1 }
    | { type: "setEnabled"; kind: Kind; name: string; enabled: boolean }
    | { type: "restart"; name: string }
    | { type: "stop"; name: string }
    | { type: "reloadAll" }
    | { type: "showOutput"; name: string }
    | { type: "openJson" }
    | { type: "openFile"; uri: string }
    | { type: "watchLog"; server?: string }
    | { type: "clearLog"; server: string }
    | { type: "stopProcess"; id: number }
    | { type: "restartProcess"; id: number }
    | { type: "saveExtraPaths"; paths: string[] }
    | { type: "checkPaths"; paths: string[] }
    | { type: "seenNotices" }
    | { type: "clearNotices" }
    | { type: "showLog" };

export type HostMessage =
    | { type: "state"; state: UiState }
    | { type: "saved"; kind: Kind; name: string }
    // `reset` replaces the shown log (a new server was picked); otherwise the lines are appended.
    | { type: "log"; server: string; lines: LogLine[]; reset: boolean }
    | { type: "pathsChecked"; exists: Record<string, boolean> }
    // Opened from a notification or the status bar: jump straight to that tab.
    | { type: "showTab"; tab: string }
    | { type: "noticesSeen" }
    | { type: "error"; message: string };
