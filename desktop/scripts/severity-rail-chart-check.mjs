// Measures the score-over-time bars inside the RAIL, which is where they render blank.
import { mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outDir = join(desktopRoot, 'artifacts', 'severity-ui');

// 120 segments -- a 30-minute recording, the shape the user actually scored.
const scores = Array.from({ length: 120 }, (_, i) => ({
  segment_idx: i,
  start_sec: i * 15,
  end_sec: (i + 1) * 15,
  score: 0.3 + 4.2 * Math.abs(Math.sin(i / 9)),
  artifact: i % 17 === 0,
}));
const RESULT = {
  status: 'complete', eeg_type: 'scalp', input_path: '0.edf', num_segments: scores.length,
  mean_score: 2.3, peak_score: 4.5, peak_time_sec: 300,
  num_clean_segments: scores.filter((s) => !s.artifact).length, clean_mean_score: 2.21, clean_peak_score: 4.42,
  clean_peak_time_sec: 285, artifact_threshold_uv: 1000,
  scores, artifacts: {}, warnings: [], timing: {},
};

mkdirSync(outDir, { recursive: true });
const vite = await createViteServer({ root: desktopRoot, server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
await vite.listen();
const { port } = vite.httpServer.address();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.setDefaultTimeout(180000);
await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 180000 });

// A run in flight: the ETA line and the cancel control.
await page.evaluate(async () => {
  const probe = await import('/src/__severityProbe.tsx');
  await probe.mountSeverityInRail('severity-host', { status: 'running', result: null, error: null, progress: { percent: 31, done: 1472, total: 4735, etaSeconds: 660 } });
});
await page.waitForTimeout(400);
const runningState = await page.evaluate(() => ({
  progress: document.querySelector('[data-testid="severity-progress"]')?.textContent?.replace(/\s+/g, ' ').trim() || null,
  cancel: document.querySelector('[data-testid="severity-cancel-button"]')?.textContent?.trim() || null,
}));
console.log('RUNNING STATE', JSON.stringify(runningState));

await page.evaluate(async (result) => {
  const probe = await import('/src/__severityProbe.tsx');
  await probe.mountSeverityInRail('severity-host', { status: 'complete', result, error: null, progress: null });
}, RESULT);
await page.waitForTimeout(600);

const geo = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), display: s.display, blockSize: s.blockSize, overflow: s.overflowY, position: s.position };
  };
  const bars = [...document.querySelectorAll('[data-testid="severity-histogram-bar"]')];
  const sample = bars.slice(0, 4).map((b) => {
    const r = b.getBoundingClientRect();
    const s = getComputedStyle(b);
    return { w: +r.width.toFixed(2), h: +r.height.toFixed(2), blockSize: s.blockSize, background: s.backgroundColor, varH: b.style.getPropertyValue('--severity-bar-h') };
  });
  const navStatus = document.querySelector('[data-testid="severity-nav-status"]')?.textContent || null;
  const rankOptions = document.querySelectorAll('[data-testid="severity-nav-rank-select"] option').length;
  return {
    navStatus,
    rankOptions,
    navCard: pick('[data-testid="severity-nav-card"]'),
    artifactNote: document.querySelector('[data-testid="severity-artifact-note"]')?.textContent || null,
    card: pick('.severity-histogram-card'),
    timeline: pick('.severity-histogram'),
    plot: pick('.severity-histogram-plot'),
    barsBox: pick('.severity-histogram-bars'),
    barCount: bars.length,
    sample,
  };
});
console.log(JSON.stringify(geo, null, 2));
// Hover the Peak at card so its lit state is in the screenshot.
const peakCard = page.locator('[data-testid="severity-stat-peak-time"]');
if (await peakCard.count()) {
  await peakCard.hover();
  await page.waitForTimeout(300);
  await peakCard.screenshot({ path: join(outDir, 'peak-hover.png') });
  const lit = await peakCard.evaluate((el) => { const cs = getComputedStyle(el); return { background: cs.backgroundColor, border: cs.borderColor, cursor: cs.cursor }; });
  console.log('PEAK HOVER', JSON.stringify(lit));
}
await page.screenshot({ path: join(outDir, 'rail-chart.png'), fullPage: true });
const nav = page.locator('[data-testid="severity-nav-card"]');
if (await nav.count()) await nav.screenshot({ path: join(outDir, 'rail-nav.png') });
await browser.close();
await vite.close();
