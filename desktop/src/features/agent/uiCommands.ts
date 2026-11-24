export type UICommandSource = 'user' | 'agent' | 'system';
export type UICommandStatus = 'staged' | 'applied' | 'rejected' | 'dismissed';
export type UICommandConfirmation = 'auto' | 'confirm';
export type UICommandRisk = 'view' | 'read' | 'analysis' | 'compute' | 'artifact_write' | 'review_write' | 'destructive';

export type UICommand = {
  contract_version?: string;
  command_id: string;
  type: string;
  reason: string;
  payload: Record<string, unknown>;
  requires_confirmation?: boolean;
  session_id?: string;
  request_id?: string;
  message_id?: string;
  conversation_id?: string;
  state_revision?: string;
  resource_scope?: Record<string, unknown>;
  contract?: Record<string, unknown>;
  created_at?: string;
};
export type WorkspaceState = {
  session_id: string;
  recordingPath?: string | null;
  activePanel: string;
  channels: string[];
  selectedChannel?: string;
  selectedEvent?: string;
  selectedRun?: string;
  viewport: { start_seconds: number; duration_seconds: number };
  events: string[];
  runs: string[];
};

export type UICommandPolicy = {
  risk: UICommandRisk;
  confirmation: UICommandConfirmation;
  description: string;
  requiredPayload?: string[];
  requiresRecording?: boolean;
  requiresRun?: boolean;
  requiresEvent?: boolean;
  channelPayloadKey?: string;
  eventPayloadKey?: string;
  runPayloadKey?: string;
};

export type HistoryEntry = {
  command: UICommand;
  source: UICommandSource;
  status: UICommandStatus;
  diffState: 'added' | 'changed' | 'blocked' | 'unchanged';
  before: WorkspaceState;
  after: WorkspaceState;
  timestamp: string;
  // Why a command was rejected (validateUICommand's reason, e.g. "missing channel"). Carried on the
  // entry so the renderer can SURFACE the rejection and ack the real outcome back to the agent
  // instead of silently dropping it — otherwise the agent narrates success of a no-op.
  reason?: string;
};

