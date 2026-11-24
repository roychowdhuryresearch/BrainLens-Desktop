#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const artifactsDir = join(desktopRoot, 'artifacts');
const outputRoot = join(artifactsDir, 'electron-real-recording');
const screenshotsDir = join(outputRoot, 'screenshots');
const outputPath = join(artifactsDir, 'electron-real-recording-smoke.json');
const electronExecutable = require('electron');
const defaultFixture = join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');
const diagnostics = { viteLogs: [], electronLogs: [] };
const ELECTRON_STARTUP_TIMEOUT_MS = 90000;
const USE_BUILT_RENDERER = process.env.PYHFO_ELECTRON_REAL_USE_BUILT_RENDERER === '1';

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

function findFirstEdf(root) {
  if (!existsSync(root)) return '';
  const stack = [root];
  let scanned = 0;
  while (stack.length && scanned < 20000) {
    const current = stack.pop();
    scanned += 1;
    let stat;
    try {
      stat = statSync(current);
    } catch {
      continue;
    }
    if (stat.isFile() && current.toLowerCase().endsWith('.edf')) return current;
    if (stat.isDirectory()) {
      for (const child of readdirSync(current).sort().reverse()) stack.push(join(current, child));
    }
  }
  return '';
}

function resolveFixture() {
  const requested = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || process.env.PYHFO_PARITY_FIXTURE_RECORDING || '').trim();
  const candidate = requested ? resolve(requested) : (existsSync(defaultFixture) ? defaultFixture : findFirstEdf(join(repoRoot, 'data/Omni-iEEG')));
  if (!candidate || !existsSync(candidate)) {
    fail('missing_fixture', 'Electron real-recording smoke needs an EDF fixture. Set PYHFO_ELECTRON_REAL_FIXTURE_RECORDING=/path/to/case.edf.', {
      default_fixture: defaultFixture,
    });
  }
  return candidate;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`renderer dev server did not become ready at ${url}: ${lastError}`);
}

function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: desktopRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    text: true,
  });
  const logs = [];
  diagnostics.viteLogs = logs;
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  return { child, logs };
}

