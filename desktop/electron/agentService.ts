export const AGENT_CONTRACT_VERSION = 'ieeg-agent.v1' as const;

const CONTRACT_VERSION_HEADER = 'X-Contract-Version';
const PUBLIC_AGENT_EVENTS = new Set([
  'status',
  'public_progress',
  'image_urls',
  'content',
  'ui_command',
  'action_receipt',
  'research_output',
  'user_input_required',
  'tool_approval_result',
  'error',
  'done'
]);
const INTERNAL_AGENT_EVENTS = new Set([
  'thinking',
  'verification',
  'skill_routing',
  'plan_created',
  'plan_updated',
  'plan_completed',
  'agent_control',
  'step_handoff',
  'step_completed',
  'step_status',
  'tool_call',
  'tool_result'
]);
const ENVELOPE_KEYS = new Set([
  'contract_version',
  'request_id',
  'conversation_id',
  'sequence',
  'event',
  'visibility',
  'data',
  'emitted_at'
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RESPONSE_LANGUAGES = new Set(['en-US', 'zh-CN']);
const PUBLIC_ERROR_CODES = new Set([
  'invalid_request',
  'contract_version_mismatch',
  'scope_missing',
  'scope_conflict',
  'permission_denied',
  'approval_required',
  'cancelled',
  'timeout',
  'execution_failed',
  'terminal_event_missing',
  'internal_error'
]);

export type AgentChatRequest = {
  message: string;
  conversation_id?: string;
  recording_path?: string;
  state_revision?: string;
  model?: string;
  provider?: string;
  api_base?: string;
  session_url?: string;
  session_token?: string;
};

function agentHeaders(token: string, withJson = false): Record<string, string> {
  return {
    ...(withJson ? { 'content-type': 'application/json' } : {}),
    authorization: `Bearer ${token}`,
    [CONTRACT_VERSION_HEADER]: AGENT_CONTRACT_VERSION
  };
}

export async function submitAgentChat(baseUrl: string, token: string, request: AgentChatRequest): Promise<unknown> {
  const response = await fetch(`${baseUrl}/agent/chat`, {
    method: 'POST',
    headers: agentHeaders(token, true),
    body: JSON.stringify(request)
  });
  if (!response.ok) throw new Error(`Agent chat failed: ${response.status}`);
  return response.json();
}

export async function getAgentChatResult(baseUrl: string, token: string, jobId: string): Promise<unknown> {
  const response = await fetch(`${baseUrl}/agent/chat-result?job_id=${encodeURIComponent(jobId)}`, {
    headers: agentHeaders(token)
  });
  if (!response.ok) throw new Error(`Agent chat result failed: ${response.status}`);
  return response.json();
}

export type AgentStreamEvent = { event: string; data: unknown };

export type ParsedAgentSseFrame = {
  source: 'canonical' | 'legacy';
  event: string;
  sequence?: number;
  requestId?: string;
  conversationId?: string;
  messageId?: string;
  publicEvent: AgentStreamEvent | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function requireIdentifier(record: Record<string, unknown>, key: string): void {
  if (typeof record[key] !== 'string' || !IDENTIFIER_PATTERN.test(record[key])) {
    throw new Error(`Invalid canonical agent stream envelope: ${key}.`);
  }
}

function optionalCanonicalIdentifier(
  record: Record<string, unknown>,
  key: 'request_id' | 'conversation_id' | 'message_id',
  context: string
): string | undefined {
  if (!hasOwn(record, key)) return undefined;
  if (typeof record[key] !== 'string' || !IDENTIFIER_PATTERN.test(record[key])) {
    throw new Error(`Invalid canonical agent stream ${context} ${key}.`);
  }
  return record[key] as string;
}

function validateResponseObjectScope(
  value: unknown,
  requestId: string,
  conversationId: string,
  context: string,
  expectedMessageId?: string
): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const scopedRequestId = optionalCanonicalIdentifier(record, 'request_id', context);
  const scopedConversationId = optionalCanonicalIdentifier(record, 'conversation_id', context);
  const messageId = optionalCanonicalIdentifier(record, 'message_id', context);
  if (scopedRequestId && scopedRequestId !== requestId) {
    throw new Error(`Canonical agent stream ${context} request_id does not match its envelope.`);
  }
  if (scopedConversationId && scopedConversationId !== conversationId) {
    throw new Error(`Canonical agent stream ${context} conversation_id does not match its envelope.`);
  }
  if (expectedMessageId && messageId && messageId !== expectedMessageId) {
    throw new Error(`Canonical agent stream ${context} message_id does not match done.message_id.`);
  }
  return messageId;
}

function validateReceiptTurnScope(
  value: unknown,
  requestId: string,
  conversationId: string,
  context: string
): void {
  const record = asRecord(value);
  if (!record) return;
  const scopedRequestId = optionalCanonicalIdentifier(record, 'request_id', context);
  const scopedConversationId = optionalCanonicalIdentifier(record, 'conversation_id', context);
  const claimsActiveTurn = scopedRequestId === requestId || scopedConversationId === conversationId;
  if (!claimsActiveTurn) return;
  if (scopedRequestId && scopedRequestId !== requestId) {
    throw new Error(`Canonical agent stream ${context} request_id conflicts with the active turn.`);
  }
  if (scopedConversationId && scopedConversationId !== conversationId) {
    throw new Error(`Canonical agent stream ${context} conversation_id conflicts with the active turn.`);
  }
}

function validateCanonicalPublicScope(
  event: string,
  data: unknown,
  requestId: string,
  conversationId: string
): string | undefined {
  const record = asRecord(data);
  if (!record) return undefined;
  if (event === 'ui_command' || event === 'research_output') {
    return validateResponseObjectScope(record, requestId, conversationId, event);
  }
  if (event === 'action_receipt') {
    validateReceiptTurnScope(record, requestId, conversationId, event);
    return undefined;
  }
  if (event !== 'done') return undefined;

  const messageId = optionalCanonicalIdentifier(record, 'message_id', 'done');
  if (!messageId) return undefined;
  if (record.research_output !== undefined) {
    validateResponseObjectScope(
      record.research_output,
      requestId,
      conversationId,
      'done.research_output',
      messageId
    );
  }
  for (const [index, command] of (record.ui_commands as unknown[]).entries()) {
    validateResponseObjectScope(
      command,
      requestId,
      conversationId,
      `done.ui_commands[${index}]`,
      messageId
    );
  }
  for (const [index, receipt] of (record.action_receipts as unknown[]).entries()) {
    validateReceiptTurnScope(
      receipt,
      requestId,
      conversationId,
      `done.action_receipts[${index}]`
    );
  }
  return messageId;
}

function validatePublicError(data: unknown): void {
  const error = asRecord(data);
  if (!error
      || typeof error.code !== 'string'
      || !PUBLIC_ERROR_CODES.has(error.code)
      || typeof error.message !== 'string'
      || !error.message.trim()
      || typeof error.retryable !== 'boolean') {
    throw new Error('Invalid canonical agent stream error payload.');
  }
  const allowed = new Set(['code', 'message', 'retryable', 'correlation_id']);
  if (Object.keys(error).some((key) => !allowed.has(key))) {
    throw new Error('Unsafe field in canonical agent stream error payload.');
  }
  if (error.correlation_id !== undefined
      && (typeof error.correlation_id !== 'string' || !IDENTIFIER_PATTERN.test(error.correlation_id))) {
    throw new Error('Invalid canonical agent stream error correlation_id.');
  }
}

function validateCanonicalPublicData(event: string, data: unknown): void {
  const record = asRecord(data);
  if (!record) throw new Error(`Invalid canonical agent stream ${event} payload.`);
  if (event === 'content') {
    if (typeof record.text !== 'string'
        || typeof record.response_language !== 'string'
        || !RESPONSE_LANGUAGES.has(record.response_language)
        || (record.replace !== undefined && typeof record.replace !== 'boolean')) {
      throw new Error('Invalid canonical agent stream content payload.');
    }
    return;
  }
  if (event === 'image_urls') {
    if (!Array.isArray(record.image_urls)
        || !record.image_urls.every((value) => typeof value === 'string' && value.length > 0)
        || !Array.isArray(record.attachment_urls)
        || !record.attachment_urls.every((value) => typeof value === 'string' && value.length > 0)) {
      throw new Error('Invalid canonical agent stream image_urls payload.');
    }
    return;
  }
  if (event === 'error') {
    validatePublicError(record);
    return;
  }
  if (event !== 'done') return;

  if (!['completed', 'cancelled', 'failed'].includes(String(record.outcome))
      || typeof record.message_id !== 'string'
      || !IDENTIFIER_PATTERN.test(record.message_id)
      || typeof record.response_language !== 'string'
      || !RESPONSE_LANGUAGES.has(record.response_language)
      || !Array.isArray(record.action_receipts)
      || !Array.isArray(record.ui_commands)) {
    throw new Error('Invalid canonical agent stream done payload.');
  }
  if (record.outcome === 'completed') {
    if (typeof record.final_content !== 'string' || record.error !== undefined) {
      throw new Error('Completed canonical agent stream is missing valid final_content.');
    }
  } else {
    validatePublicError(record.error);
  }
}

function looksCanonical(record: Record<string, unknown>): boolean {
  return ['contract_version', 'request_id', 'conversation_id', 'sequence', 'visibility']
    .some((key) => hasOwn(record, key));
}

/**
 * Unwrap one semantic stream envelope. Canonical frames are validated and internal frames are
 * deliberately represented with `publicEvent: null`, so the Electron -> renderer bridge cannot
 * leak tool/reasoning telemetry. The legacy adapter is intentionally narrow: only already-public
 * event names pass through, and legacy `tool_result` is never promoted into a UI command.
 */
export function parseAgentSseFrame(transportEvent: string, payload: unknown): ParsedAgentSseFrame | null {
  const record = asRecord(payload);
  if (record && looksCanonical(record)) {
    if (Object.keys(record).some((key) => !ENVELOPE_KEYS.has(key))) {
      throw new Error('Unknown field in canonical agent stream envelope.');
    }
    for (const key of ['contract_version', 'request_id', 'conversation_id', 'sequence', 'event', 'visibility', 'data']) {
      if (!hasOwn(record, key)) throw new Error(`Canonical agent stream envelope is missing ${key}.`);
    }
    if (record.contract_version !== AGENT_CONTRACT_VERSION) {
      throw new Error(`Agent stream contract mismatch: expected ${AGENT_CONTRACT_VERSION}.`);
    }
    requireIdentifier(record, 'request_id');
    requireIdentifier(record, 'conversation_id');
    if (!Number.isInteger(record.sequence) || Number(record.sequence) < 0) {
      throw new Error('Invalid canonical agent stream envelope: sequence.');
    }
    if (typeof record.event !== 'string' || typeof record.visibility !== 'string') {
      throw new Error('Invalid canonical agent stream envelope event or visibility.');
    }
    if (transportEvent !== 'message' && transportEvent !== record.event) {
      throw new Error('SSE transport event does not match the semantic agent event.');
    }
    if (INTERNAL_AGENT_EVENTS.has(record.event)) {
      if (record.visibility !== 'internal') {
        throw new Error('Internal agent event was incorrectly marked public.');
      }
      return {
        source: 'canonical',
        event: record.event,
        sequence: Number(record.sequence),
        requestId: String(record.request_id),
        conversationId: String(record.conversation_id),
        publicEvent: null
      };
    }
    if (!PUBLIC_AGENT_EVENTS.has(record.event)) {
      throw new Error(`Unknown canonical agent stream event: ${record.event}.`);
    }
    if (record.visibility !== 'public') {
      throw new Error('Public agent event was incorrectly marked internal.');
    }
    validateCanonicalPublicData(record.event, record.data);
    const requestId = String(record.request_id);
    const conversationId = String(record.conversation_id);
    const messageId = validateCanonicalPublicScope(record.event, record.data, requestId, conversationId);
    return {
      source: 'canonical',
      event: record.event,
      sequence: Number(record.sequence),
      requestId,
      conversationId,
      ...(messageId ? { messageId } : {}),
      publicEvent: { event: record.event, data: record.data }
    };
  }

  // Isolated compatibility path for the pre-contract runtime. It forwards only public event names;
  // internal `thinking` / `tool_result` / plan telemetry is dropped rather than exposed.
  if (INTERNAL_AGENT_EVENTS.has(transportEvent)) {
    return { source: 'legacy', event: transportEvent, publicEvent: null };
  }
  if (!PUBLIC_AGENT_EVENTS.has(transportEvent)) return null;
  if (transportEvent === 'error') {
    const legacyError = asRecord(payload);
    const safeError: Record<string, unknown> = {
      message: typeof legacyError?.message === 'string' && legacyError.message.trim()
        ? legacyError.message
        : 'Agent stream failed.'
    };
    if (typeof legacyError?.code === 'string' && PUBLIC_ERROR_CODES.has(legacyError.code)) {
      safeError.code = legacyError.code;
    }
    if (typeof legacyError?.retryable === 'boolean') safeError.retryable = legacyError.retryable;
    return { source: 'legacy', event: transportEvent, publicEvent: { event: transportEvent, data: safeError } };
  }
  return { source: 'legacy', event: transportEvent, publicEvent: { event: transportEvent, data: payload } };
}

function decodeSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(raw) };
  } catch {
    throw new Error('Agent SSE data was not valid JSON.');
  }
}

