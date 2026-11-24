#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const artifactsDir = join(desktopRoot, 'artifacts');
const screenshotsDir = join(artifactsDir, 'electron-e2e');
const outputPath = join(artifactsDir, 'electron-e2e-smoke.json');
const electronExecutable = require('electron');
const diagnostics = { viteLogs: [], electronLogs: [] };
const ELECTRON_STARTUP_TIMEOUT_MS = 90000;

const NATIVE_OR_FILE_PATTERNS = /(open|load|save|export|snapshot|artifact|project|session|file|browse|choose|reveal|copy path|batch)/i;
const BACKEND_ACTION_PATTERNS = /(run detection|run ste|run detector|hfo classification|classify|detect_all|classifier_run|sidebar_filter|qd_run_detection|pyqt-run_button|filter$|analyze|apply|cancel task|quick detection cancel)/i;
const SAFE_TESTIDS = new Set([
  'pyqt-actionLoad_Detection_toolbar',
  'pyqt-actionQuick_Detection_toolbar',
  'pyqt-actionBatch_Project_toolbar',
  'pyqt-actionWaveform_Shortcuts_toolbar',
  'pyqt-actionStatus_Log_toolbar',
  'agent-activity-actions',
  'agent-activity-artifacts',
  'agent-panel-close',
  'pyqt-recording_info_button',
  'pyqt-header_prepare_button',
  'pyqt-header_detect_button',
  'pyqt-header_classify_button',
  'pyqt-waveform_reset_view_button',
  'pyqt-go_to_time_button',
  'pyqt-zoom_out_button',
  'pyqt-zoom_in_button',
  'pyqt-raw_tool_button',
  'pyqt-filtered_tool_button',
  'pyqt-filter60_tool_button',
  'pyqt-normalize_tool_button',
  'pyqt-referential_tool_button',
  'pyqt-average_reference_button',
  'pyqt-auto_bipolar_button',
  'pyqt-highlight_channel_button',
  'pyqt-neighbor_channels_button',
  'pyqt-clean_view_button',
  'pyqt-all_channels_button',
  'pyqt-channel_preset_8',
  'pyqt-channel_preset_16',
  'pyqt-channel_preset_32',
  'pyqt-channel_preset_max',
  'pyqt-prev_event_button',
  'pyqt-center_event_button',
  'pyqt-next_event_button',
  'pyqt-pending_event_button',
  'pyqt-event_channels_button',
  'pyqt-cursor_tool_button',
  'pyqt-measure_tool_button',
  'pyqt-open_review_button',
  'pyqt-Choose_Channels_Button',
  'pyqt-bipolar_button',
  'pyqt-channel_selection_close_button',
  'pyqt-channel_selection_cancel_button',
  'pyqt-bipolar_close_button',
  'pyqt-bipolar_cancel_button',
  'pyqt-sidebar_recording_info_button',
  'pyqt-sidebar_prepare_button',
  'pyqt-sidebar_more_results_button',
  'pyqt-sidebar_more_detection_button',
  'pyqt-sidebar_more_classification_button',
  'workflow-tab-prepare',
  'workflow-tab-detect',
  'workflow-tab-classify',
  'pyqt-subpage_back_to_main_button',
  'pyqt-runtime_log_close_button',
  'pyqt-recording_info_close_button',
  'pyqt-load_detection_close_button',
  'pyqt-load_detection_cancel_button',
  'pyqt-waveform_shortcuts_close_button',
  'pyqt-waveform_shortcuts_cancel_button',
  'pyqt-batch_project_close_button',
  'pyqt-run_stats_close_button',
  'pyqt-quick_detection_close_button',
  'pyqt-default_cpu_button',
  'pyqt-default_gpu_button',
  'pyqt-quick_detection_open_review_button',
  'pyqt-quick_detection_show_artifacts_button',
  'pyqt-annotation_close_button',
  'pyqt-PreviousButton',
  'pyqt-NextButton',
  'pyqt-PrevPendingButton',
  'pyqt-NextPendingButton',
  'pyqt-ClearAnnotationButton',
  'pyqt-PrevMatchButton',
  'pyqt-NextMatchButton',
  'pyqt-BackViewButton',
  'pyqt-ForwardViewButton',
  'pyqt-ResetViewButton',
  'pyqt-ZoomInButton',
  'pyqt-ZoomOutButton',
  'pyqt-PanLeftButton',
  'pyqt-PanRightButton',
  'pyqt-PanUpButton',
  'pyqt-PanDownButton',
]);

