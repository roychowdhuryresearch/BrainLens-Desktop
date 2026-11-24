import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const llmKeySource = readFileSync(join(desktopRoot, 'electron/llmKey.ts'), 'utf8');

test('LLM key storage migrates only encrypted legacy blobs and never persists plaintext', () => {
  assert.match(llmKeySource, /legacyKeyFilePaths/);
  assert.match(llmKeySource, /ieeg-electron-desktop/);
  assert.match(llmKeySource, /ieeg-electron-desktop-packaged/);
  assert.match(llmKeySource, /copyFileSync\(legacyPath, current\)/);
  assert.match(llmKeySource, /safeStorage\.decryptStringAsync\(readFileSync\(path\)\)/);
  assert.match(llmKeySource, /safeStorage\.encryptStringAsync\(plaintext\)/);
  assert.match(llmKeySource, /safeStorage\.isAsyncEncryptionAvailable\(\)/);
  assert.match(llmKeySource, /decrypted\.shouldReEncrypt/);
  assert.doesNotMatch(llmKeySource, /safeStorage\.decryptString\(/);
  assert.doesNotMatch(llmKeySource, /safeStorage\.encryptString\(/);
  assert.doesNotMatch(llmKeySource, /safeStorage\.isEncryptionAvailable\(\)/);
  assert.doesNotMatch(llmKeySource, /writeFileSync\(path, trimmed/);
});
