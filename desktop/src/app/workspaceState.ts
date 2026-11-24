import type { WaveformWindow } from '../features/waveform/WaveformCanvas';

export type RecordingMetadata = {
  input_path?: string;
  filename?: string;
  sample_freq?: number;
  sampling_frequency?: number;
  sample_frequency_hz?: number;
  n_channels?: number;
  num_channels?: number;
  channel_names?: string[];
  duration_seconds?: number;
  length_seconds?: number;
  length?: string | number;
  // "scalp" (conventional 10-20 layout) or "ieeg", inferred by the backend from channel names.
  eeg_type?: string;
  recording_fingerprint?: string;
};

export type RecentRecording = {
  path: string;
  label: string;
  openedAt: string;
  sampleFrequencyHz?: number;
  channels?: number;
  durationSeconds?: number;
};

export type ProjectStoreState = {
  schema_version?: string;
  project_id?: string;
  recording_path?: string | null;
  recording_info?: RecordingMetadata | null;
  active_run_id?: string | null;
  accepted_run_id?: string | null;
  visible_run_ids?: string[];
  run_records?: RunRecord[];
  review_events?: ReviewEvent[];
  review_events_by_run?: Record<string, ReviewEvent[]>;
  // Finished model output for the saved recording. Severity costs many minutes on a long study, so
  // a project that remembers the runs but forgets the score makes the user pay for it twice.
  severity_result?: SeverityScoringResult | null;
  // Co-pilot threads, so reopening a project brings back the conversations that produced its
  // results rather than an empty panel with no record of how anything was decided.
  agent_conversations?: Array<{ id: string; title: string; log: AgentChatMessage[] }>;
  active_agent_conversation_id?: string;
  review_cursor_event_id?: string;
  prepare_controls?: Partial<PrepareControlsState>;
  recording_analysis?: RecordingAnalysisState;
  classifier_controls?: Record<string, unknown>;
  waveform_controls?: Partial<WaveformControlsState>;
  runtime_log?: RuntimeLogEntry[];
};

export type RecordingRoiSummary = {
  status?: string;
  policy?: string;
  brain_signal_channels?: string[];
  brain_signal_channel_count?: number;
  excluded_non_brain_channels?: Array<{ channel?: string; reason?: string }>;
  excluded_non_brain_channel_count?: number;
  uncertain_channels?: Array<{ channel?: string; reason?: string }>;
  uncertain_channel_count?: number;
  default_detection_exclusions?: string[];
  warnings?: string[];
};

export type RecordingQcSummary = {
  status?: string;
  roi_channel_count?: number;
  excluded_channels?: string[];
  flat_channels?: string[];
  outlier_channels?: string[];
  per_channel?: Array<{ channel?: string; rms?: number; std?: number; peak_to_peak?: number; nan_fraction?: number; flat_fraction?: number; log_rms_modified_z?: number | null }>;
  warnings?: string[];
  analysis_window?: { start_seconds?: number; stop_seconds?: number; samples_analyzed?: number; bounded?: boolean };
};

export type RecordingSpectralSummary = {
  status?: string;
  sample_freq?: number;
  nyquist_hz?: number;
  channels_analyzed?: string[];
  roi_channel_count?: number;
  relative_band_power?: Record<string, number>;
  psd_curve?: Array<{ frequency_hz?: number; db?: number; relative_power?: number }>;
  line_noise_candidates?: Array<{ frequency_hz?: number; local_power_ratio?: number }>;
  recommended_hfo_band?: number[] | null;
  warnings?: string[];
  analysis_window?: { start_seconds?: number; stop_seconds?: number; samples_analyzed?: number; bounded?: boolean };
};

export type RecordingAnalysisState = {
  status: 'idle' | 'running' | 'complete' | 'failed';
  updatedAt?: string;
  roi?: RecordingRoiSummary | null;
  qc?: RecordingQcSummary | null;
  spectral?: RecordingSpectralSummary | null;
  candidate_ranking?: CandidateChannelRanking | null;
  confirmed_exclusions?: string[];
  error?: string;
};

export const DEFAULT_RECORDING_ANALYSIS: RecordingAnalysisState = { status: 'idle', roi: null, qc: null, spectral: null };

export type CandidateChannelRanking = {
  status?: string;
  duration_seconds?: number;
  excluded_channels?: string[];
  artifact_paths?: Record<string, string>;
  candidate_channel_count?: number;
  top_channels?: CandidateChannelRankingRow[];
  interpretation_policy?: string;
};

export type CandidateChannelRankingRow = {
  channel?: string;
  total_events?: number;
  total_events_per_minute?: number;
  [key: string]: string | number | undefined;
};

export type BiomarkerType = 'HFO' | 'Spindle' | 'Spike';
export type WorkspaceTab = 'Prepare' | 'Detect' | 'Classify' | 'Severity';
export type AgentPanelTab = 'Chat' | 'Actions' | 'Artifacts' | 'Safety';
// A run lifecycle card rendered inline in the chat transcript: any agent-staged operation, once applied,
// shows up here as running → complete/failed so the operation's status lives on the chat surface the user
// is watching (not just the Actions tab / status strip). `detail` is the operation's finish summary.
export type AgentChatRunMeta = {
  id: string;
  status: 'running' | 'complete' | 'failed';
  label: string;
  detail?: string;
};
// 'observation' = a system-injected run-result note (distinct from a real LLM 'agent' reply so it
// never collides with the reply testid); the agent's own recap of a run comes back as a real 'agent'
// reply via the separate runAgentTurn('observation') feedback path.
export type AgentChatMessage = { role: 'user' | 'agent' | 'run' | 'observation'; text: string; ts: number; run?: AgentChatRunMeta };

export type CapabilityManifest = {
  optional_dependencies?: {
    yasa?: {
      available?: boolean;
      install_hint?: string;
      ui_behavior?: string;
      detectors?: Array<{ biomarker?: string; detector?: string }>;
    };
  };
  classifier?: {
    gpu?: {
      available?: boolean;
      backend?: string;
      device_count?: number;
      install_hint?: string;
      ui_behavior?: string;
    };
    cpu?: {
      available?: boolean;
      backend?: string;
      ui_behavior?: string;
    };
  };
};

export type AgentArtifact = {
  id: string;
  label: string;
  type: 'recording' | 'session' | 'detection' | 'report' | 'workbook' | 'snapshot' | 'summary' | 'other';
  path: string;
  source: 'user' | 'backend' | 'electron-ui' | 'agent';
  runId?: string;
  createdAt: string;
  status?: string;
};

export type RunRecord = {
  runId: string;
  biomarker: BiomarkerType | string;
  detector: string;
  events: number;
  channels: number;
  status: string;
  classifier?: string;
  accepted?: boolean;
  createdAt?: string;
  parameters?: Record<string, string | number | boolean | null | undefined>;
};

export type RuntimeOperationStatus = 'idle' | 'running' | 'complete' | 'failed' | 'cancel_requested';

export type RuntimeOperation = {
  id: string;
  label: string;
  kind: 'recording' | 'detection' | 'classification' | 'review' | 'export';
  status: RuntimeOperationStatus;
  progress: number;
  startedAt?: string;
  finishedAt?: string;
  cancellable?: boolean;
  // Optional, backward compatible. When true the renderer cannot know true progress
  // (single blocking backend call), so the UI should show a busy/elapsed indicator
  // instead of a fabricated climbing percentage. Absent/false preserves prior behavior.
  indeterminate?: boolean;
  // Optional honest, renderer-orchestrated step progress for multi-call sequences
  // (e.g. ROI -> QC -> Spectral). Drives `progress` from REAL completed-step counts.
  completedSteps?: number;
  totalSteps?: number;
};

// Pure helper: compute honest progress for a renderer-orchestrated multi-step
// sequence from REAL completed-step counts (not a timer). Returns an integer
// 0..100. `completed` is clamped into [0, total]; a non-positive `total` yields 0.
export function stepProgressPercent(completed: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const safeCompleted = Math.max(0, Math.min(total, Number.isFinite(completed) ? completed : 0));
  return Math.round((safeCompleted / total) * 100);
}