const REQUIRED_TESTIDS = [
  'pyqt-main-window',
  'pyqt-toolBar',
  'pyqt-waveformWiget',
  'pyqt-waveform_right_sidebar',
  'pyqt-header_prepare_button',
  'pyqt-sidebar_prepare_button',
  'pyqt-actionQuick_Detection_toolbar',
  'pyqt-actionStatus_Log_toolbar',
  'pyqt-sidebar_recording_info_button',
  'pyqt-sidebar_more_detection_button',
  'pyqt-sidebar_more_classification_button',
  'pyqt-open_review_button',
  'pyqt-subpage_back_to_main_button',
  'pyqt-quick_detection_window',
  'pyqt-annotation_window',
];

const STATES = [
  'loaded-main',
  'agent-open',
  'prepare-subpage',
  'runtime-log',
  'recording-info',
  'load-detection',
  'waveform-shortcuts',
  'channel-selection',
  'bipolar',
  'batch-project',
  'run-stats',
  'detect-subpage',
  'classify-subpage',
  'quick-detection',
  'annotation',
];

function writeReport(report) {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}

function fail(status, message, extra = {}) {
  writeReport({ status, message, ...extra });
  console.error(message);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`renderer dev server did not become ready at ${url}: ${lastError}`);
}

function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: desktopRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    text: true,
  });
  const logs = [];
  diagnostics.viteLogs = logs;
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

function buttonText(row) {
  return String(row.text || row.aria || row.title || '').replace(/\s+/g, ' ').trim();
}

function shouldSkipButton(testid, text, enabled) {
  if (!enabled) return 'disabled in this Electron state';
  if (!testid) return 'visible button has no data-testid';
  if (SAFE_TESTIDS.has(testid)) return '';
  const haystack = `${testid} ${text}`;
  if (NATIVE_OR_FILE_PATTERNS.test(haystack)) return 'native/file/export action intentionally skipped in automated Electron smoke';
  if (BACKEND_ACTION_PATTERNS.test(haystack)) return 'backend mutating action intentionally skipped in automated Electron smoke';
  return 'not in Electron-safe click allowlist';
}

async function closeKnownSurfaces(page) {
  for (const testid of [
    'agent-panel-close',
    'pyqt-recording_info_close_button',
    'pyqt-runtime_log_close_button',
    'pyqt-load_detection_close_button',
    'pyqt-waveform_shortcuts_close_button',
    'pyqt-channel_selection_close_button',
    'pyqt-bipolar_close_button',
    'pyqt-batch_project_close_button',
    'pyqt-run_stats_close_button',
    'pyqt-annotation_close_button',
    'pyqt-quick_detection_close_button',
  ]) {
    const locator = page.getByTestId(testid).first();
    try {
      if (await locator.count()) {
        await locator.evaluate((element) => {
          if (element.offsetWidth || element.offsetHeight || element.getClientRects().length) element.click();
        }, { timeout: 1000 });
        await page.waitForTimeout(80);
      }
    } catch {
      // The surface may already be gone after another safe click.
    }
  }
}

async function clickFirstVisibleEnabled(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).evaluateAll((nodes) => {
    const target = nodes.find((node) => {
      const element = node;
      return element.getClientRects().length && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    });
    if (!target) return false;
    target.click();
    return true;
  });
}

