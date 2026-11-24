import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// workspaceState.ts has a single `import type` (elided under isolatedModules) so the transpiled
// module is import-free and runs from a data: URL, the same pattern as quick-detection-model.test.js.
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

const modelPromise = loadWorkspaceState();

// The reported repro recording: sub-sourcesinkumf001 interictal-asleep, sfreq 999.4 Hz -> Nyquist
// 499.7 Hz, which the canonical fs=500 stopband sits ABOVE (silent detection failure).
const UMF001_META = { sample_freq: 999.4 };

function controls(model, patch = {}) {
  return { ...model.DEFAULT_PREPARE_CONTROLS, ...patch };
}

test('recordingSampleFrequencyHz / recordingNyquistHz read whichever metadata key carries the rate', async () => {
  const model = await modelPromise;
  assert.equal(model.recordingSampleFrequencyHz({ sample_freq: 999.4 }), 999.4);
  assert.equal(model.recordingSampleFrequencyHz({ sampling_frequency: 2000 }), 2000);
  assert.equal(model.recordingSampleFrequencyHz({ sample_frequency_hz: 512 }), 512);
  assert.equal(model.recordingSampleFrequencyHz({}), 0);
  assert.equal(model.recordingSampleFrequencyHz(null), 0);

  assert.equal(model.recordingNyquistHz(UMF001_META), 499.7);
  assert.equal(model.recordingNyquistHz({ sampling_frequency: 2000 }), 1000);
  assert.equal(model.recordingNyquistHz({}), null);
  assert.equal(model.recordingNyquistHz({ sample_freq: 0 }), null);
});

test('nyquistSafeStopbandHz is floor(0.95 * Nyquist), capped by the 500 Hz default downstream', async () => {
  const model = await modelPromise;
  assert.equal(model.NYQUIST_STOPBAND_SAFETY_FACTOR, 0.95);
  // floor(0.95 * 499.7) = floor(474.715) = 474, comfortably below Nyquist 499.7.
  assert.equal(model.nyquistSafeStopbandHz(UMF001_META), 474);
  assert.equal(model.nyquistSafeStopbandHz({ sampling_frequency: 2000 }), 950);
  assert.equal(model.nyquistSafeStopbandHz({}), null);
});

test('clampStopbandToNyquist lowers the 500 Hz default for a <=1000 Hz recording on load', async () => {
  const model = await modelPromise;
  // The reported bug: default fs=500 >= Nyquist 499.7 -> clamp DOWN to the safe ceiling 474.
  assert.equal(model.clampStopbandToNyquist(controls(model), UMF001_META).fs, '474');
  // A 2 kHz recording keeps fs=500 (500 <= floor(0.95*1000)=950): no behaviour change.
  assert.equal(model.clampStopbandToNyquist(controls(model), { sample_freq: 2000 }).fs, '500');
});

test('clampStopbandToNyquist only lowers fs - it never raises or rewrites a safe/blank value', async () => {
  const model = await modelPromise;
  // A deliberately-lower fs is preserved (250 < ceiling 474).
  assert.equal(model.clampStopbandToNyquist(controls(model, { fs: '250' }), UMF001_META).fs, '250');
  // Blank/non-numeric fs is left for validateFilterControls to flag, not coerced to a number.
  assert.equal(model.clampStopbandToNyquist(controls(model, { fs: '' }), UMF001_META).fs, '');
  // Unknown sample frequency: cannot derive a ceiling, so fs is untouched.
  assert.equal(model.clampStopbandToNyquist(controls(model), {}).fs, '500');
  // Already-safe fs returns the SAME object (no needless re-render churn).
  const safe = controls(model, { fs: '300' });
  assert.equal(model.clampStopbandToNyquist(safe, UMF001_META), safe);
});

test('nyquistStopbandError flags fs at/above Nyquist and names both frequencies', async () => {
  const model = await modelPromise;
  const error = model.nyquistStopbandError(500, UMF001_META);
  assert.ok(error, 'fs=500 must error against Nyquist 499.7');
  assert.match(error, /500/);
  assert.match(error, /499\.7/);
  assert.match(error, /Nyquist/);

  // Boundary: fs exactly at Nyquist is invalid (normalized freq == 1 in cheby2 design).
  assert.ok(model.nyquistStopbandError(499.7, UMF001_META));
  // A safe fs, an unknown sfreq, and a high-rate recording all return null (no error).
  assert.equal(model.nyquistStopbandError(474, UMF001_META), null);
  assert.equal(model.nyquistStopbandError(500, {}), null);
  assert.equal(model.nyquistStopbandError(500, { sample_freq: 2000 }), null);
});

test('validateFilterControls surfaces the Nyquist error only when fs is actually unsafe', async () => {
  const model = await modelPromise;
  const defaultErrors = model.validateFilterControls(controls(model), UMF001_META);
  assert.ok(defaultErrors.some((message) => /Nyquist/.test(message)), 'default fs=500 must be flagged for a 999.4 Hz recording');

  assert.deepEqual(model.validateFilterControls(controls(model, { fs: '250' }), UMF001_META), []);
  // Backward compatible: metadata is optional; numeric checks still run, no Nyquist error without a rate.
  assert.deepEqual(model.validateFilterControls(controls(model)), []);
  assert.ok(model.validateFilterControls(controls(model, { fp: 'abc' }), { sample_freq: 2000 }).includes('fp must be numeric'));
});
