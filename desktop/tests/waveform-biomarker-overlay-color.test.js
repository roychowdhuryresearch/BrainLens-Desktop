import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Load the pure color/legend exports from WaveformCanvas.tsx. The component file
// imports react, workspaceState (resolveEventTypeColor) and waveformGL at runtime;
// none are touched by the functions under test, so we strip every top-level import
// (types erase under isolatedModules; the stripped runtime bindings are only used
// inside other functions) and import the transpiled module from a data: URL.
async function loadCanvasModule() {
  let source = readFileSync(join(root, 'src/features/waveform/WaveformCanvas.tsx'), 'utf8');
  source = source.replace(/^import\s.*?from\s.*?;\s*$/gm, '');
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

const modulePromise = loadCanvasModule();

function overlay(biomarker) {
  return { event: { event_id: 'e', start_seconds: 0 }, run: biomarker ? { biomarker } : null, active: false, accepted: false, visible: true };
}

test('biomarkerOverlayColor maps each biomarker to a distinct hue', async () => {
  const { biomarkerOverlayColor } = await modulePromise;
  assert.equal(biomarkerOverlayColor(overlay('HFO'), 0.9), 'rgba(225, 29, 72, 0.9)');      // red
  assert.equal(biomarkerOverlayColor(overlay('Spindle'), 0.9), 'rgba(37, 99, 235, 0.9)');  // blue
  assert.equal(biomarkerOverlayColor(overlay('Spike'), 0.9), 'rgba(245, 158, 11, 0.9)');   // amber
});

test('biomarkerOverlayColor is case/substring tolerant and falls back to slate', async () => {
  const { biomarkerOverlayColor } = await modulePromise;
  // Detector-prefixed or lowercased biomarker strings still resolve.
  assert.equal(biomarkerOverlayColor(overlay('hfo'), 1), 'rgba(225, 29, 72, 1)');
  assert.equal(biomarkerOverlayColor(overlay('Fast Ripple'), 1), 'rgba(225, 29, 72, 1)');
  // Unknown / missing biomarker → slate, never throws.
  assert.equal(biomarkerOverlayColor(overlay(''), 1), 'rgba(100, 116, 139, 1)');
  assert.equal(biomarkerOverlayColor(overlay(null), 1), 'rgba(100, 116, 139, 1)');
});

test('HFO and Spindle ticks are visually distinguishable (the co-localization guarantee)', async () => {
  const { biomarkerOverlayColor } = await modulePromise;
  assert.notEqual(biomarkerOverlayColor(overlay('HFO'), 0.9), biomarkerOverlayColor(overlay('Spindle'), 0.9));
});

test('biomarkerOverlayLegend dedups by biomarker in first-seen order with solid swatches', async () => {
  const { biomarkerOverlayLegend } = await modulePromise;
  const legend = biomarkerOverlayLegend([overlay('HFO'), overlay('Spindle'), overlay('HFO'), overlay('hfo')]);
  assert.deepEqual(legend, [
    { label: 'HFO', color: 'rgba(225, 29, 72, 1)' },
    { label: 'Spindle', color: 'rgba(37, 99, 235, 1)' },
  ]);
});

test('biomarkerOverlayLegend ignores overlays with no run/biomarker', async () => {
  const { biomarkerOverlayLegend } = await modulePromise;
  assert.deepEqual(biomarkerOverlayLegend([overlay(null), overlay('')]), []);
});
