// Glue between the editor and TrueForge: owns the MCP server, the TrueForge runner and the review flow.
import * as vscode from 'vscode';
import { resolveMentions } from './context/mentions';
import { findSymbol } from './context/symbols';
import { walk } from './context/workspace';
import { DecisionStore, decisionKey } from './mcp/decisions';
import { EditorMcpServer, startMcpServer } from './mcp/server';
import { killAll } from './mcp/tools';
import { ReviewManager } from './review/manager';
import { prepareProposal } from './review/plan';
import { Approval, RunHooks, ToolCallInfo, TrueForgeRunner } from './trueforge/client';

export type PanelMessage = { type: string; [k: string]: unknown };

export class AgentController implements vscode.Disposable {
  post: (m: PanelMessage) => void = () => undefined;
  running = false;
  private runner: TrueForgeRunner | undefined;
  private mcp: EditorMcpServer | undefined;
  private mcpRoot: string | undefined;
  private decisions = new DecisionStore();

  constructor(
    private review: ReviewManager,
    private out: vscode.OutputChannel,
    private status: vscode.StatusBarItem,
  ) {}

  private cfg() {
    const c = vscode.workspace.getConfiguration('forge');
    return {
      baseUrl: c.get<string>('baseUrl', 'http://localhost:8790'),
      primary: c.get<string>('primaryAgent', 'forgeathon-primary'),
      fallback: c.get<string>('fallbackAgent', 'forgeathon-fallback'),
      port: c.get<number>('mcpPort', 8791),
      retries: c.get<number>('maxRetries', 2),
      firstTokenTimeoutMs: c.get<number>('firstTokenTimeoutSeconds', 30) * 1000,
    };
  }

  workspaceRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Start (or restart for a new folder) the MCP server TrueForge connects to. */
  async ensureMcp(): Promise<string | undefined> {
    const root = this.workspaceRoot();
    if (!root) return 'Open a folder (for example the Flask repo) first.';
    if (this.mcp && this.mcpRoot === root) return undefined;
    await this.mcp?.close();
    this.mcp = undefined;
    try {
      this.mcp = await startMcpServer({ root, port: this.cfg().port, decisions: this.decisions, onCall: (n) => this.out.appendLine(`[mcp] ${n}`) });
      this.mcpRoot = root;
      this.out.appendLine(`[mcp] editor MCP server listening on http://127.0.0.1:${this.mcp.port}/mcp (root ${root})`);
      return undefined;
    } catch (e) {
      const msg = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `Port ${this.cfg().port} is already in use (another VS Code window?). Change "forge.mcpPort" and re-run setup.` : String((e as Error).message);
      return `Could not start the editor MCP server: ${msg}`;
    }
  }

  private summarize(t: ToolCallInfo): string {
    const a = t.args ?? {};
    const bits: string[] = [];
    if (a.path) bits.push(String(a.path) + (a.start_line ? `:${a.start_line}-${a.end_line ?? ''}` : ''));
    if (a.query) bits.push(`/${a.query}/`);
    if (a.name) bits.push(String(a.name));
    if (a.command) bits.push(`$ ${a.command}`);
    if (Array.isArray(a.edits)) bits.push(`${a.edits.length} edit(s)`);
    if (Array.isArray(a.files)) bits.push(`${a.files.length} file(s)`);
    return bits.join('  ');
  }

  private async approve(t: ToolCallInfo): Promise<Approval> {
    const root = this.workspaceRoot()!;
    if (t.name === 'propose_edit' || t.name === 'propose_write') {
      const plan = prepareProposal(root, t.name, t.args);
      if (!plan.ok) {
        this.post({ type: 'note', text: `Proposal rejected automatically: ${plan.error}` });
        return { status: 'deny', reason: plan.error };
      }
      this.post({ type: 'note', text: `Review needed: ${plan.proposal.path} (${plan.proposal.hunks.length} hunk(s)). Use the Accept/Reject lenses in the diff editor.` });
      const outcome = await this.review.review(plan.proposal);
      this.post({ type: 'review', path: plan.proposal.path, accepted: outcome.accepted, total: outcome.total, applied: outcome.applied, note: outcome.note ?? '' });
      if (outcome.accepted === 0) {
        return { status: 'deny', reason: `The user rejected all ${outcome.total} hunk(s) of ${plan.proposal.path}.${outcome.note ? ' ' + outcome.note : ''}` };
      }
      this.decisions.set(decisionKey(t.name, t.args), { path: plan.proposal.path, total: outcome.total, accepted: outcome.accepted, rejected: outcome.rejected, applied: outcome.applied, note: outcome.note });
      return { status: 'allow' };
    }
    if (t.name === 'run_command') {
      const pick = await vscode.window.showWarningMessage('The agent wants to run a command in your workspace.', { modal: true, detail: String(t.args?.command ?? '') }, 'Run');
      return pick === 'Run' ? { status: 'allow' } : { status: 'deny', reason: 'The user declined to run this command.' };
    }
    return { status: 'deny', reason: `The editor does not approve unknown tool "${t.name}".` };
  }

