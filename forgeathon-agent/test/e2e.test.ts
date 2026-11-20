// End-to-end test against a REAL local TrueForge server (npx @truefoundry/trueforge) with scripted mock models.
// Run: E2E=1 npm test   (TrueForge must be running and `node scripts/setup-trueforge.mjs config.local.test.json` done)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { startMcpServer } from '../src/mcp/server';
import { DecisionStore, decisionKey } from '../src/mcp/decisions';
import { prepareProposal } from '../src/review/plan';
import { renderHunks } from '../src/review/hunks';
import { TrueForgeRunner, RunHooks } from '../src/trueforge/client';
import { startMockLlm } from './helpers/mockLlm';

const E2E = process.env.E2E === '1';
const SRC = process.env.FLASK_DIR ?? '/home/claude/flask';
const WORK = '/tmp/flask-e2e';
const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';

function freshWorkspace() {
  fs.rmSync(WORK, { recursive: true, force: true });
  execSync(`cp -r ${SRC} ${WORK}`);
}
const gitStatus = () => execSync('git status --porcelain', { cwd: WORK }).toString().trim();

const OLD = '    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})';
const NEW = '    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})';

const editScript = (toolResults: string[]) => {
  if (toolResults.length === 0) return { kind: 'tool', match: 'repo_map', args: {} } as const;
  if (toolResults.length === 1) return { kind: 'tool', match: 'propose_edit', args: { path: 'src/flask/helpers.py', edits: [{ old_str: OLD, new_str: NEW }], summary: 'treat off/n as false' } } as const;
  return { kind: 'text', text: `Done. Result seen by agent: ${toolResults[1].slice(0, 120)}` } as const;
};

test('TrueForge reachable and agents registered', { skip: !E2E }, async () => {
  const r = new TrueForgeRunner(BASE);
  const names = await r.listAgents();
  assert.ok(names.includes('forgeathon-primary') && names.includes('forgeathon-fallback'), `agents: ${names}`);
});

test('Task A-style flow: primary 401 -> auto fallback -> repo_map -> approval -> per-hunk apply -> result reported', { skip: !E2E }, async () => {
  freshWorkspace();
  const decisions = new DecisionStore();
  const mcp = await startMcpServer({ root: WORK, port: 8791, decisions });
  const primary = await startMockLlm({ port: 9101, script: () => ({ kind: 'http', status: 401 }) });
  const fallback = await startMockLlm({ port: 9102, script: editScript });
  const notes: string[] = [];
  const toolsSeen: string[] = [];
  let text = '';
  let diskUnchangedAtApproval = false;
  const hooks: RunHooks = {
    onNote: (m) => notes.push(m),
    onToolCall: (t) => toolsSeen.push(t.name),
    onText: (_id, d) => (text += d),
    approve: async (t) => {
      assert.equal(t.name, 'propose_edit');
      const plan = prepareProposal(WORK, t.name, t.args);
      if (!plan.ok) return { status: 'deny', reason: plan.error };
      const p = plan.proposal;
      diskUnchangedAtApproval = fs.readFileSync(p.abs, 'utf8') === p.original && gitStatus() === '';
      assert.equal(p.hunks.length, 1);
      fs.writeFileSync(p.abs, renderHunks(p.original, p.hunks, () => true).text);
      decisions.set(decisionKey(t.name, t.args), { path: p.path, total: p.hunks.length, accepted: 1, rejected: 0, applied: true });
      return { status: 'allow' };
    },
  };
  try {
    const runner = new TrueForgeRunner(BASE);
    const r = await runner.runResilient('[INLINE EDIT] treat off and n as false', hooks, { agents: ['forgeathon-primary', 'forgeathon-fallback'], maxRetries: 1, backoffMs: 100 });
    console.log('notes:', notes);
    console.log('tools:', toolsSeen, '| final:', r.output);
    assert.equal(r.status, 'done', r.error ?? '');
    assert.equal(r.agent, 'forgeathon-fallback');
    assert.ok(notes.some((n) => /Switching automatically to fallback/.test(n)), 'fallback note missing');
    assert.ok(toolsSeen.some((n) => n.endsWith('repo_map')));
    assert.ok(diskUnchangedAtApproval, 'disk must be unchanged while approval is pending');
    assert.match(r.output ?? '', /Applied 1 of 1 hunk/);
    assert.match(fs.readFileSync(`${WORK}/src/flask/helpers.py`, 'utf8'), /"off", "n"/);
    assert.match(gitStatus(), /^M src\/flask\/helpers\.py$/);
    assert.ok(text.length > 0, 'streamed text expected');
  } finally {
    await mcp.close();
    await primary.close();
    await fallback.close();
  }
});

