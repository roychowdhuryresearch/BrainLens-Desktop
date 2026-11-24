import { useEffect, useMemo, useState } from 'react';
import type { BiomarkerType, CapabilityManifest, PrepareControlsState } from '../../app/workspaceState';
import { detectorTabsByBiomarker } from '../../app/workspaceState';
import { backendClient } from '../../api/backendClient';

type DetectorField = {
  key: string;
  label: string;
  unit?: string;
  testId: string;
  defaultValue?: string;
  placeholder?: string;
  kind?: 'text' | 'select';
  options?: string[];
};

type DetectorParamValue = number | string | [number, number] | number[] | Record<string, unknown> | null;

type DetectorDisplayField = {
  key: string;
  label: string;
  testId: string;
  from?: string;
  range?: [string, string];
  fallback?: string;
};

const LSM_MODEL_FIELDS: DetectorField[] = [
  { key: 'lsm_window_duration', label: 'Window', unit: 'sec', testId: 'pyqt-lsm_window_duration_input', defaultValue: '2.0' },
  { key: 'lsm_step_duration', label: 'Step', unit: 'sec', testId: 'pyqt-lsm_step_duration_input', defaultValue: '0.2' },
  { key: 'lsm_theta_index', label: 'Theta idx', unit: '1-based', testId: 'pyqt-lsm_theta_index_input', defaultValue: '1,2,3' },
  { key: 'lsm_nine_15_index', label: '9-15 idx', unit: '1-based', testId: 'pyqt-lsm_nine_15_index_input', defaultValue: '4,5,6' },
  { key: 'lsm_mu_log_p_theta1', label: 'mu theta1', testId: 'pyqt-lsm_mu_log_p_theta1_input', defaultValue: '0' },
  { key: 'lsm_mu_log_p_theta0', label: 'mu theta0', testId: 'pyqt-lsm_mu_log_p_theta0_input', defaultValue: '0' },
  { key: 'lsm_mu_log_p_9_15_1', label: 'mu 9-15 1', testId: 'pyqt-lsm_mu_log_p_9_15_1_input', defaultValue: '0' },
  { key: 'lsm_mu_log_p_9_15_0', label: 'mu 9-15 0', testId: 'pyqt-lsm_mu_log_p_9_15_0_input', defaultValue: '0' },
  { key: 'lsm_mu_f1', label: 'mu F1', testId: 'pyqt-lsm_mu_f1_input', defaultValue: '0' },
  { key: 'lsm_mu_f0', label: 'mu F0', testId: 'pyqt-lsm_mu_f0_input', defaultValue: '0' },
  { key: 'lsm_sigma_log_p_theta1', label: 'sigma theta1', testId: 'pyqt-lsm_sigma_log_p_theta1_input', defaultValue: '1' },
  { key: 'lsm_sigma_log_p_theta0', label: 'sigma theta0', testId: 'pyqt-lsm_sigma_log_p_theta0_input', defaultValue: '1' },
  { key: 'lsm_sigma_log_p_9_15_1', label: 'sigma 9-15 1', testId: 'pyqt-lsm_sigma_log_p_9_15_1_input', defaultValue: '1' },
  { key: 'lsm_sigma_log_p_9_15_0', label: 'sigma 9-15 0', testId: 'pyqt-lsm_sigma_log_p_9_15_0_input', defaultValue: '1' },
  { key: 'lsm_sigma_f1', label: 'sigma F1', testId: 'pyqt-lsm_sigma_f1_input', defaultValue: '1' },
  { key: 'lsm_sigma_f0', label: 'sigma F0', testId: 'pyqt-lsm_sigma_f0_input', defaultValue: '1' },
  { key: 'lsm_transition_00', label: 'T 0,0', testId: 'pyqt-lsm_transition_00_input', defaultValue: '0.98' },
  { key: 'lsm_transition_01', label: 'T 0,1', testId: 'pyqt-lsm_transition_01_input', defaultValue: '0.02' },
  { key: 'lsm_transition_10', label: 'T 1,0', testId: 'pyqt-lsm_transition_10_input', defaultValue: '0.08' },
  { key: 'lsm_transition_11', label: 'T 1,1', testId: 'pyqt-lsm_transition_11_input', defaultValue: '0.92' }
];

const LSM_PRESET_HYDRATE_KEYS = new Set(['preset', 'preset_path', 'preset_paths_json', 'parameter_file', ...LSM_MODEL_FIELDS.map((field) => field.key)]);

