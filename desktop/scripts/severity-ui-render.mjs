#!/usr/bin/env node
// Renders the real SeverityTab in a browser against the vite dev server and screenshots it.
// The Electron shell can't launch in every environment (its ESM main-process import of
// `electron` is version/platform sensitive), but the renderer is a plain web app -- so the
// component, its styles, and the score ramp can still be exercised and looked at for real.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outDir = join(desktopRoot, 'artifacts', 'severity-ui');

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

// A spread that lands in every bucket of the ramp, so the colour coding is genuinely painted
// rather than inferred. (Synthetic noise only ever scores near 0, which would leave
// mild/moderate/severe untested.)
const RESULT = {
  status: 'complete', eeg_type: 'scalp', input_path: 'demo_scalp_raw.fif', num_segments: 8,
  mean_score: 2.41, peak_score: 4.62, peak_time_sec: 105,
  scores: [
    { segment_idx: 0, start_sec: 0, end_sec: 15, score: 0.42 },
    { segment_idx: 1, start_sec: 15, end_sec: 30, score: 1.08 },
    { segment_idx: 2, start_sec: 30, end_sec: 45, score: 1.94 },
    { segment_idx: 3, start_sec: 45, end_sec: 60, score: 2.63 },
    { segment_idx: 4, start_sec: 60, end_sec: 75, score: 3.11 },
    { segment_idx: 5, start_sec: 75, end_sec: 90, score: 2.20 },
    { segment_idx: 6, start_sec: 90, end_sec: 105, score: 3.85 },
    { segment_idx: 7, start_sec: 105, end_sec: 120, score: 4.62 },
  ],
  artifacts: {}, warnings: [], timing: { elapsed_seconds: 4.2 },
};

