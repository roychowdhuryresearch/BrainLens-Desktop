import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Transpile workspaceState.ts in-memory (same harness pattern as waveform-overview-parity.test.js /
// quick-detection-model.test.js). The only import in workspaceState.ts is type-only, stripped by
// isolatedModules, so the module loads standalone.
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
// stepProgressPercent: honest renderer-orchestrated step progress (1/3, 2/3, 3/3).
// ---------------------------------------------------------------------------

test('stepProgressPercent maps real completed-step counts to integer percent', async () => {
  const { stepProgressPercent } = await statePromise;
  assert.equal(stepProgressPercent(0, 3), 0);
  assert.equal(stepProgressPercent(1, 3), 33);
  assert.equal(stepProgressPercent(2, 3), 67);
  assert.equal(stepProgressPercent(3, 3), 100);
});

test('stepProgressPercent clamps completed into [0, total] and rejects bad totals', async () => {
  const { stepProgressPercent } = await statePromise;
  // Over-count never exceeds 100, negative never goes below 0.
  assert.equal(stepProgressPercent(9, 3), 100);
  assert.equal(stepProgressPercent(-2, 3), 0);
  // Non-positive / non-finite totals yield an honest 0 instead of NaN/Infinity.
  assert.equal(stepProgressPercent(1, 0), 0);
  assert.equal(stepProgressPercent(1, -4), 0);
  assert.equal(stepProgressPercent(1, Number.NaN), 0);
  assert.equal(stepProgressPercent(Number.NaN, 4), 0);
});

// ---------------------------------------------------------------------------
// isFreshWaveformResponse: stale-response token guard that prevents races.
// ---------------------------------------------------------------------------

test('isFreshWaveformResponse accepts only the response under the latest token', async () => {
  const { isFreshWaveformResponse } = await statePromise;
  assert.equal(isFreshWaveformResponse(5, 5), true);
  assert.equal(isFreshWaveformResponse(4, 5), false);
  // A response that somehow carries a future token (should not happen) is not "current".
  assert.equal(isFreshWaveformResponse(6, 5), false);
});

test('slow coarse response can NEVER overwrite a newer full-res response', async () => {
  const { isFreshWaveformResponse } = await statePromise;
  // Simulate the renderer token ref. Load A issues coarse+full under token 1.
  let latestToken = 0;
  const loadA = (latestToken += 1); // token 1
  // Full-res of load A lands and is applied (token still current).
  assert.equal(isFreshWaveformResponse(loadA, latestToken), true);
  // User navigates again -> load B claims a new token before A's coarse pass returns.
  const loadB = (latestToken += 1); // token 2
  // A's slow coarse response (token 1) is now stale and is rejected: no clobber.
  assert.equal(isFreshWaveformResponse(loadA, latestToken), false);
  // B's responses (token 2) are the only ones allowed to render.
  assert.equal(isFreshWaveformResponse(loadB, latestToken), true);
});

test('navigating repeatedly mid-flight discards every older in-flight response', async () => {
  const { isFreshWaveformResponse } = await statePromise;
  let latestToken = 0;
  const tokens = [1, 2, 3, 4, 5].map(() => (latestToken += 1));
  // Only the final navigation's token is fresh; all earlier in-flight responses drop.
  for (const tok of tokens.slice(0, -1)) assert.equal(isFreshWaveformResponse(tok, latestToken), false);
  assert.equal(isFreshWaveformResponse(tokens[tokens.length - 1], latestToken), true);
});

// ---------------------------------------------------------------------------
// Channel batching: keep derived requests under the backend per-request cap.
// (The former coarse-then-refine two-pass was removed — it re-read & re-filtered
// the identical source range for no real latency win; the backend now memoizes
// computed windows so revisits are instant, and updatePlot single-flights gestures.)
// ---------------------------------------------------------------------------

test('chunkWaveformRequestChannels keeps large derived requests under the backend channel cap', async () => {
  const { MAX_WAVEFORM_REQUEST_CHANNELS, chunkWaveformRequestChannels } = await statePromise;
  const channels = Array.from({ length: 65 }, (_value, index) => `CH${index + 1}`);
  const chunks = chunkWaveformRequestChannels(channels);

  assert.equal(MAX_WAVEFORM_REQUEST_CHANNELS, 32);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [32, 32, 1]);
  assert.deepEqual(chunks.flat(), channels);
  assert.deepEqual(chunkWaveformRequestChannels(['A', '', 'B'], 1), [['A'], ['B']]);
});

test('mergeWaveformWindowBatches preserves batch order and filter metadata', async () => {
  const { mergeWaveformWindowBatches } = await statePromise;
  const merged = mergeWaveformWindowBatches([
    { channels: ['A', 'B'], data: [[1, 2], [3, 4]], times_seconds: [0, 1], units: 'uV', source: 'filtered', filters_applied: ['bandpass_1_80hz'] },
    { channels: ['C'], data: [[5, 6]], times_seconds: [0, 1], units: 'uV', source: 'filtered', filters_applied: ['bandpass_1_80hz', 'notch_60hz'] }
  ]);

  assert.deepEqual(merged.channels, ['A', 'B', 'C']);
  assert.deepEqual(merged.data, [[1, 2], [3, 4], [5, 6]]);
  assert.deepEqual(merged.times_seconds, [0, 1]);
  assert.deepEqual(merged.filters_applied, ['bandpass_1_80hz', 'notch_60hz']);
  assert.throws(() => mergeWaveformWindowBatches([]), /At least one waveform window batch/);
});