const DETECTOR_DISPLAY_FIELDS: Record<string, DetectorDisplayField[]> = {
  STE: [
    { key: 'epoch_length', label: 'Epoch (s)', testId: 'pyqt-ste_epoch_display' },
    { key: 'min_window', label: 'Min Window (s)', testId: 'pyqt-ste_min_window_display' },
    { key: 'rms_window', label: 'RMS Window (s)', testId: 'pyqt-ste_rms_window_display' },
    { key: 'min_gap', label: 'Min Gap Time (s)', testId: 'pyqt-ste_min_gap_time_display' },
    { key: 'min_oscillation', label: 'Min Oscillations', testId: 'pyqt-ste_min_oscillations_display' },
    { key: 'peak_threshold', label: 'Peak Threshold', testId: 'pyqt-ste_peak_threshold_display' },
    { key: 'rms_threshold', label: 'RMS Threshold', testId: 'pyqt-ste_rms_threshold_display' }
  ],
  MNI: [
    { key: 'epoch_time', label: 'Epoch (s)', testId: 'pyqt-mni_epoch_display' },
    { key: 'min_window', label: 'Min Window (s)', testId: 'pyqt-mni_min_window_display' },
    { key: 'epoch_chf', label: 'Epoch CHF (s)', testId: 'pyqt-mni_epoch_chf_display' },
    { key: 'min_gap_time', label: 'Min Gap Time (s)', testId: 'pyqt-mni_min_gap_time_display' },
    { key: 'chf_percentage', label: 'CHF Percentage', testId: 'pyqt-mni_chf_percentage_display' },
    { key: 'threshold_percentage', label: 'Threshold Percentile', testId: 'pyqt-mni_threshold_percentile_display' },
    { key: 'baseline_window', label: 'Baseline Window (s)', testId: 'pyqt-mni_baseline_window_display' },
    { key: 'baseline_shift', label: 'Baseline Shift', testId: 'pyqt-mni_baseline_shift_display' },
    { key: 'baseline_threshold', label: 'Baseline Threshold', testId: 'pyqt-mni_baseline_threshold_display' },
    { key: 'baseline_min_time', label: 'Baseline Min Time', testId: 'pyqt-mni_baseline_min_time_display' }
  ],
  HIL: [
    { key: 'epoch_time', label: 'Epoch Length (s)', testId: 'pyqt-hil_epoch_time_display' },
    { key: 'min_window', label: 'Min Window (s)', testId: 'pyqt-hil_min_window_display' },
    { key: 'pass_band', label: 'Pass Band (Hz)', testId: 'pyqt-hil_pass_band_display' },
    { key: 'stop_band', label: 'Stop Band (Hz)', testId: 'pyqt-hil_stop_band_display' },
    { key: 'sample_freq', label: 'Sample Frequency', testId: 'pyqt-hil_sample_freq_display' },
    { key: 'sd_threshold', label: 'SD Threshold', testId: 'pyqt-hil_sd_threshold_display' }
  ],
  RMS: [
    { key: 'window', label: 'RMS Window (s)', testId: 'pyqt-hfo_rms_window_display' },
    { key: 'min_duration', label: 'Min Duration (s)', testId: 'pyqt-hfo_rms_min_duration_display' },
    { key: 'max_duration', label: 'Max Duration (s)', testId: 'pyqt-hfo_rms_max_duration_display' },
    { key: 'min_gap', label: 'Min Gap (s)', testId: 'pyqt-hfo_rms_min_gap_display' },
    { key: 'threshold', label: 'Metric Threshold', testId: 'pyqt-hfo_rms_threshold_display' },
    { key: 'peak_threshold', label: 'Peak Threshold', testId: 'pyqt-hfo_rms_peak_threshold_display' }
  ],
  LineLength: [
    { key: 'window', label: 'LL Window (s)', testId: 'pyqt-hfo_linelength_window_display' },
    { key: 'min_duration', label: 'Min Duration (s)', testId: 'pyqt-hfo_linelength_min_duration_display' },
    { key: 'max_duration', label: 'Max Duration (s)', testId: 'pyqt-hfo_linelength_max_duration_display' },
    { key: 'min_gap', label: 'Min Gap (s)', testId: 'pyqt-hfo_linelength_min_gap_display' },
    { key: 'threshold', label: 'Metric Threshold', testId: 'pyqt-hfo_linelength_threshold_display' },
    { key: 'peak_threshold', label: 'Peak Threshold', testId: 'pyqt-hfo_linelength_peak_threshold_display' }
  ],
  YASA: [
    { key: 'freq_sp', label: 'Spindle Band (Hz)', range: ['freq_sp_low', 'freq_sp_high'], testId: 'pyqt-yasa_freq_sp_display' },
    { key: 'freq_broad', label: 'Broad Band (Hz)', range: ['freq_broad_low', 'freq_broad_high'], testId: 'pyqt-yasa_freq_broad_display' },
    { key: 'duration', label: 'Duration (s)', range: ['duration_low', 'duration_high'], testId: 'pyqt-yasa_duration_display' },
    { key: 'min_distance', label: 'Min Distance (ms)', testId: 'pyqt-yasa_min_distance_display' },
    { key: 'rel_power', label: 'Rel Power', testId: 'pyqt-yasa_thresh_rel_pow_display' },
    { key: 'correlation', label: 'Correlation', testId: 'pyqt-yasa_thresh_corr_display' },
    { key: 'rms', label: 'RMS', testId: 'pyqt-yasa_thresh_rms_display' }
  ],
  LSM: [
    { key: 'parameter_file', label: 'Parameter Source', testId: 'pyqt-lsm_parameter_file_display' },
    { key: 'probability', label: 'Probability', testId: 'pyqt-lsm_probability_display' },
    { key: 'min_duration', label: 'Min Duration (s)', testId: 'pyqt-lsm_min_duration_display' },
    { key: 'separation', label: 'Separation (s)', testId: 'pyqt-lsm_separation_display' },
    { key: 'min_prominence', label: 'Min Prominence', testId: 'pyqt-lsm_min_prominence_display' },
    { key: 'narrowband', label: 'Narrowband (Hz)', testId: 'pyqt-lsm_narrowband_display' }
  ],
  A7: [
    { key: 'freq_sp', label: 'Spindle Band (Hz)', range: ['freq_low', 'freq_high'], testId: 'pyqt-spindle_a7_freq_sp_display' },
    { key: 'duration', label: 'Duration (s)', range: ['duration_low', 'duration_high'], testId: 'pyqt-spindle_a7_duration_display' },
    { key: 'min_distance', label: 'Min Distance (s)', testId: 'pyqt-spindle_a7_min_distance_display' },
    { key: 'smooth_window', label: 'Smooth Window (s)', testId: 'pyqt-spindle_a7_smooth_window_display' },
    { key: 'rms_threshold', label: 'RMS Threshold', testId: 'pyqt-spindle_a7_rms_threshold_display' },
    { key: 'freq_broad', label: 'Broad Band (Hz)', range: ['broad_low', 'broad_high'], testId: 'pyqt-spindle_a7_freq_broad_display' },
    { key: 'relative_power_threshold', label: 'Rel Power', testId: 'pyqt-spindle_a7_rel_power_display' },
    { key: 'correlation_threshold', label: 'Correlation', testId: 'pyqt-spindle_a7_correlation_display' }
  ],
  MOLLE: [
    { key: 'freq_sp', label: 'Spindle Band (Hz)', range: ['freq_low', 'freq_high'], testId: 'pyqt-spindle_molle_freq_sp_display' },
    { key: 'duration', label: 'Duration (s)', range: ['duration_low', 'duration_high'], testId: 'pyqt-spindle_molle_duration_display' },
    { key: 'min_distance', label: 'Min Distance (s)', testId: 'pyqt-spindle_molle_min_distance_display' },
    { key: 'smooth_window', label: 'Smooth Window (s)', testId: 'pyqt-spindle_molle_smooth_window_display' },
    { key: 'rms_threshold', label: 'RMS Threshold', testId: 'pyqt-spindle_molle_rms_threshold_display' },
    { key: 'method', label: 'Method', fallback: 'MOLLE', testId: 'pyqt-spindle_molle_method_display' }
  ],
  'RMS/LL': [
    { key: 'rms_window', label: 'RMS Window (s)', testId: 'pyqt-spike_rms_window_display' },
    { key: 'll_window', label: 'LL Window (s)', testId: 'pyqt-spike_ll_window_display' },
    { key: 'min_duration', label: 'Min Duration (s)', testId: 'pyqt-spike_min_duration_display' },
    { key: 'max_duration', label: 'Max Duration (s)', testId: 'pyqt-spike_max_duration_display' },
    { key: 'min_gap', label: 'Min Gap (s)', testId: 'pyqt-spike_min_gap_display' },
    { key: 'rms_threshold', label: 'RMS Threshold', testId: 'pyqt-spike_rms_threshold_display' },
    { key: 'll_threshold', label: 'LL Threshold', testId: 'pyqt-spike_ll_threshold_display' },
    { key: 'peak_threshold', label: 'Peak Threshold', testId: 'pyqt-spike_peak_threshold_display' }
  ]
};

