import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Transpile workspaceState.ts in-memory (same harness as waveform-coarse-refine-progress.test.js).
async function loadWorkspaceState() {
  const source = readFileSync(join(root, 'src/app/workspaceState.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const statePromise = loadWorkspaceState();

// ---------------------------------------------------------------------------
// isTransientWaveformBackendError: only backend-busy / network-pre-response
// failures are retryable. Real backend validation errors must NOT be retried,
// otherwise a bad request would be hammered 4x and the user would wait for
// nothing. The discriminator is the literal "failed before response" prefix that
// main.ts/backendFetch wraps every pre-response network failure with, plus the
// "Backend is not running" restart-window message.
// ---------------------------------------------------------------------------

test('treats the 20s waveform timeout (the reported bug) as transient/retryable', async () => {
  const { isTransientWaveformBackendError } = await statePromise;
  const reported = new Error(
    'PyHFO backend request failed before response: /waveform/window\n' +
    'Network error: request exceeded 20000ms timeout and was aborted'
  );
  assert.equal(isTransientWaveformBackendError(reported), true);
});

test('treats reset / fetch-failed / restarting backend as transient', async () => {
  const { isTransientWaveformBackendError } = await statePromise;
  assert.equal(isTransientWaveformBackendError(new Error('PyHFO backend request failed before response: /waveform/window\nNetwork error: fetch failed')), true);
  assert.equal(isTransientWaveformBackendError(new Error('PyHFO backend request failed before response: /waveform/window\nNetwork error: read ECONNRESET')), true);
  assert.equal(isTransientWaveformBackendError(new Error('Backend is not running')), true);
});

test('does NOT retry real backend validation errors', async () => {
  const { isTransientWaveformBackendError } = await statePromise;
  for (const message of [
    'Requested waveform window is outside the recording.',
    'At most 32 channels may be requested at once.',
    'duration_seconds must be <= 60.0.',
    'Input file does not exist: /tmp/missing.fif',
    'Waveform data was incomplete. Reopen the recording or update the plot again.'
  ]) {
    assert.equal(isTransientWaveformBackendError(new Error(message)), false, message);
  }
});

test('accepts strings and non-Error values without throwing', async () => {
  const { isTransientWaveformBackendError } = await statePromise;
  assert.equal(isTransientWaveformBackendError('failed before response: /waveform/window'), true);
  assert.equal(isTransientWaveformBackendError('something else entirely'), false);
  assert.equal(isTransientWaveformBackendError(null), false);
  assert.equal(isTransientWaveformBackendError(undefined), false);
});
