import type { AgentArtifact, CapabilityManifest, EventFeatureSummary, PrepareControlsState, RecordingAnalysisState, RecordingMetadata, ReviewEvent, ReviewSnippet, RunRecord, RuntimeLogEntry, WaveformControlsState } from './workspaceState';
import { DEFAULT_PREPARE_CONTROLS, DEFAULT_WAVEFORM_CONTROLS } from './workspaceState';
import type { ClassifierControlsState } from '../features/shell/ClassifierTab';
import { DEFAULT_CLASSIFIER_STATE } from '../features/shell/ClassifierTab';
import type { WaveformWindow } from '../features/waveform/WaveformCanvas';

export type VisualFixtureState = {
  recordingPath: string;
  metadata: RecordingMetadata;
  waveform: WaveformWindow;
  waveformControls: WaveformControlsState;
  prepareControls: PrepareControlsState;
  recordingAnalysis: RecordingAnalysisState;
  classifierControls: ClassifierControlsState;
  classifierFeedback: string;
  runRecords: RunRecord[];
  activeRunId: string;
  acceptedRunId: string;
  visibleRunIds: string[];
  reviewEvents: ReviewEvent[];
  runEventsByRun: Record<string, ReviewEvent[]>;
  selectedReviewEventId: string;
  reviewMessage: string;
  runtimeLog: RuntimeLogEntry[];
  agentArtifacts: AgentArtifact[];
  capabilityManifest: CapabilityManifest;
  statusMessage: string;
};

const CHANNELS = ['B10Ref', 'A2Ref', 'A1Ref', 'C3Ref', 'C4Ref', 'POL IO3', 'POL IO4', 'POL IO5'];
const PYQT_MAIN_VISIBLE_CHANNELS = ['POL IO3', 'POL IO4', 'POL IO5', 'A1Ref', 'A2Ref', 'B10Ref', 'C3Ref', 'C4Ref'];
const TIMES = Array.from({ length: 900 }, (_, index) => Number((index / 90).toFixed(4)));
const PYQT_MAIN_SAMPLE_RATE_HZ = 200;
const PYQT_MAIN_FILTER_HIGH_CUT_HZ = 98.9;
const PYQT_QUICK_DETECTION_SAMPLE_RATE_HZ = 2000;
const PYQT_REVIEW_SAMPLE_RATE_HZ = 2000;
const PYQT_REVIEW_MIN_FREQUENCY_HZ = 1;
const PYQT_REVIEW_MAX_FREQUENCY_HZ = 1000;
const PYQT_ANNOTATION_SINE_TRACE_SOURCE = 'visual-fixture-pyqt-annotation-sine-trace';
const PYQT_MAIN_EVENT_BURST_SECONDS = 2.2;
const PYQT_MAIN_RIGHT_MARKER_SECONDS = 9.82;
const PYQT_MAIN_BALANCED_TRACE_AMPLITUDE = 1;
const PYQT_MAIN_SHARED_EVENT_MARKER_SOURCE = 'visual-fixture-pyqt-main-shared-event-marker';

function deterministicNoise(index: number, channelIndex: number): number {
  const seed = Math.sin((index + 1) * 12.9898 + (channelIndex + 1) * 78.233) * 43758.5453;
  return seed - Math.floor(seed) - 0.5;
}

function eventEnvelope(time: number, center: number, width: number): number {
  return Math.exp(-Math.pow((time - center) / width, 2));
}

