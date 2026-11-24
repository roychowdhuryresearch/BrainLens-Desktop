#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const electronExecutable = require('electron');
const configuredFixture = process.env.SM_E2E_EDF?.trim() || process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING?.trim();
const fixture = configuredFixture && resolve(configuredFixture);
const outRoot = resolve(process.env.SM_E2E_CAPTURE_DIR || join(repoRoot, 'videos/e2e-ux-demo/real-ui-captures'));
const screenshotDir = join(outRoot, 'screenshots');
const reportPath = join(outRoot, 'capture-report.json');
const useDevServer = !/^(0|false|no|off)$/i.test(process.env.SM_E2E_USE_DEV_SERVER || '1');
const BIG = 240000;
const DETECTION_TIMEOUT = 420000;
const CLASSIFICATION_TIMEOUT = 420000;
const diagnostics = { viteLogs: [], electronLogs: [], console: [], pageErrors: [] };
const observedPages = new WeakSet();

function info(message, extra = undefined) {
  console.log(`[sm-e2e] ${message}${extra === undefined ? '' : ` ${JSON.stringify(extra)}`}`);
}

function writeReport(report) {
  mkdirSync(outRoot, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}

function fail(status, message, extra = {}) {
  writeReport({ status, message, ...extra, diagnostics });
  console.error(message);
  console.error(`Report: ${reportPath}`);
  process.exit(2);
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(url, child, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`renderer dev server exited early with code ${child.exitCode}`);
    }
    try {
      const status = await httpStatus(url);
      if (status < 500) return;
      last = `HTTP ${status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`renderer dev server did not become ready at ${url}: ${last}`);
}

function httpStatus(url) {
  return new Promise((resolveStatus, reject) => {
    const req = httpGet(url, (response) => {
      response.resume();
      response.on('end', () => resolveStatus(response.statusCode || 0));
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP readiness timeout')));
    req.on('error', reject);
  });
}

function postJson(url, payload) {
  return new Promise((resolvePost, reject) => {
    const target = new URL(url);
    const body = JSON.stringify(payload);
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          resolvePost(JSON.parse(data || '{}'));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTP POST timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: desktopRoot,
    env: { ...process.env, SM_E2E_CAPTURE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    text: true,
  });
  child.stdout.on('data', (chunk) => diagnostics.viteLogs.push(String(chunk)));
  child.stderr.on('data', (chunk) => diagnostics.viteLogs.push(String(chunk)));
  return child;
}

async function screenshot(page, name) {
  const path = join(screenshotDir, `${name}.png`);
  await page.screenshot({ path, fullPage: true, timeout: 60000 });
  return path;
}

function attachPageDiagnostics(page) {
  if (!page || observedPages.has(page)) return;
  observedPages.add(page);
  page.on('console', (message) => diagnostics.console.push({ type: message.type(), text: message.text().slice(0, 700) }));
  page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error).slice(0, 700)));
  page.on('close', () => diagnostics.console.push({ type: 'debug', text: `Electron page closed: ${page.url()}`.slice(0, 700) }));
}

async function waitForMainPage(app, timeoutMs = BIG) {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'no windows observed';
  await app.firstWindow({ timeout: Math.min(30000, timeoutMs) }).then(attachPageDiagnostics).catch((error) => {
    lastState = error instanceof Error ? error.message : String(error);
  });
  while (Date.now() < deadline) {
    const pages = app.windows();
    if (!pages.length && app.process()?.exitCode !== null) {
      throw new Error(`Electron exited before main window mounted: ${app.process()?.exitCode}`);
    }
    for (const candidate of pages) {
      attachPageDiagnostics(candidate);
      if (candidate.isClosed()) continue;
      try {
        const hasMainWindow = await candidate.evaluate(() => Boolean(document.querySelector('[data-testid="pyqt-main-window"]')));
        lastState = `${candidate.url()} main=${hasMainWindow}`;
        if (hasMainWindow) return candidate;
      } catch (error) {
        lastState = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for Electron main UI window. Last state: ${lastState}`);
}

async function clickTestId(page, testId, timeout = 15000) {
  await page.waitForSelector(`[data-testid="${testId}"]`, { timeout, state: 'attached' });
  await page.getByTestId(testId).first().evaluate((element) => element.click());
}

