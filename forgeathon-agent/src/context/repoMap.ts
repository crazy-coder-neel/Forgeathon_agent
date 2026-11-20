// Size-capped map of the repository: directory tree + top-level symbols per file.
import * as path from 'node:path';
import { BUDGET, cap } from './budget';
import { fileSymbols } from './symbols';
import { walk } from './workspace';

interface Node {
  dirs: Map<string, Node>;
  files: string[];
}

function build(files: string[], prefix: string): Node {
  const root: Node = { dirs: new Map(), files: [] };
  for (const f of files) {
    const rel = prefix ? f.slice(prefix.length + 1) : f;
    const parts = rel.split('/');
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { dirs: new Map(), files: [] });
      n = n.dirs.get(parts[i])!;
    }
    n.files.push(f);
  }
  return root;
}

function count(n: Node): number {
  let c = n.files.length;
  for (const d of n.dirs.values()) c += count(d);
  return c;
}

function render(root: string, n: Node, name: string, depth: number, opts: { maxDepth: number; symsPerFile: number }, lines: string[]) {
  const pad = '  '.repeat(depth);
  if (depth > 0) lines.push(`${pad}${name}/ (${count(n)} files)`);
  if (depth > opts.maxDepth) return;
  for (const f of n.files) {
    const base = path.posix.basename(f);
    let suffix = '';
    if (opts.symsPerFile > 0) {
      const syms = fileSymbols(root, f).filter((s) => s.topLevel).slice(0, opts.symsPerFile);
      if (syms.length) suffix = `  :: ${syms.map((s) => s.name).join(', ')}`;
    }
    lines.push(`${pad}${depth > 0 ? '  ' : ''}${base}${suffix}`);
  }
  for (const [dn, dnode] of n.dirs) render(root, dnode, dn, depth + 1, opts, lines);
}

export function repoMap(root: string, sub = '', maxChars = BUDGET.repoMap): string {
  const prefix = sub.replace(/^\/+|\/+$/g, '');
  const files = walk(root, prefix);
  if (files.length === 0) return `No files found under "${sub || '.'}".`;
  const tree = build(files, prefix);
  // Shrink detail until the map fits the budget: fewer symbols per file first, then less depth.
  for (const maxDepth of [8, 4, 2, 1]) {
    for (const symsPerFile of [8, 4, 2, 0]) {
      const lines: string[] = [`# repo map for ${prefix || '.'} (${files.length} files). Files list top-level symbols after '::'.`];
      render(root, tree, '', 0, { maxDepth, symsPerFile }, lines);
      const text = lines.join('\n');
      if (text.length <= maxChars) {
        const note = maxDepth < 8 || symsPerFile < 8 ? `\n(detail reduced to fit budget; call repo_map with a sub-path for more)` : '';
        return text + note;
      }
    }
  }
  return cap(`# repo map for ${prefix || '.'} (${files.length} files)\n${files.slice(0, 400).join('\n')}`, maxChars, 'call repo_map with a sub-path');
}
