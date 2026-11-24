import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export type WaveformShortcutSpec = {
  id: string;
  label: string;
  default: string;
};

export type WaveformShortcutSettings = {
  enabled: boolean;
  trackpadSensitivity: 'gentle' | 'default' | 'fast';
  bindings: Record<string, string>;
};

export const WAVEFORM_SHORTCUT_SPECS: WaveformShortcutSpec[] = [
  { id: 'window_2s', label: 'Set window to 2 s', default: '1' },
  { id: 'window_5s', label: 'Set window to 5 s', default: '2' },
  { id: 'window_10s', label: 'Set window to 10 s', default: '3' },
  { id: 'window_20s', label: 'Set window to 20 s', default: '4' },
  { id: 'visible_8', label: 'Show 8 channels', default: 'Shift+1' },
  { id: 'visible_16', label: 'Show 16 channels', default: 'Shift+2' },
  { id: 'visible_32', label: 'Show 32 channels', default: 'Shift+3' },
  { id: 'visible_all', label: 'Show full current channel subset', default: 'Shift+4' },
  { id: 'zoom_out', label: 'Zoom out', default: '[' },
  { id: 'zoom_in', label: 'Zoom in', default: ']' },
  { id: 'toggle_filtered', label: 'Toggle raw / filtered', default: 'F' },
  { id: 'toggle_event_scope', label: 'Toggle event channels / all channels', default: 'E' },
  { id: 'toggle_cursor', label: 'Toggle cursor', default: 'C' },
  { id: 'toggle_measure', label: 'Toggle measure', default: 'R' },
  { id: 'toggle_auto_bipolar', label: 'Toggle auto bipolar view', default: 'A' },
  { id: 'show_referential', label: 'Show referential channels', default: 'V' },
  { id: 'toggle_average_reference', label: 'Toggle average reference view', default: 'M' },
  { id: 'focus_highlighted_channel', label: 'Highlight selected channel', default: 'G' },
  { id: 'focus_neighbors', label: 'Focus highlighted channel and neighbors', default: 'T' },
  { id: 'toggle_clean_view', label: 'Toggle clean view', default: 'D' },
  { id: 'open_montage', label: 'Open montage / bipolar tool', default: 'B' },
  { id: 'hotspot', label: 'Highlight hotspot channels', default: 'H' },
  { id: 'center_event', label: 'Center current event', default: 'Space' },
  { id: 'next_pending', label: 'Jump to next unreviewed event', default: 'N' },
  { id: 'clear_inspect', label: 'Clear inspect mode', default: 'Esc' }
];

export const DEFAULT_WAVEFORM_SHORTCUT_SETTINGS: WaveformShortcutSettings = {
  enabled: true,
  trackpadSensitivity: 'default',
  bindings: Object.fromEntries(WAVEFORM_SHORTCUT_SPECS.map((spec) => [spec.id, spec.default]))
};