async function openAgentTab(page, tab) {
  const id = tab.toLowerCase();
  await clickTestId(page, `agent-activity-${id}`, 30000);
  await page.waitForSelector(`[data-testid="agent-${id}-tab"], [data-testid="agent-panel-tab-${id}"]`, { timeout: 30000, state: 'attached' });
}

async function waitForRecordingLoaded(page) {
  await page.waitForFunction((name) => {
    const canvas = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
    const start = canvas?.getAttribute('data-window-start-seconds') || '';
    const duration = canvas?.getAttribute('data-window-duration-seconds') || '';
    const sidebar = document.querySelector('[data-testid="pyqt-main_edf_info"]')?.textContent || '';
    const status = document.querySelector('[data-testid="pyqt-STDTextEdit"]')?.textContent || '';
    return Boolean(start && duration && sidebar.includes(name) && !/Opening recent recording/i.test(status));
  }, basename(fixture), { timeout: 120000, polling: 1000 });
  await page.waitForTimeout(1500);
}

async function waitForDetectionComplete(page) {
  await page.waitForFunction(() => {
    const strip = document.querySelector('[data-testid="pyqt-STDTextEdit"]')?.textContent || '';
    const operationNode = document.querySelector('[data-testid="agent-current-operation"]');
    const operationLabel = operationNode?.querySelector('strong')?.textContent || operationNode?.textContent || '';
    const operationStatus = operationNode?.querySelector('.status-pill')?.textContent || '';
    const completedRunCard = Array.from(document.querySelectorAll('[data-testid="agent-chat-run-message"][data-status="complete"]')).map((node) => node.textContent || '').join('\n');
    if (/run complete:\s*[1-9]\d*\s+event/i.test(strip) || /Detect STE HFO\s+complete/i.test(strip)) return true;
    if (/Detect STE HFO/i.test(operationLabel) && /complete/i.test(operationStatus)) return true;
    return /Detect STE HFO/i.test(completedRunCard) && /\bcomplete\b/i.test(completedRunCard);
  }, null, { timeout: DETECTION_TIMEOUT, polling: 1000 });
}

async function waitForClassificationComplete(page) {
  await page.waitForFunction(() => {
    const strip = document.querySelector('[data-testid="pyqt-STDTextEdit"]')?.textContent || '';
    const review = document.querySelector('[data-testid="pyqt-review-message"]')?.textContent || '';
    const operationNode = document.querySelector('[data-testid="agent-current-operation"]');
    const operationLabel = operationNode?.querySelector('strong')?.textContent || operationNode?.textContent || '';
    const operationStatus = operationNode?.querySelector('.status-pill')?.textContent || '';
    const completedRunCard = Array.from(document.querySelectorAll('[data-testid="agent-chat-run-message"][data-status="complete"]')).map((node) => node.textContent || '').join('\n');
    if (/Active run classified without rerunning detection/i.test(strip)) return true;
    if (/Classification complete for active run/i.test(review)) return true;
    if (/Classify active run/i.test(operationLabel) && /complete/i.test(operationStatus)) return true;
    return /Classify active run/i.test(completedRunCard) && /\bcomplete\b/i.test(completedRunCard);
  }, null, { timeout: CLASSIFICATION_TIMEOUT, polling: 1000 });
}

async function waitForReviewEvents(page) {
  await page.waitForFunction(async () => {
    try {
      const result = await window.ieeg?.listEvents?.({});
      const count = Number(result?.count ?? (Array.isArray(result?.events) ? result.events.length : 0));
      return count > 0;
    } catch {
      return false;
    }
  }, null, { timeout: 60000, polling: 1000 });
  return page.evaluate(async () => {
    const result = await window.ieeg.listEvents({});
    return {
      run_id: result?.run_id || null,
      count: Number(result?.count ?? (result?.events || []).length),
      preview: (result?.events || []).slice(0, 8),
    };
  });
}