async function runRealRecordingPipeline(page, request) {
  return page.evaluate(async ({ fixturePath, outputRoot, preparedPath, detectionDir, classifiedDir, exportsDir, runYasa }) => {
    const unwrapResult = (value) => (value && typeof value === 'object' && value.result && typeof value.result === 'object' ? value.result : value);
    const assert = (condition, message) => {
      if (!condition) throw new Error(message);
    };
    const api = window.ieeg;
    assert(api, 'Electron preload bridge missing on window.ieeg');
    const health = await api.getBackendStatus();
    assert(health && health.status === 'ok', `Backend health was not ok: ${JSON.stringify(health)}`);

    const loaded = unwrapResult(await api.loadRecording(fixturePath));
    const channelNames = loaded.channel_names || loaded.channels || [];
    assert(channelNames.length > 0, 'Real EDF load returned no channels');
    assert(Number(loaded.sample_freq || loaded.sample_frequency || 0) > 0, 'Real EDF load returned no sample frequency');
    const sampleFreq = Number(loaded.sample_freq || loaded.sample_frequency);
    const nyquist = sampleFreq / 2;
    const detectionFs = Math.min(250, Math.max(20, nyquist - 1));
    const detectionFp = Math.min(80, Math.max(4, detectionFs / 2));

    const roi = unwrapResult(await api.analyzeRecordingRoi({ input_path: fixturePath }));
    const brainChannels = Array.isArray(roi.brain_signal_channels) && roi.brain_signal_channels.length ? roi.brain_signal_channels : channelNames;
    const includeChannels = brainChannels.slice(0, 8);
    assert(includeChannels.length > 0, 'ROI returned no usable channels for smoke detection');

    const qc = unwrapResult(await api.analyzeRecordingQc({ input_path: fixturePath, roi, exclude_channels: roi.default_detection_exclusions || [], max_duration_seconds: 30 }));
    const spectral = unwrapResult(await api.analyzeRecordingSpectral({ input_path: fixturePath, roi, exclude_channels: roi.default_detection_exclusions || [], max_duration_seconds: 30, max_channels: 8, max_psd_points: 96 }));
    const waveform = await api.requestWaveformWindow({
      input_path: fixturePath,
      channels: [includeChannels[0]],
      start_seconds: 0,
      duration_seconds: Math.min(2, Number(loaded.duration_seconds || 2)),
      target_samples_per_channel: 256,
      units: 'uV',
      show_filtered: false,
      filter_60hz: false,
    });
    assert(Array.isArray(waveform.data) && waveform.data.length > 0, 'Waveform request returned no data');

    const prepared = unwrapResult(await api.prepareRecording({
      input_path: fixturePath,
      output_path: preparedPath,
      drop_bad_channels: true,
      drop_flat_channels: true,
      mark_outlier_channels: true,
      drop_outlier_channels: false,
      n_jobs: 1,
    }));
    assert(prepared.status === 'complete' && prepared.output_path, 'Prepare recording did not complete');
    const preparedChannels = prepared.prepared_channels || includeChannels;
    const detectionChannels = includeChannels.filter((channel) => preparedChannels.includes(channel));
    const finalDetectionChannels = (detectionChannels.length ? detectionChannels : preparedChannels).slice(0, 8);
    assert(finalDetectionChannels.length > 0, 'Prepared recording returned no usable channels for smoke detection');

    const detection = unwrapResult(await api.runDetection({
      input_path: prepared.output_path,
      output_dir: detectionDir,
      biomarker: 'HFO',
      detector: 'STE',
      filter: { fp: detectionFp, fs: detectionFs, rp: 0.5, rs: 40 },
      detector_params: {},
      classifier: { enabled: false },
      n_jobs: 1,
      include_channels: finalDetectionChannels,
      exports: ['csv', 'session', 'summary_json'],
      session_format: 'pybrain',
      fail_on_error: true,
    }));
    assert(detection.status === 'complete', `Detection did not complete: ${JSON.stringify(detection.error || detection)}`);
    assert(detection.artifacts && detection.artifacts.session, 'Detection did not export a session artifact');
    assert(Number(detection.num_events || 0) > 0, `Detection completed but produced no review events for fixture ${fixturePath}`);

    const events = await api.listEvents({ run_id: detection.active_run_id });
    assert(events.count > 0 && events.events && events.events.length > 0, 'Event list did not expose detection events');
    const firstEvent = events.events[0];
    const snippet = await api.eventSnippet({
      event_id: firstEvent.event_id,
      run_id: events.run_id || detection.active_run_id,
      input_path: prepared.output_path,
      padding_seconds: 0.5,
      target_samples_per_channel: 256,
    });
    assert(snippet && snippet.status === 'complete', 'Event snippet did not complete');
    const featureSummary = await api.eventFeatureSummary({ event_id: firstEvent.event_id, run_id: events.run_id || detection.active_run_id });
    assert(featureSummary && featureSummary.status === 'complete', 'Event feature summary did not complete');
    const cursor = await api.moveEventCursor({ action: 'next', run_id: events.run_id || detection.active_run_id });
    assert(cursor && cursor.status === 'complete', 'Event cursor navigation did not complete');
    const annotation = await api.annotateEvent({
      event_id: firstEvent.event_id,
      run_id: events.run_id || detection.active_run_id,
      label: 'uncertain',
      display_label: 'Smoke Review',
      notes: 'Electron real-recording smoke annotation.',
      reviewer: 'electron-real-smoke',
      source: 'electron-real-recording-smoke',
      confirmed: true,
    });
    assert(annotation && annotation.status === 'complete', 'Event annotation did not complete');
    const overlap = await api.overlapReview({ run_id: events.run_id || detection.active_run_id, tolerance_seconds: 0.01 });
    assert(overlap && overlap.status === 'complete', 'Overlap review did not complete');

    const classified = unwrapResult(await api.classifyActiveRun({
      session_path: detection.artifacts.session,
      output_dir: classifiedDir,
      run_id: detection.active_run_id,
      biomarker: 'HFO',
      detector: 'STE',
      classifier: {
        enabled: true,
        model_type: 'default_cpu',
        device: 'cpu',
        batch_size: 32,
        steps: ['artifact'],
      },
      exports: ['session', 'summary_json'],
      session_format: 'pybrain',
    }));
    assert(classified.status === 'complete', `Classification did not complete: ${JSON.stringify(classified.error || classified)}`);
    assert(classified.classifier_metadata?.executed_steps?.includes('artifact'), 'Classifier did not execute artifact step');

    const runRecord = {
      runId: detection.active_run_id || 'electron-real-smoke-run',
      biomarker: detection.biomarker || 'HFO',
      detector: detection.detector || 'STE',
      events: Number(detection.num_events || 0),
      channels: Number(detection.num_channels || 0),
      status: classified.status || detection.status,
      classifier: classified.classifier_metadata?.model_type || 'default_cpu',
      parameters: {
        artifact_session: detection.artifacts.session,
        artifact_summary_json: detection.artifacts.summary_json,
        artifact_csv: detection.artifacts.csv,
        classified_session: classified.artifacts?.session,
        classified_summary_json: classified.artifacts?.summary_json,
      },
    };
    const reviewState = { events: events.events, annotations: { [firstEvent.event_id]: annotation.annotation || annotation } };
    const sessionExport = await api.exportSession({ output_path: `${exportsDir}/electron-real-smoke.pybrain` });
    const reportExport = await api.exportReport({
      output_path: `${exportsDir}/electron-real-smoke-report.html`,
      summary: { run_count: 1, active_run_id: runRecord.runId, accepted_run_id: runRecord.runId },
      runs: [runRecord],
      active_run: runRecord,
      selected_run: runRecord,
      accepted_run_id: runRecord.runId,
      visible_run_ids: [runRecord.runId],
      channel_ranking: [],
      review_state: reviewState,
      runtime_log: [{ level: 'success', message: 'Electron real-recording smoke completed' }],
      artifacts: { ...detection.artifacts, ...classified.artifacts },
    });
    const workbookExport = await api.exportWorkbook({
      output_path: `${exportsDir}/electron-real-smoke-workbook.xlsx`,
      summary: { run_count: 1, active_run_id: runRecord.runId },
      runs: [runRecord],
      channel_ranking: [],
      review_state: reviewState,
    });
    assert(sessionExport?.status === 'complete' && sessionExport.artifact_path, 'Session export did not complete');
    assert(reportExport?.status === 'complete' && reportExport.artifact_path, 'Report export did not complete');
    assert(workbookExport?.status === 'complete' && workbookExport.artifact_path, 'Workbook export did not complete');

    let yasaDetection = null;
    if (runYasa) {
      yasaDetection = unwrapResult(await api.runDetection({
        input_path: prepared.output_path,
        output_dir: `${outputRoot}/yasa-detection`,
        biomarker: 'Spindle',
        detector: 'YASA',
        classifier: { enabled: false },
        n_jobs: 1,
        include_channels: finalDetectionChannels.slice(0, 1),
        exports: ['summary_json'],
        fail_on_error: true,
      }));
      assert(yasaDetection.status === 'complete', `YASA detection did not complete: ${JSON.stringify(yasaDetection.error || yasaDetection)}`);
      assert(Number(yasaDetection.num_events || 0) > 0, 'YASA detection completed without spindle candidates for the release fixture');
    }

    return {
      health,
      loaded,
      roi,
      qc,
      spectral,
      waveform: {
        channels: waveform.channels,
        returned_samples_per_channel: waveform.returned_samples_per_channel,
      },
      prepared,
      detection,
      events: { count: events.count, first_event_id: firstEvent.event_id, run_id: events.run_id || detection.active_run_id },
      review: { snippet_status: snippet.status, feature_status: featureSummary.status, cursor_event_id: cursor.event_id || cursor.cursor_event_id, annotation_status: annotation.status, overlap_status: overlap.status },
      classified,
      yasa_detection: yasaDetection,
      exports: { session: sessionExport, report: reportExport, workbook: workbookExport },
    };
  }, request);
}

