import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Load the pure (non-React) exports from EventReviewDialog.tsx. The component
// file imports React at the top; we strip the runtime `react` import (the
// type-only import erases under isolatedModules) so the transpiled module has
// no unresolvable specifiers and can be imported from a data: URL. The pure
// functions under test never touch React at runtime.
async function loadReviewModule() {
  const sourcePath = join(root, 'src/features/shell/EventReviewDialog.tsx');
  let source = readFileSync(sourcePath, 'utf8');
  source = source.replace(
    /^import\s+\{[^}]*\}\s+from\s+["']react["'];?\s*$/m,
    '',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      isolatedModules: true,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modulePromise = loadReviewModule();

function event(id, overrides = {}) {
  return { event_id: id, channel: 'A1', ...overrides };
}

// ---------------------------------------------------------------------------
// Task 1: prediction-based review scope (hfo_feature.get_prediction_scope_options)
// ---------------------------------------------------------------------------

test('prediction extraction reads predictions from event.features and top-level fields', async () => {
  const mod = await modulePromise;
  const fromFeatures = mod.eventPredictionData(
    event('e1', { features: { artifact_prediction: 1, spike_prediction: 1, ehfo_prediction: 0 } }),
  );
  assert.equal(fromFeatures.artifact, 1);
  assert.equal(fromFeatures.spike, 1);
  assert.equal(fromFeatures.ehfo, 0);

  // PyQt serialization key spellings (Artifact/spkHFO/eHFO) and top-level placement.
  const fromTop = mod.eventPredictionData(event('e2', { Artifact: 0, spkHFO: 1, eHFO: 1 }));
  assert.equal(fromTop.artifact, 0);
  assert.equal(fromTop.spike, 1);
  assert.equal(fromTop.ehfo, 1);

  const missing = mod.eventPredictionData(event('e3', { features: {} }));
  assert.equal(missing.artifact, null);
  assert.equal(missing.spike, null);
  assert.equal(missing.ehfo, null);
});

test('scope options surface prediction-based scopes only when prediction columns exist (hfo_feature.py:504-516)', async () => {
  const mod = await modulePromise;

  // No predictions, no annotations: only All events + decision scopes are offered.
  const bare = mod.eventScopeOptions([event('e1'), event('e2')]);
  assert.ok(bare.includes('All events'));
  assert.ok(!bare.includes('Artifact')); // prediction-based artifact absent
  assert.ok(!bare.includes('Non-artifact'));
  assert.ok(!bare.includes('spkHFO'));
  assert.ok(!bare.includes('eHFO'));
  // Unreviewed appears because every event is unannotated (annotated==0 parity).
  assert.ok(bare.includes('Unreviewed'));
  // Decision-based scopes are always retained.
  for (const decision of ['Accepted', 'Rejected', 'Decided Artifact', 'Uncertain']) {
    assert.ok(bare.includes(decision), decision);
  }

  // Artifact predictions present -> Artifact + Non-artifact (hfo_feature.py:508-509).
  const withArtifact = mod.eventScopeOptions([
    event('a', { features: { artifact_prediction: 1 } }),
    event('b', { features: { artifact_prediction: 0 } }),
  ]);
  assert.ok(withArtifact.includes('Artifact'));
  assert.ok(withArtifact.includes('Non-artifact'));
  // spkHFO/eHFO only when the column exists for EVERY event (hfo_feature.py:510-513).
  assert.ok(!withArtifact.includes('spkHFO'));
  assert.ok(!withArtifact.includes('eHFO'));

  // Full prediction columns -> spkHFO + eHFO become available.
  const full = mod.eventScopeOptions([
    event('a', { features: { artifact_prediction: 1, spike_prediction: 1, ehfo_prediction: 0 } }),
    event('b', { features: { artifact_prediction: 0, spike_prediction: 0, ehfo_prediction: 0 } }),
  ]);
  assert.ok(full.includes('spkHFO'));
  assert.ok(full.includes('eHFO'));
});

test('Unreviewed scope option is omitted once every event is annotated (hfo_feature.py:506)', async () => {
  const mod = await modulePromise;
  const allAnnotated = mod.eventScopeOptions([
    event('a', { annotation: { label: 'accepted' } }),
    event('b', { annotation: { label: 'rejected' } }),
  ]);
  assert.ok(!allAnnotated.includes('Unreviewed'));
});

test('overlap-tagged scope appears only when an event carries an overlap tag (hfo_feature.py:514)', async () => {
  const mod = await modulePromise;
  // Backend emits the explicit numeric `overlap_tagged` key only when tagged (>0);
  // a zero/absent value (and any unrelated feature) must NOT surface the scope.
  const noOverlap = mod.eventScopeOptions([event('a', { features: { x: 1, overlap_tagged: 0 } })]);
  assert.ok(!noOverlap.includes('Overlap tagged'));
  const withOverlap = mod.eventScopeOptions([
    event('a', { features: { overlap_tagged: 1 } }),
  ]);
  assert.ok(withOverlap.includes('Overlap tagged'));
});

test('scope matching mirrors _matches_prediction_scope semantics (hfo_feature.py:518-541)', async () => {
  const mod = await modulePromise;
  const artifactEvent = event('art', { features: { artifact_prediction: 0, spike_prediction: 1, ehfo_prediction: 1 } });
  const realSpk = event('spk', { features: { artifact_prediction: 1, spike_prediction: 1, ehfo_prediction: 0 } });
  const realEhfo = event('ehfo', { features: { artifact_prediction: 1, spike_prediction: 0, ehfo_prediction: 1 } });
  const realPlain = event('real', { features: { artifact_prediction: 1, spike_prediction: 0, ehfo_prediction: 0 } });

  // All matches everything (:519-520).
  assert.equal(mod.eventMatchesScope(artifactEvent, 'All events'), true);

  // Artifact = artifact prediction < 1 (:531-532).
  assert.equal(mod.eventMatchesScope(artifactEvent, 'Artifact'), true);
  assert.equal(mod.eventMatchesScope(realPlain, 'Artifact'), false);

  // Non-artifact = artifact prediction > 0 (:533-534).
  assert.equal(mod.eventMatchesScope(realPlain, 'Non-artifact'), true);
  assert.equal(mod.eventMatchesScope(artifactEvent, 'Non-artifact'), false);

  // spkHFO/eHFO only among non-artifact events (:535-540).
  assert.equal(mod.eventMatchesScope(realSpk, 'spkHFO'), true);
  assert.equal(mod.eventMatchesScope(realEhfo, 'eHFO'), true);
  // artifactEvent has spike==1 but is an artifact, so it must NOT match spkHFO.
  assert.equal(mod.eventMatchesScope(artifactEvent, 'spkHFO'), false);
  assert.equal(mod.eventMatchesScope(realSpk, 'eHFO'), false);

  // Prediction scopes require an artifact prediction column (:527-528).
  assert.equal(mod.eventMatchesScope(event('none', { features: {} }), 'Artifact'), false);

  // Unreviewed = no annotation (:523-524).
  assert.equal(mod.eventMatchesScope(event('u'), 'Unreviewed'), true);
  assert.equal(mod.eventMatchesScope(event('u', { annotation: { label: 'accepted' } }), 'Unreviewed'), false);
});

test('decision-based scopes filter on the human annotation label and stay available', async () => {
  const mod = await modulePromise;
  const accepted = event('a', { annotation: { label: 'accepted' } });
  const rejected = event('r', { annotation: { label: 'rejected' } });
  const humanArtifact = event('h', { annotation: { label: 'artifact' } });
  assert.equal(mod.eventMatchesScope(accepted, 'Accepted'), true);
  assert.equal(mod.eventMatchesScope(rejected, 'Rejected'), true);
  assert.equal(mod.eventMatchesScope(humanArtifact, 'Decided Artifact'), true);
  assert.equal(mod.eventMatchesScope(accepted, 'Decided Artifact'), false);
});

test('filterEventsForScope honors scope + unannotated_only (hfo_feature.py:543-553)', async () => {
  const mod = await modulePromise;
  const events = [
    event('a', { features: { artifact_prediction: 0 } }), // artifact, unannotated
    event('b', { features: { artifact_prediction: 1 }, annotation: { label: 'accepted' } }), // real, annotated
    event('c', { features: { artifact_prediction: 1 } }), // real, unannotated
  ];
  const artifacts = mod.filterEventsForScope(events, 'Artifact', false);
  assert.deepEqual(artifacts.map((e) => e.event_id), ['a']);

  const nonArtifacts = mod.filterEventsForScope(events, 'Non-artifact', false);
  assert.deepEqual(nonArtifacts.map((e) => e.event_id), ['b', 'c']);

  // unannotated_only drops the annotated event (:551).
  const nonArtifactsUnannotated = mod.filterEventsForScope(events, 'Non-artifact', true);
  assert.deepEqual(nonArtifactsUnannotated.map((e) => e.event_id), ['c']);

  // All events + unannotated_only keeps only the unannotated ones.
  const allUnannotated = mod.filterEventsForScope(events, 'All events', true);
  assert.deepEqual(allUnannotated.map((e) => e.event_id), ['a', 'c']);
});

// ---------------------------------------------------------------------------
// Task 3: FFT fidelity (Hann window + PSD-percent normalization)
// ---------------------------------------------------------------------------

test('hannWindow matches numpy.hanning endpoints-at-zero shape', async () => {
  const mod = await modulePromise;
  const w = mod.hannWindow(8);
  assert.equal(w.length, 8);
  assert.ok(Math.abs(w[0]) < 1e-12); // first weight == 0
  assert.ok(Math.abs(w[7]) < 1e-12); // last weight == 0
  // Symmetric about the center.
  for (let i = 0; i < w.length; i += 1) {
    assert.ok(Math.abs(w[i] - w[w.length - 1 - i]) < 1e-12);
  }
  // Mid weights are the peak (== 1 for the closest-to-center samples).
  const mid = Math.max(...w);
  assert.ok(mid > 0.9);
});

test('computeFftSpectrum yields PSD-percent bins that sum to ~100 and a peak at the dominant tone', async () => {
  const mod = await modulePromise;
  const fs = 256;
  const n = 256;
  const toneHz = 40;
  const signal = Array.from({ length: n }, (_, i) =>
    Math.sin((2 * Math.PI * toneHz * i) / fs),
  );
  const { bins, peak } = mod.computeFftSpectrum(signal, fs, 0, 128);
  assert.ok(bins.length > 1);
  // PSD-percent normalization: in-range bins sum to ~100% (annotation_plot.py:1088-1090).
  const total = bins.reduce((acc, b) => acc + b.amplitude, 0);
  assert.ok(Math.abs(total - 100) < 1e-6, `sum=${total}`);
  // Peak marker sits at the injected tone frequency (annotation_plot.py:1109-1111).
  assert.ok(peak);
  assert.ok(Math.abs(peak.frequency - toneHz) <= fs / n + 1e-9, `peak=${peak.frequency}`);
  // The peak should dominate the spectrum.
  assert.ok(peak.amplitude > 50);
});

test('computeFftSpectrum respects the [minFreq, maxFreq] window and renormalizes within it', async () => {
  const mod = await modulePromise;
  const fs = 256;
  const n = 256;
  const signal = Array.from({ length: n }, (_, i) =>
    Math.sin((2 * Math.PI * 40 * i) / fs) + 0.5 * Math.sin((2 * Math.PI * 90 * i) / fs),
  );
  const windowed = mod.computeFftSpectrum(signal, fs, 0, 60);
  // No bin above the 60 Hz cutoff survives.
  assert.ok(windowed.bins.every((b) => b.frequency <= 60));
  // Still normalized to 100% within the surviving window.
  const total = windowed.bins.reduce((acc, b) => acc + b.amplitude, 0);
  assert.ok(Math.abs(total - 100) < 1e-6);
  // DC mean is removed (annotation_plot.py:1072): a constant offset adds no DC power.
  const offsetSignal = signal.map((v) => v + 1000);
  const offsetSpectrum = mod.computeFftSpectrum(offsetSignal, fs, 0, 60);
  const dcBin = offsetSpectrum.bins.find((b) => b.frequency === 0);
  assert.ok(!dcBin || dcBin.amplitude < 1e-3);
});

test('computeFftSpectrum guards short / invalid input', async () => {
  const mod = await modulePromise;
  assert.deepEqual(mod.computeFftSpectrum([1, 2], 256).bins, []);
  assert.deepEqual(mod.computeFftSpectrum([1, 2, 3, 4], 0).bins, []);
});

// ---------------------------------------------------------------------------
// Task 2 + 4: pane interaction math (hover readout, wheel zoom, cursor mapping)
// ---------------------------------------------------------------------------

test('paneHoverReadout mirrors annotation_plot _update_hover_display formatting', async () => {
  const mod = await modulePromise;
  assert.equal(
    mod.paneHoverReadout('raw', 0.1234, { raw: 12.5, filtered: -3.2, y: 12.5 }),
    't=0.1234s | raw=12.50 | filtered=-3.20 | y=12.50',
  );
  // TF pane reports a frequency at the cursor (ax_idx == 2 branch).
  assert.equal(
    mod.paneHoverReadout('tf', 0.5, { freq: 250 }),
    't=0.5000s | freq=250.0Hz',
  );
  // FFT pane reports frequency + PSD percent.
  assert.equal(
    mod.paneHoverReadout('fft', 0, { freq: 80, y: 12.34 }),
    't=0.0000s | freq=80.0Hz | psd=12.34%',
  );
});

test('time-frequency cells render high frequency above low frequency regardless of backend row order', async () => {
  const mod = await modulePromise;
  const snippet = {
    time_frequency: {
      intensity: [
        [0.1, 0.2], // 80 Hz in source row 0
        [0.3, 0.4], // 250 Hz
        [0.9, 1.0], // 500 Hz in source row 2
      ],
      frequencies_hz: [80, 250, 500],
      high_frequency_at_top: false,
      display_transform: 'pyqt_log10_percentile',
      display_limits: [0, 1],
      colormap: 'magma',
    },
  };

  const cells = mod.computeTimeFrequencyCells(snippet, [80, 500]);
  const high = cells.find((cell) => cell.frequency === 500 && cell.column === 0);
  const low = cells.find((cell) => cell.frequency === 80 && cell.column === 0);
  assert.ok(high);
  assert.ok(low);
  assert.equal(high.row, 0);
  assert.equal(low.row, 2);

  const plot = { x: 10, y: 20, width: 300, height: 90 };
  const cellHeight = plot.height / 3;
  const highRect = mod.timeFrequencyCellRect(high, plot, 2, cellHeight, [], false, 0, 1);
  const lowRect = mod.timeFrequencyCellRect(low, plot, 2, cellHeight, [], false, 0, 1);
  assert.ok(highRect.y < lowRect.y, `high=${highRect.y} low=${lowRect.y}`);
});

test('lookupSeriesValueAtTime returns the nearest sample (searchsorted parity)', async () => {
  const mod = await modulePromise;
  const times = [0, 0.1, 0.2, 0.3];
  const signal = [10, 20, 30, 40];
  assert.equal(mod.lookupSeriesValueAtTime(times, signal, 0.0), 10);
  assert.equal(mod.lookupSeriesValueAtTime(times, signal, 0.2), 30);
  // Out-of-range clamps to the ends.
  assert.equal(mod.lookupSeriesValueAtTime(times, signal, 5), 40);
  assert.equal(mod.lookupSeriesValueAtTime(times, signal, -5), 10);
  assert.equal(mod.lookupSeriesValueAtTime([], [], 1), null);
});

test('paneCursorXFraction inverts the SVG x view-transform', async () => {
  const mod = await modulePromise;
  // Plot starts at x=58, width=900, no transform: midpoint -> 0.5.
  assert.ok(Math.abs(mod.paneCursorXFraction(58 + 450, 58, 900, 0, 1) - 0.5) < 1e-9);
  // With zoom=2 and panX=58, a pointer at 58+900 maps back into user space.
  const f = mod.paneCursorXFraction(58 + 900, 58, 900, 58, 2);
  assert.ok(f >= 0 && f <= 1);
  // Clamped to [0,1] outside the plot rect.
  assert.equal(mod.paneCursorXFraction(0, 58, 900, 0, 1), 0);
  assert.equal(mod.paneCursorXFraction(100000, 58, 900, 0, 1), 1);
});

test('wheelZoomTransform zooms toward the cursor like annotation_plot.wheelEvent', async () => {
  const mod = await modulePromise;
  const width = 900;
  // Scroll up (deltaY < 0) zooms in by 1.3 (annotation_plot.py:761).
  const zoomedIn = mod.wheelZoomTransform({ zoom: 1, panX: 0 }, -120, 0.5, width);
  assert.ok(Math.abs(zoomedIn.zoom - 1.3) < 1e-9);
  // The data point under the cursor stays fixed: userX before == userX after.
  const anchorBefore = 0.5 * width; // panX 0, zoom 1
  const anchorAfter = (0.5 * width - zoomedIn.panX) / zoomedIn.zoom;
  assert.ok(Math.abs(anchorBefore - anchorAfter) < 1e-6);

  // Scroll down (deltaY > 0) zooms out by 1/1.3.
  const zoomedOut = mod.wheelZoomTransform({ zoom: 1.3, panX: 0 }, 120, 0.5, width);
  assert.ok(Math.abs(zoomedOut.zoom - 1) < 1e-9);

  // Zoom is clamped to bounds and never below 1 (no un-zoom past the default view).
  const clamped = mod.wheelZoomTransform({ zoom: 1, panX: 0 }, 120, 0.5, width);
  assert.equal(clamped.zoom, 1);
  assert.equal(clamped.panX, 0); // unchanged when zoom does not move
});
