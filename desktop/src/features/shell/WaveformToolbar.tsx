import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { MontageMode, RecordingMetadata, WaveformControlsState } from '../../app/workspaceState';
import { montageModeLabel, numericChannelCount, recordingDurationSeconds, resolveMontageMode } from '../../app/workspaceState';
import type { WaveformMeasurementStatus } from '../waveform/WaveformCanvas';

type WaveformToolbarProps = {
  controls: WaveformControlsState;
  metadata: RecordingMetadata | null;
  measurementStatus: WaveformMeasurementStatus;
  onControlsChange: (controls: WaveformControlsState) => void;
  onUpdatePlot: (controls: WaveformControlsState) => void;
  onOpenChannelSelection: () => void;
  onOpenBipolarSelection: () => void;
  onOpenReview: () => void;
  onOverlapReview: () => void;
  onExportSnapshot: () => void;
  onNavigateEvent: (direction: 'prev' | 'current' | 'next' | 'pending') => void;
  onHotspotChannels: () => void;
  eventPositionLabel: string;
  hasEventNavigation: boolean;
};

type ToolbarPopoverId = 'view' | 'channels' | 'montage' | 'focus' | 'output' | null;
type ToolbarIconName = 'goToTime' | 'zoomOut' | 'zoomIn' | 'previous' | 'center' | 'next' | 'pending' | 'review' | 'snapshot' | 'refresh';

const MONTAGE_TITLES: Record<'referential' | 'averageReference' | 'bipolar', string> = {
  referential: 'Referential',
  averageReference: 'Average reference',
  bipolar: 'Bipolar',
};