/**
 * Consume the runtime SSE stream as a semantic protocol. `done` is the only terminal event; EOF,
 * duplicate/out-of-order sequences, mixed legacy/canonical modes, and events after `done` fail.
 */
export async function streamAgentChat(
  baseUrl: string,
  token: string,
  request: AgentChatRequest,
  onEvent: (event: AgentStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const requestId = `desktop-stream-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const body = {
    request_id: requestId,
    conversation_id: request.conversation_id || 'desktop-copilot',
    message: request.message,
    skill_environment: 'prod',
    response_mode: 'default',
    // The model for THIS turn. Sending it per request is what makes switching instant: the runtime
    // builds (or reuses) the matching service instead of being restarted to read new settings.
    model: request.model,
    provider: request.provider,
    api_base: request.api_base,
    // The PyHFO session this desktop is bound to. The runtime runs desktop-owned work THERE, so the
    // workspace updates from its own state rather than from a separate copy of the answer. This body
    // is built field by field, so anything not named here is silently dropped -- which is exactly how
    // the session went missing and every agent run fell back to computing in the runtime's process.
    session_url: request.session_url,
    session_token: request.session_token,
    user_context: { user_id: 'desktop', username: 'clinician', role: 'USER', allowed_mcp_servers: ['ieeg_ui'] },
    allowed_mcps: [{ name: 'iEEG UI', server_id: 'ieeg_ui', capabilities: ['ui_state', 'ui_command', 'waveform_inspection'] }],
    request_metadata: { source: 'desktop', request_id: requestId },
    // Keep only the explicit loaded recording path in the request. Live UI state is read via the
    // ieeg_ui MCP server from the broker, not copied into the agent request body.
    recording_path: request.recording_path ?? null,
    state_revision: request.state_revision ?? null
  };
  const response = await fetch(`${baseUrl}/internal/agent/v1/chat/stream`, {
    method: 'POST',
    headers: agentHeaders(token, true),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) throw new Error(`Agent chat stream failed: ${response.status}`);

  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let mode: ParsedAgentSseFrame['source'] | null = null;
  let lastSequence = -1;
  let terminalSeen = false;
  let streamMessageId: string | null = null;

  const consume = (frame: string): void => {
    const decoded = decodeSseFrame(frame);
    if (!decoded) return;
    const parsed = parseAgentSseFrame(decoded.event, decoded.data);
    if (!parsed) return;
    if (mode && mode !== parsed.source) throw new Error('Agent stream changed contract mode mid-turn.');
    mode = parsed.source;
    if (terminalSeen) throw new Error('Agent stream emitted an event after terminal done.');
    if (parsed.source === 'canonical') {
      if (parsed.requestId !== requestId) {
        throw new Error('Canonical agent stream request_id does not match the active request.');
      }
      if (parsed.conversationId !== body.conversation_id) {
        throw new Error('Canonical agent stream conversation_id does not match the active conversation.');
      }
      if (parsed.sequence === undefined || parsed.sequence <= lastSequence) {
        throw new Error('Canonical agent stream sequence did not increase monotonically.');
      }
      lastSequence = parsed.sequence;
      if (parsed.messageId) {
        if (streamMessageId && parsed.messageId !== streamMessageId) {
          throw new Error('Canonical agent stream message_id changed within the active response.');
        }
        streamMessageId = parsed.messageId;
      }
    }
    if (!parsed.publicEvent) return;
    onEvent(parsed.publicEvent);
    if (parsed.event === 'done') terminalSeen = true;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Normalize CRLF after appending so a CR/LF split across transport chunks is handled too.
    buffer = buffer.replace(/\r\n/g, '\n');
    let separator: number;
    while ((separator = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      consume(frame);
    }
  }
  buffer += decoder.decode();
  buffer = buffer.replace(/\r\n/g, '\n');
  if (buffer.trim()) consume(buffer);
  if (!terminalSeen) throw new Error('Agent stream ended without terminal done event.');
}