export const UI_COMMAND_POLICIES: Record<string, UICommandPolicy> = {
  'workspace.open_panel': { risk: 'view', confirmation: 'auto', description: 'Open a workspace panel.' },
  'workspace.show_toast': { risk: 'view', confirmation: 'auto', description: 'Show a transient workspace message.' },
  'workspace.reset_waveform_view': { risk: 'view', confirmation: 'auto', description: 'Reset waveform filters, montage, focus mode, cursor, measurement, and time origin.' },
  'agent.show_trace_step': { risk: 'view', confirmation: 'auto', description: 'Record an Agent reasoning/result trace step.' },

  'recording.open': { risk: 'destructive', confirmation: 'confirm', description: 'Replace the current workspace recording with a specific file.', requiredPayload: ['input_path'] },
  'recording.inspect_metadata': { risk: 'read', confirmation: 'auto', description: 'Inspect recording metadata.', requiresRecording: true },
  'recording.infer_roi': { risk: 'analysis', confirmation: 'auto', description: 'Infer label-free brain-signal ROI.', requiresRecording: true },
  'recording.select_channel': { risk: 'view', confirmation: 'auto', description: 'Select a loaded recording channel.', requiredPayload: ['channel'], channelPayloadKey: 'channel' },
  'recording.set_channel_visibility': { risk: 'view', confirmation: 'auto', description: 'Change visible channel selection.', channelPayloadKey: 'channel' },

  'analysis.run_qc': { risk: 'analysis', confirmation: 'auto', description: 'Run channel QC on the loaded recording.', requiresRecording: true },
  'analysis.compute_spectral_profile': { risk: 'analysis', confirmation: 'auto', description: 'Compute spectral profile and Nyquist/line-noise evidence.', requiresRecording: true },
  'analysis.prepare_recording': { risk: 'compute', confirmation: 'confirm', description: 'Create a reproducible prepared recording artifact.', requiresRecording: true },

  'detection.plan': { risk: 'analysis', confirmation: 'auto', description: 'Recommend detector settings from metadata/ROI/QC.', requiresRecording: true },
  'detection.set_parameters': { risk: 'view', confirmation: 'auto', description: 'Set detector/preprocessing parameters in the Prepare panel (filter band, notch, resample, n_jobs, channel drops).', requiresRecording: true },
  'detection.run': { risk: 'compute', confirmation: 'confirm', description: 'Run a repeatable detector and write detection artifacts.', requiresRecording: true, requiredPayload: ['biomarker', 'detector'] },
  'detection.rank_candidates': { risk: 'analysis', confirmation: 'auto', description: 'Rank candidate channels from detector artifacts.', requiresRun: true },
  'detection.select_run': { risk: 'view', confirmation: 'auto', description: 'Select an existing detector run.', requiredPayload: ['run_id'], runPayloadKey: 'run_id' },
  'detection.show_candidate_ranking': { risk: 'view', confirmation: 'auto', description: 'Show channel ranking evidence.', requiresRun: true },
  'detection.focus_top_candidate_channel': { risk: 'view', confirmation: 'auto', description: 'Focus the waveform on the channel with the most loaded candidate events in the active run.', requiresRun: true },
  'classification.run': { risk: 'compute', confirmation: 'confirm', description: 'Classify the active run or rerun detect+classify.', requiresRecording: true, requiresRun: true },
  'severity.run': { risk: 'compute', confirmation: 'confirm', description: 'Score whole-recording severity (0-5, per 15s segment) for a scalp EEG recording. Requires no detection run.', requiresRecording: true },
  'classification.set_parameters': { risk: 'view', confirmation: 'auto', description: 'Set classifier parameters in the Classify panel (mode, device, batch size, sub-classifiers, models).', requiresRecording: true },

  'waveform.set_viewport': { risk: 'view', confirmation: 'auto', description: 'Move or resize the waveform viewport.' },
  'waveform.focus_channel': { risk: 'view', confirmation: 'auto', description: 'Focus a loaded channel in the waveform.', requiredPayload: ['channel'], channelPayloadKey: 'channel' },
  'waveform.center_event': { risk: 'view', confirmation: 'auto', description: 'Center a loaded event in the waveform.', requiredPayload: ['event_id'], eventPayloadKey: 'event_id' },
  'waveform.set_amplitude_scale': { risk: 'view', confirmation: 'auto', description: 'Change waveform amplitude scale.' },
  'waveform.set_display': { risk: 'view', confirmation: 'auto', description: 'Change waveform display options such as filtered/raw, 60 Hz filter, montage, visible channel count, focus mode, cursor, or measure mode.' },
  'waveform.focus_hotspot_channels': { risk: 'view', confirmation: 'auto', description: 'Focus channels ranked by loaded event counts in the active run.', requiresRun: true },

  'events.select_event': { risk: 'view', confirmation: 'auto', description: 'Select a loaded event.', requiredPayload: ['event_id'], eventPayloadKey: 'event_id' },
  'events.move_cursor': { risk: 'view', confirmation: 'auto', description: 'Move the review cursor.', eventPayloadKey: 'event_id' },
  'events.stage_annotation': { risk: 'review_write', confirmation: 'confirm', description: 'Write a human-review annotation after confirmation.', requiredPayload: ['event_id', 'label'], eventPayloadKey: 'event_id' },
  'events.clear_staged_annotation': { risk: 'review_write', confirmation: 'confirm', description: 'Clear a human-review annotation after confirmation.', requiredPayload: ['event_id'], eventPayloadKey: 'event_id' },
  'review.focus_event': { risk: 'view', confirmation: 'auto', description: 'Focus an event in review and waveform panes.', requiredPayload: ['event_id'], eventPayloadKey: 'event_id' },
  'review.open_event': { risk: 'view', confirmation: 'auto', description: 'Open the review dialog on the selected or specified event.', requiresEvent: true },
  'review.open_comparison': { risk: 'view', confirmation: 'auto', description: 'Open run comparison UI.', requiresRun: true },
  'review.accept_run': { risk: 'review_write', confirmation: 'confirm', description: 'Mark a run as accepted after confirmation.', requiredPayload: ['run_id'], runPayloadKey: 'run_id' },

  'artifacts.open_report': { risk: 'view', confirmation: 'auto', description: 'Open an existing report artifact.' },
  'export.session': { risk: 'artifact_write', confirmation: 'confirm', description: 'Export a session artifact after confirmation.' },
  'export.workbook': { risk: 'artifact_write', confirmation: 'confirm', description: 'Export a workbook artifact after confirmation.', requiresRun: true },
  'export.report': { risk: 'artifact_write', confirmation: 'confirm', description: 'Export a report artifact after confirmation.', requiresRun: true },

  'batch.create': { risk: 'artifact_write', confirmation: 'confirm', description: 'Create a resumable batch manifest.', requiredPayload: ['input_dir'] },
  'batch.run': { risk: 'compute', confirmation: 'confirm', description: 'Run a resumable batch manifest.', requiredPayload: ['manifest_path'] },

  // Migrated off the removed pyhfo_dispatch_action tool: the agent now reaches these capabilities through
  // the ieeg_ui MCP (emit_ui_command), never a direct agent tool.
  'detection.create_consensus_run': { risk: 'compute', confirmation: 'confirm', description: 'Create a consensus candidate run from multiple existing detector runs.', requiresRun: true },
  'review.group_overlaps': { risk: 'analysis', confirmation: 'auto', description: 'Group cross-channel overlapping events for review without hiding or deleting events.', requiresRun: true },
  'project.save': { risk: 'artifact_write', confirmation: 'confirm', description: 'Save the current project (recording, runs, labels, action log) to a project file.' },
  'project.open': { risk: 'destructive', confirmation: 'confirm', description: 'Open a saved project file, replacing the current workspace.', requiredPayload: ['input_path'] }
};