// Pure helper: stale-response token guard. Given the token a response was issued
// under and the latest token the owner has handed out, decide whether the response
// is still the freshest in-flight request and may be applied. A coarse response that
// was superseded by a newer request (higher latest token) is rejected, so a slow
// coarse pass can NEVER overwrite a newer full-resolution response, and navigating
// again mid-flight discards every in-flight response from older tokens.
export function isFreshWaveformResponse(responseToken: number, latestToken: number): boolean {
  return responseToken === latestToken;
}

// Pure helper: is this waveform-fetch failure a TRANSIENT backend-busy condition
// (retryable) rather than a real, terminal error? A waveform window is normally
// <250ms, but when a heavy job (e.g. a detection's NN inference) saturates the
// single-process backend the request is GIL/CPU-starved and the 20s IPC timeout
// fires before it returns -- a condition that clears itself the moment the job
// finishes (and the window cache then makes the retry ~instant). The main-process
// backendFetch wraps EVERY pre-response network failure (abort/timeout, reset,
// "fetch failed", backlog overflow) with the literal "failed before response",
// and reports a missing/restarting backend as "Backend is not running"; real
// backend validation errors (bad time window, too many channels, file not found)
// come back as plain messages WITHOUT those phrases and so are never retried.
export function isTransientWaveformBackendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed before response|Backend is not running/i.test(message);
}

export type RuntimeLogEntry = {
  id: string;
  timestamp: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  operationId?: string;
};

export const IDLE_RUNTIME_OPERATION: RuntimeOperation = {
  id: 'idle',
  label: 'No active runtime task',
  kind: 'review',
  status: 'idle',
  progress: 0,
  cancellable: false
};

export type ReviewAnnotation = {
  label: string;
  display_label?: string;
  notes?: string;
  status?: string;
  reviewer?: string;
  source?: string;
  updated_at?: string;
};

export type ReviewEvent = {
  event_id: string;
  run_id?: string;
  index?: number;
  channel?: string;
  start_seconds?: number;
  end_seconds?: number;
  duration_seconds?: number;
  biomarker?: string;
  annotation?: ReviewAnnotation | null;
  features?: Record<string, unknown>;
};

// PyQt event-overlay color palette (utils_gui.COLOR_MAP) keyed by clinical type. RGB triples
// mirror the COLOR_MAP hex values so canvas overlays match the PyQt waveform exactly.
export type WaveformEventColorStyle = { r: number; g: number; b: number };
export type WaveformEventColorType = 'artifact' | 'spike' | 'ehfo' | 'non_spike';

const PYQT_EVENT_COLORS: Record<WaveformEventColorType, WaveformEventColorStyle> = {
  non_spike: { r: 109, g: 141, b: 116 }, // COLOR_MAP non_spike/HFO/Real "#6d8d74"
  artifact: { r: 180, g: 111, b: 85 }, // COLOR_MAP artifact "#b46f55"
  spike: { r: 127, g: 107, b: 147 }, // COLOR_MAP spike/spkHFO "#7f6b93"
  ehfo: { r: 141, g: 95, b: 103 } // COLOR_MAP eHFO "#8d5f67"
};

function eventFeatureValue(event: ReviewEvent, keys: string[]): unknown {
  const features = event.features;
  if (!features) return undefined;
  const lowered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(features)) lowered[key.toLowerCase()] = value;
  for (const key of keys) {
    const value = lowered[key.toLowerCase()];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function isTruthyPrediction(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric === 1;
  const text = String(value).trim().toLowerCase();
  return text === 'true' || text === 'yes';
}

// Resolve the per-event-type clinical color, mirroring PyQt model._resolve_event_color
// (main_waveform_plot_model.py ~353-365): Artifact==-1 (Unpredicted) -> non_spike;
// Artifact<1 -> artifact; spkHFO -> spike; eHFO -> ehfo; otherwise non_spike. Reviewer
// annotations are honored first since an explicit "artifact" label is authoritative. Returns
// null when no clinical type is resolvable so the caller can fall back to run-state styling.
export function resolveEventTypeColor(event: ReviewEvent): WaveformEventColorStyle | null {
  const type = resolveEventColorType(event);
  return type ? PYQT_EVENT_COLORS[type] : null;
}

export function resolveEventColorType(event: ReviewEvent): WaveformEventColorType | null {
  const annotationLabel = String(event.annotation?.label || '').trim().toLowerCase();
  if (annotationLabel === 'artifact') return 'artifact';

  // PyQt _resolve_event_color runs on a CLASSIFIED event (it always has an artifact array). We
  // mirror it only when the React event carries classifier features; an unclassified event with no
  // clinical signal returns null so the caller falls back to run-state styling.
  let isClassified = false;

  // Artifact prediction: -1 == Unpredicted (treated as non_spike), <1 (i.e. 0) == Artifact,
  // >=1 == passed the artifact check (model lines 355-357).
  const artifactRaw = eventFeatureValue(event, ['artifact', 'artifact_prediction', 'is_artifact']);
  if (artifactRaw !== undefined) {
    isClassified = true;
    const artifactValue = Number(artifactRaw);
    if (Number.isFinite(artifactValue)) {
      if (artifactValue === -1) return 'non_spike';
      if (artifactValue < 1) return 'artifact';
    } else if (isTruthyPrediction(artifactRaw)) {
      return 'artifact';
    }
  }

  const spikeRaw = eventFeatureValue(event, ['spkhfo', 'spike', 'spike_prediction', 'is_spike']);
  if (spikeRaw !== undefined) {
    isClassified = true;
    if (isTruthyPrediction(spikeRaw)) return 'spike';
  }
  const ehfoRaw = eventFeatureValue(event, ['ehfo', 'ehfo_prediction', 'is_ehfo']);
  if (ehfoRaw !== undefined) {
    isClassified = true;
    if (isTruthyPrediction(ehfoRaw)) return 'ehfo';
  }

  // Serialized clinical label string (PyQt _get_prediction output), e.g. "Artifact", "spkHFO",
  // "eHFO", "spkHFO and eHFO", "HFO".
  const predictionLabel = String(eventFeatureValue(event, ['prediction', 'label', 'type', 'event_type']) ?? '').trim().toLowerCase();
  if (predictionLabel) {
    if (predictionLabel.includes('artifact')) return 'artifact';
    if (predictionLabel.includes('spkhfo') || predictionLabel.includes('spike')) return 'spike';
    if (predictionLabel.includes('ehfo')) return 'ehfo';
    if (predictionLabel.includes('hfo') || predictionLabel === 'real' || predictionLabel === 'accepted') return 'non_spike';
  }

  // Positive HFO/Real flag without spike/ehfo -> PyQt's default non_spike branch (model line 363).
  if (isTruthyPrediction(eventFeatureValue(event, ['hfo', 'real']))) return 'non_spike';

  // Classifier ran and the event passed every step (non-artifact, non-spike, non-ehfo) -> non_spike.
  return isClassified ? 'non_spike' : null;
}

export type RunOverlapRow = {
  leftRunId: string;
  rightRunId: string;
  leftLabel: string;
  rightLabel: string;
  overlap: number;
  leftOnly: number;
  rightOnly: number;
  jaccard: number;
};

export type ChannelRankingRow = {
  channel: string;
  accepted: number;
  total: number;
  priority: 'High' | 'Review' | 'Monitor' | '-';
};

export function runOverlapRows(runRecords: RunRecord[], runEventsByRun: Record<string, ReviewEvent[]>, activeReviewEvents: ReviewEvent[], activeRunId: string | null, visibleRunIds: string[]): RunOverlapRow[] {
  const scopedRuns = runRecords.filter((run) => (visibleRunIds.length >= 2 ? visibleRunIds.includes(run.runId) : true));
  if (scopedRuns.length < 2) return [];
  const rows: RunOverlapRow[] = [];
  for (let leftIndex = 0; leftIndex < scopedRuns.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < scopedRuns.length; rightIndex += 1) {
      const leftRun = scopedRuns[leftIndex];
      const rightRun = scopedRuns[rightIndex];
      const leftEvents = eventsForRunComparison(leftRun.runId, runEventsByRun, activeReviewEvents, activeRunId);
      const rightEvents = eventsForRunComparison(rightRun.runId, runEventsByRun, activeReviewEvents, activeRunId);
      const overlap = countTemporalOverlapMatches(leftEvents, rightEvents);
      const union = Math.max(0, leftEvents.length + rightEvents.length - overlap);
      rows.push({
        leftRunId: leftRun.runId,
        rightRunId: rightRun.runId,
        leftLabel: `${leftRun.biomarker} • ${leftRun.detector}`,
        rightLabel: `${rightRun.biomarker} • ${rightRun.detector}`,
        overlap,
        leftOnly: Math.max(0, leftEvents.length - overlap),
        rightOnly: Math.max(0, rightEvents.length - overlap),
        jaccard: union ? overlap / union : 1
      });
    }
  }
  return rows.sort((a, b) => b.jaccard - a.jaccard || b.overlap - a.overlap || a.leftLabel.localeCompare(b.leftLabel));
}

