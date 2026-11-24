import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadRetention() {
  const source = readFileSync(join(root, 'electron/retention.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const retentionPromise = loadRetention();

const DAY_MS = 86400000;
const NOW = Date.UTC(2026, 6, 18);

const fixtures = [];
function makeUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'ieeg-retention-'));
  fixtures.push(dir);
  return dir;
}
test.after(() => { for (const dir of fixtures) rmSync(dir, { recursive: true, force: true }); });

function age(target, ageDays) {
  const when = new Date(NOW - ageDays * DAY_MS);
  utimesSync(target, when, when);
}

/** Mirrors what a completed /detections/run leaves on disk: results plus a checkpoint pair. */
function makeRun(userDataDir, name, ageDays, { summary = true, classified = false } = {}) {
  const dir = join(userDataDir, 'detection-runs', name);
  mkdirSync(join(dir, 'session.pybrain.data'), { recursive: true });
  writeFileSync(join(dir, 'events.csv'), 'channel_names,starts,ends\nA1,10,20\n');
  if (summary) writeFileSync(join(dir, 'summary.json'), '{"status":"complete"}');
  writeFileSync(join(dir, 'session.pybrain'), '{"format":"pybrain-session"}');
  writeFileSync(join(dir, 'session.pybrain.data', '0000_root_eeg_data.npy'), 'x'.repeat(4096));
  writeFileSync(join(dir, 'session.pybrain.data', '0001_root_filter_data.npy'), 'x'.repeat(4096));
  if (classified) {
    // Classification output is kept beside the desktop run's saved session.
    const nested = join(dir, 'session-classified');
    mkdirSync(join(nested, 'classified_session.pybrain.data'), { recursive: true });
    writeFileSync(join(nested, 'events.csv'), 'channel_names,starts,ends\n');
    writeFileSync(join(nested, 'summary.json'), '{"status":"complete"}');
    writeFileSync(join(nested, 'classified_session.pybrain'), '{"format":"pybrain-session"}');
    writeFileSync(join(nested, 'classified_session.pybrain.data', '0000_root_eeg_data.npy'), 'x'.repeat(4096));
    age(nested, ageDays);
  }
  age(dir, ageDays);
  return dir;
}

test('results outlive the checkpoint they were derived from', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const old = makeRun(userData, '2026-06-01T00-00-00-000Z-HFO-STE', 45);

  const summary = await pruneDetectionRunCheckpoints(userData, { keep: 0, nowMs: NOW });

  assert.ok(existsSync(join(old, 'events.csv')), 'events.csv must survive');
  assert.ok(existsSync(join(old, 'summary.json')), 'summary.json must survive');
  assert.equal(existsSync(join(old, 'session.pybrain')), false);
  assert.equal(existsSync(join(old, 'session.pybrain.data')), false);
  assert.ok(summary.freedBytes >= 8192, 'freed bytes should account for both arrays');
});

test('the manifest and its array sidecar are removed together, never one alone', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const old = makeRun(userData, '2026-06-01T00-00-00-000Z-HFO-STE', 45);

  await pruneDetectionRunCheckpoints(userData, { keep: 0, nowMs: NOW });

  // A surviving manifest whose .data dir is gone would make the run look reopenable and then fail
  // deep inside load_session_checkpoint — strictly worse than pruning nothing.
  const manifest = existsSync(join(old, 'session.pybrain'));
  const arrays = existsSync(join(old, 'session.pybrain.data'));
  assert.equal(manifest, arrays, 'manifest and arrays must share the same fate');
});

test('the newest runs keep their checkpoints', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const runs = [
    makeRun(userData, '2026-07-10T00-00-00-000Z-HFO-STE', 8),
    makeRun(userData, '2026-07-09T00-00-00-000Z-HFO-STE', 9),
    makeRun(userData, '2026-06-01T00-00-00-000Z-HFO-STE', 47),
  ];

  await pruneDetectionRunCheckpoints(userData, { keep: 2, nowMs: NOW });

  assert.ok(existsSync(join(runs[0], 'session.pybrain')), 'newest run keeps its checkpoint');
  assert.ok(existsSync(join(runs[1], 'session.pybrain')), 'second-newest keeps its checkpoint');
  assert.equal(existsSync(join(runs[2], 'session.pybrain')), false, 'oldest is pruned');
});

test('a run still in flight (no summary.json) is left alone', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const partial = makeRun(userData, '2026-06-01T00-00-00-000Z-HFO-STE', 45, { summary: false });

  const summary = await pruneDetectionRunCheckpoints(userData, { keep: 0, nowMs: NOW });

  assert.ok(existsSync(join(partial, 'session.pybrain')), 'an unfinished run must not be pruned');
  assert.equal(summary.scanned, 0);
  assert.equal(summary.skipped, 1);
});

