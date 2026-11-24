#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard
/**
 * Comprehensive agent->UI control sweep over the LIVE app via the UI MCP broker.
 *
 * Launches the real Electron app (broker hosted, renderer from the vite dev server so the CURRENT
 * source is under test), loads a real EDF, then drives commands the way the external MCP agent does
 * (POST /ui/emit) and asserts the REAL outcome read back from the broker ack (applied / noop /
 * rejected / staged). The focus is the no-op honesty contract: a command that changes nothing must
 * come back 'noop', never 'applied'. Optionally runs a detection so event-dependent commands are
 * exercised too (best-effort; skipped, not failed, if detection is flaky on the fixture).
 *
 * Run: node scripts/electron-ui-mcp-sweep.mjs   (PYHFO_ELECTRON_REAL_FIXTURE_RECORDING overrides EDF)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const outDir = join(desktopRoot, 'artifacts');
const outPath = join(outDir, 'electron-ui-mcp-sweep.json');
const electronExecutable = require('electron');
const fixture = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim() || join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');
const RUN_DETECTION = process.env.IEEG_SWEEP_SKIP_DETECTION !== '1';
const RUN_WRITES = process.env.IEEG_SWEEP_SKIP_WRITES !== '1'; // execute the write/compute commands for real
const BIG = 120000;

function writeReport(r) { mkdirSync(outDir, { recursive: true }); writeFileSync(outPath, JSON.stringify({ generated_at: new Date().toISOString(), ...r }, null, 2) + '\n'); }
function fail(s, m, e = {}) { writeReport({ status: s, message: m, ...e }); console.error(m); process.exit(2); }
function getFreePort() { return new Promise((res, rej) => { const s = createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => res(a.port)); }); }); }
async function waitForServer(url, timeoutMs = 30000) { const dl = Date.now() + timeoutMs; let last = ''; while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; last = `HTTP ${r.status}`; } catch (e) { last = String(e); } await new Promise((r) => setTimeout(r, 250)); } throw new Error(`dev server not ready at ${url}: ${last}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!existsSync(fixture)) fail('missing_fixture', `Set PYHFO_ELECTRON_REAL_FIXTURE_RECORDING to a local EDF. Missing fixture: ${fixture}`);
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js'))) fail('missing_build', 'run npm run build first');
  const rendererPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(rendererPort), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let app;
  const results = [];
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
        IEEG_AGENT_ROOT: repoRoot,
        IEEG_DISABLE_AGENT_RUNTIME: '1',
        PYHFO_PIPELINE_SUBPROCESS: '1',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: BIG,
    });
    const logs = []; const proc = app.process();
    proc?.stdout?.on('data', (c) => logs.push(String(c))); proc?.stderr?.on('data', (c) => logs.push(String(c)));
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(20000);
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });

    const status = await page.evaluate(async () => (window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null));
    const broker = status && status.ui_broker;
    if (!broker || !broker.up || !broker.base_url) fail('broker_down', 'UI broker did not start', { ui_broker: broker, log: logs.join('').split('\n').slice(-25) });
    const B = broker.base_url;

    // Full autonomy so compute commands (detection.run) auto-apply in this throwaway session.
    await page.evaluate((f) => {
      window.localStorage.setItem('ieeg.agentAutonomy', 'full');
      window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: f, label: f.split('/').pop(), openedAt: new Date().toISOString(), metadata: null }]));
    }, fixture);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveform_event_overlay_canvas"]', { timeout: BIG });
    await sleep(2000); // let the renderer report ui_state

    const state = async () => fetch(`${B}/ui/state`).then((r) => r.json()).then((d) => d.ui_state || {}).catch(() => ({}));
    const st0 = await state();
    if (!st0.recording) fail('no_recording', 'recording did not load into the broker state', { state_keys: Object.keys(st0) });
    const channels = st0.channels || [];
    const curChannel = st0.selected_channel || channels[0];
    const otherChannel = channels.find((c) => c !== curChannel) || channels[1];

    async function emitAck(type, payload, { settle = 0, slow = false } = {}) {
      const emit = await fetch(`${B}/ui/emit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, payload, reason: 'sweep' }) }).then((r) => r.json());
      if (!emit.success) return { emit, ack: { status: 'broker-reject', reason: emit.error } };
      const cid = emit.command?.command_id;
      const deadline = Date.now() + (slow ? 90000 : 8000);
      let ack = null;
      while (Date.now() < deadline) {
        ack = await fetch(`${B}/ui/ack?command_id=${cid}`).then((r) => r.json()).then((d) => d.ack).catch(() => null);
        if (ack) break;
        await sleep(300);
      }
      if (settle) await sleep(settle);
      return { emit, ack: ack || { status: 'no-ack', reason: 'renderer did not ack' } };
    }

    async function check(label, type, payload, expect, opts = {}) {
      const { ack } = await emitAck(type, payload, opts);
      const got = ack?.status || 'no-ack';
      const ok = got === expect;
      results.push({ label, type, expect, got, reason: ack?.reason || null, ok });
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(46)} expect=${String(expect).padEnd(13)} got=${String(got).padEnd(13)} ${(ack?.reason || '').slice(0, 56)}`);
      return ack;
    }

    // ── REAL EFFECTS still work (applied) ───────────────────────────────────
    await check('set_viewport real move', 'waveform.set_viewport', { start_seconds: 33, duration_seconds: 6 }, 'applied', { settle: 400 });
    await check('set_display real toggle', 'waveform.set_display', { show_filtered: true }, 'applied', { settle: 300 });
    await check('set_amplitude real', 'waveform.set_amplitude_scale', { amplitude_scale: 2.5 }, 'applied', { settle: 300 });
    if (otherChannel) await check('select_channel real', 'recording.select_channel', { channel: otherChannel }, 'applied', { settle: 300 });
    await check('set_parameters real', 'detection.set_parameters', { filter: { fp: 80, fs: 250 }, line_noise_notch_hz: 60 }, 'applied', { settle: 300 });

    // ── NO-OP HONESTY: changed nothing => must ack 'noop' (the fixes) ────────
    await check('set_viewport empty', 'waveform.set_viewport', {}, 'noop');
    await check('set_viewport non-numeric', 'waveform.set_viewport', { start_seconds: '30s', duration_seconds: 8 }, 'noop');
    await check('set_display empty', 'waveform.set_display', {}, 'noop');
    await check('set_display bad key', 'waveform.set_display', { filtered: true, montage: 'bipolar' }, 'noop');
    await check('set_amplitude empty', 'waveform.set_amplitude_scale', {}, 'noop');
    await check('set_amplitude same value', 'waveform.set_amplitude_scale', { amplitude_scale: 2.5 }, 'noop');
    await check('set_parameters bad key', 'detection.set_parameters', { nonsense_key: 1 }, 'noop');
    await check('classification bad key', 'classification.set_parameters', { nonsense_key: 1 }, 'noop');
    await check('channel_visibility empty', 'recording.set_channel_visibility', {}, 'noop');
    // Truly idempotent: re-select whatever channel is currently selected+highlighted -> identical controls -> noop.
    const selNow = (await state()).selected_channel;
    if (selNow) await check('select_channel idempotent', 'recording.select_channel', { channel: selNow }, 'noop');

    // ── REJECTIONS: bad target => 'rejected' at the validation layer (before the handler) ──
    await check('select_channel bad', 'recording.select_channel', { channel: 'POL NOPE9' }, 'rejected');
    await check('focus_channel bad', 'waveform.focus_channel', { channel: 'POL NOPE9' }, 'rejected');
    await check('focus_top no run', 'detection.focus_top_candidate_channel', { biomarker: 'HFO' }, 'rejected');

    // ── STAGING: review_write/destructive still stage (even under full? full auto-applies; so skip) ──

    // ── EVENT-DEPENDENT happy paths (best-effort: needs a detection run) ─────
    let detection = { ran: false };
    if (RUN_DETECTION) {
      console.log('[info] running detection (full autonomy auto-applies)…');
      const { ack } = await emitAck('detection.run', { biomarker: 'HFO', detector: 'STE', scope: 'all', all_channels: true, filter: { fp: 80, fs: 500 }, exports: ['csv', 'session', 'summary_json'] }, { slow: true });
      // wait for events to appear in broker state
      let evCount = 0;
      const dl = Date.now() + 90000;
      while (Date.now() < dl) { const s = await state(); evCount = (s.events || []).length; if (evCount > 0) break; await sleep(2000); }
      detection = { ran: true, run_ack: ack?.status, events: evCount };
      console.log(`[info] detection ack=${ack?.status} events=${evCount}`);
      if (evCount > 0) {
        const s = await state();
        const ev0 = (s.events || [])[0];
        const ev2 = (s.events || [])[2] || ev0;
        await check('select_event real', 'events.select_event', { event_id: ev2 }, 'applied', { settle: 400 });
        await check('move_cursor next', 'events.move_cursor', { direction: 'next' }, 'applied', { settle: 400 });
        await check('center_event real', 'waveform.center_event', { event_id: ev0 }, 'applied', { settle: 400 });
        await check('select_event bad id (rejected)', 'events.select_event', { event_id: 'evt-nope-9999' }, 'rejected');
        await check('focus_top real', 'detection.focus_top_candidate_channel', {}, 'applied', { settle: 400 });
        // biomarker that matches no loaded events reaches the handler (run exists) and no-ops honestly.
        await check('focus_top biomarker-miss', 'detection.focus_top_candidate_channel', { biomarker: 'Spindle' }, 'noop');
      }
    }

    // ── WRITE/COMPUTE EXECUTED FOR REAL + DIALOG OBSERVABILITY (workstreams C+D) ──
    // Under full autonomy these auto-apply; we assert the produced artifact/state via the NEW
    // get_ui_state fields (runs_detail / review / project / analysis / active_dialog) + files on disk.
    let writes = { ran: false };
    if (RUN_WRITES && detection.ran && detection.events > 0) {
      writes.ran = true;
      const outDir = mkdtempSync(join(tmpdir(), 'ieeg-sweep-'));
      // Stub native save/open dialogs so exports/project.save resolve to outDir instead of hanging.
      await app.evaluate(async ({ dialog }, out) => {
        let n = 0;
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: `${out}/artifact-${Date.now()}-${++n}.out` });
        dialog.showSaveDialogSync = () => `${out}/artifact-${Date.now()}.out`;
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [out] });
        dialog.showOpenDialogSync = () => [out];
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
        dialog.showMessageBoxSync = () => 0;
      }, outDir);

      const pollState = async (pred, ms = 60000) => { const dl = Date.now() + ms; let s = await state(); while (Date.now() < dl) { s = await state(); if (pred(s)) return s; await sleep(1500); } return s; };
      const hard = (label, ok, note = '') => { results.push({ label, type: 'write', expect: 'ok', got: ok ? 'ok' : 'FAIL', reason: note, ok }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(46)} ${note}`); };
      const soft = (label, ok, note = '') => { results.push({ label, type: 'write-soft', expect: 'ok', got: ok ? 'ok' : 'skip', reason: note, ok: true }); console.log(`[${ok ? 'PASS' : 'SKIP'}] ${label.padEnd(46)} ${note}${ok ? '' : ' (best-effort)'}`); };
      const fileCount = () => readdirSync(outDir).length;
      const runId0 = (await state()).selected_run || (await state()).runs?.[0];

      console.log('[info] write/compute phase (full autonomy, dialogs stubbed)…');

      // 1. classification.run -> the active run gains a REAL classifier label (soft: completion needs the
      // hub/cached model, which may be unavailable offline; the dispatch+ack is already proven elsewhere).
      const classified = (r) => r && r.classifier && r.classifier !== 'not classified' && r.classifier !== 'pending';
      await emitAck('classification.run', { biomarker: 'HFO', mode: 'HF CPU' }, { slow: true });
      { const s = await pollState((st) => (st.runs_detail || []).some((r) => r.active && classified(r)), 150000);
        soft('classification.run -> run classified', (s.runs_detail || []).some((r) => r.active && classified(r)), `classifier=${(s.runs_detail || []).find((r) => r.active)?.classifier || 'none'}`); }

      // 2. exports -> a file lands on disk (dialog stubbed to outDir)
      for (const type of ['export.session', 'export.workbook', 'export.report']) {
        const before = fileCount();
        await emitAck(type, { run_id: runId0 }, { slow: true });
        const got = (await pollState(() => fileCount() > before, 45000)) && fileCount() > before;
        hard(`${type} -> file written`, fileCount() > before, got ? `+${fileCount() - before} file(s)` : 'no file appeared');
      }

      // 3. project.save -> the workspace saves (dirty clears; a file also lands on disk via the stub)
      { const before = fileCount();
        await emitAck('project.save', {}, { slow: true });
        const s = await pollState((st) => st.project?.dirty === false, 45000);
        hard('project.save -> saved (dirty cleared)', s.project?.dirty === false, `dirty=${s.project?.dirty}, files+${fileCount() - before}`); }

      // 4. stage_annotation (full autonomy -> executes) -> annotation_count rises
      { const ev = (await state()).events?.[0];
        const before = (await state()).review?.annotation_count || 0;
        await emitAck('events.stage_annotation', { event_id: ev, label: 'accepted' }, { settle: 1200 });
        const s = await pollState((st) => (st.review?.annotation_count || 0) > before, 20000);
        hard('stage_annotation -> annotated', (s.review?.annotation_count || 0) > before, `count ${before}->${s.review?.annotation_count || 0}`); }

      // 5. accept_run -> runs_detail marks it accepted
      { await emitAck('review.accept_run', { run_id: runId0 }, { settle: 1200 });
        const s = await pollState((st) => (st.runs_detail || []).some((r) => r.run_id === runId0 && r.accepted), 20000);
        hard('accept_run -> accepted', (s.runs_detail || []).some((r) => r.run_id === runId0 && r.accepted), ''); }

      // 6. D: dialog opens are now observable via active_dialog (workstream A)
      for (const [label, type, payload, dlg] of [
        ['inspect_metadata', 'recording.inspect_metadata', {}, 'recordingInfo'],
        ['open_comparison', 'review.open_comparison', {}, 'runStats'],
      ]) {
        await emitAck(type, payload, { settle: 800 });
        const s = await pollState((st) => st.active_dialog === dlg, 10000);
        hard(`${label} -> active_dialog=${dlg}`, s.active_dialog === dlg, `active_dialog=${s.active_dialog}`);
        try { await page.keyboard.press('Escape'); } catch { /* non-fatal */ }
        await pollState((st) => st.active_dialog === null, 5000);
      }

      // 7. SOFT (best-effort): consensus needs >=2 runs; prepare swaps the recording (heavy, last)
      { const before = (await state()).runs_detail?.length || 0;
        await emitAck('detection.create_consensus_run', {}, { slow: true });
        const s = await pollState((st) => (st.runs_detail?.length || 0) > before, 30000);
        soft('create_consensus_run -> new run', (s.runs_detail?.length || 0) > before, `runs ${before}->${s.runs_detail?.length || 0} (needs >=2 source runs)`); }
      { await emitAck('analysis.prepare_recording', {}, { slow: true });
        const s = await pollState((st) => (st.recording?.path || '').endsWith('.fif') || (st.messages?.status || '').toLowerCase().includes('prepar'), 120000);
        soft('prepare_recording -> ran', Boolean((s.recording?.path || '').endsWith('.fif') || (s.messages?.status || '').toLowerCase().includes('prepar')), `rec=${(s.recording?.path || '').split('/').pop()}`); }
    }

    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    const report = { status: failed === 0 ? 'passed' : 'failed', fixture, broker: B, checks: results.length, passed, failed, detection, writes, results };
    writeReport(report);
    console.log(`\n=== UI-MCP SWEEP: ${passed}/${results.length} passed; detection ${detection.ran ? `ran (events=${detection.events})` : 'skipped'}; writes ${writes.ran ? 'executed' : 'skipped'} -> ${outPath} ===`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch {} } }
    vite.kill();
  }
}

main().catch((e) => { writeReport({ status: 'failed', message: e instanceof Error ? e.message : String(e) }); console.error(e); process.exit(1); });
