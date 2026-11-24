import type * as React from 'react';
import { useMemo } from 'react';
import type { BiomarkerType, CapabilityManifest, PrepareControlsState, RecordingAnalysisState, RecordingMetadata, ReviewEvent, RunRecord, RuntimeLogEntry, RuntimeOperation, WorkspaceTab } from '../../app/workspaceState';
import { visibleWorkspaceTabs } from '../../app/workspaceState';
import { DetectTab, type DetectorRunRequest } from './DetectorForms';
import { ClassifierTab, type ClassifierControlsState, type ClassifierRunRequest } from './ClassifierTab';

type WorkspaceTabsProps = {
  activeTab: WorkspaceTab;
  onTabChange: (tab: WorkspaceTab) => void;
  onCollapse: () => void;
  collapsed: boolean;
  metadata: RecordingMetadata | null;
  recordingPath: string | null;
  capabilityManifest: CapabilityManifest | null;
  biomarker: BiomarkerType;
  prepareControls: PrepareControlsState;
  recordingAnalysis: RecordingAnalysisState;
  classifierControls: ClassifierControlsState;
  classifierFeedback: string;
  runRecords: RunRecord[];
  activeRunId: string | null;
  runtimeOperation: RuntimeOperation;
  runtimeLog: RuntimeLogEntry[];
  onPrepareControlsChange: (controls: PrepareControlsState) => void;
  onRecordingAnalysisChange: (analysis: RecordingAnalysisState) => void;
  onClassifierControlsChange: (controls: ClassifierControlsState) => void;
  onClassifierFeedbackChange: (feedback: string) => void;
  onBiomarkerChange: (biomarker: BiomarkerType) => void;
  onAnalyzeRecordingPlanning: () => Promise<void> | void;
  onApplyFilters: () => void;
  onSaveNJobs: () => void;
  onRunDetection: (request: DetectorRunRequest) => Promise<void> | void;
  onRunClassifier: (request: ClassifierRunRequest) => Promise<void> | void;
  onCancelRuntimeOperation: () => void;
  onOpenModelFile: () => Promise<string | null>;
  // Viewport placement supplied by the shell: the panel is position:fixed and anchored under the
  // Prep/Detect/Classify buttons that open it.
  popoverStyle?: React.CSSProperties;
};

