type UnknownRecord = Record<string, unknown>;

export type AgentClaimStateInput = {
  scopeSalt?: string;
  autonomy?: string | null;
  recording: {
    loaded: boolean;
    locator?: string | null;
    metadata?: UnknownRecord | null;
  };
  activeRunId?: string | null;
  acceptedRunId?: string | null;
  visibleRunIds?: string[];
  runs?: UnknownRecord[];
  reviewEvents?: UnknownRecord[];
  reviewEventsByRun?: Record<string, UnknownRecord[]>;
  prepareControls?: UnknownRecord | null;
  classifierControls?: UnknownRecord | null;
  recordingAnalysis?: UnknownRecord | null;
  severity?: UnknownRecord | null;
  operation?: UnknownRecord | null;
};

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const SHA256_ROUNDS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SENSITIVE_PARAMETER_PARTS = new Set(['credential', 'directory', 'dob', 'email', 'file', 'folder', 'mrn', 'password', 'patient', 'path', 'phone', 'secret', 'subject', 'token']);
const SENSITIVE_PARAMETER_COMPOUNDS = new Set(['apikey', 'filename', 'filepath', 'patientid', 'subjectid']);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15];
      const y = words[index - 2];
      const sigma0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const sigma1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choice + SHA256_ROUNDS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, '0')).join('');
}

function stableCanonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableCanonicalJson(value[key])}`).join(',')}}`;
}

function jsonCanonicalValue(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (Array.isArray(value)) return value.map(jsonCanonicalValue);
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, jsonCanonicalValue(item)])
  );
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(stableCanonicalJson(jsonCanonicalValue(value)));
}

/** Broker-safe workspace identifier: stable for one workspace, without exposing local paths/PHI. */
export function opaqueWorkspaceSessionId(
  appSessionId: string,
  projectId?: string | null,
  projectPath?: string | null,
  recordingPath?: string | null,
): string {
  const workspaceIdentity = projectId || projectPath || recordingPath || 'unsaved-workspace';
  return `workspace-${canonicalJsonSha256({ app_session: appSessionId, workspace: workspaceIdentity }).slice(0, 32)}`;
}

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

function finiteNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Object.is(numeric, -0) ? 0 : numeric;
}

function isSensitiveParameterKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts.some((part) => SENSITIVE_PARAMETER_PARTS.has(part))
    || SENSITIVE_PARAMETER_COMPOUNDS.has(parts.join(''));
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