async function resetToFixture(page, baseUrl) {
  await page.goto(`${baseUrl}/?visualFixture=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 10000 });
  await page.waitForTimeout(180);
}

async function setState(page, baseUrl, state) {
  await resetToFixture(page, baseUrl);
  if (state === 'agent-open') {
    await page.getByTestId('agent-activity-actions').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="agent-panel"]');
  } else if (state === 'prepare-subpage') {
    await page.getByTestId('pyqt-header_prepare_button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-tabWidget"]:not([hidden])');
    await page.waitForSelector('[data-testid="workflow-prepare-content"]');
  } else if (state === 'runtime-log') {
    await page.getByTestId('pyqt-actionStatus_Log_toolbar').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-status_log_dialog"]');
  } else if (state === 'recording-info') {
    await page.getByTestId('pyqt-recording_info_button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-recording_info_dialog"]');
  } else if (state === 'load-detection') {
    await page.getByTestId('pyqt-actionLoad_Detection_toolbar').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-load_detection_window"]');
  } else if (state === 'waveform-shortcuts') {
    await page.getByTestId('pyqt-actionWaveform_Shortcuts_toolbar').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-waveform_shortcuts_window"]');
  } else if (state === 'channel-selection') {
    await page.getByTestId('pyqt-Choose_Channels_Button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-channel_selection_window"]');
  } else if (state === 'bipolar') {
    await page.getByTestId('pyqt-bipolar_button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-bipolar_channel_selection_window"]');
  } else if (state === 'batch-project') {
    await page.getByTestId('pyqt-actionBatch_Project_toolbar').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-batch_project_window"]');
  } else if (state === 'run-stats') {
    await page.getByTestId('pyqt-sidebar_more_results_button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-run_stats_dialog"]');
  } else if (state === 'detect-subpage') {
    await page.getByTestId('pyqt-header_detect_button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-tabWidget"]:not([hidden])');
    await page.waitForSelector('[data-testid="workflow-detect-content"]');
  } else if (state === 'classify-subpage') {
    await page.getByTestId('pyqt-header_classify_button').evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-tabWidget"]:not([hidden])');
    await page.waitForSelector('[data-testid="workflow-classify-content"]');
  } else if (state === 'quick-detection') {
    await page.getByTestId('pyqt-actionQuick_Detection_toolbar').click({ force: true });
    await page.waitForSelector('[data-testid="pyqt-quick_detection_window"]');
  } else if (state === 'annotation') {
    if (!(await clickFirstVisibleEnabled(page, 'pyqt-open_review_button'))) throw new Error('No visible enabled review button opened Annotation');
    await page.waitForSelector('[data-testid="pyqt-annotation_window"]');
  }
}

async function collectButtons(page, state) {
  const surfaceSelectors = {
    'quick-detection': '[data-testid="pyqt-quick_detection_window"] button',
    annotation: '[data-testid="pyqt-annotation_window"] button',
    'runtime-log': '[data-testid="pyqt-status_log_dialog"] button',
    'recording-info': '[data-testid="pyqt-recording_info_dialog"] button',
    'load-detection': '[data-testid="pyqt-load_detection_window"] button',
    'waveform-shortcuts': '[data-testid="pyqt-waveform_shortcuts_window"] button',
    'channel-selection': '[data-testid="pyqt-channel_selection_window"] button',
    bipolar: '[data-testid="pyqt-bipolar_channel_selection_window"] button',
    'batch-project': '[data-testid="pyqt-batch_project_window"] button',
    'run-stats': '[data-testid="pyqt-run_stats_dialog"] button',
    'agent-open': '[data-testid="agent-panel"] button, [data-testid="agent-activity-bar"] button',
  };
  const selector = surfaceSelectors[state] || 'button';
  const rows = await page.locator(selector).evaluateAll((buttons) => buttons.map((button) => ({
    testid: button.getAttribute('data-testid') || '',
    text: button.innerText || '',
    aria: button.getAttribute('aria-label') || '',
    title: button.getAttribute('title') || '',
    disabled: button.disabled || button.getAttribute('aria-disabled') === 'true',
    visible: !!(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
  })));
  return rows.filter((row) => row.visible).map((row, index) => {
    const text = buttonText(row);
    const enabled = !row.disabled;
    const detail = shouldSkipButton(row.testid, text, enabled);
    return {
      state,
      testid: row.testid || `no-testid:${index}`,
      text,
      enabled,
      visible: true,
      action: detail ? 'skip' : 'pending-click',
      result: detail ? 'skipped' : 'pending',
      detail,
    };
  });
}

async function clickButton(page, testid) {
  const locator = page.getByTestId(testid).first();
  if (!(await locator.count())) return 'missing after state reset';
  try {
    await locator.evaluate((element) => element.click(), { timeout: 1500 });
    await page.waitForTimeout(160);
    await closeKnownSurfaces(page);
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.message.split('\n', 1)[0] : String(error);
  }
}

async function auditButtons(page, baseUrl) {
  const records = [];
  for (const state of STATES) {
    await setState(page, baseUrl, state);
    const stateRecords = await collectButtons(page, state);
    const seen = new Set();
    for (const record of stateRecords) {
      if (seen.has(record.testid)) {
        records.push({ ...record, action: 'skip', result: 'skipped', detail: 'duplicate visible button testid already audited in this state' });
        continue;
      }
      seen.add(record.testid);
      if (record.action !== 'pending-click') {
        records.push(record);
        continue;
      }
      await setState(page, baseUrl, state);
      const result = await clickButton(page, record.testid);
      records.push({ ...record, action: 'clicked', result: result === 'ok' ? 'passed' : 'failed', detail: result === 'ok' ? '' : result });
    }
  }
  return records;
}

async function requiredSurfaceFailures(page, baseUrl) {
  const failures = [];
  await resetToFixture(page, baseUrl);
  for (const testid of REQUIRED_TESTIDS.slice(0, 9)) {
    if ((await page.getByTestId(testid).count()) === 0) failures.push(`missing required Electron surface ${testid}`);
  }
  await setState(page, baseUrl, 'detect-subpage');
  if ((await page.getByTestId('pyqt-subpage_back_to_main_button').count()) === 0) failures.push('missing Back-to-Waveform button in Electron Detect subpage');
  await setState(page, baseUrl, 'quick-detection');
  if ((await page.getByTestId('pyqt-quick_detection_window').count()) === 0) failures.push('missing Electron Quick Detection window');
  await setState(page, baseUrl, 'annotation');
  if ((await page.getByTestId('pyqt-annotation_window').count()) === 0) failures.push('missing Electron Annotation window');
  return failures;
}

async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
    const clipped = buttons.filter((button) => button.scrollWidth > button.clientWidth + 1 || button.scrollHeight > button.clientHeight + 1).map((button) => ({
      testid: button.getAttribute('data-testid') || '',
      text: (button.innerText || button.getAttribute('aria-label') || button.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
      width: button.clientWidth,
      scrollWidth: button.scrollWidth,
      height: button.clientHeight,
      scrollHeight: button.scrollHeight,
    }));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      visibleButtonCount: buttons.length,
      clippedButtonCount: clipped.length,
      clippedButtons: clipped.slice(0, 20),
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
}

function screenshotFileForState(state) {
  const names = {
    'loaded-main': 'electron-main.png',
    'agent-open': 'electron-agent-open.png',
    'prepare-subpage': 'electron-prepare-subpage.png',
    'runtime-log': 'electron-runtime-log.png',
    'recording-info': 'electron-recording-info.png',
    'load-detection': 'electron-load-detection.png',
    'waveform-shortcuts': 'electron-waveform-shortcuts.png',
    'channel-selection': 'electron-channel-selection.png',
    bipolar: 'electron-bipolar.png',
    'batch-project': 'electron-batch-project.png',
    'run-stats': 'electron-run-stats.png',
    'detect-subpage': 'electron-detect-subpage.png',
    'classify-subpage': 'electron-classify-subpage.png',
    'quick-detection': 'electron-quick-detection.png',
    annotation: 'electron-annotation.png',
  };
  return join(screenshotsDir, names[state] || `electron-${state}.png`);
}

async function captureStateScreenshots(page, baseUrl) {
  const screenshots = {};
  const layoutByState = {};
  for (const state of STATES) {
    await setState(page, baseUrl, state);
    await page.waitForTimeout(120);
    const path = screenshotFileForState(state);
    await page.screenshot({ path, fullPage: true });
    screenshots[state] = path;
    layoutByState[state] = await layoutSnapshot(page);
  }
  await resetToFixture(page, baseUrl);
  return { screenshots, layoutByState };
}

async function main() {
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js'))) {
    fail('missing_build', 'Electron E2E requires desktop/dist-electron/main.js. Run npm run build before npm run qa:electron-e2e.');
  }
  mkdirSync(screenshotsDir, { recursive: true });
  const rendererPort = Number(process.env.PYHFO_ELECTRON_E2E_RENDERER_PORT || await getFreePort());
  const backendPort = Number(process.env.PYHFO_ELECTRON_E2E_BACKEND_PORT || await getFreePort());
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = startVite(rendererPort);
  let electronApp;
  const consoleEntries = [];
  const pageErrors = [];
  const dialogs = [];
  try {
    await waitForServer(`${baseUrl}/?visualFixture=1`);
    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/?visualFixture=1`,
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS || '60000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: ELECTRON_STARTUP_TIMEOUT_MS,
    });
    const electronLogs = [];
    diagnostics.electronLogs = electronLogs;
    const electronProcess = electronApp.process();
    electronProcess?.stdout?.on('data', (chunk) => electronLogs.push(String(chunk)));
    electronProcess?.stderr?.on('data', (chunk) => electronLogs.push(String(chunk)));
    const page = await electronApp.firstWindow({ timeout: ELECTRON_STARTUP_TIMEOUT_MS });
    page.setDefaultTimeout(2500);
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 500) });
      try {
        await dialog.dismiss();
      } catch {
        // Electron may auto-close navigation dialogs before Playwright handles them.
      }
    });
    page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text().slice(0, 500) }));
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 500)));
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 30000 });
    await page.waitForTimeout(300);

    const preload = await page.evaluate(async () => {
      const api = window.ieeg;
      if (!api) return { hasBridge: false, health: null };
      const health = await api.getBackendStatus();
      return { hasBridge: true, health };
    });
    const surfaceFailures = await requiredSurfaceFailures(page, baseUrl);
    const { screenshots: stateScreenshots, layoutByState } = await captureStateScreenshots(page, baseUrl);
    const layout = layoutByState['loaded-main'] || await layoutSnapshot(page);
    const clickRecords = await auditButtons(page, baseUrl);
    const failedClicks = clickRecords.filter((record) => record.result === 'failed');
    const clicked = clickRecords.filter((record) => record.action === 'clicked');
    const skipped = clickRecords.filter((record) => record.action === 'skip');
    const unexpectedConsole = consoleEntries.filter((entry) => entry.type === 'error' && !/ResizeObserver loop|DevTools failed/i.test(entry.text));
    const failures = [
      ...(!preload.hasBridge ? ['Electron preload bridge was not exposed on window.ieeg'] : []),
      ...(!(preload.health && preload.health.status === 'ok') ? [`Electron backend health did not report ok: ${JSON.stringify(preload.health)}`] : []),
      ...surfaceFailures,
      ...(layout.clippedButtonCount ? [`Electron main window has ${layout.clippedButtonCount} clipped visible button(s)`] : []),
      ...(layout.hasHorizontalOverflow ? ['Electron main window has horizontal document overflow'] : []),
      ...failedClicks.map((record) => `${record.state}:${record.testid} click failed: ${record.detail}`),
      ...unexpectedConsole.map((entry) => `console error: ${entry.text}`),
      ...pageErrors.map((entry) => `page error: ${entry}`),
    ];
    const report = {
      status: failures.length ? 'failed' : 'passed',
      renderer_url: `${baseUrl}/?visualFixture=1`,
      backend_port: backendPort,
      preload,
      states_checked: STATES,
      summary: {
        electron_visible_button_records: clickRecords.length,
        clicked_safe_buttons: clicked.length,
        skipped_disabled_native_or_backend_buttons: skipped.length,
        failed_clicks: failedClicks.length,
        required_surface_failures: surfaceFailures.length,
        unexpected_console_errors: unexpectedConsole.length,
        page_errors: pageErrors.length,
        dialogs: dialogs.length,
      },
      layout,
      layout_by_state: layoutByState,
      screenshots: {
        ...stateScreenshots,
        main: stateScreenshots['loaded-main'],
        quick_detection: stateScreenshots['quick-detection'],
        annotation: stateScreenshots.annotation,
      },
      click_records: clickRecords,
      console: consoleEntries.slice(-80),
      dialogs,
      electron_logs: electronLogs.join('').split('\n').slice(-80),
      vite_logs: vite.logs.join('').split('\n').slice(-80),
      failures,
      limitations: [
        'Native file dialogs, save/export dialogs, and mutating detector/classifier backend actions are skipped to keep the Electron smoke deterministic.',
        'The wider PyQt source button inventory remains covered by qa:buttons; this gate proves the same UI can boot and interact through the real Electron main/preload runtime.',
      ],
    };
    writeReport(report);
    console.log(JSON.stringify({ status: report.status, summary: report.summary, report: outputPath, screenshots: report.screenshots, failures: failures.slice(0, 20) }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    if (electronApp) {
      try {
        await electronApp.evaluate(async ({ app }) => app.exit(0));
      } catch {
        try {
          await electronApp.close();
        } catch {
          // Process cleanup below handles stubborn Electron exits.
        }
      }
    }
    vite.child.kill();
  }
}

main().catch((error) => {
  writeReport({
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    electron_logs: diagnostics.electronLogs.join('').split('\n').slice(-80),
    vite_logs: diagnostics.viteLogs.join('').split('\n').slice(-80),
  });
  console.error(error);
  process.exit(1);
});