test('Task C: both models unreachable -> clear error, workspace unchanged', { skip: !E2E }, async () => {
  freshWorkspace();
  const mcp = await startMcpServer({ root: WORK, port: 8791 });
  const a = await startMockLlm({ port: 9101, script: () => ({ kind: 'http', status: 401 }) });
  const b = await startMockLlm({ port: 9102, script: () => ({ kind: 'http', status: 401 }) });
  try {
    const runner = new TrueForgeRunner(BASE);
    const t0 = Date.now();
    const r = await runner.runResilient('hello', { approve: async () => ({ status: 'deny', reason: 'n/a' }) }, { agents: ['forgeathon-primary', 'forgeathon-fallback'], maxRetries: 1, backoffMs: 100 });
    console.log('task C result:', r.status, '|', r.error, '|', Date.now() - t0, 'ms');
    assert.equal(r.status, 'error');
    assert.match(r.error ?? '', /No model could be reached/);
    assert.equal(gitStatus(), '');
  } finally {
    await mcp.close();
    await a.close();
    await b.close();
  }
});

test('TrueForge server down -> clear message, no hang', { skip: !E2E }, async () => {
  const runner = new TrueForgeRunner('http://127.0.0.1:1');
  const r = await runner.runResilient('hi', { approve: async () => ({ status: 'deny', reason: '' }) }, { agents: ['forgeathon-primary'], maxRetries: 0 });
  assert.equal(r.status, 'error');
  assert.match(r.error ?? '', /not reachable/);
});

