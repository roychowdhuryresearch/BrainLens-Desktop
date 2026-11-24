#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const artifactsRoot = join(desktopRoot, 'artifacts');
const reportDir = join(artifactsRoot, 'ui-geometry-audit');
const screenshotsDir = join(reportDir, 'screenshots');
const jsonOutputPath = join(artifactsRoot, 'ui-geometry-audit.json');
const htmlOutputPath = join(reportDir, 'index.html');

const STATE_SURFACES = {
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

const STATES = [
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

const MIN_VIEWPORT_WIDTH = 1440;
const MIN_VIEWPORT_HEIGHT = 860;

const DEFAULT_VIEWPORTS = [
  { name: 'minimum-main', width: 1440, height: 860 },
  { name: 'desktop', width: 1512, height: 982 },
  { name: 'compact', width: 1440, height: 900 },
];

function parseViewports() {
  const raw = process.env.UI_GEOMETRY_VIEWPORTS || '';
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

async function clickFirstVisibleEnabled(page, testid) {
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

async function resetToFixture(page, fixtureUrl) {
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 10000 });
  await page.waitForTimeout(180);
}

async function clickTestId(page, testid) {
  await page.getByTestId(testid).evaluate((element) => element.click());
}

async function setState(page, fixtureUrl, state) {
  await resetToFixture(page, fixtureUrl);
  if (state === 'loaded-main') return;
  if (state === 'waveform-review') {
    await page.waitForSelector('[data-testid="pyqt-waveform-toolbar"]', { timeout: 7000 });
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
    throw new Error(`Unknown UI geometry state: ${state}`);
  }
  if (state === 'waveform-review') await page.waitForSelector('.pyqt-workspace-shell[data-active-workflow-tab="waveform"]', { timeout: 7000 });
  await page.waitForSelector(STATE_SURFACES[state], { timeout: 7000 });
  await page.waitForTimeout(180);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function relativeArtifactPath(path) {
  return relative(reportDir, path).replaceAll('\\', '/');
}

function renderIssue(issue) {
  const context = [
    issue.testid ? `testid=${issue.testid}` : '',
    issue.text ? `text=${issue.text}` : '',
    issue.otherTestid ? `other=${issue.otherTestid}` : '',
    issue.otherText ? `otherText=${issue.otherText}` : '',
    issue.value ? `value=${issue.value}` : '',
  ].filter(Boolean).join(' · ');
  return `<tr class="${escapeHtml(issue.severity)}"><td>${escapeHtml(issue.severity)}</td><td>${escapeHtml(issue.type)}</td><td>${escapeHtml(issue.message)}</td><td>${escapeHtml(context)}</td></tr>`;
}

function renderStatsTable(stats) {
  const rows = Object.values(stats).map((row) => `<tr><td>${escapeHtml(row.kind)}</td><td>${row.count}</td><td>${row.minHeight}</td><td>${row.medianHeight}</td><td>${row.maxHeight}</td><td>${row.minWidth}</td><td>${row.medianWidth}</td><td>${row.maxWidth}</td><td>${row.fontSizes.join(', ')}</td></tr>`);
  if (!rows.length) return '<p>No visible controls in this state.</p>';
  return `<table><thead><tr><th>Kind</th><th>Count</th><th>Min H</th><th>Median H</th><th>Max H</th><th>Min W</th><th>Median W</th><th>Max W</th><th>Font px</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderHtmlReport(report) {
  const consistencyRows = report.consistency_issues.length ? report.consistency_issues.map(renderIssue).join('') : '<tr><td colspan="4">No cross-page layout drift.</td></tr>';
  const stateCards = report.runs.map((run) => {
    const hard = run.issues.filter((issue) => issue.severity === 'error').length;
    const warnings = run.issues.filter((issue) => issue.severity === 'warning').length;
    const issueRows = run.issues.length ? run.issues.map(renderIssue).join('') : '<tr><td colspan="4">No hard geometry issues.</td></tr>';
    const screenshot = relativeArtifactPath(run.screenshot_path);
    return `<section class="state-card">
      <header>
        <div>
          <h2>${escapeHtml(run.viewport.name)} / ${escapeHtml(run.state)}</h2>
          <p>${run.viewport.width} x ${run.viewport.height} · ${run.controls.length} controls · ${hard} errors · ${warnings} warnings</p>
        </div>
        <a href="${escapeHtml(screenshot)}">Open Screenshot</a>
      </header>
      <img src="${escapeHtml(screenshot)}" alt="${escapeHtml(`${run.viewport.name} ${run.state}`)} screenshot" loading="lazy">
      <h3>Issues</h3>
      <table><thead><tr><th>Severity</th><th>Type</th><th>Message</th><th>Element</th></tr></thead><tbody>${issueRows}</tbody></table>
      <h3>Control Size Stats</h3>
      ${renderStatsTable(run.control_stats)}
    </section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>UI Geometry Audit</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f5f7fb}
    body{margin:0;padding:24px}
    main{max-width:1440px;margin:0 auto}
    h1{font-size:24px;margin:0 0 8px}
    h2{font-size:18px;margin:0}
    h3{font-size:14px;margin:18px 0 8px;color:#344054}
    p{margin:0;color:#667085}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:18px 0}
    .metric,.state-card{background:white;border:1px solid #d8e0ec;border-radius:8px;box-shadow:0 1px 2px rgba(16,24,40,.05)}
    .metric{padding:14px}
    .metric strong{display:block;font-size:24px}
    .state-card{padding:16px;margin:18px 0}
    .state-card header{display:flex;align-items:center;justify-content:space-between;gap:16px}
    .state-card a{color:#1d4ed8;text-decoration:none;font-weight:650}
    img{display:block;max-width:100%;border:1px solid #d8e0ec;border-radius:6px;margin-top:14px;background:#fff}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border-bottom:1px solid #e5eaf2;text-align:left;padding:7px 8px;vertical-align:top}
    th{color:#475467;background:#f8fafc;font-weight:700}
    tr.error td:first-child{color:#b42318;font-weight:800}
    tr.warning td:first-child{color:#b54708;font-weight:800}
    code{background:#eef2f7;border-radius:4px;padding:2px 5px}
  </style>
</head>
<body>
<main>
  <h1>UI Geometry Audit</h1>
  <p>Generated ${escapeHtml(report.generated_at)}. Hard failures cover visual overlap, horizontal overflow, clipped button text, and undersized controls. Warnings cover tight spacing and inconsistent control metrics.</p>
  <div class="summary">
    <div class="metric"><span>Status</span><strong>${escapeHtml(report.status)}</strong></div>
    <div class="metric"><span>States</span><strong>${report.summary.runs}</strong></div>
    <div class="metric"><span>Errors</span><strong>${report.summary.errors}</strong></div>
    <div class="metric"><span>Warnings</span><strong>${report.summary.warnings}</strong></div>
  </div>
  <p>JSON report: <code>${escapeHtml(relative(reportDir, jsonOutputPath))}</code></p>
  <section class="state-card">
    <header><div><h2>Cross-Page Consistency</h2><p>Repeated shell and workflow landmarks should keep the same geometry across pages in the same viewport.</p></div></header>
    <table><thead><tr><th>Severity</th><th>Type</th><th>Message</th><th>Element</th></tr></thead><tbody>${consistencyRows}</tbody></table>
  </section>
  ${stateCards}
</main>
</body>
</html>`;
}

function makeAuditEvaluator() {
  return () => {
    const CONTROL_SELECTOR = 'button,input,select,textarea,[role="button"],[role="switch"],[role="checkbox"],[role="radio"],[contenteditable="true"]';
    const TEXT_BLOCK_SELECTOR = [
      '.quick-detection-metadata-grid dt',
      '.quick-detection-metadata-grid dd',
      '.quick-detection-grid h3',
      '.quick-detection-grid .helper-copy',
      '.quick-detection-grid .status-line',
      '.classifier-status-grid span',
      '.recording-info-grid dt',
      '.recording-info-grid dd',
      '.annotation-side-stack h3',
      '.annotation-side-stack h4',
      '.annotation-side-stack strong',
      '.annotation-side-stack dt',
      '.annotation-side-stack dd',
      '.annotation-side-stack .helper-copy',
      '.event-review-left-panel h3',
      '.event-review-left-panel h4',
      '.workflow-panel-heading h3',
      '.workspace-tabs h3',
      '.workspace-tabs h4',
      '.status-line',
    ].join(',');
    const SURFACE_SELECTOR = [
      '[data-testid="pyqt-quick_detection_window"]',
      '[data-testid="pyqt-annotation_window"]',
      '[data-testid="pyqt-recording_info_dialog"]',
      '[data-testid="pyqt-status_log_dialog"]',
      '[data-testid="pyqt-load_detection_window"]',
      '[data-testid="pyqt-waveform_shortcuts_window"]',
      '[data-testid="pyqt-channel_selection_window"]',
      '[data-testid="pyqt-bipolar_channel_selection_window"]',
      '[data-testid="pyqt-batch_project_window"]',
      '[data-testid="pyqt-run_stats_dialog"]',
      '[data-testid="agent-panel"]',
      '[data-testid="pyqt-main-window"]',
      '[data-testid="pyqt-tabWidget"]',
      '[data-testid="pyqt-waveform-toolbar"]',
      '[data-testid="pyqt-waveformWiget"]',
    ].join(',');
    const OBSTRUCTION_SELECTOR = [
      '.status-strip',
      '.quick-detection-action-strip',
      '.modal-actions',
      '.shortcut-actions',
      '.annotation-detail-actions',
    ].join(',');
    const SCROLL_CONTAINER_SELECTOR = [
      '.workspace-tab-panel>.tab-content',
      '.quick-detection-dialog>.quick-detection-grid',
      '.event-review-dialog .event-detail-card',
      '.event-review-dialog .annotation-side-stack',
      '.event-review-dialog .event-review-left-panel',
      '.waveform-shortcuts-dialog .shortcut-scroll',
      '.recording-info-raw-card',
      '.batch-project-grid',
      '.waveform-right-sidebar',
    ].join(',');
    const LANDMARKS = [
      ['main-window', '[data-testid="pyqt-main-window"]'],
      ['top-toolbar', '[data-testid="pyqt-toolBar"]'],
      ['workflow-header', '[data-testid="pyqt-workflowHeader"]'],
      ['header-prepare', '[data-testid="pyqt-header_prepare_button"]'],
      ['header-detect', '[data-testid="pyqt-header_detect_button"]'],
      ['header-classify', '[data-testid="pyqt-header_classify_button"]'],
      ['header-info', '[data-testid="pyqt-recording_info_button"]'],
      ['loaded-workspace', '.loaded-workspace'],
      ['workflow-tabs', '[data-testid="pyqt-tabWidget"]'],
      ['workspace-tabs-header', '.workspace-tabs-header'],
      ['prepare-tab', '[data-testid="workflow-tab-prepare"]'],
      ['detect-tab', '[data-testid="workflow-tab-detect"]'],
      ['classify-tab', '[data-testid="workflow-tab-classify"]'],
      ['status-strip', '.status-strip'],
      ['waveform-toolbar', '[data-testid="pyqt-waveform-toolbar"]'],
      ['waveform-widget', '[data-testid="pyqt-waveformWiget"]'],
    ];
    const px = (value) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
    };
    const rounded = (value) => Math.round(value * 100) / 100;
    const textOf = (element) => (element.innerText || element.value || element.getAttribute('aria-label') || element.getAttribute('title') || element.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim();
    const rectIntersection = (a, b) => {
      const x = Math.max(a.x, b.x);
      const y = Math.max(a.y, b.y);
      const right = Math.min(a.right, b.right);
      const bottom = Math.min(a.bottom, b.bottom);
      return { x, y, right, bottom, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
    };
    const clipRectFor = (element, rect) => {
      let clip = { x: 0, y: 0, right: window.innerWidth, bottom: window.innerHeight };
      let parent = element.parentElement;
      while (parent) {
        const style = getComputedStyle(parent);
        const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
        if (/(auto|scroll|hidden|clip)/.test(overflow)) {
          const parentRect = parent.getBoundingClientRect();
          clip = rectIntersection(clip, { x: parentRect.x, y: parentRect.y, right: parentRect.right, bottom: parentRect.bottom });
        }
        parent = parent.parentElement;
      }
      return rectIntersection({ x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }, clip);
    };
    const visibleClipRect = (element) => clipRectFor(element, element.getBoundingClientRect());
    const textContentRect = (element) => {
      const range = document.createRange();
      try {
        range.selectNodeContents(element);
        const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 1 && rect.height > 1);
        if (!rects.length) return null;
        const x = Math.min(...rects.map((rect) => rect.x));
        const y = Math.min(...rects.map((rect) => rect.y));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        return { x, y, right, bottom, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
      } finally {
        range.detach?.();
      }
    };
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01 || element.getAttribute('aria-hidden') === 'true') return false;
      const visibleRect = visibleClipRect(element);
      if (visibleRect.width <= 0 || visibleRect.height <= 0) return false;
      const area = rect.width * rect.height;
      const visibleArea = visibleRect.width * visibleRect.height;
      if (visibleArea < Math.min(16, area * 0.2)) return false;
      const centerX = Math.min(window.innerWidth - 1, Math.max(0, visibleRect.x + visibleRect.width / 2));
      const centerY = Math.min(window.innerHeight - 1, Math.max(0, visibleRect.y + visibleRect.height / 2));
      const topElement = document.elementFromPoint(centerX, centerY);
      return Boolean(topElement && (element === topElement || element.contains(topElement)));
    };
    const isRendered = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01 && element.getAttribute('aria-hidden') !== 'true';
    };
    const kindOf = (element) => {
      const tag = element.tagName.toLowerCase();
      if (tag === 'button' || element.getAttribute('role') === 'button') return 'button';
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textarea';
      if (tag === 'input') return `input:${element.getAttribute('type') || 'text'}`;
      return element.getAttribute('role') || tag;
    };
    const selectorPath = (element) => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 5) {
        const testid = current.getAttribute('data-testid');
        if (testid) {
          parts.unshift(`[data-testid="${testid}"]`);
          break;
        }
        const className = String(current.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        parts.unshift(`${current.tagName.toLowerCase()}${className ? `.${className}` : ''}`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const nearestSurface = (element) => {
      const surface = element.closest(SURFACE_SELECTOR);
      return surface ? surface.getAttribute('data-testid') || surface.className || surface.tagName.toLowerCase() : '';
    };
    const nearestLayoutContainer = (element) => {
      const container = element.closest([
        '.annotation-navigation-row',
        '.annotation-detail-actions',
        '.annotation-select-row',
        '.frequency-controls',
        '.quick-model-row',
        '.quick-classifier-actions',
        '.quick-classifier-param-grid',
        '.quick-detection-action-strip',
        '.quick-filter-grid',
        '.detector-field-grid',
        '.classifier-controls-card',
        '.classifier-stack-grid',
        '.agent-command-toolbar',
        '.button-row',
        '.field-grid',
        '.tab-bar',
        '[data-testid="pyqt-qd_right_rail"]',
        '[data-testid="pyqt-annotation_side_stack"]',
      ].join(','));
      if (!container) return null;
      const rect = container.getBoundingClientRect();
      if (rect.width <= 8 || rect.height <= 8) return null;
      return {
        selector: selectorPath(container),
        testid: container.getAttribute('data-testid') || '',
        className: String(container.className || '').replace(/\s+/g, ' ').trim(),
        rect: {
          x: rounded(rect.x),
          y: rounded(rect.y),
          width: rounded(rect.width),
          height: rounded(rect.height),
          right: rounded(rect.right),
          bottom: rounded(rect.bottom),
        },
      };
    };
    const statKindOf = (control) => {
      if (control.kind !== 'button') return control.kind;
      const text = (control.text || '').trim();
      const squareLike = control.rect.width >= 30 && control.rect.height >= 30 && Math.abs(control.rect.width - control.rect.height) <= 10;
      const iconOnly = !text || text.length <= 2 || squareLike || /\b(icon-only|toolbar-icon|square)\b/i.test(control.className) || /(activity|close|prev|next|pan|zoom|reset|info|snapshot|tool_button)/i.test(control.testid);
      if (iconOnly) return 'button:icon';
      if (/(workflow-tab|header_(prepare|detect|classify)|subpage_back)/i.test(control.testid)) return 'button:workflow-nav';
      if (/(action(Open_EDF|Quick_Detection|Waveform_Shortcuts)|project_|Session|toolBar)/i.test(control.testid) || /pyqt-toolbar|top-toolbar/i.test(control.selector)) return 'button:top-toolbar';
      if (/agent-panel|agent-/i.test(control.surface) || /agent-panel-tab/i.test(control.testid)) return 'button:agent-panel';
      if (/(quick_detection|qd_|quick-|quick_)/i.test(control.testid) || /quick-detection/i.test(control.selector)) return 'button:quick-detection';
      if (/(annotation|PreviousButton|NextButton|Pending|ClearLabel|Accept|Reject|Artifact|Uncertain|Save)/i.test(control.testid) || /annotation/i.test(control.selector)) return 'button:annotation';
      if (/(classifier|overview_|default_cpu|default_gpu|detect_all)/i.test(control.testid) || /classifier/i.test(control.selector)) return 'button:classifier';
      if (/status_log|status/i.test(control.testid) || /status-strip/i.test(control.selector)) return 'button:status';
      return 'button:text';
    };
    const elements = Array.from(document.querySelectorAll(CONTROL_SELECTOR)).filter((element) => isVisible(element) && element.getAttribute('type') !== 'hidden');
    const textElements = Array.from(document.querySelectorAll(TEXT_BLOCK_SELECTOR)).filter((element) => isVisible(element));
    const obstructionElements = Array.from(document.querySelectorAll(OBSTRUCTION_SELECTOR)).filter((element) => isVisible(element));
    const scrollContainerElements = Array.from(document.querySelectorAll(SCROLL_CONTAINER_SELECTOR)).filter((element) => isRendered(element));
    const landmarks = {};
    for (const [key, selector] of LANDMARKS) {
      const element = document.querySelector(selector);
      if (!element || !isVisible(element)) continue;
      const rect = element.getBoundingClientRect();
      landmarks[key] = {
        key,
        selector,
        testid: element.getAttribute('data-testid') || '',
        text: textOf(element).slice(0, 120),
        rect: {
          x: rounded(rect.x),
          y: rounded(rect.y),
          width: rounded(rect.width),
          height: rounded(rect.height),
          right: rounded(rect.right),
          bottom: rounded(rect.bottom),
        },
      };
    }
    const controls = elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const visibleRect = visibleClipRect(element);
      const style = getComputedStyle(element);
      const kind = kindOf(element);
      const text = textOf(element);
      const className = String(element.className || '').replace(/\s+/g, ' ').trim();
      const container = nearestLayoutContainer(element);
      return {
        index,
        kind,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        testid: element.getAttribute('data-testid') || '',
        id: element.id || '',
        className,
        text,
        selector: selectorPath(element),
        surface: nearestSurface(element),
        container,
        disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true',
        rect: {
          x: rounded(rect.x),
          y: rounded(rect.y),
          width: rounded(rect.width),
          height: rounded(rect.height),
          right: rounded(rect.right),
          bottom: rounded(rect.bottom),
        },
        visibleRect: {
          x: rounded(visibleRect.x),
          y: rounded(visibleRect.y),
          width: rounded(visibleRect.width),
          height: rounded(visibleRect.height),
          right: rounded(visibleRect.right),
          bottom: rounded(visibleRect.bottom),
        },
        metrics: {
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          fontSize: px(style.fontSize),
          lineHeight: px(style.lineHeight),
          paddingLeft: px(style.paddingLeft),
          paddingRight: px(style.paddingRight),
          paddingTop: px(style.paddingTop),
          paddingBottom: px(style.paddingBottom),
        },
      };
    });
    const textBlocks = textElements.map((element, index) => {
      const rect = textContentRect(element) || element.getBoundingClientRect();
      const visibleRect = clipRectFor(element, rect);
      const style = getComputedStyle(element);
      const container = nearestLayoutContainer(element);
      return {
        index,
        kind: 'text',
        tag: element.tagName.toLowerCase(),
        testid: element.getAttribute('data-testid') || '',
        className: String(element.className || '').replace(/\s+/g, ' ').trim(),
        text: textOf(element).slice(0, 160),
        selector: selectorPath(element),
        surface: nearestSurface(element),
        container,
        rect: {
          x: rounded(rect.x),
          y: rounded(rect.y),
          width: rounded(rect.width),
          height: rounded(rect.height),
          right: rounded(rect.right),
          bottom: rounded(rect.bottom),
        },
        visibleRect: {
          x: rounded(visibleRect.x),
          y: rounded(visibleRect.y),
          width: rounded(visibleRect.width),
          height: rounded(visibleRect.height),
          right: rounded(visibleRect.right),
          bottom: rounded(visibleRect.bottom),
        },
        metrics: {
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
          fontSize: px(style.fontSize),
          lineHeight: px(style.lineHeight),
        },
      };
    }).filter((block) => block.text && block.visibleRect.width > 2 && block.visibleRect.height > 2);
    const obstructions = obstructionElements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        testid: element.getAttribute('data-testid') || '',
        className: String(element.className || '').replace(/\s+/g, ' ').trim(),
        text: textOf(element).slice(0, 120),
        selector: selectorPath(element),
        rect: {
          x: rounded(rect.x),
          y: rounded(rect.y),
          width: rounded(rect.width),
          height: rounded(rect.height),
          right: rounded(rect.right),
          bottom: rounded(rect.bottom),
        },
      };
    });
    const scrollContainers = scrollContainerElements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        index,
        testid: element.getAttribute('data-testid') || '',
        className: String(element.className || '').replace(/\s+/g, ' ').trim(),
        selector: selectorPath(element),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        paddingBottom: px(style.paddingBottom),
        scrollPaddingBottom: px(style.scrollPaddingBottom),
        overflowY: style.overflowY,
        rect: {
          x: rounded(rect.x),
          y: rounded(rect.y),
          width: rounded(rect.width),
          height: rounded(rect.height),
          right: rounded(rect.right),
          bottom: rounded(rect.bottom),
        },
      };
    });

    const issues = [];
    const add = (severity, type, message, control, extra = {}) => issues.push({
      severity,
      type,
      message,
      testid: control?.testid || '',
      text: control?.text || '',
      selector: control?.selector || '',
      rect: control?.rect || null,
      ...extra,
    });
    const CLASSIFIER_ACTION_BUTTON_LIMITS = {
      maxWidth: 128,
      maxHeight: 38,
      testids: new Set(['pyqt-classifier_run_button', 'pyqt-default_cpu_button', 'pyqt-default_gpu_button', 'pyqt-classifier_save_button']),
    };
    const WORKFLOW_FIELD_WIDTH_LIMITS = [
      { testid: 'pyqt-detector_mode_combo', maxWidth: 360 },
      { testid: 'pyqt-classifier_mode_combo', maxWidth: 320 },
      { testid: 'pyqt-overview_ignore_before_input', maxWidth: 180 },
      { testid: 'pyqt-overview_ignore_after_input', maxWidth: 180 },
    ];

    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const documentOverflowX = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0) - viewport.width;
    if (documentOverflowX > 2) {
      issues.push({
        severity: 'error',
        type: 'document-overflow-x',
        message: `Document is ${Math.round(documentOverflowX)}px wider than the viewport`,
        value: Math.round(documentOverflowX),
      });
    }

    for (const control of controls) {
      const width = control.rect.width;
      const height = control.rect.height;
      if (control.kind === 'button') {
        const squareLike = width >= 30 && height >= 30 && Math.abs(width - height) <= 10;
        const iconLike = !control.text || control.text.length <= 2 || squareLike || /\b(icon-only|toolbar-icon|square)\b/i.test(control.className) || /(activity|tool_button|toolbar|close|prev|next|pan|zoom|reset|info)/i.test(control.testid);
        const minWidth = iconLike ? 30 : 44;
        if (height < 30) add('error', 'too-small-control', `Button height ${height}px is below 30px`, control);
        if (width < minWidth) add('error', 'too-small-control', `Button width ${width}px is below ${minWidth}px`, control);
        if (CLASSIFIER_ACTION_BUTTON_LIMITS.testids.has(control.testid) && (width > CLASSIFIER_ACTION_BUTTON_LIMITS.maxWidth || height > CLASSIFIER_ACTION_BUTTON_LIMITS.maxHeight)) {
          add('error', 'oversized-classifier-action-button', `Classifier action button is ${width}x${height}px; limit is ${CLASSIFIER_ACTION_BUTTON_LIMITS.maxWidth}x${CLASSIFIER_ACTION_BUTTON_LIMITS.maxHeight}px`, control);
        }
        if (control.metrics.scrollWidth > control.metrics.clientWidth + 2 || control.metrics.scrollHeight > control.metrics.clientHeight + 2) {
          add('error', 'button-text-overflow', 'Button text is clipped inside its visual box', control, {
            value: `${control.metrics.clientWidth}x${control.metrics.clientHeight} client, ${control.metrics.scrollWidth}x${control.metrics.scrollHeight} scroll`,
          });
        }
      } else if (control.kind === 'select') {
        if (height < 32) add('error', 'too-small-control', `Select height ${height}px is below 32px`, control);
        if (width < 72) add('warning', 'narrow-field', `Select width ${width}px is narrow`, control);
      } else if (control.kind === 'textarea') {
        if (height < 40) add('error', 'too-small-control', `Textarea height ${height}px is below 40px`, control);
      } else if (control.kind.startsWith('input:checkbox') || control.kind.startsWith('input:radio')) {
        if (height < 14 || width < 14) add('error', 'too-small-control', `Choice control ${width}x${height}px is below 14px`, control);
      } else if (control.kind.startsWith('input:range')) {
        const verticalRange = height > width * 3;
        if (verticalRange) {
          if (width < 30 || height < 80) add('warning', 'small-range', `Vertical range input ${width}x${height}px is compact`, control);
        } else if (height < 16 || width < 80) {
          add('warning', 'small-range', `Range input ${width}x${height}px is compact`, control);
        }
      } else if (control.kind.startsWith('input:')) {
        if (height < 32) add('error', 'too-small-control', `Input height ${height}px is below 32px`, control);
        if (width < 48) add('warning', 'narrow-field', `Input width ${width}px is narrow`, control);
      }
      const fieldWidthLimit = WORKFLOW_FIELD_WIDTH_LIMITS.find((limit) => limit.testid === control.testid);
      if (fieldWidthLimit && width > fieldWidthLimit.maxWidth) {
        add('error', 'oversized-workflow-field', `Workflow field width ${width}px exceeds ${fieldWidthLimit.maxWidth}px`, control);
      }
      const horizontallyVisible = control.visibleRect.bottom > 0 && control.visibleRect.y < viewport.height;
      if (horizontallyVisible && (control.visibleRect.x < -2 || control.visibleRect.right > viewport.width + 2)) {
        add('error', 'control-overflow-x', 'Control extends horizontally outside the viewport', control);
      }
      const intersectsViewport = control.rect.right > 0 && control.rect.x < viewport.width && control.rect.bottom > 0 && control.rect.y < viewport.height;
      if (intersectsViewport) {
        const clippedWidth = control.visibleRect.width < control.rect.width - 2;
        const clippedHeight = control.visibleRect.height < control.rect.height - 2;
        if (clippedWidth || clippedHeight) {
          add('error', 'clipped-control', 'Control is partially clipped by a viewport or scroll-container boundary', control, {
            value: `${control.visibleRect.width}x${control.visibleRect.height}px visible of ${control.rect.width}x${control.rect.height}px`,
          });
        }
      }
      if (control.container && control.visibleRect.bottom > 0 && control.visibleRect.y < viewport.height) {
        const containerRect = control.container.rect;
        const overflowLeft = control.rect.x < containerRect.x - 2;
        const overflowRight = control.rect.right > containerRect.right + 2;
        if (overflowLeft || overflowRight) {
          add('error', 'layout-container-overflow-x', 'Control extends horizontally outside its layout container', control, {
            container: control.container.testid || control.container.className || control.container.selector,
            containerRect,
          });
        }
      }
      const isTextualControl = control.kind === 'button' || control.kind === 'select' || control.kind === 'textarea';
      if (!isTextualControl && control.metrics.scrollWidth > control.metrics.clientWidth + 3 && control.kind.startsWith('input:')) {
        add('warning', 'input-scroll-overflow', 'Input value is wider than the visible field', control, {
          value: `${control.metrics.clientWidth}px client, ${control.metrics.scrollWidth}px scroll`,
        });
      }
    }

    for (const obstruction of obstructions) {
      for (const control of controls) {
        const controlElement = elements[control.index];
        const obstructionElement = obstructionElements[obstruction.index];
        if (!controlElement || !obstructionElement || obstructionElement.contains(controlElement) || controlElement.contains(obstructionElement)) continue;
        const intersection = rectIntersection(control.visibleRect || control.rect, obstruction.rect);
        if (intersection.width <= 2 || intersection.height <= 2) continue;
        const controlArea = Math.max(1, (control.visibleRect.width || control.rect.width) * (control.visibleRect.height || control.rect.height));
        const ratio = (intersection.width * intersection.height) / controlArea;
        if (ratio > 0.12 || intersection.height > 8) {
          add('error', 'bottom-obstruction-overlap', 'Visible control intersects a status, footer, or sticky action area', control, {
            otherTestid: obstruction.testid,
            otherText: obstruction.text,
            otherSelector: obstruction.selector,
            overlapRatio: rounded(ratio),
          });
        }
      }
      for (const block of textBlocks) {
        const textElement = textElements[block.index];
        const obstructionElement = obstructionElements[obstruction.index];
        if (!textElement || !obstructionElement || obstructionElement.contains(textElement) || textElement.contains(obstructionElement)) continue;
        const intersection = rectIntersection(block.visibleRect || block.rect, obstruction.rect);
        if (intersection.width <= 2 || intersection.height <= 2) continue;
        const textArea = Math.max(1, (block.visibleRect.width || block.rect.width) * (block.visibleRect.height || block.rect.height));
        const ratio = (intersection.width * intersection.height) / textArea;
        if (ratio > 0.16 || intersection.height > 8) {
          add('error', 'bottom-obstruction-overlap', 'Visible text intersects a status, footer, or sticky action area', block, {
            otherTestid: obstruction.testid,
            otherText: obstruction.text,
            otherSelector: obstruction.selector,
            overlapRatio: rounded(ratio),
          });
        }
      }
    }

    for (const container of scrollContainers) {
      const scrollsVertically = /(auto|scroll)/.test(container.overflowY) && container.scrollHeight > container.clientHeight + 4;
      if (!scrollsVertically) continue;
      const clearance = container.paddingBottom + container.scrollPaddingBottom;
      if (clearance < 12) {
        issues.push({
          severity: 'error',
          type: 'scroll-container-bottom-clearance',
          message: 'Scrollable UI region does not reserve enough bottom clearance for final controls/content',
          testid: container.testid,
          text: '',
          selector: container.selector,
          rect: container.rect,
          value: `${clearance}px clearance; ${container.clientHeight}px client, ${container.scrollHeight}px scroll`,
        });
      }
    }

    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        const a = controls[i];
        const b = controls[j];
        if (elements[i].contains(elements[j]) || elements[j].contains(elements[i])) continue;
        const aRect = a.visibleRect || a.rect;
        const bRect = b.visibleRect || b.rect;
        const x = Math.max(0, Math.min(aRect.right, bRect.right) - Math.max(aRect.x, bRect.x));
        const y = Math.max(0, Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.y, bRect.y));
        if (x <= 3 || y <= 3) continue;
        const overlapArea = x * y;
        const minArea = Math.min(aRect.width * aRect.height, bRect.width * bRect.height);
        const ratio = minArea > 0 ? overlapArea / minArea : 0;
        if (ratio > 0.2 || (x > 10 && y > 10)) {
          add('error', 'visual-overlap', `Controls overlap by ${Math.round(x)}x${Math.round(y)}px`, a, {
            otherTestid: b.testid,
            otherText: b.text,
            otherSelector: b.selector,
            overlapRatio: rounded(ratio),
          });
        }
      }
    }

    for (let i = 0; i < textBlocks.length; i += 1) {
      for (let j = i + 1; j < textBlocks.length; j += 1) {
        const a = textBlocks[i];
        const b = textBlocks[j];
        if (textElements[i].contains(textElements[j]) || textElements[j].contains(textElements[i])) continue;
        const sameContainer = a.container && b.container && (a.container.testid || a.container.selector) === (b.container.testid || b.container.selector);
        if (sameContainer) continue;
        const aRect = a.visibleRect || a.rect;
        const bRect = b.visibleRect || b.rect;
        const x = Math.max(0, Math.min(aRect.right, bRect.right) - Math.max(aRect.x, bRect.x));
        const y = Math.max(0, Math.min(aRect.bottom, bRect.bottom) - Math.max(aRect.y, bRect.y));
        if (x <= 4 || y <= 4) continue;
        const overlapArea = x * y;
        const minArea = Math.min(aRect.width * aRect.height, bRect.width * bRect.height);
        const ratio = minArea > 0 ? overlapArea / minArea : 0;
        if (ratio > 0.18 || (x > 10 && y > 8)) {
          add('error', 'text-overlap', `Text blocks overlap by ${Math.round(x)}x${Math.round(y)}px`, a, {
            otherTestid: b.testid,
            otherText: b.text,
            otherSelector: b.selector,
            overlapRatio: rounded(ratio),
          });
        }
      }
    }

    const rowBuckets = new Map();
    for (const control of controls) {
      if (control.rect.bottom < 0 || control.rect.y > viewport.height) continue;
      const key = `${control.surface}|${Math.round((control.rect.y + control.rect.height / 2) / 8)}`;
      const row = rowBuckets.get(key) || [];
      row.push(control);
      rowBuckets.set(key, row);
    }
    for (const row of rowBuckets.values()) {
      row.sort((a, b) => a.rect.x - b.rect.x);
      for (let i = 1; i < row.length; i += 1) {
        const gap = row[i].rect.x - row[i - 1].rect.right;
        if (gap >= 0 && gap < 4) {
          add('warning', 'tight-control-gap', `Adjacent controls have only ${rounded(gap)}px horizontal gap`, row[i - 1], {
            otherTestid: row[i].testid,
            otherText: row[i].text,
          });
        }
      }
    }

    const alignmentGroups = [];
    const alignmentSpecs = [
      { name: 'quick metadata values', selector: '.quick-detection-metadata-grid', itemSelector: 'dd', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'quick filter inputs', selector: '.quick-detection-filter-card .quick-filter-grid', itemSelector: 'input,select', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'quick detector inputs', selector: '.quick-detector-panel .detector-field-grid', itemSelector: 'input,select', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'quick model rows', selector: '.quick-model-row', itemSelector: 'input,button', height: true, heightTolerance: 2 },
      { name: 'quick classifier params', selector: '.quick-classifier-param-grid', itemSelector: 'input:not([type="checkbox"]):not([type="radio"]),select', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'quick classifier actions', selector: '.quick-classifier-actions', itemSelector: 'button,.quick-classifier-toggle', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'quick action strip', selector: '.quick-detection-action-strip', itemSelector: 'button', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'annotation navigation rows', selector: '.annotation-navigation-row', itemSelector: 'button', rowScoped: true, width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'annotation frequency controls', selector: '[data-testid="pyqt-frequency_range_group"]', itemSelector: 'input,button', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'classifier action buttons', selector: '.classifier-controls-card .button-row', itemSelector: 'button', width: true, height: true, widthTolerance: 3, heightTolerance: 2 },
      { name: 'classifier parameter fields', selector: '.classifier-control-grid,.classifier-stack-grid', itemSelector: 'input:not([type="checkbox"]):not([type="radio"]),select', height: true, heightTolerance: 2 },
    ];
    const pushMetricDrift = (type, message, rows, values, tolerance, specName) => {
      const first = rows[0];
      add('error', type, message, first, {
        value: `${Math.min(...values)}px to ${Math.max(...values)}px (tolerance ${tolerance}px)`,
        alignmentGroup: specName,
        otherText: rows.slice(1).map((row) => row.text || row.selector).join(' | '),
      });
    };
    for (const spec of alignmentSpecs) {
      for (const container of Array.from(document.querySelectorAll(spec.selector)).filter((element) => isVisible(element))) {
        const items = Array.from(container.querySelectorAll(spec.itemSelector)).filter((element) => isVisible(element));
        const buckets = new Map();
        for (const element of items) {
          const rect = element.getBoundingClientRect();
          const key = spec.rowScoped ? String(Math.round((rect.y + rect.height / 2) / 8)) : 'all';
          const row = buckets.get(key) || [];
          row.push(element);
          buckets.set(key, row);
        }
        for (const elementsInBucket of buckets.values()) {
          if (elementsInBucket.length < 2) continue;
          const rows = elementsInBucket.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              testid: element.getAttribute('data-testid') || '',
              text: textOf(element),
              selector: selectorPath(element),
              rect: {
                x: rounded(rect.x),
                y: rounded(rect.y),
                width: rounded(rect.width),
                height: rounded(rect.height),
                right: rounded(rect.right),
                bottom: rounded(rect.bottom),
              },
            };
          });
          alignmentGroups.push({
            name: spec.name,
            selector: selectorPath(container),
            rows,
          });
          if (spec.height) {
            const heights = rows.map((row) => row.rect.height);
            const heightDrift = Math.max(...heights) - Math.min(...heights);
            if (heightDrift > spec.heightTolerance) {
              pushMetricDrift('control-height-drift', `${spec.name} controls differ in height by ${rounded(heightDrift)}px`, rows, heights, spec.heightTolerance, spec.name);
            }
          }
          if (spec.width) {
            const widths = rows.map((row) => row.rect.width);
            const widthDrift = Math.max(...widths) - Math.min(...widths);
            if (widthDrift > spec.widthTolerance) {
              pushMetricDrift('control-width-drift', `${spec.name} controls differ in width by ${rounded(widthDrift)}px`, rows, widths, spec.widthTolerance, spec.name);
            }
          }
        }
      }
    }

    const grouped = controls.reduce((acc, control) => {
      const key = statKindOf(control);
      if (!acc[key]) acc[key] = [];
      acc[key].push(control);
      return acc;
    }, {});
    const percentile = (values, p) => {
      if (!values.length) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
      return rounded(sorted[index]);
    };
    const controlStats = {};
    for (const [kind, rows] of Object.entries(grouped)) {
      const heights = rows.map((row) => row.rect.height);
      const widths = rows.map((row) => row.rect.width);
      const fontSizes = Array.from(new Set(rows.map((row) => row.metrics.fontSize).filter(Boolean))).sort((a, b) => a - b);
      controlStats[kind] = {
        kind,
        count: rows.length,
        minHeight: percentile(heights, 0),
        p10Height: percentile(heights, 0.1),
        medianHeight: percentile(heights, 0.5),
        p90Height: percentile(heights, 0.9),
        maxHeight: percentile(heights, 1),
        minWidth: percentile(widths, 0),
        medianWidth: percentile(widths, 0.5),
        maxWidth: percentile(widths, 1),
        fontSizes,
      };
      const heightSpread = controlStats[kind].p90Height - controlStats[kind].p10Height;
      const spreadLimit = kind.startsWith('button:') ? 10 : 10;
      if (rows.length >= 4 && heightSpread > spreadLimit) {
        issues.push({
          severity: 'warning',
          type: 'height-inconsistency',
          message: `${kind} p10-p90 height spread is ${rounded(heightSpread)}px`,
          value: `${controlStats[kind].p10Height}px to ${controlStats[kind].p90Height}px`,
        });
      }
      if (kind !== 'button:icon' && fontSizes.length > 2) {
        issues.push({
          severity: 'warning',
          type: 'font-size-inconsistency',
          message: `${kind} uses ${fontSizes.length} different font sizes`,
          value: fontSizes.join(', '),
        });
      }
    }

    return {
      viewport,
      document: {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        overflowX: rounded(documentOverflowX),
      },
      controls,
      text_blocks: textBlocks,
      obstructions,
      scroll_containers: scrollContainers,
      alignment_groups: alignmentGroups,
      landmarks,
      control_stats: controlStats,
      issues,
    };
  };
}

function auditLayoutConsistency(runs) {
  const primaryWorkflowStates = ['prepare-subpage', 'detect-subpage', 'classify-subpage'];
  const subpageStates = ['prepare-subpage', 'detect-subpage', 'classify-subpage'];
  const specs = [
    { group: 'primary workflow shell', key: 'main-window', states: primaryWorkflowStates, fields: ['x', 'y', 'width', 'height'], tolerance: 2, severity: 'error' },
    { group: 'primary workflow shell', key: 'top-toolbar', states: primaryWorkflowStates, fields: ['x', 'y', 'width', 'height'], tolerance: 2, severity: 'error' },
    { group: 'primary workflow shell', key: 'workflow-header', states: primaryWorkflowStates, fields: ['x', 'y', 'width', 'height'], tolerance: 2, severity: 'error' },
    { group: 'primary workflow shell', key: 'header-prepare', states: primaryWorkflowStates, fields: ['x', 'y', 'width', 'height'], tolerance: 2, severity: 'error' },
    { group: 'primary workflow shell', key: 'header-detect', states: primaryWorkflowStates, fields: ['x', 'y', 'width', 'height'], tolerance: 2, severity: 'error' },
    { group: 'primary workflow shell', key: 'header-classify', states: primaryWorkflowStates, fields: ['x', 'y', 'width', 'height'], tolerance: 2, severity: 'error' },
    { group: 'primary workflow shell', key: 'loaded-workspace', states: primaryWorkflowStates, fields: ['x', 'y', 'width'], tolerance: 3, severity: 'error' },
    { group: 'workflow subpages', key: 'workflow-tabs', states: subpageStates, fields: ['x', 'y', 'width', 'height'], tolerance: 3, severity: 'error' },
    { group: 'workflow subpages', key: 'workspace-tabs-header', states: subpageStates, fields: ['x', 'y', 'width', 'height'], tolerance: 3, severity: 'error' },
    { group: 'workflow subpages', key: 'prepare-tab', states: subpageStates, fields: ['x', 'y', 'width', 'height'], tolerance: 3, severity: 'error' },
    { group: 'workflow subpages', key: 'detect-tab', states: subpageStates, fields: ['x', 'y', 'width', 'height'], tolerance: 3, severity: 'error' },
    { group: 'workflow subpages', key: 'classify-tab', states: subpageStates, fields: ['x', 'y', 'width', 'height'], tolerance: 3, severity: 'error' },
  ];
  const issues = [];
  const byViewport = new Map();
  for (const run of runs) {
    const bucket = byViewport.get(run.viewport.name) || [];
    bucket.push(run);
    byViewport.set(run.viewport.name, bucket);
  }
  for (const [viewportName, viewportRuns] of byViewport.entries()) {
    const runByState = new Map(viewportRuns.map((run) => [run.state, run]));
    for (const spec of specs) {
      const present = spec.states.map((state) => ({ state, run: runByState.get(state) })).filter((entry) => entry.run?.landmarks?.[spec.key]);
      if (present.length < 2) continue;
      const baseline = present[0];
      const baselineRect = baseline.run.landmarks[spec.key].rect;
      for (const candidate of present.slice(1)) {
        const rect = candidate.run.landmarks[spec.key].rect;
        const drifts = spec.fields.map((field) => ({ field, value: Math.round(Math.abs(rect[field] - baselineRect[field]) * 100) / 100 })).filter((drift) => drift.value > spec.tolerance);
        if (!drifts.length) continue;
        issues.push({
          severity: spec.severity,
          type: 'cross-page-layout-drift',
          message: `${spec.group} landmark "${spec.key}" drifted in ${candidate.state} vs ${baseline.state}: ${drifts.map((drift) => `${drift.field} ${drift.value}px`).join(', ')}`,
          viewport: viewportName,
          state: 'cross-page',
          testid: candidate.run.landmarks[spec.key].testid,
          text: candidate.run.landmarks[spec.key].text,
          selector: candidate.run.landmarks[spec.key].selector,
          value: `${candidate.state} vs ${baseline.state}`,
          baseline: { state: baseline.state, rect: baselineRect },
          candidate: { state: candidate.state, rect },
        });
      }
    }
  }
  return issues;
}

async function auditRun(page, fixtureUrl, viewport, state) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await setState(page, fixtureUrl, state);
  const audit = await page.evaluate(makeAuditEvaluator());
  const screenshotPath = join(screenshotsDir, `${viewport.name}-${state}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return {
    ...audit,
    viewport,
    measured_viewport: audit.viewport,
    state,
    screenshot_path: screenshotPath,
  };
}

async function main() {
  rmSync(screenshotsDir, { recursive: true, force: true });
  mkdirSync(screenshotsDir, { recursive: true });
  const externalUrl = process.env.UI_GEOMETRY_URL || process.env.PYHFO_UI_GEOMETRY_URL || '';
  const port = Number(process.env.UI_GEOMETRY_PORT || await getFreePort());
  const baseUrl = externalUrl ? externalUrl : `http://127.0.0.1:${port}/`;
  const fixtureUrl = withVisualFixture(baseUrl);
  const viewports = parseViewports();
  let vite;
  let browser;
  try {
    if (!externalUrl) {
      vite = startVite(port);
      await waitForServer(fixtureUrl);
    }
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    const runs = [];
    for (const viewport of viewports) {
      for (const state of STATES) {
        runs.push(await auditRun(page, fixtureUrl, viewport, state));
      }
    }
    const consistencyIssues = auditLayoutConsistency(runs);
    const allIssues = [
      ...runs.flatMap((run) => run.issues.map((issue) => ({ ...issue, viewport: run.viewport.name, state: run.state }))),
      ...consistencyIssues,
    ];
    const errors = allIssues.filter((issue) => issue.severity === 'error');
    const warnings = allIssues.filter((issue) => issue.severity === 'warning');
    const report = {
      generated_at: new Date().toISOString(),
      status: errors.length ? 'failed' : 'passed',
      fixture_url: fixtureUrl,
      viewports,
      states: STATES,
      summary: {
        runs: runs.length,
        states: STATES.length,
        viewports: viewports.length,
        controls: runs.reduce((sum, run) => sum + run.controls.length, 0),
        errors: errors.length,
        warnings: warnings.length,
        consistency_errors: consistencyIssues.filter((issue) => issue.severity === 'error').length,
        consistency_warnings: consistencyIssues.filter((issue) => issue.severity === 'warning').length,
      },
      issues: allIssues,
      consistency_issues: consistencyIssues,
      runs,
      outputs: {
        json: jsonOutputPath,
        html: htmlOutputPath,
        screenshots_dir: screenshotsDir,
      },
    };
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(htmlOutputPath, renderHtmlReport(report));
    const relativeHtml = relative(desktopRoot, htmlOutputPath);
    const relativeJson = relative(desktopRoot, jsonOutputPath);
    console.log(`UI geometry audit ${report.status}: ${runs.length} state/viewport runs, ${errors.length} error(s), ${warnings.length} warning(s).`);
    console.log(`HTML report: ${relativeHtml}`);
    console.log(`JSON report: ${relativeJson}`);
    if (errors.length) {
      for (const issue of errors.slice(0, 20)) console.error(`- [${issue.viewport}/${issue.state}] ${issue.type}: ${issue.message} ${issue.testid || issue.text || ''}`);
      process.exitCode = 1;
    }
  } finally {
    if (browser) await browser.close();
    if (vite) vite.child.kill();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
