export type QuickDetectionBiomarker = 'HFO' | 'Spindle' | 'Spike';
export type QuickRecordingMetadata = { sample_freq?: number; sampling_frequency?: number; sample_frequency_hz?: number };

export type QuickDetectionDetector = 'MNI' | 'STE' | 'HIL' | 'RMS' | 'LineLength' | 'YASA' | 'LSM' | 'A7' | 'MOLLE' | 'RMS/LL';

export type QuickDetectionField = { key: string; label: string; unit?: string; testId: string; defaultValue?: string; placeholder?: string; type?: 'path' };

export type QuickDetectionState = {
  filter: Record<'fp' | 'fs' | 'rp' | 'rs', string>;
  classifier: {
    useClassifier: boolean;
    artifactModel: string;
    spikeModel: string;
    ehfoModel: string;
    useSpike: boolean;
    useEhfo: boolean;
    ignoreBefore: string;
    ignoreAfter: string;
    device: string;
    batchSize: string;
  };
  saveAs: { excel: boolean; npz: boolean };
  nJobs: number;
  biomarker: QuickDetectionBiomarker;
  detector: QuickDetectionDetector;
  detectorValues: Record<string, string>;
};

export const DETECTOR_FIELDS: Record<QuickDetectionDetector, QuickDetectionField[]> = {
  MNI: [
    { key: 'mni_epoch_time', label: 'Epoch Time', unit: 'Sec', testId: 'pyqt-qd_mni_epoch_time_input', defaultValue: '10' },
    { key: 'mni_baseline_window', label: 'Baseline Window', unit: 'Sec', testId: 'pyqt-qd_mni_baseline_window_input', defaultValue: '0.125' },
    { key: 'mni_epoch_chf', label: 'Epoch CHF', unit: 'Sec', testId: 'pyqt-qd_mni_epoch_chf_input', defaultValue: '60' },
    { key: 'mni_baseline_shift', label: 'Baseline Shift', testId: 'pyqt-qd_mni_baseline_shift_input', defaultValue: '0.5' },
    { key: 'mni_chf_percentage', label: 'CHF Percentage', unit: '%', testId: 'pyqt-qd_mni_chf_percentage_input', defaultValue: '0.95' },
    { key: 'mni_baseline_threshold', label: 'Baseline Threshold', testId: 'pyqt-qd_mni_baseline_threshold_input', defaultValue: '0.67' },
    { key: 'mni_min_window', label: 'min Window', unit: 'Sec', testId: 'pyqt-qd_mni_min_window_input', defaultValue: '0.01' },
    { key: 'mni_threshold_percentage', label: 'Threshold Perc.', unit: '%', testId: 'pyqt-qd_mni_threshold_percentage_input', defaultValue: '99.9999' },
    { key: 'mni_min_gap_time', label: 'min Gap', unit: 'Sec', testId: 'pyqt-qd_mni_min_gap_time_input', defaultValue: '0.01' },
    { key: 'mni_baseline_time', label: 'Baseline Min Time', testId: 'pyqt-qd_mni_baseline_time_input', defaultValue: '5' }
  ],
  STE: [
    // Defaults mirror PyQt ParamSTE (param_detector.py): min_osc=6, rms_thres=5, rms_window=3e-3,
    // epoch_len=600, min_window=6e-3, peak_thres=3, min_gap=10e-3. rms/min_window/min_gap render in ms.
    { key: 'ste_min_oscillation', label: 'Min Oscillations', testId: 'pyqt-qd_ste_min_oscillation_input', defaultValue: '6' },
    { key: 'ste_rms_threshold', label: 'RMS Threshold', testId: 'pyqt-qd_ste_rms_threshold_input', defaultValue: '5' },
    { key: 'ste_rms_window', label: 'RMS Window', unit: 'ms', testId: 'pyqt-qd_ste_rms_window_input', defaultValue: '3' },
    { key: 'ste_epoch_length', label: 'Epoch Length', testId: 'pyqt-qd_ste_epoch_length_input', defaultValue: '600' },
    { key: 'ste_min_window', label: 'Min Window', unit: 'ms', testId: 'pyqt-qd_ste_min_window_input', defaultValue: '6' },
    { key: 'ste_peak_threshold', label: 'Peak Threshold', testId: 'pyqt-qd_ste_peak_threshold_input', defaultValue: '3' },
    { key: 'ste_min_gap', label: 'Min Gap', unit: 'ms', testId: 'pyqt-qd_ste_min_gap_input', defaultValue: '10' }
  ],
  HIL: [
    // Defaults mirror PyQt ParamHIL: sd_threshold=5, pass_band=80, sample_freq=2000,
    // min_window=0.01, epoch_time=3600, stop_band=500.
    { key: 'hil_sd_threshold', label: 'SD Threshold', testId: 'pyqt-qd_hil_sd_threshold_input', defaultValue: '5' },
    { key: 'hil_pass_band', label: 'Pass Band', unit: 'Hz', testId: 'pyqt-qd_hil_pass_band_input', defaultValue: '80' },
    { key: 'hil_sample_freq', label: 'Sample Frequency', unit: 'Hz', testId: 'pyqt-qd_hil_sample_freq_input', defaultValue: '2000' },
    { key: 'hil_min_window', label: 'Min Window', unit: 'sec', testId: 'pyqt-qd_hil_min_window_input', defaultValue: '0.01' },
    { key: 'hil_epoch_time', label: 'Epoch Time', unit: 'sec', testId: 'pyqt-qd_hil_epoch_time_input', defaultValue: '3600' },
    { key: 'hil_stop_band', label: 'Stop Band', unit: 'Hz', testId: 'pyqt-qd_hil_stop_band_input', defaultValue: '500' }
  ],
  RMS: [
    { key: 'rms_window', label: 'RMS window', unit: 's', testId: 'pyqt-qd_rms_rms_window_input', defaultValue: '0.003' },
    { key: 'min_window', label: 'Min duration', unit: 's', testId: 'pyqt-qd_rms_min_window_input', defaultValue: '0.006' },
    { key: 'max_window', label: 'Max duration', unit: 's', testId: 'pyqt-qd_rms_max_window_input', defaultValue: '0.2' },
    { key: 'min_gap', label: 'Merge gap', unit: 's', testId: 'pyqt-qd_rms_min_gap_input', defaultValue: '0.01' },
    { key: 'threshold', label: 'RMS threshold', testId: 'pyqt-qd_rms_threshold_input', defaultValue: '5.0' },
    { key: 'peak_threshold', label: 'Peak threshold', testId: 'pyqt-qd_rms_peak_threshold_input', defaultValue: '3.0' }
  ],
  LineLength: [
    { key: 'll_window', label: 'LL window', unit: 's', testId: 'pyqt-qd_linelength_ll_window_input', defaultValue: '0.01' },
    { key: 'min_window', label: 'Min duration', unit: 's', testId: 'pyqt-qd_linelength_min_window_input', defaultValue: '0.006' },
    { key: 'max_window', label: 'Max duration', unit: 's', testId: 'pyqt-qd_linelength_max_window_input', defaultValue: '0.2' },
    { key: 'min_gap', label: 'Merge gap', unit: 's', testId: 'pyqt-qd_linelength_min_gap_input', defaultValue: '0.01' },
    { key: 'threshold', label: 'LL threshold', testId: 'pyqt-qd_linelength_threshold_input', defaultValue: '5.0' },
    { key: 'peak_threshold', label: 'Peak threshold', testId: 'pyqt-qd_linelength_peak_threshold_input', defaultValue: '3.0' }
  ],
  YASA: [
    { key: 'freq_sp_low', label: 'Spindle low', unit: 'Hz', testId: 'pyqt-qd_yasa_freq_sp_low_input', defaultValue: '12' },
    { key: 'freq_sp_high', label: 'Spindle high', unit: 'Hz', testId: 'pyqt-qd_yasa_freq_sp_high_input', defaultValue: '15' },
    { key: 'freq_broad_low', label: 'Broad low', unit: 'Hz', testId: 'pyqt-qd_yasa_freq_broad_low_input', defaultValue: '1' },
    { key: 'freq_broad_high', label: 'Broad high', unit: 'Hz', testId: 'pyqt-qd_yasa_freq_broad_high_input', defaultValue: '30' },
    { key: 'duration_low', label: 'Duration min', unit: 's', testId: 'pyqt-qd_yasa_duration_low_input', defaultValue: '0.5' },
    { key: 'duration_high', label: 'Duration max', unit: 's', testId: 'pyqt-qd_yasa_duration_high_input', defaultValue: '2.0' },
    { key: 'min_distance', label: 'Min distance', unit: 'ms', testId: 'pyqt-qd_yasa_min_distance_input', defaultValue: '500' },
    { key: 'rel_pow', label: 'Rel power', testId: 'pyqt-qd_yasa_rel_pow_input', defaultValue: '0.2' },
    { key: 'corr', label: 'Correlation', testId: 'pyqt-qd_yasa_corr_input', defaultValue: '0.65' },
    { key: 'rms', label: 'RMS threshold', testId: 'pyqt-qd_yasa_rms_input', defaultValue: '1.5' }
  ],
  LSM: [
    { key: 'parameter_file', label: 'Parameter file', unit: '.mat/.json', testId: 'pyqt-qd_lsm_parameter_file_input', placeholder: 'Choose a Kramer .mat/.json parameter file', type: 'path' },
    { key: 'prob_threshold', label: 'Probability', testId: 'pyqt-qd_lsm_prob_threshold_input', defaultValue: '0.95' },
    { key: 'min_spindle_duration', label: 'Min duration', unit: 's', testId: 'pyqt-qd_lsm_min_spindle_duration_input', defaultValue: '0.5' },
    { key: 'spindle_separation_threshold', label: 'Separation', unit: 's', testId: 'pyqt-qd_lsm_spindle_separation_threshold_input', defaultValue: '1.0' },
    { key: 'min_peak_prominence', label: 'Min prominence', unit: 'V', testId: 'pyqt-qd_lsm_min_peak_prominence_input', defaultValue: '0.000002' },
    { key: 'start_frequency', label: 'Start freq.', unit: 'Hz', testId: 'pyqt-qd_lsm_start_frequency_input', placeholder: 'Optional' },
    { key: 'stop_frequency', label: 'Stop freq.', unit: 'Hz', testId: 'pyqt-qd_lsm_stop_frequency_input', placeholder: 'Optional' }
  ],
  A7: [
    { key: 'freq_sp_low', label: 'Spindle low', unit: 'Hz', testId: 'pyqt-qd_a7_freq_sp_low_input', defaultValue: '11' },
    { key: 'freq_sp_high', label: 'Spindle high', unit: 'Hz', testId: 'pyqt-qd_a7_freq_sp_high_input', defaultValue: '16' },
    { key: 'freq_broad_low', label: 'Broad low', unit: 'Hz', testId: 'pyqt-qd_a7_freq_broad_low_input', defaultValue: '1' },
    { key: 'freq_broad_high', label: 'Broad high', unit: 'Hz', testId: 'pyqt-qd_a7_freq_broad_high_input', defaultValue: '30' },
    { key: 'duration_low', label: 'Duration min', unit: 's', testId: 'pyqt-qd_a7_duration_low_input', defaultValue: '0.5' },
    { key: 'duration_high', label: 'Duration max', unit: 's', testId: 'pyqt-qd_a7_duration_high_input', defaultValue: '2.5' },
    { key: 'min_distance', label: 'Min distance', unit: 's', testId: 'pyqt-qd_a7_min_distance_input', defaultValue: '0.5' },
    { key: 'smooth_window', label: 'Smooth window', unit: 's', testId: 'pyqt-qd_a7_smooth_window_input', defaultValue: '0.2' },
    { key: 'rms_threshold', label: 'RMS threshold', testId: 'pyqt-qd_a7_rms_threshold_input', defaultValue: '1.5' },
    { key: 'relative_power_threshold', label: 'Rel power', testId: 'pyqt-qd_a7_relative_power_threshold_input', defaultValue: '0.2' },
    { key: 'correlation_threshold', label: 'Correlation', testId: 'pyqt-qd_a7_correlation_threshold_input', defaultValue: '0.65' }
  ],
  MOLLE: [
    { key: 'freq_sp_low', label: 'Spindle low', unit: 'Hz', testId: 'pyqt-qd_molle_freq_sp_low_input', defaultValue: '12' },
    { key: 'freq_sp_high', label: 'Spindle high', unit: 'Hz', testId: 'pyqt-qd_molle_freq_sp_high_input', defaultValue: '15' },
    { key: 'duration_low', label: 'Duration min', unit: 's', testId: 'pyqt-qd_molle_duration_low_input', defaultValue: '0.5' },
    { key: 'duration_high', label: 'Duration max', unit: 's', testId: 'pyqt-qd_molle_duration_high_input', defaultValue: '3.0' },
    { key: 'min_distance', label: 'Min distance', unit: 's', testId: 'pyqt-qd_molle_min_distance_input', defaultValue: '0.5' },
    { key: 'smooth_window', label: 'Smooth window', unit: 's', testId: 'pyqt-qd_molle_smooth_window_input', defaultValue: '0.2' },
    { key: 'rms_threshold', label: 'RMS threshold', testId: 'pyqt-qd_molle_rms_threshold_input', defaultValue: '1.5' }
  ],
  'RMS/LL': [
    // Defaults mirror PyQt ParamSpikeRMSLL: rms_window=0.02, ll_window=0.01, min_window=0.015,
    // max_window=0.05, min_gap=0.08, rms_thres=5.0, ll_thres=5.0, peak_thres=6.0.
    { key: 'rms_window', label: 'RMS window', unit: 's', testId: 'pyqt-qd_rms_ll_rms_window_input', defaultValue: '0.02' },
    { key: 'll_window', label: 'LL window', unit: 's', testId: 'pyqt-qd_rms_ll_ll_window_input', defaultValue: '0.01' },
    { key: 'min_window', label: 'Min duration', unit: 's', testId: 'pyqt-qd_rms_ll_min_window_input', defaultValue: '0.015' },
    { key: 'max_window', label: 'Max duration', unit: 's', testId: 'pyqt-qd_rms_ll_max_window_input', defaultValue: '0.05' },
    { key: 'min_gap', label: 'Merge gap', unit: 's', testId: 'pyqt-qd_rms_ll_min_gap_input', defaultValue: '0.08' },
    { key: 'rms_thres', label: 'RMS threshold', testId: 'pyqt-qd_rms_ll_rms_thres_input', defaultValue: '5.0' },
    { key: 'll_thres', label: 'LL threshold', testId: 'pyqt-qd_rms_ll_ll_thres_input', defaultValue: '5.0' },
    { key: 'peak_thres', label: 'Peak threshold', testId: 'pyqt-qd_rms_ll_peak_thres_input', defaultValue: '6.0' }
  ]
};

