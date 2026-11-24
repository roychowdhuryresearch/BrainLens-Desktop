import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadModule() {
  const source = readFileSync(join(root, 'src/app/stagedCommandAuthorization.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modulePromise = loadModule();

function appliedReceipt(commandId, scope) {
  return {
    ok: true,
    receipt: {
      command_id: commandId,
      status: 'applied',
      terminal: false,
      conversation_id: scope.conversationId,
      state_revision: scope.stateRevision,
      approval_role: 'clinician',
      actor: { role: 'clinician' },
    },
  };
}

test('a side effect may start only after a matching durable applied receipt', async () => {
  const { authorizeStagedCommandExecution } = await modulePromise;
  const order = [];
  await authorizeStagedCommandExecution(
    'mcp-command-1',
    { status: 'applied' },
    { sessionId: 'session-1', conversationId: 'conv-1', stateRevision: 'rev-1' },
    { sessionId: 'session-1', conversationId: 'conv-1', stateRevision: 'rev-1' },
    async () => {
      order.push('broker-authorized');
      return appliedReceipt('mcp-command-1', { conversationId: 'conv-1', stateRevision: 'rev-1' });
    },
  );
  order.push('execute');
  assert.deepEqual(order, ['broker-authorized', 'execute']);
});

test('rejected, malformed, or mismatched broker replies fail before execution', async () => {
  const { authorizeStagedCommandExecution } = await modulePromise;
  for (const reply of [
    { ok: false },
    { ...appliedReceipt('mcp-other', { conversationId: 'conv-2', stateRevision: 'rev-2' }) },
    { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-2' }), receipt: { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-2' }).receipt, status: 'queued' } },
    { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-2' }), receipt: { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-2' }).receipt, terminal: true } },
    { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-other', stateRevision: 'rev-2' }) },
    { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-other' }) },
    { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-2' }), receipt: { ...appliedReceipt('mcp-command-2', { conversationId: 'conv-2', stateRevision: 'rev-2' }).receipt, actor: { role: 'service' } } },
  ]) {
    await assert.rejects(
      authorizeStagedCommandExecution(
        'mcp-command-2',
        { status: 'applied' },
        { sessionId: 'session-2', conversationId: 'conv-2', stateRevision: 'rev-2' },
        { sessionId: 'session-2', conversationId: 'conv-2', stateRevision: 'rev-2' },
        async () => reply,
      ),
      /did not durably authorize/,
    );
  }
});

test('model-authored non-broker command IDs cannot authorize a write', async () => {
  const { authorizeStagedCommandExecution } = await modulePromise;
  let called = false;
  await assert.rejects(
    authorizeStagedCommandExecution(
      'agent-ui-forged',
      { status: 'applied' },
      { sessionId: 'session-3', conversationId: 'conv-3', stateRevision: 'rev-3' },
      { sessionId: 'session-3', conversationId: 'conv-3', stateRevision: 'rev-3' },
      async () => {
      called = true;
      return { ok: true };
      },
    ),
    /not issued by the canonical UI broker/,
  );
  assert.equal(called, false);
});

test('a staged command cannot cross session, conversation, or state even when resource IDs collide', async () => {
  const { authorizeStagedCommandExecution } = await modulePromise;
  const captured = { sessionId: 'recording-a', conversationId: 'conv-a', stateRevision: 'rev-a' };
  for (const current of [
    { ...captured, sessionId: 'recording-b' },
    { ...captured, conversationId: 'conv-b' },
    { ...captured, stateRevision: 'rev-b' },
  ]) {
    let brokerCalled = false;
    let executed = false;
    try {
      await authorizeStagedCommandExecution(
        'mcp-stale-command',
        { status: 'applied', event_id: 'same-event-id', run_id: 'same-run-id' },
        captured,
        current,
        async () => {
          brokerCalled = true;
          return appliedReceipt('mcp-stale-command', captured);
        },
      );
      executed = true;
    } catch (error) {
      assert.match(String(error), /stale .* scope/);
    }
    assert.equal(brokerCalled, false);
    assert.equal(executed, false);
  }
});

test('scope changing while broker ACK is pending rejects the applied receipt and executes nothing', async () => {
  const { authorizeAndExecuteFreshStagedCommand } = await modulePromise;
  const captured = { sessionId: 'recording-a', conversationId: 'conv-a', stateRevision: 'rev-a' };
  let current = { ...captured };
  let resolveAck;
  let brokerCalled = false;
  let rejectionIssued = false;
  let executed = false;
  const ackPromise = new Promise((resolve) => { resolveAck = resolve; });

  const pending = authorizeAndExecuteFreshStagedCommand({
    commandId: 'mcp-toctou-command',
    outcome: { status: 'applied' },
    capturedScope: captured,
    readCurrentScope: () => ({ ...current }),
    acknowledge: async () => {
      brokerCalled = true;
      return ackPromise;
    },
    rejectAuthorized: async () => {
      rejectionIssued = true;
      return { ok: true };
    },
    execute: () => { executed = true; },
  });

  await Promise.resolve();
  assert.equal(brokerCalled, true);
  current = { sessionId: 'recording-b', conversationId: 'conv-a', stateRevision: 'rev-b' };
  resolveAck(appliedReceipt('mcp-toctou-command', captured));
  const result = await pending;

  assert.equal(result.executed, false);
  assert.match(result.scopeError, /stale .* scope/);
  assert.equal(rejectionIssued, true);
  assert.equal(executed, false);
});

test('App awaits durable authorization before dispatching the staged side effect', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  const start = app.indexOf('async function applyStagedUICommand');
  const end = app.indexOf('function dismissStagedUICommand', start);
  const block = app.slice(start, end);
  const authorize = block.indexOf('await authorizeAndExecuteFreshStagedCommand');
  const execute = block.indexOf('executeAppliedUICommand(applied.command)');
  const scopeCheck = block.indexOf('stagedCommandScopeError(existingContext, currentScope)');
  assert.ok(scopeCheck >= 0 && scopeCheck < authorize,
    'captured command scope must be compared to current scope before broker authorization');
  assert.ok(authorize >= 0, 'staged Apply must await the broker authorization helper');
  assert.ok(execute > authorize, 'backend/UI side effects must start only after broker authorization');
  assert.match(block, /humanApprovalNonce: capturedContext\.humanApprovalNonce \|\| globalThis\.crypto\.randomUUID\(\)/);
  assert.match(block, /const currentScope = \{[\s\S]{0,180}conversationId: existingContext\?\.conversationId \|\| liveAgentCommandScopeRef\.current\.conversationId/,
    'switching visible chat tabs must not invalidate the command origin captured by the broker');
  assert.match(block, /readCurrentScope: \(\) => \(\{[\s\S]{0,140}\.\.\.liveAgentCommandScopeRef\.current,[\s\S]{0,100}conversationId: approvalContext\.conversationId/,
    'the post-ACK scope must combine live workspace state with the immutable originating conversation');
  assert.doesNotMatch(block, /risk === 'review_write'/,
    'the human nonce must authorize every clinician-gated write, not only review labels');
});
