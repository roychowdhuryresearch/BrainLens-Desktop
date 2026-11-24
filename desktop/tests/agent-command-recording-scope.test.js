import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadScopeHelper() {
  let source = readFileSync(join(root, 'src/app/agentCommandRecordingScope.ts'), 'utf8');
  source = source.replace(/import type \{ UICommand \} from '[^']+';\n/, '');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const helperPromise = loadScopeHelper();

function command(overrides = {}) {
  return {
    command_id: 'mcp-command-1',
    type: 'severity.run',
    reason: 'test',
    payload: { input_path: '/data/case.edf', recording_fingerprint: 'a'.repeat(64) },
    resource_scope: { recording_sha256: 'a'.repeat(64), state_revision: 'rev-1' },
    ...overrides,
  };
}

test('recording-bound compute command accepts only the active path and fingerprint', async () => {
  const { agentCommandRecordingScopeError } = await helperPromise;
  assert.equal(agentCommandRecordingScopeError(command(), '/data/case.edf', 'a'.repeat(64)), null);
  assert.match(agentCommandRecordingScopeError(command(), '/data/other.edf', 'a'.repeat(64)), /input_path/);
  assert.match(agentCommandRecordingScopeError(command(), '/data/case.edf', 'b'.repeat(64)), /does not match/);
});

test('broker compute command fails closed on missing or conflicting durable fingerprint scope', async () => {
  const { agentCommandRecordingScopeError } = await helperPromise;
  const missing = command({ payload: { input_path: '/data/case.edf' }, resource_scope: { state_revision: 'rev-1' } });
  assert.match(agentCommandRecordingScopeError(missing, '/data/case.edf', 'a'.repeat(64)), /missing a recording fingerprint/);

  const conflicting = command({ resource_scope: { recording_sha256: 'b'.repeat(64), state_revision: 'rev-1' } });
  assert.match(agentCommandRecordingScopeError(conflicting, '/data/case.edf', 'a'.repeat(64)), /identify different recordings/);
});
