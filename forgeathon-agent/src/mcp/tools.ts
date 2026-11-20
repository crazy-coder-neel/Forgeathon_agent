// The editor capabilities exposed to the TrueForge agent as MCP tools.
// Pure Node (no vscode import) so they can be tested headlessly against any directory.
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { BUDGET, cap, capTail } from '../context/budget';
import { repoMap } from '../context/repoMap';
import { searchWorkspace } from '../context/search';
import { blockEnd, findSymbol } from '../context/symbols';
import { isBinary, isProtectedPath, resolveInside, toRel, walk, globToRegExp } from '../context/workspace';
import { DecisionStore, decisionKey } from './decisions';

export interface ToolContext {
  root: string;
  decisions: DecisionStore;
  processes: Set<ChildProcess>;
}

export interface ToolDef {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  readOnly: boolean;
  handler: (args: any, ctx: ToolContext) => Promise<{ text: string; isError?: boolean }>;
}

export function isSensitiveEnvVar(key: string): boolean {
  if (/^(PATH|TERM|SHELL|USER|LOGNAME|HOME|LANG|LC_|EDITOR|PWD|SHLVL|VIRTUAL_ENV|PYTHONUNBUFFERED|CI)$/i.test(key)) {
    return false;
  }
  return /(API_?KEY|SECRET|TOKEN|PASSW(OR)?D|AUTH|CREDENTIAL|PRIVATE_?KEY)/i.test(key);
}

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let res = text;
  for (const [k, v] of Object.entries(env)) {
    if (v && v.length >= 6 && isSensitiveEnvVar(k)) {
      res = res.split(v).join('[REDACTED_SECRET]');
    }
  }
  res = res.replace(new RegExp('AI' + 'za[0-9A-Za-z_-]{35}', 'g'), '[REDACTED_API_KEY]');
  res = res.replace(new RegExp('s' + 'k-[a-zA-Z0-9_-]{20,}', 'g'), '[REDACTED_API_KEY]');
  res = res.replace(/gh[pousr]_[A-Za-z0-9_]{36,}/g, '[REDACTED_TOKEN]');
  res = res.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{20,}/gi, '$1[REDACTED_TOKEN]');
  res = res.replace(/-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  return res;
}

const ok = (text: string) => ({ text: redactSecrets(cap(text)) });
const fail = (text: string) => ({ text: redactSecrets(text), isError: true });

// Commands run with the workspace's Python virtualenv first on PATH (when one exists), so `python -m pytest`
// works no matter how VS Code itself was launched. Sensitive parent env vars are stripped to prevent leakage.
export function commandEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', PYTHONUNBUFFERED: '1' };
  for (const [k, v] of Object.entries(process.env)) {
    if (!isSensitiveEnvVar(k)) {
      env[k] = v;
    }
  }
  for (const dir of ['.venv', 'venv']) {
    const bin = path.join(root, dir, process.platform === 'win32' ? 'Scripts' : 'bin');
    if (fs.existsSync(bin)) {
      const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
      env[key] = bin + path.delimiter + (env[key] ?? '');
      env.VIRTUAL_ENV = path.join(root, dir);
      break;
    }
  }
  return env;
}

export function killAll(ctx: ToolContext) {
  for (const p of ctx.processes) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  ctx.processes.clear();
}

