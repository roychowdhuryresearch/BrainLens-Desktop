import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, shell } from 'electron';
import path from 'node:path';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { backendExitSummary, recentBackendLogs, startAgentRuntime, startPythonBackend, startUiBroker, stopPythonBackend, type BackendRuntime } from './pythonBackend.js';
import {
  clearStoredLlmKey,
  clearStoredLlmProfile,
  getActiveStoredLlmProfile,
  getStoredLlmKey,
  getStoredLlmProfileStatus,
  resolveStoredLlmProfile,
  saveStoredLlmProfile,
  setStoredLlmKey,
} from './llmKey.js';
import { DEFAULT_LLM_SETTINGS, SUPPORTED_LLM_PROVIDERS, applyLlmSettingsToEnv, getLlmSettings, isKeylessLlmEndpoint, setLlmSettings } from './llmSettings.js';
import { listLlmModels, readLlmUsage, testLlmConnection } from './llmProbe.js';
import { getAgentChatResult, streamAgentChat, submitAgentChat } from './agentService.js';
import { closePromptForState } from './closeGuard.js';
import { shouldRestartOnExit, RestartCoordinator } from './childSupervisor.js';
import { runStartupRetention } from './retention.js';

const electronBundleDir = path.dirname(fileURLToPath(import.meta.url));
// Below ~1268px the loaded-Review waveform toolbar's second row (nowrap) runs
// past its card and overlaps the right inspector sidebar. Pin the floor above
// that so the window can never sit in the broken band (1121–1275px).
const MAIN_WINDOW_MIN_WIDTH = 1440;
const MAIN_WINDOW_MIN_HEIGHT = 860;

let backend: BackendRuntime | undefined;
let agentRuntime: BackendRuntime | undefined;
let uiBroker: BackendRuntime | undefined;
let mainWindow: BrowserWindow | undefined;
let quitting = false;
let backendRestartCount = 0;
const MAX_BACKEND_RESTARTS = 5;
// Crash supervision for the non-PyHFO children. The agent runtime (co-pilot chat) and the UI
// broker were spawned unsupervised: an OOM-kill or crash left them dead until a full app restart.
let agentRuntimeRestartCount = 0;
let uiBrokerRestartCount = 0;
const MAX_CHILD_RESTARTS = 3;
// Coordinators serialize each child's restarts so a crash-restart and a deliberate restart
// (BYO-key change for the agent) can never overlap and leak a duplicate, unsupervised process.
// Defined after doAgentRestart/doUiBrokerRestart below (function declarations hoist).
const agentRestartCoordinator = new RestartCoordinator(() => doAgentRestart());
const uiBrokerRestartCoordinator = new RestartCoordinator(() => doUiBrokerRestart());
// AbortControllers for in-flight streamed agent turns, keyed by streamId, so the renderer can
// cancel an abandoned turn (agent:chat-stream-cancel) instead of leaking the SSE read.
const activeAgentStreams = new Map<string, AbortController>();
let workspaceDirty = false;
let allowUnsafeClose = false;
// IEEG_DISABLE_CLOSE_GUARD=1 bypasses the unsaved-workspace close prompt and discards the workspace on
// close. Automated/headless runs (E2E smokes, agent-driven sessions) have no human to answer the native
// dialog, so without this they hang on it. Leave unset for interactive use so the guard still protects work.
const closeGuardDisabled = process.env.IEEG_DISABLE_CLOSE_GUARD === '1';
let closeSaveInProgress = false;
let closeSaveTimeout: ReturnType<typeof setTimeout> | undefined;
let closeDiscardPromptInProgress = false;
let closePrimaryPromptInProgress = false;
let classifierModelLastDirectory: string | undefined;
let openDialogDirectoryState: Record<string, string> | undefined;

