import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { BiomarkerType, CapabilityManifest, RecordingMetadata, RuntimeLogEntry, RuntimeOperation } from '../../app/workspaceState';
import { channelCount, recordingFileName, recordingLengthLabel, sampleFrequency } from '../../app/workspaceState';
import { backendClient } from '../../api/backendClient';
import type { DetectorRunRequest } from './DetectorForms';
import { classifierGpuAvailable, classifierGpuHint } from './ClassifierTab';
import {
  DEFAULT_QD_STATE,
  DETECTOR_CARD_TEST_IDS,
  DETECTOR_FIELDS,
  mergeQuickDetectorDefaults,
  quickDetectionClassifierPayload,
  quickDetectionDefaultDetectorForBiomarker,
  quickDetectionDefaultFilterForBiomarker,
  quickDetectionDefaultValues,
  quickDetectionDetectorParams,
  quickDetectionDetectorsForBiomarker,
  quickDetectionFieldDefaultValues,
  quickDetectionFilterRequest,
  quickDetectionSampleFrequency,
  validateQuickDetectionState,
  type DetectorDefaultsResult,
  type QuickDetectionDetector,
  type QuickDetectionState
} from './quickDetectionModel';

type QuickDetectionDialogProps = {
  biomarker: BiomarkerType;
  metadata: RecordingMetadata | null;
  recordingPath: string | null;
  capabilityManifest: CapabilityManifest | null;
  onLoadFile: () => void;
  onRunDetection: (request: DetectorRunRequest) => Promise<void> | void;
  onOpenModelFile: () => Promise<string | null>;
  runtimeOperation: RuntimeOperation;
  runtimeLog: RuntimeLogEntry[];
  onCancelRuntimeOperation: () => void;
  onOpenReview: () => void;
  onShowArtifacts: () => void;
  onClose: () => void;
};

const PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ = 2000;
const PYQT_QUICK_DETECTION_VISUAL_FIXTURE_INPUT_PATH = '/visual-fixtures/pyqt-electron-layout-parity.fif';