test('a run created during this process lifetime is left alone', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const fresh = makeRun(userData, '2026-07-18T00-00-00-000Z-HFO-STE', -1); // mtime after the cutoff

  await pruneDetectionRunCheckpoints(userData, { keep: 0, nowMs: NOW });

  assert.ok(existsSync(join(fresh, 'session.pybrain')), 'this session may still hold its session_path');
});

test('the nested classified checkpoint is pruned too, but its results are kept', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const old = makeRun(userData, '2026-06-01T00-00-00-000Z-HFO-STE', 45, { classified: true });
  const nested = join(old, 'session-classified');

  await pruneDetectionRunCheckpoints(userData, { keep: 0, nowMs: NOW });

  assert.equal(existsSync(join(nested, 'classified_session.pybrain')), false);
  assert.equal(existsSync(join(nested, 'classified_session.pybrain.data')), false);
  assert.ok(existsSync(join(nested, 'events.csv')), 'nested results are results too');
  assert.ok(existsSync(join(nested, 'summary.json')));
});

test('unrecognised files in a pruned run are never touched', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const userData = makeUserData();
  const old = makeRun(userData, '2026-06-01T00-00-00-000Z-HFO-STE', 45);
  writeFileSync(join(old, 'clinician-notes.md'), 'do not delete me');
  age(old, 45);

  await pruneDetectionRunCheckpoints(userData, { keep: 0, nowMs: NOW });

  assert.ok(existsSync(join(old, 'clinician-notes.md')), 'only known checkpoint names may be deleted');
});

test('a missing detection-runs directory is not an error', async () => {
  const { pruneDetectionRunCheckpoints } = await retentionPromise;
  const summary = await pruneDetectionRunCheckpoints(makeUserData(), { keep: 0, nowMs: NOW });
  assert.deepEqual(summary.pruned, []);
  assert.deepEqual(summary.errors, []);
});

test('prepared recordings are retained unless a keep count is configured', async () => {
  const { prunePreparedRecordings } = await retentionPromise;
  const userData = makeUserData();
  const dir = join(userData, 'prepared-recordings');
  mkdirSync(dir, { recursive: true });
  const files = ['2026-06-01T00-00-00-000Z-a-prepared.fif', '2026-06-02T00-00-00-000Z-b-prepared.fif'];
  for (const [index, name] of files.entries()) {
    writeFileSync(join(dir, name), 'x'.repeat(1024));
    age(join(dir, name), 40 - index);
  }

  // Default: off, because a saved project may reference any of these by path.
  const off = await prunePreparedRecordings(userData, { nowMs: NOW });
  assert.deepEqual(off.pruned, []);
  for (const name of files) assert.ok(existsSync(join(dir, name)));

  const on = await prunePreparedRecordings(userData, { keep: 1, nowMs: NOW });
  assert.equal(on.pruned.length, 1);
  assert.ok(existsSync(join(dir, files[1])), 'the newest prepared recording survives');
  assert.equal(existsSync(join(dir, files[0])), false);
});

test('keep-count overrides fall back instead of throwing', async () => {
  const { configuredKeepCount } = await retentionPromise;
  assert.equal(configuredKeepCount(undefined, 5), 5);
  assert.equal(configuredKeepCount('', 5), 5);
  assert.equal(configuredKeepCount('12', 5), 12);
  assert.equal(configuredKeepCount('off', 5), Number.POSITIVE_INFINITY);
  assert.equal(configuredKeepCount('OFF', 5), Number.POSITIVE_INFINITY);
  assert.equal(configuredKeepCount('nonsense', 5), 5, 'a typo must not stop the app launching');
  assert.equal(configuredKeepCount('0', 5), 5);
  assert.equal(configuredKeepCount('-3', 5), 5);
  assert.equal(configuredKeepCount('2.5', 5), 5);
});

test('startup retention is opt-in so saved project checkpoints are preserved by default', async () => {
  const { startupRetentionPolicy } = await retentionPromise;
  const defaults = startupRetentionPolicy({});
  assert.equal(defaults.detectionRunCheckpoints, Number.POSITIVE_INFINITY);
  assert.equal(defaults.preparedRecordings, Number.POSITIVE_INFINITY);

  const configured = startupRetentionPolicy({
    IEEG_RETENTION_RUN_CHECKPOINTS: '5',
    IEEG_RETENTION_PREPARED_RECORDINGS: '12',
  });
  assert.deepEqual(configured, { detectionRunCheckpoints: 5, preparedRecordings: 12 });
});
