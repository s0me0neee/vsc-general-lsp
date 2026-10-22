import { render, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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
    Scope,
    Status,
    UiMessage,
    UiState,
} from "../ui/protocol";

type Tab = "buffers" | "processes" | "servers" | "formatters" | "paths";
interface Persisted {
    tab: Tab;
    selected: Partial<Record<Kind | "process", string>>;
}

interface ShownLog {
    server: string;
    lines: LogLine[];
}

const host = acquireVsCodeApi<Persisted>();
const send = (message: UiMessage) => host.postMessage(message);
const persisted: Persisted = host.getState() ?? { tab: "buffers", selected: {} };
const persist = (patch: Partial<Persisted>) => host.setState(Object.assign(persisted, patch));

const statusText: Record<Status, string> = {
    running: "Running",
    starting: "Starting",
    stopped: "Stopped",
    idle: "Idle",
    disabled: "Disabled",
    missing: "Not installed",
};

// A formatter has no process between runs, so "idle" just means it is ready to run.
function statusLabel(kind: Kind, status: Status): string {
    return kind === "formatter" && status === "idle" ? "Ready" : statusText[status];
}

// ---------- app shell ----------

function App() {
    const [state, setState] = useState<UiState>();
    const [tab, setTab] = useState<Tab>(persisted.tab);
    const [toast, setToast] = useState<{ error: boolean; text: string }>();
    const [errors, setErrors] = useState(0);
    const [log, setLog] = useState<ShownLog>();
    const saved = useRef<(kind: Kind, name: string) => void>();

    useEffect(() => {
        const onMessage = (event: MessageEvent<HostMessage>) => {
            const message = event.data;
            if (message.type === "state") setState(message.state);
            else if (message.type === "log") {
                setLog((shown) =>
                    message.reset || shown?.server !== message.server
                        ? { server: message.server, lines: message.lines }
                        : { server: message.server, lines: [...shown.lines, ...message.lines].slice(-5000) },
                );
            }
            else if (message.type === "error") {
                setToast({ error: true, text: message.message });
                setErrors((n) => n + 1);
            }
            else if (message.type === "saved") {
                saved.current?.(message.kind, message.name);
                setToast({ error: false, text: `Saved ${message.name}` });
            }
        };
        window.addEventListener("message", onMessage);
        send({ type: "ready" });
        return () => window.removeEventListener("message", onMessage);
    }, []);

    useEffect(() => {
        if (!toast) return;
        const timer = setTimeout(() => setToast(undefined), toast.error ? 6000 : 2000);
        return () => clearTimeout(timer);
    }, [toast]);

    const choose = (next: Tab) => {
        setTab(next);
        persist({ tab: next });
    };
    // Jump from a buffer's chip to that entry's editor.
    const goto = (kind: Kind, name: string) => {
        persist({ selected: { ...persisted.selected, [kind]: name } });
        choose(kind === "server" ? "servers" : "formatters");
    };

    if (!state) return <div class="loading">Loading…</div>;
    const running = state.servers.filter((s) => s.status === "running").length;

    return (
        <div class="app">
            <header class="topbar">
                <div class="brand">
                    <i class="codicon codicon-server-process" />
                    <span>General LSP</span>
                    <span class="muted">
                        {running} of {state.servers.length} servers running
                    </span>
                </div>
                <nav class="tabs" role="tablist">
                    <TabButton
                        active={tab === "buffers"}
                        onClick={() => choose("buffers")}
                        count={state.buffers.filter((b) => !b.hidden).length}
                    >
                        Buffers
                    </TabButton>
                    <TabButton
                        active={tab === "processes"}
                        onClick={() => choose("processes")}
                        count={state.processes.length}
                    >
                        Processes
                    </TabButton>
                    <TabButton active={tab === "servers"} onClick={() => choose("servers")} count={state.servers.length}>
                        Servers
                    </TabButton>
                    <TabButton
                        active={tab === "formatters"}
                        onClick={() => choose("formatters")}
                        count={state.formatters.length}
                    >
                        Formatters
                    </TabButton>
                    <TabButton active={tab === "paths"} onClick={() => choose("paths")} count={state.extraPaths.length}>
                        Paths
                    </TabButton>
                </nav>
                <div class="actions">
                    <button class="btn secondary" onClick={() => send({ type: "openJson" })} title="Open settings.json">
                        <i class="codicon codicon-json" /> settings.json
                    </button>
                    <button
                        class="btn"
                        onClick={() => send({ type: "reloadAll" })}
                        title="Re-read settings and restart every server"
                    >
                        <i class="codicon codicon-debug-restart" /> Reload all
                    </button>
                </div>
            </header>
            {tab === "buffers" ? (
                <BuffersView buffers={state.buffers} formatters={state.formatters} goto={goto} />
            ) : tab === "processes" ? (
                <ProcessesView state={state} log={log} goto={goto} />
            ) : tab === "paths" ? (
                <PathsView paths={state.extraPaths} />
            ) : (
                <MasterDetail
                    key={tab}
                    kind={tab === "servers" ? "server" : "formatter"}
                    state={state}
                    errors={errors}
                    onSavedRef={saved}
                />
            )}
            {toast && (
                <div class={`toast ${toast.error ? "error" : ""}`} role="status">
                    <i class={`codicon ${toast.error ? "codicon-error" : "codicon-check"}`} />
                    {toast.text}
                </div>
            )}
        </div>
    );
}

function TabButton(props: { active: boolean; onClick: () => void; count: number; children: ComponentChildren }) {
    return (
        <button role="tab" aria-selected={props.active} class={`tab ${props.active ? "active" : ""}`} onClick={props.onClick}>
            {props.children}
            <span class="count">{props.count}</span>
        </button>
    );
}

// ---------- list + editor ----------

interface Draft {
    raw: Raw;
    scope: Scope;
}

