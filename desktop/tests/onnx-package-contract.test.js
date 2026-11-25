import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const desktopRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(desktopRoot, '..');
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
const packageSource = readFileSync(join(desktopRoot, 'scripts/package-macos-app.mjs'), 'utf8');
const smokeSource = readFileSync(join(desktopRoot, 'scripts/packaged-electron-smoke.mjs'), 'utf8');
const hfOnnxSmokeSource = readFileSync(join(desktopRoot, 'scripts/hf-onnx-runtime-smoke.mjs'), 'utf8');
const mainSource = readFileSync(join(desktopRoot, 'electron/main.ts'), 'utf8');
const pyhfoRequirements = readFileSync(join(repoRoot, 'pyhfo/requirements.txt'), 'utf8');
const pyhfoPackageSpec = readFileSync(join(repoRoot, 'pyhfo/pyhfo_backend_macos.spec'), 'utf8');
const pyhfoBackendEntry = readFileSync(join(repoRoot, 'pyhfo/scripts/pyhfo_backend_entry.py'), 'utf8');
const pyhfoHeadlessRuntimeHook = join(repoRoot, 'pyhfo/scripts/pyinstaller_headless_runtime.py');
const agentRuntimePackageSpec = readFileSync(join(repoRoot, 'runtime/ieeg_agent_runtime_macos.spec'), 'utf8');
const coldStartSmokePath = join(desktopRoot, 'scripts/packaged-cold-start-smoke.mjs');

test('macOS package does not generate, export, or bundle ONNX classifier assets', () => {
  assert.doesNotMatch(packageSource, /scripts\/export_onnx\.py/);
  assert.doesNotMatch(packageSource, /PYHFO_ONNX_ASSET_DIR/);
  assert.doesNotMatch(packageSource, /onnx-manifest\.json/);
  assert.doesNotMatch(packageSource, /Contents\/Resources\/onnx/);
  assert.doesNotMatch(packageSource, /Bundled ONNX classifier assets/);
});

test('packaged smoke rejects bundled models and verifies offline registry startup', () => {
  assert.match(smokeSource, /has_no_onnx_bundle/);
  assert.match(smokeSource, /has_no_packaged_classifier_models/);
  assert.match(smokeSource, /packaged_model_files/);
  assert.match(smokeSource, /HF_HUB_OFFLINE: '1'/);
  assert.match(smokeSource, /TRANSFORMERS_OFFLINE: '1'/);
  assert.doesNotMatch(smokeSource, /--self-test-download-models/);
  assert.doesNotMatch(smokeSource, /onnx_checksums_match/);
  assert.doesNotMatch(smokeSource, /onnx_parity_within_tolerance/);
  assert.match(smokeSource, /backend_self_test_passed/);
  assert.match(smokeSource, /backend_yasa_available/);
  assert.match(smokeSource, /backend_detector_probe_clean/);
  assert.match(smokeSource, /backend_yasa_detection_smoke/);
  assert.match(smokeSource, /backend_bundle_within_size_budget/);
  assert.match(smokeSource, /PYHFO_PACKAGED_BACKEND_MAX_BYTES/);
  assert.match(smokeSource, /app_bundle_within_size_budget/);
  assert.match(smokeSource, /IEEG_PACKAGED_APP_MAX_BYTES/);
  assert.match(smokeSource, /agent_runtime_within_size_budget/);
  assert.match(smokeSource, /IEEG_PACKAGED_AGENT_MAX_BYTES/);
  assert.match(smokeSource, /\['--self-test'\]/);
});

test('separate HF ONNX runtime smoke proves first download and offline cache readiness', () => {
  assert.match(hfOnnxSmokeSource, /--self-test-download-models/);
  assert.match(hfOnnxSmokeSource, /HF_HUB_DISABLE_XET: '1'/);
  assert.match(hfOnnxSmokeSource, /HF_HUB_DISABLE_IMPLICIT_TOKEN: '1'/);
  assert.match(hfOnnxSmokeSource, /HF_HUB_DISABLE_PROGRESS_BARS: '1'/);
  assert.match(hfOnnxSmokeSource, /delete env\.HF_TOKEN/);
  assert.match(hfOnnxSmokeSource, /mode === 'offline'/);
  assert.match(hfOnnxSmokeSource, /HF_HUB_OFFLINE = '1'/);
  assert.match(hfOnnxSmokeSource, /TRANSFORMERS_OFFLINE = '1'/);
  assert.match(hfOnnxSmokeSource, /loadedAllDefaultModels/);
  assert.match(hfOnnxSmokeSource, /registryComplete/);
  assert.match(hfOnnxSmokeSource, /cache_bytes/);
  assert.match(hfOnnxSmokeSource, /startsWithShellShebang/);
});

