#!/usr/bin/env node
// One-off: screenshot every reachable UI state at the desktop reference viewport
// so design reviewers can see the WHOLE app, not just the agent panel.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startVite, getFreePort, waitForServer, withVisualFixture, desktopRoot, STATES, STATE_SURFACES, setState } from './lib/ui-audit-harness.mjs';

const outDir = join(desktopRoot, 'artifacts/ui-review-sweep');
mkdirSync(outDir, { recursive: true });

const port = await getFreePort();
const { child } = startVite(port);
try {
  await waitForServer(`http://127.0.0.1:${port}/`);
  const fixtureUrl = withVisualFixture(`http://127.0.0.1:${port}/`);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
  for (const state of STATES) {
    try {
      await setState(page, fixtureUrl, state);
      await page.waitForSelector(STATE_SURFACES[state], { timeout: 8000 });
      await page.waitForTimeout(350);
      await page.screenshot({ path: join(outDir, `${state}.png`) });
      console.log('ok', state);
    } catch (error) {
      console.log('SKIP', state, String(error).slice(0, 120));
    }
  }
  await browser.close();
} finally {
  child.kill('SIGTERM');
}