async function waitForDetectedHfoWaveform(page, events) {
  const firstEvent = events?.preview?.[0] || null;
  if (!firstEvent?.event_id) {
    fail('no_event_preview', 'Detection returned events, but no first HFO candidate was available to focus.', { events });
  }

  const backToWaveform = page.getByTestId('pyqt-subpage_back_to_main_button');
  if (await backToWaveform.count()) {
    await backToWaveform.first().evaluate((element) => element.click()).catch(() => {});
  }
  await page.waitForFunction(() => {
    const shell = document.querySelector('[data-testid="pyqt-closed-agent-layout"]');
    return shell?.getAttribute('data-active-workflow-tab') === 'waveform';
  }, null, { timeout: 30000, polling: 250 });

  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
    const overlayCount = Number(canvas?.getAttribute('data-overlay-count') || 0);
    const position = document.querySelector('[data-testid="pyqt-event_position_label"]')?.textContent || '';
    return overlayCount > 0 && /Event\s+\d+\s*\/\s*\d+/i.test(position);
  }, null, { timeout: 60000, polling: 500 });

  await clickTestId(page, 'pyqt-center_event_button', 30000);
  await page.waitForFunction((event) => {
    const canvas = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
    if (!canvas) return false;
    const selected = canvas.getAttribute('data-selected-event-id') || '';
    const overlayCount = Number(canvas.getAttribute('data-overlay-count') || 0);
    const windowStart = Number(canvas.getAttribute('data-window-start-seconds') || NaN);
    const windowDuration = Number(canvas.getAttribute('data-window-duration-seconds') || NaN);
    const eventStart = Number(event.start_seconds);
    const windowEnd = windowStart + windowDuration;
    return selected === event.event_id
      && overlayCount > 0
      && Number.isFinite(windowStart)
      && Number.isFinite(windowDuration)
      && Number.isFinite(eventStart)
      && eventStart >= windowStart
      && eventStart <= windowEnd;
  }, firstEvent, { timeout: 90000, polling: 500 });

  await clickTestId(page, 'pyqt-event_channels_button', 30000);
  await page.waitForFunction(() => {
    const meta = document.querySelector('[data-testid="workflow-waveform-metadata"]')?.textContent || '';
    const canvas = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
    const overlayCount = Number(canvas?.getAttribute('data-overlay-count') || 0);
    return overlayCount > 0 && /Run overlays:\s*[1-9]\d*\s+event/i.test(meta);
  }, null, { timeout: 60000, polling: 500 });
  await page.waitForTimeout(900);
  return firstEvent;
}

async function waitForReviewSnippetLoaded(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="pyqt-annotation_view_status"]')?.textContent || '';
    const raw = document.querySelector('[data-testid="pyqt-raw_pane_interactive"]')?.textContent || '';
    const filtered = document.querySelector('[data-testid="pyqt-filtered_pane_interactive"]')?.textContent || '';
    return /waveform.*filtered trace.*FFT panes updated/i.test(status)
      && !/No waveform snippet available/i.test(raw)
      && !/No filtered trace available/i.test(filtered);
  }, null, { timeout: 120000, polling: 1000 });
}

async function emitUiBrokerCommand(page, type, payload, reason, failureCode) {
  const status = await page.evaluate(async () => window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null);
  const brokerUrl = status?.ui_broker?.base_url;
  if (!brokerUrl) fail(`${failureCode}_broker_missing`, `UI broker is unavailable for ${type}.`, { status });
  const emit = await postJson(`${brokerUrl}/ui/emit`, { type, payload, reason });
  if (!emit?.success) fail(`${failureCode}_broker_emit_failed`, `UI broker rejected ${type}.`, { emit, status });
  return emit;
}

async function waitForTopHfoFocus(page, expectedEvent) {
  await page.waitForFunction((event) => {
    const canvas = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
    const selected = canvas?.getAttribute('data-selected-event-id') || '';
    const overlayCount = Number(canvas?.getAttribute('data-overlay-count') || 0);
    const windowStart = Number(canvas?.getAttribute('data-window-start-seconds') || NaN);
    const channel = String(event?.channel || '').trim();
    const bodyText = document.body.textContent || '';
    const position = document.querySelector('[data-testid="pyqt-event_position_label"]')?.textContent || '';
    return overlayCount > 0
      && selected.length > 0
      && Number.isFinite(windowStart)
      && windowStart > 1
      && (!channel || bodyText.includes(channel))
      && /Event\s+\d+\s*\/\s*\d+/i.test(position);
  }, expectedEvent || {}, { timeout: 90000, polling: 500 });
}