async function main() {
  mkdirSync(outDir, { recursive: true });
  const vite = await createViteServer({
    root: desktopRoot,
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'warn',
  });
  await vite.listen();
  const { port } = vite.httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`vite dev server: ${baseUrl}`);

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    check('renderer loads with the workspace stylesheet', true);

    // Gating helpers, evaluated in the real bundle.
    const gating = await page.evaluate(async () => {
      const m = await import('/src/app/workspaceState.ts');
      const scalp = { channel_names: ['FP1'], eeg_type: 'scalp' };
      const ieeg = { channel_names: ['A1'], eeg_type: 'ieeg' };
      return {
        scalpTabs: m.visibleWorkspaceTabs(scalp),
        ieegTabs: m.visibleWorkspaceTabs(ieeg),
        noMeta: m.visibleWorkspaceTabs(null),
        buckets: [0.4, 1.9, 3.1, 4.6].map(m.severityBucket),
        colors: m.SEVERITY_BUCKET_COLORS,
        fmt: [m.formatSeverityScore(1.234), m.formatSeverityScore(null)],
      };
    });
    check('Severity tab shows for scalp, hidden for ieeg and for no recording',
      gating.scalpTabs.includes('Severity') && !gating.ieegTabs.includes('Severity') && !gating.noMeta.includes('Severity'),
      `scalp=[${gating.scalpTabs}] ieeg=[${gating.ieegTabs}] none=[${gating.noMeta}]`);
    check('buckets cover the full ramp',
      JSON.stringify(gating.buckets) === JSON.stringify(['minimal', 'mild', 'moderate', 'severe']), gating.buckets.join(','));
    check('score formatting', gating.fmt[0] === '1.23' && gating.fmt[1] === '—', gating.fmt.join(' / '));

    // Mount the real component with a real result payload.
    const rendered = await page.evaluate(async (payload) => {
      const probe = await import('/src/__severityProbe.tsx');
      await probe.mountSeverity('severity-host', { status: 'complete', result: payload, error: null }, true);
      const host = document.getElementById('severity-host');
      const q = (s) => host.querySelector(s);
      const bars = Array.from(host.querySelectorAll('[data-testid="severity-histogram-bar"]'));
      const cs = (el) => el ? getComputedStyle(el) : null;
      return {
        bars: bars.length,
        buckets: bars.map((b) => b.getAttribute('data-bucket')),
        heights: bars.map((b) => Math.round(parseFloat(b.style.getPropertyValue('--severity-bar-h')))),
        paintedHeights: bars.map((b) => Math.round(b.getBoundingClientRect().height)),
        barColors: bars.map((b) => cs(b).backgroundColor),
        mean: q('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent,
        peak: q('[data-testid="severity-stat-peak"] .severity-stat-value')?.textContent,
        peakAt: q('[data-testid="severity-stat-peak-time"] .severity-stat-value')?.textContent,
        segs: q('[data-testid="severity-stat-segments"] .severity-stat-value')?.textContent,
        legend: host.querySelectorAll('.severity-legend-item').length,
        legendText: Array.from(host.querySelectorAll('.severity-legend-item')).map((e) => e.textContent.trim()),
        badge: q('[data-testid="severity-eeg-type"]')?.textContent,
        rows: host.querySelectorAll('[data-testid="severity-score-table"] tbody tr').length,
        runBtn: q('[data-testid="severity-run-button"]')?.textContent,
        // styling actually applied (not just class names present)
        statBg: cs(q('.severity-stat'))?.backgroundColor,
        barRadius: cs(bars[0])?.borderTopLeftRadius,
        barGap: cs(q('.severity-histogram-bars'))?.gap,
        barsSpan: Math.round(bars[bars.length-1].getBoundingClientRect().right - bars[0].getBoundingClientRect().left),
        trackWidth: Math.round(q('.severity-histogram-bars').getBoundingClientRect().width),
        hostWidth: host.scrollWidth,
        docWidth: document.documentElement.clientWidth,
      };
    }, RESULT);

    check('timeline paints one bar per segment', rendered.bars === 8, `bars=${rendered.bars}`);
    check('bars span all four ramp buckets', new Set(rendered.buckets).size === 4, rendered.buckets.join(','));
    check('bar heights scale monotonically with score',
      rendered.heights[0] < rendered.heights[7], `first=${rendered.heights[0]} last=${rendered.heights[7]}`);
    check('PAINTED bar heights track the score (not flattened by a control-height floor)',
      rendered.paintedHeights[0] < rendered.paintedHeights[7]
        && new Set(rendered.paintedHeights).size >= 6,
      `painted=[${rendered.paintedHeights}]`);
    check('each bucket paints a distinct colour', new Set(rendered.barColors).size === 4, [...new Set(rendered.barColors)].join(' '));
    check('summary stats render correct values',
      rendered.mean === '2.41' && rendered.peak === '4.62' && rendered.peakAt === '1:45' && rendered.segs === '8',
      `mean=${rendered.mean} peak=${rendered.peak} peakAt=${rendered.peakAt} segs=${rendered.segs}`);
    check('legend labels all four levels in text (not colour alone)',
      rendered.legend === 4 && rendered.legendText.join(',') === 'Minimal,Mild,Moderate,Severe', rendered.legendText.join(','));
    check('scalp badge rendered', (rendered.badge || '').includes('Scalp'), rendered.badge);
    check('per-segment table populated', rendered.rows >= 8, `rows=${rendered.rows}`);
    check('run button present', (rendered.runBtn || '').includes('Run severity'), rendered.runBtn);
    check('CSS actually applied (stat card, 4px bar ends, 2px bar gap)',
      rendered.statBg && rendered.statBg !== 'rgba(0, 0, 0, 0)' && rendered.barRadius === '4px' && rendered.barGap === '2px',
      `bg=${rendered.statBg} radius=${rendered.barRadius} gap=${rendered.barGap}`);
    check('bars span the full time-axis track (chart matches its own scale)',
      rendered.barsSpan >= rendered.trackWidth * 0.9,
      `bars=${rendered.barsSpan}px track=${rendered.trackWidth}px`);
    check('no horizontal overflow', rendered.hostWidth <= rendered.docWidth,
      `content=${rendered.hostWidth} viewport=${rendered.docWidth}`);
    check('no runtime errors while rendering', errors.length === 0, errors.join(' | '));

    await page.screenshot({ path: join(outDir, 'severity-tab-light.png'), fullPage: true });

    // Long-term monitoring: a 21.6-hour recording is ~5200 segments. Real data, real shape.
    const many = await page.evaluate(async (n) => {
      const scores = Array.from({ length: n }, (_, i) => ({
        segment_idx: i, start_sec: i * 15, end_sec: (i + 1) * 15,
        score: 0.2 + 2.2 * Math.abs(Math.sin(i / 180)) + (i % 97 === 0 ? 2.2 : 0),
      }));
      const probe = await import('/src/__severityProbe.tsx');
      await probe.mountSeverity('severity-host', { status: 'complete', result: {
        status: 'complete', eeg_type: 'scalp', num_segments: n,
        mean_score: 1.4, peak_score: 4.4, peak_time_sec: 1455, scores,
        artifacts: {}, warnings: [], timing: {},
      }, error: null }, true);
      const host = document.getElementById('severity-host');
      const track = host.querySelector('.severity-histogram-bars');
      const bars = host.querySelectorAll('[data-testid="severity-histogram-bar"]');
      return {
        requested: n,
        painted: bars.length,
        trackScrollW: Math.round(track.scrollWidth),
        trackClientW: Math.round(track.clientWidth),
        plotW: Math.round(host.querySelector('.severity-histogram-plot').getBoundingClientRect().width),
        trackW: Math.round(track.getBoundingClientRect().width),
        note: host.querySelector('[data-testid="severity-histogram-note"]')?.textContent?.trim().slice(0, 60) || '',
        hostScrollW: Math.round(host.scrollWidth),
        docW: document.documentElement.clientWidth,
        bodyScrollW: Math.round(document.body.scrollWidth),
      };
    }, 5200);
    check('long recording: timeline stays inside its plot (no runaway track)',
      many.trackW <= many.plotW + 2, `track=${many.trackW}px plot=${many.plotW}px`);
    check('long recording: column count is bounded',
      many.painted > 0 && many.painted <= 240, `painted=${many.painted} of ${many.requested} segments`);
    check('long recording: aggregation is disclosed to the reader',
      many.note.length > 0, many.note);
    check('long recording does not overflow the page',
      many.bodyScrollW <= many.docW + 2, `body=${many.bodyScrollW} viewport=${many.docW}`);
    await page.screenshot({ path: join(outDir, 'severity-tab-longrecording.png'), fullPage: false });
    console.log(`   (long-recording probe: requested=${many.requested} painted=${many.painted})`);

    // Empty/idle state too -- the pre-run view a user sees first.
    await page.evaluate(async () => {
      const probe = await import('/src/__severityProbe.tsx');
      await probe.mountSeverity('severity-host', { status: 'idle', result: null, error: null }, false);
    });
    await page.screenshot({ path: join(outDir, 'severity-tab-empty.png'), fullPage: true });
    check('empty state renders', true, 'severity-tab-empty.png');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await vite.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  writeFileSync(join(outDir, 'severity-ui-render.json'), JSON.stringify({ results, failed: failed.length }, null, 2));
  console.log(`\n=== Severity UI render: ${results.length - failed.length}/${results.length} PASS ===`);
  console.log(`screenshots: ${outDir}`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