export function WorkspaceTabs({ activeTab, onTabChange, onCollapse, collapsed, metadata, recordingPath, capabilityManifest, biomarker, prepareControls, recordingAnalysis, classifierControls, classifierFeedback, runRecords, activeRunId, runtimeOperation, runtimeLog, onPrepareControlsChange, onRecordingAnalysisChange, onClassifierControlsChange, onClassifierFeedbackChange, onBiomarkerChange, onAnalyzeRecordingPlanning, onApplyFilters, onSaveNJobs, onRunDetection, onRunClassifier, onCancelRuntimeOperation, onOpenModelFile, popoverStyle }: WorkspaceTabsProps) {
  const tabs = useMemo(() => visibleWorkspaceTabs(metadata), [metadata]);
  return (
    <section
      className="workspace-tabs"
      data-testid="pyqt-tabWidget"
      hidden={collapsed}
      style={popoverStyle}
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <header className="workspace-tabs-header">
        <nav className="tab-bar" aria-label="PyQt workspace tabs">
          <div className="workflow-tab-list" role="tablist" aria-label="Workflow steps">
            {tabs.map((tab) => (
              <button key={tab} role="tab" aria-selected={activeTab === tab} data-testid={`workflow-tab-${tab.toLowerCase()}`} data-pyqt-object={tab === 'Prepare' ? 'overview_tab' : tab === 'Detect' ? 'detector_tab' : 'classifier_tab'} className={activeTab === tab ? 'active' : ''} onClick={() => onTabChange(tab)}>{workflowTabLabel(tab)}</button>
            ))}
          </div>
          <div className="workflow-tab-actions">
            <button
              className="subpage-back-button"
              data-testid="pyqt-subpage_back_to_main_button"
              data-pyqt-object="return_to_main_button"
              onClick={onCollapse}
            >
              Close
            </button>
          </div>
        </nav>
      </header>
      <main className="workspace-tab-panel" data-active-tab={activeTab} role="tabpanel">
        {activeTab === 'Prepare' && <PrepareTab metadata={metadata} recordingPath={recordingPath} biomarker={biomarker} prepareControls={prepareControls} recordingAnalysis={recordingAnalysis} runRecords={runRecords} activeRunId={activeRunId} runtimeOperation={runtimeOperation} runtimeLog={runtimeLog} onCancelRuntimeOperation={onCancelRuntimeOperation} onPrepareControlsChange={onPrepareControlsChange} onRecordingAnalysisChange={onRecordingAnalysisChange} onAnalyzeRecordingPlanning={onAnalyzeRecordingPlanning} onApplyFilters={onApplyFilters} onSaveNJobs={onSaveNJobs} />}
        {activeTab === 'Detect' && <DetectTab biomarker={biomarker} hasRecording={Boolean(recordingPath)} capabilityManifest={capabilityManifest} sampleFrequencyHz={numericSampleFrequency(metadata)} nJobs={prepareControls.nJobs} prepareControls={prepareControls} onPrepareControlsChange={onPrepareControlsChange} onBiomarkerChange={onBiomarkerChange} onRunDetection={onRunDetection} />}
        {activeTab === 'Classify' && <ClassifierTab biomarker={biomarker} hasActiveRun={Boolean(activeRunId)} capabilityManifest={capabilityManifest} state={classifierControls} feedback={classifierFeedback} onStateChange={onClassifierControlsChange} onFeedbackChange={onClassifierFeedbackChange} onRunClassifier={onRunClassifier} onOpenModelFile={onOpenModelFile} />}
      </main>
    </section>
  );
}

function workflowTabLabel(tab: WorkspaceTab): string {
  return tab === 'Prepare' ? 'Preprocess' : tab;
}

