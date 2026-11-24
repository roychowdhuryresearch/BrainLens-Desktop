#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outputPath = join(desktopRoot, 'artifacts/packaged-electron-smoke.json');
const appPathRaw = (process.env.PYHFO_PARITY_ELECTRON_APP || '').trim();
const defaultBackendMaxBytes = 475 * 1024 * 1024;
const defaultAppMaxBytes = 800 * 1024 * 1024;
const defaultAgentRuntimeMaxBytes = 140 * 1024 * 1024;
const configuredBackendMaxBytes = Number(process.env.PYHFO_PACKAGED_BACKEND_MAX_BYTES || defaultBackendMaxBytes);
const configuredAppMaxBytes = Number(process.env.IEEG_PACKAGED_APP_MAX_BYTES || defaultAppMaxBytes);
const configuredAgentRuntimeMaxBytes = Number(process.env.IEEG_PACKAGED_AGENT_MAX_BYTES || defaultAgentRuntimeMaxBytes);
const backendMaxBytes = Number.isFinite(configuredBackendMaxBytes) && configuredBackendMaxBytes > 0
  ? configuredBackendMaxBytes
  : defaultBackendMaxBytes;
const appMaxBytes = Number.isFinite(configuredAppMaxBytes) && configuredAppMaxBytes > 0
  ? configuredAppMaxBytes
  : defaultAppMaxBytes;
const agentRuntimeMaxBytes = Number.isFinite(configuredAgentRuntimeMaxBytes) && configuredAgentRuntimeMaxBytes > 0
  ? configuredAgentRuntimeMaxBytes
  : defaultAgentRuntimeMaxBytes;

function writeReport(report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}

function fail(status, message, extra = {}) {
  writeReport({ status, message, required_env: 'PYHFO_PARITY_ELECTRON_APP', command: 'PYHFO_PARITY_ELECTRON_APP=/path/to/iEEG.app npm run qa:packaged', ...extra });
  console.error(message);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}

function directorySizeBytes(root) {
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) return total;
    if (entry.isDirectory()) return total + directorySizeBytes(entryPath);
    return total + statSync(entryPath).size;
  }, 0);
}

function findPackagedClassifierModels(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(root, entry.name);
    const isClassifierModel = (
      /\.(onnx|safetensors)$/i.test(entry.name)
      || /^model_[ase]\.tar$/i.test(entry.name)
    );
    if (entry.isSymbolicLink()) return isClassifierModel ? [entryPath] : [];
    if (entry.isDirectory()) return findPackagedClassifierModels(entryPath);
    return isClassifierModel ? [entryPath] : [];
  });
}

const electronLocaleFamilies = new Set(['en', 'en_GB', 'zh_CN', 'zh_TW']);

function retainedElectronLocale(entryName) {
  if (!entryName.endsWith('.lproj')) return false;
  const locale = entryName
    .slice(0, -'.lproj'.length)
    .replace(/_(?:FEMININE|MASCULINE|NEUTER)$/, '');
  return electronLocaleFamilies.has(locale);
}

function electronLocales(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('.lproj'))
    .map((entry) => entry.name)
    .sort();
}

function startsWithShellShebang(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(9);
    return readSync(fd, buffer, 0, buffer.length, 0) === buffer.length && buffer.toString('utf8') === '#!/bin/sh';
  } finally {
    closeSync(fd);
  }
}

if (!appPathRaw) fail('missing_env', 'Packaged Electron smoke requires PYHFO_PARITY_ELECTRON_APP pointing to the built .app/app directory.');
const appPath = resolve(appPathRaw);
if (!existsSync(appPath)) fail('missing_app', `Packaged Electron app path does not exist: ${appPath}`, { app_path: appPath });
const stats = statSync(appPath);
if (!stats.isDirectory()) fail('not_directory', `Packaged Electron app path must be a directory: ${appPath}`, { app_path: appPath });

const macContents = join(appPath, 'Contents');
const onnxRoot = join(macContents, 'Resources', 'onnx');
const packagedModelFiles = findPackagedClassifierModels(join(macContents, 'Resources'));
const backendExecutable = join(macContents, 'Resources', 'backend', 'pyhfo-backend', 'pyhfo-backend');
const backendBundleRoot = dirname(backendExecutable);
const backendBundleBytes = existsSync(backendBundleRoot) ? directorySizeBytes(backendBundleRoot) : 0;
const agentRuntimeExecutable = join(macContents, 'Resources', 'backend', 'agent-runtime', 'ieeg-agent-runtime');
const agentRuntimeBundleRoot = dirname(agentRuntimeExecutable);
const agentRuntimeBundleBytes = existsSync(agentRuntimeBundleRoot) ? directorySizeBytes(agentRuntimeBundleRoot) : 0;
const appBundleBytes = directorySizeBytes(appPath);
const electronAppLocaleRoot = join(macContents, 'Resources');
const electronFrameworkResourceRoot = join(
  macContents,
  'Frameworks',
  'Electron Framework.framework',
  'Versions',
  'A',
  'Resources',
);
const electronAppLocales = electronLocales(electronAppLocaleRoot);
const electronFrameworkLocales = electronLocales(electronFrameworkResourceRoot);
const unexpectedElectronLocales = [...electronAppLocales, ...electronFrameworkLocales]
  .filter((name) => !retainedElectronLocale(name));
