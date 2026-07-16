/**
 * Extension host entry point. Owns the webview panel lifecycle, feeds VSCode
 * configuration into the game, and persists setting changes the player makes
 * from the in-game menu.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import { BackviewsSettings, DEFAULT_SETTINGS, HostMessage, SettingValue, WebviewMessage } from './shared/settings';

/** Image files under materials/ that re-skin the atlas when present. */
const MATERIAL_FILES = {
  wallpaper: 'wallpaper.jpg',
  ceiling: 'ceiling.jpg',
  carpet: 'carpet.jpg',
} as const;

const VIEW_TYPE = 'backviews.panel';

let panel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('backviews.open', () => openPanel(context)),
    vscode.commands.registerCommand('backviews.relocate', () => {
      openPanel(context);
      post({ type: 'relocate' });
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('backviews')) {
        post({ type: 'config', settings: readSettings() });
      }
    }),
  );
}

export function deactivate(): void {
  panel?.dispose();
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

  panel.webview.onDidReceiveMessage(
    (message: WebviewMessage) => {
      if (message.type === 'ready') {
        post({ type: 'config', settings: readSettings() });
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
