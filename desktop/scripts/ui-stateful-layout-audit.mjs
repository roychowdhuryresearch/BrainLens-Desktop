#!/usr/bin/env node
// Stateful layout audit.
//
// WHY THIS EXISTS
// The static UI audits (ui-geometry-audit, ui-alignment-audit) and the overlay
// audit (ui-interaction-overlap-audit) render each surface in its DEFAULT state.
// They never drive the stateful controls that REVEAL conditionally-rendered UI.
// Example regression: switching the Classifier preset to "Custom" shows the
// "Local models" / "Hub models" cards. A row in "Local models" was wider than
// its column and its "Choose File" button overflowed the card -- but because no
// audit ever switched the preset to Custom, the overflowing cards were never
// rendered and the breakage was invisible to the whole QA suite.
//
// WHAT THIS DOES
// For each surface, drive it into the states that reveal conditional UI, then for
// every state x viewport assert that:
//   - no interactive control overflows its containing card        (the regression)
//   - no interactive control overflows the viewport horizontally
//   - interactive controls do not cover each other
// It also accumulates which interactive testids were exercised and (Phase 4)
// gates against a committed coverage baseline so a surface that silently stops
// rendering -- a new blind spot -- fails the audit.
//
// Harness mirrors ui-interaction-overlap-audit.mjs: chromium drives the renderer
// served by Vite in `?visualFixture` mode (deterministic loaded workspace, no
// Electron, no Python backend). Navigation mirrors ui-geometry-audit's setState.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const artifactsRoot = join(desktopRoot, 'artifacts');
const reportDir = join(artifactsRoot, 'ui-stateful-layout-audit');
const screenshotsDir = join(reportDir, 'screenshots');
const jsonOutputPath = join(artifactsRoot, 'ui-stateful-layout-audit.json');
const baselinePath = join(desktopRoot, 'scripts', 'ui-stateful-coverage-baseline.json');

const MIN_VIEWPORT_WIDTH = 1440;
const MIN_VIEWPORT_HEIGHT = 860;
const DEFAULT_VIEWPORTS = [
  { name: 'minimum-main', width: 1440, height: 860 },
  { name: 'compact', width: 1440, height: 900 },
  { name: 'desktop', width: 1512, height: 982 },
];

// Surface selector whose presence confirms arrival at a base state.
const BASE_SURFACES = {
  'loaded-main': '[data-testid="pyqt-main-window"]',
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

// ---------------------------------------------------------------------------
// Harness helpers (self-contained, matching the sibling audit scripts).
// ---------------------------------------------------------------------------
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
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

function withVisualFixture(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('visualFixture', '1');
  return parsed.toString();
}

async function resetToFixture(page, fixtureUrl) {
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 10000 });
  await page.waitForTimeout(180);
}

async function clickTestId(page, testid) {
  await page.getByTestId(testid).first().evaluate((element) => element.click());
}

async function clickFirstVisibleEnabled(page, testid) {
  return page.locator(`[data-testid="${testid}"]`).evaluateAll((nodes) => {
    const target = nodes.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
    });
    if (!target) return false;
    target.click();
    return true;
  });
}