export function eventsForRunComparison(runId: string, runEventsByRun: Record<string, ReviewEvent[]>, activeReviewEvents: ReviewEvent[], activeRunId: string | null): ReviewEvent[] {
  const cached = runEventsByRun[runId];
  if (cached?.length) return cached;
  return runId === activeRunId ? activeReviewEvents : [];
}

export function countTemporalOverlapMatches(leftEvents: ReviewEvent[], rightEvents: ReviewEvent[]): number {
  const rightUsed = new Set<number>();
  let matches = 0;
  const leftRows = comparableEvents(leftEvents).sort((a, b) => a.channel.localeCompare(b.channel) || a.end - b.end || a.start - b.start);
  const rightRows = comparableEvents(rightEvents).sort((a, b) => a.channel.localeCompare(b.channel) || a.end - b.end || a.start - b.start);
  for (const left of leftRows) {
    for (let index = 0; index < rightRows.length; index += 1) {
      if (rightUsed.has(index)) continue;
      const right = rightRows[index];
      if (right.channel !== left.channel) continue;
      if (right.end <= left.start) continue;
      if (Math.min(left.end, right.end) <= Math.max(left.start, right.start)) continue;
      rightUsed.add(index);
      matches += 1;
      break;
    }
  }
  return matches;
}

export function comparableEvents(events: ReviewEvent[]): Array<{ channel: string; start: number; end: number }> {
  return events.map((event) => ({ channel: String(event.channel || ''), start: Number(event.start_seconds), end: Number(event.end_seconds) }))
    .filter((event) => event.channel && Number.isFinite(event.start) && Number.isFinite(event.end) && event.end > event.start);
}

export function channelRankingRows(events: ReviewEvent[]): ChannelRankingRow[] {
  const rows = new Map<string, { accepted: number; total: number }>();
  for (const event of events) {
    const channel = String(event.channel || '').trim() || '--';
    const current = rows.get(channel) || { accepted: 0, total: 0 };
    current.total += 1;
    if (String(event.annotation?.label || '').toLowerCase() === 'accepted') current.accepted += 1;
    rows.set(channel, current);
  }
  return Array.from(rows.entries())
    .map(([channel, counts]) => ({ channel, accepted: counts.accepted, total: counts.total, priority: channelPriority(counts.accepted, counts.total) }))
    .sort((a, b) => b.accepted - a.accepted || b.total - a.total || a.channel.localeCompare(b.channel, undefined, { numeric: true, sensitivity: 'base' }));
}

export function candidateChannelRankingRows(ranking: CandidateChannelRanking | null | undefined, fallbackEvents: ReviewEvent[] = []): ChannelRankingRow[] {
  const ranked = ranking?.top_channels || [];
  if (!ranked.length) return channelRankingRows(fallbackEvents);
  return ranked
    .map((item) => {
      const total = Number(item.total_events || 0);
      const accepted = Number(item.hfo_count || item.spike_count || item.spindle_count || 0);
      return {
        channel: String(item.channel || '--'),
        accepted,
        total,
        priority: candidateChannelPriority(total, Number(item.total_events_per_minute || 0))
      };
    })
    .filter((item) => item.channel !== '--')
    .sort((a, b) => b.total - a.total || a.channel.localeCompare(b.channel, undefined, { numeric: true, sensitivity: 'base' }));
}

function candidateChannelPriority(total: number, perMinute: number): ChannelRankingRow['priority'] {
  if (total >= 10 || perMinute >= 1) return 'High';
  if (total >= 3 || perMinute > 0) return 'Review';
  if (total > 0) return 'Monitor';
  return '-';
}

export function channelPriority(accepted: number, total: number): ChannelRankingRow['priority'] {
  if (accepted >= 10) return 'High';
  if (accepted >= 3) return 'Review';
  if (total > 0) return 'Monitor';
  return '-';
}

export type ReviewFilteredTrace = {
  status?: string;
  source?: string;
  reason?: string;
  sample_freq?: number;
  units?: string;
  times_seconds?: number[];
  data?: number[];
  filter?: Record<string, number>;
};

export type ReviewTimeFrequency = {
  status?: string;
  source?: string;
  reason?: string;
  display_transform?: string;
  display_percentiles?: number[];
  display_limits?: number[];
  colormap?: string;
  frequency_range?: number[];
  high_frequency_at_top?: boolean;
  frequencies_hz?: number[];
  time_bins_seconds?: number[];
  intensity?: number[][];
};

export type ReviewSnippet = {
  status?: string;
  event?: ReviewEvent;
  waveform?: WaveformWindow;
  filtered_trace?: ReviewFilteredTrace;
  time_frequency?: ReviewTimeFrequency;
};

export type EventFeatureSummary = {
  status?: string;
  summary?: {
    event_id?: string;
    channel?: string;
    duration_seconds?: number;
    features?: Record<string, unknown>;
    spectrum?: { status?: string; reason?: string };
  };
};

export type PrepareControlsState = {
  fp: string;
  fs: string;
  rp: string;
  rs: string;
  lineNoiseNotchHz: string;
  resampleSfreq: string;
  dropBadChannels: boolean;
  dropFlatChannels: boolean;
  markOutlierChannels: boolean;
  dropOutlierChannels: boolean;
  nJobs: number;
};

export type WaveformControlsState = {
  visibleChannels: number;
  channelStartIndex: number;
  startSeconds: number;
  timeWindowSeconds: number;
  timeIncrementPercent: number;
  amplitudeScale: number;
  channelsToPlot: string[];
  annotationChannel: string;
  compareToChannels: string[];
  derivedBipolarChannels: DerivedBipolarChannel[];
  normalizeVertically: boolean;
  showFiltered: boolean;
  filter60Hz: boolean;
  // Per-display bandpass for the filtered view (Hz). null → backend default 1-80 Hz
  // clinical band. Set from the active run's biomarker so the waveform reveals the
  // right band (e.g. HFO 80-500) instead of hiding it under the 1-80 default.
  displayFilterLowHz: number | null;
  displayFilterHighHz: number | null;
  montageMode: MontageMode;
  channelFocusMode: 'all' | 'highlight' | 'neighbors' | 'clean' | 'events';
  cursorEnabled: boolean;
  measureEnabled: boolean;
  targetSamplesPerChannel: number;
};

// Montage modes offered by the waveform toolbar. 'bipolar' applies the configured pair list;
// 'auto' picks the right montage for the recording (see resolveMontageMode) and reports what it
// chose. The legacy 'autoBipolar' value is migrated to 'auto' by normalizeMontageMode.
export type MontageMode = 'referential' | 'averageReference' | 'bipolar' | 'auto';
export type ResolvedMontageMode = 'referential' | 'averageReference' | 'bipolar';

export type DerivedBipolarChannel = {
  name: string;
  channel1: string;
  channel2: string;
  kind?: 'manual' | 'autoBipolar';
};

export type MainWorkspaceState = {
  biomarker: BiomarkerType;
  activeTab: WorkspaceTab;
  recordingPath: string | null;
  metadata: RecordingMetadata | null;
  waveform: WaveformWindow | null;
  waveformControls: WaveformControlsState;
  prepareControls: PrepareControlsState;
  statusMessage: string;
  error: string | null;
};

export const DEFAULT_WAVEFORM_CONTROLS: WaveformControlsState = {
  visibleChannels: 8,
  channelStartIndex: 0,
  startSeconds: 0,
  timeWindowSeconds: 10,
  timeIncrementPercent: 100,
  amplitudeScale: 1,
  channelsToPlot: [],
  annotationChannel: '',
  compareToChannels: [],
  derivedBipolarChannels: [],
  normalizeVertically: false,
  showFiltered: false,
  filter60Hz: false,
  displayFilterLowHz: null,
  displayFilterHighHz: null,
  montageMode: 'referential',
  channelFocusMode: 'all',
  cursorEnabled: false,
  measureEnabled: false,
  targetSamplesPerChannel: 900
};

