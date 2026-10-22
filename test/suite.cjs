const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const fixture = process.env.FIXTURE;

async function waitFor(fn, what, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function posOf(doc, needle) {
  return doc.positionAt(doc.getText().indexOf(needle));
}

async function open(rel) {
  const doc = await vscode.workspace.openTextDocument(path.join(fixture, rel));
  await vscode.window.showTextDocument(doc);
  return doc;
}

// Applies the provider's edits to the open document without saving it.
async function formatted(rel) {
  const doc = await open(rel);
  const edits = await vscode.commands.executeCommand("vscode.executeFormatDocumentProvider", doc.uri, {
    tabSize: 4,
    insertSpaces: false,
  });
  if (edits?.length) {
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, edits);
    await vscode.workspace.applyEdit(edit);
  }
  return doc.getText();
}

// Waits for the restarted gopls to finish initializing so its formatting capability is known.
async function setGoplsFormat(api, format) {
  const config = vscode.workspace.getConfiguration("generalLsp");
  const servers = config.inspect("servers").workspaceValue;
  await config.update("servers", { ...servers, gopls: { ...servers.gopls, format } }, vscode.ConfigurationTarget.Workspace);
  await waitFor(() => {
    const rc = runningClient(api, "gopls");
    return rc?.server.format === format && rc.formatting.static.has("document");
  }, `gopls with format ${format}`);
}

function owners(api, doc, name) {
  return api.runningClients().filter((rc) => rc.server.name === name && rc.docs.has(doc.uri.toString()));
}

function runningClient(api, name) {
  return api.runningClients().find((rc) => rc.server.name === name && rc.client.isRunning());
}

