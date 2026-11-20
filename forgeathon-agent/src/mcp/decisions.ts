// Bridge between the review UI and the MCP tools.
// Flow: TrueForge pauses on propose_* (tool approval) -> extension shows the diff -> user decides per hunk ->
// extension applies accepted hunks and records the outcome here -> approval is sent -> the MCP tool runs and
// simply REPORTS that outcome to the agent. The MCP tool itself never writes to disk.
import { createHash } from 'node:crypto';

export interface Decision {
  path: string;
  total: number;
  accepted: number;
  rejected: number;
  applied: boolean;
  note?: string;
}

export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Key a proposal by the fields that define it (so extra/missing optional args like `summary` cannot break the match). */
export function decisionKey(tool: string, args: any): string {
  const core = tool === 'propose_write' ? { path: args?.path, content: args?.content } : { path: args?.path, edits: args?.edits };
  return createHash('sha1').update(`${tool}:${stable(core)}`).digest('hex');
}

export class DecisionStore {
  private map = new Map<string, Decision>();
  set(key: string, d: Decision) {
    this.map.set(key, d);
  }
  take(key: string): Decision | undefined {
    const d = this.map.get(key);
    this.map.delete(key);
    return d;
  }
  clear() {
    this.map.clear();
  }
}