function MasterDetail(props: {
    kind: Kind;
    state: UiState;
    errors: number;
    onSavedRef: { current?: (kind: Kind, name: string) => void };
}) {
    const { kind, state } = props;
    const entries = kind === "server" ? state.servers : state.formatters;
    const [selected, setSelected] = useState(persisted.selected[kind]);
    const [filter, setFilter] = useState("");
    const [draft, setDraft] = useState<Draft>();

    const select = (name: string | undefined) => {
        setDraft(undefined);
        setSelected(name);
        persist({ selected: { ...persisted.selected, [kind]: name } });
    };
    props.onSavedRef.current = (savedKind, name) => {
        if (savedKind === kind) select(name);
    };

    const current = entries.find((e) => e.name === selected) ?? entries[0];
    const visible = entries.filter((e) => matchesFilter(e, filter));

    const create = (raw: Raw = { command: [] }) => {
        setDraft({ raw, scope: "user" });
    };

    return (
        <div class="split">
            <aside class="sidebar">
                <label class="search">
                    <i class="codicon codicon-filter" />
                    <input
                        placeholder={`Filter ${kind}s`}
                        value={filter}
                        onInput={(e) => setFilter(e.currentTarget.value)}
                    />
                </label>
                <ul class="entries" role="listbox">
                    {visible.map((e) => (
                        <ListItem
                            key={e.name}
                            kind={kind}
                            entry={e}
                            index={entries.indexOf(e)}
                            count={entries.length}
                            active={!draft && current?.name === e.name}
                            onSelect={() => select(e.name)}
                        />
                    ))}
                    {draft && (
                        <li class="entry active new">
                            <span class="dot idle" />
                            <span class="name">New {kind}</span>
                        </li>
                    )}
                </ul>
                <button class="btn ghost add" onClick={() => create()}>
                    <i class="codicon codicon-add" /> New {kind}
                </button>
            </aside>
            <main class="detail">
                {draft ? (
                    <Editor
                        key="__new__"
                        kind={kind}
                        name=""
                        raw={draft.raw}
                        scope={draft.scope}
                        isNew
                        errors={props.errors}
                        hasWorkspace={state.hasWorkspace}
                        onCancel={() => setDraft(undefined)}
                    />
                ) : current ? (
                    <Editor
                        key={`${kind}:${current.name}`}
                        kind={kind}
                        name={current.name}
                        raw={current.raw}
                        scope={current.scope}
                        entry={current}
                        siblings={entries}
                        errors={props.errors}
                        hasWorkspace={state.hasWorkspace}
                        onDuplicate={(raw) => create(raw)}
                    />
                ) : (
                    <EmptyState kind={kind} onCreate={() => create()} />
                )}
            </main>
        </div>
    );
}

function matchesFilter(entry: Entry, filter: string): boolean {
    if (!filter) return true;
    const haystack = [entry.name, ...asStrings(entry.raw.languages), ...asStrings(entry.raw.filePatterns)].join(" ");
    return haystack.toLowerCase().includes(filter.toLowerCase());
}

function ListItem(props: {
    kind: Kind;
    entry: Entry;
    index: number;
    count: number;
    active: boolean;
    onSelect: () => void;
}) {
    const { entry, kind } = props;
    const enabled = entry.raw.enabled !== false;
    const targets = [...asStrings(entry.raw.languages), ...asStrings(entry.raw.filePatterns)];
    const stop = (e: Event) => e.stopPropagation();
    return (
        <li
            class={`entry ${props.active ? "active" : ""} ${enabled ? "" : "disabled"}`}
            role="option"
            aria-selected={props.active}
            tabIndex={0}
            onClick={props.onSelect}
            onKeyDown={(e) => e.key === "Enter" && props.onSelect()}
        >
            <span class={`dot ${entry.status}`} title={statusLabel(kind, entry.status)} />
            <span class="name">
                {kind === "formatter" && <span class="order">{props.index + 1}</span>}
                {entry.name}
            </span>
            <span class="sub">{targets.slice(0, 3).join(", ") + (targets.length > 3 ? ` +${targets.length - 3}` : "")}</span>
            <span class="row-actions" onClick={stop}>
                <IconButton
                    icon="arrow-up"
                    title="Move up (earlier in chain / priority)"
                    disabled={props.index === 0}
                    onClick={() => send({ type: "move", kind, name: entry.name, delta: -1 })}
                />
                <IconButton
                    icon="arrow-down"
                    title="Move down"
                    disabled={props.index === props.count - 1}
                    onClick={() => send({ type: "move", kind, name: entry.name, delta: 1 })}
                />
                <Switch
                    checked={enabled}
                    label={enabled ? "Disable" : "Enable"}
                    onChange={(on) => send({ type: "setEnabled", kind, name: entry.name, enabled: on })}
                />
            </span>
        </li>
    );
}

function EmptyState(props: { kind: Kind; onCreate: () => void }) {
    return (
        <div class="empty">
            <i class={`codicon ${props.kind === "server" ? "codicon-server" : "codicon-wand"}`} />
            <h2>No {props.kind}s configured</h2>
            <p>
                {props.kind === "server"
                    ? "Add a language server and pick the files it attaches to."
                    : "Add a command-line formatter, like conform.nvim."}
            </p>
            <button class="btn" onClick={props.onCreate}>
                <i class="codicon codicon-add" /> New {props.kind}
            </button>
        </div>
    );
}

// ---------- editor ----------