function trace(channelIndex: number, visibleIndex = channelIndex): number[] {
  return TIMES.map((time, index) => {
    const baseFrequency = 11.2 + visibleIndex * 0.65;
    const visibleAmplitude = PYQT_MAIN_BALANCED_TRACE_AMPLITUDE;
    const phaseOffset = visibleIndex * 0.13;
    const denseTrace =
      Math.sin((time + phaseOffset) * Math.PI * 2 * baseFrequency) * 18.5 +
      Math.sin((time + phaseOffset / 2) * Math.PI * 2 * (baseFrequency * 2.2)) * 2.7 +
      deterministicNoise(index, channelIndex) * 1.3;
    const sharedMainMarkerAmplitude =
      visibleIndex <= 2 ? 54 :
      visibleIndex <= 4 ? 46 :
      visibleIndex === 5 ? 38 :
      18;
    const mainBurst =
      Math.sin(time * Math.PI * 2 * 112) *
      sharedMainMarkerAmplitude *
      eventEnvelope(time, PYQT_MAIN_EVENT_BURST_SECONDS, 0.065);
    const b10Burst =
      channelIndex === CHANNELS.indexOf('B10Ref')
        ? Math.sin(time * Math.PI * 2 * 86) *
          18 *
          eventEnvelope(time, PYQT_MAIN_EVENT_BURST_SECONDS + 0.03, 0.065)
        : 0;
    const rightMarker =
      Math.sin(time * Math.PI * 2 * 155) *
      40 *
      eventEnvelope(time, PYQT_MAIN_RIGHT_MARKER_SECONDS, 0.018);
    return Number(((denseTrace + mainBurst + b10Burst + rightMarker) * visibleAmplitude).toFixed(3));
  });
}

function pyqtAnnotationSineTraceAt(channelIndex: number, time: number, start: number, end: number): number {
  const span = Math.max(0.001, end - start);
  const phase = (time - start) / span;
  const channelPhase = channelIndex * 0.18;
  // PyQt dummy-review visual parity: the Annotation screenshot uses smooth
  // matplotlib-like sine curves across the full review interval. Keep this
  // visual-fixture-only / visual-fixture-review so production backend snippets continue to show the
  // real event waveform data and high-frequency bursts.
  const slowArc = Math.sin((phase * 1.25 + channelPhase * 0.08) * Math.PI * 2) * 98;
  const secondaryArc = Math.sin((phase * 2.5 + 0.04 + channelPhase) * Math.PI * 2) * 2.5;
  const trend = Math.sin(phase * Math.PI) * 3;
  return Number((slowArc + secondaryArc + trend).toFixed(3));
}

function fixtureEventTrace(event: ReviewEvent): { times: number[]; data: number[] } {
  const padding = 1.0;
  const start = Math.max(0, (event.start_seconds || 0) - padding);
  const end = Math.min(10, (event.end_seconds || start + 0.1) + padding);
  const samples = Math.max(4, Math.round((end - start) * PYQT_REVIEW_SAMPLE_RATE_HZ));
  const channelIndex = Math.max(0, CHANNELS.findIndex((channel) => channel === event.channel));
  const times = Array.from({ length: samples }, (_, index) => Number((start + (index / Math.max(1, samples - 1)) * (end - start)).toFixed(4)));
  return { times, data: times.map((time) => pyqtAnnotationSineTraceAt(channelIndex, time, start, end)) };
}

function fixtureFilteredTrace(row: number[]): number[] {
  return row.map((value, index) => {
    const left = row[Math.max(0, index - 3)] || 0;
    const right = row[Math.min(row.length - 1, index + 3)] || 0;
    const smooth = (left + value * 2 + right) / 4;
    return Number((smooth * 1.06).toFixed(3));
  });
}