  /** Send one request to the agent. Streams into the panel; edits are only ever applied through the review flow. */
  async run(userText: string, label?: string): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage('Forge: a run is already in progress. Stop it first.');
      return;
    }
    const problem = await this.ensureMcp();
    if (problem) {
      this.post({ type: 'error', text: problem });
      void vscode.window.showErrorMessage(`Forge: ${problem}`);
      return;
    }
    const root = this.workspaceRoot()!;
    const { context, items } = resolveMentions(root, userText);
    const message = context ? `${userText}\n\n${context}` : userText;
    const cfg = this.cfg();
    this.runner = new TrueForgeRunner(cfg.baseUrl);
    this.decisions.clear();
    this.running = true;
    this.setStatus('running');
    this.post({ type: 'user', text: label ?? userText });
    if (items.length) this.post({ type: 'attached', items });
    this.post({ type: 'state', running: true });

    const hooks: RunHooks = {
      onSession: (id, agent) => {
        this.out.appendLine(`[forge] session ${id} on agent ${agent}`);
        this.post({ type: 'note', text: `TrueForge session ${id.slice(0, 8)}… on agent "${agent}"` });
      },
      onText: (id, delta) => this.post({ type: 'text', id, delta }),
      onToolCall: (t) => {
        this.out.appendLine(`[tool] ${t.name} ${this.summarize(t)}${t.viaDeferred ? ' (deferred call_tool)' : ''}`);
        this.post({ type: 'tool', id: t.id, name: t.name, summary: this.summarize(t), args: t.args });
        if (t.name === 'declare_context') this.post({ type: 'context', files: t.args?.files ?? [] });
      },
      onToolResult: (id, preview) => this.post({ type: 'toolresult', id, preview }),
      onNote: (text) => {
        this.out.appendLine(`[note] ${text}`);
        this.post({ type: 'note', text });
      },
      approve: (t) => this.approve(t),
    };
    try {
      const agents = [cfg.primary, cfg.fallback].filter((a): a is string => !!a);
      const r = await this.runner.runResilient(message, hooks, { agents, maxRetries: cfg.retries, firstTokenTimeoutMs: cfg.firstTokenTimeoutMs });
      if (r.status === 'cancelled') {
        this.review.discardAll('stopped by user');
        this.post({ type: 'stopped' });
      } else if (r.status === 'error') {
        this.post({ type: 'error', text: r.error ?? 'Unknown error' });
        void vscode.window.showErrorMessage(`Forge: ${r.error}`);
      } else {
        this.post({ type: 'done', output: r.output ?? '' });
      }
    } catch (e) {
      this.post({ type: 'error', text: String((e as Error).message) });
    } finally {
      this.running = false;
      this.runner = undefined;
      this.setStatus('idle');
      this.post({ type: 'state', running: false });
    }
  }

  /** Stop button: cancel the TrueForge turn, drop open reviews (nothing half-applied), kill running commands. */
  async stop(): Promise<void> {
    if (!this.running || !this.runner) return;
    const p = this.runner.stop();
    this.review.discardAll('stopped by user');
    if (this.mcp) killAll(this.mcp.ctx);
    this.post({ type: 'note', text: 'Stopping…' });
    await p;
  }

  suggest(query: string): { kind: 'file' | 'symbol'; value: string }[] {
    const root = this.workspaceRoot();
    if (!root) return [];
    const q = query.replace(/^(file:|symbol:)/, '').toLowerCase();
    const out: { kind: 'file' | 'symbol'; value: string }[] = [];
    if (!query.startsWith('symbol:')) {
      for (const f of walk(root)) {
        if (f.toLowerCase().includes(q)) out.push({ kind: 'file', value: f });
        if (out.length >= 6) break;
      }
    }
    if (!query.startsWith('file:') && q.length >= 2) {
      for (const s of findSymbol(root, q, 5)) out.push({ kind: 'symbol', value: s.name });
    }
    return out.slice(0, 10);
  }

  private setStatus(state: 'idle' | 'running') {
    this.status.text = state === 'running' ? '$(sync~spin) Forge: running' : '$(hubot) Forge';
    this.status.tooltip = state === 'running' ? 'Click to stop' : 'Open the Forge agent panel';
    this.status.command = state === 'running' ? 'forge.stop' : 'forge.openPanel';
  }

  async smokeTest(): Promise<void> {
    const cfg = this.cfg();
    this.out.show(true);
    const runner = new TrueForgeRunner(cfg.baseUrl);
    this.out.appendLine(`[hello] talking to TrueForge at ${cfg.baseUrl} with agent ${cfg.primary}`);
    const r = await runner.runResilient('Say hello in one short sentence.', { onText: (_i, d) => this.out.append(d), approve: async () => ({ status: 'deny', reason: 'smoke test' }), onNote: (m) => this.out.appendLine(`\n[note] ${m}`) }, { agents: [cfg.primary], maxRetries: 0, firstTokenTimeoutMs: cfg.firstTokenTimeoutMs });
    this.out.appendLine(`\n[hello] status=${r.status}${r.error ? ' error=' + r.error : ''}`);
  }

  dispose() {
    void this.mcp?.close();
  }
}
