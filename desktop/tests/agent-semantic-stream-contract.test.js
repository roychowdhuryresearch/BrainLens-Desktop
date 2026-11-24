import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;

async function loadAgentService() {
  const source = readFileSync(join(root, 'electron/agentService.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const servicePromise = loadAgentService();

async function loadAgentStateRevision() {
  const source = readFileSync(join(root, 'src/app/agentStateRevision.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const stateRevisionPromise = loadAgentStateRevision();

async function loadConversationAppendHelper() {
  const source = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'appendAgentConversationMessage');
  assert.ok(declaration, 'conversation append must remain an executable top-level helper');
  const compiled = ts.transpileModule(declaration.getText(file), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const conversationAppendPromise = loadConversationAppendHelper();

function baseClaimState() {
  return {
    recording: {
      loaded: true,
      locator: '/private/Patients/Jane Doe/session-01.edf',
      metadata: {
        input_path: '/private/Patients/Jane Doe/session-01.edf',
        filename: 'Jane Doe session-01.edf',
        sample_freq: 2000,
        n_channels: 2,
        channel_names: ['LA1', 'LA2'],
        duration_seconds: 120,
      },
    },
    autonomy: 'review',
    activeRunId: 'run-a',
    acceptedRunId: 'run-a',
    visibleRunIds: ['run-b', 'run-a'],
    runs: [
      { runId: 'run-b', biomarker: 'HFO', detector: 'STE', events: 4, channels: 2, status: 'complete', accepted: false, parameters: { threshold: 3, band_hz: [80, 250], profile: 'strict' } },
      { runId: 'run-a', biomarker: 'HFO', detector: 'RMS', classifier: 'HF CPU', events: 8, channels: 2, status: 'complete', accepted: true, parameters: { threshold: 4, min_duration_ms: 6, output_path: '/secret/output.csv', api_token: 'do-not-bind' } },
    ],
    reviewEvents: [
      { event_id: 'event-2', run_id: 'run-a', channel: 'LA2', start_seconds: 2, end_seconds: 2.04, biomarker: 'HFO', annotation: null, features: { artifact_probability: 0.8 } },
      { event_id: 'event-1', run_id: 'run-a', channel: 'LA1', start_seconds: 1, end_seconds: 1.03, biomarker: 'HFO', annotation: { label: 'accepted', status: 'complete', notes: 'Patient Jane Doe confirmed event.', reviewer: 'Dr. Jane Doe', source: 'clinician', updated_at: '2026-07-15T10:00:00Z' }, features: { spike_probability: 0.7 } },
    ],
    reviewEventsByRun: {
      'run-b': [{ event_id: 'event-b', run_id: 'run-b', channel: 'LA2', annotation: null }],
      'run-a': [{ event_id: 'event-1', run_id: 'run-a', channel: 'LA1', annotation: { label: 'accepted', status: 'complete', notes: 'Patient Jane Doe confirmed event.' } }],
    },
    prepareControls: {
      fp: '80', fs: '70', rp: '1', rs: '40', lineNoiseNotchHz: '60', resampleSfreq: '1000', nJobs: 4,
      dropBadChannels: true, dropFlatChannels: true, markOutlierChannels: true, dropOutlierChannels: false,
    },
    classifierControls: {
      mode: 'HF CPU', device: 'cpu', batchSize: '32', ignoreBefore: '1', ignoreAfter: '1', useSpike: true, useEhfo: true,
      localArtifact: '/private/models/artifact.tar', localSpike: '', localEhfo: '',
      hubArtifact: 'lab/HFO-artifact', hubSpike: 'lab/HFO-spike', hubEhfo: 'lab/HFO-eHFO',
    },
    recordingAnalysis: {
      status: 'complete',
      updatedAt: '2026-07-15T10:00:00Z',
      error: 'transient status copy',
      roi: { policy: 'label-free', brain_signal_channels: ['LA1', 'LA2'], brain_signal_channel_count: 2 },
      qc: { flat_channels: [], outlier_channels: ['LA2'], roi_channel_count: 2 },
      spectral: { sample_freq: 2000, nyquist_hz: 1000, recommended_hfo_band: [80, 500] },
      candidate_ranking: { candidate_channel_count: 2, top_channels: [{ channel: 'LA1', total_events: 8 }] },
      confirmed_exclusions: ['LA2'],
    },
    severity: {
      status: 'complete',
      result: {
        eeg_type: 'scalp', recording_fingerprint: 'a'.repeat(64), model_name: 'BASED',
        model_version: 'based-severity-v1', model_sha256: 'b'.repeat(64), parameters_sha256: 'c'.repeat(64),
        num_segments: 8, num_clean_segments: 7, mean_score: 1.2, peak_score: 3.4, peak_time_sec: 45,
      },
    },
    operation: {
      id: 'operation-1', kind: 'detection', status: 'complete', completedSteps: 3, totalSteps: 3,
      label: 'Finished detector', progress: 100, startedAt: '2026-07-15T09:59:00Z', finishedAt: '2026-07-15T10:00:00Z',
    },
    statusMessage: 'transient toast',
    reviewMessage: 'transient review copy',
    activeDialog: 'Review',
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function envelope(event, data, sequence = 0, visibility = 'public') {
  return {
    contract_version: 'ieeg-agent.v1',
    request_id: 'req-desktop-test',
    conversation_id: 'conv-desktop-test',
    sequence,
    event,
    visibility,
    data,
  };
}

function completed(sequence, text = 'Complete.') {
  return envelope('done', {
    outcome: 'completed',
    message_id: 'msg-desktop-test',
    final_content: text,
    response_language: 'en-US',
    action_receipts: [],
    ui_commands: [],
  }, sequence);
}

function encodeSse(frames, crlf = false) {
  const newline = crlf ? '\r\n' : '\n';
  return frames.map(({ transportEvent, payload }) => (
    `event: ${transportEvent}${newline}data: ${JSON.stringify(payload)}${newline}${newline}`
  )).join('');
}

function bindCanonicalFramesToPostedScope(frames, init) {
  assert.equal(typeof init?.body, 'string', 'stream request must carry a JSON body');
  const request = JSON.parse(init.body);
  return frames.map((frame) => {
    const payload = frame.payload;
    if (!payload || typeof payload !== 'object' || payload.contract_version !== 'ieeg-agent.v1') return frame;
    return {
      ...frame,
      payload: {
        ...payload,
        request_id: request.request_id,
        conversation_id: request.conversation_id,
      },
    };
  });
}

function streamResponse(text, splitAt = []) {
  const encoded = new TextEncoder().encode(text);
  const cuts = [...splitAt.filter((value) => value > 0 && value < encoded.length), encoded.length];
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        let start = 0;
        for (const end of cuts) {
          controller.enqueue(encoded.slice(start, end));
          start = end;
        }
        controller.close();
      },
    }),
  };
}

async function withFetch(mock, action) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
  }
}

test('canonical semantic envelopes unwrap public events and suppress internal events', async () => {
  const { parseAgentSseFrame } = await servicePromise;
  const content = parseAgentSseFrame('content', envelope('content', {
    text: 'Hello', response_language: 'en-US', replace: false,
  }, 2));
  assert.deepEqual(content.publicEvent, {
    event: 'content', data: { text: 'Hello', response_language: 'en-US', replace: false },
  });
  assert.equal(content.requestId, 'req-desktop-test');
  assert.equal(content.conversationId, 'conv-desktop-test');

  const terminal = parseAgentSseFrame('done', completed(4));
  assert.equal(terminal.messageId, 'msg-desktop-test');

  const internal = parseAgentSseFrame('tool_result', envelope('tool_result', {
    kind: 'tool', name: 'emit_ui_command', payload: { secret: true },
  }, 3, 'internal'));
  assert.equal(internal.requestId, 'req-desktop-test');
  assert.equal(internal.conversationId, 'conv-desktop-test');
  assert.equal(internal.publicEvent, null, 'internal tool telemetry must not cross the Electron bridge');
  assert.equal(parseAgentSseFrame('tool_result', { result: { command: { type: 'analysis.run_qc' } } }).publicEvent, null,
    'legacy tool_result must not be promoted into a UI command');
});

test('canonical envelopes fail closed on version, visibility, and unsafe error fields', async () => {
  const { parseAgentSseFrame } = await servicePromise;
  assert.throws(() => parseAgentSseFrame('content', {
    ...envelope('content', { text: 'x', response_language: 'en-US' }),
    contract_version: 'ieeg-agent.v2',
  }), /contract mismatch/);
  assert.throws(() => parseAgentSseFrame('tool_result', envelope('tool_result', { kind: 'tool' }, 1, 'public')),
    /incorrectly marked public/);
  assert.throws(() => parseAgentSseFrame('error', envelope('error', {
    code: 'internal_error', message: 'Safe summary.', retryable: false, stack: 'private stack',
  }, 1)), /Unsafe field/);
});

test('stream handshake sends contract version and exposes only public semantic events', async () => {
  const { streamAgentChat } = await servicePromise;
  const frames = [
    { transportEvent: 'thinking', payload: envelope('thinking', { kind: 'reasoning', summary: 'private' }, 0, 'internal') },
    { transportEvent: 'image_urls', payload: envelope('image_urls', { image_urls: ['attachment://image-1'], attachment_urls: [] }, 1) },
    { transportEvent: 'content', payload: envelope('content', { text: 'Review ', response_language: 'en-US' }, 2) },
    { transportEvent: 'ui_command', payload: envelope('ui_command', {
      command_id: 'cmd-public', type: 'analysis.run_qc', payload: {}, reason: 'Run QC', requires_confirmation: false,
    }, 3) },
    { transportEvent: 'done', payload: completed(4, 'Review complete.') },
  ];
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    const wire = encodeSse(bindCanonicalFramesToPostedScope(frames, init), true);
    // Split in the middle of CRLF to prove transport chunking does not change frame parsing.
    return streamResponse(wire, [wire.indexOf('\r\n') + 1, Math.floor(wire.length / 2)]);
  }, async () => {
    const seen = [];
    await streamAgentChat('http://runtime', 'secret', { message: 'run qc' }, (event) => seen.push(event));
    assert.deepEqual(seen.map((event) => event.event), ['image_urls', 'content', 'ui_command', 'done']);
    assert.equal(seen.some((event) => event.event === 'thinking' || event.event === 'tool_result'), false);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['X-Contract-Version'], 'ieeg-agent.v1');
});

test('stream state machine rejects EOF without done, non-monotonic sequence, and post-terminal events', async () => {
  const { streamAgentChat } = await servicePromise;
  const run = async (frames) => withFetch(
    async (_url, init) => streamResponse(encodeSse(bindCanonicalFramesToPostedScope(frames, init))),
    () => streamAgentChat('http://runtime', 'secret', { message: 'test' }, () => undefined),
  );

  await assert.rejects(run([
    { transportEvent: 'content', payload: envelope('content', { text: 'partial', response_language: 'en-US' }, 0) },
  ]), /without terminal done/);

  await assert.rejects(run([
    { transportEvent: 'content', payload: envelope('content', { text: 'a', response_language: 'en-US' }, 2) },
    { transportEvent: 'content', payload: envelope('content', { text: 'b', response_language: 'en-US' }, 2) },
  ]), /monotonically/);

  await assert.rejects(run([
    { transportEvent: 'done', payload: completed(0) },
    { transportEvent: 'content', payload: envelope('content', { text: 'late', response_language: 'en-US' }, 1) },
  ]), /after terminal done/);

  await withFetch(async () => streamResponse('event: content\ndata: not-json\n\n'), async () => {
    await assert.rejects(
      () => streamAgentChat('http://runtime', 'secret', { message: 'test' }, () => undefined),
      /not valid JSON/,
    );
  });
});

test('canonical stream rejects frames outside the posted request and conversation scope', async () => {
  const { streamAgentChat } = await servicePromise;
  const run = async (field, value) => withFetch(async (_url, init) => {
    const [terminal] = bindCanonicalFramesToPostedScope([
      { transportEvent: 'done', payload: completed(0) },
    ], init);
    terminal.payload = { ...terminal.payload, [field]: value };
    return streamResponse(encodeSse([terminal]));
  }, () => streamAgentChat(
    'http://runtime',
    'secret',
    { message: 'test', conversation_id: 'conv-expected' },
    () => undefined,
  ));

  await assert.rejects(run('request_id', 'req-another-turn'), /request_id does not match the active request/);
  await assert.rejects(run('conversation_id', 'conv-another-chat'), /conversation_id does not match the active conversation/);
});

test('canonical done message_id must match the message bound earlier in the stream', async () => {
  const { streamAgentChat } = await servicePromise;
  const run = async (researchMessageId) => withFetch(async (_url, init) => {
    const frames = bindCanonicalFramesToPostedScope([
      { transportEvent: 'research_output', payload: envelope('research_output', { message_id: researchMessageId }, 0) },
      { transportEvent: 'done', payload: completed(1) },
    ], init);
    return streamResponse(encodeSse(frames));
  }, () => streamAgentChat('http://runtime', 'secret', { message: 'test' }, () => undefined));

  await run('msg-desktop-test');
  await assert.rejects(run('msg-another-response'), /message_id changed within the active response/);
});

test('canonical UI commands and research output cannot carry a conflicting nested turn scope', async () => {
  const { streamAgentChat } = await servicePromise;
  const run = async (buildFrames) => withFetch(async (_url, init) => {
    const request = JSON.parse(init.body);
    const frames = bindCanonicalFramesToPostedScope(buildFrames(request), init);
    return streamResponse(encodeSse(frames));
  }, () => streamAgentChat(
    'http://runtime',
    'secret',
    { message: 'test', conversation_id: 'conv-expected' },
    () => undefined,
  ));

  await assert.rejects(run((request) => [
    { transportEvent: 'ui_command', payload: envelope('ui_command', {
      request_id: 'req-another-turn',
      conversation_id: request.conversation_id,
      message_id: 'msg-desktop-test',
    }, 0) },
  ]), /ui_command request_id does not match its envelope/);

  await assert.rejects(run((request) => {
    const terminal = completed(0);
    terminal.data.ui_commands = [{
      request_id: request.request_id,
      conversation_id: 'conv-another-chat',
      message_id: 'msg-desktop-test',
    }];
    return [{ transportEvent: 'done', payload: terminal }];
  }), /done\.ui_commands\[0\] conversation_id does not match its envelope/);

  await assert.rejects(run((request) => {
    const terminal = completed(0);
    terminal.data.research_output = {
      request_id: request.request_id,
      conversation_id: request.conversation_id,
      message_id: 'msg-another-response',
    };
    return [{ transportEvent: 'done', payload: terminal }];
  }), /done\.research_output message_id does not match done\.message_id/);
});

test('historical receipts keep their message scope but cannot partly claim the active turn', async () => {
  const { streamAgentChat } = await servicePromise;
  const run = async (receiptForRequest) => withFetch(async (_url, init) => {
    const request = JSON.parse(init.body);
    const terminal = completed(0);
    terminal.data.action_receipts = [receiptForRequest(request)];
    return streamResponse(encodeSse(bindCanonicalFramesToPostedScope([
      { transportEvent: 'done', payload: terminal },
    ], init)));
  }, () => streamAgentChat(
    'http://runtime',
    'secret',
    { message: 'test', conversation_id: 'conv-expected' },
    () => undefined,
  ));

  await run(() => ({
    request_id: 'req-historical',
    conversation_id: 'conv-historical',
    message_id: 'msg-historical',
  }));
  await assert.rejects(run((request) => ({
    request_id: request.request_id,
    conversation_id: 'conv-historical',
    message_id: 'msg-historical',
  })), /done\.action_receipts\[0\] conversation_id conflicts with the active turn/);
});

test('typed error remains nonterminal until failed done while legacy errors are sanitized', async () => {
  const { parseAgentSseFrame, streamAgentChat } = await servicePromise;
  const typedError = { code: 'execution_failed', message: 'Analysis failed safely.', retryable: false };
  const frames = [
    { transportEvent: 'error', payload: envelope('error', typedError, 0) },
    { transportEvent: 'done', payload: envelope('done', {
      outcome: 'failed',
      message_id: 'msg-failed',
      response_language: 'en-US',
      action_receipts: [],
      ui_commands: [],
      error: typedError,
    }, 1) },
  ];
  await withFetch(async (_url, init) => streamResponse(
    encodeSse(bindCanonicalFramesToPostedScope(frames, init)),
  ), async () => {
    const seen = [];
    await streamAgentChat('http://runtime', 'secret', { message: 'test' }, (event) => seen.push(event.event));
    assert.deepEqual(seen, ['error', 'done']);
  });

  const legacy = parseAgentSseFrame('error', {
    message: 'Safe legacy summary.', code: 'timeout', retryable: true, stack: 'must not cross', detail: 'private',
  });
  assert.deepEqual(legacy.publicEvent.data, { message: 'Safe legacy summary.', code: 'timeout', retryable: true });
});

test('all agent HTTP calls carry the version handshake', async () => {
  const { submitAgentChat, getAgentChatResult } = await servicePromise;
  const calls = [];
  await withFetch(async (url, init = {}) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  }, async () => {
    await submitAgentChat('https://backend.example.invalid', 'token', { message: 'hello' });
    await getAgentChatResult('https://backend.example.invalid', 'token', 'job/1');
  });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.init.headers['X-Contract-Version'], 'ieeg-agent.v1');
  assert.match(calls[1].url, /job_id=job%2F1/);
});

