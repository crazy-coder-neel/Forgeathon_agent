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

// 1. providers.
// Two passes so a model can be swapped while an agent still uses it (TrueForge refuses to drop an in-use model):
//   pass 1 registers the union of existing + configured models, agents are re-pointed in step 3, pass 2 prunes the old models.
const isLocalUrl = (u) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/i.test(u ?? '');
const existingProviders = (await api('GET', '/api/v1/settings/model-providers')).data ?? [];
const prepared = [];
for (const p of cfg.providers ?? []) {
  const { api_key_env, _comment, ...manifest } = p;
  const label = manifest.name ?? manifest.type;
  if (api_key_env) {
    const key = process.env[api_key_env];
    if (!key && !isLocalUrl(manifest.base_url)) {
      // never overwrite a stored key with a placeholder for a remote provider
      console.warn(`  SKIPPED provider "${label}": env var ${api_key_env} is not set (existing registration left untouched)`);
      continue;
    }
    if (!key) console.warn(`  note: env var ${api_key_env} is not set; using a placeholder key for local provider "${label}"`);
    manifest.auth = { api_key: key ?? 'not-needed' };
  }
  const old = existingProviders.find((e) => e.name === label)?.manifest?.models ?? [];
  const union = [...(manifest.models ?? []), ...old.filter((m) => !(manifest.models ?? []).some((n) => n.name === m.name))];
  await api('PUT', '/api/v1/settings/model-providers', { manifest: { ...manifest, models: union } });
  console.log(`provider ok: ${label}`);
  prepared.push(manifest);
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

// pass 2: drop models that are no longer configured (best effort; a model still used by some other agent is kept)
for (const manifest of prepared) {
  try {
    await api('PUT', '/api/v1/settings/model-providers', { manifest });
  } catch (e) {
    console.warn(`  note: kept extra models on "${manifest.name ?? manifest.type}": ${String(e.message).slice(0, 160)}`);
  }
}

const models = await api('GET', '/api/v1/models');
const names = JSON.stringify(models).match(/"[a-z0-9-]+\/[A-Za-z0-9._-]+"/g) ?? [];
console.log('\nModels known to TrueForge:', [...new Set(names)].join(', ') || '(none listed)');
console.log('\nDone. Now start the extension (F5) so its MCP server is listening, then use the Forge panel.');
