import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadCommandModule() {
  const source = readFileSync(join(root, 'src/features/agent/uiCommands.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modulePromise = loadCommandModule();

function state(patch = {}) {
  return {
    session_id: 'session-1',
    recordingPath: '/data/case.edf',
    activePanel: 'workspace',
    channels: ['A1', 'A2', 'B1'],
    selectedChannel: 'A1',
    selectedEvent: 'evt-1',
    selectedRun: 'run-1',
    viewport: { start_seconds: 0, duration_seconds: 10 },
    events: ['evt-1', 'evt-2'],
    runs: ['run-1', 'run-2'],
    ...patch
  };
}

function command(type, payload = {}, patch = {}) {
  return {
    command_id: `${type}-test`,
    type,
    reason: `test ${type}`,
    payload,
    ...patch
  };
}

test('agent command catalog covers UI replacement workflow commands with explicit risk policy', async () => {
  const mod = await modulePromise;
  for (const type of [
    'workspace.open_panel',
    'workspace.reset_waveform_view',
    'recording.open',
    'recording.inspect_metadata',
    'recording.infer_roi',
    'recording.set_channel_visibility',
    'analysis.run_qc',
    'analysis.compute_spectral_profile',
    'analysis.prepare_recording',
    'detection.plan',
    'detection.run',
    'detection.rank_candidates',
    'detection.focus_top_candidate_channel',
    'waveform.set_display',
    'waveform.focus_hotspot_channels',
    'classification.run',
    'review.open_event',
    'review.accept_run',
    'export.session',
    'export.workbook',
    'export.report',
    'batch.create',
    'batch.run'
  ]) {
    assert.ok(mod.ALLOWED_UI_COMMANDS.has(type), type);
    assert.ok(mod.uiCommandPolicy(type), type);
  }
  assert.equal(mod.uiCommandPolicy('detection.run').risk, 'compute');
  assert.equal(mod.uiCommandPolicy('analysis.run_qc').confirmation, 'auto');
  assert.equal(mod.uiCommandPolicy('export.report').confirmation, 'confirm');
});

test('normalization enforces default confirmations for review/export/destructive commands', async () => {
  const mod = await modulePromise;
  const annotation = mod.normalizeAgentCommand({ type: 'events.stage_annotation', payload: { event_id: 'evt-1', label: 'accepted' }, requires_confirmation: false }, 0);
  const exportReport = mod.normalizeAgentCommand({ type: 'export.report', payload: { run_id: 'run-1' }, requires_confirmation: false }, 1);
  const openRecording = mod.normalizeAgentCommand({ type: 'recording.open', payload: { input_path: '/data/new.edf' }, requires_confirmation: false }, 2);
  const detection = mod.normalizeAgentCommand({ type: 'detection.run', payload: { biomarker: 'HFO', detector: 'STE' } }, 3);

  assert.equal(annotation.requires_confirmation, true);
  assert.equal(exportReport.requires_confirmation, true);
  assert.equal(openRecording.requires_confirmation, true);
  assert.equal(detection.requires_confirmation, true); // compute write: must stage (clinical safety)
});

test('normalization preserves canonical resource scope and top-level compatibility fields', async () => {
  const mod = await modulePromise;
  const canonical = mod.normalizeAgentCommand({
    contract_version: 'ieeg-agent.v1',
    command_id: 'mcp-scoped',
    type: 'severity.run',
    payload: {},
    actor: { session_id: 'session-1' },
    request_id: 'req-1',
    message_id: 'msg-1',
    conversation_id: 'conv-1',
    resource_scope: { state_revision: 'rev-1', recording_sha256: 'a'.repeat(64) }
  }, 0);

  assert.equal(canonical.contract_version, 'ieeg-agent.v1');
  assert.equal(canonical.session_id, 'session-1');
  assert.equal(canonical.state_revision, 'rev-1');
  assert.equal(canonical.resource_scope.recording_sha256, 'a'.repeat(64));

  const legacy = mod.normalizeAgentCommand({
    command_id: 'mcp-legacy', type: 'workspace.open_panel', payload: {},
    session_id: 'session-legacy', state_revision: 'rev-legacy'
  }, 1);
  assert.equal(legacy.session_id, 'session-legacy');
  assert.equal(legacy.state_revision, 'rev-legacy');

  assert.equal(mod.normalizeAgentCommand({
    command_id: 'mcp-conflict', type: 'severity.run', payload: {},
    state_revision: 'rev-top', resource_scope: { state_revision: 'rev-nested' }
  }, 2), null);
});

test('read/analysis workflow commands auto-apply; compute writes stage for confirmation', async () => {
  const mod = await modulePromise;
  const detection = mod.applyUICommand(command('detection.run', { biomarker: 'HFO', detector: 'STE' }), state());
  const qc = mod.applyUICommand(command('analysis.run_qc'), state());
  const ranking = mod.applyUICommand(command('detection.rank_candidates'), state());

  assert.equal(detection.status, 'staged'); // compute write must stage (clinical safety), not auto-apply
  assert.equal(detection.diffState, 'added');
  assert.equal(qc.status, 'applied');
  assert.equal(ranking.status, 'applied');
});

test('confirmation-gated commands stage first and apply only after explicit confirmation', async () => {
  const mod = await modulePromise;
  const staged = mod.applyUICommand(command('review.accept_run', { run_id: 'run-1' }), state());
  assert.equal(staged.status, 'staged');
  assert.equal(staged.diffState, 'added');

  const applied = mod.applyUICommand({ ...staged.command, requires_confirmation: false }, state(), 'agent', { confirmed: true });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.after.selectedRun, 'run-1');
});

test('agent autonomy pre-confirm policy is explicit by source and risk level', async () => {
  const mod = await modulePromise;

  assert.equal(mod.shouldPreconfirmUICommand('detection.run', 'agent', 'review'), false);
  assert.equal(mod.shouldPreconfirmUICommand('export.report', 'agent', 'review'), false);
  assert.equal(mod.shouldPreconfirmUICommand('review.accept_run', 'agent', 'review'), false);

  assert.equal(mod.shouldPreconfirmUICommand('detection.run', 'agent', 'auto-run'), false);
  assert.equal(mod.shouldPreconfirmUICommand('export.report', 'agent', 'auto-run'), false);
  assert.equal(mod.shouldPreconfirmUICommand('review.accept_run', 'agent', 'auto-run'), false);
  assert.equal(mod.shouldPreconfirmUICommand('recording.open', 'agent', 'auto-run'), false);

  assert.equal(mod.shouldPreconfirmUICommand('review.accept_run', 'agent', 'full'), false);
  assert.equal(mod.shouldPreconfirmUICommand('events.stage_annotation', 'agent', 'full'), false);
  assert.equal(mod.shouldPreconfirmUICommand('recording.open', 'agent', 'full'), false);
  assert.equal(mod.shouldPreconfirmUICommand('detection.run', 'user', 'full'), false);
  assert.equal(mod.shouldPreconfirmUICommand('detection.run', 'system', 'full'), false);
});

test('no autonomy preference can manufacture clinician authority for a write', async () => {
  const mod = await modulePromise;
  const writes = ['analysis.prepare_recording', 'detection.run', 'classification.run', 'export.report', 'events.stage_annotation', 'review.accept_run', 'recording.open', 'project.open'];
  for (const level of ['review', 'auto-run', 'full']) {
    for (const type of writes) {
      assert.equal(mod.shouldPreconfirmUICommand(type, 'agent', level), false, `${level} must stage ${type}`);
    }
  }
});

test('agent autonomy pre-confirm result matches command staging behavior', async () => {
  const mod = await modulePromise;
  const detection = command('detection.run', { biomarker: 'HFO', detector: 'STE' });
  const acceptRun = command('review.accept_run', { run_id: 'run-1' });

  assert.equal(
    mod.applyUICommand(detection, state(), 'agent', { confirmed: mod.shouldPreconfirmUICommand(detection.type, 'agent', 'review') }).status,
    'staged'
  );
  assert.equal(
    mod.applyUICommand(detection, state(), 'agent', { confirmed: mod.shouldPreconfirmUICommand(detection.type, 'agent', 'auto-run') }).status,
    'staged'
  );
  assert.equal(
    mod.applyUICommand(acceptRun, state(), 'agent', { confirmed: mod.shouldPreconfirmUICommand(acceptRun.type, 'agent', 'auto-run') }).status,
    'staged'
  );
  assert.equal(
    mod.applyUICommand(acceptRun, state(), 'agent', { confirmed: mod.shouldPreconfirmUICommand(acceptRun.type, 'agent', 'full') }).status,
    'staged'
  );
});

test('validation rejects stale sessions, missing references, and missing workflow inputs', async () => {
  const mod = await modulePromise;
  assert.equal(mod.applyUICommand(command('waveform.focus_channel', { channel: 'MISSING' }), state()).status, 'rejected');
  assert.equal(mod.applyUICommand(command('waveform.center_event', { event_id: 'missing' }), state()).status, 'rejected');
  assert.equal(mod.applyUICommand(command('detection.select_run', { run_id: 'missing' }), state()).status, 'rejected');
  assert.equal(mod.applyUICommand(command('detection.run', { biomarker: 'HFO' }), state()).status, 'rejected');
  assert.equal(mod.applyUICommand(command('batch.create'), state()).status, 'rejected');
  assert.equal(mod.applyUICommand(command('analysis.run_qc'), state({ recordingPath: null })).status, 'rejected');
  assert.equal(mod.applyUICommand(command('workspace.show_toast', {}, { session_id: 'other-session' }), state()).status, 'rejected');
});

test('view commands mutate only local workspace selection and viewport state', async () => {
  const mod = await modulePromise;
  const focused = mod.applyUICommand(command('waveform.focus_channel', { channel: 'B1', start_seconds: 20, duration_seconds: 5 }), state());
  assert.equal(focused.status, 'applied');
  assert.equal(focused.after.selectedChannel, 'B1');
  assert.deepEqual(focused.after.viewport, { start_seconds: 20, duration_seconds: 5 });

  const event = mod.applyUICommand(command('review.focus_event', { event_id: 'evt-2' }), state());
  assert.equal(event.status, 'applied');
  assert.equal(event.after.selectedEvent, 'evt-2');

  const reset = mod.applyUICommand(command('workspace.reset_waveform_view'), state({ viewport: { start_seconds: 12, duration_seconds: 10 } }));
  assert.equal(reset.status, 'applied');
  assert.deepEqual(reset.after.viewport, { start_seconds: 0, duration_seconds: 10 });

  const display = mod.applyUICommand(command('waveform.set_display', { start_seconds: 5, time_window_seconds: 2 }), state());
  assert.equal(display.status, 'applied');
  assert.deepEqual(display.after.viewport, { start_seconds: 5, duration_seconds: 2 });

  const review = mod.applyUICommand(command('review.open_event', { event_id: 'evt-2' }), state());
  assert.equal(review.status, 'applied');
  assert.equal(review.after.selectedEvent, 'evt-2');
});

test('replay applies confirmed history and ignores staged or rejected entries', async () => {
  const mod = await modulePromise;
  const initial = state({ selectedChannel: 'A1', selectedRun: 'run-1' });
  const applied = mod.applyUICommand(command('recording.select_channel', { channel: 'A2' }), initial);
  const staged = mod.applyUICommand(command('export.report', { run_id: 'run-1' }), applied.after);
  const rejected = mod.applyUICommand(command('recording.select_channel', { channel: 'missing' }), applied.after);

  const replayed = mod.replayCommands(initial, [applied, staged, rejected]);
  assert.equal(replayed.selectedChannel, 'A2');
  assert.equal(replayed.selectedRun, 'run-1');
});

test('unsafe unknown commands are captured as rejected instead of executed', async () => {
  const mod = await modulePromise;
  const normalized = mod.normalizeAgentCommand({ type: 'filesystem.delete', payload: { path: '/tmp/case' } }, 0);
  const entry = mod.applyUICommand(normalized, state());
  assert.equal(entry.status, 'rejected');
  assert.equal(entry.diffState, 'blocked');
  assert.equal(entry.after, entry.before);
});
