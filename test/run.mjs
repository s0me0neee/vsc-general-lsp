import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

const root = path.resolve(import.meta.dirname, "..");
// A server child that ignores SIGTERM and outlives stdin EOF, like a stray cargo/proc-macro process.
const straggler = "sleep 86399";

async function launch(mode) {
  // Tests mutate workspace settings, so run against a throwaway copy of the fixture.
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "general-lsp-")));
  fs.cpSync(path.join(root, "test/fixture"), workspace, { recursive: true });
  const settingsPath = path.join(workspace, ".vscode/settings.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const servers = settings["generalLsp.servers"];
  servers.gopls.command = [
    "sh",
    "-c",
    `echo $$ > server.pid; echo "$0" > root.name; echo glsp-stderr-marker >&2; trap '' TERM HUP; ${straggler} & exec gopls`,
    "${rootName}",
  ];
  servers["clangd-loose"].fallbackRoot = path.join(workspace, "scratch-root");
  settings["generalLsp.extraPaths"] = [path.join(workspace, "bin")];
  fs.writeFileSync(settingsPath, JSON.stringify(settings));

  let ok = true;
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_PATH,
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(root, "test/suite.cjs"),
      extensionTestsEnv: { FIXTURE: workspace, MODE: mode },
      launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust"],
    });
  } catch {
    // Killing the extension host on purpose makes the run "fail".
    ok = mode === "kill";
  }
  try {
    const serverPid = Number(fs.readFileSync(path.join(workspace, "gomod/server.pid"), "utf8"));
    ok = (await serversGone(serverPid, mode)) && ok;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  return ok;
}

async function serversGone(serverPid, mode) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(serverPid) && stragglers().length === 0) {
      console.log(`  ✓ servers are gone after ${mode}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`  ✗ servers survived ${mode}: server ${isAlive(serverPid) ? "alive" : "dead"}, stragglers ${stragglers()}`);
  for (const pid of [serverPid, ...stragglers()]) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return false;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stragglers() {
  try {
    return execFileSync("pgrep", ["-f", `^${straggler}$`], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

const results = [await launch("quit"), await launch("kill")];
if (results.includes(false)) process.exitCode = 1;
