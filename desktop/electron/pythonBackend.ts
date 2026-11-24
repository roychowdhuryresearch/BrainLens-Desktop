import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

export type BackendRuntime = {
  process: ChildProcessByStdio<null, Readable, Readable>;
  baseUrl: string;
  token: string;
  logs: string[];
  exited?: { code: number | null; signal: NodeJS.Signals | null };
};

export type LlmRuntimeProfile = {
  provider: string;
  apiBase: string;
  model: string;
  apiKey: string;
};

export function llmRuntimeProfileEnv(profile?: Partial<LlmRuntimeProfile>, legacyApiKey?: string): Record<string, string> {
  const apiKey = String(profile?.apiKey || legacyApiKey || '').trim();
  if (!apiKey) return {};
  const env: Record<string, string> = { IEEG_LLM_API_KEY: apiKey };
  const provider = String(profile?.provider || '').trim();
  const apiBase = String(profile?.apiBase || '').trim();
  const model = String(profile?.model || '').trim();
  if (provider) env.IEEG_LLM_PROVIDER = provider;
  if (apiBase) env.IEEG_LLM_API_BASE = apiBase;
  if (model) env.IEEG_LLM_MODEL = model;
  return env;
}

/**
 * Parent-death guard preamble injected ahead of every spawned Python backend.
 *
 * The graceful path (app 'before-quit' -> stopPythonBackend -> SIGTERM) only runs on a clean
 * Electron quit. When the parent dies non-gracefully — force-quit, crash, or a `kill` of the
 * `npm run electron` dev wrapper — 'before-quit' never fires and these children are orphaned
 * (observed: stacked `uvicorn app.main` + `ui_mcp.broker` processes eating ~1.3GB across dev
 * launches). macOS has no Linux PR_SET_PDEATHSIG, so each child watches its own parent instead:
 * a daemon thread polls os.getppid() and hard-exits the moment it no longer sees the spawning
 * Electron process. runpy then runs the real `python -m <module>` target as __main__, so the
 * guard is transparent to the module. Poll cadence is IEEG_PARENT_GUARD_INTERVAL seconds
 * (default 2; tests set it low).
 *
 * Robustness: the spawner passes its own PID as IEEG_PARENT_PID, so the child knows exactly which
 * parent is legitimate. This survives the startup race where the parent dies *before* the child
 * finishes booting (capturing os.getppid() at startup would then latch onto pid 1 and never fire).
 * We also treat ppid==1 as orphaned (on macOS an orphan is always reparented to launchd/pid 1),
 * which covers the fallback case where IEEG_PARENT_PID is absent.
 *
 * Spawned as `python -c <guard> <module> <args...>`, so the module + args remain real argv
 * tokens — `pgrep -f 'uvicorn app.main'` / `pgrep -f ui_mcp.broker` still match for diagnostics.
 */
export const PARENT_DEATH_GUARD = [
  'import os, sys, threading, time, runpy',
  "_expected = int(os.environ.get('IEEG_PARENT_PID') or os.getppid())",
  "_interval = float(os.environ.get('IEEG_PARENT_GUARD_INTERVAL', '2') or '2')",
  'def _watch():',
  '    while True:',
  '        time.sleep(_interval)',
  '        try:',
  '            cur = os.getppid()',
  '        except Exception:',
  '            cur = 1',
  '        if cur != _expected or cur == 1:',  // reparented away from the spawner, or adopted by launchd -> orphaned
  '            os._exit(0)',
  'threading.Thread(target=_watch, daemon=True).start()',
  '_mod = sys.argv[1]',
  'sys.argv = sys.argv[1:]',
  "runpy.run_module(_mod, run_name='__main__', alter_sys=True)",
].join('\n');

/**
 * Wrap a `['-m', '<module>', ...args]` argv with the parent-death guard, yielding
 * `['-c', PARENT_DEATH_GUARD, '<module>', ...args]`. The guard reads the module name from
 * sys.argv[1] and runpy's it as __main__, so spawn sites keep listing the natural
 * `-m <module> <args>` form. See PARENT_DEATH_GUARD for why every backend child needs this.
 */
export function guardedModuleArgs(moduleArgs: string[]): string[] {
  if (moduleArgs[0] !== '-m' || moduleArgs.length < 2) {
    throw new Error(`guardedModuleArgs expects ['-m', '<module>', ...args], received: ${JSON.stringify(moduleArgs)}`);
  }
  return ['-c', PARENT_DEATH_GUARD, ...moduleArgs.slice(1)];
}

