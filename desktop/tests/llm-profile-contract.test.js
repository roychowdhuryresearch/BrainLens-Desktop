import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadLlmProfile() {
  const source = readFileSync(join(root, 'electron/llmProfile.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const profilePromise = loadLlmProfile();

test('provider presets bind credentials to canonical API bases', async () => {
  const profile = await profilePromise;
  const deepseek = profile.normalizeLlmProfile({
    provider: 'deepseek',
    apiBase: 'https://malicious.example/v1',
    model: 'deepseek-v4-flash',
    apiKey: 'secret-deepseek-key',
  });

  assert.equal(deepseek.provider, 'deepseek');
  assert.equal(deepseek.apiBase, 'https://api.deepseek.com');
  assert.equal(deepseek.model, 'deepseek-v4-flash');
  assert.equal(profile.chatCompletionsUrl(deepseek.apiBase), 'https://api.deepseek.com/chat/completions');
  assert.deepEqual(
    profile.LLM_PROVIDER_PRESETS.map((item) => item.id),
    ['deepseek', 'openai', 'qianwen', 'zhipu', 'custom'],
  );
});

test('custom profiles require a safe explicit endpoint and can reuse a stored key', async () => {
  const profile = await profilePromise;
  const custom = profile.normalizeLlmProfile({
    provider: 'custom',
    apiBase: 'http://127.0.0.1:11434/v1/',
    model: 'local-model',
    apiKey: '',
  }, 'stored-key');

  assert.equal(custom.apiBase, 'http://127.0.0.1:11434/v1');
  assert.equal(custom.apiKey, 'stored-key');
  assert.throws(
    () => profile.normalizeLlmProfile({ provider: 'custom', apiBase: 'file:///tmp/model', model: 'x', apiKey: 'key' }),
    /http\(s\)/,
  );
  assert.throws(
    () => profile.normalizeLlmProfile({ provider: 'custom', apiBase: 'https://user:pass@example.com/v1', model: 'x', apiKey: 'key' }),
    /without embedded credentials/,
  );
  assert.throws(
    () => profile.normalizeLlmProfile({ provider: 'custom', apiBase: 'http://public.example/v1', model: 'x', apiKey: 'key' }),
    /only on loopback or private-network hosts/,
  );
});

test('stored custom keys can be reused only for the exact bound endpoint', async () => {
  const profile = await profilePromise;
  const stored = {
    provider: 'custom',
    apiBase: 'https://trusted.example/v1',
    model: 'model-a',
    apiKey: 'stored-secret',
  };

  assert.equal(profile.canReuseStoredProfileKey(stored, { provider: 'custom', apiBase: 'https://trusted.example/v1/', model: 'model-b' }), true);
  assert.equal(profile.canReuseStoredProfileKey(stored, { provider: 'custom', apiBase: 'https://attacker.example/v1', model: 'model-a' }), false);
  assert.equal(profile.canReuseStoredProfileKey({ ...stored, apiBase: '' }, { provider: 'custom', apiBase: 'https://attacker.example/v1', model: 'x' }), false);
  assert.throws(
    () => profile.normalizeLlmProfile({ provider: 'custom', apiBase: 'https://attacker.example/v1', model: 'x', apiKey: '' }),
    /API key is required/,
  );
});

test('connection test sends the selected model and never returns the API key in an error', async () => {
  const profile = await profilePromise;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ error: { message: `bad key ${init.headers.authorization}` } }), { status: 401 });
  };
  const result = await profile.testLlmProfileConnection({
    provider: 'custom',
    apiBase: 'https://gateway.example/v1',
    model: 'model-a',
    apiKey: 'super-secret-key',
  }, fetchImpl, 1000);

  assert.equal(calls[0].url, 'https://gateway.example/v1/chat/completions');
  assert.equal(JSON.parse(calls[0].init.body).model, 'model-a');
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.doesNotMatch(result.message, /super-secret-key/);
  assert.match(result.message, /\[redacted\]/);
});
