#!/usr/bin/env node
// Interactive overlay-overlap audit.
//
// The static UI audits (ui-geometry-audit, ui-alignment-audit) render every
// surface in its default state, so they never open the waveform toolbar
// popovers. Those popovers only overlap other controls WHEN OPEN, and because
// the toolbar reflows by width the breakage is viewport-dependent. This audit
// opens each popover across viewports and fails if it leaves the viewport or
// covers an interactive control.
//
// Contract per waveform-toolbar popover: when open it must be fully on-screen
// AND must not cover any interactive control (button/input/select/role=button)
// outside itself. Dropping over the non-interactive waveform area is fine.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const artifactsRoot = join(desktopRoot, 'artifacts');
const reportDir = join(artifactsRoot, 'ui-interaction-overlap-audit');
const screenshotsDir = join(reportDir, 'screenshots');
const jsonOutputPath = join(artifactsRoot, 'ui-interaction-overlap-audit.json');

const MIN_VIEWPORT_WIDTH = 1440;
const MIN_VIEWPORT_HEIGHT = 860;
const DEFAULT_VIEWPORTS = [
  { name: 'minimum-main', width: 1440, height: 860 },
  { name: 'compact', width: 1440, height: 900 },
  { name: 'desktop', width: 1512, height: 982 },
];

// Each overlay: a trigger to click and the panel it opens. All are toolbar
// popovers that should drop below the toolbar over the waveform, covering
// nothing. (The top-toolbar Settings menu is intentionally excluded: a menu
// covering the content below it is normal behavior.)
const OVERLAYS = [
  { name: 'channel-scope', trigger: 'pyqt-channel_scope_summary_button' },
  { name: 'montage', trigger: 'pyqt-montage_summary_button' },
  { name: 'focus', trigger: 'pyqt-focus_summary_button' },
  { name: 'output-more', trigger: 'pyqt-output_more_button' },
  { name: 'view-settings', trigger: 'pyqt-waveform_view_summary_button' },
];

function parseViewports() {
  const raw = process.env.UI_OVERLAY_VIEWPORTS || '';
  if (!raw.trim()) return DEFAULT_VIEWPORTS;
  return raw.split(',').map((entry) => {
    const [namePart, sizePart] = entry.includes(':') ? entry.split(':', 2) : ['', entry];
    const [width, height] = sizePart.split('x').map((v) => Number(v.trim()));
    if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error(`Invalid UI_OVERLAY_VIEWPORTS entry: ${entry}`);
    if (width < MIN_VIEWPORT_WIDTH || height < MIN_VIEWPORT_HEIGHT) throw new Error(`UI_OVERLAY_VIEWPORTS entry below Electron minimum (${MIN_VIEWPORT_WIDTH}x${MIN_VIEWPORT_HEIGHT}): ${entry}`);
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

async function gotoWaveform(page, fixtureUrl) {
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 10000 });
  await page.waitForTimeout(180);
  const toolbarVisible = await page.locator('[data-testid="pyqt-waveform-toolbar"]').first().isVisible().catch(() => false);
  if (!toolbarVisible) {
    await page.locator('[data-testid="pyqt-subpage_back_to_main_button"]').evaluateAll((nodes) => {
      const target = nodes.find((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.disabled;
      });
      if (target) target.click();
    }).catch(() => {});
  }
  await page.waitForSelector('[data-testid="pyqt-waveform-toolbar"]', { timeout: 7000 });
  await page.waitForTimeout(220);
}

function makeOverlayEvaluator() {
  return () => {
    const PANEL_SELECTOR = '.waveform-view-settings-popover,.clinical-selector-popover';
    const CONTROL_SELECTOR = 'button,input:not([type="hidden"]),select,textarea,[role="button"]';
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
    };
    let panel = null;
    for (const el of document.querySelectorAll(PANEL_SELECTOR)) {
      if (visible(el)) { panel = el; break; }
    }
    if (!panel) return { panelFound: false };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pr = panel.getBoundingClientRect();
    const round = (n) => Math.round(n * 100) / 100;
    const rect = { x: round(pr.x), y: round(pr.y), width: round(pr.width), height: round(pr.height), right: round(pr.right), bottom: round(pr.bottom) };
    const offscreen = {
      left: Math.max(0, Math.round(-pr.x)),
      top: Math.max(0, Math.round(-pr.y)),
      right: Math.max(0, Math.round(pr.right - vw)),
      bottom: Math.max(0, Math.round(pr.bottom - vh)),
    };
    const offscreenAny = pr.x < -1 || pr.y < -1 || pr.right > vw + 1 || pr.bottom > vh + 1;
    const covered = [];
    for (const control of document.querySelectorAll(CONTROL_SELECTOR)) {
      if (panel.contains(control) || control.contains(panel) || !visible(control)) continue;
      const cr = control.getBoundingClientRect();
      if (cr.bottom < 0 || cr.top > vh || cr.right < 0 || cr.left > vw) continue;
      const cx = Math.min(vw - 1, Math.max(0, cr.x + cr.width / 2));
      const cy = Math.min(vh - 1, Math.max(0, cr.y + cr.height / 2));
      const hit = document.elementFromPoint(cx, cy);
      if (hit && panel.contains(hit)) {
        covered.push({
          testid: control.getAttribute('data-testid') || '',
          text: (control.innerText || control.value || control.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 24),
          tag: control.tagName.toLowerCase(),
        });
      }
    }
    return {
      panelFound: true,
      panelClass: String(panel.className || '').split(/\s+/).filter((c) => /popover/.test(c)).join(' '),
      rect,
      offscreenAny,
      offscreen,
      coveredControls: covered,
    };
  };
}