function numericSampleFrequency(metadata: RecordingMetadata | null): number | undefined {
  const value = Number(metadata?.sample_freq ?? metadata?.sampling_frequency ?? 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

type PrepareTabProps = {
  metadata: RecordingMetadata | null;
  recordingPath: string | null;
  biomarker: BiomarkerType;
  prepareControls: PrepareControlsState;
  recordingAnalysis: RecordingAnalysisState;  runRecords: RunRecord[];
  activeRunId: string | null;
  runtimeOperation: RuntimeOperation;
  runtimeLog: RuntimeLogEntry[];
  onCancelRuntimeOperation: () => void;
  onPrepareControlsChange: (controls: PrepareControlsState) => void;
  onRecordingAnalysisChange: (analysis: RecordingAnalysisState) => void;
  onAnalyzeRecordingPlanning: () => Promise<void> | void;
  onApplyFilters: () => void;
  onSaveNJobs: () => void;
};

function PrepareTab({ metadata, recordingPath, biomarker, prepareControls, recordingAnalysis, runRecords, activeRunId, runtimeOperation, runtimeLog, onCancelRuntimeOperation, onPrepareControlsChange, onRecordingAnalysisChange, onAnalyzeRecordingPlanning, onApplyFilters, onSaveNJobs }: PrepareTabProps) {
  function updatePrepareControls(patch: Partial<PrepareControlsState>) {
    onPrepareControlsChange({ ...prepareControls, ...patch });
  }

  return (
    <div className="tab-content prepare-grid" data-testid="workflow-prepare-content">
      <section className="panel-card case-console" data-testid="workflow-case-console">
        <div className="case-console-workspace" data-testid="pyqt-case_workspace_body">
          <section className="case-console-column configure-column" data-testid="pyqt-configure_column">
            <h4 data-testid="pyqt-configure_title">Preprocess</h4>
            <section className="prepare-section filter-parameter-panel" data-testid="pyqt-filters_groupbox">
              <div className="prepare-section-heading">
                <h3>Filter Parameters</h3>
              </div>
              <div className="prepare-control-cluster">
                <div className="field-grid compact">
                  <label>Fp<input data-testid="pyqt-fp_input" aria-label="Fp" value={prepareControls.fp} onChange={(event) => updatePrepareControls({ fp: event.target.value })} placeholder="80" /></label>
                  <label>Fs<input data-testid="pyqt-fs_input" aria-label="Fs" value={prepareControls.fs} onChange={(event) => updatePrepareControls({ fs: event.target.value })} placeholder="500" /></label>
                  <label>rp<input data-testid="pyqt-rp_input" aria-label="rp" value={prepareControls.rp} onChange={(event) => updatePrepareControls({ rp: event.target.value })} placeholder="0.5" /></label>
                  <label>rs<input data-testid="pyqt-rs_input" aria-label="rs" value={prepareControls.rs} onChange={(event) => updatePrepareControls({ rs: event.target.value })} placeholder="93" /></label>
                </div>
                <div className="prepare-strategy-grid" data-testid="pyqt-prepare_strategy_group">
                  <label>Line notch Hz<input data-testid="pyqt-line_noise_notch_input" aria-label="Line noise notch Hz" value={prepareControls.lineNoiseNotchHz} onChange={(event) => updatePrepareControls({ lineNoiseNotchHz: event.target.value })} placeholder="60" /></label>
                  <label>Resample Hz<input data-testid="pyqt-resample_sfreq_input" aria-label="Resample frequency" value={prepareControls.resampleSfreq} onChange={(event) => updatePrepareControls({ resampleSfreq: event.target.value })} placeholder="optional" /></label>
                </div>
              </div>
              <div className="prepare-filter-action-strip">
                <div className="prepare-toggle-grid" data-testid="pyqt-channel_qc_strategy_group">
                  <label className="prepare-toggle-option"><input data-testid="pyqt-drop_bad_channels_checkbox" type="checkbox" checked={prepareControls.dropBadChannels} onChange={(event) => updatePrepareControls({ dropBadChannels: event.target.checked })} /><span>Drop bad channels</span></label>
                  <label className="prepare-toggle-option"><input data-testid="pyqt-drop_flat_channels_checkbox" type="checkbox" checked={prepareControls.dropFlatChannels} onChange={(event) => updatePrepareControls({ dropFlatChannels: event.target.checked })} /><span>Drop flat channels</span></label>
                  <label className="prepare-toggle-option"><input data-testid="pyqt-mark_outlier_channels_checkbox" type="checkbox" checked={prepareControls.markOutlierChannels} onChange={(event) => updatePrepareControls({ markOutlierChannels: event.target.checked })} /><span>Mark outlier channels</span></label>
                  <label className="prepare-toggle-option"><input data-testid="pyqt-drop_outlier_channels_checkbox" type="checkbox" checked={prepareControls.dropOutlierChannels} onChange={(event) => updatePrepareControls({ dropOutlierChannels: event.target.checked })} /><span>Drop outlier channels</span></label>
                </div>
                <div className="runtime-control-row" data-testid="pyqt-runtime-controls">
                  <button className="prepare-runtime-action" data-testid="pyqt-overview_filter_button" data-pyqt-action="action_filter" onClick={onApplyFilters}>Apply</button>
                </div>
              </div>
            </section>
            <RuntimeLogPanel operation={runtimeOperation} log={runtimeLog} onCancel={onCancelRuntimeOperation} />
          </section>
          <section className="case-console-column review-settings-column" data-testid="pyqt-review_settings_column">
            <h4 data-testid="pyqt-review_settings_title">Analysis & outputs</h4>
            <span className="sr-only">Output readiness for the active run.</span>
            <RecordingPlanningPanel analysis={recordingAnalysis} hasRecording={Boolean(recordingPath)} onAnalyze={onAnalyzeRecordingPlanning} onAnalysisChange={onRecordingAnalysisChange} />
          </section>
        </div>
      </section>
    </div>
  );
}

function RecordingPlanningPanel({ analysis, hasRecording, onAnalyze, onAnalysisChange }: { analysis: RecordingAnalysisState; hasRecording: boolean; onAnalyze: () => Promise<void> | void; onAnalysisChange: (analysis: RecordingAnalysisState) => void }) {
  const roi = analysis.roi || null;
  const qc = analysis.qc || null;
  const spectral = analysis.spectral || null;
  const bandPower = useMemo(() => spectral?.relative_band_power || {}, [spectral]);
  const bandRows = useMemo(() => spectralBandRows(bandPower), [bandPower]);
  const recommendedBand = useMemo(() => spectral?.recommended_hfo_band?.length === 2 ? `${formatNumberShort(spectral.recommended_hfo_band[0])}-${formatNumberShort(spectral.recommended_hfo_band[1])}` : '--', [spectral]);
  const confirmedExclusions = useMemo(() => analysis.confirmed_exclusions || roi?.default_detection_exclusions || [], [analysis.confirmed_exclusions, roi]);
  const channelRows = useMemo(() => recordingChannelReviewRows(roi, qc), [roi, qc]);
  const channelExcludedCount = confirmedExclusions.length;
  const channelKeptCount = useMemo(() => {
    const excluded = new Set(confirmedExclusions);
    return Math.max(0, channelRows.length - channelRows.filter((row) => excluded.has(row.channel)).length);
  }, [channelRows, confirmedExclusions]);
  const analysisSummary = useMemo(() => [
    { label: 'ROI', value: roi?.brain_signal_channel_count ?? '--', unit: 'brain', meta: `${roi?.default_detection_exclusions?.length ?? '--'} excluded`, detail: compactList(roi?.default_detection_exclusions, 'No default exclusions yet'), title: roi?.default_detection_exclusions?.join(', '), testId: 'pyqt-recording_roi_card' },
    { label: 'QC', value: qc?.flat_channels?.length ?? '--', unit: 'flat', meta: `${qc?.outlier_channels?.length ?? '--'} outlier`, detail: compactList([...(qc?.flat_channels || []), ...(qc?.outlier_channels || [])], 'No flat/outlier channels flagged'), title: [...(qc?.flat_channels || []), ...(qc?.outlier_channels || [])].join(', '), testId: 'pyqt-recording_qc_card' }
  ], [qc, roi]);

  function updateConfirmedExclusions(value: string) {
    onAnalysisChange({ ...analysis, confirmed_exclusions: parseChannelList(value), updatedAt: new Date().toISOString() });
  }

  function setChannelExcluded(channel: string, excluded: boolean) {
    const next = new Set(confirmedExclusions);
    if (excluded) next.add(channel);
    else next.delete(channel);
    onAnalysisChange({ ...analysis, confirmed_exclusions: Array.from(next).sort(), updatedAt: new Date().toISOString() });
  }

  function resetConfirmedExclusions() {
    onAnalysisChange({ ...analysis, confirmed_exclusions: roi?.default_detection_exclusions || [], updatedAt: new Date().toISOString() });
  }

  return (
    <section className="prepare-section recording-planning-panel" data-testid="pyqt-recording_planning_panel">
      <div className="panel-heading-row">
        <h3>Recording ROI / QC / Spectral</h3>
        <button data-testid="pyqt-recording_analysis_button" disabled={!hasRecording || analysis.status === 'running'} onClick={onAnalyze}>{analysis.status === 'running' ? 'Analyzing…' : 'Analyze'}</button>
      </div>
      <div className="recording-analysis-grid">
        {analysisSummary.map((item) => (
          <article className="recording-analysis-stat-card" data-testid={item.testId} key={item.testId}>
            <h4>{item.label}</h4>
            <p><strong>{item.value}</strong> {item.unit}</p>
            <span>{item.meta}</span>
            <p className="mini-list" title={item.title}>{item.detail}</p>
          </article>
        ))}
        <article className="recording-analysis-spectral-card" data-testid="pyqt-recording_spectral_card">
          <div className="spectral-card-heading">
            <h4>Spectral</h4>
            <p>Nyq <strong>{formatNumberShort(spectral?.nyquist_hz)}</strong> · HFO <strong>{recommendedBand}</strong></p>
          </div>
          <SpectralCurvePlot spectral={spectral} />
          <div className="spectral-band-bars" data-testid="pyqt-recording_spectral_band_bars" aria-label="Relative band power">
            {bandRows.map((row) => (
              <div className="spectral-band-row" key={row.label} data-testid="pyqt-recording_spectral_band_row">
                <span>{row.label}</span>
                <div className="spectral-band-track"><i style={{ width: `${row.percent}%` }} /></div>
                <strong>{formatPercent(row.value)}</strong>
              </div>
            ))}
            {!Object.keys(bandPower).length && <p className="mini-list">Run analysis for relative band power.</p>}
          </div>
          <div className="spectral-line-noise-list" data-testid="pyqt-recording_spectral_line_noise_list">
            <span className="ln-caption">Line noise</span>
            {(spectral?.line_noise_candidates || []).slice(0, 4).map((item) => (
              <span key={`${item.frequency_hz}-${item.local_power_ratio}`}>{formatHz(item.frequency_hz)} · {formatNumber(item.local_power_ratio)}x</span>
            ))}
            {!spectral?.line_noise_candidates?.length && <span className="ln-empty">none flagged</span>}
          </div>
        </article>
      </div>
      <label className="roi-exclusion-editor" data-testid="pyqt-recording_roi_exclusions_editor">
        Confirmed ROI/QC Exclusions
        <textarea data-testid="pyqt-recording_roi_exclusions_input" rows={2} value={confirmedExclusions.join(', ')} placeholder="comma-separated channels excluded from detection" onChange={(event) => updateConfirmedExclusions(event.target.value)} />
      </label>
      <div className="channel-review-summary" data-testid="pyqt-recording_channel_review_summary" data-has-exclusions={channelExcludedCount ? 'true' : 'false'}>
        <strong>Detection</strong>
        <span className="channel-review-counts"><b>{channelKeptCount}</b> kept · <b>{channelExcludedCount}</b> excluded</span>
        {channelExcludedCount > 0 && <em title={confirmedExclusions.join(', ')}>{confirmedExclusions.join(', ')}</em>}
      </div>
      <div className="roi-channel-review" data-testid="pyqt-recording_roi_channel_review">
        <table className="data-table compact" data-testid="pyqt-recording_roi_channel_table">
          <thead><tr><th>Exclude</th><th>Channel</th><th>ROI/QC reason</th><th>RMS</th><th>Flat</th><th>Z</th></tr></thead>
          <tbody>
            {channelRows.map((row) => {
              const isExcluded = confirmedExclusions.includes(row.channel);
              return (
              <tr key={row.channel} data-role={row.role} data-excluded={isExcluded ? 'true' : 'false'}>
                <td><input data-testid="pyqt-recording_roi_channel_checkbox" type="checkbox" checked={isExcluded} onChange={(event) => setChannelExcluded(row.channel, event.target.checked)} aria-label={`Exclude ${row.channel}`} /></td>
                <td>{row.channel}{isExcluded && <span className="channel-excluded-tag">Excluded</span>}</td>
                <td title={row.reason}>{row.reason}</td>
                <td>{formatNumber(row.rms)}</td>
                <td>{formatPercent(row.flatFraction)}</td>
                <td>{formatNumber(row.logRmsModifiedZ)}</td>
              </tr>
              );
            })}
            {!channelRows.length && <tr><td colSpan={6}>Run analysis to review ROI/QC channel inclusion.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="button-row">
        <button data-testid="pyqt-recording_roi_exclusions_reset" disabled={!roi?.default_detection_exclusions?.length} onClick={resetConfirmedExclusions}>Reset to ROI</button>
        <span className="status-pill" data-testid="pyqt-recording_roi_exclusions_count">{confirmedExclusions.length} detection exclusion(s)</span>
      </div>
      {analysis.error && <p className="error-panel" data-testid="pyqt-recording_analysis_error">{analysis.error}</p>}
    </section>
  );
}

function SpectralCurvePlot({ spectral }: { spectral: RecordingAnalysisState['spectral'] }) {
  const points = useMemo(() => spectralCurvePolyline(spectral?.psd_curve || []), [spectral]);
  const hfoBand = spectral?.recommended_hfo_band || null;
  const nyquist = Number(spectral?.nyquist_hz || 0);
  const hfoStart = hfoBand?.length === 2 && nyquist > 0 ? Math.max(0, Math.min(100, (Number(hfoBand[0]) / nyquist) * 100)) : 0;
  const hfoEnd = hfoBand?.length === 2 && nyquist > 0 ? Math.max(0, Math.min(100, (Number(hfoBand[1]) / nyquist) * 100)) : 0;
  return (
    <div className="spectral-curve-plot" data-testid="pyqt-recording_spectral_psd_plot" aria-label="Compact PSD curve">
      <svg viewBox="0 0 100 44" preserveAspectRatio="none" role="img">
        {hfoEnd > hfoStart && <rect data-testid="pyqt-recording_spectral_hfo_band" x={hfoStart} y={2} width={Math.max(1, hfoEnd - hfoStart)} height={38} />}
        <polyline data-testid="pyqt-recording_spectral_psd_curve" points={points} />
      </svg>
    </div>
  );
}

function RuntimeLogPanel({ operation, log, onCancel }: { operation: RuntimeOperation; log: RuntimeLogEntry[]; onCancel: () => void }) {
  const latest = useMemo(() => [...log].slice(-8).reverse(), [log]);
  return (
    <section className="prepare-section runtime-log-panel" data-testid="pyqt-status_log_group">
      <div className="runtime-log-heading">
        <div>
          <h3>Runtime / Progress</h3>
          <p className="helper-copy">Operational messages, warnings, and task progress appear here in chronological order.</p>
        </div>
        <button data-testid="pyqt-runtime_cancel_button" disabled={operation.status !== 'running' || !operation.cancellable} onClick={onCancel}>Cancel Task</button>
      </div>
      <div className="runtime-current" data-testid="pyqt-run_runtime_host">
        <span className={`status-pill runtime-${operation.status}`}>{operation.status}</span>
        <strong data-testid="pyqt-runtime_operation_label">{operation.label}</strong>
        <progress data-testid="pyqt-runtime_progress_bar" max={100} value={operation.indeterminate ? undefined : operation.progress} />
        <span data-testid="pyqt-runtime_progress_value">{operation.indeterminate ? '—' : `${Math.round(operation.progress)}%`}</span>
      </div>
      <ol className="runtime-log-list" data-testid="pyqt-status_log_text">
        {latest.map((entry) => <li key={entry.id} className={`runtime-log-${entry.level}`}><time>{entry.timestamp.slice(11, 19)}</time><span>{entry.message}</span></li>)}
      </ol>
    </section>
  );
}







function rowsFromRecord(record: Record<string, unknown>, keyPattern?: RegExp): Array<[string, string]> {
  return Object.entries(record)
    .filter(([key, value]) => (keyPattern ? keyPattern.test(key) : true) && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, formatSummaryValue(value)] as [string, string])
    .filter(([, value]) => value !== '--');
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function formatSummaryValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatSummaryValue).join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '--';
  const text = String(value ?? '').trim();
  return text || '--';
}

function humanizeParameterKey(key: string): string {
  return key.replace(/^artifact_/, '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactList(values: string[] | undefined, emptyText: string, limit = 4): string {
  const clean = (values || []).filter(Boolean);
  if (!clean.length) return emptyText;
  return clean.length <= limit ? clean.join(', ') : `${clean.slice(0, limit).join(', ')} +${clean.length - limit} more`;
}

type RecordingChannelReviewRow = { channel: string; role: 'brain' | 'excluded' | 'uncertain' | 'qc'; reason: string; rms?: number; flatFraction?: number; logRmsModifiedZ?: number | null };

function recordingChannelReviewRows(roi: RecordingAnalysisState['roi'], qc: RecordingAnalysisState['qc']): RecordingChannelReviewRow[] {
  const rows = new Map<string, RecordingChannelReviewRow>();
  for (const channel of roi?.brain_signal_channels || []) {
    rows.set(channel, { channel, role: 'brain', reason: 'brain-signal ROI channel' });
  }
  for (const item of roi?.excluded_non_brain_channels || []) {
    const channel = String(item.channel || '').trim();
    if (channel) rows.set(channel, { channel, role: 'excluded', reason: item.reason || 'non-brain channel' });
  }
  for (const item of roi?.uncertain_channels || []) {
    const channel = String(item.channel || '').trim();
    if (channel) rows.set(channel, { channel, role: 'uncertain', reason: item.reason || 'uncertain channel; review before detection' });
  }
  for (const metric of qc?.per_channel || []) {
    const channel = String(metric.channel || '').trim();
    if (!channel) continue;
    const existing = rows.get(channel);
    rows.set(channel, {
      channel,
      role: existing?.role || 'qc',
      reason: existing?.reason || qcReasonForChannel(channel, qc),
      rms: metric.rms,
      flatFraction: metric.flat_fraction,
      logRmsModifiedZ: metric.log_rms_modified_z
    });
  }
  return Array.from(rows.values()).sort((a, b) => roleSort(a.role) - roleSort(b.role) || a.channel.localeCompare(b.channel));
}

function qcReasonForChannel(channel: string, qc: RecordingAnalysisState['qc']): string {
  const reasons = [];
  if (qc?.flat_channels?.includes(channel)) reasons.push('flat channel');
  if (qc?.outlier_channels?.includes(channel)) reasons.push('QC outlier');
  return reasons.join(', ') || 'QC reviewed channel';
}

function roleSort(role: RecordingChannelReviewRow['role']): number {
  return role === 'excluded' ? 0 : role === 'uncertain' ? 1 : role === 'qc' ? 2 : 3;
}

function parseChannelList(value: string): string[] {
  return Array.from(new Set(value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)));
}

function spectralBandRows(bandPower: Record<string, number>): Array<{ label: string; value: number; percent: number }> {
  const order = ['delta', 'theta', 'alpha', 'beta', 'gamma', 'ripple'];
  return order
    .filter((label) => label in bandPower)
    .map((label) => {
      const value = Math.max(0, Math.min(1, Number(bandPower[label]) || 0));
      return { label, value, percent: Math.max(2, Math.min(100, value * 100)) };
    });
}

function spectralCurvePolyline(points: Array<{ frequency_hz?: number; relative_power?: number }>): string {
  if (!points.length) return '0,42 100,42';
  const maxFrequency = Math.max(...points.map((point) => Number(point.frequency_hz || 0)), 1);
  return points.map((point) => {
    const x = Math.max(0, Math.min(100, (Number(point.frequency_hz || 0) / maxFrequency) * 100));
    const y = 40 - Math.max(0, Math.min(1, Number(point.relative_power || 0))) * 34;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

function formatHz(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? `${parsed.toFixed(1)} Hz` : '--';
}

function formatNumber(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(1) : '--';
}

function formatNumberShort(value: unknown): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '--';
  return Number.isInteger(parsed) ? String(parsed) : parsed.toFixed(1);
}

function formatPercent(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${(parsed * 100).toFixed(1)}%` : '--';
}

function analysisWindowLabel(window: { start_seconds?: number; stop_seconds?: number; samples_analyzed?: number; bounded?: boolean } | undefined): string {
  if (!window) return '--';
  return `${formatNumber(window.start_seconds)}-${formatNumber(window.stop_seconds)}s · ${Number(window.samples_analyzed || 0)} samples${window.bounded ? ' · bounded' : ''}`;
}