const requiredElectronLocales = ['en.lproj', 'zh_CN.lproj', 'zh_TW.lproj'];
const requiredElectronPaks = ['chrome_100_percent.pak', 'chrome_200_percent.pak', 'resources.pak'];
const electronFrameworkLocaleBytes = electronFrameworkLocales.reduce(
  (total, name) => total + directorySizeBytes(join(electronFrameworkResourceRoot, name)),
  0,
);
const hfHome = join(desktopRoot, 'artifacts', 'packaged-smoke-hf-home');
const hfHubCache = join(hfHome, 'hub');
mkdirSync(hfHubCache, { recursive: true });
let backendSelfTest = { status: 'not_run', stdout: '', stderr: '' };
if (existsSync(backendExecutable)) {
  const isShellFixture = startsWithShellShebang(backendExecutable);
  const command = isShellFixture ? '/bin/sh' : backendExecutable;
  const args = isShellFixture ? [backendExecutable, '--self-test'] : ['--self-test'];
  const result = spawnSync(command, args, {
    cwd: dirname(backendExecutable),
    env: {
      ...process.env,
      PYHFO_PIPELINE_SUBPROCESS: '0',
      HF_HOME: process.env.HF_HOME || hfHome,
      HF_HUB_CACHE: process.env.HF_HUB_CACHE || hfHubCache,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      MPLCONFIGDIR: process.env.MPLCONFIGDIR || join(desktopRoot, 'artifacts', 'matplotlib-cache'),
      PYHFO_MPLCONFIGDIR: process.env.PYHFO_MPLCONFIGDIR || process.env.MPLCONFIGDIR || join(desktopRoot, 'artifacts', 'matplotlib-cache'),
    },
    encoding: 'utf8',
    timeout: 180000,
  });
  const stdout = String(result.stdout || '').trim();
  let payload = null;
  try {
    payload = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).at(-1) || '');
  } catch {
    payload = null;
  }
  backendSelfTest = {
    status: result.status === 0 && payload?.status === 'passed' ? 'passed' : 'failed',
    exit_status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : '',
    payload,
    stdout: stdout.slice(-4000),
    stderr: String(result.stderr || '').trim().slice(-4000),
  };
}
const checks = {
  app_path_exists: true,
  has_mac_contents: existsSync(macContents),
  has_info_plist: existsSync(join(macContents, 'Info.plist')),
  has_macos_executable_dir: existsSync(join(macContents, 'MacOS')),
  has_resources_dir: existsSync(join(macContents, 'Resources')),
  has_no_onnx_bundle: !existsSync(onnxRoot),
  has_no_packaged_classifier_models: packagedModelFiles.length === 0,
  has_backend_bundle: existsSync(backendExecutable),
  backend_self_test_passed: backendSelfTest.status === 'passed',
  backend_yasa_available: backendSelfTest.payload?.capabilities?.optional_dependencies?.yasa?.available === true,
  backend_detector_probe_clean: backendSelfTest.payload?.capabilities?.detector_availability?.probe_error === '',
  backend_yasa_detection_smoke: backendSelfTest.payload?.yasa_detection?.status === 'passed',
  backend_bundle_within_size_budget: backendBundleBytes > 0 && backendBundleBytes <= backendMaxBytes,
  has_agent_runtime_bundle: existsSync(agentRuntimeExecutable),
  agent_runtime_within_size_budget: agentRuntimeBundleBytes > 0 && agentRuntimeBundleBytes <= agentRuntimeMaxBytes,
  app_bundle_within_size_budget: appBundleBytes > 0 && appBundleBytes <= appMaxBytes,
  electron_locales_pruned: unexpectedElectronLocales.length === 0,
  electron_required_locales_present: requiredElectronLocales.every(
    (name) => electronFrameworkLocales.includes(name),
  ),
  electron_non_locale_paks_present: requiredElectronPaks.every(
    (name) => existsSync(join(electronFrameworkResourceRoot, name)),
  ),
  has_renderer_build: existsSync(join(desktopRoot, 'dist-renderer', 'index.html')),
  has_main_build: existsSync(join(desktopRoot, 'dist-electron', 'main.js')),
};
if (checks.has_macos_executable_dir) {
  checks.macos_executables = readdirSync(join(macContents, 'MacOS'));
}
const failures = [];
for (const [key, value] of Object.entries(checks)) {
  if (key === 'macos_executables') continue;
  if (!value) failures.push(`Missing packaged app contract: ${key}`);
}
if (Array.isArray(checks.macos_executables) && !checks.macos_executables.length) failures.push('Packaged app Contents/MacOS contains no executable entry.');

writeReport({
  status: failures.length ? 'failed' : 'passed',
  app_path: appPath,
  checks,
  backend_bundle_bytes: backendBundleBytes,
  backend_bundle_max_bytes: backendMaxBytes,
  agent_runtime_bundle_bytes: agentRuntimeBundleBytes,
  agent_runtime_bundle_max_bytes: agentRuntimeMaxBytes,
  app_bundle_bytes: appBundleBytes,
  app_bundle_max_bytes: appMaxBytes,
  backend_self_test: backendSelfTest,
  electron_app_locales: electronAppLocales,
  electron_framework_locales: electronFrameworkLocales,
  unexpected_electron_locales: unexpectedElectronLocales,
  electron_framework_locale_bytes: electronFrameworkLocaleBytes,
  packaged_model_files: packagedModelFiles,
  failures,
});
if (failures.length) {
  console.error(`Packaged Electron smoke failed with ${failures.length} issue(s).`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Report: ${outputPath}`);
  process.exit(1);
}
console.log(`Packaged Electron smoke passed for ${appPath}. Report: ${outputPath}`);
