#!/usr/bin/env node
// Registers everything the extension needs in a running local TrueForge, through TrueForge's HTTP API:
//   1. model providers (primary + fallback)   2. the extension's MCP server   3. the two saved agents.
// Usage: node scripts/setup-trueforge.mjs [config.local.json]
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Safely load environment variables from .env if present (without requiring external packages)
for (const envCandidate of ['.env', '.env.local', 'forgeathon-agent/.env', '../.env']) {
  const p = resolve(envCandidate);
  if (existsSync(p)) {
    if (typeof process.loadEnvFile === 'function') {
      try { process.loadEnvFile(p); } catch {}
    } else {
      try {
        const lines = readFileSync(p, 'utf8').split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eq = trimmed.indexOf('=');
          if (eq > 0) {
            const k = trimmed.slice(0, eq).trim();
            let v = trimmed.slice(eq + 1).trim();
            if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
              v = v.slice(1, -1);
            }
            if (!(k in process.env)) process.env[k] = v;
          }
        }
      } catch {}
    }
  }
}

const cfgPath = resolve(process.argv[2] ?? 'config.local.json');
if (!existsSync(cfgPath)) {
  console.error(`Config not found: ${cfgPath}\nCopy config.example.json to config.local.json and edit it first.`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const base = (process.env.TRUEFORGE_BASE_URL ?? cfg.trueforge?.baseUrl ?? 'http://localhost:8790').replace(/\/$/, '');
const template = JSON.parse(readFileSync(resolve('agent/forgeathon-agent.json'), 'utf8'));

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    console.error(`Cannot reach TrueForge at ${base}. Start it first:\n  OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@latest`);
    process.exit(1);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return json;
}

// 1. providers
for (const p of cfg.providers ?? []) {
  const { api_key_env, _comment, ...manifest } = p;
  if (api_key_env) {
    const key = process.env[api_key_env] ?? 'not-needed';
    if (!process.env[api_key_env]) console.warn(`  note: env var ${api_key_env} is not set; using a placeholder key for "${manifest.name ?? manifest.type}"`);
    manifest.auth = { api_key: key };
  }
  await api('PUT', '/api/v1/settings/model-providers', { manifest });
  console.log(`provider ok: ${manifest.name ?? manifest.type}`);
}

// 2. MCP server hosted by the extension
const mcpName = cfg.mcp?.name ?? 'forge-editor';
await api('PUT', '/api/v1/settings/mcp-servers', {
  manifest: {
    type: 'remote',
    name: mcpName,
    url: cfg.mcp?.url ?? 'http://127.0.0.1:8791/mcp',
    description: 'Editor capabilities (repo map, search, read, propose edits, run command) hosted by the VS Code extension.',
  },
});
console.log(`mcp server ok: ${mcpName}`);

// 3. agents
const existing = await api('GET', '/api/v1/agents');
const list = existing.data?.data ?? existing.data ?? [];
async function saveAgent(name, model) {
  const manifest = JSON.parse(JSON.stringify(template.manifest).replace('__MODEL__', model));
  manifest.mcp_servers[0].name = mcpName;
  const found = (Array.isArray(list) ? list : []).find((a) => a.name === name);
  if (found) await api('PUT', `/api/v1/agents/${found.id}`, { description: template.description, manifest });
  else await api('POST', '/api/v1/agents', { name, description: template.description, manifest });
  console.log(`agent ok: ${name} -> ${model}`);
}
await saveAgent('forgeathon-primary', cfg.agents.primary);
if (cfg.agents.fallback) await saveAgent('forgeathon-fallback', cfg.agents.fallback);
if (cfg.agents.local) await saveAgent('forgeathon-local', cfg.agents.local); // optional third tier (e.g. Ollama)

const models = await api('GET', '/api/v1/models');
const names = JSON.stringify(models).match(/"[a-z0-9-]+\/[A-Za-z0-9._-]+"/g) ?? [];
console.log('\nModels known to TrueForge:', [...new Set(names)].join(', ') || '(none listed)');
console.log('\nDone. Now start the extension (F5) so its MCP server is listening, then use the Forge panel.');