export const QUICK_DETECTION_DETECTORS_BY_BIOMARKER: Record<QuickDetectionBiomarker, QuickDetectionDetector[]> = {
  HFO: ['MNI', 'STE', 'HIL', 'RMS', 'LineLength'],
  Spindle: ['YASA', 'LSM', 'A7', 'MOLLE'],
  Spike: ['RMS/LL']
};

export const DETECTOR_CARD_TEST_IDS: Record<QuickDetectionDetector, string> = {
  MNI: 'pyqt-qd_MNI_detector',
  STE: 'pyqt-qd_STE_detector',
  HIL: 'pyqt-qd_HIL_detector',
  RMS: 'pyqt-qd_RMS_detector',
  LineLength: 'pyqt-qd_LineLength_detector',
  YASA: 'pyqt-qd_YASA_detector',
  LSM: 'pyqt-qd_LSM_detector',
  A7: 'pyqt-qd_A7_detector',
  MOLLE: 'pyqt-qd_MOLLE_detector',
  'RMS/LL': 'pyqt-qd_RMS_LL_detector'
};

export const QUICK_DETECTION_DEFAULT_FIELD_MAP: Record<QuickDetectionDetector, Record<string, string>> = {
  MNI: {
    epoch_time: 'mni_epoch_time',
    baseline_window: 'mni_baseline_window',
    epoch_chf: 'mni_epoch_chf',
    baseline_shift: 'mni_baseline_shift',
    chf_percentage: 'mni_chf_percentage',
    baseline_threshold: 'mni_baseline_threshold',
    min_window: 'mni_min_window',
    threshold_percentage: 'mni_threshold_percentage',
    min_gap_time: 'mni_min_gap_time',
    baseline_min_time: 'mni_baseline_time'
  },
  STE: {
    min_oscillation: 'ste_min_oscillation',
    rms_threshold: 'ste_rms_threshold',
    rms_window: 'ste_rms_window',
    epoch_length: 'ste_epoch_length',
    min_window: 'ste_min_window',
    peak_threshold: 'ste_peak_threshold',
    min_gap: 'ste_min_gap'
  },
  HIL: {
    sd_threshold: 'hil_sd_threshold',
    pass_band: 'hil_pass_band',
    sample_freq: 'hil_sample_freq',
    min_window: 'hil_min_window',
    epoch_time: 'hil_epoch_time',
    stop_band: 'hil_stop_band'
  },
  RMS: {
    window: 'rms_window',
    min_duration: 'min_window',
    max_duration: 'max_window',
    min_gap: 'min_gap',
    threshold: 'threshold',
    peak_threshold: 'peak_threshold'
  },
  LineLength: {
    window: 'll_window',
    min_duration: 'min_window',
    max_duration: 'max_window',
    min_gap: 'min_gap',
    threshold: 'threshold',
    peak_threshold: 'peak_threshold'
  },
  YASA: {
    freq_sp_low: 'freq_sp_low',
    freq_sp_high: 'freq_sp_high',
    freq_broad_low: 'freq_broad_low',
    freq_broad_high: 'freq_broad_high',
    duration_low: 'duration_low',
    duration_high: 'duration_high',
    min_distance: 'min_distance',
    rel_power: 'rel_pow',
    correlation: 'corr',
    rms: 'rms'
  },
  LSM: {
    parameter_file: 'parameter_file',
    probability: 'prob_threshold',
    min_duration: 'min_spindle_duration',
    separation: 'spindle_separation_threshold',
    min_prominence: 'min_peak_prominence',
    start_frequency: 'start_frequency',
    stop_frequency: 'stop_frequency'
  },
  A7: {
    freq_low: 'freq_sp_low',
    freq_high: 'freq_sp_high',
    broad_low: 'freq_broad_low',
    broad_high: 'freq_broad_high',
    duration_low: 'duration_low',
    duration_high: 'duration_high',
    min_distance: 'min_distance',
    smooth_window: 'smooth_window',
    rms_threshold: 'rms_threshold',
    relative_power_threshold: 'relative_power_threshold',
    correlation_threshold: 'correlation_threshold'
  },
  MOLLE: {
    freq_low: 'freq_sp_low',
    freq_high: 'freq_sp_high',
    duration_low: 'duration_low',
    duration_high: 'duration_high',
    min_distance: 'min_distance',
    smooth_window: 'smooth_window',
    rms_threshold: 'rms_threshold'
  },
  'RMS/LL': {
    rms_window: 'rms_window',
    ll_window: 'll_window',
    min_duration: 'min_window',
    max_duration: 'max_window',
    min_gap: 'min_gap',
    rms_threshold: 'rms_thres',
    ll_threshold: 'll_thres',
    peak_threshold: 'peak_thres'
  }
};

