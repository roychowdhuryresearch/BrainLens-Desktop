#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
// Real-EDF page audit: launch real Electron + Python backend, load a real EDF,
// then navigate every app page/dialog, screenshot each, and capture per-page
// console errors / page errors / dialogs. Output: artifacts/full-app-page-audit/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const outDir = join(desktopRoot, 'artifacts', 'full-app-page-audit');
const shotsDir = join(outDir, 'screenshots');
const reportPath = join(outDir, 'report.json');
const electronExecutable = require('electron');
const defaultFixture = join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');

function findFirstEdf(root) {
  if (!existsSync(root)) return '';
  const stack = [root];
  let scanned = 0;
  while (stack.length && scanned < 20000) {
    const current = stack.pop();
    scanned += 1;
    let stat;
    try { stat = statSync(current); } catch { continue; }
    if (stat.isFile() && current.toLowerCase().endsWith('.edf')) return current;
    if (stat.isDirectory()) for (const child of readdirSync(current).sort().reverse()) stack.push(join(current, child));
  }
  return '';
}
function resolveFixture() {
  const requested = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim();
  const candidate = requested ? resolve(requested) : (existsSync(defaultFixture) ? defaultFixture : findFirstEdf(join(repoRoot, 'data/Omni-iEEG')));
  if (!candidate || !existsSync(candidate)) throw new Error('No EDF fixture found under data/Omni-iEEG');
  return candidate;
}
function getFreePort() {
  return new Promise((res, rej) => {
    const server = createServer();
    server.unref();
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => { const a = server.address(); const p = typeof a === 'object' && a ? a.port : 0; server.close(() => res(p)); });
  });
}
async function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return; lastError = `HTTP ${r.status}`; }
    catch (e) { lastError = e instanceof Error ? e.message : String(e); }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`renderer dev server not ready at ${url}: ${lastError}`);
}
function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));
  return { child, logs };
}

// Each page: { state, click: nav testid, surface: confirm selector, dialog: close
// after, overflow: button lives in the Settings overflow menu, needsRun: needs a run }
const PAGES = [
  { state: 'loaded-main', surface: '[data-testid="pyqt-main-window"]' },
  { state: 'prepare-subpage', click: 'pyqt-header_prepare_button', surface: '[data-testid="workflow-prepare-content"]' },
  { state: 'detect-subpage', click: 'pyqt-header_detect_button', surface: '[data-testid="workflow-detect-content"]' },
  { state: 'classify-subpage', click: 'pyqt-header_classify_button', surface: '[data-testid="workflow-classify-content"]' },
  { state: 'recording-info', click: 'pyqt-recording_info_button', surface: '[data-testid="pyqt-recording_info_dialog"]', dialog: true },
  { state: 'channel-selection', click: 'pyqt-Choose_Channels_Button', surface: '[data-testid="pyqt-channel_selection_window"]', dialog: true },
  { state: 'bipolar', click: 'pyqt-bipolar_button', surface: '[data-testid="pyqt-bipolar_channel_selection_window"]', dialog: true },
  { state: 'quick-detection', click: 'pyqt-actionQuick_Detection_toolbar', surface: '[data-testid="pyqt-quick_detection_window"]', dialog: true },
  { state: 'load-detection', click: 'pyqt-actionLoad_Detection_toolbar', surface: '[data-testid="pyqt-load_detection_window"]', dialog: true, overflow: true },
  { state: 'waveform-shortcuts', click: 'pyqt-actionWaveform_Shortcuts_toolbar', surface: '[data-testid="pyqt-waveform_shortcuts_window"]', dialog: true },
  { state: 'batch-project', click: 'pyqt-actionBatch_Project_toolbar', surface: '[data-testid="pyqt-batch_project_window"]', dialog: true, overflow: true },
  { state: 'runtime-log', click: 'pyqt-actionStatus_Log_toolbar', surface: '[data-testid="pyqt-status_log_dialog"]', dialog: true, overflow: true },
  { state: 'agent-open', click: 'agent-activity-actions', surface: '[data-testid="agent-panel"]', dialog: true },
  { state: 'run-stats', click: 'pyqt-sidebar_more_results_button', surface: '[data-testid="pyqt-run_stats_dialog"]', dialog: true, needsRun: true },
  { state: 'annotation', click: 'pyqt-open_review_button', surface: '[data-testid="pyqt-annotation_window"]', dialog: true, needsRun: true },
];

