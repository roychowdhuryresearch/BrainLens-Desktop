import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Transpile the TS module in-memory (same harness pattern as quick-detection-model.test.js). The
// only import in workspaceState.ts is a type-only import which isolatedModules strips, so the
// module loads standalone.
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

function reviewEvent(patch = {}) {
  return { event_id: patch.event_id || 'evt-1', channel: 'A1', start_seconds: 1, end_seconds: 1.05, ...patch };
}

// ---------------------------------------------------------------------------
// Task 4: neighbor / clean channel subsetting (PyQt _infer_neighbor_channels /
// focus_clean_channels parity).
// ---------------------------------------------------------------------------

test('neighborFocusChannels resolves conventional 10-20 EEG neighbors and includes the target in source order', async () => {
  const state = await statePromise;
  // In the conventional left-parasagittal chain (Fp1-F3, F3-C3, C3-P3, P3-O1), C3 is bonded to
  // F3 and P3 only. F7/T3 belong to the temporal chain and are not bonded to C3.
  const channels = ['Fp1', 'F3', 'C3', 'P3', 'O1', 'F7', 'T3'];
  const neighbors = state.neighborFocusChannels(channels, 'C3');
  assert.ok(neighbors.includes('C3'), 'includes the highlighted channel');
  assert.ok(neighbors.includes('F3') && neighbors.includes('P3'));
  assert.ok(!neighbors.includes('Fp1') && !neighbors.includes('O1') && !neighbors.includes('T3'), 'non-adjacent electrodes excluded');
  // Result must follow source order, not candidate insertion order.
  assert.deepEqual(neighbors, ['F3', 'C3', 'P3']);
});

test('neighborFocusChannels falls back to adjacent numbered contacts within radius and keeps the target', async () => {
  const state = await statePromise;
  // Depth electrode contacts with no conventional mapping -> numbered-contact adjacency path.
  const channels = ['LAD1', 'LAD2', 'LAD3', 'LAD4', 'RAD1', 'RAD2'];
  const neighbors = state.neighborFocusChannels(channels, 'LAD2', 1);
  assert.deepEqual(neighbors, ['LAD1', 'LAD2', 'LAD3']);
  // A radius of 2 widens the contact window.
  assert.deepEqual(state.neighborFocusChannels(channels, 'LAD2', 2), ['LAD1', 'LAD2', 'LAD3', 'LAD4']);
  // Different stem (RAD) must never bleed into LAD neighbors.
  assert.ok(!neighbors.some((channel) => channel.startsWith('RAD')));
});

test('neighborFocusChannels uses a positional index +/-1 fallback when no naming structure is available', async () => {
  const state = await statePromise;
  const channels = ['alpha', 'bravo', 'charlie', 'delta'];
  assert.deepEqual(state.neighborFocusChannels(channels, 'charlie'), ['bravo', 'charlie', 'delta']);
  // First channel only has a right neighbor.
  assert.deepEqual(state.neighborFocusChannels(channels, 'alpha'), ['alpha', 'bravo']);
  // Unknown target -> empty (no focus possible).
  assert.deepEqual(state.neighborFocusChannels(channels, 'missing'), []);
  assert.deepEqual(state.neighborFocusChannels([], 'charlie'), []);
});

test('cleanViewChannels excludes bad/flat channels and preserves source order', async () => {
  const state = await statePromise;
  const channels = ['A1', 'A2', 'A3', 'A4'];
  assert.deepEqual(state.cleanViewChannels(channels, ['A2', 'A4']), ['A1', 'A3']);
  // No exclusions -> unchanged copy.
  assert.deepEqual(state.cleanViewChannels(channels, []), channels);
  // Excluding everything would blank the view, so fall back to the full list.
  assert.deepEqual(state.cleanViewChannels(channels, ['A1', 'A2', 'A3', 'A4']), channels);
});

test('applyChannelFocusMode subsets for neighbors/clean and is a no-op for all/highlight/events', async () => {
  const state = await statePromise;
  const universe = ['Fp1', 'F3', 'C3', 'P3', 'O1', 'T3'];
  const base = [...universe];
  // neighbors uses the highlighted channel from the focus context (C3 bonds to F3 and P3 only).
  assert.deepEqual(
    state.applyChannelFocusMode(universe, base, 'neighbors', { highlightedChannel: 'C3' }),
    ['F3', 'C3', 'P3']
  );
  // clean drops excluded channels, intersected with the base selection.
  assert.deepEqual(
    state.applyChannelFocusMode(universe, ['F3', 'C3', 'P3'], 'clean', { excludedChannels: ['C3'] }),
    ['F3', 'P3']
  );
  // No focus context -> base list untouched even for subset modes.
  assert.deepEqual(state.applyChannelFocusMode(universe, base, 'neighbors'), base);
  // Non-subset modes never alter the list.
  assert.deepEqual(state.applyChannelFocusMode(universe, base, 'all', { highlightedChannel: 'C3' }), base);
  assert.deepEqual(state.applyChannelFocusMode(universe, base, 'highlight', { highlightedChannel: 'C3' }), base);
  assert.deepEqual(state.applyChannelFocusMode(universe, base, 'events', { excludedChannels: ['C3'] }), base);
});

