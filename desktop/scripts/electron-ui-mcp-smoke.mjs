#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
/**
 * Last-mile live test for the UI MCP connector: launch the REAL Electron app (UI broker hosted),
 * load a real EDF, then POST a command to the broker the way the external MCP server (Claude) would —
 * and assert the LIVE waveform actually moves. Proves: external HTTP -> broker -> renderer poll ->
 * executeAppliedUICommand -> UI moves. Agent runtime is skipped (not needed for this path).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const outDir = join(desktopRoot, 'artifacts');
const outPath = join(outDir, 'electron-ui-mcp-smoke.json');
const electronExecutable = require('electron');
const fixture = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim() || join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');
const BIG = 120000;
const TARGET_START = 25, TARGET_WINDOW = 5;

function writeReport(r) { mkdirSync(outDir, { recursive: true }); writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 2) + '\n'); }
function fail(s, m, e = {}) { writeReport({ status: s, message: m, ...e }); console.error(m); process.exit(2); }
function getFreePort() { return new Promise((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); }); }); }
async function waitForServer(url, timeoutMs = 30000) { const dl = Date.now() + timeoutMs; let last = ''; while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; last = `HTTP ${r.status}`; } catch (e) { last = String(e); } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`renderer dev server not ready at ${url}: ${last}`); }

async function main() {
  if (!existsSync(fixture)) fail('missing_fixture', `needs an EDF fixture: ${fixture}`);
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js'))) fail('missing_build', 'run npm run build first');
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
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/`,
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_AGENT_ROOT: repoRoot,            // so `python -m ui_mcp.broker` resolves
        IEEG_DISABLE_AGENT_RUNTIME: '1',      // not needed for the broker path; skip the slow agent boot
        // IEEG_DISABLE_UI_BROKER deliberately unset -> the broker DOES start.
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: BIG,
    });
    const logs = []; const proc = app.process();
    proc?.stdout?.on('data', (c) => logs.push(String(c))); proc?.stderr?.on('data', (c) => logs.push(String(c)));
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(15000);
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });

    const status = await page.evaluate(async () => (window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null));
    const broker = status && status.ui_broker;
    if (!broker || !broker.up || !broker.base_url) fail('broker_down', 'UI broker did not start', { ui_broker: broker, log: logs.join('').split('\n').slice(-25) });

    // Load a real EDF via recents.
    await page.evaluate((f) => window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: f, label: f.split('/').pop(), openedAt: new Date().toISOString(), metadata: null }])), fixture);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveform_event_overlay_canvas"]', { timeout: BIG });
    await page.waitForTimeout(1500); // let the renderer report ui_state at least once

    const readStart = () => page.getByTestId('pyqt-waveform_event_overlay_canvas').evaluate((el) => el.getAttribute('data-window-start-seconds') || '').catch(() => '');
    const startBefore = await readStart();

    // The renderer should have reported its ui_state to the broker by now.
    const reportedState = await fetch(`${broker.base_url}/ui/state`).then((r) => r.json()).catch(() => ({}));
    const stateOk = Boolean(reportedState?.ui_state && reportedState.ui_state.recording);

    // ACT AS THE EXTERNAL MCP AGENT: POST a command to the broker's MCP side.
    const emit = await fetch(`${broker.base_url}/ui/emit`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'waveform.set_viewport', payload: { start_seconds: TARGET_START, duration_seconds: TARGET_WINDOW }, reason: 'external MCP agent drives the UI' }),
    }).then((r) => r.json());

    // The renderer poll (700ms) should drain + apply -> the live waveform moves.
    let moved = false;
    try {
      await page.waitForFunction(({ target, before }) => {
        const el = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
        const raw = el && el.getAttribute('data-window-start-seconds');
        if (!raw) return false;
        const v = Number(raw);
        return Number.isFinite(v) && Math.abs(v - target) <= 3 && raw !== before;
      }, { target: TARGET_START, before: startBefore }, { timeout: 20000, polling: 500 });
      moved = true;
    } catch { moved = false; }
    const startAfter = await readStart();

    const passed = Boolean(emit?.success) && moved && Math.abs(Number(startAfter) - TARGET_START) <= 3;
    const report = {
      status: passed ? 'passed' : 'failed',
      ui_broker: broker,
      renderer_reported_state_to_broker: stateOk,
      reported_channels: reportedState?.ui_state?.channels?.length ?? 0,
      emit_result: emit,
      viewport: { start_before: startBefore, start_after: startAfter, target_start: TARGET_START },
      assertions: { emit_accepted: Boolean(emit?.success), waveform_moved: moved },
    };
    writeReport(report);
    console.log(JSON.stringify({ status: report.status, renderer_reported_state_to_broker: stateOk, emit_result: emit, viewport: report.viewport, assertions: report.assertions, report: outPath }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch {} } }
    vite.kill();
  }
}

main().catch((e) => { writeReport({ status: 'failed', message: e instanceof Error ? e.message : String(e) }); console.error(e); process.exit(1); });
