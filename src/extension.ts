/**
 * Extension host entry point. Owns the webview panel lifecycle, feeds VSCode
 * configuration into the game, and persists setting changes the player makes
 * from the in-game menu. It also mirrors live Copilot activity into the world:
 * a polled job-status file and the chat session store are turned into wall
 * writing and a HUD token counter.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { snapshotFromSession } from './shared/chatlog';
import {
  BackviewsSettings,
  ChatSessionSnapshot,
  CopilotJob,
  DEFAULT_SETTINGS,
  HostMessage,
  IDLE_JOB,
  SettingValue,
  WebviewMessage,
} from './shared/settings';

/** Image files under materials/ that re-skin the atlas when present. */
const MATERIAL_FILES = {
  wallpaper: 'wallpaper.jpg',
  ceiling: 'ceiling.jpg',
  carpet: 'carpet.jpg',
} as const;

const VIEW_TYPE = 'backviews.panel';

/**
 * Workspace-relative status file the Copilot side writes while it works:
 * `{ "working": true, "status": "...", "tokens": 1234 }`. Polled while the
 * panel is open; a file that stops updating goes stale and reads as idle.
 */
const JOB_STATUS_FILE = path.join('.copilot', 'backviews-job.json');
const JOB_POLL_MS = 1000;
const JOB_STALE_MS = 3 * 60_000;

/** A session file untouched for this long is no longer "streaming". */
const CHAT_FRESH_MS = 20_000;

/** Input shape of the backviews_reportJob language model tool. */
interface ReportJobInput {
  status?: string;
  tokens?: number;
  done?: boolean;
}

let panel: vscode.WebviewPanel | undefined;
let jobTimer: ReturnType<typeof setInterval> | undefined;
let lastJobJson = '';
let lastFileJson = '';
let chatSessionsDir: string | null = null;
let lastChatJson = '';
// Most recent job pushed through the tool or command (not the file), kept so
// a panel opened mid-job picks the live status up immediately.
let lastDirectJob: CopilotJob | null = null;
let lastDirectAt = 0;

export function activate(context: vscode.ExtensionContext): void {
  chatSessionsDir = resolveChatSessionsDir(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('backviews.open', () => openPanel(context)),
    vscode.commands.registerCommand('backviews.relocate', () => {
      openPanel(context);
      post({ type: 'relocate' });
    }),
    // Programmatic entry point so tasks, hooks, or other extensions can push
    // job status without touching the status file.
    vscode.commands.registerCommand('backviews.reportJob', (job?: Partial<CopilotJob>) => {
      reportDirect(normalizeJob(job));
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('backviews')) {
        post({ type: 'config', settings: readSettings() });
      }
    }),
  );

  // Copilot agent chat integration: the agent invokes this tool while it
  // handles chat input (steered by .github/copilot-instructions.md), which is
  // what routes live job status and token usage into the game.
  if (typeof vscode.lm?.registerTool === 'function') {
    context.subscriptions.push(
      vscode.lm.registerTool<ReportJobInput>('backviews_reportJob', {
        invoke: async (options) => {
          const input = options.input ?? {};
          reportDirect(
            normalizeJob({
              working: input.done !== true,
              status: input.status,
              tokens: input.tokens,
            }),
          );
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              'Status reported to the backrooms. Call again on the next step, and with done=true when finished.',
            ),
          ]);
        },
      }),
    );
  }
}

/**
 * Records a tool/command-pushed job and forwards it to the webview. This
 * captures jobs from the language model tool or reportJob command, keeping
 * them alive so a panel opened mid-job picks them up immediately.
 */
function reportDirect(job: CopilotJob): void {
  lastDirectJob = job;
  lastDirectAt = Date.now();
  postJob(job);
}

export function deactivate(): void {
  panel?.dispose();
}

/** Coerces untrusted job input (file or command args) into a CopilotJob. */
function normalizeJob(raw: unknown): CopilotJob {
  if (typeof raw !== 'object' || raw === null) {
    return { ...IDLE_JOB };
  }
  const value = raw as Record<string, unknown>;
  return {
    working: value.working === true,
    status: typeof value.status === 'string' ? value.status.slice(0, 120) : '',
    tokens:
      typeof value.tokens === 'number' && Number.isFinite(value.tokens)
        ? Math.max(0, Math.floor(value.tokens))
        : 0,
  };
}

/** Reads the first workspace folder's status file, treating stale as idle. */
function readJobFile(): CopilotJob {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const file = path.join(folder.uri.fsPath, JOB_STATUS_FILE);
    try {
      const stat = fs.statSync(file);
      if (Date.now() - stat.mtimeMs > JOB_STALE_MS) {
        return { ...IDLE_JOB };
      }
      return normalizeJob(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // Missing or malformed file: try the next folder.
    }
  }
  return { ...IDLE_JOB };
}

/** Posts a job snapshot to the webview, deduplicating unchanged states. */
function postJob(job: CopilotJob): void {
  const json = JSON.stringify(job);
  if (json === lastJobJson) {
    return;
  }
  lastJobJson = json;
  post({ type: 'jobStatus', job });
}