// Canonical PyHFO filter defaults (param_filter.ParamFilter: fp=80, fs=500, rp=0.5, rs=93)
// pre-filled so the Signal-prep filter has working defaults out of the box instead of blank fields.
export const DEFAULT_PREPARE_CONTROLS: PrepareControlsState = {
  fp: '80',
  fs: '500',
  rp: '0.5',
  rs: '93',
  lineNoiseNotchHz: '',
  resampleSfreq: '',
  dropBadChannels: true,
  dropFlatChannels: true,
  markOutlierChannels: true,
  dropOutlierChannels: false,
  nJobs: 1
};

export const biomarkerOptions: BiomarkerType[] = ['HFO', 'Spindle', 'Spike'];
export const workspaceTabs: WorkspaceTab[] = ['Prepare', 'Detect', 'Classify'];

// Severity is a whole-recording scalp-EEG workflow rather than a fourth biomarker, so it is a
// sibling tab that only appears once the loaded recording is detected as scalp EEG.
// Severity is NOT a workflow tab: it is a scalp-gated card in the pipeline rail (mirroring the
// PyQt inspector's Analysis|Severity segments), so the centre panel keeps exactly the three tabs
// upstream ships. Kept as a function because callers ask for "the tabs to render".
export function visibleWorkspaceTabs(_metadata?: RecordingMetadata | null): WorkspaceTab[] {
  return [...workspaceTabs];
}

export const detectorTabsByBiomarker: Record<BiomarkerType, string[]> = {
  HFO: ['STE', 'MNI', 'HIL', 'RMS', 'LineLength'],
  Spindle: ['YASA', 'LSM', 'A7', 'MOLLE'],
  Spike: ['RMS/LL']
};

export function recordingFileName(path: string | null, metadata?: RecordingMetadata | null): string {
  if (metadata?.filename) return metadata.filename;
  if (!path) return '—';
  return path.split(/[\/]/).pop() || path;
}

function formatMetadataNumber(value: string | number | undefined | null): string {
  if (value == null) return '';
  if (typeof value === 'string' && value.trim() && !Number.isFinite(Number(value))) return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  if (Number.isInteger(numeric)) return String(numeric);
  const decimals = Math.abs(numeric) >= 100 ? 1 : Math.abs(numeric) >= 10 ? 2 : 3;
  return numeric.toFixed(decimals).replace(/\.?0+$/, '');
}

export function sampleFrequency(metadata?: RecordingMetadata | null): string {
  const value = metadata?.sample_freq ?? metadata?.sampling_frequency ?? metadata?.sample_frequency_hz;
  return value == null ? '—' : formatMetadataNumber(value);
}

// Numeric sample frequency (Hz) from whichever metadata key carries it; 0 when unknown/invalid.
export function recordingSampleFrequencyHz(metadata?: RecordingMetadata | null): number {
  const value = Number(metadata?.sample_freq ?? metadata?.sampling_frequency ?? metadata?.sample_frequency_hz ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Nyquist frequency (Hz) = sampleFreq / 2, or null when the sample frequency is unknown.
export function recordingNyquistHz(metadata?: RecordingMetadata | null): number | null {
  const sampleFreq = recordingSampleFrequencyHz(metadata);
  return sampleFreq > 0 ? sampleFreq / 2 : null;
}

export function channelNames(metadata?: RecordingMetadata | null): string[] {
  return metadata?.channel_names || [];
}

export function recordingEegType(metadata?: RecordingMetadata | null): string | null {
  const value = String(metadata?.eeg_type || '').trim().toLowerCase();
  return value ? value : null;
}

// Severity scoring is only meaningful for conventional 10-20 scalp EEG; the backend refuses
// recordings whose channels don't overlap the TUEG-19 layout at all.
export function supportsSeverityScoring(metadata?: RecordingMetadata | null): boolean {
  return recordingEegType(metadata) === 'scalp';
}

export type SeveritySegmentScore = {
  segment_idx: number;
  start_sec: number;
  end_sec: number;
  score: number;
  // Set by the backend when any scalp channel in the segment swings past the artifact threshold.
  // Severity navigation skips these, matching the PyQt app.
  artifact?: boolean;
};

export type SeverityScoringResult = {
  status?: string;
  input_path?: string;
  eeg_type?: string | null;
  recording_fingerprint?: string | null;
  model_name?: string | null;
  model_version?: string | null;
  model_sha256?: string | null;
  parameters_sha256?: string | null;
  num_segments?: number;
  mean_score?: number | null;
  peak_score?: number | null;
  peak_time_sec?: number | null;
  num_clean_segments?: number;
  clean_mean_score?: number | null;
  clean_peak_score?: number | null;
  clean_peak_time_sec?: number | null;
  artifact_threshold_uv?: number | null;
  artifact_quality?: {
    status?: 'assessed' | 'partial' | 'unavailable' | 'not_applicable' | string;
    method?: string;
    threshold_uv?: number;
    assessed_segments?: number;
    total_segments?: number;
    channel_count?: number;
    reason?: string;
  } | null;
  scores?: SeveritySegmentScore[];
  artifacts?: Record<string, string>;
  warnings?: string[];
  timing?: Record<string, number>;
};

// Scores run 0 (benign) to 5 (severe). Buckets drive both the tab's readout and the
// waveform timeline overlay so a given score always reads the same colour in both places.
export const SEVERITY_SCORE_MAX = 5;

export type SeverityBucket = 'minimal' | 'mild' | 'moderate' | 'severe';

// Severity navigation ranks segments most-severe first, skipping artifact so a movement burst
// cannot be offered as the recording's worst moment. Falls back to the full list when every
// segment is flagged -- an empty rank list would leave the controls dead with no explanation.
export function severityRankedSegments(result: SeverityScoringResult | null | undefined): SeveritySegmentScore[] {
  const scores = result?.scores || [];
  if (!scores.length) return [];
  const clean = scores.filter((segment) => !segment.artifact);
  return (clean.length ? clean : scores).slice().sort((a, b) => Number(b.score) - Number(a.score));
}

export function severityBucket(score: number | null | undefined): SeverityBucket | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score < 1.25) return 'minimal';
  if (score < 2.5) return 'mild';
  if (score < 3.75) return 'moderate';
  return 'severe';
}

// Severity is a continuous magnitude, so these are steps of ONE sequential blue ramp
// (light = low, dark = high) rather than four independent hues. Validated as an ordinal
// ramp against both the light (#fcfcfb) and dark (#1a1a19) chart surfaces: monotone
// lightness, >=0.06 adjacent dL, light end clears 2:1, single hue. Do not swap an
// individual step for a different hue -- re-validate the whole ramp instead.
export const SEVERITY_BUCKET_COLORS: Record<SeverityBucket, string> = {
  minimal: '#86b6ef',
  mild: '#5598e7',
  moderate: '#2a78d6',
  severe: '#184f95'
};

export const SEVERITY_BUCKET_LABELS: Record<SeverityBucket, string> = {
  minimal: 'Minimal',
  mild: 'Mild',
  moderate: 'Moderate',
  severe: 'Severe'
};

export function formatSeverityScore(score: number | null | undefined): string {
  if (score === null || score === undefined || !Number.isFinite(score)) return '—';
  return score.toFixed(2);
}


export const BIPOLAR_TOKEN = '#-#';
export const AVERAGE_REFERENCE_SUFFIX = 'AVG';

const CONVENTIONAL_BIPOLAR_CHAINS: Array<[string, Array<[string, string]>]> = [
  ['left_parasagittal', [['Fp1', 'F3'], ['F3', 'C3'], ['C3', 'P3'], ['P3', 'O1']]],
  ['left_temporal', [['Fp1', 'F7'], ['F7', 'T3'], ['T3', 'T5'], ['T5', 'O1']]],
  ['right_parasagittal', [['Fp2', 'F4'], ['F4', 'C4'], ['C4', 'P4'], ['P4', 'O2']]],
  ['right_temporal', [['Fp2', 'F8'], ['F8', 'T4'], ['T4', 'T6'], ['T6', 'O2']]],
  ['midline', [['Fz', 'Cz'], ['Cz', 'Pz']]]
];