// Navigate the loaded fixture to a base surface. Fresh page load each time so
// there is no stale-state carryover between scenarios. Mirrors ui-geometry-audit.
async function setBaseState(page, fixtureUrl, base) {
  await resetToFixture(page, fixtureUrl);
  if (base === 'loaded-main') {
    // already here
  } else if (base === 'prepare-subpage') {
    await clickTestId(page, 'pyqt-header_prepare_button');
  } else if (base === 'detect-subpage') {
    await clickTestId(page, 'pyqt-header_detect_button');
  } else if (base === 'classify-subpage') {
    await clickTestId(page, 'pyqt-header_classify_button');
  } else if (base === 'quick-detection') {
    await page.getByTestId('pyqt-actionQuick_Detection_toolbar').click({ force: true });
  } else if (base === 'annotation') {
    if (!(await clickFirstVisibleEnabled(page, 'pyqt-open_review_button'))) throw new Error('No visible review button opened Annotation');
  } else if (base === 'recording-info') {
    await clickTestId(page, 'pyqt-recording_info_button');
  } else if (base === 'runtime-log') {
    await clickTestId(page, 'pyqt-actionStatus_Log_toolbar');
  } else if (base === 'load-detection') {
    await clickTestId(page, 'pyqt-actionLoad_Detection_toolbar');
  } else if (base === 'waveform-shortcuts') {
    await clickTestId(page, 'pyqt-actionWaveform_Shortcuts_toolbar');
  } else if (base === 'channel-selection') {
    await clickTestId(page, 'pyqt-Choose_Channels_Button');
  } else if (base === 'bipolar') {
    await clickTestId(page, 'pyqt-bipolar_button');
  } else if (base === 'batch-project') {
    await clickTestId(page, 'pyqt-actionBatch_Project_toolbar');
  } else if (base === 'run-stats') {
    await clickTestId(page, 'pyqt-sidebar_more_results_button');
  } else {
    throw new Error(`Unknown base state: ${base}`);
  }
  await page.waitForSelector(BASE_SURFACES[base], { timeout: 7000 });
  await page.waitForTimeout(160);
}

async function selectOption(page, testid, value) {
  await page.selectOption(`[data-testid="${testid}"]`, value);
  await page.waitForTimeout(140);
}