export const DETECTOR_FIELDS: Record<string, DetectorField[]> = {
  STE: [
    { key: 'rms_window', label: 'RMS window', unit: 'sec', testId: 'pyqt-ste_rms_window_input', defaultValue: '0.003' },
    { key: 'min_window', label: 'Min window', unit: 'sec', testId: 'pyqt-ste_min_window_input', defaultValue: '0.006' },
    { key: 'min_gap', label: 'Min gap', unit: 'sec', testId: 'pyqt-ste_min_gap_input', defaultValue: '0.01' },
    { key: 'min_oscillation', label: 'Min oscill.', testId: 'pyqt-ste_min_oscillation_input', defaultValue: '6' },
    { key: 'peak_threshold', label: 'Peak thresh.', testId: 'pyqt-ste_peak_threshold_input', defaultValue: '3' },
    { key: 'rms_threshold', label: 'RMS thresh.', testId: 'pyqt-ste_rms_threshold_input', defaultValue: '5' },
    { key: 'epoch_length', label: 'Epoch length', unit: 'sec', testId: 'pyqt-ste_epoch_length_input', defaultValue: '600' }
  ],
  MNI: [
    { key: 'epoch_time', label: 'Epoch time', unit: 'sec', testId: 'pyqt-mni_epoch_time_input', defaultValue: '10' },
    { key: 'min_window', label: 'Min window', unit: 'sec', testId: 'pyqt-mni_min_window_input', defaultValue: '0.01' },
    { key: 'chf_percentage', label: 'CHF percent', unit: '%', testId: 'pyqt-mni_chf_percentage_input', defaultValue: '0.95' },
    { key: 'threshold_percentage', label: 'Threshold', unit: '%', testId: 'pyqt-mni_threshold_percentage_input', defaultValue: '99.9999' },
    { key: 'min_gap_time', label: 'Min gap', unit: 'sec', testId: 'pyqt-mni_min_gap_time_input', defaultValue: '0.01' },
    { key: 'epoch_chf', label: 'Epoch CHF', unit: 'sec', testId: 'pyqt-mni_epoch_chf_input', defaultValue: '60' },
    { key: 'baseline_window', label: 'Baseline win.', unit: 'sec', testId: 'pyqt-mni_baseline_window_input', defaultValue: '0.125' },
    { key: 'baseline_shift', label: 'Baseline shift', testId: 'pyqt-mni_baseline_shift_input', defaultValue: '0.5' },
    { key: 'baseline_threshold', label: 'Baseline thres.', testId: 'pyqt-mni_baseline_threshold_input', defaultValue: '0.67' },
    { key: 'baseline_min_time', label: 'Baseline min', unit: 'sec', testId: 'pyqt-mni_baseline_min_time_input', defaultValue: '5' }
  ],
  HIL: [
    { key: 'pass_band', label: 'Pass band', unit: 'Hz', testId: 'pyqt-hil_pass_band_input', defaultValue: '80' },
    { key: 'stop_band', label: 'Stop band', unit: 'Hz', testId: 'pyqt-hil_stop_band_input', defaultValue: '500' },
    { key: 'sd_threshold', label: 'SD thresh.', testId: 'pyqt-hil_sd_threshold_input', defaultValue: '5' },
    { key: 'min_window', label: 'Min window', unit: 'sec', testId: 'pyqt-hil_min_window_input', defaultValue: '0.01' },
    { key: 'sample_freq', label: 'Sample freq.', unit: 'Hz', testId: 'pyqt-hil_sample_freq_input', defaultValue: '2000' },
    { key: 'epoch_time', label: 'Epoch length', unit: 'sec', testId: 'pyqt-hil_epoch_time_input', defaultValue: '3600' }
  ],
  RMS: [
    { key: 'window', label: 'RMS Window', unit: 'sec', testId: 'pyqt-hfo_rms_window_input', defaultValue: '0.003' },
    { key: 'min_duration', label: 'Min duration', unit: 'sec', testId: 'pyqt-hfo_rms_min_duration_input', defaultValue: '0.006' },
    { key: 'max_duration', label: 'Max duration', unit: 'sec', testId: 'pyqt-hfo_rms_max_duration_input', defaultValue: '0.2' },
    { key: 'min_gap', label: 'Min gap', unit: 'sec', testId: 'pyqt-hfo_rms_min_gap_input', defaultValue: '0.01' },
    { key: 'threshold', label: 'Threshold', testId: 'pyqt-hfo_rms_threshold_input', defaultValue: '5.0' },
    { key: 'peak_threshold', label: 'Peak thresh.', testId: 'pyqt-hfo_rms_peak_threshold_input', defaultValue: '3.0' }
  ],
  LineLength: [
    { key: 'window', label: 'LL window', unit: 'sec', testId: 'pyqt-hfo_linelength_window_input', defaultValue: '0.01' },
    { key: 'min_duration', label: 'Min duration', unit: 'sec', testId: 'pyqt-hfo_linelength_min_duration_input', defaultValue: '0.006' },
    { key: 'max_duration', label: 'Max duration', unit: 'sec', testId: 'pyqt-hfo_linelength_max_duration_input', defaultValue: '0.2' },
    { key: 'min_gap', label: 'Min gap', unit: 'sec', testId: 'pyqt-hfo_linelength_min_gap_input', defaultValue: '0.01' },
    { key: 'threshold', label: 'Threshold', testId: 'pyqt-hfo_linelength_threshold_input', defaultValue: '5.0' },
    { key: 'peak_threshold', label: 'Peak thresh.', testId: 'pyqt-hfo_linelength_peak_threshold_input', defaultValue: '3.0' }
  ],
  YASA: [
    { key: 'freq_sp_low', label: 'Spindle band low', unit: 'Hz', testId: 'pyqt-yasa_freq_sp_low_input', defaultValue: '12' },
    { key: 'freq_sp_high', label: 'Spindle band high', unit: 'Hz', testId: 'pyqt-yasa_freq_sp_high_input', defaultValue: '15' },
    { key: 'freq_broad_low', label: 'Broad band low', unit: 'Hz', testId: 'pyqt-yasa_freq_broad_low_input', defaultValue: '1' },
    { key: 'freq_broad_high', label: 'Broad band high', unit: 'Hz', testId: 'pyqt-yasa_freq_broad_high_input', defaultValue: '30' },
    { key: 'duration_low', label: 'Duration min', unit: 'sec', testId: 'pyqt-yasa_duration_low_input', defaultValue: '0.5' },
    { key: 'duration_high', label: 'Duration max', unit: 'sec', testId: 'pyqt-yasa_duration_high_input', defaultValue: '2.0' },
    { key: 'min_distance', label: 'Min distance', unit: 'ms', testId: 'pyqt-yasa_min_distance_input', defaultValue: '500' },
    { key: 'rel_power', label: 'Rel power', testId: 'pyqt-yasa_thresh_rel_pow_input', defaultValue: '0.2' },
    { key: 'correlation', label: 'Correlation', testId: 'pyqt-yasa_thresh_corr_input', defaultValue: '0.65' },
    { key: 'rms', label: 'RMS', testId: 'pyqt-yasa_thresh_rms_input', defaultValue: '1.5' }
  ],
  LSM: [
    { key: 'preset', label: 'Preset', kind: 'select', options: ['AllAges (Kwon 2023)', 'Original (Kramer 2021)', 'ESES (McLaren 2023)', 'Infant (Berja 2024)', 'Custom file / manual'], testId: 'pyqt-lsm_preset_combo' },
    { key: 'parameter_file', label: 'Parameter file', unit: '.mat/.json', testId: 'pyqt-lsm_parameter_file_input', placeholder: 'Choose a Kramer .mat/.json parameter file' },
    { key: 'probability', label: 'Probability', testId: 'pyqt-lsm_probability_input', defaultValue: '0.95' },
    { key: 'min_duration', label: 'Min duration', unit: 'sec', testId: 'pyqt-lsm_min_duration_input', defaultValue: '0.5' },
    { key: 'separation', label: 'Separation', unit: 'sec', testId: 'pyqt-lsm_separation_input', defaultValue: '1.0' },
    { key: 'min_prominence', label: 'Min prominence', unit: 'V', testId: 'pyqt-lsm_min_prominence_input', defaultValue: '2e-6' },
    { key: 'start_frequency', label: 'Start freq.', unit: 'Hz', testId: 'pyqt-lsm_start_frequency_input', defaultValue: '9' },
    { key: 'stop_frequency', label: 'Stop freq.', unit: 'Hz', testId: 'pyqt-lsm_stop_frequency_input', defaultValue: '16' }
  ],
  A7: [
    { key: 'freq_low', label: 'Spindle band low', unit: 'Hz', testId: 'pyqt-spindle_a7_freq_low_input', defaultValue: '11' },
    { key: 'freq_high', label: 'Spindle band high', unit: 'Hz', testId: 'pyqt-spindle_a7_freq_high_input', defaultValue: '16' },
    { key: 'duration_low', label: 'Duration min', unit: 'sec', testId: 'pyqt-spindle_a7_duration_low_input', defaultValue: '0.5' },
    { key: 'duration_high', label: 'Duration max', unit: 'sec', testId: 'pyqt-spindle_a7_duration_high_input', defaultValue: '2.5' },
    { key: 'min_distance', label: 'Min distance', unit: 'sec', testId: 'pyqt-spindle_a7_min_distance_input', defaultValue: '0.5' },
    { key: 'smooth_window', label: 'Smooth window', unit: 'sec', testId: 'pyqt-spindle_a7_smooth_window_input', defaultValue: '0.2' },
    { key: 'rms_threshold', label: 'RMS thresh.', testId: 'pyqt-spindle_a7_rms_threshold_input', defaultValue: '1.5' },
    { key: 'broad_low', label: 'Broad band low', unit: 'Hz', testId: 'pyqt-spindle_a7_broad_low_input', defaultValue: '1' },
    { key: 'broad_high', label: 'Broad band high', unit: 'Hz', testId: 'pyqt-spindle_a7_broad_high_input', defaultValue: '30' },
    { key: 'relative_power_threshold', label: 'Rel power', testId: 'pyqt-spindle_a7_rel_power_input', defaultValue: '0.2' },
    { key: 'correlation_threshold', label: 'Correlation', testId: 'pyqt-spindle_a7_correlation_input', defaultValue: '0.65' }
  ],
  MOLLE: [
    { key: 'freq_low', label: 'Spindle band low', unit: 'Hz', testId: 'pyqt-spindle_molle_freq_low_input', defaultValue: '12' },
    { key: 'freq_high', label: 'Spindle band high', unit: 'Hz', testId: 'pyqt-spindle_molle_freq_high_input', defaultValue: '15' },
    { key: 'duration_low', label: 'Duration min', unit: 'sec', testId: 'pyqt-spindle_molle_duration_low_input', defaultValue: '0.5' },
    { key: 'duration_high', label: 'Duration max', unit: 'sec', testId: 'pyqt-spindle_molle_duration_high_input', defaultValue: '3.0' },
    { key: 'min_distance', label: 'Min distance', unit: 'sec', testId: 'pyqt-spindle_molle_min_distance_input', defaultValue: '0.5' },
    { key: 'smooth_window', label: 'Smooth window', unit: 'sec', testId: 'pyqt-spindle_molle_smooth_window_input', defaultValue: '0.2' },
    { key: 'rms_threshold', label: 'RMS thresh.', testId: 'pyqt-spindle_molle_rms_threshold_input', defaultValue: '1.5' }
  ],
  'RMS/LL': [
    { key: 'rms_window', label: 'RMS window', unit: 'sec', testId: 'pyqt-spike_rms_window_input', defaultValue: '0.02' },
    { key: 'll_window', label: 'LL window', unit: 'sec', testId: 'pyqt-spike_ll_window_input', defaultValue: '0.01' },
    { key: 'min_duration', label: 'Min duration', unit: 'sec', testId: 'pyqt-spike_min_duration_input', defaultValue: '0.015' },
    { key: 'max_duration', label: 'Max duration', unit: 'sec', testId: 'pyqt-spike_max_duration_input', defaultValue: '0.05' },
    { key: 'min_gap', label: 'Min gap', unit: 'sec', testId: 'pyqt-spike_min_gap_input', defaultValue: '0.08' },
    { key: 'rms_threshold', label: 'RMS thresh.', testId: 'pyqt-spike_rms_threshold_input', defaultValue: '5.0' },
    { key: 'll_threshold', label: 'LL thresh.', testId: 'pyqt-spike_ll_threshold_input', defaultValue: '5.0' },
    { key: 'peak_threshold', label: 'Peak thresh.', testId: 'pyqt-spike_peak_threshold_input', defaultValue: '6.0' }
  ]
};

