// Throwaway: render the Event Review dialog via the visual fixture and screenshot it +
// log the layout boxes of the frequency-range group, the view-control arrows, and the scope card.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const freePort = () => new Promise((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const waitServer = async (url, ms = 40000) => { const dl = Date.now() + ms; let last = ''; while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; last = `HTTP ${r.status}`; } catch (e) { last = String(e); } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`vite not ready: ${last}`); };

const port = await freePort();
const vite = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'], env: process.env });
try {
  await waitServer(`http://localhost:${port}/`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`http://localhost:${port}/?visualFixture=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 30000 });
  const opened = await page.locator('[data-testid="pyqt-open_review_button"]').evaluateAll((nodes) => {
    const t = nodes.find((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !n.disabled && n.getAttribute('aria-disabled') !== 'true'; });
    if (!t) return false; t.click(); return true;
  });
  if (!opened) throw new Error('no visible open_review_button');
  await page.waitForSelector('[data-testid="pyqt-predictionScopeCard"]', { timeout: 30000 });
  await page.waitForTimeout(500);

  const layout = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { top: Math.round(b.top), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
    const ids = ['pyqt-ResetViewButton', 'pyqt-BackViewButton', 'pyqt-ForwardViewButton', 'pyqt-ZoomInButton', 'pyqt-ZoomOutButton', 'pyqt-PanLeftButton', 'pyqt-PanRightButton', 'pyqt-PanUpButton', 'pyqt-PanDownButton', 'pyqt-spinBox_minFreq', 'pyqt-spinBox_maxFreq', 'pyqt-SetFreqLimit', 'pyqt-viewControlsExportSnapshotButton'];
    const out = {};
    for (const id of ids) out[id] = box(`[data-testid="${id}"]`);
    return out;
  });
  console.log(JSON.stringify(layout, null, 2));

  await page.screenshot({ path: '/tmp/review_dialog_full.png' });
  await browser.close();
} finally { vite.kill(); }
