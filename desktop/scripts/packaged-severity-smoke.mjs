#!/usr/bin/env node
// Drives the unpacked Windows build from electron-builder end to end.
// Set SEVERITY_SMOKE_RECORDING to a scalp recording with the standard channels for the 18-pair bipolar montage.
//
// This is deliberately not severity-tab-smoke.mjs with a different executable path: that script
// needs a Vite dev server and imports `/src/**.ts` straight into the page, neither of which exists
// in a packaged build. What packaging can actually break is different, so that is what is checked
// here -- the app resolves and spawns the BUNDLED backend (no system Python anywhere), the frozen
// torch/transformers stack survives being frozen, and the built renderer still gates the Severity
// tab on scalp EEG.
//
// Electron must NOT inherit ELECTRON_RUN_AS_NODE: it turns electron.exe into plain Node and the
// app never boots. Unset below.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE;
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import { packagedAppPath, requiredRecording } from './lib/qa-paths.mjs';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outDir = join(desktopRoot, 'artifacts', 'packaged-severity');
const RECORDING = requiredRecording('SEVERITY_SMOKE_RECORDING', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING');
const STARTUP_MS = 180000;
// Throwaway profile per run. Electron persists recent recordings and workspace state into userData,
// so once anyone has used the app for real, the next launch RESTORES that recording: there is no
// empty-state Open button to click, and the restore starts a fresh backend session that discards a
// severity result this run just stored. That made the smoke fail against a perfectly good build.
const USER_DATA_DIR = join(tmpdir(), `ieeg-smoke-userdata-${process.pid}`);

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  rmSync(USER_DATA_DIR, { recursive: true, force: true });
  if (!existsSync(packagedAppPath)) throw new Error(`packaged app not found: ${packagedAppPath} (run npm run package:win)`);

  const logs = [];
  let app;
  try {
    // No PYHFO_BACKEND_PYTHON and no PYHFO_APP_ROOT on purpose: if the packaged app still needs a
    // system Python or the source tree, this run must fail rather than quietly pass on the dev box.
    // IEEG_DISABLE_AGENT_RUNTIME is deliberately NOT set: the co-pilot runtime is bundled now, so
    // this run has to prove it actually starts from the package rather than skipping past it.
    app = await electron.launch({
      executablePath: packagedAppPath,
      args: [`--user-data-dir=${USER_DATA_DIR}`],
      env: {
        ...process.env,
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '180000',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: STARTUP_MS,
    });
    const proc = app.process();
    proc?.stdout?.on('data', (c) => logs.push(String(c)));
    proc?.stderr?.on('data', (c) => logs.push(String(c)));

    const page = await app.firstWindow({ timeout: STARTUP_MS });
    page.on('console', (m) => logs.push(`[renderer:${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
    await page.waitForLoadState('domcontentloaded');
    await page.screenshot({ path: join(outDir, '01-launch.png') });
    check('packaged app launches and renders', true, packagedAppPath);

    // The backend is a sibling resource of the app, spawned by main.ts. If it did not come up, the
    // very first IPC call fails -- which is the real assertion here.
    const backendPath = await app.evaluate(async () => process.env.PYHFO_BACKEND_EXECUTABLE ?? null);
    check('app resolved the bundled backend executable',
      typeof backendPath === 'string' && backendPath.includes('pyhfo-backend'), String(backendPath));

    // Co-pilot: the runtime binary must be both configured AND actually running. main.ts only sets
    // PYHFO_AGENT_CHAT_URL / AGENT_SERVICE_TOKEN once startAgentRuntime() has come up healthy, so
    // those are the honest signals -- a resolved path alone would pass even with no binary present.
    // Keep this callback dependency-free: app.evaluate() runs in the main process where dynamic
    // import() is unavailable, so read the env here and do the filesystem check back in this process.
    const agent = await app.evaluate(async () => ({
      configured: process.env.IEEG_AGENT_RUNTIME_EXECUTABLE ?? null,
      chatUrl: process.env.PYHFO_AGENT_CHAT_URL ?? null,
      hasToken: Boolean(process.env.AGENT_SERVICE_TOKEN),
    }));
    check('agent runtime binary is bundled',
      Boolean(agent.configured) && existsSync(agent.configured), String(agent.configured));
    check('agent runtime started (co-pilot chat enabled)',
      typeof agent.chatUrl === 'string' && agent.chatUrl.startsWith('http') && agent.hasToken,
      `chatUrl=${agent.chatUrl} token=${agent.hasToken}`);

    const loaded = await page.evaluate(async (path) => {
      const res = await window.ieeg.loadRecording(path);
      return { eegType: res?.result?.eeg_type ?? res?.eeg_type ?? null, error: res?.error?.message ?? null };
    }, RECORDING);
    check('bundled backend loads a real recording', loaded.error === null, loaded.error || 'no error');
    check('backend reports eeg_type=scalp', loaded.eegType === 'scalp', `eeg_type=${loaded.eegType}`);

    // The point of the whole packaging exercise: torch + transformers + the BASED checkpoint,
    // frozen, actually producing scores.
    const started = Date.now();
    const scored = await page.evaluate(async (path) => {
      const res = await window.ieeg.runSeverityScoring({ input_path: path });
      const r = res?.result ?? res;
      return {
        status: r?.status, segments: r?.num_segments, mean: r?.mean_score,
        peak: r?.peak_score, scores: (r?.scores || []).length,
        error: res?.error?.message ?? r?.error ?? null,
      };
    }, RECORDING);
    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    check('severity scoring completes in the packaged app',
      scored.status === 'complete', `${JSON.stringify(scored)} in ${elapsedSec}s`);
    check('one score per 15s segment',
      scored.segments > 0 && scored.scores === scored.segments,
      `segments=${scored.segments} scores=${scored.scores}`);
    check('mean/peak are finite and within the 0-5 scale',
      Number.isFinite(scored.mean) && Number.isFinite(scored.peak)
      && scored.mean >= 0 && scored.peak <= 5, `mean=${scored.mean} peak=${scored.peak}`);

    const fetched = await page.evaluate(async () => {
      const res = await window.ieeg.getSeverityResult();
      return { status: res?.status, mean: res?.result?.mean_score };
    });
    check('stored result is retrievable', fetched.status === 'complete' && Number.isFinite(fetched.mean),
      JSON.stringify(fetched));

    // --- Real UI flow -------------------------------------------------------------------
    // Everything above drove the backend over IPC, which deliberately bypasses React state --
    // the renderer only learns about a recording when the UI itself opens one (App.tsx), so the
    // Severity tab cannot appear from an IPC load no matter how long we wait. Drive the genuine
    // path instead: the ONLY thing stubbed is the native file dialog, which cannot be automated.
    await app.evaluate(async ({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, RECORDING);

    await page.getByTestId('pyqt-empty_open_button').click();
    // Opening runs a real backend load; wait on the resulting UI, not a fixed sleep.
    // Severity is a scalp-gated card in the pipeline rail (mirroring the PyQt inspector), so it is
    // visible straight after the recording opens -- no tab to select, no panel to expand.
    await page.getByTestId('pyqt-sidebar_severity_card').waitFor({ state: 'visible', timeout: 120000 });
    check('Severity card appears in the pipeline rail for a scalp recording', true);

    // Montage: a scalp recording must open on bipolar, and the popover must offer four
    // selectable montages (the old build rendered three plus an unclickable status badge).
    const montageLabel = (await page.getByTestId('pyqt-montage_summary_button').textContent()) || '';
    check('scalp recording opens on the automatic bipolar montage', montageLabel.includes('Auto: Bipolar'),
      `label=${montageLabel.trim()}`);
    await page.getByTestId('pyqt-montage_summary_button').click();
    const montageButtons = ['pyqt-referential_tool_button', 'pyqt-average_reference_button',
      'pyqt-bipolar_montage_button', 'pyqt-auto_bipolar_button'];
    const enabled = [];
    for (const id of montageButtons) {
      const locator = page.getByTestId(id);
      enabled.push((await locator.count()) === 1 && await locator.isEnabled());
    }
    check('montage popover offers four selectable options', enabled.every(Boolean),
      montageButtons.map((id, i) => `${id.replace('pyqt-', '')}=${enabled[i]}`).join(' '));
    check('no unclickable pseudo-option remains',
      (await page.getByTestId('pyqt-montage_status_badge').count()) === 0);

    // The Montage editor must show the montage you are ON, not just an add-a-pair form.
    await page.getByTestId('pyqt-bipolar_button').click();
    await page.getByTestId('pyqt-bipolar_current_montage_card').waitFor({ state: 'visible', timeout: 15000 });
    const pairRows = await page.getByTestId('pyqt-bipolar_pair_row').count();
    check('montage editor lists the pairs currently in use', pairRows === 18, `rows=${pairRows}`);
    const firstPair = (await page.getByTestId('pyqt-bipolar_pair_row').first().textContent()) || '';
    check('pairs are listed without the internal token', firstPair.includes('Fp1-F3') && !firstPair.includes('#-#'),
      `first=${firstPair.trim()}`);
    check('scalp reset is offered', (await page.getByTestId('pyqt-bipolar_conventional_button').count()) === 1);
    await page.screenshot({ path: join(outDir, '04-montage-editor.png') });
    await page.getByTestId('pyqt-bipolar_cancel_button').click();
    await page.screenshot({ path: join(outDir, '03-montage-popover.png') });
    await page.keyboard.press('Escape');

    // The centre workflow panel must still carry exactly upstream's three tabs.
    const severityTabCount = await page.getByTestId('workflow-tab-severity').count();
    check('centre workflow tabs are unchanged from upstream', severityTabCount === 0,
      `workflow-tab-severity count=${severityTabCount}`);

    await page.getByTestId('workflow-severity-content').waitFor({ state: 'visible', timeout: 15000 });
    const badge = (await page.getByTestId('severity-eeg-type').textContent().catch(() => '')) || '';
    check('Severity tab reports the recording as scalp', badge.toLowerCase().includes('scalp'), `badge=${badge.trim()}`);

    // Score through the button a user actually clicks, not the IPC bridge.
    await page.getByTestId('severity-run-button').click();
    // Wait on the DATA, not on visibility. severity-summary-card renders immediately with em-dash
    // placeholders (visible while the run is still in flight, so it proves nothing), and the
    // timeline bars sit below the panel's scroll fold -- they are attached and correct but never
    // 'visible' to Playwright, which previously hung this check for its full timeout.
    const deadline = Date.now() + 900000;
    let barCount = 0;
    while (Date.now() < deadline) {
      barCount = await page.getByTestId('severity-histogram-bar').count();
      if (barCount > 0) break;
      await page.waitForTimeout(500);
    }

    const errorCount = await page.getByTestId('severity-error').count();
    check('no error surfaced by the Severity tab', errorCount === 0, `errors=${errorCount}`);

    const bars = barCount;
    check('timeline renders per-segment bars', bars > 0, `bars=${bars}`);
    const meanText = (await page.getByTestId('severity-stat-mean').textContent().catch(() => '')) || '';
    check('summary shows a real score, not the placeholder', !meanText.includes('—') && /\d/.test(meanText),
      `mean=${meanText.trim()}`);
    const legend = await page.getByTestId('severity-legend').count();
    check('severity legend renders', legend > 0, `legend=${legend}`);

    await page.screenshot({ path: join(outDir, '02-severity-tab.png'), fullPage: true });
    check('screenshots captured', true, outDir);
  } finally {
    // Always persist the report: an assertion or locator timeout used to propagate out of main()
    // before the write, throwing away the renderer/main-process logs that explain the failure.
    writeFileSync(join(outDir, 'packaged-severity-smoke.json'),
      JSON.stringify({ app: packagedAppPath, recording: RECORDING, results, logs: logs.slice(-120) }, null, 2));
    const noise = logs.filter((line) => /error|Error|crash|exit|Traceback/.test(line)).slice(-15);
    if (noise.length) console.log(['', '--- notable log lines ---', ...noise].join(String.fromCharCode(10)));
    if (app) await app.close().catch(() => {});
    rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  writeFileSync(join(outDir, 'packaged-severity-smoke.json'),
    JSON.stringify({ app: packagedAppPath, recording: RECORDING, results, failed: failed.length, logs: logs.slice(-80) }, null, 2));
  console.log(`\n=== Packaged severity smoke: ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); process.exitCode = 1; }
}

main().catch((exc) => { console.error(exc); process.exitCode = 1; });
