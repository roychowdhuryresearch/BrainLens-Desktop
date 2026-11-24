import { useEffect, useMemo } from 'react';
import type { BiomarkerType, CapabilityManifest } from '../../app/workspaceState';

export type ClassifierMode = 'ONNX CPU' | 'HF CPU' | 'HF GPU' | 'Custom' | 'Review only';

export type ClassifierControlsState = {
  mode: ClassifierMode;
  ignoreBefore: string;
  ignoreAfter: string;
  device: string;
  batchSize: string;
  useSpike: boolean;
  useEhfo: boolean;
  localArtifact: string;
  localSpike: string;
  localEhfo: string;
  hubArtifact: string;
  hubSpike: string;
  hubEhfo: string;
};

export type ClassifierRunRequest = {
  biomarker: BiomarkerType;
  mode: ClassifierMode;
  classifier: Record<string, unknown>;
  classifierLabel: string;
};

export const CLASSIFIER_MODEL_ARCHIVE_EXTENSIONS = ['.tar', '.onnx'] as const;

export const DEFAULT_CLASSIFIER_STATE: ClassifierControlsState = {
  mode: 'ONNX CPU',
  ignoreBefore: '1',
  ignoreAfter: '1',
  device: 'cpu',
  batchSize: '32',
  useSpike: true,
  useEhfo: true,
  localArtifact: '',
  localSpike: '',
  localEhfo: '',
  hubArtifact: '',
  hubSpike: '',
  hubEhfo: ''
};

export const DEFAULT_CLASSIFIER_HUB_CARDS = {
  artifact: 'roychowdhuryresearch/HFO-artifact',
  spike: 'roychowdhuryresearch/HFO-spkHFO',
  ehfo: 'roychowdhuryresearch/HFO-eHFO'
} as const;

export function defaultClassifierPatch(biomarker: BiomarkerType, mode: ClassifierMode): Partial<ClassifierControlsState> {
  if (mode === 'Custom') return { mode };
  if (mode === 'Review only' || biomarker === 'Spike') {
    return { mode: 'Review only', device: 'cpu', batchSize: '32', useSpike: false, useEhfo: false, localArtifact: '', localSpike: '', localEhfo: '', hubArtifact: '', hubSpike: '', hubEhfo: '' };
  }
  if (mode === 'ONNX CPU') {
    return {
      mode,
      device: 'cpu',
      batchSize: '32',
      useSpike: true,
      useEhfo: biomarker === 'HFO',
      localArtifact: '',
      localSpike: '',
      localEhfo: '',
      hubArtifact: '',
      hubSpike: '',
      hubEhfo: ''
    };
  }
  return {
    mode,
    device: mode === 'HF GPU' ? 'cuda:0' : 'cpu',
    batchSize: '32',
    useSpike: true,
    useEhfo: biomarker === 'HFO',
    localArtifact: '',
    localSpike: '',
    localEhfo: '',
    hubArtifact: DEFAULT_CLASSIFIER_HUB_CARDS.artifact,
    hubSpike: DEFAULT_CLASSIFIER_HUB_CARDS.spike,
    hubEhfo: biomarker === 'HFO' ? DEFAULT_CLASSIFIER_HUB_CARDS.ehfo : ''
  };
}

