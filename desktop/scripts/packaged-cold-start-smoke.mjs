#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { _electron as electron } from 'playwright';
import { macBundleName, productName } from './lib/product-name.mjs';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outputPath = join(desktopRoot, 'artifacts/packaged-cold-start-smoke.json');
const appPathRaw = (process.env.PYHFO_PARITY_ELECTRON_APP || '').trim();

function positiveNumber(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const STARTUP_TIMEOUT_MS = positiveNumber(process.env.PYHFO_PACKAGED_COLD_START_TIMEOUT_MS, 120000);
const MAX_FIRST_WINDOW_MS = positiveNumber(process.env.PYHFO_PACKAGED_COLD_START_MAX_FIRST_WINDOW_MS, 15000);
const MAX_MAIN_READY_MS = positiveNumber(process.env.PYHFO_PACKAGED_COLD_START_MAX_MAIN_READY_MS, 18000);

function writeReport(report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}

function fail(status, message, extra = {}) {
  writeReport({
    status,
    message,
    required_env: 'PYHFO_PARITY_ELECTRON_APP',
    command: `PYHFO_PARITY_ELECTRON_APP="/path/to/${macBundleName}" node scripts/packaged-cold-start-smoke.mjs`,
    ...extra,
  });
  console.error(message);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}

function tempWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'ieeg-packaged-cold-start-'));
  const dirs = {
    root,
    userData: join(root, 'user-data'),
    hfHome: join(root, 'hf-home'),
    hfHubCache: join(root, 'hf-home', 'hub'),
    mplConfig: join(root, 'mplconfig'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

function cleanEnv(dirs) {
  const env = { ...process.env };
  for (const key of [
    'HF_TOKEN',
    'HUGGING_FACE_HUB_TOKEN',
    'HUGGINGFACE_HUB_TOKEN',
    'PYHFO_ONNX_DIR',
    'PYHFO_ONNX_MODEL_ARTIFACT',
    'PYHFO_ONNX_MODEL_SPIKE',
    'PYHFO_ONNX_MODEL_EHFO',
  ]) {
    delete env[key];
  }
  return {
    ...env,
    IEEG_DISABLE_AGENT_RUNTIME: '1',
    IEEG_DISABLE_CLOSE_GUARD: '1',
    HF_HOME: dirs.hfHome,
    HF_HUB_CACHE: dirs.hfHubCache,
    HF_HUB_OFFLINE: '1',
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
    TRANSFORMERS_OFFLINE: '1',
    MPLCONFIGDIR: dirs.mplConfig,
    PYHFO_MPLCONFIGDIR: dirs.mplConfig,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    ELECTRON_ENABLE_LOGGING: '1',
  };
}

if (!appPathRaw) fail('missing_env', 'Packaged cold-start smoke requires PYHFO_PARITY_ELECTRON_APP pointing to the built .app directory.');
const appPath = resolve(appPathRaw);
if (!existsSync(appPath)) fail('missing_app', `Packaged Electron app path does not exist: ${appPath}`, { app_path: appPath });
if (!statSync(appPath).isDirectory()) fail('not_directory', `Packaged Electron app path must be a directory: ${appPath}`, { app_path: appPath });

const executablePath = join(appPath, 'Contents', 'MacOS', productName);
if (!existsSync(executablePath)) fail('missing_executable', `Packaged app executable not found: ${executablePath}`, { app_path: appPath, executable_path: executablePath });

const temp = tempWorkspace();
const timings = {};
const logs = [];
const consoleEntries = [];
const pageErrors = [];
let electronApp;
let report = {
  status: 'failed',
  app_path: appPath,
  executable_path: executablePath,
  isolated_caches: {
    user_data_dir: temp.userData,
    hf_home: temp.hfHome,
    hf_hub_cache: temp.hfHubCache,
    mpl_config_dir: temp.mplConfig,
  },
  timings,
  budgets: {
    max_first_window_ms: MAX_FIRST_WINDOW_MS,
    max_main_window_ready_ms: MAX_MAIN_READY_MS,
  },
  backend_status: null,
  failures: [],
};

try {
  const launchStarted = performance.now();
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${temp.userData}`],
    cwd: dirname(executablePath),
    env: cleanEnv(temp),
    timeout: STARTUP_TIMEOUT_MS,
  });
  timings.launch_ms = Math.round(performance.now() - launchStarted);

  const proc = electronApp.process();
  proc?.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  proc?.stderr?.on('data', (chunk) => logs.push(String(chunk)));

  const page = await electronApp.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
  timings.first_window_ms = Math.round(performance.now() - launchStarted);
  page.setDefaultTimeout(10000);
  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text().slice(0, 1000) }));
  page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 1000)));

  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: STARTUP_TIMEOUT_MS });
  timings.main_window_ready_ms = Math.round(performance.now() - launchStarted);

  const backendStatus = await page.evaluate(async () => {
    if (!window.ieeg?.getBackendStatus) return { __error: 'window.ieeg.getBackendStatus unavailable' };
    return window.ieeg.getBackendStatus();
  });
  report.backend_status = backendStatus;

  const failures = [];
  if (backendStatus?.__error) failures.push(backendStatus.__error);
  if (backendStatus?.status !== 'ok') failures.push(`backend status is ${JSON.stringify(backendStatus?.status ?? null)}, expected "ok"`);
  if (timings.first_window_ms > MAX_FIRST_WINDOW_MS) {
    failures.push(`first window exceeded ${MAX_FIRST_WINDOW_MS} ms budget: ${timings.first_window_ms} ms`);
  }
  if (timings.main_window_ready_ms > MAX_MAIN_READY_MS) {
    failures.push(`main window readiness exceeded ${MAX_MAIN_READY_MS} ms budget: ${timings.main_window_ready_ms} ms`);
  }
  report = {
    ...report,
    status: failures.length ? 'failed' : 'passed',
    timings: { ...timings, total_ms: Math.round(performance.now() - launchStarted) },
    backend_status: backendStatus,
    failures,
    console_entries: consoleEntries.slice(-20),
    page_errors: pageErrors.slice(-20),
    electron_log_tail: logs.join('').split(/\r?\n/).filter(Boolean).slice(-60),
  };
  writeReport(report);
  if (failures.length) {
    console.error(`Packaged cold-start smoke failed with ${failures.length} issue(s).`);
    for (const failure of failures) console.error(`- ${failure}`);
    console.error(`Report: ${outputPath}`);
    process.exitCode = 1;
  } else {
    console.log(`Packaged cold-start smoke passed for ${appPath}. Report: ${outputPath}`);
  }
} catch (error) {
  report = {
    ...report,
    status: 'error',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    timings,
    console_entries: consoleEntries.slice(-20),
    page_errors: pageErrors.slice(-20),
    electron_log_tail: logs.join('').split(/\r?\n/).filter(Boolean).slice(-60),
  };
  writeReport(report);
  console.error(report.message);
  console.error(`Report: ${outputPath}`);
  process.exitCode = 1;
} finally {
  if (electronApp) {
    try {
      await electronApp.close();
    } catch {
      // Process already exited.
    }
  }
  rmSync(temp.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
