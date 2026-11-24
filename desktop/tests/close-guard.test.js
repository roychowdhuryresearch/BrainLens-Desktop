import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadCloseGuard() {
  const source = readFileSync(join(root, 'electron/closeGuard.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const guardPromise = loadCloseGuard();

test('close guard allows clean or explicitly unsafe closes without prompting', async () => {
  const { closePromptForState } = await guardPromise;

  assert.equal(closePromptForState({
    workspaceDirty: false,
    allowUnsafeClose: false,
    closeSaveInProgress: false,
    closeDiscardPromptInProgress: false
  }), 'none');

  assert.equal(closePromptForState({
    workspaceDirty: true,
    allowUnsafeClose: true,
    closeSaveInProgress: true,
    closeDiscardPromptInProgress: true
  }), 'none');
});

test('close guard prompts for unsaved workspace before a save starts', async () => {
  const { closePromptForState } = await guardPromise;

  assert.equal(closePromptForState({
    workspaceDirty: true,
    allowUnsafeClose: false,
    closeSaveInProgress: false,
    closeDiscardPromptInProgress: false
  }), 'unsaved-workspace');
});

test('close guard offers discard while save-before-close is still pending', async () => {
  const { closePromptForState } = await guardPromise;

  assert.equal(closePromptForState({
    workspaceDirty: true,
    allowUnsafeClose: false,
    closeSaveInProgress: true,
    closeDiscardPromptInProgress: false
  }), 'save-still-running');
});

test('close guard suppresses duplicate discard dialogs while one is active', async () => {
  const { closePromptForState } = await guardPromise;

  assert.equal(closePromptForState({
    workspaceDirty: true,
    allowUnsafeClose: false,
    closeSaveInProgress: true,
    closeDiscardPromptInProgress: true
  }), 'discard-prompt-active');
});

test('close guard suppresses a duplicate while the primary unsaved-workspace dialog is open', async () => {
  const { closePromptForState } = await guardPromise;

  // A second close arriving (e.g. Cmd-Q) while the primary Save/Discard sheet is up must
  // not stack another dialog — it returns 'discard-prompt-active' instead of re-prompting.
  assert.equal(closePromptForState({
    workspaceDirty: true,
    allowUnsafeClose: false,
    closeSaveInProgress: false,
    closeDiscardPromptInProgress: false,
    closePrimaryPromptInProgress: true
  }), 'discard-prompt-active');
});