/**
 * Starts polling both the job status file and chat session store. File-based
 * job updates are deduplicated to avoid overwriting direct reports from the
 * tool/command. Chat sessions are always forwarded when they change to keep
 * wall writing current.
 */
function startJobWatch(): void {
  stopJobWatch();
  // Only file *changes* are forwarded, so an idle status file does not
  // continuously stomp updates pushed through the reportJob command.
  jobTimer = setInterval(() => {
    const job = readJobFile();
    const json = JSON.stringify(job);
    if (json !== lastFileJson) {
      lastFileJson = json;
      postJob(job);
    }
    postChatSession();
  }, JOB_POLL_MS);
}

/**
 * Reads the newest chat session and forwards it when it changed. This polls
 * VSCode's internal chat session store to mirror live responses onto the
 * walls as they stream.
 */
function postChatSession(): void {
  const session = readChatSession();
  if (!session) {
    return;
  }
  const json = JSON.stringify(session);
  if (json !== lastChatJson) {
    lastChatJson = json;
    post({ type: 'chatSession', session });
  }
}

// --- Copilot Chat session mirror ---------------------------------------------
//
// VSCode persists the chat panel's sessions under
// workspaceStorage/<hash>/chatSessions/. Our own storageUri lives under the
// same <hash>, which is how the folder is located without knowing the hash.
// Parsing lives in shared/chatlog.ts; everything is best-effort.

function resolveChatSessionsDir(context: vscode.ExtensionContext): string | null {
  const storage = context.storageUri;
  if (!storage || storage.scheme !== 'file') {
    return null;
  }
  return path.join(path.dirname(storage.fsPath), 'chatSessions');
}

/**
 * Snapshot of the newest session file in the workspace's chat store. Finds the
 * most recently modified .json or .jsonl file in the chat sessions directory
 * and parses it into a wall-ready snapshot. Returns null if no sessions exist
 * or parsing fails.
 */
function readChatSession(): ChatSessionSnapshot | null {
  if (!chatSessionsDir) {
    return null;
  }
  try {
    // Find the most recently modified session file.
    let newest: { file: string; mtimeMs: number } | null = null;
    for (const name of fs.readdirSync(chatSessionsDir)) {
      if (!/\.jsonl?$/.test(name)) {
        continue;
      }
      const file = path.join(chatSessionsDir, name);
      const mtimeMs = fs.statSync(file).mtimeMs;
      if (!newest || mtimeMs > newest.mtimeMs) {
        newest = { file, mtimeMs };
      }
    }
    if (!newest) {
      return null;
    }
    // A file touched recently is still streaming.
    const fresh = Date.now() - newest.mtimeMs < CHAT_FRESH_MS;
    return snapshotFromSession(fs.readFileSync(newest.file, 'utf8'), fresh);
  } catch {
    return null;
  }
}

function stopJobWatch(): void {
  if (jobTimer !== undefined) {
    clearInterval(jobTimer);
    jobTimer = undefined;
  }
}

function openPanel(context: vscode.ExtensionContext): void {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    return;
  }

  panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'BackViews', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'media'),
      vscode.Uri.joinPath(context.extensionUri, 'materials'),
    ],
  });
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  panel.webview.html = renderHtml(panel.webview, context.extensionUri);

  lastJobJson = '';
  lastFileJson = '';
  startJobWatch();

  panel.webview.onDidReceiveMessage(
    (message: WebviewMessage) => {
      if (message.type === 'ready') {
        post({ type: 'config', settings: readSettings() });
        // A fresh direct report (tool/command) beats the status file.
        if (lastDirectJob && Date.now() - lastDirectAt < JOB_STALE_MS) {
          postJob(lastDirectJob);
        } else {
          postJob(readJobFile());
        }
        lastChatJson = '';
        postChatSession();
      } else if (message.type === 'updateSetting') {
        vscode.workspace
          .getConfiguration('backviews')
          .update(message.key, message.value, vscode.ConfigurationTarget.Global);
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.onDidDispose(() => {
    stopJobWatch();
    panel = undefined;
  }, undefined, context.subscriptions);
}

function post(message: HostMessage): void {
  panel?.webview.postMessage(message);
}

/** Reads the `backviews.*` configuration, falling back to defaults per key. */
function readSettings(): BackviewsSettings {
  const config = vscode.workspace.getConfiguration('backviews');
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(settings) as (keyof BackviewsSettings)[]) {
    const value = config.get(key);
    if (typeof value === typeof settings[key]) {
      (settings as Record<string, SettingValue>)[key] = value as SettingValue;
    }
  }
  return settings;
}

/** Webview URIs for the material images that actually exist on disk. */
function materialUris(webview: vscode.Webview, extensionUri: vscode.Uri): Record<string, string> {
  const uris: Record<string, string> = {};
  for (const [key, file] of Object.entries(MATERIAL_FILES)) {
    const uri = vscode.Uri.joinPath(extensionUri, 'materials', file);
    if (fs.existsSync(uri.fsPath)) {
      uris[key] = webview.asWebviewUri(uri).toString();
    }
  }
  return uris;
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'webview.js'));
  const materials = JSON.stringify(materialUris(webview, extensionUri));
  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BackViews</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #101010; }
    #app { position: relative; width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">window.__BACKVIEWS_MATERIALS__ = ${materials};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