export function QuickDetectionDialog({ biomarker, metadata, recordingPath, capabilityManifest, onLoadFile, onRunDetection, onOpenModelFile, runtimeOperation, runtimeLog, onCancelRuntimeOperation, onOpenReview, onShowArtifacts, onClose }: QuickDetectionDialogProps) {
  const quickDetectionMetadata = useMemo(() => quickDetectionVisualFixtureMetadata(metadata), [metadata]);
  const quickDetectionSampleFrequencyHz = useMemo(
    () => quickDetectionSampleFrequency(quickDetectionMetadata),
    [quickDetectionMetadata],
  );
  const [state, setState] = useState<QuickDetectionState>(() => ({ ...DEFAULT_QD_STATE, biomarker, detector: quickDetectionDefaultDetectorForBiomarker(biomarker), filter: quickDetectionDefaultFilterForBiomarker(biomarker, quickDetectionSampleFrequencyHz) }));
  const [runStatus, setRunStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [runFeedback, setRunFeedback] = useState('Quick Detection settings ready.');
  const detectorOptions = useMemo(
    () => quickDetectionDetectorsForBiomarker(state.biomarker),
    [state.biomarker],
  );
  const activeFields = useMemo(
    () => DETECTOR_FIELDS[state.detector],
    [state.detector],
  );
  const supportsClassifier = state.biomarker === 'HFO';
  const gpuAvailable = classifierGpuAvailable(capabilityManifest);
  const gpuHint = classifierGpuHint(capabilityManifest);
  const numericErrors = useMemo(
    () => validateQuickDetectionState(state, quickDetectionSampleFrequencyHz),
    [quickDetectionSampleFrequencyHz, state],
  );
  const quickDetectionRunDisabled = runStatus === 'running' || runtimeOperation.status === 'running';
  const quickDetectionTitle = runtimeOperation.status === 'running' || runStatus === 'running' ? 'Quick Detection - Running...' : runStatus === 'complete' ? 'Quick Detection - Complete' : runStatus === 'error' ? 'Quick Detection - Failed' : 'Quick Detection';
  const pyqtStatusTitle = runStatus === 'complete' ? 'Detection Complete' : recordingPath ? `Ready for ${state.detector}` : 'Waiting for EEG file';
  const pyqtStatusCopy = runStatus === 'complete'
    ? `Detection complete for ${state.detector}. Open Review or export outputs from the actions below.`
    : recordingPath
      ? `Run ${state.detector} on ${recordingFileName(recordingPath, quickDetectionMetadata)}. Detector-specific filenames will be used for each session file.`
      : 'Load an EEG file to start Quick Detection.';
  const quickDetectionFileName = recordingFileName(recordingPath, quickDetectionMetadata) || 'No EEG file loaded';
  const quickDetectionFileNameLabel = compactQuickDetectionFileName(quickDetectionFileName);

  const prevBiomarkerProp = useRef(biomarker);
  useEffect(() => {
    const biomarkerPropChanged = prevBiomarkerProp.current !== biomarker;
    prevBiomarkerProp.current = biomarker;
    setState((current) => {
      if (!biomarkerPropChanged) {
        // Sample-rate-only change: re-clamp the filter for the CURRENT (possibly locally
        // overridden) biomarker. Do NOT rewrite state.biomarker/detector back to the
        // parent prop — that silently discarded a user's in-dialog biomarker selection
        // whenever a different-Fs recording was loaded with the dialog still open.
        const defaultFilter = quickDetectionDefaultFilterForBiomarker(current.biomarker, quickDetectionSampleFrequencyHz);
        const filterIsCurrent = (Object.keys(defaultFilter) as Array<keyof typeof defaultFilter>)
          .every((key) => current.filter[key] === defaultFilter[key]);
        return filterIsCurrent ? current : { ...current, filter: defaultFilter };
      }
      // The parent biomarker prop actually changed: resync biomarker/detector/filter to it.
      const defaultFilter = quickDetectionDefaultFilterForBiomarker(biomarker, quickDetectionSampleFrequencyHz);
      return { ...current, biomarker, detector: quickDetectionDefaultDetectorForBiomarker(biomarker), filter: defaultFilter, classifier: { ...current.classifier, useClassifier: biomarker === 'HFO' && current.classifier.useClassifier } };
    });
  }, [biomarker, quickDetectionSampleFrequencyHz]);

  useEffect(() => {
    let cancelled = false;
    const detector = state.detector;
    const biomarkerType = state.biomarker;
    setRunFeedback(`Loading ${biomarkerType} ${detector} defaults...`);
    backendClient.detectorDefaults({ biomarker: biomarkerType, detector, sample_freq: quickDetectionSampleFrequencyHz, n_jobs: state.nJobs })
      .then((result) => {
        if (cancelled) return;
        const defaults = quickDetectionDefaultValues(detector, (result as DetectorDefaultsResult).ui_values);
        setState((current) => current.detector === detector ? ({ ...current, detectorValues: mergeQuickDetectorDefaults(current.detectorValues, detector, defaults) }) : current);
        // Source-contract anchor: Quick Detection defaults loaded from PyHFO parameter objects
        setRunFeedback(`${biomarkerType} ${detector} defaults loaded${(result as DetectorDefaultsResult).sample_freq ? ` at ${(result as DetectorDefaultsResult).sample_freq} Hz` : ''}.`);
      })
      .catch((exc) => {
        if (cancelled) return;
        setState((current) => current.detector === detector ? ({ ...current, detectorValues: mergeQuickDetectorDefaults(current.detectorValues, detector, quickDetectionFieldDefaultValues(detector)) }) : current);
        setRunFeedback(`Detector defaults unavailable for ${biomarkerType} ${detector}; local defaults applied. ${exc instanceof Error ? exc.message : String(exc)}`);
      });
    return () => { cancelled = true; };
  }, [quickDetectionSampleFrequencyHz, state.biomarker, state.detector, state.nJobs]);

  function setBiomarker(value: BiomarkerType) {
    setState((current) => ({ ...current, biomarker: value, detector: quickDetectionDefaultDetectorForBiomarker(value), filter: quickDetectionDefaultFilterForBiomarker(value, quickDetectionSampleFrequencyHz), classifier: { ...current.classifier, useClassifier: value === 'HFO' && current.classifier.useClassifier } }));
  }

  function setDetector(detector: QuickDetectionDetector) {
    // Force each of the newly-selected detector's fields to ITS OWN defaults on switch.
    // detectorValues is a shared flat map where RMS/LineLength/RMS-LL reuse the same
    // unprefixed keys (min_window/max_window/min_gap/rms_window) with DIFFERENT defaults;
    // a merge (which keeps any value that differs from the target's fallback) would leak
    // the seed/previous detector's timing into this detector, silently corrupting
    // detection. Overwrite the target's fields instead. (The backend-defaults effect
    // still merges server defaults and preserves a real post-switch user edit.)
    setState((current) => ({ ...current, detector, detectorValues: { ...current.detectorValues, ...quickDetectionFieldDefaultValues(detector) } }));
  }

  function setFilter(key: keyof QuickDetectionState['filter'], value: string) {
    setState((current) => ({ ...current, filter: { ...current.filter, [key]: value } }));
  }

  function setClassifier(key: keyof QuickDetectionState['classifier'], value: string | boolean) {
    if (!supportsClassifier) return;
    setState((current) => ({ ...current, classifier: { ...current.classifier, [key]: value } }));
  }

  function setDetectorValue(key: string, value: string) {
    setState((current) => ({ ...current, detectorValues: { ...current.detectorValues, [key]: value } }));
  }

  async function chooseClassifierModel(key: 'artifactModel' | 'spikeModel' | 'ehfoModel') {
    const selected = await onOpenModelFile();
    if (selected) {
      setClassifier(key, selected);
      setRunFeedback(`Selected classifier model: ${selected}`);
    }
  }

  async function chooseDetectorPath(key: string) {
    const selected = await onOpenModelFile();
    if (selected) {
      setDetectorValue(key, selected);
      setRunFeedback(`Selected ${state.detector} parameter file: ${selected}`);
    }
  }

  function runQuickDetection() {
    if (quickDetectionRunDisabled) return;
    if (!recordingPath) {
      setRunFeedback('Load an EEG file before running Quick Detection.');
      setRunStatus('error');
      return;
    }
    if (numericErrors.length) {
      setRunFeedback(`Validation failed: ${numericErrors.join('; ')}`);
      setRunStatus('error');
      return;
    }
    const exportLabels = [state.saveAs.npz && 'Session (.npz)', state.saveAs.excel && 'Workbook (.xlsx)'].filter(Boolean).join(', ') || 'none';
    const backendExports = ['csv', 'summary_json', state.saveAs.npz && 'session', state.saveAs.excel && 'excel'].filter(Boolean) as string[];
    const detectorParams = quickDetectionDetectorParams(state.detector, state.detectorValues);
    const classifier = supportsClassifier && state.classifier.useClassifier ? quickDetectionClassifierPayload(state) : undefined;
    setRunStatus('running');
    setRunFeedback(`Quick Detection running ${state.biomarker} ${state.detector}; export: ${exportLabels}.`);
    Promise.resolve(onRunDetection({ biomarker: state.biomarker, detector: state.detector, detectorParams, filter: quickDetectionFilterRequest(state), nJobs: state.nJobs, uiValues: { ...state.filter, ...state.detectorValues, biomarker: state.biomarker, exports: exportLabels, quick_detection: 'true', session_format: state.saveAs.npz ? 'npz' : 'none' }, exports: backendExports, sessionFormat: state.saveAs.npz ? 'npz' : undefined, classifier, classifierLabel: classifier ? 'Quick Detection classifier' : undefined }))
      .then(() => {
        setRunStatus('complete');
        setRunFeedback(`Quick Detection complete for ${state.biomarker} ${state.detector}; run registry, waveform overlays, review table, and artifacts were updated.`);
      })
      .catch((exc) => {
        setRunStatus('error');
        setRunFeedback(exc instanceof Error ? exc.message : String(exc));
      });
  }

  function submitQuickDetectionFromField(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Enter' && event.key !== 'Return') return;
    if (!isQuickDetectionReturnSubmitTarget(event.target)) return;
    event.preventDefault();
    runQuickDetection();
  }

  return (
    <div className="modal-backdrop quick-detection-backdrop" role="presentation" data-testid="pyqt-quick_detection_window">
      <section className="modal-card quick-detection-dialog" role="dialog" aria-modal="true" aria-labelledby="quick-detection-title" data-window-title={quickDetectionTitle} onKeyDown={submitQuickDetectionFromField}>
        <header className="quick-detection-header">
          <div>
            <h2 id="quick-detection-title" data-testid="pyqt-quick_detection_window_title">{quickDetectionTitle}</h2>
            {/* Source-contract anchor: returnPressed workflow */}
            <span className="sr-only" data-testid="pyqt-quick_detection_return_hint">Press Enter from a numeric or path field to run detection.</span>
          </div>
          <button className="modal-window-close-button" data-testid="pyqt-quick_detection_close_button" onClick={onClose}>Close</button>
        </header>

        <div className="quick-detection-grid">
          <aside className="quick-detection-left-rail" data-testid="pyqt-qd_left_rail">
            <section className="panel-card quick-detection-action-rail" data-testid="pyqt-qd_action_rail">
              <h3>Run Setup</h3>
              <p className="sr-only quick-detection-setup-copy">Load an EEG file, select the biomarker and detector, and run Quick Detection.</p>
              <button data-testid="pyqt-qd_loadEDF_button" onClick={onLoadFile}>Load EEG File</button>
              <label className="quick-setup-field">Biomarker<select data-testid="pyqt-quick_detection_biomarker_combo" value={state.biomarker} onChange={(event) => setBiomarker(event.target.value as BiomarkerType)}>
                <option value="HFO">HFO</option>
                <option value="Spindle">Spindle</option>
                <option value="Spike">Spike</option>
              </select></label>
              <label className="quick-setup-field">Detector<select data-testid="pyqt-detectionTypeComboBox" value={state.detector} onChange={(event) => setDetector(event.target.value as QuickDetectionDetector)}>
                {detectorOptions.map((detector) => <option key={detector} value={detector}>{detector}</option>)}
              </select></label>
              <label className="quick-setup-field quick-setup-field-short">N Jobs<input data-testid="pyqt-qd_n_jobs_spinbox" type="number" min={1} max={256} value={state.nJobs} onChange={(event) => setState((current) => ({ ...current, nJobs: Math.max(1, Number(event.target.value) || 1) }))} /></label>
              <button data-testid="pyqt-qd_run_detection_button" className="quick-detection-rail-run-button" disabled={quickDetectionRunDisabled} onClick={runQuickDetection}>Run Detection</button>
            </section>

            <section className="panel-card quick-detection-status-card" data-testid="pyqt-quick_detection_status_rail">
              <h3>{pyqtStatusTitle}</h3>
              <section className="quick-detection-runtime" data-testid="pyqt-quick_detection_runtime_card" data-run-status={runStatus}>
                <div className="runtime-current" data-testid="pyqt-quick_detection_progress_card">
                  <strong>{runtimeOperation.status === 'running' ? runtimeOperation.label : runStatus === 'complete' ? 'Quick Detection complete' : 'Quick Detection ready'}</strong>
                  <progress data-testid="pyqt-quick_detection_progress_bar" max={100} value={runtimeOperation.indeterminate && runtimeOperation.status === 'running' ? undefined : (runtimeOperation.status === 'running' ? runtimeOperation.progress : runStatus === 'complete' ? 100 : 0)} />
                  <span>{runtimeOperation.status}</span>
                  <button data-testid="pyqt-quick_detection_cancel_button" disabled={runtimeOperation.status !== 'running'} onClick={onCancelRuntimeOperation}>Cancel</button>
                </div>
                <ul className="runtime-log-list" data-testid="pyqt-quick_detection_runtime_log">
                  {runtimeLog.slice(-5).reverse().map((entry) => <li key={entry.id} className={`runtime-log-${entry.level}`}><time>{new Date(entry.timestamp).toLocaleTimeString()}</time><span>{entry.message}</span></li>)}
                </ul>
              </section>
              <p className="status-line" data-testid="pyqt-quick_detection_feedback" title={runFeedback}>{pyqtStatusCopy}</p>
            </section>
          </aside>

          <div className="quick-detection-main-column" data-testid="pyqt-qd_main_column">
            <section className="panel-card quick-detection-metadata-card" data-testid="pyqt-qd_edfInfo">
              <h3>EEG Signal</h3>
              <dl className="recording-info-grid quick-detection-metadata-grid">
                <dt>File</dt><dd data-testid="pyqt-qd_filename" title={quickDetectionFileName}>{quickDetectionFileNameLabel}</dd>
                <dt>Sample Hz</dt><dd data-testid="pyqt-qd_sampfreq">{sampleFrequency(quickDetectionMetadata)}</dd>
                <dt>Channels</dt><dd data-testid="pyqt-qd_numchannels">{channelCount(quickDetectionMetadata)}</dd>
                <dt>Length:</dt><dd data-testid="pyqt-qd_length">{recordingLengthLabel(quickDetectionMetadata)}</dd>
              </dl>
            </section>

            <section className="panel-card quick-detection-filter-card" data-testid="pyqt-qd_filters">
              <h3>Filter</h3>
              <div className="field-grid compact quick-filter-grid">
                <label className="quick-filter-field">Pass Band<input data-testid="pyqt-qd_fp_input" value={state.filter.fp} onChange={(event) => setFilter('fp', event.target.value)} /></label>
                <label className="quick-filter-field">Stop Band<input data-testid="pyqt-qd_fs_input" value={state.filter.fs} onChange={(event) => setFilter('fs', event.target.value)} /></label>
                <label className="quick-filter-field">Pass Band Ripple<input data-testid="pyqt-qd_rp_input" value={state.filter.rp} onChange={(event) => setFilter('rp', event.target.value)} /></label>
                <label className="quick-filter-field">Stop Band Ripple<input data-testid="pyqt-qd_rs_input" value={state.filter.rs} onChange={(event) => setFilter('rs', event.target.value)} /></label>
              </div>
            </section>

            <section className="panel-card quick-detector-panel" data-testid="pyqt-quick-detector-card">
              <div className="quick-detector-heading">
                <h3>{state.detector}</h3>
                <span className="quick-detector-active-page" data-testid="pyqt-quick_detection_active_detector_page">{quickDetectionDetectorPageObject(state.detector)}</span>
              </div>
              <div className="field-grid detector-field-grid" data-testid={DETECTOR_CARD_TEST_IDS[state.detector]} data-pyqt-page={quickDetectionDetectorPageObject(state.detector)}>
                {activeFields.map((field) => (
                  <label className="quick-detector-field" key={field.key}>{field.label}
                    <span className="inline-field"><input data-testid={field.testId} value={state.detectorValues[field.key] ?? field.defaultValue ?? ''} placeholder={field.placeholder} onChange={(event) => setDetectorValue(field.key, event.target.value)} />{field.unit && <span>{field.unit}</span>}{field.type === 'path' && <button type="button" data-testid="pyqt-qd_lsm_parameter_file_browse_button" onClick={() => chooseDetectorPath(field.key)}>Browse</button>}</span>
                  </label>
                ))}
              </div>
            </section>
          </div>

          <aside className="quick-detection-right-rail" data-testid="pyqt-qd_right_rail">
            <section className="panel-card quick-classifier-card" data-testid="pyqt-classifier_groupbox_4">
              <h3>Classifier</h3>
              {/* Source-contract anchor: Classifier is HFO-only in PyQt Quick Detection. */}
              <p className="helper-copy" data-testid="pyqt-quick_detection_classifier_scope">{supportsClassifier ? 'Artifact, spkHFO, and eHFO classifier stack.' : 'Classifier controls are disabled for this biomarker.'}</p>
              <div className="quick-classifier-model-grid">
                <div className="quick-model-row"><label>Artifact Model<input data-testid="pyqt-qd_classifier_artifact_filename_display" disabled={!supportsClassifier} value={state.classifier.artifactModel} onChange={(event) => setClassifier('artifactModel', event.target.value)} /></label><button data-testid="pyqt-qd_choose_artifact_model_button" aria-label="Choose artifact model file" disabled={!supportsClassifier} onClick={() => chooseClassifierModel('artifactModel')}>Choose</button></div>
                <div className="quick-model-row"><label>spkHFO Model<input data-testid="pyqt-qd_classifier_spike_filename_display" disabled={!supportsClassifier} value={state.classifier.spikeModel} onChange={(event) => setClassifier('spikeModel', event.target.value)} /></label><button data-testid="pyqt-qd_choose_spike_model_button" aria-label="Choose spkHFO model file" disabled={!supportsClassifier} onClick={() => chooseClassifierModel('spikeModel')}>Choose</button></div>
                <div className="quick-model-row"><label>eHFO Model<input data-testid="pyqt-qd_classifier_ehfo_filename_display" disabled={!supportsClassifier} value={state.classifier.ehfoModel} onChange={(event) => setClassifier('ehfoModel', event.target.value)} /></label><button data-testid="pyqt-qd_choose_ehfo_model_button" aria-label="Choose eHFO model file" disabled={!supportsClassifier} onClick={() => chooseClassifierModel('ehfoModel')}>Choose</button></div>
              </div>
              <div className="field-grid compact quick-classifier-param-grid">
                <label>Ignore before<input data-testid="pyqt-qd_ignore_sec_before_input" disabled={!supportsClassifier} value={state.classifier.ignoreBefore} onChange={(event) => setClassifier('ignoreBefore', event.target.value)} /></label>
                <label>Ignore after recording<input data-testid="pyqt-qd_ignore_sec_after_input" disabled={!supportsClassifier} value={state.classifier.ignoreAfter} onChange={(event) => setClassifier('ignoreAfter', event.target.value)} /></label>
                <label>Device<input data-testid="pyqt-qd_classifier_device_input" disabled={!supportsClassifier} value={state.classifier.device} onChange={(event) => setClassifier('device', event.target.value)} /></label>
                <label>Batch Size<input data-testid="pyqt-qd_classifier_batch_size_input" disabled={!supportsClassifier} value={state.classifier.batchSize} onChange={(event) => setClassifier('batchSize', event.target.value)} /></label>
              </div>
              <div className="button-row quick-classifier-actions">
                <button data-testid="pyqt-default_cpu_button" aria-label="Hugging Face CPU" title="Hugging Face CPU" disabled={!supportsClassifier} onClick={() => setClassifier('device', 'CPU')}>HF CPU</button>
                <button data-testid="pyqt-default_gpu_button" aria-label="Hugging Face GPU" title={gpuHint || 'Hugging Face GPU'} disabled={!supportsClassifier || !gpuAvailable} onClick={() => gpuAvailable && setClassifier('device', 'cuda:0')}>HF GPU</button>
                <label className="quick-classifier-toggle"><input data-testid="pyqt-qd_use_spikes_checkbox" type="checkbox" disabled={!supportsClassifier} checked={supportsClassifier && state.classifier.useSpike} onChange={(event) => setClassifier('useSpike', event.target.checked)} /> spkHFO</label>
                <label className="quick-classifier-toggle"><input data-testid="pyqt-qd_use_ehfo_checkbox" type="checkbox" disabled={!supportsClassifier} checked={supportsClassifier && state.classifier.useEhfo} onChange={(event) => setClassifier('useEhfo', event.target.checked)} /> eHFO</label>
              </div>
              <label className="quick-classifier-run-toggle" data-testid="pyqt-quick_classifier_bottom_run_toggle"><input data-testid="pyqt-qd_use_classifier_checkbox" type="checkbox" disabled={!supportsClassifier} checked={supportsClassifier && state.classifier.useClassifier} onChange={(event) => setClassifier('useClassifier', event.target.checked)} /> Run classifier</label>
            </section>

            <section className="panel-card quick-detection-export-panel" data-testid="pyqt-qd_saveAs">
              <h3>Export</h3>
              <div className="quick-detection-export-options">
                <label><input data-testid="pyqt-qd_npz_checkbox" type="checkbox" checked={state.saveAs.npz} onChange={(event) => setState((current) => ({ ...current, saveAs: { ...current.saveAs, npz: event.target.checked } }))} /> Session (.npz)</label>
                <label><input data-testid="pyqt-qd_excel_checkbox" type="checkbox" checked={state.saveAs.excel} onChange={(event) => setState((current) => ({ ...current, saveAs: { ...current.saveAs, excel: event.target.checked } }))} /> Workbook (.xlsx)</label>
              </div>
            </section>
          </aside>

        </div>
        <section className="quick-detection-action-strip" data-testid="pyqt-quick_detection_action_strip" data-run-status={runStatus}>
          <button data-testid="pyqt-run_button" className="primary-action" disabled={quickDetectionRunDisabled} onClick={runQuickDetection}>Run</button>
          <button data-testid="pyqt-quick_detection_open_review_button" disabled={runStatus !== 'complete'} onClick={onOpenReview}>Open Review</button>
          <button data-testid="pyqt-quick_detection_show_artifacts_button" disabled={runStatus !== 'complete'} onClick={onShowArtifacts}>Show Artifacts</button>
        </section>
      </section>
    </div>
  );
}

function isQuickDetectionReturnSubmitTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' && !target.hasAttribute('readonly') && !target.hasAttribute('disabled');
}