export function WaveformToolbar({ controls, metadata, measurementStatus, onControlsChange, onUpdatePlot, onOpenChannelSelection, onOpenBipolarSelection, onOpenReview, onOverlapReview, onExportSnapshot, onNavigateEvent, onHotspotChannels, eventPositionLabel, hasEventNavigation }: WaveformToolbarProps) {
  const [draftControls, setDraftControls] = useState(controls);
  const [activePopover, setActivePopover] = useState<ToolbarPopoverId>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const firstViewInputRef = useRef<HTMLInputElement>(null);
  const totalChannels = numericChannelCount(metadata);
  const maxVisibleChannels = Math.max(1, Math.min(32, totalChannels || 32));
  const maxStartSeconds = Math.max(0, recordingDurationSeconds(metadata) - draftControls.timeWindowSeconds);
  const timeWindowLabel = formatPyQtSecondsInput(draftControls.timeWindowSeconds);
  const startSecondsLabel = formatPyQtSecondsInput(draftControls.startSeconds);
  const amplitudeScaleLabel = formatPyQtMultiplierInput(draftControls.amplitudeScale);
  const viewSettingsTitle = `Waveform view settings: window ${timeWindowLabel} seconds, step ${draftControls.timeIncrementPercent} percent, amplitude ${amplitudeScaleLabel}x, go to ${startSecondsLabel} seconds`;
  const viewSettingsOpen = activePopover === 'view';
  const channelSettingsOpen = activePopover === 'channels';
  const montageSettingsOpen = activePopover === 'montage';
  const focusSettingsOpen = activePopover === 'focus';
  const outputSettingsOpen = activePopover === 'output';
  const visibleChannelsLabel = draftControls.visibleChannels >= maxVisibleChannels ? 'All' : String(draftControls.visibleChannels);
  const montageLabel = montageModeLabel(draftControls.montageMode, metadata);
  const montageTitle = MONTAGE_TITLES[resolveMontageMode(draftControls.montageMode, metadata)];
  const focusLabel = draftControls.channelFocusMode === 'highlight' ? 'Mark' : draftControls.channelFocusMode === 'neighbors' ? 'Near' : draftControls.channelFocusMode === 'clean' ? 'Clean' : draftControls.channelFocusMode === 'events' ? 'Event' : 'All';
  const focusTitle = draftControls.channelFocusMode === 'highlight' ? 'Highlighted annotation channel' : draftControls.channelFocusMode === 'neighbors' ? 'Neighboring channels' : draftControls.channelFocusMode === 'clean' ? 'Clean-view subset' : draftControls.channelFocusMode === 'events' ? 'Event channels' : 'All channels';
  const eventFocusActive = hasEventNavigation && draftControls.channelFocusMode === 'events';

  useEffect(() => {
    setDraftControls(controls);
  }, [controls]);

  useEffect(() => {
    if (!activePopover) return;

    function closeToolbarPopoverFromOutside(event: PointerEvent) {
      if (!(event.target instanceof Node) || !toolbarRef.current || toolbarRef.current.contains(event.target)) return;
      setActivePopover(null);
    }

    function closeToolbarPopoverFromEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setActivePopover(null);
    }

    window.addEventListener('pointerdown', closeToolbarPopoverFromOutside);
    window.addEventListener('keydown', closeToolbarPopoverFromEscape);
    if (activePopover === 'view') window.setTimeout(() => firstViewInputRef.current?.select(), 0);
    return () => {
      window.removeEventListener('pointerdown', closeToolbarPopoverFromOutside);
      window.removeEventListener('keydown', closeToolbarPopoverFromEscape);
    };
  }, [activePopover]);

  // Anchor the open popover under the button that opened it. CSS alone cannot do this: the
  // toolbar reflows by width, so a static offset drifts off its trigger, and the popovers used to
  // pin to the toolbar's own right edge -- which is why every one of them appeared at the top-right
  // of the waveform regardless of which control was clicked. Measuring the trigger and placing the
  // panel with position:fixed sidesteps the containing-block question entirely, then the panel is
  // clamped back inside the viewport so a right-hand trigger cannot push it off-screen.
  useLayoutEffect(() => {
    if (!activePopover) return;
    const toolbar = toolbarRef.current;
    if (!toolbar) return;

    function place() {
      const panel = toolbar?.querySelector<HTMLElement>('.clinical-selector-popover, .waveform-view-settings-popover');
      const trigger = panel?.closest('.clinical-selector')?.querySelector<HTMLElement>('button');
      if (!panel || !trigger) return;
      const anchor = trigger.getBoundingClientRect();
      const gap = 4;
      const margin = 8;
      const width = panel.offsetWidth;
      const left = Math.max(margin, Math.min(anchor.left, window.innerWidth - margin - width));
      panel.style.setProperty('--popover-anchor-top', `${Math.round(anchor.bottom + gap)}px`);
      panel.style.setProperty('--popover-anchor-left', `${Math.round(left)}px`);
      panel.style.setProperty('--popover-anchor-max-height', `${Math.round(window.innerHeight - anchor.bottom - gap - margin)}px`);
      panel.dataset.anchored = 'true';
    }

    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [activePopover]);

  function applyPatch(patch: Partial<WaveformControlsState>) {
    const next = { ...draftControls, ...patch };
    setDraftControls(next);
    onControlsChange(next);
  }

  function applyPatchAndRefresh(patch: Partial<WaveformControlsState>) {
    const next = { ...draftControls, ...patch };
    setDraftControls(next);
    onControlsChange(next);
    onUpdatePlot(next);
  }

  function refreshDraftControls() {
    onControlsChange(draftControls);
    onUpdatePlot(draftControls);
  }

  function applyViewSettings() {
    refreshDraftControls();
    setActivePopover(null);
  }

  function submitDraftOnEnter(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' && event.key !== 'Return') return;
    event.preventDefault();
    refreshDraftControls();
  }

  function setVisibleChannels(count: number | 'all') {
    applyPatchAndRefresh({
      visibleChannels: count === 'all' ? maxVisibleChannels : Math.min(maxVisibleChannels, count),
      channelStartIndex: 0
    });
    setActivePopover(null);
  }

  // Every montage is a plain selection now. The old toggle turned a second click on Avg/Auto into
  // 'referential', so those two behaved unlike Ref and could silently leave the chosen montage.
  function selectMontage(mode: MontageMode) {
    applyPatchAndRefresh({ montageMode: mode, channelStartIndex: 0 });
    setActivePopover(null);
  }

  function setFocusMode(mode: WaveformControlsState['channelFocusMode']) {
    applyPatch({ channelFocusMode: mode, channelStartIndex: 0 });
    setActivePopover(null);
  }

  // Neighbors/Clean change the visible channel SUBSET, so they must re-fetch the waveform window
  // (parity with PyQt neighbor_channels_button / clean_view_button which call set_channels_to_plot
  // and refresh the plot). Toggling an already-active focus mode returns to 'all', mirroring PyQt
  // toggle_neighbor_channel_focus / toggle_clean_view falling back to show_all_channels.
  function toggleSubsetFocusMode(mode: WaveformControlsState['channelFocusMode']) {
    const nextMode = draftControls.channelFocusMode === mode ? 'all' : mode;
    applyPatchAndRefresh({ channelFocusMode: nextMode, channelStartIndex: 0 });
    setActivePopover(null);
  }

  return (
    <section className="waveform-toolbar waveform-toolbar-clinical-console" data-testid="pyqt-waveform-toolbar" aria-label="PyQt waveform toolbar" ref={toolbarRef}>
      <div className="waveform-toolbar-row" data-testid="pyqt-waveform-source-row">
        <ToolbarGroup ariaLabel="Signal source tools" label="Signal" className="waveform-tool-group-source waveform-tool-group-state">
          <button data-testid="pyqt-raw_tool_button" data-icon="⌁" data-pyqt-toolbutton-style="text-beside-icon" title="Show unfiltered signal" className={!draftControls.showFiltered ? 'active' : ''} onClick={() => applyPatchAndRefresh({ showFiltered: false })}>Raw</button>
          <button data-testid="pyqt-filtered_tool_button" data-pyqt-source="toggle_filtered_checkbox" data-icon="∿" data-pyqt-toolbutton-style="text-beside-icon" aria-label="Toggle Filtered" title="Show filtered signal" className={draftControls.showFiltered ? 'active' : ''} onClick={() => applyPatchAndRefresh({ showFiltered: true })}>Filt</button>
          <button data-testid="pyqt-filter60_tool_button" data-pyqt-source="Filter60Button" data-icon="⌁" data-pyqt-toolbutton-style="text-beside-icon" aria-label="Filter 60 Hz" title="Toggle 60 Hz notch" className={draftControls.filter60Hz ? 'active' : ''} onClick={() => applyPatchAndRefresh({ filter60Hz: !draftControls.filter60Hz })}>60 Hz</button>
          <button data-testid="pyqt-normalize_tool_button" data-pyqt-source="normalize_vertical_input" data-icon="▦" data-pyqt-toolbutton-style="text-beside-icon" aria-label="Normalize Vertically" title="Normalize vertical scale" className={draftControls.normalizeVertically ? 'active' : ''} onClick={() => applyPatchAndRefresh({ normalizeVertically: !draftControls.normalizeVertically })}>Norm</button>
        </ToolbarGroup>
        <ToolbarGroup ariaLabel="Waveform window controls" label="View" className="waveform-tool-group-fields waveform-tool-group-window">
          <div className="waveform-view-settings clinical-selector" data-testid="pyqt-waveform_view_settings">
            <button type="button" className="waveform-view-summary clinical-selector-trigger" data-testid="pyqt-waveform_view_summary_button" title={viewSettingsTitle} aria-label={viewSettingsTitle} aria-expanded={viewSettingsOpen} aria-controls="waveform-view-settings-popover" onClick={() => setActivePopover(viewSettingsOpen ? null : 'view')}>
              <span className="waveform-view-summary-label">View</span>
              <span className="waveform-view-token" title="Display time window"><span className="waveform-view-value">{timeWindowLabel}s</span></span>
              <span className="waveform-view-token" title="Display time step as a percent of the window"><span className="waveform-view-value">{draftControls.timeIncrementPercent}%</span></span>
              <span className="waveform-view-token" title="Waveform amplitude scale"><span className="waveform-view-value">{amplitudeScaleLabel}x</span></span>
              <span className="waveform-view-token" title="Go to recording time"><span className="waveform-view-value">{startSecondsLabel}s</span></span>
            </button>
            {viewSettingsOpen && (
              <div className="waveform-view-settings-popover" id="waveform-view-settings-popover" role="dialog" aria-label="Edit waveform view settings" data-testid="pyqt-waveform_view_settings_popover">
                <div className="waveform-view-settings-grid">
                  <label className="toolbar-field" title="Display time window"><span className="toolbar-field-label">Win</span><span className="toolbar-value-with-unit spaced-unit"><input ref={firstViewInputRef} data-testid="pyqt-display_time_window_input" aria-label="Display Time Window" type="number" min={0.25} max={60} step={0.25} value={timeWindowLabel} onKeyDown={submitDraftOnEnter} onChange={(event) => applyPatch({ timeWindowSeconds: Number(event.target.value) })} /><span>s</span></span></label>
                  <label className="toolbar-field" title="Display time step as a percent of the window"><span className="toolbar-field-label">Step</span><span className="toolbar-value-with-unit tight-unit"><input data-testid="pyqt-Time_Increment_Input" aria-label="Display Time Window Increment" type="number" min={1} max={100} value={draftControls.timeIncrementPercent} onKeyDown={submitDraftOnEnter} onChange={(event) => applyPatch({ timeIncrementPercent: Number(event.target.value) })} /><span>%</span></span></label>
                  <label className="toolbar-field" title="Waveform amplitude scale"><span className="toolbar-field-label">Amp</span><span className="toolbar-value-with-unit tight-unit"><input data-testid="pyqt-waveform_amplitude_input" aria-label="Waveform amplitude scale" type="number" min={0.25} max={10} step={0.25} value={amplitudeScaleLabel} onKeyDown={submitDraftOnEnter} onChange={(event) => applyPatch({ amplitudeScale: Number(event.target.value) })} /><span>x</span></span></label>
                  <label className="toolbar-field" title="Go to recording time"><span className="toolbar-field-label">Go</span><span className="toolbar-value-with-unit spaced-unit"><input data-testid="pyqt-go_to_time_input" aria-label="Go to recording time" type="number" min={0} max={maxStartSeconds} step={0.1} value={startSecondsLabel} onKeyDown={submitDraftOnEnter} onChange={(event) => applyPatch({ startSeconds: Number(event.target.value) })} /><span>s</span></span></label>
                </div>
                <button type="button" className="waveform-view-settings-apply" data-testid="pyqt-waveform_view_settings_apply_button" title="Apply waveform view settings" onClick={applyViewSettings}>Apply</button>
              </div>
            )}
          </div>
        </ToolbarGroup>
        <ToolbarGroup ariaLabel="Waveform scope controls" label="Scope" className="waveform-tool-group-scope">
          <div className="clinical-selector">
            <button type="button" className="clinical-selector-trigger" data-testid="pyqt-channel_scope_summary_button" title="Set visible channel count" aria-label={`Visible channels: ${visibleChannelsLabel}`} aria-expanded={channelSettingsOpen} aria-controls="waveform-channel-settings-popover" onClick={() => setActivePopover(channelSettingsOpen ? null : 'channels')}>
              <span>Channels</span><span className="clinical-selector-value">{visibleChannelsLabel}</span>
            </button>
            {channelSettingsOpen && (
              <div className="clinical-selector-popover clinical-selector-popover-channel" id="waveform-channel-settings-popover" role="dialog" aria-label="Edit visible channel count">
                <div className="clinical-popover-row">
                  {[8, 16, 32].map((count) => <button key={count} data-testid={`pyqt-channel_preset_${count}`} title={`Show ${count} channels`} onClick={() => setVisibleChannels(count)}>{count}</button>)}
                  <button data-testid="pyqt-channel_preset_max" title="Show all channels" onClick={() => setVisibleChannels('all')}>All</button>
                  <label className="toolbar-field clinical-inline-field" title="Number of channels to display"><span className="toolbar-field-label">N</span><input data-testid="pyqt-n_channel_input" aria-label="Number of Channels to Display" type="number" min={1} max={maxVisibleChannels} value={draftControls.visibleChannels} onKeyDown={submitDraftOnEnter} onChange={(event) => applyPatch({ visibleChannels: Number(event.target.value) })} /></label>
                </div>
              </div>
            )}
          </div>
          <div className="clinical-selector">
            <button type="button" className="clinical-selector-trigger" data-testid="pyqt-montage_summary_button" title="Set waveform montage" aria-label={`Montage: ${montageTitle}`} aria-expanded={montageSettingsOpen} aria-controls="waveform-montage-settings-popover" onClick={() => setActivePopover(montageSettingsOpen ? null : 'montage')}>
              <span>Montage</span><span className="clinical-selector-value">{montageLabel}</span>
            </button>
            {montageSettingsOpen && (
              <div className="clinical-selector-popover clinical-selector-popover-montage" id="waveform-montage-settings-popover" role="dialog" aria-label="Edit montage mode">
                <div className="clinical-popover-row">
                  <button data-testid="pyqt-referential_tool_button" data-icon="♆" data-pyqt-toolbutton-style="text-beside-icon" title="Use referential montage" className={draftControls.montageMode === 'referential' ? 'active' : ''} onClick={() => { selectMontage('referential'); setActivePopover(null); }}>Ref</button>
                  <button data-testid="pyqt-average_reference_button" data-icon="♨" data-pyqt-toolbutton-style="text-beside-icon" title="Use average reference" className={draftControls.montageMode === 'averageReference' ? 'active' : ''} onClick={() => { selectMontage('averageReference'); setActivePopover(null); }}>Avg</button>
                  <button data-testid="pyqt-bipolar_montage_button" data-icon="⨯" data-pyqt-toolbutton-style="text-beside-icon" title="Use the configured bipolar montage" className={draftControls.montageMode === 'bipolar' ? 'active' : ''} onClick={() => { selectMontage('bipolar'); setActivePopover(null); }}>Bipolar</button>
                  <button data-testid="pyqt-auto_bipolar_button" data-icon="⌁" data-pyqt-toolbutton-style="text-beside-icon" title={`Pick the montage automatically (currently ${montageTitle})`} className={draftControls.montageMode === 'auto' ? 'active' : ''} onClick={() => { selectMontage('auto'); setActivePopover(null); }}>{montageModeLabel('auto', metadata)}</button>
                </div>
              </div>
            )}
          </div>
          <div className="clinical-selector">
            <button type="button" className="clinical-selector-trigger" data-testid="pyqt-focus_summary_button" title="Set channel focus mode" aria-label={`Channel focus: ${focusTitle}`} aria-expanded={focusSettingsOpen} aria-controls="waveform-focus-settings-popover" onClick={() => setActivePopover(focusSettingsOpen ? null : 'focus')}>
              <span>Focus</span><span className="clinical-selector-value">{focusLabel}</span>
            </button>
            {focusSettingsOpen && (
              <div className="clinical-selector-popover clinical-selector-popover-focus" id="waveform-focus-settings-popover" role="dialog" aria-label="Edit channel focus mode">
                <div className="clinical-popover-row">
                  <button data-testid="pyqt-highlight_channel_button" data-icon="⊙" data-pyqt-toolbutton-style="text-beside-icon" title="Highlight annotation channel" className={draftControls.channelFocusMode === 'highlight' ? 'active' : ''} onClick={() => setFocusMode('highlight')}>Mark</button>
                  <button data-testid="pyqt-neighbor_channels_button" data-icon="☷" data-pyqt-toolbutton-style="text-beside-icon" title="Show neighboring channels" className={draftControls.channelFocusMode === 'neighbors' ? 'active' : ''} onClick={() => toggleSubsetFocusMode('neighbors')}>Near</button>
                  <button data-testid="pyqt-clean_view_button" data-icon="⌞" data-pyqt-toolbutton-style="text-beside-icon" title="Show clean-view subset" className={draftControls.channelFocusMode === 'clean' ? 'active' : ''} onClick={() => toggleSubsetFocusMode('clean')}>Clean</button>
                  <button data-testid="pyqt-all_channels_button" data-icon="▦" data-pyqt-toolbutton-style="text-beside-icon" title="Show all channels" className={draftControls.channelFocusMode === 'all' ? 'active' : ''} onClick={() => { applyPatchAndRefresh({ channelFocusMode: 'all', channelStartIndex: 0 }); setActivePopover(null); }}>All</button>
                </div>
              </div>
            )}
          </div>
        </ToolbarGroup>
      </div>

      <div className="waveform-toolbar-row" data-testid="pyqt-waveform-channel-row">
        <ToolbarGroup ariaLabel="Event navigation tools" label="Evt" className="waveform-tool-group-icons waveform-tool-group-events waveform-tool-group-review-primary">
          <ToolbarIconButton testId="pyqt-prev_event_button" icon="previous" aria-label="Prev" title="Previous event" disabled={!hasEventNavigation} onClick={() => onNavigateEvent('prev')} />
          <ToolbarIconButton testId="pyqt-center_event_button" icon="center" aria-label="Center" title="Center active event" disabled={!hasEventNavigation} onClick={() => onNavigateEvent('current')} />
          <ToolbarIconButton testId="pyqt-next_event_button" icon="next" aria-label="Next" title="Next event" disabled={!hasEventNavigation} onClick={() => onNavigateEvent('next')} />
          <ToolbarIconButton testId="pyqt-pending_event_button" icon="pending" aria-label="Pending" title="Next pending event" disabled={!hasEventNavigation} onClick={() => onNavigateEvent('pending')} />
          <span className="waveform-badge" data-testid="pyqt-event_position_label" data-has-events={hasEventNavigation ? 'true' : 'false'}>{eventPositionLabel}</span>
        </ToolbarGroup>
        <ToolbarGroup ariaLabel="Waveform navigation tools" label="Nav" className="waveform-tool-group-icons waveform-tool-group-nav waveform-tool-group-review-primary">
          <ToolbarIconButton testId="pyqt-zoom_out_button" icon="zoomOut" aria-label="Zoom out" title="Zoom out" onClick={() => applyPatchAndRefresh({ timeWindowSeconds: Math.min(60, draftControls.timeWindowSeconds * 1.25) })} />
          <ToolbarIconButton testId="pyqt-zoom_in_button" icon="zoomIn" aria-label="Zoom in" title="Zoom in" onClick={() => applyPatchAndRefresh({ timeWindowSeconds: Math.max(0.25, draftControls.timeWindowSeconds * 0.8) })} />
          <ToolbarIconButton testId="pyqt-go_to_time_button" icon="goToTime" aria-label="Go to time" title="Go to time" onClick={refreshDraftControls} />
        </ToolbarGroup>
        <ToolbarGroup ariaLabel="Event review tools" label="Insp" className="waveform-tool-group-inspect">
          <button data-testid="pyqt-event_channels_button" data-icon="⌁" data-pyqt-toolbutton-style="text-beside-icon" title="Focus event channels" disabled={!hasEventNavigation} className={eventFocusActive ? 'active' : ''} onClick={() => setFocusMode('events')}>Event</button>
          <button data-testid="pyqt-cursor_tool_button" data-icon="＋" data-pyqt-toolbutton-style="text-beside-icon" title="Toggle cursor inspection" className={draftControls.cursorEnabled ? 'active' : ''} onClick={() => applyPatch({ cursorEnabled: !draftControls.cursorEnabled, measureEnabled: false })}>Cursor</button>
          <button data-testid="pyqt-measure_tool_button" data-icon="⇔" data-pyqt-toolbutton-style="text-beside-icon" title="Toggle measurement mode" className={draftControls.measureEnabled ? 'active' : ''} onClick={() => applyPatch({ measureEnabled: !draftControls.measureEnabled, cursorEnabled: false })}>Measure</button>
          <span className="waveform-badge" data-testid="pyqt-measurement_status_badge" title={measurementStatus.tooltip}>{draftControls.measureEnabled ? (measurementStatus.text || 'Click A') : draftControls.cursorEnabled ? 'Cursor on' : 'Inspect'}</span>
        </ToolbarGroup>
        <ToolbarGroup ariaLabel="Review output tools" label="Out" className="waveform-tool-group-output">
          <ToolbarIconButton testId="pyqt-open_review_button" icon="review" aria-label="Review" title="Open review" onClick={onOpenReview} />
          <div className="clinical-selector waveform-output-more">
            <button type="button" className="clinical-output-more-trigger" data-testid="pyqt-output_more_button" title="More review output tools" aria-label="More review output tools" aria-expanded={outputSettingsOpen} aria-controls="waveform-output-settings-popover" onClick={() => setActivePopover(outputSettingsOpen ? null : 'output')}>More</button>
            {outputSettingsOpen && (
              <div className="clinical-selector-popover clinical-selector-popover-output" id="waveform-output-settings-popover" role="dialog" aria-label="More review output tools">
                <div className="clinical-popover-row">
                  <button data-testid="pyqt-hotspot_tool_button" data-icon="☆" data-pyqt-toolbutton-style="text-beside-icon" title="Focus hotspot channels" disabled={!hasEventNavigation} onClick={onHotspotChannels}>Hotspot</button>
                  <button data-testid="pyqt-overlap_review_button" data-icon="⊙" data-pyqt-toolbutton-style="text-beside-icon" title="Open overlap review" disabled={!hasEventNavigation} onClick={onOverlapReview}>Overlap</button>
                  <ToolbarIconButton testId="pyqt-snapshot_button" icon="snapshot" aria-label="Snapshot" title="Export waveform snapshot" data-export-format="png" onClick={onExportSnapshot} />
                  <ToolbarIconButton testId="pyqt-waveform_plot_button" icon="refresh" aria-label="Refresh waveform plot" title="Refresh waveform plot" onClick={refreshDraftControls} />
                </div>
              </div>
            )}
          </div>
        </ToolbarGroup>
        <ToolbarGroup ariaLabel="Channel selection tools" label="Edit" className="waveform-tool-group-channel waveform-tool-group-edit waveform-tool-group-setup-secondary">
          <button data-testid="pyqt-Choose_Channels_Button" data-icon="☰" data-pyqt-toolbutton-style="text-beside-icon" title="Choose visible channels" onClick={onOpenChannelSelection}>Channels</button>
          <button data-testid="pyqt-bipolar_button" data-icon="⨯" data-pyqt-toolbutton-style="text-beside-icon" title="Edit bipolar montage" onClick={onOpenBipolarSelection}>Montage</button>
        </ToolbarGroup>
      </div>
      <div className="waveform-toolbar-row waveform-toolbar-contract-row" data-testid="pyqt-waveform-event-row" aria-hidden="true" />
    </section>
  );
}

