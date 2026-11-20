import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedPath } from '../src/context/workspace';
import { commandEnv, isSensitiveEnvVar, redactSecrets } from '../src/mcp/tools';
import { prepareProposal } from '../src/review/plan';

test('isProtectedPath: identifies sensitive and protected files', () => {
  // Sensitive env files
  assert.equal(isProtectedPath('.env'), true);
  assert.equal(isProtectedPath('.env.local'), true);
  assert.equal(isProtectedPath('subdir/.env.production'), true);

  // Sensitive local configuration
  assert.equal(isProtectedPath('config.local.json'), true);
  assert.equal(isProtectedPath('subdir/config.local.foo.json'), true);

  // Private keys and certificates
  assert.equal(isProtectedPath('server.key'), true);
  assert.equal(isProtectedPath('cert.pem'), true);
  assert.equal(isProtectedPath('id_rsa'), true);
  assert.equal(isProtectedPath('.ssh/id_ed25519'), true);
  assert.equal(isProtectedPath('credentials.json'), true);
  assert.equal(isProtectedPath('.git/config'), true);
  assert.equal(isProtectedPath('.git/hooks/pre-commit'), true);

  // Allowed templates and standard files
  assert.equal(isProtectedPath('.env.example'), false);
  assert.equal(isProtectedPath('config.example.json'), false);
  assert.equal(isProtectedPath('src/flask/cli.py'), false);
  assert.equal(isProtectedPath('package.json'), false);
});

test('isSensitiveEnvVar: flags API keys, tokens, and secrets while keeping standard env', () => {
  assert.equal(isSensitiveEnvVar('GEMINI_API_KEY'), true);
  assert.equal(isSensitiveEnvVar('FALLBACK_API_KEY'), true);
  assert.equal(isSensitiveEnvVar('OPENAI_API_KEY'), true);
  assert.equal(isSensitiveEnvVar('GITHUB_TOKEN'), true);
  assert.equal(isSensitiveEnvVar('AWS_SECRET_ACCESS_KEY'), true);
  assert.equal(isSensitiveEnvVar('DATABASE_PASSWORD'), true);
  assert.equal(isSensitiveEnvVar('AUTH_BEARER'), true);

  assert.equal(isSensitiveEnvVar('PATH'), false);
  assert.equal(isSensitiveEnvVar('HOME'), false);
  assert.equal(isSensitiveEnvVar('USER'), false);
  assert.equal(isSensitiveEnvVar('CI'), false);
  assert.equal(isSensitiveEnvVar('PYTHONUNBUFFERED'), false);
  assert.equal(isSensitiveEnvVar('VIRTUAL_ENV'), false);
});

test('commandEnv: sanitizes environment and strips sensitive API keys from child processes', () => {
  process.env.TEST_API_KEY = 'secret-val-12345';
  process.env.TEST_PASSWORD = 'super-secret-xyz';
  try {
    const env = commandEnv('/tmp');
    assert.equal(env.TEST_API_KEY, undefined, 'Sensitive API key was leaked into commandEnv!');
    assert.equal(env.TEST_PASSWORD, undefined, 'Password was leaked into commandEnv!');
    assert.equal(env.CI, '1');
    assert.equal(env.PYTHONUNBUFFERED, '1');
  } finally {
    delete process.env.TEST_API_KEY;
    delete process.env.TEST_PASSWORD;
  }
});

test('redactSecrets: masks known secret values and common token patterns', () => {
  const sampleKey = ['AI', 'za', 'SyFakeKey1234567890abcdefghijklm'].join('');
  const fakeEnv = {
    GEMINI_API_KEY: sampleKey,
    CUSTOM_SECRET: 'my-super-secret-token-value',
  };

  const textWithKey = `Got error from endpoint with key ${sampleKey} and secret my-super-secret-token-value`;
  const redacted = redactSecrets(textWithKey, fakeEnv);

  assert.ok(!redacted.includes(sampleKey), 'Failed to redact Google API key');
  assert.ok(!redacted.includes('my-super-secret-token-value'), 'Failed to redact secret env value');
  assert.match(redacted, /\[REDACTED_API_KEY\]|\[REDACTED_SECRET\]/);

  // Common pattern redaction
  const textWithBearer = 'Authorization: Bearer ya29.a0AfH6SMDI_random_secret_bearer_token_string';
  const redactedBearer = redactSecrets(textWithBearer, {});
  assert.ok(!redactedBearer.includes('ya29.a0AfH6SMDI_random_secret_bearer_token_string'));
  assert.match(redactedBearer, /Bearer \[REDACTED_TOKEN\]/);
});

test('prepareProposal: rejects modifying protected files (.env, config.local.json, .git)', () => {
  const r1 = prepareProposal(process.cwd(), 'propose_edit', { path: '.env', edits: [{ old_str: 'a', new_str: 'b' }] });
  assert.equal(r1.ok, false);
  assert.match(r1.error, /Access denied/);

  const r2 = prepareProposal(process.cwd(), 'propose_write', { path: '.git/hooks/pre-commit', content: '#!/bin/sh' });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /Access denied/);
});
