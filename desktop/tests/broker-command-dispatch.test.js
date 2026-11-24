import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadModule() {
  const source = readFileSync(join(root, 'src/app/brokerCommandDispatch.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modulePromise = loadModule();
const normalize = (raw) => raw && typeof raw.command_id === 'string' && typeof raw.type === 'string'
  ? { command_id: raw.command_id, type: raw.type }
  : null;

test('a command already received over SSE is not executed or acknowledged again by broker polling', async () => {
  const { dispatchBrokerCommand } = await modulePromise;
  let applied = 0;
  const result = dispatchBrokerCommand(
    { command_id: 'mcp-1', type: 'events.stage_annotation' },
    { normalize, isRecorded: () => true, apply: () => { applied += 1; return { status: 'applied', reason: null }; } },
  );
  assert.equal(result.shouldAcknowledge, false);
  assert.equal(result.outcome, null);
  assert.equal(applied, 0);
});

test('a new broker command executes once and relays its real outcome', async () => {
  const { dispatchBrokerCommand } = await modulePromise;
  let applied = 0;
  const result = dispatchBrokerCommand(
    { command_id: 'mcp-2', type: 'analysis.run_qc' },
    { normalize, isRecorded: () => false, apply: () => { applied += 1; return { status: 'running', reason: null }; } },
  );
  assert.equal(result.shouldAcknowledge, true);
  assert.deepEqual(result.outcome, { status: 'running', reason: null });
  assert.equal(applied, 1);
});

test('an invalid broker payload fails closed with a terminal rejection shape', async () => {
  const { dispatchBrokerCommand } = await modulePromise;
  const result = dispatchBrokerCommand(
    { command_id: 'mcp-3' },
    { normalize, isRecorded: () => false, apply: () => { throw new Error('must not execute'); } },
  );
  assert.equal(result.shouldAcknowledge, true);
  assert.equal(result.commandId, 'mcp-3');
  assert.equal(result.outcome.status, 'rejected');
});
