import { useMemo, useState } from 'react';
import type { DerivedBipolarChannel, RecordingMetadata, WaveformControlsState } from '../../app/workspaceState';
import { displayChannelName, channelNames, conventionalBipolarDerivedChannels, montageBipolarChannels, waveformChannelUniverse } from '../../app/workspaceState';

type BipolarChannelDialogProps = {
  metadata: RecordingMetadata | null;
  controls: WaveformControlsState;
  onCreate: (controls: WaveformControlsState) => void;
  // Applies a change WITHOUT closing. The montage is edited in place here -- there is no OK button
  // to commit against, so every edit takes effect immediately and the dialog stays open.
  onUpdate?: (controls: WaveformControlsState) => void;
  onClose: () => void;
};

type PairRow = { channel1: string; channel2: string };

const BIPOLAR_TOKEN = '#-#';

export function BipolarChannelDialog({ metadata, controls, onCreate, onUpdate, onClose }: BipolarChannelDialogProps) {
  const sourceChannels = useMemo(() => channelNames(metadata).filter((channel) => !channel.includes(BIPOLAR_TOKEN)), [metadata]);
  // Non-empty only for conventional 10-20 scalp recordings, so this doubles as the scalp test.
  const conventionalPairs = useMemo(() => conventionalBipolarDerivedChannels(metadata), [metadata]);

  // The montage IS the list. Seeded from what is actually on screen -- the configured pairs when
  // there are any, otherwise the derivation Auto produced -- so opening the editor shows the
  // montage you are reviewing instead of an empty form.
  const [rows, setRows] = useState<PairRow[]>(() =>
    montageBipolarChannels(metadata, controls).map((pair) => ({ channel1: pair.channel1, channel2: pair.channel2 })));

  function toDerived(list: PairRow[]): DerivedBipolarChannel[] {
    const seen = new Set<string>();
    const derived: DerivedBipolarChannel[] = [];
    for (const row of list) {
      // A half-filled or self-referential row is legal to sit in the UI while it is being edited;
      // it just contributes no channel until it names two different electrodes.
      if (!row.channel1 || !row.channel2 || row.channel1 === row.channel2) continue;
      const name = `${row.channel1}${BIPOLAR_TOKEN}${row.channel2}`;
      if (seen.has(name)) continue;
      seen.add(name);
      derived.push({ name, channel1: row.channel1, channel2: row.channel2 });
    }
    return derived;
  }

  function commit(list: PairRow[]) {
    setRows(list);
    const derivedBipolarChannels = toDerived(list);
    const nextControls = { ...controls, derivedBipolarChannels, montageMode: 'bipolar' as const };
    (onUpdate ?? onCreate)({ ...nextControls, channelsToPlot: waveformChannelUniverse(metadata, nextControls), channelStartIndex: 0 });
  }

  function setRow(index: number, patch: Partial<PairRow>) {
    commit(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  function removeRow(index: number) {
    commit(rows.filter((_, position) => position !== index));
  }

  function addRow() {
    commit([...rows, { channel1: sourceChannels[0] || '', channel2: sourceChannels[1] || sourceChannels[0] || '' }]);
  }

  function applyConventionalMontage() {
    if (!conventionalPairs.length) return;
    commit(conventionalPairs.map((pair) => ({ channel1: pair.channel1, channel2: pair.channel2 })));
  }

  const activeCount = toDerived(rows).length;
  const status = sourceChannels.length < 2
    ? 'At least two source channels are required to create a bipolar pair.'
    : `${activeCount} bipolar channel(s) in this montage. New channel = Channel 1 - Channel 2.`;

  return (
    <div className="modal-backdrop" role="presentation" data-testid="pyqt-bipolar_channel_selection_window">
      <section className="modal-card bipolar-dialog" role="dialog" aria-modal="true" aria-labelledby="bipolar-selection-title">
        <button className="modal-window-close-button" data-testid="pyqt-bipolar_close_button" onClick={onClose}>Close</button>
        <h2 id="bipolar-selection-title">Create bipolar channel</h2>
        <p className="helper-copy">Each row is a derived channel: Channel 1 minus Channel 2. Edits apply immediately.</p>
        <div className="bipolar-form-card" data-testid="pyqt-bipolar_current_montage_card">
          <div className="bipolar-pair-heading" aria-hidden="true">
            <span>Channel 1</span>
            <span>Channel 2</span>
            <span />
          </div>
          <ul className="bipolar-pair-list" data-testid="pyqt-bipolar_pair_list">
            {rows.map((row, index) => (
              <li key={`row-${index}`} data-testid="pyqt-bipolar_pair_row">
                <select
                  aria-label={`Channel 1 for pair ${index + 1}`}
                  data-testid={index === 0 ? 'pyqt-ch_1_dropdown' : `pyqt-ch_1_dropdown_${index}`}
                  value={row.channel1}
                  onChange={(event) => setRow(index, { channel1: event.target.value })}
                >
                  {sourceChannels.map((channel) => <option key={channel} value={channel}>{displayChannelName(channel)}</option>)}
                </select>
                <select
                  aria-label={`Channel 2 for pair ${index + 1}`}
                  data-testid={index === 0 ? 'pyqt-ch_2_dropdown' : `pyqt-ch_2_dropdown_${index}`}
                  value={row.channel2}
                  onChange={(event) => setRow(index, { channel2: event.target.value })}
                >
                  {sourceChannels.map((channel) => <option key={channel} value={channel}>{displayChannelName(channel)}</option>)}
                </select>
                <button
                  className="bipolar-pair-remove"
                  data-testid={`pyqt-bipolar_remove_${index}`}
                  title={`Remove ${displayChannelName(row.channel1)} - ${displayChannelName(row.channel2)}`}
                  onClick={() => removeRow(index)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <div className="bipolar-pair-add-row">
            <button
              className="bipolar-pair-add"
              data-testid="pyqt-bipolar_add_pair_button"
              title="Add a bipolar pair"
              aria-label="Add a bipolar pair"
              disabled={sourceChannels.length < 2}
              onClick={addRow}
            >
              +
            </button>
          </div>
          <p className="helper-copy" data-testid="pyqt-bipolar_selection_status_label">{status}</p>
        </div>
        {conventionalPairs.length > 0 && (
          <div className="bipolar-form-card" data-testid="pyqt-bipolar_conventional_card">
            <p className="helper-copy">Scalp EEG detected: the conventional 10-20 bipolar montage ({conventionalPairs.length} pairs) can be applied in one step.</p>
            <button data-testid="pyqt-bipolar_conventional_button" onClick={applyConventionalMontage}>Use scalp 10-20 montage</button>
          </div>
        )}
      </section>
    </div>
  );
}