// Strings that can carry paths, patient identifiers, free-text notes, channel labels,
// or model locations are never copied into the canonical state. Their opaque token still
// makes a clinically relevant value change invalidate the revision without disclosing it.
function opaqueToken(kind: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${kind}-${sha256Hex(String(value))}`;
}

function sortedTokens(kind: string, values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => opaqueToken(kind, value))
    .filter((value): value is string => Boolean(value))
    .sort();
}

function safeParameterValue(value: unknown, seen: WeakSet<object>, depth = 0): CanonicalJson | undefined {
  if (depth > 8 || value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : undefined;
  if (typeof value === 'string') return opaqueToken('text', value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const projected = value
      .slice(0, 512)
      .map((item) => safeParameterValue(item, seen, depth + 1))
      .filter((item): item is CanonicalJson => item !== undefined);
    seen.delete(value);
    return projected;
  }
  if (typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  const projected: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(value as UnknownRecord).sort().slice(0, 512)) {
    if (isSensitiveParameterKey(key)) continue;
    const item = safeParameterValue((value as UnknownRecord)[key], seen, depth + 1);
    if (item !== undefined) projected[key] = item;
  }
  seen.delete(value);
  return projected;
}

function canonicalParameters(value: unknown): CanonicalJson {
  return safeParameterValue(asRecord(value), new WeakSet()) || {};
}

function canonicalRecording(input: AgentClaimStateInput['recording']): CanonicalJson {
  if (!input.loaded) return { loaded: false };
  const metadata = asRecord(input.metadata);
  const channelNames = Array.isArray(metadata.channel_names) ? metadata.channel_names : [];
  const explicitFingerprint = metadata.recording_fingerprint ?? metadata.fingerprint ?? metadata.content_hash ?? metadata.sha256;
  return {
    loaded: true,
    // The locator distinguishes two same-shape recordings, but only an opaque token enters
    // canonical state. Raw filesystem paths never enter a request or broker receipt revision.
    locator_token: opaqueToken('recording', input.locator),
    fingerprint_token: opaqueToken('fingerprint', explicitFingerprint),
    sample_frequency_hz: finiteNumber(metadata.sample_freq ?? metadata.sampling_frequency ?? metadata.sample_frequency_hz),
    duration_seconds: finiteNumber(metadata.duration_seconds ?? metadata.length_seconds ?? metadata.length),
    channel_count: finiteNumber(metadata.n_channels ?? metadata.num_channels ?? channelNames.length),
    channel_layout_token: opaqueToken('channels', stableCanonicalJson(channelNames.map((name) => opaqueToken('channel', name))))
  };
}

function canonicalRun(runValue: unknown): CanonicalJson {
  const run = asRecord(runValue);
  return {
    run_token: opaqueToken('run', run.runId ?? run.run_id),
    biomarker_token: opaqueToken('biomarker', run.biomarker),
    detector_token: opaqueToken('detector', run.detector),
    classifier_token: opaqueToken('classifier', run.classifier),
    status_token: opaqueToken('status', run.status),
    event_count: finiteNumber(run.events),
    channel_count: finiteNumber(run.channels),
    accepted: booleanValue(run.accepted),
    parameters: canonicalParameters(run.parameters)
  };
}

function canonicalRuns(runs: unknown): CanonicalJson[] {
  if (!Array.isArray(runs)) return [];
  return runs
    .map(canonicalRun)
    .sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right)));
}

function canonicalAnnotation(annotationValue: unknown): CanonicalJson | null {
  if (!annotationValue || typeof annotationValue !== 'object' || Array.isArray(annotationValue)) return null;
  const annotation = asRecord(annotationValue);
  return {
    label_token: opaqueToken('review-label', annotation.label),
    display_label_token: opaqueToken('review-display', annotation.display_label),
    status_token: opaqueToken('review-status', annotation.status),
    notes_token: opaqueToken('review-notes', annotation.notes),
    reviewer_token: opaqueToken('reviewer', annotation.reviewer),
    source_token: opaqueToken('review-source', annotation.source)
  };
}

function canonicalReviewEvent(eventValue: unknown): CanonicalJson {
  const event = asRecord(eventValue);
  return {
    event_token: opaqueToken('event', event.event_id),
    run_token: opaqueToken('run', event.run_id),
    channel_token: opaqueToken('channel', event.channel),
    start_seconds: finiteNumber(event.start_seconds),
    end_seconds: finiteNumber(event.end_seconds),
    duration_seconds: finiteNumber(event.duration_seconds),
    biomarker_token: opaqueToken('biomarker', event.biomarker),
    annotation: canonicalAnnotation(event.annotation),
    // Per-event classifier outputs and derived features can change a claim even when the
    // review label has not yet changed. Sensitive-key filtering remains recursive.
    features: canonicalParameters(event.features)
  };
}

function canonicalReviewEvents(events: unknown): CanonicalJson[] {
  if (!Array.isArray(events)) return [];
  return events
    .map(canonicalReviewEvent)
    .sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right)));
}

function canonicalReviewsByRun(eventsByRun: unknown): CanonicalJson[] {
  const record = asRecord(eventsByRun);
  return Object.keys(record)
    .map((runId) => ({ run_token: opaqueToken('run', runId), events: canonicalReviewEvents(record[runId]) }))
    .sort((left, right) => stableCanonicalJson(left).localeCompare(stableCanonicalJson(right)));
}

function canonicalPrepareControls(value: unknown): CanonicalJson {
  const controls = asRecord(value);
  return {
    filter_pass_hz: finiteNumber(controls.fp),
    filter_stop_hz: finiteNumber(controls.fs),
    passband_ripple_db: finiteNumber(controls.rp),
    stopband_attenuation_db: finiteNumber(controls.rs),
    line_noise_notch_hz: finiteNumber(controls.lineNoiseNotchHz),
    resample_frequency_hz: finiteNumber(controls.resampleSfreq),
    n_jobs: finiteNumber(controls.nJobs),
    drop_bad_channels: booleanValue(controls.dropBadChannels),
    drop_flat_channels: booleanValue(controls.dropFlatChannels),
    mark_outlier_channels: booleanValue(controls.markOutlierChannels),
    drop_outlier_channels: booleanValue(controls.dropOutlierChannels)
  };
}

function canonicalClassifierControls(value: unknown): CanonicalJson {
  const controls = asRecord(value);
  return {
    mode_token: opaqueToken('classifier-mode', controls.mode),
    device_token: opaqueToken('classifier-device', controls.device),
    batch_size: finiteNumber(controls.batchSize),
    ignore_before_seconds: finiteNumber(controls.ignoreBefore),
    ignore_after_seconds: finiteNumber(controls.ignoreAfter),
    use_spike: booleanValue(controls.useSpike),
    use_ehfo: booleanValue(controls.useEhfo),
    // Model identity is claim-affecting, while local paths and remote identifiers are not
    // suitable for transport. Tokens preserve equality/change semantics without disclosure.
    local_artifact_token: opaqueToken('model', controls.localArtifact),
    local_spike_token: opaqueToken('model', controls.localSpike),
    local_ehfo_token: opaqueToken('model', controls.localEhfo),
    hub_artifact_token: opaqueToken('model', controls.hubArtifact),
    hub_spike_token: opaqueToken('model', controls.hubSpike),
    hub_ehfo_token: opaqueToken('model', controls.hubEhfo)
  };
}

function canonicalRecordingAnalysis(value: unknown): CanonicalJson | null {
  const analysis = asRecord(value);
  const hasResult = analysis.roi || analysis.qc || analysis.spectral || analysis.candidate_ranking || analysis.confirmed_exclusions;
  if (!hasResult && (!analysis.status || analysis.status === 'idle')) return null;
  return {
    status_token: opaqueToken('analysis-status', analysis.status),
    roi: canonicalParameters(analysis.roi),
    qc: canonicalParameters(analysis.qc),
    spectral: canonicalParameters(analysis.spectral),
    candidate_ranking: canonicalParameters(analysis.candidate_ranking),
    confirmed_exclusion_tokens: sortedTokens('channel', analysis.confirmed_exclusions)
  };
}

function canonicalSeverity(value: unknown): CanonicalJson | null {
  const severity = asRecord(value);
  const result = asRecord(severity.result);
  const status = severity.status ?? result.status;
  if (!status || status === 'idle') return null;
  return {
    status_token: opaqueToken('severity-status', status),
    eeg_type_token: opaqueToken('eeg-type', result.eeg_type),
    recording_fingerprint_token: opaqueToken('fingerprint', result.recording_fingerprint),
    model_name_token: opaqueToken('severity-model', result.model_name),
    model_version_token: opaqueToken('severity-model-version', result.model_version),
    model_sha256_token: opaqueToken('severity-model-digest', result.model_sha256),
    parameters_sha256_token: opaqueToken('severity-parameters-digest', result.parameters_sha256),
    num_segments: finiteNumber(result.num_segments),
    num_clean_segments: finiteNumber(result.num_clean_segments),
    mean_score: finiteNumber(result.mean_score),
    peak_score: finiteNumber(result.peak_score),
    peak_time_seconds: finiteNumber(result.peak_time_sec),
    clean_mean_score: finiteNumber(result.clean_mean_score),
    clean_peak_score: finiteNumber(result.clean_peak_score),
    clean_peak_time_seconds: finiteNumber(result.clean_peak_time_sec)
  };
}

function canonicalOperation(value: unknown): CanonicalJson | null {
  const operation = asRecord(value);
  if (!operation.status || operation.status === 'idle') return null;
  return {
    operation_token: opaqueToken('operation', operation.id),
    kind_token: opaqueToken('operation-kind', operation.kind),
    status_token: opaqueToken('operation-status', operation.status),
    completed_steps: finiteNumber(operation.completedSteps),
    total_steps: finiteNumber(operation.totalSteps)
  };
}

export function canonicalAgentClaimState(input: AgentClaimStateInput): CanonicalJson {
  return {
    autonomy_token: opaqueToken('autonomy', input.autonomy),
    recording: canonicalRecording(input.recording),
    active_run_token: opaqueToken('run', input.activeRunId),
    accepted_run_token: opaqueToken('run', input.acceptedRunId),
    visible_run_tokens: sortedTokens('run', input.visibleRunIds),
    runs: canonicalRuns(input.runs),
    review: {
      workspace_events: canonicalReviewEvents(input.reviewEvents),
      events_by_run: canonicalReviewsByRun(input.reviewEventsByRun)
    },
    prepare: canonicalPrepareControls(input.prepareControls),
    classifier: canonicalClassifierControls(input.classifierControls),
    analysis: canonicalRecordingAnalysis(input.recordingAnalysis),
    severity: canonicalSeverity(input.severity),
    operation: canonicalOperation(input.operation)
  };
}

export function agentClaimStateRevision(input: AgentClaimStateInput): string {
  const canonical = stableCanonicalJson(canonicalAgentClaimState(input));
  const salt = String(input.scopeSalt || '');
  return `desktop-state-${sha256Hex(`${salt.length}:${salt}:${canonical}`)}`;
}