async function auditOverlay(browser, fixtureUrl, viewport, overlay) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
  const issues = [];
  let audit = { panelFound: false };
  try {
    await gotoWaveform(page, fixtureUrl);
    const trigger = page.locator(`[data-testid="${overlay.trigger}"]`);
    if (!(await trigger.count())) {
      issues.push({ severity: 'warning', type: 'trigger-missing', message: `Trigger ${overlay.trigger} not found` });
    } else {
      await trigger.first().evaluate((el) => el.click()).catch(() => {});
      await page.waitForTimeout(320);
      audit = await page.evaluate(makeOverlayEvaluator());
      const screenshotPath = join(screenshotsDir, `${viewport.name}-${overlay.name}.png`);
      await page.screenshot({ path: screenshotPath });
      audit.screenshot_path = screenshotPath;
      if (!audit.panelFound) {
        issues.push({ severity: 'warning', type: 'panel-not-open', message: `${overlay.name} did not open a panel on click` });
      } else {
        if (audit.offscreenAny) {
          const dirs = Object.entries(audit.offscreen).filter(([, v]) => v > 1).map(([k, v]) => `${k} ${v}px`).join(', ');
          issues.push({ severity: 'error', type: 'overlay-offscreen', message: `${overlay.name} popover leaves the viewport (${dirs})`, value: dirs });
        }
        if (audit.coveredControls.length) {
          issues.push({
            severity: 'error',
            type: 'overlay-covers-control',
            message: `${overlay.name} popover covers ${audit.coveredControls.length} interactive control(s): ${audit.coveredControls.map((c) => c.testid || c.text || c.tag).join(', ')}`,
            covered: audit.coveredControls,
          });
        }
      }
    }
  } catch (error) {
    issues.push({ severity: 'error', type: 'audit-error', message: String(error instanceof Error ? error.message : error).slice(0, 160) });
  }
  await page.close();
  return { viewport: viewport.name, overlay: overlay.name, trigger: overlay.trigger, ...audit, issues };
}

async function main() {
  rmSync(screenshotsDir, { recursive: true, force: true });
  mkdirSync(screenshotsDir, { recursive: true });
  const externalUrl = process.env.UI_OVERLAY_URL || '';
  const port = Number(process.env.UI_OVERLAY_PORT || (await getFreePort()));
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
    const runs = [];
    for (const viewport of viewports) {
      for (const overlay of OVERLAYS) {
        runs.push(await auditOverlay(browser, fixtureUrl, viewport, overlay));
      }
    }
    const allIssues = runs.flatMap((run) => run.issues.map((issue) => ({ ...issue, viewport: run.viewport, overlay: run.overlay })));
    const errors = allIssues.filter((issue) => issue.severity === 'error');
    const warnings = allIssues.filter((issue) => issue.severity === 'warning');
    const report = {
      generated_at: new Date().toISOString(),
      status: errors.length ? 'failed' : 'passed',
      fixture_url: fixtureUrl,
      viewports,
      overlays: OVERLAYS.map((o) => o.name),
      summary: { runs: runs.length, errors: errors.length, warnings: warnings.length },
      issues: allIssues,
      runs,
    };
    writeFileSync(jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`UI interaction-overlap audit ${report.status}: ${runs.length} overlay/viewport runs, ${errors.length} error(s), ${warnings.length} warning(s).`);
    console.log(`JSON report: ${relative(desktopRoot, jsonOutputPath)}`);
    for (const issue of errors) console.error(`- [${issue.viewport}/${issue.overlay}] ${issue.type}: ${issue.message}`);
    for (const issue of warnings) console.warn(`- [${issue.viewport}/${issue.overlay}] ${issue.type}: ${issue.message}`);
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