export function WaveformShortcutSettingsDialog({ settings, onSave, onClose }: { settings: WaveformShortcutSettings; onSave: (settings: WaveformShortcutSettings) => void; onClose: () => void }) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [trackpadSensitivity, setTrackpadSensitivity] = useState<WaveformShortcutSettings['trackpadSensitivity']>(settings.trackpadSensitivity);
  const [bindings, setBindings] = useState<Record<string, string>>({ ...settings.bindings });
  const validationError = useMemo(() => validateWaveformShortcutBindings(enabled, bindings), [enabled, bindings]);

  function resetDefaults() {
    setEnabled(true);
    setTrackpadSensitivity('default');
    setBindings({ ...DEFAULT_WAVEFORM_SHORTCUT_SETTINGS.bindings });
  }

  function save() {
    if (validationError) return;
    onSave({ enabled, trackpadSensitivity, bindings: normalizedBindings(bindings) });
    onClose();
  }

  function captureShortcut(event: ReactKeyboardEvent<HTMLInputElement>, shortcutId: string) {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      setBindings((current) => ({ ...current, [shortcutId]: '' }));
      return;
    }
    if (['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)) return;
    setBindings((current) => ({ ...current, [shortcutId]: eventToShortcutText(event.nativeEvent) }));
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card waveform-shortcuts-dialog" data-testid="pyqt-waveform_shortcuts_window">
        <button className="modal-window-close-button" data-testid="pyqt-waveform_shortcuts_close_button" onClick={onClose}>Close</button>
        <h2>Waveform Shortcuts</h2>
        <label className="select-toggle"><input data-testid="pyqt-waveform_shortcuts_enabled_checkbox" type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable waveform shortcuts</label>
        <section className="panel-card shortcut-trackpad-card" data-testid="pyqt-waveform_shortcuts_trackpad_group">
          <h3>Trackpad</h3>
          <label>Sensitivity
            <select data-testid="pyqt-waveform_trackpad_sensitivity_combo" value={trackpadSensitivity} onChange={(event) => setTrackpadSensitivity(event.target.value as WaveformShortcutSettings['trackpadSensitivity'])}>
              <option value="gentle">Gentle</option>
              <option value="default">Default</option>
              <option value="fast">Fast</option>
            </select>
          </label>
        </section>
        <div className="shortcut-scroll" data-testid="pyqt-waveform_shortcuts_scroll_area">
          <div className="shortcut-grid shortcut-grid-header"><strong>Action</strong><strong>Shortcut</strong><strong>Default</strong><span /></div>
          {WAVEFORM_SHORTCUT_SPECS.map((spec) => (
            <div className="shortcut-grid" key={spec.id}>
              <span>{spec.label}</span>
              <input data-testid={`pyqt-waveform_shortcut_${spec.id}`} aria-label={`${spec.label} shortcut`} value={bindings[spec.id] ?? ''} onKeyDown={(event) => captureShortcut(event, spec.id)} onChange={(event) => setBindings((current) => ({ ...current, [spec.id]: normalizeShortcutText(event.target.value) }))} onFocus={(event) => event.currentTarget.select()} />
              <span className="helper-copy">{spec.default || 'Disabled'}</span>
              <button data-testid={`pyqt-waveform_shortcut_${spec.id}_clear`} onClick={() => setBindings((current) => ({ ...current, [spec.id]: '' }))}>Clear</button>
            </div>
          ))}
        </div>
        {validationError && <p className="error-panel" data-testid="pyqt-waveform_shortcuts_error">{validationError}</p>}
        <div className="modal-actions shortcut-actions">
          <button data-testid="pyqt-waveform_shortcuts_reset_button" onClick={resetDefaults}>Reset Defaults</button>
          <button data-testid="pyqt-waveform_shortcuts_cancel_button" onClick={onClose}>Cancel</button>
          <button data-testid="pyqt-waveform_shortcuts_save_button" className="primary-action" disabled={Boolean(validationError)} onClick={save}>Save</button>
        </div>
      </section>
    </div>
  );
}

export function normalizedBindings(bindings: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(bindings).map(([shortcutId, value]) => [shortcutId, normalizeShortcutText(value)]));
}

export function normalizeShortcutText(value: string): string {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.split('+').map((part) => {
    const item = part.trim();
    if (/^esc$/i.test(item) || /^escape$/i.test(item)) return 'Esc';
    if (/^space$/i.test(item) || item === ' ') return 'Space';
    if (/^shift$/i.test(item)) return 'Shift';
    return item.length === 1 ? item.toUpperCase() : item;
  }).join('+');
}

export function eventToShortcutText(event: KeyboardEvent): string {
  const key = event.key === ' ' ? 'Space' : event.key === 'Escape' ? 'Esc' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const modifiers = [
    event.ctrlKey && key !== 'Control' ? 'Ctrl' : '',
    event.metaKey && key !== 'Meta' ? 'Meta' : '',
    event.altKey && key !== 'Alt' ? 'Alt' : '',
    event.shiftKey && key !== 'Shift' ? 'Shift' : ''
  ].filter(Boolean);
  return [...modifiers, key].join('+');
}

export function validateWaveformShortcutBindings(_enabled: boolean, bindings: Record<string, string>): string {
  const seen = new Map<string, string>();
  for (const spec of WAVEFORM_SHORTCUT_SPECS) {
    const sequence = normalizeShortcutText(bindings[spec.id] || '');
    if (!sequence) continue;
    if (sequence.includes(',')) return `${spec.label} uses '${sequence}'. Use a single shortcut, not a multi-step sequence.`;
    const modifiers = sequence.split('+').slice(0, -1);
    if (modifiers.some((modifier) => ['Ctrl', 'Meta', 'Alt'].includes(modifier))) return `${spec.label} uses '${sequence}'. Use plain keys or Shift-only combinations.`;
    const previous = seen.get(sequence);
    if (previous) return `${spec.label} and ${previous} both use '${sequence}'. Choose unique shortcuts.`;
    seen.set(sequence, spec.label);
  }
  return '';
}
