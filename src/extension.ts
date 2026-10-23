import * as vscode from "vscode";
import { State } from "vscode-languageclient/node";
import * as clients from "./clients";
import { readFormatters, readServers, sameConfig, type ServerConfig } from "./config";
import { forgetExecutables } from "./executables";
import * as formatting from "./formatting";
import { startWatchdog } from "./processes";
import * as logs from "./logs";
import * as notify from "./notify";
import { dispatch, openSettingsPanel, uiState, webviewReadyCount, type PanelActions } from "./ui/panel";
import * as store from "./ui/store";

let servers = new Map<string, ServerConfig>();
let status: vscode.StatusBarItem;

const panelActions: PanelActions = {
  reloadAll,
  restartServer: async (name) => {
    await Promise.all(clientsOf(name).map(clients.stop));
    attachAll();
  },
  stopServer: async (name) => {
    await Promise.all(clientsOf(name).map(clients.stop));
  },
  reattach: () => attachAll(),
};

export function activate(context: vscode.ExtensionContext) {
  startWatchdog();
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "generalLsp.openSettings";
  context.subscriptions.push(
    status,
    { dispose: clients.dispose },
    { dispose: formatting.dispose },
    { dispose: logs.dispose },
    { dispose: notify.dispose },
    notify.onDidChange(updateStatus),
    notify.onDidChangeSeen(updateStatus),
    vscode.workspace.onDidOpenTextDocument(attachDocument),
    vscode.workspace.onDidCloseTextDocument(clients.forget),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("generalLsp")) reload();
    }),
    // Restricted settings only take effect once the workspace is trusted.
    vscode.workspace.onDidGrantWorkspaceTrust(reload),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    clients.onDidChange(updateStatus),
    clients.onDidChange(formatting.refresh),
    vscode.commands.registerCommand("generalLsp.restart", restart),
    vscode.commands.registerCommand("generalLsp.stop", stop),
    vscode.commands.registerCommand("generalLsp.reloadAll", reloadAll),
    vscode.commands.registerCommand("generalLsp.enable", (name?: string) => setEnabled(true, name)),
    vscode.commands.registerCommand("generalLsp.disable", (name?: string) => setEnabled(false, name)),
    vscode.commands.registerCommand("generalLsp.openSettings", (tab?: string) =>
      openSettingsPanel(context.extensionUri, panelActions, typeof tab === "string" ? tab : undefined),
    ),
  );
  reload();
  return {
    runningClients: clients.runningClients,
    uiState,
    store,
    webviewReadyCount,
    dispatch,
    logs,
    notices: notify.list,
    readServers,
  };
}

function clientsOf(name: string): clients.RunningClient[] {
  return clients.runningClients().filter((rc) => rc.server.name === name);
}

export function deactivate(): Promise<void> {
  return clients.stopAll();
}

// A bug here would otherwise silently leave every server unattached, so it's reported instead.
function reload(): void {
  try {
    clients.settingsChanged();
    forgetExecutables();
    notify.forgetToasts();
    const problems: string[] = [];
    const next = readServers(problems);
    const nextFormatters = readFormatters(problems);
    // Invalid entries are skipped, so say which ones instead of letting them silently do nothing.
    for (const problem of problems) notify.report("warning", "settings", problem);
    for (const rc of clients.runningClients()) {
      const updated = next.get(rc.server.name);
      if (!updated || !sameConfig(updated, rc.server)) void clients.stop(rc);
      else rc.server = updated;
    }
    servers = next;
    logs.retain(new Set([...next.keys(), "formatters", "general-lsp"]));
    formatting.setFormatters(nextFormatters);
    attachAll();
  } catch (err) {
    notify.error("general-lsp", err, "loading settings failed");
  }
}

function attachAll(): void {
  vscode.workspace.textDocuments.forEach(attachDocument);
}

function attachDocument(doc: vscode.TextDocument): void {
  for (const server of servers.values()) {
    try {
      clients.attach(server, doc);
    } catch (err) {
      notify.error(server.name, err, `attaching to ${vscode.workspace.asRelativePath(doc.uri)} failed`);
    }
  }
}

function updateStatus(): void {
  const doc = vscode.window.activeTextEditor?.document;
  const attached = doc ? clients.clientsFor(doc) : [];
  const problems = notify.unseenCount();
  // Problems keep the item visible even where no server is attached.
  if (attached.length === 0 && problems === 0) {
    status.hide();
    return;
  }
  const hasError = notify.unseenSeverity() === "error";
  status.text = [
    attached.length > 0 && `$(server-process) ${attached.map((rc) => rc.server.name).join(", ")}`,
    problems > 0 && `$(${hasError ? "error" : "warning"}) ${problems}`,
  ]
    .filter(Boolean)
    .join("  ");
  status.backgroundColor =
    problems > 0 ? new vscode.ThemeColor(hasError ? "statusBarItem.errorBackground" : "statusBarItem.warningBackground") : undefined;
  status.command = problems > 0 ? { command: "generalLsp.openSettings", title: "Show problems", arguments: ["problems"] } : "generalLsp.openSettings";
  status.tooltip = [
    ...attached.map((rc) => `${rc.server.name} (${State[rc.client.state]}): ${rc.folders.join(", ")}`),
    problems > 0 ? `${problems} new problem${problems === 1 ? "" : "s"} — click to see them` : "",
  ]
    .filter(Boolean)
    .join("\n");
  status.show();
}

interface ClientItem extends vscode.QuickPickItem {
  targets: clients.RunningClient[];
}

async function pickClients(placeHolder: string): Promise<clients.RunningClient[] | undefined> {
  const all = clients.runningClients();
  if (all.length === 0) {
    void vscode.window.showInformationMessage("General LSP: no servers are running.");
    return undefined;
  }
  const active = vscode.window.activeTextEditor?.document;
  const attached = new Set(active ? clients.clientsFor(active) : []);
  // Servers attached to the active file come first.
  all.sort((a, b) => Number(attached.has(b)) - Number(attached.has(a)));
  const items: ClientItem[] = all.map((rc) => ({
    label: rc.server.name,
    description: rc.root,
    detail: State[rc.client.state],
    targets: [rc],
  }));
  if (all.length > 1) items.unshift({ label: "$(list-flat) All servers", targets: all });
  return (await vscode.window.showQuickPick(items, { placeHolder }))?.targets;
}

async function restart(): Promise<void> {
  const targets = await pickClients("Server to restart");
  if (!targets) return;
  await Promise.all(targets.map(clients.stop));
  attachAll();
}

async function stop(): Promise<void> {
  const targets = await pickClients("Server to stop");
  if (targets) await Promise.all(targets.map(clients.stop));
}

// Unlike the automatic reload, this restarts every server even if its settings look unchanged.
async function reloadAll(): Promise<void> {
  await clients.stopAll();
  reload();
  vscode.window.setStatusBarMessage(`General LSP: reloaded settings, ${servers.size} servers configured`, 3000);
}

async function setEnabled(enabled: boolean, name?: string): Promise<void> {
  const candidates = store
    .entries("server")
    .filter((e) => (e.raw.enabled !== false) !== enabled)
    .map((e) => e.name);
  name ??= await vscode.window.showQuickPick(candidates, {
    placeHolder: enabled ? "Server to enable" : "Server to disable",
  });
  if (name && candidates.includes(name)) await store.setEnabled("server", name, enabled);
}