function fixtureTimeFrequency(row: number[]): number[][] {
  const rows = 44;
  const columns = 72;
  const eventCenterColumn = 34;
  return Array.from({ length: rows }, (_, rowIndex) =>
    Array.from({ length: columns }, (_, columnIndex) => {
      const signal = Math.abs(
        row[
          Math.min(
            row.length - 1,
            Math.floor((columnIndex / Math.max(1, columns - 1)) * row.length),
          )
        ] || 0,
      );
      // PyQt dummy-review spectrogram parity: high frequency is at the top,
      // with a bright red/orange cap and mostly dark purple low/mid-frequency
      // background. Narrow vertical event streaks mark the annotation window.
      const highFrequencyCap = rowIndex < 5 ? 0.82 - rowIndex * 0.055 : 0;
      const lowFrequencyRim = rowIndex > rows - 3 ? 0.68 : 0;
      const darkBackground =
        0.055 +
        Math.sin(rowIndex * 0.8) * 0.015 +
        Math.cos(columnIndex * 0.45) * 0.012;
      const midBandWeight = Math.exp(-Math.pow((rowIndex - rows * 0.52) / 8, 2));
      const topCapMask = Math.min(1, rowIndex / 8);
      const eventColumn =
        (Math.exp(-Math.pow((columnIndex - eventCenterColumn) / 1.15, 2)) * 0.22 +
          Math.exp(-Math.pow((columnIndex - eventCenterColumn - 4) / 1.7, 2)) *
            0.12) *
        midBandWeight *
        topCapMask;
      const signalTexture =
        (signal / 110) *
        midBandWeight *
        0.13;
      return Number(
        Math.min(
          0.98,
          Math.max(
            0,
            darkBackground +
              highFrequencyCap +
              lowFrequencyRim +
              eventColumn +
              signalTexture,
          ),
        ).toFixed(3),
      );
    }),
  );
}

function waveformTraceForChannel(channel: string): number[] {
  const channelIndex = CHANNELS.indexOf(channel);
  const visibleIndex = PYQT_MAIN_VISIBLE_CHANNELS.indexOf(channel);
  return trace(channelIndex >= 0 ? channelIndex : 0, visibleIndex >= 0 ? visibleIndex : channelIndex);
}

const reviewEvents: ReviewEvent[] = [
  { event_id: 'evt-hfo-001', run_id: 'run-mni-002', index: 1, channel: 'A1', start_seconds: 0.5, end_seconds: 0.55, duration_seconds: 0.05, biomarker: 'HFO', annotation: null, features: {} },
  { event_id: 'evt-hfo-002', run_id: 'run-mni-002', index: 2, channel: 'A2', start_seconds: 1.5, end_seconds: 1.56, duration_seconds: 0.06, biomarker: 'HFO', annotation: null, features: {} }
];
const mainWaveformEvents: ReviewEvent[] = [
  { ...reviewEvents[0], channel: 'POL IO3', start_seconds: 2.15, end_seconds: 2.35, duration_seconds: 0.2 },
  { ...reviewEvents[1], channel: 'C4Ref', start_seconds: 9.76, end_seconds: 9.88, duration_seconds: 0.12 }
];