export const ALLOWED_UI_COMMANDS = new Set(Object.keys(UI_COMMAND_POLICIES));

export function uiCommandPolicy(type: string): UICommandPolicy | null {
  return UI_COMMAND_POLICIES[type] || null;
}

export function uiCommandRequiresConfirmation(command: UICommand): boolean {
  return Boolean(command.requires_confirmation) || uiCommandPolicy(command.type)?.confirmation === 'confirm';
}

// Agent autonomy is retained as a forward-compatible user preference, but it cannot enlarge
// authority. Every current confirmation-gated command has a clinician approval contract, so all of
// them stage until an explicit Apply interaction is durably accepted by the broker. Read-only/view
// analysis remains agent-driven because those command policies do not require confirmation.
export type AgentAutonomyLevel = 'review' | 'auto-run' | 'full';

export function autonomyAutoApplies(commandType: string, level: AgentAutonomyLevel): boolean {
  void level;
  const risk = uiCommandPolicy(commandType)?.risk;
  return risk === undefined ? false : !['compute', 'artifact_write', 'review_write', 'destructive'].includes(risk)
    && uiCommandPolicy(commandType)?.confirmation !== 'confirm';
}

export function shouldPreconfirmUICommand(commandType: string, source: UICommandSource, level: AgentAutonomyLevel): boolean {
  return source === 'agent' && autonomyAutoApplies(commandType, level);
}

export function validateUICommand(command: UICommand, state: WorkspaceState): { valid: boolean; reason?: string } {
  const policy = uiCommandPolicy(command.type);
  if (!policy) return { valid: false, reason: 'unsafe command type' };
  if (command.session_id && command.session_id !== state.session_id) return { valid: false, reason: 'stale or conflicting session command' };
  for (const key of policy.requiredPayload || []) {
    if (!hasPayloadValue(command.payload, key)) return { valid: false, reason: `missing ${key}` };
  }
  if (policy.requiresRecording && !state.recordingPath && !hasPayloadValue(command.payload, 'input_path')) return { valid: false, reason: 'missing recording' };
  if (policy.requiresRun && !state.selectedRun && state.runs.length === 0) return { valid: false, reason: 'missing run' };
  if (policy.requiresEvent && !state.selectedEvent && state.events.length === 0) return { valid: false, reason: 'missing event' };
  const channel = command.payload[policy.channelPayloadKey || 'channel'] as string | undefined;
  if (channel && !state.channels.includes(channel)) return { valid: false, reason: 'missing channel' };
  const eventId = command.payload[policy.eventPayloadKey || 'event_id'] as string | undefined;
  if (eventId && !state.events.includes(eventId)) return { valid: false, reason: 'missing event' };
  const runId = command.payload[policy.runPayloadKey || 'run_id'] as string | undefined;
  if (runId && !state.runs.includes(runId)) return { valid: false, reason: 'missing run' };
  return { valid: true };
}