const tests = {
  async "gopls attaches by language at the nearest go.mod"(api) {
    const doc = await open("gomod/main.go");
    const gopls = await waitFor(() => runningClient(api, "gopls"), "gopls");
    assert.equal(gopls.root, path.join(fixture, "gomod"));

    const defs = await waitFor(async () => {
      const d = await vscode.commands.executeCommand("vscode.executeDefinitionProvider", doc.uri, posOf(doc, "greet())"));
      return d?.length ? d : undefined;
    }, "definition");
    assert.equal((defs[0].targetRange ?? defs[0].range).start.line, 4);
  },

  async "settings are served to workspace/configuration"(_api) {
    const doc = await open("gomod/main.go");
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, posOf(doc, "Println"));
    const text = hovers.flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value))).join("\n");
    assert.match(text, /Println/);
    // hoverKind=NoDocumentation comes from the dotted "gopls.hoverKind" key.
    assert.doesNotMatch(text, /default formats/);
  },

  async "clangd attaches by file pattern with diagnostics and symbols"(api) {
    const doc = await open("c/hello.c");
    const clangd = await waitFor(() => runningClient(api, "clangd"), "clangd");
    assert.equal(clangd.root, fixture);

    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(doc.uri);
      return d.length ? d : undefined;
    }, "diagnostics");
    assert.match(diags.map((d) => d.message).join("\n"), /undefined_name/);

    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri);
    assert.deepEqual(symbols.map((s) => s.name), ["add", "main"]);
  },

  async "command expands ${rootName}"(_api) {
    assert.equal(fs.readFileSync(path.join(fixture, "gomod/root.name"), "utf8").trim(), "gomod");
  },

  async "loose files use fallbackRoot and disabledCapabilities are stripped"(api) {
    const doc = await open("loose/scratch.cc");
    // Also a second clangd alongside the first: their shared command ids must not collide.
    const rc = await waitFor(() => runningClient(api, "clangd-loose"), "clangd-loose");
    assert.ok(runningClient(api, "clangd"));
    assert.ok((await vscode.commands.getCommands(true)).includes("clangd.applyFix"));
    assert.equal(rc.root, path.join(fixture, "scratch-root"));
    assert.ok(fs.existsSync(rc.root));

    // Diagnostics prove the file outside the root was still synced to the server.
    const diags = await waitFor(() => {
      const d = vscode.languages.getDiagnostics(doc.uri);
      return d.length ? d : undefined;
    }, "diagnostics");
    assert.match(diags.map((d) => d.message).join("\n"), /missing_name/);

    assert.equal(rc.client.initializeResult.capabilities.documentSymbolProvider, undefined);
    const symbols = await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri);
    assert.equal(symbols?.length ?? 0, 0);
  },

  // The chain also contains an uninstalled formatter, which must be skipped.
  async "venv: each root runs inside its own activated virtualenv"(api) {
    await open("py/app.probe");
    await open("py2/app.probe");
    const probes = await waitFor(() => {
      const clients = api.runningClients().filter((rc) => rc.server.name === "venv-probe" && rc.client.isRunning());
      return clients.length === 2 ? clients : undefined;
    }, "two venv-probe clients");
    for (const [project, venv] of [["py", "venv"], ["py2", ".venv"]]) {
      const expected = path.join(fixture, project, venv);
      const rc = probes.find((p) => p.root === path.join(fixture, project));
      assert.equal(rc.venv, expected);
      // The probe binary only exists in the venv, and it saw VIRTUAL_ENV set.
      const seen = await waitFor(() => {
        try {
          return fs.readFileSync(path.join(fixture, project, "venv.out"), "utf8").trim();
        } catch {
          return undefined;
        }
      }, `${project}/venv.out`);
      assert.equal(seen, expected);
    }
  },

  async "formatters chain in settings order via extraPaths"(_api) {
    assert.equal(await formatted("fmt/a.up"), "HELLO;\nWORLD;\n");
  },

  async "non-stdin formatters rewrite a temporary sibling"(_api) {
    assert.equal(await formatted("fmt/x.inplace"), "rewritten .general-lsp\n");
    assert.deepEqual(fs.readdirSync(path.join(fixture, "fmt")).filter((f) => f.startsWith(".general-lsp")), []);
  },

  async "a failing formatter leaves the file alone"(_api) {
    assert.equal(await formatted("fmt/z.broken"), "unchanged\n");
  },

  async "formatters win over LSP formatting"(api) {
    await open("c/fmtme.c");
    await waitFor(() => runningClient(api, "clangd"), "clangd");
    assert.equal(await formatted("c/fmtme.c"), "INT X;\n");
  },

  async "LSP formatting is used when no formatter matches"(_api) {
    const text = await waitFor(async () => {
      const t = await formatted("gomod/ugly.go");
      return t.includes("func ugly() {}") ? t : undefined;
    }, "gopls formatting");
    assert.equal(text, "package main\n\nfunc ugly() {}\n");
  },

  async "a nested root joins the running client as a workspace folder"(api) {
    const doc = await open("gomod/inner/inner.go");
    const gopls = await waitFor(() => {
      const rc = runningClient(api, "gopls");
      return rc?.folders.length === 2 ? rc : undefined;
    }, "inner folder added");
    assert.deepEqual(gopls.folders, [path.join(fixture, "gomod"), path.join(fixture, "gomod/inner")]);
    assert.equal(api.runningClients().filter((rc) => rc.server.name === "gopls").length, 1);
    assert.equal(owners(api, doc, "gopls").length, 1);
    const hover = await waitFor(async () => {
      const h = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, posOf(doc, "Println"));
      return h?.length ? h : undefined;
    }, "hover in the added folder");
    assert.ok(hover.length > 0);
  },

  async "multiRoot false gives one client per root, each file attached once"(api) {
    const config = vscode.workspace.getConfiguration("generalLsp");
    const servers = config.inspect("servers").workspaceValue;
    await config.update("servers", { ...servers, gopls: { ...servers.gopls, multiRoot: false } }, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => {
      const clients = api.runningClients().filter((rc) => rc.server.name === "gopls" && rc.client.isRunning());
      return clients.length === 2 && clients.every((rc) => rc.server.multiRoot === false);
    }, "two gopls clients");
    for (const rel of ["gomod/main.go", "gomod/inner/inner.go"]) {
      const doc = await open(rel);
      const docOwners = owners(api, doc, "gopls");
      assert.equal(docOwners.length, 1, rel);
      assert.equal(docOwners[0].root, path.dirname(doc.uri.fsPath), rel);
      // The other gopls never hears about the file, so it can't answer for it either.
      const synced = api.runningClients().filter((rc) => rc.server.name === "gopls" && rc.opened.has(doc.uri.toString()));
      assert.deepEqual(synced, docOwners, rel);
      const hovers = await waitFor(async () => {
        const h = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, posOf(doc, "Println"));
        return h?.length ? h : undefined;
      }, `hover in ${rel}`);
      assert.equal(hovers.length, 1, rel);
    }
  },

  async "reloadAll restarts every server"(api) {
    const before = new Set(api.runningClients().map((rc) => rc.client));
    await vscode.commands.executeCommand("generalLsp.reloadAll");
    for (const name of ["gopls", "clangd"]) {
      await waitFor(() => {
        const rc = runningClient(api, name);
        return rc && !before.has(rc.client);
      }, `fresh ${name}`);
    }
    assert.ok(api.runningClients().every((rc) => !before.has(rc.client)));
  },

  async "disable and enable a server keep its config"(api) {
    const servers = () => vscode.workspace.getConfiguration("generalLsp").inspect("servers").workspaceValue;
    await vscode.commands.executeCommand("generalLsp.disable", "clangd");
    await waitFor(() => !api.runningClients().some((rc) => rc.server.name === "clangd"), "clangd to stop");
    assert.equal(servers().clangd.enabled, false);
    assert.deepEqual(servers().clangd.command, ["clangd"]);

    await vscode.commands.executeCommand("generalLsp.enable", "clangd");
    await waitFor(() => runningClient(api, "clangd"), "clangd to restart");
    assert.equal("enabled" in servers().clangd, false);
  },

  async "format: prefer beats matching CLI formatters"(api) {
    await setGoplsFormat(api, "prefer");
    assert.equal(await formatted("gomod/prefer.go"), "package main\n\nfunc p() {}\n");
  },

  async "format: never turns a server's formatting off"(api) {
    await setGoplsFormat(api, "never");
    assert.equal(await formatted("gomod/never.go"), "package main\n\nfunc  n( ) {}\n");
  },

  async "settings UI opens and reports live state"(api) {
    const panel = await vscode.commands.executeCommand("generalLsp.openSettings");
    assert.equal(panel.title, "General LSP");
    for (const asset of ["main.js", "main.css"]) assert.ok(panel.webview.html.includes(asset), asset);
    await waitFor(() => api.webviewReadyCount() > 0, "webview script to boot under the CSP");
    const state = api.uiState();
    const gopls = state.servers.find((s) => s.name === "gopls");
    assert.equal(gopls.status, "running");
    // The runner wraps gopls in `sh -c`, so the resolved executable is the shell.
    assert.ok(path.isAbsolute(gopls.binary));
    assert.ok(gopls.clients.some((c) => c.folders.includes(path.join(fixture, "gomod"))));
    assert.equal(state.formatters.find((f) => f.name === "not-installed").status, "missing");
    assert.deepEqual(
      state.formatters.map((f) => f.name),
      ["upper", "not-installed", "suffix", "in-place", "broken"],
    );
    panel.dispose();
  },

  async "processes: details, captured log, stop and restart one process"(api) {
    const processes = () => api.uiState().processes;
    const gopls = processes().find((p) => p.server === "gopls");
    assert.equal(gopls.state, "running");
    assert.equal(gopls.argv[0], "/bin/sh");
    assert.ok(gopls.folders.length >= 1);
    assert.ok(gopls.capabilities.includes("hoverProvider"));
    assert.deepEqual(gopls.config.command, gopls.argv);
    assert.ok(gopls.files.some((f) => f.path.endsWith("main.go")));

    const probe = processes().find((p) => p.server === "venv-probe");
    assert.ok(probe.config.venv.endsWith("venv"));
    assert.equal(probe.config.env.VIRTUAL_ENV, probe.config.venv);

    // stderr is captured line by line, before it reaches the Output panel.
    const marker = api.logs.lines("gopls").find((l) => l.text === "glsp-stderr-marker");
    assert.equal(marker?.level, "output");

    const loose = processes().find((p) => p.server === "clangd-loose");
    await api.dispatch({ type: "stopProcess", id: loose.id });
    assert.ok(!processes().some((p) => p.id === loose.id));

    await api.dispatch({ type: "restartProcess", id: gopls.id });
    // Same root, new process: the other gopls (one per root at this point) doesn't count.
    const fresh = await waitFor(
      () =>
        processes().find((p) => p.server === "gopls" && p.cwd === gopls.cwd && p.id !== gopls.id && p.state === "running"),
      "gopls restarted",
    );
    assert.notEqual(fresh.pid, gopls.pid);
  },

  async "buffers show attached servers, why others aren't, and who formats"(api) {
    const { store } = api;
    // Three servers that match .c files but can't attach, one per reason.
    await store.saveEntry("server", "workspace", "c-off", { command: ["clangd"], filePatterns: ["*.c"], enabled: false });
    await store.saveEntry("server", "workspace", "c-missing", { command: ["glsp-no-such-server"], filePatterns: ["*.c"] });
    await store.saveEntry("server", "workspace", "c-gated", {
      command: ["clangd"],
      filePatterns: ["*.c"],
      rootMarkers: ["glsp-no-such-marker"],
      singleFileSupport: false,
    });
    await open("c/hello.c");
    await open("fmt/a.up");
    const buffer = (rel) => api.uiState().buffers.find((b) => b.uri === vscode.Uri.file(path.join(fixture, rel)).toString());

    const hello = await waitFor(() => {
      const b = buffer("c/hello.c");
      return b?.servers.find((s) => s.name === "clangd")?.state === "running" ? b : undefined;
    }, "hello.c buffer with clangd");
    const states = Object.fromEntries(hello.servers.map((s) => [s.name, s.state]));
    assert.deepEqual(states, { clangd: "running", "c-off": "disabled", "c-missing": "missing", "c-gated": "noRoot" });
    assert.equal(hello.servers.find((s) => s.name === "clangd").root, fixture.replace(require("node:os").homedir(), "~"));
    assert.deepEqual(hello.format, { kind: "server", server: "clangd", mode: "fallback" });

    assert.deepEqual(buffer("fmt/a.up").format, {
      kind: "chain",
      steps: [
        { name: "upper", installed: true },
        { name: "not-installed", installed: false },
        { name: "suffix", installed: true },
      ],
    });
    assert.deepEqual(buffer("fmt/a.up").servers, []);
    // gopls is set to never format by an earlier test, and no CLI formatter matches main.go.
    assert.deepEqual(buffer("gomod/main.go").format, { kind: "none" });

    for (const name of ["c-off", "c-missing", "c-gated"]) await store.deleteEntry("server", name);
  },

  async "settings UI edits: create, rename in place, reorder, toggle"(api) {
    const { store } = api;
    const names = () => Object.keys(vscode.workspace.getConfiguration("generalLsp").inspect("formatters").workspaceValue);

    await store.saveEntry("formatter", "workspace", "lower", { command: ["tr", "A-Z", "a-z"], filePatterns: ["*.low"] });
    assert.deepEqual(names().slice(-1), ["lower"]);

    await store.saveEntry("formatter", "workspace", "suffix-renamed", { command: ["sed", "s/$/;/"], filePatterns: ["*.up"] }, "suffix");
    assert.deepEqual(names(), ["upper", "not-installed", "suffix-renamed", "in-place", "broken", "lower"]);
    await assert.rejects(store.saveEntry("formatter", "workspace", "upper", { command: ["x"] }, "lower"), /already exists/);

    await store.moveEntry("formatter", "lower", -1);
    assert.deepEqual(names().slice(-2), ["lower", "broken"]);
    const raw = vscode.workspace.getConfiguration("generalLsp").inspect("formatters").workspaceValue;
    assert.ok(Object.values(raw).every((f) => !("__reordering" in f)), "transient marker removed");

    // Moving a server must not restart it.
    const gopls = runningClient(api, "gopls");
    const serverNames = () => Object.keys(vscode.workspace.getConfiguration("generalLsp").inspect("servers").workspaceValue);
    const before = serverNames();
    await store.moveEntry("server", "gopls", 1);
    assert.notDeepEqual(serverNames(), before);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(runningClient(api, "gopls"), gopls);
    assert.equal(gopls.server.order, 1);

    await store.setEnabled("formatter", "upper", false);
    await waitFor(async () => (await formatted("fmt/b.up")) === "plain;\n", "upper to be skipped");
    await store.setEnabled("formatter", "upper", true);
    assert.equal("enabled" in vscode.workspace.getConfiguration("generalLsp").inspect("formatters").workspaceValue.upper, false);
  },

  async "config changes stop removed servers and keep unchanged ones"(api) {
    const gopls = runningClient(api, "gopls");
    const config = vscode.workspace.getConfiguration("generalLsp");
    const { clangd: _, ...rest } = config.get("servers");
    await config.update("servers", rest, vscode.ConfigurationTarget.Workspace);
    await waitFor(() => !api.runningClients().some((rc) => rc.server.name === "clangd"), "clangd to stop");
    assert.equal(runningClient(api, "gopls"), gopls);
  },
};

async function killHost(api) {
  await open("gomod/main.go");
  await waitFor(() => runningClient(api, "gopls"), "gopls");
  process.kill(process.pid, "SIGKILL");
}

exports.run = async function run() {
  const api = await vscode.extensions.getExtension("maot27.general-lsp").activate();
  if (process.env.MODE === "kill") return killHost(api);
  const failures = [];
  for (const [name, test] of Object.entries(tests)) {
    try {
      await test(api);
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.log(`  ✗ ${name}\n    ${err.stack}`);
      failures.push(name);
    }
  }
  if (failures.length) throw new Error(`${failures.length} test(s) failed`);
};