type DetectorFormState = Record<string, Record<string, string>>;

type DetectorDefaultsResult = {
  status?: string;
  source?: string;
  detector?: string;
  ui_values?: Record<string, unknown>;
  detector_params?: Record<string, unknown>;
};


type ProtocolPreset = {
  format?: string;
  version?: number;
  name?: string;
  biomarker_type?: BiomarkerType;
  detector?: {
    name?: string;
    ui_values?: Record<string, unknown>;
    detector_params?: Record<string, unknown>;
  };
  prepare?: Partial<PrepareControlsState> & { n_jobs?: number };
};

export type DetectorRunRequest = {
  biomarker: BiomarkerType;
  detector: string;
  detectorParams: Record<string, DetectorParamValue>;
  uiValues: Record<string, string>;
  scope?: 'visible' | 'all';
  allChannels?: boolean;
  includeChannels?: string[];
  excludeChannels?: string[];
  outputDir?: string;
  filter?: Record<string, number>;
  nJobs?: number;
  exports?: string[];
  sessionFormat?: 'pybrain' | 'npz';
  classifier?: Record<string, unknown>;
  classifierLabel?: string;
};

export function DetectTab({ biomarker, hasRecording, capabilityManifest, sampleFrequencyHz, nJobs, prepareControls, onPrepareControlsChange, onBiomarkerChange, onRunDetection }: { biomarker: BiomarkerType; hasRecording: boolean; capabilityManifest: CapabilityManifest | null; sampleFrequencyHz?: number; nJobs: number; prepareControls: PrepareControlsState; onPrepareControlsChange: (controls: PrepareControlsState) => void; onBiomarkerChange: (biomarker: BiomarkerType) => void; onRunDetection: (request: DetectorRunRequest) => Promise<void> | void }) {
  const detectors = useMemo(() => detectorTabsByBiomarker[biomarker], [biomarker]);
  const [activeDetectorByBiomarker, setActiveDetectorByBiomarker] = useState<Record<BiomarkerType, string>>({
    HFO: detectorTabsByBiomarker.HFO[0],
    Spindle: detectorTabsByBiomarker.Spindle[0],
    Spike: detectorTabsByBiomarker.Spike[0]
  });
  const [values, setValues] = useState<DetectorFormState>(() => initialDetectorValues());
  const [appliedValues, setAppliedValues] = useState<DetectorFormState>({});
  const [appliedFingerprints, setAppliedFingerprints] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('Detector settings ready for review.');
  const activeDetector = activeDetectorByBiomarker[biomarker] || detectors[0];
  const fields = useMemo(() => DETECTOR_FIELDS[activeDetector] || [], [activeDetector]);
  const activeValues = values[activeDetector] || {};
  const activeFingerprint = useMemo(() => detectorValueFingerprint(activeValues), [activeValues]);
  const currentApplied = appliedFingerprints[activeDetector] === activeFingerprint;
  const detectorAvailability = detectorRuntimeAvailability(biomarker, activeDetector, capabilityManifest);
  const runDisabled = !hasRecording || !currentApplied || !detectorAvailability.available;
  const formTestId = useMemo(() => `pyqt-detector_form_${activeDetector.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, [activeDetector]);

  useEffect(() => {
    if (!detectors.includes(activeDetector)) {
      setActiveDetectorByBiomarker((current) => ({ ...current, [biomarker]: detectors[0] }));
    }
  }, [activeDetector, biomarker, detectors]);

  useEffect(() => {
    let cancelled = false;
    const fallbackValues = valuesForFields(fields);
    backendClient.detectorDefaults({ biomarker, detector: activeDetector, sample_freq: sampleFrequencyHz, n_jobs: nJobs })
      .then((result) => {
        if (cancelled) return;
        const defaults = normalizeDefaultUiValues((result as DetectorDefaultsResult).ui_values, fields);
        setValues((current) => ({ ...current, [activeDetector]: { ...fallbackValues, ...defaults } }));
        // Source-contract anchor: PyHFO parameter objects
        setFeedback(`${activeDetector} defaults loaded${sampleFrequencyHz ? ` at ${sampleFrequencyHz} Hz` : ''}.`);
      })
      .catch((exc) => {
        if (cancelled) return;
        setValues((current) => ({ ...current, [activeDetector]: { ...(current[activeDetector] || fallbackValues) } }));
        setFeedback(`Detector defaults unavailable; local defaults applied. ${exc instanceof Error ? exc.message : String(exc)}`);
      });
    return () => { cancelled = true; };
  }, [activeDetector, biomarker, fields, nJobs, sampleFrequencyHz]);

  function setActiveDetector(detector: string) {
    setActiveDetectorByBiomarker((current) => ({ ...current, [biomarker]: detector }));
    setFeedback(`Detector set to ${detector}.`);
  }

  function updateValue(key: string, value: string) {
    setValues((current) => {
      const next = { ...(current[activeDetector] || {}), [key]: value };
      if (activeDetector === 'LSM' && key === 'preset') {
        const presetPaths = parsePresetPaths(next.lsm_preset_paths_json);
        next.preset_path = presetPaths[value] || '';
        if (value !== 'Custom file / manual' && !next.parameter_file) next.parameter_file = '';
      }
      return { ...current, [activeDetector]: next };
    });
  }

  function updateLsmPreset(preset: string) {
    updateValue('preset', preset);
    backendClient.detectorDefaults({ biomarker, detector: 'LSM', preset, sample_freq: sampleFrequencyHz, n_jobs: nJobs })
      .then((result) => {
        const defaults = normalizeDefaultUiValues((result as DetectorDefaultsResult).ui_values, DETECTOR_FIELDS.LSM);
        setValues((current) => {
          const existing = current.LSM || {};
          const next: Record<string, string> = { ...existing, preset };
          for (const key of LSM_PRESET_HYDRATE_KEYS) {
            if (defaults[key] !== undefined) next[key] = defaults[key];
          }
          if (preset !== 'Custom file / manual') next.parameter_file = '';
          return { ...current, LSM: next };
        });
        // Source-contract anchor: LSM preset ${preset} loaded into PyQt model parameter fields
        setFeedback(`LSM preset ${preset} loaded.`);
      })
      .catch((exc) => setFeedback(`LSM preset refresh failed: ${exc instanceof Error ? exc.message : String(exc)}`));
  }

  function applyDetector() {
    const currentValues = values[activeDetector] || {};
    const errors = validateDetectorValues(activeDetector, currentValues);
    if (errors.length) {
      setFeedback(`Validation failed: ${errors.join('; ')}`);
      return;
    }
    const snapshot = { ...currentValues };
    setAppliedValues((current) => ({ ...current, [activeDetector]: snapshot }));
    setAppliedFingerprints((current) => ({ ...current, [activeDetector]: detectorValueFingerprint(snapshot) }));
    setFeedback(`${activeDetector} parameters applied for ${biomarker}.`);
  }

  function runDetector() {
    const applied = appliedValues[activeDetector];
    const errors = validateDetectorValues(activeDetector, applied || {});
    if (errors.length) {
      setFeedback(`Validation failed: ${errors.join('; ')}`);
      return;
    }
    if (!hasRecording) {
      setFeedback('Load a recording before running detection.');
      return;
    }
    if (!detectorAvailability.available) {
      setFeedback(detectorAvailability.message);
      return;
    }
    if (!applied || !currentApplied) {
      // Source-contract anchor: Apply the current detector parameters before running
      setFeedback('Apply current detector parameters before running.');
      return;
    }
    const uiValues = applied;
    const detectorParams = detectorParamsForRun(activeDetector, uiValues);
    Promise.resolve(onRunDetection({ biomarker, detector: activeDetector, detectorParams, uiValues }))
      .then(() => setFeedback(`${activeDetector} ${biomarker} run submitted.`))
      .catch((exc) => setFeedback(exc instanceof Error ? exc.message : String(exc)));
  }


  async function exportProtocolPreset() {
    const currentValues = values[activeDetector] || {};
    const errors = validateDetectorValues(activeDetector, currentValues);
    if (errors.length) {
      setFeedback(`Protocol export blocked: ${errors.join('; ')}`);
      return;
    }
    const preset = buildProtocolPreset(biomarker, activeDetector, currentValues, prepareControls, sampleFrequencyHz);
    try {
      const result = await backendClient.saveProtocolPreset(preset) as { canceled?: boolean; artifact_path?: string };
      if (result?.canceled) {
        setFeedback('Protocol preset export cancelled.');
        return;
      }
      setAppliedValues((current) => ({ ...current, [activeDetector]: { ...currentValues } }));
      setAppliedFingerprints((current) => ({ ...current, [activeDetector]: detectorValueFingerprint(currentValues) }));
      setFeedback(`Protocol preset exported${result?.artifact_path ? `: ${result.artifact_path}` : ''}.`);
    } catch (exc) {
      setFeedback(`Protocol preset export failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  async function importProtocolPreset() {
    try {
      const preset = await backendClient.openProtocolPreset() as ProtocolPreset | null;
      if (!preset) {
        setFeedback('Protocol preset import cancelled.');
        return;
      }
      const restored = restoreProtocolPreset(preset, prepareControls);
      onBiomarkerChange(restored.biomarker);
      onPrepareControlsChange(restored.prepareControls);
      setActiveDetectorByBiomarker((current) => ({ ...current, [restored.biomarker]: restored.detector }));
      setValues((current) => ({ ...current, [restored.detector]: restored.uiValues }));
      setAppliedValues((current) => ({ ...current, [restored.detector]: restored.uiValues }));
      setAppliedFingerprints((current) => ({ ...current, [restored.detector]: detectorValueFingerprint(restored.uiValues) }));
      setFeedback(`Protocol preset imported: ${preset.name || restored.biomarker + ' ' + restored.detector}; Prepare/filter/N Jobs restored.`);
    } catch (exc) {
      setFeedback(`Protocol preset import failed: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }

  return (
    <div className="tab-content detect-layout" data-testid="workflow-detect-content">
      <div className="detector-setup-strip" data-testid="pyqt-detector_setup_strip">
        <section className="detector-mode-header" data-testid="pyqt-detector_mode_header">
          <div className="detector-mode-primary-row">
            <label className="detector-mode-field" data-testid="pyqt-detector_subtabs">Detector
              <select data-testid="pyqt-detector_mode_combo" value={activeDetector} disabled={detectors.length <= 1} onChange={(event) => setActiveDetector(event.target.value)}>
                {detectors.map((detector) => <option key={detector} value={detector}>{detector}</option>)}
              </select>
            </label>
            <div className="detector-run-actions">
              <button data-testid="pyqt-detector_apply_button" disabled={!hasRecording} onClick={applyDetector}>Apply</button>
              <button data-testid="pyqt-detector_run_button" className="primary-action" disabled={runDisabled} aria-disabled={runDisabled} title={detectorAvailability.available ? undefined : detectorAvailability.message} onClick={runDetector}>Run {activeDetector}</button>
            </div>
            <div className="protocol-preset-actions" data-testid="pyqt-protocol_preset_actions">
              <button data-testid="pyqt-protocol_export_button" onClick={exportProtocolPreset}>Export Protocol</button>
              <button data-testid="pyqt-protocol_import_button" onClick={importProtocolPreset}>Import Protocol</button>
            </div>
          </div>
          <p className="detector-mode-hint" data-testid="pyqt-detector_mode_hint">{detectorModeHint(biomarker, activeDetector, currentApplied, hasRecording, detectorAvailability)}</p>
        </section>
      </div>
      {!detectorAvailability.available && <p className="error-panel detector-runtime-warning" data-testid="pyqt-detector_runtime_warning">{detectorAvailability.message}</p>}
      <section className="panel-card detector-form-card" data-testid={formTestId}>
        <div className="detector-form-header">
          <h4>{activeDetector} Detection Parameters</h4>
          <span className="status-pill">{biomarker}</span>
        </div>
        <div className="detector-form-body">
          <section className="detector-parameter-section" aria-label={`${activeDetector} parameter inputs`}>
            <div className="field-grid detector-field-grid">
              {fields.map((field) => (
                <label key={field.key} className="detector-field">{field.label}
                  <span className="inline-field">
                    {field.kind === 'select' ? (
                      <select data-testid={field.testId} value={values[activeDetector]?.[field.key] ?? field.defaultValue ?? field.options?.[0] ?? ''} onChange={(event) => activeDetector === 'LSM' && field.key === 'preset' ? updateLsmPreset(event.target.value) : updateValue(field.key, event.target.value)}>
                        {(field.options || []).map((option) => <option key={option} value={option}>{option}</option>)}
                      </select>
                    ) : (
                      <input data-testid={field.testId} value={values[activeDetector]?.[field.key] ?? field.defaultValue ?? ''} placeholder={field.placeholder} onChange={(event) => updateValue(field.key, event.target.value)} />
                    )}
                    {field.unit && <span className="field-unit">{field.unit}</span>}
                  </span>
                </label>
              ))}
            </div>
          </section>
          {activeDetector === 'LSM' && <LsmModelParameters values={values[activeDetector] || {}} onChange={updateValue} />}
        </div>
        <DetectorAppliedDisplay detector={activeDetector} values={appliedValues[activeDetector] || null} currentApplied={currentApplied} />
        <p className="detector-feedback-line" data-testid="pyqt-detector_feedback">{feedback}</p>
      </section>
    </div>
  );
}

function LsmModelParameters({ values, onChange }: { values: Record<string, string>; onChange: (key: string, value: string) => void }) {
  const enabled = values.lsm_model_parameters_enabled === 'true';
  return (
    <details className="detector-advanced lsm-model-parameters" data-testid="pyqt-lsm_model_parameters_group" open={enabled}>
      <summary>
        <label className="select-toggle">
          <input data-testid="pyqt-lsm_model_parameters_checkbox" type="checkbox" checked={enabled} onChange={(event) => onChange('lsm_model_parameters_enabled', event.target.checked ? 'true' : 'false')} />
          Model Parameters
        </label>
      </summary>
      <p className="helper-copy">Manual LSM parameters: window/step, theta and 9-15 index sets, μ, σ, and 2×2 transition matrix.</p>
      <div className="field-grid detector-field-grid lsm-model-grid" data-testid="pyqt-lsm_model_parameters_content">
        {LSM_MODEL_FIELDS.map((field) => (
          <label key={field.key}>{field.label}
            <span className="inline-field">
              <input data-testid={field.testId} value={values[field.key] ?? field.defaultValue ?? ''} disabled={!enabled} onChange={(event) => onChange(field.key, event.target.value)} />
              {field.unit && <span>{field.unit}</span>}
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

function DetectorAppliedDisplay({ detector, values, currentApplied }: { detector: string; values: Record<string, string> | null; currentApplied: boolean }) {
  const fields = useMemo(() => DETECTOR_DISPLAY_FIELDS[detector] || [], [detector]);
  const appliedStateLabel = values ? (currentApplied ? 'Ready to Run' : 'Changed - Apply again') : 'Not applied';
  return (
    <section className="detector-applied-display" data-testid={`pyqt-detector_display_${detector.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`} data-applied-current={currentApplied ? 'true' : 'false'}>
      <div className="detector-display-heading"><span className="detector-display-title">Applied Parameters</span><span className="status-pill">{appliedStateLabel}</span></div>
      <div className="detector-display-grid">
        {values ? fields.map((field) => (
          <div className="detector-display-cell" key={field.testId}>
            <span>{field.label}</span>
            <output data-testid={field.testId}>{detectorDisplayValue(field, values)}</output>
          </div>
        )) : (
          <p className="detector-display-empty" data-testid="pyqt-detector_display_empty">No parameters applied yet — set values above and choose Apply.</p>
        )}
      </div>
    </section>
  );
}


function buildProtocolPreset(biomarker: BiomarkerType, detector: string, uiValues: Record<string, string>, prepareControls: PrepareControlsState, sampleFrequencyHz?: number): ProtocolPreset {
  return {
    format: 'pybrain-protocol-preset',
    version: 1,
    name: `${biomarker} ${detector} protocol`,
    biomarker_type: biomarker,
    prepare: {
      fp: prepareControls.fp,
      fs: prepareControls.fs,
      rp: prepareControls.rp,
      rs: prepareControls.rs,
      nJobs: prepareControls.nJobs,
      n_jobs: prepareControls.nJobs,
      lineNoiseNotchHz: prepareControls.lineNoiseNotchHz,
      resampleSfreq: prepareControls.resampleSfreq,
      dropBadChannels: prepareControls.dropBadChannels,
      dropFlatChannels: prepareControls.dropFlatChannels,
      markOutlierChannels: prepareControls.markOutlierChannels,
      dropOutlierChannels: prepareControls.dropOutlierChannels
    },
    detector: {
      name: detector,
      ui_values: { ...uiValues, sample_frequency_hz: sampleFrequencyHz == null ? '' : String(sampleFrequencyHz) },
      detector_params: detectorParamsForRun(detector, uiValues)
    }
  };
}

function restoreProtocolPreset(preset: ProtocolPreset, currentPrepareControls: PrepareControlsState): { biomarker: BiomarkerType; detector: string; uiValues: Record<string, string>; prepareControls: PrepareControlsState } {
  if (preset.format !== 'pybrain-protocol-preset') throw new Error('Unsupported protocol preset format.');
  const biomarker = preset.biomarker_type;
  if (!biomarker || !detectorTabsByBiomarker[biomarker]) throw new Error('Protocol preset biomarker must be HFO, Spindle, or Spike.');
  const detector = String(preset.detector?.name || '');
  if (!detectorTabsByBiomarker[biomarker].includes(detector)) throw new Error(`Protocol detector ${detector || '(missing)'} is not valid for ${biomarker}.`);
  const fields = DETECTOR_FIELDS[detector] || [];
  const uiValues = normalizeDefaultUiValues(preset.detector?.ui_values, fields);
  if (!Object.keys(uiValues).length) throw new Error('Protocol preset is missing detector UI values.');
  return { biomarker, detector, uiValues: { ...valuesForFields(fields), ...uiValues }, prepareControls: restoreProtocolPrepareControls(preset.prepare, currentPrepareControls) };
}

function restoreProtocolPrepareControls(prepare: ProtocolPreset['prepare'], current: PrepareControlsState): PrepareControlsState {
  if (!prepare) return current;
  return {
    ...current,
    fp: protocolString(prepare.fp, current.fp),
    fs: protocolString(prepare.fs, current.fs),
    rp: protocolString(prepare.rp, current.rp),
    rs: protocolString(prepare.rs, current.rs),
    nJobs: protocolPositiveInteger(prepare.nJobs ?? prepare.n_jobs, current.nJobs),
    lineNoiseNotchHz: protocolString(prepare.lineNoiseNotchHz, current.lineNoiseNotchHz),
    resampleSfreq: protocolString(prepare.resampleSfreq, current.resampleSfreq),
    dropBadChannels: protocolBoolean(prepare.dropBadChannels, current.dropBadChannels),
    dropFlatChannels: protocolBoolean(prepare.dropFlatChannels, current.dropFlatChannels),
    markOutlierChannels: protocolBoolean(prepare.markOutlierChannels, current.markOutlierChannels),
    dropOutlierChannels: protocolBoolean(prepare.dropOutlierChannels, current.dropOutlierChannels)
  };
}

function protocolString(value: unknown, fallback: string): string {
  return value == null ? fallback : String(value);
}

function protocolBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function protocolPositiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

type DetectorRuntimeAvailability = { available: boolean; message: string };

function detectorRuntimeAvailability(biomarker: BiomarkerType, detector: string, manifest: CapabilityManifest | null): DetectorRuntimeAvailability {
  if (biomarker === 'Spindle' && detector === 'YASA' && manifest?.optional_dependencies?.yasa?.available === false) {
    return { available: false, message: manifest.optional_dependencies.yasa.install_hint || "Install the optional 'yasa' package to run YASA spindle detection." };
  }
  return { available: true, message: '' };
}

function detectorModeHint(biomarker: BiomarkerType, detector: string, currentApplied: boolean, hasRecording: boolean, availability: DetectorRuntimeAvailability): string {
  if (!hasRecording) return 'Open a recording before applying or running detector settings.';
  if (!availability.available) return availability.message;
  if (!currentApplied) return `${detector} parameters need Apply before the next ${biomarker} run.`;
  return `${detector} parameters are applied; Run ${detector} will submit a new ${biomarker} analysis.`;
}

function detectorDisplayValue(field: DetectorDisplayField, values: Record<string, string> | null): string {
  if (!values) return '--';
  if (field.range) {
    const [left, right] = field.range;
    const leftValue = values[left] || '';
    const rightValue = values[right] || '';
    return leftValue || rightValue ? `${leftValue} - ${rightValue}` : '--';
  }
  if (field.key === 'parameter_file') {
    if (values.lsm_model_parameters_enabled === 'true') return 'Manual parameters';
    const source = values.parameter_file || values.preset_path || '';
    return source ? source.split(/[\\/]/).pop() || source : '--';
  }
  if (field.key === 'narrowband') {
    return values.start_frequency || values.stop_frequency ? `${values.start_frequency || ''} - ${values.stop_frequency || ''}` : 'Broadband';
  }
  return values[field.key] || field.fallback || '--';
}

function detectorValueFingerprint(values: Record<string, string>): string {
  return JSON.stringify(Object.keys(values).sort().map((key) => [key, values[key]]));
}

function numericValue(values: Record<string, string>, key: string): number | undefined {
  const raw = values[key];
  if (raw == null || String(raw).trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function percentFraction(values: Record<string, string>, key: string): number | undefined {
  const value = numericValue(values, key);
  if (value == null) return undefined;
  return value > 1 ? value / 100 : value;
}

function pair(values: Record<string, string>, left: string, right: string): [number, number] | undefined {
  const l = numericValue(values, left);
  const r = numericValue(values, right);
  return l == null || r == null ? undefined : [l, r];
}

function parseIndexList(values: Record<string, string>, key: string): number[] | undefined {
  const raw = values[key];
  if (!raw || !raw.trim()) return undefined;
  const parsed = raw.split(/[,\s;]+/).map((part) => Number(part)).filter((value) => Number.isFinite(value));
  return parsed.length ? parsed : undefined;
}

function parsePresetPaths(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item || '')])) : {};
  } catch {
    return {};
  }
}

function lsmModelParametersForRun(values: Record<string, string>): Record<string, unknown> {
  return {
    format: 'pyhfo_kramer_lsm_preset',
    schema_version: 1,
    name: 'Manual LSM parameters',
    source: 'Electron manual entry',
    index_base: 1,
    params: {
      window_duration: numericValue(values, 'lsm_window_duration'),
      step_duration: numericValue(values, 'lsm_step_duration'),
      theta_index: parseIndexList(values, 'lsm_theta_index'),
      nine_15_index: parseIndexList(values, 'lsm_nine_15_index')
    },
    mu: {
      log_P_theta1: numericValue(values, 'lsm_mu_log_p_theta1'),
      log_P_theta0: numericValue(values, 'lsm_mu_log_p_theta0'),
      log_P_9_15_1: numericValue(values, 'lsm_mu_log_p_9_15_1'),
      log_P_9_15_0: numericValue(values, 'lsm_mu_log_p_9_15_0'),
      F1: numericValue(values, 'lsm_mu_f1'),
      F0: numericValue(values, 'lsm_mu_f0')
    },
    sigma: {
      log_P_theta1: numericValue(values, 'lsm_sigma_log_p_theta1'),
      log_P_theta0: numericValue(values, 'lsm_sigma_log_p_theta0'),
      log_P_9_15_1: numericValue(values, 'lsm_sigma_log_p_9_15_1'),
      log_P_9_15_0: numericValue(values, 'lsm_sigma_log_p_9_15_0'),
      F1: numericValue(values, 'lsm_sigma_f1'),
      F0: numericValue(values, 'lsm_sigma_f0')
    },
    transition_matrix: [
      [numericValue(values, 'lsm_transition_00'), numericValue(values, 'lsm_transition_01')],
      [numericValue(values, 'lsm_transition_10'), numericValue(values, 'lsm_transition_11')]
    ]
  };
}

function definedParams(params: Record<string, DetectorParamValue | undefined>): Record<string, DetectorParamValue> {
  const result: Record<string, DetectorParamValue> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function detectorParamsForRun(detector: string, values: Record<string, string>): Record<string, DetectorParamValue> {
  if (detector === 'STE') return definedParams({ rms_window: numericValue(values, 'rms_window'), min_window: numericValue(values, 'min_window'), min_gap: numericValue(values, 'min_gap'), min_osc: numericValue(values, 'min_oscillation'), peak_thres: numericValue(values, 'peak_threshold'), rms_thres: numericValue(values, 'rms_threshold'), epoch_len: numericValue(values, 'epoch_length') });
  if (detector === 'MNI') return definedParams({ epoch_time: numericValue(values, 'epoch_time'), min_win: numericValue(values, 'min_window'), per_CHF: percentFraction(values, 'chf_percentage'), thrd_perc: percentFraction(values, 'threshold_percentage'), min_gap: numericValue(values, 'min_gap_time'), epo_CHF: numericValue(values, 'epoch_chf'), base_seg: numericValue(values, 'baseline_window'), base_shift: numericValue(values, 'baseline_shift'), base_thrd: numericValue(values, 'baseline_threshold'), base_min: numericValue(values, 'baseline_min_time') });
  if (detector === 'HIL') return definedParams({ pass_band: numericValue(values, 'pass_band'), stop_band: numericValue(values, 'stop_band'), sd_threshold: numericValue(values, 'sd_threshold'), min_window: numericValue(values, 'min_window'), epoch_time: numericValue(values, 'epoch_time') });
  if (detector === 'RMS') return definedParams({ rms_window: numericValue(values, 'window'), min_window: numericValue(values, 'min_duration'), max_window: numericValue(values, 'max_duration'), min_gap: numericValue(values, 'min_gap'), threshold: numericValue(values, 'threshold'), peak_threshold: numericValue(values, 'peak_threshold') });
  if (detector === 'LineLength') return definedParams({ ll_window: numericValue(values, 'window'), min_window: numericValue(values, 'min_duration'), max_window: numericValue(values, 'max_duration'), min_gap: numericValue(values, 'min_gap'), threshold: numericValue(values, 'threshold'), peak_threshold: numericValue(values, 'peak_threshold') });
  if (detector === 'YASA') return definedParams({ freq_sp: pair(values, 'freq_sp_low', 'freq_sp_high'), freq_broad: pair(values, 'freq_broad_low', 'freq_broad_high'), duration: pair(values, 'duration_low', 'duration_high'), min_distance: numericValue(values, 'min_distance'), rel_pow: numericValue(values, 'rel_power'), corr: numericValue(values, 'correlation'), rms: numericValue(values, 'rms') });
  if (detector === 'LSM') {
    const manualModel = values.lsm_model_parameters_enabled === 'true';
    return definedParams({ parameter_file: manualModel ? '' : (values.parameter_file || values.preset_path || ''), model_parameters: manualModel ? lsmModelParametersForRun(values) : {}, prob_threshold: numericValue(values, 'probability'), min_spindle_duration: numericValue(values, 'min_duration'), spindle_separation_threshold: numericValue(values, 'separation'), min_peak_prominence: numericValue(values, 'min_prominence'), start_frequency: numericValue(values, 'start_frequency') ?? null, stop_frequency: numericValue(values, 'stop_frequency') ?? null });
  }
  if (detector === 'A7') return definedParams({ freq_sp: pair(values, 'freq_low', 'freq_high'), duration: pair(values, 'duration_low', 'duration_high'), min_distance: numericValue(values, 'min_distance'), smooth_window: numericValue(values, 'smooth_window'), rms_threshold: numericValue(values, 'rms_threshold'), freq_broad: pair(values, 'broad_low', 'broad_high'), relative_power_threshold: numericValue(values, 'relative_power_threshold'), correlation_threshold: numericValue(values, 'correlation_threshold') });
  if (detector === 'MOLLE') return definedParams({ method: 'MOLLE', freq_sp: pair(values, 'freq_low', 'freq_high'), duration: pair(values, 'duration_low', 'duration_high'), min_distance: numericValue(values, 'min_distance'), smooth_window: numericValue(values, 'smooth_window'), rms_threshold: numericValue(values, 'rms_threshold') });
  if (detector === 'RMS/LL') return definedParams({ rms_window: numericValue(values, 'rms_window'), ll_window: numericValue(values, 'll_window'), min_window: numericValue(values, 'min_duration'), max_window: numericValue(values, 'max_duration'), min_gap: numericValue(values, 'min_gap'), rms_thres: numericValue(values, 'rms_threshold'), ll_thres: numericValue(values, 'll_threshold'), peak_thres: numericValue(values, 'peak_threshold') });
  return {};
}

function initialDetectorValues(): DetectorFormState {
  const values: DetectorFormState = {};
  for (const [detector, fields] of Object.entries(DETECTOR_FIELDS)) {
    values[detector] = valuesForFields(fields);
  }
  return values;
}

function valuesForFields(fields: DetectorField[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [field.key, field.defaultValue || field.options?.[0] || '']));
}

function normalizeDefaultUiValues(values: Record<string, unknown> | undefined, _fields: DetectorField[]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(values || {})) {
    normalized[key] = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return normalized;
}

function validateDetectorValues(detector: string, values: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const field of DETECTOR_FIELDS[detector] || []) {
    const value = values[field.key] ?? field.defaultValue ?? '';
    if (field.kind === 'select' || !String(value).trim()) continue;
    if (!Number.isFinite(Number(value))) errors.push(`${field.label} must be numeric`);
  }
  if (detector === 'LSM') {
    const probability = numericValue(values, 'probability');
    if (probability != null && probability > 1) errors.push('LSM Probability must be <= 1');
    const start = numericValue(values, 'start_frequency');
    const stop = numericValue(values, 'stop_frequency');
    if ((start == null) !== (stop == null)) errors.push('LSM start and stop frequency must be provided together');
    if (start != null && stop != null && start >= stop) errors.push('LSM stop frequency must be greater than start frequency');
    if (values.lsm_model_parameters_enabled === 'true') {
      for (const field of LSM_MODEL_FIELDS) {
        const raw = values[field.key] || '';
        if (!raw.trim()) errors.push(`${field.label} is required for manual LSM model parameters`);
        else if (field.key.includes('_index')) {
          const indexes = parseIndexList(values, field.key);
          if (!indexes?.length || indexes.some((index) => !Number.isInteger(index) || index < 1)) errors.push(`${field.label} must contain positive 1-based integer indexes`);
        } else if (!Number.isFinite(Number(raw))) {
          errors.push(`${field.label} must be numeric`);
        }
      }
    } else if (!(values.parameter_file || values.preset_path)) {
      errors.push('LSM requires a preset, parameter file, or manual model parameters');
    }
  }
  return errors;
}
