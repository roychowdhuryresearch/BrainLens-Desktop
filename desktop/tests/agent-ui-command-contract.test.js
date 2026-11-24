// TEST-FIRST contract suite for the agent↔UI co-pilot (Phase 0).
// Plan: .omx/plans/agent-ui-copilot-IMPLEMENTATION.md  (red-first suite).
// These are written BEFORE implementation and are expected to be RED against
// current code:
//   - SAFETY INVARIANT  -> GREEN by T-UI-2 (reclassify the 5 compute/batch writes to 'confirm')
//   - CATALOG PARITY     -> GREEN by T-UI-2 (TS policy table matches the authoritative JSON)
// The authoritative catalog is contracts/ui-command-catalog.json.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url)); // -> desktop/
const WRITE_RISKS = new Set(['compute', 'artifact_write', 'review_write', 'destructive']);

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

function loadCatalog() {
  // desktop/ -> ../contracts/ui-command-catalog.json
  return JSON.parse(readFileSync(join(root, '..', 'contracts', 'ui-command-catalog.json'), 'utf8'));
}

const modulePromise = loadCommandModule();

// ── SAFETY INVARIANT (T-UI-6) ────────────────────────────────────────────────
// No clinical/review WRITE may auto-apply. Every command whose risk is a write
// class must require confirmation (so the renderer stages it for human Apply).
test('SAFETY INVARIANT: no write-risk command auto-applies (all stage)', async () => {
  const mod = await modulePromise;
  const offenders = [];
  for (const [type, policy] of Object.entries(mod.UI_COMMAND_POLICIES)) {
    if (WRITE_RISKS.has(policy.risk) && policy.confirmation !== 'confirm') {
      offenders.push(`${type} (risk=${policy.risk}, confirmation=${policy.confirmation})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `write-risk commands must be confirmation:'confirm'. Offenders: ${offenders.join(', ')}`
  );
});

// Behavioral form: a VALID write command must STAGE (not apply) without explicit
// confirmation. detection.run has its preconditions satisfied here, so the ONLY
// thing that should hold it back is the confirmation gate.
test('SAFETY INVARIANT (behavioral): a valid write command stages, not applies', async () => {
  const mod = await modulePromise;
  const state = {
    session_id: 'session-1', recordingPath: '/data/case.edf', activePanel: 'workspace',
    channels: ['A1', 'A2'], selectedChannel: 'A1', selectedEvent: 'evt-1', selectedRun: 'run-1',
    viewport: { start_seconds: 0, duration_seconds: 10 }, events: ['evt-1'], runs: ['run-1']
  };
  const entry = mod.applyUICommand(
    { command_id: 'c1', type: 'detection.run', reason: 't', payload: { biomarker: 'HFO', detector: 'STE' } },
    state, 'agent', { confirmed: false }
  );
  assert.equal(entry.status, 'staged', "detection.run (compute) must stage, not auto-apply, for clinical safety");
});

// ── CATALOG PARITY (T-UI-1) ──────────────────────────────────────────────────
// The renderer policy table must match the authoritative JSON catalog exactly
// on the type set and on each entry's risk + confirmation. (No runtime json.load
// in production; this test is the drift guard.)
test('CATALOG PARITY: UI_COMMAND_POLICIES matches ui-command-catalog.json', async () => {
  const mod = await modulePromise;
  const catalog = loadCatalog();
  const jsonTypes = new Set(catalog.commands.map((c) => c.type));
  const tsTypes = new Set(Object.keys(mod.UI_COMMAND_POLICIES));

  assert.equal(tsTypes.size, jsonTypes.size, `command count differs (TS=${tsTypes.size}, JSON=${jsonTypes.size})`);
  for (const t of jsonTypes) assert.ok(tsTypes.has(t), `TS policy missing catalog type: ${t}`);
  for (const t of tsTypes) assert.ok(jsonTypes.has(t), `catalog missing TS-only type: ${t}`);

  const mismatches = [];
  for (const entry of catalog.commands) {
    const policy = mod.UI_COMMAND_POLICIES[entry.type];
    if (!policy) continue;
    const wantConfirmation = entry.requires_confirmation === true ? 'confirm' : 'auto';
    if (policy.risk !== entry.risk) mismatches.push(`${entry.type}: risk TS=${policy.risk} JSON=${entry.risk}`);
    if (policy.confirmation !== wantConfirmation) {
      mismatches.push(`${entry.type}: confirmation TS=${policy.confirmation} JSON→${wantConfirmation}`);
    }
  }
  assert.deepEqual(mismatches, [], `policy/catalog mismatches: ${mismatches.join(' | ')}`);
});

// ── HANDLER COVERAGE ─────────────────────────────────────────────────────────
// A catalog type with a policy but NO executeAppliedUICommand branch silently no-ops
// into the App.tsx fall-through and the agent reports success of a command that did
// nothing. The old parity test only checked catalog<->policy; this asserts every
// catalog type actually reaches a real renderer handler. Handlers use two patterns:
//   if (command.type === 'X') { ... }
//   if (['a','b',...].includes(command.type)) { ... }
test('HANDLER COVERAGE: every catalog type has an executeAppliedUICommand branch', () => {
  const catalog = loadCatalog();
  const catalogTypes = new Set(catalog.commands.map((c) => c.type));
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  const start = app.indexOf('function executeAppliedUICommand');
  assert.ok(start >= 0, 'executeAppliedUICommand not found in App.tsx');
  // Body = from the function start to the next top-level "  function " declaration.
  const rest = app.slice(start + 'function executeAppliedUICommand'.length);
  const nextFn = rest.search(/\n {2}(?:async )?function \w+/);
  const body = rest.slice(0, nextFn >= 0 ? nextFn : undefined);
  const handled = new Set();
  for (const m of body.matchAll(/command\.type === '([^']+)'/g)) handled.add(m[1]);
  for (const arr of body.matchAll(/\[([^\]]*)\]\.includes\(command\.type\)/g)) {
    for (const t of arr[1].matchAll(/'([^']+)'/g)) handled.add(t[1]);
  }
  const missing = [...catalogTypes].filter((t) => !handled.has(t)).sort();
  assert.deepEqual(missing, [], `catalog types with NO executeAppliedUICommand handler (silent no-op): ${missing.join(', ')}`);
});

// Rejected auto-apply commands must NOT silently vanish: the renderer surfaces them and
// acks the real outcome (closing the open-loop where the agent narrates success of a no-op).
test('FEEDBACK: rejected auto-apply commands are surfaced and ack the real outcome', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  // applyRecordedEntry handles the rejected branch with a visible status message...
  assert.match(app, /function applyRecordedEntry/, 'applyRecordedEntry helper missing');
  assert.match(app, /status === 'rejected'[\s\S]{0,200}setStatusMessage/, 'rejected branch must surface a status message');
  // ...and the broker ack carries the real outcome, not a hardcoded {received:true}.
  assert.doesNotMatch(app, /uiBrokerAck\(\{[^}]*outcome:\s*\{\s*received:\s*true/, 'broker ack must not be hardcoded {received:true}');
  assert.match(app, /brokerAckRef\.current\(dispatch\.commandId \|\| id, dispatch\.outcome/,
    'broker ack must relay the real outcome through the fresh acknowledgement ref');
});

// HANDLER-LAYER FEEDBACK: validation-pass-but-no-op must also reach the agent. A command can pass
// validateUICommand yet change nothing in the handler (non-numeric viewport, missing scale, an
// unhandled type). executeAppliedUICommand records that via commandOutcomeRef and applyRecordedEntry
// relays it so the agent stops narrating success of a no-op.
test('HANDLER-LAYER FEEDBACK: no-op handler outcomes are captured and relayed', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  // executeAppliedUICommand resets the outcome to 'applied' at the top of each run...
  assert.match(app, /commandOutcomeRef\.current = \{ status: 'applied', reason: null \}/, 'executeAppliedUICommand must reset commandOutcomeRef to applied');
  // ...sync no-op guards downgrade it to 'noop' with a reason (broadened in the honesty pass: empty/
  // mis-keyed payloads, unknown targets, idempotent re-applies, fallback-to-current param writes)...
  assert.ok((app.match(/commandOutcomeRef\.current = \{ status: 'noop'/g) || []).length >= 10,
    'expected >=10 noop guards across the handler surface (empty payload, mis-keyed fields, unknown target, idempotent re-apply)');
  // ...including the central waveform sink that catches every "controls unchanged" command...
  assert.match(app, /function applyWaveformControlsFromAgent[\s\S]*?'waveform is already in the requested state/,
    'applyWaveformControlsFromAgent must downgrade an unchanged-controls write to noop');
  // ...and the param setters that fall back to current values on an unrecognized payload.
  assert.match(app, /JSON\.stringify\(nextPrepare\) === JSON\.stringify\(prepareControls\)/,
    'detection.set_parameters must compare next-vs-current Prepare controls to detect a no-op');
  assert.match(app, /no recognized detection parameter in the payload/,
    'detection.set_parameters must noop with guidance when no recognized parameter changed');
  // ...the unhandled-type fall-through is one of them (no silent success for an unknown command)...
  assert.match(app, /commandOutcomeRef\.current = \{ status: 'noop', reason: 'no renderer handler/, 'fall-through must mark a noop');
  // ...and applyRecordedEntry reads commandOutcomeRef after executing and surfaces a non-applied outcome.
  assert.match(app, /const outcome = commandOutcomeRef\.current;[\s\S]{0,200}outcome\.status !== 'applied'[\s\S]{0,160}setStatusMessage/,
    'applyRecordedEntry must surface a non-applied handler outcome');
});

// The MCP server must fold rejected/noop/error apply outcomes into success:false so the external
// agent treats a no-op as a failure to retry, not a done deal.
test('HANDLER-LAYER FEEDBACK: mcp_server treats noop/error like rejected (success:false)', () => {
  const mcp = readFileSync(join(root, '..', 'ui_mcp', 'mcp_server.py'), 'utf8');
  assert.match(mcp, /FAILURE_ACK_STATUSES\s*=\s*frozenset\(\{(?=[^}]*["']rejected["'])(?=[^}]*["']noop["'])(?=[^}]*["']failed["'])[^}]*\}\)/,
    'the canonical failure status set must include rejected/noop/failed');
  assert.match(mcp, /status in FAILURE_ACK_STATUSES/,
    'tool_emit_ui_command must use the canonical failure status set');
});

// ── OBSERVABILITY ────────────────────────────────────────────────────────────
// The agent can only "fully control" the UI if it can READ BACK the panels/results it sets.
// get_ui_state's payload (agentUiStatePayload) must expose the Prepare/Classify panels, analysis
// results, per-run detail, the running operation, and the open dialog — not just viewport/selection.
test('OBSERVABILITY: agentUiStatePayload exposes the panels/results the agent sets', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  const start = app.indexOf('function agentUiStatePayload');
  assert.ok(start >= 0, 'agentUiStatePayload not found');
  const body = app.slice(start, start + 4000);
  for (const key of ['prepare:', 'classify:', 'analysis:', 'runs_detail:', 'operation:', 'messages:', 'active_dialog:', 'project:']) {
    assert.ok(body.includes(key), `agentUiStatePayload must expose ${key} for agent observability`);
  }
  // active_dialog must be wired from the real renderer surface, not hardcoded.
  assert.match(app, /uiSurfaceRef\.current\.dialog/, 'active_dialog must read the real open-dialog surface');
  assert.match(readFileSync(join(root, 'src/app/MainWindowShell.tsx'), 'utf8'), /onUiSurfaceChange\?\.\(\{\s*dialog: activeDialog/,
    'MainWindowShell must report its open dialog/tab up to App');
});
