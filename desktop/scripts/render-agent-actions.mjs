// Throwaway: open the Agent panel's Actions tab in the visual fixture and screenshot it.
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
  // Open the agent panel on the Actions face (rail button is the only tab switcher).
  const tryClick = async (tid) => page.locator(`[data-testid="${tid}"]`).first().evaluate((el) => el.click()).then(() => true).catch(() => false);
  await tryClick('agent-activity-actions');
  await page.waitForTimeout(400);
  if (!(await page.locator('[data-testid="agent-actions-tab"]').count())) {
    await tryClick('agent-activity-actions');
    await page.waitForTimeout(300);
  }
  const panel = page.locator('[data-testid="agent-panel"]').first();
  const has = await panel.count();
  console.log('agent-panel present:', has, 'actions-tab present:', await page.locator('[data-testid="agent-actions-tab"]').count());
  if (has) await panel.screenshot({ path: '/tmp/agent_actions.png' });
  else await page.screenshot({ path: '/tmp/agent_actions.png' });
  await browser.close();
} finally { vite.kill(); }
