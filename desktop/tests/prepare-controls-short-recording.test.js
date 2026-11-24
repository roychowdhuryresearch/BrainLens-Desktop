import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Same transpile-and-import pattern as prepare-controls-nyquist.test.js: workspaceState.ts has only
// `import type` (elided under isolatedModules), so the compiled module runs from a data: URL.
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

// The reported repro: sub-Multicenterumf005 ictal ECoG prepared.fif is an anomalous 1.0 s recording,
// so STE/MNI legitimately return 0 events and the UI must explain WHY instead of a bare "0 event(s)".
const UMF005_META = { duration_seconds: 1.0 };

test('recordingDurationSeconds reads whichever metadata key carries the length', async () => {
  const model = await modelPromise;
  assert.equal(model.recordingDurationSeconds({ duration_seconds: 71 }), 71);
  assert.equal(model.recordingDurationSeconds({ length_seconds: 30 }), 30);
  assert.equal(model.recordingDurationSeconds({ length: '12.5' }), 12.5);
  assert.equal(model.recordingDurationSeconds({}), 0);
  assert.equal(model.recordingDurationSeconds(null), 0);
});

test('shortRecordingDetectionNote explains a too-short recording and names its actual duration', async () => {
  const model = await modelPromise;
  assert.equal(model.MIN_DETECTION_DURATION_SECONDS, 60);

  const note = model.shortRecordingDetectionNote(UMF005_META);
  assert.ok(note, '1.0 s recording must produce an explanation');
  assert.match(note, /1 s/);
  assert.match(note, /too short/i);
  assert.match(note, /60 s/);

  // Sub-second and fractional durations render with one decimal.
  assert.match(model.shortRecordingDetectionNote({ duration_seconds: 1.5 }), /1\.5 s/);
  // A 20 s recording is still below the floor (empirically yields 0 events).
  assert.ok(model.shortRecordingDetectionNote({ duration_seconds: 20 }));
});

test('shortRecordingDetectionNote returns null for adequate, boundary, or unknown durations', async () => {
  const model = await modelPromise;
  // Boundary: exactly the recommended floor is adequate (>= floor -> no note).
  assert.equal(model.shortRecordingDetectionNote({ duration_seconds: 60 }), null);
  // A comfortably long recording never gets the note (would misexplain a genuine empty result).
  assert.equal(model.shortRecordingDetectionNote({ duration_seconds: 71 }), null);
  // Unknown / zero / missing duration -> cannot conclude "too short" -> null.
  assert.equal(model.shortRecordingDetectionNote({}), null);
  assert.equal(model.shortRecordingDetectionNote(null), null);
  assert.equal(model.shortRecordingDetectionNote({ duration_seconds: 0 }), null);
});
