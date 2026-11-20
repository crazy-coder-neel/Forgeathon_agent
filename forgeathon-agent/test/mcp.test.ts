import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMcpServer } from '../src/mcp/server';
import { decisionKey } from '../src/mcp/decisions';
import { resolveMentions } from '../src/context/mentions';

const FLASK = process.env.FLASK_DIR ?? '/home/claude/flask';
const have = fs.existsSync(`${FLASK}/src/flask/cli.py`);

async function withClient<T>(fn: (c: Client, srv: Awaited<ReturnType<typeof startMcpServer>>) => Promise<T>): Promise<T> {
  const srv = await startMcpServer({ root: FLASK, port: 0 });
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
  try {
    return await fn(client, srv);
  } finally {
    await client.close();
    await srv.close();
  }
}
const text = (r: any) => (r.content as any[]).map((c) => c.text).join('\n');

test('lists all editor tools', { skip: !have }, async () => {
  await withClient(async (c) => {
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    for (const n of ['repo_map', 'list_files', 'search_workspace', 'find_symbol', 'read_file', 'read_symbol', 'declare_context', 'propose_edit', 'propose_write', 'run_command']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  });
});

test('repo_map is size-capped and useful', { skip: !have }, async () => {
  await withClient(async (c) => {
    const t = text(await c.callTool({ name: 'repo_map', arguments: {} }));
    assert.ok(t.length <= 8300, `repo_map too big: ${t.length}`);
    assert.match(t, /cli\.py/);
    const sub = text(await c.callTool({ name: 'repo_map', arguments: { path: 'src/flask' } }));
    assert.match(sub, /helpers\.py/);
    console.log('repo_map chars:', t.length, '| sub:', sub.length);
  });
});

test('search, find_symbol, read_file range + cap', { skip: !have }, async () => {
  await withClient(async (c) => {
    const s = text(await c.callTool({ name: 'search_workspace', arguments: { query: 'def get_debug_flag', glob: '*.py' } }));
    assert.match(s, /helpers\.py:\d+/);
    const f = text(await c.callTool({ name: 'find_symbol', arguments: { name: 'get_debug_flag' } }));
    assert.match(f, /src\/flask\/helpers\.py:\d+\s+function get_debug_flag/);
    const r = text(await c.callTool({ name: 'read_file', arguments: { path: 'src/flask/cli.py', start_line: 1, end_line: 30 } }));
    assert.match(r, /lines 1-30 of/);
    const big = text(await c.callTool({ name: 'read_file', arguments: { path: 'src/flask/cli.py' } }));
    assert.ok(big.length <= 8300);
    const sym = text(await c.callTool({ name: 'read_symbol', arguments: { name: 'get_debug_flag' } }));
    assert.match(sym, /FLASK_DEBUG/);
    const esc = await c.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
    assert.equal(esc.isError, true);
  });
});

test('propose_edit without a recorded decision never writes', { skip: !have }, async () => {
  await withClient(async (c) => {
    const before = fs.statSync(`${FLASK}/src/flask/helpers.py`).mtimeMs;
    const r: any = await c.callTool({ name: 'propose_edit', arguments: { path: 'src/flask/helpers.py', edits: [{ old_str: 'x', new_str: 'y' }] } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Nothing was written/);
    assert.equal(fs.statSync(`${FLASK}/src/flask/helpers.py`).mtimeMs, before);
  });
});

test('recorded decision is reported back to the agent', { skip: !have }, async () => {
  await withClient(async (c, srv) => {
    const args = { path: 'src/flask/cli.py', edits: [{ old_str: 'a', new_str: 'b' }], summary: 's' };
    srv.ctx.decisions.set(decisionKey('propose_edit', args), { path: args.path, total: 3, accepted: 2, rejected: 1, applied: true });
    const r: any = await c.callTool({ name: 'propose_edit', arguments: args });
    assert.match(text(r), /Applied 2 of 3 hunk/);
    assert.match(text(r), /rejected 1/);
  });
});

test('run_command captures output and exit code', { skip: !have }, async () => {
  await withClient(async (c) => {
    const ok: any = await c.callTool({ name: 'run_command', arguments: { command: 'echo hello && exit 0' } });
    assert.match(text(ok), /hello/);
    assert.match(text(ok), /exit code 0/);
    const bad: any = await c.callTool({ name: 'run_command', arguments: { command: 'exit 3' } });
    assert.equal(bad.isError, true);
  });
});

test('@mentions resolve within budget', { skip: !have }, () => {
  const r = resolveMentions(FLASK, 'fix @src/flask/helpers.py and @symbol:get_debug_flag and @nonexistent_thing');
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].ok, true);
  assert.equal(r.items[1].ok, true);
  assert.equal(r.items[2].ok, false);
  assert.ok(r.context.length < 20000 + 400);
  assert.match(r.context, /@symbol get_debug_flag/);
});