const CHANNEL_ALIAS: Record<string, string> = { T7: 'T3', T8: 'T4', P7: 'T5', P8: 'T6' };
const REFERENCE_SUFFIXES = ['REF', 'LE', 'AVG', 'AV', 'CAR', 'M1', 'M2', 'A1', 'A2'];
const NUMBERED_CHANNEL_PATTERN = /^(.*?)(\d+)((?:\s*[-_ ]?(?:Ref|REF|ref))?)$/;
const KNOWN_CHANNEL_PREFIX_PATTERN = /^(?:(?:EEG|POL|SEEG|ECOG)\s+)+/i;
const MIN_CONVENTIONAL_AUTO_ENTRIES = 4;
const CONVENTIONAL_LABELS = Array.from(new Set(CONVENTIONAL_BIPOLAR_CHAINS.flatMap(([, pairs]) => pairs.flat())));
const CONVENTIONAL_LOOKUP = new Map(CONVENTIONAL_LABELS.map((label) => [label.toUpperCase(), label]));

function normalizeChannelText(name: string): string {
  return String(name || '').trim().replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').replace(/\s*_\s*/g, '_');
}

function stripReferenceSuffix(label: string): string {
  const upper = label.toUpperCase();
  for (const suffix of REFERENCE_SUFFIXES) {
    if (upper.endsWith(suffix)) {
      const base = label.slice(0, -suffix.length).replace(/[\s_-]+$/g, '');
      if (base) return base;
    }
  }
  return label;
}

function canonicalConventionalChannel(name: string): string {
  const label = normalizeChannelText(name).replace(KNOWN_CHANNEL_PREFIX_PATTERN, '');
  if (!label) return '';
  const candidates = [label, ...label.split(' ').slice(-1)];
  for (const candidate of candidates) {
    const token = stripReferenceSuffix(candidate).toUpperCase();
    const canonical = CHANNEL_ALIAS[token] || token;
    const resolved = CONVENTIONAL_LOOKUP.get(canonical.toUpperCase());
    if (resolved) return resolved;
  }
  return '';
}

function conventionalSourceMap(sourceChannels: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of sourceChannels) {
    const canonical = canonicalConventionalChannel(raw);
    if (canonical && !result.has(canonical)) result.set(canonical, raw);
  }
  return result;
}

function parseNumberedContact(channel: string): { raw: string; stemKey: string; number: number; suffixKey: string } | null {
  const raw = String(channel || '').trim();
  if (!raw || raw.includes(BIPOLAR_TOKEN)) return null;
  const normalized = normalizeChannelText(raw).replace(KNOWN_CHANNEL_PREFIX_PATTERN, '');
  const match = NUMBERED_CHANNEL_PATTERN.exec(normalized);
  if (!match) return null;
  const stemKey = match[1].trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const suffixKey = (match[3] || '').trim().replace(/^[-_ ]+/, '').toLocaleLowerCase();
  return { raw, stemKey, number: Number(match[2]), suffixKey };
}

// BIPOLAR_TOKEN is an internal identity marker, not a label: it keys derived channels through
// state, waveform requests, annotations and exports, so it must never be renamed. But nobody
// wants to read 'Fp1#-#F3' on a trace -- render derived names the way a montage is written.
// Display only: never feed the result back into anything that looks a channel up.
export function displayChannelName(name: string): string {
  return String(name || '').split(BIPOLAR_TOKEN).join('-');
}

export function averageReferenceChannelName(channel: string): string {
  return `${channel}${BIPOLAR_TOKEN}${AVERAGE_REFERENCE_SUFFIX}`;
}

export function averageReferenceChannelNames(metadata: RecordingMetadata | null): string[] {
  const sourceChannels = channelNames(metadata).filter((channel) => !channel.includes(BIPOLAR_TOKEN));
  if (sourceChannels.length < 2) return [];
  return sourceChannels.map(averageReferenceChannelName);
}

// The conventional 10-20 ("double banana") chains, restricted to the pairs this recording can
// actually form. This is the scalp montage the PyQt app applied on load via
// get_conventional_bipolar_definitions(); it returns [] for iEEG, which is what makes it safe to
// use as the scalp test elsewhere.
export function conventionalBipolarDerivedChannels(metadata: RecordingMetadata | null): DerivedBipolarChannel[] {
  const sourceChannels = channelNames(metadata).filter((channel) => !channel.includes(BIPOLAR_TOKEN));
  const sourceMap = conventionalSourceMap(sourceChannels);
  const pairs: DerivedBipolarChannel[] = [];
  for (const [, chain] of CONVENTIONAL_BIPOLAR_CHAINS) {
    for (const [left, right] of chain) {
      const sourceLeft = sourceMap.get(left);
      const sourceRight = sourceMap.get(right);
      if (sourceLeft && sourceRight) pairs.push({ name: `${left}${BIPOLAR_TOKEN}${right}`, channel1: sourceLeft, channel2: sourceRight, kind: 'autoBipolar' });
    }
  }
  return pairs.length >= MIN_CONVENTIONAL_AUTO_ENTRIES ? pairs : [];
}

// Tolerate anything persisted by an older build (or sent by the agent) instead of falling back to
// a mode the user never chose: 'autoBipolar' was this control's only automatic mode before
// 'bipolar' and 'auto' were split apart.
export function normalizeMontageMode(value: unknown): MontageMode | null {
  if (value === 'autoBipolar') return 'auto';
  if (value === 'referential' || value === 'averageReference' || value === 'bipolar' || value === 'auto') return value;
  return null;
}

// What 'auto' actually means for this recording. Scalp EEG gets the conventional bipolar montage
// (matching the PyQt app, which called toggle_auto_bipolar_view(True) only when eeg_type ==
// 'scalp'); iEEG keeps the adjacent-contact bipolar derivation that Auto has always offered there.
// Anything with no derivable pairs stays referential rather than rendering an empty plot.
export function resolveMontageMode(mode: MontageMode, metadata: RecordingMetadata | null): ResolvedMontageMode {
  if (mode !== 'auto') return mode;
  return autoBipolarDerivedChannels(metadata).length ? 'bipolar' : 'referential';
}

const MONTAGE_SHORT_LABEL: Record<ResolvedMontageMode, string> = {
  referential: 'Ref',
  averageReference: 'Avg',
  bipolar: 'Bipolar',
};

// 'Auto: Bipolar' rather than a bare 'Auto': the point of Auto is that the user can see which
// montage it landed on without opening the popover.
export function montageModeLabel(mode: MontageMode, metadata: RecordingMetadata | null): string {
  if (mode !== 'auto') return MONTAGE_SHORT_LABEL[mode];
  return `Auto: ${MONTAGE_SHORT_LABEL[resolveMontageMode(mode, metadata)]}`;
}

