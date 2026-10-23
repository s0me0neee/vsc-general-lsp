# General LSP

One VS Code extension for every language server, configured like nvim-lspconfig. Every standard LSP feature
(completion, hover, definition, references, rename, code actions, formatting, semantic tokens, inlay hints,
call/type hierarchy, diagnostics, …) comes from `vscode-languageclient`; this extension only decides which server
runs for which file and where its root is.

## Configuration

```jsonc
"generalLsp.servers": {
  "rust-analyzer": {
    "command": ["rust-analyzer"],
    "languages": ["rust"],
    "rootMarkers": ["Cargo.toml", ".git"],
    "settings": { "rust-analyzer": { "check": { "command": "clippy" } } }
  },
  "ts": {
    "command": ["typescript-language-server", "--stdio"],
    "languages": ["typescript", "typescriptreact", "javascript", "javascriptreact"],
    "rootMarkers": [["tsconfig.json", "package.json"], ".git"]
  },
  "zls": {
    "command": ["zls"],
    "filePatterns": ["*.zig", "*.zon"],   // files VS Code has no language for
    "rootMarkers": ["build.zig"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `command` | Executable + args: on `PATH` (or `env.PATH`/`extraPaths`), absolute, or `./…` relative to the root. |
| `languages` | VS Code language IDs. |
| `filePatterns` | Globs on the file path; unless absolute or starting with `**/`, they match at any depth (`*.zig` → `**/*.zig`). |
| `rootMarkers` | Tried in priority order; a nested array is one equal-priority group. Globs like `*.csproj` work. |
| `singleFileSupport` | Default `true`. If `false` and no marker is found, the server does not attach. |
| `fallbackRoot` | Root for files with no marker, e.g. an empty scratch dir so a loose `.rs` file doesn't index `~`. |
| `venv` | `true` (or a list of folder names): launch as if the nearest Python virtualenv (`.venv`, `venv`, `env`, at or above the root) were activated — `VIRTUAL_ENV` set and its `bin` first on `PATH`, which also resolves `command`. What an activated shell gives nvim. Roots with different venvs get separate processes. |
| `settings` | Answers `workspace/configuration` and is pushed via `didChangeConfiguration`. Nested, or dotted top-level keys (`"rust-analyzer.check.command"`); deeper keys such as `yaml.schemas` URLs keep their dots. |
| `disabledCapabilities` | Capabilities stripped from the `initialize` result, like `server_capabilities.X = false` in `on_init`. |
| `format` | `fallback` (default): formats only files no CLI formatter matches. `prefer`: formats its files even then. `never`: never formats. |
| `multiRoot` | Default `true`: a new root joins a running client as a workspace folder when the server supports it. `false`: one client per root (nvim's default). |
| `enabled` | `false` turns the server off but keeps its config; toggled by **Enable/Disable Server…**. |
| `initializationOptions`, `env` | As named. |

Variables: `~` and `${userHome}` in `command`, `env` and `fallbackRoot`; `${root}`, `${rootName}` and `${rootUri}` in
`command`, `env`, `settings` and `initializationOptions` (e.g. a per-project jdtls `-data` dir).

Attachment works like nvim's: each open file gets a root (nearest marker → `fallbackRoot` → workspace folder → file's
directory) and is attached to exactly one client per server — the one whose workspace folders include that root
(`reuse_client`). A new root is added to the running client via `workspace/didChangeWorkspaceFolders` when the server
supports it and `multiRoot` is on; otherwise it gets its own process. A client never syncs or answers for files it
isn't attached to, so nested roots aren't served twice. `fallbackRoot` clients only serve loose files. Server
commands (`executeCommandProvider`) are registered once and routed to the client serving the active editor.

Each server runs in its own process group. Stopping a server, quitting VS Code, or the extension host being
killed outright terminates the whole group (SIGTERM, then SIGKILL after 1s), including anything the server
spawned. A small watchdog process notices the extension host disappearing via stdin EOF.

`generalLsp.extraPaths` lists directories searched after `PATH` (e.g. `~/.local/share/nvim/mason/bin`), so
commands can be bare names whether they're installed globally or by Mason.

`generalLsp.idleTimeout` (seconds, default `0` = never) stops a server once its last attached file has been closed
for that long.

An entry with a wrongly typed field (say `"languages": "rust"`) is skipped and reported; the others keep working.

## Problems and notifications

Errors and warnings from General LSP itself are reported in one place:

- A notification with **Show problems** / **Show log** — at most once per 5 minutes for the same problem, so format on
  save or a crash loop doesn't flood you.
- The status bar item shows an error/warning badge with the number of unseen problems, even where no server is
  attached; clicking it opens the **Problems** tab.
- The *General LSP* output channel logs every one.

Reported: invalid settings entries, missing executables, servers that fail to start, crash and get restarted, or stop
for good, formatter failures and timeouts, formatters that aren't installed and server commands owned by another
extension (these last two are listed without a pop-up), and unexpected internal errors.

## Formatters

Command-line formatters, matched the same way as servers, in the spirit of conform.nvim:

```jsonc
"generalLsp.formatters": {
  "goimports": { "command": ["goimports", "-srcdir", "${fileDirname}"], "languages": ["go"] },
  "gofumpt": { "command": ["gofumpt"], "languages": ["go"] },
  "stylua": {
    "command": ["stylua", "--search-parent-directories", "--stdin-filepath", "${file}", "-"],
    "languages": ["lua"],
    "rootMarkers": [[".stylua.toml", "stylua.toml"]]
  },
  "markdownlint-cli2": {
    "command": ["markdownlint-cli2", "--fix", "${file}"],
    "languages": ["markdown"],
    "stdin": false,          // rewrites a temporary sibling copy named by ${file}
    "exitCodes": [0, 1]
  }
}
```

- Every formatter matching a file runs, in settings order, each fed the previous output.
- A file with a matching formatter doesn't use LSP formatting (conform's `lsp_format = "fallback"`) unless a server
  attached to it has `"format": "prefer"`; otherwise the first server in settings order that can format it does.
  Range formatting (format on paste) is LSP-only.
- An uninstalled formatter is skipped; a failing one aborts the chain and leaves the file untouched. Both are logged
  to the *General LSP: formatters* output channel and listed under Problems.
- `timeout` (ms, default 10000) kills a formatter that hangs, like conform's `timeout_ms`.
- `./…` commands run relative to the formatter's working directory, e.g. `["./node_modules/.bin/prettier", …]`.
- `rootMarkers` sets the working directory and `${root}`; `requireRoot` skips the formatter without one.
- The extension registers a single formatting provider, so it can be the `editor.defaultFormatter` for any of these
  languages without VS Code asking which formatter to use.

## Settings UI

**General LSP: Open Settings** (or click the status bar item) opens an editor for servers, formatters and extra
paths, without touching settings.json by hand:

- **Buffers** lists every open file (focused first; hidden buffers behind a toggle) with each matching server —
  attached with its root, or why not: disabled, not installed, no root marker — and exactly what formats it: the
  CLI chain (uninstalled steps marked as skipped), or the LSP server and whether it's `prefer` or `fallback`.
  Click a file to open it, or a chip to jump to that server or formatter.
- **Processes** lists every running server process: state, pid, uptime and crash restarts, the exact command line,
  working dir, venv, workspace folders, attached files, advertised capabilities (stripped ones struck through), the
  effective config with variables expanded, and a live log tail (filter, level, follow). **Stop** turns that one
  process off until a matching file opens again or **Reload all**; **Disable** turns the server off in settings.
- **Problems** lists recent errors and warnings, newest first, with their source (linking to that server or
  formatter), time and repeat count.
- Live state per server: running/starting/stopped/not installed, the resolved executable, each process's pid,
  workspace folders and number of attached files, with restart/stop/output buttons.
- Forms for every option, a JSON editor with validation for `settings`/`initializationOptions`, and a key/value
  editor for `env`. Root markers are one row per priority level, comma-separated within a level.
- Formatters show the chain each of their languages runs, e.g. `go → goimports › gofumpt`; arrows reorder
  entries (chain order for formatters, formatting priority for servers) without restarting anything.
- Enable/disable switches, duplicate, rename and delete. Edits are saved to the scope (User or Workspace) the entry
  is defined in; ⌘S/Ctrl+S saves. Saving rewrites the whole `generalLsp.servers`/`formatters` value, so comments
  inside it are lost.

Commands: **Open Settings**, **Restart Server**, **Stop Server**,
**Reload Settings and Restart All Servers**, **Enable Server…** and **Disable Server…** (the last two take an optional
server name argument, for keybindings).
For protocol tracing, set the server's output channel log level to *Trace*.

## Limitations

- Server-specific, non-standard requests (rust-analyzer's expand macro / runnables, clangd's switch header/source)
  and client-side commands referenced by code lenses are not implemented.
- Debugging (DAP), test explorers and syntax grammars are outside LSP; files matched only by `filePatterns`
  open as `plaintext` and get highlighting only from semantic tokens.
- Workspace folders are only ever added, never removed, for the life of a client (nvim behaves the same).
- In untrusted workspaces, `generalLsp.servers`, `formatters` and `extraPaths` from workspace settings are ignored.

## Development

```sh
bun install
bun run build        # or F5 in VS Code
VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code" bun run test   # omit to download VS Code
bun run package      # .vsix
```

Tests need `gopls`, `clangd` and `node` on `PATH`, and run on macOS/Linux. `ONLY=<regex>` runs a subset (tests still
run in order, so pick ones that don't rely on earlier ones) and `DEBUG_TESTS=1` prints when each starts.
`test/fixture/bin/glsp-fake-server` is a tiny LSP server for cases real servers can't trigger on demand: slow starts,
crash loops, dynamically registered commands and stderr without a trailing newline.
