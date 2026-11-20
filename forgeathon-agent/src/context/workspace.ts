// Filesystem helpers shared by the MCP tools. Pure Node, no vscode dependency.
import * as fs from 'node:fs';
import * as path from 'node:path';

export const IGNORE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'dist', 'build', 'out', '.next', '.idea', '.vscode-test', 'site-packages', '.eggs',
  '.ssh', '.aws', '.gnupg', '.claude',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.gz', '.tar', '.whl', '.pyc', '.so', '.dll',
  '.exe', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.sqlite', '.db', '.lock',
]);

export function isBinary(file: string): boolean {
  return BINARY_EXT.has(path.extname(file).toLowerCase());
}

/** Check if a relative or absolute path points to a protected, secret, or sensitive file/directory. */
export function isProtectedPath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = norm.split('/').filter(Boolean);
  if (!segments.length) return false;

  const base = segments[segments.length - 1];
  // Allow harmless example templates
  if (base === '.env.example' || base === 'config.example.json') return false;

  // Check parent directory segments
  for (let i = 0; i < segments.length - 1; i++) {
    const dir = segments[i];
    if (IGNORE_DIRS.has(dir)) return true;
    if (dir.startsWith('.') && (dir === '.env' || dir.startsWith('.env.'))) return true;
  }

  // Check if target itself is an ignored directory
  if (IGNORE_DIRS.has(base)) return true;

  // Protect environment files (.env, .env.local, .env.production, etc.)
  if (/^\.env(\..+)?$/i.test(base)) return true;

  // Protect local configuration files containing credentials
  if (/^config\.local.*\.json$/i.test(base) || base === 'config.local.json' || /\.local\.json$/i.test(base)) return true;

  // Protect keys, certificates, and credentials
  if (/\.(key|pem|cert|crt|pfx|p12)$/i.test(base)) return true;
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/i.test(base)) return true;
  if (/^(credentials|client_secret.*|service-account.*|token)\.json$/i.test(base)) return true;

  return false;
}

/** Resolve a user/agent supplied path inside root. Throws if it escapes the workspace. */
export function resolveInside(root: string, p: string): string {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path is outside the workspace: ${p}`);
  return abs;
}

export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export function walk(root: string, start = '', maxFiles = 20000): string[] {
  const out: string[] = [];
  const base = resolveInside(root, start);
  const rec = (dir: string) => {
    if (out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = toRel(root, path.join(dir, e.name));
      if (isProtectedPath(rel)) continue;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.endsWith('.egg-info')) continue;
        rec(path.join(dir, e.name));
      } else if (e.isFile() && !isBinary(e.name)) {
        out.push(rel);
      }
    }
  };
  rec(base);
  return out;
}

/** Tiny glob: supports *, **, ? against posix-style relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