// Montage state a freshly loaded recording should start from. Scalp EEG opens on its bipolar
// montage with the conventional pairs prefilled; everything else opens referential with the pair
// list CLEARED, so pairs built for one recording can never leak onto the next.
// A scalp study is read as a whole page -- all 19 electrodes, or all 18 bipolar derivations, at
// once, the way a 10-20 recording is laid out clinically. Intracranial recordings have far too many
// contacts for that, so they keep the default 8-channel page and scroll.
// H:MM:SS position inside the recording. The scrubbers report this rather than a bare seconds
// count, which is hard to relate to a study's timeline once a recording runs into hours.
export function formatRecordingClock(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function initialVisibleChannels(metadata: RecordingMetadata | null): number {
  if (recordingEegType(metadata) !== 'scalp') return DEFAULT_WAVEFORM_CONTROLS.visibleChannels;
  // The recording's own channel count, not the montage's -- a bipolar montage derives fewer rows
  // (18 pairs from 19 electrodes), and asking for the larger number is what makes the toolbar read
  // 'All' rather than '18' while still showing every derived row.
  const count = channelNames(metadata).length || numericChannelCount(metadata);
  return count > 0 ? count : DEFAULT_WAVEFORM_CONTROLS.visibleChannels;
}

export function montageStateForRecording(metadata: RecordingMetadata | null): { montageMode: MontageMode; derivedBipolarChannels: DerivedBipolarChannel[] } {
  const conventional = conventionalBipolarDerivedChannels(metadata);
  if (recordingEegType(metadata) === 'scalp' && conventional.length) {
    return { montageMode: 'auto', derivedBipolarChannels: conventional };
  }
  return { montageMode: 'referential', derivedBipolarChannels: [] };
}

export function autoBipolarDerivedChannels(metadata: RecordingMetadata | null): DerivedBipolarChannel[] {
  const sourceChannels = channelNames(metadata).filter((channel) => !channel.includes(BIPOLAR_TOKEN));
  const sourceMap = conventionalSourceMap(sourceChannels);
  const conventional: DerivedBipolarChannel[] = [];
  for (const [, pairs] of CONVENTIONAL_BIPOLAR_CHAINS) {
    for (const [left, right] of pairs) {
      const sourceLeft = sourceMap.get(left);
      const sourceRight = sourceMap.get(right);
      if (sourceLeft && sourceRight) conventional.push({ name: `${left}${BIPOLAR_TOKEN}${right}`, channel1: sourceLeft, channel2: sourceRight, kind: 'autoBipolar' });
    }
  }
  if (conventional.length >= MIN_CONVENTIONAL_AUTO_ENTRIES) return conventional;

  const groups = new Map<string, Array<{ raw: string; number: number }>>();
  for (const channel of sourceChannels) {
    const parsed = parseNumberedContact(channel);
    if (!parsed) continue;
    const key = `${parsed.stemKey}::${parsed.suffixKey}`;
    const group = groups.get(key) || [];
    group.push({ raw: parsed.raw, number: parsed.number });
    groups.set(key, group);
  }
  const adjacent: DerivedBipolarChannel[] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => a.number - b.number || a.raw.localeCompare(b.raw));
    for (let index = 0; index < group.length - 1; index += 1) {
      const left = group[index];
      const right = group[index + 1];
      if (right.number === left.number + 1) adjacent.push({ name: `${left.raw}${BIPOLAR_TOKEN}${right.raw}`, channel1: left.raw, channel2: right.raw, kind: 'autoBipolar' });
    }
  }
  return adjacent;
}

// Pairs a bipolar montage renders: the user's configured list when there is one (the Montage
// editor owns it), otherwise the derivation Auto would have produced.
export function montageBipolarChannels(metadata: RecordingMetadata | null, controls?: WaveformControlsState): DerivedBipolarChannel[] {
  const configured = controls?.derivedBipolarChannels || [];
  if (configured.length) return configured;
  return autoBipolarDerivedChannels(metadata);
}

export function waveformChannelUniverse(metadata: RecordingMetadata | null, controls?: WaveformControlsState): string[] {
  const resolved = controls ? resolveMontageMode(controls.montageMode, metadata) : 'referential';
  if (resolved === 'averageReference') {
    const averageChannels = averageReferenceChannelNames(metadata);
    if (averageChannels.length) return averageChannels;
  }
  if (resolved === 'bipolar') {
    const bipolarChannels = montageBipolarChannels(metadata, controls).map((channel) => channel.name);
    if (bipolarChannels.length) return bipolarChannels;
  }
  const sourceChannels = channelNames(metadata);
  const derivedChannels = controls?.derivedBipolarChannels.map((channel) => channel.name) || [];
  return Array.from(new Set([...sourceChannels, ...derivedChannels]));
}

// Context the waveform focus modes need beyond metadata/controls: the highlighted channel
// (for 'neighbors') and the set of bad/excluded channels (for 'clean'). Supplied by the caller
// from existing ROI/QC exclusion data; omitting it leaves channel selection unchanged.
export type WaveformFocusContext = {
  highlightedChannel?: string;
  excludedChannels?: string[];
  neighborRadius?: number;
};

// Conventional 10-20 EEG adjacency derived from the bipolar chains, mirroring PyQt's
// _CONVENTIONAL_NEIGHBOR_LOOKUP (utils_montage.py ~62-67): two electrodes are neighbors when they
// form a directly-bonded pair in any chain.
const CONVENTIONAL_NEIGHBOR_LOOKUP: Map<string, string[]> = (() => {
  const lookup = new Map<string, string[]>();
  const addNeighbor = (from: string, to: string) => {
    const list = lookup.get(from) || [];
    if (!list.includes(to)) list.push(to);
    lookup.set(from, list);
  };
  for (const [, pairs] of CONVENTIONAL_BIPOLAR_CHAINS) {
    for (const [left, right] of pairs) {
      addNeighbor(left, right);
      addNeighbor(right, left);
    }
  }
  return lookup;
})();

function orderedChannelSubset(orderedSource: string[], candidates: string[]): string[] {
  const candidateSet = new Set(candidates.map((channel) => String(channel)).filter(Boolean));
  return orderedSource.filter((channel) => candidateSet.has(channel));
}

// Conventional-EEG neighbors of the target (PyQt get_conventional_eeg_neighbor_channels): map the
// target + its bonded electrodes back onto the present source channels, keeping source order.
function conventionalNeighborChannels(sourceChannels: string[], targetChannel: string): string[] {
  const targetCanonical = canonicalConventionalChannel(targetChannel);
  if (!targetCanonical) return [];
  const sourceByCanonical = conventionalSourceMap(sourceChannels);
  if (!sourceByCanonical.has(targetCanonical)) return [];
  const neighborCanonicals = CONVENTIONAL_NEIGHBOR_LOOKUP.get(targetCanonical) || [];
  const candidates = [targetChannel];
  for (const canonical of neighborCanonicals) {
    const source = sourceByCanonical.get(canonical);
    if (source) candidates.push(source);
  }
  return candidates.length > 1 ? orderedChannelSubset(sourceChannels, candidates) : [];
}

// Adjacent numbered-contact neighbors (PyQt get_adjacent_contact_neighbor_channels): same stem and
// reference suffix, with contact number within +/- radius of the target.
function adjacentContactNeighborChannels(sourceChannels: string[], targetChannel: string, radius: number): string[] {
  const target = parseNumberedContact(targetChannel);
  if (!target) return [];
  const safeRadius = Math.max(1, Math.round(radius || 1));
  const candidates = [target.raw];
  for (const channel of sourceChannels) {
    const parsed = parseNumberedContact(channel);
    if (!parsed) continue;
    if (parsed.stemKey !== target.stemKey || parsed.suffixKey !== target.suffixKey) continue;
    if (Math.abs(parsed.number - target.number) <= safeRadius) candidates.push(parsed.raw);
  }
  return candidates.length > 1 ? orderedChannelSubset(sourceChannels, candidates) : [];
}

// Compute the neighbor focus subset for a highlighted channel, mirroring PyQt
// _infer_neighbor_channels (main_window_model.py ~2600-2629): conventional EEG neighbors first,
// then adjacent numbered contacts, then a positional index +/-1 fallback. Always returns the
// highlighted channel together with its neighbors in source order (or [] if none can be inferred).
export function neighborFocusChannels(sourceChannels: string[], highlightedChannel: string, radius = 1): string[] {
  const target = String(highlightedChannel || '');
  if (!target || !sourceChannels.length) return [];

  const conventional = conventionalNeighborChannels(sourceChannels, target);
  if (conventional.length) return conventional;

  const adjacent = adjacentContactNeighborChannels(sourceChannels, target, radius);
  if (adjacent.length) return adjacent;

  const targetIndex = sourceChannels.indexOf(target);
  if (targetIndex >= 0) {
    const candidates = [target];
    if (targetIndex > 0) candidates.push(sourceChannels[targetIndex - 1]);
    if (targetIndex + 1 < sourceChannels.length) candidates.push(sourceChannels[targetIndex + 1]);
    return orderedChannelSubset(sourceChannels, candidates);
  }
  return [];
}

// Compute the clean-view subset: drop bad/excluded channels, keeping source order. Mirrors PyQt
// focus_clean_channels (main_window_model.py ~2734-2748) where clean_channels = recording channels
// minus excluded (bad + flat). Returns the full list unchanged when nothing is excluded.
export function cleanViewChannels(sourceChannels: string[], excludedChannels: string[] = []): string[] {
  const excluded = new Set((excludedChannels || []).map((channel) => String(channel)).filter(Boolean));
  if (!excluded.size) return [...sourceChannels];
  const cleaned = sourceChannels.filter((channel) => !excluded.has(channel));
  return cleaned.length ? cleaned : [...sourceChannels];
}