async function backToWaveform(page) {
  // After loading, and after entering prepare/detect/classify subpages, the
  // toolbar buttons live in the waveform view. Click "← Back to Waveform" if present.
  const back = page.getByTestId('pyqt-subpage_back_to_main_button').first();
  if (await back.isVisible().catch(() => false)) {
    await back.click({ force: true }).catch(() => {});
    await page.waitForTimeout(350);
  }
}

async function openToolbarOverflow(page) {
  // Load Detection / Batch Project / Status Log live inside the collapsed
  // <details class="pyqt-toolbar-overflow"> (Settings menu); open it first.
  // Idempotent: clicking <summary> toggles, so only open when currently closed.
  const details = page.locator('.pyqt-toolbar-overflow').first();
  const isOpen = await details.evaluate((el) => el.hasAttribute('open')).catch(() => false);
  if (!isOpen) {
    const summary = page.locator('.pyqt-toolbar-overflow > summary').first();
    if (await summary.isVisible().catch(() => false)) {
      await summary.click({ force: true }).catch(() => {});
      await page.waitForTimeout(250);
    }
  }
}

async function closeOverlays(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(120);
  }
  // Best-effort: click any visible modal close button.
  const closers = ['pyqt-annotation_close_button', 'modal-window-close-button'];
  for (const c of closers) {
    const el = page.locator(`[data-testid="${c}"], .${c}`).first();
    if (await el.isVisible().catch(() => false)) await el.click({ force: true }).catch(() => {});
  }
  // Collapse the toolbar overflow <details> if it was left open, so it does not
  // cover later toolbar/agent controls.
  const overflowOpen = page.locator('.pyqt-toolbar-overflow[open] > summary').first();
  if (await overflowOpen.isVisible().catch(() => false)) {
    await overflowOpen.click({ force: true }).catch(() => {});
    await page.waitForTimeout(150);
  }
}

// --- Interaction coverage --------------------------------------------------
// Drive every UI-changing control on a surface: selects are cycled through ALL
// options, checkboxes/radios toggled, tabs + mode buttons clicked. Records the
// console/page errors each interaction produces and screenshots each select
// state. Controls that open a native OS file dialog are skipped (they block).
const NATIVE_DIALOG_RE = /open_recording|load_session|recent_recording|choose_|_choose_|protocol_export|protocol_import|save_npz|save_csv|save_session|save_workbook|export_report|browse|model_file|loadedf|open_edf|select_output|pick_/i;
// Keep this narrow — only verbs that ALWAYS mean a native file picker. (A plain
// "Save" button like n_jobs persists state, it does NOT open a dialog.)
const NATIVE_DIALOG_TEXT_RE = /^(choose|browse)\b/i;
// Heavy backend-pipeline triggers: skip explicitly so the sweep never kicks off
// a real detection/classification run (don't rely on them being fixture-disabled).
const RUN_TRIGGER_RE = /detector_run_button|classifier_run_button|run_detection|quick_detection_run|qd_run_button|run_ste|run_mni|run_hil/i;
const CONTROL_QUERY = 'button, select, input[type="checkbox"], input[type="radio"], [role="tab"], [role="switch"]';