export function ClassifierTab({ biomarker, hasActiveRun, capabilityManifest, state, feedback, onStateChange, onFeedbackChange, onRunClassifier, onOpenModelFile }: { biomarker: BiomarkerType; hasActiveRun: boolean; capabilityManifest: CapabilityManifest | null; state: ClassifierControlsState; feedback: string; onStateChange: (state: ClassifierControlsState) => void; onFeedbackChange: (feedback: string) => void; onRunClassifier: (request: ClassifierRunRequest) => Promise<void> | void; onOpenModelFile: () => Promise<string | null> }) {
  const modes = useMemo(() => classifierModesForBiomarker(biomarker), [biomarker]);
  const spikeReviewOnly = biomarker === 'Spike';
  const gpuCapability = useMemo(() => classifierGpuCapability(capabilityManifest), [capabilityManifest]);
  const gpuAvailable = useMemo(() => classifierGpuAvailable(capabilityManifest), [capabilityManifest]);
  const gpuStatusCopy = gpuAvailable ? (gpuCapability.ui_behavior || 'GPU classifier preset is available for Hugging Face classifier workflows.') : classifierGpuHint(capabilityManifest);
  const gpuStatusLabel = gpuAvailable ? 'GPU ready' : 'GPU unavailable';
  const classifierControlsVisible = biomarker !== 'Spike';
  const customSourcesVisible = classifierControlsVisible && state.mode === 'Custom';
  const showEhfo = biomarker === 'HFO';
  const spikeToggleLabel = biomarker === 'HFO' ? 'Use spk-HFO' : 'Use spike-associated';
  const sourceSummary = useMemo(() => classifierSourceSummary(state, biomarker), [state, biomarker]);
  const classifierSteps = useMemo(() => classifierStepLabels(state, biomarker), [state, biomarker]);
  const stackDisplay = useMemo(() => ({
    artifact: state.localArtifact || state.hubArtifact,
    spike: state.localSpike || state.hubSpike,
    ehfo: state.localEhfo || state.hubEhfo,
    sourceSummary,
    classifierSteps
  }), [classifierSteps, sourceSummary, state.hubArtifact, state.hubEhfo, state.hubSpike, state.localArtifact, state.localEhfo, state.localSpike]);
  const classifierStatusItems = useMemo(() => [
    { label: 'Source', value: classifierSourceSummary(state, biomarker) },
    { label: 'Device', value: normalizeDevice(state.device).toUpperCase() || '--' },
    { label: 'Batch', value: state.batchSize || '--' },
    { label: 'GPU', value: gpuStatusLabel, tone: gpuAvailable ? 'ready' : 'blocked' }
  ], [biomarker, gpuAvailable, gpuStatusLabel, state]);
  const runDisabled = spikeReviewOnly || !hasActiveRun || (state.mode === 'HF GPU' && !gpuAvailable);

  useEffect(() => {
    function applyDefaultPatch(patchState: Partial<ClassifierControlsState>) {
      if (classifierPatchChangesState(state, patchState)) onStateChange({ ...state, ...patchState });
    }

    if (biomarker === 'Spike') applyDefaultPatch({ mode: 'Review only', useSpike: false, useEhfo: false, device: 'cpu' });
    else if (state.mode === 'HF GPU' && !gpuAvailable) {
      applyDefaultPatch(defaultClassifierPatch(biomarker, 'ONNX CPU'));
      onFeedbackChange(classifierGpuHint(capabilityManifest));
      return;
    }
    else if (!modes.includes(state.mode)) applyDefaultPatch(defaultClassifierPatch(biomarker, 'ONNX CPU'));
    else if (state.mode === 'ONNX CPU' || state.mode === 'HF CPU' || state.mode === 'HF GPU') applyDefaultPatch(defaultClassifierPatch(biomarker, state.mode));
    onFeedbackChange(classifierHint(biomarker));
  }, [biomarker, gpuAvailable]);

  function patch(patchState: Partial<ClassifierControlsState>) {
    onStateChange({ ...state, ...patchState });
  }

  function setMode(mode: ClassifierMode) {
    if (mode === 'HF GPU' && !gpuAvailable) {
      onFeedbackChange(classifierGpuHint(capabilityManifest));
      return;
    }
    patch(mode === 'Custom' ? { mode } : defaultClassifierPatch(biomarker, mode));
  }

  function applyClassifier() {
    const errors = validateClassifierState(state, biomarker, gpuAvailable);
    onFeedbackChange(errors.length ? `Validation failed: ${errors.join('; ')}` : `Classifier settings applied for ${biomarker} using ${state.mode}.`);
  }

  function runClassifier() {
    const errors = validateClassifierState(state, biomarker, gpuAvailable);
    if (errors.length) {
      onFeedbackChange(`Validation failed: ${errors.join('; ')}`);
      return;
    }
    if (spikeReviewOnly) {
      onFeedbackChange('Spike mode is review-only.');
      return;
    }
    if (!hasActiveRun) {
      onFeedbackChange('Create or load a detection run before classifying.');
      return;
    }
    const classifier = classifierPayloadFromState(state, biomarker);
    Promise.resolve(onRunClassifier({ biomarker, mode: state.mode, classifier, classifierLabel: `${state.mode} classifier` }))
      .then(() => onFeedbackChange(`${biomarker} classification submitted with ${state.mode}.`))
      .catch((exc) => onFeedbackChange(exc instanceof Error ? exc.message : String(exc)));
  }

  async function chooseLocalModel(key: 'localArtifact' | 'localSpike' | 'localEhfo') {
    const selected = await onOpenModelFile();
    if (selected) {
      patch({ [key]: selected, mode: 'Custom' });
      onFeedbackChange(`Selected classifier model: ${selected}`);
    }
  }

  function setLocalModelPath(key: 'localArtifact' | 'localSpike' | 'localEhfo', value: string) {
    patch({ [key]: value, mode: value ? 'Custom' : state.mode });
  }

  return (
    <div className="tab-content classify-layout" data-testid="workflow-classify-content">
      <header className="workflow-panel-heading classify-panel-heading">
        <h3>Classifier</h3>
        <span className="status-pill">{biomarker}</span>
      </header>
      <div className="classifier-workbench-grid">
        <section className="panel-card classifier-header-card" data-testid="pyqt-classifier_tab">
          <div className="classifier-mode-row" data-testid="pyqt-classifier_preset">
            <div className="classifier-mode-control">
              <label>Preset
                <select data-testid="pyqt-classifier_mode_combo" value={state.mode} disabled={modes.length === 1} onChange={(event) => setMode(event.target.value as ClassifierMode)}>
                  {modes.map((mode) => <option key={mode} value={mode} disabled={mode === 'HF GPU' && !gpuAvailable}>{mode}{mode === 'HF GPU' && !gpuAvailable ? ' (unavailable)' : ''}</option>)}
                </select>
              </label>
            </div>
            <button data-testid="pyqt-classifier_run_button" className="primary-action" disabled={runDisabled} aria-disabled={runDisabled} onClick={runClassifier}>Classify</button>
          </div>
          <p className="helper-copy" data-testid="pyqt-classifier_mode_hint">{classifierHint(biomarker)}</p>
          {biomarker !== 'Spike' && <p className="helper-copy classifier-gpu-copy" data-testid="pyqt-classifier_gpu_status" data-available={gpuAvailable ? 'true' : 'false'}>{gpuStatusCopy}</p>}
          <dl className="classifier-status-list" data-testid="pyqt-classifier_status_summary">
            {classifierStatusItems.map((item) => (
              <div className="classifier-status-item" key={item.label} data-tone={item.tone || 'neutral'}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
          {classifierControlsVisible && <section className="classifier-controls-card" data-testid="pyqt-classifier-controls">
            <div className="classifier-section-heading">
              <h3>Classifier Parameters</h3>
              <span className="status-pill">{state.mode}</span>
            </div>
            <div className="classifier-control-grid">
              <div className="field-grid compact classifier-ignore-grid" data-testid="pyqt-classifier_ignore_frame">
                <label>Before<input data-testid="pyqt-overview_ignore_before_input" value={state.ignoreBefore} onChange={(event) => patch({ ignoreBefore: event.target.value })} /></label>
                <label>After<input data-testid="pyqt-overview_ignore_after_input" value={state.ignoreAfter} onChange={(event) => patch({ ignoreAfter: event.target.value })} /></label>
              </div>
              <div className="field-grid compact classifier-device-grid">
                <label>Device<input data-testid="pyqt-classifier_device_input" readOnly={!customSourcesVisible} data-custom-editable={customSourcesVisible ? 'true' : 'false'} value={state.device} onChange={(event) => patch({ device: event.target.value })} /></label>
                <label>Batch Size<input data-testid="pyqt-classifier_batch_size_input" readOnly={!customSourcesVisible} data-custom-editable={customSourcesVisible ? 'true' : 'false'} value={state.batchSize} onChange={(event) => patch({ batchSize: event.target.value })} /></label>
              </div>
              <div className="classifier-toggle-row" data-testid="pyqt-classifier_toggles">
                <label><input data-testid="pyqt-use_spike_checkbox" type="checkbox" checked={state.useSpike} onChange={(event) => patch({ useSpike: event.target.checked })} /> {spikeToggleLabel}</label>
                {showEhfo && <label><input data-testid="pyqt-use_ehfo_checkbox" type="checkbox" checked={state.useEhfo} onChange={(event) => patch({ useEhfo: event.target.checked })} /> Use eHFO</label>}
              </div>
            </div>
            <div className="button-row">
              <button data-testid="pyqt-default_cpu_button" onClick={() => setMode('ONNX CPU')}>ONNX CPU</button>
              <button data-testid="pyqt-hf_cpu_button" onClick={() => setMode('HF CPU')}>HF CPU</button>
              <button data-testid="pyqt-default_gpu_button" title={classifierGpuHint(capabilityManifest)} onClick={() => setMode('HF GPU')} disabled={spikeReviewOnly || !gpuAvailable}>GPU preset</button>
              <button data-testid="pyqt-classifier_save_button" onClick={applyClassifier}>Apply</button>
            </div>
          </section>}
        </section>

        {customSourcesVisible && <section className="panel-card classifier-source-card" data-testid="pyqt-groupBox" data-visible={customSourcesVisible ? 'true' : 'false'}>
          <h3>Local models</h3>
          <div className="classifier-source-list">
            <ModelPathRow label="Artifact Model" testId="pyqt-classifier_artifact_filename" buttonTestId="pyqt-choose_artifact_model_button" value={state.localArtifact} onChange={(value) => setLocalModelPath('localArtifact', value)} onBrowse={() => chooseLocalModel('localArtifact')} />
            <ModelPathRow label="spk-HFO Model" testId="pyqt-classifier_spike_filename" buttonTestId="pyqt-choose_spike_model_button" value={state.localSpike} onChange={(value) => setLocalModelPath('localSpike', value)} onBrowse={() => chooseLocalModel('localSpike')} />
            {showEhfo && <ModelPathRow label="eHFO Model" testId="pyqt-classifier_ehfo_filename" buttonTestId="pyqt-choose_ehfo_model_button" value={state.localEhfo} onChange={(value) => setLocalModelPath('localEhfo', value)} onBrowse={() => chooseLocalModel('localEhfo')} />}
          </div>
        </section>}

        {customSourcesVisible && <section className="panel-card classifier-source-card" data-testid="pyqt-groupBox_2" data-visible={customSourcesVisible ? 'true' : 'false'}>
          <h3>Hub models</h3>
          <div className="classifier-hub-banner" data-testid="pyqt-image_label" aria-label="Hosted model cards for the artifact, spk-HFO, and eHFO classifiers">
            <strong>Hugging Face model cards</strong>
            <span>Artifact</span>
            <span>spk-HFO</span>
            {showEhfo && <span>eHFO</span>}
            <em>{biomarker} classifier preset stack</em>
          </div>
          <div className="classifier-source-list">
            <ModelCardRow label="Artifact Model" testId="pyqt-classifier_artifact_card_name" value={state.hubArtifact} onChange={(value) => patch({ hubArtifact: value })} />
            <ModelCardRow label="spk-HFO Model" testId="pyqt-classifier_spike_card_name" value={state.hubSpike} onChange={(value) => patch({ hubSpike: value })} />
            {showEhfo && <ModelCardRow label="eHFO Model" testId="pyqt-classifier_ehfo_card_name" value={state.hubEhfo} onChange={(value) => patch({ hubEhfo: value })} />}
          </div>
        </section>}

        <section className="panel-card classifier-stack-card" data-testid="pyqt-classifier_groupbox_4">
          <h3>Classifier stack</h3>
          <dl className="classifier-stack-list">
            <div className="classifier-stack-item classifier-stack-item-path">
              <dt>Artifact</dt>
              <dd><output data-testid="pyqt-overview_artifact_path_display" className="stack-display" title={stackDisplay.artifact || 'File Name...'}>{stackDisplay.artifact || 'File Name...'}</output></dd>
            </div>
            <div className="classifier-stack-item classifier-stack-item-path">
              <dt>spk-HFO</dt>
              <dd><output data-testid="pyqt-overview_spike_path_display" className="stack-display" title={stackDisplay.spike || 'File Name...'}>{stackDisplay.spike || 'File Name...'}</output></dd>
            </div>
            {showEhfo && <div className="classifier-stack-item classifier-stack-item-path">
              <dt>eHFO</dt>
              <dd><output data-testid="pyqt-overview_ehfo_path_display" className="stack-display" title={stackDisplay.ehfo || 'File Name...'}>{stackDisplay.ehfo || 'File Name...'}</output></dd>
            </div>}
            <div className="classifier-stack-item">
              <dt>Device</dt>
              <dd><output data-testid="pyqt-overview_device_display" className="stack-display">{state.device}</output></dd>
            </div>
            <div className="classifier-stack-item">
              <dt>Batch</dt>
              <dd><output data-testid="pyqt-overview_batch_size_display" className="stack-display">{state.batchSize}</output></dd>
            </div>
            <div className="classifier-stack-item classifier-stack-item-source">
              <dt>Source</dt>
              <dd><output data-testid="pyqt-classifier_source_preference_display" className="stack-display">{stackDisplay.sourceSummary}</output></dd>
            </div>
            <div className="classifier-stack-item classifier-stack-item-steps">
              <dt>Steps</dt>
              <dd><output data-testid="pyqt-classifier_steps_display" className="stack-display">{stackDisplay.classifierSteps}</output></dd>
            </div>
          </dl>
          <p className="status-line" data-testid="pyqt-classifier_feedback">{feedback}</p>
        </section>
      </div>
    </div>
  );
}

export function classifierPayloadFromState(state: ClassifierControlsState, biomarker?: BiomarkerType): Record<string, unknown> {
  const modelType = state.mode === 'ONNX CPU' ? 'onnx_cpu' : state.mode === 'HF GPU' ? 'default_gpu' : state.mode === 'Custom' ? 'custom' : 'default_cpu';
  const sourcePreference = state.mode === 'Custom' ? 'local' : (state.mode === 'HF CPU' || state.mode === 'HF GPU') ? 'huggingface' : undefined;
  // eHFO is an HFO-ONLY classifier stage. Never emit it for a non-HFO run: a stale
  // useEhfo/hubEhfo (e.g. left over from Custom mode before a HFO->Spindle biomarker
  // switch, which the eHFO controls are hidden for) would otherwise run the HFO eHFO
  // model against Spindle/Spike events. When biomarker is unknown, preserve prior behavior.
  const ehfoAllowed = biomarker === undefined ? state.useEhfo : (biomarker === 'HFO' && state.useEhfo);
  const steps = ['artifact', state.useSpike && 'spike', ehfoAllowed && 'ehfo'].filter(Boolean);
  const localSourcesAllowed = state.mode === 'Custom';
  const hubSourcesAllowed = state.mode === 'Custom' || state.mode === 'HF CPU' || state.mode === 'HF GPU';
  const artifactLocalSource = localClassifierSourcePayload('artifact', localSourcesAllowed ? state.localArtifact : '');
  const spikeLocalSource = localClassifierSourcePayload('spike', localSourcesAllowed ? state.localSpike : '');
  const ehfoLocalSource = localClassifierSourcePayload('ehfo', localSourcesAllowed && ehfoAllowed ? state.localEhfo : '');
  return {
    enabled: true,
    ...artifactLocalSource,
    ...spikeLocalSource,
    ...ehfoLocalSource,
    artifact_card: hubSourcesAllowed ? (state.hubArtifact || null) : null,
    spike_card: hubSourcesAllowed ? (state.hubSpike || null) : null,
    ehfo_card: hubSourcesAllowed && ehfoAllowed ? (state.hubEhfo || null) : null,
    use_spike: state.useSpike,
    use_ehfo: ehfoAllowed,
    device: normalizeDevice(state.device),
    batch_size: Math.max(1, Math.round(Number(state.batchSize) || 1)),
    model_type: modelType,
    ...(sourcePreference ? { source_preference: sourcePreference } : {}),
    ignore_region: [Number(state.ignoreBefore) || 0, Number(state.ignoreAfter) || 0],
    steps
  };
}

export function classifierPatchChangesState(state: ClassifierControlsState, patchState: Partial<ClassifierControlsState>): boolean {
  return (Object.entries(patchState) as Array<[keyof ClassifierControlsState, ClassifierControlsState[keyof ClassifierControlsState]]>)
    .some(([key, value]) => state[key] !== value);
}

export function classifierSourceSummary(state: ClassifierControlsState, biomarker: BiomarkerType): string {
  if (biomarker === 'Spike' || state.mode === 'Review only') return 'Review only';
  if (state.mode === 'ONNX CPU') return 'Bundled ONNX';
  if (state.mode === 'Custom') {
    const localSummary = localClassifierSourceSummary(state, biomarker);
    if (localSummary) return localSummary;
    if (state.hubArtifact || state.hubSpike || state.hubEhfo) return 'Custom hub';
    return 'Custom';
  }
  return state.mode;
}

export function classifierStepLabels(state: ClassifierControlsState, biomarker: BiomarkerType): string {
  if (biomarker === 'Spike' || state.mode === 'Review only') return 'Review only';
  return ['Artifact', state.useSpike && (biomarker === 'HFO' ? 'spk-HFO' : 'spike-associated'), biomarker === 'HFO' && state.useEhfo && 'eHFO'].filter(Boolean).join(' → ');
}

export function normalizeDevice(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw === 'gpu' || raw === 'cuda') return 'cuda:0';
  if (raw === 'cpu') return 'cpu';
  return raw || 'cpu';
}

function ModelPathRow({ label, testId, buttonTestId, value, onChange, onBrowse }: { label: string; testId: string; buttonTestId: string; value: string; onChange: (value: string) => void; onBrowse: () => void }) {
  return (
    <div className="model-source-row">
      <label>{label}<input data-testid={testId} placeholder="File Name..." value={value} onChange={(event) => onChange(event.target.value)} /></label>
      <button data-testid={buttonTestId} onClick={onBrowse}>Choose File</button>
    </div>
  );
}

function ModelCardRow({ label, testId, value, onChange }: { label: string; testId: string; value: string; onChange: (value: string) => void }) {
  return <label>{label}<input data-testid={testId} placeholder="Model Card Name..." value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

export function classifierModesForBiomarker(biomarker: BiomarkerType): ClassifierMode[] {
  return biomarker === 'Spike' ? ['Review only'] : ['ONNX CPU', 'HF CPU', 'HF GPU', 'Custom'];
}

export function classifierHint(biomarker: BiomarkerType): string {
  if (biomarker === 'Spindle') return 'Preset model stack ready for active-run spindle classification.';
  if (biomarker === 'Spike') return 'Spike runs are available for detection and review.';
  return 'Preset model stack ready for active-run HFO classification.';
}

export function validateClassifierState(state: ClassifierControlsState, biomarker: BiomarkerType, gpuAvailable = true): string[] {
  const errors: string[] = [];
  if (state.mode === 'HF GPU' && !gpuAvailable) errors.push('GPU classifier preset is unavailable');
  for (const [label, value] of [['Before', state.ignoreBefore], ['After', state.ignoreAfter], ['Batch Size', state.batchSize]]) {
    if (!Number.isFinite(Number(value))) errors.push(`${label} must be numeric`);
  }
  for (const [label, value] of [['Artifact Model', state.localArtifact], ['spk-HFO Model', state.localSpike], ['eHFO Model', state.localEhfo]]) {
    const archiveError = validateLocalClassifierArchive(value, label);
    if (archiveError) errors.push(archiveError);
  }
  if (biomarker !== 'Spike' && state.mode === 'Custom' && !state.localArtifact && !state.localSpike && !state.localEhfo && !state.hubArtifact && !state.hubSpike && !state.hubEhfo) {
    errors.push('Custom mode needs at least one model source');
  }
  return errors;
}

export function classifierGpuCapability(manifest: CapabilityManifest | null): NonNullable<NonNullable<CapabilityManifest['classifier']>['gpu']> {
  return manifest?.classifier?.gpu || {};
}

export function classifierGpuAvailable(manifest: CapabilityManifest | null): boolean {
  const gpu = classifierGpuCapability(manifest);
  return gpu.available !== false;
}

export function classifierGpuHint(manifest: CapabilityManifest | null): string {
  const gpu = classifierGpuCapability(manifest);
  return gpu.install_hint || gpu.ui_behavior || 'GPU preset unavailable.';
}

export function validateLocalClassifierArchive(path: string, label: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (CLASSIFIER_MODEL_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null;
  return `${label} must be a .tar archive or .onnx classifier model`;
}

function localClassifierSourcePayload(prefix: 'artifact' | 'spike' | 'ehfo', path: string): Record<string, string | null> {
  const trimmed = path.trim();
  const legacyKey = `${prefix}_path`;
  const onnxKey = `${prefix}_onnx`;
  if (!trimmed) return { [legacyKey]: null, [onnxKey]: null };
  return trimmed.toLowerCase().endsWith('.onnx')
    ? { [legacyKey]: null, [onnxKey]: trimmed }
    : { [legacyKey]: trimmed, [onnxKey]: null };
}

function localClassifierSourceSummary(state: ClassifierControlsState, biomarker: BiomarkerType): string | null {
  const paths = [
    state.localArtifact,
    state.localSpike,
    biomarker === 'HFO' ? state.localEhfo : ''
  ].map((path) => path.trim()).filter(Boolean);
  if (!paths.length) return null;
  const hasOnnx = paths.some((path) => path.toLowerCase().endsWith('.onnx'));
  const hasArchive = paths.some((path) => !path.toLowerCase().endsWith('.onnx'));
  if (hasOnnx && hasArchive) return 'Custom local mixed';
  return hasOnnx ? 'Custom local ONNX' : 'Custom local archive';
}