// Apply the active channel focus mode to a base channel list. 'neighbors' and 'clean' produce real
// subsets; all other modes (all/highlight/events) leave the list untouched here (highlight/events
// are handled by selection/run logic elsewhere). Falls back to the base list when a subset cannot
// be inferred so the viewer never goes blank.
export function applyChannelFocusMode(universe: string[], base: string[], mode: WaveformControlsState['channelFocusMode'], focus?: WaveformFocusContext): string[] {
  if (!focus) return base;
  if (mode === 'neighbors') {
    const neighbors = neighborFocusChannels(universe, focus.highlightedChannel || '', focus.neighborRadius || 1);
    return neighbors.length ? neighbors : base;
  }
  if (mode === 'clean') {
    const cleaned = cleanViewChannels(universe, focus.excludedChannels || []);
    // Intersect with the base selection so an explicit channel pick is still respected.
    const baseSet = new Set(base);
    const intersected = cleaned.filter((channel) => baseSet.has(channel));
    return intersected.length ? intersected : cleaned;
  }
  return base;
}

// Collect the channels excluded from a clean view out of the existing ROI/QC analysis state,
// mirroring PyQt get_clean_recording_channel_metadata excluded_channels = bad + flat channels
// (hfo_app.py ~223-227), augmented with ROI non-brain exclusions and confirmed exclusions.
export function waveformExcludedChannels(analysis: RecordingAnalysisState | null | undefined): string[] {
  if (!analysis) return [];
  const excluded = new Set<string>();
  const add = (channel: unknown) => {
    const name = String(channel || '').trim();
    if (name) excluded.add(name);
  };
  for (const channel of analysis.qc?.excluded_channels || []) add(channel);
  for (const channel of analysis.qc?.flat_channels || []) add(channel);
  for (const channel of analysis.qc?.outlier_channels || []) add(channel);
  for (const entry of analysis.roi?.excluded_non_brain_channels || []) add(entry?.channel);
  for (const channel of analysis.roi?.default_detection_exclusions || []) add(channel);
  for (const channel of analysis.confirmed_exclusions || []) add(channel);
  return Array.from(excluded);
}

// Clamp a measured plot render width to a sane floor/cap, then map it to a backend
// target_samples_per_channel. PyQt floors render points at MIN_RENDER_POINTS=1500 and targets
// render_width_px*2 (main_waveform_plot_model.py ~39/222-223); we mirror that 2x relationship so
// server-side downsampling matches the on-screen pixel width.
export const WAVEFORM_RENDER_WIDTH_FLOOR = 320;
export const WAVEFORM_RENDER_WIDTH_CAP = 4096;
export const WAVEFORM_MIN_RENDER_SAMPLES = 1500;
export const MAX_WAVEFORM_REQUEST_CHANNELS = 32;

export function chunkWaveformRequestChannels(channels: string[], maxChannels = MAX_WAVEFORM_REQUEST_CHANNELS): string[][] {
  const max = Number.isFinite(maxChannels) ? Math.max(1, Math.floor(maxChannels)) : MAX_WAVEFORM_REQUEST_CHANNELS;
  const filtered = channels.map((channel) => String(channel || '')).filter(Boolean);
  const chunks: string[][] = [];
  for (let index = 0; index < filtered.length; index += max) chunks.push(filtered.slice(index, index + max));
  return chunks;
}

export function mergeWaveformWindowBatches(windows: WaveformWindow[]): WaveformWindow {
  if (!windows.length) throw new Error('At least one waveform window batch is required.');
  const first = windows[0];
  const filters = Array.from(new Set(windows.flatMap((window) => window.filters_applied || [])));
  return {
    ...first,
    channels: windows.flatMap((window) => window.channels || []),
    data: windows.flatMap((window) => window.data || []),
    filters_applied: filters
  };
}

export function resolveTargetSamplesPerChannel(renderWidthPx: number): number {
  const width = Number(renderWidthPx);
  const clampedWidth = Number.isFinite(width) && width > 0
    ? Math.min(WAVEFORM_RENDER_WIDTH_CAP, Math.max(WAVEFORM_RENDER_WIDTH_FLOOR, width))
    : 900;
  return Math.min(5000, Math.max(WAVEFORM_MIN_RENDER_SAMPLES, Math.round(clampedWidth * 2)));
}

// --- Overview minimap geometry (full-recording navigator) -----------------------------------
// Pure mappings between recording time and pixel-x across the compact overview width, plus the
// draggable range-band rect and the seek clamp. These mirror the PyQt overview navigator band:
// the band spans [startSeconds, startSeconds+windowSeconds] over the whole recording, and dragging
// it re-centers the main window without letting the start fall below 0 or past duration-window.
export type OverviewRangeBandRect = { x: number; width: number };

// Coarse full-recording sample target for the overview fetch. One low-resolution /waveform/window
// request (start 0, full duration) is enough to paint an envelope; ~800 columns keeps it cheap.
export const OVERVIEW_TARGET_SAMPLES_PER_CHANNEL = 800;

// Map a recording time (seconds) to a pixel x across an overview of the given width.
export function overviewTimeToX(timeSeconds: number, durationSeconds: number, widthPx: number): number {
  const width = Math.max(0, Number(widthPx) || 0);
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (duration <= 0 || width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (Number(timeSeconds) || 0) / duration));
  return ratio * width;
}

// Inverse of overviewTimeToX: map a pixel x back to a recording time (seconds), clamped to range.
export function overviewXToTime(xPx: number, durationSeconds: number, widthPx: number): number {
  const width = Math.max(0, Number(widthPx) || 0);
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (duration <= 0 || width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, (Number(xPx) || 0) / width));
  return ratio * duration;
}

// Clamp a proposed window start so the window stays inside [0, duration]. The start can never go
// below 0 nor past duration-window (when the window is at least the full duration, start pins to 0).
export function clampOverviewStartSeconds(startSeconds: number, windowSeconds: number, durationSeconds: number): number {
  const duration = Math.max(0, Number(durationSeconds) || 0);
  const window = Math.max(0, Number(windowSeconds) || 0);
  const maxStart = Math.max(0, duration - window);
  const start = Number(startSeconds);
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.min(maxStart, start));
}

// Geometry of the draggable range band: its left edge maps the window start across the overview,
// and its width maps the window length. A small minimum width keeps a sub-second band grabbable.
export function overviewRangeBandRect(startSeconds: number, windowSeconds: number, durationSeconds: number, widthPx: number, minBandPx = 6): OverviewRangeBandRect {
  const width = Math.max(0, Number(widthPx) || 0);
  const duration = Math.max(0, Number(durationSeconds) || 0);
  if (duration <= 0 || width <= 0) return { x: 0, width: Math.min(width, Math.max(0, minBandPx)) };
  const window = Math.max(0, Number(windowSeconds) || 0);
  const clampedStart = clampOverviewStartSeconds(startSeconds, window, duration);
  const rawX = overviewTimeToX(clampedStart, duration, width);
  const rawWidth = Math.max(Number(minBandPx) || 0, overviewTimeToX(window, duration, width));
  const bandWidth = Math.min(width, rawWidth);
  const x = Math.max(0, Math.min(width - bandWidth, rawX));
  return { x, width: bandWidth };
}

export function activeWaveformChannels(metadata: RecordingMetadata | null, controls: WaveformControlsState, focus?: WaveformFocusContext): string[] {
  const universe = waveformChannelUniverse(metadata, controls);
  const base = !controls.channelsToPlot.length
    ? universe
    : (() => {
        const selected = controls.channelsToPlot.filter((channel) => universe.includes(channel));
        return selected.length ? selected : universe;
      })();
  // Apply neighbors/clean focus subsetting against the full channel universe (PyQt focuses
  // relative to the recording's source order, not the prior selection).
  return applyChannelFocusMode(universe, base, controls.channelFocusMode, focus);
}

export function channelCount(metadata?: RecordingMetadata | null): string {
  const value = metadata?.n_channels ?? metadata?.num_channels ?? metadata?.channel_names?.length;
  return value == null ? '—' : String(value);
}

export function numericChannelCount(metadata?: RecordingMetadata | null): number {
  return Number(metadata?.n_channels ?? metadata?.num_channels ?? metadata?.channel_names?.length ?? 0);
}