async function sweepControls(page, stateName, scopeSelector, sink, recover = true) {
  const scope = page.locator(scopeSelector).first();
  if (!(await scope.isVisible().catch(() => false))) {
    sink.records.push({ state: stateName, note: `scope ${scopeSelector} not visible` });
    return;
  }
  const handles = await scope.locator(CONTROL_QUERY).elementHandles();
  const descriptors = [];
  for (const handle of handles) {
    const descriptor = await handle.evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      testid: el.getAttribute('data-testid') || '',
      text: (el.textContent || '').trim().slice(0, 32),
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled'),
    })).catch(() => null);
    if (descriptor) descriptors.push(descriptor);
  }
  for (const descriptor of descriptors) {
    const key = descriptor.testid || descriptor.text;
    if (!key || descriptor.disabled) continue;
    if (NATIVE_DIALOG_RE.test(descriptor.testid) || NATIVE_DIALOG_TEXT_RE.test(descriptor.text)) {
      sink.records.push({ state: stateName, control: key, action: 'skipped (native dialog)' });
      continue;
    }
    if (RUN_TRIGGER_RE.test(descriptor.testid)) {
      sink.records.push({ state: stateName, control: key, action: 'skipped (backend run)' });
      continue;
    }
    const locator = descriptor.testid
      ? page.locator(`[data-testid="${descriptor.testid}"]`).first()
      : scope.locator(descriptor.tag, { hasText: descriptor.text }).first();
    if (!(await locator.isVisible().catch(() => false))) continue;
    const beforeConsole = sink.consoleErrors.length;
    const beforePage = sink.pageErrors.length;
    const action = descriptor.tag === 'select' ? 'cycled' : 'clicked';
    try {
      if (descriptor.tag === 'select') {
        const values = await locator.evaluate((el) => Array.from(el.options).map((option) => option.value)).catch(() => []);
        for (const value of values) {
          await locator.selectOption(value).catch(() => {});
          await page.waitForTimeout(160);
          const slug = `${descriptor.testid || 'select'}-${String(value)}`.replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
          await page.screenshot({ path: join(sink.shotsDir, `interact-${stateName}-${slug}.png`), fullPage: false }).catch(() => {});
        }
      } else if (descriptor.type === 'checkbox' || descriptor.type === 'radio') {
        await locator.click({ force: true }).catch(() => {});
        await page.waitForTimeout(140);
      } else {
        await locator.click({ force: true }).catch(() => {});
        await page.waitForTimeout(180);
        if (recover) await closeOverlays(page).catch(() => {});
      }
    } catch (error) {
      sink.records.push({ state: stateName, control: key, action, error: String(error).slice(0, 120) });
    }
    sink.records.push({
      state: stateName,
      control: key,
      action,
      consoleErrors: sink.consoleErrors.length - beforeConsole,
      pageErrors: sink.pageErrors.length - beforePage,
    });
  }
}