function authorizedInit(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${backend!.token}` } };
}

/**
 * The application menu. Windows desktop software puts New/Open/Save under File with the standard
 * accelerators, and users look there first -- before this, project actions were only reachable
 * from a toolbar button labelled Settings, which is where nobody expects to find Save.
 *
 * Menu items send a command to the renderer, which owns the actions; main does not duplicate the
 * logic behind the toolbar buttons. The Edit roles matter beyond tidiness: they are what supply
 * Ctrl+A / Ctrl+C / Ctrl+V to text fields.
 */
function buildApplicationMenu(): void {
  const send = (command: string) => () => mainWindow?.webContents.send('menu:command', command);
  const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
    {
      label: '&File',
      submenu: [
        { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: send('project.new') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+O', click: send('project.open') },
        { label: 'Save Project', accelerator: 'CmdOrCtrl+S', click: send('project.save') },
        { type: 'separator' },
        { label: 'Open Recording…', accelerator: 'CmdOrCtrl+Shift+O', click: send('recording.open') },
        { label: 'Open Saved Session…', click: send('session.open') },
        { type: 'separator' },
        { label: 'Status Log', click: send('window.status_log') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '&View',
      submenu: [
        // Reload is a DEVELOPMENT affordance. In a packaged build Ctrl+R would throw away the
        // loaded recording, the runs, and the conversation with no warning and no undo -- the
        // renderer holds all of it in memory. Offered only when running against a dev server.
        ...(process.env.VITE_DEV_SERVER_URL
          ? [{ role: 'reload' as const }, { role: 'forceReload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }]
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function safeDevServerUrl(value?: string): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && ['127.0.0.1', 'localhost'].includes(parsed.hostname)) return value;
  throw new Error(`Refusing to load remote renderer URL with privileged preload: ${value}`);
}

function safePngDefaultName(value?: string): string {
  const stem = String(value || 'pybrain_snapshot.png').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'pybrain_snapshot.png';
  return stem.toLowerCase().endsWith('.png') ? stem : `${stem}.png`;
}

function classifierModelDialogStatePath(): string {
  return path.join(app.getPath('userData'), 'classifier-model-dialog-state.json');
}

async function loadClassifierModelLastDirectory(): Promise<string | undefined> {
  if (classifierModelLastDirectory) return classifierModelLastDirectory;
  try {
    const parsed = JSON.parse(await readFile(classifierModelDialogStatePath(), 'utf8')) as Record<string, unknown>;
    const directory = String(parsed.lastClassifierModelDirectory || '');
    if (directory) {
      classifierModelLastDirectory = directory;
      return directory;
    }
  } catch {
    // Missing or corrupt picker state is non-fatal; fall back to Documents like a normal desktop dialog.
  }
  return undefined;
}

async function persistClassifierModelLastDirectory(filePath: string): Promise<void> {
  const directory = path.dirname(filePath);
  classifierModelLastDirectory = directory;
  const statePath = classifierModelDialogStatePath();
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify({ lastClassifierModelDirectory: directory }, null, 2));
}

function openDialogDirectoryStatePath(): string {
  return path.join(app.getPath('userData'), 'open-dialog-directory-state.json');
}

async function loadOpenDialogLastDirectory(key: 'lastRecordingDirectory' | 'lastSessionDirectory' | 'lastProjectDirectory' | 'lastProtocolDirectory' | 'lastBatchInputDirectory' | 'lastBatchOutputDirectory'): Promise<string | undefined> {
  if (!openDialogDirectoryState) {
    try {
      const parsed = JSON.parse(await readFile(openDialogDirectoryStatePath(), 'utf8')) as Record<string, unknown>;
      openDialogDirectoryState = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    } catch {
      openDialogDirectoryState = {};
    }
  }
  return openDialogDirectoryState[key];
}

async function persistOpenDialogLastDirectory(key: 'lastRecordingDirectory' | 'lastSessionDirectory' | 'lastProjectDirectory' | 'lastProtocolDirectory' | 'lastBatchInputDirectory' | 'lastBatchOutputDirectory', filePath: string): Promise<void> {
  openDialogDirectoryState = { ...(openDialogDirectoryState || {}), [key]: path.dirname(filePath) };
  const statePath = openDialogDirectoryStatePath();
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(openDialogDirectoryState, null, 2));
}

function decodePngDataUrl(dataUrl: unknown): Buffer {
  const value = String(dataUrl || '');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new Error('Snapshot payload must be a PNG data URL');
  const buffer = Buffer.from(match[1], 'base64');
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < pngSignature.length || !buffer.subarray(0, pngSignature.length).equals(pngSignature)) throw new Error('Snapshot payload is not a valid PNG');
  return buffer;
}


function safeExportDefaultName(value: unknown, fallback: string, extension: string): string {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const stem = String(value || fallback).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 140) || fallback;
  return stem.toLowerCase().endsWith(ext.toLowerCase()) ? stem : `${stem}${ext}`;
}


function protocolPresetDefaultName(payload: Record<string, unknown>): string {
  return safeExportDefaultName(payload.name || payload.preset_name, 'protocol-preset', 'json');
}

async function saveProtocolPresetWithDialog(payload: Record<string, unknown>): Promise<unknown> {
  const defaultName = protocolPresetDefaultName(payload);
  const defaultDirectory = await loadOpenDialogLastDirectory('lastProtocolDirectory') || app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export Protocol Preset',
    defaultPath: path.join(defaultDirectory, defaultName),
    filters: [{ name: 'PyBrain Protocol Preset', extensions: ['json'] }]
  });
  if (result.canceled || !result.filePath) return { status: 'cancelled', canceled: true };
  const outputPath = result.filePath.toLowerCase().endsWith('.json') ? result.filePath : `${result.filePath}.json`;
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8');
  await persistOpenDialogLastDirectory('lastProtocolDirectory', outputPath);
  return { status: 'complete', canceled: false, artifact_type: 'protocol_preset', artifact_path: outputPath };
}

async function openProtocolPresetWithDialog(): Promise<unknown> {
  const defaultPath = await loadOpenDialogLastDirectory('lastProtocolDirectory') || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openFile'], filters: [{ name: 'PyBrain Protocol Preset', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistOpenDialogLastDirectory('lastProtocolDirectory', result.filePaths[0]);
  return JSON.parse(await readFile(result.filePaths[0], 'utf8'));
}

type BackendExportDialogOptions = { title: string; defaultName: string; extension: string; filterName: string; endpoint: string; filters?: Array<{ name: string; extensions: string[] }> };

async function saveBackendExportWithDialog(payload: Record<string, unknown>, options: BackendExportDialogOptions): Promise<unknown> {
  const defaultName = safeExportDefaultName(payload.default_name, options.defaultName, options.extension);
  const allowedExtensions = (options.filters || [{ name: options.filterName, extensions: [options.extension.replace(/^\./, '')] }]).flatMap((filter) => filter.extensions.map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`));
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: options.title,
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: options.filters || [{ name: options.filterName, extensions: [options.extension.replace(/^\./, '')] }]
  });
  if (result.canceled || !result.filePath) return { status: 'cancelled', canceled: true };
  const ext = options.extension.startsWith('.') ? options.extension : `.${options.extension}`;
  const selectedExt = path.extname(result.filePath).toLowerCase();
  const outputPath = allowedExtensions.includes(selectedExt) ? result.filePath : `${result.filePath}${ext}`;
  return backendFetch(options.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, output_path: outputPath, allow_absolute_path: true })
  });
}

function defaultPreparedOutputPath(payload: Record<string, unknown>): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const inputPath = String(payload.input_path || 'recording');
  const baseName = path.basename(inputPath).replace(/\.(edf|bdf|fif|gz|vhdr)$/gi, '').replace(/[^a-z0-9_-]+/gi, '-') || 'recording';
  return path.join(app.getPath('userData'), 'prepared-recordings', `${stamp}-${baseName}-prepared.fif`);
}

function defaultDetectionOutputDir(payload: Record<string, unknown>): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const biomarker = String(payload.biomarker || 'run').replace(/[^a-z0-9_-]+/gi, '-');
  const detector = String(payload.detector || 'detector').replace(/[^a-z0-9_-]+/gi, '-');
  return path.join(app.getPath('userData'), 'detection-runs', `${stamp}-${biomarker}-${detector}`);
}

type SeverityProgress = { percent: number; done: number; total: number } | null;

// tqdm writes lines like "Severity scoring:  31%|###1      | 1472/4735 [04:40<10:28, 5.19seg/s]",
// carriage-return separated within a chunk. Only the newest one matters.
function severityProgressFromLogs(logs: string[]): SeverityProgress {
  const pattern = /Severity scoring:\s*(\d+)%\|[^|]*\|\s*(\d+)\/(\d+)/g;
  let match: RegExpExecArray | null = null;
  let latest: RegExpExecArray | null = null;
  const text = logs.slice(-200).join('');
  while ((match = pattern.exec(text)) !== null) latest = match;
  if (!latest) return null;
  return { percent: Number(latest[1]), done: Number(latest[2]), total: Number(latest[3]) };
}

function endpointLabel(endpoint: string): string {
  return endpoint.split('?')[0] || endpoint;
}

function backendDiagnostics(runtime?: BackendRuntime): string {
  const exitSummary = backendExitSummary(runtime);
  if (exitSummary) return exitSummary;
  const logs = recentBackendLogs(runtime?.logs || []);
  return logs ? `Recent backend logs:\n${logs}` : '';
}

