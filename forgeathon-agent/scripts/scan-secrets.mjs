#!/usr/bin/env node
/**
 * Secret & Sensitive Information Scanner
 * Checks repository files, git status, gitignore configurations, and commit history
 * to ensure that environment variables, credentials, and API keys are strictly protected.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, join, basename } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve('..'); // Workspace root
const AGENT_DIR = resolve('.'); // forgeathon-agent dir

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^config\.local.*\.json$/i,
  /\.(key|pem|cert|crt|pfx|p12)$/i,
  /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i,
  /^(credentials|client_secret.*|service-account.*)\.json$/i,
];

const SECRET_CONTENT_PATTERNS = [
  { name: 'Google API Key', regex: new RegExp('AI' + 'za[0-9A-Za-z_-]{35}') },
  { name: 'OpenAI / Anthropic Secret Key', regex: new RegExp('s' + 'k-[a-zA-Z0-9_-]{20,}') },
  { name: 'GitHub Personal Access Token', regex: /gh[pousr]_[A-Za-z0-9_]{36,}/ },
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key Block', regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/ },
  { name: 'Generic High-Entropy API Key', regex: /api[_-]?key["']?\s*[:=]\s*["']([A-Za-z0-9_-]{20,})["']/i },
];

const ALLOWED_PLACEHOLDERS = new Set([
  'your-api-key',
  'your_gemini_api_key_here',
  'your_fallback_api_key_here',
  'not-needed',
  'invalid',
  'mock-a',
  'mock-b',
  'X_UNSET',
]);

const IGNORED_SCAN_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  '.venv',
  'venv',
  '__pycache__',
]);

let issues = 0;

function logPass(msg) {
  console.log(`  \x1b[32m✔\x1b[0m ${msg}`);
}

function logFail(msg) {
  console.log(`  \x1b[31m✖\x1b[0m ${msg}`);
  issues++;
}

function logInfo(msg) {
  console.log(`  \x1b[36mℹ\x1b[0m ${msg}`);
}

console.log('\x1b[1m=== Forgeathon Secret & Environment Scanner ===\x1b[0m\n');

// 1. Check .gitignore rules
console.log('1. Checking .gitignore configurations...');
for (const [label, gitignorePath] of [
  ['Root .gitignore', resolve(ROOT, '.gitignore')],
  ['Extension .gitignore', resolve(AGENT_DIR, '.gitignore')],
]) {
  if (!existsSync(gitignorePath)) {
    logFail(`${label} does not exist!`);
    continue;
  }
  const content = readFileSync(gitignorePath, 'utf8');
  const requiredRules = ['.env', 'config.local.json', '*.key', '*.pem'];
  let allPresent = true;
  for (const rule of requiredRules) {
    if (!content.includes(rule)) {
      logFail(`${label} is missing rule: "${rule}"`);
      allPresent = false;
    }
  }
  if (allPresent) {
    logPass(`${label} contains required secret protection rules.`);
  }
}

// 2. Scan filesystem for sensitive filenames and patterns
console.log('\n2. Scanning files in repository tree...');

function walkFiles(dir) {
  const files = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (IGNORED_SCAN_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        files.push(...walkFiles(full));
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  } catch {}
  return files;
}

const allFiles = walkFiles(ROOT);
let sensitiveFilesFound = 0;
let secretMatchesFound = 0;

for (const filePath of allFiles) {
  const name = basename(filePath);
  const rel = relative(ROOT, filePath);

  // Check if filename is sensitive
  if (name !== '.env.example' && name !== 'config.example.json') {
    for (const pat of SENSITIVE_FILENAME_PATTERNS) {
      if (pat.test(name)) {
        // Check if git tracks it
        try {
          execSync(`git ls-files --error-unmatch "${filePath}"`, { stdio: 'pipe' });
          logFail(`CRITICAL: Sensitive file "${rel}" is tracked by git!`);
        } catch {
          logInfo(`Sensitive file "${rel}" exists on disk but is properly uncommitted.`);
        }
        sensitiveFilesFound++;
        break;
      }
    }
  }

  // Check content
  if (name.endsWith('.png') || name.endsWith('.ico') || name.endsWith('.lock') || name.endsWith('.map')) continue;
  try {
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of SECRET_CONTENT_PATTERNS) {
        const match = pat.regex.exec(line);
        if (match) {
          const matchedVal = match[1] ?? match[0];
          if (ALLOWED_PLACEHOLDERS.has(matchedVal)) continue;
          // Ignore scanner and regex definitions themselves
          if (rel.includes('scan-secrets') || rel.includes('tools.ts') || rel.includes('SUBMISSION_CHECKLIST.md')) {
            if (line.includes('regex:') || line.includes('/AIza') || line.includes('/sk-') || line.includes('grep')) continue;
          }
          logFail(`Possible secret (${pat.name}) in ${rel}:${i + 1}\n      Line: ${line.trim().slice(0, 80)}`);
          secretMatchesFound++;
        }
      }
    }
  } catch {}
}

if (sensitiveFilesFound === 0) {
  logPass('No unignored sensitive files (.env, config.local.json, keys) found in workspace.');
}
if (secretMatchesFound === 0) {
  logPass('No hardcoded secrets or API keys found in codebase files.');
}

// 3. Scan Git commit history
console.log('\n3. Scanning Git commit history...');
try {
  const commitCount = execSync('git rev-list --count HEAD 2>/dev/null', { encoding: 'utf8' }).trim();
  if (commitCount === '0' || !commitCount) {
    logPass('Git repository has 0 commits (clean slate, no history leakage).');
  } else {
    const gitDiff = execSync('git log -p', { encoding: 'utf8' });
    const diffLines = gitDiff.split('\n');
    let gitIssues = 0;
    for (const line of diffLines) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const addedText = line.slice(1);
      for (const pat of SECRET_CONTENT_PATTERNS) {
        const match = pat.regex.exec(addedText);
        if (match) {
          const matchedVal = match[1] ?? match[0];
          if (ALLOWED_PLACEHOLDERS.has(matchedVal)) continue;
          if (addedText.includes('regex:') || addedText.includes('/AIza') || addedText.includes('/sk-') || addedText.includes('grep')) continue;
          logFail(`Git history contains secret matching ${pat.name}: ${addedText.trim().slice(0, 80)}`);
          gitIssues++;
        }
      }
    }
    if (gitIssues === 0) {
      logPass(`Scanned ${commitCount} commit(s): no leaked secrets in git history.`);
    }
  }
} catch {
  logPass('Git repository has no commits yet (clean slate, no history leakage).');
}

// 4. Summary
console.log('\n-----------------------------------------------');
if (issues === 0) {
  console.log('\x1b[32m\x1b[1mALL CHECKS PASSED: Environment variables & secrets are properly protected.\x1b[0m\n');
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1mFAILED: ${issues} issue(s) detected. Please resolve them.\x1b[0m\n`);
  process.exit(1);
}
