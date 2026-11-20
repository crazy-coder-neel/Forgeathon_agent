import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { BUDGET } from './budget';
import { globToRegExp, isProtectedPath, resolveInside, walk } from './workspace';

export interface Hit {
  file: string;
  line: number;
  text: string;
}

function tryRipgrep(root: string, pattern: string, glob: string | undefined, max: number, ignoreCase: boolean): Promise<Hit[] | null> {
  return new Promise((resolve) => {
    const args = ['--no-heading', '--line-number', '--max-columns', '200', '--max-count', '5', '--color', 'never'];
    if (ignoreCase) args.push('-i');
    if (glob) args.push('-g', glob);
    for (const d of ['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build', '.env*', '*.key', '*.pem', '*.cert', '*config.local*.json', '*credentials*.json']) {
      args.push('-g', `!${d}`);
    }
    args.push('-e', pattern, '.');
    let child;
    try {
      child = spawn('rg', args, { cwd: root });
    } catch {
      return resolve(null);
    }
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > 400_000) child.kill();
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0 && code !== 1 && code !== null) return resolve(null);
      const hits: Hit[] = [];
      for (const line of out.split('\n')) {
        const m = /^\.?\/?(.+?):(\d+):(.*)$/.exec(line);
        if (m) {
          const file = m[1].replace(/^\.\//, '');
          if (isProtectedPath(file)) continue;
          hits.push({ file, line: Number(m[2]), text: m[3].trim() });
        }
        if (hits.length >= max) break;
      }
      resolve(hits);
    });
  });
}

function nodeSearch(root: string, pattern: string, glob: string | undefined, max: number, ignoreCase: boolean): Hit[] {
  let re: RegExp;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '');
  }
  const globRe = glob ? globToRegExp(glob.includes('/') ? glob : `**/${glob}`) : null;
  const hits: Hit[] = [];
  for (const f of walk(root)) {
    if (isProtectedPath(f)) continue;
    if (globRe && !globRe.test(f)) continue;
    let text: string;
    try {
      const st = fs.statSync(resolveInside(root, f));
      if (st.size > 1_000_000) continue;
      text = fs.readFileSync(resolveInside(root, f), 'utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    let perFile = 0;
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (++perFile >= 5 || hits.length >= max) break;
      }
    }
    if (hits.length >= max) break;
  }
  return hits;
}

export async function searchWorkspace(root: string, pattern: string, glob?: string, ignoreCase = true, max = BUDGET.searchHits): Promise<Hit[]> {
  const viaRg = await tryRipgrep(root, pattern, glob, max, ignoreCase);
  return viaRg ?? nodeSearch(root, pattern, glob, max, ignoreCase);
}
