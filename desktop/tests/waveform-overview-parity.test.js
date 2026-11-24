import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Transpile workspaceState.ts in-memory (same harness pattern as waveform-canvas-parity.test.js /
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
// Overview minimap geometry: time<->x mapping, range-band rect, and seek clamp.
// (Full-recording overview navigator parity — draggable window band.)
// ---------------------------------------------------------------------------

test('overviewTimeToX maps recording time linearly across the overview width and clamps to range', async () => {
  const state = await statePromise;
  // 120s recording over a 600px overview: 0s -> 0px, 60s -> 300px (mid), 120s -> 600px (end).
  assert.equal(state.overviewTimeToX(0, 120, 600), 0);
  assert.equal(state.overviewTimeToX(60, 120, 600), 300);
  assert.equal(state.overviewTimeToX(120, 120, 600), 600);
  // Times outside [0, duration] clamp to the edges (no overflow past the strip).
  assert.equal(state.overviewTimeToX(-10, 120, 600), 0);
  assert.equal(state.overviewTimeToX(999, 120, 600), 600);
  // Degenerate width/duration -> 0 (nothing to map onto).
  assert.equal(state.overviewTimeToX(60, 0, 600), 0);
  assert.equal(state.overviewTimeToX(60, 120, 0), 0);
});

test('overviewXToTime is the inverse of overviewTimeToX and clamps the pixel into range', async () => {
  const state = await statePromise;
  assert.equal(state.overviewXToTime(0, 120, 600), 0);
  assert.equal(state.overviewXToTime(300, 120, 600), 60);
  assert.equal(state.overviewXToTime(600, 120, 600), 120);
  // Pixels outside [0, width] clamp to the time bounds.
  assert.equal(state.overviewXToTime(-50, 120, 600), 0);
  assert.equal(state.overviewXToTime(5000, 120, 600), 120);
  // Round-trips for arbitrary interior points.
  const seconds = state.overviewXToTime(123, 120, 600);
  assert.ok(Math.abs(state.overviewTimeToX(seconds, 120, 600) - 123) < 1e-9);
});

test('clampOverviewStartSeconds keeps the window inside [0, duration]', async () => {
  const state = await statePromise;
  // Window of 10s in a 120s recording: max start is 110s.
  assert.equal(state.clampOverviewStartSeconds(50, 10, 120), 50);
  // Start cannot go below 0.
  assert.equal(state.clampOverviewStartSeconds(-5, 10, 120), 0);
  // Start cannot push the window past the end: 115 -> 110 (duration - window).
  assert.equal(state.clampOverviewStartSeconds(115, 10, 120), 110);
  // Exactly at the max boundary stays put.
  assert.equal(state.clampOverviewStartSeconds(110, 10, 120), 110);
  // Window >= duration pins the start to 0.
  assert.equal(state.clampOverviewStartSeconds(40, 200, 120), 0);
  // Non-finite input is treated as 0.
  assert.equal(state.clampOverviewStartSeconds(NaN, 10, 120), 0);
});

test('overviewRangeBandRect positions the band by start and sizes it by window, clamped to the strip', async () => {
  const state = await statePromise;
  // 120s recording, 600px strip, 10s window at 60s: x = 300px, width = (10/120)*600 = 50px.
  const mid = state.overviewRangeBandRect(60, 10, 120, 600);
  assert.equal(mid.x, 300);
  assert.equal(mid.width, 50);
  // At start 0 the band hugs the left edge.
  const left = state.overviewRangeBandRect(0, 10, 120, 600);
  assert.equal(left.x, 0);
  assert.equal(left.width, 50);
  // An out-of-range start clamps so the band never overflows the right edge (x + width <= 600).
  const clamped = state.overviewRangeBandRect(115, 10, 120, 600);
  assert.ok(clamped.x + clamped.width <= 600 + 1e-9);
  assert.equal(clamped.x, 550); // start clamps to 110s -> 550px, band width 50px ends at 600px.
  // A sub-pixel window still yields a grabbable minimum band width.
  const tiny = state.overviewRangeBandRect(10, 0.1, 120, 600, 6);
  assert.ok(tiny.width >= 6);
  // Full-duration window fills the whole strip.
  const full = state.overviewRangeBandRect(0, 120, 120, 600);
  assert.equal(full.x, 0);
  assert.equal(full.width, 600);
  // Degenerate duration -> safe zero-anchored band.
  const empty = state.overviewRangeBandRect(0, 10, 0, 600);
  assert.equal(empty.x, 0);
});

test('OVERVIEW_TARGET_SAMPLES_PER_CHANNEL is a coarse full-recording target', async () => {
  const state = await statePromise;
  assert.equal(state.OVERVIEW_TARGET_SAMPLES_PER_CHANNEL, 800);
});