export const VISUAL_FIXTURE_STATE: VisualFixtureState = {
  recordingPath: '/visual-fixtures/pyqt-electron-layout-parity.fif',
  metadata: {
    input_path: '/visual-fixtures/pyqt-electron-layout-parity.fif',
    filename: 'pyqt-electron-layout-parity.fif',
    sample_freq: PYQT_MAIN_SAMPLE_RATE_HZ,
    sampling_frequency: PYQT_MAIN_SAMPLE_RATE_HZ,
    n_channels: CHANNELS.length,
    num_channels: CHANNELS.length,
    channel_names: CHANNELS,
    duration_seconds: 10,
    length_seconds: 10
  },
  waveform: { channels: PYQT_MAIN_VISIBLE_CHANNELS, times_seconds: TIMES, data: PYQT_MAIN_VISIBLE_CHANNELS.map(waveformTraceForChannel), units: 'uV', source: 'visual-fixture-pyqt-visible-order', filters_applied: ['60 Hz notch preview', PYQT_MAIN_SHARED_EVENT_MARKER_SOURCE] },
  waveformControls: { ...DEFAULT_WAVEFORM_CONTROLS, visibleChannels: 8, timeWindowSeconds: 9.99, channelsToPlot: PYQT_MAIN_VISIBLE_CHANNELS, annotationChannel: 'B10Ref', showFiltered: true, filter60Hz: true, normalizeVertically: true, channelFocusMode: 'events' },
  prepareControls: { ...DEFAULT_PREPARE_CONTROLS, fp: '80', fs: String(PYQT_MAIN_FILTER_HIGH_CUT_HZ), rp: '0.5', rs: '40', lineNoiseNotchHz: '60', nJobs: 4 },
  recordingAnalysis: {
    status: 'complete',
    updatedAt: '2026-06-01T00:00:00.000Z',
    roi: { status: 'complete', brain_signal_channels: CHANNELS.slice(0, 6), brain_signal_channel_count: 6, excluded_non_brain_channel_count: 2, excluded_non_brain_channels: [{ channel: 'EKG1-EKG2', reason: 'non-brain physiological channel' }], default_detection_exclusions: ['EKG1-EKG2'] },
    qc: { status: 'complete', roi_channel_count: 6, flat_channels: [], outlier_channels: ['POL IO5'], per_channel: CHANNELS.slice(0, 4).map((channel, index) => ({ channel, rms: 14 + index, std: 9 + index, peak_to_peak: 90 + index * 8, nan_fraction: 0, flat_fraction: 0, log_rms_modified_z: index === 3 ? 3.2 : 0.4 })) },
    spectral: { status: 'complete', sample_freq: PYQT_MAIN_SAMPLE_RATE_HZ, nyquist_hz: 100, channels_analyzed: CHANNELS.slice(0, 4), relative_band_power: { delta: 0.12, theta: 0.18, alpha: 0.2, beta: 0.24, gamma: 0.26 }, psd_curve: Array.from({ length: 24 }, (_, index) => ({ frequency_hz: index * 4, db: -34 + Math.sin(index / 3) * 8, relative_power: Math.max(0.02, 0.4 - index * 0.012) })), recommended_hfo_band: [80, PYQT_MAIN_FILTER_HIGH_CUT_HZ], line_noise_candidates: [{ frequency_hz: 60, local_power_ratio: 1.8 }] },
    confirmed_exclusions: ['EKG1-EKG2']
  },
  classifierControls: { ...DEFAULT_CLASSIFIER_STATE, mode: 'ONNX CPU', useSpike: true, useEhfo: true, device: 'cpu', batchSize: '32' },
  classifierFeedback: 'Bundled ONNX classifier stack ready.',
  runRecords: [
    { runId: 'run-ste-001', biomarker: 'HFO', detector: 'STE', events: 2, channels: 2, status: 'complete', classifier: 'not run', accepted: false, createdAt: '2026-06-01T00:00:00.000Z', parameters: { fp: 80, fs: PYQT_MAIN_FILTER_HIGH_CUT_HZ, min_window: 0.006, threshold: 3 } },
    { runId: 'run-mni-002', biomarker: 'HFO', detector: 'MNI', events: 2, channels: 2, status: 'complete', classifier: 'not run', accepted: true, createdAt: '2026-06-01T00:01:00.000Z', parameters: { fp: 80, fs: PYQT_MAIN_FILTER_HIGH_CUT_HZ, threshold: 3.5 } }
  ],
  activeRunId: 'run-mni-002',
  acceptedRunId: 'run-mni-002',
  visibleRunIds: ['run-ste-001', 'run-mni-002'],
  reviewEvents,
  runEventsByRun: { 'run-ste-001': mainWaveformEvents.map((event, index) => ({ ...event, event_id: `evt-ste-00${index + 1}`, run_id: 'run-ste-001' })), 'run-mni-002': mainWaveformEvents },
  selectedReviewEventId: 'evt-hfo-001',
  reviewMessage: 'HFO MNI review events loaded.',
  runtimeLog: [
    { id: 'visual-fixture-ready', timestamp: '2026-06-01T00:00:00.000Z', level: 'success', message: 'Case workspace ready.' },
    { id: 'visual-fixture-run', timestamp: '2026-06-01T00:00:03.000Z', level: 'info', message: 'MNI detection review events loaded.' }
  ],
  agentArtifacts: [
    { id: 'visual-session', label: 'Session artifact', type: 'session', path: '/visual-fixtures/hfo-layout.pybrain', source: 'agent', createdAt: '2026-06-01T00:00:00.000Z', status: 'fixture' },
    { id: 'visual-report', label: 'Report artifact', type: 'report', path: '/visual-fixtures/hfo-layout-report.html', source: 'backend', runId: 'run-mni-002', createdAt: '2026-06-01T00:00:00.000Z', status: 'fixture' }
  ],
  capabilityManifest: { classifier: { cpu: { available: true, backend: 'visual-fixture', ui_behavior: 'available' }, gpu: { available: false, backend: 'visual-fixture', install_hint: 'GPU preset unavailable in this environment.', ui_behavior: 'disabled' } }, optional_dependencies: { yasa: { available: true, ui_behavior: 'available' } } },
  statusMessage: 'Case ready.'
};

