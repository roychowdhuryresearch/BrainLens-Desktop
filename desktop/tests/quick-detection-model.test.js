import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadQuickDetectionModel() {
  const source = readFileSync(join(root, 'src/features/shell/quickDetectionModel.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modelPromise = loadQuickDetectionModel();

function quickState(model, patch = {}) {
  return {
    ...model.DEFAULT_QD_STATE,
    filter: { ...model.DEFAULT_QD_STATE.filter },
    classifier: { ...model.DEFAULT_QD_STATE.classifier },
    saveAs: { ...model.DEFAULT_QD_STATE.saveAs },
    detectorValues: { ...model.DEFAULT_QD_STATE.detectorValues },
    ...patch
  };
}

test('quick detection detector lists mirror PyQt biomarker pages', async () => {
  const model = await modelPromise;
  assert.deepEqual(model.quickDetectionDetectorsForBiomarker('HFO'), ['MNI', 'STE', 'HIL', 'RMS', 'LineLength']);
  assert.deepEqual(model.quickDetectionDetectorsForBiomarker('Spindle'), ['YASA', 'LSM', 'A7', 'MOLLE']);
  assert.deepEqual(model.quickDetectionDetectorsForBiomarker('Spike'), ['RMS/LL']);
  assert.equal(model.quickDetectionDefaultDetectorForBiomarker('HFO'), 'MNI');
  assert.equal(model.quickDetectionDefaultDetectorForBiomarker('Spindle'), 'YASA');
  assert.equal(model.quickDetectionDefaultDetectorForBiomarker('Spike'), 'RMS/LL');
});

test('quick detection initial defaults mirror PyQt quick window', async () => {
  const model = await modelPromise;
  assert.deepEqual(model.DEFAULT_QD_STATE.filter, { fp: '80', fs: '500', rp: '0.5', rs: '93' });
  assert.equal(model.DEFAULT_QD_STATE.detector, 'MNI');
  assert.equal(model.DEFAULT_QD_STATE.classifier.useClassifier, true);
  assert.equal(model.DEFAULT_QD_STATE.classifier.useSpike, true);
  assert.equal(model.DEFAULT_QD_STATE.classifier.useEhfo, true);
  assert.equal(model.DEFAULT_QD_STATE.classifier.device, 'CPU');
  assert.equal(model.DEFAULT_QD_STATE.classifier.batchSize, '32');
  assert.deepEqual(model.quickDetectionFieldDefaultValues('MNI'), {
    mni_epoch_time: '10',
    mni_baseline_window: '0.125',
    mni_epoch_chf: '60',
    mni_baseline_shift: '0.5',
    mni_chf_percentage: '0.95',
    mni_baseline_threshold: '0.67',
    mni_min_window: '0.01',
    mni_threshold_percentage: '99.9999',
    mni_min_gap_time: '0.01',
    mni_baseline_time: '5'
  });
});

test('quick detection backend defaults hydrate every expanded detector page', async () => {
  const model = await modelPromise;
  const rms = model.quickDetectionDefaultValues('RMS', { window: 0.004, min_duration: 0.007, max_duration: 0.12, threshold: 4 });
  assert.equal(rms.rms_window, '0.004');
  assert.equal(rms.min_window, '0.007');
  assert.equal(rms.max_window, '0.12');
  assert.equal(rms.threshold, '4');

  const lineLength = model.quickDetectionDefaultValues('LineLength', { window: 0.011, min_duration: 0.008 });
  assert.equal(lineLength.ll_window, '0.011');
  assert.equal(lineLength.min_window, '0.008');

  const yasa = model.quickDetectionDefaultValues('YASA', { rel_power: 0.22, correlation: 0.7, freq_sp_low: 11, freq_sp_high: 16 });
  assert.equal(yasa.rel_pow, '0.22');
  assert.equal(yasa.corr, '0.7');
  assert.equal(yasa.freq_sp_low, '11');
  assert.equal(yasa.freq_sp_high, '16');

  const lsm = model.quickDetectionDefaultValues('LSM', { probability: 0.92, min_duration: 0.45, separation: 0.8, min_prominence: 0.000003 });
  assert.equal(lsm.prob_threshold, '0.92');
  assert.equal(lsm.min_spindle_duration, '0.45');
  assert.equal(lsm.spindle_separation_threshold, '0.8');
  assert.equal(lsm.min_peak_prominence, '0.000003');

  const a7 = model.quickDetectionDefaultValues('A7', { freq_low: 10, freq_high: 17, broad_low: 1, broad_high: 28 });
  assert.equal(a7.freq_sp_low, '10');
  assert.equal(a7.freq_sp_high, '17');
  assert.equal(a7.freq_broad_low, '1');
  assert.equal(a7.freq_broad_high, '28');

  const molle = model.quickDetectionDefaultValues('MOLLE', { freq_low: 12.5, freq_high: 15.5 });
  assert.equal(molle.freq_sp_low, '12.5');
  assert.equal(molle.freq_sp_high, '15.5');

  const spike = model.quickDetectionDefaultValues('RMS/LL', { rms_threshold: 6, ll_threshold: 7, min_duration: 0.02, max_duration: 0.08 });
  assert.equal(spike.rms_thres, '6');
  assert.equal(spike.ll_thres, '7');
  assert.equal(spike.min_window, '0.02');
  assert.equal(spike.max_window, '0.08');
});

test('quick detection defaults merge without clobbering edited values', async () => {
  const model = await modelPromise;
  const merged = model.mergeQuickDetectorDefaults({ rms_window: 'custom', min_window: '', max_window: '0.2' }, 'RMS', { rms_window: '0.004', min_window: '0.007', max_window: '0.12' });
  assert.equal(merged.rms_window, 'custom');
  assert.equal(merged.min_window, '0.007');
  assert.equal(merged.max_window, '0.12');
});

test('quick detection parameter payloads preserve PyQt units and backend keys', async () => {
  const model = await modelPromise;
  assert.deepEqual(model.quickDetectionDetectorParams('STE', {
    ste_min_oscillation: '6',
    ste_rms_threshold: '3',
    ste_rms_window: '4',
    ste_epoch_length: '10',
    ste_min_window: '7',
    ste_peak_threshold: '5',
    ste_min_gap: '11'
  }), {
    min_osc: 6,
    rms_thres: 3,
    rms_window: 0.004,
    epoch_len: 10,
    min_window: 0.007,
    peak_thres: 5,
    min_gap: 0.011
  });

  assert.deepEqual(model.quickDetectionDetectorParams('YASA', {
    freq_sp_low: '12', freq_sp_high: '15', freq_broad_low: '1', freq_broad_high: '30', duration_low: '0.5', duration_high: '2.5', min_distance: '500', corr: '0.65', rel_pow: '0.2', rms: '1.5'
  }), {
    freq_sp: [12, 15],
    freq_broad: [1, 30],
    duration: [0.5, 2.5],
    min_distance: 500,
    corr: 0.65,
    rel_pow: 0.2,
    rms: 1.5
  });

  assert.deepEqual(model.quickDetectionDetectorParams('RMS/LL', {
    rms_window: '0.004', ll_window: '0.01', min_window: '0.006', max_window: '0.1', min_gap: '0.02', rms_thres: '5', ll_thres: '6', peak_thres: '3'
  }), {
    rms_window: 0.004,
    ll_window: 0.01,
    min_window: 0.006,
    max_window: 0.1,
    min_gap: 0.02,
    rms_thres: 5,
    ll_thres: 6,
    peak_thres: 3
  });
});

test('quick detection validation enforces active PyQt page ranges and allows LSM path fields', async () => {
  const model = await modelPromise;
  const yasaState = quickState(model, {
    biomarker: 'Spindle',
    detector: 'YASA',
    classifier: { ...model.DEFAULT_QD_STATE.classifier, useClassifier: false },
    detectorValues: { ...model.quickDetectionFieldDefaultValues('YASA'), freq_sp_low: '16', freq_sp_high: '12' }
  });
  assert.ok(model.validateQuickDetectionState(yasaState).includes('Spindle band low value must be lower than the high value'));

  const spikeState = quickState(model, {
    biomarker: 'Spike',
    detector: 'RMS/LL',
    classifier: { ...model.DEFAULT_QD_STATE.classifier, useClassifier: false },
    detectorValues: { ...model.quickDetectionFieldDefaultValues('RMS/LL'), min_window: '0.2', max_window: '0.1' }
  });
  assert.ok(model.validateQuickDetectionState(spikeState).includes('Min duration must be lower than max duration'));

  const lsmState = quickState(model, {
    biomarker: 'Spindle',
    detector: 'LSM',
    classifier: { ...model.DEFAULT_QD_STATE.classifier, useClassifier: false },
    detectorValues: { ...model.quickDetectionFieldDefaultValues('LSM'), parameter_file: '/tmp/kramer-params.mat', prob_threshold: '0.95', min_spindle_duration: '0.5', spindle_separation_threshold: '1', min_peak_prominence: '0.000002' }
  });
  assert.deepEqual(model.validateQuickDetectionState(lsmState), []);
});

test('quick detection classifier payload is executable and normalized', async () => {
  const model = await modelPromise;
  const payload = model.quickDetectionClassifierPayload(quickState(model, {
    classifier: {
      ...model.DEFAULT_QD_STATE.classifier,
      artifactModel: '/models/artifact.zip',
      spikeModel: 'File Name...',
      ehfoModel: '/models/ehfo.zip',
      useSpike: true,
      useEhfo: true,
      device: 'GPU',
      batchSize: '32',
      ignoreBefore: '2',
      ignoreAfter: '3'
    }
  }));
  assert.equal(payload.device, 'cuda:0');
  assert.equal(payload.model_type, 'default_gpu');
  assert.equal(payload.artifact_path, '/models/artifact.zip');
  assert.equal(payload.spike_path, null);
  assert.deepEqual(payload.ignore_region, [2, 3]);
  assert.deepEqual(payload.steps, ['artifact', 'spike', 'ehfo']);
});

test('P0-1 parity: YASA spindle duration max default is 2.0 (ParamYASA), not A7 2.5', async () => {
  const model = await modelPromise;
  const yasa = model.quickDetectionFieldDefaultValues('YASA');
  assert.equal(yasa.duration_low, '0.5');
  assert.equal(yasa.duration_high, '2.0'); // PyQt ParamYASA duration=(0.5, 2)
  // A7 (2.5) and MOLLE (3.0) duration maxima are correct per param_detector.py — must stay unchanged.
  assert.equal(model.quickDetectionFieldDefaultValues('A7').duration_high, '2.5');
  assert.equal(model.quickDetectionFieldDefaultValues('MOLLE').duration_high, '3.0');
});

test('P0-2 parity: QD filter band retunes per biomarker like PyQt _default_filter_param_for_biomarker', async () => {
  const model = await modelPromise;
  assert.deepEqual(model.quickDetectionDefaultFilterForBiomarker('HFO'), { fp: '80', fs: '500', rp: '0.5', rs: '93' });
  assert.deepEqual(model.quickDetectionDefaultFilterForBiomarker('Spike'), { fp: '4', fs: '80', rp: '0.5', rs: '93' }); // ParamFilter(fp=4, fs=80)
  assert.deepEqual(model.quickDetectionDefaultFilterForBiomarker('Spindle'), { fp: '1', fs: '30', rp: '0.5', rs: '93' }); // ParamFilterSpindle()
});

test('P0-2 parity: filter stop band clamps below Nyquist like PyQt _recommended_filter_param', async () => {
  const model = await modelPromise;
  // 200 Hz recording -> Nyquist 100 -> stop band clamps to 98.9 (matches PyQt _filter_stop_band_limit)
  assert.deepEqual(model.quickDetectionDefaultFilterForBiomarker('HFO', 200), { fp: '80', fs: '98.9', rp: '0.5', rs: '93' });
  // 2000 Hz recording -> Nyquist 1000 -> 80/500 well within range, unchanged
  assert.deepEqual(model.quickDetectionDefaultFilterForBiomarker('HFO', 2000), { fp: '80', fs: '500', rp: '0.5', rs: '93' });
  // Spike 4/80 at 200 Hz stays valid (80 < 98.9 limit)
  assert.deepEqual(model.quickDetectionDefaultFilterForBiomarker('Spike', 200), { fp: '4', fs: '80', rp: '0.5', rs: '93' });
});

test('P0-5 parity: STE/HIL/Spike QD fields seed PyQt Param defaults and round-trip exactly', async () => {
  const model = await modelPromise;
  const ste = model.quickDetectionFieldDefaultValues('STE');
  assert.equal(ste.ste_min_oscillation, '6');
  assert.equal(ste.ste_rms_threshold, '5');
  assert.equal(ste.ste_rms_window, '3');   // ParamSTE rms_window=3e-3 s, shown in ms
  assert.equal(ste.ste_epoch_length, '600');
  assert.equal(ste.ste_min_window, '6');   // 6e-3 s in ms
  assert.equal(ste.ste_peak_threshold, '3');
  assert.equal(ste.ste_min_gap, '10');     // 10e-3 s in ms
  const steParams = model.quickDetectionDetectorParams('STE', ste);
  assert.equal(steParams.rms_window, 0.003);
  assert.equal(steParams.min_window, 0.006);
  assert.equal(steParams.min_gap, 0.01);

  assert.deepEqual(model.quickDetectionFieldDefaultValues('HIL'), {
    hil_sd_threshold: '5', hil_pass_band: '80', hil_sample_freq: '2000', hil_min_window: '0.01', hil_epoch_time: '3600', hil_stop_band: '500'
  });

  assert.deepEqual(model.quickDetectionFieldDefaultValues('RMS/LL'), {
    rms_window: '0.02', ll_window: '0.01', min_window: '0.015', max_window: '0.05', min_gap: '0.08', rms_thres: '5.0', ll_thres: '5.0', peak_thres: '6.0'
  });
});

test('P1-QD parity: filter validation enforces fp<fs and fs<Nyquist', async () => {
  const model = await modelPromise;
  const base = quickState(model, { classifier: { ...model.DEFAULT_QD_STATE.classifier, useClassifier: false } });
  const badBand = { ...base, filter: { ...base.filter, fp: '600', fs: '500' } };
  assert.ok(model.validateQuickDetectionState(badBand).includes('Filter pass band must be lower than the stop band'));
  // 80/500 exceeds the Nyquist of a 200 Hz recording (limit 100 Hz)
  const aboveNyquist = { ...base, filter: { ...base.filter, fp: '80', fs: '500' } };
  assert.ok(model.validateQuickDetectionState(aboveNyquist, 200).some((e) => e.includes('Nyquist')));
  // 80/500 is valid at 2000 Hz (Nyquist 1000) -> no filter errors
  const okErrs = model.validateQuickDetectionState({ ...base, filter: { ...base.filter, fp: '80', fs: '500' } }, 2000);
  assert.ok(!okErrs.some((e) => e.includes('Nyquist') || e.includes('pass band must be lower')));
});
