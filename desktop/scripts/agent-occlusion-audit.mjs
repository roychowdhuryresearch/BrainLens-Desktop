#!/usr/bin/env node
// One-off audit: how much of the workspace does the agent overlay panel cover?
// Screenshots closed vs open at the two reference viewports and measures which
// workspace surfaces intersect the fixed agent panel + rail.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startVite, getFreePort, waitForServer, withVisualFixture, desktopRoot } from './lib/ui-audit-harness.mjs';

const outDir = join(desktopRoot, 'artifacts/agent-occlusion-audit');
mkdirSync(outDir, { recursive: true });

const SURFACES = {
  rightSidebar: 'pyqt-waveform_right_sidebar',
  waveformStage: 'pyqt-waveform_stage',
  toolbar: 'pyqt-waveform-toolbar',
};

function intersect(a, b) {
  const x = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const y = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return x * y;
}

const port = await getFreePort();
const { child } = startVite(port);
const base = `http://127.0.0.1:${port}/`;
try {
  await waitForServer(base);
  const browser = await chromium.launch();
  const report = [];
  for (const vp of [{ name: '1512x982', width: 1512, height: 982 }, { name: '1440x860', width: 1440, height: 860 }]) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.goto(withVisualFixture(base), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 15000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${vp.name}-closed.png`) });
    await page.getByTestId('agent-activity-chat').click();
    await page.waitForSelector('[data-testid="agent-panel"]', { timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(outDir, `${vp.name}-open.png`) });

    const rects = await page.evaluate((surfaces) => {
      const grab = (testid) => {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
      };
      const out = { panel: grab('agent-panel'), rail: grab('agent-activity-bar') };
      for (const [key, testid] of Object.entries(surfaces)) out[key] = grab(testid);
      return out;
    }, SURFACES);

    const covered = {};
    for (const key of Object.keys(SURFACES)) {
      const surface = rects[key];
      if (!surface || !rects.panel) continue;
      const overlap = intersect(surface, rects.panel) + (rects.rail ? intersect(surface, rects.rail) : 0);
      const area = surface.width * surface.height;
      covered[key] = { surfaceWidth: Math.round(surface.width), overlapPct: area ? Math.round((overlap / area) * 100) : 0 };
    }
    report.push({ viewport: vp.name, panel: rects.panel, rail: rects.rail, covered });
    await page.close();
  }
  await browser.close();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill('SIGTERM');
}
