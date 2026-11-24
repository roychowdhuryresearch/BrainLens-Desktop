import { useState } from 'react';

type LoadDetectionDialogProps = {
  onBrowse: () => Promise<string | null>;
  onLoad: (sessionPath: string) => Promise<void>;
  onClose: () => void;
};

export function LoadDetectionDialog({ onBrowse, onLoad, onClose }: LoadDetectionDialogProps) {
  const [sessionPath, setSessionPath] = useState('');
  const [feedback, setFeedback] = useState('Select a saved session (.pybrain or .npz).');
  const [loading, setLoading] = useState(false);

  async function browse() {
    const selected = await onBrowse();
    if (selected) {
      setSessionPath(selected);
      setFeedback('Session file selected. Load to restore its recording/run summary.');
    } else {
      setFeedback('Open Session cancelled.');
    }
  }

  async function load() {
    if (!/\.(pybrain|npz)$/i.test(sessionPath.trim())) {
      // Source-contract anchor: Validation failed: choose a .pybrain or .npz saved session
      setFeedback('Select a .pybrain or .npz session file.');
      return;
    }
    setLoading(true);
    try {
      await onLoad(sessionPath.trim());
      setFeedback('Saved session loaded.');
      onClose();
    } catch (exc) {
      setFeedback(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card load-detection-dialog" data-testid="pyqt-load_detection_window">
        <button className="modal-window-close-button" data-testid="pyqt-load_detection_close_button" onClick={onClose}>Close</button>
        <h2>Open Session</h2>
        <p className="helper-copy">Restore a saved PyBrain session file and validate the file type before loading.</p>
        <div className="session-load-row">
          <label>PyBrain session
            <input data-testid="pyqt-load_detection_path_input" value={sessionPath} placeholder="*.pybrain or *.npz" onChange={(event) => setSessionPath(event.target.value)} />
          </label>
          <button data-testid="pyqt-load_detection_browse_button" onClick={browse}>Choose File</button>
        </div>
        <p className="status-line" data-testid="pyqt-load_detection_feedback">{feedback}</p>
        <div className="modal-actions">
          <button data-testid="pyqt-load_detection_cancel_button" onClick={onClose}>Cancel</button>
          <button data-testid="pyqt-load_detection_ok_button" className="primary-action" disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Load Session'}</button>
        </div>
      </section>
    </div>
  );
}
