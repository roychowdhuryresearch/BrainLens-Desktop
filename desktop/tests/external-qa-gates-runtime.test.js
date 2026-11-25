import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requiredRecording } from '../scripts/lib/qa-paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifactsDir = join(root, 'artifacts');
const runtimeDir = join(artifactsDir, 'runtime-gate-test');

function runNodeScript(script, env = {}) {
  return spawnSync(process.execPath, [join(root, script)], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function readArtifact(name) {
  return JSON.parse(readFileSync(join(artifactsDir, name), 'utf8'));
}

function snapshotArtifacts(names) {
  return Object.fromEntries(names.map((name) => {
    const path = join(artifactsDir, name);
    return [name, existsSync(path) ? readFileSync(path, 'utf8') : null];
  }));
}

function restoreArtifacts(snapshot) {
  for (const [name, contents] of Object.entries(snapshot)) {
    const path = join(artifactsDir, name);
    if (contents === null) rmSync(path, { force: true });
    else writeFileSync(path, contents);
  }
}

test('QA checks require a selected recording and respect the script override', () => {
  const primary = 'IEEG_TEST_PRIMARY_RECORDING';
  const fallback = 'IEEG_TEST_FALLBACK_RECORDING';
  const directory = mkdtempSync(join(tmpdir(), 'ieeg-qa-recordings-'));
  const first = join(directory, 'primary.edf');
  const second = join(directory, 'secondary.edf');

  try {
    writeFileSync(first, '');
    writeFileSync(second, '');
    delete process.env[primary];
    delete process.env[fallback];
    assert.throws(() => requiredRecording(primary, fallback), /Set IEEG_TEST_PRIMARY_RECORDING or IEEG_TEST_FALLBACK_RECORDING/);
    process.env[fallback] = second;
    assert.equal(requiredRecording(primary, fallback), second);
    process.env[primary] = first;
    assert.equal(requiredRecording(primary, fallback), first);
    process.env[primary] = directory;
    assert.throws(() => requiredRecording(primary, fallback), /Recording file for IEEG_TEST_PRIMARY_RECORDING/);
  } finally {
    delete process.env[primary];
    delete process.env[fallback];
    rmSync(directory, { recursive: true, force: true });
  }
});

test('external QA gates pass when production signoff evidence artifacts are present', (t) => {
  // The fixture builds a macOS bundle with an Electron Framework and links its
  // backend executable with symlinkSync. Creating symlinks on Windows needs Developer Mode or an
  // elevated shell, so this fails with EPERM there rather than testing the gates.
  if (process.platform === 'win32') {
    t.skip('fixture builds a macOS .app bundle and needs symlink privileges');
    return;
  }
  const artifactSnapshot = snapshotArtifacts(['packaged-electron-smoke.json', 'packaged-cold-start-smoke.json', 'hf-onnx-runtime-smoke.json', 'layout-smoke.json', 'real-fixture-smoke.json', 'electron-real-recording-smoke.json', 'production-signoff-audit.json']);
  try {
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(join(root, 'dist-renderer'), { recursive: true });
  mkdirSync(join(root, 'dist-electron'), { recursive: true });
  const rendererIndex = join(root, 'dist-renderer/index.html');
  const electronMain = join(root, 'dist-electron/main.js');
  if (!existsSync(rendererIndex)) writeFileSync(rendererIndex, '<div id="root"></div>');
  if (!existsSync(electronMain)) writeFileSync(electronMain, 'export {};');

  const appRoot = join(runtimeDir, 'BrainLens Desktop.app');
  rmSync(appRoot, { recursive: true, force: true });
  mkdirSync(join(appRoot, 'Contents/MacOS'), { recursive: true });
  mkdirSync(join(appRoot, 'Contents/Resources'), { recursive: true });
  const electronFrameworkResources = join(
    appRoot,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Resources',
  );
  mkdirSync(electronFrameworkResources, { recursive: true });
  for (const locale of ['en.lproj', 'zh_CN.lproj', 'zh_TW.lproj']) {
    mkdirSync(join(electronFrameworkResources, locale), { recursive: true });
    writeFileSync(join(electronFrameworkResources, locale, 'locale.pak'), locale);
  }
  for (const pak of ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak']) {
    writeFileSync(join(electronFrameworkResources, pak), pak);
  }
  const backendExecutable = join(appRoot, 'Contents/Resources/backend/pyhfo-backend/pyhfo-backend');
  mkdirSync(join(appRoot, 'Contents/Resources/backend/pyhfo-backend'), { recursive: true });
  mkdirSync(join(appRoot, 'Contents/Resources/backend/agent-runtime'), { recursive: true });
  writeFileSync(join(appRoot, 'Contents/Resources/backend/agent-runtime/ieeg-agent-runtime'), '#!/bin/sh\n');
  writeFileSync(
    backendExecutable,
    '#!/bin/sh\nmkdir -p "$HF_HOME"\nprintf model-bytes >> "$HF_HOME/fake-model-cache.bin"\nprintf \'%s\\n\' \'{"status":"passed","service":"pyhfo-backend","frozen":true,"onnx_registry":{"a":{"repo_id":"org/a","revision":"1","uri":"hf://org/a@1"},"s":{"repo_id":"org/s","revision":"1","uri":"hf://org/s@1"},"e":{"repo_id":"org/e","revision":"1","uri":"hf://org/e@1"}},"onnx_models":{"artifact":true,"spike":true,"ehfo":true},"yasa_detection":{"status":"passed","algorithm":"spindles_detect","events":0},"capabilities":{"optional_dependencies":{"yasa":{"available":true}},"detector_availability":{"probe_error":""}}}\'\n'
  );
  chmodSync(backendExecutable, 0o755);
  writeFileSync(join(appRoot, 'Contents/Info.plist'), '<plist><dict></dict></plist>');
  writeFileSync(join(appRoot, 'Contents/MacOS/BrainLens Desktop'), '#!/bin/sh\n');
  const symlinkedModel = join(appRoot, 'Contents/Resources/model_a.onnx');
  symlinkSync(backendExecutable, symlinkedModel);
  const rejectedBundledModel = runNodeScript('scripts/packaged-electron-smoke.mjs', { PYHFO_PARITY_ELECTRON_APP: appRoot });
  assert.equal(rejectedBundledModel.status, 1, `${rejectedBundledModel.stdout}\n${rejectedBundledModel.stderr}`);
  rmSync(symlinkedModel);

  const packaged = runNodeScript('scripts/packaged-electron-smoke.mjs', { PYHFO_PARITY_ELECTRON_APP: appRoot });
  assert.equal(packaged.status, 0, `${packaged.stdout}\n${packaged.stderr}`);
  assert.equal(readArtifact('packaged-electron-smoke.json').status, 'passed');
  const hfOnnx = runNodeScript('scripts/hf-onnx-runtime-smoke.mjs', { PYHFO_PARITY_ELECTRON_APP: appRoot });
  assert.equal(hfOnnx.status, 0, `${hfOnnx.stdout}\n${hfOnnx.stderr}`);
  const hfOnnxArtifact = readArtifact('hf-onnx-runtime-smoke.json');
  assert.equal(hfOnnxArtifact.status, 'passed');
  assert.equal(hfOnnxArtifact.checks.online_models_loaded, true);
  assert.equal(hfOnnxArtifact.checks.offline_models_loaded, true);
  assert.ok(hfOnnxArtifact.cache_bytes > 0);
  writeFileSync(join(artifactsDir, 'packaged-cold-start-smoke.json'), JSON.stringify({
    status: 'passed',
    timings: { first_window_ms: 100, main_window_ready_ms: 150 },
    budgets: { max_first_window_ms: 15000, max_main_window_ready_ms: 18000 },
    backend_status: { status: 'ok' },
  }, null, 2));

  writeFileSync(join(artifactsDir, 'layout-smoke.json'), JSON.stringify({ failures: [] }, null, 2));
  writeFileSync(join(artifactsDir, 'real-fixture-smoke.json'), JSON.stringify({ status: 'passed', optional_detection_enabled: true }, null, 2));

  const signoff = runNodeScript('scripts/production-signoff-audit.mjs');
  assert.equal(signoff.status, 0, `${signoff.stdout}\n${signoff.stderr}`);
  const signoffArtifact = readArtifact('production-signoff-audit.json');
  assert.equal(signoffArtifact.status, 'ready');
  assert.deepEqual(signoffArtifact.failures, []);

  // Negative path: the standalone external gates refuse a blank env, and a missing/failed
  // required artifact must block final signoff.
  const blankExternalEnv = { PYHFO_PARITY_FIXTURE_RECORDING: '', PYHFO_PARITY_ELECTRON_APP: '' };
  assert.equal(runNodeScript('scripts/real-fixture-smoke.mjs', blankExternalEnv).status, 2);
  assert.equal(runNodeScript('scripts/packaged-electron-smoke.mjs', blankExternalEnv).status, 2);
  assert.equal(runNodeScript('scripts/hf-onnx-runtime-smoke.mjs', blankExternalEnv).status, 2);
  writeFileSync(join(artifactsDir, 'real-fixture-smoke.json'), JSON.stringify({ status: 'failed', optional_detection_enabled: false }, null, 2));
  rmSync(join(artifactsDir, 'electron-real-recording-smoke.json'), { force: true });
  rmSync(join(artifactsDir, 'packaged-electron-smoke.json'), { force: true });
  rmSync(join(artifactsDir, 'packaged-cold-start-smoke.json'), { force: true });
  rmSync(join(artifactsDir, 'hf-onnx-runtime-smoke.json'), { force: true });
  const blockedSignoff = runNodeScript('scripts/production-signoff-audit.mjs');
  assert.equal(blockedSignoff.status, 1, `${blockedSignoff.stdout}\n${blockedSignoff.stderr}`);
  assert.equal(readArtifact('production-signoff-audit.json').status, 'blocked');
  } finally {
    restoreArtifacts(artifactSnapshot);
  }
});