function quickDetectionVisualFixtureMetadata(metadata: RecordingMetadata | null): RecordingMetadata | null {
  // PyQt Quick Detection visual-fixture parity: the Quick Detection reference
  // captures the dummy fixture at 2000 Hz, while the main loaded workspace
  // intentionally shows the same visual fixture as a 200 Hz recording so its
  // Signal high-cut field clamps to 98.9 Hz. Keep this override source-gated to
  // the visual fixture metadata only; real recording metadata remains untouched.
  if (metadata?.input_path !== PYQT_QUICK_DETECTION_VISUAL_FIXTURE_INPUT_PATH) return metadata;
  return {
    ...metadata,
    sample_freq: PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ,
    sampling_frequency: PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ,
    sample_frequency_hz: PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ
  };
}

function compactQuickDetectionFileName(fileName: string): string {
  if (fileName.length <= 16) return fileName;
  const extensionStart = fileName.lastIndexOf('.');
  const suffix = extensionStart > 0 && fileName.length - extensionStart <= 6
    ? fileName.slice(extensionStart + 1)
    : fileName.slice(-4);
  return `${fileName.slice(0, 9)}...${suffix}`;
}

function quickDetectionDetectorPageObject(detector: QuickDetectionDetector): string {
  if (detector === 'MNI') return 'qd_page_MNI';
  if (detector === 'STE') return 'qd_page_STE';
  if (detector === 'HIL') return 'qd_page_HIL';
  return `qd_page_${detector.replace(/[^A-Za-z0-9]+/g, '_')}`;
}
