// Diff review inside VS Code: shows a proposal in the native diff editor with per-hunk Accept / Reject CodeLenses,
// applies ONLY accepted hunks via WorkspaceEdit (after the user's decision), and keeps an undo stack.
// Nothing is written to disk before the user accepts.
import * as vscode from 'vscode';
import { Hunk, renderHunks, splitLines } from './hunks';
import { Proposal } from './plan';

type HunkState = 'pending' | 'accepted' | 'rejected';

export interface ReviewOutcome {
  total: number;
  accepted: number;
  rejected: number;
  applied: boolean;
  note?: string;
}

interface Session {
  proposal: Proposal;
  states: Map<number, HunkState>;
  uri: vscode.Uri;
  leftUri: vscode.Uri;
  resolve: (o: ReviewOutcome) => void;
  done: boolean;
}

interface UndoEntry {
  uri: vscode.Uri;
  path: string;
  before: string;
  after: string;
  created: boolean;
}

export const SCHEME = 'forge-proposal';

export class ReviewManager implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider, vscode.Disposable {
  private sessions = new Map<string, Session>();
  private undoStack: UndoEntry[] = [];
  private counter = 0;
  private lensEmitter = new vscode.EventEmitter<void>();
  private contentEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  readonly onDidChange = this.contentEmitter.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: SCHEME }, this),
      this.lensEmitter,
      this.contentEmitter,
    );
  }

  dispose() {
    this.discardAll('extension disposed');
    this.disposables.forEach((d) => d.dispose());
  }

  // ---- content provider: the "proposed" side of the diff = original + non-rejected hunks
  provideTextDocumentContent(uri: vscode.Uri): string {
    const s = this.sessions.get(uri.toString());
    if (uri.query.startsWith('empty')) return '';
    if (!s) return '';
    return renderHunks(s.proposal.original, s.proposal.hunks, (h) => s.states.get(h.id) !== 'rejected').text;
  }

  // ---- code lenses: one Accept/Reject pair per undecided hunk, file-level actions on line 1
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.sessions.get(doc.uri.toString());
    if (!s || s.done) return [];
    const lenses: vscode.CodeLens[] = [];
    const key = doc.uri.toString();
    const rendered = renderHunks(s.proposal.original, s.proposal.hunks, (h) => s.states.get(h.id) !== 'rejected');
    const pending = [...s.states.values()].filter((v) => v === 'pending').length;
    const top = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(top, { title: `$(check-all) Accept all (${s.proposal.hunks.length})`, command: 'forge.acceptAll', arguments: [key] }),
      new vscode.CodeLens(top, { title: '$(close-all) Reject all', command: 'forge.rejectAll', arguments: [key] }),
      new vscode.CodeLens(top, { title: `${pending} hunk(s) awaiting your decision`, command: '' }),
    );
    for (const h of s.proposal.hunks) {
      const st = s.states.get(h.id);
      if (st === 'rejected') continue;
      const line = Math.min(rendered.starts.get(h.id) ?? 0, Math.max(doc.lineCount - 1, 0));
      const r = new vscode.Range(line, 0, line, 0);
      const label = `hunk ${h.id + 1}/${s.proposal.hunks.length}`;
      if (st === 'accepted') {
        lenses.push(new vscode.CodeLens(r, { title: `$(pass-filled) ${label} accepted`, command: 'forge.rejectHunk', arguments: [key, h.id], tooltip: 'Click to reject instead' }));
      } else {
        lenses.push(
          new vscode.CodeLens(r, { title: `$(check) Accept ${label}`, command: 'forge.acceptHunk', arguments: [key, h.id] }),
          new vscode.CodeLens(r, { title: '$(close) Reject', command: 'forge.rejectHunk', arguments: [key, h.id] }),
        );
      }
    }
    return lenses;
  }

  // ---- public API
  /** Show the proposal for review and resolve once every hunk is decided (or the review is discarded). */
  review(proposal: Proposal): Promise<ReviewOutcome> {
    const id = ++this.counter;
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${proposal.path}`, query: `p${id}` });
    const leftUri = proposal.isNew ? vscode.Uri.from({ scheme: SCHEME, path: `/${proposal.path}`, query: `empty${id}` }) : vscode.Uri.file(proposal.abs);
    const states = new Map<number, HunkState>(proposal.hunks.map((h) => [h.id, 'pending' as HunkState]));
    return new Promise<ReviewOutcome>((resolve) => {
      const s: Session = { proposal, states, uri, leftUri, resolve, done: false };
      this.sessions.set(uri.toString(), s);
      const title = `Forge review: ${proposal.path} (${proposal.hunks.length} hunk${proposal.hunks.length === 1 ? '' : 's'})${proposal.isNew ? ' [new file]' : ''}`;
      void vscode.commands.executeCommand('vscode.diff', leftUri, uri, title, { preview: false });
      this.lensEmitter.fire();
      void vscode.window.setStatusBarMessage(`Forge: review ${proposal.path}, use the Accept/Reject lenses in the diff`, 8000);
      // VS Code hides CodeLens in diff editors unless diffEditor.codeLens is on (we ship it on by default, but a user
      // setting can override that). Never leave the reviewer without a way to decide.
      if (!vscode.workspace.getConfiguration('diffEditor').get<boolean>('codeLens', false)) {
        const key = uri.toString();
        void vscode.window
          .showWarningMessage(
            `Forge: per-hunk Accept/Reject buttons are hidden because "diffEditor.codeLens" is off. Review ${proposal.path} (${proposal.hunks.length} hunk(s)):`,
            'Enable per-hunk buttons',
            'Accept all',
            'Reject all',
          )
          .then(async (choice) => {
            if (choice === 'Accept all') this.setAll(key, 'accepted');
            else if (choice === 'Reject all') this.setAll(key, 'rejected');
            else if (choice === 'Enable per-hunk buttons') {
              await vscode.workspace.getConfiguration('diffEditor').update('codeLens', true, vscode.ConfigurationTarget.Global);
              this.lensEmitter.fire();
            }
          });
      }
    });
  }

  setHunk(uriKey: string, hunkId: number, state: HunkState) {
    const s = this.sessions.get(uriKey);
    if (!s || s.done) return;
    s.states.set(hunkId, state);
    this.contentEmitter.fire(s.uri);
    this.lensEmitter.fire();
    void this.maybeFinish(s);
  }

  setAll(uriKey: string, state: HunkState) {
    const s = this.sessions.get(uriKey);
    if (!s || s.done) return;
    for (const h of s.proposal.hunks) s.states.set(h.id, state);
    this.contentEmitter.fire(s.uri);
    this.lensEmitter.fire();
    void this.maybeFinish(s);
  }

  private async maybeFinish(s: Session) {
    if ([...s.states.values()].some((v) => v === 'pending')) return;
    await this.finish(s);
  }

  private async finish(s: Session) {
    if (s.done) return;
    s.done = true;
    const hunks = s.proposal.hunks;
    const accepted = hunks.filter((h) => s.states.get(h.id) === 'accepted');
    const outcome: ReviewOutcome = { total: hunks.length, accepted: accepted.length, rejected: hunks.length - accepted.length, applied: false };
    try {
      if (accepted.length > 0) {
        const note = await this.apply(s.proposal, accepted);
        outcome.applied = note.ok;
        if (!note.ok) {
          outcome.accepted = 0;
          outcome.rejected = hunks.length;
        }
        if (note.message) outcome.note = note.message;
      }
    } catch (e) {
      outcome.accepted = 0;
      outcome.rejected = hunks.length;
      outcome.note = `Applying failed: ${(e as Error).message}. Nothing was changed.`;
    }
    await this.closeTab(s.uri);
    this.sessions.delete(s.uri.toString());
    this.lensEmitter.fire();
    s.resolve(outcome);
  }

  /** Apply the accepted hunks to the real file (editor buffer, then saved) and remember how to undo. */
  private async apply(p: Proposal, accepted: Hunk[]): Promise<{ ok: boolean; message?: string }> {
    const uri = vscode.Uri.file(p.abs);
    const finalText = renderHunks(p.original, p.hunks, (h) => accepted.some((a) => a.id === h.id)).text;
    if (p.isNew) {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), finalText);
      if (!(await vscode.workspace.applyEdit(edit))) return { ok: false, message: 'VS Code refused to create the file (does it already exist?). Nothing was changed.' };
      const doc = await vscode.workspace.openTextDocument(uri);
      await doc.save();
      this.undoStack.push({ uri, path: p.path, before: '', after: finalText, created: true });
      await vscode.window.showTextDocument(doc, { preview: false });
      return { ok: true };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.getText() !== p.original) {
      return { ok: false, message: `${p.path} changed while you were reviewing. Nothing was applied; ask the agent to re-read the file.` };
    }
    const lines = splitLines(p.original);
    const offsetOf = (lineIdx: number) => lines.slice(0, lineIdx).reduce((n, l) => n + l.length, 0);
    const edit = new vscode.WorkspaceEdit();
    for (const h of accepted) {
      const startOff = offsetOf(h.oldStart);
      const endOff = startOff + h.oldLines.reduce((n, l) => n + l.length, 0);
      edit.replace(uri, new vscode.Range(doc.positionAt(startOff), doc.positionAt(endOff)), h.newLines.join(''));
    }
    if (!(await vscode.workspace.applyEdit(edit))) return { ok: false, message: 'VS Code refused the edit. Nothing was changed.' };
    await doc.save();
    this.undoStack.push({ uri, path: p.path, before: p.original, after: finalText, created: false });
    const first = accepted[0];
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const pos = new vscode.Position(first.oldStart, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    return { ok: true };
  }

  /** Stop button: drop every open review, close diff tabs, apply nothing. */
  discardAll(reason = 'cancelled') {
    for (const s of [...this.sessions.values()]) {
      if (s.done) continue;
      s.done = true;
      void this.closeTab(s.uri);
      this.sessions.delete(s.uri.toString());
      s.resolve({ total: s.proposal.hunks.length, accepted: 0, rejected: s.proposal.hunks.length, applied: false, note: reason });
    }
    this.lensEmitter.fire();
  }

  hasOpenReviews() {
    return this.sessions.size > 0;
  }

  get undoDepth() {
    return this.undoStack.length;
  }

  /** "Forge: Undo Last Applied Change". Restores the file to what it was before that apply. */
  async undoLast(): Promise<string> {
    const e = this.undoStack.pop();
    if (!e) return 'Nothing to undo.';
    try {
      if (e.created) {
        const edit = new vscode.WorkspaceEdit();
        edit.deleteFile(e.uri, { ignoreIfNotExists: true });
        await vscode.workspace.applyEdit(edit);
        return `Undone: removed the new file ${e.path}.`;
      }
      const doc = await vscode.workspace.openTextDocument(e.uri);
      if (doc.getText() !== e.after) {
        const pick = await vscode.window.showWarningMessage(`${e.path} was edited after Forge applied the change. Undo anyway and discard those later edits?`, { modal: true }, 'Undo anyway');
        if (pick !== 'Undo anyway') {
          this.undoStack.push(e);
          return 'Undo cancelled.';
        }
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(e.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), e.before);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
      return `Undone: restored ${e.path}.`;
    } catch (err) {
      return `Undo failed: ${(err as Error).message}`;
    }
  }

  private async closeTab(uri: vscode.Uri) {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri.toString()) {
          await vscode.window.tabGroups.close(tab);
        }
      }
    }
  }
}
