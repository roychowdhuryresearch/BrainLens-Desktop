#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const electronExecutable = require('electron');
const defaultPyhfoRoot = join(repoRoot, 'pyhfo');
const defaultAgentRoot = repoRoot;
const logDir = join('/tmp', 'ieeg-electron-launch');
const stdoutLog = join(logDir, 'latest.stdout.log');
const stderrLog = join(logDir, 'latest.stderr.log');
const launcherPath = fileURLToPath(import.meta.url);
const launchedAsEntryPoint = Boolean(process.argv[1] && resolve(process.argv[1]) === launcherPath);

const options = parseArgs(launchedAsEntryPoint ? process.argv.slice(2) : []);

function parseArgs(args) {
  const opts = {
    rebuild: false,
    noBuild: false,
    clean: true,
    agent: true,
    uiBroker: true,
    foreground: false,
    verifyTimeoutMs: 240000,
  };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--rebuild') opts.rebuild = true;
    else if (arg === '--no-build') opts.noBuild = true;
    else if (arg === '--keep-existing') opts.clean = false;
    else if (arg === '--no-agent') opts.agent = false;
    else if (arg === '--ui-broker') opts.uiBroker = true;
    else if (arg === '--no-ui-broker') opts.uiBroker = false;
    else if (arg === '--foreground') opts.foreground = true;
    else if (arg.startsWith('--verify-timeout-ms=')) opts.verifyTimeoutMs = Number(arg.split('=')[1]) || opts.verifyTimeoutMs;
    else fail(`Unknown option: ${arg}\nRun npm run app -- --help for usage.`);
  }
  return opts;
}

function printHelp() {
  console.log(`Usage: npm run app -- [options]

Launch the production Electron iEEG workstation with the local PyHFO backend.

Options:
  --rebuild                 Run npm run build before launching.
  --no-build                Fail instead of rebuilding missing or stale dist outputs.
  --keep-existing           Do not terminate existing ieeg-agent Electron instances first.
  --no-agent                Disable the local agent runtime.
  --ui-broker               Enable the UI MCP broker. Default.
  --no-ui-broker            Disable the UI MCP broker.
  --foreground              Launch through npm/electron in the foreground instead of macOS open.
  --verify-timeout-ms=N     Wait limit for process verification. Default: 240000.
`);
}

