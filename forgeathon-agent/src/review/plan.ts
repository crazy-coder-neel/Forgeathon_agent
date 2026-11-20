// Pure planning for a propose_edit / propose_write call: compute the proposed file and its hunks.
import * as fs from 'node:fs';
import { isProtectedPath, resolveInside, toRel } from '../context/workspace';
import { applyEdits, computeHunks, Hunk } from './hunks';

export interface Proposal {
  tool: 'propose_edit' | 'propose_write';
  path: string;
  abs: string;
  isNew: boolean;
  original: string;
  proposed: string;
  hunks: Hunk[];
  summary: string;
}

export type PlanResult = { ok: true; proposal: Proposal } | { ok: false; error: string };

export function prepareProposal(root: string, tool: string, args: any): PlanResult {
  if (tool !== 'propose_edit' && tool !== 'propose_write') return { ok: false, error: `Unsupported tool ${tool}` };
  if (!args || typeof args.path !== 'string') return { ok: false, error: 'Missing "path" argument.' };
  if (isProtectedPath(args.path)) {
    return { ok: false, error: `Access denied: cannot modify protected or sensitive file "${args.path}".` };
  }
  let abs: string;
  try {
    abs = resolveInside(root, args.path);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  const rel = toRel(root, abs);
  if (isProtectedPath(rel)) {
    return { ok: false, error: `Access denied: cannot modify protected or sensitive file "${args.path}".` };
  }
  const exists = fs.existsSync(abs);
  const original = exists ? fs.readFileSync(abs, 'utf8') : '';
  let proposed: string;
  if (tool === 'propose_edit') {
    if (!exists) return { ok: false, error: `${args.path} does not exist. Use propose_write to create a new file.` };
    if (!Array.isArray(args.edits) || args.edits.length === 0) return { ok: false, error: 'propose_edit needs a non-empty "edits" array.' };
    const r = applyEdits(original, args.edits);
    if (!r.ok) return { ok: false, error: `${args.path}: ${r.error}` };
    proposed = r.content;
  } else {
    if (typeof args.content !== 'string') return { ok: false, error: 'propose_write needs a string "content".' };
    proposed = args.content;
  }
  const hunks = computeHunks(original, proposed);
  if (hunks.length === 0) return { ok: false, error: `The proposed change to ${args.path} makes no difference to the file.` };
  return {
    ok: true,
    proposal: { tool, path: args.path, abs, isNew: !exists, original, proposed, hunks, summary: String(args.summary ?? '') },
  };
}
