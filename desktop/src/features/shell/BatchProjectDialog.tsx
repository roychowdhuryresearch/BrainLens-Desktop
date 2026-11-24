import { useMemo, useState } from 'react';
import { backendClient } from '../../api/backendClient';
import type { BiomarkerType, PrepareControlsState } from '../../app/workspaceState';
import { detectorTabsByBiomarker } from '../../app/workspaceState';

type BatchCase = { case_id?: string; input_path?: string; output_dir?: string; status?: string; error?: string };
type BatchResult = { status?: string; manifest_path?: string; summary?: Record<string, number>; cases?: BatchCase[]; errors?: Array<Record<string, unknown>> };

type BatchProjectDialogProps = { biomarker: BiomarkerType; prepareControls: PrepareControlsState; onClose: () => void; onShowArtifacts: () => void };

export function BatchProjectDialog({ biomarker, prepareControls, onClose, onShowArtifacts }: BatchProjectDialogProps) {
  const [inputDir, setInputDir] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [retryFailed, setRetryFailed] = useState(false);
  const [failFast, setFailFast] = useState(false);
  const [selectedBiomarker, setSelectedBiomarker] = useState<BiomarkerType>(biomarker);
  const [detector, setDetector] = useState(detectorTabsByBiomarker[biomarker][0]);
  const [manifestPath, setManifestPath] = useState('');
  const [result, setResult] = useState<BatchResult | null>(null);
  const [feedback, setFeedback] = useState('Batch manifest not created yet.');
  const [busy, setBusy] = useState(false);
  const detectors = detectorTabsByBiomarker[selectedBiomarker];
  const visibleCases = useMemo(() => (result?.cases || []).slice(0, 80), [result]);

  function setBiomarker(value: BiomarkerType) {
    setSelectedBiomarker(value);
    setDetector(detectorTabsByBiomarker[value][0]);
  }

  async function chooseInputDirectory() {
    const selected = await backendClient.openBatchInputDirectory() as string | null;
    if (selected) { setInputDir(selected); setFeedback('Batch input directory selected.'); }
    else setFeedback('Input directory selection cancelled.');
  }

  async function chooseOutputDirectory() {
    const selected = await backendClient.openBatchOutputDirectory() as string | null;
    if (selected) { setOutputDir(selected); setFeedback('Batch output directory selected.'); }
    else setFeedback('Output directory selection cancelled.');
  }

  async function createManifest() {
    if (!inputDir.trim()) { setFeedback('Input directory is required to create a batch project.'); return; }
    setBusy(true);
    try {
      const created = await backendClient.createBatchProject({ input_dir: inputDir.trim(), output_dir: outputDir.trim() || undefined, recursive }) as BatchResult;
      setResult(created);
      setManifestPath(created.manifest_path || '');
      setFeedback(`Batch manifest created: ${created.summary?.total ?? created.cases?.length ?? 0} case(s).`);
    } catch (exc) { setFeedback(exc instanceof Error ? exc.message : String(exc)); }
    finally { setBusy(false); }
  }

  async function runBatch() {
    if (!manifestPath.trim() && !inputDir.trim()) { setFeedback('Input directory or manifest path is required.'); return; }
    setBusy(true);
    try {
      const batch = await backendClient.runBatch({
        manifest_path: manifestPath.trim() || undefined,
        input_dir: inputDir.trim() || undefined,
        output_dir: outputDir.trim() || undefined,
        recursive,
        retry_failed: retryFailed,
        fail_fast: failFast,
        detection: { biomarker: selectedBiomarker, detector, detector_params: {}, filter: prepareFilterPayload(prepareControls), n_jobs: prepareControls.nJobs, exports: ['csv', 'session', 'summary_json'] }
      }) as BatchResult;
      setResult(batch);
      setManifestPath(batch.manifest_path || manifestPath);
      setFeedback(`Batch run ${batch.status || 'complete'}: ${batch.summary?.complete ?? 0}/${batch.summary?.total ?? batch.cases?.length ?? 0} complete, ${batch.summary?.failed ?? 0} failed.`);
      onShowArtifacts();
    } catch (exc) { setFeedback(exc instanceof Error ? exc.message : String(exc)); }
    finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop batch-project-backdrop" role="dialog" aria-modal="true">
      <section className="modal-card batch-project-dialog" data-testid="pyqt-batch_project_window">
        <header className="batch-project-header">
          <div>
            <h2>Batch Project</h2>
          </div>
          <button className="modal-window-close-button" data-testid="pyqt-batch_project_close_button" onClick={onClose}>Close</button>
        </header>
        <div className="batch-project-grid">
          <section className="panel-card" data-testid="pyqt-batch_project_setup_card"><h3>Project folders</h3><label>Input directory<input data-testid="pyqt-batch_input_dir_input" value={inputDir} placeholder="Folder containing EDF/BDF/FIF/VHDR recordings" onChange={(event) => setInputDir(event.target.value)} /></label><button data-testid="pyqt-batch_input_dir_browse_button" onClick={chooseInputDirectory}>Choose Input Folder</button><label>Output directory<input data-testid="pyqt-batch_output_dir_input" value={outputDir} placeholder="Optional (uses the PyHFO exports folder)" onChange={(event) => setOutputDir(event.target.value)} /></label><button data-testid="pyqt-batch_output_dir_browse_button" onClick={chooseOutputDirectory}>Choose Output Folder</button><label className="select-toggle"><input data-testid="pyqt-batch_recursive_checkbox" type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /> Recursive scan</label><button data-testid="pyqt-batch_create_manifest_button" className="primary-action" disabled={busy || !inputDir.trim()} onClick={createManifest}>Create Manifest</button></section>
          <section className="panel-card" data-testid="pyqt-batch_project_run_card"><h3>Run settings</h3><label>Manifest<input data-testid="pyqt-batch_manifest_path_input" value={manifestPath} placeholder="batch_project.json" onChange={(event) => setManifestPath(event.target.value)} /></label><label>Biomarker<select data-testid="pyqt-batch_biomarker_combo" value={selectedBiomarker} onChange={(event) => setBiomarker(event.target.value as BiomarkerType)}>{(['HFO', 'Spindle', 'Spike'] as BiomarkerType[]).map((item) => <option key={item}>{item}</option>)}</select></label><label>Detector<select data-testid="pyqt-batch_detector_combo" value={detector} onChange={(event) => setDetector(event.target.value)}>{detectors.map((item) => <option key={item}>{item}</option>)}</select></label><label className="select-toggle"><input data-testid="pyqt-batch_retry_failed_checkbox" type="checkbox" checked={retryFailed} onChange={(event) => setRetryFailed(event.target.checked)} /> Retry failed cases</label><label className="select-toggle"><input data-testid="pyqt-batch_fail_fast_checkbox" type="checkbox" checked={failFast} onChange={(event) => setFailFast(event.target.checked)} /> Stop after first failure</label><button data-testid="pyqt-batch_run_button" className="primary-action" disabled={busy || (!manifestPath.trim() && !inputDir.trim())} onClick={runBatch}>{busy ? 'Working…' : 'Run Batch'}</button></section>
          <section className="panel-card batch-summary-card" data-testid="pyqt-batch_project_summary_card"><h3>Batch summary</h3><p className="status-line" data-testid="pyqt-batch_feedback">{feedback}</p><div className="batch-summary-grid">{['total', 'pending', 'running', 'complete', 'failed'].map((key) => <span key={key} className="status-pill" data-testid={`pyqt-batch_summary_${key}`}>{key}: {result?.summary?.[key] ?? 0}</span>)}</div></section>
          <section className="panel-card batch-cases-card" data-testid="pyqt-batch_project_cases_card"><h3>Cases</h3><table className="data-table compact" data-testid="pyqt-batch_case_table"><thead><tr><th>Case</th><th>Status</th><th>Input</th><th>Output</th></tr></thead><tbody>{visibleCases.map((item) => <tr key={item.case_id || item.input_path}><td>{item.case_id || '--'}</td><td>{item.status || 'pending'}</td><td title={item.input_path}>{item.input_path || '--'}</td><td title={item.output_dir}>{item.output_dir || '--'}</td></tr>)}{!visibleCases.length && <tr><td className="batch-empty-row" colSpan={4}>No cases yet. Choose an input folder and create a manifest.</td></tr>}</tbody></table></section>
        </div>
      </section>
    </div>
  );
}

function prepareFilterPayload(controls: PrepareControlsState) {
  return { fp: numberOrUndefined(controls.fp), fs: numberOrUndefined(controls.fs), rp: numberOrUndefined(controls.rp), rs: numberOrUndefined(controls.rs), line_noise_notch_hz: numberOrUndefined(controls.lineNoiseNotchHz), resample_sfreq: numberOrUndefined(controls.resampleSfreq) };
}

// A blank field must be OMITTED (undefined) so the backend applies its per-biomarker
// default. Number('') === 0 is finite, so the old check sent fp/fs=0, which fails the
// backend's `fp <= 0` Nyquist guard and makes every batch case fail. Match the canonical
// optionalPositiveNumber semantics used on the single-recording Prepare path.
function numberOrUndefined(value: string) { const v = value.trim(); if (!v) return undefined; const parsed = Number(v); return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined; }