function Editor(props: {
    kind: Kind;
    name: string;
    raw: Raw;
    scope: Scope;
    entry?: Entry;
    siblings?: Entry[];
    isNew?: boolean;
    errors: number;
    hasWorkspace: boolean;
    onCancel?: () => void;
    onDuplicate?: (raw: Raw) => void;
}) {
    const { kind, entry } = props;
    const [name, setName] = useState(props.name);
    const [raw, setRaw] = useState<Raw>(props.raw);
    const [scope, setScope] = useState<Scope>(props.scope);
    const [jsonErrors, setJsonErrors] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);

    const dirty = props.isNew || name !== props.name || stableJson(raw) !== stableJson(props.raw);
    // Settings changed elsewhere (settings.json, the list toggles) flow in unless there are local edits.
    useEffect(() => {
        if (!dirty) setRaw(props.raw);
        setBusy(false);
    }, [stableJson(props.raw)]);
    // A rejected save (e.g. duplicate name) must hand the form back.
    useEffect(() => setBusy(false), [props.errors]);

    const set = (key: string, value: unknown) =>
        setRaw((current) => {
            const next = { ...current };
            if (value === undefined) delete next[key];
            else next[key] = value;
            return next;
        });
    const setJsonError = (key: string, bad: boolean) => setJsonErrors((e) => ({ ...e, [key]: bad }));

    const command = asStrings(raw.command);
    const problems = [
        !name.trim() && "Name is required.",
        command.filter(Boolean).length === 0 && "Command needs at least the executable.",
        asStrings(raw.languages).length + asStrings(raw.filePatterns).length === 0 &&
            "Add a language or a file pattern, or it will never attach.",
        Object.values(jsonErrors).some(Boolean) && "Fix the invalid JSON first.",
    ].filter((p): p is string => Boolean(p));
    const blocking = problems.filter((p) => !p.startsWith("Add a language"));

    const save = () => {
        if (blocking.length > 0 || !dirty) return;
        setBusy(true);
        send({
            type: "save",
            kind,
            name: name.trim(),
            previousName: props.isNew ? undefined : props.name,
            scope,
            raw: clean(raw),
        });
    };
    const revert = () => {
        if (props.isNew) props.onCancel?.();
        setName(props.name);
        setRaw(props.raw);
        setJsonErrors({});
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
                e.preventDefault();
                save();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    });

    return (
        <div class="editor">
            <div class="editor-head">
                <div class="title">
                    {entry && <StatusPill status={entry.status} kind={kind} />}
                    <input
                        class="name-input"
                        value={name}
                        placeholder={kind === "server" ? "server name, e.g. rust-analyzer" : "formatter name, e.g. stylua"}
                        onInput={(e) => setName(e.currentTarget.value)}
                        aria-label="Name"
                    />
                    {props.isNew ? (
                        props.hasWorkspace && (
                            <select
                                class="scope-select"
                                value={scope}
                                onChange={(e) => setScope(e.currentTarget.value as Scope)}
                            >
                                <option value="user">Save to User settings</option>
                                <option value="workspace">Save to Workspace settings</option>
                            </select>
                        )
                    ) : (
                        <span class="badge" title="Where this entry is defined">
                            {scope === "workspace" ? "Workspace" : "User"}
                        </span>
                    )}
                </div>
                {!props.isNew && entry && (
                    <div class="head-actions">
                        {kind === "server" && (
                            <>
                                <IconButton
                                    icon="debug-restart"
                                    title="Restart"
                                    onClick={() => send({ type: "restart", name: entry.name })}
                                />
                                <IconButton
                                    icon="debug-stop"
                                    title="Stop"
                                    disabled={entry.clients.length === 0}
                                    onClick={() => send({ type: "stop", name: entry.name })}
                                />
                            </>
                        )}
                        <IconButton
                            icon="output"
                            title="Show output"
                            onClick={() => send({ type: "showOutput", name: kind === "server" ? entry.name : "formatters" })}
                        />
                        <IconButton
                            icon="copy"
                            title="Duplicate"
                            onClick={() => props.onDuplicate?.(structuredClone(entry.raw))}
                        />
                        <IconButton
                            icon="trash"
                            title="Delete"
                            onClick={() => send({ type: "delete", kind, name: entry.name })}
                        />
                    </div>
                )}
            </div>

            <div class="editor-body">
                {entry && <Runtime kind={kind} entry={entry} siblings={props.siblings ?? []} />}

                <Section title="Command" icon="terminal">
                    <ListField
                        label="Executable and arguments"
                        hint={
                            kind === "server"
                                ? "One per row. Variables: ${root}, ${rootName}, ${rootUri}, ${userHome}, ~"
                                : "One per row. Variables: ${file}, ${fileDirname}, ${fileBasename}, ${root}, ${userHome}, ~"
                        }
                        values={command}
                        mono
                        placeholder={command.length === 0 ? "executable" : "argument"}
                        onChange={(v) => set("command", v)}
                    />
                </Section>

                <Section title="Attach to" icon="file-code">
                    <div class="two-col">
                        <ListField
                            label="Languages"
                            hint="VS Code language IDs"
                            values={asStrings(raw.languages)}
                            placeholder="e.g. rust"
                            onChange={(v) => set("languages", emptyToUndefined(v))}
                        />
                        <ListField
                            label="File patterns"
                            hint="Globs; *.zig means **/*.zig"
                            values={asStrings(raw.filePatterns)}
                            placeholder="e.g. *.gleam"
                            mono
                            onChange={(v) => set("filePatterns", emptyToUndefined(v))}
                        />
                    </div>
                </Section>

                <Section title="Root" icon="root-folder">
                    <MarkerField
                        value={raw.rootMarkers}
                        hint={
                            kind === "server"
                                ? "One row per priority level, nearest folder first. Comma-separate names of equal priority."
                                : "Sets the working directory and ${root}."
                        }
                        onChange={(v) => set("rootMarkers", v)}
                    />
                    {kind === "server" ? (
                        <>
                            <Toggle
                                label="Single-file support"
                                hint="Attach even without a root marker, using the workspace folder or the file's folder."
                                checked={raw.singleFileSupport !== false}
                                onChange={(on) => set("singleFileSupport", on ? undefined : false)}
                            />
                            <Toggle
                                label="Multiple workspace folders"
                                hint="New roots join this server's running process instead of starting another (when the server supports it)."
                                checked={raw.multiRoot !== false}
                                onChange={(on) => set("multiRoot", on ? undefined : false)}
                            />
                            <Toggle
                                label="Activate Python virtualenv"
                                hint="Launch as if the nearest venv at or above the root were activated (VIRTUAL_ENV, venv/bin on PATH), so ty, ruff and pyright resolve the project's packages."
                                checked={raw.venv === true || Array.isArray(raw.venv)}
                                onChange={(on) => set("venv", on ? true : undefined)}
                            />
                            {Array.isArray(raw.venv) || raw.venv === true ? (
                                <ListField
                                    label="Virtualenv folder names"
                                    hint="Searched in order in the root, then its parents. Default: .venv, venv, env"
                                    values={Array.isArray(raw.venv) ? asStrings(raw.venv) : [".venv", "venv", "env"]}
                                    mono
                                    placeholder=".venv"
                                    onChange={(v) =>
                                        set("venv", v.length === 0 || stableJson(v) === stableJson([".venv", "venv", "env"]) ? true : v)
                                    }
                                />
                            ) : null}
                            <TextField
                                label="Fallback root"
                                hint="Root for files without any marker, e.g. an empty scratch folder."
                                value={asString(raw.fallbackRoot)}
                                placeholder="~/.cache/general-lsp/scratch"
                                mono
                                onChange={(v) => set("fallbackRoot", v || undefined)}
                            />
                        </>
                    ) : (
                        <Toggle
                            label="Require root"
                            hint="Skip this formatter when no root marker is found (conform's require_cwd)."
                            checked={raw.requireRoot === true}
                            onChange={(on) => set("requireRoot", on || undefined)}
                        />
                    )}
                </Section>

                {kind === "server" ? (
                    <>
                        <Section title="Formatting" icon="wand">
                            <Segmented
                                label="Use this server's formatter"
                                value={asString(raw.format) || "fallback"}
                                options={[
                                    ["fallback", "Fallback", "Only for files no CLI formatter matches"],
                                    ["prefer", "Prefer", "Even when a CLI formatter matches"],
                                    ["never", "Never", "Never format with this server"],
                                ]}
                                onChange={(v) => set("format", v === "fallback" ? undefined : v)}
                            />
                        </Section>
                        <Section title="Server settings" icon="settings">
                            <JsonField
                                label="settings"
                                hint="Answers workspace/configuration; nested or dotted keys."
                                value={raw.settings}
                                onChange={(v) => set("settings", v)}
                                onError={(bad) => setJsonError("settings", bad)}
                            />
                            <JsonField
                                label="initializationOptions"
                                hint="Sent verbatim in the initialize request."
                                value={raw.initializationOptions}
                                onChange={(v) => set("initializationOptions", v)}
                                onError={(bad) => setJsonError("initializationOptions", bad)}
                            />
                            <ListField
                                label="Disabled capabilities"
                                hint="Stripped from the initialize result, e.g. codeActionProvider."
                                values={asStrings(raw.disabledCapabilities)}
                                placeholder="e.g. codeActionProvider"
                                mono
                                onChange={(v) => set("disabledCapabilities", emptyToUndefined(v))}
                            />
                        </Section>
                    </>
                ) : (
                    <Section title="Execution" icon="run">
                        <Toggle
                            label="Use stdin"
                            hint="Off: ${file} is a temporary copy the formatter rewrites in place."
                            checked={raw.stdin !== false}
                            onChange={(on) => set("stdin", on ? undefined : false)}
                        />
                        <TextField
                            label="Success exit codes"
                            hint="Comma-separated."
                            value={numbers(raw.exitCodes, [0]).join(", ")}
                            placeholder="0"
                            mono
                            narrow
                            onChange={(v) => {
                                const codes = v
                                    .split(",")
                                    .map((s) => Number.parseInt(s.trim(), 10))
                                    .filter(Number.isInteger);
                                set("exitCodes", codes.length === 0 || stableJson(codes) === "[0]" ? undefined : codes);
                            }}
                        />
                    </Section>
                )}

                <Section title="Environment" icon="symbol-variable">
                    <KeyValueField
                        value={(raw.env as Record<string, string> | undefined) ?? {}}
                        onChange={(v) => set("env", Object.keys(v).length ? v : undefined)}
                    />
                </Section>
            </div>

            <footer class={`editor-foot ${dirty ? "dirty" : ""}`}>
                <div class="problems">
                    {problems.map((p) => (
                        <span class={blocking.includes(p) ? "problem" : "warning"}>
                            <i class={`codicon ${blocking.includes(p) ? "codicon-error" : "codicon-warning"}`} /> {p}
                        </span>
                    ))}
                    {problems.length === 0 && dirty && <span class="muted">Unsaved changes</span>}
                </div>
                <button class="btn secondary" disabled={!dirty || busy} onClick={revert}>
                    {props.isNew ? "Cancel" : "Revert"}
                </button>
                <button class="btn" disabled={!dirty || busy || blocking.length > 0} onClick={save} title="⌘S / Ctrl+S">
                    {busy ? "Saving…" : "Save"}
                </button>
            </footer>
        </div>
    );
}

