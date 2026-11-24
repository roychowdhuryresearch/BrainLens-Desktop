#!/usr/bin/env node
/**
 * B — FULL-STACK co-pilot live smoke. Launches the REAL Electron app with BOTH backends enabled
 * (PyHFO scientific backend + the LLM agent runtime), loads a REAL EDF, then asks the co-pilot — via
 * the actual chat composer — to move the waveform, and asserts the waveform viewport ACTUALLY MOVED.
 *
 * This exercises the entire turn-based loop through the real desktop stack:
 *   chat composer -> window.ieeg.sendAgentMessage -> Electron agent:chat -> PyHFO /agent/chat (job)
 *     -> agent runtime /internal/agent/v1/chat (real model qwen3.5-plus) -> emit_ui_command
 *     -> drained ui_commands -> PyHFO job result -> renderer poll -> executeAppliedUICommand -> updatePlot
 *
 * Requires a real model/API key (configured in agent user_config.yaml) and network egress to the model
 * endpoint. NOT part of the deterministic CI suite — it costs tokens and is model-non-deterministic.
 * Run: npm run qa:copilot-live   (after npm run build)
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
const artifactsDir = join(desktopRoot, 'artifacts');
const outputRoot = join(artifactsDir, 'electron-copilot-live');
const outputPath = join(artifactsDir, 'electron-copilot-live-smoke.json');
const electronExecutable = require('electron');
const defaultFixture = join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');
const BIG = 240000;            // agent+PyHFO boot can take ~60s; window awaits both
const ANSWER_TIMEOUT_MS = 180000; // model round-trip + 1s renderer poll loop
const TARGET_START = 30;
const TARGET_WINDOW = 5;
const diagnostics = { viteLogs: [], electronLogs: [] };

function writeReport(report) {
  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}
function fail(status, message, extra = {}) {
  writeReport({ status, message, ...extra });
  console.error(message);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}
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
function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], text: true });
  const logs = []; diagnostics.viteLogs = logs;
  child.stdout.on('data', (c) => logs.push(String(c)));
  child.stderr.on('data', (c) => logs.push(String(c)));
  return { child, logs };
}

async function main() {
  const fixturePath = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim()
    ? resolve(process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING.trim())
    : defaultFixture;
  if (!existsSync(fixturePath)) fail('missing_fixture', `Co-pilot live smoke needs an EDF fixture. Set PYHFO_ELECTRON_REAL_FIXTURE_RECORDING. Tried: ${fixturePath}`);
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js')) || !existsSync(join(desktopRoot, 'dist-electron', 'preload.cjs'))) {
    fail('missing_build', 'Co-pilot live smoke requires built Electron outputs. Run npm run build first.');
  }
  mkdirSync(outputRoot, { recursive: true });

  const rendererPort = await getFreePort();
  const backendPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = startVite(rendererPort);
  let app;
  const consoleEntries = [];
  try {
    await waitForServer(`${baseUrl}/`);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/`,
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS || '90000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_AGENT_ROOT: repoRoot,
        IEEG_DISABLE_CLOSE_GUARD: '1', // headless run: don't hang on the unsaved-workspace close dialog
        // NOTE: IEEG_DISABLE_AGENT_RUNTIME deliberately NOT set -> the agent runtime DOES start.
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: BIG,
    });
    const electronLogs = []; diagnostics.electronLogs = electronLogs;
    const proc = app.process();
    proc?.stdout?.on('data', (c) => electronLogs.push(String(c)));
    proc?.stderr?.on('data', (c) => electronLogs.push(String(c)));
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(15000);
    page.on('console', (m) => consoleEntries.push({ type: m.type(), text: m.text().slice(0, 500) }));
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });

    // 1) Confirm the agent runtime came up (the whole point of the full-stack run).
    const status = await page.evaluate(async () => (window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null));
    const agentUp = Boolean(status && status.agent_runtime && status.agent_runtime.up);
    if (!agentUp) fail('agent_down', 'Agent runtime did not start; co-pilot cannot run.', { backend_status: status, electron_logs: electronLogs.join('').split('\n').slice(-40) });

    // 2) Load a real EDF via the recents path (native open dialog is not scriptable).
    await page.evaluate((fixture) => {
      window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: fixture, label: fixture.split('/').pop() || fixture, openedAt: new Date().toISOString(), metadata: null }]));
    }, fixturePath);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveformWiget"]', { timeout: BIG });
    await page.waitForTimeout(800);

    // The waveform CANVAS reflects the actually-rendered window via data-window-* (toolbar inputs
    // collapse into an overflow menu at headless widths, so they are unreliable to read).
    const readViewport = () => page.getByTestId('pyqt-waveform_event_overlay_canvas')
      .evaluate((el) => ({ start: el.getAttribute('data-window-start-seconds') || '', duration: el.getAttribute('data-window-duration-seconds') || '' }))
      .catch(() => ({ start: '', duration: '' }));
    const vpBefore = await readViewport();

    // 3) Drive the co-pilot through the real chat composer.
    await page.getByTestId('agent-activity-chat').click();
    await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 15000 });
    const prompt = `Move the waveform viewport to start at ${TARGET_START} seconds and show a ${TARGET_WINDOW} second window.`;
    await page.fill('#agent-prompt-input', prompt);
    await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();

    // 4) Wait for the rendered waveform window to actually move to ~30s (renderer applied a real
    //    waveform.set_viewport -> updatePlot refetched the window). The canvas data attribute is truth.
    let moved = false;
    try {
      await page.waitForFunction(({ target, before }) => {
        const el = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
        if (!el) return false;
        const raw = el.getAttribute('data-window-start-seconds');
        if (!raw) return false;
        const v = Number(raw);
        return Number.isFinite(v) && Math.abs(v - target) <= 3 && raw !== before;
      }, { target: TARGET_START, before: vpBefore.start }, { timeout: ANSWER_TIMEOUT_MS, polling: 1000 });
      moved = true;
    } catch { moved = false; }

    await page.waitForTimeout(500);
    const vpAfter = await readViewport();
    const startBefore = vpBefore.start;
    const windowBefore = vpBefore.duration;
    const startAfter = vpAfter.start;
    const windowAfter = vpAfter.duration;
    const statusText = await page.getByTestId('pyqt-STDTextEdit').innerText().catch(() => '');
    // Pull the agent's emitted command(s) out of the Actions tab for evidence.
    await page.getByTestId('agent-activity-actions').click().catch(() => {});
    const commandDiffs = await page.locator('[data-testid="agent-command-diff"]').allInnerTexts().catch(() => []);
    await page.screenshot({ path: join(outputRoot, 'copilot-live.png'), fullPage: true }).catch(() => {});

    const startOk = Number.isFinite(Number(startAfter)) && Math.abs(Number(startAfter) - TARGET_START) <= 3;
    const windowOk = Number.isFinite(Number(windowAfter)) && Math.abs(Number(windowAfter) - TARGET_WINDOW) <= 2;
    const passed = moved && startOk && windowOk;

    const report = {
      status: passed ? 'passed' : 'failed',
      agent_runtime: status?.agent_runtime,
      fixture_path: fixturePath,
      prompt,
      viewport: { start_before: startBefore, start_after: startAfter, window_before: windowBefore, window_after: windowAfter, target_start: TARGET_START, target_window: TARGET_WINDOW },
      assertions: { viewport_moved: moved, start_ok: startOk, window_ok: windowOk },
      command_evidence: commandDiffs.slice(0, 10),
      ingest_status_excerpt: (statusText.match(/Agent response received[^\n]*/) || [''])[0],
      console_errors: consoleEntries.filter((e) => e.type === 'error' && !/ResizeObserver loop|DevTools/i.test(e.text)).slice(-10),
      electron_log_tail: electronLogs.join('').split('\n').filter((l) => /agent|8001|uvicorn|emit_ui|qwen|set_viewport|ui_command/i.test(l)).slice(-15),
    };
    writeReport(report);
    console.log(JSON.stringify({ status: report.status, viewport: report.viewport, assertions: report.assertions, ingest: report.ingest_status_excerpt, report: outputPath }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch {} } }
    vite.child.kill();
  }
}

main().catch((e) => {
  writeReport({ status: 'failed', message: e instanceof Error ? e.message : String(e), electron_logs: diagnostics.electronLogs.join('').split('\n').slice(-40), vite_logs: diagnostics.viteLogs.join('').split('\n').slice(-40) });
  console.error(e);
  process.exit(1);
});
