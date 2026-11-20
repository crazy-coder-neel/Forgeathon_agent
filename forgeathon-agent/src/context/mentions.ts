// Explicit @file / @symbol mentions, resolved by the extension and attached to the turn within a size budget.
import * as fs from 'node:fs';
import { BUDGET, cap } from './budget';
import { blockEnd, findSymbol } from './symbols';
import { resolveInside } from './workspace';

export interface MentionItem {
  kind: 'file' | 'symbol';
  ref: string;
  chars: number;
  truncated: boolean;
  ok: boolean;
}

export interface Resolved {
  context: string;
  items: MentionItem[];
}

const RE = /(^|\s)@(file:|symbol:)?([^\s,;()]+)/g;

function numbered(lines: string[], start: number): string {
  return lines.map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join('\n');
}

export function resolveMentions(root: string, text: string): Resolved {
  const items: MentionItem[] = [];
  const blocks: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const m of text.matchAll(RE)) {
    const explicit = m[2];
    const ref = m[3].replace(/[.:]+$/, '');
    const key = `${explicit ?? ''}${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let block: string | null = null;
    let kind: MentionItem['kind'] = 'file';
    const tryFile = () => {
      try {
        const abs = resolveInside(root, ref);
        if (fs.statSync(abs).isFile()) {
          const lines = fs.readFileSync(abs, 'utf8').split('\n');
          const body = numbered(lines, 1);
          return `### @file ${ref} (${lines.length} lines)\n${body}`;
        }
      } catch {
        /* not a file */
      }
      return null;
    };
    const trySymbol = () => {
      const s = findSymbol(root, ref).find((x) => x.name === ref);
      if (!s) return null;
      const lines = fs.readFileSync(resolveInside(root, s.file), 'utf8').split('\n');
      const end = blockEnd(lines, s.line, s.file);
      return `### @symbol ${ref} (${s.file}:${s.line}-${end})\n${numbered(lines.slice(s.line - 1, end), s.line)}`;
    };
    if (explicit === 'symbol:') {
      kind = 'symbol';
      block = trySymbol();
    } else if (explicit === 'file:') {
      block = tryFile();
    } else {
      block = tryFile();
      if (!block) {
        block = trySymbol();
        if (block) kind = 'symbol';
      }
    }
    if (!block) {
      items.push({ kind, ref, chars: 0, truncated: false, ok: false });
      continue;
    }
    const room = Math.max(0, Math.min(BUDGET.mentionEach, BUDGET.mentionTotal - total));
    if (room < 300) {
      items.push({ kind, ref, chars: 0, truncated: true, ok: false });
      continue;
    }
    const capped = cap(block, room, 'use read_file with a line range for the rest');
    total += capped.length;
    items.push({ kind, ref, chars: capped.length, truncated: capped.length < block.length, ok: true });
    blocks.push(capped);
  }
  const context = blocks.length ? `<attached_context note="explicit @mentions, size-capped; use read_file for more">\n${blocks.join('\n\n')}\n</attached_context>` : '';
  return { context, items };
}