export function recentBackendLogs(logs: string[] = [], limit = 12): string {
  return logs
    .flatMap((chunk) => String(chunk).split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit)
    .join('\n');
}

export function backendExitSummary(runtime?: BackendRuntime): string {
  if (!runtime) return '';
  const exited = runtime.exited || (runtime.process.exitCode !== null || runtime.process.signalCode ? { code: runtime.process.exitCode, signal: runtime.process.signalCode } : undefined);
  if (!exited) return '';
  const logs = recentBackendLogs(runtime.logs);
  const reason = `PyHFO backend process exited (code ${exited.code ?? 'null'}, signal ${exited.signal ?? 'null'}).`;
  return logs ? `${reason}\nRecent backend logs:\n${logs}` : reason;
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a local backend port.')));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function configuredPort(value?: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PYHFO_BACKEND_PORT: ${value}`);
  return port;
}

export function configuredStartupTimeoutMs(value?: string): number {
  if (!value) return 60000;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) throw new Error(`Invalid PYHFO_BACKEND_STARTUP_TIMEOUT_MS: ${value}`);
  return timeout;
}

function childHasExited(child?: ChildProcessByStdio<null, Readable, Readable>): boolean {
  return Boolean(child && (child.exitCode !== null || child.signalCode !== null));
}

/**
 * Reject immediately when a child is configured to run a binary that isn't there.
 *
 * spawn() reports a missing executable through an 'error' event, not an exit: exitCode and
 * signalCode both stay null, so childHasExited() never trips and waitForHealth() polls a socket
 * nothing is listening on until its deadline. In the packaged app that meant a missing
 * agent-runtime binary cost 180s (plus 20s for the UI broker) BEFORE the analysis backend was
 * even spawned -- and since createWindow() awaits all of it, the user stared at no window at all
 * for over three minutes on a normal launch.
 *
 * Only configured paths are checked. A bare command name (`python`) is left to PATH resolution.
 */
function assertConfiguredExecutable(label: string, executable?: string): void {
  if (!executable) return;
  if (!existsSync(executable)) {
    throw new Error(`${label} executable not found: ${executable}`);
  }
}

/**
 * spawn() emits 'error' on ENOENT/EACCES, and an 'error' event with no listener is re-thrown as an
 * uncaught exception. Record it in the child's logs so the failure shows up in the startup error
 * instead of taking down (or silently destabilising) the main process.
 */