test('frozen PyHFO spec collects only required runtime data and excludes non-runtime stacks', () => {
  assert.doesNotMatch(pyhfoPackageSpec, /collect_all/);
  assert.match(pyhfoPackageSpec, /collect_data_files\("lspopt", includes=\["data\/\*\.npy"\]\)/);
  assert.match(pyhfoPackageSpec, /collect_data_files\("mne", includes=\["\*\*\/\*\.pyi"\]\)/);
  assert.match(pyhfoPackageSpec, /"mne\.utils\.progressbar"/);
  assert.match(pyhfoPackageSpec, /"mne\.io\.fiff\.raw"/);
  assert.match(pyhfoPackageSpec, /"matplotlib": \{"backends": \["Agg"\]\}/);
  assert.ok(pyhfoPackageSpec.includes('runtime_hooks=[str(ROOT / "scripts" / "pyinstaller_headless_runtime.py")]'));
  assert.equal(existsSync(pyhfoHeadlessRuntimeHook), true);
  assert.doesNotMatch(pyhfoPackageSpec, /^\s*"matplotlib",$/m);
  for (const excluded of ['pyqtgraph', 'pytest', 'IPython', 'sphinx', 'babel', 'botocore', 'sqlalchemy', 'psycopg_binary', 'hf_xet']) {
    assert.ok(pyhfoPackageSpec.includes(`"${excluded}"`), excluded);
  }
});

test('frozen Agent runtime excludes documentation, notebook, GUI, and unused database drivers', () => {
  for (const excluded of [
    'IPython',
    'ipykernel',
    'jedi',
    'parso',
    'sphinx',
    'sphinxcontrib',
    'docutils',
    'alabaster',
    'babel',
    'tkinter',
    '_tkinter',
    'psycopg',
    'psycopg_binary',
    'asyncpg',
  ]) {
    assert.ok(agentRuntimePackageSpec.includes(`"${excluded}"`), excluded);
  }
  for (const required of ['boto3', 'botocore', 'PIL', 'lxml', 'sqlalchemy']) {
    assert.ok(!agentRuntimePackageSpec.includes(`"${required}"`), required);
  }
});

test('macOS package prunes Electron locales before signing while preserving English and Chinese', () => {
  assert.match(packageSource, /pruneElectronLocales/);
  assert.match(packageSource, /Electron Framework\.framework/);
  for (const locale of ['en', 'en_GB', 'zh_CN', 'zh_TW']) {
    assert.match(packageSource, new RegExp(`['"]${locale}['"]`));
  }
  assert.ok(packageSource.indexOf('pruneElectronLocales(outputApp)') < packageSource.indexOf("'/usr/bin/xattr'"));
  assert.ok(packageSource.indexOf('pruneElectronLocales(outputApp)') < packageSource.indexOf("'--deep', '--sign', '-'"));
  assert.match(smokeSource, /electron_locales_pruned/);
  assert.match(smokeSource, /electron_required_locales_present/);
  assert.match(smokeSource, /electron_non_locale_paks_present/);
});

test('packaged cold-start gate launches the released app with isolated caches and records timing', () => {
  assert.equal(existsSync(coldStartSmokePath), true);
  const coldStartSource = readFileSync(coldStartSmokePath, 'utf8');
  assert.match(coldStartSource, /_electron as electron/);
  assert.match(coldStartSource, /join\(appPath, 'Contents', 'MacOS', productName\)/);
  assert.match(coldStartSource, /IEEG_DISABLE_AGENT_RUNTIME/);
  assert.match(coldStartSource, /HF_HUB_OFFLINE/);
  assert.match(coldStartSource, /first_window_ms/);
  assert.match(coldStartSource, /main_window_ready_ms/);
  assert.match(coldStartSource, /PYHFO_PACKAGED_COLD_START_MAX_FIRST_WINDOW_MS/);
  assert.match(coldStartSource, /PYHFO_PACKAGED_COLD_START_MAX_MAIN_READY_MS/);
  assert.match(coldStartSource, /first window exceeded/);
  assert.match(coldStartSource, /main window readiness exceeded/);
  assert.match(coldStartSource, /getBackendStatus/);
  assert.match(coldStartSource, /await electronApp\.close\(\)/);
  assert.match(coldStartSource, /maxRetries:/);
  assert.equal(desktopPackage.scripts['qa:packaged-cold-start'], 'node scripts/packaged-cold-start-smoke.mjs');
  assert.match(desktopPackage.scripts['package:mac-smoke'], /qa:packaged-cold-start/);
});