// Each language/pattern runs every enabled formatter that lists it, in settings order.
function Chains(props: { entry: Entry; siblings: Entry[] }) {
    const targets = (e: Entry) => [...asStrings(e.raw.languages), ...asStrings(e.raw.filePatterns)];
    const mine = targets(props.entry);
    if (mine.length === 0) {
        return (
            <div class="kv">
                <span>Chain</span>
                <span class="muted">Matches no files yet</span>
            </div>
        );
    }
    return (
        <>
            {mine.map((target, i) => {
                const chain = props.siblings.filter(
                    (f) => (f.raw.enabled !== false || f === props.entry) && targets(f).includes(target),
                );
                return (
                    <div class="kv">
                        <span>{i === 0 ? "Chain" : ""}</span>
                        <span class="chain">
                            <code>{target}</code>
                            <i class="codicon codicon-arrow-small-right" />
                            {chain.map((f, j) => (
                                <>
                                    {j > 0 && <i class="codicon codicon-chevron-right" />}
                                    <span class={`step ${f === props.entry ? "self" : ""}`}>{f.name}</span>
                                </>
                            ))}
                        </span>
                    </div>
                );
            })}
        </>
    );
}

function Runtime(props: { kind: Kind; entry: Entry; siblings: Entry[] }) {
    const { entry } = props;
    const binary =
        entry.binary === undefined ? (
            <span class="muted">resolved per root</span>
        ) : entry.binary === null ? (
            <span class="problem">
                <i class="codicon codicon-error" /> not found on PATH or extra paths
            </span>
        ) : (
            <code>{entry.binary}</code>
        );
    return (
        <section class="card runtime">
            <div class="kv">
                <span>Executable</span>
                {binary}
            </div>
            {props.kind === "formatter" ? (
                <Chains entry={entry} siblings={props.siblings} />
            ) : entry.clients.length === 0 ? (
                <div class="kv">
                    <span>Processes</span>
                    <span class="muted">
                        {entry.status === "disabled" ? "Disabled" : "None — starts when a matching file opens"}
                    </span>
                </div>
            ) : (
                entry.clients.map((c, i) => <ClientRow key={i} client={c} />)
            )}
        </section>
    );
}

function ClientRow(props: { client: ClientInfo }) {
    const c = props.client;
    return (
        <div class="client">
            <div class="client-head">
                <StatusPill status={c.state} />
                {c.pid !== undefined && <span class="muted">pid {c.pid}</span>}
                <span class="muted">
                    {c.files} open file{c.files === 1 ? "" : "s"}
                </span>
            </div>
            <ul class="folders">
                {c.folders.map((f) => (
                    <li>
                        <i class="codicon codicon-folder" />
                        <code>{f}</code>
                    </li>
                ))}
                {c.venv && (
                    <li title="Launched as if this virtualenv were activated">
                        <i class="codicon codicon-package" />
                        <code>{c.venv}</code>
                        <span class="muted">venv</span>
                    </li>
                )}
            </ul>
        </div>
    );
}

