#!/usr/bin/env node
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { macBundleName } from './lib/product-name.mjs';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outputPath = join(desktopRoot, 'artifacts/hf-onnx-runtime-smoke.json');
const appPathRaw = (process.env.PYHFO_PARITY_ELECTRON_APP || '').trim();
const cacheParent = resolve(process.env.PYHFO_HF_ONNX_RUNTIME_CACHE || join(desktopRoot, 'artifacts'));
const cacheRoot = join(cacheParent, 'hf-onnx-runtime-cache');
const hfHome = join(cacheRoot, 'hf-home');
const hfHubCache = join(hfHome, 'hub');
const timeoutMs = Number(process.env.PYHFO_HF_ONNX_RUNTIME_TIMEOUT_MS || 900000);

function writeReport(report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}

function fail(status, message, extra = {}) {
  writeReport({
    status,
    message,
    required_env: 'PYHFO_PARITY_ELECTRON_APP',
    command: `PYHFO_PARITY_ELECTRON_APP="/path/to/${macBundleName}" npm run qa:hf-onnx-runtime`,
    cache_root: cacheRoot,
    ...extra,
  });
  console.error(message);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}

function directorySizeBytes(root) {
  if (!existsSync(root)) return 0;
  return readdirSync(root, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = join(root, entry.name);
    if (entry.isSymbolicLink()) return total;
    if (entry.isDirectory()) return total + directorySizeBytes(entryPath);
    return total + statSync(entryPath).size;
  }, 0);
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

function runBackendSelfTest(backendExecutable, mode) {
  const isShellFixture = startsWithShellShebang(backendExecutable);
  const command = isShellFixture ? '/bin/sh' : backendExecutable;
  const args = isShellFixture ? [backendExecutable, '--self-test-download-models'] : ['--self-test-download-models'];
  const env = {
    ...process.env,
    PYHFO_PIPELINE_SUBPROCESS: '0',
    HF_HOME: hfHome,
    HF_HUB_CACHE: hfHubCache,
    HF_HUB_DISABLE_XET: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
    MPLCONFIGDIR: process.env.MPLCONFIGDIR || join(cacheRoot, 'matplotlib-cache'),
    PYHFO_MPLCONFIGDIR: process.env.PYHFO_MPLCONFIGDIR || process.env.MPLCONFIGDIR || join(cacheRoot, 'matplotlib-cache'),
  };
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  delete env.HF_HUB_TOKEN;
  if (mode === 'offline') {
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  } else {
    delete env.HF_HUB_OFFLINE;
    delete env.TRANSFORMERS_OFFLINE;
  }

  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: dirname(backendExecutable),
    env,
    encoding: 'utf8',
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 900000,
  });
  const durationMs = Date.now() - started;
  const stdout = String(result.stdout || '').trim();
  let payload = null;
  try {
    payload = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).at(-1) || '');
  } catch {
    payload = null;
  }
  return {
    mode,
    status: result.status === 0 && payload?.status === 'passed' ? 'passed' : 'failed',
    duration_ms: durationMs,
    exit_status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : '',
    payload,
    stdout: stdout.slice(-4000),
    stderr: String(result.stderr || '').trim().slice(-4000),
  };
}

function registryComplete(payload) {
  const registry = payload?.onnx_registry || {};
  return ['a', 's', 'e'].every((tag) => {
    const entry = registry[tag];
    return entry?.repo_id && entry?.revision && entry?.uri;
  });
}

function loadedAllDefaultModels(payload) {
  const models = payload?.onnx_models || {};
  return models.artifact === true && models.spike === true && models.ehfo === true;
}

if (!appPathRaw) fail('missing_env', 'HF ONNX runtime smoke requires PYHFO_PARITY_ELECTRON_APP pointing to the built .app/app directory.');
const appPath = resolve(appPathRaw);
if (!existsSync(appPath)) fail('missing_app', `Packaged Electron app path does not exist: ${appPath}`, { app_path: appPath });
if (!statSync(appPath).isDirectory()) fail('not_directory', `Packaged Electron app path must be a directory: ${appPath}`, { app_path: appPath });

const backendExecutable = join(appPath, 'Contents', 'Resources', 'backend', 'pyhfo-backend', 'pyhfo-backend');
if (!existsSync(backendExecutable)) fail('missing_backend', `Frozen PyHFO backend is missing: ${backendExecutable}`, { app_path: appPath, backend_executable: backendExecutable });

rmSync(cacheRoot, { recursive: true, force: true });
mkdirSync(hfHubCache, { recursive: true });

const online = runBackendSelfTest(backendExecutable, 'online');
const offline = online.status === 'passed' ? runBackendSelfTest(backendExecutable, 'offline') : null;
const phases = [online, offline].filter(Boolean);
const checks = {
  backend_exists: true,
  online_self_test_passed: online.status === 'passed',
  online_models_loaded: loadedAllDefaultModels(online.payload),
  online_registry_complete: registryComplete(online.payload),
  offline_self_test_passed: offline?.status === 'passed',
  offline_models_loaded: loadedAllDefaultModels(offline?.payload),
  offline_registry_complete: registryComplete(offline?.payload),
};
const failures = Object.entries(checks)
  .filter(([, value]) => !value)
  .map(([key]) => `HF ONNX runtime contract failed: ${key}`);
const cacheBytes = directorySizeBytes(cacheRoot);

writeReport({
  status: failures.length ? 'failed' : 'passed',
  app_path: appPath,
  backend_executable: backendExecutable,
  cache_root: cacheRoot,
  hf_home: hfHome,
  hf_hub_cache: hfHubCache,
  cache_bytes: cacheBytes,
  checks,
  phases,
  failures,
});
if (failures.length) {
  console.error(`HF ONNX runtime smoke failed with ${failures.length} issue(s).`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Report: ${outputPath}`);
  process.exit(1);
}
console.log(`HF ONNX runtime smoke passed for ${appPath}. Cache: ${cacheRoot} (${cacheBytes} bytes). Report: ${outputPath}`);
