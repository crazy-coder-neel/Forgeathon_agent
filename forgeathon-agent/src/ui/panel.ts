import * as vscode from 'vscode';
import { AgentController } from '../controller';

export class AgentPanel {
  private static current: AgentPanel | undefined;

  static show(context: vscode.ExtensionContext, controller: AgentController): AgentPanel {
    if (AgentPanel.current) {
      AgentPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return AgentPanel.current;
    }
    AgentPanel.current = new AgentPanel(context, controller);
    return AgentPanel.current;
  }

  private panel: vscode.WebviewPanel;

  private constructor(context: vscode.ExtensionContext, private controller: AgentController) {
    this.panel = vscode.window.createWebviewPanel('forgeAgent', 'Forge Agent', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const w = this.panel.webview;
    const js = w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'panel.css'));
    w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<header><b>Forge Agent</b><span id="state" class="idle">idle</span></header>
<main>
  <section id="chat"></section>
  <aside>
    <h4>Files chosen &amp; why</h4><div id="files" class="empty">Nothing yet. The agent lists the context it picked here.</div>
    <h4>Attached @mentions</h4><div id="attached" class="empty">None. Type @ in the box to mention a file or symbol.</div>
    <h4>Tool calls</h4><div id="tools"></div>
  </aside>
</main>
<footer>
  <div id="suggest" hidden></div>
  <textarea id="input" rows="3" placeholder="Describe the change. Use @file or @symbol to attach context. Enter = send, Shift+Enter = newline"></textarea>
  <div class="row"><button id="send">Send</button><button id="stop" disabled>Stop</button><button id="undo" title="Undo the last applied change">Undo last change</button></div>
</footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;

    controller.post = (m) => void this.panel.webview.postMessage(m);
    this.panel.webview.onDidReceiveMessage((m) => {
      switch (m.type) {
        case 'send':
          void controller.run(String(m.text ?? ''));
          break;
        case 'stop':
          void controller.stop();
          break;
        case 'undo':
          void vscode.commands.executeCommand('forge.undo');
          break;
        case 'mention-query':
          void this.panel.webview.postMessage({ type: 'mention-results', q: m.q, items: controller.suggest(String(m.q ?? '')) });
          break;
      }
    });
    this.panel.onDidDispose(() => {
      AgentPanel.current = undefined;
      controller.post = () => undefined;
    });
  }
}