// ---------- processes ----------

function ProcessesView(props: { state: UiState; log?: ShownLog; goto: (kind: Kind, name: string) => void }) {
    const processes = props.state.processes;
    const [selectedId, setSelectedId] = useState<number>();
    const current =
        processes.find((p) => p.id === selectedId) ??
        processes.find((p) => p.server === persisted.selected.process) ??
        processes[0];
    const select = (p: ProcessInfo) => {
        setSelectedId(p.id);
        persist({ selected: { ...persisted.selected, process: p.server } });
    };

    // Stream only the log on screen, and stop when this tab goes away.
    useEffect(() => {
        send({ type: "watchLog", server: current?.server });
    }, [current?.server]);
    useEffect(() => () => send({ type: "watchLog" }), []);

    const now = useNow();
    if (processes.length === 0) {
        return (
            <div class="empty">
                <i class="codicon codicon-server-process" />
                <h2>No servers running</h2>
                <p>Servers start when a file they attach to is opened.</p>
            </div>
        );
    }
    const enabled = (name: string) => props.state.servers.find((s) => s.name === name)?.raw.enabled !== false;

    return (
        <div class="split">
            <aside class="sidebar">
                <ul class="entries" role="listbox">
                    {processes.map((p) => (
                        <li
                            class={`entry ${p.id === current?.id ? "active" : ""}`}
                            role="option"
                            aria-selected={p.id === current?.id}
                            tabIndex={0}
                            onClick={() => select(p)}
                            onKeyDown={(e) => e.key === "Enter" && select(p)}
                        >
                            <span class={`dot ${p.state}`} title={statusText[p.state]} />
                            <span class="name">{p.server}</span>
                            <span class="sub">
                                {p.pid !== undefined ? `pid ${p.pid} · ` : ""}
                                {uptime(now - p.startedAt)} · {p.files.length} file{p.files.length === 1 ? "" : "s"}
                            </span>
                        </li>
                    ))}
                </ul>
            </aside>
            <main class="detail">
                {current && (
                    <ProcessDetail
                        key={current.id}
                        process={current}
                        now={now}
                        enabled={enabled(current.server)}
                        log={props.log?.server === current.server ? props.log.lines : []}
                        goto={props.goto}
                    />
                )}
            </main>
        </div>
    );
}

