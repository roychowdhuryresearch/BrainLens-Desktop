#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outputPath = join(desktopRoot, 'artifacts/production-signoff-audit.json');
const artifactPaths = {
  layout: join(desktopRoot, 'artifacts/layout-smoke.json'),
  realFixture: join(desktopRoot, 'artifacts/real-fixture-smoke.json'),
  electronRealRecording: join(desktopRoot, 'artifacts/electron-real-recording-smoke.json'),
  packaged: join(desktopRoot, 'artifacts/packaged-electron-smoke.json'),
  packagedColdStart: join(desktopRoot, 'artifacts/packaged-cold-start-smoke.json'),
  hfOnnxRuntime: join(desktopRoot, 'artifacts/hf-onnx-runtime-smoke.json')
};

function readJsonArtifact(label, path, failures) {
  if (!existsSync(path)) {
    failures.push(`${label} artifact missing: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    failures.push(`${label} artifact is not valid JSON: ${path} (${error})`);
    return null;
  }
}

function readOptionalJsonArtifact(label, path, failures) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    failures.push(`${label} artifact is not valid JSON: ${path} (${error})`);
    return null;
  }
}

function electronRealRecordingPassed(artifact) {
  const summary = artifact?.summary || {};
  return artifact?.status === 'passed' &&
    Number(summary.prepared_channels || 0) > 0 &&
    Number(summary.detection_events || 0) > 0 &&
    Number(summary.classified_events || 0) > 0 &&
    Number(summary.failed_console_errors || 0) === 0 &&
    Number(summary.page_errors || 0) === 0 &&
    Number(summary.dialogs || 0) === 0;
}

const failures = [];
const artifacts = {
  layout: readJsonArtifact('layout', artifactPaths.layout, failures),
  realFixture: readJsonArtifact('realFixture', artifactPaths.realFixture, failures),
  electronRealRecording: readOptionalJsonArtifact('electronRealRecording', artifactPaths.electronRealRecording, failures),
  packaged: readJsonArtifact('packaged', artifactPaths.packaged, failures),
  packagedColdStart: readJsonArtifact('packagedColdStart', artifactPaths.packagedColdStart, failures),
  hfOnnxRuntime: readJsonArtifact('hfOnnxRuntime', artifactPaths.hfOnnxRuntime, failures)
};

if (artifacts.layout) {
  if (artifacts.layout.failures?.length) failures.push(`layout smoke has failures: ${artifacts.layout.failures.join('; ')}`);
}
const realFixtureDetectorReady = artifacts.realFixture?.status === 'passed' && artifacts.realFixture.optional_detection_enabled === true;
const electronRealRecordingReady = electronRealRecordingPassed(artifacts.electronRealRecording);
if (!realFixtureDetectorReady && !electronRealRecordingReady) {
  const realFixtureStatus = artifacts.realFixture?.status || '<missing status>';
  const electronStatus = artifacts.electronRealRecording?.status || '<missing status>';
  failures.push(`real recording detector/classifier smoke did not pass with usable event evidence; real-fixture=${realFixtureStatus}, electron-real-recording=${electronStatus}.`);
}
if (artifacts.packaged) {
  if (artifacts.packaged.status !== 'passed') failures.push(`packaged Electron smoke is not passed: ${artifacts.packaged.status || '<missing status>'}`);
}
if (artifacts.packagedColdStart) {
  if (artifacts.packagedColdStart.status !== 'passed') failures.push(`packaged cold-start smoke is not passed: ${artifacts.packagedColdStart.status || '<missing status>'}`);
  if (!(Number(artifacts.packagedColdStart.timings?.first_window_ms || 0) > 0)) failures.push('packaged cold-start first-window timing evidence is missing.');
  if (artifacts.packagedColdStart.backend_status?.status !== 'ok') failures.push('packaged cold-start backend health evidence is missing.');
  const firstWindowBudget = Number(artifacts.packagedColdStart.budgets?.max_first_window_ms || 15000);
  const mainReadyBudget = Number(artifacts.packagedColdStart.budgets?.max_main_window_ready_ms || 18000);
  if (Number(artifacts.packagedColdStart.timings?.first_window_ms || 0) > firstWindowBudget) failures.push('packaged cold-start first-window budget was exceeded.');
  if (Number(artifacts.packagedColdStart.timings?.main_window_ready_ms || 0) > mainReadyBudget) failures.push('packaged cold-start main-window budget was exceeded.');
}
if (artifacts.hfOnnxRuntime) {
  if (artifacts.hfOnnxRuntime.status !== 'passed') failures.push(`HF ONNX runtime smoke is not passed: ${artifacts.hfOnnxRuntime.status || '<missing status>'}`);
  if (artifacts.hfOnnxRuntime.checks?.online_models_loaded !== true) failures.push('HF ONNX runtime online model download/load evidence is missing.');
  if (artifacts.hfOnnxRuntime.checks?.offline_models_loaded !== true) failures.push('HF ONNX runtime offline cache model-load evidence is missing.');
  if (artifacts.hfOnnxRuntime.checks?.online_registry_complete !== true || artifacts.hfOnnxRuntime.checks?.offline_registry_complete !== true) failures.push('HF ONNX runtime registry completeness evidence is missing.');
}

const buildOutputs = {
  renderer_index: existsSync(join(desktopRoot, 'dist-renderer/index.html')),
  electron_main: existsSync(join(desktopRoot, 'dist-electron/main.js'))
};
if (!buildOutputs.renderer_index) failures.push('production renderer build missing: desktop/dist-renderer/index.html');
if (!buildOutputs.electron_main) failures.push('production Electron main build missing: desktop/dist-electron/main.js');

const report = {
  generated_at: new Date().toISOString(),
  status: failures.length ? 'blocked' : 'ready',
  artifact_paths: artifactPaths,
  build_outputs: buildOutputs,
  signoff_requirements: [
    'static fixed-pane layout smoke passed',
    'real recording smoke passed with detector/classifier event evidence',
    'packaged Electron app smoke passed',
    'packaged app cold start and backend health passed',
    'packaged HF ONNX runtime smoke passed with first-download and offline-cache evidence',
    'production renderer and Electron main builds exist'
  ],
  evidence_summary: {
    real_fixture_detector_ready: realFixtureDetectorReady,
    electron_real_recording_ready: electronRealRecordingReady,
    electron_real_recording_summary: artifacts.electronRealRecording?.summary || null,
    packaged_cold_start_timings: artifacts.packagedColdStart?.timings || null,
    hf_onnx_runtime_cache_bytes: artifacts.hfOnnxRuntime?.cache_bytes ?? null,
    hf_onnx_runtime_cache_root: artifacts.hfOnnxRuntime?.cache_root || null
  },
  failures
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
if (failures.length) {
  console.error(`Production signoff audit blocked by ${failures.length} issue(s).`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Report: ${outputPath}`);
  process.exit(1);
}
console.log(`Production signoff audit ready. Report: ${outputPath}`);
