import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { backendClient } from '../api/backendClient';
import type { AgentArtifact, AgentChatMessage, AgentChatRunMeta, CapabilityManifest, EventFeatureSummary, PrepareControlsState, ProjectStoreState, RecentRecording, RecordingAnalysisState, RecordingMetadata, RecordingQcSummary, RecordingRoiSummary, RecordingSpectralSummary, ReviewEvent, ReviewSnippet, RunRecord, RuntimeLogEntry, RuntimeOperation, SeverityScoringResult, WaveformControlsState } from './workspaceState';
import { AVERAGE_REFERENCE_SUFFIX, BIPOLAR_TOKEN, DEFAULT_PREPARE_CONTROLS, DEFAULT_RECORDING_ANALYSIS, DEFAULT_WAVEFORM_CONTROLS, IDLE_RUNTIME_OPERATION, autoBipolarDerivedChannels, channelNames, initialVisibleChannels, montageBipolarChannels, montageStateForRecording, normalizeMontageMode, resolveMontageMode, chunkWaveformRequestChannels, clampPrepareControls, clampStopbandToNyquist, clampWaveformControls, detectorTabsByBiomarker, formatSeverityScore, isFreshWaveformResponse, isTransientWaveformBackendError, mergeWaveformWindowBatches, nyquistStopbandError, selectedWaveformChannels, shortRecordingDetectionNote, stepProgressPercent, supportsSeverityScoring, validateFilterControls } from './workspaceState';
import { VISUAL_FIXTURE_STATE, isVisualFixtureMode, visualFixtureEventFeatureSummary, visualFixtureEventSnippet, visualFixtureQuickDetectionMetadata } from './visualFixture';
import { createAgentStreamRouter } from './agentStreamRouter';
import { dispatchBrokerCommand, type BrokerCommandDispatch } from './brokerCommandDispatch';
import { bindDesktopApprovalContext, type AgentCommandAckContext } from './desktopApprovalAuthority';
import { authorizeAndExecuteFreshStagedCommand, stagedCommandScopeError, type StagedCommandScope } from './stagedCommandAuthorization';
import type { DetectorRunRequest } from '../features/shell/DetectorForms';
import { DEFAULT_CLASSIFIER_STATE, classifierHint, classifierPayloadFromState, type ClassifierControlsState, type ClassifierMode, type ClassifierRunRequest } from '../features/shell/ClassifierTab';
import { DEFAULT_SEVERITY_STATE, type SeverityRunState } from '../features/shell/SeverityTab';
import { filterAgentReply } from '../features/agent/agentReplyFilter';
import type { WaveformWindow } from '../features/waveform/WaveformCanvas';
import { applyUICommand, normalizeAgentCommand, shouldPreconfirmUICommand, uiCommandPolicy, type AgentAutonomyLevel, type HistoryEntry, type UICommand, type UICommandSource, type WorkspaceState } from '../features/agent/uiCommands';
import { agentClaimStateRevision, canonicalJsonSha256, opaqueWorkspaceSessionId } from './agentStateRevision';
import { agentCommandRecordingScopeError } from './agentCommandRecordingScope';

const AGENT_ARTIFACTS_STORAGE_KEY = 'ieeg.agentArtifacts';
const MAX_AGENT_ARTIFACTS = 80;

type AgentTurnScope = Readonly<{
  uiThreadId: string;
  backendConversationId: string;
}>;

type SequencedText = Readonly<{
  text: string;
  sequence: number;
}>;

type AgentConversationThread = {
  id: string;
  title: string;
  log: AgentChatMessage[];
};

export function appendAgentConversationMessage(
  conversations: AgentConversationThread[],
  uiThreadId: string,
  message: AgentChatMessage,
): AgentConversationThread[] {
  if (!conversations.some((entry) => entry.id === uiThreadId)) return conversations;
  return conversations.map((entry) => (
    entry.id === uiThreadId ? { ...entry, log: [...entry.log, message] } : entry
  ));
}
const AGENT_AUTONOMY_STORAGE_KEY = 'ieeg.agentAutonomy';

export type ReviewWriteSettlement = {
  status: 'complete' | 'failed' | 'noop';
  detail: string;
};

// Review writes are never success-shaped until the asynchronous mutation returns
// observed postcondition evidence. Keeping this coordinator pure makes the receipt
// ordering executable in tests instead of relying on source-shape assertions.
export async function settleAgentReviewWrite(options: {
  commandType: string;
  execute: () => Promise<Record<string, unknown> | null>;
  acknowledge: (outcome: Record<string, unknown>) => void | Promise<void>;
  now?: () => string;
}): Promise<ReviewWriteSettlement> {
  const now = options.now || (() => new Date().toISOString());
  await options.acknowledge({
    status: 'running',
    command_type: options.commandType,
    started_at: now()
  });
  try {
    const proof = await options.execute();
    const hasObservedEvidence = Boolean(
      proof
      && Object.entries(proof).some(([key, value]) => key !== 'source' && value !== undefined && value !== null && value !== '')
    );
    if (!hasObservedEvidence) {
      const detail = 'Review write completed without an observable state change.';
      await options.acknowledge({
        status: 'noop',
        command_type: options.commandType,
        reason: detail,
        finished_at: now()
      });
      return { status: 'noop', detail };
    }
    const detail = 'Review write completed and backend state was read back.';
    await options.acknowledge({
      status: 'complete',
      command_type: options.commandType,
      detail,
      terminal_proof: {
        source: String(proof?.source || 'backend_readback'),
        ...proof
      },
      finished_at: now()
    });
    return { status: 'complete', detail };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await options.acknowledge({
      status: 'failed',
      command_type: options.commandType,
      detail,
      error: { code: 'execution_failed', message: detail, retryable: false },
      finished_at: now()
    });
    return { status: 'failed', detail };
  }
}

function loadAgentAutonomy(): AgentAutonomyLevel {
  if (typeof window === 'undefined') return 'review';
  const saved = window.localStorage.getItem(AGENT_AUTONOMY_STORAGE_KEY);
  return saved === 'auto-run' || saved === 'full' ? saved : 'review';
}
const RECENT_RECORDINGS_STORAGE_KEY = 'ieeg.recentRecordings';
const MAX_RECENT_RECORDINGS = 12;
const MainWindowShell = lazy(async () => ({ default: (await import('./MainWindowShell')).MainWindowShell }));

function loadPersistedAgentArtifacts(): AgentArtifact[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_ARTIFACTS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersistableAgentArtifact).slice(0, MAX_AGENT_ARTIFACTS);
  } catch {
    return [];
  }
}

function persistAgentArtifacts(artifacts: AgentArtifact[]) {
  if (typeof window !== 'undefined') window.localStorage.setItem(AGENT_ARTIFACTS_STORAGE_KEY, JSON.stringify(artifacts.slice(0, MAX_AGENT_ARTIFACTS)));
}

function isPersistableAgentArtifact(value: unknown): value is AgentArtifact {
  const artifact = value as Partial<AgentArtifact> | null;
  return Boolean(artifact && typeof artifact.id === 'string' && typeof artifact.label === 'string' && typeof artifact.path === 'string' && typeof artifact.type === 'string' && typeof artifact.source === 'string' && typeof artifact.createdAt === 'string');
}

function loadPersistedRecentRecordings(): RecentRecording[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_RECORDINGS_STORAGE_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPersistableRecentRecording).slice(0, MAX_RECENT_RECORDINGS);
  } catch {
    return [];
  }
}

function persistRecentRecordings(recordings: RecentRecording[]) {
  if (typeof window !== 'undefined') window.localStorage.setItem(RECENT_RECORDINGS_STORAGE_KEY, JSON.stringify(recordings.slice(0, MAX_RECENT_RECORDINGS)));
}

function isPersistableRecentRecording(value: unknown): value is RecentRecording {
  const item = value as Partial<RecentRecording> | null;
  return Boolean(item && typeof item.path === 'string' && typeof item.label === 'string' && typeof item.openedAt === 'string');
}

function shortStableHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

function newAgentConversationSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function unsupportedAgentPayloadKeys(payload: Record<string, unknown>, allowed: ReadonlySet<string>): string[] {
  return Object.keys(payload).filter((key) => !allowed.has(key)).sort();
}

const AGENT_PREPARE_PAYLOAD_KEYS = new Set([
  'input_path', 'recording_fingerprint', 'output_path', 'filter', 'fp', 'fs', 'rp', 'rs',
  'line_noise_notch_hz', 'lineNoiseNotchHz', 'resample_sfreq', 'resampleSfreq',
  'drop_bad_channels', 'dropBadChannels', 'drop_flat_channels', 'dropFlatChannels',
  'mark_outlier_channels', 'markOutlierChannels', 'drop_outlier_channels', 'dropOutlierChannels',
  'n_jobs', 'nJobs',
]);
const AGENT_DETECTION_PAYLOAD_KEYS = new Set([
  'input_path', 'recording_fingerprint', 'biomarker', 'detector', 'detector_params', 'detectorParams',
  'ui_values', 'uiValues', 'filter', 'n_jobs', 'nJobs', 'exports', 'session_format', 'sessionFormat',
  'classifier', 'classifier_label', 'classifierLabel', 'scope', 'channel_scope', 'channelScope',
  'all_channels', 'allChannels', 'include_channels', 'includeChannels', 'exclude_channels',
  'excludeChannels', 'output_dir', 'outputDir', 'confirmed_defaults', 'use_defaults', 'protocol',
  'detection_protocol', 'protocol_name', 'parameter_preset', 'preset',
]);
const AGENT_SEVERITY_PAYLOAD_KEYS = new Set([
  'input_path', 'recording_fingerprint', 'model_dir', 'export_csv',
]);

function compactWaveformSnapshotDataUrl(canvas: HTMLCanvasElement): string {
  const maxWidth = 1400;
  const scale = canvas.width > maxWidth ? maxWidth / canvas.width : 1;
  if (scale >= 1) return canvas.toDataURL('image/png');

  const target = document.createElement('canvas');
  target.width = Math.max(1, Math.round(canvas.width * scale));
  target.height = Math.max(1, Math.round(canvas.height * scale));
  const ctx = target.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  ctx.drawImage(canvas, 0, 0, target.width, target.height);
  return target.toDataURL('image/png');
}

function roundAgentSeconds(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 1000) / 1000 : null;
}

function compactReviewStateForAgent(events: ReviewEvent[], selectedEventId: string, selectedRunId: string | null): Record<string, unknown> {
  const annotationCount = events.filter((event) => event.annotation).length;
  return {
    event_count: events.length,
    annotation_count: annotationCount,
    pending_count: Math.max(0, events.length - annotationCount),
    selected_event: selectedEventId || null,
    selected_run: selectedRunId,
    channel_counts: rankReviewChannels(events).slice(0, 12),
    events_preview: events.slice(0, 30).map((event) => ({
      event_id: event.event_id,
      run_id: event.run_id || selectedRunId || null,
      channel: event.channel || null,
      start_seconds: roundAgentSeconds(event.start_seconds),
      end_seconds: roundAgentSeconds(event.end_seconds),
      duration_seconds: roundAgentSeconds(event.duration_seconds),
      biomarker: event.biomarker || null,
      annotation: event.annotation ? {
        label: event.annotation.label,
        status: event.annotation.status || null,
        notes: event.annotation.notes ? event.annotation.notes.slice(0, 120) : null
      } : null
    }))
  };
}

