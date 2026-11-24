#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
/**
 * LIVE smoke for the co-pilot deployment seam: launch the REAL Electron app and confirm it spawns +
 * health-gates the LLM agent runtime (runtime, uvicorn). Proves the supervisor end-to-end WITHOUT a
 * model — it only checks backend:status.agent_runtime.up. (A full chat needs a real model/API key.)
 *
 * The agent runtime boots slowly (MCP server init ~40s), and createWindow awaits both backends before
 * showing the window, so the first window can take ~60s — timeouts are generous on purpose.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const electronExecutable = require('electron');
const BIG = 240000;

function getFreePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
  });
}
async function waitForServer(url, timeoutMs = 30000) {
  const dl = Date.now() + timeoutMs; let last = '';
  while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; last = `HTTP ${r.status}`; } catch (e) { last = String(e); } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`renderer dev server not ready at ${url}: ${last}`);
}

async function main() {
  const rendererPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(rendererPort), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let app;
  try {
    await waitForServer(`${baseUrl}/`);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      // NOTE: IEEG_DISABLE_AGENT_RUNTIME deliberately NOT set -> the app DOES start the agent runtime.
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/`,
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: BIG,
    });
    const logs = [];
    const proc = app.process();
    proc?.stdout?.on('data', (c) => logs.push(String(c)));
    proc?.stderr?.on('data', (c) => logs.push(String(c)));
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(15000);
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });
    const status = await page.evaluate(async () => {
      const a = window.ieeg;
      return a && a.getBackendStatus ? await a.getBackendStatus() : { __error: 'no window.ieeg.getBackendStatus' };
    });
    const agent = status && status.agent_runtime;
    const ok = Boolean(agent && agent.up);
    console.log(JSON.stringify({
      status: ok ? 'passed' : 'failed',
      agent_runtime: agent,
      pyhfo_status: status && status.status,
      electron_log_tail: logs.join('').split('\n').filter((l) => /agent|8001|uvicorn|did not start/i.test(l)).slice(-10),
    }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch {} } }
    vite.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