async function setCheckbox(page, testid, checked) {
  const box = page.locator(`[data-testid="${testid}"]`).first();
  if (!(await box.count())) return;
  const current = await box.isChecked().catch(() => null);
  if (current === null || current === checked) return;
  await box.evaluate((el) => el.click());
  await page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// Scenario matrix. Each scenario navigates to a base surface, optionally drives
// stateful controls to reveal conditional UI, then the surface is audited. A
// scenario with `comboCycle` is expanded to one audited sub-run per option of
// that <select> -- the same "drive the control that reveals conditional UI"
// lesson, applied to every detector/biomarker mode.
//
// loaded-main / waveform toolbar / agent panel are intentionally NOT covered
// here: they are owned by ui-geometry-audit and ui-interaction-overlap-audit.
// This audit complements them by exercising the conditional-heavy surfaces.
// ---------------------------------------------------------------------------
const CLASSIFY_SURFACE = '[data-testid="workflow-classify-content"]';
const DETECT_SURFACE = '[data-testid="workflow-detect-content"]';
const PREPARE_SURFACE = '[data-testid="workflow-prepare-content"]';

const SCENARIOS = [
  // --- Workflow tabs -------------------------------------------------------
  { name: 'prepare/default', base: 'prepare-subpage', surface: PREPARE_SURFACE },
  { name: 'detect/default', base: 'detect-subpage', surface: DETECT_SURFACE },
  // Each detector mode reflows the parameter form -> audit every mode.
  { name: 'detect/mode', base: 'detect-subpage', surface: DETECT_SURFACE, comboCycle: 'pyqt-detector_mode_combo' },
  { name: 'classify/hf-cpu', base: 'classify-subpage', surface: CLASSIFY_SURFACE, drive: async (page) => { await selectOption(page, 'pyqt-classifier_mode_combo', 'HF CPU'); } },
  {
    name: 'classify/custom-hub',
    base: 'classify-subpage',
    surface: CLASSIFY_SURFACE,
    // Reveals Local models + Hub models cards (the cards that overflowed).
    drive: async (page) => {
      await selectOption(page, 'pyqt-classifier_mode_combo', 'Custom');
      await page.waitForSelector('[data-testid="pyqt-groupBox"]', { timeout: 5000 });
    },
  },
  {
    name: 'classify/custom-no-spike',
    base: 'classify-subpage',
    surface: CLASSIFY_SURFACE,
    drive: async (page) => {
      await selectOption(page, 'pyqt-classifier_mode_combo', 'Custom');
      await page.waitForSelector('[data-testid="pyqt-groupBox"]', { timeout: 5000 });
      await setCheckbox(page, 'pyqt-use_spike_checkbox', false);
    },
  },
  {
    name: 'classify/custom-no-ehfo',
    base: 'classify-subpage',
    surface: CLASSIFY_SURFACE,
    drive: async (page) => {
      await selectOption(page, 'pyqt-classifier_mode_combo', 'Custom');
      await page.waitForSelector('[data-testid="pyqt-groupBox"]', { timeout: 5000 });
      await setCheckbox(page, 'pyqt-use_ehfo_checkbox', false);
    },
  },
  // --- Dialogs -------------------------------------------------------------
  { name: 'dialog/quick-detection', base: 'quick-detection', surface: BASE_SURFACES['quick-detection'] },
  { name: 'dialog/annotation', base: 'annotation', surface: BASE_SURFACES.annotation },
  { name: 'dialog/recording-info', base: 'recording-info', surface: BASE_SURFACES['recording-info'] },
  { name: 'dialog/runtime-log', base: 'runtime-log', surface: BASE_SURFACES['runtime-log'] },
  { name: 'dialog/load-detection', base: 'load-detection', surface: BASE_SURFACES['load-detection'] },
  { name: 'dialog/waveform-shortcuts', base: 'waveform-shortcuts', surface: BASE_SURFACES['waveform-shortcuts'] },
  { name: 'dialog/channel-selection', base: 'channel-selection', surface: BASE_SURFACES['channel-selection'] },
  { name: 'dialog/bipolar', base: 'bipolar', surface: BASE_SURFACES.bipolar },
  { name: 'dialog/batch-project', base: 'batch-project', surface: BASE_SURFACES['batch-project'] },
  { name: 'dialog/run-stats', base: 'run-stats', surface: BASE_SURFACES['run-stats'] },
];

// ---------------------------------------------------------------------------
// In-page evaluator: overflow + cover checks for interactive controls in a surface.
// ---------------------------------------------------------------------------
function auditSurfaceInPage(surfaceSel) {
  const EPS = 1.5;
  const surface = document.querySelector(surfaceSel) || document.body;
  const CONTROL = 'button,input:not([type="hidden"]),select,textarea,[role="button"]';
  const CARD = '[class*="card"],.panel-card,.run-management-box,.classifier-hub-banner';
  const round = (n) => Math.round(n * 100) / 100;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0.01;
  };
  const desc = (el) => ({
    testid: el.getAttribute('data-testid') || '',
    text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 28),
    tag: el.tagName.toLowerCase(),
  });
  const presented = (el) => {
    // Skip controls that are not actually shown to the user: inside a closed
    // overflow menu / hidden / inert subtree, or rendered fully off-screen
    // (e.g. collapsed toolbar overflow items parked off-canvas).
    if (el.closest('details:not([open]),[hidden],[aria-hidden="true"],[inert]')) return false;
    const r = el.getBoundingClientRect();
    if (r.right <= 0 || r.left >= window.innerWidth || r.bottom <= 0) return false;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    for (let node = el.parentElement; node && node !== surface; node = node.parentElement) {
      const s = getComputedStyle(node);
      const clipsY = /(auto|scroll|hidden|clip)/.test(`${s.overflowY} ${s.overflow}`);
      const clipsX = /(auto|scroll|hidden|clip)/.test(`${s.overflowX} ${s.overflow}`);
      if (!clipsX && !clipsY) continue;
      const nr = node.getBoundingClientRect();
      if ((clipsX && (cx < nr.left || cx > nr.right)) || (clipsY && (cy < nr.top || cy > nr.bottom))) return false;
    }
    return true;
  };
  const visibleControls = Array.from(surface.querySelectorAll(CONTROL)).filter((el) => visible(el));
  const controls = visibleControls.filter((el) => presented(el));
  const vw = window.innerWidth;
  const overflow = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    // Only horizontal overflow is a layout bug; vertical extent is expected --
    // panels and dialog bodies scroll vertically.
    if (r.right > vw + EPS || r.left < -EPS) {
      overflow.push({ kind: 'viewport-overflow', ...desc(el), axis: 'x', rect: { left: round(r.left), right: round(r.right) } });
    }
    // Nearest *inner* card -- never the surface/shell container itself, whose
    // own bottom a scrolled control legitimately exceeds.
    const card = el.parentElement ? el.parentElement.closest(CARD) : null;
    if (card && surface.contains(card) && card !== el && card !== surface && !card.contains(surface)) {
      const cs = getComputedStyle(card);
      const cr = card.getBoundingClientRect();
      const scrollX = /(auto|scroll)/.test(`${cs.overflowX} ${cs.overflow}`);
      const over = {};
      if (!scrollX && r.right > cr.right + EPS) over.right = round(r.right - cr.right);
      if (!scrollX && r.left < cr.left - EPS) over.left = round(cr.left - r.left);
      if (Object.keys(over).length) {
        overflow.push({
          kind: 'card-overflow',
          ...desc(el),
          over,
          cardTestid: card.getAttribute('data-testid') || '',
          cardClass: String(card.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join(' '),
        });
      }
    }
  }
  // Conservative cover check: a control's center is occupied by a different,
  // non-ancestor control (mirrors ui-interaction-overlap-audit's approach).
  const overlap = [];
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit)) continue;
    const hitControl = hit.closest(CONTROL);
    if (!hitControl || hitControl === el || el.contains(hitControl) || hitControl.contains(el)) continue;
    if (!surface.contains(hitControl)) continue;
    overlap.push({ kind: 'covered', ...desc(el), coveredBy: desc(hitControl) });
  }
  return {
    controlCount: visibleControls.length,
    overflow,
    overlap,
    seenTestids: visibleControls.map((c) => c.getAttribute('data-testid')).filter(Boolean),
  };
}