// ── Compact observability summaries for get_ui_state ──────────────────────────
// The broker state must stay LEAN (reported every 1500ms) but the agent needs to READ BACK
// the panels/results it controls — otherwise it can set Prepare/Classify/analysis values and
// then be blind to whether they took. These helpers surface compact summaries (capped arrays).
function agentNumberOrNull(value: unknown): number | string | null {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

function compactPrepareControlsForAgent(p: PrepareControlsState): Record<string, unknown> {
  return {
    filter: { fp: agentNumberOrNull(p.fp), fs: agentNumberOrNull(p.fs) },
    rejection_band: { rp: agentNumberOrNull(p.rp), rs: agentNumberOrNull(p.rs) },
    line_noise_notch_hz: agentNumberOrNull(p.lineNoiseNotchHz),
    resample_sfreq: agentNumberOrNull(p.resampleSfreq),
    n_jobs: p.nJobs,
    drop_bad_channels: p.dropBadChannels,
    drop_flat_channels: p.dropFlatChannels,
    mark_outlier_channels: p.markOutlierChannels,
    drop_outlier_channels: p.dropOutlierChannels
  };
}

function compactClassifierControlsForAgent(c: ClassifierControlsState): Record<string, unknown> {
  return {
    mode: c.mode,
    device: c.device,
    batch_size: agentNumberOrNull(c.batchSize),
    use_spike: c.useSpike,
    use_ehfo: c.useEhfo,
    ignore_before: agentNumberOrNull(c.ignoreBefore),
    ignore_after: agentNumberOrNull(c.ignoreAfter)
  };
}

function compactRecordingAnalysisForAgent(a: RecordingAnalysisState): Record<string, unknown> | null {
  if (!a || (a.status === 'idle' && !a.roi && !a.qc && !a.spectral && !a.candidate_ranking)) return null;
  const out: Record<string, unknown> = { status: a.status };
  if (a.updatedAt) out.updated_at = a.updatedAt;
  if (a.error) out.error = a.error;
  if (a.roi) out.roi = { policy: a.roi.policy, brain_signal_channel_count: a.roi.brain_signal_channel_count ?? a.roi.brain_signal_channels?.length ?? null, default_detection_exclusions: (a.roi.default_detection_exclusions || []).slice(0, 24) };
  if (a.qc) out.qc = { roi_channel_count: a.qc.roi_channel_count ?? null, flat_channels: (a.qc.flat_channels || []).slice(0, 24), outlier_channels: (a.qc.outlier_channels || []).slice(0, 24) };
  if (a.spectral) out.spectral = { sample_freq: a.spectral.sample_freq ?? null, nyquist_hz: a.spectral.nyquist_hz ?? null, recommended_hfo_band: a.spectral.recommended_hfo_band ?? null, line_noise_candidates: (a.spectral.line_noise_candidates || []).slice(0, 5) };
  if (a.candidate_ranking) out.candidate_ranking = { candidate_channel_count: a.candidate_ranking.candidate_channel_count ?? null, top_channels: (a.candidate_ranking.top_channels || []).slice(0, 12).map((r) => ({ channel: r.channel, total_events: r.total_events, per_minute: r.total_events_per_minute })) };
  if (a.confirmed_exclusions?.length) out.confirmed_exclusions = a.confirmed_exclusions.slice(0, 24);
  return out;
}

function compactSeverityForAgent(state: SeverityRunState): Record<string, unknown> | null {
  if (state.status === 'idle' && !state.result) return null;
  const result = state.result;
  return {
    status: state.status,
    eeg_type: result?.eeg_type ?? null,
    num_segments: result?.num_segments ?? null,
    num_clean_segments: result?.num_clean_segments ?? null,
    mean_score: result?.mean_score ?? null,
    peak_score: result?.peak_score ?? null,
    peak_time_sec: result?.peak_time_sec ?? null,
    clean_mean_score: result?.clean_mean_score ?? null,
    clean_peak_score: result?.clean_peak_score ?? null,
    clean_peak_time_sec: result?.clean_peak_time_sec ?? null,
    artifact_threshold_uv: result?.artifact_threshold_uv ?? null,
    artifact_quality: result?.artifact_quality ?? null,
    model_name: result?.model_name ?? null,
    model_version: result?.model_version ?? null,
    model_sha256: result?.model_sha256 ?? null,
    parameters_sha256: result?.parameters_sha256 ?? null,
    recording_fingerprint: result?.recording_fingerprint ?? null,
    warnings: (result?.warnings || []).slice(0, 8),
  };
}

function compactRunsForAgent(runs: RunRecord[], acceptedRunId: string | null, visibleRunIds: string[], activeRunId: string | null): Array<Record<string, unknown>> {
  return runs.slice(0, 24).map((r) => ({
    run_id: r.runId,
    detector: r.detector,
    biomarker: r.biomarker,
    events: r.events,
    channels: r.channels,
    status: r.status,
    classifier: r.classifier || null,
    accepted: Boolean(r.accepted) || r.runId === acceptedRunId,
    active: r.runId === activeRunId,
    visible: visibleRunIds.includes(r.runId)
  }));
}

function compactOperationForAgent(op: RuntimeOperation): Record<string, unknown> | null {
  if (!op || op.status === 'idle') return null;
  return { id: op.id, label: op.label, kind: op.kind, status: op.status, progress: op.progress, indeterminate: op.indeterminate || false, step: op.totalSteps ? { completed: op.completedSteps ?? 0, total: op.totalSteps } : null };
}


export function App() {
  // Empty, not a seeded prompt: pre-filled text in the composer is indistinguishable from something
  // the user typed, and Send would fire it verbatim. The greyed placeholder does the hinting.
  const [message, setMessage] = useState('');
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<RecordingMetadata | null>(null);
  const [waveform, setWaveform] = useState<WaveformWindow | null>(null);
  const [waveformControls, setWaveformControls] = useState<WaveformControlsState>(DEFAULT_WAVEFORM_CONTROLS);
  const [prepareControls, setPrepareControls] = useState<PrepareControlsState>(DEFAULT_PREPARE_CONTROLS);
  const [recordingAnalysis, setRecordingAnalysis] = useState<RecordingAnalysisState>(DEFAULT_RECORDING_ANALYSIS);
  const [classifierControls, setClassifierControls] = useState<ClassifierControlsState>(DEFAULT_CLASSIFIER_STATE);
  const [classifierFeedback, setClassifierFeedback] = useState(classifierHint('HFO'));
  const [severityState, setSeverityState] = useState<SeverityRunState>(DEFAULT_SEVERITY_STATE);
  const severityStatusRef = useRef<SeverityRunState['status']>('idle');
  // Set when the user cancels, so the failing request that follows is reported as a cancellation
  // rather than as a backend error the user did not cause.
  const severityCancelledRef = useRef(false);
  useEffect(() => { severityStatusRef.current = severityState.status; }, [severityState.status]);
  const [runRecords, setRunRecords] = useState<RunRecord[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [acceptedRunId, setAcceptedRunId] = useState<string | null>(null);
  const [visibleRunIds, setVisibleRunIds] = useState<string[]>([]);
  const [reviewEvents, setReviewEvents] = useState<ReviewEvent[]>([]);
  const [selectedReviewEventId, setSelectedReviewEventId] = useState('');
  const [runEventsByRun, setRunEventsByRun] = useState<Record<string, ReviewEvent[]>>({});
  const [reviewMessage, setReviewMessage] = useState('No detection runs yet.');
  const [runtimeOperation, setRuntimeOperation] = useState<RuntimeOperation>(IDLE_RUNTIME_OPERATION);
  const [runtimeLog, setRuntimeLog] = useState<RuntimeLogEntry[]>([
    { id: 'runtime-ready', timestamp: new Date().toISOString(), level: 'info', message: 'Ready. Operational messages, warnings, and task progress appear here.' }
  ]);
  const [agentArtifacts, setAgentArtifacts] = useState<AgentArtifact[]>(loadPersistedAgentArtifacts);
  const [uiCommandHistory, setUiCommandHistory] = useState<HistoryEntry[]>([]);
  const [pendingShellCommand, setPendingShellCommand] = useState<UICommand | null>(null);
  const [recentRecordings, setRecentRecordings] = useState<RecentRecording[]>(loadPersistedRecentRecordings);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);
  const [capabilityManifest, setCapabilityManifest] = useState<CapabilityManifest | null>(null);
  const noticeSequenceRef = useRef(0);
  const [workspaceError, setWorkspaceError] = useState<{ text: string | null; sequence: number }>({ text: null, sequence: 0 });
  const [workspaceStatus, setWorkspaceStatus] = useState<SequencedText>({ text: 'Ready. Open a recording to start review.', sequence: 0 });
  // Conversations are separate threads, each with its own backend history: a new one must not
  // inherit the last one's context, or 'start fresh' would only clear the screen.
  const [agentConversations, setAgentConversations] = useState<AgentConversationThread[]>(
    () => [{ id: 'conversation-1', title: 'Chat 1', log: [] }],
  );
  const [activeAgentConversationId, setActiveAgentConversationId] = useState('conversation-1');
  const [agentTurnErrorsByConversation, setAgentTurnErrorsByConversation] = useState<Record<string, SequencedText>>({});
  const [agentTurnStatusByConversation, setAgentTurnStatusByConversation] = useState<Record<string, SequencedText>>({});
  const closedAgentConversationIdsRef = useRef<Set<string>>(new Set());
  // Conversation records are the sole transcript source. Deriving the visible log prevents an
  // async turn from appending through a stale "active chat" copy after the user switches tabs.
  const agentChatLog = agentConversations.find((entry) => entry.id === activeAgentConversationId)?.log || [];
  const activeAgentError = agentTurnErrorsByConversation[activeAgentConversationId];
  const activeAgentStatus = agentTurnStatusByConversation[activeAgentConversationId];
  const error = activeAgentError && activeAgentError.sequence > workspaceError.sequence
    ? activeAgentError.text
    : workspaceError.text;
  const statusMessage = activeAgentStatus && activeAgentStatus.sequence > workspaceStatus.sequence
    ? activeAgentStatus.text
    : workspaceStatus.text;

  function setError(text: string | null) {
    setWorkspaceError({ text, sequence: ++noticeSequenceRef.current });
  }

  function setStatusMessage(text: string) {
    setWorkspaceStatus({ text, sequence: ++noticeSequenceRef.current });
  }

  function setAgentTurnError(uiThreadId: string, text: string | null) {
    if (closedAgentConversationIdsRef.current.has(uiThreadId)) return;
    if (text === null) {
      setAgentTurnErrorsByConversation((current) => {
        if (!(uiThreadId in current)) return current;
        const next = { ...current };
        delete next[uiThreadId];
        return next;
      });
      return;
    }
    const sequence = ++noticeSequenceRef.current;
    setAgentTurnErrorsByConversation((current) => ({ ...current, [uiThreadId]: { text, sequence } }));
  }

  function setAgentTurnStatus(uiThreadId: string, text: string) {
    if (closedAgentConversationIdsRef.current.has(uiThreadId)) return;
    const sequence = ++noticeSequenceRef.current;
    setAgentTurnStatusByConversation((current) => ({
      ...current,
      [uiThreadId]: { text, sequence },
    }));
  }

  function setAgentTurnStreamingText(uiThreadId: string, text: string) {
    if (closedAgentConversationIdsRef.current.has(uiThreadId)) return;
    setStreamingByConversation((current) => ({ ...current, [uiThreadId]: text }));
  }
  // Names come from a counter that never rewinds. Deriving 'Chat N' from the list length meant
  // closing a tab and opening another produced two tabs with the same name.
  const conversationCounterRef = useRef(1);
  // Live agent turn: `agentResponding` flips on the moment a prompt is sent and off when the reply lands,
  // so the transcript can show a thinking/streaming bubble instead of going silent. `agentStreamingText`
  // carries the partial reply for in-bubble streaming (empty until the first token arrives).
  // Which conversation the in-flight turn belongs to. A turn started in Chat 1 keeps running while
  // you read Chat 2 -- its status has to follow the thread, not the window, and its answer has to
  // land in the thread that asked.
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [streamingByConversation, setStreamingByConversation] = useState<Record<string, string>>({});
  const agentResponding = busyConversationId === activeAgentConversationId;
  const agentStreamingText = streamingByConversation[activeAgentConversationId] || '';
  // Run cards in the transcript need unique ids; user-initiated agent turns are serialized through a
  // promise chain so one reply cannot clobber another streaming bubble.
  const agentRunCardSeq = useRef(0);
  const agentTurnChain = useRef<Promise<unknown>>(Promise.resolve());
  const agentUserTurnEpoch = useRef(0);
  // operation.id → run-card id, so finishOperation can retire/notify the card for any agent-initiated op.
  const agentOpCardIds = useRef<Map<string, string>>(new Map());
  const agentOpCommandIds = useRef<Map<string, string>>(new Map());
  const agentOpUiThreadIds = useRef<Map<string, string>>(new Map());
  // Agent autonomy is a preference, never an authority grant. Current clinician-authorized writes
  // always stage; a ref mirror keeps live SSE ingest closures reading the displayed preference.
  const [agentAutonomy, setAgentAutonomy] = useState<AgentAutonomyLevel>(loadAgentAutonomy);
  const agentAutonomyRef = useRef<AgentAutonomyLevel>(agentAutonomy);
  agentAutonomyRef.current = agentAutonomy;
  // Monotonically increasing token for the main waveform fetch. Each new window load
  // (navigation/zoom/coarse-then-refine) increments it; only responses carrying the
  // current token are allowed to call setWaveform, so slow/out-of-order responses
  // (e.g. a coarse pass that finishes after a newer full-res load) are discarded.
  const waveformRequestTokenRef = useRef(0);
  // Single-flight gate for navigation-driven plot updates. A wheel/drag gesture
  // emits an update per event; without this, each one fires its own
  // /waveform/window fetch(es), and a single scroll can stack dozens of
  // concurrent requests that overwhelm the local backend and reset the
  // connection. Instead we keep at most one load in flight and remember only the
  // latest requested controls, running that once the current load settles.
  const waveformUpdateInFlightRef = useRef(false);
  const pendingWaveformControlsRef = useRef<WaveformControlsState | null>(null);
  const agentConversationSessionRef = useRef(newAgentConversationSessionId());
  const commandAckContextRef = useRef<Map<string, AgentCommandAckContext>>(new Map());
  const pendingCommandApprovalsRef = useRef<Set<string>>(new Set());
  const brokerAckRef = useRef<(commandId: string, outcome: Record<string, unknown>) => void>(() => undefined);
  // The broker reports the same state every 1.5 seconds. Computing the canonical SHA-256
  // revision only when one of its immutable React inputs changes avoids repeatedly hashing
  // large review collections while preserving the exact snapshot captured by async callbacks.
  const agentWorkspaceStateRevisionValue = useMemo(() => agentClaimStateRevision({
    scopeSalt: agentConversationSessionRef.current,
    autonomy: agentAutonomy,
    recording: { loaded: Boolean(recordingPath), locator: recordingPath, metadata: metadata as Record<string, unknown> | null },
    activeRunId,
    acceptedRunId,
    visibleRunIds,
    runs: runRecords as unknown as Record<string, unknown>[],
    reviewEvents: reviewEvents as unknown as Record<string, unknown>[],
    reviewEventsByRun: runEventsByRun as unknown as Record<string, Record<string, unknown>[]>,
    prepareControls: prepareControls as unknown as Record<string, unknown>,
    classifierControls: classifierControls as unknown as Record<string, unknown>,
    recordingAnalysis: recordingAnalysis as unknown as Record<string, unknown>,
    severity: severityState as unknown as Record<string, unknown>,
    operation: runtimeOperation as unknown as Record<string, unknown>
  }), [
    recordingPath,
    agentAutonomy,
    metadata,
    activeRunId,
    acceptedRunId,
    visibleRunIds,
    runRecords,
    reviewEvents,
    runEventsByRun,
    prepareControls,
    classifierControls,
    recordingAnalysis,
    severityState,
    runtimeOperation
  ]);
  // Async Apply handlers retain their original render closure. Keep the authorization scope in a
  // render-updated ref so a recording/project/state change during an awaited broker round-trip is
  // visible to the post-ACK TOCTOU check.
  const liveAgentCommandScopeRef = useRef<StagedCommandScope>({
    sessionId: projectId || projectPath || recordingPath || 'unsaved-workspace',
    conversationId: agentConversationId(),
    stateRevision: agentWorkspaceStateRevisionValue,
  });
  liveAgentCommandScopeRef.current = {
    sessionId: projectId || projectPath || recordingPath || 'unsaved-workspace',
    conversationId: agentConversationId(),
    stateRevision: agentWorkspaceStateRevisionValue,
  };


  useEffect(() => { persistAgentArtifacts(agentArtifacts); }, [agentArtifacts]);
  useEffect(() => { persistRecentRecordings(recentRecordings); }, [recentRecordings]);
  useEffect(() => {
    backendClient.setWorkspaceDirty({ dirty: projectDirty, source: 'renderer-project-state' }).catch(() => undefined);
  }, [projectDirty]);
  useEffect(() => backendClient.onSaveBeforeClose(async () => {
    try {
      const saved = await saveProject();
      await backendClient.completeSaveBeforeClose({ saved, source: 'renderer-save-before-close' });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Save before close failed; workspace kept open.');
      logRuntime('error', `Save before close failed: ${message}`);
      await backendClient.completeSaveBeforeClose({ saved: false, source: 'renderer-save-before-close', error: message }).catch(() => undefined);
    }
  }));
  useEffect(() => {
    if (!isVisualFixtureMode()) return;
    const fixture = VISUAL_FIXTURE_STATE;
    setRecordingPath(fixture.recordingPath);
    setMetadata(fixture.metadata);
    setWaveform(fixture.waveform);
    setWaveformControls(fixture.waveformControls);
    setPrepareControls(fixture.prepareControls);
    setRecordingAnalysis(fixture.recordingAnalysis);
    setClassifierControls(fixture.classifierControls);
    setClassifierFeedback(fixture.classifierFeedback);
    setRunRecords(fixture.runRecords);
    setActiveRunId(fixture.activeRunId);
    setAcceptedRunId(fixture.acceptedRunId);
    setVisibleRunIds(fixture.visibleRunIds);
    setReviewEvents(fixture.reviewEvents);
    setRunEventsByRun(fixture.runEventsByRun);
    setSelectedReviewEventId(fixture.selectedReviewEventId);
    setReviewMessage(fixture.reviewMessage);
    setRuntimeLog(fixture.runtimeLog);
    setAgentArtifacts(fixture.agentArtifacts);
    setCapabilityManifest(fixture.capabilityManifest);
    setStatusMessage(fixture.statusMessage);
  }, []);
  useEffect(() => {
    if (typeof window !== 'undefined') window.localStorage.setItem(AGENT_AUTONOMY_STORAGE_KEY, agentAutonomy);
  }, [agentAutonomy]);
  useEffect(() => {
    if (isVisualFixtureMode()) {
      setCapabilityManifest(VISUAL_FIXTURE_STATE.capabilityManifest);
      return;
    }
    let cancelled = false;
    backendClient.manifest()
      .then((manifest) => {
        if (!cancelled) setCapabilityManifest(manifest as CapabilityManifest);
      })
      .catch((exc) => logRuntime('warning', `Capability manifest load failed: ${exc instanceof Error ? exc.message : String(exc)}`));
    return () => { cancelled = true; };
  }, []);

  function recordAgentArtifact(artifact: Omit<AgentArtifact, 'id' | 'createdAt'> & { id?: string; createdAt?: string }) {
    const createdAt = artifact.createdAt || new Date().toISOString();
    const id = artifact.id || `artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setAgentArtifacts((current) => [{ ...artifact, id, createdAt }, ...current.filter((item) => item.path !== artifact.path)].slice(0, MAX_AGENT_ARTIFACTS));
  }

  function clearAgentArtifacts() {
    setAgentArtifacts([]);
    if (typeof window !== 'undefined') window.localStorage.removeItem(AGENT_ARTIFACTS_STORAGE_KEY);
    logRuntime('info', 'Agent artifact history cleared.');
  }

  function recordDetectionArtifacts(result: DetectionRunResult, run: RunRecord) {
    for (const [key, value] of Object.entries(result.artifacts || {})) {
      if (!value) continue;
      recordAgentArtifact({ label: `${run.detector} ${key}`, type: key.includes('summary') ? 'summary' : key.includes('session') ? 'session' : 'detection', path: value, source: 'backend', runId: run.runId, status: result.status || run.status });
    }
    if (result.output_dir) recordAgentArtifact({ label: `${run.detector} output directory`, type: 'detection', path: result.output_dir, source: 'backend', runId: run.runId, status: result.status || run.status });
  }

  async function openAgentArtifact(path: string) {
    try {
      await backendClient.openArtifactPath({ path });
      logRuntime('info', `Opened artifact: ${path}`);
    } catch (exc) {
      logRuntime('warning', `Open artifact failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }


  async function revealAgentArtifact(path: string) {
    try {
      await backendClient.revealArtifactPath({ path });
      logRuntime('info', `Revealed artifact: ${path}`);
    } catch (exc) {
      logRuntime('warning', `Reveal artifact failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  function removeAgentArtifact(id: string) {
    setAgentArtifacts((current) => current.filter((artifact) => artifact.id !== id));
    logRuntime('info', 'Agent artifact removed from history.');
  }

  async function savePngSnapshot(request: { data_url: string; default_name: string; title: string }) {
    const result = await backendClient.savePngSnapshot(request) as { status?: string; canceled?: boolean; artifact_path?: string; artifact_type?: string };
    if (!result?.canceled && result?.artifact_path) {
      recordAgentArtifact({ label: request.title, type: 'snapshot', path: result.artifact_path, source: 'electron-ui', status: result.status || 'complete' });
    }
    return result;
  }

  function markWorkspaceDirty() {
    setProjectDirty(true);
  }

  async function confirmDiscardWorkspace(action: string): Promise<boolean> {
    if (!projectDirty) return true;
    const result = await backendClient.confirmDiscardWorkspace({ action, project_id: projectId, project_path: projectPath }) as { action?: 'continue' | 'save' | 'discard' | 'cancel'; confirmed?: boolean };
    if (result.action === 'continue' || result.action === 'discard') return true;
    if (result.action === 'save') {
      const saved = await saveProject();
      if (saved) return true;
      const saveMessage = `${action} paused because project save failed.`;
      setStatusMessage(saveMessage);
      logRuntime('warning', saveMessage);
      return false;
    }
    const message = `${action} cancelled to keep the unsaved workspace.`;
    setStatusMessage(message);
    logRuntime('warning', message);
    return false;
  }

  function buildProjectStoreState(): ProjectStoreState {
    return {
      schema_version: 'electron-pyqt-project.v1',
      project_id: projectId || undefined,
      recording_path: recordingPath,
      recording_info: metadata,
      active_run_id: activeRunId,
      accepted_run_id: acceptedRunId,
      visible_run_ids: visibleRunIds,
      run_records: runRecords,
      review_events: reviewEvents,
      review_events_by_run: runEventsByRun,
      severity_result: severityState.result,
      agent_conversations: agentConversations,
      active_agent_conversation_id: activeAgentConversationId,
      review_cursor_event_id: selectedReviewEventId,
      prepare_controls: prepareControls,
      recording_analysis: recordingAnalysis,
      classifier_controls: classifierControls as unknown as Record<string, unknown>,
      waveform_controls: waveformControls,
      runtime_log: runtimeLog.slice(-80)
    };
  }

  async function newProject() {
    const operation = beginOperation('New project', 'export');
    try {
      const created = await backendClient.createProject({ recording_path: recordingPath, detection_runs: runRecords, review_labels: {} }) as ProjectApiResult;
      const path = created.project_path || null;
      const state = { ...buildProjectStoreState(), ...(created.state || {}), project_id: created.project_id || projectId || created.state?.project_id };
      const saved = await backendClient.saveProject({ project_path: path, state }) as ProjectApiResult;
      setProjectPath(saved.project_path || path);
      setProjectId(String(saved.state?.project_id || created.project_id || 'project'));
      setProjectDirty(false);
      if (saved.project_path) recordAgentArtifact({ label: 'Project', type: 'session', path: saved.project_path, source: 'backend', status: saved.status || 'complete' });
      setStatusMessage(`Project created: ${saved.project_path || created.project_path || 'backend project'}.`);
      finishOperation(operation, 'success', 'Project created and current workspace saved.');
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Project creation failed.');
      finishOperation(operation, 'error', message);
    }
  }

  async function openProject() {
    if (!(await confirmDiscardWorkspace('opening another project'))) return;
    const operation = beginOperation('Open project', 'recording');
    try {
      setError(null);
      const selected = await backendClient.openProjectFile();
      if (!selected) {
        setStatusMessage('Open project cancelled.');
        finishOperation(operation, 'warning', 'Open project cancelled.');
        return;
      }
      const opened = await backendClient.openProject({ project_path: selected }) as ProjectApiResult;
      await restoreProjectState(opened.state || {}, opened.project_path || selected, operation);
      finishOperation(operation, 'success', `Project opened: ${opened.project_path || selected}.`);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Open project failed.');
      finishOperation(operation, 'error', message);
    }
  }

  async function saveProject(opts: { agentInitiated?: boolean; commandId?: string } = {}): Promise<boolean> {
    const operation = beginOperation('Save project', 'export', { agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    try {
      const state = buildProjectStoreState();
      const saved = await backendClient.saveProject({ project_path: projectPath || undefined, state }) as ProjectApiResult;
      const terminalProof = backendArtifactTerminalProof(saved);
      setProjectPath(saved.project_path || projectPath);
      setProjectId(String(saved.state?.project_id || state.project_id || projectId || 'project'));
      setProjectDirty(false);
      if (saved.project_path) recordAgentArtifact({ label: 'Project', type: 'session', path: saved.project_path, source: 'backend', status: saved.status || 'complete' });
      setStatusMessage(`Project saved: ${saved.project_path || 'backend project'}.`);
      finishOperation(operation, 'success', 'Project saved with current recording, runs, controls, and review state.', terminalProof);
      return true;
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Project save failed.');
      finishOperation(operation, 'error', message);
      return false;
    }
  }

  function logRuntime(level: RuntimeLogEntry['level'], message: string, operationId = runtimeOperation.id) {
    setRuntimeLog((current) => [...current.slice(-80), { id: `log-${Date.now()}-${Math.random().toString(16).slice(2)}`, timestamp: new Date().toISOString(), level, message, operationId }]);
  }

  function agentWorkspaceState(): WorkspaceState {
    return {
      session_id: opaqueWorkspaceSessionId(
        agentConversationSessionRef.current,
        projectId,
        projectPath,
        recordingPath,
      ),
      recordingPath,
      activePanel: 'workspace',
      channels: metadata?.channel_names || [],
      selectedChannel: waveformControls.annotationChannel || waveformControls.channelsToPlot[0],
      selectedEvent: selectedReviewEventId || undefined,
      selectedRun: activeRunId || undefined,
      viewport: { start_seconds: waveformControls.startSeconds, duration_seconds: waveformControls.timeWindowSeconds },
      events: reviewEvents.map((event) => event.event_id),
      runs: runRecords.map((run) => run.runId)
    };
  }

  function agentConversationId(uiThreadId = activeAgentConversationId): string {
    // Bind the backend conversation_id ONLY to the stable per-app-session ref. Mixing in
    // the mutable workspace session_id (recording/project path) re-routed the turn to a
    // fresh, empty backend history the moment a recording was loaded or a project saved —
    // so the agent "forgot" the in-progress conversation. Workspace/recording context is
    // still conveyed separately via the agentUiStatePayload + [Desktop context] injection.
    return `desktop-copilot-${shortStableHash(`${agentConversationSessionRef.current}:${uiThreadId}`)}`;
  }

  /** Show another thread. Its transcript and in-flight state are projected from per-thread stores. */
  function selectAgentConversation(conversationId: string) {
    if (conversationId === activeAgentConversationId) return;
    setActiveAgentConversationId(conversationId);
  }

  function startAgentConversation() {
    const id = `conversation-${Date.now().toString(36)}`;
    closedAgentConversationIdsRef.current.delete(id);
    setAgentConversations((current) => {
      conversationCounterRef.current += 1;
      return [...current, { id, title: `Chat ${conversationCounterRef.current}`, log: [] }];
    });
    setActiveAgentConversationId(id);
    setStatusMessage('Started a new co-pilot conversation.');
  }

  /**
   * Close a thread. The list never empties -- closing the last one leaves a fresh empty thread,
   * because a chat panel with no conversation has nowhere to type. If the closed thread had a turn
   * in flight, its status is released here; its reply is dropped by appendToConversation, which
   * ignores threads that no longer exist rather than resurrecting them.
   */
  function closeAgentConversation(conversationId: string) {
    closedAgentConversationIdsRef.current.add(conversationId);
    setAgentConversations((current) => {
      const remaining = current.filter((entry) => entry.id !== conversationId);
      if (!remaining.length) {
        conversationCounterRef.current += 1;
        const fresh = { id: `conversation-${Date.now().toString(36)}`, title: `Chat ${conversationCounterRef.current}`, log: [] };
        closedAgentConversationIdsRef.current.delete(fresh.id);
        setActiveAgentConversationId(fresh.id);
        return [fresh];
      }
      if (conversationId === activeAgentConversationId) {
        const closedIndex = current.findIndex((entry) => entry.id === conversationId);
        const neighbour = remaining[Math.min(closedIndex, remaining.length - 1)];
        setActiveAgentConversationId(neighbour.id);
      }
      return remaining;
    });
    if (busyConversationId === conversationId) setBusyConversationId(null);
    setStreamingByConversation((current) => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setAgentTurnErrorsByConversation((current) => {
      if (!(conversationId in current)) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setAgentTurnStatusByConversation((current) => {
      if (!(conversationId in current)) return current;
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }

  function agentWorkspaceStateRevision(): string {
    return agentWorkspaceStateRevisionValue;
  }

  function agentUiStatePayload(waveformImage?: string): Record<string, unknown> {
    const ws = agentWorkspaceState();
    const stateRevision = agentWorkspaceStateRevision();
    const recordingFingerprint = String(metadata?.recording_fingerprint || '').trim().toLowerCase();
    const recordingResourceScope = {
      state_revision: stateRevision,
      ...(/^[a-f0-9]{64}$/.test(recordingFingerprint)
        ? {
            recording_id: `recording-${recordingFingerprint.slice(0, 24)}`,
            recording_sha256: recordingFingerprint,
          }
        : {}),
    };
    const activeRunEvents = activeRunId ? (runEventsByRun[activeRunId] || reviewEvents) : reviewEvents;
    const agentReviewEvents = activeRunEvents.length ? activeRunEvents : reviewEvents;
    const payload: Record<string, unknown> = {
      session_id: ws.session_id,
      state_revision: stateRevision,
      resource_scope: recordingResourceScope,
      active_panel: ws.activePanel,
      agent_autonomy: agentAutonomyRef.current,
      recording: recordingPath
        ? {
            loaded: true,
            path: recordingPath,
            duration_seconds: metadata?.duration_seconds ?? metadata?.length_seconds ?? null,
            channel_count: metadata?.channel_names?.length ?? metadata?.n_channels ?? metadata?.num_channels ?? null,
            sampling_rate: metadata?.sample_freq ?? metadata?.sampling_frequency ?? metadata?.sample_frequency_hz ?? null,
            eeg_type: metadata?.eeg_type ?? null,
            recording_fingerprint: /^[a-f0-9]{64}$/.test(recordingFingerprint) ? recordingFingerprint : null,
          }
        : { loaded: false },
      viewport: ws.viewport,
      channels: ws.channels,
      selected_channel: ws.selectedChannel,
      selected_event: ws.selectedEvent,
      selected_run: ws.selectedRun,
      events: ws.events,
      runs: ws.runs,
      review: compactReviewStateForAgent(agentReviewEvents, selectedReviewEventId, activeRunId),
      waveform: waveformControls,
      // ── The panels/results the agent SETS and must be able to read back (observability) ──
      prepare: compactPrepareControlsForAgent(prepareControls),
      classify: compactClassifierControlsForAgent(classifierControls),
      analysis: compactRecordingAnalysisForAgent(recordingAnalysis),
      severity: compactSeverityForAgent(severityState),
      runs_detail: compactRunsForAgent(runRecords, acceptedRunId, visibleRunIds, activeRunId),
      operation: compactOperationForAgent(runtimeOperation),
      messages: { status: (statusMessage || '').slice(0, 200), review: (reviewMessage || '').slice(0, 200) },
      active_dialog: uiSurfaceRef.current.dialog,
      active_tab: uiSurfaceRef.current.tab,
      agent_tab: uiSurfaceRef.current.agentTab,
      project: { path: projectPath, dirty: projectDirty }
    };
    // Attach a PNG snapshot of the live waveform so the agent can LOOK at it via inspect_waveform.
    // Only when the user's message is about what's on screen — base64 is heavy, keep normal turns lean.
    if (waveformImage) payload.waveform_image = waveformImage;
    return payload;
  }

  // Heuristic: does this message want the agent to visually inspect the waveform?
  function messageWantsWaveformVision(text: string): boolean {
    return /\b(see|look|show|view|screen|waveform|trace|morpholog|artifact|artefact|spike|hfo|oscillat|ripple|wave)\b/i.test(text)
      || /看|屏幕|波形|图|伪迹|尖波|振荡/.test(text);
  }

  // The SAME agent command can arrive via two independent channels — the public SSE ui_command event AND the
  // UI-broker poll — each with its own per-scope `seen` set. Dedupe centrally by command_id so one
  // emit_ui_command never records (or executes) twice — the "2 actions awaiting approval" duplicate-card bug.
  const recordedCommandIdsRef = useRef<Set<string>>(new Set());
  const commandUiThreadIdsRef = useRef<Map<string, string>>(new Map());
  // Handler-layer outcome for the command currently executing. validateUICommand decides
  // applied/rejected/staged BEFORE the handler runs; this captures whether the handler ITSELF then
  // no-op'd (e.g. a non-numeric viewport that passed validation but moved nothing) so the ack — and
  // the agent — learn it did nothing, closing the loop past validation.
  const commandOutcomeRef = useRef<{ status: string; reason: string | null }>({ status: 'applied', reason: null });
  // What UI surface is currently open (dialog / workflow tab / agent-panel tab), reported up from
  // MainWindowShell so get_ui_state can tell the agent what it actually opened (active_panel alone is
  // always 'workspace'). Ref-backed to avoid re-renders; read lazily when building the broker payload.
  const uiSurfaceRef = useRef<{ dialog: string | null; tab: string; agentTab: string | null }>({ dialog: null, tab: 'Prepare', agentTab: null });
  const handleUiSurfaceChange = useCallback((surface: { dialog: string | null; tab: string; agentTab: string | null }) => {
    uiSurfaceRef.current = surface;
  }, []);
  function recordUICommand(command: UICommand, source: UICommandSource = 'agent', uiThreadId?: string) {
    if (recordedCommandIdsRef.current.has(command.command_id)) {
      // The broker poll can win the race against this turn's SSE event. The SSE callback carries the
      // immutable UI thread scope, so retain that stronger routing fact even though the card is deduped.
      if (uiThreadId) commandUiThreadIdsRef.current.set(command.command_id, uiThreadId);
      return null;
    }
    recordedCommandIdsRef.current.add(command.command_id);
    if (recordedCommandIdsRef.current.size > 400) {
      recordedCommandIdsRef.current = new Set([...recordedCommandIdsRef.current].slice(-200));
    }
    const workspace = agentWorkspaceState();
    const commandContract = asRecord(command.contract);
    const resolvedUiThreadId = uiThreadId
      || agentConversations.find((entry) => agentConversationId(entry.id) === command.conversation_id)?.id
      || activeAgentConversationId;
    commandUiThreadIdsRef.current.set(command.command_id, resolvedUiThreadId);
    if (commandUiThreadIdsRef.current.size > 400) {
      commandUiThreadIdsRef.current = new Map([...commandUiThreadIdsRef.current].slice(-200));
    }
    commandAckContextRef.current.set(command.command_id, {
      sessionId: workspace.session_id,
      conversationId: command.conversation_id || agentConversationId(resolvedUiThreadId),
      stateRevision: command.state_revision || String(commandContract.state_revision || '') || agentWorkspaceStateRevision(),
    });
    if (commandAckContextRef.current.size > 400) {
      commandAckContextRef.current = new Map([...commandAckContextRef.current].slice(-200));
    }
    // The policy helper cannot enlarge authority: all current clinician-authorized writes return
    // false and stage. It remains centralized for a future broker-verified delegation contract.
    const confirmed = shouldPreconfirmUICommand(command.type, source, agentAutonomyRef.current);
    const entry = applyUICommand(command, workspace, source, { confirmed });
    setUiCommandHistory((current) => {
      const next = [...current, entry];
      // Cap history but NEVER evict a still-'staged' HITL command — its Apply/Dismiss
      // card is the only way to act on a pending clinical action, and unrelated
      // high-volume view/trace commands would otherwise push it off the front. Trim
      // only non-staged entries, oldest first, preserving insertion order.
      const stagedCount = next.filter((e) => e.status === 'staged').length;
      const maxOthers = Math.max(0, 80 - stagedCount);
      const othersCount = next.length - stagedCount;
      let toDrop = Math.max(0, othersCount - maxOthers);
      if (toDrop === 0) return next;
      return next.filter((e) => {
        if (e.status !== 'staged' && toDrop > 0) {
          toDrop -= 1;
          return false;
        }
        return true;
      });
    });
    // Async work owns its own running + terminal receipt. In particular, a review
    // write must never turn the validation-layer `applied/unchanged` snapshot into
    // a terminal success before its backend mutation has even returned.
    if (entry.status !== 'applied' || !entryStartsAsyncOperation(entry)) {
      ackUICommand(entry.command.command_id, { status: entry.status, command_type: entry.command.type, diff_state: entry.diffState, timestamp: entry.timestamp });
    }
    return entry;
  }

  function withDesktopApprovalActor(
    outcome: Record<string, unknown>,
    context?: AgentCommandAckContext,
  ): Record<string, unknown> {
    const workspace = agentWorkspaceState();
    return bindDesktopApprovalContext(
      outcome,
      context,
      workspace.session_id,
      shortStableHash(agentConversationSessionRef.current),
      agentConversationId(),
      agentWorkspaceStateRevision(),
    );
  }

  function ackUICommand(commandId: string, outcome: Record<string, unknown>) {
    if (!commandId.startsWith('mcp-')) return;
    brokerAckRef.current(commandId, outcome);
  }
  brokerAckRef.current = (commandId: string, outcome: Record<string, unknown>) => {
    if (!commandId.startsWith('mcp-')) return;
    const context = commandAckContextRef.current.get(commandId);
    const request = {
      command_id: commandId,
      outcome: withDesktopApprovalActor(outcome, context),
    };
    // Receipt delivery is part of the clinical command contract, not telemetry. Retry one
    // idempotent ACK and surface a persistent failure instead of leaving a command silently
    // stuck in `running` while the workspace looks complete.
    void backendClient.uiBrokerAck(request).catch(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      try {
        await backendClient.uiBrokerAck(request);
      } catch (error) {
        const message = `Could not persist the Agent command receipt for ${commandId}: ${error instanceof Error ? error.message : String(error)}`;
        setError(message);
        setStatusMessage('Agent command receipt delivery failed; retry the command after checking the local broker.');
        logRuntime('error', message);
      }
    });
  };

  function closeAgentCommandWithoutOperation(opts: { agentInitiated?: boolean; commandId?: string }, label: string, status: 'complete' | 'failed', detail: string) {
    if (opts.commandId) ackUICommand(opts.commandId, { status, label, detail, finished_at: new Date().toISOString() });
    if (opts.agentInitiated) notifyAgentOfRunResult({ label, status, detail }, opts.commandId ? commandUiThreadIdsRef.current.get(opts.commandId) : undefined);
  }

  function entryStartsAsyncOperation(entry: HistoryEntry | null): boolean {
    if (!entry || entry.status !== 'applied') return false;
    const risk = uiCommandPolicy(entry.command.type)?.risk;
    return risk === 'analysis' || risk === 'compute' || risk === 'artifact_write' || risk === 'review_write' || risk === 'destructive';
  }

  // Surface the OUTCOME of a recorded agent command so agent->UI control is closed-loop. Applied ->
  // execute. Rejected -> tell the user WHY (a stale/invalid channel/event/run target, or a missing
  // recording, used to be a silent no-op the agent reported as success). 'staged' already surfaces
  // via the Apply card. Returns a compact outcome the broker ack relays back so the agent can learn
  // and self-correct instead of narrating success of a command the renderer dropped.
  function applyRecordedEntry(entry: HistoryEntry | null) {
    if (!entry) return null;
    if (entry.status === 'applied') {
      executeAppliedUICommand(entry.command);
      // executeAppliedUICommand resets commandOutcomeRef to 'applied' and a no-op guard inside it may
      // downgrade it to 'noop' (+reason). Surface + relay that refined handler-layer outcome so a
      // command that passed validation but changed nothing stops reading as success.
      const outcome = commandOutcomeRef.current;
      if (entryStartsAsyncOperation(entry) && outcome.status === 'applied') {
        return { status: 'running', reason: null };
      }
      if (outcome.status !== 'applied') {
        setStatusMessage(`Agent UI command had no effect — ${entry.command.type}: ${outcome.reason || 'no change'}.`);
        logRuntime('warning', `Agent UI command no-op: ${entry.command.type} (${outcome.reason || 'no change'}).`);
      }
      ackUICommand(entry.command.command_id, { status: outcome.status, reason: outcome.reason, command_type: entry.command.type, timestamp: new Date().toISOString() });
      return { status: outcome.status, reason: outcome.reason };
    }
    if (entry.status === 'rejected') {
      const reason = entry.reason || 'blocked by current workspace state';
      setStatusMessage(`Agent UI command not applied — ${entry.command.type}: ${reason}.`);
      logRuntime('warning', `Agent UI command rejected: ${entry.command.type} (${reason}).`);
    }
    ackUICommand(entry.command.command_id, { status: entry.status, reason: entry.reason ?? null, command_type: entry.command.type, timestamp: new Date().toISOString() });
    return { status: entry.status, reason: entry.reason ?? null };
  }

  // The transcript shows the conversation and nothing else. Plan/command envelopes the model
  // printed instead of tool-calling are stripped from the bubble -- and any UI command found in
  // that text is executed, so a command the model typed behaves like one it called (the workspace
  // runs it, with the same progress the user gets from clicking).
  /** Append to an immutable UI thread id; a closed thread is never recreated by a late callback. */
  function appendToConversation(uiThreadId: string, message: AgentChatMessage) {
    setAgentConversations((current) => appendAgentConversationMessage(current, uiThreadId, message));
  }

  function appendAgentReply(uiThreadId: string, rawText: string) {
    const filtered = filterAgentReply(rawText);
    filtered.commands.forEach((command) => {
      const entry = recordUICommand(
        {
          command_id: `text-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          type: command.type,
          payload: command.payload,
          reason: 'Agent wrote this command in its reply instead of calling the tool.',
        },
        'agent',
        uiThreadId,
      );
      applyRecordedEntry(entry);
    });
    if (filtered.text) appendToConversation(uiThreadId, { role: 'agent' as const, text: filtered.text, ts: Date.now() });
    else if (filtered.commands.length) {
      logRuntime('info', `Agent reply carried ${filtered.commands.length} inline UI command(s) and no prose.`);
    }
  }

  function ingestAgentUICommands(response: unknown, uiThreadId: string): { count: number; waitingForOperation: boolean } {
    const commands = extractAgentUICommands(response);
    let waitingForOperation = false;
    commands.forEach((command) => {
      const entry = recordUICommand(command, 'agent', uiThreadId);
      applyRecordedEntry(entry);
      if (entryStartsAsyncOperation(entry)) waitingForOperation = true;
    });
    return { count: commands.length, waitingForOperation };
  }

  // Ingest ONE public agent command, de-duplicated by id so a streamed ui_command and the isolated
  // legacy done.ui_commands adapter never double-execute the same command.
  function ingestAgentCommandObject(raw: unknown, seen: Set<string>, uiThreadId: string): HistoryEntry | null {
    const command = normalizeAgentCommand(raw);
    if (!command || seen.has(command.command_id)) return null;
    seen.add(command.command_id);
    const entry = recordUICommand(command, 'agent', uiThreadId);
    applyRecordedEntry(entry);
    return entry;
  }

  // Drive one agent turn over the live SSE bridge. Public ui_command events are applied immediately;
  // internal tool/reasoning events never enter the renderer. Rejects ONLY if the stream fails to start
  // (so the caller can fall back to the job poll).
  function runStreamingAgentTurn(prompt: string, turnScope: AgentTurnScope, opts: { suppressIfUserTurnEpochChanged?: number; showStreaming?: boolean; allowUiCommands?: boolean; stateRevision?: string } = {}): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const seen = new Set<string>();
      let count = 0;
      let started = false;
      let settled = false;
      let streamId = '';
      let replyText = '';
      let waitingForOperation = false;
      let pendingStreamError: Error | null = null;
      let unsubscribe: (() => void) | null = null;
      let router: ReturnType<typeof createAgentStreamRouter> | null = null;
      const timeout = window.setTimeout(() => finish(new Error('Agent stream timed out before terminal done.')), 180000);
      const suppressed = () => opts.suppressIfUserTurnEpochChanged !== undefined && agentUserTurnEpoch.current !== opts.suppressIfUserTurnEpochChanged;
      function finish(err?: Error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (unsubscribe) unsubscribe();
        if (router) router.dispose();
        // Abort the backend stream so an abandoned turn (timeout/error/superseded) stops
        // generating and stops emitting on the shared 'agent:event' channel. Best-effort:
        // a naturally-finished stream has no live controller in main, so this is a no-op.
        if (streamId) { try { backendClient.cancelAgentStream(streamId); } catch { /* best effort */ } }
        if (suppressed()) { resolve(count); return; }
        if (err && !started) { reject(err); return; }
        // A stream that started and then died used to report only through an unscoped error banner, so
        // the thread showed the question with no answer and no reason. Say it where it was asked.
        if (err) {
          setAgentTurnError(turnScope.uiThreadId, err.message);
          appendToConversation(turnScope.uiThreadId, { role: 'observation' as const, text: `This turn failed. ${err.message}`, ts: Date.now() });
        }
        if (!err) setAgentTurnError(turnScope.uiThreadId, null);
        if (!err && replyText.trim() && !waitingForOperation) appendAgentReply(turnScope.uiThreadId, replyText);
        if (opts.showStreaming !== false) {
          // Retire the live streaming bubble in the same commit the final card is appended, so the
          // transcript swaps atomically (no one-frame duplicate of the reply).
          setBusyConversationId((current) => current === turnScope.uiThreadId ? null : current);
          setAgentTurnStreamingText(turnScope.uiThreadId, '');
          setAgentTurnStatus(turnScope.uiThreadId, err
            ? `Agent turn failed: ${err.message}`
            : waitingForOperation
              ? `Agent requested ${count} UI command(s); waiting for operation result.`
              : `Agent response received: ${count} UI command(s) ingested.`);
        }
        resolve(count);
      }
      // Route frames through a buffer-until-streamId-known router. The listener is registered
      // before this turn's streamId is known (it arrives when streamAgentMessage resolves), so
      // the naive `payload.streamId !== streamId` filter fails open in that window and would let
      // a previous, abandoned turn's late frames bleed in. The router defers frames until the id
      // is known, then replays only the matching ones.
      router = createAgentStreamRouter((payload) => {
        started = true;
        const data = asRecord(payload.data);
        if (payload.event === 'content') {
          const text = String(data.text || data.content || '');
          if (text && !suppressed()) {
            // Canonical content explicitly declares replacement vs delta semantics. Legacy frames
            // omit `replace` and retain the old delta behavior.
            replyText = data.replace === true ? text : replyText + text;
            // Stream the partial reply straight into the transcript bubble (not the status strip).
            if (opts.showStreaming !== false) {
              setAgentTurnStreamingText(turnScope.uiThreadId, replyText);
            }
          }
        } else if (payload.event === 'ui_command') {
          if (!suppressed() && opts.allowUiCommands !== false) {
            const entry = ingestAgentCommandObject(data, seen, turnScope.uiThreadId);
            if (entry) {
              count += 1;
              if (entryStartsAsyncOperation(entry)) waitingForOperation = true;
            }
          }
        } else if (payload.event === 'status' || payload.event === 'public_progress') {
          const progress = String(data.message || '');
          if (progress && !suppressed() && opts.showStreaming !== false) setAgentTurnStatus(turnScope.uiThreadId, progress);
        } else if (payload.event === 'done') {
          const outcome = typeof data.outcome === 'string' ? data.outcome : 'completed'; // isolated legacy fallback
          const terminalError = asRecord(data.error);
          if (outcome !== 'completed' || pendingStreamError) {
            const fallback = outcome === 'cancelled' ? 'Agent turn was cancelled.' : 'Agent turn failed.';
            finish(new Error(String(terminalError.message || pendingStreamError?.message || fallback)));
            return;
          }
          // Compatibility only: canonical ui_command events arrive independently; old runtimes put
          // commands on done. Dedupe prevents a dual-emitting migration runtime from applying twice.
          const cmds = Array.isArray(data.ui_commands) ? data.ui_commands : [];
          if (!suppressed() && opts.allowUiCommands !== false) cmds.forEach((raw) => {
            const entry = ingestAgentCommandObject(raw, seen, turnScope.uiThreadId);
            if (entry) {
              count += 1;
              if (entryStartsAsyncOperation(entry)) waitingForOperation = true;
            }
          });
          if (typeof data.final_content === 'string') {
            replyText = data.final_content;
          } else {
            const finalText = String(data.content || data.text || data.answer || data.final_answer || '');
            if (finalText.trim().length > replyText.trim().length) replyText = finalText;
          }
          finish();
        } else if (payload.event === 'end') {
          finish(pendingStreamError || new Error('Agent stream ended without terminal done event.'));
        } else if (payload.event === 'error') {
          const streamError = new Error(String(data.message || 'Agent stream error.'));
          // A typed public error is diagnostic and must be followed by done(failed|cancelled).
          // Untyped errors are Electron transport failures and are terminal immediately.
          if (typeof data.code === 'string' && typeof data.retryable === 'boolean') {
            pendingStreamError = streamError;
            if (!suppressed() && opts.showStreaming !== false) setAgentTurnStatus(turnScope.uiThreadId, streamError.message);
          } else {
            finish(streamError);
          }
        }
      });
      unsubscribe = backendClient.onAgentEvent((payload) => router?.push(payload));
      backendClient.streamAgentMessage({ message: prompt, conversation_id: turnScope.backendConversationId, recording_path: recordingPath, state_revision: opts.stateRevision })
        .then((res) => {
          streamId = String(asRecord(res).streamId || '');
          router?.resolve(streamId);
          // If the turn already settled before this resolved (e.g. the 180s timeout fired first),
          // finish() ran with no streamId and couldn't cancel. Abort the backend stream now so it
          // isn't left generating and emitting on the shared channel.
          if (settled) {
            if (streamId) { try { backendClient.cancelAgentStream(streamId); } catch { /* best effort */ } }
            return;
          }
          if (!suppressed() && opts.showStreaming !== false) setAgentTurnStatus(turnScope.uiThreadId, 'Agent is thinking… (streaming)');
        })
        .catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
    });
  }

  async function pollAgentChatResult(jobId: string, turnScope: AgentTurnScope, maxAttempts = 180): Promise<unknown> {
    setAgentTurnStatus(turnScope.uiThreadId, 'Agent is thinking… waiting for backend UI commands.');
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const result = await backendClient.getAgentChatResult(jobId);
      const record = asRecord(result);
      if (record.status === 'complete') return record.result ?? result;
      if (record.status === 'error') throw new Error(formatAgentChatError(record.error));
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error(`Agent chat timed out while waiting for job ${jobId}.`);
  }

  async function applyStagedUICommand(commandId: string): Promise<void> {
    if (pendingCommandApprovalsRef.current.has(commandId)) {
      setStatusMessage(`Authorization is already pending for ${commandId}.`);
      return;
    }
    const staged = uiCommandHistory.find((entry) => entry.command.command_id === commandId && entry.status === 'staged');
    if (!staged) {
      setStatusMessage(`No staged UI command found for ${commandId}.`);
      return;
    }
    const workspace = agentWorkspaceState();
    const existingContext = commandAckContextRef.current.get(commandId);
    // A chat-tab switch changes only presentation. Keep the command's immutable originating
    // conversation in the authorization scope while reading live session/state for freshness.
    const currentScope = {
      ...liveAgentCommandScopeRef.current,
      conversationId: existingContext?.conversationId || liveAgentCommandScopeRef.current.conversationId,
    };
    const scopeError = stagedCommandScopeError(existingContext, currentScope);
    if (scopeError) {
      const rejected: HistoryEntry = {
        ...staged,
        status: 'rejected',
        diffState: 'blocked',
        after: structuredClone(workspace),
        timestamp: new Date().toISOString(),
        reason: scopeError,
      };
      ackUICommand(commandId, {
        status: 'rejected',
        command_type: staged.command.type,
        reason: scopeError,
        timestamp: rejected.timestamp,
      });
      setUiCommandHistory((current) => current.map((entry) => entry.command.command_id === commandId && entry.status === 'staged' ? rejected : entry));
      setStatusMessage(`Agent command was not executed — ${scopeError}`);
      logRuntime('warning', `Rejected stale staged Agent command before authorization: ${staged.command.type} (${scopeError}).`);
      return;
    }
    const capturedContext = existingContext as AgentCommandAckContext;
    const approvalContext: AgentCommandAckContext = {
      ...capturedContext,
      humanApprovalNonce: capturedContext.humanApprovalNonce || globalThis.crypto.randomUUID(),
    };
    commandAckContextRef.current.set(commandId, approvalContext);
    const applied = applyUICommand({ ...staged.command, requires_confirmation: false }, agentWorkspaceState(), staged.source, { confirmed: true });
    if (applied.status !== 'applied') {
      ackUICommand(applied.command.command_id, {
        status: applied.status,
        reason: applied.reason,
        command_type: applied.command.type,
        timestamp: applied.timestamp,
      });
      setUiCommandHistory((current) => current.map((entry) => entry.command.command_id === commandId && entry.status === 'staged' ? applied : entry));
      setStatusMessage(`Rejected staged Agent command: ${applied.command.type}.`);
      return;
    }

    pendingCommandApprovalsRef.current.add(commandId);
    try {
      const authorizationOutcome = withDesktopApprovalActor({
        status: 'applied',
        command_type: applied.command.type,
        diff_state: applied.diffState,
        timestamp: applied.timestamp,
      }, approvalContext);
      const execution = await authorizeAndExecuteFreshStagedCommand({
        commandId,
        outcome: authorizationOutcome,
        capturedScope: approvalContext,
        readCurrentScope: () => ({
          ...liveAgentCommandScopeRef.current,
          conversationId: approvalContext.conversationId,
        }),
        acknowledge: (request) => backendClient.uiBrokerAck(request),
        rejectAuthorized: (reason) => backendClient.uiBrokerAck({
          command_id: commandId,
          outcome: withDesktopApprovalActor({
            status: 'rejected',
            command_type: applied.command.type,
            reason,
            timestamp: new Date().toISOString(),
          }, approvalContext),
        }),
        execute: () => executeAppliedUICommand(applied.command),
      });
      if (!execution.executed) {
        const rejected: HistoryEntry = {
          ...staged,
          status: 'rejected',
          diffState: 'blocked',
          after: structuredClone(agentWorkspaceState()),
          timestamp: new Date().toISOString(),
          reason: execution.scopeError || 'The command scope changed during authorization.',
        };
        setUiCommandHistory((current) => current.map((entry) => entry.command.command_id === commandId && entry.status === 'staged' ? rejected : entry));
        setStatusMessage(`Agent command was not executed — ${rejected.reason}`);
        logRuntime('warning', `Rejected staged Agent command after authorization scope changed: ${applied.command.type} (${rejected.reason}).`);
        return;
      }
    } catch (authorizationError) {
      const reason = authorizationError instanceof Error ? authorizationError.message : String(authorizationError);
      setStatusMessage(`Agent command was not executed — authorization failed: ${reason}`);
      logRuntime('warning', `Staged Agent command authorization failed before execution: ${applied.command.type} (${reason}).`);
      return;
    } finally {
      pendingCommandApprovalsRef.current.delete(commandId);
    }

    const handlerOutcome = commandOutcomeRef.current;
    if (!entryStartsAsyncOperation(applied) || handlerOutcome.status !== 'applied') {
      ackUICommand(applied.command.command_id, {
        status: handlerOutcome.status,
        reason: handlerOutcome.reason,
        command_type: applied.command.type,
        ...(handlerOutcome.status === 'applied' ? { diff_state: applied.diffState } : {}),
        timestamp: applied.timestamp
      });
    }
    setUiCommandHistory((current) => current.map((entry) => entry.command.command_id === commandId && entry.status === 'staged' ? applied : entry));
    setStatusMessage(applied.status === 'applied' ? `Applied staged Agent command: ${applied.command.type}.` : `Rejected staged Agent command: ${applied.command.type}.`);
  }

  function dismissStagedUICommand(commandId: string) {
    const staged = uiCommandHistory.find((entry) => entry.command.command_id === commandId && entry.status === 'staged');
    if (staged) ackUICommand(commandId, { status: 'dismissed', command_type: staged.command.type, timestamp: new Date().toISOString() });
    setUiCommandHistory((current) => current.map((entry) => entry.command.command_id === commandId && entry.status === 'staged'
      ? { ...entry, status: 'dismissed', diffState: 'unchanged', timestamp: new Date().toISOString() }
      : entry));
  }

  function activeReviewEventsForAgentCommand(): ReviewEvent[] {
    const activeEvents = activeRunId ? runEventsByRun[activeRunId] : undefined;
    if (activeEvents?.length) return activeEvents;
    if (reviewEvents.length) return reviewEvents;
    return Object.values(runEventsByRun).flat();
  }

  function resolveReviewEventForAgentCommand(eventId: unknown): ReviewEvent | undefined {
    const id = String(eventId || selectedReviewEventId || '').trim();
    const events = activeReviewEventsForAgentCommand();
    if (id) {
      const found = events.find((event) => event.event_id === id) || Object.values(runEventsByRun).flat().find((event) => event.event_id === id);
      if (found) return found;
    }
    return events.find((event) => event.event_id === selectedReviewEventId) || events[0];
  }

  function payloadNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function payloadPositiveNumber(value: unknown): number | undefined {
    const parsed = payloadNumber(value);
    return parsed !== undefined && parsed > 0 ? parsed : undefined;
  }

  function payloadBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : undefined;
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return undefined;
  }

  function payloadChannels(payload: Record<string, unknown>): string[] {
    const channels = stringArray(payload.channels)
      || stringArray(payload.visible_channels)
      || stringArray(payload.visibleChannels)
      || (typeof payload.channel === 'string' && payload.channel.trim() ? [payload.channel.trim()] : undefined)
      || [];
    if (!channels.length) return [];
    const universe = channelNames(metadata);
    return universe.length ? channels.filter((channel) => universe.includes(channel)) : channels;
  }

  function eventDurationSeconds(event: ReviewEvent): number {
    const explicit = Number(event.duration_seconds);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const start = Number(event.start_seconds);
    const end = Number(event.end_seconds);
    return Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0;
  }

  function representativeEventForChannel(events: ReviewEvent[], channel: string): ReviewEvent | undefined {
    return events
      .filter((event) => event.channel === channel)
      .sort((left, right) => eventDurationSeconds(right) - eventDurationSeconds(left) || Number(left.start_seconds || 0) - Number(right.start_seconds || 0))[0];
  }

  function waveformControlsCenteredOnEvent(event: ReviewEvent, baseControls: WaveformControlsState, windowSeconds?: number): WaveformControlsState {
    const nextControls = { ...baseControls };
    if (windowSeconds && windowSeconds > 0) nextControls.timeWindowSeconds = windowSeconds;
    const midSeconds = Number(event.start_seconds ?? 0) + Math.max(0, eventDurationSeconds(event)) / 2;
    if (Number.isFinite(midSeconds)) {
      nextControls.startSeconds = Math.max(0, midSeconds - nextControls.timeWindowSeconds / 2);
    }
    if (event.channel) {
      nextControls.annotationChannel = event.channel;
      nextControls.channelsToPlot = [event.channel, ...nextControls.channelsToPlot.filter((channel) => channel !== event.channel)];
      nextControls.channelFocusMode = 'events';
    }
    return clampWaveformControls(nextControls, metadata);
  }

  function applyWaveformControlsFromAgent(nextControls: WaveformControlsState, message: string) {
    const clampedControls = clampWaveformControls(nextControls, metadata);
    // Honesty guard: if the computed controls equal the current ones, the command changed nothing
    // (empty payload, mis-keyed/aliased fields, or a value already in effect). Downgrade to 'noop' so
    // the agent learns it didn't move the UI instead of reading the broker 'applied' as success.
    if (JSON.stringify(clampedControls) === JSON.stringify(clampWaveformControls(waveformControls, metadata))) {
      commandOutcomeRef.current = { status: 'noop', reason: 'waveform is already in the requested state — no recognized change in the payload' };
      return;
    }
    setWaveformControls(clampedControls);
    void updatePlot(clampedControls);
    markWorkspaceDirty();
    setStatusMessage(message);
  }

  function resetWaveformViewFromAgent() {
    applyWaveformControlsFromAgent({
      ...waveformControls,
      channelStartIndex: 0,
      startSeconds: 0,
      normalizeVertically: false,
      showFiltered: false,
      filter60Hz: false,
      montageMode: 'referential',
      channelFocusMode: 'all',
      cursorEnabled: false,
      measureEnabled: false
    }, 'Agent reset the waveform view.');
  }

  function setWaveformDisplayFromAgent(payload: Record<string, unknown>) {
    const nextControls = { ...waveformControls };
    const startSeconds = payloadNumber(payload.start_seconds ?? payload.startSeconds);
    const durationSeconds = payloadPositiveNumber(payload.duration_seconds ?? payload.time_window_seconds ?? payload.timeWindowSeconds);
    const visibleChannels = optionalPositiveInteger(payload.visible_channels ?? payload.visibleChannels);
    const amplitudeScale = payloadPositiveNumber(payload.amplitude_scale ?? payload.amplitudeScale ?? payload.scale);
    const channelList = payloadChannels(payload);
    if (startSeconds !== undefined) nextControls.startSeconds = startSeconds;
    if (durationSeconds !== undefined) nextControls.timeWindowSeconds = durationSeconds;
    if (visibleChannels !== undefined) nextControls.visibleChannels = visibleChannels;
    if (amplitudeScale !== undefined) nextControls.amplitudeScale = amplitudeScale;
    if (channelList.length) {
      nextControls.channelsToPlot = channelList;
      nextControls.channelStartIndex = 0;
    }
    const showFiltered = payloadBoolean(payload.show_filtered ?? payload.showFiltered);
    const filter60Hz = payloadBoolean(payload.filter_60hz ?? payload.filter60Hz);
    const normalizeVertically = payloadBoolean(payload.normalize_vertically ?? payload.normalizeVertically);
    const cursorEnabled = payloadBoolean(payload.cursor_enabled ?? payload.cursorEnabled);
    const measureEnabled = payloadBoolean(payload.measure_enabled ?? payload.measureEnabled);
    if (showFiltered !== undefined) nextControls.showFiltered = showFiltered;
    if (filter60Hz !== undefined) nextControls.filter60Hz = filter60Hz;
    if (normalizeVertically !== undefined) nextControls.normalizeVertically = normalizeVertically;
    if (cursorEnabled !== undefined) nextControls.cursorEnabled = cursorEnabled;
    if (measureEnabled !== undefined) nextControls.measureEnabled = measureEnabled;
    const requestedMontage = normalizeMontageMode(payload.montage_mode) ?? normalizeMontageMode(payload.montageMode);
    if (requestedMontage) nextControls.montageMode = requestedMontage;
    if (payload.channel_focus_mode === 'all' || payload.channel_focus_mode === 'highlight' || payload.channel_focus_mode === 'neighbors' || payload.channel_focus_mode === 'clean' || payload.channel_focus_mode === 'events') nextControls.channelFocusMode = payload.channel_focus_mode;
    if (payload.channelFocusMode === 'all' || payload.channelFocusMode === 'highlight' || payload.channelFocusMode === 'neighbors' || payload.channelFocusMode === 'clean' || payload.channelFocusMode === 'events') nextControls.channelFocusMode = payload.channelFocusMode;
    applyWaveformControlsFromAgent(nextControls, 'Agent updated waveform display.');
  }

  function setChannelVisibilityFromAgent(payload: Record<string, unknown>) {
    const channelList = payloadChannels(payload);
    const visibleChannels = optionalPositiveInteger(payload.visible_channels ?? payload.visibleChannels ?? payload.count);
    if (!channelList.length && visibleChannels === undefined) {
      commandOutcomeRef.current = { status: 'noop', reason: 'no loaded channels named and no visible-channel count — pass {channels:[...]} or {visible_channels:N}' };
      setStatusMessage('Agent channel visibility command did not name channels or a visible channel count.');
      return;
    }
    applyWaveformControlsFromAgent({
      ...waveformControls,
      channelsToPlot: channelList.length ? channelList : waveformControls.channelsToPlot,
      visibleChannels: visibleChannels ?? (channelList.length || waveformControls.visibleChannels),
      channelStartIndex: 0,
      channelFocusMode: channelList.length ? 'highlight' : waveformControls.channelFocusMode
    }, channelList.length ? `Agent limited waveform display to ${channelList.length} channel(s).` : `Agent set waveform display to ${visibleChannels} visible channel(s).`);
  }

  function focusTopCandidateChannelFromAgent(payload: Record<string, unknown>) {
    const biomarker = String(payload.biomarker || '').trim().toLowerCase();
    const events = activeReviewEventsForAgentCommand().filter((event) => !biomarker || String(event.biomarker || '').toLowerCase() === biomarker);
    if (!events.length) {
      commandOutcomeRef.current = { status: 'noop', reason: biomarker ? `no loaded events match biomarker "${biomarker}" — nothing to focus` : 'no loaded detection events — run detection first' };
      setStatusMessage('Agent requested the top candidate channel, but no loaded detection events are available.');
      return;
    }
    const requestedChannel = typeof payload.channel === 'string' ? payload.channel.trim() : '';
    const ranking = rankReviewChannels(events).filter((row) => row.channel !== '--');
    const topChannel = requestedChannel || ranking[0]?.channel || '';
    if (!topChannel) {
      commandOutcomeRef.current = { status: 'noop', reason: 'loaded events have no channel labels — cannot pick a top candidate channel' };
      setStatusMessage('Agent requested the top candidate channel, but the loaded events have no channel labels.');
      return;
    }
    const matchingEvents = events.filter((event) => event.channel === topChannel);
    const representative = representativeEventForChannel(events, topChannel) || matchingEvents[0];
    const visibleChannels = optionalPositiveInteger(payload.visible_channels ?? payload.visibleChannels) || 1;
    const windowSeconds = payloadPositiveNumber(payload.duration_seconds ?? payload.time_window_seconds ?? payload.timeWindowSeconds) || 2;
    const nextControls = representative
      ? waveformControlsCenteredOnEvent(representative, { ...waveformControls, visibleChannels, timeWindowSeconds: windowSeconds, channelsToPlot: [topChannel] }, windowSeconds)
      : clampWaveformControls({ ...waveformControls, annotationChannel: topChannel, channelsToPlot: [topChannel], visibleChannels, channelStartIndex: 0, channelFocusMode: 'events' }, metadata);
    if (representative) selectReviewEventForCursor(representative);
    applyWaveformControlsFromAgent(nextControls, `Agent focused ${topChannel}, top candidate channel (${matchingEvents.length || ranking[0]?.events || 0} event(s)).`);
  }

  function focusHotspotChannelsFromAgent(payload: Record<string, unknown>) {
    const biomarker = String(payload.biomarker || '').trim().toLowerCase();
    const events = activeReviewEventsForAgentCommand().filter((event) => !biomarker || String(event.biomarker || '').toLowerCase() === biomarker);
    const topN = optionalPositiveInteger(payload.top_n ?? payload.topN ?? payload.visible_channels ?? payload.visibleChannels) || 8;
    const channels = rankReviewChannels(events).filter((row) => row.channel !== '--').slice(0, topN).map((row) => row.channel);
    if (!channels.length) {
      commandOutcomeRef.current = { status: 'noop', reason: biomarker ? `no loaded events match biomarker "${biomarker}" — no hotspot channels to show` : 'no loaded detection events — run detection first' };
      setStatusMessage('Agent requested hotspot channels, but no loaded detection events are available.');
      return;
    }
    const representative = representativeEventForChannel(events, channels[0]);
    if (representative) selectReviewEventForCursor(representative);
    const windowSeconds = payloadPositiveNumber(payload.duration_seconds ?? payload.time_window_seconds ?? payload.timeWindowSeconds);
    const baseControls = {
      ...waveformControls,
      channelsToPlot: channels,
      visibleChannels: channels.length,
      channelStartIndex: 0,
      annotationChannel: channels[0],
      channelFocusMode: 'events' as WaveformControlsState['channelFocusMode'],
      timeWindowSeconds: windowSeconds || waveformControls.timeWindowSeconds
    };
    const nextControls = representative ? waveformControlsCenteredOnEvent(representative, baseControls, windowSeconds) : clampWaveformControls(baseControls, metadata);
    applyWaveformControlsFromAgent(nextControls, `Agent focused top ${channels.length} hotspot channel(s): ${channels.join(', ')}.`);
  }

  function executeAppliedUICommand(command: UICommand) {
    // Default outcome = applied; a no-op guard below downgrades it to 'noop' (+reason) so
    // applyRecordedEntry can relay the real handler-layer result in the ack.
    commandOutcomeRef.current = { status: 'applied', reason: null };
    if (command.type === 'workspace.open_panel') {
      setPendingShellCommand(command);
      setStatusMessage(`Agent requested workspace panel: ${String(command.payload.panel || command.payload.dialog || command.payload.tab || command.payload.target || 'workspace')}.`);
      return;
    }
    if (command.type === 'workspace.show_toast' || command.type === 'agent.show_trace_step') {
      setStatusMessage(String(command.payload.message || command.reason || 'Agent updated the workspace.'));
      return;
    }
    if (command.type === 'workspace.reset_waveform_view') {
      resetWaveformViewFromAgent();
      return;
    }
    if (command.type === 'recording.open') {
      const path = String(command.payload.input_path || '');
      if (!path) {
        setStatusMessage('Agent recording.open command is missing input_path.');
        return;
      }
      const operation = beginOperation('Agent load recording', 'recording', { agentInitiated: true, commandId: command.command_id });
      void loadSelectedRecording(path, operation, 'recent')
        .then(() => finishOperation(operation, 'success', 'Agent-loaded recording and waveform viewport initialized.'))
        .catch((exc) => {
          const message = exc instanceof Error ? exc.message : String(exc);
          setError(message);
          setStatusMessage('Agent recording load failed.');
          finishOperation(operation, 'error', message);
        });
      return;
    }
    if (command.type === 'recording.inspect_metadata') {
      setPendingShellCommand(command);
      setStatusMessage('Agent opened recording metadata.');
      return;
    }
    if (command.type === 'recording.set_channel_visibility') {
      setChannelVisibilityFromAgent(command.payload);
      return;
    }
    if (['recording.infer_roi', 'analysis.run_qc', 'analysis.compute_spectral_profile'].includes(command.type)) {
      void analyzeRecordingPlanning({ agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'detection.plan') {
      void recommendDetectorPlanFromAgent(command.payload, { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'analysis.prepare_recording') {
      void applyFilters({ agentInitiated: true, commandId: command.command_id, agentCommand: command });
      return;
    }
    if (command.type === 'detection.set_parameters') {
      const nextPrepare = prepareControlsFromAgentCommand(command.payload, prepareControls);
      if (JSON.stringify(nextPrepare) === JSON.stringify(prepareControls)) {
        commandOutcomeRef.current = { status: 'noop', reason: 'no recognized detection parameter in the payload — Prepare controls unchanged (use filter.fp/filter.fs, line_noise_notch_hz, resample_sfreq, n_jobs)' };
        return;
      }
      setPrepareControls(nextPrepare);
      markWorkspaceDirty();
      setStatusMessage('Agent updated detection parameters in the Prepare panel.');
      return;
    }
    if (command.type === 'detection.run') {
      void runDetection(detectorRunRequestFromAgentCommand(command.payload), { agentInitiated: true, commandId: command.command_id, agentCommand: command }).catch((exc) => {
        setError(exc instanceof Error ? exc.message : String(exc));
      });
      return;
    }
    if (command.type === 'detection.rank_candidates' || command.type === 'detection.show_candidate_ranking') {
      // Ranking needs at least one run carrying a detector CSV artifact; without one the backend call is
      // skipped and nothing changes. Report that honestly (noop) instead of acking a silent success.
      if (!candidateRankingRunsFromRecords(runRecords).length) {
        commandOutcomeRef.current = { status: 'noop', reason: 'no detector run with a CSV artifact to rank — run detection (with CSV export) first' };
        setStatusMessage('Agent requested candidate ranking, but no detector run has a CSV artifact yet.');
        return;
      }
      // rank_candidates is a compute command (chat run card + loop closure); show_candidate_ranking is a
      // pure view refresh (no card). On completion the result lands in get_ui_state.analysis.candidate_ranking.
      void refreshCandidateChannelRanking(
        undefined,
        undefined,
        command.type === 'detection.rank_candidates' ? { agentInitiated: true, commandId: command.command_id } : undefined
      );
      setStatusMessage('Agent requested candidate channel ranking refresh.');
      return;
    }
    if (command.type === 'detection.focus_top_candidate_channel') {
      focusTopCandidateChannelFromAgent(command.payload);
      return;
    }
    if (command.type === 'waveform.focus_hotspot_channels') {
      focusHotspotChannelsFromAgent(command.payload);
      return;
    }
    if (command.type === 'detection.select_run') {
      activateRun(String(command.payload.run_id || ''));
      return;
    }
    if (command.type === 'classification.set_parameters') {
      const nextClassifier = classifierControlsFromAgentCommand(command.payload, classifierControls);
      if (JSON.stringify(nextClassifier) === JSON.stringify(classifierControls)) {
        commandOutcomeRef.current = { status: 'noop', reason: 'no recognized classification parameter in the payload — Classify controls unchanged (use mode, device, batch_size, use_spike, use_ehfo)' };
        return;
      }
      setClassifierControls(nextClassifier);
      markWorkspaceDirty();
      setStatusMessage('Agent updated classification parameters in the Classify panel.');
      return;
    }
    if (command.type === 'classification.run') {
      void runClassifier(classifierRunRequestFromAgentCommand(command.payload, classifierControls), { agentInitiated: true, commandId: command.command_id }).catch((exc) => {
        setError(exc instanceof Error ? exc.message : String(exc));
      });
      return;
    }
    if (command.type === 'severity.run') {
      void runSeverityScoring({ agentInitiated: true, commandId: command.command_id, agentCommand: command }).catch((exc) => {
        setError(exc instanceof Error ? exc.message : String(exc));
      });
      return;
    }
    if (command.type === 'review.accept_run') {
      void acceptRun(String(command.payload.run_id || activeRunId || ''), { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'review.open_comparison' || command.type === 'artifacts.open_report') {
      setPendingShellCommand(command);
      setStatusMessage(command.type === 'review.open_comparison' ? 'Agent opened run comparison.' : 'Agent opened artifacts.');
      return;
    }
    if (command.type === 'export.session') {
      void exportRunSession(String(command.payload.run_id || activeRunId || runRecords[0]?.runId || ''), { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'export.workbook') {
      void exportRunWorkbook(String(command.payload.run_id || activeRunId || runRecords[0]?.runId || ''), { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'export.report') {
      void exportRunReport(String(command.payload.run_id || activeRunId || runRecords[0]?.runId || ''), { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'batch.create') {
      void runAgentBatchCreate(command.payload, command.command_id);
      return;
    }
    if (command.type === 'batch.run') {
      void runAgentBatch(command.payload, command.command_id);
      return;
    }
    if (command.type === 'events.select_event' || command.type === 'events.move_cursor' || command.type === 'waveform.center_event' || command.type === 'review.focus_event') {
      let eventId = String(command.payload.event_id || '');
      const loadedEvents = reviewEvents.length ? reviewEvents : Object.values(runEventsByRun).flat();
      // move_cursor with a direction (and no explicit event_id) steps next/prev through the loaded
      // review events — the command name implies navigation, so honor it instead of only re-selecting.
      if (command.type === 'events.move_cursor' && !eventId) {
        const direction = String(command.payload.direction || command.payload.step || 'next').toLowerCase();
        if (!loadedEvents.length) {
          commandOutcomeRef.current = { status: 'noop', reason: 'no loaded events to move the cursor through — run detection first' };
          setReviewMessage('Agent move-cursor command has no loaded events to navigate.');
          return;
        }
        const back = direction === 'prev' || direction === 'previous' || direction === 'back' || direction === 'up';
        const currentIndex = loadedEvents.findIndex((candidate) => candidate.event_id === selectedReviewEventId);
        const nextIndex = currentIndex < 0 ? 0 : Math.min(loadedEvents.length - 1, Math.max(0, currentIndex + (back ? -1 : 1)));
        if (currentIndex >= 0 && nextIndex === currentIndex) {
          commandOutcomeRef.current = { status: 'noop', reason: `already at the ${back ? 'first' : 'last'} event — cursor did not move` };
          setReviewMessage(`Agent move-cursor reached the ${back ? 'first' : 'last'} loaded event.`);
          return;
        }
        eventId = loadedEvents[nextIndex]?.event_id || '';
      }
      const event = loadedEvents.find((candidate) => candidate.event_id === eventId);
      if (event) {
        selectReviewEventForCursor(event);
        if (command.type === 'waveform.center_event' || command.type === 'review.focus_event') focusWaveformOnCommandEvent(event);
      } else {
        commandOutcomeRef.current = { status: 'noop', reason: `event "${eventId}" is not in the loaded set — nothing selected (call get_ui_state for valid event_ids)` };
        setReviewMessage(`Agent command referenced an event that is no longer loaded: ${eventId}.`);
      }
      return;
    }
    if (command.type === 'review.open_event') {
      const event = resolveReviewEventForAgentCommand(command.payload.event_id);
      if (event) {
        selectReviewEventForCursor(event);
        focusWaveformOnCommandEvent(event);
      }
      setPendingShellCommand(command);
      return;
    }
    if (command.type === 'recording.select_channel' || command.type === 'waveform.focus_channel') {
      const channel = String(command.payload.channel || '');
      const nextControls = clampWaveformControls({
        ...waveformControls,
        annotationChannel: channel,
        channelsToPlot: channel ? [channel, ...waveformControls.channelsToPlot.filter((item) => item !== channel)] : waveformControls.channelsToPlot,
        channelFocusMode: 'highlight',
        startSeconds: Number(command.payload.start_seconds ?? waveformControls.startSeconds),
        timeWindowSeconds: Number(command.payload.duration_seconds ?? waveformControls.timeWindowSeconds)
      }, metadata);
      if (JSON.stringify(nextControls) === JSON.stringify(clampWaveformControls(waveformControls, metadata))) {
        commandOutcomeRef.current = { status: 'noop', reason: `channel "${channel}" is already focused — nothing changed` };
        return;
      }
      setWaveformControls(nextControls);
      void updatePlot(nextControls);
      markWorkspaceDirty();
      return;
    }
    if (command.type === 'waveform.set_amplitude_scale') {
      const amplitudeScale = payloadPositiveNumber(command.payload.amplitude_scale ?? command.payload.amplitudeScale ?? command.payload.scale);
      if (amplitudeScale === undefined) {
        commandOutcomeRef.current = { status: 'noop', reason: 'missing a positive amplitude scale; nothing changed' };
        setStatusMessage('Agent amplitude-scale command is missing a positive scale.');
        return;
      }
      applyWaveformControlsFromAgent({ ...waveformControls, amplitudeScale }, `Agent set waveform amplitude to ${amplitudeScale}x.`);
      return;
    }
    if (command.type === 'waveform.set_display') {
      setWaveformDisplayFromAgent(command.payload);
      return;
    }
    if (command.type === 'waveform.set_viewport') {
      // Validate provided values. A present-but-malformed start/duration (e.g. "30s") used to coerce
      // to NaN -> clampWaveformControls(Number(NaN||0)) -> silently JUMP the viewport to 0s. Warn and
      // leave the viewport unchanged instead, so the agent learns it didn't move (via the ack loop).
      const startProvided = command.payload.start_seconds ?? command.payload.startSeconds;
      const durationProvided = command.payload.duration_seconds ?? command.payload.time_window_seconds;
      const startSeconds = startProvided == null ? waveformControls.startSeconds : payloadNumber(startProvided);
      const timeWindowSeconds = durationProvided == null ? waveformControls.timeWindowSeconds : payloadNumber(durationProvided);
      if (startSeconds === undefined || timeWindowSeconds === undefined) {
        commandOutcomeRef.current = { status: 'noop', reason: `non-numeric start/duration (start=${JSON.stringify(startProvided)}, duration=${JSON.stringify(durationProvided)}); viewport unchanged` };
        setStatusMessage(`Agent set_viewport got a non-numeric value (start=${JSON.stringify(startProvided)}, duration=${JSON.stringify(durationProvided)}); viewport unchanged.`);
        return;
      }
      const nextControls = clampWaveformControls({ ...waveformControls, startSeconds, timeWindowSeconds }, metadata);
      if (JSON.stringify(nextControls) === JSON.stringify(clampWaveformControls(waveformControls, metadata))) {
        commandOutcomeRef.current = { status: 'noop', reason: 'viewport is already at the requested start/duration — nothing moved' };
        return;
      }
      setWaveformControls(nextControls);
      void updatePlot(nextControls);
      markWorkspaceDirty();
      return;
    }
    if (command.type === 'events.stage_annotation') {
      const eventId = String(command.payload.event_id || selectedReviewEventId || '');
      const label = String(command.payload.label || '');
      if (!eventId || !label) {
        commandOutcomeRef.current = { status: 'noop', reason: 'missing event_id or label; no annotation was written' };
        setReviewMessage('Agent annotation command is missing event_id or label.');
        return;
      }
      void annotateEvent(eventId, label, String(command.payload.notes || command.reason || ''), 'clinician', 'agent-proposal-clinician-confirmed', { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'events.clear_staged_annotation') {
      const eventId = String(command.payload.event_id || selectedReviewEventId || '');
      if (!eventId) {
        commandOutcomeRef.current = { status: 'noop', reason: 'missing event_id; no annotation was cleared' };
        setReviewMessage('Agent clear-annotation command is missing event_id.');
        return;
      }
      void annotateEvent(eventId, 'clear', String(command.payload.notes || command.reason || 'Cleared by confirmed Agent command'), 'clinician', 'agent-proposal-clinician-confirmed', { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'detection.create_consensus_run') {
      const strategy = command.payload.strategy;
      void createConsensusRun(typeof strategy === 'string' ? (strategy as ConsensusStrategy) : undefined, { agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'review.group_overlaps') {
      void overlapReview({ agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'project.save') {
      void saveProject({ agentInitiated: true, commandId: command.command_id });
      return;
    }
    if (command.type === 'project.open') {
      const projectFilePath = String(command.payload.input_path || '');
      if (!projectFilePath) {
        commandOutcomeRef.current = { status: 'noop', reason: 'missing input_path; no project opened' };
        setStatusMessage('Agent project.open command is missing input_path.');
        return;
      }
      void (async () => {
        if (!(await confirmDiscardWorkspace('opening another project'))) {
          closeAgentCommandWithoutOperation({ agentInitiated: true, commandId: command.command_id }, 'Open project', 'failed', 'Open project cancelled to keep the unsaved workspace.');
          return;
        }
        const operation = beginOperation('Open project', 'recording', { agentInitiated: true, commandId: command.command_id });
        try {
          setError(null);
          const opened = await backendClient.openProject({ project_path: projectFilePath }) as ProjectApiResult;
          await restoreProjectState(opened.state || {}, opened.project_path || projectFilePath, operation);
          finishOperation(operation, 'success', `Project opened: ${opened.project_path || projectFilePath}.`);
        } catch (exc) {
          const message = exc instanceof Error ? exc.message : String(exc);
          setError(message);
          finishOperation(operation, 'error', message);
        }
      })();
      return;
    }
    // No handler matched. Today every catalog type is handled above, so this is a DEV TRIPWIRE for a
    // future catalog type shipped without a renderer handler — make it loud, not a success-shaped
    // "no mutation required" message that hides the no-op. The contract test asserts this never fires
    // for a real catalog type.
    commandOutcomeRef.current = { status: 'noop', reason: 'no renderer handler for this command type' };
    console.warn(`[agent-ui] no executeAppliedUICommand handler for "${command.type}" — command was a no-op`);
    logRuntime('warning', `Agent UI command not handled in the renderer: ${command.type} (no-op).`);
    setStatusMessage(`Agent UI command not handled — ${command.type} did nothing (no renderer handler).`);
  }

  async function runAgentBatchCreate(payload: Record<string, unknown>, commandId?: string) {
    const inputDir = String(payload.input_dir || '');
    if (!inputDir) {
      setStatusMessage('Agent batch.create command is missing input_dir.');
      closeAgentCommandWithoutOperation({ agentInitiated: true, commandId }, 'Agent create batch manifest', 'failed', 'Agent batch.create command is missing input_dir.');
      return;
    }
    const operation = beginOperation('Agent create batch manifest', 'detection', { indeterminate: true, agentInitiated: true, commandId });
    try {
      const result = asRecord(await backendClient.createBatchProject({
        input_dir: inputDir,
        output_dir: payload.output_dir || undefined,
        recursive: payload.recursive !== false
      }));
      const terminalProof = backendArtifactTerminalProof(result);
      const manifestPath = String(result.manifest_path || '');
      if (manifestPath) recordAgentArtifact({ label: 'Batch manifest', type: 'summary', path: manifestPath, source: 'backend', status: String(result.status || 'complete') });
      setStatusMessage(`Batch manifest created: ${manifestPath || inputDir}.`);
      finishOperation(operation, 'success', `Agent batch manifest created with ${Number(asRecord(result.summary).total || 0)} case(s).`, terminalProof);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Agent batch manifest creation failed.');
      finishOperation(operation, 'error', message);
    }
  }

  async function runAgentBatch(payload: Record<string, unknown>, commandId?: string) {
    const manifestPath = String(payload.manifest_path || payload.manifest || '');
    if (!manifestPath) {
      setStatusMessage('Agent batch.run command is missing manifest_path.');
      closeAgentCommandWithoutOperation({ agentInitiated: true, commandId }, 'Agent run batch manifest', 'failed', 'Agent batch.run command is missing manifest_path.');
      return;
    }
    const operation = beginOperation('Agent run batch manifest', 'detection', { indeterminate: true, agentInitiated: true, commandId });
    try {
      const result = asRecord(await backendClient.runBatch({
        manifest_path: manifestPath,
        retry_failed: Boolean(payload.retry_failed),
        fail_fast: Boolean(payload.fail_fast),
        // Detection params MUST be nested under `detection`: pipeline.run_batch reads them ONLY
        // from payload['detection'], so top-level keys were silently dropped and every case ran
        // as the HFO/STE default instead of the requested biomarker/detector/band/n_jobs.
        detection: {
          biomarker: payload.biomarker || 'HFO',
          detector: payload.detector || 'STE',
          filter: asRecord(payload.filter),
          n_jobs: optionalPositiveInteger(payload.n_jobs || payload.nJobs) || prepareControls.nJobs
        }
      }));
      const terminalProof = backendComputeTerminalProof(result);
      const summary = asRecord(result.summary);
      setStatusMessage(`Batch run ${String(result.status || 'complete')}: ${Number(summary.complete || 0)}/${Number(summary.total || 0)} complete, ${Number(summary.failed || 0)} failed.`);
      finishOperation(operation, 'success', `Agent batch run ${String(result.status)}.`, terminalProof);
      if (manifestPath) recordAgentArtifact({ label: 'Batch manifest', type: 'summary', path: manifestPath, source: 'backend', status: String(result.status || 'complete') });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Agent batch run failed.');
      finishOperation(operation, 'error', message);
    }
  }

  // Severity navigation lands the segment at the left edge of the window, the way the PyQt app's
  // jump did: the reader wants the segment's onset in view, not its midpoint.
  function seekWaveformToSeconds(startSeconds: number) {
    const nextControls = clampWaveformControls({
      ...waveformControls,
      startSeconds: Math.max(0, Number(startSeconds) || 0)
    }, metadata);
    setWaveformControls(nextControls);
    void updatePlot(nextControls);
    setStatusMessage(`Jumped to ${nextControls.startSeconds.toFixed(1)} s.`);
  }

  function focusWaveformOnCommandEvent(event: ReviewEvent) {
    const midSeconds = Number(event.start_seconds ?? 0) + Math.max(0, Number(event.duration_seconds ?? 0)) / 2;
    const nextControls = clampWaveformControls({
      ...waveformControls,
      startSeconds: Number.isFinite(midSeconds) ? Math.max(0, midSeconds - waveformControls.timeWindowSeconds / 2) : waveformControls.startSeconds,
      annotationChannel: event.channel || waveformControls.annotationChannel,
      channelsToPlot: event.channel ? [event.channel, ...waveformControls.channelsToPlot.filter((channel) => channel !== event.channel)] : waveformControls.channelsToPlot,
      channelFocusMode: event.channel ? 'events' : waveformControls.channelFocusMode
    }, metadata);
    setWaveformControls(nextControls);
    void updatePlot(nextControls);
  }

  // `options.indeterminate` marks operations whose true progress the renderer cannot
  // know (a single blocking backend call). They start at progress 0 and the UI shows
  // an honest busy/elapsed indicator instead of a fabricated climbing percentage.
  // `options.totalSteps` declares a renderer-orchestrated multi-call sequence whose
  // progress is driven from REAL completed-step counts via reportOperationStep.
  function beginOperation(label: string, kind: RuntimeOperation['kind'], options: { indeterminate?: boolean; totalSteps?: number; agentInitiated?: boolean; commandId?: string } = {}): RuntimeOperation {
    const indeterminate = options.indeterminate === true;
    const operation: RuntimeOperation = {
      id: `op-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      label,
      kind,
      status: 'running',
      progress: indeterminate ? 0 : 5,
      startedAt: new Date().toISOString(),
      cancellable: true,
      indeterminate,
      completedSteps: options.totalSteps ? 0 : undefined,
      totalSteps: options.totalSteps
    };
    setRuntimeOperation(operation);
    logRuntime('info', `${label} started.`, operation.id);
    // Agent-initiated operations get a live lifecycle card in the chat transcript; finishOperation
    // retires it and closes the loop. This single hook covers every operation (detect/classify/
    // load/analyze/prepare/rank/export/batch) so the agent surface mirrors the workspace's work.
    if (options.agentInitiated) {
      const uiThreadId = (options.commandId ? commandUiThreadIdsRef.current.get(options.commandId) : undefined) || activeAgentConversationId;
      agentOpUiThreadIds.current.set(operation.id, uiThreadId);
      agentOpCardIds.current.set(operation.id, pushAgentRunCard({ status: 'running', label }, uiThreadId));
    }
    if (options.commandId) {
      agentOpCommandIds.current.set(operation.id, options.commandId);
      ackUICommand(options.commandId, {
        status: 'running',
        operation_id: operation.id,
        label: operation.label,
        started_at: operation.startedAt
      });
    }
    return operation;
  }

  function updateOperation(operation: RuntimeOperation, progress: number, message: string) {
    // Indeterminate operations never advance a fabricated percentage; they stay at 0
    // and the UI surfaces a busy/elapsed state. We still record the log message.
    setRuntimeOperation((current) => current.id === operation.id && !current.indeterminate ? { ...current, progress: Math.min(99, Math.max(progress, current.progress)) } : current);
    logRuntime('info', message, operation.id);
  }

  // Honest, renderer-orchestrated step progress: advance `progress` from REAL
  // completed-step counts (e.g. 1/3 -> 2/3 -> 3/3), not a timer. Caps below 100 so
  // only finishOperation marks completion.
  function reportOperationStep(operation: RuntimeOperation, completedSteps: number, message: string) {
    setRuntimeOperation((current) => {
      if (current.id !== operation.id) return current;
      const totalSteps = current.totalSteps ?? operation.totalSteps;
      if (!totalSteps) return current;
      const nextCompleted = Math.max(current.completedSteps ?? 0, completedSteps);
      return { ...current, completedSteps: nextCompleted, progress: Math.min(99, stepProgressPercent(nextCompleted, totalSteps)) };
    });
    logRuntime('info', message, operation.id);
  }

  function finishOperation(
    operation: RuntimeOperation,
    level: RuntimeLogEntry['level'],
    message: string,
    terminalProof?: Record<string, unknown>,
    terminalStatus: 'complete' | 'failed' | 'noop' = level === 'error' ? 'failed' : 'complete',
    terminalError?: { code: string; message: string; retryable: boolean },
  ) {
    const operationFailed = terminalStatus !== 'complete';
    setRuntimeOperation((current) => current.id === operation.id ? { ...current, status: operationFailed ? 'failed' : 'complete', progress: 100, completedSteps: current.totalSteps ?? current.completedSteps, indeterminate: false, finishedAt: new Date().toISOString(), cancellable: false } : current);
    logRuntime(level, message, operation.id);
    // Retire the chat run card (if this op was agent-initiated) and hand the result back to the agent.
    const cardId = agentOpCardIds.current.get(operation.id);
    if (cardId) {
      agentOpCardIds.current.delete(operation.id);
      const status = operationFailed ? 'failed' : 'complete';
      updateAgentRunCard(cardId, { status, detail: message });
      notifyAgentOfRunResult({ label: operation.label, status, detail: message }, agentOpUiThreadIds.current.get(operation.id));
    }
    agentOpUiThreadIds.current.delete(operation.id);
    const commandId = agentOpCommandIds.current.get(operation.id);
    if (commandId) {
      agentOpCommandIds.current.delete(operation.id);
      ackUICommand(commandId, {
        status: terminalStatus,
        operation_id: operation.id,
        label: operation.label,
        detail: message,
        ...(typeof terminalProof?.recording_fingerprint === 'string'
          ? { recording_fingerprint: terminalProof.recording_fingerprint }
          : {}),
        ...(terminalProof ? { terminal_proof: terminalProof } : {}),
        ...(terminalError ? { error: terminalError } : {}),
        finished_at: new Date().toISOString()
      });
    }
  }

  function cancelRuntimeOperation() {
    if (runtimeOperation.status !== 'running') return;
    setRuntimeOperation((current) => ({ ...current, status: 'cancel_requested', cancellable: false }));
    logRuntime('warning', 'Cancel requested. The current backend call will stop at the next cancellable boundary.', runtimeOperation.id);
  }

  async function loadWaveformForRecording(selected: string, info: RecordingMetadata, requestedControls: WaveformControlsState = waveformControls) {
    const controls = clampWaveformControls(requestedControls, info);
    const channels = selectedWaveformChannels(info, controls);
    const requestChannels = expandDerivedChannelsForRequest(channels, controls, info);
    setWaveformControls(controls);
    if (!channels.length) {
      setStatusMessage('Recording loaded, but no channels are available for waveform display.');
      return;
    }
    // Claim a fresh token for this window load. Any in-flight response from a prior
    // token (including a still-pending coarse pass) is now stale and will be ignored.
    const requestToken = (waveformRequestTokenRef.current += 1);
    // A per-display band only applies to the filtered view; omit the keys entirely
    // when unset so the backend falls back to its default 1-80 Hz clinical band.
    const displayBand = controls.showFiltered && controls.displayFilterLowHz != null && controls.displayFilterHighHz != null
      ? { filter_low: controls.displayFilterLowHz, filter_high: controls.displayFilterHighHz }
      : {};
    const baseRequest = {
      input_path: selected,
      start_seconds: controls.startSeconds,
      duration_seconds: controls.timeWindowSeconds,
      channels: requestChannels,
      units: 'uV',
      show_filtered: controls.showFiltered,
      filter_60hz: controls.filter60Hz,
      ...displayBand
    } as const;
    // Guard: only apply a response if it is still the freshest request AND the
    // higher-fidelity full-resolution result for THIS load has not already landed.
    // This is what prevents a slow coarse response from overwriting a newer (or
    // already-applied full-res) window — no flicker, no races.
    let fullApplied = false;
    const applyWaveform = (windowResult: unknown, isFull: boolean): boolean => {
      if (!isFreshWaveformResponse(requestToken, waveformRequestTokenRef.current)) return false;
      if (!isFull && fullApplied) return false;
      if (isFull) fullApplied = true;
      setWaveform(materializeDerivedWaveform(windowResult as WaveformWindow, channels, controls, info));
      return true;
    };
    // Retry each batch through transient backend-busy failures (timeout while a
    // detection pins the CPU, a reset, a restarting backend). The stale-token guard
    // in applyWaveform still drops any response the user has navigated past, so a
    // superseded window costs at most a few bounded retries and never applies stale
    // data. Real backend errors (bad window, too many channels) are not retried.
    const requestBatchResilient = async (request: Parameters<typeof backendClient.waveformWindow>[0]): Promise<WaveformWindow> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await backendClient.waveformWindow(request) as WaveformWindow;
        } catch (exc) {
          if (attempt >= WAVEFORM_BUSY_RETRIES || !isTransientWaveformBackendError(exc)) throw exc;
          setStatusMessage('Backend busy (a detection may be running) — retrying waveform load…');
          await new Promise((resolve) => window.setTimeout(resolve, WAVEFORM_BUSY_BACKOFF_MS[Math.min(attempt, WAVEFORM_BUSY_BACKOFF_MS.length - 1)]));
        }
      }
    };
    const fetchWindow = async (targetSamples: number) => {
      const request = { ...baseRequest, target_samples_per_channel: targetSamples };
      const channelBatches = chunkWaveformRequestChannels(requestChannels);
      if (channelBatches.length <= 1) return requestBatchResilient(request);
      const windows = await Promise.all(channelBatches.map((batch) => requestBatchResilient({ ...request, channels: batch })));
      return mergeWaveformWindowBatches(windows);
    };
    // Single full-resolution pass. The former coarse "preview" pass re-read and
    // re-filtered the IDENTICAL source range (target_samples_per_channel only
    // changes the final downsample), so it ~doubled backend work per scroll for no
    // real latency win. Revisited windows now come straight from the backend window
    // cache, and updatePlot single-flights gestures, so one pass stays responsive.
    try {
      applyWaveform(await fetchWindow(controls.targetSamplesPerChannel), true);
    } catch (exc) {
      logRuntime('warning', `Waveform window load failed: ${exc instanceof Error ? exc.message : String(exc)}`);
      throw new Error(formatWaveformUpdateError(exc));
    }
  }

  async function loadSelectedRecording(selected: string, operation: RuntimeOperation, source: 'dialog' | 'recent') {
    updateOperation(operation, 25, `${source === 'recent' ? 'Opening recent recording' : 'Selected recording'} ${selected}.`);
    setRecordingPath(selected);
    recordAgentArtifact({ label: 'Recording', type: 'recording', path: selected, source: source === 'recent' ? 'electron-ui' : 'user', status: 'loaded' });
    setRunRecords([]);
    setActiveRunId(null);
    setAcceptedRunId(null);
    setVisibleRunIds([]);
    setReviewEvents([]);
    setSelectedReviewEventId('');
    setRunEventsByRun({});
    setReviewMessage('No detection runs yet.');
    setRecordingAnalysis(DEFAULT_RECORDING_ANALYSIS);
    // Severity is scored per recording; clearing it here stops a previous file's score
    // from being read as this one's.
    setSeverityState(DEFAULT_SEVERITY_STATE);
    markWorkspaceDirty();
    const loaded = unwrapSidecarResult<{ recording_info?: RecordingMetadata } & RecordingMetadata>(await backendClient.loadRecording(selected));
    const info = loaded.recording_info || loaded;
    setMetadata(info);
    // Derive a Nyquist-safe default stopband for this recording: the canonical fs=500 is at/above
    // Nyquist for any <=1000 Hz recording, which makes PyHFO's filter invalid and detection fail
    // silently. clampStopbandToNyquist only lowers fs when it would exceed floor(0.95*Nyquist).
    setPrepareControls((current) => clampStopbandToNyquist(current, info));
    upsertRecentRecording(selected, info);
    updateOperation(operation, 65, `Recording metadata loaded: ${Number(info.n_channels || info.num_channels || info.channel_names?.length || 0)} channel(s).`);
    // Montage follows the recording: scalp EEG opens on its conventional bipolar montage (what the
    // PyQt app did on load), anything else opens referential with the pair list CLEARED so pairs
    // built for the previous recording cannot leak onto this one.
    const initialMontage = montageStateForRecording(info);
    const initialControls = clampWaveformControls({ ...DEFAULT_WAVEFORM_CONTROLS, ...initialMontage, visibleChannels: initialVisibleChannels(info), timeWindowSeconds: Math.min(10, Number(info.duration_seconds || 10)) }, info);
    setStatusMessage('Recording loaded. Waveform viewport ready.');
    await loadWaveformForRecording(selected, info, initialControls);
  }

  async function openAndLoadRecording() {
    if (!(await confirmDiscardWorkspace('opening another recording'))) return;
    const operation = beginOperation('Load recording', 'recording');
    try {
      setError(null);
      setStatusMessage('Opening recording…');
      const selected = await backendClient.openRecording();
      if (!selected) {
        setStatusMessage('Open recording cancelled.');
        finishOperation(operation, 'warning', 'Open recording cancelled.');
        return;
      }
      await loadSelectedRecording(selected, operation, 'dialog');
      finishOperation(operation, 'success', 'Recording loaded and waveform viewport initialized.');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      setStatusMessage('Recording load failed.');
      finishOperation(operation, 'error', exc instanceof Error ? exc.message : String(exc));
    }
  }

  async function openRecentRecording(path: string) {
    if (!(await confirmDiscardWorkspace('opening a recent recording'))) return;
    const operation = beginOperation('Open recent recording', 'recording');
    try {
      setError(null);
      setStatusMessage(`Opening recent recording ${path}…`);
      await loadSelectedRecording(path, operation, 'recent');
      finishOperation(operation, 'success', 'Recent recording loaded and waveform viewport initialized.');
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Recent recording load failed.');
      finishOperation(operation, 'error', message);
      setRecentRecordings((current) => current.map((item) => item.path === path ? { ...item, label: `${item.label} (missing?)` } : item));
    }
  }

  function upsertRecentRecording(path: string, info: RecordingMetadata) {
    const entry: RecentRecording = {
      path,
      label: recordingLabelFromPath(path),
      openedAt: new Date().toISOString(),
      sampleFrequencyHz: Number(info.sample_freq || info.sampling_frequency || info.sample_frequency_hz || 0) || undefined,
      channels: Number(info.n_channels || info.num_channels || info.channel_names?.length || 0) || undefined,
      durationSeconds: Number(info.duration_seconds || info.length_seconds || 0) || undefined
    };
    setRecentRecordings((current) => [entry, ...current.filter((item) => item.path !== path)].slice(0, MAX_RECENT_RECORDINGS));
  }

  function removeRecentRecording(path: string) {
    setRecentRecordings((current) => current.filter((item) => item.path !== path));
    logRuntime('info', `Recent recording removed: ${path}`);
  }

  function clearRecentRecordings() {
    setRecentRecordings([]);
    if (typeof window !== 'undefined') window.localStorage.removeItem(RECENT_RECORDINGS_STORAGE_KEY);
    logRuntime('info', 'Recent recordings cleared.');
  }

  async function openSavedSession(): Promise<string | null> {
    try {
      setError(null);
      setStatusMessage('Choose a saved PyBrain session to load…');
      const selected = await backendClient.openSavedSession();
      setStatusMessage(selected ? 'Saved session selected.' : 'Load session cancelled.');
      return selected;
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      setStatusMessage('Open saved session failed.');
      return null;
    }
  }

  async function openClassifierModel(): Promise<string | null> {
    try {
      setError(null);
      setStatusMessage('Choose a classifier model archive…');
      const selected = await backendClient.openClassifierModel();
      setStatusMessage(selected ? 'Classifier model selected.' : 'Classifier model selection cancelled.');
      return selected;
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      setStatusMessage('Open classifier model failed.');
      return null;
    }
  }

  async function loadSavedSession(sessionPath: string) {
    if (!(await confirmDiscardWorkspace('loading a saved session'))) return;
    const operation = beginOperation('Load saved session', 'recording');
    setError(null);
    setStatusMessage('Loading saved session…');
    try {
      const loaded = await backendClient.loadSavedSession(sessionPath) as SavedSessionSummary;
      recordAgentArtifact({ label: 'Loaded PyBrain session', type: 'session', path: sessionPath, source: 'user', status: 'loaded' });
      updateOperation(operation, 35, `Saved session summary loaded from ${sessionPath}.`);
      const info = loaded.recording_info || null;
      if (loaded.prepare_controls) setPrepareControls(clampPrepareControls({ ...DEFAULT_PREPARE_CONTROLS, ...loaded.prepare_controls }));
      if (loaded.classifier_controls) {
        setClassifierControls({ ...DEFAULT_CLASSIFIER_STATE, ...loaded.classifier_controls });
        setClassifierFeedback('Classifier controls restored from saved session.');
      }
      setMetadata(info);
      const restoredRecordingPath = info?.input_path || loaded.recording_path || null;
      setRecordingPath(restoredRecordingPath);
      setWaveform(null);
      if (info && restoredRecordingPath) {
        const initialMontage = montageStateForRecording(info);
        const initialControls = clampWaveformControls({ ...DEFAULT_WAVEFORM_CONTROLS, ...initialMontage, visibleChannels: initialVisibleChannels(info), timeWindowSeconds: Math.min(10, Number(info.duration_seconds || 10)) }, info);
        try {
          await loadWaveformForRecording(restoredRecordingPath, info, initialControls);
          updateOperation(operation, 75, 'Saved session waveform source restored.');
        } catch (exc) {
          setError(exc instanceof Error ? exc.message : String(exc));
          logRuntime('warning', exc instanceof Error ? exc.message : String(exc), operation.id);
        }
      }
      const runs = savedSessionRunRecords(loaded);
      const runIds = new Set(runs.map((run) => run.runId));
      const restoredActiveRunId = loaded.active_run_id && runIds.has(loaded.active_run_id) ? loaded.active_run_id : runs[0]?.runId || null;
      const restoredAcceptedRunId = loaded.accepted_run_id && runIds.has(loaded.accepted_run_id) ? loaded.accepted_run_id : null;
      const restoredVisibleRunIds = (loaded.visible_run_ids || []).filter((runId) => runIds.has(runId));
      setRunRecords(runs);
      setActiveRunId(restoredActiveRunId);
      setAcceptedRunId(restoredAcceptedRunId);
      setVisibleRunIds(restoredVisibleRunIds.length ? restoredVisibleRunIds : runs.map((run) => run.runId));
      setRunEventsByRun(normalizeSavedEventsByRun(loaded.review_events_by_run || {}, runs));
      const events = await refreshReviewEvents(restoredActiveRunId || undefined);
      if (restoredActiveRunId) cacheRunEvents(restoredActiveRunId, events);
      const runStatus = loaded.detected || runs.length ? `${loaded.event_count || events.length || 0} events across ${runs.length || 1} run(s)` : 'no detected events';
      setStatusMessage(`Saved ${loaded.biomarker || 'PyBrain'} session loaded: ${runStatus}${loaded.classified ? ', classified' : ''}.`);
      markWorkspaceDirty();
      finishOperation(operation, 'success', `Saved session loaded: ${runStatus}.`);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
      setStatusMessage('Load saved session failed.');
      finishOperation(operation, 'error', exc instanceof Error ? exc.message : String(exc));
      throw exc;
    }
  }

  async function restoreProjectState(state: ProjectStoreState, path: string | null, operation: RuntimeOperation) {
    setProjectPath(path);
    setProjectId(String(state.project_id || recordingLabelFromPath(path || 'project')));
    setProjectDirty(false);
    if (state.prepare_controls) setPrepareControls(clampPrepareControls({ ...DEFAULT_PREPARE_CONTROLS, ...state.prepare_controls }));
    setRecordingAnalysis(state.recording_analysis || DEFAULT_RECORDING_ANALYSIS);
    if (state.classifier_controls) setClassifierControls({ ...DEFAULT_CLASSIFIER_STATE, ...(state.classifier_controls as Partial<ClassifierControlsState>) });
    const restoredWaveformControls = clampWaveformControls({ ...DEFAULT_WAVEFORM_CONTROLS, ...(state.waveform_controls || {}) }, state.recording_info || null);
    setWaveformControls(restoredWaveformControls);
    setMetadata(state.recording_info || null);
    setRecordingPath(state.recording_path || null);
    setRunRecords(state.run_records || []);
    setActiveRunId(state.active_run_id || null);
    setAcceptedRunId(state.accepted_run_id || null);
    setVisibleRunIds(state.visible_run_ids || (state.run_records || []).map((run) => run.runId));
    setRunEventsByRun(state.review_events_by_run || {});
    setReviewEvents(state.review_events || []);
    // Model output saved with the project comes back as a finished result rather than an empty panel.
    setSeverityState(state.severity_result
      ? { status: 'complete', result: state.severity_result, error: null, progress: null }
      : DEFAULT_SEVERITY_STATE);
    if (state.agent_conversations?.length) {
      const restored = state.agent_conversations;
      const active = restored.find((entry) => entry.id === state.active_agent_conversation_id) || restored[0];
      restored.forEach((entry) => closedAgentConversationIdsRef.current.delete(entry.id));
      setAgentConversations(restored);
      setActiveAgentConversationId(active.id);
      // Continue numbering above whatever the project already used, so a new thread cannot collide
      // with a restored one.
      conversationCounterRef.current = restored.reduce((highest, entry) => {
        const parsed = Number(/Chat\s+(\d+)/.exec(entry.title)?.[1] || 0);
        return Number.isFinite(parsed) ? Math.max(highest, parsed) : highest;
      }, restored.length);
    }
    setSelectedReviewEventId(state.review_cursor_event_id || state.review_events?.[0]?.event_id || '');
    setReviewMessage((state.review_events || []).length ? `${state.review_events?.length || 0} project event(s) restored.` : 'Project opened; no event rows saved in project.');
    if (state.recording_path && state.recording_info) {
      try {
        await loadWaveformForRecording(state.recording_path, state.recording_info, restoredWaveformControls);
        updateOperation(operation, 75, 'Project waveform source restored.');
      } catch (exc) {
        logRuntime('warning', `Project waveform restore failed: ${exc instanceof Error ? exc.message : String(exc)}`, operation.id);
      }
    } else {
      setWaveform(null);
    }
    if (path) recordAgentArtifact({ label: 'Opened project', type: 'session', path, source: 'user', status: 'opened' });
    setStatusMessage(`Project opened${path ? `: ${path}` : ''}.`);
  }

  async function refreshReviewEvents(runId = activeRunId || undefined, options: { throwOnError?: boolean } = {}): Promise<ReviewEvent[]> {
    try {
      const result = await backendClient.listEvents({ run_id: runId }) as { run_id?: string | null; events?: ReviewEvent[]; count?: number; cursor_event_id?: string | null; cursor?: { event_id?: string | null } };
      const resultRunId = result.run_id || runId || undefined;
      const events = (result.events || []).map((event) => ({ ...event, run_id: event.run_id || resultRunId || undefined }));
      const ids = new Set(events.map((event) => event.event_id));
      const cursorEventId = result.cursor_event_id || result.cursor?.event_id || '';
      setReviewEvents(events);
      if (resultRunId) setRunEventsByRun((current) => ({ ...current, [resultRunId]: events.map((event) => ({ ...event, run_id: event.run_id || resultRunId })) }));
      setSelectedReviewEventId((current) => cursorEventId && ids.has(cursorEventId) ? cursorEventId : ids.has(current) ? current : events[0]?.event_id || '');
      setReviewMessage(events.length ? `${events.length} event(s) available for review${resultRunId ? ` in ${resultRunId}` : ''}.` : 'Active run has no event rows available yet.');
      return events;
    } catch (exc) {
      if (options.throwOnError) throw exc;
      setReviewEvents([]);
      setSelectedReviewEventId('');
      setReviewMessage(exc instanceof Error ? exc.message : String(exc));
      return [];
    }
  }

  function cacheRunEvents(runId: string, events: ReviewEvent[]) {
    setRunEventsByRun((current) => ({ ...current, [runId]: events.map((event) => ({ ...event, run_id: event.run_id || runId })) }));
  }

  function applyReviewEventsForRun(run: RunRecord, events: ReviewEvent[], message: string) {
    const stampedEvents = events.map((event) => ({ ...event, run_id: event.run_id || run.runId }));
    setReviewEvents(stampedEvents);
    setSelectedReviewEventId(stampedEvents[0]?.event_id || '');
    setReviewMessage(message);
    if (stampedEvents[0]) {
      void backendClient.moveEventCursor({ action: 'select', event_id: stampedEvents[0].event_id, run_id: run.runId, events: stampedEvents })
        .catch((exc) => logRuntime('warning', `Event cursor sync failed after run switch: ${exc instanceof Error ? exc.message : String(exc)}`));
    }
  }

  async function updatePlot(nextControls: WaveformControlsState = waveformControls) {
    if (!recordingPath || !metadata) {
      setStatusMessage('Open a recording before updating the plot.');
      setWaveformControls(clampWaveformControls(nextControls, metadata));
      return;
    }
    const clampedControls = clampWaveformControls(nextControls, metadata);
    if (isVisualFixtureMode()) {
      setError(null);
      setWaveformControls(clampedControls);
      const modeNotes = [clampedControls.showFiltered ? 'filtered requested' : 'raw', clampedControls.filter60Hz ? '60 Hz requested' : 'line filter off', clampedControls.normalizeVertically ? 'normalized display' : 'native scale', `${clampedControls.amplitudeScale}x`, clampedControls.montageMode, clampedControls.channelFocusMode];
      setStatusMessage(`Waveform plot updated: ${clampedControls.startSeconds.toFixed(2)}s + ${clampedControls.timeWindowSeconds}s, ${selectedWaveformChannels(metadata, clampedControls).length} channels (${modeNotes.join(', ')}).`);
      return;
    }
    // Coalesce bursts: while a load runs, keep only the newest requested target
    // and apply it once the current load settles. The stale-response token still
    // guards ordering; this stops the concurrent-fetch pile-up at the source so a
    // single wheel/drag gesture can never overwhelm the local backend.
    if (waveformUpdateInFlightRef.current) {
      pendingWaveformControlsRef.current = clampedControls;
      return;
    }
    waveformUpdateInFlightRef.current = true;
    try {
      let controlsToLoad: WaveformControlsState | null = clampedControls;
      while (controlsToLoad) {
        pendingWaveformControlsRef.current = null;
        try {
          setError(null);
          setStatusMessage('Updating waveform plot…');
          await loadWaveformForRecording(recordingPath, metadata, controlsToLoad);
          const controls = clampWaveformControls(controlsToLoad, metadata);
          const modeNotes = [controls.showFiltered ? 'filtered requested' : 'raw', controls.filter60Hz ? '60 Hz requested' : 'line filter off', controls.normalizeVertically ? 'normalized display' : 'native scale', `${controls.amplitudeScale}x`, controls.montageMode, controls.channelFocusMode];
          setStatusMessage(`Waveform plot updated: ${controls.startSeconds.toFixed(2)}s + ${controls.timeWindowSeconds}s, ${selectedWaveformChannels(metadata, controls).length} channels (${modeNotes.join(', ')}).`);
        } catch (exc) {
          setError(formatWaveformUpdateError(exc));
          setStatusMessage('Waveform update failed.');
        }
        controlsToLoad = pendingWaveformControlsRef.current;
      }
    } finally {
      waveformUpdateInFlightRef.current = false;
    }
  }

  function handleWaveformControlsChange(nextControls: WaveformControlsState) {
    const controls = clampWaveformControls(nextControls, metadata);
    setWaveformControls(controls);
    markWorkspaceDirty();
  }

  function handlePrepareControlsChange(nextControls: PrepareControlsState) {
    setPrepareControls(clampPrepareControls(nextControls));
    markWorkspaceDirty();
  }

  function handleClassifierControlsChange(nextControls: ClassifierControlsState) {
    setClassifierControls(nextControls);
    markWorkspaceDirty();
  }

  function handleRecordingAnalysisChange(nextAnalysis: RecordingAnalysisState) {
    setRecordingAnalysis(nextAnalysis);
    markWorkspaceDirty();
  }

  async function applyFilters(opts: { agentInitiated?: boolean; commandId?: string; agentCommand?: UICommand } = {}) {
    if (opts.agentCommand) {
      const scopeError = agentCommandRecordingScopeError(
        opts.agentCommand,
        recordingPath,
        metadata?.recording_fingerprint,
      );
      const unsupported = unsupportedAgentPayloadKeys(opts.agentCommand.payload, AGENT_PREPARE_PAYLOAD_KEYS);
      const commandError = scopeError || (unsupported.length
        ? `Unsupported preparation payload fields: ${unsupported.join(', ')}.`
        : null);
      if (commandError) {
        setError(commandError);
        setStatusMessage('Prepare recording command rejected because its execution scope is not exact.');
        closeAgentCommandWithoutOperation(opts, 'Prepare recording', 'failed', commandError);
        return;
      }
    }
    const controls = clampPrepareControls(
      opts.agentCommand
        ? prepareControlsFromAgentCommand(opts.agentCommand.payload, prepareControls)
        : prepareControls,
    );
    const errors = validateFilterControls(controls, metadata);
    setPrepareControls(controls);
    if (errors.length) {
      const message = errors.join('; ');
      setError(message);
      setStatusMessage('Filter parameter validation failed.');
      closeAgentCommandWithoutOperation(opts, 'Prepare recording', 'failed', message);
      return;
    }
    if (!recordingPath) {
      setStatusMessage('Open a recording before applying filter preparation.');
      closeAgentCommandWithoutOperation(opts, 'Prepare recording', 'failed', 'Open a recording before applying filter preparation.');
      return;
    }
    const operation = beginOperation('Prepare recording', 'recording', { agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    try {
      setError(null);
      const inputRecordingFingerprint = String(metadata?.recording_fingerprint || '').trim().toLowerCase();
      const bandpass = filterBandpassFromPrepareControls(controls);
      const lineNoiseNotchHz = optionalPositiveNumber(controls.lineNoiseNotchHz);
      const resampleSfreq = optionalPositiveNumber(controls.resampleSfreq);
      const requestedOutputPath = String(opts.agentCommand?.payload.output_path || '').trim() || undefined;
      const activeValues = [
        controls.fp && `Fp=${controls.fp}`,
        controls.fs && `Fs=${controls.fs}`,
        controls.rp && `rp=${controls.rp}`,
        controls.rs && `rs=${controls.rs}`,
        lineNoiseNotchHz && `notch=${lineNoiseNotchHz}Hz`,
        resampleSfreq && `resample=${resampleSfreq}Hz`,
        controls.dropBadChannels && 'drop bad channels',
        controls.dropFlatChannels && 'drop flat channels',
        controls.markOutlierChannels && 'mark outlier channels',
        controls.dropOutlierChannels && 'drop outlier channels'
      ].filter(Boolean).join(', ') || 'default filter values';
      setStatusMessage(`Preparing recording with ${activeValues}…`);
      updateOperation(operation, 30, `Prepare request sent with ${activeValues}.`);
      const prepareRequest = {
        input_path: recordingPath,
        ...(requestedOutputPath ? { output_path: requestedOutputPath } : {}),
        bandpass,
        filter_design: { fp: controls.fp, fs: controls.fs, rp: controls.rp, rs: controls.rs },
        line_noise_notch_hz: lineNoiseNotchHz,
        resample_sfreq: resampleSfreq,
        drop_bad_channels: controls.dropBadChannels,
        drop_flat_channels: controls.dropFlatChannels,
        mark_outlier_channels: controls.markOutlierChannels,
        drop_outlier_channels: controls.dropOutlierChannels,
        n_jobs: controls.nJobs
      };
      const result = unwrapSidecarResult<PrepareRecordingResult>(await backendClient.prepareRecording(prepareRequest));
      const preparedPath = result.output_path;
      if (result.status !== 'complete' || !preparedPath) {
        throw new Error('The backend did not return a completed prepared-recording artifact.');
      }
      if (
        result.input_recording_fingerprint
        && inputRecordingFingerprint
        && result.input_recording_fingerprint !== inputRecordingFingerprint
      ) {
        throw new Error('The prepared artifact was produced from a different recording fingerprint.');
      }
      let waveformDeferred = false;
      let preparedFingerprint = String(result.output_recording_fingerprint || '').trim().toLowerCase();
      if (preparedPath) {
        recordAgentArtifact({ label: 'Prepared recording', type: 'recording', path: preparedPath, source: 'backend', status: result.status || 'complete' });
        const loaded = unwrapSidecarResult<{ recording_info?: RecordingMetadata } & RecordingMetadata>(await backendClient.loadRecording(preparedPath));
        const info = loaded.recording_info || loaded;
        const observedPreparedFingerprint = String(info.recording_fingerprint || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(observedPreparedFingerprint)) {
          throw new Error('The backend did not provide a verifiable fingerprint for the prepared artifact.');
        }
        if (preparedFingerprint && preparedFingerprint !== observedPreparedFingerprint) {
          throw new Error('Prepared artifact fingerprint changed before backend read-back.');
        }
        preparedFingerprint = observedPreparedFingerprint;
        setRecordingPath(preparedPath);
        setMetadata(info);
        // The .fif is written and the recording is loaded — the prepare itself has
        // SUCCEEDED. Rendering its waveform preview is a non-critical follow-on, so a
        // transient preview failure (e.g. the backend is still finishing a detection)
        // must NOT flip the whole prepare to "failed". loadWaveformForRecording already
        // retries backend-busy errors; if it still can't render, defer it gracefully.
        try {
          await loadWaveformForRecording(preparedPath, info, waveformControls);
        } catch (waveformExc) {
          waveformDeferred = true;
          logRuntime('warning', `Prepared recording is ready, but the waveform preview could not load yet: ${waveformExc instanceof Error ? waveformExc.message : String(waveformExc)}`);
        }
      }
      markWorkspaceDirty();
      setStatusMessage(waveformDeferred
        ? `Prepared recording complete: ${preparedPath || 'backend output'}. Waveform preview will appear once the backend is free — use Update plot to retry.`
        : `Prepared recording complete: ${preparedPath || 'backend output'}.`);
      finishOperation(operation, 'success', `Prepared recording written: ${preparedPath || 'backend output'}.`, {
        source: 'backend_readback',
        backend_status: result.status,
        recording_fingerprint: inputRecordingFingerprint,
        input_recording_fingerprint: result.input_recording_fingerprint || inputRecordingFingerprint,
        output_recording_fingerprint: preparedFingerprint,
        parameters_sha256: result.parameters_sha256 || canonicalJsonSha256(prepareRequest),
        result_sha256: canonicalJsonSha256(result),
        output_path_sha256: canonicalJsonSha256(preparedPath),
        prepared_n_channels: result.prepared_n_channels ?? null,
        prepared_sfreq: result.prepared_sfreq ?? null,
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage('Prepare recording failed.');
      finishOperation(operation, 'error', message);
    }
  }

  // detection.plan (agent): a REAL "recommend detector settings" action — distinct from the ROI/QC/
  // spectral analyze pass. Calls the backend recommend_parameters (Nyquist-safe, goal-profile aware),
  // reflects the recommended filter/notch in the visible Prepare panel (so it's actionable, like
  // detection.set_parameters), and surfaces the full plan (biomarker + detector + validation +
  // warnings) — which flows back to the agent via the apply-result loop so it can commit the rest.
  async function recommendDetectorPlanFromAgent(payload: Record<string, unknown>, opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    if (!recordingPath) {
      setStatusMessage('Open a recording before recommending a detector plan.');
      closeAgentCommandWithoutOperation(opts, 'Recommend detector plan', 'failed', 'Open a recording before recommending a detector plan.');
      return;
    }
    const operation = beginOperation('Recommend detector plan', 'recording', { indeterminate: true, agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    try {
      setError(null);
      const biomarker = String(payload.biomarker || 'HFO');
      const plan = unwrapSidecarResult<{ parameters?: Record<string, unknown>; validation?: Record<string, unknown> }>(
        await backendClient.recommendParameters({
          input_path: recordingPath,
          biomarker,
          detector: payload.detector,
          goal_profile: payload.goal_profile ?? payload.goal,
          roi: recordingAnalysis.roi || undefined,
          recording_info: metadata || undefined
        })
      );
      const params = asRecord(plan.parameters);
      // Reflect the recommended filter/notch in the Prepare panel so the recommendation is visible
      // and the user can review it before running detection.
      setPrepareControls(prepareControlsFromAgentCommand(params, prepareControls));
      markWorkspaceDirty();
      const recommendedDetector = String(params.detector || 'detector');
      const validation = asRecord(plan.validation);
      const validationStatus = String(validation.status || 'unknown');
      const warnings = Array.isArray(validation.warnings) ? validation.warnings : [];
      const summary = `Recommended ${biomarker} ${recommendedDetector} plan applied to the Prepare panel (validation ${validationStatus}${warnings.length ? `, ${warnings.length} warning(s)` : ''}).`;
      setStatusMessage(summary);
      finishOperation(operation, 'success', summary);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage(`Detector-plan recommendation failed: ${message}`);
      finishOperation(operation, 'error', message);
    }
  }

  async function analyzeRecordingPlanning(opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    if (!recordingPath) {
      setStatusMessage('Open a recording before running ROI/QC/spectral analysis.');
      closeAgentCommandWithoutOperation(opts, 'Analyze recording ROI/QC/Spectral', 'failed', 'Open a recording before running ROI/QC/spectral analysis.');
      return;
    }
    // Renderer orchestrates 3 real sequential backend calls (ROI -> QC -> Spectral),
    // so progress is driven from REAL completed-step counts (1/3, 2/3, 3/3).
    const operation = beginOperation('Analyze recording ROI/QC/Spectral', 'recording', { totalSteps: 3, agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    setRecordingAnalysis({ status: 'running', updatedAt: new Date().toISOString(), roi: null, qc: null, spectral: null });
    try {
      setError(null);
      setStatusMessage('Analyzing recording ROI, channel QC, and spectral profile…');
      const roi = unwrapSidecarResult<RecordingRoiSummary>(await backendClient.analyzeRecordingRoi({ input_path: recordingPath }));
      const defaultExclusions = roi.default_detection_exclusions || [];
      reportOperationStep(operation, 1, `ROI complete (1/3): ${Number(roi.brain_signal_channel_count || 0)} brain-signal channel(s), ${defaultExclusions.length} default exclusion(s).`);
      const qc = unwrapSidecarResult<RecordingQcSummary>(await backendClient.analyzeRecordingQc({ input_path: recordingPath, roi, exclude_channels: defaultExclusions, max_duration_seconds: 60 }));
      reportOperationStep(operation, 2, `QC complete (2/3): ${Number(qc.flat_channels?.length || 0)} flat and ${Number(qc.outlier_channels?.length || 0)} outlier channel(s).`);
      const spectral = unwrapSidecarResult<RecordingSpectralSummary>(await backendClient.analyzeRecordingSpectral({ input_path: recordingPath, roi, exclude_channels: defaultExclusions, max_duration_seconds: 60, max_channels: 32, max_psd_points: 96 }));
      reportOperationStep(operation, 3, 'Spectral profile complete (3/3).');
      setRecordingAnalysis({ status: 'complete', updatedAt: new Date().toISOString(), roi, qc, spectral, confirmed_exclusions: defaultExclusions });
      markWorkspaceDirty();
      setStatusMessage(`Recording analysis complete: ROI ${Number(roi.brain_signal_channel_count || 0)} brain channel(s), QC ${Number(qc.flat_channels?.length || 0)} flat/${Number(qc.outlier_channels?.length || 0)} outlier, Nyquist ${formatOptionalHz(spectral.nyquist_hz)}.`);
      finishOperation(operation, 'success', 'Recording ROI/QC/spectral planning analysis complete.');
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setRecordingAnalysis((current) => ({ ...current, status: 'failed', updatedAt: new Date().toISOString(), error: message }));
      setError(message);
      setStatusMessage('Recording analysis failed.');
      finishOperation(operation, 'error', message);
    }
  }

  function saveNJobs() {
    const controls = clampPrepareControls(prepareControls);
    setPrepareControls(controls);
    markWorkspaceDirty();
    setStatusMessage(`N Jobs saved: ${controls.nJobs}.`);
  }

  async function runDetection(request: DetectorRunRequest, opts: { agentInitiated?: boolean; commandId?: string; agentCommand?: UICommand } = {}) {
    if (!recordingPath) {
      setStatusMessage('Load a recording before running detection.');
      closeAgentCommandWithoutOperation(opts, `Detect ${request.detector} ${request.biomarker}`, 'failed', 'Load a recording before running detection.');
      return;
    }
    if (opts.agentCommand) {
      const scopeError = agentCommandRecordingScopeError(
        opts.agentCommand,
        recordingPath,
        metadata?.recording_fingerprint,
      );
      const unsupported = unsupportedAgentPayloadKeys(opts.agentCommand.payload, AGENT_DETECTION_PAYLOAD_KEYS);
      const commandError = scopeError || (unsupported.length
        ? `Unsupported detection payload fields: ${unsupported.join(', ')}.`
        : null);
      if (commandError) {
        setError(commandError);
        setStatusMessage('Detection command rejected because its execution scope is not exact.');
        closeAgentCommandWithoutOperation(opts, `Detect ${request.detector} ${request.biomarker}`, 'failed', commandError);
        return;
      }
    }
    const controls = clampPrepareControls(prepareControls);
    const filter = request.filter || filterRequestFromPrepareControls(controls);
    // Pre-run Nyquist gate: a stopband fs at/above the recording's Nyquist makes PyHFO's filter
    // invalid and detection fails silently (0 events, 0 channels). Surface a clear inline error
    // instead, validating the EFFECTIVE fs (an explicit request.filter overrides the controls).
    const stopbandError = nyquistStopbandError(Number(filter?.fs ?? controls.fs), metadata);
    if (stopbandError) {
      setPrepareControls(controls);
      setError(stopbandError);
      setStatusMessage('Detection blocked: stopband Fs exceeds the recording Nyquist frequency.');
      closeAgentCommandWithoutOperation(opts, `Detect ${request.detector} ${request.biomarker}`, 'failed', stopbandError);
      return;
    }
    const availableChannels = metadata?.channel_names || [];
    const availableChannelSet = new Set(availableChannels);
    const requestedInclude = request.includeChannels ? [...new Set(request.includeChannels)] : undefined;
    const requestedExclude = request.excludeChannels ? [...new Set(request.excludeChannels)] : undefined;
    const missingInclude = (requestedInclude || []).filter((channel) => !availableChannelSet.has(channel));
    const missingExclude = (requestedExclude || []).filter((channel) => !availableChannelSet.has(channel));
    const allChannelScope = request.allChannels === true || request.scope === 'all';
    const overlap = (requestedInclude || []).filter((channel) => requestedExclude?.includes(channel));
    const channelScopeError = allChannelScope && requestedInclude
      ? 'Detection cannot combine all_channels with an explicit include_channels list.'
      : missingInclude.length
        ? `Detection include_channels are not loaded: ${missingInclude.join(', ')}.`
        : missingExclude.length
          ? `Detection exclude_channels are not loaded: ${missingExclude.join(', ')}.`
          : overlap.length
            ? `Detection channels cannot be both included and excluded: ${overlap.join(', ')}.`
            : null;
    if (channelScopeError) {
      setError(channelScopeError);
      setStatusMessage('Detection blocked because the requested channel scope is not executable exactly.');
      closeAgentCommandWithoutOperation(opts, `Detect ${request.detector} ${request.biomarker}`, 'failed', channelScopeError);
      return;
    }
    // Detection (and detect+classify) is a single blocking backend call whose true
    // progress the renderer cannot observe, so it runs as an HONEST indeterminate
    // operation (busy/elapsed) rather than a fabricated climbing percentage. The
    // updateOperation calls below remain as honest runtime LOG lines only.
    const operation = beginOperation(`${request.classifier ? 'Detect + classify' : 'Detect'} ${request.detector} ${request.biomarker}`, request.classifier ? 'classification' : 'detection', { indeterminate: true, agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    const nJobs = request.nJobs || controls.nJobs;
    const roiExclusions = confirmedRecordingExclusions(recordingAnalysis);
    const excludeChannels = requestedExclude || roiExclusions;
    const includeChannels = allChannelScope
      ? []
      : (requestedInclude || selectedWaveformChannels(metadata, waveformControls))
          .filter((channel) => !excludeChannels.includes(channel));
    if (!allChannelScope && requestedInclude && !includeChannels.length) {
      const message = 'Detection include_channels contains no channel after the explicit exclusions.';
      finishOperation(operation, 'error', message);
      throw new Error(message);
    }
    try {
      setError(null);
      setPrepareControls(controls);
      setStatusMessage(`Running ${request.detector} ${request.biomarker} detection…`);
      updateOperation(operation, 20, `Backend request prepared with ${allChannelScope ? 'all eligible' : includeChannels.length || 'all'} channel(s), ${nJobs} worker(s), ${excludeChannels.length} exclusion(s).`);
      const detectionRequest = {
        input_path: recordingPath,
        ...(request.outputDir ? { output_dir: request.outputDir } : {}),
        biomarker: request.biomarker,
        detector: request.detector,
        detector_params: request.detectorParams,
        classifier: request.classifier,
        filter,
        n_jobs: nJobs,
        exports: request.exports || ['csv', 'session', 'summary_json'],
        session_format: request.sessionFormat,
        include_channels: includeChannels.length ? includeChannels : undefined,
        exclude_channels: excludeChannels.length ? excludeChannels : undefined,
        fail_on_error: false
      };
      const result = unwrapSidecarResult<DetectionRunResult>(await backendClient.runDetection(detectionRequest));
      if (result.status !== 'complete') {
        throw new Error(String(asRecord(result.error).message || `${request.detector} detection did not complete.`));
      }
      const expectedFingerprint = String(metadata?.recording_fingerprint || '').trim().toLowerCase();
      if (result.recording_fingerprint && result.recording_fingerprint !== expectedFingerprint) {
        throw new Error('Detection backend read-back is bound to a different recording fingerprint.');
      }
      updateOperation(operation, 82, `Backend returned ${result.status || 'complete'} with ${Number(result.num_events || 0)} event(s).`);
      const run = detectionResultRunRecord(result, request);
      recordDetectionArtifacts(result, run);
      setRunRecords((current) => [run, ...current]);
      setActiveRunId(run.runId);
      setAcceptedRunId(null);
      setVisibleRunIds((current) => [run.runId, ...current.filter((id) => id !== run.runId)]);
      const events = await refreshReviewEvents(run.runId);
      cacheRunEvents(run.runId, events);
      applyReviewProfileForRun(run, events);
      void refreshCandidateChannelRanking([run, ...runRecords], excludeChannels);
      markWorkspaceDirty();
      // A 0-event run on a too-short recording is a legitimate backend result, not a failure, so
      // explain the likely cause inline instead of leaving the user with a bare "0 event(s)".
      const shortRecordingNote = run.events === 0 ? shortRecordingDetectionNote(metadata) : null;
      if (shortRecordingNote) logRuntime('warning', shortRecordingNote);
      setStatusMessage(`${run.detector} run complete: ${run.events} event(s), ${run.channels} channel(s), status ${run.status}.${shortRecordingNote ? ` ${shortRecordingNote}` : ''}`);
      finishOperation(operation, 'success', `${run.detector} run ${run.status}: ${run.events} event(s), ${run.channels} channel(s).`, {
        source: 'backend_readback',
        backend_status: result.status,
        recording_fingerprint: result.recording_fingerprint || expectedFingerprint,
        parameters_sha256: result.parameters_sha256 || canonicalJsonSha256(detectionRequest),
        result_sha256: canonicalJsonSha256(result),
        run_id: run.runId,
        biomarker: run.biomarker,
        detector: run.detector,
        num_events: run.events,
        num_channels: run.channels,
        artifacts_sha256: canonicalJsonSha256(result.artifacts || {}),
        output_dir_sha256: canonicalJsonSha256(result.output_dir || request.outputDir || ''),
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setStatusMessage(`${request.detector} detection failed.`);
      finishOperation(operation, 'error', message);
      throw new Error(message);
    }
  }

  async function refreshCandidateChannelRanking(runs: RunRecord[] = runRecords, excludeChannels = confirmedRecordingExclusions(recordingAnalysis), opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    const payloadRuns = candidateRankingRunsFromRecords(runs);
    if (!payloadRuns.length) {
      closeAgentCommandWithoutOperation(opts, 'Rank candidate channels', 'failed', 'Create or load a detection run before ranking candidate channels.');
      return;
    }
    // Ranking is the one agent op without its own beginOperation; give it a lifecycle when agent-initiated
    // so it gets a chat card + loop closure like every other operation.
    const operation = opts.agentInitiated ? beginOperation('Rank candidate channels', 'detection', { indeterminate: true, agentInitiated: true, commandId: opts.commandId }) : null;
    try {
      const ranking = unwrapSidecarResult<RecordingAnalysisState['candidate_ranking']>(await backendClient.rankCandidateChannels({
        runs: payloadRuns,
        duration_seconds: metadata?.duration_seconds || 0,
        exclude_channels: excludeChannels,
        top_n: 20
      }));
      setRecordingAnalysis((current) => ({ ...current, candidate_ranking: ranking as RecordingAnalysisState['candidate_ranking'], updatedAt: new Date().toISOString() }));
      logRuntime('info', `Backend channel ranking updated from ${payloadRuns.length} detector artifact(s).`);
      if (operation) finishOperation(operation, 'success', `Candidate channel ranking updated from ${payloadRuns.length} detector artifact(s).`);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      logRuntime('warning', `Backend channel ranking unavailable; using event-table fallback: ${message}`);
      if (operation) finishOperation(operation, 'error', message);
    }
  }

  async function runSeverityScoring(opts: { agentInitiated?: boolean; commandId?: string; agentCommand?: UICommand } = {}) {
    if (!recordingPath) {
      const message = 'Load a scalp EEG recording before running severity scoring.';
      setSeverityState({ status: 'failed', result: null, error: message });
      setStatusMessage(message);
      closeAgentCommandWithoutOperation(opts, 'Severity scoring', 'failed', message);
      throw new Error(message);
    }
    if (!supportsSeverityScoring(metadata)) {
      const message = 'Severity scoring is supported only for a recording verified as scalp EEG.';
      setSeverityState({ status: 'failed', result: null, error: message, progress: null });
      setError(message);
      setStatusMessage(message);
      closeAgentCommandWithoutOperation(opts, 'Severity scoring', 'failed', message);
      return;
    }
    if (opts.agentCommand) {
      const scopeError = agentCommandRecordingScopeError(
        opts.agentCommand,
        recordingPath,
        metadata?.recording_fingerprint,
      );
      const unsupported = unsupportedAgentPayloadKeys(opts.agentCommand.payload, AGENT_SEVERITY_PAYLOAD_KEYS);
      const nonStringPathField = ['model_dir', 'export_csv'].find((field) => (
        opts.agentCommand?.payload[field] != null
        && typeof opts.agentCommand.payload[field] !== 'string'
      ));
      const commandError = scopeError
        || (unsupported.length ? `Unsupported severity payload fields: ${unsupported.join(', ')}.` : null)
        || (nonStringPathField ? `Severity ${nonStringPathField} must be a string.` : null);
      if (commandError) {
        setSeverityState({ status: 'failed', result: null, error: commandError, progress: null });
        setError(commandError);
        setStatusMessage('Severity command rejected because its execution scope is not exact.');
        closeAgentCommandWithoutOperation(opts, 'Severity scoring', 'failed', commandError);
        return;
      }
    }
    setSeverityState({ status: 'running', result: null, error: null, progress: null });
    // One blocking backend pass over the whole recording. The request itself reports nothing until
    // it returns, so the percentage comes from the backend's own per-batch tqdm output, polled
    // while the call is in flight; the operation entry stays indeterminate.
    const operation = beginOperation('Severity scoring', 'classification', { indeterminate: true, agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    // Rate comes from the run itself rather than a guess: segments completed since the first
    // reading, which absorbs model warm-up instead of extrapolating from it.
    let firstSample: { at: number; done: number } | null = null;
    const progressPoll = window.setInterval(() => {
      void backendClient.getSeverityProgress().then((progress) => {
        const reading = progress as { percent?: number; done?: number; total?: number } | null;
        if (!reading || !Number.isFinite(reading.total)) return;
        const done = Number(reading.done) || 0;
        const total = Number(reading.total) || 0;
        const now = Date.now();
        if (!firstSample) firstSample = { at: now, done };
        const elapsedSeconds = (now - firstSample.at) / 1000;
        const completedSinceFirst = done - firstSample.done;
        const rate = elapsedSeconds > 5 && completedSinceFirst > 0 ? completedSinceFirst / elapsedSeconds : 0;
        const etaSeconds = rate > 0 && total > done ? (total - done) / rate : null;
        setSeverityState((current) => (current.status === 'running'
          ? { ...current, progress: { percent: Number(reading.percent) || 0, done, total, etaSeconds } }
          : current));
      }).catch(() => { /* a missed progress read is not a failed run */ });
    }, 2000);
    try {
      const severityRequest = {
        input_path: recordingPath,
        ...(optionalNonemptyString(opts.agentCommand?.payload.model_dir)
          ? { model_dir: optionalNonemptyString(opts.agentCommand?.payload.model_dir) }
          : {}),
        ...(optionalNonemptyString(opts.agentCommand?.payload.export_csv)
          ? { export_csv: optionalNonemptyString(opts.agentCommand?.payload.export_csv) }
          : {}),
      };
      const result = unwrapSidecarResult<SeverityScoringResult>(await backendClient.runSeverityScoring(severityRequest));
      const expectedFingerprint = String(metadata?.recording_fingerprint || '').trim().toLowerCase();
      const numSegments = Number(result.num_segments);
      const numCleanSegments = Number(result.num_clean_segments);
      const provenanceDigests = [result.recording_fingerprint, result.model_sha256, result.parameters_sha256];
      if (
        result.status !== 'complete'
        || result.eeg_type !== 'scalp'
        || !Number.isInteger(numSegments)
        || numSegments <= 0
        || !Number.isInteger(numCleanSegments)
        || numCleanSegments < 0
        || numCleanSegments > numSegments
        || result.model_name !== 'BASED'
        || !result.model_version
        || provenanceDigests.some((value) => !/^[a-f0-9]{64}$/.test(String(value || '')))
        || result.recording_fingerprint !== expectedFingerprint
      ) {
        throw new Error('Severity backend read-back failed the scalp result/provenance contract.');
      }
      const rawValues = [result.mean_score, result.peak_score, result.peak_time_sec];
      const cleanValues = [result.clean_mean_score, result.clean_peak_score, result.clean_peak_time_sec];
      if (
        rawValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        || (numCleanSegments > 0 && cleanValues.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
      ) {
        throw new Error('Severity backend read-back contains incomplete score evidence.');
      }
      setSeverityState({ status: 'complete', result, error: null, progress: null });
      const headlineMean = numCleanSegments > 0 ? result.clean_mean_score : result.mean_score;
      const headlinePeak = numCleanSegments > 0 ? result.clean_peak_score : result.peak_score;
      const summary = `Severity scored ${numSegments} segment(s); mean ${formatSeverityScore(headlineMean)}, peak ${formatSeverityScore(headlinePeak)}${numCleanSegments > 0 ? ' after artifact exclusion' : ' (raw; no clean subset available)'}.`;
      finishOperation(operation, 'info', summary, {
        source: 'backend_readback',
        backend_status: result.status || 'complete',
        recording_fingerprint: result.recording_fingerprint,
        model_name: result.model_name,
        model_version: result.model_version,
        model_sha256: result.model_sha256,
        parameters_sha256: result.parameters_sha256,
        result_sha256: canonicalJsonSha256(result),
        severity_summary: {
          eeg_type: result.eeg_type ?? null,
          num_segments: result.num_segments ?? 0,
          num_clean_segments: result.num_clean_segments ?? 0,
          mean_score: result.mean_score ?? null,
          peak_score: result.peak_score ?? null,
          peak_time_sec: result.peak_time_sec ?? null,
          clean_mean_score: result.clean_mean_score ?? null,
          clean_peak_score: result.clean_peak_score ?? null,
          clean_peak_time_sec: result.clean_peak_time_sec ?? null,
          artifact_quality: result.artifact_quality ?? null,
        },
      });
      setStatusMessage(summary);
      return result;
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      // Either the user pressed Cancel here, or the backend says the run was cancelled (it can also
      // be stopped from elsewhere). Both are a cancellation, not a failure to report.
      if (severityCancelledRef.current || /\bcancell?ed\b/i.test(message)) {
        severityCancelledRef.current = false;
        setSeverityState({ status: 'idle', result: null, error: null, progress: null });
        finishOperation(
          operation,
          'warning',
          'Severity scoring cancelled.',
          undefined,
          'failed',
          { code: 'cancelled', message: 'Severity scoring was cancelled before a result was produced.', retryable: true },
        );
        return;
      }
      setSeverityState({ status: 'failed', result: null, error: message, progress: null });
      finishOperation(
        operation,
        'error',
        `Severity scoring failed: ${message}`,
        undefined,
        'failed',
        { code: 'execution_failed', message, retryable: false },
      );
      throw exc;
    } finally {
      window.clearInterval(progressPoll);
    }
  }

  // The co-pilot can score severity WITHOUT going through the UI: in direct-backend mode it calls
  // the backend tool itself, so nothing in the renderer ever hears about the result and the
  // Severity panel keeps showing the old numbers (or none). The backend holds the last result on
  // the session, so poll for it and adopt anything newer than what is on screen. This also picks up
  // a score produced by the CLI against the same session.
  useEffect(() => {
    if (!recordingPath) return;
    let cancelled = false;

    async function adoptBackendSeverity() {
      // Never stomp a run this window is driving -- its own completion handler owns that state.
      if (severityStatusRef.current === 'running') return;
      try {
        const response = (await backendClient.getSeverityResult()) as { status?: string; result?: SeverityScoringResult | null };
        if (cancelled || response?.status !== 'complete' || !response.result) return;
        const incoming = response.result;
        // Only a result for the recording ON SCREEN. The session can still hold the previous file's
        // score, and adopting that would silently attribute one recording's severity to another.
        const normalisePath = (value?: string | null) => String(value || '').split('\\').join('/').toLowerCase();
        const samePath = (left?: string | null, right?: string | null) => normalisePath(left) === normalisePath(right);
        if (!samePath(incoming.input_path, recordingPath)) return;
        if (
          incoming.eeg_type !== 'scalp'
          || incoming.recording_fingerprint !== metadata?.recording_fingerprint
          || !Number.isInteger(Number(incoming.num_segments))
          || Number(incoming.num_segments) <= 0
          || incoming.model_name !== 'BASED'
          || !incoming.model_version
          || !/^[a-f0-9]{64}$/.test(String(incoming.model_sha256 || ''))
          || !/^[a-f0-9]{64}$/.test(String(incoming.parameters_sha256 || ''))
        ) return;
        setSeverityState((current) => {
          if (current.status === 'running') return current;
          const shown = current.result;
          const same = shown
            && shown.input_path === incoming.input_path
            && shown.num_segments === incoming.num_segments
            && shown.mean_score === incoming.mean_score
            && shown.peak_score === incoming.peak_score
            && shown.recording_fingerprint === incoming.recording_fingerprint
            && shown.model_sha256 === incoming.model_sha256;
          if (same) return current;
          return { status: 'complete', result: incoming, error: null, progress: null };
        });
      } catch {
        /* backend busy or between sessions -- the next tick tries again */
      }
    }

    void adoptBackendSeverity();
    const timer = window.setInterval(() => { void adoptBackendSeverity(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [recordingPath]);

  // File-menu commands run the same functions the toolbar buttons do -- one implementation, two
  // ways in. Registered once; the menu is built in main and only names the command.
  useEffect(() => {
    const unsubscribe = backendClient.onMenuCommand?.((command) => {
      if (command === 'project.new') void newProject();
      else if (command === 'project.open') void openProject();
      else if (command === 'project.save') void saveProject();
      else if (command === 'recording.open') void openAndLoadRecording();
      else if (command === 'session.open') void openSavedSession();
      else if (command === 'window.status_log') setPendingShellCommand({ command_id: `menu-${Date.now()}`, type: 'workspace.open_panel', payload: { panel: 'status_log' }, reason: 'Opened from the File menu.' });
    });
    return () => { unsubscribe?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stops the backend's scoring child, not just the waiting. The in-flight request then returns a
  // failure, which runSeverityScoring reports as cancelled rather than as an error.
  async function cancelSeverityScoring() {
    setStatusMessage('Cancelling severity scoring…');
    try {
      await backendClient.cancelSeverityScoring();
      severityCancelledRef.current = true;
      setSeverityState((current) => (current.status === 'running' ? { ...current, status: 'idle', progress: null } : current));
      setStatusMessage('Severity scoring cancelled.');
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }

  async function runClassifier(request: ClassifierRunRequest, opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    const activeRun = runRecords.find((run) => run.runId === activeRunId);
    if (!recordingPath || !activeRun) {
      const message = 'Create or load a detection run before classifying.';
      setReviewMessage(message);
      setStatusMessage(message);
      closeAgentCommandWithoutOperation(opts, 'Classify active run', 'failed', message);
      throw new Error(message);
    }
    const detectorParams = parseDetectorParams(activeRun.parameters?.detector_params);
    const sessionPath = activeRunSessionPath(activeRun);
    setReviewMessage(`Classifying active run ${activeRun.runId} with ${request.mode}…`);
    logRuntime('info', `Classifying active run ${activeRun.runId} with ${request.mode}.`);
    if (sessionPath) {
      // Single blocking classify call: honest indeterminate progress, not a fake %.
      const operation = beginOperation(`Classify active run ${activeRun.detector}`, 'classification', { indeterminate: true, agentInitiated: opts.agentInitiated, commandId: opts.commandId });
      try {
        const result = unwrapSidecarResult<DetectionRunResult>(await backendClient.classifyActiveRun({
          session_path: sessionPath,
          run_id: activeRun.runId,
          biomarker: (activeRun.biomarker as ClassifierRunRequest['biomarker']) || request.biomarker,
          detector: activeRun.detector,
          classifier: request.classifier,
          exports: ['csv', 'session', 'summary_json'],
          session_format: sessionPath.toLowerCase().endsWith('.npz') ? 'npz' : 'pybrain'
        }));
        const recordingFingerprint = String(metadata?.recording_fingerprint || '').trim().toLowerCase();
        if (!SHA256_HEX_PATTERN.test(recordingFingerprint)) {
          throw new Error('Classification completion cannot be bound to the active recording fingerprint.');
        }
        const terminalProof = backendComputeTerminalProof(result, {
          recording_fingerprint: recordingFingerprint,
          run_id: activeRun.runId,
        });
        updateOperation(operation, 82, `Backend classified active session run ${activeRun.runId} without detector rerun.`);
        const classifiedRun = detectionResultRunRecord(result, {
          biomarker: (activeRun.biomarker as ClassifierRunRequest['biomarker']) || request.biomarker,
          detector: activeRun.detector,
          detectorParams,
          classifier: request.classifier,
          classifierLabel: request.classifierLabel,
          exports: ['csv', 'session', 'summary_json'],
          uiValues: { source_run_id: activeRun.runId, classifier_mode: request.mode, classification_mode: 'active_run_session' }
        });
        setRunRecords((current) => current.map((run) => run.runId === activeRun.runId ? {
          ...run,
          events: classifiedRun.events || run.events,
          channels: classifiedRun.channels || run.channels,
          status: classifiedRun.status,
          classifier: request.classifierLabel || classifiedRun.classifier || run.classifier,
          parameters: { ...run.parameters, ...classifiedRun.parameters, classification_mode: 'active_run_session', source_run_id: activeRun.runId }
        } : run));
        recordDetectionArtifacts(result, { ...activeRun, runId: activeRun.runId, classifier: request.classifierLabel || classifiedRun.classifier, parameters: { ...activeRun.parameters, ...classifiedRun.parameters } });
        const events = await refreshReviewEvents(activeRun.runId);
        cacheRunEvents(activeRun.runId, events);
        markWorkspaceDirty();
        finishOperation(operation, 'success', `Active run classification ${result.status}: ${Number(result.num_events || activeRun.events)} event(s).`, terminalProof);
        setReviewMessage(`Classification complete for active run ${activeRun.runId}; detector discovery was not rerun.`);
        setStatusMessage(`Active run classified without rerunning detection: ${activeRun.runId}.`);
        return;
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        finishOperation(operation, 'error', message);
        throw new Error(message);
      }
    }
    logRuntime('warning', `Active run ${activeRun.runId} has no saved session artifact; falling back to detect+classify rerun.`);
    await runDetection({
      biomarker: (activeRun.biomarker as ClassifierRunRequest['biomarker']) || request.biomarker,
      detector: activeRun.detector,
      detectorParams,
      classifier: request.classifier,
      classifierLabel: request.classifierLabel,
      exports: ['csv', 'session', 'summary_json'],
      uiValues: { source_run_id: activeRun.runId, classifier_mode: request.mode, classification_mode: 'rerun_fallback_no_session_artifact' }
    }, { agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    setReviewMessage(`Classification complete for active run ${activeRun.runId}; fallback classified run snapshot is now active because no session artifact was available.`);
  }

  // Snap the waveform to the active run's biomarker review profile, centered on
  // its first event. This is what makes "view follows active run" visible: the
  // filter band, window length and gain track HFO vs spindle vs spike, and a
  // reload (updatePlot) re-fetches the window at the new band.
  function applyReviewProfileForRun(run: RunRecord, events: ReviewEvent[]) {
    const profile = reviewProfileForRun(run);
    if (!Object.keys(profile).length) return;
    const base: WaveformControlsState = { ...waveformControls, ...profile };
    const windowSeconds = profile.timeWindowSeconds ?? base.timeWindowSeconds;
    const firstEvent = events[0];
    if (firstEvent) {
      const mid = Number(firstEvent.start_seconds ?? 0) + Math.max(0, eventDurationSeconds(firstEvent)) / 2;
      if (Number.isFinite(mid)) base.startSeconds = Math.max(0, mid - windowSeconds / 2);
    }
    const nextControls = clampWaveformControls(base, metadata);
    setWaveformControls(nextControls);
    void updatePlot(nextControls);
  }

  async function activateRun(runId: string) {
    const run = runRecords.find((candidate) => candidate.runId === runId);
    if (!run) {
      commandOutcomeRef.current = { status: 'noop', reason: `run "${runId}" is not loaded — nothing activated (call get_ui_state for valid run_ids)` };
      setReviewMessage(`Run not found: ${runId}.`);
      return;
    }
    setActiveRunId(run.runId);
    setVisibleRunIds((current) => current.includes(run.runId) ? current : [run.runId, ...current]);
    const cachedEvents = runEventsByRun[run.runId] || [];
    const events = cachedEvents.length ? cachedEvents : await refreshReviewEvents(run.runId);
    applyReviewEventsForRun(run, events, `Activated run: ${run.detector}${cachedEvents.length ? '' : ' (event rows loaded from backend)'}.`);
    applyReviewProfileForRun(run, events);
    markWorkspaceDirty();
    logRuntime('info', `Activated run ${run.runId} (${run.detector}).`);
  }

  function toggleRunVisible(runId: string, visible: boolean) {
    const run = runRecords.find((candidate) => candidate.runId === runId);
    if (!run) {
      setReviewMessage(`Run not found: ${runId}.`);
      return;
    }
    setVisibleRunIds((current) => {
      if (visible) return current.includes(runId) ? current : [...current, runId];
      return current.filter((id) => id !== runId);
    });
    const message = `${visible ? 'Showing' : 'Hiding'} overlay for ${run.detector}.`;
    setReviewMessage(message);
    markWorkspaceDirty();
    logRuntime('info', message);
  }

  async function acceptRun(runId = activeRunId || '', opts: { agentInitiated?: boolean; commandId?: string } = {}): Promise<boolean> {
    const applyAcceptance = async (): Promise<Record<string, unknown> | null> => {
      const target = runRecords.find((run) => run.runId === runId);
      if (!runId || !target) {
        setReviewMessage(runId ? `Run not found: ${runId}.` : 'No active run to accept.');
        return null;
      }
      if (acceptedRunId === runId && target.accepted === true) {
        setReviewMessage(`Run ${runId} is already accepted.`);
        return null;
      }
      const previousAcceptedRunId = acceptedRunId;
      setActiveRunId(runId);
      setAcceptedRunId(runId);
      setRunRecords((current) => current.map((run) => ({ ...run, accepted: run.runId === runId, status: run.runId === runId ? 'accepted' : run.status })));
      setReviewMessage(`Accepted active run ${runId}.`);
      logRuntime('success', `Accepted run ${runId} for downstream export.`);
      markWorkspaceDirty();
      await Promise.resolve();
      return {
        source: 'renderer_state_transition',
        accepted_run_id: runId,
        previous_accepted_run_id: previousAcceptedRunId || null,
        accepted_flag: true
      };
    };

    if (!opts.commandId) return Boolean(await applyAcceptance());
    const settlement = await settleAgentReviewWrite({
      commandType: 'review.accept_run',
      execute: applyAcceptance,
      acknowledge: (outcome) => ackUICommand(opts.commandId!, outcome)
    });
    if (opts.agentInitiated) {
      notifyAgentOfRunResult({
        label: 'Accept review run',
        status: settlement.status === 'complete' ? 'complete' : 'failed',
        detail: settlement.detail
      }, opts.commandId ? commandUiThreadIdsRef.current.get(opts.commandId) : undefined);
    }
    return settlement.status === 'complete';
  }

  async function createConsensusRun(strategy: ConsensusStrategy = 'majority', opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    const sourceRuns = runRecords.filter((run) => isRunVisible(run.runId, visibleRunIds) && !isConsensusRun(run));
    if (sourceRuns.length < 2) {
      const message = 'Show at least two non-consensus detector runs before building consensus.';
      setReviewMessage(message);
      setStatusMessage(message);
      closeAgentCommandWithoutOperation(opts, `Create ${strategy} consensus`, 'failed', message);
      return;
    }
    const runEventPairs = sourceRuns.map((run) => ({ run, events: runEventsByRun[run.runId] || (run.runId === activeRunId ? reviewEvents : []) }));
    const sourceRunsWithEvents = runEventPairs.filter((entry) => entry.events.length);
    if (sourceRunsWithEvents.length < 2) {
      const message = 'Consensus needs event rows from at least two source runs. Re-open or create detector runs so their event tables are cached.';
      setReviewMessage(message);
      setStatusMessage(message);
      logRuntime('warning', message);
      closeAgentCommandWithoutOperation(opts, `Create ${strategy} consensus`, 'failed', message);
      return;
    }
    const operation = beginOperation(`Create ${strategy} consensus`, 'review', { agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    const sourceEvents = Object.fromEntries(sourceRunsWithEvents.map(({ run, events }) => [run.runId, events]));
    let consensusRun: RunRecord;
    let stampedConsensusEvents: ReviewEvent[];
    let consensusSource = 'backend';
    let terminalProof: Record<string, unknown> | undefined;
    try {
      const result = await backendClient.createConsensusRun({
        strategy,
        biomarker: sourceRunsWithEvents[0]?.run.biomarker || 'HFO',
        run_ids: sourceRunsWithEvents.map(({ run }) => run.runId),
        events_by_run: sourceEvents
      }) as { status?: string; run?: RunRecord; events?: ReviewEvent[] };
      if (!result.run || !Array.isArray(result.events)) throw new Error('Backend consensus response was missing run/events.');
      consensusRun = { ...result.run, runId: result.run.runId || (result.run as RunRecord & { run_id?: string }).run_id || `consensus-${strategy}-${Date.now()}` };
      stampedConsensusEvents = result.events;
      terminalProof = backendComputeTerminalProof(result, {
        run_id: consensusRun.runId,
        ...(SHA256_HEX_PATTERN.test(String(metadata?.recording_fingerprint || '').trim().toLowerCase())
          ? { recording_fingerprint: String(metadata?.recording_fingerprint).trim().toLowerCase() }
          : {}),
      });
    } catch (exc) {
      if (opts.commandId) {
        const message = `Backend consensus failed; no agent-approved renderer fallback was applied: ${exc instanceof Error ? exc.message : String(exc)}`;
        setReviewMessage(message);
        setStatusMessage(message);
        finishOperation(operation, 'error', message, undefined, 'failed', { code: 'execution_failed', message, retryable: false });
        return;
      }
      consensusSource = 'renderer-fallback';
      const consensusEvents = buildConsensusEvents(sourceEvents, strategy, sourceRunsWithEvents[0]?.run.biomarker || 'HFO');
      const consensusRunId = `consensus-${strategy}-${Date.now()}`;
      consensusRun = {
        runId: consensusRunId,
        biomarker: sourceRunsWithEvents[0]?.run.biomarker || 'HFO',
        detector: `Consensus ${titleCase(strategy)}`,
        events: consensusEvents.length,
        channels: new Set(consensusEvents.map((event) => event.channel || '--')).size,
        status: 'consensus',
        classifier: `from ${sourceRunsWithEvents.length} runs`,
        createdAt: new Date().toISOString(),
        parameters: {
          consensus_strategy: strategy,
          consensus_source_run_ids: sourceRunsWithEvents.map(({ run }) => run.runId).join(','),
          consensus_support_threshold: consensusSupportThreshold(strategy, sourceRunsWithEvents.length),
          source_event_count: sourceRunsWithEvents.reduce((sum, entry) => sum + entry.events.length, 0),
          consensus_fallback_reason: exc instanceof Error ? exc.message : String(exc)
        }
      };
      stampedConsensusEvents = consensusEvents.map((event, index) => ({
        ...event,
        event_id: `${consensusRunId}-evt-${index + 1}`,
        run_id: consensusRunId,
        index
      }));
    }
    setRunRecords((current) => [consensusRun, ...current]);
    setActiveRunId(consensusRun.runId);
    setReviewEvents(stampedConsensusEvents);
    setVisibleRunIds((current) => [consensusRun.runId, ...current.filter((id) => id !== consensusRun.runId)]);
    setRunEventsByRun((current) => ({ ...current, [consensusRun.runId]: stampedConsensusEvents }));
    const message = `Created ${strategy} consensus run from ${sourceRunsWithEvents.length} runs via ${consensusSource}: ${stampedConsensusEvents.length} event(s).`;
    setReviewMessage(message);
    setStatusMessage(message);
    markWorkspaceDirty();
    finishOperation(operation, 'success', message, terminalProof);
  }

  async function exportRunWorkbook(runId = activeRunId || runRecords[0]?.runId || '', opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    await exportRunArtifact('workbook', runId, opts);
  }

  async function exportRunSession(runId = activeRunId || runRecords[0]?.runId || '', opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    if (!runRecords.length && !recordingPath) {
      setReviewMessage('Open a recording or create a detection run before saving a session.');
      closeAgentCommandWithoutOperation(opts, 'Save session', 'failed', 'Open a recording or create a detection run before saving a session.');
      return;
    }
    const operation = beginOperation('Save session', 'export', { agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    try {
      setError(null);
      const activeRun = runRecords.find((run) => run.runId === activeRunId) || runRecords[0] || null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeRunId = safeArtifactStem(runId || activeRunId || 'session');
      const sessionState = {
        schema_version: 'electron-pyqt-session.v1',
        biomarker_type: activeRun?.biomarker || runRecords[0]?.biomarker || 'HFO',
        recording_path: recordingPath,
        recording_info: metadata,
        active_run_id: activeRunId,
        accepted_run_id: acceptedRunId,
        visible_run_ids: visibleRunIds,
        run_records: runRecords,
        detection_runs: runRecords,
        review_events: reviewEvents,
        review_events_by_run: runEventsByRun,
      severity_result: severityState.result,
      agent_conversations: agentConversations,
      active_agent_conversation_id: activeAgentConversationId,
        review_cursor_event_id: selectedReviewEventId,
        classifier_controls: classifierControls,
        prepare_controls: prepareControls,
        recording_analysis: recordingAnalysis,
        runtime_log: runtimeLog.slice(-50),
        generated_by: 'electron-overview-statistics'
      };
      updateOperation(operation, 35, `Session export payload prepared for ${runId || activeRunId || 'current workspace'}.`);
      const result = await backendClient.saveSessionExport({ default_name: `session-${stamp}-${safeRunId}.pybrain`, session_state: sessionState }) as ExportArtifactResult;
      if (result.canceled) {
        setReviewMessage('Save session cancelled.');
        setStatusMessage('Save session cancelled.');
        finishOperation(operation, 'warning', 'Save session cancelled by user.', undefined, 'failed', { code: 'cancelled', message: 'Save session cancelled by user.', retryable: false });
        return;
      }
      const terminalProof = backendArtifactTerminalProof(result);
      const artifactPath = result.artifact_path || 'backend artifact';
      if (result.artifact_path) recordAgentArtifact({ label: 'Save session', type: 'session', path: result.artifact_path, source: 'backend', runId: runId || activeRunId || undefined, status: result.status || 'complete' });
      setReviewMessage(`Save session complete: ${artifactPath}.`);
      setStatusMessage(`Save session complete: ${artifactPath}.`);
      finishOperation(operation, 'success', `Session export wrote ${artifactPath}.`, terminalProof);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setReviewMessage(`Save session failed: ${message}`);
      setStatusMessage('Save session failed.');
      finishOperation(operation, 'error', message);
    }
  }

  async function exportRunReport(runId = activeRunId || runRecords[0]?.runId || '', opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    await exportRunArtifact('report', runId, opts);
  }

  async function exportRunArtifact(kind: 'workbook' | 'report', runId: string, opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    if (!runRecords.length) {
      setReviewMessage('Create or load a detection run before exporting.');
      closeAgentCommandWithoutOperation(opts, kind === 'workbook' ? 'Export workbook' : 'Export report', 'failed', 'Create or load a detection run before exporting.');
      return;
    }
    const label = kind === 'workbook' ? 'Export workbook' : 'Export report';
    const operation = beginOperation(label, 'export', { agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    try {
      setError(null);
      const payload = buildRunExportPayload(kind, runId);
      updateOperation(operation, 35, `${label} payload prepared for ${runId || 'active run'}.`);
      const result = (kind === 'workbook' ? await backendClient.saveWorkbookExport({ ...payload, default_name: payload.output_path }) : await backendClient.saveReportExport({ ...payload, default_name: payload.output_path })) as ExportArtifactResult;
      if (result.canceled) {
        setReviewMessage(`${label} cancelled.`);
        setStatusMessage(`${label} cancelled.`);
        finishOperation(operation, 'warning', `${label} cancelled by user.`, undefined, 'failed', { code: 'cancelled', message: `${label} cancelled by user.`, retryable: false });
        return;
      }
      const terminalProof = backendArtifactTerminalProof(result);
      const artifactPath = result.artifact_path || 'backend artifact';
      if (result.artifact_path) recordAgentArtifact({ label, type: kind, path: result.artifact_path, source: 'backend', runId: runId || activeRunId || undefined, status: result.status || 'complete' });
      setReviewMessage(`${label} complete: ${artifactPath}.`);
      setStatusMessage(`${label} complete: ${artifactPath}.`);
      finishOperation(operation, 'success', `${label} wrote ${result.artifact_type || 'artifact'} at ${artifactPath}.`, terminalProof);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setError(message);
      setReviewMessage(`${label} failed: ${message}`);
      setStatusMessage(`${label} failed.`);
      finishOperation(operation, 'error', message);
    }
  }

  function buildRunExportPayload(kind: 'workbook' | 'report', selectedRunId: string) {
    const selectedRun = runRecords.find((run) => run.runId === selectedRunId) || runRecords.find((run) => run.runId === activeRunId) || runRecords[0] || null;
    const activeRun = runRecords.find((run) => run.runId === activeRunId) || selectedRun;
    const selectedEvents = selectedRun ? (runEventsByRun[selectedRun.runId] || (selectedRun.runId === activeRunId ? reviewEvents : [])) : reviewEvents;
    const reviewedEvents = selectedEvents.filter((event) => event.annotation);
    const annotations = Object.fromEntries(reviewedEvents.map((event) => [event.event_id, event.annotation]));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeRunId = safeArtifactStem(selectedRun?.runId || activeRun?.runId || 'session');
    const waveformSnapshot = kind === 'report' ? currentWaveformSnapshotPayload() : undefined;
    return {
      output_path: `run-statistics-${stamp}-${safeRunId}-${kind === 'workbook' ? 'workbook.xlsx' : 'report.html'}`,
      summary: {
        recording_path: recordingPath,
        active_run_id: activeRun?.runId || null,
        selected_run_id: selectedRun?.runId || null,
        accepted_run_id: acceptedRunId,
        visible_run_ids: visibleRunIds,
        run_count: runRecords.length,
        visible_run_count: runRecords.filter((run) => isRunVisible(run.runId, visibleRunIds)).length,
        event_count: selectedEvents.length,
        reviewed_count: reviewedEvents.length,
        pending_count: Math.max(0, selectedEvents.length - reviewedEvents.length),
        generated_by: 'electron-run-statistics'
      },
      recording_info: metadata,
      runs: runRecords,
      active_run: activeRun,
      selected_run: selectedRun,
      accepted_run_id: acceptedRunId,
      visible_run_ids: visibleRunIds,
      channel_ranking: rankReviewChannels(selectedEvents),
      review_state: {
        cursor_event_id: selectedReviewEventId,
        events: selectedEvents,
        events_by_run: runEventsByRun,
        annotations,
        review_message: reviewMessage
      },
      waveform_snapshot: waveformSnapshot,
      artifacts: collectRunArtifacts(runRecords, selectedRun),
      runtime_log: runtimeLog.slice(-50)
    };
  }

  function currentWaveformSnapshotPayload(): { data_url: string; filename: string; source: string } | undefined {
    const canvas = typeof document !== 'undefined' ? document.querySelector<HTMLCanvasElement>('[data-testid="pyqt-waveform_event_overlay_canvas"]') : null;
    if (!canvas) return undefined;
    try {
      return { data_url: compactWaveformSnapshotDataUrl(canvas), filename: 'waveform_snapshot.png', source: 'electron-waveform-canvas' };
    } catch {
      return undefined;
    }
  }

  async function overlapReview(opts: { agentInitiated?: boolean; commandId?: string } = {}) {
    const activeRunEvents = activeRunId ? (runEventsByRun[activeRunId] || reviewEvents) : reviewEvents;
    const events = activeRunEvents.length ? activeRunEvents : reviewEvents;
    const operation = beginOperation('Group overlapping events', 'review', { indeterminate: true, agentInitiated: opts.agentInitiated, commandId: opts.commandId });
    try {
      const result = await backendClient.overlapReview({ run_id: activeRunId || undefined, events, tolerance_seconds: 0 }) as { overlap_count?: number };
      const message = `Overlap review complete${activeRunId ? ` for ${activeRunId}` : ''}: ${result.overlap_count || 0} overlap group(s).`;
      setReviewMessage(message);
      finishOperation(operation, 'success', message);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      setReviewMessage(message);
      finishOperation(operation, 'error', message);
    }
  }

  function reviewEventContext(eventOrId: ReviewEvent | string): { eventId: string; runId?: string; events: ReviewEvent[] } {
    const eventId = typeof eventOrId === 'string' ? eventOrId : eventOrId.event_id;
    const event = typeof eventOrId === 'string'
      ? reviewEvents.find((candidate) => candidate.event_id === eventId) || Object.values(runEventsByRun).flat().find((candidate) => candidate.event_id === eventId)
      : eventOrId;
    const runId = event?.run_id || activeRunId || undefined;
    const runScopedEvents = runId ? (runEventsByRun[runId] || (runId === activeRunId ? reviewEvents : [])) : [];
    const events = runScopedEvents.some((candidate) => candidate.event_id === eventId)
      ? runScopedEvents
      : reviewEvents.some((candidate) => candidate.event_id === eventId)
        ? reviewEvents
        : runScopedEvents.length ? runScopedEvents : reviewEvents;
    return { eventId, runId, events };
  }

  function selectReviewEventForCursor(event: ReviewEvent) {
    setSelectedReviewEventId(event.event_id);
    markWorkspaceDirty();
    const context = reviewEventContext(event);
    void backendClient.moveEventCursor({ action: 'select', event_id: context.eventId, run_id: context.runId, events: context.events })
      .then((result) => {
        const selected = result as { cursor?: { event_id?: string }, event?: ReviewEvent };
        const cursorEventId = selected.cursor?.event_id || selected.event?.event_id;
        if (cursorEventId) setSelectedReviewEventId(cursorEventId);
      })
      .catch((exc) => {
        logRuntime('warning', `Event cursor sync failed: ${exc instanceof Error ? exc.message : String(exc)}`);
      });
  }

  async function annotateEvent(
    eventOrId: ReviewEvent | string,
    label: string,
    notes: string,
    reviewer = 'human',
    source = 'electron-ui',
    opts: { agentInitiated?: boolean; commandId?: string } = {}
  ): Promise<void> {
    const context = reviewEventContext(eventOrId);
    const applyAnnotation = async (): Promise<Record<string, unknown>> => {
      const backendLabel = backendAnnotationLabel(label);
      const backendResult = asRecord(await backendClient.annotateEvent({ event_id: context.eventId, run_id: context.runId, label: backendLabel, display_label: label, notes, reviewer, source, confirmed: true, events: context.events }));
      if (backendResult.status !== 'complete') throw new Error(`Annotation backend returned ${String(backendResult.status || 'no terminal status')}.`);
      const refreshedEvents = await refreshReviewEvents(context.runId, { throwOnError: true });
      const observed = refreshedEvents.find((event) => event.event_id === context.eventId);
      const observedLabel = String(observed?.annotation?.label || '');
      if (backendLabel === 'clear') {
        if (observed?.annotation) throw new Error(`Annotation clear for event ${context.eventId} was not visible in backend read-back.`);
      } else if (!observed?.annotation || observedLabel !== backendLabel) {
        throw new Error(`Annotation ${backendLabel} for event ${context.eventId} was not visible in backend read-back.`);
      }
      setReviewMessage(`Event ${context.eventId} marked ${label} (${backendLabel}).`);
      markWorkspaceDirty();
      return {
        source: 'backend_readback',
        event_id: context.eventId,
        run_id: context.runId || null,
        backend_status: backendResult.status,
        requested_annotation_label: label,
        expected_annotation_label: backendLabel,
        observed_annotation_label: backendLabel === 'clear' ? null : observedLabel,
        annotation_cleared: backendLabel === 'clear',
        annotation_present: backendLabel !== 'clear',
        observed_updated_at: observed?.annotation?.updated_at || null
      };
    };

    if (!opts.commandId) {
      try {
        await applyAnnotation();
        return;
      } catch (exc) {
        setReviewMessage(exc instanceof Error ? exc.message : String(exc));
        return;
      }
    }

    // The operation card is renderer UX only; settleAgentReviewWrite owns the
    // command receipt so finishOperation cannot emit a second terminal ACK.
    const operation = beginOperation(`Annotate event ${context.eventId}`, 'review', {
      indeterminate: true,
      agentInitiated: opts.agentInitiated
    });
    const settlement = await settleAgentReviewWrite({
      commandType: label === 'clear' ? 'events.clear_staged_annotation' : 'events.stage_annotation',
      execute: applyAnnotation,
      acknowledge: (outcome) => ackUICommand(opts.commandId!, outcome)
    });
    if (settlement.status !== 'complete') setReviewMessage(settlement.detail);
    finishOperation(operation, settlement.status === 'complete' ? 'success' : 'error', settlement.detail);
  }

  async function loadEventSnippet(event: ReviewEvent, paddingSeconds = 1): Promise<ReviewSnippet | null> {
    if (isVisualFixtureMode()) return visualFixtureEventSnippet(event);
    const context = reviewEventContext(event);
    try {
      const snippet = await backendClient.eventSnippet({ event_id: context.eventId, run_id: context.runId, padding_seconds: paddingSeconds, target_samples_per_channel: 900, events: context.events }) as ReviewSnippet;
      return snippet;
    } catch (exc) {
      setReviewMessage(exc instanceof Error ? exc.message : String(exc));
      return null;
    }
  }

  async function loadEventFeatureSummary(event: ReviewEvent): Promise<EventFeatureSummary | null> {
    if (isVisualFixtureMode()) return visualFixtureEventFeatureSummary(event);
    const context = reviewEventContext(event);
    try {
      return await backendClient.eventFeatureSummary({ event_id: context.eventId, run_id: context.runId, events: context.events }) as EventFeatureSummary;
    } catch (exc) {
      setReviewMessage(exc instanceof Error ? exc.message : String(exc));
      return null;
    }
  }

  // Serialize user-visible agent turns so one streaming reply cannot clobber another.
  function enqueueAgentTurn(run: () => Promise<void>): Promise<void> {
    const next = agentTurnChain.current.then(run, run) as Promise<void>;
    agentTurnChain.current = next.catch(() => undefined);
    return next;
  }

  // Prepend a compact loaded-recording hint so the model does not ask for a file path. Live UI state
  // is not copied into the prompt/request; the agent must call MCP `get_ui_state` for panel, viewport,
  // selection, events, and waveform image availability.
  function agentMessageWithContext(message: string): string {
    if (!recordingPath) return message;
    const channels = metadata?.channel_names?.length ?? metadata?.n_channels ?? metadata?.num_channels;
    const hz = metadata?.sample_freq ?? metadata?.sampling_frequency ?? metadata?.sample_frequency_hz;
    const seconds = metadata?.duration_seconds ?? metadata?.length_seconds;
    const facts = [
      `path: ${recordingPath}`,
      channels ? `${channels} channels` : null,
      hz ? `${hz} Hz` : null,
      seconds != null ? `${Math.round(Number(seconds))}s` : null
    ].filter(Boolean).join(', ');
    // Phrased as a PASSIVE system note, not an imperative. An earlier version read
    // "...Operate on it directly; call get_ui_state for live panel, viewport, event, and
    // channel state." — the planner splits comma/semicolon clauses in the user request into
    // independent subtasks (agent_controller_user.md), so that imperative got mis-read as a
    // user-requested subtask and a bare "hi" was decomposed into a 2-step plan that greeted
    // twice. Keep the "[Desktop context:" prefix verbatim so the runtime idempotency guard
    // (_augment_message_with_recording_context) still no-ops. Must match agent_service.py.
    return `[Desktop context: (system note, not a user request) a recording is already loaded in the workspace — ${facts}. Treat it as the input recording and do not ask the user for a file path. Live panel, viewport, event, and channel state is available from the get_ui_state tool if needed.]\n\n${message}`;
  }

  // Core of one agent turn: stream (or job-poll) a reply for `outgoing`, render it live via the
  // responding bubble, and append the final reply.
  async function runAgentTurn(outgoing: string, kind: 'user' | 'observation', turnScope: AgentTurnScope, opts: { suppressIfUserTurnEpochChanged?: number; allowUiCommands?: boolean } = {}) {
    const suppressed = () => opts.suppressIfUserTurnEpochChanged !== undefined && agentUserTurnEpoch.current !== opts.suppressIfUserTurnEpochChanged;
    if (suppressed() || closedAgentConversationIdsRef.current.has(turnScope.uiThreadId)) return;
    const visibleTurn = kind === 'user';
    try {
      if (kind === 'user') setAgentTurnError(turnScope.uiThreadId, null);
      if (visibleTurn) {
        setBusyConversationId(turnScope.uiThreadId);
        setAgentTurnStreamingText(turnScope.uiThreadId, '');
        setAgentTurnStatus(turnScope.uiThreadId, 'Agent is thinking…');
      }
      const waveformImage = recordingPath && messageWantsWaveformVision(outgoing) ? currentWaveformSnapshotPayload()?.data_url : undefined;
      const uiState = agentUiStatePayload(waveformImage);
      const stateRevision = String(uiState.state_revision || agentWorkspaceStateRevision());
      await backendClient.uiBrokerReportState({ ui_state: uiState }).catch(() => undefined);
      const sent = agentMessageWithContext(outgoing);
      // Prefer the live SSE bridge so the workspace moves mid-turn; fall back to the PyHFO job-poll
      // path when streaming can't start (agent runtime down / not an Electron build).
      const canStream = typeof window !== 'undefined' && Boolean(window.ieeg?.streamAgentMessage);
      if (canStream) {
        try {
          const streamed = await runStreamingAgentTurn(sent, turnScope, { ...opts, showStreaming: visibleTurn, allowUiCommands: opts.allowUiCommands, stateRevision });
          if (suppressed()) return;
          logRuntime('info', `Agent stream ingested ${streamed} UI command(s).`);
          return;
        } catch (streamErr) {
          logRuntime('warning', `Agent stream unavailable (${streamErr instanceof Error ? streamErr.message : String(streamErr)}); using job poll.`);
        }
      }
      const submitted = asRecord(await backendClient.sendAgentMessage({ message: sent, conversation_id: turnScope.backendConversationId, recording_path: recordingPath, state_revision: stateRevision }));
      if (suppressed()) return;
      setAgentTurnStatus(turnScope.uiThreadId, submitted.job_id ? 'Agent is thinking… waiting for backend UI commands.' : 'Agent response received.');
      const agentResult = submitted.job_id ? await pollAgentChatResult(String(submitted.job_id), turnScope) : (submitted.result ?? submitted);
      if (suppressed()) return;
      const commandResult = opts.allowUiCommands === false ? { count: 0, waitingForOperation: false } : ingestAgentUICommands(agentResult, turnScope.uiThreadId);
      logRuntime('info', `Agent response ingested ${commandResult.count} backend UI command(s).`);
      const replyRec = asRecord(agentResult);
      const replyNested = asRecord(replyRec.result);
      const replyContent = typeof replyRec.content === 'string' ? replyRec.content : typeof replyNested.content === 'string' ? replyNested.content : '';
      if (replyContent.trim() && !commandResult.waitingForOperation) appendAgentReply(turnScope.uiThreadId, replyContent);
      setAgentTurnError(turnScope.uiThreadId, null);
      setAgentTurnStatus(turnScope.uiThreadId, commandResult.waitingForOperation ? `Agent requested ${commandResult.count} UI command(s); waiting for operation result.` : `Agent response received: ${commandResult.count} UI command(s) ingested.`);
    } catch (exc) {
      if (suppressed()) return;
      const messageText = exc instanceof Error ? exc.message : String(exc);
      if (kind === 'user') {
        setAgentTurnError(turnScope.uiThreadId, messageText);
        // Also say it in the thread that asked. A failed turn that only lights a scoped error banner
        // leaves the conversation looking like the message was never sent -- the user's line sits
        // there with no answer and no reason, which is how a runtime crash read as "nothing happened".
        appendToConversation(turnScope.uiThreadId, { role: 'observation' as const, text: `This turn failed. ${messageText}`, ts: Date.now() });
        setAgentTurnStatus(turnScope.uiThreadId, 'Agent message failed.');
      } else {
        logRuntime('warning', `Agent observation turn failed: ${messageText}`);
        setAgentTurnStatus(turnScope.uiThreadId, 'Agent observation unavailable.');
      }
    } finally {
      if (suppressed()) return;
      if (!visibleTurn) return;
      // Clears the responding bubble on the job-poll path and on error. The streaming path already
      // retires it atomically inside finish(), so this is a no-op there.
      setBusyConversationId((current) => current === turnScope.uiThreadId ? null : current);
      setAgentTurnStreamingText(turnScope.uiThreadId, '');
    }
  }

  async function sendAgentMessage() {
    if (!message.trim()) return;
    agentUserTurnEpoch.current += 1;
    const outgoing = message;
    const uiThreadId = activeAgentConversationId;
    const turnScope: AgentTurnScope = {
      uiThreadId,
      backendConversationId: agentConversationId(uiThreadId),
    };
    setMessage(''); // clear the composer the moment you hit send — don't leave the prompt sitting in the box through the turn
    setError(null);
    setAgentTurnError(uiThreadId, null);
    setAgentTurnStatus(uiThreadId, 'Sending agent message…');
    appendToConversation(uiThreadId, { role: 'user' as const, text: outgoing, ts: Date.now() });
    recordUICommand({ command_id: `agent-message-${Date.now()}`, type: 'agent.show_trace_step', reason: outgoing.slice(0, 120) || 'Agent message sent', payload: { panel: 'Chat', message: outgoing }, created_at: new Date().toISOString() }, 'agent', uiThreadId);
    await enqueueAgentTurn(() => runAgentTurn(outgoing, 'user', turnScope));
  }

  // Run lifecycle cards in the transcript: an agent-staged run, once applied, shows here as running →
  // complete/failed so the run's status lives on the chat surface (not just the Actions tab/status strip).
  function pushAgentRunCard(meta: Omit<AgentChatRunMeta, 'id'>, uiThreadId = activeAgentConversationId): string {
    const id = `runcard-${Date.now()}-${agentRunCardSeq.current++}`;
    appendToConversation(uiThreadId, { role: 'run' as const, text: meta.label, ts: Date.now(), run: { id, ...meta } });
    return id;
  }

  function updateAgentRunCard(id: string, patch: Partial<AgentChatRunMeta>) {
    setAgentConversations((current) => current.map((conversation) => ({
      ...conversation,
      log: conversation.log.map((entry) => (entry.role === 'run' && entry.run?.id === id
        ? { ...entry, run: { ...entry.run, ...patch } as AgentChatRunMeta }
        : entry)),
    })));
  }

  function notifyAgentOfRunResult(summary: { label: string; status: 'complete' | 'failed'; detail?: string }, uiThreadId = activeAgentConversationId) {
    const text = `${summary.label} ${summary.status === 'complete' ? 'complete' : 'failed'}${summary.detail ? `: ${summary.detail}` : '.'}`;
    // A run-result note is a SYSTEM observation, not an LLM reply — render it as role 'observation' so
    // it never carries the 'agent' reply testid. (It fires async when a run finishes, which can land
    // mid-way through a later turn; sharing the reply testid made automation read it as that turn's reply.)
    appendToConversation(uiThreadId, { role: 'observation' as const, text, ts: Date.now() });
    setAgentTurnStatus(uiThreadId, `${summary.label} ${summary.status === 'complete' ? 'complete' : 'failed'}; result recorded in Agent chat.`);
  }

  function markDeferredAction(action: string) {
    recordUICommand({ command_id: `user-action-${Date.now()}`, type: 'workspace.show_toast', reason: action, payload: { panel: 'workspace', message: action }, created_at: new Date().toISOString() }, 'user');
    setStatusMessage(action);
  }

  // UI MCP connector (last mile): report ui_state to the broker + apply its queued commands so an
  // external MCP agent (Claude) can drive this live workspace. Refs keep the timers on fresh closures.
  const brokerStateRef = useRef<() => Record<string, unknown>>(() => ({}));
  brokerStateRef.current = () => agentUiStatePayload();
  const brokerApplyRef = useRef<(cmd: unknown) => BrokerCommandDispatch>(() => ({
    commandId: '', shouldAcknowledge: false, outcome: null,
  }));
  brokerApplyRef.current = (cmd: unknown) => dispatchBrokerCommand(cmd, {
    normalize: normalizeAgentCommand,
    isRecorded: (commandId) => recordedCommandIdsRef.current.has(commandId),
    apply: (command) => applyRecordedEntry(recordUICommand(command, 'agent')),
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.ieeg?.uiBrokerPoll) return;
    const seen = new Set<string>();
    const reportTimer = window.setInterval(() => {
      backendClient.uiBrokerReportState({ ui_state: brokerStateRef.current() }).catch(() => undefined);
    }, 1500);
    const pollTimer = window.setInterval(async () => {
      try {
        const res = asRecord(await backendClient.uiBrokerPoll());
        const commands = Array.isArray(res.commands) ? res.commands : [];
        for (const raw of commands) {
          const id = String(asRecord(raw).command_id || '');
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          const dispatch = brokerApplyRef.current(raw);
          if (!dispatch.shouldAcknowledge) continue;
          // Ack the REAL renderer outcome (applied / rejected + reason / staged), not a hardcoded
          // {received:true}, so the broker — and the agent polling it — learn whether the command
          // actually moved the UI instead of assuming success off the broker enqueue.
          brokerAckRef.current(dispatch.commandId || id, dispatch.outcome ?? {
            status: 'rejected', reason: 'command not recognized',
          });
        }
      } catch { /* broker down / transient — ignore */ }
    }, 700);
    return () => { window.clearInterval(reportTimer); window.clearInterval(pollTimer); };
  }, []);

  return <Suspense fallback={<div data-testid="app-loading-shell" />}><MainWindowShell recordingPath={recordingPath} metadata={metadata} quickDetectionMetadata={isVisualFixtureMode() ? visualFixtureQuickDetectionMetadata() : null} recentRecordings={recentRecordings} projectPath={projectPath} projectId={projectId} projectDirty={projectDirty} capabilityManifest={capabilityManifest} waveform={waveform} waveformControls={waveformControls} prepareControls={prepareControls} recordingAnalysis={recordingAnalysis} classifierControls={classifierControls} classifierFeedback={classifierFeedback} severityState={severityState} runRecords={runRecords} activeRunId={activeRunId} acceptedRunId={acceptedRunId} visibleRunIds={visibleRunIds} runEventsByRun={runEventsByRun} reviewEvents={reviewEvents} selectedReviewEventId={selectedReviewEventId} runtimeOperation={runtimeOperation} runtimeLog={runtimeLog} uiCommandHistory={uiCommandHistory} pendingShellCommand={pendingShellCommand} onShellCommandHandled={(commandId) => setPendingShellCommand((current) => current?.command_id === commandId ? null : current)} agentArtifacts={agentArtifacts} error={error} message={message} agentChatLog={agentChatLog} agentConversations={agentConversations.map(({ id, title }) => ({ id, title }))} activeAgentConversationId={activeAgentConversationId} onSelectAgentConversation={selectAgentConversation} onNewAgentConversation={startAgentConversation} onCloseAgentConversation={closeAgentConversation} agentResponding={agentResponding} agentStreamingText={agentStreamingText} agentAutonomy={agentAutonomy} onAgentAutonomyChange={setAgentAutonomy} statusMessage={statusMessage} onMessageChange={setMessage} onNewProject={newProject} onOpenProject={openProject} onSaveProject={saveProject} onOpenRecording={openAndLoadRecording} onOpenRecentRecording={openRecentRecording} onRemoveRecentRecording={removeRecentRecording} onClearRecentRecordings={clearRecentRecordings} onOpenSavedSession={openSavedSession} onOpenClassifierModel={openClassifierModel} onLoadSavedSession={loadSavedSession} onSendAgentMessage={sendAgentMessage} onWaveformControlsChange={handleWaveformControlsChange} onPrepareControlsChange={handlePrepareControlsChange} onRecordingAnalysisChange={handleRecordingAnalysisChange} onClassifierControlsChange={handleClassifierControlsChange} onClassifierFeedbackChange={setClassifierFeedback} onAnalyzeRecordingPlanning={analyzeRecordingPlanning} onApplyFilters={applyFilters} onSaveNJobs={saveNJobs} onRunDetection={runDetection} onRunClassifier={runClassifier} onRunSeverityScoring={runSeverityScoring} onCancelSeverityScoring={cancelSeverityScoring} onSeekToSeconds={seekWaveformToSeconds} onCancelRuntimeOperation={cancelRuntimeOperation} onActivateRun={activateRun} onToggleRunVisible={toggleRunVisible} onAcceptRun={acceptRun} onCreateConsensusRun={createConsensusRun} onExportSession={exportRunSession} onExportWorkbook={exportRunWorkbook} onExportReport={exportRunReport} onSelectReviewEvent={selectReviewEventForCursor} onAnnotateEvent={annotateEvent} onLoadEventSnippet={loadEventSnippet} onLoadEventFeatureSummary={loadEventFeatureSummary} onSavePngSnapshot={savePngSnapshot} onOpenAgentArtifact={openAgentArtifact} onRevealAgentArtifact={revealAgentArtifact} onRemoveAgentArtifact={removeAgentArtifact} onClearAgentArtifacts={clearAgentArtifacts} onApplyStagedCommand={applyStagedUICommand} onDismissStagedCommand={dismissStagedUICommand} onOverlapReview={overlapReview} onUpdatePlot={updatePlot} onDeferredAction={markDeferredAction} onUiSurfaceChange={handleUiSurfaceChange} /></Suspense>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function unwrapSidecarResult<T>(response: unknown): T {
  const record = asRecord(response);
  if ('result' in record && (typeof record.action === 'string' || 'state' in record)) return record.result as T;
  return response as T;
}

function extractAgentUICommands(response: unknown): UICommand[] {
  const record = asRecord(response);
  const nested = asRecord(record.result);
  const explicit = firstArray(record.ui_commands) || firstArray(record.commands) || firstArray(nested.ui_commands) || firstArray(nested.commands) || [];
  const commands = explicit.map((item, index) => normalizeAgentUICommand(item, index)).filter((item): item is UICommand => item !== null);
  if (commands.length > 0) return commands;
  const content = typeof record.content === 'string' ? record.content : typeof nested.content === 'string' ? nested.content : '';
  if (!content.trim()) return [];
  return [{
    command_id: `agent-response-${Date.now()}`,
    type: 'agent.show_trace_step',
    reason: 'Agent response received',
    payload: { panel: 'Chat', message: content.slice(0, 2000) },
    requires_confirmation: false,
    created_at: new Date().toISOString()
  }];
}

function normalizeAgentUICommand(value: unknown, index: number): UICommand | null {
  return normalizeAgentCommand(value, index);
}

function firstArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function detectorRunRequestFromAgentCommand(payload: Record<string, unknown>): DetectorRunRequest {
  const biomarker = biomarkerFromValue(payload.biomarker);
  const detector = detectorFromAgentValue(biomarker, payload.detector);
  const detectorParams = detectorParamsFromAgentPayload(biomarker, detector, payload);
  return {
    biomarker,
    detector,
    detectorParams,
    uiValues: stringRecord(payload.ui_values || payload.uiValues),
    filter: filterFromAgentPayload(biomarker, payload),
    nJobs: optionalPositiveInteger(payload.n_jobs || payload.nJobs),
    exports: stringArray(payload.exports),
    sessionFormat: sessionFormatFromValue(payload.session_format || payload.sessionFormat),
    classifier: hasObjectPayload(payload.classifier) ? asRecord(payload.classifier) : undefined,
    classifierLabel: typeof payload.classifier_label === 'string' ? payload.classifier_label : typeof payload.classifierLabel === 'string' ? payload.classifierLabel : undefined,
    scope: payload.scope === 'all' || payload.channel_scope === 'all' || payload.channelScope === 'all' ? 'all' : undefined,
    allChannels: payload.all_channels === true || payload.allChannels === true,
    includeChannels: stringArray(payload.include_channels ?? payload.includeChannels),
    excludeChannels: stringArray(payload.exclude_channels ?? payload.excludeChannels),
    outputDir: optionalNonemptyString(payload.output_dir ?? payload.outputDir),
  };
}

const DEFAULT_AGENT_DETECTOR_BY_BIOMARKER: Record<DetectorRunRequest['biomarker'], string> = {
  HFO: 'STE',
  Spindle: 'MOLLE',
  Spike: 'RMS/LL'
};

function detectorFromAgentValue(biomarker: DetectorRunRequest['biomarker'], value: unknown): string {
  const valid = detectorTabsByBiomarker[biomarker] || [];
  const fallback = DEFAULT_AGENT_DETECTOR_BY_BIOMARKER[biomarker] || valid[0] || 'STE';
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const exact = valid.find((detector) => detector.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const normalizedRaw = normalizeDetectorToken(raw);
  const normalized = valid.find((detector) => normalizeDetectorToken(detector) === normalizedRaw);
  return normalized || fallback;
}

function normalizeDetectorToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function detectorParamsFromAgentPayload(biomarker: DetectorRunRequest['biomarker'], detector: string, payload: Record<string, unknown>): DetectorRunRequest['detectorParams'] {
  const detectorParams = { ...asRecord(payload.detector_params || payload.detectorParams) } as DetectorRunRequest['detectorParams'];
  if (biomarker !== 'Spindle') return detectorParams;
  if (detector === 'MOLLE' && detectorParams.method === undefined) detectorParams.method = 'MOLLE';
  const filter = numberRecord(payload.filter);
  if (!filter || detectorParams.freq_sp !== undefined) return detectorParams;
  const fp = Number(filter.fp);
  const fs = Number(filter.fs);
  const looksLikeSpindleBand = Number.isFinite(fp) && Number.isFinite(fs) && fp >= 8 && fs > fp && fs <= 20;
  if (!looksLikeSpindleBand) return detectorParams;
  return {
    ...detectorParams,
    freq_sp: [fp, fs]
  };
}

function filterFromAgentPayload(biomarker: DetectorRunRequest['biomarker'], payload: Record<string, unknown>): Record<string, number> | undefined {
  const filter = numberRecord(payload.filter);
  if (biomarker !== 'Spindle' || !filter) return filter;
  const fp = Number(filter.fp);
  const fs = Number(filter.fs);
  if (Number.isFinite(fp) && Number.isFinite(fs) && fp >= 8 && fs > fp && fs <= 20) {
    return { ...filter, fp: 1, fs: 30 };
  }
  return filter;
}

function classifierRunRequestFromAgentCommand(payload: Record<string, unknown>, controls: ClassifierControlsState): ClassifierRunRequest {
  // HITL symmetry with detection: base the run on the clinician's VISIBLE Classify panel (so their
  // reviewed edits are honored) and layer any explicit agent payload fields on top.
  const mode = classifierModeFromAgentValue(payload.mode || payload.classifier_mode, controls.mode);
  const biomarker = biomarkerFromValue(payload.biomarker);
  const classifier = { ...classifierPayloadFromState(controls, biomarker), ...asRecord(payload.classifier) };
  return {
    biomarker,
    mode,
    classifier,
    classifierLabel: String(payload.classifier_label || payload.classifierLabel || mode)
  };
}

const CLASSIFIER_MODES: ClassifierMode[] = ['ONNX CPU', 'HF CPU', 'HF GPU', 'Custom', 'Review only'];

function classifierModeFromAgentValue(value: unknown, fallback: ClassifierMode): ClassifierMode {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const exact = CLASSIFIER_MODES.find((mode) => mode.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;
  const normalized = raw.toLowerCase().replace(/[_-]+/g, ' ');
  if (/\b(gpu|cuda)\b/.test(normalized)) return 'HF GPU';
  if (/\b(onnx|bundled)\b/.test(normalized)) return 'ONNX CPU';
  if (/\b(cpu|hf cpu|hfo cpu)\b/.test(normalized)) return 'HF CPU';
  if (/\bcustom\b/.test(normalized)) return 'Custom';
  if (/\breview\b/.test(normalized)) return 'Review only';
  return fallback;
}

function prepareControlsFromAgentCommand(payload: Record<string, unknown>, current: PrepareControlsState): PrepareControlsState {
  const p = asRecord(payload);
  const pickString = (snake: string, camel: string, fallback: string): string => {
    const value = p[snake] ?? p[camel];
    return value === undefined || value === null ? fallback : String(value);
  };
  const pickBoolean = (snake: string, camel: string, fallback: boolean): boolean => {
    const value = p[snake] ?? p[camel];
    return value === undefined || value === null ? fallback : Boolean(value);
  };
  const filterObj = asRecord(p.filter);
  // qwen-plus varies its payload keys run-to-run; accept the common aliases (and a nested `filter`
  // object) so the visible Prepare panel reliably reflects what the agent intends to set.
  const pickAny = (keys: string[], fallback: string): string => {
    for (const key of keys) {
      const value = p[key] ?? filterObj[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
    }
    return fallback;
  };
  const nJobsRaw = p.n_jobs ?? p.nJobs ?? p.njobs;
  return {
    fp: pickAny(['fp', 'fp_hz', 'highpass', 'low_cutoff', 'lowcut', 'low'], current.fp),
    fs: pickAny(['fs', 'fs_hz', 'lowpass', 'high_cutoff', 'highcut', 'high', 'stop_band', 'stopband'], current.fs),
    rp: pickString('rp', 'rp', current.rp),
    rs: pickString('rs', 'rs', current.rs),
    lineNoiseNotchHz: pickAny(['line_noise_notch_hz', 'lineNoiseNotchHz', 'notch', 'notch_hz', 'line_noise', 'line_noise_hz', 'notch_filter', 'powerline'], current.lineNoiseNotchHz),
    resampleSfreq: pickAny(['resample_sfreq', 'resampleSfreq', 'resample'], current.resampleSfreq),
    dropBadChannels: pickBoolean('drop_bad_channels', 'dropBadChannels', current.dropBadChannels),
    dropFlatChannels: pickBoolean('drop_flat_channels', 'dropFlatChannels', current.dropFlatChannels),
    markOutlierChannels: pickBoolean('mark_outlier_channels', 'markOutlierChannels', current.markOutlierChannels),
    dropOutlierChannels: pickBoolean('drop_outlier_channels', 'dropOutlierChannels', current.dropOutlierChannels),
    nJobs: nJobsRaw === undefined || nJobsRaw === null ? current.nJobs : (optionalPositiveInteger(nJobsRaw) ?? current.nJobs)
  };
}

function classifierControlsFromAgentCommand(payload: Record<string, unknown>, current: ClassifierControlsState): ClassifierControlsState {
  const p = asRecord(payload);
  const pickString = (snake: string, camel: string, fallback: string): string => {
    const value = p[snake] ?? p[camel];
    return value === undefined || value === null ? fallback : String(value);
  };
  const pickBoolean = (snake: string, camel: string, fallback: boolean): boolean => {
    const value = p[snake] ?? p[camel];
    return value === undefined || value === null ? fallback : Boolean(value);
  };
  const modeRaw = p.mode ?? p.classifier_mode;
  return {
    mode: classifierModeFromAgentValue(modeRaw, current.mode),
    ignoreBefore: pickString('ignore_before', 'ignoreBefore', current.ignoreBefore),
    ignoreAfter: pickString('ignore_after', 'ignoreAfter', current.ignoreAfter),
    device: pickString('device', 'device', current.device),
    batchSize: pickString('batch_size', 'batchSize', current.batchSize),
    useSpike: pickBoolean('use_spike', 'useSpike', current.useSpike),
    useEhfo: pickBoolean('use_ehfo', 'useEhfo', current.useEhfo),
    localArtifact: pickString('local_artifact', 'localArtifact', current.localArtifact),
    localSpike: pickString('local_spike', 'localSpike', current.localSpike),
    localEhfo: pickString('local_ehfo', 'localEhfo', current.localEhfo),
    hubArtifact: pickString('hub_artifact', 'hubArtifact', current.hubArtifact),
    hubSpike: pickString('hub_spike', 'hubSpike', current.hubSpike),
    hubEhfo: pickString('hub_ehfo', 'hubEhfo', current.hubEhfo)
  };
}

function biomarkerFromValue(value: unknown): DetectorRunRequest['biomarker'] {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'spindle' || normalized === 'spindles') return 'Spindle';
  if (normalized === 'spike' || normalized === 'spikes') return 'Spike';
  if (normalized === 'hfo' || normalized === 'hfos' || normalized === 'ripple' || normalized === 'ripples') return 'HFO';
  return 'HFO';
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, String(item)]));
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record)
    .map(([key, item]) => [key, Number(item)] as const)
    .filter(([, item]) => Number.isFinite(item));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function optionalNonemptyString(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  return text || undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function sessionFormatFromValue(value: unknown): DetectorRunRequest['sessionFormat'] | undefined {
  return value === 'pybrain' || value === 'npz' ? value : undefined;
}

function hasObjectPayload(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatAgentChatError(error: unknown): string {
  const record = asRecord(error);
  return String(record.message || record.code || 'Agent chat failed.');
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

function backendComputeTerminalProof(resultValue: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const result = asRecord(resultValue);
  const status = String(result.status || '').trim();
  if (status !== 'complete') {
    throw new Error(`Backend computation did not complete (status: ${status || 'missing'}).`);
  }
  return {
    source: 'backend_readback',
    backend_status: status,
    result_sha256: canonicalJsonSha256(result),
    ...extra,
  };
}

function backendArtifactTerminalProof(resultValue: unknown): Record<string, unknown> {
  const result = asRecord(resultValue);
  const status = String(result.status || '').trim();
  const artifactSha256 = String(result.artifact_sha256 || '').trim().toLowerCase();
  if (status !== 'complete' || result.artifact_exists !== true || !SHA256_HEX_PATTERN.test(artifactSha256)) {
    throw new Error('Backend did not confirm the final artifact exists with a valid SHA-256 digest.');
  }
  return {
    source: 'backend_readback',
    backend_status: status,
    artifact_exists: true,
    artifact_sha256: artifactSha256,
    result_sha256: canonicalJsonSha256(result),
  };
}


function backendAnnotationLabel(label: string): string {
  const normalized = String(label || '').trim().toLowerCase();
  if (['artifact', 'uncertain', 'clear', 'rejected'].includes(normalized)) return normalized;
  if (['accepted', 'pathological', 'physiological', 'real', 'spike'].includes(normalized)) return 'accepted';
  return normalized;
}

function formatOptionalHz(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? `${parsed.toFixed(1)} Hz` : '--';
}

function confirmedRecordingExclusions(analysis: RecordingAnalysisState): string[] {
  return Array.from(new Set((analysis.confirmed_exclusions || analysis.roi?.default_detection_exclusions || []).map((channel) => String(channel).trim()).filter(Boolean)));
}

type DetectionRunResult = {
  status?: string;
  recording_fingerprint?: string;
  parameters_sha256?: string;
  biomarker?: string;
  detector?: string;
  num_events?: number;
  num_channels?: number;
  active_run_id?: string;
  output_dir?: string;
  artifacts?: Record<string, string>;
  classifier?: string | null;
  classifier_metadata?: Record<string, unknown>;
  warnings?: string[];
  error?: Record<string, unknown> | null;
};

type ExportArtifactResult = {
  status?: string;
  canceled?: boolean;
  artifact_path?: string;
  artifact_type?: string;
  artifact_exists?: boolean;
  artifact_sha256?: string;
};

type ProjectApiResult = {
  status?: string;
  project_id?: string;
  project_path?: string;
  state?: ProjectStoreState;
  artifact_exists?: boolean;
  artifact_sha256?: string;
};

type PrepareRecordingResult = {
  status?: string;
  output_path?: string;
  input_recording_fingerprint?: string;
  output_recording_fingerprint?: string;
  parameters_sha256?: string;
  prepared_n_channels?: number;
  prepared_sfreq?: number;
  warnings?: string[];
};

export type ConsensusStrategy = 'union' | 'majority' | 'intersection';



function optionalPositiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function filterBandpassFromPrepareControls(controls: PrepareControlsState): { l_freq?: number; h_freq?: number } | undefined {
  const low = Number(controls.fp);
  const high = Number(controls.fs);
  const bandpass: { l_freq?: number; h_freq?: number } = {};
  if (Number.isFinite(low) && low > 0) bandpass.l_freq = low;
  if (Number.isFinite(high) && high > 0) bandpass.h_freq = high;
  return Object.keys(bandpass).length ? bandpass : undefined;
}

function filterRequestFromPrepareControls(controls: PrepareControlsState): Record<string, number> | undefined {
  const filter = Object.fromEntries(
    (['fp', 'fs', 'rp', 'rs'] as const)
      .map((key) => [key, Number(controls[key])] as const)
      .filter(([, value]) => Number.isFinite(value))
  ) as Record<string, number>;
  return Object.keys(filter).length ? filter : undefined;
}

// --- Review view profile ---------------------------------------------------
// "View follows active run": when a detection run is activated, the waveform
// snaps to a review profile derived from that run's biomarker. HFO and spindle
// sit at opposite ends of the spectrum and cannot share one view — an HFO needs
// a short, high-band window to resolve the oscillation; a spindle needs a longer
// raw-ish window to see the waxing/waning envelope.
function bandFromValues(lowRaw: unknown, highRaw: unknown): [number, number] | null {
  const low = Number(lowRaw);
  const high = Number(highRaw);
  if (Number.isFinite(low) && Number.isFinite(high) && low > 0 && high > low) return [low, high];
  return null;
}

function hfoDisplayBandForRun(run: RunRecord): [number, number] {
  const params = run.parameters || {};
  const direct = bandFromValues(params.fp, params.fs);
  if (direct) return direct;
  const detectorParams = params.detector_params;
  if (typeof detectorParams === 'string' && detectorParams.trim()) {
    try {
      const parsed = JSON.parse(detectorParams);
      const band = bandFromValues(parsed.fp ?? parsed.low ?? parsed.lowcut, parsed.fs ?? parsed.high ?? parsed.highcut);
      if (band) return band;
    } catch { /* malformed detector_params — fall back to the canonical HFO band */ }
  }
  return [80, 500];
}

function reviewProfileForRun(run: RunRecord): Partial<WaveformControlsState> {
  const biomarker = String(run.biomarker || '').toLowerCase();
  if (biomarker.includes('hfo') || biomarker.includes('ripple')) {
    const [low, high] = hfoDisplayBandForRun(run);
    // Bandpass to the HFO band + short window; normalize so the low-µV ripple
    // fills its lane instead of reading as a flat line at native gain.
    return { showFiltered: true, displayFilterLowHz: low, displayFilterHighHz: high, timeWindowSeconds: 1, normalizeVertically: true };
  }
  if (biomarker.includes('spindle')) {
    // The default 1-80 Hz filtered view already frames an 11-16 Hz spindle in
    // context; a longer window shows the full envelope. Clear any HFO band.
    return { showFiltered: true, displayFilterLowHz: null, displayFilterHighHz: null, timeWindowSeconds: 10, normalizeVertically: false };
  }
  if (biomarker.includes('spike')) {
    return { showFiltered: true, displayFilterLowHz: null, displayFilterHighHz: null, timeWindowSeconds: 2, normalizeVertically: false };
  }
  return {};
}

function detectionResultRunRecord(result: DetectionRunResult, request: DetectorRunRequest): RunRecord {
  const runId = result.active_run_id || `run-${Date.now()}`;
  return {
    runId,
    biomarker: result.biomarker || request.biomarker,
    detector: result.detector || request.detector,
    events: Number(result.num_events || 0),
    channels: Number(result.num_channels || 0),
    status: result.status || 'completed',
    classifier: request.classifierLabel || result.classifier || 'not classified',
    createdAt: new Date().toISOString(),
    parameters: {
      output_dir: result.output_dir,
      ...artifactParameters(result.artifacts),
      detector_params: JSON.stringify(request.detectorParams),
      classifier_params: request.classifier ? JSON.stringify(request.classifier) : undefined,
      classifier_metadata: result.classifier_metadata ? JSON.stringify(result.classifier_metadata) : undefined,
      classifier_source_preference: typeof result.classifier_metadata?.source_preference === 'string' ? result.classifier_metadata.source_preference : undefined,
      classifier_steps: Array.isArray(result.classifier_metadata?.executed_steps) ? result.classifier_metadata.executed_steps.join(',') : undefined,
      warnings: result.warnings?.join('; ')
    }
  };
}

function artifactParameters(artifacts: Record<string, string> | undefined): Record<string, string> {
  if (!artifacts) return {};
  return Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [`artifact_${key}`, value]));
}

function collectRunArtifacts(runs: RunRecord[], selectedRun: RunRecord | null): Record<string, unknown> {
  const artifactLikeKey = /(artifact|output|path|session|csv|excel|summary|report|warning)/i;
  return {
    selected_run_id: selectedRun?.runId || null,
    selected_run: Object.fromEntries(Object.entries(selectedRun?.parameters || {}).filter(([key]) => artifactLikeKey.test(key))),
    runs: Object.fromEntries(runs.map((run) => [run.runId, Object.fromEntries(Object.entries(run.parameters || {}).filter(([key]) => artifactLikeKey.test(key)))]))
  };
}

function candidateRankingRunsFromRecords(runs: RunRecord[]): Array<{ biomarker: string; events_csv: string; run_id: string }> {
  return runs
    .map((run) => {
      const eventsCsv = String(run.parameters?.artifact_csv || run.parameters?.csv || '').trim();
      return eventsCsv ? { biomarker: String(run.biomarker || 'event'), events_csv: eventsCsv, run_id: run.runId } : null;
    })
    .filter((item): item is { biomarker: string; events_csv: string; run_id: string } => item !== null);
}

function rankReviewChannels(events: ReviewEvent[]): Array<{ channel: string; events: number }> {
  const counts = events.reduce<Record<string, number>>((acc, event) => {
    const channel = event.channel || '--';
    acc[channel] = (acc[channel] || 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([channel, events]) => ({ channel, events }));
}

function safeArtifactStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'session';
}

function recordingLabelFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || path;
}

function isConsensusRun(run: RunRecord): boolean {
  return run.detector.toLowerCase().startsWith('consensus') || Boolean(run.parameters?.consensus_strategy);
}

function isRunVisible(runId: string, visibleRunIds: string[]): boolean {
  return visibleRunIds.includes(runId);
}

function consensusSupportThreshold(strategy: ConsensusStrategy, runCount: number): number {
  if (strategy === 'union') return 1;
  if (strategy === 'intersection') return runCount;
  return Math.max(1, Math.ceil(runCount / 2));
}

function buildConsensusEvents(sourceEvents: Record<string, ReviewEvent[]>, strategy: ConsensusStrategy, biomarker: string): ReviewEvent[] {
  const runIds = Object.keys(sourceEvents);
  const threshold = consensusSupportThreshold(strategy, runIds.length);
  const rows = runIds.flatMap((runId) => sourceEvents[runId].map((event) => ({ ...event, run_id: runId })))
    .filter((event) => event.channel && Number.isFinite(Number(event.start_seconds)) && Number.isFinite(Number(event.end_seconds)))
    .sort((a, b) => String(a.channel).localeCompare(String(b.channel)) || Number(a.start_seconds) - Number(b.start_seconds) || Number(a.end_seconds) - Number(b.end_seconds));
  const clusters: ReviewEvent[][] = [];
  for (const event of rows) {
    const last = clusters[clusters.length - 1];
    if (!last?.length || last[0].channel !== event.channel || Number(event.start_seconds) > Math.max(...last.map((item) => Number(item.end_seconds || 0)))) clusters.push([event]);
    else last.push(event);
  }
  return clusters.flatMap((cluster) => {
    const sourceRunIds = Array.from(new Set(cluster.map((event) => event.run_id).filter(Boolean) as string[])).sort();
    if (sourceRunIds.length < threshold) return [];
    const starts = cluster.map((event) => Number(event.start_seconds || 0));
    const ends = cluster.map((event) => Number(event.end_seconds || event.start_seconds || 0));
    const start = Math.min(...starts);
    const end = Math.max(...ends);
    return [{
      event_id: '',
      run_id: '',
      channel: cluster[0].channel,
      start_seconds: start,
      end_seconds: end,
      duration_seconds: Math.max(0, end - start),
      biomarker,
      features: {
        consensus: true,
        consensus_strategy: strategy,
        support_count: sourceRunIds.length,
        support_threshold: threshold,
        source_run_ids: sourceRunIds,
        source_event_ids: cluster.map((event) => event.event_id).filter(Boolean)
      }
    }];
  });
}

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function activeRunSessionPath(run: RunRecord): string | null {
  const parameters = run.parameters || {};
  const candidates = [parameters.artifact_session, parameters.session_path, parameters.artifact_session_path, parameters.session].map((value) => typeof value === 'string' ? value : '');
  return candidates.find((value) => value.endsWith('.pybrain') || value.endsWith('.npz')) || null;
}

function parseDetectorParams(value: unknown): Record<string, number | string | [number, number] | null> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, number | string | [number, number] | null>;
  } catch {
    return {};
  }
}

type SavedSessionSummary = {
  recording_info?: RecordingMetadata;
  recording_path?: string;
  biomarker?: string;
  event_count?: number;
  detected?: boolean;
  classified?: boolean;
  session_path?: string;
  format?: string;
  detection_runs?: RunRecord[];
  active_run_id?: string | null;
  accepted_run_id?: string | null;
  visible_run_ids?: string[];
  review_events_by_run?: Record<string, ReviewEvent[]>;
  prepare_controls?: Partial<PrepareControlsState>;
  classifier_controls?: Partial<ClassifierControlsState>;
};

function savedSessionRunRecords(session: SavedSessionSummary): RunRecord[] {
  if (session.detection_runs?.length) {
    return session.detection_runs.map((run) => ({
      ...run,
      runId: run.runId || String((run as unknown as { run_id?: string }).run_id || `saved-${Date.now()}`),
      parameters: { ...(run.parameters || {}), format: session.format, session_path: session.session_path }
    }));
  }
  const runId = `saved-${Date.now()}`;
  return [{
    runId,
    biomarker: session.biomarker || 'HFO',
    detector: session.detected ? 'saved-session' : 'session-loaded',
    events: Number(session.event_count || 0),
    channels: Number(session.recording_info?.n_channels || session.recording_info?.num_channels || session.recording_info?.channel_names?.length || 0),
    status: session.detected ? 'loaded' : 'not_detected',
    classifier: session.classified ? 'saved classifier' : 'not classified',
    createdAt: new Date().toISOString(),
    parameters: { format: session.format, session_path: session.session_path }
  }];
}

function normalizeSavedEventsByRun(eventsByRun: Record<string, ReviewEvent[]>, runs: RunRecord[]): Record<string, ReviewEvent[]> {
  const runIds = new Set(runs.map((run) => run.runId));
  return Object.fromEntries(Object.entries(eventsByRun).filter(([runId]) => runIds.has(runId)).map(([runId, events]) => [runId, events.map((event) => ({ ...event, run_id: event.run_id || runId }))]));
}

function expandDerivedChannelsForRequest(channels: string[], controls: WaveformControlsState, metadata: RecordingMetadata | null): string[] {
  const resolvedMontage = resolveMontageMode(controls.montageMode, metadata);
  if (resolvedMontage === 'averageReference') return channelNames(metadata);
  const autoDefinitions = resolvedMontage === 'bipolar' ? montageBipolarChannels(metadata, controls) : [];
  const expanded: string[] = [];
  for (const channel of channels) {
    const derived = controls.derivedBipolarChannels.find((candidate) => candidate.name === channel) || autoDefinitions.find((candidate) => candidate.name === channel);
    if (derived) expanded.push(derived.channel1, derived.channel2);
    else if (channel.endsWith(`${BIPOLAR_TOKEN}${AVERAGE_REFERENCE_SUFFIX}`)) expanded.push(channel.slice(0, -`${BIPOLAR_TOKEN}${AVERAGE_REFERENCE_SUFFIX}`.length));
    else expanded.push(channel);
  }
  return Array.from(new Set(expanded));
}

function materializeDerivedWaveform(windowData: WaveformWindow, requestedChannels: string[], controls: WaveformControlsState, metadata: RecordingMetadata | null): WaveformWindow {
  assertUsableWaveformWindow(windowData);
  const rowByChannel = new Map(windowData.channels.map((channel, index) => [channel, windowData.data[index]]));
  const data: number[][] = [];
  const channels: string[] = [];
  if (controls.montageMode === 'averageReference') {
    const sourceRows = channelNames(metadata).map((channel) => rowByChannel.get(channel)).filter((row): row is number[] => Array.isArray(row));
    const sampleCount = Math.min(...sourceRows.map((row) => row.length));
    if (sourceRows.length >= 2 && Number.isFinite(sampleCount) && sampleCount > 0) {
      const averageRow = Array.from({ length: sampleCount }, (_value, index) => sourceRows.reduce((sum, row) => sum + (row[index] ?? 0), 0) / sourceRows.length);
      for (const channel of requestedChannels) {
        const sourceChannel = channel.endsWith(`${BIPOLAR_TOKEN}${AVERAGE_REFERENCE_SUFFIX}`) ? channel.slice(0, -`${BIPOLAR_TOKEN}${AVERAGE_REFERENCE_SUFFIX}`.length) : channel;
        const row = rowByChannel.get(sourceChannel);
        if (!row) continue;
        channels.push(channel);
        data.push(averageRow.map((average, index) => (row[index] ?? 0) - average));
      }
      return { ...windowData, channels, data, source: 'average_reference', filters_applied: [...(windowData.filters_applied || []), 'average_reference'] };
    }
  }
  const autoDefinitions = resolveMontageMode(controls.montageMode, metadata) === 'bipolar' ? montageBipolarChannels(metadata, controls) : [];
  for (const channel of requestedChannels) {
    const derived = controls.derivedBipolarChannels.find((candidate) => candidate.name === channel) || autoDefinitions.find((candidate) => candidate.name === channel);
    if (derived) {
      const row1 = rowByChannel.get(derived.channel1);
      const row2 = rowByChannel.get(derived.channel2);
      if (row1 && row2) {
        channels.push(channel);
        data.push(row1.map((value, index) => value - (row2[index] ?? 0)));
      }
      continue;
    }
    const row = rowByChannel.get(channel);
    if (row) {
      channels.push(channel);
      data.push(row);
    }
  }
  const bipolarApplied = resolveMontageMode(controls.montageMode, metadata) === 'bipolar';
  return { ...windowData, channels, data, source: bipolarApplied ? 'auto_bipolar' : windowData.source, filters_applied: bipolarApplied ? [...(windowData.filters_applied || []), 'auto_bipolar'] : windowData.filters_applied };
}

function assertUsableWaveformWindow(windowData: WaveformWindow): asserts windowData is WaveformWindow {
  if (!windowData || !Array.isArray(windowData.channels) || !Array.isArray(windowData.data) || !Array.isArray(windowData.times_seconds)) {
    throw new Error('Waveform data was incomplete. Reopen the recording or update the plot again.');
  }
}

// Waveform-fetch resilience: a window request that fails because the single-process
// backend is transiently saturated (e.g. a detection is pinning the CPU and the 20s
// IPC timeout fires before the starved request returns) is retried with a short
// backoff rather than surfaced as an error. The job finishes, the backend window
// cache makes the next attempt ~instant. Bounded so a genuinely dead backend still
// fails in finite time. Total attempts = retries + 1 (i.e. up to 4 tries).
const WAVEFORM_BUSY_RETRIES = 3;
const WAVEFORM_BUSY_BACKOFF_MS = [400, 900, 1600];

function formatWaveformUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isTransientWaveformBackendError(error)) {
    return 'The backend is busy (a detection or other heavy job is running). The waveform will load once it frees up — try Update plot again in a moment.';
  }
  if (/Cannot read properties|undefined|null|map is not a function|Waveform data was incomplete/i.test(message)) {
    return 'Waveform data was incomplete. Reopen the recording or update the plot again.';
  }
  return message;
}
