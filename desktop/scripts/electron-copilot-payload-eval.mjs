#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
/**
 * Workstream E — real-LLM payload-correctness eval.
 *
 * Drives the REAL co-pilot (runtime + model from user_config.yaml) through the chat composer with
 * clinician-phrased prompts that previously alias-drifted, and verifies the agent emitted the RIGHT
 * command with the RIGHT payload keys by checking the actual STATE EFFECT via the expanded
 * get_ui_state (Workstream A). A wrong/missing key no-ops -> the field does NOT change -> FAIL. Each
 * probe resets the target field via the broker first (so an idempotent value can't false-pass), then
 * asks the agent, then polls the field for the expected value. N-run averaged (model is stochastic).
 *
 * Requires a real model/API key (user_config.yaml) + network. NOT in the deterministic CI suite.
 * Run: node scripts/electron-copilot-payload-eval.mjs   (IEEG_PAYLOAD_EVAL_RUNS=N, default 2)
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
const outPath = join(outDir, 'electron-copilot-payload-eval.json');
const electronExecutable = require('electron');
const fixture = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim() || join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');
const RUNS = Math.max(1, parseInt(process.env.IEEG_PAYLOAD_EVAL_RUNS || '2', 10));
const REPLY_TIMEOUT = parseInt(process.env.IEEG_PAYLOAD_EVAL_REPLY_TIMEOUT || '120000', 10);
const BIG = 120000;

function writeReport(r) { mkdirSync(outDir, { recursive: true }); writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 2) + '\n'); }
function fail(s, m, e = {}) { writeReport({ status: s, message: m, ...e }); console.error(m); process.exit(2); }
function getFreePort() { return new Promise((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => res(a.port)); }); }); }
async function waitForServer(url, t = 30000) { const dl = Date.now() + t; while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`dev server not ready at ${url}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const path = (obj, dotted) => dotted.split('.').reduce((cur, k) => (cur && typeof cur === 'object' ? cur[k] : undefined), obj);

// Each probe: a clinician prompt + the field that must change + the value the agent should produce.
// `reset` is emitted deterministically via the broker BEFORE the prompt so an already-correct value
// can't false-pass; `check(state)` returns true once the agent's command actually took effect.
const PROBES = [
  { key: 'set_display(show_filtered)', prompt: 'Show me the band-pass filtered trace.', reset: { type: 'waveform.set_display', payload: { show_filtered: false } }, check: (s) => path(s, 'waveform.showFiltered') === true },
  { key: 'set_parameters(notch+band)', prompt: 'Set the line-noise notch to 60 Hz and the detection filter band to fp 80 and fs 250.', reset: { type: 'detection.set_parameters', payload: { filter: { fp: 1, fs: 2 }, line_noise_notch_hz: 50 } }, check: (s) => Number(path(s, 'prepare.line_noise_notch_hz')) === 60 && Number(path(s, 'prepare.filter.fp')) === 80 && Number(path(s, 'prepare.filter.fs')) === 250 },
  { key: 'set_amplitude(3x)', prompt: 'Set the waveform amplitude scale to 3x.', reset: { type: 'waveform.set_amplitude_scale', payload: { amplitude_scale: 1 } }, check: (s) => Number(path(s, 'waveform.amplitudeScale')) === 3 },
  { key: 'set_viewport(60s)', prompt: 'Jump the waveform to 60 seconds.', reset: { type: 'waveform.set_viewport', payload: { start_seconds: 0, duration_seconds: 8 } }, check: (s) => Math.abs(Number(path(s, 'viewport.start_seconds')) - 60) <= 3 },
];

async function main() {
  if (!existsSync(fixture)) fail('missing_fixture', `Set PYHFO_ELECTRON_REAL_FIXTURE_RECORDING to a local EDF. Missing fixture: ${fixture}`);
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js'))) fail('missing_build', 'run npm run build first');
  const rendererPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(rendererPort), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let app;
  const probeResults = PROBES.map((p) => ({ key: p.key, prompt: p.prompt, runs: 0, passed: 0, details: [] }));
  try {
    await waitForServer(`${baseUrl}/`);
    app = await electron.launch({
      executablePath: electronExecutable, args: [desktopRoot], cwd: desktopRoot,
      env: { ...process.env, VITE_DEV_SERVER_URL: `${baseUrl}/`, PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python', PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'), IEEG_AGENT_ROOT: repoRoot, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
      timeout: BIG,
    });
    const logs = []; const proc = app.process();
    proc?.stdout?.on('data', (c) => logs.push(String(c))); proc?.stderr?.on('data', (c) => logs.push(String(c)));
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(20000);
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });

    // The agent runtime + UI broker boot asynchronously after the window; wait up to 90s for both.
    let status = null;
    const bootDl = Date.now() + 90000;
    while (Date.now() < bootDl) {
      status = await page.evaluate(async () => (window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null));
      if (status?.agent_runtime?.up && status?.ui_broker?.up) break;
      await sleep(2000);
    }
    if (!status?.agent_runtime?.up) fail('agent_down', 'Agent runtime did not start; cannot run real-model eval', { status, log: logs.join('').split('\n').slice(-30) });
    const broker = status?.ui_broker;
    if (!broker?.up || !broker?.base_url) fail('broker_down', 'UI broker did not start (needed to read/reset state)', { ui_broker: broker });
    const B = broker.base_url;

    await page.evaluate((f) => window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: f, label: f.split('/').pop(), openedAt: new Date().toISOString(), metadata: null }])), fixture);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveform_event_overlay_canvas"]', { timeout: BIG });
    await sleep(2000);

    const state = async () => fetch(`${B}/ui/state`).then((r) => r.json()).then((d) => d.ui_state || {}).catch(() => ({}));
    const emit = (type, payload) => fetch(`${B}/ui/emit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload, reason: 'eval reset' }) }).then((r) => r.json()).catch(() => ({}));
    const ask = async (prompt) => {
      await page.getByTestId('agent-activity-chat').click({ timeout: 8000 }).catch(() => {});
      const before = await page.getByTestId('agent-chat-agent-message').count().catch(() => 0);
      await page.fill('#agent-prompt-input', prompt);
      await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="agent-chat-agent-message"]').length > n, before, { timeout: REPLY_TIMEOUT, polling: 1000 }).catch(() => {});
      return (await page.getByTestId('agent-chat-agent-message').last().innerText().catch(() => '')).trim();
    };

    for (let run = 1; run <= RUNS; run += 1) {
      console.log(`\n──── run ${run}/${RUNS} ────`);
      for (let i = 0; i < PROBES.length; i += 1) {
        const probe = PROBES[i]; const res = probeResults[i];
        await emit(probe.reset.type, probe.reset.payload); await sleep(1500); // deterministic reset so idempotent values can't false-pass
        const reply = await ask(probe.prompt);
        let ok = false;
        const dl = Date.now() + 12000;
        while (Date.now() < dl) { if (probe.check(await state())) { ok = true; break; } await sleep(1000); }
        res.runs += 1; if (ok) res.passed += 1;
        res.details.push({ run, ok, reply: reply.slice(0, 160) });
        console.log(`[${ok ? 'PASS' : 'FAIL'}] ${probe.key.padEnd(30)} (run ${run})  reply="${reply.slice(0, 70)}"`);
      }
    }

    const probesPassed = probeResults.filter((r) => r.passed === r.runs && r.runs > 0).length;
    const totalRate = probeResults.reduce((a, r) => a + r.passed, 0) / Math.max(1, probeResults.reduce((a, r) => a + r.runs, 0));
    const report = { status: probeResults.every((r) => r.passed > 0) ? 'passed' : 'failed', fixture, runs: RUNS, probes_all_pass: probesPassed, probe_count: PROBES.length, overall_pass_rate: Number(totalRate.toFixed(3)), probes: probeResults };
    writeReport(report);
    console.log(`\n=== PAYLOAD EVAL: ${probesPassed}/${PROBES.length} probes passed all ${RUNS} runs; overall ${(totalRate * 100).toFixed(0)}% -> ${outPath} ===`);
    for (const r of probeResults) console.log(`  ${r.key.padEnd(30)} ${r.passed}/${r.runs}`);
    if (!report.status || report.status !== 'passed') process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch {} } }
    vite.kill();
  }
}

main().catch((e) => { writeReport({ status: 'failed', message: e instanceof Error ? e.message : String(e) }); console.error(e); process.exit(1); });