test('cancellation is quick and leaves workspace clean', { skip: !E2E }, async () => {
  freshWorkspace();
  const mcp = await startMcpServer({ root: WORK, port: 8791 });
  const slow = await startMockLlm({ port: 9101, script: () => ({ kind: 'slow' }) });
  try {
    const runner = new TrueForgeRunner(BASE);
    let sawText = false;
    const p = runner.runResilient('long task', { onText: () => (sawText = true), approve: async () => ({ status: 'deny', reason: '' }) }, { agents: ['forgeathon-primary'], maxRetries: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(sawText, 'should be streaming before stop');
    const t0 = Date.now();
    await runner.stop();
    const r = await p;
    const ms = Date.now() - t0;
    console.log('cancel took', ms, 'ms ->', r.status);
    assert.equal(r.status, 'cancelled');
    assert.ok(ms < 3000, `cancel too slow: ${ms}`);
    assert.equal(gitStatus(), '');
  } finally {
    await mcp.close();
    await slow.close();
  }
});

test('deferred call_tool (run_command) and new-file propose_write both go through approval', { skip: !E2E }, async () => {
  freshWorkspace();
  const decisions = new DecisionStore();
  const mcp = await startMcpServer({ root: WORK, port: 8791, decisions });
  const model = await startMockLlm({
    port: 9101,
    script: (tr) => {
      if (tr.length === 0) return { kind: 'tool', match: 'call_tool', args: { mcp_server: 'forge-editor', tool_name: 'run_command', input: { command: 'echo deferred-ok' } } };
      if (tr.length === 1) return { kind: 'tool', match: 'propose_write', args: { path: 'docs/forge_e2e_note.md', content: '# note\nhello\n', summary: 'new doc' } };
      return { kind: 'text', text: `Finished. tool1=${tr[0].replace(/\s+/g, ' ').slice(0, 80)} | tool2=${tr[1].slice(0, 80)}` };
    },
  });
  const seen: { name: string; deferred: boolean }[] = [];
  try {
    const runner = new TrueForgeRunner(BASE);
    const r = await runner.runResilient(
      'do it',
      {
        onToolCall: (t) => seen.push({ name: t.name, deferred: t.viaDeferred }),
        approve: async (t) => {
          if (t.name === 'run_command') return { status: 'allow' };
          const plan = prepareProposal(WORK, t.name, t.args);
          if (!plan.ok) return { status: 'deny', reason: plan.error };
          assert.equal(plan.proposal.isNew, true);
          assert.equal(fs.existsSync(plan.proposal.abs), false, 'new file must not exist before accept');
          fs.mkdirSync(plan.proposal.abs.replace(/\/[^/]+$/, ''), { recursive: true });
          fs.writeFileSync(plan.proposal.abs, renderHunks(plan.proposal.original, plan.proposal.hunks, () => true).text);
          decisions.set(decisionKey(t.name, t.args), { path: plan.proposal.path, total: 1, accepted: 1, rejected: 0, applied: true });
          return { status: 'allow' };
        },
      },
      { agents: ['forgeathon-primary'], maxRetries: 0 },
    );
    console.log('deferred test:', JSON.stringify(seen), '|', r.output);
    assert.equal(r.status, 'done', r.error ?? '');
    assert.deepEqual(seen.map((s) => s.name), ['run_command', 'propose_write']);
    assert.equal(seen[0].deferred, true);
    assert.match(r.output ?? '', /deferred-ok/);
    assert.match(r.output ?? '', /Applied 1 of 1/);
    assert.equal(fs.readFileSync(`${WORK}/docs/forge_e2e_note.md`, 'utf8'), '# note\nhello\n');
  } finally {
    await mcp.close();
    await model.close();
  }
});

test('Task C variant: primary endpoint HANGS (no refusal) -> first-token watchdog -> automatic fallback', { skip: !E2E }, async () => {
  freshWorkspace();
  const mcp = await startMcpServer({ root: WORK, port: 8791 });
  const hang = await startMockLlm({ port: 9101, script: () => ({ kind: 'hang' }) });
  const ok = await startMockLlm({ port: 9102, script: () => ({ kind: 'text', text: 'fallback answered' }) });
  const notes: string[] = [];
  try {
    const runner = new TrueForgeRunner(BASE);
    const t0 = Date.now();
    const r = await runner.runResilient('hello', { onNote: (m) => notes.push(m), approve: async () => ({ status: 'deny', reason: '' }) }, { agents: ['forgeathon-primary', 'forgeathon-fallback'], maxRetries: 0, firstTokenTimeoutMs: 1500 });
    console.log('hang->fallback:', r.status, r.agent, Date.now() - t0, 'ms |', notes.join(' || '));
    assert.equal(r.status, 'done', r.error ?? '');
    assert.equal(r.agent, 'forgeathon-fallback');
    assert.match(r.output ?? '', /fallback answered/);
    assert.ok(notes.some((n) => /Switching automatically to fallback/.test(n)));
    assert.equal(gitStatus(), '');
  } finally {
    await mcp.close();
    await hang.close();
    await ok.close();
  }
});

test('rate limit (429) is waited out and the SAME session continues', { skip: !E2E }, async () => {
  freshWorkspace();
  const mcp = await startMcpServer({ root: WORK, port: 8791 });
  const t0 = Date.now();
  const m = await startMockLlm({
    port: 9101,
    script: () => {
      // 429 for the first 10 s so TrueForge's own retries are exhausted and the extension has to wait it out
      if (Date.now() - t0 < 10_000) return { kind: 'http', status: 429, body: JSON.stringify({ error: { message: 'RESOURCE_EXHAUSTED: quota exceeded. Please retry in 1s', code: 429 } }) };
      return { kind: 'text', text: 'continued after the rate limit' };
    },
  });
  const notes: string[] = [];
  const sessions: string[] = [];
  try {
    const runner = new TrueForgeRunner(BASE);
    const r = await runner.runResilient('hello', { onSession: (id) => sessions.push(id), onNote: (x) => notes.push(x), approve: async () => ({ status: 'deny', reason: '' }) }, { agents: ['forgeathon-primary'], maxRetries: 0 });
    console.log('rate-limit:', r.status, '| sessions:', sessions.length, '|', notes.join(' || '));
    assert.equal(r.status, 'done', r.error ?? '');
    assert.ok(notes.some((x) => /rate limit/i.test(x)), 'rate limit note expected');
    assert.equal(sessions.length, 1, 'must reuse the same TrueForge session');
    assert.match(r.output ?? '', /continued after the rate limit/);
  } finally {
    await mcp.close();
    await m.close();
  }
});