test('renderer consumes public ui_command and treats done as the only semantic terminal', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  assert.match(app, /payload\.event === 'ui_command'[\s\S]{0,320}ingestAgentCommandObject\(data, seen, turnScope\.uiThreadId\)/);
  assert.doesNotMatch(app, /payload\.event === 'tool_result'/, 'renderer must not consume internal tool events');
  assert.match(app, /let pendingStreamError: Error \| null = null/);
  assert.match(app, /outcome !== 'completed' \|\| pendingStreamError/);
  assert.match(app, /data\.final_content/);
  assert.match(app, /ended without terminal done event/);
  assert.match(app, /typeof data\.code === 'string' && typeof data\.retryable === 'boolean'/);
  assert.match(app, /if \(!err && replyText\.trim\(\)/, 'partial failed content must not become a final reply');
});

test('an async agent turn carries one immutable UI thread scope through stream, poll, reply, and error paths', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  assert.doesNotMatch(app, /turnConversationRef|setAgentChatLog/,
    'async callbacks must not route transcript writes through mutable active-thread state');
  assert.match(app, /type AgentTurnScope = Readonly<\{\s*uiThreadId: string;\s*backendConversationId: string;/);
  assert.match(app, /const uiThreadId = activeAgentConversationId;[\s\S]{0,180}backendConversationId: agentConversationId\(uiThreadId\)/,
    'send must capture both the UI thread and its backend conversation id before enqueueing');
  assert.match(app, /enqueueAgentTurn\(\(\) => runAgentTurn\(outgoing, 'user', turnScope\)\)/);
  assert.match(app, /runStreamingAgentTurn\(sent, turnScope,/);
  assert.match(app, /pollAgentChatResult\(String\(submitted\.job_id\), turnScope\)/);
  assert.match(app, /conversation_id: turnScope\.backendConversationId/g);
  assert.match(app, /appendAgentReply\(turnScope\.uiThreadId, replyText\)/);
  assert.match(app, /appendToConversation\(turnScope\.uiThreadId, \{ role: 'observation'/);
  assert.match(app, /setAgentTurnStreamingText\(turnScope\.uiThreadId, replyText\)/);
  assert.match(app, /current === turnScope\.uiThreadId \? null : current/,
    'one turn may only retire its own busy marker');

  const streamBlock = app.slice(app.indexOf('function runStreamingAgentTurn'), app.indexOf('async function pollAgentChatResult'));
  const runBlock = app.slice(app.indexOf('async function runAgentTurn'), app.indexOf('async function sendAgentMessage'));
  for (const [label, block] of [['stream', streamBlock], ['poll/run', runBlock]]) {
    assert.doesNotMatch(block, /activeAgentConversationId|turnConversationRef/, `${label} callbacks must not read mutable active chat state`);
  }
});

test('late replies update only their captured thread and never recreate a closed thread', async () => {
  const { appendAgentConversationMessage } = await conversationAppendPromise;
  const chat1 = { id: 'chat-1', title: 'Chat 1', log: [{ role: 'user', text: 'one', ts: 1 }] };
  const chat2 = { id: 'chat-2', title: 'Chat 2', log: [{ role: 'user', text: 'two', ts: 2 }] };
  const reply = { role: 'agent', text: 'reply to one', ts: 3 };

  const updated = appendAgentConversationMessage([chat1, chat2], 'chat-1', reply);
  assert.deepEqual(updated[0].log, [chat1.log[0], reply]);
  assert.deepEqual(updated[1], chat2, 'another active thread must remain untouched');
  assert.equal(updated[1], chat2, 'unrelated thread identity should be preserved');

  const afterClose = [chat2];
  const ignored = appendAgentConversationMessage(afterClose, 'chat-1', { role: 'observation', text: 'late failure', ts: 4 });
  assert.equal(ignored, afterClose, 'a late callback for a closed thread must be a no-op');
  assert.deepEqual(ignored.map((thread) => thread.id), ['chat-2']);
});

test('broker acknowledgements bind scoped execution authority, session, conversation, and state revision', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  const authority = readFileSync(join(root, 'src/app/desktopApprovalAuthority.ts'), 'utf8');
  assert.match(app, /bindDesktopApprovalContext\(/,
    'broker receipts must use the executable desktop approval authority helper');
  assert.match(authority, /EXECUTION_STATUSES\.has\(status\)/,
    'queued review proposals must not bind a service actor before human Apply');
  assert.match(authority, /approval_actor: buildDesktopApprovalActor\(/,
    'execution transitions must bind the actor produced by the authority helper');
  assert.match(app, /humanApprovalNonce: capturedContext\.humanApprovalNonce \|\| globalThis\.crypto\.randomUUID\(\)/,
    'clinical review authority must carry a unique user-interaction nonce');
  assert.match(app, /conversationId: agentConversationId\(\)/,
    'the renderer must capture the conversation scope when the command is first recorded');
  assert.match(authority, /conversation_id: context\?\.conversationId \|\| fallbackConversationId/);
  assert.match(app, /const agentWorkspaceStateRevisionValue = useMemo\(\(\) => agentClaimStateRevision\(\{/,
    'the expensive canonical revision must be memoized across periodic broker reports');
  assert.match(app, /function agentWorkspaceStateRevision\(\)[\s\S]{0,120}return agentWorkspaceStateRevisionValue;/);
  assert.match(app, /scopeSalt: agentConversationSessionRef\.current/,
    'public state revisions must be session-salted so recording/path pseudonyms are not linkable across app sessions');
  for (const field of ['agentAutonomy', 'acceptedRunId', 'activeRunId', 'visibleRunIds', 'runRecords', 'reviewEvents', 'runEventsByRun', 'prepareControls', 'classifierControls', 'recordingAnalysis', 'severityState', 'runtimeOperation']) {
    assert.ok(app.slice(app.indexOf('const agentWorkspaceStateRevisionValue'), app.indexOf('function agentUiStatePayload')).includes(field), `canonical revision input must include ${field}`);
  }
  assert.match(app, /const stateRevision = agentWorkspaceStateRevision\(\)[\s\S]{0,500}state_revision: stateRevision/,
    'UI state must expose the canonical revision');
  assert.match(app, /stateRevision: command\.state_revision \|\| String\(commandContract\.state_revision \|\| ''\) \|\| agentWorkspaceStateRevision\(\)/,
    'broker ACK context must preserve the broker-issued revision, with the current canonical revision only as a fallback');
  assert.match(app, /const stateRevision = String\(uiState\.state_revision \|\| agentWorkspaceStateRevision\(\)\)/,
    'agent request must reuse the revision reported in the canonical UI state snapshot');
  assert.match(app, /commandAckContextRef\.current\.get\(commandId\)/,
    'acks must use the renderer-owned state snapshot captured when the command was first recorded');
  assert.match(app, /brokerAckRef\.current\(dispatch\.commandId \|\| id, dispatch\.outcome/,
    'the broker timer must call a fresh ref instead of its initial-render acknowledgement closure');
});

test('direct-open recording workspaces use stable opaque broker session ids', async () => {
  const { opaqueWorkspaceSessionId } = await stateRevisionPromise;
  const path = '/private/Patients/Jane Doe/session 01.edf';
  const first = opaqueWorkspaceSessionId('app-session-a', null, null, path);
  const repeated = opaqueWorkspaceSessionId('app-session-a', null, null, path);
  const otherRecording = opaqueWorkspaceSessionId('app-session-a', null, null, '/private/Patients/Jane Doe/session 02.edf');

  assert.equal(first, repeated);
  assert.match(first, /^workspace-[a-f0-9]{32}$/);
  assert.notEqual(first, otherRecording);
  assert.doesNotMatch(first, /Patients|Jane|session 01|\//);
});

test('canonical revision changes for every claim-affecting state family', async () => {
  const { agentClaimStateRevision, sha256Hex } = await stateRevisionPromise;
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'state revisions must use the standard SHA-256 digest rather than a short non-cryptographic hash',
  );
  const baselineState = baseClaimState();
  const baseline = agentClaimStateRevision(baselineState);
  assert.match(baseline, /^desktop-state-[0-9a-f]{64}$/);

  const mutations = [
    ['loaded recording locator', (state) => { state.recording.locator = '/private/Patients/Jane Doe/session-02.edf'; }],
    ['autonomy policy', (state) => { state.autonomy = 'full'; }],
    ['recording sample frequency', (state) => { state.recording.metadata.sample_freq = 2048; }],
    ['recording channel layout', (state) => { state.recording.metadata.channel_names[1] = 'LB2'; }],
    ['active run', (state) => { state.activeRunId = 'run-b'; }],
    ['accepted run', (state) => { state.acceptedRunId = 'run-b'; }],
    ['visible runs', (state) => { state.visibleRunIds = ['run-a']; }],
    ['run event result', (state) => { state.runs[0].events = 5; }],
    ['run status', (state) => { state.runs[0].status = 'failed'; }],
    ['detector parameter', (state) => { state.runs[0].parameters.threshold = 5; }],
    ['detector string parameter', (state) => { state.runs[0].parameters.profile = 'sensitive'; }],
    ['classifier result', (state) => { state.runs[1].classifier = 'HF GPU'; }],
    ['review label', (state) => { state.reviewEvents[1].annotation.label = 'artifact'; }],
    ['review status', (state) => { state.reviewEvents[1].annotation.status = 'rejected'; }],
    ['review annotation notes', (state) => { state.reviewEvents[1].annotation.notes = 'Clinician amended the review.'; }],
    ['per-event classifier result', (state) => { state.reviewEvents[1].features.spike_probability = 0.9; }],
    ['per-run review state', (state) => { state.reviewEventsByRun['run-a'][0].annotation.label = 'artifact'; }],
    ['analysis ROI result', (state) => { state.recordingAnalysis.roi.brain_signal_channel_count = 1; }],
    ['analysis QC result', (state) => { state.recordingAnalysis.qc.flat_channels = ['LA1']; }],
    ['analysis spectral result', (state) => { state.recordingAnalysis.spectral.recommended_hfo_band = [100, 500]; }],
    ['candidate ranking result', (state) => { state.recordingAnalysis.candidate_ranking.top_channels[0].total_events = 9; }],
    ['confirmed exclusion', (state) => { state.recordingAnalysis.confirmed_exclusions = ['LA1']; }],
    ['severity score', (state) => { state.severity.result.peak_score = 4.1; }],
    ['severity model', (state) => { state.severity.result.model_sha256 = 'd'.repeat(64); }],
    ['operation terminal status', (state) => { state.operation.status = 'failed'; }],
    ['operation result step', (state) => { state.operation.completedSteps = 2; }],
    ['session-private revision salt', (state) => { state.scopeSalt = 'different-session-salt'; }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = clone(baselineState);
    mutate(changed);
    assert.notEqual(agentClaimStateRevision(changed), baseline, `${label} must invalidate state_revision`);
  }

  for (const [field, nextValue] of Object.entries({
    fp: '90', fs: '75', rp: '2', rs: '50', lineNoiseNotchHz: '50', resampleSfreq: '500', nJobs: 2,
    dropBadChannels: false, dropFlatChannels: false, markOutlierChannels: false, dropOutlierChannels: true,
  })) {
    const changed = clone(baselineState);
    changed.prepareControls[field] = nextValue;
    assert.notEqual(agentClaimStateRevision(changed), baseline, `prepare.${field} must invalidate state_revision`);
  }

  for (const [field, nextValue] of Object.entries({
    mode: 'Custom', device: 'cuda:0', batchSize: '64', ignoreBefore: '2', ignoreAfter: '2', useSpike: false, useEhfo: false,
    localArtifact: '/private/models/new-artifact.tar', localSpike: '/private/models/spike.tar', localEhfo: '/private/models/ehfo.tar',
    hubArtifact: 'lab/new-artifact', hubSpike: 'lab/new-spike', hubEhfo: 'lab/new-ehfo',
  })) {
    const changed = clone(baselineState);
    changed.classifierControls[field] = nextValue;
    assert.notEqual(agentClaimStateRevision(changed), baseline, `classifier.${field} must invalidate state_revision`);
  }
});

test('canonical revision ignores transient UI state and never retains raw paths, PHI, or secrets', async () => {
  const { agentClaimStateRevision, canonicalAgentClaimState } = await stateRevisionPromise;
  const baselineState = baseClaimState();
  const baseline = agentClaimStateRevision(baselineState);

  const transient = clone(baselineState);
  transient.statusMessage = 'another toast';
  transient.reviewMessage = 'another transient message';
  transient.activeDialog = 'Export';
  transient.viewport = { start_seconds: 40, duration_seconds: 5 };
  transient.selectedEvent = 'event-2';
  transient.recording.metadata.filename = 'Different Patient Name.edf';
  transient.recording.metadata.input_path = '/another/raw/metadata/path.edf';
  transient.recordingAnalysis.updatedAt = '2026-07-15T12:00:00Z';
  transient.recordingAnalysis.error = 'temporary UI error with /private/path';
  transient.reviewEvents[1].annotation.updated_at = '2026-07-15T12:00:00Z';
  transient.operation.label = 'different progress copy';
  transient.operation.progress = 17;
  transient.operation.startedAt = '2026-07-15T11:59:00Z';
  transient.operation.finishedAt = '2026-07-15T12:00:00Z';
  assert.equal(agentClaimStateRevision(transient), baseline, 'transient presentation state must not invalidate claim scope');

  const reordered = clone(baselineState);
  reordered.visibleRunIds.reverse();
  reordered.runs.reverse();
  reordered.reviewEvents.reverse();
  reordered.reviewEventsByRun = { 'run-a': reordered.reviewEventsByRun['run-a'], 'run-b': reordered.reviewEventsByRun['run-b'] };
  assert.equal(agentClaimStateRevision(reordered), baseline, 'unordered clinical collections must canonicalize deterministically');

  const secretOnlyChange = clone(baselineState);
  secretOnlyChange.runs[1].parameters.api_token = 'a-different-secret';
  secretOnlyChange.runs[1].parameters.output_path = '/a/different/output.csv';
  secretOnlyChange.runs[1].parameters.apiToken = 'camel-case-secret';
  secretOnlyChange.runs[1].parameters.patientMrn = 'MRN-123';
  secretOnlyChange.runs[1].parameters.outputPath = '/camel/case/output.csv';
  assert.equal(agentClaimStateRevision(secretOnlyChange), baseline, 'secrets and artifact paths are outside claim scope');

  const canonical = JSON.stringify(canonicalAgentClaimState(baselineState));
  for (const forbidden of [
    '/private/Patients/Jane Doe/session-01.edf', 'Jane Doe session-01.edf', 'Patient Jane Doe confirmed event.',
    'Dr. Jane Doe', '/secret/output.csv', 'do-not-bind', '/private/models/artifact.tar', 'LA1', 'LA2',
  ]) {
    assert.equal(canonical.includes(forbidden), false, `canonical state must not retain sensitive value: ${forbidden}`);
  }
});
