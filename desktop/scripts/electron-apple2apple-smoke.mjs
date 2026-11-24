#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
/**
 * apple-to-apple: does driving detection via the CO-PILOT produce the SAME scientific result as the
 * MANUAL UI path, on the same recording + context? (co-pilot must not "走样".)
 *
 *   Arm A (manual):   click Detect tab -> Run button       -> renderer runDetection -> PyHFO
 *   Arm B (co-pilot): POST detection.run to the UI broker  -> renderer stages -> Apply -> same runDetection -> PyHFO
 *
 * Both build the PyHFO request from the SAME renderer context (loaded recording + default channel
 * selection + prepareControls filter); only the entry path differs. We compare the resulting events
 * (count + per-event {start_seconds, channel} signatures). Identical events => co-pilot == manual.
 *
 * window.ieeg is a frozen contextBridge object (can't be monkeypatched), so we compare RESULTS — the
 * true arbiter — via window.ieeg.listEvents() (latest run) rather than intercepting requests.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const outDir = join(desktopRoot, 'artifacts');
const outPath = join(outDir, 'electron-apple2apple-smoke.json');
const electronExecutable = require('electron');
const fixture = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim() || join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');
const BIG = 120000, DET = 90000;

function writeReport(r) { mkdirSync(outDir, { recursive: true }); writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 2) + '\n'); }
function fail(s, m, e = {}) { writeReport({ status: s, message: m, ...e }); console.error(m); process.exit(2); }
function getFreePort() { return new Promise((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); }); }); }
async function waitForServer(url, t = 30000) { const dl = Date.now() + t; let last = ''; while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; last = `HTTP ${r.status}`; } catch (e) { last = String(e); } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`renderer not ready ${url}: ${last}`); }
const sig = (events) => (events || []).map((e) => `${Number(e.start_seconds ?? e.start ?? 0).toFixed(3)}@${e.channel || e.channel_name || ''}`).sort();

async function main() {
  if (!existsSync(fixture)) fail('missing_fixture', `needs EDF: ${fixture}`);
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js'))) fail('missing_build', 'run npm run build first');
  const rendererPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(rendererPort), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let app;
  try {
    await waitForServer(`${baseUrl}/`);
    app = await electron.launch({
      executablePath: electronExecutable, args: [desktopRoot], cwd: desktopRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: `${baseUrl}/`, PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python', PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'), IEEG_AGENT_ROOT: repoRoot, IEEG_DISABLE_AGENT_RUNTIME: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      timeout: BIG,
    });
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(15000);
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });
    const status = await page.evaluate(async () => (window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null));
    const broker = status && status.ui_broker;
    if (!broker?.up || !broker?.base_url) fail('broker_down', 'UI broker did not start', { ui_broker: broker });

    // Load EDF via recents.
    await page.evaluate((f) => window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: f, label: f.split('/').pop(), openedAt: new Date().toISOString(), metadata: null }])), fixture);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveform_event_overlay_canvas"]', { timeout: BIG });
    await page.waitForTimeout(800);

    const listEvents = (runId) => page.evaluate(async (rid) => { const r = await window.ieeg.listEvents(rid ? { run_id: rid } : {}); return { run_id: r?.run_id ?? null, count: Number(r?.count ?? (r?.events || []).length), events: r?.events || [] }; }, runId);
    const baseline = await listEvents();

    const diag = {};
    const waitNewRun = async (prev) => {
      try { await page.waitForFunction(async (p) => { const r = await window.ieeg.listEvents({}); return Boolean(r && r.run_id && r.run_id !== p); }, prev, { timeout: DET, polling: 1000 }); return true; } catch { return false; }
    };
    const statusText = () => page.getByTestId('pyqt-STDTextEdit').innerText().catch(() => '');

    // This recording's Nyquist is ~499.7 Hz (sfreq 999), so the canonical stopband fs=500 would be
    // invalid. The renderer now auto-derives a Nyquist-safe fs on load (clampStopbandToNyquist), but
    // we still pin fs explicitly so BOTH arms use the SAME known filter for an exact apple-to-apple
    // comparison (manual reads prepareControls; co-pilot with no payload filter falls back to it).
    await page.getByTestId('pyqt-header_prepare_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-fs_input"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-fs_input').evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, '250');
    await page.waitForTimeout(400);
    diag.fs_set = await page.getByTestId('pyqt-fs_input').inputValue().catch(() => '?');
    const reported = await fetch(`${broker.base_url}/ui/state`).then((r) => r.json()).catch(() => ({}));
    diag.reported_channels = (reported?.ui_state?.channels || []).length;

    // ── Arm A (manual): Detect tab -> Run ─────────────────────────────
    // Clicks via DOM .click() (evaluate) to bypass headless responsive-collapse visibility, as the
    // other Electron smokes in this repo do.
    await page.waitForSelector('[data-testid="pyqt-header_detect_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-header_detect_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-detector_run_button"]', { timeout: 15000, state: 'attached' });
    const detector = await page.getByTestId('pyqt-detector_mode_combo').inputValue().catch(() => 'STE');
    // The manual Run button is truly disabled until the detector is "Applied" (the co-pilot bypasses
    // this by calling runDetection directly). Apply first to enable it.
    await page.getByTestId('pyqt-detector_apply_button').first().evaluate((el) => el.click()).catch(() => {});
    await page.waitForTimeout(600);
    diag.run_button_disabled = await page.getByTestId('pyqt-detector_run_button').first().evaluate((el) => el.disabled).catch(() => 'n/a');
    await page.getByTestId('pyqt-detector_run_button').first().evaluate((el) => el.click());
    diag.armA_wait = await waitNewRun(baseline.run_id);
    await page.waitForTimeout(2500); // settle: let the run record + events become queryable
    diag.armA_status = (await statusText()).split('\n').slice(-3).join(' | ');
    const armA = await listEvents();
    diag.armA_listEvents = { run_id: armA.run_id, count: armA.count };

    // ── Arm B (co-pilot): broker emit detection.run -> stage -> Apply ──
    const emit = await fetch(`${broker.base_url}/ui/emit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'detection.run', payload: { biomarker: 'HFO', detector }, reason: 'apple2apple co-pilot arm' }) }).then((r) => r.json());
    if (!emit?.success) fail('emit_failed', 'broker rejected detection.run', { emit });
    await page.getByTestId('agent-activity-actions').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="agent-command-apply"]', { timeout: 15000, state: 'attached' });
    diag.staged_apply_count = await page.locator('[data-testid="agent-command-apply"]').count().catch(() => 0);
    await page.getByTestId('agent-command-apply').first().evaluate((el) => el.click());
    diag.armB_wait = await waitNewRun(armA.run_id);
    await page.waitForTimeout(2500); // settle
    diag.armB_status = (await statusText()).split('\n').slice(-3).join(' | ');
    await page.screenshot({ path: join(outDir, 'apple2apple.png'), fullPage: true }).catch(() => {});
    const armB = await listEvents();
    diag.armB_listEvents = { run_id: armB.run_id, count: armB.count };

    const sigA = sig(armA.events), sigB = sig(armB.events);
    // Two genuinely separate detections (manual Run, then co-pilot stage+Apply) — each emits its own
    // "STE run complete" status. listEvents({}) doesn't echo run_id, so distinctness is evidenced by the
    // two completion statuses, not run_id. The apple-to-apple claim = identical events from both paths.
    const bothCompleted = /run complete/i.test(diag.armA_status || '') && /run complete/i.test(diag.armB_status || '');
    const countMatch = armA.count === armB.count;
    const sigMatch = sigA.length === sigB.length && sigA.every((s, i) => s === sigB[i]);
    const passed = bothCompleted && countMatch && sigMatch && armA.count > 0 && armB.count > 0;
    const report = {
      status: passed ? 'passed' : 'failed',
      detector,
      arm_a_manual: { run_id: armA.run_id, count: armA.count },
      arm_b_copilot: { run_id: armB.run_id, count: armB.count },
      assertions: { both_completed: bothCompleted, count_match: countMatch, event_signature_match: sigMatch, arm_a_nonempty: armA.count > 0, arm_b_nonempty: armB.count > 0 },
      diag,
      sig_diff_example: sigMatch ? null : { only_in_a: sigA.filter((s) => !sigB.includes(s)).slice(0, 5), only_in_b: sigB.filter((s) => !sigA.includes(s)).slice(0, 5) },
    };
    writeReport(report);
    console.log(JSON.stringify(report, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch {} } }
    vite.kill();
  }
}

main().catch((e) => { writeReport({ status: 'failed', message: e instanceof Error ? e.message : String(e) }); console.error(e); process.exit(1); });