async function resetWaveformAwayFromEvent(page, event) {
  await emitUiBrokerCommand(page, 'workspace.reset_waveform_view', {}, 'Reset waveform before the top-HFO-channel prompt for E2E capture contrast', 'reset_waveform');
  await page.waitForFunction((target) => {
    const canvas = document.querySelector('[data-testid="pyqt-waveform_event_overlay_canvas"]');
    const windowStart = Number(canvas?.getAttribute('data-window-start-seconds') || NaN);
    const windowDuration = Number(canvas?.getAttribute('data-window-duration-seconds') || NaN);
    const eventStart = Number(target?.start_seconds);
    return Number.isFinite(windowStart)
      && Number.isFinite(windowDuration)
      && Number.isFinite(eventStart)
      && windowStart <= 0.5
      && eventStart > windowStart + windowDuration;
  }, event || {}, { timeout: 30000, polling: 500 });
}

async function main() {
  info('starting capture', { fixture, outRoot });
  if (!fixture || !existsSync(fixture)) fail('missing_fixture', 'Set SM_E2E_EDF or PYHFO_ELECTRON_REAL_FIXTURE_RECORDING to a local EDF.');
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js')) || !existsSync(join(desktopRoot, 'dist-electron', 'preload.cjs'))) {
    fail('missing_build', 'Capture requires built Electron outputs. Run npm run build in desktop first.');
  }
  rmSync(screenshotDir, { recursive: true, force: true });
  mkdirSync(screenshotDir, { recursive: true });

  info('allocating ports');
  const rendererPort = useDevServer ? await getFreePort() : null;
  const backendPort = await getFreePort();
  const baseUrl = rendererPort ? `http://127.0.0.1:${rendererPort}` : null;
  info(useDevServer ? 'starting Vite' : 'using built renderer', { rendererPort, backendPort });
  const vite = useDevServer ? startVite(rendererPort) : null;
  let app;
  try {
    if (useDevServer) {
      await waitForServer(`${baseUrl}/?smE2eCapture=1`, vite);
      info('Vite ready', { baseUrl });
    }
    info('launching Electron');
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        ...(baseUrl ? { VITE_DEV_SERVER_URL: `${baseUrl}/?smE2eCapture=1` } : {}),
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS || '120000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_AGENT_ROOT: repoRoot,
        PYHFO_AGENT_EXPORT_DIR: outRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: BIG,
    });
    info('Electron launched');
    const proc = app.process();
    proc?.stdout?.on('data', (chunk) => diagnostics.electronLogs.push(String(chunk)));
    proc?.stderr?.on('data', (chunk) => diagnostics.electronLogs.push(String(chunk)));

    const page = await waitForMainPage(app, BIG);
    page.setDefaultTimeout(15000);
    try {
      const bw = await app.browserWindow(page);
      await bw.setSize(1920, 1080);
      await bw.setPosition(24, 24);
    } catch {
      await page.setViewportSize({ width: 1920, height: 1080 }).catch(() => {});
    }

    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });
    await page.evaluate((edf) => {
      window.localStorage.setItem('ieeg.agentPanelWidth', '420');
      window.localStorage.setItem('ieeg.agentPanelTab', 'Chat');
      window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{
        path: edf,
        label: edf.split('/').pop() || edf,
        openedAt: new Date().toISOString(),
        metadata: null,
      }]));
    }, fixture);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });
    await clickTestId(page, 'pyqt-recent_recording_open_button');
    await page.waitForSelector('[data-testid="pyqt-waveform_event_overlay_canvas"]', { timeout: BIG });
    await page.waitForSelector('[data-testid="pyqt-header_detect_button"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid="pyqt-waveform_right_sidebar"]', { timeout: 30000 });
    await waitForRecordingLoaded(page);

    const shots = {};
    shots.loaded = await screenshot(page, '01-real-ui-loaded-toolbar-agent');
    info('recording loaded screenshot captured');

    await openAgentTab(page, 'Chat');
    await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 15000 });
    const prompt = 'Detect all HFOs in this EDF.';
    await page.fill('#agent-prompt-input', prompt);
    shots.prompt = await screenshot(page, '02-real-main-agent-prompt-detect-all-hfos');
    await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();
    info('agent prompt sent');

    await openAgentTab(page, 'Actions');
    let stagedVia = 'agent-chat';
    const detectionApplySelector = '[data-testid="agent-command-card"][data-command-type="detection.run"] [data-testid="agent-command-apply"]';
    try {
      await page.waitForSelector(detectionApplySelector, { timeout: 120000 });
      info('agent staged detection command');
    } catch {
      stagedVia = 'ui-broker-fallback';
      const status = await page.evaluate(async () => window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null);
      const brokerUrl = status?.ui_broker?.base_url;
      if (!brokerUrl) fail('broker_missing', 'Agent chat did not stage a command and UI broker is unavailable.', { status, shots });
      const emit = await postJson(`${brokerUrl}/ui/emit`, {
        type: 'detection.run',
        payload: {
          biomarker: 'HFO',
          detector: 'STE',
          scope: 'all',
          all_channels: true,
          filter: { fp: 80, fs: 500 },
          n_jobs: 1,
          exports: ['csv', 'session', 'summary_json'],
        },
        reason: 'Detect all HFOs in the loaded EDF from the E2E UX capture',
      });
      if (!emit?.success) fail('broker_emit_failed', 'UI broker rejected detection.run.', { emit, status, shots });
      await page.waitForSelector(detectionApplySelector, { timeout: 30000 });
      info('fallback staged detection command');
    }
    const commandCard = page.locator('[data-testid="agent-command-card"][data-command-type="detection.run"][data-command-status="staged"]').first();
    shots.staged = await screenshot(page, '03-real-main-actions-staged-all-hfo');
    const commandText = await commandCard.innerText().catch(() => '');
    const commandPayloadText = await commandCard.locator('[data-testid="agent-command-diff"]').textContent().catch(() => '');
    if (!/detection\.run/.test(commandText) || !(/"scope": "all"/.test(commandPayloadText) || /"all_channels": true/.test(commandPayloadText))) {
      fail('bad_scope', 'Staged detection.run did not visibly carry all-channel scope.', { commandText, commandPayloadText, shots });
    }

    await commandCard.locator('[data-testid="agent-command-apply"]').first().evaluate((element) => element.click());
    await page.waitForTimeout(700);
    shots.running = await screenshot(page, '04-real-main-detection-running-after-apply');
    info('detection apply clicked');

    await waitForDetectionComplete(page);
    const events = await waitForReviewEvents(page);
    if (!events.count) fail('no_events', 'All-HFO detection completed without review events.', { events, shots });
    info('events listed', { count: events.count, run_id: events.run_id });

    const focusedEvent = await waitForDetectedHfoWaveform(page, events);
    shots.complete = await screenshot(page, '05-real-main-detection-complete-results');
    info('detected HFO waveform screenshot captured', { event_id: focusedEvent.event_id, channel: focusedEvent.channel, start_seconds: focusedEvent.start_seconds });

    await resetWaveformAwayFromEvent(page, focusedEvent);
    info('waveform reset before top-HFO-channel prompt');

    await openAgentTab(page, 'Chat');
    await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 15000 });
    const topChannelPrompt = 'Show me the channel with the most HFO.';
    await page.fill('#agent-prompt-input', topChannelPrompt);
    shots.topChannelPrompt = await screenshot(page, '06-real-main-agent-prompt-top-hfo-channel');
    await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();
    info('top-HFO-channel agent prompt sent');

    let topChannelVia = 'agent-chat';
    try {
      await waitForTopHfoFocus(page, focusedEvent);
      info('agent focused top HFO channel');
    } catch {
      topChannelVia = 'ui-broker-fallback';
      await emitUiBrokerCommand(page, 'detection.focus_top_candidate_channel', {
        biomarker: 'HFO',
        duration_seconds: 2,
        visible_channels: 1,
      }, 'Show the channel with the most loaded HFO candidates from the E2E UX capture', 'top_channel');
      await waitForTopHfoFocus(page, focusedEvent);
      info('fallback focused top HFO channel');
    }
    shots.topChannelFocused = await screenshot(page, '07-real-main-top-hfo-channel-focused');

    await openAgentTab(page, 'Chat');
    await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 15000 });
    const classifyPrompt = 'Classify the detected HFO candidates.';
    await page.fill('#agent-prompt-input', classifyPrompt);
    shots.classifyPrompt = await screenshot(page, '08-real-main-agent-prompt-classify-hfos');
    await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();
    info('classification agent prompt sent');

    await openAgentTab(page, 'Actions');
    let classifyVia = 'agent-chat';
    const classificationApplySelector = '[data-testid="agent-command-card"][data-command-type="classification.run"] [data-testid="agent-command-apply"]';
    try {
      await page.waitForSelector(classificationApplySelector, { timeout: 120000 });
      info('agent staged classification command');
    } catch {
      classifyVia = 'ui-broker-fallback';
      const status = await page.evaluate(async () => window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null);
      const brokerUrl = status?.ui_broker?.base_url;
      if (!brokerUrl) fail('classification_broker_missing', 'Agent chat did not stage classification.run and UI broker is unavailable.', { status, shots });
      const emit = await postJson(`${brokerUrl}/ui/emit`, {
        type: 'classification.run',
        payload: {
          biomarker: 'HFO',
          mode: 'HF CPU',
          classifier_label: 'HF CPU classifier',
        },
        reason: 'Classify the active HFO run from the E2E UX capture',
      });
      if (!emit?.success) fail('classification_broker_emit_failed', 'UI broker rejected classification.run.', { emit, status, shots });
      await page.waitForSelector(classificationApplySelector, { timeout: 30000 });
      info('fallback staged classification command');
    }
    const classifyCard = page.locator('[data-testid="agent-command-card"][data-command-type="classification.run"][data-command-status="staged"]').first();
    shots.classifyStaged = await screenshot(page, '09-real-main-actions-staged-classify-hfos');
    const classifyText = await classifyCard.innerText().catch(() => '');
    const classifyPayloadText = await classifyCard.locator('[data-testid="agent-command-diff"]').textContent().catch(() => '');
    if (!/classification\.run/.test(classifyText) || !/"selectedRun":\s*"[^"]+"/.test(classifyPayloadText)) {
      fail('bad_classification_command', 'Staged classification.run did not visibly target the active HFO run.', { classifyText, classifyPayloadText, shots });
    }

    await classifyCard.locator('[data-testid="agent-command-apply"]').first().evaluate((element) => element.click());
    await page.waitForTimeout(700);
    shots.classifyRunning = await screenshot(page, '10-real-main-classification-running-after-apply');
    info('classification apply clicked');

    await waitForClassificationComplete(page);
    await waitForDetectedHfoWaveform(page, events);
    shots.classifyComplete = await screenshot(page, '11-real-main-classification-complete-results');
    info('classification complete screenshot captured');

    await clickTestId(page, 'pyqt-sidebar_open_review_button');
    await page.waitForSelector('[data-testid="pyqt-annotation_window"]', { timeout: 60000 });
    await waitForReviewSnippetLoaded(page);
    await page.waitForTimeout(500);
    shots.review = await screenshot(page, '12-real-review-dialog-first-candidate');
    info('review dialog screenshot captured');

    await clickTestId(page, 'pyqt-annotation_close_button');
    await page.waitForSelector('[data-testid="pyqt-annotation_window"]', { timeout: 30000, state: 'detached' }).catch(() => {});
    await openAgentTab(page, 'Chat');
    await page.waitForTimeout(600);
    shots.chatComplete = await screenshot(page, '13-real-agent-chat-complete');
    info('final chat screenshot captured');

    const statusText = await page.getByTestId('pyqt-STDTextEdit').innerText().catch(() => '');
    const report = {
      status: 'passed',
      fixture,
      renderer_url: baseUrl ? `${baseUrl}/?smE2eCapture=1` : join(desktopRoot, 'dist-renderer/index.html'),
      prompt,
      topChannelPrompt,
      classifyPrompt,
      stagedVia,
      topChannelVia,
      classifyVia,
      screenshots: shots,
      events,
      statusText,
      commandPayloadText,
      classifyPayloadText,
      diagnostics: {
        console_errors: diagnostics.console.filter((entry) => entry.type === 'error' && !/ResizeObserver loop|DevTools/i.test(entry.text)).slice(-10),
        page_errors: diagnostics.pageErrors,
        electron_log_tail: diagnostics.electronLogs.join('').split('\n').slice(-60),
        vite_log_tail: diagnostics.viteLogs.join('').split('\n').slice(-30),
      },
    };
    writeReport(report);
    console.log(JSON.stringify({ status: report.status, events: report.events.count, report: reportPath, screenshots: report.screenshots }, null, 2));
  } finally {
    if (app) {
      try { await app.evaluate(async ({ app: electronApp }) => electronApp.exit(0)); }
      catch { try { await app.close(); } catch {} }
    }
    vite?.kill();
  }
}

main().catch((error) => {
  writeReport({
    status: 'failed',
    message: error instanceof Error ? error.message : String(error),
    diagnostics,
  });
  console.error(error);
  process.exit(1);
});