function captureSpawnErrors(child: ChildProcessByStdio<null, Readable, Readable>, logs: string[]): void {
  child.once('error', (error) => {
    logs.push(`spawn error: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}

export async function waitForHealth(baseUrl: string, token?: string, timeoutMs = 15000, child?: ChildProcessByStdio<null, Readable, Readable>, logs: string[] = []): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastFetchError = '';
  while (Date.now() < deadline) {
    if (childHasExited(child)) {
      const recentLogs = recentBackendLogs(logs);
      throw new Error(`PyHFO backend exited before becoming healthy at ${baseUrl}.${recentLogs ? `\nRecent backend logs:\n${recentLogs}` : ''}`);
    }
    // Bound each probe with an AbortController so a socket that accepts the connection but
    // never answers /health can't block past the deadline (Node fetch has no default
    // per-request timeout, and the while-loop only re-checks the deadline between iterations).
    const controller = new AbortController();
    const probeTimeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(1500, deadline - Date.now())));
    try {
      const init: RequestInit = { signal: controller.signal };
      if (token) init.headers = { authorization: `Bearer ${token}` };
      const response = await fetch(`${baseUrl}/health`, init);
      if (response.ok) return;
      lastFetchError = `HTTP ${response.status}`;
    } catch (error) {
      lastFetchError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(probeTimeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const recentLogs = recentBackendLogs(logs);
  throw new Error([
    `PyHFO backend did not become healthy at ${baseUrl} within ${timeoutMs}ms.`,
    lastFetchError ? `Last health check error: ${lastFetchError}` : '',
    recentLogs ? `Recent backend logs:\n${recentLogs}` : ''
  ].filter(Boolean).join('\n'));
}

export async function startPythonBackend(options: { python?: string; executable?: string; port?: number; startupTimeoutMs?: number } = {}): Promise<BackendRuntime> {
  const python = options.python || process.env.PYHFO_BACKEND_PYTHON || 'python';
  const executable = options.executable || process.env.PYHFO_BACKEND_EXECUTABLE;
  const port = options.port ?? configuredPort(process.env.PYHFO_BACKEND_PORT) ?? await findFreePort();
  const startupTimeoutMs = options.startupTimeoutMs ?? configuredStartupTimeoutMs(process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS);
  const token = randomBytes(24).toString('hex');
  assertConfiguredExecutable('PyHFO backend', executable);
  const cwd = process.env.PYHFO_APP_ROOT || (executable ? process.cwd() : '../pyhfo');
  const env: NodeJS.ProcessEnv = { ...process.env, PYHFO_ELECTRON_TOKEN: token, IEEG_PARENT_PID: String(process.pid) };
  if (!executable) {
    env.PYTHONPATH = [resolve(cwd, 'src'), env.PYTHONPATH].filter(Boolean).join(delimiter);
  }
  const backendCommand = executable || python;
  const backendArgs = executable
    ? ['--host', '127.0.0.1', '--port', String(port)]
    : guardedModuleArgs(['-m', 'pyhfo.agent_api.server', '--host', '127.0.0.1', '--port', String(port)]);
  const child = spawn(backendCommand, backendArgs, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs: string[] = [];
  captureSpawnErrors(child, logs);
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime: BackendRuntime = { process: child, baseUrl, token, logs };
  child.once('exit', (code, signal) => {
    runtime.exited = { code, signal };
  });
  try {
    await waitForHealth(baseUrl, token, startupTimeoutMs, child, logs);
  } catch (error) {
    if (!child.killed) child.kill();
    throw error;
  }
  return runtime;
}

export function agentServiceToken(env: NodeJS.ProcessEnv): string {
  return env.PYHFO_AGENT_SERVICE_TOKEN?.trim() || env.AGENT_SERVICE_TOKEN?.trim() || randomBytes(24).toString('hex');
}

/**
 * Start the LLM ReAct agent runtime (FastAPI app in `runtime`) so the desktop co-pilot chat works.
 * Mints/propagates AGENT_SERVICE_TOKEN (the token PyHFO must send and the agent validates) and
 * health-gates the agent's app-level /health (which needs no token). Caller wires PyHFO to it via
 * PYHFO_AGENT_CHAT_URL + AGENT_SERVICE_TOKEN.
 */
export async function startAgentRuntime(options: { python?: string; executable?: string; port?: number; startupTimeoutMs?: number; llmProfile?: LlmRuntimeProfile; llmApiKey?: string; uiBrokerUrl?: string; uiBrokerToken?: string; backendUrl?: string; backendToken?: string } = {}): Promise<BackendRuntime> {
  const python = options.python || process.env.PYHFO_BACKEND_PYTHON || 'python';
  const executable = options.executable || process.env.IEEG_AGENT_RUNTIME_EXECUTABLE;
  const port = options.port ?? configuredPort(process.env.IEEG_AGENT_PORT) ?? await findFreePort();
  const startupTimeoutMs = options.startupTimeoutMs ?? configuredStartupTimeoutMs(process.env.IEEG_AGENT_STARTUP_TIMEOUT_MS);
  const token = agentServiceToken(process.env);
  assertConfiguredExecutable('Agent runtime', executable);
  // The desktop co-pilot uses the ieeg_ui MCP connector plus built-in PyHFO tools.
  // BYO-key: inject the user's keychain-stored LLM key as env only (never a config file). The runtime
  // (config.py _apply_env_api_key) lets IEEG_LLM_API_KEY override any configured key.
  const env = {
    ...process.env,
    AGENT_SERVICE_TOKEN: token,
    PYHFO_AGENT_SERVICE_TOKEN: token,
    // The PyHFO session the desktop is showing. The agent writes results it computed in its own
    // process back to this session, so the workspace reflects agent-triggered work.
    ...(options.backendUrl ? { PYHFO_SESSION_URL: options.backendUrl } : {}),
    ...(options.backendToken ? { PYHFO_SESSION_TOKEN: options.backendToken } : {}),
    IEEG_AGENT_SKIP_MCP: process.env.IEEG_AGENT_SKIP_MCP || '0',
    IEEG_AGENT_MCP_SERVERS: process.env.IEEG_AGENT_MCP_SERVERS || 'ieeg_ui',
    IEEG_UI_BROKER_URL: options.uiBrokerUrl || process.env.IEEG_UI_BROKER_URL || 'http://127.0.0.1:8770',
    ...(options.uiBrokerToken || process.env.IEEG_UI_BROKER_TOKEN ? { IEEG_UI_BROKER_TOKEN: options.uiBrokerToken || process.env.IEEG_UI_BROKER_TOKEN || '' } : {}),
    IEEG_AGENT_SKIP_TONE: process.env.IEEG_AGENT_SKIP_TONE || '1',
    IEEG_PARENT_PID: String(process.pid),
    ...llmRuntimeProfileEnv(options.llmProfile, options.llmApiKey)
  };
  const agentCommand = executable || python;
  const agentArgs = executable
    ? ['serve', '--host', '127.0.0.1', '--port', String(port)]
    : guardedModuleArgs(['-m', 'uvicorn', 'runtime.main:app', '--host', '127.0.0.1', '--port', String(port)]);
  const child = spawn(agentCommand, agentArgs, {
    cwd: process.env.IEEG_AGENT_ROOT || (executable ? process.cwd() : '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs: string[] = [];
  captureSpawnErrors(child, logs);
  // IEEG_DEBUG_AGENT_LOGS=1 echoes the runtime's own log to this process's stderr. Kept in memory
  // only, the runtime's account of what it decided (which tool ran, and where) is invisible unless
  // something throws -- which is no help when the complaint is that nothing visibly happened.
  const echoAgentLogs = process.env.IEEG_DEBUG_AGENT_LOGS === '1';
  child.stdout.on('data', (chunk) => { logs.push(String(chunk)); if (echoAgentLogs) process.stderr.write(`[agent] ${chunk}`); });
  child.stderr.on('data', (chunk) => { logs.push(String(chunk)); if (echoAgentLogs) process.stderr.write(`[agent] ${chunk}`); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime: BackendRuntime = { process: child, baseUrl, token, logs };
  child.once('exit', (code, signal) => {
    runtime.exited = { code, signal };
  });
  try {
    await waitForHealth(baseUrl, undefined, startupTimeoutMs, child, logs); // agent /health is auth-free
  } catch (error) {
    if (!child.killed) child.kill();
    throw error;
  }
  return runtime;
}

/**
 * Start the zero-dependency UI MCP broker (ui_mcp/broker.py) — the stable hub that lets an
 * external MCP agent drive this desktop UI. The renderer reports ui_state to it and drains/applies its
 * queued commands; the Claude-spawned stdio MCP server (ui_mcp/mcp_server.py) is a separate client of
 * the same broker. Stdlib only, so it never touches the agent's Python env. Every broker process gets
 * a fresh bearer token shared only with the renderer proxy and its agent-runtime MCP child.
 */
export function mintUiBrokerToken(): string {
  return randomBytes(32).toString('hex');
}

export async function startUiBroker(options: { python?: string; executable?: string; port?: number; startupTimeoutMs?: number } = {}): Promise<BackendRuntime> {
  const python = options.python || process.env.PYHFO_BACKEND_PYTHON || 'python';
  const executable = options.executable || process.env.IEEG_UI_BROKER_EXECUTABLE;
  const port = options.port ?? configuredPort(process.env.IEEG_UI_BROKER_PORT) ?? await findFreePort();
  const startupTimeoutMs = options.startupTimeoutMs ?? 20000;
  const token = mintUiBrokerToken();
  assertConfiguredExecutable('UI broker', executable);
  const env = { ...process.env, IEEG_UI_BROKER_TOKEN: token, IEEG_PARENT_PID: String(process.pid) };
  const brokerCommand = executable || python;
  const brokerArgs = executable
    ? ['--ui-broker', '--host', '127.0.0.1', '--port', String(port)]
    : guardedModuleArgs(['-m', 'ui_mcp.broker', '--host', '127.0.0.1', '--port', String(port)]);
  const child = spawn(brokerCommand, brokerArgs, {
    cwd: process.env.IEEG_AGENT_ROOT || (executable ? process.cwd() : '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const logs: string[] = [];
  captureSpawnErrors(child, logs);
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const baseUrl = `http://127.0.0.1:${port}`;
  const runtime: BackendRuntime = { process: child, baseUrl, token, logs };
  child.once('exit', (code, signal) => {
    runtime.exited = { code, signal };
  });
  try {
    await waitForHealth(baseUrl, undefined, startupTimeoutMs, child, logs); // broker /health is auth-free
  } catch (error) {
    if (!child.killed) child.kill();
    throw error;
  }
  return runtime;
}

export function stopPythonBackend(runtime?: BackendRuntime): void {
  if (runtime?.process && !runtime.process.killed) runtime.process.kill();
}
