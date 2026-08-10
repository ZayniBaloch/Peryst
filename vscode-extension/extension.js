const vscode = require("vscode");
const crypto = require("crypto");
const http = require("http");
const { spawn } = require("child_process");

let serviceProcess = null;
let serviceState = null;
let reviewPanel = null;

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function requestJson(path, body = null) {
  if (!serviceState) return Promise.reject(new Error("ScopeKeep service is not running."));
  return new Promise((resolve, reject) => {
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      hostname: "127.0.0.1",
      port: serviceState.port,
      path,
      method: encoded ? "POST" : "GET",
      timeout: 8000,
      headers: {
        Authorization: `Bearer ${serviceState.token}`,
        ...(encoded ? {
          "Content-Type": "application/json",
          "Content-Length": encoded.length,
        } : {}),
      },
    }, (response) => {
      let data = "";
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if ((response.statusCode || 500) >= 400) {
            reject(new Error(parsed.error || `ScopeKeep returned HTTP ${response.statusCode}`));
            return;
          }
          resolve(parsed);
        } catch (error) {
          reject(new Error(`Invalid ScopeKeep response: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("ScopeKeep request timed out.")));
    request.on("error", reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

async function invokeTool(name, args = {}) {
  const result = await requestJson("/tool", { name, arguments: args });
  const text = result?.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return result;
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

async function waitUntilHealthy(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson("/health");
      if (health.service === "scopekeep") return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`ScopeKeep did not become ready on port ${port}.`);
}

async function startService() {
  if (serviceProcess && serviceState) return serviceState;
  const root = workspaceRoot();
  if (!root) throw new Error("Open a workspace before starting ScopeKeep.");

  const config = vscode.workspace.getConfiguration("scopekeep");
  const port = config.get("port", 43219);
  const packageSpec = config.get("package", "scopekeep@next");
  const token = crypto.randomBytes(32).toString("hex");
  const command = process.platform === "win32" ? "npx.cmd" : "npx";

  serviceState = { port, token };
  serviceProcess = spawn(command, ["-y", packageSpec], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      SCOPEKEEP_WORKSPACE_ROOT: root,
      PERSYST_PROJECT: vscode.workspace.name || "shared",
      PERSYST_HTTP_ENABLED: "1",
      PERSYST_ENABLE_GENERIC_TOOL: "1",
      PERSYST_API_KEY: token,
      PORT: String(port),
    },
  });

  let startupError = "";
  serviceProcess.stderr.on("data", (chunk) => { startupError = `${startupError}${chunk}`.slice(-4000); });
  serviceProcess.once("exit", () => {
    serviceProcess = null;
    serviceState = null;
  });

  try {
    await waitUntilHealthy(port);
    return serviceState;
  } catch (error) {
    stopService();
    throw new Error(`${error.message}${startupError ? `\n${startupError.trim()}` : ""}`);
  }
}

function stopService() {
  if (serviceProcess) serviceProcess.kill();
  serviceProcess = null;
  serviceState = null;
}

class MemoryItem extends vscode.TreeItem {
  constructor(memory) {
    super(memory.content.split(/\r?\n/)[0].slice(0, 78), vscode.TreeItemCollapsibleState.None);
    this.description = memory.namespace || "shared";
    this.tooltip = new vscode.MarkdownString(
      `**Memory #${memory.id}**\n\n${memory.content}\n\nImportance: ${memory.importance_score ?? "unknown"}`
    );
    this.contextValue = "scopekeepMemory";
    this.iconPath = new vscode.ThemeIcon(memory.valid_until ? "archive" : "database");
    this.command = { command: "scopekeep.openReview", title: "Review memories", arguments: [memory.id] };
  }
}

class MemoryProvider {
  constructor() { this.changed = new vscode.EventEmitter(); this.onDidChangeTreeData = this.changed.event; }
  refresh() { this.changed.fire(); }
  getTreeItem(item) { return item; }
  async getChildren() {
    try {
      if (!serviceState) await startService();
      const data = await invokeTool("get_recent_memories", { limit: 50, agent_id: "vscode" });
      const memories = data.memories || [];
      if (!memories.length) {
        const empty = new vscode.TreeItem("No memories in this workspace");
        empty.iconPath = new vscode.ThemeIcon("info");
        return [empty];
      }
      return memories.map((memory) => new MemoryItem(memory));
    } catch (error) {
      const item = new vscode.TreeItem(`ScopeKeep unavailable: ${error.message.split("\n")[0]}`);
      item.iconPath = new vscode.ThemeIcon("warning");
      return [item];
    }
  }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function panelHtml(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px/1.55 var(--vscode-font-family); }
  header { max-width: 980px; margin: 0 auto 24px; display: flex; align-items: end; justify-content: space-between; gap: 20px; }
  h1 { margin: 0; font-size: 28px; letter-spacing: -0.04em; }
  header p { margin: 5px 0 0; color: var(--vscode-descriptionForeground); }
  .search { display: flex; gap: 8px; min-width: min(420px, 100%); }
  input, textarea { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); outline: none; }
  input { flex: 1; padding: 9px 11px; }
  input:focus, textarea:focus { border-color: var(--vscode-focusBorder); }
  button { padding: 8px 12px; border: 0; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground); }
  main { max-width: 980px; margin: auto; border-top: 1px solid var(--vscode-panel-border); }
  article { display: grid; grid-template-columns: 54px 1fr auto; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .id { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); }
  .content { white-space: pre-wrap; word-break: break-word; }
  .meta { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .actions { display: flex; gap: 6px; }
  .empty { padding: 50px 0; color: var(--vscode-descriptionForeground); text-align: center; }
  dialog { width: min(680px, calc(100% - 40px)); padding: 22px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  dialog::backdrop { background: rgba(0,0,0,.45); }
  textarea { width: 100%; min-height: 180px; padding: 10px; box-sizing: border-box; resize: vertical; }
  .dialog-actions { margin-top: 12px; display: flex; justify-content: flex-end; gap: 8px; }
  @media (max-width: 700px) { header { align-items: stretch; flex-direction: column; } article { grid-template-columns: 42px 1fr; } .actions { grid-column: 2; } }
</style></head><body>
<header><div><h1>Workspace memory</h1><p>Review what coding agents can retrieve in this project.</p></div>
<form class="search" id="searchForm"><input id="query" aria-label="Search memories" placeholder="Search this workspace"><button>Search</button><button class="secondary" type="button" id="recent">Recent</button></form></header>
<main id="memories"><div class="empty">Loading local memories...</div></main>
<dialog id="editor"><form method="dialog"><h2>Edit memory</h2><textarea id="editContent" aria-label="Memory content"></textarea><div class="dialog-actions"><button class="secondary" value="cancel">Cancel</button><button value="save" id="save">Save version</button></div></form></dialog>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('memories');
  const editor = document.getElementById('editor');
  const editContent = document.getElementById('editContent');
  let current = [];
  let editingId = null;
  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  function render(memories) {
    current = memories || [];
    list.innerHTML = current.length ? current.map(memory => '<article><div class="id">#' + memory.id + '</div><div><div class="content">' + escapeHtml(memory.content) + '</div><div class="meta">' + escapeHtml(memory.namespace || 'shared') + ' · importance ' + Number(memory.importance_score || 0).toFixed(2) + '</div></div><div class="actions"><button class="secondary" data-edit="' + memory.id + '">Edit</button><button class="secondary" data-delete="' + memory.id + '">Delete</button></div></article>').join('') : '<div class="empty">No matching memories in this workspace.</div>';
  }
  document.getElementById('searchForm').addEventListener('submit', event => { event.preventDefault(); vscode.postMessage({ type: 'search', query: document.getElementById('query').value }); });
  document.getElementById('recent').addEventListener('click', () => vscode.postMessage({ type: 'recent' }));
  list.addEventListener('click', event => {
    const edit = event.target.closest('[data-edit]');
    const remove = event.target.closest('[data-delete]');
    if (edit) { editingId = Number(edit.dataset.edit); editContent.value = current.find(m => m.id === editingId)?.content || ''; editor.showModal(); }
    if (remove) vscode.postMessage({ type: 'delete', id: Number(remove.dataset.delete) });
  });
  document.getElementById('save').addEventListener('click', event => { event.preventDefault(); vscode.postMessage({ type: 'update', id: editingId, content: editContent.value }); editor.close(); });
  window.addEventListener('message', event => { if (event.data.type === 'memories') render(event.data.memories); if (event.data.type === 'error') list.innerHTML = '<div class="empty">' + escapeHtml(event.data.message) + '</div>'; });
  vscode.postMessage({ type: 'recent' });
</script></body></html>`;
}

async function getRecent() {
  const result = await invokeTool("get_recent_memories", { limit: 100, agent_id: "vscode" });
  return result.memories || [];
}

async function openReview(provider) {
  await startService();
  if (reviewPanel) { reviewPanel.reveal(); return; }
  reviewPanel = vscode.window.createWebviewPanel("scopekeepReview", "ScopeKeep Memory Review", vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  const nonce = crypto.randomBytes(16).toString("base64");
  reviewPanel.webview.html = panelHtml(nonce);
  reviewPanel.onDidDispose(() => { reviewPanel = null; });
  reviewPanel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (message.type === "recent") {
        reviewPanel.webview.postMessage({ type: "memories", memories: await getRecent() });
      } else if (message.type === "search") {
        const query = String(message.query || "").trim();
        const data = query ? await requestJson("/search", { query, limit: 100, agent_id: "vscode" }) : { results: await getRecent() };
        reviewPanel.webview.postMessage({ type: "memories", memories: data.results || [] });
      } else if (message.type === "update") {
        await invokeTool("update_memory", { id: Number(message.id), content: String(message.content), agent_id: "vscode" });
        provider.refresh();
        reviewPanel.webview.postMessage({ type: "memories", memories: await getRecent() });
      } else if (message.type === "delete") {
        const answer = await vscode.window.showWarningMessage(`Permanently delete memory #${message.id}?`, { modal: true }, "Delete");
        if (answer === "Delete") {
          await invokeTool("delete_memory", { id: Number(message.id), agent_id: "vscode" });
          provider.refresh();
          reviewPanel.webview.postMessage({ type: "memories", memories: await getRecent() });
        }
      }
    } catch (error) {
      reviewPanel?.webview.postMessage({ type: "error", message: error.message });
      vscode.window.showErrorMessage(`ScopeKeep: ${error.message.split("\n")[0]}`);
    }
  });
}

function activate(context) {
  const provider = new MemoryProvider();
  context.subscriptions.push(
    provider.changed,
    vscode.window.registerTreeDataProvider("scopekeep.memories", provider),
    vscode.commands.registerCommand("scopekeep.openReview", () => openReview(provider)),
    vscode.commands.registerCommand("scopekeep.refresh", async () => { if (!serviceState) await startService(); provider.refresh(); }),
    vscode.commands.registerCommand("scopekeep.start", async () => { await startService(); provider.refresh(); vscode.window.showInformationMessage("ScopeKeep local review service is ready."); }),
    vscode.commands.registerCommand("scopekeep.stop", () => { stopService(); provider.refresh(); }),
  );

  if (vscode.workspace.getConfiguration("scopekeep").get("autoStart", true) && workspaceRoot()) {
    startService().then(() => provider.refresh()).catch((error) => vscode.window.showWarningMessage(`ScopeKeep could not start: ${error.message.split("\n")[0]}`));
  }
}

function deactivate() { stopService(); }

module.exports = { activate, deactivate, htmlEscape };