export const TOOLS: ToolDef[] = [
  {
    name: 'repo_map',
    readOnly: true,
    description:
      'START HERE for any task in an unfamiliar repo. Returns a size-capped map of the directory tree with the top-level symbols (classes/functions) of each file. Pass `path` to zoom into a sub-directory. Cheap; use it before reading any file.',
    shape: { path: z.string().optional().describe('Sub-directory to map, relative to the workspace root. Default: whole repo.') },
    handler: async (a, ctx) => ok(repoMap(ctx.root, a.path ?? '')),
  },
  {
    name: 'list_files',
    readOnly: true,
    description: 'List files under a directory (recursive), optionally filtered by a glob such as "tests/**/*.py". Capped at 300 entries.',
    shape: { path: z.string().optional(), glob: z.string().optional() },
    handler: async (a, ctx) => {
      try {
        let files = walk(ctx.root, a.path ?? '');
        if (a.glob) {
          const re = globToRegExp(a.glob.includes('/') ? a.glob : `**/${a.glob}`);
          files = files.filter((f) => re.test(f));
        }
        const shown = files.slice(0, 300);
        return ok(`${files.length} files${files.length > 300 ? ' (showing 300)' : ''}\n${shown.join('\n')}`);
      } catch (e) {
        return fail(String((e as Error).message));
      }
    },
  },
  {
    name: 'search_workspace',
    readOnly: true,
    description:
      'Search file contents (ripgrep if available, else a built-in scan). `query` is a regex. Returns up to 40 hits as file:line: text, max 5 per file. Prefer this over reading whole files to locate code.',
    shape: {
      query: z.string().describe('Regex or plain text to search for.'),
      glob: z.string().optional().describe('Restrict to files matching this glob, e.g. "*.py" or "src/**/*.py".'),
      case_sensitive: z.boolean().optional(),
    },
    handler: async (a, ctx) => {
      const hits = await searchWorkspace(ctx.root, a.query, a.glob, !a.case_sensitive);
      if (!hits.length) return ok(`No matches for /${a.query}/.`);
      return ok(hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join('\n'));
    },
  },
  {
    name: 'find_symbol',
    readOnly: true,
    description: 'Find where a class/function/method is defined by name (exact matches first, then partial). Returns file:line and kind.',
    shape: { name: z.string() },
    handler: async (a, ctx) => {
      const syms = findSymbol(ctx.root, a.name);
      if (!syms.length) return ok(`No symbol named "${a.name}". Try search_workspace.`);
      return ok(syms.map((s) => `${s.file}:${s.line}  ${s.kind} ${s.name}`).join('\n'));
    },
  },
  {
    name: 'read_file',
    readOnly: true,
    description: `Read a file with line numbers. Defaults to the first ${BUDGET.readLines} lines; pass start_line/end_line for a range. Output is capped at ${BUDGET.toolResult} chars. Never read a whole large file: locate code with search_workspace/find_symbol first, then read the relevant range.`,
    shape: { path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() },
    handler: async (a, ctx) => {
      try {
        if (isProtectedPath(a.path)) return fail(`Access denied: "${a.path}" is a protected or sensitive file.`);
        const abs = resolveInside(ctx.root, a.path);
        const rel = toRel(ctx.root, abs);
        if (isProtectedPath(rel)) return fail(`Access denied: "${a.path}" is a protected or sensitive file.`);
        if (isBinary(abs)) return fail('Binary file, not readable.');
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const start = a.start_line ?? 1;
        const end = Math.min(a.end_line ?? start + BUDGET.readLines - 1, lines.length, start + 1000);
        if (start > lines.length) return fail(`File has only ${lines.length} lines.`);
        const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join('\n');
        return ok(`${a.path} (lines ${start}-${end} of ${lines.length})\n${body}`);
      } catch (e) {
        return fail(String((e as Error).message));
      }
    },
  },
  {
    name: 'read_symbol',
    readOnly: true,
    description: 'Read the full body of a function/class by name (uses find_symbol + block detection). Cheaper than read_file when you know the symbol.',
    shape: { name: z.string(), file: z.string().optional().describe('Disambiguate by file path.') },
    handler: async (a, ctx) => {
      const syms = findSymbol(ctx.root, a.name).filter((s) => s.name === a.name && (!a.file || s.file === a.file));
      if (!syms.length) return fail(`No symbol "${a.name}"${a.file ? ` in ${a.file}` : ''}.`);
      const s = syms[0];
      if (isProtectedPath(s.file)) return fail(`Access denied: "${s.file}" is a protected or sensitive file.`);
      const lines = fs.readFileSync(resolveInside(ctx.root, s.file), 'utf8').split('\n');
      const end = blockEnd(lines, s.line, s.file);
      const body = lines.slice(s.line - 1, end).map((l, i) => `${String(s.line + i).padStart(5)}| ${l}`).join('\n');
      const more = syms.length > 1 ? `\n(${syms.length - 1} other match(es): ${syms.slice(1, 4).map((x) => `${x.file}:${x.line}`).join(', ')})` : '';
      return ok(`${s.file} (lines ${s.line}-${end})\n${body}${more}`);
    },
  },
  {
    name: 'declare_context',
    readOnly: true,
    description:
      'Tell the user which files/symbols you chose to read and WHY (one short reason each). Call this once after you finish exploring and before you propose edits. It has no side effects; it is shown in the editor panel.',
    shape: { files: z.array(z.object({ path: z.string(), reason: z.string() })).min(1) },
    handler: async (a) => ok(`Recorded ${a.files.length} context item(s).`),
  },
  {
    name: 'propose_edit',
    readOnly: false,
    description:
      'Propose edits to an EXISTING file as search/replace pairs. This does NOT write to disk: the user reviews every hunk in the editor and accepts or rejects each one; the result tells you what was applied. Each old_str must match the file exactly once (include enough surrounding lines to be unique). Make the smallest change that satisfies the request; do not touch unrelated code. Several edits to one file go in one call.',
    shape: {
      path: z.string().describe('File path relative to the workspace root.'),
      edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })).min(1),
      summary: z.string().optional().describe('One sentence on what this change does.'),
    },
    handler: async (a, ctx) => reportDecision('propose_edit', a, ctx),
  },
  {
    name: 'propose_write',
    readOnly: false,
    description:
      'Propose creating a NEW file (or fully replacing a small file) with the given content. Does NOT write to disk: the user reviews the diff and accepts or rejects it. For changes to existing files prefer propose_edit.',
    shape: { path: z.string(), content: z.string(), summary: z.string().optional() },
    handler: async (a, ctx) => reportDecision('propose_write', a, ctx),
  },
  {
    name: 'run_command',
    readOnly: false,
    description: `Run a shell command in the workspace root (for example tests: "python -m pytest tests/test_cli.py -q"). The user must approve every command. Output is capped to the last ${BUDGET.commandOutput} chars; timeout ${BUDGET.commandTimeoutMs / 1000}s. Edits you proposed and the user accepted are already on disk when this runs.`,
    shape: { command: z.string(), timeout_seconds: z.number().int().min(1).max(600).optional() },
    handler: async (a, ctx) => {
      const timeout = Math.min((a.timeout_seconds ?? BUDGET.commandTimeoutMs / 1000) * 1000, 600_000);
      return new Promise((resolve) => {
        const child = spawn(a.command, { cwd: ctx.root, shell: true, env: commandEnv(ctx.root) });
        ctx.processes.add(child);
        let out = '';
        const onData = (d: Buffer) => {
          out += d.toString();
          if (out.length > 200_000) out = out.slice(-100_000);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          out += `\n[killed: timeout after ${timeout / 1000}s]`;
        }, timeout);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          ctx.processes.delete(child);
          const status = signal ? `killed by ${signal}` : `exit code ${code}`;
          resolve({ text: redactSecrets(`$ ${a.command}\n${capTail(out.trim(), BUDGET.commandOutput)}\n[${status}]`), isError: code !== 0 });
        });
        child.on('error', (e) => {
          clearTimeout(timer);
          ctx.processes.delete(child);
          resolve({ text: redactSecrets(`Failed to start: ${e.message}`), isError: true });
        });
      });
    },
  },
];

function reportDecision(tool: string, args: any, ctx: ToolContext) {
  const d = ctx.decisions.take(decisionKey(tool, args));
  if (!d) {
    return fail(
      `No review decision was recorded for ${args.path}. Nothing was written to disk. (The change must be approved in the editor.)`,
    );
  }
  if (d.accepted === 0) return ok(`The user REJECTED all ${d.total} hunk(s) for ${d.path}. Nothing was written. Ask what they want instead, or try a different approach.`);
  const partial = d.rejected > 0 ? ` The user rejected ${d.rejected} hunk(s); those were NOT applied, do not re-propose them unless asked.` : '';
  return ok(`Applied ${d.accepted} of ${d.total} hunk(s) to ${d.path} (user-approved).${partial}${d.note ? ' ' + d.note : ''}`);
}