async function main() {
  const fixturePath = resolveFixture();
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js'))) throw new Error('Run npm run build first (missing dist-electron).');
  mkdirSync(shotsDir, { recursive: true });
  const rendererPort = await getFreePort();
  const backendPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = startVite(rendererPort);
  let app;
  const console_log = [];
  const pageErrors = [];
  let currentState = 'startup';
  const results = [];
  try {
    await waitForServer(`${baseUrl}/?fullAppAudit=1`);
    app = await electron.launch({
      executablePath: electronExecutable, args: [desktopRoot], cwd: desktopRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: `${baseUrl}/?fullAppAudit=1`, PYHFO_BACKEND_PORT: String(backendPort), PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python', PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '60000', PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      timeout: 90000,
    });
    const page = await app.firstWindow({ timeout: 90000 });
    page.setDefaultTimeout(6000);
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });
    page.on('console', (m) => { if (m.type() === 'error') console_log.push({ state: currentState, text: m.text().slice(0, 400) }); });
    page.on('pageerror', (e) => pageErrors.push({ state: currentState, text: String(e).slice(0, 400) }));
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 40000 });

    // Home (no recording) screenshot.
    currentState = 'home';
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(shotsDir, 'home.png'), fullPage: false });
    results.push({ state: 'home', opened: true });

    // Load the real EDF via recent-recordings.
    await page.evaluate((fixture) => {
      window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: fixture, label: fixture.split('/').pop() || fixture, openedAt: new Date().toISOString(), metadata: null }]));
    }, fixturePath);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 12000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveformWiget"]', { timeout: 40000 });
    await page.waitForTimeout(800);
    await backToWaveform(page); // recent-open lands on Prepare; return to waveform base for toolbar access

    for (const p of PAGES) {
      currentState = p.state;
      await backToWaveform(page); // ensure waveform base before navigating each page
      const errBefore = console_log.length;
      const peBefore = pageErrors.length;
      let opened = false;
      let note = '';
      try {
        if (p.overflow) await openToolbarOverflow(page);
        if (p.click) {
          const target = page.getByTestId(p.click).first();
          if (await target.isVisible().catch(() => false)) {
            await target.click({ force: true });
          } else {
            note = `nav button ${p.click} not visible`;
          }
        }
        await page.waitForSelector(p.surface, { timeout: 7000 });
        opened = true;
      } catch (e) {
        note = note || (p.needsRun ? `not opened (likely needs a detection run): ${String(e).slice(0, 120)}` : `not opened: ${String(e).slice(0, 160)}`);
      }
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(shotsDir, `${p.state}.png`), fullPage: false }).catch(() => {});
      results.push({ state: p.state, opened, note, consoleErrors: console_log.length - errBefore, pageErrors: pageErrors.length - peBefore });
      if (p.dialog) await closeOverlays(page);
    }

    // Interaction coverage: drive every UI-changing control per surface and
    // record the console/page errors each one produces.
    const interactionRecords = [];
    const sink = { consoleErrors: console_log, pageErrors, records: interactionRecords, shotsDir };
    await backToWaveform(page);
    await closeOverlays(page);
    currentState = 'interact-waveform-toolbar';
    await sweepControls(page, 'waveform-toolbar', '[data-testid="pyqt-waveform-toolbar"]', sink);
    for (const tab of ['prepare', 'detect', 'classify']) {
      currentState = `interact-${tab}`;
      await backToWaveform(page);
      const navButton = page.getByTestId(`pyqt-header_${tab}_button`).first();
      if (await navButton.isVisible().catch(() => false)) await navButton.click({ force: true }).catch(() => {});
      await page.waitForSelector(`[data-testid="workflow-${tab}-content"]`, { timeout: 7000 }).catch(() => {});
      await page.waitForTimeout(400);
      await sweepControls(page, tab, `[data-testid="workflow-${tab}-content"]`, sink);
    }
    // Toolbar selector popovers: each closes after ONE option applies, so
    // enumerate its controls then RE-OPEN before each so every option (montage
    // modes, channel presets, focus modes, view settings) is exercised.
    await backToWaveform(page);
    for (const [btnId, popoverSel] of [
      ['pyqt-waveform_view_summary_button', '.waveform-view-settings-popover'],
      ['pyqt-channel_scope_summary_button', '.clinical-selector-popover'],
      ['pyqt-montage_summary_button', '.clinical-selector-popover'],
      ['pyqt-focus_summary_button', '.clinical-selector-popover'],
    ]) {
      currentState = `popover-${btnId}`;
      const trigger = () => page.getByTestId(btnId).first();
      if (!(await trigger().isVisible().catch(() => false))) continue;
      await trigger().click({ force: true }).catch(() => {});
      await page.waitForTimeout(220);
      const innerIds = await page.locator(popoverSel).first().locator(CONTROL_QUERY)
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')).filter(Boolean)).catch(() => []);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(100);
      for (const innerId of innerIds) {
        if (NATIVE_DIALOG_RE.test(innerId) || RUN_TRIGGER_RE.test(innerId)) {
          interactionRecords.push({ state: currentState, control: innerId, action: 'skipped (guarded)' });
          continue;
        }
        if (!(await trigger().isVisible().catch(() => false))) await backToWaveform(page);
        await trigger().click({ force: true }).catch(() => {});
        await page.waitForTimeout(160);
        const control = page.locator(`[data-testid="${innerId}"]`).first();
        if (!(await control.isVisible().catch(() => false))) continue;
        const beforeConsole = console_log.length;
        const beforePage = pageErrors.length;
        await control.click({ force: true }).catch(() => {});
        await page.waitForTimeout(150);
        interactionRecords.push({ state: currentState, control: innerId, action: 'clicked', consoleErrors: console_log.length - beforeConsole, pageErrors: pageErrors.length - beforePage });
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(80);
      }
    }
    await backToWaveform(page);
    await page.waitForTimeout(250);

    const benign = /ResizeObserver loop|DevTools failed|Download the React DevTools/i;
    const realConsole = console_log.filter((e) => !benign.test(e.text));
    const interactionErrors = interactionRecords.filter((r) => r.error || (r.consoleErrors || 0) > 0 || (r.pageErrors || 0) > 0);
    const report = {
      generated_at: new Date().toISOString(),
      fixture_path: fixturePath,
      pages: results,
      interactions: interactionRecords,
      console_errors: realConsole,
      page_errors: pageErrors,
      summary: {
        pages_total: results.length,
        pages_opened: results.filter((r) => r.opened).length,
        pages_not_opened: results.filter((r) => !r.opened).map((r) => r.state),
        controls_exercised: interactionRecords.filter((r) => r.action && !String(r.action).startsWith('skipped')).length,
        controls_skipped: interactionRecords.filter((r) => String(r.action).startsWith('skipped')).length,
        interaction_error_count: interactionErrors.length,
        console_error_count: realConsole.length,
        page_error_count: pageErrors.length,
      },
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report.summary, null, 2));
    if (interactionErrors.length) console.log('Interaction errors:', JSON.stringify(interactionErrors, null, 2));
    console.log(`Report: ${reportPath}`);
    console.log(`Screenshots: ${shotsDir}`);
    // Honest exit: fail on any skipped page or any console/page/interaction error.
    if (report.summary.pages_not_opened.length || report.summary.console_error_count || report.summary.page_error_count || report.summary.interaction_error_count) process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app: a }) => a.exit(0)); } catch { try { await app.close(); } catch { /* noop */ } } }
    vite.child.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