function configurePackagedRuntimeEnv(): void {
  if (!app.isPackaged) return;
  const userData = app.getPath('userData');
  // PyInstaller emits a bare name on macOS and a .exe on Windows. Without the suffix the packaged
  // Windows app looks for a file that does not exist and the backend never starts.
  const exe = process.platform === 'win32' ? '.exe' : '';
  const agentRuntimeExecutable = path.join(process.resourcesPath, 'backend', 'agent-runtime', `ieeg-agent-runtime${exe}`);
  const hfHome = path.join(userData, 'models', 'huggingface');
  mkdirSync(hfHome, { recursive: true });
  process.env.HF_HOME ||= hfHome;
  if (!process.env.PYHFO_BACKEND_EXECUTABLE) {
    process.env.PYHFO_BACKEND_EXECUTABLE = path.join(process.resourcesPath, 'backend', 'pyhfo-backend', `pyhfo-backend${exe}`);
  }
  process.env.IEEG_AGENT_RUNTIME_EXECUTABLE ||= agentRuntimeExecutable;
  process.env.IEEG_UI_BROKER_EXECUTABLE ||= agentRuntimeExecutable;
  process.env.IEEG_UI_MCP_EXECUTABLE ||= agentRuntimeExecutable;
  // The frozen runtime looks for Skills relative to its own source tree, which inside a PyInstaller
  // bundle resolves to nothing. It does not fail -- it loads zero skills, and the co-pilot then
  // reports it has no access to severity scoring at all. Point it at the shipped copy.
  process.env.SKILLS_BASE_DIR ||= path.join(process.resourcesPath, 'skills');
  process.env.IEEG_AGENT_DATA_DIR ||= path.join(userData, 'agent-runtime', 'data');
  process.env.IEEG_AGENT_CONFIG_DIR ||= path.join(userData, 'agent-runtime', 'config');
  process.env.IEEG_STORAGE_BACKEND ||= 'local';
  process.env.IEEG_STORAGE_LOCAL_ROOT ||= path.join(userData, 'agent-runtime', 'storage');
  // Provider/model/endpoint come from the user's stored settings (DeepSeek by default), so the
  // co-pilot can be pointed at OpenAI, a gateway, or a local OpenAI-compatible server such as
  // Ollama or llama.cpp without a rebuild.
  applyLlmSettingsToEnv();
  process.env.PYHFO_PIPELINE_SUBPROCESS ||= '0';
  process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS ||= '180000';
  process.env.MPLCONFIGDIR ||= path.join(userData, 'matplotlib');
  process.env.PYHFO_MPLCONFIGDIR ||= process.env.MPLCONFIGDIR;
}

type BackendResponse = { status: number; ok: boolean; text: string };

// node:http rather than fetch. Node's fetch (undici) abandons any request whose response headers
// have not arrived within 300s, and severity scoring holds the connection far longer than that on a
// long recording -- the request died at ~31% while the backend went on scoring, surfacing as an
// unexplained 'fetch failed'. A raw http request imposes no deadline of its own, which leaves the
// opt-in timeout below as the only thing that can abort a call.
function backendHttpRequest(url: string, init: RequestInit, timeoutMs?: number): Promise<BackendResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    const body = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : undefined;
    if (body) headers['content-length'] = String(body.byteLength);
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: init.method || 'GET',
      headers
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    // A total deadline rather than node's idle-socket timeout, so timeoutMs keeps meaning what it
    // meant under AbortController.
    const timer = timeoutMs
      ? setTimeout(() => request.destroy(new Error(`request exceeded ${timeoutMs}ms timeout and was aborted`)), timeoutMs)
      : undefined;
    request.on('close', () => { if (timer) clearTimeout(timer); });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

async function backendFetch(endpoint: string, init?: RequestInit, opts?: { timeoutMs?: number }): Promise<unknown> {
  if (!backend) throw new Error('Backend is not running');
  // Opt-in timeout: only fast endpoints (e.g. waveform:window) pass one, so a hung
  // request can't wedge the single-flight scroll queue forever. Long-running calls
  // (detection, prepare, severity, exports) pass no timeout and are never aborted.
  let response: BackendResponse;
  try {
    response = await backendHttpRequest(`${backend.baseUrl}${endpoint}`, authorizedInit(init), opts?.timeoutMs);
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    const diagnostics = backendDiagnostics(backend);
    throw new Error([
      `PyHFO backend request failed before response: ${endpointLabel(endpoint)}`,
      `Network error: ${message}`,
      diagnostics
    ].filter(Boolean).join('\n'));
  }
  const responseText = response.text;
  let body: any;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch (exc) {
    throw new Error(`PyHFO backend returned a non-JSON response for ${endpointLabel(endpoint)}: HTTP ${response.status}${responseText ? `\n${responseText.slice(0, 500)}` : ''}`);
  }
  if (!response.ok) throw new Error(body?.error?.message || `Backend request failed: ${response.status}`);
  return body;
}

/**
 * Keep the local PyHFO backend alive. macOS can SIGKILL the child (e.g. memory
 * pressure across the whole app stack, or a dev-mode process-group teardown);
 * before this, the renderer just showed "request failed before response" and the
 * session was dead until a manual restart. Now an unexpected exit respawns the
 * backend and re-points the global `backend` (the renderer reads backend.baseUrl
 * fresh on every IPC call, so the next scroll/request transparently recovers).
 */
function superviseBackend(runtime: BackendRuntime): void {
  runtime.process.once('exit', (code, signal) => {
    if (quitting || runtime !== backend) return; // intentional shutdown or already replaced
    console.error(`[main] PyHFO backend exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}); restarting.`);
    void restartBackend();
  });
}

async function restartBackend(): Promise<void> {
  if (quitting) return;
  if (backendRestartCount >= MAX_BACKEND_RESTARTS) {
    console.error(`[main] PyHFO backend exceeded ${MAX_BACKEND_RESTARTS} restarts; not retrying. Reload the app to recover.`);
    return;
  }
  backendRestartCount += 1;
  try {
    backend = await startPythonBackend();
    // One source of truth for where the desktop's PyHFO session lives. The agent runtime is spawned
    // with these so results it computes itself can be written back into the session the UI reads.
    process.env.PYHFO_SESSION_URL = backend.baseUrl;
    process.env.PYHFO_SESSION_TOKEN = backend.token;
    superviseBackend(backend);
    console.error('[main] PyHFO backend restarted.');
    // Once the fresh backend proves stable, clear the budget so a later, unrelated
    // crash gets its own full restart allowance instead of tripping the cap.
    const stable = backend;
    setTimeout(() => { if (!quitting && backend === stable) backendRestartCount = 0; }, 30000);
  } catch (error) {
    console.error('[main] PyHFO backend restart failed; retrying shortly:', error instanceof Error ? error.message : error);
    setTimeout(() => { void restartBackend(); }, 1500);
  }
}

// The single agent-runtime (re)start primitive, shared by the crash supervisor and the BYO-key
// change path via agentRestartCoordinator (which serializes them). Kills the current runtime if it
// is still alive (a no-op after a crash), respawns reading the LATEST stored key and the CURRENT
// broker URL/token, re-points env, and re-arms supervision. Throws on spawn failure.
async function doAgentRestart(): Promise<void> {
  // Re-read settings on every spawn so a provider/endpoint change lands without a relaunch.
  applyLlmSettingsToEnv();
  try { agentRuntime?.process.kill(); } catch { /* already gone (crash) */ }
  const runtime = await startAgentRuntime({
    startupTimeoutMs: Number(process.env.IEEG_AGENT_STARTUP_TIMEOUT_MS) || 180000,
    llmProfile: await getActiveStoredLlmProfile(),
    uiBrokerUrl: uiBroker?.baseUrl,
    uiBrokerToken: uiBroker?.token,
    backendUrl: backend?.baseUrl,
    backendToken: backend?.token,
  });
  agentRuntime = runtime;
  process.env.AGENT_SERVICE_TOKEN = runtime.token;
  process.env.PYHFO_AGENT_SERVICE_TOKEN = runtime.token;
  process.env.PYHFO_AGENT_CHAT_URL = `${runtime.baseUrl}/internal/agent/v1/chat`;
  superviseAgentRuntime(runtime);
  // Re-arm the crash-budget reset against THIS runtime: if it is still the live agent 30s from now,
  // prior crashes are forgiven. Done here (not in the crash caller) so a healthy runtime restores the
  // budget regardless of restart origin (crash / key change / broker re-point) — otherwise a later
  // key-change or re-point that swaps the runtime would strand a stale, never-firing reset timer.
  setTimeout(() => { if (!quitting && agentRuntime === runtime) agentRuntimeRestartCount = 0; }, 30000);
}

