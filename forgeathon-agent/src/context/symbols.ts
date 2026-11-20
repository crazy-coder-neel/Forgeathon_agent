// Regex-based symbol index. Works with no language server, so it behaves the same on any machine.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInside, walk } from './workspace';

export interface Sym {
  name: string;
  kind: 'class' | 'function' | 'method' | 'const';
  file: string;
  line: number; // 1-based
  topLevel: boolean;
}

const PATTERNS: Record<string, RegExp[]> = {
  '.py': [/^(\s*)(?:async\s+)?(def)\s+([A-Za-z_]\w*)/, /^(\s*)(class)\s+([A-Za-z_]\w*)/],
  '.ts': [/^(\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\s*\*?\s*([A-Za-z_$][\w$]*)/, /^(\s*)(?:export\s+)?(?:abstract\s+)?(class)\s+([A-Za-z_$][\w$]*)/, /^(\s*)(?:export\s+)?(const)\s+([A-Za-z_$][\w$]*)\s*[:=]/],
  '.go': [/^()(func)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, /^()(type)\s+([A-Za-z_]\w*)/],
  '.java': [/^(\s*)(?:public|private|protected)?\s*(?:static\s+)?(class|interface)\s+([A-Za-z_]\w*)/],
};
PATTERNS['.tsx'] = PATTERNS['.ts'];
PATTERNS['.js'] = PATTERNS['.ts'];
PATTERNS['.jsx'] = PATTERNS['.ts'];

export function fileSymbols(root: string, rel: string): Sym[] {
  const pats = PATTERNS[path.extname(rel).toLowerCase()];
  if (!pats) return [];
  let text: string;
  try {
    text = fs.readFileSync(resolveInside(root, rel), 'utf8');
  } catch {
    return [];
  }
  if (text.length > 1_000_000) return [];
  const out: Sym[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of pats) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const indent = m[1].length;
      const kw = m[2];
      const kind: Sym['kind'] = kw === 'class' || kw === 'type' || kw === 'interface' ? 'class' : kw === 'const' ? 'const' : indent > 0 ? 'method' : 'function';
      out.push({ name: m[3], kind, file: rel, line: i + 1, topLevel: indent === 0 });
      break;
    }
  }
  return out;
}

let cache: { root: string; at: number; syms: Sym[] } | null = null;

export function indexSymbols(root: string, force = false): Sym[] {
  if (!force && cache && cache.root === root && Date.now() - cache.at < 30_000) return cache.syms;
  const syms: Sym[] = [];
  for (const f of walk(root)) syms.push(...fileSymbols(root, f));
  cache = { root, at: Date.now(), syms };
  return syms;
}

export function findSymbol(root: string, query: string, max = 20): Sym[] {
  const q = query.toLowerCase();
  const all = indexSymbols(root);
  const exact = all.filter((s) => s.name.toLowerCase() === q);
  const partial = all.filter((s) => s.name.toLowerCase() !== q && s.name.toLowerCase().includes(q));
  return [...exact, ...partial].slice(0, max);
}

/** End line (1-based, inclusive) of the block starting at `startLine`, using indentation (python) or braces. */
export function blockEnd(lines: string[], startLine: number, file: string): number {
  const start = startLine - 1;
  if (file.endsWith('.py')) {
    const indent = /^\s*/.exec(lines[start])![0].length;
    let end = start;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      const ind = /^\s*/.exec(l)![0].length;
      if (ind <= indent && !/^\s*[)\]}]/.test(l)) break;
      end = i;
    }
    return end + 1;
  }
  let depth = 0;
  let seen = false;
  for (let i = start; i < Math.min(lines.length, start + 400); i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        seen = true;
      } else if (ch === '}') depth--;
    }
    if (seen && depth <= 0) return i + 1;
  }
  return Math.min(lines.length, startLine + 60);
}