function issuesFromResult(result, label) {
  const issues = [];
  for (const o of result.overflow) {
    const where = o.kind === 'card-overflow'
      ? `overflows card ${o.cardTestid || o.cardClass} by ${Object.entries(o.over).map(([k, v]) => `${k} ${v}px`).join(', ')}`
      : 'leaves the viewport horizontally';
    issues.push({ severity: 'error', type: o.kind, message: `${o.testid || o.text || o.tag} ${where}`, control: o });
  }
  for (const o of result.overlap) {
    // Cover detection is noisier than overflow (sticky footers over scrolled
    // lists, etc.), so it is advisory rather than a hard gate.
    issues.push({ severity: 'warning', type: 'control-covered', message: `${o.testid || o.text || o.tag} is covered by ${o.coveredBy.testid || o.coveredBy.text || o.coveredBy.tag}`, control: o });
  }
  return issues.map((i) => ({ ...i, label }));
}

async function auditOnce(page, viewport, scenario, label, seen) {
  const result = await page.evaluate(auditSurfaceInPage, scenario.surface);
  for (const t of result.seenTestids) seen.add(t);
  const screenshotPath = join(screenshotsDir, `${viewport.name}--${label.replace(/[/:]/g, '-')}.png`);
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  return { viewport: viewport.name, scenario: label, controlCount: result.controlCount, screenshot_path: screenshotPath, issues: issuesFromResult(result, label) };
}

async function auditScenario(browser, fixtureUrl, viewport, scenario, seen) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const runs = [];
  try {
    await setBaseState(page, fixtureUrl, scenario.base);
    if (scenario.drive) await scenario.drive(page);
    if (scenario.comboCycle) {
      const values = await page.$eval(`[data-testid="${scenario.comboCycle}"]`, (sel) => Array.from(sel.options).filter((o) => !o.disabled).map((o) => o.value));
      for (const value of values) {
        await selectOption(page, scenario.comboCycle, value);
        await page.waitForTimeout(160);
        runs.push(await auditOnce(page, viewport, scenario, `${scenario.name}=${value}`, seen));
      }
    } else {
      await page.waitForTimeout(140);
      runs.push(await auditOnce(page, viewport, scenario, scenario.name, seen));
    }
  } catch (error) {
    runs.push({ viewport: viewport.name, scenario: scenario.name, controlCount: 0, issues: [{ severity: 'error', type: 'audit-error', message: String(error instanceof Error ? error.message : error).slice(0, 200), label: scenario.name }] });
  }
  await page.close();
  return runs;
}

