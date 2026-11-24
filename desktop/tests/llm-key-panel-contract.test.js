import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('LLM key popover escapes agent header button sizing', () => {
  const component = read('src/features/agent/LlmKeyButton.tsx');
  const chrome = read('src/styles/workspace/agent-visual-chrome.css');

  assert.match(component, /createPortal\(panel, document\.body\)/);
  assert.match(component, /className="agent-llm-key-panel"/);
  assert.match(component, /className="agent-llm-key-action"/);
  assert.match(component, /className="agent-llm-key-action agent-llm-key-close"/);

  assert.match(chrome, /\.agent-llm-key-panel\{/);
  assert.match(chrome, /\.agent-llm-key-action\{/);
  assert.match(chrome, /inline-size:auto!important;/);
  assert.match(chrome, /min-inline-size:68px!important;/);
});

test('LLM key copy is platform-neutral', () => {
  const component = read('src/features/agent/LlmKeyButton.tsx');
  const mainStorage = read('electron/llmKey.ts');

  assert.doesNotMatch(component, /this Mac|your Keychain|OS Keychain/);
  assert.doesNotMatch(mainStorage, /OS secure storage \(Keychain\)/);
  assert.match(component, /encrypted at rest/);
  assert.match(component, /OS secure storage/);
});

test('LLM connection panel binds provider, endpoint, model, test, and save controls', () => {
  const component = read('src/features/agent/LlmKeyButton.tsx');
  const preload = read('electron/preload.cts');
  const main = read('electron/main.ts');
  const storage = read('electron/llmKey.ts');

  for (const testId of ['agent-llm-provider', 'agent-llm-api-base', 'agent-llm-model', 'agent-llm-key-input', 'agent-llm-key-test', 'agent-llm-key-save']) {
    assert.match(component, new RegExp(`data-testid="${testId}"`));
  }
  assert.match(component, /saveLlmProfile\(draft\(\)\)/);
  assert.match(component, /testLlmProfile\(draft\(\)\)/);
  assert.match(component, /The Agent uses runtime defaults until you choose Save/);
  assert.match(preload, /llm-profile:status/);
  assert.match(preload, /llm-profile:test/);
  assert.match(preload, /llm-profile:save/);
  assert.match(main, /ipcMain\.handle\('llm-profile:status'/);
  assert.match(main, /ipcMain\.handle\('llm-profile:test'/);
  assert.match(main, /ipcMain\.handle\('llm-profile:save'/);
  assert.match(main, /llmProfile: await getActiveStoredLlmProfile\(\)/);
  assert.match(storage, /llm-api-profiles\.bin/);
  assert.match(storage, /safeStorage\.encryptString/);
  assert.match(storage, /legacyKeyFilePath/);
  assert.match(storage, /canReuseStoredProfileKey\(storedProfile, input\)/);
  assert.match(storage, /store\.legacy \? undefined : store\.profiles\[provider\]/);
  assert.match(storage, /if \(store\.legacy\) return undefined/);
  assert.doesNotMatch(storage, /activeProvider: 'custom'[\s\S]*legacy: true/);
  assert.match(storage, /store\.activeProvider = undefined/);
  assert.doesNotMatch(storage, /store\.activeProvider = Object\.keys\(store\.profiles\)\[0\]/);
});