function fail(message) {
  console.error(`[launch] ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(`[launch] ${message}`);
}

function runChecked(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || desktopRoot,
    env: opts.env || process.env,
    encoding: 'utf8',
    stdio: opts.stdio || 'pipe',
  });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout || '';
}

function executablePath(pathValue) {
  if (!pathValue) return false;
  try {
    accessSync(pathValue, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDirectory(envName, fallback, sentinel) {
  const value = process.env[envName] ? resolve(process.env[envName]) : fallback;
  if (!existsSync(value)) fail(`${envName} does not exist: ${value}`);
  if (sentinel && !existsSync(join(value, sentinel))) fail(`${envName} is not valid: missing ${join(value, sentinel)}`);
  return value;
}

function checkPythonCandidate(candidate, pyhfoRoot, agentRoot, requireAgent = true) {
  const executableResult = spawnSync(candidate, ['-c', 'import sys; print(sys.executable)'], {
    cwd: desktopRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (executableResult.status !== 0) {
    // spawnSync leaves stderr null when the candidate cannot be spawned at all (several
    // candidates below are macOS-only paths, so this is the norm on Windows). Reading .trim()
    // off it threw and aborted the whole search instead of moving to the next candidate.
    return { ok: false, reason: (executableResult.stderr || '').trim() || executableResult.error?.message || `exit ${executableResult.status}` };
  }
  const resolved = executableResult.stdout.trim().split('\n').at(-1) || candidate;
  if (!executablePath(resolved) && !executablePath(candidate)) return { ok: false, reason: `not executable: ${resolved}` };
  const executable = executablePath(resolved) ? resolved : candidate;
  // fastapi/uvicorn belong to the agent runtime, not to PyHFO -- the PyHFO backend serves over
  // http.server. Requiring them even under --no-agent made the launcher refuse a perfectly good
  // PyHFO environment and then report "could not find a Python", which is misleading.
  const checks = [
    { cwd: pyhfoRoot, code: 'import numpy' },
    { cwd: join(pyhfoRoot, 'src'), code: 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("pyhfo.agent_api.server") else 1)' },
    ...(requireAgent ? [
      { cwd: pyhfoRoot, code: 'import fastapi, uvicorn' },
      { cwd: agentRoot, code: 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("runtime.main") else 1)' },
    ] : []),
  ];
  for (const check of checks) {
    const result = spawnSync(executable, ['-c', check.code], {
      cwd: check.cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status !== 0) {
      return { ok: false, reason: (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n').slice(-4).join('\n') };
    }
  }
  return { ok: true, executable };
}

function resolvePython(pyhfoRoot, agentRoot, requireAgent = true) {
  const candidates = [
    process.env.PYHFO_BACKEND_PYTHON,
    process.env.PYTHON,
    'python',
    'python3',
    join(homedir(), 'miniconda3/bin/python'),
    join(homedir(), 'miniconda3/bin/python3'),
    join(homedir(), 'anaconda3/bin/python'),
    join(homedir(), 'mambaforge/bin/python'),
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ].filter(Boolean);

  const seen = new Set();
  const failures = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const check = checkPythonCandidate(candidate, pyhfoRoot, agentRoot, requireAgent);
    if (check.ok) return check.executable;
    failures.push(`${candidate}: ${check.reason}`);
  }
  fail(`Could not find a Python that can start both PyHFO and the agent runtime. Set PYHFO_BACKEND_PYTHON=/absolute/path/to/python.\n${failures.join('\n\n')}`);
}

const BUILD_OUTPUTS = [
  'dist-electron/main.js',
  'dist-electron/preload.cjs',
  'dist-electron/pythonBackend.js',
  'dist-renderer/index.html',
];
const BUILD_INPUT_ROOTS = ['electron', 'src'];
const BUILD_INPUT_FILES = ['index.html', 'vite.config.ts', 'tsconfig.json', 'electron/tsconfig.json', 'package.json', 'package-lock.json'];
const SECURITY_SOURCE = 'electron/pythonBackend.ts';
const BUILD_MANIFEST = 'dist-electron/.launch-build-manifest.json';

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const pathValue = join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(pathValue);
    return entry.isFile() ? [pathValue] : [];
  });
}

export function buildInputPaths(root = desktopRoot) {
  const nested = BUILD_INPUT_ROOTS.flatMap((relativePath) => walkFiles(join(root, relativePath)));
  const direct = BUILD_INPUT_FILES.map((relativePath) => join(root, relativePath)).filter((pathValue) => existsSync(pathValue));
  return [...new Set([...nested, ...direct])];
}

export function buildOutputPaths(root = desktopRoot) {
  return BUILD_OUTPUTS.map((relativePath) => join(root, relativePath));
}

function fileSha256(pathValue) {
  return createHash('sha256').update(readFileSync(pathValue)).digest('hex');
}

function securitySourceSha256(root = desktopRoot) {
  const pathValue = join(root, SECURITY_SOURCE);
  return existsSync(pathValue) ? fileSha256(pathValue) : '';
}

function readBuildManifest(root = desktopRoot) {
  try {
    return JSON.parse(readFileSync(join(root, BUILD_MANIFEST), 'utf8'));
  } catch {
    return {};
  }
}

function compiledTokenMintContractIsCurrent(root = desktopRoot) {
  const pathValue = join(root, 'dist-electron/pythonBackend.js');
  if (!existsSync(pathValue)) return false;
  const compiled = readFileSync(pathValue, 'utf8');
  return /function mintUiBrokerToken\(\)[\s\S]{0,160}randomBytes\(32\)\.toString\(['"]hex['"]\)/.test(compiled)
    && /const token = mintUiBrokerToken\(\)/.test(compiled)
    && /IEEG_UI_BROKER_TOKEN:\s*token/.test(compiled);
}

export function buildStalenessReasons(root = desktopRoot) {
  const reasons = [];
  const outputs = buildOutputPaths(root);
  const missingOutputs = outputs.filter((pathValue) => !existsSync(pathValue));
  if (missingOutputs.length) reasons.push(`missing outputs: ${missingOutputs.map((pathValue) => basename(pathValue)).join(', ')}`);

  const inputs = buildInputPaths(root);
  if (!inputs.length) reasons.push('no build source inputs found');
  if (!missingOutputs.length && inputs.length) {
    const newestInput = Math.max(...inputs.map((pathValue) => statSync(pathValue).mtimeMs));
    const oldestOutput = Math.min(...outputs.map((pathValue) => statSync(pathValue).mtimeMs));
    if (newestInput > oldestOutput) reasons.push('source inputs are newer than production outputs');
  }

  const sourceDigest = securitySourceSha256(root);
  const manifestDigest = String(readBuildManifest(root).security_source_sha256 || '');
  if (!sourceDigest) reasons.push(`security source is missing: ${SECURITY_SOURCE}`);
  else if (sourceDigest !== manifestDigest) reasons.push('UI broker token-mint source differs from the last production build');
  if (!compiledTokenMintContractIsCurrent(root)) reasons.push('compiled UI broker token-mint contract is missing or stale');
  return [...new Set(reasons)];
}

export function writeBuildManifest(root = desktopRoot) {
  const pathValue = join(root, BUILD_MANIFEST);
  mkdirSync(dirname(pathValue), { recursive: true });
  writeFileSync(pathValue, `${JSON.stringify({
    version: 1,
    security_source: SECURITY_SOURCE,
    security_source_sha256: securitySourceSha256(root),
    built_at: new Date().toISOString(),
  }, null, 2)}\n`);
}

function ensureBuild() {
  const staleReasons = buildStalenessReasons();
  if (options.rebuild || staleReasons.length) {
    if (options.noBuild) fail(`Production build outputs require a rebuild (${staleReasons.join('; ') || 'explicit --rebuild'}) and --no-build was provided.`);
    info(options.rebuild
      ? 'Rebuilding production Electron app...'
      : `Production build is stale (${staleReasons.join('; ')}); running npm run build...`);
    runChecked('npm', ['run', 'build'], { cwd: desktopRoot, stdio: 'inherit' });
    writeBuildManifest();
    const remainingReasons = buildStalenessReasons();
    if (remainingReasons.length) fail(`Production build did not satisfy launcher integrity checks: ${remainingReasons.join('; ')}`);
  }
}

function electronAppRoot() {
  const marker = '.app/Contents/MacOS/';
  if (process.platform !== 'darwin') return '';
  if (!electronExecutable.includes(marker)) return '';
  return electronExecutable.slice(0, electronExecutable.indexOf(marker) + '.app'.length);
}

function readProcessTable() {
  // `ps -axo` is POSIX. On Windows the Git-Bash ps rejects -axo and runChecked aborts the whole
  // launch, so plain `npm run app` never got as far as starting Electron. There is no cheap
  // equivalent that yields ppid + full argv here, and this table is only used to find and reap
  // previous instances -- so on Windows we report none and skip the reaping (same effect as
  // --keep-existing) rather than failing the launch.
  if (process.platform === 'win32') return [];
  const output = runChecked('ps', ['-axo', 'pid=,ppid=,args='], { cwd: desktopRoot });
  return output.split('\n').map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), args: match[3] } : null;
  }).filter(Boolean);
}

function matchingMainProcess(row) {
  return row.args.includes(desktopRoot)
    && (
      row.args.includes('/node_modules/.bin/electron')
      || row.args.includes('/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
      || row.args.includes(electronExecutable)
    );
}

function descendantsOf(rows, parentPids) {
  const selected = new Set(parentPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!selected.has(row.pid) && selected.has(row.ppid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return selected;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanExisting() {
  if (!options.clean) return;
  const rows = readProcessTable();
  const mains = rows.filter(matchingMainProcess).map((row) => row.pid);
  if (!mains.length) return;
  const targets = [...descendantsOf(rows, mains)].filter((pid) => pid !== process.pid);
  info(`Stopping existing ieeg-agent Electron process tree: ${targets.join(', ')}`);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const alive = readProcessTable().filter((row) => targets.includes(row.pid));
    if (!alive.length) return;
    await sleep(250);
  }
  for (const pid of targets) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

function launchEnv(python, pyhfoRoot, agentRoot) {
  const inherited = { ...process.env };
  // An inherited ELECTRON_RUN_AS_NODE=1 (some terminals and agent shells set it) makes electron.exe
  // execute main.js as plain Node, which dies on the first `import { app } from 'electron'` -- after
  // it has already spawned the Python children. The symptom is backends running and no window.
  delete inherited.ELECTRON_RUN_AS_NODE;
  return {
    ...inherited,
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
    IEEG_DISABLE_AGENT_RUNTIME: options.agent ? '0' : '1',
    IEEG_DISABLE_UI_BROKER: options.uiBroker ? '0' : '1',
    IEEG_AGENT_SKIP_MCP: process.env.IEEG_AGENT_SKIP_MCP || '0',
    IEEG_AGENT_MCP_SERVERS: process.env.IEEG_AGENT_MCP_SERVERS || 'ieeg_ui',
    IEEG_AGENT_SKIP_TONE: process.env.IEEG_AGENT_SKIP_TONE || '1',
    IEEG_AGENT_STARTUP_TIMEOUT_MS: process.env.IEEG_AGENT_STARTUP_TIMEOUT_MS || '180000',
    IEEG_UI_BROKER_STARTUP_TIMEOUT_MS: process.env.IEEG_UI_BROKER_STARTUP_TIMEOUT_MS || '20000',
    PYHFO_BACKEND_STARTUP_TIMEOUT_MS: process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS || '90000',
    PYHFO_BACKEND_PYTHON: python,
    // The frozen agent runtime, when one is available: it carries its own dependencies, so the
    // backend interpreter never has to satisfy the runtime's imports too.
    ...(process.env.IEEG_AGENT_RUNTIME_EXECUTABLE ? { IEEG_AGENT_RUNTIME_EXECUTABLE: process.env.IEEG_AGENT_RUNTIME_EXECUTABLE } : {}),
    PYHFO_APP_ROOT: pyhfoRoot,
    IEEG_AGENT_ROOT: agentRoot,
  };
}

function launchWithOpen(env) {
  const appRoot = electronAppRoot();
  if (!appRoot || !existsSync(appRoot)) return false;
  mkdirSync(logDir, { recursive: true });
  writeFileSync(stdoutLog, '');
  writeFileSync(stderrLog, '');
  const envArgs = Object.entries(env)
    .filter(([key]) => [
      'ELECTRON_DISABLE_SECURITY_WARNINGS',
      'IEEG_DISABLE_AGENT_RUNTIME',
      'IEEG_DISABLE_UI_BROKER',
      'IEEG_AGENT_SKIP_MCP',
      'IEEG_AGENT_MCP_SERVERS',
      'IEEG_AGENT_SKIP_TONE',
      'IEEG_AGENT_STARTUP_TIMEOUT_MS',
      'IEEG_UI_BROKER_STARTUP_TIMEOUT_MS',
      'PYHFO_BACKEND_STARTUP_TIMEOUT_MS',
      'PYHFO_BACKEND_PYTHON',
      'PYHFO_APP_ROOT',
      'IEEG_AGENT_ROOT',
      'AGENT_SERVICE_TOKEN',
      'PYHFO_AGENT_SERVICE_TOKEN',
      'OPENAI_API_KEY',
      'IEEG_LLM_API_KEY',
    ].includes(key))
    .flatMap(([key, value]) => ['--env', `${key}=${value}`]);
  const args = ['-n', '-F', appRoot, ...envArgs, '--stdout', stdoutLog, '--stderr', stderrLog, '--args', desktopRoot];
  const result = spawnSync('/usr/bin/open', args, { cwd: desktopRoot, encoding: 'utf8', stdio: 'pipe' });
  if (result.error) return false;
  if (result.status !== 0) fail(`/usr/bin/open failed:\n${result.stderr || result.stdout}`);
  info(`Launched via macOS open. Logs: ${stdoutLog}, ${stderrLog}`);
  return true;
}

function launchForeground(env) {
  info('Launching Electron in the foreground.');
  const child = spawn(electronExecutable, [desktopRoot], { cwd: desktopRoot, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code || 0)));
}

function launchDetached(env) {
  const child = spawn(electronExecutable, [desktopRoot], { cwd: desktopRoot, env, detached: true, stdio: 'ignore' });
  child.unref();
  info(`Launched detached Electron pid ${child.pid}.`);
}

function parsePort(args, moduleName) {
  if (!args.includes(moduleName)) return null;
  const match = args.match(/--port\s+(\d+)/);
  return match ? Number(match[1]) : null;
}

async function healthOk(port) {
  if (!port) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function logTail() {
  const result = spawnSync('tail', ['-n', '80', stderrLog], { encoding: 'utf8', stdio: 'pipe' });
  return result.status === 0 ? result.stdout.trim() : '';
}

async function verifyLaunch() {
  const deadline = Date.now() + options.verifyTimeoutMs;
  let last = {};
  while (Date.now() < deadline) {
    const rows = readProcessTable();
    const main = rows.find(matchingMainProcess);
    const renderer = rows.find((row) => row.ppid === main?.pid && row.args.includes('Electron Helper (Renderer)'));
    const pyhfo = rows.find((row) => row.ppid === main?.pid && row.args.includes('pyhfo.agent_api.server'));
    const agent = rows.find((row) => row.ppid === main?.pid && row.args.includes('runtime.main:app'));
    const broker = rows.find((row) => row.ppid === main?.pid && row.args.includes('ui_mcp.broker'));
    const agentPort = parsePort(agent?.args || '', 'runtime.main:app');
    const agentHealthy = options.agent ? await healthOk(agentPort) : true;
    const brokerPort = parsePort(broker?.args || '', 'ui_mcp.broker');
    const brokerHealthy = options.uiBroker ? await healthOk(brokerPort) : true;
    last = {
      main: main?.pid,
      renderer: renderer?.pid,
      pyhfo: pyhfo?.pid,
      agent: agent?.pid,
      agentPort,
      agentHealthy,
      broker: broker?.pid,
      brokerPort,
      brokerHealthy,
    };
    if (main && renderer && pyhfo && (!options.agent || (agent && agentHealthy)) && (!options.uiBroker || (broker && brokerHealthy))) {
      info(`Ready: Electron ${main.pid}, renderer ${renderer.pid}, PyHFO ${pyhfo.pid}${options.agent ? `, agent ${agent.pid} on ${agentPort}` : ''}${options.uiBroker ? `, UI broker ${broker.pid} on ${brokerPort}` : ''}.`);
      if (process.platform === 'darwin') spawnSync('osascript', ['-e', 'tell application "Electron" to activate'], { stdio: 'ignore' });
      return;
    }
    await sleep(1000);
  }
  const tail = existsSync(stderrLog) ? logTail() : '';
  fail(`Electron launch did not verify within ${options.verifyTimeoutMs}ms. Last state: ${JSON.stringify(last)}${tail ? `\n\nstderr tail:\n${tail}` : ''}`);
}

/**
 * Is any runtime .py newer than the frozen binary? Mirrors the packaging gate's staleness rule
 * (verify-python-binaries.mjs), but decides which runtime a DEV launch uses rather than blocking.
 * The runtime root is scanned shallowly so a sibling .venv of newer site-packages cannot skew it.
 */
function runtimeSourcesNewerThan(exePath) {
  const builtAt = statSync(exePath).mtimeMs;
  const ignored = new Set(['__pycache__', '.pytest_cache', 'dist', 'build', 'node_modules', '.venv']);
  const roots = ['core', 'services', 'agent_runtime', 'api', 'scripts'].map((name) => join(repoRoot, 'runtime', name));
  const stack = [...roots.filter(existsSync)];
  for (const entry of readdirSync(join(repoRoot, 'runtime'), { withFileTypes: true })) {
    if (!entry.isDirectory() && entry.name.endsWith('.py')) {
      if (statSync(join(repoRoot, 'runtime', entry.name)).mtimeMs > builtAt) return true;
    }
  }
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) stack.push(full);
      } else if (entry.name.endsWith('.py') && statSync(full).mtimeMs > builtAt) {
        return true;
      }
    }
  }
  return false;
}

async function main() {
  const pyhfoRoot = resolveDirectory('PYHFO_APP_ROOT', defaultPyhfoRoot, 'src/pyhfo/agent_api/server.py');
  const agentRoot = resolveDirectory('IEEG_AGENT_ROOT', defaultAgentRoot, 'runtime/main.py');
  // The agent runtime does NOT have to come from the same interpreter as the backend: its
  // dependencies (uvicorn, fastapi, watchdog) live in runtime/.venv while torch/mne live in the
  // pyhfo env, and no single interpreter here has both. When a runtime executable or its own
  // interpreter is supplied, stop demanding one python that can start everything.
  const frozenRuntime = join(repoRoot, 'runtime', 'dist', 'ieeg-agent-runtime', 'ieeg-agent-runtime.exe');
  // A frozen binary older than the runtime sources is NOT a valid stand-in for them. Preferring it
  // unconditionally is how a dev run reproduced a bug that had already been fixed in source: every
  // chat turn died with "Model '<name>' not found in configuration" because the binary predated
  // per-request model selection. Stale binary -> run from source and say so.
  if (existsSync(frozenRuntime) && runtimeSourcesNewerThan(frozenRuntime)) {
    info('Agent runtime: WARNING — the frozen binary is older than runtime/ sources, so this run does');
    info('  not include your latest runtime changes. Rebuild: npm run build:python -- ieeg-agent-runtime');
  }
  const agentRuntimeExecutable = process.env.IEEG_AGENT_RUNTIME_EXECUTABLE
    || (existsSync(frozenRuntime) ? frozenRuntime : '');
  if (agentRuntimeExecutable) process.env.IEEG_AGENT_RUNTIME_EXECUTABLE = agentRuntimeExecutable;
  const requireAgentPython = options.agent !== false && !agentRuntimeExecutable;
  const python = resolvePython(pyhfoRoot, agentRoot, requireAgentPython);
  ensureBuild();
  await cleanExisting();
  const env = launchEnv(python, pyhfoRoot, agentRoot);
  info(`Desktop root: ${desktopRoot}`);
  info(`PyHFO root: ${pyhfoRoot}`);
  info(`Agent root: ${agentRoot}`);
  info(`Python: ${python}`);
  info(`Agent runtime: ${options.agent ? 'enabled' : 'disabled'}`);
  if (options.foreground) {
    launchForeground(env);
    return;
  }
  if (!launchWithOpen(env)) launchDetached(env);
  await verifyLaunch();
}

if (launchedAsEntryPoint) {
  main().catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)));
}