async function main() {
  const fixturePath = resolveFixture();
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js')) || !existsSync(join(desktopRoot, 'dist-electron', 'preload.cjs'))) {
    fail('missing_build', 'Electron real-recording smoke requires built Electron outputs. Run npm run build first.');
  }
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(screenshotsDir, { recursive: true });
  const preparedPath = join(outputRoot, 'prepared-real-smoke.fif');
  const detectionDir = join(outputRoot, 'detection');
  const classifiedDir = join(outputRoot, 'classified');
  const exportsDir = join(outputRoot, 'exports');
  mkdirSync(detectionDir, { recursive: true });
  mkdirSync(classifiedDir, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });

  const rendererPort = USE_BUILT_RENDERER ? 0 : Number(process.env.PYHFO_ELECTRON_REAL_RENDERER_PORT || await getFreePort());
  const backendPort = Number(process.env.PYHFO_ELECTRON_REAL_BACKEND_PORT || await getFreePort());
  const runYasa = /^(1|true|yes|on)$/i.test(process.env.PYHFO_ELECTRON_REAL_RUN_YASA || '');
  const baseUrl = USE_BUILT_RENDERER ? '' : `http://127.0.0.1:${rendererPort}`;
  const vite = USE_BUILT_RENDERER ? { child: null, logs: [] } : startVite(rendererPort);
  let electronApp;
  const consoleEntries = [];
  const pageErrors = [];
  const dialogs = [];
  try {
    if (!USE_BUILT_RENDERER) await waitForServer(`${baseUrl}/?electronRealSmoke=1`);
    electronApp = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        ...(USE_BUILT_RENDERER ? {} : { VITE_DEV_SERVER_URL: `${baseUrl}/?electronRealSmoke=1` }),
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS || '60000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_DISABLE_AGENT_RUNTIME: '1', // backend-API smoke doesn't need the LLM runtime; skip its ~40s boot
        PYHFO_AGENT_EXPORT_DIR: outputRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: ELECTRON_STARTUP_TIMEOUT_MS,
    });
    const electronLogs = [];
    diagnostics.electronLogs = electronLogs;
    const electronProcess = electronApp.process();
    electronProcess?.stdout?.on('data', (chunk) => electronLogs.push(String(chunk)));
    electronProcess?.stderr?.on('data', (chunk) => electronLogs.push(String(chunk)));
    const page = await electronApp.firstWindow({ timeout: ELECTRON_STARTUP_TIMEOUT_MS });
    page.setDefaultTimeout(5000);
    page.on('dialog', async (dialog) => {
      dialogs.push({ type: dialog.type(), message: dialog.message().slice(0, 500) });
      try {
        await dialog.dismiss();
      } catch {
        // Dialog may already be closed by Electron navigation handling.
      }
    });
    page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text().slice(0, 500) }));
    page.on('pageerror', (error) => pageErrors.push(String(error).slice(0, 500)));
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 30000 });

    await page.evaluate((fixture) => {
      window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{
        path: fixture,
        label: fixture.split('/').pop() || fixture,
        openedAt: new Date().toISOString(),
        metadata: null,
      }]));
    }, fixturePath);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 10000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((element) => element.click());
    await page.waitForSelector('[data-testid="pyqt-waveformWiget"]', { timeout: 30000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(screenshotsDir, 'real-recording-ui-loaded.png'), fullPage: true });

    const pipeline = await runRealRecordingPipeline(page, { fixturePath, outputRoot, preparedPath, detectionDir, classifiedDir, exportsDir, runYasa });
    await page.screenshot({ path: join(screenshotsDir, 'real-recording-after-pipeline.png'), fullPage: true });

    const unexpectedConsole = consoleEntries.filter((entry) => entry.type === 'error' && !/ResizeObserver loop|DevTools failed/i.test(entry.text));
    const failures = [
      ...(unexpectedConsole.length ? unexpectedConsole.map((entry) => `console error: ${entry.text}`) : []),
      ...pageErrors.map((entry) => `page error: ${entry}`),
    ];
    const report = {
      status: failures.length ? 'failed' : 'passed',
      fixture_path: fixturePath,
      output_root: outputRoot,
      renderer_url: USE_BUILT_RENDERER ? join(desktopRoot, 'dist-renderer', 'index.html') : `${baseUrl}/?electronRealSmoke=1`,
      backend_port: backendPort,
      backend_executable: process.env.PYHFO_BACKEND_EXECUTABLE || null,
      onnx_dir: process.env.PYHFO_ONNX_DIR || null,
      yasa_detection_requested: runYasa,
      summary: {
        sample_frequency_hz: Number(pipeline.loaded.sample_freq || pipeline.loaded.sample_frequency || 0),
        channel_count: Number(pipeline.loaded.n_channels || pipeline.loaded.channel_names?.length || 0),
        prepared_channels: Number(pipeline.prepared.prepared_n_channels || 0),
        detection_events: Number(pipeline.detection.num_events || 0),
        detection_channels: Number(pipeline.detection.num_channels || 0),
        classified_events: Number(pipeline.classified.num_events || 0),
        classifier_steps: pipeline.classified.classifier_metadata?.executed_steps || [],
        yasa_detection_events: Number(pipeline.yasa_detection?.num_events || 0),
        reviewed_event_id: pipeline.events.first_event_id,
        failed_console_errors: unexpectedConsole.length,
        page_errors: pageErrors.length,
        dialogs: dialogs.length,
      },
      pipeline,
      screenshots: {
        loaded_ui: join(screenshotsDir, 'real-recording-ui-loaded.png'),
        after_pipeline: join(screenshotsDir, 'real-recording-after-pipeline.png'),
      },
      console: consoleEntries.slice(-80),
      dialogs,
      electron_logs: electronLogs.join('').split('\n').slice(-80),
      vite_logs: vite.logs.join('').split('\n').slice(-80),
      failures,
    };
    writeReport(report);
    console.log(JSON.stringify({ status: report.status, summary: report.summary, report: outputPath, screenshots: report.screenshots, failures }, null, 2));
    if (failures.length) process.exitCode = 1;
  } finally {
    if (electronApp) {
      try {
        await electronApp.evaluate(async ({ app }) => app.exit(0));
      } catch {
        try {
          await electronApp.close();
        } catch {
          // Process cleanup below handles stubborn Electron exits.
        }
      }
    }
    vite.child?.kill();
  }
}

main().catch((error) => {
  writeReport({
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    electron_logs: diagnostics.electronLogs.join('').split('\n').slice(-80),
    vite_logs: diagnostics.viteLogs.join('').split('\n').slice(-80),
  });
  console.error(error);
  process.exit(1);
});