test('frozen PyHFO entry initializes multiprocessing children through PyInstaller', () => {
  assert.match(pyhfoBackendEntry, /multiprocessing\.freeze_support\(\)/);
  assert.match(pyhfoBackendEntry, /_run_yasa_detector_smoke/);
  assert.match(pyhfoBackendEntry, /"yasa_detection": yasa_detection/);
  assert.match(pyhfoBackendEntry, /PYHFO_MPLCONFIGDIR/);
  assert.match(mainSource, /process\.env\.PYHFO_MPLCONFIGDIR \|\|= process\.env\.MPLCONFIGDIR/);
  assert.match(smokeSource, /PYHFO_MPLCONFIGDIR/);
});

test('packaged runtime points model caches at persistent user data, not bundled ONNX assets', () => {
  assert.doesNotMatch(mainSource, /process\.env\.PYHFO_ONNX_DIR = path\.join\(process\.resourcesPath, 'onnx'\)/);
  assert.match(mainSource, /const hfHome = path\.join\(userData, 'models', 'huggingface'\)/);
  assert.match(mainSource, /process\.env\.HF_HOME \|\|= hfHome/);
  // The executable names carry a platform suffix (`${exe}` -> '.exe' on Windows, '' elsewhere):
  // PyInstaller emits a bare name on macOS and a .exe on Windows, and without it the packaged
  // Windows app resolves a path that does not exist and never starts its backend.
  assert.match(mainSource, /const exe = process\.platform === 'win32' \? '\.exe' : '';/);
  assert.match(mainSource, /process\.env\.PYHFO_BACKEND_EXECUTABLE = path\.join\(process\.resourcesPath, 'backend', 'pyhfo-backend', `pyhfo-backend\$\{exe\}`\)/);
  assert.match(mainSource, /path\.join\(process\.resourcesPath, 'backend', 'agent-runtime', `ieeg-agent-runtime\$\{exe\}`\)/);
  assert.match(mainSource, /process\.env\.IEEG_AGENT_RUNTIME_EXECUTABLE \|\|= agentRuntimeExecutable/);
  assert.match(mainSource, /process\.env\.IEEG_UI_BROKER_EXECUTABLE \|\|= agentRuntimeExecutable/);
  assert.match(mainSource, /process\.env\.IEEG_UI_MCP_EXECUTABLE \|\|= agentRuntimeExecutable/);
  assert.match(mainSource, /process\.env\.IEEG_AGENT_DATA_DIR \|\|= path\.join\(userData, 'agent-runtime', 'data'\)/);
  assert.match(mainSource, /process\.env\.IEEG_AGENT_CONFIG_DIR \|\|= path\.join\(userData, 'agent-runtime', 'config'\)/);
  assert.match(mainSource, /process\.env\.IEEG_STORAGE_LOCAL_ROOT \|\|= path\.join\(userData, 'agent-runtime', 'storage'\)/);
  // The provider and model are the user's choice (Settings -> connection) and travel per request.
  // Asserting a hard-coded vendor default here would re-freeze what was deliberately made settable.
  assert.match(mainSource, /applyLlmSettingsToEnv/);
  assert.match(pyhfoRequirements, /^onnxruntime[<=>]/m);
  assert.match(pyhfoRequirements, /^huggingface_hub[<=>]/m);
});

test('macOS package builds, embeds, and signs the frozen PyHFO backend', () => {
  assert.match(packageSource, /const appVersion = String\(desktopPackage\.version/);
  assert.match(packageSource, /pyhfo_backend_macos\.spec/);
  assert.match(packageSource, /Contents\/Resources\/backend\/pyhfo-backend/);
  assert.match(packageSource, /join\(agentRuntimeRoot, 'dist', 'ieeg-agent-runtime'\)/);
  assert.match(packageSource, /ieeg_agent_runtime_macos\.spec/);
  assert.match(packageSource, /Unable to build the packaged Agent runtime/);
  assert.match(packageSource, /Contents\/Resources\/backend\/agent-runtime/);
  assert.match(packageSource, /chmodSync\(join\(resourcesAgentRuntime, 'ieeg-agent-runtime'\), 0o755\)/);
  assert.match(packageSource, /renameSync\(originalExecutable, packagedExecutable\)/);
  assert.match(packageSource, /Contents\/Resources\/default_app\.asar/);
  assert.match(packageSource, /\['CFBundleExecutable', productName\]/);
  assert.match(packageSource, /\['CFBundleShortVersionString', appVersion\]/);
  assert.match(packageSource, /\['CFBundleVersion', appVersion\]/);
  assert.match(packageSource, /\['-remove', 'ElectronAsarIntegrity'/);
  assert.match(packageSource, /'--deep', '--sign', '-'/);
});