function checkCoverageBaseline(seen) {
  const seenSorted = [...seen].sort();
  const updating = process.env.UI_STATEFUL_UPDATE_BASELINE === '1';
  if (updating || !existsSync(baselinePath)) {
    writeFileSync(baselinePath, `${JSON.stringify(seenSorted, null, 2)}\n`);
    return { mode: updating ? 'updated' : 'created', baseline_count: seenSorted.length, missing: [], added: [], issues: [] };
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const seenSet = new Set(seenSorted);
  const baseSet = new Set(baseline);
  const missing = baseline.filter((t) => !seenSet.has(t)); // previously audited, now absent -> coverage regression
  const added = seenSorted.filter((t) => !baseSet.has(t)); // newly audited -> update baseline
  const issues = missing.map((t) => ({ severity: 'error', type: 'coverage-regression', message: `control no longer exercised by any audited state: ${t} (run with UI_STATEFUL_UPDATE_BASELINE=1 if intentional)`, label: 'coverage' }));
  return { mode: 'checked', baseline_count: baseline.length, missing, added, issues };
}

async function main() {
  rmSync(screenshotsDir, { recursive: true, force: true });
  mkdirSync(screenshotsDir, { recursive: true });
  const externalUrl = process.env.UI_STATEFUL_URL || '';
  const port = Number(process.env.UI_STATEFUL_PORT || (await getFreePort()));
  const baseUrl = externalUrl ? externalUrl : `http://127.0.0.1:${port}/`;
  const fixtureUrl = withVisualFixture(baseUrl);
  const viewports = DEFAULT_VIEWPORTS;
  const seen = new Set();
  let vite;
  let browser;
  try {
    if (!externalUrl) {
      vite = startVite(port);
      await waitForServer(fixtureUrl);
    }
    browser = await chromium.launch({ headless: true });
    const runs = [];
    for (const viewport of viewports) {
      for (const scenario of SCENARIOS) {
        runs.push(...(await auditScenario(browser, fixtureUrl, viewport, scenario, seen)));
      }
    }
    const coverage = checkCoverageBaseline(seen);
    const allIssues = [...runs.flatMap((run) => run.issues.map((issue) => ({ ...issue, viewport: run.viewport }))), ...coverage.issues];
    const errors = allIssues.filter((issue) => issue.severity === 'error');
    const warnings = allIssues.filter((issue) => issue.severity === 'warning');
    const report = {
      generated_at: new Date().toISOString(),
      status: errors.length ? 'failed' : 'passed',
      fixture_url: fixtureUrl,
      viewports,
      scenarios: SCENARIOS.map((s) => s.name),
      summary: { runs: runs.length, errors: errors.length, warnings: warnings.length, distinct_controls_seen: seen.size },
      coverage: { mode: coverage.mode, baseline_count: coverage.baseline_count, missing: coverage.missing, added: coverage.added },
      issues: allIssues,
      runs,
    };
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`UI stateful-layout audit ${report.status}: ${runs.length} runs, ${errors.length} error(s), ${warnings.length} warning(s), ${seen.size} distinct controls exercised.`);
    console.log(`Coverage baseline: ${coverage.mode} (${coverage.baseline_count} controls); ${coverage.added.length} newly seen, ${coverage.missing.length} missing.`);
    console.log(`JSON report: ${relative(desktopRoot, jsonOutputPath)}`);
    if (coverage.added.length) console.warn(`- new controls now exercised (consider UI_STATEFUL_UPDATE_BASELINE=1): ${coverage.added.join(', ')}`);
    for (const issue of errors) console.error(`- [${issue.viewport || issue.label}] ${issue.type}: ${issue.message}`);
    if (errors.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (vite) vite.child.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
