import type { BiomarkerType, RecordingMetadata, WaveformControlsState } from '../../app/workspaceState';
import { biomarkerOptions, waveformChannelUniverse } from '../../app/workspaceState';

const PYQT_BIOMARKER_LEGEND_COLORS = {
  hfo: '#6b8a5f',
  artifact: '#8a6b4f',
  spike: '#7f6592',
  ehfo: '#5b8b84',
  accepted: '#4f7499'
} as const;

const legendByBiomarker: Record<BiomarkerType, Array<{ color: string; label: string }>> = {
  HFO: [
    { color: PYQT_BIOMARKER_LEGEND_COLORS.hfo, label: 'HFO' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.artifact, label: 'Artifact' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.spike, label: 'spkHFO' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.ehfo, label: 'eHFO' }
  ],
  Spindle: [
    { color: PYQT_BIOMARKER_LEGEND_COLORS.artifact, label: 'Artifact' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.spike, label: 'spk-Spindle' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.hfo, label: 'Spindle' }
  ],
  Spike: [
    { color: PYQT_BIOMARKER_LEGEND_COLORS.artifact, label: 'Artifact' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.spike, label: 'Spike candidate' },
    { color: PYQT_BIOMARKER_LEGEND_COLORS.accepted, label: 'Accepted' }
  ]
};