export function visualFixtureQuickDetectionMetadata(): RecordingMetadata {
  return {
    ...VISUAL_FIXTURE_STATE.metadata,
    sample_freq: PYQT_QUICK_DETECTION_SAMPLE_RATE_HZ,
    sampling_frequency: PYQT_QUICK_DETECTION_SAMPLE_RATE_HZ,
    sample_frequency_hz: PYQT_QUICK_DETECTION_SAMPLE_RATE_HZ,
  };
}

export function isVisualFixtureMode(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('visualFixture');
}

export function visualFixtureEventSnippet(event: ReviewEvent): ReviewSnippet {
  const { times, data } = fixtureEventTrace(event);
  const filtered = fixtureFilteredTrace(data);
  const tfIntensity = fixtureTimeFrequency(filtered);
  const frequencies = Array.from({ length: tfIntensity.length }, (_, index) => Number((PYQT_REVIEW_MAX_FREQUENCY_HZ - index * ((PYQT_REVIEW_MAX_FREQUENCY_HZ - PYQT_REVIEW_MIN_FREQUENCY_HZ) / Math.max(1, tfIntensity.length - 1))).toFixed(3)));
  const timeBinCount = tfIntensity[0]?.length || 1;
  const timeBins = Array.from({ length: timeBinCount }, (_, index) => times[Math.min(times.length - 1, Math.round((index / Math.max(1, timeBinCount - 1)) * (times.length - 1)))] || 0);
  return {
    status: 'visual-fixture',
    event,
    waveform: { channels: [event.channel || CHANNELS[0]], times_seconds: times, data: [data], units: 'uV', source: PYQT_ANNOTATION_SINE_TRACE_SOURCE },
    filtered_trace: { status: 'visual-fixture', source: PYQT_ANNOTATION_SINE_TRACE_SOURCE, sample_freq: PYQT_REVIEW_SAMPLE_RATE_HZ, units: 'uV', times_seconds: times, data: filtered, filter: { fp: 80, fs: 250 } },
    time_frequency: { status: 'visual-fixture', source: PYQT_ANNOTATION_SINE_TRACE_SOURCE, display_transform: 'log10', display_percentiles: [2, 98], display_limits: [0, 1], colormap: 'magma', frequency_range: [PYQT_REVIEW_MIN_FREQUENCY_HZ, PYQT_REVIEW_MAX_FREQUENCY_HZ], high_frequency_at_top: true, frequencies_hz: frequencies, time_bins_seconds: timeBins, intensity: tfIntensity }
  };
}

export function visualFixtureEventFeatureSummary(event: ReviewEvent): EventFeatureSummary {
  return {
    status: 'visual-fixture',
    summary: {
      event_id: event.event_id,
      channel: event.channel,
      duration_seconds: event.duration_seconds,
      features: event.features || {},
      spectrum: { status: 'visual-fixture' }
    }
  };
}