export function recordingDurationSeconds(metadata?: RecordingMetadata | null): number {
  const value = metadata?.duration_seconds ?? metadata?.length_seconds;
  if (typeof value === 'number') return value;
  const parsed = Number(metadata?.length);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function recordingLength(metadata?: RecordingMetadata | null): string {
  const value = metadata?.duration_seconds ?? metadata?.length_seconds ?? metadata?.length;
  return value == null ? '—' : formatMetadataNumber(value);
}

// Display helpers: a recording value never renders as a bare number. The raw helpers
// above stay for callers that need the number alone; these carry the unit so the rail,
// Recording Info, and Quick Detection all read the same way (e.g. "10 s", "200 Hz").
export function recordingLengthLabel(metadata?: RecordingMetadata | null): string {
  const value = recordingLength(metadata);
  return value === '—' ? value : `${value} s`;
}

export function sampleFrequencyLabel(metadata?: RecordingMetadata | null): string {
  const value = sampleFrequency(metadata);
  return value === '—' ? value : `${value} Hz`;
}

export function clampWaveformControls(controls: WaveformControlsState, metadata?: RecordingMetadata | null): WaveformControlsState {
  const nChannels = Math.max(0, activeWaveformChannels(metadata || null, controls).length || numericChannelCount(metadata));
  const duration = Math.max(0, recordingDurationSeconds(metadata));
  const visibleChannels = Math.min(32, Math.max(1, Math.round(controls.visibleChannels || 1)));
  const channelStartIndex = Math.min(Math.max(0, nChannels - visibleChannels), Math.max(0, Math.round(controls.channelStartIndex || 0)));
  const timeWindowSeconds = Math.min(60, Math.max(0.25, Number(controls.timeWindowSeconds || 10)));
  const maxStart = Math.max(0, duration - timeWindowSeconds);
  const startSeconds = Math.min(maxStart, Math.max(0, Number(controls.startSeconds || 0)));
  return {
    ...controls,
    visibleChannels,
    channelStartIndex,
    startSeconds,
    timeWindowSeconds,
    timeIncrementPercent: Math.min(100, Math.max(1, Math.round(controls.timeIncrementPercent || 100))),
    amplitudeScale: Math.min(10, Math.max(0.25, Number(controls.amplitudeScale || 1))),
    targetSamplesPerChannel: Math.min(5000, Math.max(1, Math.round(controls.targetSamplesPerChannel || 900)))
  };
}

export function selectedWaveformChannels(metadata: RecordingMetadata | null, controls: WaveformControlsState, focus?: WaveformFocusContext): string[] {
  const names = activeWaveformChannels(metadata, controls, focus);
  if (!names.length) return [];
  const clamped = clampWaveformControls(controls, metadata);
  return names.slice(clamped.channelStartIndex, clamped.channelStartIndex + clamped.visibleChannels);
}

export function channelSelectionSummary(metadata: RecordingMetadata | null, controls: WaveformControlsState): string {
  const selected = activeWaveformChannels(metadata, controls).length;
  const total = waveformChannelUniverse(metadata, controls).length;
  return `${selected}/${total || '—'}`;
}

export function clampPrepareControls(controls: PrepareControlsState): PrepareControlsState {
  return {
    ...controls,
    lineNoiseNotchHz: controls.lineNoiseNotchHz ?? '',
    resampleSfreq: controls.resampleSfreq ?? '',
    dropBadChannels: Boolean(controls.dropBadChannels),
    dropFlatChannels: Boolean(controls.dropFlatChannels),
    markOutlierChannels: Boolean(controls.markOutlierChannels),
    dropOutlierChannels: Boolean(controls.dropOutlierChannels),
    nJobs: Math.min(256, Math.max(1, Math.round(Number(controls.nJobs) || 1)))
  };
}

// The detection bandpass stopband edge (PrepareControlsState.fs) must stay below the recording's
// Nyquist frequency, or PyHFO's cheby2 design (utils_filter.construct_filter) normalizes fs/Nyquist
// to >= 1 and detection fails silently with 0 events / 0 channels. We keep a 0.95 margin below
// Nyquist, matching the agent backend's documented min(500, 0.95*Nyquist) rule, so the small space
// padding construct_filter adds to the stopband still lands below Nyquist.
export const NYQUIST_STOPBAND_SAFETY_FACTOR = 0.95;

function formatHzShort(hz: number): string {
  const rounded = Math.round(hz * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Highest Nyquist-safe stopband edge (Hz) for a recording: floor(0.95 * Nyquist), or null when the
// sample frequency is unknown.
export function nyquistSafeStopbandHz(metadata?: RecordingMetadata | null): number | null {
  const nyquist = recordingNyquistHz(metadata);
  if (nyquist == null) return null;
  return Math.floor(NYQUIST_STOPBAND_SAFETY_FACTOR * nyquist);
}

// Clamp the stopband edge (fs) DOWN to the Nyquist-safe ceiling when a recording loads, so the
// default 500 Hz stopband never sits at/above the Nyquist of a <=1000 Hz recording (which makes
// detection silently fail). Only lowers fs: an already-safe or deliberately-lower fs is left as-is,
// and a blank/non-numeric fs is left for validateFilterControls to flag.
export function clampStopbandToNyquist(controls: PrepareControlsState, metadata?: RecordingMetadata | null): PrepareControlsState {
  const ceiling = nyquistSafeStopbandHz(metadata);
  if (ceiling == null || ceiling <= 0) return controls;
  const currentFs = Number(controls.fs);
  if (!Number.isFinite(currentFs) || currentFs <= 0) return controls;
  if (currentFs <= ceiling) return controls;
  return { ...controls, fs: String(ceiling) };
}

// Inline error string when a stopband edge (Hz) is at/above the recording's Nyquist frequency, else
// null. Used as a renderer pre-run gate so the user sees a clear cause instead of a silent backend
// "0 events, 0 channels" failure. Returns null when the sample frequency or fs is unknown/invalid.
export function nyquistStopbandError(fsHz: number, metadata?: RecordingMetadata | null): string | null {
  const nyquist = recordingNyquistHz(metadata);
  if (nyquist == null) return null;
  if (!Number.isFinite(fsHz) || fsHz <= 0) return null;
  if (fsHz < nyquist) return null;
  return `Fs stopband ${formatHzShort(fsHz)} Hz must be below the recording Nyquist ${formatHzShort(nyquist)} Hz. Lower Fs and retry.`;
}

export function validateFilterControls(controls: PrepareControlsState, metadata?: RecordingMetadata | null): string[] {
  const errors: string[] = [];
  for (const key of ['fp', 'fs', 'rp', 'rs'] as const) {
    const value = controls[key].trim();
    if (value && !Number.isFinite(Number(value))) errors.push(`${key} must be numeric`);
  }
  for (const [key, label] of [['lineNoiseNotchHz', 'line-noise notch'], ['resampleSfreq', 'resample frequency']] as const) {
    const value = controls[key].trim();
    const parsed = Number(value);
    if (value && (!Number.isFinite(parsed) || parsed <= 0)) errors.push(`${label} must be a positive number`);
  }
  const stopbandError = nyquistStopbandError(Number(controls.fs), metadata);
  if (stopbandError) errors.push(stopbandError);
  return errors;
}

// HFO detectors (STE/MNI) estimate detection thresholds over epochs of signal, so a very short
// recording yields 0 events even when the filter band and channel selection are valid. Empirically,
// cropping a recording that detects normally at full length finds nothing below ~30s (1-20s -> 0
// events, 40s -> events), and clinical HFO analysis uses at least ~1 min of interictal data. This
// floor is used ONLY to explain a 0-event result to the user, never to block or alter a run.
export const MIN_DETECTION_DURATION_SECONDS = 60;

function formatSecondsShort(seconds: number): string {
  const rounded = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10;
  return `${rounded} s`;
}

// Explanation for a detection run that returned 0 events because the recording is too short for
// reliable HFO detection, or null when the recording is long enough or its duration is unknown.
// Callers MUST gate this on an actual 0-event result so it never mislabels a genuinely empty run on
// an adequately long recording. Reuses recordingDurationSeconds so duration parsing stays in one place.
export function shortRecordingDetectionNote(metadata?: RecordingMetadata | null): string | null {
  const duration = recordingDurationSeconds(metadata);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (duration >= MIN_DETECTION_DURATION_SECONDS) return null;
  return `The recording is only ${formatSecondsShort(duration)} long, which is usually too short for reliable HFO detection (at least ${MIN_DETECTION_DURATION_SECONDS} s of interictal data is recommended). Load a longer recording if you expected events.`;
}