// Keep the agent runtime (co-pilot chat) alive across crashes, mirroring superviseBackend. The
// coordinator's isBusy() feeds `intentionalRestart` so a deliberate key-change restart isn't
// mistaken for a crash and double-respawned.
function superviseAgentRuntime(runtime: BackendRuntime): void {
  runtime.process.once('exit', (code, signal) => {
    if (!shouldRestartOnExit({
      quitting,
      intentionalRestart: agentRestartCoordinator.isBusy(),
      isCurrentRuntime: runtime === agentRuntime,
      restartCount: agentRuntimeRestartCount,
      maxRestarts: MAX_CHILD_RESTARTS,
    })) return;
    console.error(`[main] agent runtime exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}); restarting.`);
    void restartAgentRuntimeAfterCrash();
  });
}

async function restartAgentRuntimeAfterCrash(): Promise<void> {
  if (quitting) return;
  if (agentRuntimeRestartCount >= MAX_CHILD_RESTARTS) {
    console.error(`[main] agent runtime exceeded ${MAX_CHILD_RESTARTS} restarts; not retrying. Reload the app to recover.`);
    return;
  }
  agentRuntimeRestartCount += 1;
  try {
    // request() resolves only when a real restart (this one, or the fresh follow-up that satisfies a
    // coalesced request) actually succeeds; the budget reset is armed inside doAgentRestart.
    await agentRestartCoordinator.request();
    console.error('[main] agent runtime restarted.');
  } catch (error) {
    console.error('[main] agent runtime restart failed; retrying shortly:', error instanceof Error ? error.message : error);
    setTimeout(() => { void restartAgentRuntimeAfterCrash(); }, 1500);
  }
}

// The single UI-broker (re)start primitive. Spawns a fresh broker and re-arms supervision + budget.
async function doUiBrokerRestart(): Promise<void> {
  const runtime = await startUiBroker({ startupTimeoutMs: Number(process.env.IEEG_UI_BROKER_STARTUP_TIMEOUT_MS) || 20000 });
  uiBroker = runtime;
  superviseUiBroker(runtime);
  setTimeout(() => { if (!quitting && uiBroker === runtime) uiBrokerRestartCount = 0; }, 30000);
}

function superviseUiBroker(runtime: BackendRuntime): void {
  runtime.process.once('exit', (code, signal) => {
    if (!shouldRestartOnExit({
      quitting,
      intentionalRestart: uiBrokerRestartCoordinator.isBusy(),
      isCurrentRuntime: runtime === uiBroker,
      restartCount: uiBrokerRestartCount,
      maxRestarts: MAX_CHILD_RESTARTS,
    })) return;
    console.error(`[main] UI broker exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'}); restarting.`);
    void restartUiBrokerAfterCrash();
  });
}

async function restartUiBrokerAfterCrash(): Promise<void> {
  if (quitting) return;
  if (uiBrokerRestartCount >= MAX_CHILD_RESTARTS) {
    console.error(`[main] UI broker exceeded ${MAX_CHILD_RESTARTS} restarts; not retrying.`);
    return;
  }
  uiBrokerRestartCount += 1;
  try {
    await uiBrokerRestartCoordinator.request();
    console.error('[main] UI broker restarted.');
  } catch (error) {
    console.error('[main] UI broker restart failed; retrying shortly:', error instanceof Error ? error.message : error);
    setTimeout(() => { void restartUiBrokerAfterCrash(); }, 1500);
    return;
  }
  // The fresh broker has a new port, so the running agent runtime holds a stale broker URL. Re-point
  // it through the agent coordinator: this is isolated (errors can't fall into the broker's control
  // flow) and serialized (never races the agent's own crash-restart into a duplicate process). Skip
  // when the agent runtime was never up or is disabled.
  if (agentRuntime && process.env.IEEG_DISABLE_AGENT_RUNTIME !== '1') {
    void agentRestartCoordinator.request().catch((error) => {
      console.error('[main] agent runtime re-point after UI broker restart failed:', error instanceof Error ? error.message : error);
    });
  }
}

