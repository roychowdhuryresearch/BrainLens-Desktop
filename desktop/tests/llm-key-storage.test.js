import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;
let userDataPath = '';
let decryptShouldReEncrypt = false;
let encryptionCount = 0;

async function transpiledModule(path) {
  const source = readFileSync(join(root, path), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

async function loadLlmKey() {
  const profile = await transpiledModule('electron/llmProfile.ts');
  globalThis.__llmProfileTestModule = profile;
  globalThis.__llmElectronTestModule = {
    app: { getPath: () => userDataPath },
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => {
        encryptionCount += 1;
        return Buffer.from(value, 'utf8');
      },
      decryptStringAsync: async (value) => {
        const shouldReEncrypt = decryptShouldReEncrypt;
        decryptShouldReEncrypt = false;
        return { result: Buffer.from(value).toString('utf8'), shouldReEncrypt };
      },
    },
  };

  let source = readFileSync(join(root, 'electron/llmKey.ts'), 'utf8');
  source = source.replace(
    "import { app, safeStorage } from 'electron';",
    'const { app, safeStorage } = globalThis.__llmElectronTestModule;',
  );
  source = source.replace(
    /import \{\s*LLM_PROVIDER_PRESETS,[\s\S]*?\} from '\.\/llmProfile\.js';/,
    'const { LLM_PROVIDER_PRESETS, canReuseStoredProfileKey, isLlmProviderId, matchesStoredProfileEndpoint, normalizeLlmProfile } = globalThis.__llmProfileTestModule;',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const storagePromise = loadLlmKey();

function isolatedUserData(t) {
  const directory = mkdtempSync(join(tmpdir(), 'ieeg-llm-key-storage-'));
  userDataPath = directory;
  decryptShouldReEncrypt = false;
  encryptionCount = 0;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('legacy ciphertext is visible for migration but never active or reusable', async (t) => {
  const storage = await storagePromise;
  const directory = isolatedUserData(t);
  writeFileSync(join(directory, 'llm-api-key.bin'), Buffer.from('legacy-secret', 'utf8'));

  const status = await storage.getStoredLlmProfileStatus();
  assert.equal(status.legacy, true);
  assert.equal(status.hasKey, true);
  assert.equal(status.activeHasKey, false);
  assert.equal(status.activeProvider, undefined);
  assert.equal(await storage.getActiveStoredLlmProfile(), undefined);
  await assert.rejects(
    storage.resolveStoredLlmProfile({ provider: 'custom', apiBase: 'https://gateway.example/v1', model: 'model-a', apiKey: '' }),
    /API key is required/,
  );

  await storage.saveStoredLlmProfile({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'new-secret' });
  assert.equal((await storage.getActiveStoredLlmProfile()).provider, 'deepseek');
  assert.equal(existsSync(join(directory, 'llm-api-key.bin')), false);
});

test('removing an active profile does not activate a remaining vendor profile', async (t) => {
  const storage = await storagePromise;
  isolatedUserData(t);
  await storage.saveStoredLlmProfile({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: 'deepseek-secret' });
  await storage.saveStoredLlmProfile({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'openai-secret' });

  await storage.clearStoredLlmProfile('openai');

  const inactive = await storage.getStoredLlmProfileStatus();
  assert.equal(inactive.activeProvider, undefined);
  assert.equal(inactive.hasKey, true);
  assert.equal(inactive.activeHasKey, false);
  assert.deepEqual(inactive.profiles.map((profile) => profile.provider), ['deepseek']);
  assert.equal(await storage.getActiveStoredLlmProfile(), undefined);

  await storage.saveStoredLlmProfile({ provider: 'deepseek', model: 'deepseek-v4-flash', apiKey: '' });
  assert.equal((await storage.getActiveStoredLlmProfile()).apiKey, 'deepseek-secret');
  assert.equal((await storage.getStoredLlmProfileStatus()).activeHasKey, true);
});

test('legacy connection probes can reuse the active key only at its saved endpoint', async (t) => {
  const storage = await storagePromise;
  isolatedUserData(t);
  await storage.saveStoredLlmProfile({ provider: 'openai', model: 'model', apiKey: 'test-key' });
  assert.equal(await storage.getStoredLlmKey('https://api.openai.com/v1/'), 'test-key');
  assert.equal(await storage.getStoredLlmKey('https://gateway.example/v1'), '');

  await storage.saveStoredLlmProfile({ provider: 'custom', apiBase: 'https://gateway.example/v1', model: 'model', apiKey: 'test-custom-key' });
  assert.equal(await storage.getStoredLlmKey('https://gateway.example/v1'), 'test-custom-key');
  assert.equal(await storage.getStoredLlmKey('https://gateway.example/v2'), '');
});

test('profile ciphertext is rotated when safeStorage requests re-encryption', async (t) => {
  const storage = await storagePromise;
  isolatedUserData(t);
  await storage.saveStoredLlmProfile({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: 'openai-secret' });
  const beforeRotation = encryptionCount;

  decryptShouldReEncrypt = true;
  const profile = await storage.getActiveStoredLlmProfile();

  assert.equal(profile.provider, 'openai');
  assert.equal(encryptionCount, beforeRotation + 1);
});