function ProcessDetail(props: {
    process: ProcessInfo;
    now: number;
    enabled: boolean;
    log: LogLine[];
    goto: (kind: Kind, name: string) => void;
}) {
    const p = props.process;
    return (
        <div class="editor">
            <div class="editor-head">
                <div class="title">
                    <StatusPill status={p.state} />
                    <span class="process-name">{p.server}</span>
                    {p.pid !== undefined && <span class="muted">pid {p.pid}</span>}
                </div>
                <div class="head-actions labelled">
                    <button class="btn secondary" onClick={() => send({ type: "restartProcess", id: p.id })}>
                        <i class="codicon codicon-debug-restart" /> Restart
                    </button>
                    <button
                        class="btn secondary"
                        onClick={() => send({ type: "stopProcess", id: p.id })}
                        title="Stop this process. It starts again when a matching file is opened or on Reload all."
                    >
                        <i class="codicon codicon-debug-stop" /> Stop
                    </button>
                    {props.enabled && (
                        <button
                            class="btn secondary"
                            onClick={() => send({ type: "setEnabled", kind: "server", name: p.server, enabled: false })}
                            title="Turn the server off in settings.json so it stays off"
                        >
                            <i class="codicon codicon-circle-slash" /> Disable
                        </button>
                    )}
                    <IconButton icon="output" title="Open in Output panel" onClick={() => send({ type: "showOutput", name: p.server })} />
                    <IconButton icon="edit" title="Edit server config" onClick={() => props.goto("server", p.server)} />
                </div>
            </div>
            <div class="editor-body process-body">
                <section class="card">
                    <div class="kv">
                        <span>Uptime</span>
                        <span>
                            {uptime(props.now - p.startedAt)}
                            {p.restarts > 0 && (
                                <span class="warning">&nbsp;· restarted {p.restarts}× after crashing</span>
                            )}
                        </span>
                    </div>
                    <div class="kv">
                        <span>Command</span>
                        <code>{p.argv.map(shellQuote).join(" ")}</code>
                    </div>
                    <div class="kv">
                        <span>Working dir</span>
                        <code>{p.cwd}</code>
                    </div>
                    {p.venv && (
                        <div class="kv">
                            <span>Virtualenv</span>
                            <code>{p.venv}</code>
                        </div>
                    )}
                </section>

                <div class="two-col cards">
                    <section class="card">
                        <div class="card-title">
                            <i class="codicon codicon-root-folder" /> Workspace folders
                        </div>
                        <ul class="folders">
                            {p.folders.map((f) => (
                                <li>
                                    <i class="codicon codicon-folder" />
                                    <code>{f}</code>
                                </li>
                            ))}
                        </ul>
                    </section>
                    <section class="card">
                        <div class="card-title">
                            <i class="codicon codicon-files" /> Attached files ({p.files.length})
                        </div>
                        {p.files.length === 0 ? (
                            <span class="muted">None open</span>
                        ) : (
                            <ul class="folders">
                                {p.files.map((f) => (
                                    <li>
                                        <i class="codicon codicon-file" />
                                        <button class="link" onClick={() => send({ type: "openFile", uri: f.uri })}>
                                            {f.path}
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                </div>

                <section class="card">
                    <div class="card-title">
                        <i class="codicon codicon-symbol-method" /> Capabilities
                    </div>
                    {p.capabilities.length === 0 ? (
                        <span class="muted">Not initialized yet</span>
                    ) : (
                        <div class="chips">
                            {p.capabilities.map((c) => {
                                const off = p.disabled.includes(c);
                                return (
                                    <span class={`cap ${off ? "off" : ""}`} title={off ? `${c} (disabledCapabilities)` : c}>
                                        {capabilityLabel(c)}
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </section>

                <details class="card config">
                    <summary class="card-title">
                        <i class="codicon codicon-settings" /> Effective config
                        <span class="muted"> — what this process runs with, variables expanded</span>
                    </summary>
                    <pre class="json">{JSON.stringify(p.config, null, 2)}</pre>
                </details>

                <LogView server={p.server} lines={props.log} />
            </div>
        </div>
    );
}

const levelRank: Record<LogLine["level"], number> = { trace: 0, debug: 1, output: 2, info: 2, warn: 3, error: 4 };

function LogView(props: { server: string; lines: LogLine[] }) {
    const [filter, setFilter] = useState("");
    const [minLevel, setMinLevel] = useState(0);
    const [follow, setFollow] = useState(true);
    const box = useRef<HTMLDivElement>(null);
    const shown = props.lines.filter(
        (l) => levelRank[l.level] >= minLevel && (!filter || l.text.toLowerCase().includes(filter.toLowerCase())),
    );
    useEffect(() => {
        if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
    }, [shown.length, follow]);
    return (
        <section class="card log-card">
            <div class="log-bar">
                <div class="card-title">
                    <i class="codicon codicon-output" /> Log
                </div>
                <label class="search small">
                    <i class="codicon codicon-filter" />
                    <input placeholder="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} />
                </label>
                <select value={String(minLevel)} onChange={(e) => setMinLevel(Number(e.currentTarget.value))}>
                    <option value="0">All levels</option>
                    <option value="2">Info and up</option>
                    <option value="3">Warnings and errors</option>
                    <option value="4">Errors</option>
                </select>
                <div class="toggle-inline">
                    <Switch checked={follow} label="Follow new lines" onChange={setFollow} />
                    <span class="muted">Follow</span>
                </div>
                <button class="btn ghost small" onClick={() => send({ type: "clearLog", server: props.server })}>
                    <i class="codicon codicon-clear-all" /> Clear
                </button>
            </div>
            <div
                class="log"
                ref={box}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    // Scrolling up pauses following; scrolling back to the bottom resumes it.
                    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
                }}
            >
                {shown.length === 0 ? (
                    <div class="muted log-empty">
                        {props.lines.length === 0 ? "Nothing logged yet." : "No lines match the filter."}
                    </div>
                ) : (
                    shown.slice(-2000).map((l) => (
                        <div class={`log-line ${l.level}`}>
                            <span class="log-time">{clock(l.time)}</span>
                            <span class="log-level">{l.level === "output" ? "" : l.level}</span>
                            <span class="log-text">{l.text}</span>
                        </div>
                    ))
                )}
            </div>
        </section>
    );
}

function useNow(): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    return now;
}

function uptime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function clock(time: number): string {
    return new Date(time).toTimeString().slice(0, 8);
}

function shellQuote(arg: string): string {
    return /^[\w@%+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

// "documentFormattingProvider" → "document formatting"
function capabilityLabel(capability: string): string {
    return capability
        .replace(/Provider$/, "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase();
}

// ---------- buffers ----------

const bufferServerText: Record<BufferServer["state"], string> = {
    running: "running",
    starting: "starting",
    stopped: "stopped",
    disabled: "disabled",
    missing: "not installed",
    noRoot: "no root marker",
    pending: "not attached yet",
};

function BuffersView(props: { buffers: BufferInfo[]; formatters: Entry[]; goto: (kind: Kind, name: string) => void }) {
    const [filter, setFilter] = useState("");
    const [showHidden, setShowHidden] = useState(false);
    const hiddenCount = props.buffers.filter((b) => b.hidden).length;
    const visible = props.buffers.filter(
        (b) =>
            (showHidden || !b.hidden) &&
            (!filter || `${b.path} ${b.language}`.toLowerCase().includes(filter.toLowerCase())),
    );
    return (
        <div class="buffers">
            <div class="buffers-bar">
                <label class="search">
                    <i class="codicon codicon-filter" />
                    <input
                        placeholder="Filter files"
                        value={filter}
                        onInput={(e) => setFilter(e.currentTarget.value)}
                    />
                </label>
                {hiddenCount > 0 && (
                    <div class="toggle-inline">
                        <Switch checked={showHidden} label="Show hidden buffers" onChange={setShowHidden} />
                        <span class="muted">
                            {hiddenCount} hidden buffer{hiddenCount === 1 ? "" : "s"} (loaded, not in a tab)
                        </span>
                    </div>
                )}
            </div>
            {visible.length === 0 ? (
                <div class="empty">
                    <i class="codicon codicon-files" />
                    <h2>No files open</h2>
                    <p>Open a file to see which servers attach to it and what formats it.</p>
                </div>
            ) : (
                <ul class="buffer-list">
                    {visible.map((b) => (
                        <BufferCard key={b.uri} buffer={b} goto={props.goto} />
                    ))}
                </ul>
            )}
        </div>
    );
}

function BufferCard(props: { buffer: BufferInfo; goto: (kind: Kind, name: string) => void }) {
    const b = props.buffer;
    const slash = b.path.lastIndexOf("/");
    return (
        <li class={`buffer ${b.active ? "active" : ""} ${b.hidden ? "hidden" : ""}`}>
            <div class="buffer-head">
                <i class="codicon codicon-file" />
                <button class="link file" onClick={() => send({ type: "openFile", uri: b.uri })} title={`Open ${b.path}`}>
                    <span class="muted">{b.path.slice(0, slash + 1)}</span>
                    {b.path.slice(slash + 1)}
                </button>
                <span class="badge lang">{b.language}</span>
                {b.active && <span class="tag">active</span>}
                {b.hidden && <span class="tag">hidden</span>}
            </div>
            <div class="buffer-rows">
                <div class="buffer-row">
                    <span class="row-label">Servers</span>
                    <span class="chips">
                        {b.servers.length === 0 ? (
                            <span class="muted">No configured server matches this file</span>
                        ) : (
                            b.servers.map((s) => (
                                <button
                                    class={`chip ${s.state}`}
                                    onClick={() => props.goto("server", s.name)}
                                    title={s.root ? `${s.name}: ${bufferServerText[s.state]} in ${s.root}` : `${s.name}: ${bufferServerText[s.state]}`}
                                >
                                    <span class={`dot ${chipDot(s.state)}`} />
                                    <span class="chip-name">{s.name}</span>
                                    {s.root ? (
                                        <code class="chip-detail">
                                            {s.root}
                                            {s.venv && ` · venv ${s.venv.slice(s.venv.lastIndexOf("/") + 1)}`}
                                        </code>
                                    ) : (
                                        s.state !== "running" && <span class="chip-detail">{bufferServerText[s.state]}</span>
                                    )}
                                </button>
                            ))
                        )}
                    </span>
                </div>
                <div class="buffer-row">
                    <span class="row-label">Formatter</span>
                    <FormatChips buffer={b} goto={props.goto} />
                </div>
            </div>
        </li>
    );
}

function FormatChips(props: { buffer: BufferInfo; goto: (kind: Kind, name: string) => void }) {
    const f = props.buffer.format;
    if (f.kind === "none") return <span class="chips muted">Nothing formats this file</span>;
    if (f.kind === "server") {
        return (
            <span class="chips">
                <button class="chip running" onClick={() => props.goto("server", f.server)}>
                    <i class="codicon codicon-server-process" />
                    <span class="chip-name">{f.server}</span>
                    <span class="chip-detail">LSP · {f.mode === "prefer" ? "prefer, beats CLI formatters" : "fallback"}</span>
                </button>
            </span>
        );
    }
    return (
        <span class="chips chain">
            <span class="tag">CLI</span>
            {f.steps.map((step, i) => (
                <>
                    {i > 0 && <i class="codicon codicon-chevron-right" />}
                    <button
                        class={`chip ${step.installed ? "" : "skipped"}`}
                        onClick={() => props.goto("formatter", step.name)}
                        title={step.installed ? step.name : `${step.name} is not installed and will be skipped`}
                    >
                        <span class="chip-name">{step.name}</span>
                        {!step.installed && <span class="chip-detail">skipped, not installed</span>}
                    </button>
                </>
            ))}
        </span>
    );
}

function chipDot(state: BufferServer["state"]): Status {
    if (state === "noRoot" || state === "pending") return "idle";
    return state;
}

// ---------- paths ----------

function PathsView(props: { paths: UiState["extraPaths"] }) {
    const initial = props.paths.map((p) => p.path);
    const [paths, setPaths] = useState(initial);
    const dirty = stableJson(paths) !== stableJson(initial);
    useEffect(() => {
        if (!dirty) setPaths(initial);
    }, [stableJson(initial)]);
    const exists = new Map(props.paths.map((p) => [p.path, p.exists]));
    return (
        <div class="paths">
            <Section title="Extra search paths" icon="folder-library">
                <p class="hint">
                    Searched after PATH for server and formatter commands, and appended to their PATH. Point this at
                    Mason's bin folder to use bare command names.
                </p>
                <ListField
                    label="Directories"
                    values={paths}
                    mono
                    placeholder="~/.local/share/nvim/mason/bin"
                    onChange={setPaths}
                    decorate={(v) =>
                        v && exists.has(v) && !exists.get(v) ? (
                            <span class="warning" title="Directory does not exist">
                                <i class="codicon codicon-warning" />
                            </span>
                        ) : null
                    }
                />
            </Section>
            <footer class={`editor-foot ${dirty ? "dirty" : ""}`}>
                <div class="problems">{dirty && <span class="muted">Unsaved changes</span>}</div>
                <button class="btn secondary" disabled={!dirty} onClick={() => setPaths(initial)}>
                    Revert
                </button>
                <button
                    class="btn"
                    disabled={!dirty}
                    onClick={() => send({ type: "saveExtraPaths", paths: paths.filter(Boolean) })}
                >
                    Save
                </button>
            </footer>
        </div>
    );
}

// ---------- fields ----------

function Section(props: { title: string; icon: string; children: ComponentChildren }) {
    return (
        <section class="section">
            <h3>
                <i class={`codicon codicon-${props.icon}`} /> {props.title}
            </h3>
            <div class="section-body">{props.children}</div>
        </section>
    );
}

function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
    return (
        <div class="field">
            <div class="label">{props.label}</div>
            {props.hint && <div class="hint">{props.hint}</div>}
            {props.children}
        </div>
    );
}

function TextField(props: {
    label: string;
    hint?: string;
    value: string;
    placeholder?: string;
    mono?: boolean;
    narrow?: boolean;
    onChange: (v: string) => void;
}) {
    return (
        <Field label={props.label} hint={props.hint}>
            <input
                class={`${props.mono ? "mono" : ""} ${props.narrow ? "narrow" : ""}`}
                value={props.value}
                placeholder={props.placeholder}
                onInput={(e) => props.onChange(e.currentTarget.value)}
            />
        </Field>
    );
}

// Keeps a trailing empty row locally so typing into a fresh row doesn't vanish before it has a value.
function ListField(props: {
    label: string;
    hint?: string;
    values: string[];
    placeholder?: string;
    mono?: boolean;
    onChange: (v: string[]) => void;
    decorate?: (value: string) => ComponentChildren;
}) {
    const [rows, setRows] = useState<string[]>(props.values);
    const refs = useRef<(HTMLInputElement | null)[]>([]);
    const focusIndex = useRef<number>();
    useEffect(() => {
        if (!sameRows(rows, props.values)) setRows(props.values);
    }, [stableJson(props.values)]);
    useEffect(() => {
        if (focusIndex.current !== undefined) refs.current[focusIndex.current]?.focus();
        focusIndex.current = undefined;
    });
    const update = (next: string[]) => {
        setRows(next);
        props.onChange(next.filter((v) => v !== ""));
    };
    const add = (at = rows.length) => {
        focusIndex.current = at;
        update([...rows.slice(0, at), "", ...rows.slice(at)]);
    };
    return (
        <Field label={props.label} hint={props.hint}>
            <div class="list-field">
                {rows.map((value, i) => (
                    <div class="list-row">
                        <input
                            ref={(el) => {
                                refs.current[i] = el;
                            }}
                            class={props.mono ? "mono" : ""}
                            value={value}
                            placeholder={props.placeholder}
                            onInput={(e) => update(rows.map((v, j) => (j === i ? e.currentTarget.value : v)))}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    add(i + 1);
                                } else if (e.key === "Backspace" && value === "" && rows.length > 0) {
                                    e.preventDefault();
                                    focusIndex.current = Math.max(0, i - 1);
                                    update(rows.filter((_, j) => j !== i));
                                }
                            }}
                        />
                        {props.decorate?.(value)}
                        <IconButton
                            icon="close"
                            title="Remove"
                            onClick={() => update(rows.filter((_, j) => j !== i))}
                        />
                    </div>
                ))}
                <button class="btn ghost small" onClick={() => add()}>
                    <i class="codicon codicon-add" /> Add
                </button>
            </div>
        </Field>
    );
}

function MarkerField(props: { value: unknown; hint: string; onChange: (v: unknown) => void }) {
    const levels = (Array.isArray(props.value) ? props.value : []).map((level) =>
        Array.isArray(level) ? level.join(", ") : String(level),
    );
    return (
        <ListField
            label="Root markers"
            hint={props.hint}
            values={levels}
            mono
            placeholder="e.g. Cargo.toml   or   package-lock.json, yarn.lock"
            onChange={(rows) => {
                const parsed = rows.map((row) => {
                    const names = row
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                    return names.length === 1 ? names[0] : names;
                });
                props.onChange(parsed.length ? parsed : undefined);
            }}
        />
    );
}

function Toggle(props: { label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
    return (
        <div class="toggle-field">
            <Switch checked={props.checked} label={props.label} onChange={props.onChange} />
            <div>
                <div class="label">{props.label}</div>
                {props.hint && <div class="hint">{props.hint}</div>}
            </div>
        </div>
    );
}

function Switch(props: { checked: boolean; label: string; onChange: (on: boolean) => void }) {
    return (
        <button
            role="switch"
            aria-checked={props.checked}
            aria-label={props.label}
            title={props.label}
            class={`switch ${props.checked ? "on" : ""}`}
            onClick={() => props.onChange(!props.checked)}
        >
            <span class="knob" />
        </button>
    );
}

function Segmented(props: {
    label: string;
    value: string;
    options: [string, string, string][];
    onChange: (v: string) => void;
}) {
    const description = props.options.find(([v]) => v === props.value)?.[2];
    return (
        <Field label={props.label} hint={description}>
            <div class="segmented" role="radiogroup">
                {props.options.map(([value, label]) => (
                    <button
                        role="radio"
                        aria-checked={props.value === value}
                        class={props.value === value ? "on" : ""}
                        onClick={() => props.onChange(value)}
                    >
                        {label}
                    </button>
                ))}
            </div>
        </Field>
    );
}

function JsonField(props: {
    label: string;
    hint: string;
    value: unknown;
    onChange: (v: unknown) => void;
    onError: (bad: boolean) => void;
}) {
    const format = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
    const [text, setText] = useState(format(props.value));
    const [error, setError] = useState<string>();
    useEffect(() => {
        if (!error && stableJson(parseOr(text)) !== stableJson(props.value)) setText(format(props.value));
    }, [stableJson(props.value)]);
    const lines = Math.min(18, Math.max(3, text.split("\n").length));
    return (
        <Field label={props.label} hint={props.hint}>
            <textarea
                class={`mono ${error ? "invalid" : ""}`}
                rows={lines}
                spellcheck={false}
                value={text}
                placeholder="{ }"
                onInput={(e) => {
                    const next = e.currentTarget.value;
                    setText(next);
                    if (next.trim() === "") {
                        setError(undefined);
                        props.onError(false);
                        props.onChange(undefined);
                        return;
                    }
                    try {
                        props.onChange(JSON.parse(next));
                        setError(undefined);
                        props.onError(false);
                    } catch (err) {
                        setError(err instanceof Error ? err.message : String(err));
                        props.onError(true);
                    }
                }}
            />
            {error && (
                <div class="problem">
                    <i class="codicon codicon-error" /> {error}
                </div>
            )}
        </Field>
    );
}

function KeyValueField(props: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
    const [rows, setRows] = useState<[string, string][]>(Object.entries(props.value));
    useEffect(() => {
        if (stableJson(Object.fromEntries(rows.filter(([k]) => k))) !== stableJson(props.value)) {
            setRows(Object.entries(props.value));
        }
    }, [stableJson(props.value)]);
    const update = (next: [string, string][]) => {
        setRows(next);
        props.onChange(Object.fromEntries(next.filter(([k]) => k)));
    };
    return (
        <Field label="Variables" hint="Added to the process environment; PATH also gets the extra paths appended.">
            <div class="list-field">
                {rows.map(([k, v], i) => (
                    <div class="list-row kv-row">
                        <input
                            class="mono"
                            value={k}
                            placeholder="NAME"
                            onInput={(e) => update(rows.map((r, j) => (j === i ? [e.currentTarget.value, r[1]] : r)))}
                        />
                        <span class="eq">=</span>
                        <input
                            class="mono"
                            value={v}
                            placeholder="value"
                            onInput={(e) => update(rows.map((r, j) => (j === i ? [r[0], e.currentTarget.value] : r)))}
                        />
                        <IconButton icon="close" title="Remove" onClick={() => update(rows.filter((_, j) => j !== i))} />
                    </div>
                ))}
                <button class="btn ghost small" onClick={() => setRows([...rows, ["", ""]])}>
                    <i class="codicon codicon-add" /> Add variable
                </button>
            </div>
        </Field>
    );
}

function StatusPill(props: { status: Status | ClientInfo["state"]; kind?: Kind }) {
    return (
        <span class={`pill ${props.status}`}>
            <span class={`dot ${props.status}`} />
            {statusLabel(props.kind ?? "server", props.status as Status)}
        </span>
    );
}

function IconButton(props: { icon: string; title: string; disabled?: boolean; onClick: () => void }) {
    return (
        <button class="icon-btn" title={props.title} aria-label={props.title} disabled={props.disabled} onClick={props.onClick}>
            <i class={`codicon codicon-${props.icon}`} />
        </button>
    );
}

// ---------- helpers ----------

function asStrings(v: unknown): string[] {
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asString(v: unknown): string {
    return typeof v === "string" ? v : "";
}

function numbers(v: unknown, fallback: number[]): number[] {
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : fallback;
}

function emptyToUndefined(v: string[]): string[] | undefined {
    return v.length ? v : undefined;
}

function parseOr(text: string): unknown {
    try {
        return text.trim() ? JSON.parse(text) : undefined;
    } catch {
        return undefined;
    }
}

// Drops keys whose value is empty so a saved entry stays as small as a hand-written one.
function clean(raw: Raw): Raw {
    return Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)),
    );
}

// Key order is irrelevant to settings, so toggling a key off and on again isn't an edit.
function stableJson(v: unknown): string {
    return JSON.stringify(v ?? null, (_, value) =>
        value && typeof value === "object" && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
    );
}

// "a,b" and "a, b" are the same marker group; only resync a list when its meaning changed.
function sameRows(a: string[], b: string[]): boolean {
    const norm = (rows: string[]) =>
        rows.filter(Boolean).map((r) =>
            r
                .split(",")
                .map((t) => t.trim())
                .join(","),
        );
    return stableJson(norm(a)) === stableJson(norm(b));
}

render(<App />, document.getElementById("app")!);
