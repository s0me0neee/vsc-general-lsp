import * as vscode from "vscode";
import { State } from "vscode-languageclient/node";
import * as clients from "./clients";
import { readFormatters, readServers, sameConfig, type ServerConfig } from "./config";
import * as formatting from "./formatting";
import { startWatchdog } from "./processes";
import * as logs from "./logs";
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
    { dispose: clients.disposeOutputs },
    { dispose: formatting.dispose },
    vscode.workspace.onDidOpenTextDocument(attachDocument),
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
    vscode.commands.registerCommand("generalLsp.openSettings", () => openSettingsPanel(context.extensionUri, panelActions)),
  );
  reload();
  return { runningClients: clients.runningClients, uiState, store, webviewReadyCount, dispatch, logs };
}

function clientsOf(name: string): clients.RunningClient[] {
  return clients.runningClients().filter((rc) => rc.server.name === name);
}

export function deactivate(): Promise<void> {
  return clients.stopAll();
}

function reload(): void {
  const next = readServers();
  for (const rc of clients.runningClients()) {
    const updated = next.get(rc.server.name);
    if (!updated || !sameConfig(updated, rc.server)) void clients.stop(rc);
    else rc.server = updated;
  }
  servers = next;
  clients.forgetMissing();
  formatting.setFormatters(readFormatters());
  attachAll();
}

function attachAll(): void {
  vscode.workspace.textDocuments.forEach(attachDocument);
}

function attachDocument(doc: vscode.TextDocument): void {
  for (const server of servers.values()) clients.attach(server, doc);
}

function updateStatus(): void {
  const doc = vscode.window.activeTextEditor?.document;
  const attached = doc ? clients.clientsFor(doc) : [];
  if (attached.length === 0) {
    status.hide();
    return;
  }
  status.text = `$(server-process) ${attached.map((rc) => rc.server.name).join(", ")}`;
  status.tooltip = attached
    .map((rc) => `${rc.server.name} (${State[rc.client.state]}): ${rc.folders.join(", ")}`)
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
