import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadSupervisor() {
  const source = readFileSync(join(root, 'electron/childSupervisor.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const supervisorPromise = loadSupervisor();

const base = { quitting: false, intentionalRestart: false, isCurrentRuntime: true, restartCount: 0, maxRestarts: 3 };

test('an unexpected crash of the current runtime triggers a restart', async () => {
  const { shouldRestartOnExit } = await supervisorPromise;
  assert.equal(shouldRestartOnExit({ ...base }), true);
});

test('app shutdown never restarts', async () => {
  const { shouldRestartOnExit } = await supervisorPromise;
  assert.equal(shouldRestartOnExit({ ...base, quitting: true }), false);
});

test('a deliberate key-change kill is not treated as a crash', async () => {
  const { shouldRestartOnExit } = await supervisorPromise;
  // This is the race the guard exists for: the intentional kill+respawn fires the same exit event.
  assert.equal(shouldRestartOnExit({ ...base, intentionalRestart: true }), false);
});

test('a superseded runtime (already replaced) does not restart', async () => {
  const { shouldRestartOnExit } = await supervisorPromise;
  assert.equal(shouldRestartOnExit({ ...base, isCurrentRuntime: false }), false);
});

test('an exhausted restart budget stops the crash loop', async () => {
  const { shouldRestartOnExit } = await supervisorPromise;
  assert.equal(shouldRestartOnExit({ ...base, restartCount: 3, maxRestarts: 3 }), false);
  assert.equal(shouldRestartOnExit({ ...base, restartCount: 2, maxRestarts: 3 }), true);
});

// ---- RestartCoordinator: the serialization that keeps crash-restart and key-change-restart from
// overlapping into a duplicate, unsupervised process. ----

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

test('isBusy reflects an in-flight restart', async () => {
  const { RestartCoordinator } = await supervisorPromise;
  const gate = deferred();
  const coord = new RestartCoordinator(async () => { await gate.promise; });
  assert.equal(coord.isBusy(), false);
  const p = coord.request();
  assert.equal(coord.isBusy(), true, 'busy while the restart runs');
  gate.resolve();
  await p;
  assert.equal(coord.isBusy(), false, 'idle after it finishes');
});

test('concurrent requests never overlap and are coalesced to a single follow-up', async () => {
  const { RestartCoordinator } = await supervisorPromise;
  const gates = [];
  let runs = 0; let running = 0; let maxConcurrent = 0;
  const coord = new RestartCoordinator(async () => {
    runs += 1; running += 1; maxConcurrent = Math.max(maxConcurrent, running);
    const g = deferred(); gates.push(g);
    await g.promise;
    running -= 1;
  });
  const p1 = coord.request();  // starts run #1
  const p2 = coord.request();  // busy -> deferred
  const p3 = coord.request();  // busy -> deferred (coalesced with p2, NOT a third run)
  await flush();
  assert.equal(runs, 1, 'only one run is active while the first is in flight');
  gates[0].resolve();          // finish run #1 -> triggers exactly one coalesced follow-up
  await flush();
  assert.equal(runs, 2, 'three overlapping requests produced two runs, not three');
  gates[1].resolve();
  await Promise.all([p1, p2, p3]);
  await flush();
  assert.equal(maxConcurrent, 1, 'never two restarts running at once');
});

test('a run error propagates to the direct caller and does not wedge the coordinator', async () => {
  const { RestartCoordinator } = await supervisorPromise;
  let attempts = 0;
  const coord = new RestartCoordinator(async () => { attempts += 1; if (attempts === 1) throw new Error('spawn failed'); });
  await assert.rejects(() => coord.request(), /spawn failed/);
  assert.equal(coord.isBusy(), false, 'not stuck busy after a failed run');
  await coord.request();       // a subsequent restart still works
  assert.equal(attempts, 2);
});

test('a coalesced request settles with its fresh follow-up run\'s real FAILURE (no false success)', async () => {
  // This is the property the D4/F1 rework turns on: a caller that coalesced behind an in-flight
  // restart must learn whether ITS restart actually succeeded — not resolve eagerly. A false
  // success would make a crash-retry skip its retry and reset the budget against a dead process.
  const { RestartCoordinator } = await supervisorPromise;
  let runs = 0;
  const gate1 = deferred();
  const coord = new RestartCoordinator(async () => {
    runs += 1;
    if (runs === 1) { await gate1.promise; } else { throw new Error('follow-up spawn failed'); }
  });
  const p1 = coord.request();  // in-flight run #1 (succeeds)
  const p2 = coord.request();  // coalesced -> waits for the fresh follow-up (run #2, which fails)
  let p2err = null;
  p2.catch((e) => { p2err = e; });   // handle so there is no unhandled rejection
  gate1.resolve();
  await assert.doesNotReject(() => p1, 'the in-flight run succeeded, so its direct caller resolves');
  await flush();
  assert.equal(runs, 2, 'the coalesced follow-up actually ran');
  assert.ok(p2err && /follow-up spawn failed/.test(p2err.message), 'coalesced caller sees the real failure');
});

test('a coalesced request resolves when its fresh follow-up run succeeds', async () => {
  const { RestartCoordinator } = await supervisorPromise;
  let runs = 0;
  const gate1 = deferred();
  const coord = new RestartCoordinator(async () => { runs += 1; if (runs === 1) { await gate1.promise; } });
  const p1 = coord.request();  // in-flight
  const p2 = coord.request();  // coalesced
  gate1.resolve();
  await assert.doesNotReject(() => p1);
  await assert.doesNotReject(() => p2, 'coalesced caller resolves on follow-up success');
  assert.equal(runs, 2);
});
