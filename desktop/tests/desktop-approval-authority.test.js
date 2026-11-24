import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadModule() {
  const source = readFileSync(join(root, 'src/app/desktopApprovalAuthority.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modulePromise = loadModule();

test('agent/autonomy execution cannot manufacture clinician review authority', async () => {
  const { buildDesktopApprovalActor } = await modulePromise;
  const actor = buildDesktopApprovalActor(
    { sessionId: 'workspace-1', conversationId: 'conv-1', stateRevision: 'rev-1' },
    'fallback',
    'scope-1',
  );
  assert.deepEqual(actor, {
    role: 'service',
    actor_id: 'desktop-agent-service-scope-1',
    session_id: 'workspace-1',
    source: 'desktop_renderer',
  });
});

test('an explicit human Apply nonce mints distinct clinician authority', async () => {
  const { buildDesktopApprovalActor } = await modulePromise;
  const actor = buildDesktopApprovalActor(
    {
      sessionId: 'workspace-2',
      conversationId: 'conv-2',
      stateRevision: 'rev-2',
      humanApprovalNonce: 'approval-uuid-2',
    },
    'fallback',
    'scope-2',
  );
  assert.deepEqual(actor, {
    role: 'clinician',
    actor_id: 'desktop-clinician-scope-2',
    session_id: 'workspace-2',
    source: 'desktop_human_apply:approval-uuid-2',
  });
});

test('queued review acknowledgement does not pre-bind a service actor', async () => {
  const { bindDesktopApprovalContext } = await modulePromise;
  const bound = bindDesktopApprovalContext(
    { status: 'staged', command_type: 'events.stage_annotation' },
    { sessionId: 'workspace-3', conversationId: 'conv-3', stateRevision: 'rev-3' },
    'fallback',
    'scope-3',
    'fallback-conv',
    'fallback-rev',
  );
  assert.equal('approval_actor' in bound, false);
  assert.equal(bound.conversation_id, 'conv-3');
  assert.equal(bound.state_revision, 'rev-3');
});

test('execution acknowledgement binds the actor only after authority is known', async () => {
  const { bindDesktopApprovalContext } = await modulePromise;
  const bound = bindDesktopApprovalContext(
    { status: 'running', command_type: 'events.stage_annotation' },
    {
      sessionId: 'workspace-4',
      conversationId: 'conv-4',
      stateRevision: 'rev-4',
      humanApprovalNonce: 'approval-uuid-4',
    },
    'fallback',
    'scope-4',
    'fallback-conv',
    'fallback-rev',
  );
  assert.equal(bound.approval_actor.role, 'clinician');
  assert.equal(bound.approval_actor.source, 'desktop_human_apply:approval-uuid-4');
});
