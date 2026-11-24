import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadReviewWriteSettlement() {
  const source = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'settleAgentReviewWrite');
  assert.ok(declaration, 'settleAgentReviewWrite must remain an executable top-level contract helper');
  const compiled = ts.transpileModule(declaration.getText(file), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const helperPromise = loadReviewWriteSettlement();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('review write remains running until the backend mutation returns observed evidence', async () => {
  const { settleAgentReviewWrite } = await helperPromise;
  const backend = deferred();
  const receipts = [];
  const pending = settleAgentReviewWrite({
    commandType: 'events.stage_annotation',
    execute: () => backend.promise,
    acknowledge: (receipt) => receipts.push(receipt),
    now: () => '2026-07-15T20:00:00Z'
  });

  await Promise.resolve();
  assert.deepEqual(receipts.map((receipt) => receipt.status), ['running']);
  assert.equal(receipts.some((receipt) => receipt.status === 'complete'), false, 'must not report success while backend work is pending');

  backend.resolve({ source: 'backend_readback', event_id: 'event-1', expected_annotation_label: 'accepted', annotation_present: true });
  const result = await pending;
  assert.equal(result.status, 'complete');
  assert.deepEqual(receipts.map((receipt) => receipt.status), ['running', 'complete']);
  assert.equal(receipts[1].terminal_proof.source, 'backend_readback');
  assert.equal('diff_state' in receipts[1], false, 'unchanged renderer snapshots are not terminal proof');
});

test('review write backend failure yields failed, never success', async () => {
  const { settleAgentReviewWrite } = await helperPromise;
  const receipts = [];
  const result = await settleAgentReviewWrite({
    commandType: 'events.stage_annotation',
    execute: async () => { throw new Error('annotation backend unavailable'); },
    acknowledge: (receipt) => receipts.push(receipt),
    now: () => '2026-07-15T20:00:00Z'
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(receipts.map((receipt) => receipt.status), ['running', 'failed']);
  assert.equal(receipts[1].error.code, 'execution_failed');
  assert.equal(receipts.some((receipt) => receipt.status === 'complete'), false);
});

test('review write without observed postcondition evidence terminates as noop', async () => {
  const { settleAgentReviewWrite } = await helperPromise;
  const receipts = [];
  const result = await settleAgentReviewWrite({
    commandType: 'events.clear_staged_annotation',
    execute: async () => null,
    acknowledge: (receipt) => receipts.push(receipt),
    now: () => '2026-07-15T20:00:00Z'
  });

  assert.equal(result.status, 'noop');
  assert.deepEqual(receipts.map((receipt) => receipt.status), ['running', 'noop']);
});

test('App routes confirmed annotation writes through backend read-back settlement', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  assert.match(app, /events\.stage_annotation[\s\S]{0,900}annotateEvent\([^;]+commandId: command\.command_id/);
  assert.match(app, /backendClient\.annotateEvent[\s\S]{0,700}refreshReviewEvents\(context\.runId, \{ throwOnError: true \}\)/);
  assert.match(app, /observedLabel !== backendLabel/);
  assert.match(app, /entryStartsAsyncOperation\(entry\)[\s\S]{0,120}return \{ status: 'running'/);
  assert.doesNotMatch(app, /status: 'complete'[^\n]+diff_state: ['"]unchanged['"]/);
});
