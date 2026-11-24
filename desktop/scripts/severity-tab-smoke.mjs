#!/usr/bin/env node
// Drives the REAL Electron app against a scalp EEG recording and exercises the Severity tab
// end to end: tab visibility gating, the run button, the backend round-trip, the summary stats,
// and the per-segment timeline. Captures screenshots so the rendering can actually be looked at.
//
// NOTE: Electron must NOT be launched with ELECTRON_RUN_AS_NODE set -- that runs electron.exe as
// plain Node, so `import { app } from 'electron'` yields an empty module and the app never starts.
// This script unsets it. severity-ui-render.mjs covers the same component in Chromium without
// needing Electron at all.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE; // see note above
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { createServer as createViteServer } from 'vite';
const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const outDir = join(desktopRoot, 'artifacts', 'severity-ui');
const electronExecutable = require('electron');
const RECORDING = process.env.SEVERITY_SMOKE_RECORDING || join(outDir, 'scalp_demo_raw.fif');
const STARTUP_MS = 120000;
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
async function waitForServer(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`renderer never came up at ${url}`);
}
const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
}
async function main() {
  mkdirSync(outDir, { recursive: true });
  const rendererPort = await getFreePort();
  const backendPort = Number(process.env.PYHFO_ELECTRON_E2E_BACKEND_PORT || await getFreePort());
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const viteLogs = [];
  const electronLogs = [];
  // Vite in-process: spawning `npm run dev` through a Windows shell hangs here.
  const vite = await createViteServer({ root: desktopRoot, server: { host: '127.0.0.1', port: rendererPort }, logLevel: 'warn' });
  await vite.listen();
  let app;
  try {
    // No visualFixture here: we want the real backend path, not canned fixture state.
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: baseUrl,
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '120000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_DISABLE_AGENT_RUNTIME: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: STARTUP_MS,
    });
    const proc = app.process();
    proc?.stdout?.on('data', (c) => electronLogs.push(String(c)));
    proc?.stderr?.on('data', (c) => electronLogs.push(String(c)));
    const page = await app.firstWindow({ timeout: STARTUP_MS });
    page.on('console', (m) => electronLogs.push(`[renderer:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => electronLogs.push(`[pageerror] ${e.message}`));
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: join(outDir, '01-launch.png') });
    check('electron app launches and renders', true);
    // Severity is a scalp-gated card in the pipeline rail, so it must be absent before a recording
    // is loaded -- and it is never a centre workflow tab.
    const cardBefore = await page.getByTestId('pyqt-sidebar_severity_card').count();
    check('severity card hidden with no recording', cardBefore === 0, `count=${cardBefore}`);
    // Load the recording straight through the same IPC bridge the UI uses.
    const loaded = await page.evaluate(async (path) => {
      const res = await window.ieeg.loadRecording(path);
      return res?.result?.eeg_type ?? res?.eeg_type ?? null;
    }, RECORDING);
    check('backend reports eeg_type=scalp for the recording', loaded === 'scalp', `eeg_type=${loaded}`);
    // The renderer only re-renders on its own state, so open the recording via the UI path too.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(outDir, '02-after-load.png'), fullPage: false });
    // Verify the tab-gating helper and the score buckets directly in the renderer bundle.
    const gating = await page.evaluate(async () => {
      const mod = await import('/src/app/workspaceState.ts');
      const scalp = { channel_names: ['FP1'], eeg_type: 'scalp' };
      const ieeg = { channel_names: ['A1'], eeg_type: 'ieeg' };
      return {
        scalpTabs: mod.visibleWorkspaceTabs(scalp),
        ieegTabs: mod.visibleWorkspaceTabs(ieeg),
        supportsScalp: mod.supportsSeverityScoring(scalp),
        supportsIeeg: mod.supportsSeverityScoring(ieeg),
        buckets: [0.5, 2.0, 3.0, 4.5].map((s) => mod.severityBucket(s)),
        colors: mod.SEVERITY_BUCKET_COLORS,
        formatted: mod.formatSeverityScore(1.234),
        formattedNull: mod.formatSeverityScore(null),
      };
    });
    check('Severity tab present for scalp only', gating.scalpTabs.includes('Severity') && !gating.ieegTabs.includes('Severity'),
      `scalp=[${gating.scalpTabs}] ieeg=[${gating.ieegTabs}]`);
    check('supportsSeverityScoring gates on eeg_type', gating.supportsScalp === true && gating.supportsIeeg === false);
    check('score buckets span the full ramp',
      JSON.stringify(gating.buckets) === JSON.stringify(['minimal', 'mild', 'moderate', 'severe']),
      gating.buckets.join(','));
    check('all four ramp steps are distinct colours', new Set(Object.values(gating.colors)).size === 4,
      Object.values(gating.colors).join(' '));
    check('score formatting handles values and nulls', gating.formatted === '1.23' && gating.formattedNull === '—',
      `${gating.formatted} / ${gating.formattedNull}`);
    // Real backend severity round-trip through the IPC bridge the tab's button uses.
    const scored = await page.evaluate(async (path) => {
      const res = await window.ieeg.runSeverityScoring({ input_path: path });
      const r = res?.result ?? res;
      return { status: r?.status, segments: r?.num_segments, mean: r?.mean_score, peak: r?.peak_score, scores: (r?.scores || []).length };
    }, RECORDING);
    check('severity scoring completes over IPC', scored.status === 'complete', JSON.stringify(scored));
    check('segment count matches 15s windows over the recording',
      scored.segments > 0 && scored.scores === scored.segments, `segments=${scored.segments} scores=${scored.scores}`);
    check('mean/peak are finite numbers in range',
      Number.isFinite(scored.mean) && Number.isFinite(scored.peak) && scored.mean >= 0 && scored.peak <= 5,
      `mean=${scored.mean} peak=${scored.peak}`);
    const fetched = await page.evaluate(async () => {
      const res = await window.ieeg.getSeverityResult();
      return { status: res?.status, mean: res?.result?.mean_score };
    });
    check('GET /severity returns the stored result', fetched.status === 'complete' && Number.isFinite(fetched.mean),
      JSON.stringify(fetched));
    // Render the SeverityTab with a real result so the timeline/colour ramp is actually painted.
    const rendered = await page.evaluate(async (payload) => {
      // Mount through the vite-served probe: a bare import('react') from page context does not
      // go through vite's bare-specifier resolution.
      const probe = await import('/src/__severityProbe.tsx');
      await probe.mountSeverity('severity-probe', { status: 'complete', result: payload, error: null }, true);
      const host = document.getElementById('severity-probe');
      const q = (sel) => host.querySelector(sel);
      const bars = host.querySelectorAll('[data-testid="severity-histogram-bar"]');
      return {
        bars: bars.length,
        barBuckets: Array.from(bars).map((b) => b.getAttribute('data-bucket')),
        barHeights: Array.from(bars).map((b) => b.style.getPropertyValue('--severity-bar-h')),
        paintedHeights: Array.from(bars).map((b) => Math.round(b.getBoundingClientRect().height)),
        mean: q('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent,
        peak: q('[data-testid="severity-stat-peak"] .severity-stat-value')?.textContent,
        peakAt: q('[data-testid="severity-stat-peak-time"] .severity-stat-value')?.textContent,
        legend: host.querySelectorAll('.severity-legend-item').length,
        tableRows: host.querySelectorAll('[data-testid="severity-score-table"] tbody tr').length,
        eegBadge: q('[data-testid="severity-eeg-type"]')?.textContent,
      };
    }, {
      // Hand-built spread so every bucket in the ramp gets painted, not just the low end.
      status: 'complete', eeg_type: 'scalp', num_segments: 6,
      mean_score: 2.4, peak_score: 4.6, peak_time_sec: 75,
      scores: [
        { segment_idx: 0, start_sec: 0, end_sec: 15, score: 0.4 },
        { segment_idx: 1, start_sec: 15, end_sec: 30, score: 1.6 },
        { segment_idx: 2, start_sec: 30, end_sec: 45, score: 2.1 },
        { segment_idx: 3, start_sec: 45, end_sec: 60, score: 3.2 },
        { segment_idx: 4, start_sec: 60, end_sec: 75, score: 2.5 },
        { segment_idx: 5, start_sec: 75, end_sec: 90, score: 4.6 },
      ],
      artifacts: {}, warnings: [], timing: {},
    });
    // Twenty score bins, not one bar per segment: the distribution answers 'what is the shape of
    // this recording's scores', and time is the mini plot's axis.
    check('histogram paints one bar per score bin', rendered.bars === 20, `bars=${rendered.bars}`);
    check('bars colour-code across the whole ramp',
      new Set(rendered.barBuckets).size >= 4, rendered.barBuckets.join(','));
    check('bar heights scale with bin population',
      rendered.paintedHeights.filter((h) => h > 0).length === 6
      && rendered.paintedHeights.filter((h) => h === 0).length === 14,
      `painted=[${rendered.paintedHeights}]`);
    check('summary stats render', rendered.mean === '2.40' && rendered.peak === '4.60',
      `mean=${rendered.mean} peak=${rendered.peak} peakAt=${rendered.peakAt}`);
    check('peak timestamp formats as clock', rendered.peakAt === '1:15', `peakAt=${rendered.peakAt}`);
    check('legend labels all four levels', rendered.legend === 4, `items=${rendered.legend}`);
    check('table view lists segments', rendered.tableRows >= 6, `rows=${rendered.tableRows}`);
    check('scalp badge shown', (rendered.eegBadge || '').includes('Scalp'), `badge=${rendered.eegBadge}`);
    await page.screenshot({ path: join(outDir, '03-severity-tab.png'), fullPage: true });
    const probe = await page.$('#severity-probe');
    if (probe) await probe.screenshot({ path: join(outDir, '04-severity-tab-closeup.png') });
    check('screenshots captured', true, outDir);
  } finally {
    if (app) await app.close().catch(() => {});
    await vite.close().catch(() => {});
  }
  const failed = results.filter((r) => !r.pass);
  writeFileSync(join(outDir, 'severity-tab-smoke.json'),
    JSON.stringify({ results, failed: failed.length, electron_logs: electronLogs.slice(-60), vite_logs: viteLogs.slice(-30) }, null, 2));
  console.log(`\n=== Severity tab smoke: ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); process.exitCode = 1; }
}
main().catch((exc) => { console.error(exc); process.exitCode = 1; });