export function applyUICommand(command: UICommand, state: WorkspaceState, source: UICommandSource = 'agent', options: { confirmed?: boolean } = {}): HistoryEntry {
  const before = structuredClone(state);
  const validation = validateUICommand(command, state);
  if (!validation.valid) {
    return { command, source, status: 'rejected', diffState: 'blocked', before, after: before, timestamp: new Date().toISOString(), reason: validation.reason };
  }
  if (!options.confirmed && uiCommandRequiresConfirmation(command)) {
    return { command, source, status: 'staged', diffState: 'added', before, after: before, timestamp: new Date().toISOString() };
  }
  const after = structuredClone(state);
  if (command.type === 'workspace.open_panel') after.activePanel = String(command.payload.panel || after.activePanel);
  if (command.type === 'workspace.reset_waveform_view') after.viewport = { start_seconds: 0, duration_seconds: after.viewport.duration_seconds };
  if (command.type === 'recording.select_channel' || command.type === 'waveform.focus_channel') after.selectedChannel = String(command.payload.channel || after.selectedChannel);
  if (command.type === 'events.select_event' || command.type === 'waveform.center_event' || command.type === 'review.focus_event' || command.type === 'review.open_event') after.selectedEvent = String(command.payload.event_id || after.selectedEvent);
  if (command.type === 'detection.select_run' || command.type === 'review.accept_run') after.selectedRun = String(command.payload.run_id || after.selectedRun);
  if (command.type === 'detection.focus_top_candidate_channel' && typeof command.payload.channel === 'string') after.selectedChannel = command.payload.channel;
  if (command.type === 'waveform.set_viewport' || command.type === 'waveform.focus_channel' || command.type === 'waveform.set_display') {
    after.viewport = {
      start_seconds: Number(command.payload.start_seconds ?? after.viewport.start_seconds),
      duration_seconds: Number(command.payload.duration_seconds ?? command.payload.time_window_seconds ?? after.viewport.duration_seconds)
    };
  }
  return { command, source, status: 'applied', diffState: JSON.stringify(before) === JSON.stringify(after) ? 'unchanged' : 'changed', before, after, timestamp: new Date().toISOString() };
}

export function normalizeAgentCommand(value: unknown, index = 0): UICommand | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (typeof record.type !== 'string' || !record.type.trim()) return null;
  const payload = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload) ? record.payload as Record<string, unknown> : {};
  const resourceScope = record.resource_scope && typeof record.resource_scope === 'object' && !Array.isArray(record.resource_scope)
    ? record.resource_scope as Record<string, unknown>
    : undefined;
  const actor = record.actor && typeof record.actor === 'object' && !Array.isArray(record.actor)
    ? record.actor as Record<string, unknown>
    : undefined;
  const topLevelSessionId = typeof record.session_id === 'string' && record.session_id.trim()
    ? record.session_id.trim()
    : undefined;
  const actorSessionId = typeof actor?.session_id === 'string' && actor.session_id.trim()
    ? actor.session_id.trim()
    : undefined;
  const topLevelStateRevision = typeof record.state_revision === 'string' && record.state_revision.trim()
    ? record.state_revision.trim()
    : undefined;
  const resourceStateRevision = typeof resourceScope?.state_revision === 'string' && resourceScope.state_revision.trim()
    ? resourceScope.state_revision.trim()
    : undefined;
  if (topLevelSessionId && actorSessionId && topLevelSessionId !== actorSessionId) return null;
  if (topLevelStateRevision && resourceStateRevision && topLevelStateRevision !== resourceStateRevision) return null;
  const command: UICommand = {
    contract_version: typeof record.contract_version === 'string' && record.contract_version.trim() ? record.contract_version.trim() : undefined,
    command_id: typeof record.command_id === 'string' && record.command_id.trim() ? record.command_id : `agent-ui-${Date.now()}-${index}`,
    type: record.type.trim(),
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason : record.type.trim(),
    payload,
    requires_confirmation: Boolean(record.requires_confirmation),
    session_id: topLevelSessionId || actorSessionId,
    request_id: typeof record.request_id === 'string' && record.request_id.trim() ? record.request_id : undefined,
    message_id: typeof record.message_id === 'string' && record.message_id.trim() ? record.message_id : undefined,
    conversation_id: typeof record.conversation_id === 'string' && record.conversation_id.trim() ? record.conversation_id : undefined,
    state_revision: topLevelStateRevision || resourceStateRevision,
    resource_scope: resourceScope ? { ...resourceScope } : undefined,
    contract: record.contract && typeof record.contract === 'object' && !Array.isArray(record.contract)
      ? record.contract as Record<string, unknown>
      : undefined,
    created_at: typeof record.created_at === 'string' && record.created_at.trim() ? record.created_at : new Date().toISOString()
  };
  command.requires_confirmation = uiCommandRequiresConfirmation(command);
  return command;
}

export function filterHistory(history: HistoryEntry[], filters: { source?: UICommandSource; status?: UICommandStatus }): HistoryEntry[] {
  return history.filter((entry) => (!filters.source || entry.source === filters.source) && (!filters.status || entry.status === filters.status));
}

export function replayCommands(initial: WorkspaceState, history: HistoryEntry[]): WorkspaceState {
  return history.reduce((state, entry) => entry.status === 'applied' ? applyUICommand({ ...entry.command, requires_confirmation: false }, state, entry.source, { confirmed: true }).after : state, structuredClone(initial));
}

function hasPayloadValue(payload: Record<string, unknown>, key: string): boolean {
  const value = payload[key];
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