export function BiomarkerBar({ biomarker, onChange, hasRecording, waveformControls }: { biomarker: BiomarkerType; onChange: (value: BiomarkerType) => void; hasRecording: boolean; waveformControls: WaveformControlsState }) {
  return (
    <section className="biomarker-bar" data-testid="pyqt-biomarker_selection_widget">
      <label htmlFor="biomarker-select" data-testid="pyqt-biomarker_label">Biomarker Type:</label>
      <select id="biomarker-select" data-testid="pyqt-combo_box_biomarker" value={biomarker} onChange={(event) => onChange(event.target.value as BiomarkerType)}>
        {biomarkerOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <BiomarkerLegend biomarker={biomarker} testId="pyqt-legend_host_frame" />
      <WaveformModeBadges hasRecording={hasRecording} waveformControls={waveformControls} testId="pyqt-waveform_mode_frame" sourceTestId="pyqt-waveform_source_mode_badge" scopeTestId="pyqt-waveform_scope_mode_badge" toolTestId="pyqt-waveform_tool_mode_badge" />
    </section>
  );
}

// PyQt keeps combo_box_biomarker available at all times. When a recording is loaded the
// top biomarker-bar collapses in favor of the waveform header, so surface the same selector
// here too — otherwise the biomarker can only be changed from the Detect tab.
export function BiomarkerHeaderSelect({ biomarker, onChange }: { biomarker: BiomarkerType; onChange: (value: BiomarkerType) => void }) {
  return (
    <label className="waveform-header-biomarker" data-testid="pyqt-waveform_header_biomarker">
      <span>Biomarker</span>
      <select data-testid="pyqt-waveform_header_biomarker_select" value={biomarker} onChange={(event) => onChange(event.target.value as BiomarkerType)}>
        {biomarkerOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

export function WaveformHeaderModeBadges({ hasRecording, waveformControls, metadata }: { hasRecording: boolean; waveformControls: WaveformControlsState; metadata: RecordingMetadata | null }) {
  return <WaveformModeBadges hasRecording={hasRecording} waveformControls={waveformControls} metadata={metadata} className="waveform-header-mode-badges" />;
}

function BiomarkerLegend({ biomarker, testId, className = 'legend-host' }: { biomarker: BiomarkerType; testId?: string; className?: string }) {
  return (
    <div className={className} data-testid={testId} aria-label={`${biomarker} color legend`}>
      {legendByBiomarker[biomarker].map((entry) => (
        <span className="legend-chip" key={entry.label}><span style={{ background: entry.color }} />{entry.label}</span>
      ))}
    </div>
  );
}

function WaveformModeBadges({ hasRecording, waveformControls, metadata = null, testId, sourceTestId, scopeTestId, toolTestId, className = 'waveform-mode-badges', showSource = true }: { hasRecording: boolean; waveformControls: WaveformControlsState; metadata?: RecordingMetadata | null; testId?: string; sourceTestId?: string; scopeTestId?: string; toolTestId?: string; className?: string; showSource?: boolean }) {
  const sourceBadge = waveformSourceBadgePayload(hasRecording, waveformControls);
  const scopeBadge = waveformScopeBadgePayload(hasRecording, waveformControls, metadata);
  const toolBadge = waveformToolBadgePayload(hasRecording, waveformControls);
  const badges = [
    ...(showSource ? [{ ...sourceBadge, testId: sourceTestId }] : []),
    { ...scopeBadge, testId: scopeTestId },
    { ...toolBadge, testId: toolTestId }
  ].filter((badge) => badge.active);
  if (!badges.length) return null;
  return (
    <div className={className} data-testid={testId} aria-label="Waveform source scope and tool status">
      {badges.map((badge) => (
        <span key={badge.testId || badge.text} data-testid={badge.testId} title={badge.tooltip} data-active="true">{badge.text}</span>
      ))}
    </div>
  );
}

type WaveformModeBadgePayload = { text: string; tooltip: string; active: boolean };

function waveformSourceBadgePayload(hasRecording: boolean, controls: WaveformControlsState): WaveformModeBadgePayload {
  if (!hasRecording) return { text: '', tooltip: 'Load an EEG file to inspect waveform source modes.', active: false };
  // Wording tracks the Montage control exactly (Ref / Avg / Bipolar / Auto: Bipolar) so the pill
  // and the menu never disagree about what is on screen.
  if (controls.montageMode === 'auto' || controls.montageMode === 'bipolar') return { text: controls.montageMode === 'auto' ? 'Auto: Bipolar' : 'Bipolar', tooltip: 'Reviewing derived bipolar channels. Choose Ref in the Montage menu, or Reset View, to return.', active: true };
  if (controls.montageMode === 'averageReference') return { text: 'Avg', tooltip: 'Reviewing average-reference derived channels. Choose Ref in the Montage menu, or Reset View, to return.', active: true };
  if (controls.showFiltered || controls.filter60Hz || controls.normalizeVertically) {
    const activeTransforms = [
      controls.showFiltered ? 'Filtered' : '',
      controls.filter60Hz ? '60 Hz notch' : '',
      controls.normalizeVertically ? 'Normalized' : ''
    ].filter(Boolean);
    return {
      text: activeTransforms.length === 1 ? activeTransforms[0] : `${activeTransforms.length} signal modes`,
      tooltip: `Reviewing referential source channels with ${activeTransforms.join(', ')}.`,
      active: true
    };
  }
  return { text: '', tooltip: 'Default referential source channels.', active: false };
}

function waveformScopeBadgePayload(hasRecording: boolean, controls: WaveformControlsState, metadata: RecordingMetadata | null = null): WaveformModeBadgePayload {
  if (!hasRecording) return { text: '', tooltip: 'Load an EEG file to inspect waveform channel scopes.', active: false };
  const customCount = controls.channelsToPlot.length;
  const selectedChannel = abbreviateChannelName(controls.annotationChannel) || 'selected';
  if (controls.channelFocusMode === 'neighbors') {
    return { text: `Scope Neighbors ${selectedChannel}`, tooltip: `Showing the highlighted channel and adjacent neighbors around ${controls.annotationChannel || 'the current selection'}. Click Neighbors again, All, or Reset View to return.`, active: true };
  }
  if (controls.channelFocusMode === 'clean') {
    return { text: 'Scope Clean', tooltip: 'Showing only clean source channels. Click Clean again, All, or Reset View to return.', active: true };
  }
  if (controls.channelFocusMode === 'events') {
    return { text: customCount ? `Events (${customCount})` : 'Events', tooltip: `Showing channels with detected events in the active run. Click Events again, All, or Reset View to return.`, active: true };
  }
  if (controls.channelFocusMode === 'highlight' && controls.annotationChannel) {
    return { text: `Scope Highlight ${selectedChannel}`, tooltip: `Highlighting ${controls.annotationChannel} while keeping the current channel list intact. Click Highlight again or Reset View to clear it.`, active: true };
  }
  // A montage sets channelsToPlot to everything it derives -- 18 pairs for a scalp bipolar montage --
  // which is the DEFAULT view for that montage, not a hand-picked subset. Reporting it as
  // "Scope Custom (18)" alongside the Bipolar pill said two different things about one state.
  if (customCount) {
    const universe = waveformChannelUniverse(metadata, controls);
    const isWholeMontage = universe.length === customCount
      && controls.channelsToPlot.every((channel) => universe.includes(channel));
    if (!isWholeMontage) return { text: `Scope Custom (${customCount})`, tooltip: 'Showing a custom channel subset. Use All or Reset View to return to the default source list.', active: true };
  }
  return { text: '', tooltip: 'Default full channel list.', active: false };
}

function waveformToolBadgePayload(hasRecording: boolean, controls: WaveformControlsState): WaveformModeBadgePayload {
  if (!hasRecording) return { text: '', tooltip: 'Load an EEG file to inspect waveform tools.', active: false };
  if (controls.measureEnabled) return { text: 'Tool Measure', tooltip: 'Measure mode is active. Click Measure again, press Esc, or use Reset View to exit.', active: true };
  if (controls.cursorEnabled) return { text: 'Tool Cursor', tooltip: 'Cursor mode is active. Click Cursor again, press Esc, or use Reset View to exit.', active: true };
  return { text: '', tooltip: 'No sticky inspect tool is active.', active: false };
}

function abbreviateChannelName(channelName: string, maxLength = 18): string {
  const value = channelName.trim();
  return value.length > maxLength ? `${value.slice(0, Math.max(1, maxLength - 1))}...` : value;
}