async function createWindow(): Promise<void> {
  configurePackagedRuntimeEnv();
  // Start the zero-dep UI MCP broker first. The agent runtime's ieeg_ui MCP server needs this URL
  // in its environment so tool calls go through the same broker the renderer reports state to.
  // Gated by IEEG_DISABLE_UI_BROKER=1. The renderer reports ui_state + drains/applies its commands.
  if (process.env.IEEG_DISABLE_UI_BROKER !== '1') {
    try {
      uiBroker = await startUiBroker({ startupTimeoutMs: Number(process.env.IEEG_UI_BROKER_STARTUP_TIMEOUT_MS) || 20000 });
      superviseUiBroker(uiBroker);
    } catch (error) {
      console.error('[main] UI MCP broker did not start; UI MCP control disabled:', error instanceof Error ? error.message : error);
      uiBroker = undefined;
    }
  }
  // Start the LLM ReAct agent runtime so the desktop co-pilot chat works. Non-fatal: the scientific
  // PyHFO workflow still runs if it can't start. On success, point PyHFO at it (URL + shared token).
  // Gated by IEEG_DISABLE_AGENT_RUNTIME=1 so UI smokes (which don't need it) skip the agent boot.
  if (process.env.IEEG_DISABLE_AGENT_RUNTIME !== '1') {
    try {
      agentRuntime = await startAgentRuntime({
        startupTimeoutMs: Number(process.env.IEEG_AGENT_STARTUP_TIMEOUT_MS) || 180000,
        llmProfile: await getActiveStoredLlmProfile(),
        uiBrokerUrl: uiBroker?.baseUrl,
        uiBrokerToken: uiBroker?.token,
    backendUrl: backend?.baseUrl,
    backendToken: backend?.token,
      });
      process.env.AGENT_SERVICE_TOKEN = agentRuntime.token;
      process.env.PYHFO_AGENT_SERVICE_TOKEN = agentRuntime.token;
      process.env.PYHFO_AGENT_CHAT_URL = `${agentRuntime.baseUrl}/internal/agent/v1/chat`;
      superviseAgentRuntime(agentRuntime);
    } catch (error) {
      console.error('[main] agent runtime did not start; co-pilot chat disabled:', error instanceof Error ? error.message : error);
      agentRuntime = undefined;
    }
  }
  try {
    backend = await startPythonBackend();
    // One source of truth for where the desktop's PyHFO session lives. The agent runtime is spawned
    // with these so results it computes itself can be written back into the session the UI reads.
    process.env.PYHFO_SESSION_URL = backend.baseUrl;
    process.env.PYHFO_SESSION_TOKEN = backend.token;
  } catch (error) {
    // The analysis backend is fatal (unlike the broker/agent runtime above, which are
    // non-fatal). Surface the failure instead of leaving a dead dock icon with no window,
    // and reap the child backends that DID start so they aren't orphaned.
    const message = error instanceof Error ? error.message : String(error);
    console.error('[main] PyHFO backend failed to start:', message);
    stopPythonBackend(agentRuntime);
    stopPythonBackend(uiBroker);
    dialog.showErrorBox('iEEG Workstation failed to start', `The analysis backend did not start.\n\n${message}`);
    app.exit(1);
    return;
  }
  superviseBackend(backend);
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    title: 'iEEG Workstation',
    webPreferences: {
      preload: path.join(electronBundleDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  buildApplicationMenu();
  // Belt and braces: Chromium honours Ctrl+R / F5 itself, menu or no menu. In a packaged build the
  // reload is swallowed, so a stray keypress cannot discard an hour of review work.
  if (!process.env.VITE_DEV_SERVER_URL) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      const reloadCombo = (key === 'r' && (input.control || input.meta)) || key === 'f5';
      if (input.type === 'keyDown' && reloadCombo) event.preventDefault();
    });
  }
  mainWindow.on('close', async (event) => {
    const closePrompt = closePromptForState({
      workspaceDirty,
      allowUnsafeClose: allowUnsafeClose || closeGuardDisabled,
      closeSaveInProgress,
      closeDiscardPromptInProgress,
      closePrimaryPromptInProgress
    });
    if (closePrompt === 'none') return;
    event.preventDefault();
    if (closePrompt === 'discard-prompt-active') return;
    if (closePrompt === 'save-still-running') {
      closeDiscardPromptInProgress = true;
      const pendingResult = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        buttons: ['Keep Open', 'Discard Changes'],
        defaultId: 0,
        cancelId: 0,
        title: 'Project Save Still Running',
        message: 'The project save has not finished yet.',
        detail: 'Keep the workspace open to let the save finish, or discard unsaved changes and close now.'
      });
      closeDiscardPromptInProgress = false;
      if (pendingResult.response === 1) discardWorkspaceAndClose();
      return;
    }
    closePrimaryPromptInProgress = true;
    const result = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Cancel', 'Save Project', 'Discard Changes'],
      defaultId: 1,
      cancelId: 0,
      title: 'Unsaved iEEG Workspace',
      message: 'You have unsaved iEEG workspace changes.',
      detail: 'Save the project before closing to preserve recording, run, waveform, and review state.'
    }).finally(() => { closePrimaryPromptInProgress = false; });
    if (result.response === 1) {
      closeSaveInProgress = true;
      mainWindow?.webContents.send('workspace:save-before-close');
      closeSaveTimeout = setTimeout(() => {
        closeSaveInProgress = false;
        closeSaveTimeout = undefined;
        void dialog.showMessageBox(mainWindow!, {
          type: 'warning',
          buttons: ['OK'],
          defaultId: 0,
          title: 'Save Project Timed Out',
          message: 'The project save did not finish before the close timeout.',
          detail: 'The iEEG workspace was kept open so you can retry Save Project or choose Discard Changes.'
        });
      }, 30000);
      return;
    }
    if (result.response === 2) discardWorkspaceAndClose();
  });
  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
  const devUrl = safeDevServerUrl(process.env.VITE_DEV_SERVER_URL);
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(electronBundleDir, '../dist-renderer/index.html'));
}

function discardWorkspaceAndClose(): void {
  if (closeSaveTimeout) {
    clearTimeout(closeSaveTimeout);
    closeSaveTimeout = undefined;
  }
  closeSaveInProgress = false;
  allowUnsafeClose = true;
  workspaceDirty = false;
  mainWindow?.setDocumentEdited(false);
  mainWindow?.close();
}

function setWorkspaceDirty(dirty: boolean): { status: string; dirty: boolean } {
  workspaceDirty = dirty;
  if (!dirty) allowUnsafeClose = false;
  if (!dirty && closeSaveTimeout) {
    clearTimeout(closeSaveTimeout);
    closeSaveTimeout = undefined;
    closeSaveInProgress = false;
  }
  mainWindow?.setDocumentEdited(dirty);
  return { status: 'ok', dirty: workspaceDirty };
}

function completeSaveBeforeClose(saved: boolean): { status: string; saved: boolean } {
  if (closeSaveTimeout) {
    clearTimeout(closeSaveTimeout);
    closeSaveTimeout = undefined;
  }
  closeSaveInProgress = false;
  if (saved) {
    allowUnsafeClose = true;
    workspaceDirty = false;
    mainWindow?.setDocumentEdited(false);
    mainWindow?.close();
    return { status: 'closing', saved: true };
  }
  return { status: 'kept-open', saved: false };
}

async function confirmDiscardWorkspace(payload: Record<string, unknown> = {}): Promise<{ action: 'continue' | 'save' | 'discard' | 'cancel'; confirmed: boolean; dirty: boolean }> {
  if (!workspaceDirty) return { action: 'continue', confirmed: true, dirty: false };
  const action = String(payload.action || 'continue');
  const result = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons: ['Cancel', 'Save Project', 'Discard Current Workspace'],
    defaultId: 1,
    cancelId: 0,
    title: 'Unsaved iEEG Workspace',
    message: `Save unsaved workspace changes before ${action}?`,
    detail: 'Choose Save Project to preserve the current recording, run, waveform, and review state; choose Discard only if you want to replace it.'
  });
  if (result.response === 1) return { action: 'save', confirmed: true, dirty: workspaceDirty };
  if (result.response === 2) return { action: 'discard', confirmed: true, dirty: workspaceDirty };
  return { action: 'cancel', confirmed: false, dirty: workspaceDirty };
}