test('waveformExcludedChannels aggregates QC, ROI, and confirmed exclusions from analysis state', async () => {
  const state = await statePromise;
  const analysis = {
    status: 'complete',
    qc: { excluded_channels: ['A1'], flat_channels: ['A2'], outlier_channels: ['A3'] },
    roi: { excluded_non_brain_channels: [{ channel: 'EKG' }], default_detection_exclusions: ['DC1'] },
    confirmed_exclusions: ['A1', 'NOISE']
  };
  const excluded = state.waveformExcludedChannels(analysis).sort();
  assert.deepEqual(excluded, ['A1', 'A2', 'A3', 'DC1', 'EKG', 'NOISE']);
  assert.deepEqual(state.waveformExcludedChannels(null), []);
  assert.deepEqual(state.waveformExcludedChannels({ status: 'idle' }), []);
});

// ---------------------------------------------------------------------------
// Task 3: per-event-type color mapping (PyQt model._resolve_event_color parity).
// COLOR_MAP: non_spike #6d8d74, artifact #b46f55, spike #7f6b93, ehfo #8d5f67.
// ---------------------------------------------------------------------------

test('resolveEventColorType mirrors PyQt _resolve_event_color precedence', async () => {
  const state = await statePromise;
  // Artifact == -1 (Unpredicted) -> non_spike, per model line 355-356.
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { Artifact: -1, spkHFO: 1 } })), 'non_spike');
  // Artifact < 1 (i.e. 0) -> artifact, and it outranks spike/ehfo flags.
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { Artifact: 0, spkHFO: 1, eHFO: 1 } })), 'artifact');
  // spkHFO -> spike (when not an artifact).
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { Artifact: 1, spkHFO: 1 } })), 'spike');
  // eHFO -> ehfo.
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { Artifact: 1, eHFO: 1 } })), 'ehfo');
  // Plain accepted HFO with no flags -> non_spike.
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { Artifact: 1, HFO: 1 } })), 'non_spike');
  // Reviewer artifact annotation is authoritative.
  assert.equal(state.resolveEventColorType(reviewEvent({ annotation: { label: 'artifact' }, features: { spkHFO: 1 } })), 'artifact');
  // Serialized clinical label string fallback (PyQt _get_prediction output).
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { prediction: 'spkHFO and eHFO' } })), 'spike');
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { prediction: 'Artifact' } })), 'artifact');
  // No resolvable clinical type -> null so the caller can use run-state styling.
  assert.equal(state.resolveEventColorType(reviewEvent()), null);
  assert.equal(state.resolveEventColorType(reviewEvent({ features: {} })), null);
});

test('resolveEventTypeColor returns COLOR_MAP RGB triples for each clinical type', async () => {
  const state = await statePromise;
  assert.deepEqual(state.resolveEventTypeColor(reviewEvent({ features: { Artifact: 0 } })), { r: 180, g: 111, b: 85 });
  assert.deepEqual(state.resolveEventTypeColor(reviewEvent({ features: { spkHFO: 1 } })), { r: 127, g: 107, b: 147 });
  assert.deepEqual(state.resolveEventTypeColor(reviewEvent({ features: { eHFO: 1 } })), { r: 141, g: 95, b: 103 });
  assert.deepEqual(state.resolveEventTypeColor(reviewEvent({ features: { HFO: 1 } })), { r: 109, g: 141, b: 116 });
  assert.equal(state.resolveEventTypeColor(reviewEvent()), null);
});

test('resolveEventColorType tolerates string and boolean feature encodings', async () => {
  const state = await statePromise;
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { spkHFO: 'true' } })), 'spike');
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { is_ehfo: true } })), 'ehfo');
  // spkHFO == 0 is a negative spike prediction: the classifier ran but it is not a spike, so it
  // resolves to the PyQt default non_spike color rather than spike.
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { spkHFO: 0 } })), 'non_spike');
  // A bare event with no classifier features at all stays null (run-state fallback).
  assert.equal(state.resolveEventColorType(reviewEvent({ features: { duration: 0.05 } })), null);
});

// ---------------------------------------------------------------------------
// Task 1: render width -> target_samples_per_channel mapping (PyQt model
// set_render_width_pixels / _target_render_points parity, ~2x with a floor).
// ---------------------------------------------------------------------------

test('resolveTargetSamplesPerChannel mirrors the PyQt render-points floor and 2x width relationship', async () => {
  const state = await statePromise;
  // Narrow widths still floor at MIN_RENDER_POINTS = 1500 (model MIN_RENDER_POINTS).
  assert.equal(state.resolveTargetSamplesPerChannel(320), 1500);
  assert.equal(state.resolveTargetSamplesPerChannel(100), 1500); // below floor width -> clamped up then floored
  // Mid widths track render_width_px * 2.
  assert.equal(state.resolveTargetSamplesPerChannel(1200), 2400);
  // Very wide widths cap the width at 4096 then double (but stay <= 5000).
  assert.equal(state.resolveTargetSamplesPerChannel(10000), 5000);
  // Invalid input -> safe default path floors at 1500.
  assert.equal(state.resolveTargetSamplesPerChannel(NaN), 1800);
  assert.equal(state.resolveTargetSamplesPerChannel(0), 1800);
});
