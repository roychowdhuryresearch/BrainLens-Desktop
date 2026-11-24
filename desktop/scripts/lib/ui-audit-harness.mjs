#!/usr/bin/env node
// Shared harness for the UI audits (geometry + alignment).
// Owns: dev-server spawn, readiness wait, viewport parsing, and the
// state-navigation map (the 16 UI surfaces). Both ui-geometry-audit.mjs and
// ui-alignment-audit.mjs import from here so the surface list and the
// click-sequence to reach each state never drift between the two audits.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));

export const STATE_SURFACES = {
  'loaded-main': '[data-testid="pyqt-main-window"]',
  'waveform-review': '[data-testid="pyqt-waveform-toolbar"]',
  'agent-open': '[data-testid="agent-panel"]',
  'prepare-subpage': '[data-testid="workflow-prepare-content"]',
  'detect-subpage': '[data-testid="workflow-detect-content"]',
  'classify-subpage': '[data-testid="workflow-classify-content"]',
  'quick-detection': '[data-testid="pyqt-quick_detection_window"]',
  annotation: '[data-testid="pyqt-annotation_window"]',
  'recording-info': '[data-testid="pyqt-recording_info_dialog"]',
  'runtime-log': '[data-testid="pyqt-status_log_dialog"]',
  'load-detection': '[data-testid="pyqt-load_detection_window"]',
  'waveform-shortcuts': '[data-testid="pyqt-waveform_shortcuts_window"]',
  'channel-selection': '[data-testid="pyqt-channel_selection_window"]',
  bipolar: '[data-testid="pyqt-bipolar_channel_selection_window"]',
  'batch-project': '[data-testid="pyqt-batch_project_window"]',
  'run-stats': '[data-testid="pyqt-run_stats_dialog"]',
};

export const STATES = [
  'loaded-main',
  'waveform-review',
  'prepare-subpage',
  'detect-subpage',
  'classify-subpage',
  'quick-detection',
  'annotation',
  'recording-info',
  'runtime-log',
  'load-detection',
  'waveform-shortcuts',
  'channel-selection',
  'bipolar',
  'batch-project',
  'run-stats',
  'agent-open',
];

// Electron pins the main window to MAIN_WINDOW_MIN_WIDTH x MAIN_WINDOW_MIN_HEIGHT (electron/main.ts:
// 1440x860 — full-width on a 13" MacBook Air and short enough for its ~875px work area; the docked
// agent panel relies on this floor for its compact-toolbar math). The
// shared audits must never render below that reachable minimum, and these match the inline viewport
// sets in ui-geometry-audit.mjs / ui-interaction-overlap-audit.mjs / ui-stateful-layout-audit.mjs.
export const MIN_VIEWPORT_WIDTH = 1440;
export const MIN_VIEWPORT_HEIGHT = 860;

export const DEFAULT_VIEWPORTS = [
  { name: 'minimum-main', width: 1440, height: 860 },
  { name: 'desktop', width: 1512, height: 982 },
  { name: 'compact', width: 1440, height: 900 },
];

export function parseViewports(raw = process.env.UI_GEOMETRY_VIEWPORTS || '') {
  if (!raw.trim()) return DEFAULT_VIEWPORTS;
  return raw.split(',').map((entry) => {
    const [namePart, sizePart] = entry.includes(':') ? entry.split(':', 2) : ['', entry];
    const [width, height] = sizePart.split('x').map((value) => Number(value.trim()));
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error(`Invalid UI_GEOMETRY_VIEWPORTS entry: ${entry}`);
    }
    if (width < MIN_VIEWPORT_WIDTH || height < MIN_VIEWPORT_HEIGHT) {
      throw new Error(`UI_GEOMETRY_VIEWPORTS entry is below Electron minimum window size (${MIN_VIEWPORT_WIDTH}x${MIN_VIEWPORT_HEIGHT}): ${entry}`);
    }
    return { name: namePart || `${width}x${height}`, width, height };
  });
}

export function getFreePort() {
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

export async function waitForServer(url, timeoutMs = 45000) {
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

export function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: desktopRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    text: true,
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

export function withVisualFixture(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('visualFixture', '1');
  return parsed.toString();
}

export async function clickFirstVisibleEnabled(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).evaluateAll((nodes) => {
    const target = nodes.find((node) => {
      const element = node;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !element.disabled && element.getAttribute('aria-disabled') !== 'true';
    });
    if (!target) return false;
    target.click();
    return true;
  });
}

export async function resetToFixture(page, fixtureUrl) {
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 10000 });
  await page.waitForTimeout(180);
}

export async function clickTestId(page, testid) {
  await page.getByTestId(testid).evaluate((element) => element.click());
}

export async function setState(page, fixtureUrl, state) {
  await resetToFixture(page, fixtureUrl);
  if (state === 'loaded-main') return;
  if (state === 'waveform-review') {
    if (!(await clickFirstVisibleEnabled(page, 'pyqt-subpage_back_to_main_button'))) throw new Error('No visible enabled back button returned to waveform review');
  } else if (state === 'agent-open') {
    await clickTestId(page, 'agent-activity-actions');
  } else if (state === 'prepare-subpage') {
    await clickTestId(page, 'pyqt-header_prepare_button');
  } else if (state === 'detect-subpage') {
    await clickTestId(page, 'pyqt-header_detect_button');
  } else if (state === 'classify-subpage') {
    await clickTestId(page, 'pyqt-header_classify_button');
  } else if (state === 'quick-detection') {
    await page.getByTestId('pyqt-actionQuick_Detection_toolbar').click({ force: true });
  } else if (state === 'annotation') {
    if (!(await clickFirstVisibleEnabled(page, 'pyqt-open_review_button'))) throw new Error('No visible enabled review button opened Annotation');
  } else if (state === 'recording-info') {
    await clickTestId(page, 'pyqt-recording_info_button');
  } else if (state === 'runtime-log') {
    await clickTestId(page, 'pyqt-actionStatus_Log_toolbar');
  } else if (state === 'load-detection') {
    await clickTestId(page, 'pyqt-actionLoad_Detection_toolbar');
  } else if (state === 'waveform-shortcuts') {
    await clickTestId(page, 'pyqt-actionWaveform_Shortcuts_toolbar');
  } else if (state === 'channel-selection') {
    await clickTestId(page, 'pyqt-Choose_Channels_Button');
  } else if (state === 'bipolar') {
    await clickTestId(page, 'pyqt-bipolar_button');
  } else if (state === 'batch-project') {
    await clickTestId(page, 'pyqt-actionBatch_Project_toolbar');
  } else if (state === 'run-stats') {
    await clickTestId(page, 'pyqt-sidebar_more_results_button');
  } else {
    throw new Error(`Unknown UI state: ${state}`);
  }
  if (state === 'waveform-review') await page.waitForSelector('.pyqt-workspace-shell[data-active-workflow-tab="waveform"]', { timeout: 7000 });
  await page.waitForSelector(STATE_SURFACES[state], { timeout: 7000 });
  await page.waitForTimeout(180);
}
