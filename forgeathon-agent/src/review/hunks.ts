// Pure hunk logic (no vscode dependency) so it can be unit-tested in plain Node.
import { diffArrays } from 'diff';

export interface Hunk {
  id: number;
  /** 0-based index into the ORIGINAL line array where this hunk starts. */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

/** Split keeping line terminators, so join('') round-trips exactly. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split(/(?<=\n)/);
}

export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  const changes = diffArrays(a, b);
  const hunks: Hunk[] = [];
  let pos = 0;
  let cur: Hunk | null = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };
  for (const ch of changes) {
    const lines = ch.value as string[];
    if (!ch.added && !ch.removed) {
      flush();
      pos += lines.length;
      continue;
    }
    if (!cur) cur = { id: hunks.length, oldStart: pos, oldLines: [], newLines: [] };
    if (ch.removed) {
      cur.oldLines.push(...lines);
      pos += lines.length;
    } else {
      cur.newLines.push(...lines);
    }
  }
  flush();
  return hunks;
}

export interface Rendered {
  text: string;
  /** hunk id -> 0-based start line in the rendered text (only for included hunks). */
  starts: Map<number, number>;
}

/** Build text = original with only the `included` hunks applied. */
export function renderHunks(original: string, hunks: Hunk[], included: (h: Hunk) => boolean): Rendered {
  const a = splitLines(original);
  const out: string[] = [];
  const starts = new Map<number, number>();
  let pos = 0;
  for (const h of hunks) {
    for (; pos < h.oldStart; pos++) out.push(a[pos]);
    if (included(h)) {
      starts.set(h.id, out.length);
      out.push(...h.newLines);
    } else {
      out.push(...h.oldLines);
    }
    pos = h.oldStart + h.oldLines.length;
  }
  for (; pos < a.length; pos++) out.push(a[pos]);
  return { text: out.join(''), starts };
}

export interface EditSpec {
  old_str: string;
  new_str: string;
}

export type ApplyResult = { ok: true; content: string } | { ok: false; error: string };

/** Apply search/replace edits. Each old_str must match exactly once in the current content. */
export function applyEdits(content: string, edits: EditSpec[]): ApplyResult {
  const crlf = content.includes('\r\n');
  let cur = content;
  for (let i = 0; i < edits.length; i++) {
    let { old_str, new_str } = edits[i];
    if (typeof old_str !== 'string' || typeof new_str !== 'string') {
      return { ok: false, error: `edit #${i + 1}: old_str and new_str must be strings` };
    }
    if (crlf) {
      old_str = old_str.replace(/\r?\n/g, '\r\n');
      new_str = new_str.replace(/\r?\n/g, '\r\n');
    }
    if (old_str === '') return { ok: false, error: `edit #${i + 1}: old_str is empty` };
    const first = cur.indexOf(old_str);
    if (first === -1) {
      return { ok: false, error: `edit #${i + 1}: old_str not found in file. Re-read the file (read_file) and copy the text exactly, including whitespace.` };
    }
    if (cur.indexOf(old_str, first + 1) !== -1) {
      return { ok: false, error: `edit #${i + 1}: old_str matches more than once. Include more surrounding lines so it is unique.` };
    }
    cur = cur.slice(0, first) + new_str + cur.slice(first + old_str.length);
  }
  return { ok: true, content: cur };
}