ipcMain.handle('backend:status', async () => {
  const health = await backendFetch('/health') as Record<string, unknown>;
  return {
    ...health,
    logs: backend?.logs.slice(-100),
    baseUrl: backend?.baseUrl,
    agent_runtime: { up: Boolean(agentRuntime) && !agentRuntime?.exited, base_url: agentRuntime?.baseUrl },
    ui_broker: { up: Boolean(uiBroker) && !uiBroker?.exited, base_url: uiBroker?.baseUrl },
  };
});
ipcMain.handle('backend:manifest', () => backendFetch('/manifest'));
ipcMain.handle('recording:open-dialog', async () => {
  const defaultPath = await loadOpenDialogLastDirectory('lastRecordingDirectory') || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openFile'], filters: [{ name: 'EEG recordings', extensions: ['edf', 'bdf', 'fif', 'gz', 'vhdr'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistOpenDialogLastDirectory('lastRecordingDirectory', result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('session:open-dialog', async () => {
  const defaultPath = await loadOpenDialogLastDirectory('lastSessionDirectory') || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openFile'], filters: [{ name: 'PyBrain sessions', extensions: ['pybrain', 'npz'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistOpenDialogLastDirectory('lastSessionDirectory', result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('project:open-dialog', async () => {
  const defaultPath = await loadOpenDialogLastDirectory('lastProjectDirectory') || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openFile'], filters: [{ name: 'PyHFO project', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistOpenDialogLastDirectory('lastProjectDirectory', result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('project:create', (_event, payload) => backendFetch('/projects/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('project:open', (_event, payload) => backendFetch('/projects/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('project:save', (_event, payload) => backendFetch('/projects/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('workspace:set-dirty', (_event, payload) => setWorkspaceDirty(Boolean(payload?.dirty)));
ipcMain.handle('workspace:confirm-discard', (_event, payload) => confirmDiscardWorkspace(payload || {}));
ipcMain.handle('workspace:save-before-close-result', (_event, payload) => completeSaveBeforeClose(Boolean(payload?.saved)));
ipcMain.handle('protocol-preset:save-dialog', (_event, payload) => saveProtocolPresetWithDialog({ ...(payload || {}) }));
ipcMain.handle('protocol-preset:open-dialog', () => openProtocolPresetWithDialog());
ipcMain.handle('batch:open-input-directory', async () => {
  const defaultPath = await loadOpenDialogLastDirectory('lastBatchInputDirectory') || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistOpenDialogLastDirectory('lastBatchInputDirectory', path.join(result.filePaths[0], 'selected'));
  return result.filePaths[0];
});
ipcMain.handle('batch:open-output-directory', async () => {
  const defaultPath = await loadOpenDialogLastDirectory('lastBatchOutputDirectory') || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistOpenDialogLastDirectory('lastBatchOutputDirectory', path.join(result.filePaths[0], 'selected'));
  return result.filePaths[0];
});
ipcMain.handle('classifier-model:open-dialog', async () => {
  const defaultPath = await loadClassifierModelLastDirectory() || app.getPath('documents');
  const result = await dialog.showOpenDialog(mainWindow!, { defaultPath, properties: ['openFile'], filters: [{ name: 'Classifier model files', extensions: ['tar', 'onnx'] }, { name: 'All files', extensions: ['*'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  await persistClassifierModelLastDirectory(result.filePaths[0]);
  return result.filePaths[0];
});
ipcMain.handle('recording:load', (_event, payload) => backendFetch('/recordings/load', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
ipcMain.handle('recording:roi', (_event, payload) => backendFetch('/recordings/roi', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('recording:qc', (_event, payload) => backendFetch('/recordings/qc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('recording:spectral', (_event, payload) => backendFetch('/recordings/spectral', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));

ipcMain.handle('recording:prepare', (_event, payload) => {
  const request = { ...(payload || {}) };
  request.output_path ||= defaultPreparedOutputPath(request);
  return backendFetch('/recordings/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
});

ipcMain.handle('session:load', (_event, payload) => backendFetch('/sessions/open-saved', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
ipcMain.handle('waveform:window', (_event, payload) => {
  const query = new URLSearchParams({ ...payload, channels: (payload.channels || []).join(','), target_samples_per_channel: String(payload.target_samples_per_channel) });
  // A waveform window is normally <250ms even on a 2 kHz multi-hour recording; cap it
  // so a hung backend can't freeze the single-flight scroll queue indefinitely.
  return backendFetch(`/waveform/window?${query.toString()}`, undefined, { timeoutMs: 20000 });
});
ipcMain.handle('events:list', (_event, payload) => {
  const query = new URLSearchParams();
  if (payload?.run_id) query.set('run_id', String(payload.run_id));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return backendFetch(`/events${suffix}`);
});
ipcMain.handle('events:cursor', (_event, payload) => backendFetch('/events/cursor', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('events:snippet', (_event, payload) => backendFetch('/events/snippet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('events:feature-summary', (_event, payload) => backendFetch('/events/feature-summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('events:annotate', (_event, payload) => backendFetch(`/events/${encodeURIComponent(String(payload?.event_id || ''))}/annotation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('events:overlap-review', (_event, payload) => backendFetch('/events/overlap-review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('runs:create-consensus', (_event, payload) => backendFetch('/runs/consensus', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('runs:classify-active', (_event, payload) => {
  const request = { ...(payload || {}) };
  if (!request.output_dir && typeof request.session_path === 'string') {
    const session = path.parse(request.session_path);
    const managedRuns = path.join(app.getPath('userData'), 'detection-runs');
    if (path.dirname(session.dir) === managedRuns) {
      request.output_dir = path.join(session.dir, `${session.name}-classified`);
    }
  }
  return backendFetch('/runs/classify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
});
ipcMain.handle('detections:run', (_event, payload) => {
  const request = { ...(payload || {}) };
  request.output_dir ||= defaultDetectionOutputDir(request);
  request.exports ||= ['csv', 'session', 'summary_json'];
  return backendFetch('/detections/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
});
ipcMain.handle('detections:rank-candidates', (_event, payload) => backendFetch('/detections/rank-candidates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('severity:run', (_event, payload) => backendFetch('/severity/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('severity:get', () => backendFetch('/severity'));
// Severity scoring is one blocking pass that can run for a quarter of an hour on a long recording.
// The model reports nothing per-request, but it does emit tqdm progress on the backend's stderr,
// which is already captured -- reading the last line back is what turns a silent spinner into a
// count the user can watch advance.
ipcMain.handle('severity:progress', () => severityProgressFromLogs(backend?.logs || []));
ipcMain.handle('severity:cancel', () => backendFetch('/severity/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
ipcMain.handle('batch:create', (_event, payload) => backendFetch('/batch/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('batch:run', (_event, payload) => backendFetch('/batch/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('parameters:recommend', (_event, payload) => backendFetch('/parameters/recommend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }));
ipcMain.handle('parameters:detector-defaults', (_event, payload) => backendFetch('/parameters/detector-defaults', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
// BYO-key: the user's LLM key lives only in the OS keychain (never in a config file). Restart the
// agent runtime so a newly saved/cleared key takes effect — it is injected as env at spawn.
async function restartAgentRuntimeWithStoredKey(): Promise<void> {
  if (process.env.IEEG_DISABLE_AGENT_RUNTIME === '1') return;
  // Go through the coordinator so this deliberate restart is serialized with any in-flight
  // crash-restart (never two concurrent spawns) and the exit supervisor sees isBusy()=true and
  // won't treat the kill as a crash. doAgentRestart reads the latest stored key.
  await agentRestartCoordinator.request();
}
ipcMain.handle('llm-key:status', async () => {
  const profileStatus = await getStoredLlmProfileStatus();
  const activeProfile = await getActiveStoredLlmProfile();
  const settings = activeProfile
    ? {
        provider: activeProfile.provider === 'custom' ? 'openai_compatible' : activeProfile.provider,
        model: activeProfile.model,
        apiBase: activeProfile.apiBase,
      }
    : getLlmSettings();
  return {
    // `hasKey` describes the credential the running Agent can actually use. Keep other stored
    // profiles and unbound legacy ciphertext separate so the UI never shows a green "key set"
    // state while startup intentionally injects no credential.
    hasKey: profileStatus.activeHasKey,
    anyStoredKey: profileStatus.hasKey,
    encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
    agentUp: Boolean(agentRuntime && !agentRuntime.exited),
    activeProvider: activeProfile?.provider,
    legacy: profileStatus.legacy,
    profiles: profileStatus.profiles,
    settings,
    providers: SUPPORTED_LLM_PROVIDERS,
    defaults: DEFAULT_LLM_SETTINGS,
    // The renderer uses this to stop demanding a key for a server that ignores one.
    keyless: isKeylessLlmEndpoint(settings),
  };
});
// Model discovery, connection test, and usage all run in main so the API key never crosses to the
// renderer. Each takes the settings the user currently has on screen (not the saved ones) so they
// can be tried before committing.
ipcMain.handle('llm-models:list', async (_event, payload: unknown) => {
  const draft = (payload || {}) as { provider?: string; apiBase?: string; model?: string; apiKey?: string };
  const settings = getLlmSettings();
  try {
    const profile = await resolveStoredLlmProfile({
      provider: draft.provider || (settings.provider === 'openai_compatible' ? 'custom' : settings.provider),
      apiBase: draft.apiBase || settings.apiBase,
      model: draft.model || settings.model,
      apiKey: draft.apiKey,
    });
    return listLlmModels(profile.apiBase, profile.apiKey);
  } catch (error) {
    return { ok: false, models: [], error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('llm-connection:test', async (_event, payload: unknown) => {
  const draft = (payload || {}) as { apiBase?: string; model?: string; apiKey?: string };
  const settings = getLlmSettings();
  const apiBase = String(draft.apiBase || settings.apiBase);
  const model = String(draft.model || settings.model);
  const apiKey = String(draft.apiKey || '') || await getStoredLlmKey(apiBase);
  return testLlmConnection(apiBase, apiKey, model);
});
ipcMain.handle('llm-usage:summary', async () => {
  if (!agentRuntime || agentRuntime.exited) return { ok: false, turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastModel: null, lastAt: null, error: 'The agent runtime is not running.' };
  return readLlmUsage(agentRuntime.baseUrl, agentRuntime.token);
});
ipcMain.handle('llm-settings:set', async (_event, payload: unknown) => {
  try {
    const next = (payload || {}) as { provider?: string; model?: string; apiBase?: string };
    const settings = setLlmSettings(next);
    applyLlmSettingsToEnv();
    // No restart: provider/model/endpoint travel with each turn now, so the next message uses them.
    // (An API KEY change still restarts -- the key is injected into the runtime's environment at
    // spawn -- and that path is llm-key:set, not this one.)
    return { ok: true, settings, keyless: isKeylessLlmEndpoint(settings), agentUp: Boolean(agentRuntime && !agentRuntime.exited) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('llm-key:set', async (_event, key: unknown) => {
  try {
    await setStoredLlmKey(String(key ?? ''));
    await restartAgentRuntimeWithStoredKey();
    return { ok: true, agentUp: Boolean(agentRuntime && !agentRuntime.exited) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('llm-key:clear', async () => {
  try { await clearStoredLlmKey(); await restartAgentRuntimeWithStoredKey(); return { ok: true }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
});
ipcMain.handle('llm-profile:status', async () => ({
  ...await getStoredLlmProfileStatus(),
  encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
  agentUp: Boolean(agentRuntime && !agentRuntime.exited),
}));
ipcMain.handle('llm-profile:test', async (_event, input: unknown) => {
  try {
    const profile = await resolveStoredLlmProfile((input || {}) as Record<string, unknown>);
    return await testLlmConnection(profile.apiBase, profile.apiKey, profile.model);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('llm-profile:save', async (_event, input: unknown) => {
  try {
    const profile = await saveStoredLlmProfile((input || {}) as Record<string, unknown>);
    setLlmSettings({
      provider: profile.provider === 'custom' ? 'openai_compatible' : profile.provider,
      model: profile.model,
      apiBase: profile.apiBase,
    });
    applyLlmSettingsToEnv();
    await restartAgentRuntimeWithStoredKey();
    return { ok: true, profile, agentUp: Boolean(agentRuntime && !agentRuntime.exited) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('llm-profile:clear', async (_event, provider: unknown) => {
  try {
    await clearStoredLlmProfile(provider);
    await restartAgentRuntimeWithStoredKey();
    return { ok: true, agentUp: Boolean(agentRuntime && !agentRuntime.exited) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// Every turn carries the model settings in force right now: switching model is a settings write,
// not a process restart, and the change lands on the next message.
function withLlmSettings(payload: unknown): Record<string, unknown> {
  const settings = getLlmSettings();
  return {
    ...(payload as Record<string, unknown> || {}),
    model: settings.model,
    provider: settings.provider,
    api_base: settings.apiBase,
    // Where this desktop's PyHFO session lives, sent per TURN rather than left to the runtime's
    // environment. The runtime is spawned before the backend exists (the backend needs the agent's
    // URL, the agent needs the backend's -- one of them has to start first), so PYHFO_SESSION_URL
    // never reached the child. Without it the runtime believed no desktop was attached and ran
    // severity in its own process: no confirmation bubble, no progress, an empty panel, and a chat
    // reply full of numbers the workspace had never heard of.
    session_url: backend?.baseUrl,
    session_token: backend?.token
  };
}
ipcMain.handle('agent:chat', (_event, payload) => submitAgentChat(backend!.baseUrl, backend!.token, withLlmSettings(payload) as never));
ipcMain.handle('agent:chat-result', (_event, jobId) => getAgentChatResult(backend!.baseUrl, backend!.token, String(jobId || '')));
// D (Phase 1): stream the agent turn straight from the runtime's SSE endpoint and push each event to
// the renderer over 'agent:event'. Returns a streamId immediately; events arrive asynchronously.
/**
 * Explain a failed agent turn using the runtime's own words.
 *
 * The runtime answers an SSE turn with 200 and only then starts generating, so an exception raised
 * mid-generation cannot change the status code -- it just drops the socket. Node's fetch reports that
 * as the single word "terminated", which is what the chat panel used to show: no status, no traceback,
 * nothing to act on. The traceback is already sitting in the runtime's captured stderr, so attach it.
 */
function agentStreamFailureMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error && err.cause ? ` (${err.cause instanceof Error ? err.cause.message : String(err.cause)})` : '';
  const dropped = /terminated|socket|ECONNRESET|other side closed/i.test(raw);
  if (!dropped) return `${raw}${cause}`;
  const lines = recentBackendLogs(agentRuntime?.logs, 40).split('\n');
  // The exception line IS the diagnosis; stack frames and the source snippets Python interleaves with
  // them ("^^^", the echoed line of code) only bury it. Quote that one line, or fall back to the tail.
  const failure = lines.reverse().find((line) => /(Error|Exception)\b.*:/.test(line));
  if (failure) return `The agent runtime failed mid-answer: ${failure.replace(/^\s*\|\s*/, '').trim()}`;
  const tail = lines.slice(0, 4).reverse().filter(Boolean).join('\n');
  return tail
    ? `The agent runtime closed the connection mid-answer.\n\nRuntime said:\n${tail}`
    : 'The agent runtime closed the connection mid-answer.';
}

ipcMain.handle('agent:chat-stream', (event, payload) => {
  if (!agentRuntime || agentRuntime.exited) throw new Error('Agent runtime is not running; streaming chat is unavailable.');
  const streamId = `stream-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  // Track an AbortController per stream so the renderer can cancel an abandoned turn (timeout /
  // error / superseded). Without this, an abandoned SSE keeps being read here and keeps emitting
  // on the shared 'agent:event' channel — the frames leak into the next turn and the backend
  // generation runs on uselessly.
  const controller = new AbortController();
  activeAgentStreams.set(streamId, controller);
  const send = (e: { event: string; data: unknown }) => { if (!event.sender.isDestroyed()) event.sender.send('agent:event', { streamId, event: e.event, data: e.data }); };
  void (async () => {
    try {
      await streamAgentChat(agentRuntime!.baseUrl, agentRuntime!.token, withLlmSettings(payload) as never, send, controller.signal);
      send({ event: 'end', data: {} });
    } catch (err) {
      // A deliberate cancel surfaces as an AbortError; don't relay it as a stream error.
      if (!controller.signal.aborted) {
        send({ event: 'error', data: { message: agentStreamFailureMessage(err) } });
      }
    } finally {
      activeAgentStreams.delete(streamId);
    }
  })();
  return { streamId };
});
ipcMain.handle('agent:chat-stream-cancel', (_event, streamId: unknown) => {
  const controller = activeAgentStreams.get(String(streamId || ''));
  if (controller) { controller.abort(); activeAgentStreams.delete(String(streamId)); }
  return { ok: true };
});

// UI MCP connector (last mile): the renderer reports its ui_state to the broker and drains/applies the
// broker's queued commands. These IPC handlers proxy the renderer <-> broker; the external MCP server
// (Claude) talks to the broker's other side. Tolerant when the broker is down (returns empty).
async function brokerFetch(brokerPath: string, init?: Parameters<typeof fetch>[1]): Promise<unknown> {
  if (!uiBroker || uiBroker.exited) return { __broker: 'down' };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (uiBroker.token) headers.authorization = `Bearer ${uiBroker.token}`;
  const response = await fetch(`${uiBroker.baseUrl}${brokerPath}`, { ...(init || {}), headers: { ...headers, ...((init?.headers as Record<string, string>) || {}) } });
  if (!response.ok) throw new Error(`UI broker ${brokerPath} failed: ${response.status}`);
  return response.json();
}
ipcMain.handle('ui-broker:report-state', (_event, payload) => brokerFetch('/ui/state', { method: 'POST', body: JSON.stringify({ ui_state: (payload && (payload as { ui_state?: unknown }).ui_state) ?? payload ?? {} }) }));
ipcMain.handle('ui-broker:poll', () => brokerFetch('/ui/commands', { method: 'GET' }));
ipcMain.handle('ui-broker:ack', (_event, payload) => brokerFetch('/ui/ack', { method: 'POST', body: JSON.stringify(payload || {}) }));

ipcMain.handle('artifact:open-path', async (_event, payload) => {
  const artifactPath = String(payload?.path || '');
  if (!artifactPath) return { status: 'cancelled', reason: 'missing_path' };
  const error = await shell.openPath(artifactPath);
  return error ? { status: 'failed', error } : { status: 'complete', artifact_path: artifactPath };
});


ipcMain.handle('artifact:reveal-path', async (_event, payload) => {
  const artifactPath = String(payload?.path || '');
  if (!artifactPath) return { status: 'cancelled', reason: 'missing_path' };
  shell.showItemInFolder(artifactPath);
  return { status: 'complete', artifact_path: artifactPath };
});

ipcMain.handle('exports:session', (_event, payload) => backendFetch('/exports/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('exports:report', (_event, payload) => backendFetch('/exports/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('exports:workbook', (_event, payload) => backendFetch('/exports/workbook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) }));
ipcMain.handle('exports:session-save-dialog', (_event, payload) => saveBackendExportWithDialog({ ...(payload || {}) }, { title: 'Save PyBrain Session', defaultName: 'session.pybrain', extension: 'pybrain', filterName: 'PyBrain Session', endpoint: '/exports/session', filters: [{ name: 'PyBrain Session', extensions: ['pybrain'] }, { name: 'Legacy PyBrain NPZ Session', extensions: ['npz'] }] }));
ipcMain.handle('exports:workbook-save-dialog', (_event, payload) => saveBackendExportWithDialog({ ...(payload || {}) }, { title: 'Export Workbook', defaultName: 'workbook.xlsx', extension: 'xlsx', filterName: 'Excel Workbook', endpoint: '/exports/workbook' }));
ipcMain.handle('exports:report-save-dialog', (_event, payload) => saveBackendExportWithDialog({ ...(payload || {}) }, { title: 'Export Analysis Report', defaultName: 'report.html', extension: 'html', filterName: 'HTML Report', endpoint: '/exports/report', filters: [{ name: 'HTML Report', extensions: ['html'] }, { name: 'CSV Report', extensions: ['csv'] }, { name: 'JSON Report', extensions: ['json'] }] }));

ipcMain.handle('exports:snapshot-png', async (_event, payload) => {
  const buffer = decodePngDataUrl(payload?.data_url);
  const defaultName = safePngDefaultName(payload?.default_name);
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: String(payload?.title || 'Save PNG Snapshot'),
    defaultPath: path.join(app.getPath('pictures'), defaultName),
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  });
  if (result.canceled || !result.filePath) return { status: 'cancelled', canceled: true };
  const targetPath = result.filePath.toLowerCase().endsWith('.png') ? result.filePath : `${result.filePath}.png`;
  await writeFile(targetPath, buffer);
  return { status: 'complete', canceled: false, artifact_type: 'png_snapshot', artifact_path: targetPath };
});


app.whenReady().then(createWindow).then(() => {
  // Fire-and-forget housekeeping, chained after the window exists so a slow or failing sweep can
  // never delay startup. Safe to run concurrently with a detection: it only touches runs that
  // predate this process and already have a summary.json.
  void runStartupRetention(app.getPath('userData'));
}).catch((error) => {
  // Surface any startup failure instead of swallowing it (a rejected createWindow would
  // otherwise leave a dead dock icon with no window and no message).
  const message = error instanceof Error ? error.message : String(error);
  console.error('[main] createWindow failed:', message);
  try { dialog.showErrorBox('iEEG Workstation failed to start', message); } catch { /* ignore */ }
  app.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason);
});
app.on('before-quit', () => { quitting = true; stopPythonBackend(backend); stopPythonBackend(agentRuntime); stopPythonBackend(uiBroker); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