function ToolbarGroup({ ariaLabel, label, className = '', children }: { ariaLabel: string; label: string; className?: string; children: ReactNode }) {
  return (
    <div className={`waveform-tool-group ${className}`.trim()} role="group" aria-label={ariaLabel}>
      <span className="waveform-tool-group-label">{label}</span>
      {children}
    </div>
  );
}

function ToolbarIconButton({ testId, icon, title, disabled = false, 'aria-label': ariaLabel, 'data-export-format': exportFormat, onClick }: { testId: string; icon: ToolbarIconName; title: string; disabled?: boolean; 'aria-label': string; 'data-export-format'?: 'png'; onClick: () => void }) {
  return (
    <button data-testid={testId} data-pyqt-toolbutton-style="icon-only" aria-label={ariaLabel} title={title} data-export-format={exportFormat} disabled={disabled} onClick={onClick}>
      <ToolbarSvgIcon name={icon} />
      <span className="sr-only">{ariaLabel}</span>
    </button>
  );
}

function ToolbarSvgIcon({ name }: { name: ToolbarIconName }) {
  return (
    <svg className="waveform-toolbar-svg-icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      {renderToolbarIconPath(name)}
    </svg>
  );
}

function renderToolbarIconPath(name: ToolbarIconName) {
  switch (name) {
    case 'goToTime':
      return <><path d="M4 12h12" /><path d="m12 7 5 5-5 5" /><path d="M20 5v14" /></>;
    case 'zoomOut':
      return <><circle cx="10.5" cy="10.5" r="5.5" /><path d="M7.5 10.5h6" /><path d="m15 15 5 5" /></>;
    case 'zoomIn':
      return <><circle cx="10.5" cy="10.5" r="5.5" /><path d="M7.5 10.5h6" /><path d="M10.5 7.5v6" /><path d="m15 15 5 5" /></>;
    case 'previous':
      return <><path d="M19 12H6" /><path d="m11 7-5 5 5 5" /></>;
    case 'center':
      return <><circle cx="12" cy="12" r="5" /><path d="M12 3v4" /><path d="M12 17v4" /><path d="M3 12h4" /><path d="M17 12h4" /></>;
    case 'next':
      return <><path d="M5 12h13" /><path d="m13 7 5 5-5 5" /></>;
    case 'pending':
      return <><circle cx="12" cy="12" r="7" /><path d="M12 8v4l3 2" /><path d="M5 5l2.5 2.5" /></>;
    case 'review':
      return <><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M8 9h8" /><path d="M8 13h8" /><path d="M8 17h5" /></>;
    case 'snapshot':
      return <><rect x="4" y="6" width="16" height="12" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="m7 16 4-4 3 3 2-2 2 3" /></>;
    case 'refresh':
      return <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M18.2 10A6.5 6.5 0 0 0 7 6.5L4 9" /><path d="M5.8 14A6.5 6.5 0 0 0 17 17.5l3-2.5" /></>;
  }
}

function formatPyQtSecondsInput(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}

function formatPyQtMultiplierInput(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "1.00";
}