export type DetectorDefaultsResult = {
  status?: string;
  source?: string;
  detector?: string;
  sample_freq?: number;
  ui_values?: Record<string, unknown>;
};

export const DEFAULT_QD_STATE: QuickDetectionState = {
  filter: { fp: '80', fs: '500', rp: '0.5', rs: '93' },
  classifier: {
    useClassifier: true,
    artifactModel: 'No model selected',
    spikeModel: 'No model selected',
    ehfoModel: 'No model selected',
    useSpike: true,
    useEhfo: true,
    ignoreBefore: '1',
    ignoreAfter: '1',
    device: 'CPU',
    batchSize: '32'
  },
  saveAs: { excel: false, npz: true },
  nJobs: 1,
  biomarker: 'HFO',
  detector: 'MNI',
  detectorValues: quickDetectionAllDefaultValues()
};

export function quickDetectionSampleFrequency(metadata: QuickRecordingMetadata | null): number | undefined {
  const value = metadata?.sample_freq ?? metadata?.sampling_frequency ?? metadata?.sample_frequency_hz;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

export function quickDetectionDefaultValues(detector: QuickDetectionDetector, values: Record<string, unknown> | undefined): Record<string, string> {
  const fieldMap = QUICK_DETECTION_DEFAULT_FIELD_MAP[detector];
  const defaults: Record<string, string> = quickDetectionFieldDefaultValues(detector);
  if (!Object.keys(fieldMap).length) {
    for (const [key, value] of Object.entries(values || {})) {
      if (key in defaults || DETECTOR_FIELDS[detector].some((field) => field.key === key)) defaults[key] = quickDefaultDisplayValue(detector, key, value);
    }
    return defaults;
  }
  for (const [backendKey, targetKey] of Object.entries(fieldMap)) {
    if (!values || !(backendKey in values)) continue;
    defaults[targetKey] = quickDefaultDisplayValue(detector, targetKey, values[backendKey]);
  }
  return defaults;
}

export function quickDetectionFieldDefaultValues(detector: QuickDetectionDetector): Record<string, string> {
  return Object.fromEntries(DETECTOR_FIELDS[detector].map((field) => [field.key, field.defaultValue || '']));
}

export function quickDetectionAllDefaultValues(): Record<string, string> {
  return Object.assign({}, ...Object.keys(DETECTOR_FIELDS).map((detector) => quickDetectionFieldDefaultValues(detector as QuickDetectionDetector)));
}

export function mergeQuickDetectorDefaults(currentValues: Record<string, string>, detector: QuickDetectionDetector, defaults: Record<string, string>): Record<string, string> {
  const next = { ...currentValues };
  for (const field of DETECTOR_FIELDS[detector]) {
    const current = next[field.key];
    const fallback = field.defaultValue || '';
    if (current == null || current === '' || current === fallback) next[field.key] = defaults[field.key] ?? fallback;
  }
  return next;
}

export function quickDetectionDetectorsForBiomarker(biomarker: QuickDetectionBiomarker): QuickDetectionDetector[] {
  return QUICK_DETECTION_DETECTORS_BY_BIOMARKER[biomarker];
}

export function quickDetectionDefaultDetectorForBiomarker(biomarker: QuickDetectionBiomarker): QuickDetectionDetector {
  if (biomarker === 'Spindle') return 'YASA';
  if (biomarker === 'Spike') return 'RMS/LL';
  return 'MNI';
}

function pyqtFilterStopBandLimit(nyquist: number): number {
  // PyQt quick_detection.py _filter_stop_band_limit (1119-1124).
  if (nyquist <= 0) return 0;
  const filterSpace = 0.5;
  return Math.max(0, Math.min(nyquist * 0.99 - 0.1, nyquist - filterSpace - 0.1));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * PyQt quick_detection.py `_default_filter_param_for_biomarker` + `_recommended_filter_param`:
 * switching the biomarker retunes the filter band. Base bands: HFO ParamFilter() (80/500),
 * Spike ParamFilter(fp=4, fs=80), Spindle ParamFilterSpindle() (1/30); rp/rs stay 0.5/93.
 * When the recording sample rate is known, the stop band is clamped below the Nyquist
 * frequency and the pass band keeps a gap — so low-sample-rate recordings get a valid seeded
 * band (e.g. fs=98.9 at 200 Hz) instead of the raw 80/500 that would fail Nyquist validation.
 */
export function quickDetectionDefaultFilterForBiomarker(biomarker: QuickDetectionBiomarker, sampleFreqHz?: number): Record<'fp' | 'fs' | 'rp' | 'rs', string> {
  const base = biomarker === 'Spindle' ? { fp: 1, fs: 30 } : biomarker === 'Spike' ? { fp: 4, fs: 80 } : { fp: 80, fs: 500 };
  let fp = base.fp;
  let fs = base.fs;
  if (sampleFreqHz && sampleFreqHz > 0) {
    const nyquist = sampleFreqHz / 2;
    const stopBand = Math.min(base.fs, Math.max(1.1, pyqtFilterStopBandLimit(nyquist)));
    const preferredGap = Math.max(5, stopBand * 0.15);
    let passBand = Math.min(base.fp, stopBand - preferredGap);
    if (passBand <= 0) passBand = Math.max(1, stopBand * 0.8);
    passBand = Math.min(passBand, stopBand - 0.1);
    passBand = Math.max(1, passBand);
    if (passBand >= stopBand) passBand = Math.max(1, stopBand - 0.1);
    fp = round3(passBand);
    fs = round3(stopBand);
  }
  return { fp: String(fp), fs: String(fs), rp: '0.5', rs: '93' };
}

export function quickDefaultDisplayValue(detector: QuickDetectionDetector, targetKey: string, value: unknown): string {
  if (value == null) return '';
  if (detector === 'STE' && ['ste_rms_window', 'ste_min_window', 'ste_min_gap'].includes(targetKey)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return String(Math.round(numeric * 1000));
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}


export type DetectorParamValue = number | string | [number, number] | null;

export function numericValue(values: Record<string, string>, key: string): number | undefined {
  const raw = values[key];
  if (raw == null || String(raw).trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function percentFraction(values: Record<string, string>, key: string): number | undefined {
  const value = numericValue(values, key);
  if (value == null) return undefined;
  return value > 1 ? value / 100 : value;
}

export function millisecondsToSeconds(values: Record<string, string>, key: string): number | undefined {
  const value = numericValue(values, key);
  return value == null ? undefined : value / 1000;
}

export function pair(values: Record<string, string>, left: string, right: string): [number, number] | undefined {
  const l = numericValue(values, left);
  const r = numericValue(values, right);
  return l == null || r == null ? undefined : [l, r];
}

export function definedParams(params: Record<string, DetectorParamValue | undefined>): Record<string, DetectorParamValue> {
  const result: Record<string, DetectorParamValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function quickDetectionDetectorParams(detector: QuickDetectionDetector, values: Record<string, string>): Record<string, DetectorParamValue> {
  if (detector === 'MNI') return definedParams({
    epoch_time: numericValue(values, 'mni_epoch_time'),
    base_seg: numericValue(values, 'mni_baseline_window'),
    epo_CHF: numericValue(values, 'mni_epoch_chf'),
    base_shift: numericValue(values, 'mni_baseline_shift'),
    per_CHF: percentFraction(values, 'mni_chf_percentage'),
    base_thrd: numericValue(values, 'mni_baseline_threshold'),
    min_win: numericValue(values, 'mni_min_window'),
    thrd_perc: percentFraction(values, 'mni_threshold_percentage'),
    min_gap: numericValue(values, 'mni_min_gap_time'),
    base_min: numericValue(values, 'mni_baseline_time')
  });
  if (detector === 'STE') return definedParams({
    min_osc: numericValue(values, 'ste_min_oscillation'),
    rms_thres: numericValue(values, 'ste_rms_threshold'),
    rms_window: millisecondsToSeconds(values, 'ste_rms_window'),
    epoch_len: numericValue(values, 'ste_epoch_length'),
    min_window: millisecondsToSeconds(values, 'ste_min_window'),
    peak_thres: numericValue(values, 'ste_peak_threshold'),
    min_gap: millisecondsToSeconds(values, 'ste_min_gap')
  });
  if (detector === 'HIL') return definedParams({
    sd_threshold: numericValue(values, 'hil_sd_threshold'),
    pass_band: numericValue(values, 'hil_pass_band'),
    sample_freq: numericValue(values, 'hil_sample_freq'),
    min_window: numericValue(values, 'hil_min_window'),
    epoch_time: numericValue(values, 'hil_epoch_time'),
    stop_band: numericValue(values, 'hil_stop_band')
  });
  if (detector === 'RMS') return definedParams({
    rms_window: numericValue(values, 'rms_window'),
    min_window: numericValue(values, 'min_window'),
    max_window: numericValue(values, 'max_window'),
    min_gap: numericValue(values, 'min_gap'),
    threshold: numericValue(values, 'threshold'),
    peak_threshold: numericValue(values, 'peak_threshold')
  });
  if (detector === 'LineLength') return definedParams({
    ll_window: numericValue(values, 'll_window'),
    min_window: numericValue(values, 'min_window'),
    max_window: numericValue(values, 'max_window'),
    min_gap: numericValue(values, 'min_gap'),
    threshold: numericValue(values, 'threshold'),
    peak_threshold: numericValue(values, 'peak_threshold')
  });
  if (detector === 'YASA') return definedParams({
    freq_sp: pair(values, 'freq_sp_low', 'freq_sp_high'),
    freq_broad: pair(values, 'freq_broad_low', 'freq_broad_high'),
    duration: pair(values, 'duration_low', 'duration_high'),
    min_distance: numericValue(values, 'min_distance'),
    corr: numericValue(values, 'corr'),
    rel_pow: numericValue(values, 'rel_pow'),
    rms: numericValue(values, 'rms')
  });
  if (detector === 'LSM') return definedParams({
    parameter_file: values.parameter_file || '',
    prob_threshold: numericValue(values, 'prob_threshold'),
    min_spindle_duration: numericValue(values, 'min_spindle_duration'),
    spindle_separation_threshold: numericValue(values, 'spindle_separation_threshold'),
    min_peak_prominence: numericValue(values, 'min_peak_prominence'),
    start_frequency: numericValue(values, 'start_frequency') ?? null,
    stop_frequency: numericValue(values, 'stop_frequency') ?? null
  });
  if (detector === 'A7') return definedParams({
    freq_sp: pair(values, 'freq_sp_low', 'freq_sp_high'),
    freq_broad: pair(values, 'freq_broad_low', 'freq_broad_high'),
    duration: pair(values, 'duration_low', 'duration_high'),
    min_distance: numericValue(values, 'min_distance'),
    rms_threshold: numericValue(values, 'rms_threshold'),
    relative_power_threshold: numericValue(values, 'relative_power_threshold'),
    correlation_threshold: numericValue(values, 'correlation_threshold'),
    smooth_window: numericValue(values, 'smooth_window')
  });
  if (detector === 'MOLLE') return definedParams({
    method: 'MOLLE',
    freq_sp: pair(values, 'freq_sp_low', 'freq_sp_high'),
    duration: pair(values, 'duration_low', 'duration_high'),
    min_distance: numericValue(values, 'min_distance'),
    smooth_window: numericValue(values, 'smooth_window'),
    rms_threshold: numericValue(values, 'rms_threshold')
  });
  return definedParams({
    rms_window: numericValue(values, 'rms_window'),
    ll_window: numericValue(values, 'll_window'),
    min_window: numericValue(values, 'min_window'),
    max_window: numericValue(values, 'max_window'),
    min_gap: numericValue(values, 'min_gap'),
    rms_thres: numericValue(values, 'rms_thres'),
    ll_thres: numericValue(values, 'll_thres'),
    peak_thres: numericValue(values, 'peak_thres')
  });
}

export function quickDetectionFilterRequest(state: QuickDetectionState): Record<string, number> | undefined {
  const filter = definedParams({
    fp: numericValue(state.filter, 'fp'),
    fs: numericValue(state.filter, 'fs'),
    rp: numericValue(state.filter, 'rp'),
    rs: numericValue(state.filter, 'rs')
  }) as Record<string, number>;
  return Object.keys(filter).length ? filter : undefined;
}

export function quickDetectionClassifierPayload(state: QuickDetectionState): Record<string, unknown> {
  const device = normalizeDevice(state.classifier.device);
  const modelType = device.startsWith('cuda') ? 'default_gpu' : 'default_cpu';
  const steps = ['artifact', state.classifier.useSpike && 'spike', state.classifier.useEhfo && 'ehfo'].filter(Boolean);
  return {
    enabled: true,
    artifact_path: placeholderToNull(state.classifier.artifactModel),
    spike_path: placeholderToNull(state.classifier.spikeModel),
    ehfo_path: placeholderToNull(state.classifier.ehfoModel),
    artifact_card: null,
    spike_card: null,
    ehfo_card: null,
    use_spike: state.classifier.useSpike,
    use_ehfo: state.classifier.useEhfo,
    device,
    batch_size: Math.max(1, Math.round(Number(state.classifier.batchSize) || 1)),
    model_type: modelType,
    source_preference: 'auto',
    ignore_region: [Number(state.classifier.ignoreBefore) || 0, Number(state.classifier.ignoreAfter) || 0],
    steps
  };
}

export function placeholderToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed && trimmed !== 'File Name...' && trimmed !== 'No model selected' ? trimmed : null;
}

export function normalizeDevice(value: string): string {
  const raw = value.trim().toLowerCase();
  if (raw === 'gpu' || raw === 'cuda') return 'cuda:0';
  if (raw === 'cpu') return 'cpu';
  return raw || 'cpu';
}

export function validateQuickDetectionState(state: QuickDetectionState, sampleFreqHz?: number): string[] {
  const errors: string[] = [];
  const classifierEnabled = state.biomarker === 'HFO' && state.classifier.useClassifier;
  const values = [
    ...Object.entries(state.filter).map(([key, value]) => [`filter ${key}`, value]),
    ['nJobs', String(state.nJobs)],
    ...(classifierEnabled ? [
      ['classifier batch size', state.classifier.batchSize],
      ['ignore before', state.classifier.ignoreBefore],
      ['ignore after', state.classifier.ignoreAfter]
    ] : []),
    ...DETECTOR_FIELDS[state.detector].filter((field) => field.type !== 'path').map((field) => [field.key, state.detectorValues[field.key] || ''])
  ];
  for (const [label, value] of values) {
    if (String(value).trim() && !Number.isFinite(Number(value))) errors.push(`${label} must be numeric`);
  }
  addQuickRangeValidation(errors, state);
  // Filter band validity (parity with PyQt quick_detection.py:1202-1205: fp must be
  // below fs, and fs must stay below the recording Nyquist frequency).
  const fp = numericValue(state.filter, 'fp');
  const fs = numericValue(state.filter, 'fs');
  if (fp != null && fs != null && fp >= fs) errors.push('Filter pass band must be lower than the stop band');
  if (fs != null && sampleFreqHz && sampleFreqHz > 0 && fs >= sampleFreqHz / 2) {
    errors.push(`Filter stop band must stay below the Nyquist frequency (${(sampleFreqHz / 2).toFixed(1)} Hz)`);
  }
  if (state.detector === 'LSM') {
    const probability = numericValue(state.detectorValues, 'prob_threshold');
    if (probability != null && probability > 1) errors.push('LSM Probability must be <= 1');
    const start = numericValue(state.detectorValues, 'start_frequency');
    const stop = numericValue(state.detectorValues, 'stop_frequency');
    if ((start == null) !== (stop == null)) errors.push('LSM start and stop frequency must be provided together');
    if (start != null && stop != null && start >= stop) errors.push('LSM stop frequency must be greater than start frequency');
  }
  if (!state.saveAs.npz && !state.saveAs.excel) errors.push('select at least one export format');
  return errors;
}

export function addQuickRangeValidation(errors: string[], state: QuickDetectionState) {
  const values = state.detectorValues;
  if (['RMS', 'LineLength', 'RMS/LL'].includes(state.detector)) {
    const minWindow = numericValue(values, 'min_window');
    const maxWindow = numericValue(values, 'max_window');
    if (minWindow != null && maxWindow != null && minWindow > maxWindow) errors.push('Min duration must be lower than max duration');
  }
  for (const [left, right, label] of quickRangeFieldsForDetector(state.detector)) {
    const low = numericValue(values, left);
    const high = numericValue(values, right);
    if (low != null && high != null && low >= high) errors.push(`${label} low value must be lower than the high value`);
  }
}

export function quickRangeFieldsForDetector(detector: QuickDetectionDetector): Array<[string, string, string]> {
  if (detector === 'YASA') return [['freq_sp_low', 'freq_sp_high', 'Spindle band'], ['freq_broad_low', 'freq_broad_high', 'Broad band'], ['duration_low', 'duration_high', 'Duration']];
  if (detector === 'A7') return [['freq_sp_low', 'freq_sp_high', 'Spindle band'], ['freq_broad_low', 'freq_broad_high', 'Broad band'], ['duration_low', 'duration_high', 'Duration']];
  if (detector === 'MOLLE') return [['freq_sp_low', 'freq_sp_high', 'Spindle band'], ['duration_low', 'duration_high', 'Duration']];
  return [];
}
