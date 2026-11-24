import { useMemo, useState } from 'react';
import type { RecordingMetadata, WaveformControlsState } from '../../app/workspaceState';
import { displayChannelName, activeWaveformChannels, waveformChannelUniverse } from '../../app/workspaceState';

type ChannelSelectionDialogProps = {
  metadata: RecordingMetadata | null;
  controls: WaveformControlsState;
  channelAmplitudes?: Record<string, number>;
  onApply: (controls: WaveformControlsState) => void;
  onClose: () => void;
};

export function ChannelSelectionDialog({ metadata, controls, channelAmplitudes = {}, onApply, onClose }: ChannelSelectionDialogProps) {
  const channels = useMemo(() => waveformChannelUniverse(metadata, controls), [metadata, controls]);
  const activeChannels = useMemo(() => activeWaveformChannels(metadata, controls), [metadata, controls]);
  const initialSelection = useMemo(() => new Set(activeChannels), [activeChannels]);
  const initialAnnotationChannel = controls.annotationChannel && channels.includes(controls.annotationChannel) ? controls.annotationChannel : activeChannels[0] || channels[0] || '';
  const initialCompareChannels = controls.compareToChannels?.filter((channel) => channels.includes(channel) && channel !== initialAnnotationChannel) || activeChannels.filter((channel) => channel !== initialAnnotationChannel);
  const [selected, setSelected] = useState<Set<string>>(initialSelection);
  const [annotationChannel, setAnnotationChannel] = useState(initialAnnotationChannel);
  const [compareChannels, setCompareChannels] = useState<Set<string>>(new Set(initialCompareChannels));
  const selectedCount = selected.size;

  function toggleChannel(channel: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) next.add(channel);
    else next.delete(channel);
    setSelected(next);
  }

  function chooseAnnotationChannel(channel: string) {
    setAnnotationChannel(channel);
    setSelected((current) => new Set([...current, channel]));
    setCompareChannels((current) => {
      const next = new Set(current);
      next.delete(channel);
      return next;
    });
  }

  function toggleCompareChannel(channel: string, checked: boolean) {
    const next = new Set(compareChannels);
    if (checked) next.add(channel);
    else next.delete(channel);
    setCompareChannels(next);
    if (checked) setSelected((current) => new Set([...current, channel]));
  }

  function applySelection() {
    const compareToChannels = channels.filter((channel) => compareChannels.has(channel) && channel !== annotationChannel);
    const focusedChannels = uniqueChannels([annotationChannel, ...compareToChannels]);
    const selectedChannels = channels.filter((channel) => selected.has(channel));
    const channelsToPlot = uniqueChannels([...focusedChannels, ...selectedChannels]);
    onApply({
      ...controls,
      channelsToPlot,
      annotationChannel,
      compareToChannels,
      channelStartIndex: 0,
      channelFocusMode: annotationChannel ? 'highlight' : controls.channelFocusMode,
      visibleChannels: Math.max(1, Math.min(Math.max(controls.visibleChannels, focusedChannels.length || 1), channelsToPlot.length || 1))
    });
  }

  return (
    <div className="modal-backdrop" role="presentation" data-testid="pyqt-channel_selection_window">
      <section className="modal-card channel-dialog" role="dialog" aria-modal="true" aria-labelledby="channel-selection-title">
        <button className="modal-window-close-button" data-testid="pyqt-channel_selection_close_button" onClick={onClose}>Close</button>
        <h2 id="channel-selection-title">Choose visible channels</h2>
        <p className="helper-copy">Select waveform channels, the primary annotation channel, and optional comparison channels.</p>
        {!channels.length ? (
          <div className="error-panel" data-testid="pyqt-channel_selection_no_data">No EEG data available. Please load data first.</div>
        ) : (
          <>
            <div className="channel-select-actions" data-testid="pyqt-channel_select_actions">
              <span className="channel-select-actions-count">{selectedCount}/{channels.length} selected</span>
              <button type="button" data-testid="pyqt-channel_select_all" onClick={() => setSelected(new Set(channels))}>Select All</button>
              <button type="button" data-testid="pyqt-channel_select_none" onClick={() => setSelected(new Set(annotationChannel ? [annotationChannel] : []))}>Select None</button>
            </div>
            <div className="channel-dialog-scroll" data-testid="pyqt-channel_selection_scroll_area" data-pyqt-object="Channels_Group_box">
              {channels.map((channel, index) => (
                <label key={channel} className="channel-choice">
                  <input data-testid={`pyqt-channel_${index}`} type="checkbox" checked={selected.has(channel)} onChange={(event) => toggleChannel(channel, event.target.checked)} />
                  <span className="channel-choice-name">{displayChannelName(channel)}</span>
                  <output className="channel-choice-amp" data-testid={`pyqt-channel_amplitude_${index}`}>{formatChannelAmplitude(channelAmplitudes[channel])}</output>
                </label>
              ))}
            </div>
            <section className="selected-channels-dialog" data-testid="pyqt-selected_channels_window" aria-label="Select Channels">
              <h3>Select Channels</h3>
              <div className="selected-channels-grid" data-testid="pyqt-selected_channels_gridLayout">
                <label className="selected-channel-list" data-testid="pyqt-selected_channels_listWidget">Channel to Annotate
                  <select size={Math.min(10, Math.max(3, channels.length))} value={annotationChannel} onChange={(event) => chooseAnnotationChannel(event.target.value)}>
                    {channels.map((channel) => <option key={channel} value={channel}>{displayChannelName(channel)}</option>)}
                  </select>
                </label>
                <div className="selected-channel-spacer" data-testid="pyqt-selected_channels_horizontalSpacer" aria-hidden="true" />
                <fieldset className="selected-channel-list" data-testid="pyqt-selected_channels_listWidget_2">
                  <legend>Compare To</legend>
                  <div className="compare-channel-scroll">
                    {channels.map((channel) => (
                      <label key={channel} className="channel-choice">
                        <input data-testid={`pyqt-compare_channel_${channel}`} type="checkbox" disabled={channel === annotationChannel} checked={compareChannels.has(channel)} onChange={(event) => toggleCompareChannel(channel, event.target.checked)} />
                        <span>{displayChannelName(channel)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              </div>
              <p className="helper-copy" data-testid="pyqt-selected_channels_summary">Annotate {annotationChannel || '--'} · Compare {compareChannels.size} channel(s)</p>
            </section>
          </>
        )}
        <div className="modal-actions">
          <button data-testid="pyqt-channel_selection_cancel_button" onClick={onClose}>Cancel</button>
          <button data-testid="pyqt-channel_selection_ok_button" className="primary-action" disabled={!selectedCount || !annotationChannel} onClick={applySelection}>OK</button>
        </div>
      </section>
    </div>
  );
}

function uniqueChannels(channels: string[]): string[] {
  return Array.from(new Set(channels.filter(Boolean)));
}

function formatChannelAmplitude(value?: number): string {
  return Number.isFinite(value) ? `${Number(value).toFixed(2)} µV p-p` : 'unavailable';
}
