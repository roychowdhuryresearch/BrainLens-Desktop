import type { RecordingMetadata } from '../../app/workspaceState';
import { displayChannelName, channelCount, channelNames, recordingFileName, recordingLengthLabel, sampleFrequencyLabel } from '../../app/workspaceState';

export function RecordingInfoDialog({
  metadata,
  recordingPath,
  onClose,
}: {
  metadata: RecordingMetadata | null;
  recordingPath: string | null;
  onClose: () => void;
}) {
  const channels = channelNames(metadata);
  const rawRows = recordingMetadataRows(metadata, recordingPath);
  return (
    <div className="modal-backdrop recording-info-backdrop" data-testid="pyqt-recording_info_backdrop">
      <section className="modal-card recording-info-dialog" role="dialog" aria-modal="false" data-testid="pyqt-recording_info_dialog" aria-label="Recording Information">
        <header className="recording-info-header">
          <div>
            <h2>Recording Information</h2>

          </div>
          <button className="modal-window-close-button" data-testid="pyqt-recording_info_close_button" onClick={onClose}>Close</button>
        </header>
        <section className="panel-card" data-testid="pyqt-recording_info_summary_card">
          <h3>File Summary</h3>
          <dl className="recording-info-grid">
            <dt>File Name:</dt><dd data-testid="pyqt-recording_info_filename">{recordingFileName(recordingPath, metadata)}</dd>
            <dt>Input Path:</dt><dd data-testid="pyqt-recording_info_input_path">{metadata?.input_path || recordingPath || '--'}</dd>
            <dt>Sampling Frequency:</dt><dd data-testid="pyqt-recording_info_sample_frequency">{sampleFrequencyLabel(metadata)}</dd>
            <dt>Number of Channels:</dt><dd data-testid="pyqt-recording_info_channel_count">{channelCount(metadata)}</dd>
            <dt>Length:</dt><dd data-testid="pyqt-recording_info_length">{recordingLengthLabel(metadata)}</dd>
          </dl>
        </section>
        <section className="panel-card recording-info-channel-card" data-testid="pyqt-recording_info_channel_card">
          <h3>Channels</h3>
          <div className="recording-info-channel-list" data-testid="pyqt-recording_info_channel_list">
            {channels.map((channel, index) => <span key={`${channel}-${index}`} data-testid="pyqt-recording_info_channel_row">{index + 1}. {displayChannelName(channel)}</span>)}
            {!channels.length && <span>No channel names available.</span>}
          </div>
        </section>
        <section className="panel-card recording-info-raw-card" data-testid="pyqt-recording_info_raw_metadata">
          <h3>Raw Metadata</h3>
          <table className="data-table compact-summary-table">
            <thead><tr><th>Field</th><th>Value</th></tr></thead>
            <tbody>
              {rawRows.map(([key, value]) => <tr key={key} data-testid="pyqt-recording_info_metadata_row"><td>{key}</td><td title={value}>{value}</td></tr>)}
              {!rawRows.length && <tr><td colSpan={2}>No metadata has been loaded.</td></tr>}
            </tbody>
          </table>
        </section>
      </section>
    </div>
  );
}

function recordingMetadataRows(metadata: RecordingMetadata | null, recordingPath: string | null): Array<[string, string]> {
  // The "Channels" section above already lists every channel name in full, and the backend emits
  // an identical `recording_channel_names` copy alongside `channel_names`. Drop both keys here so
  // the raw table doesn't repeat the same long montage two more times.
  const CHANNEL_NAME_KEYS = new Set(['channel_names', 'recording_channel_names']);
  // The File Summary card above already surfaces these (with units); drop them so the raw table
  // shows only the fields the summary doesn't, instead of restating filename/path/Hz/length/count.
  const SUMMARY_KEYS = new Set([
    'filename', 'file_name', 'input_path',
    'sample_freq', 'sampling_frequency', 'sample_frequency_hz',
    'duration_seconds', 'length_seconds', 'length',
    'n_channels', 'channel_count', 'num_channels'
  ]);
  const rows = Object.entries({ input_path: recordingPath || metadata?.input_path || '', ...(metadata || {}) })
    .filter(([key, value]) => !CHANNEL_NAME_KEYS.has(key) && !SUMMARY_KEYS.has(key) && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, formatMetadataValue(value)] as [string, string]);
  return rows.sort(([left], [right]) => left.localeCompare(right));
}

function formatMetadataValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}
