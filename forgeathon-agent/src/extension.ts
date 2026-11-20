import * as vscode from 'vscode';
import { AgentController } from './controller';
import { ReviewManager } from './review/manager';
import { AgentPanel } from './ui/panel';

export function activate(context: vscode.ExtensionContext) {
  const out = vscode.window.createOutputChannel('Forge Agent');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(hubot) Forge';
  status.command = 'forge.openPanel';
  status.show();

  const review = new ReviewManager();
  const controller = new AgentController(review, out, status);
  context.subscriptions.push(out, status, review, controller);

  // Start the editor MCP server right away so TrueForge can connect as soon as an agent runs.
  void controller.ensureMcp().then((problem) => {
    if (problem) out.appendLine(`[mcp] ${problem}`);
  });

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('forge.openPanel', () => AgentPanel.show(context, controller));
  reg('forge.stop', () => controller.stop());
  reg('forge.hello', () => controller.smokeTest());
  reg('forge.undo', async () => vscode.window.showInformationMessage(await review.undoLast()));

  // CodeLens actions (arguments: uriKey, hunkId)
  reg('forge.acceptHunk', (key: string, id: number) => review.setHunk(key, id, 'accepted'));
  reg('forge.rejectHunk', (key: string, id: number) => review.setHunk(key, id, 'rejected'));
  reg('forge.acceptAll', (key: string) => review.setAll(key, 'accepted'));
  reg('forge.rejectAll', (key: string) => review.setAll(key, 'rejected'));

  // Inline edit: selection + keybinding + plain-language instruction -> diff in the editor (never a chat reply to copy).
  reg('forge.inlineEdit', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage('Forge: select the code you want to change first.');
      return;
    }
    const instruction = await vscode.window.showInputBox({ prompt: 'Forge inline edit: what should change?', placeHolder: 'e.g. Treat the values "off" and "n" as false as well...', ignoreFocusOut: true });
    if (!instruction) return;
    const doc = editor.document;
    const sel = editor.selection;
    const rel = vscode.workspace.asRelativePath(doc.uri, false);
    const text = doc.getText(sel);
    const message = [
      '[INLINE EDIT]',
      `File: ${rel}`,
      `Selected lines ${sel.start.line + 1}-${sel.end.line + 1} (1-based):`,
      '```',
      text,
      '```',
      `Instruction: ${instruction}`,
    ].join('\n');
    AgentPanel.show(context, controller);
    // Small delay so the freshly created webview is ready to receive streamed messages.
    setTimeout(() => void controller.run(message, `[inline edit] ${rel}:${sel.start.line + 1}-${sel.end.line + 1}\n${instruction}`), 300);
  });
}

export function deactivate() {
  /* disposables are cleaned up via context.subscriptions */
}
