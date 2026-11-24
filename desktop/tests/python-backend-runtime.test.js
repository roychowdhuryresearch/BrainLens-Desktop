import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadPythonBackend() {
  const source = readFileSync(join(root, 'electron/pythonBackend.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      isolatedModules: true
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const backendPromise = loadPythonBackend();

test('python backend allocates an ephemeral localhost port by default', async () => {
  const backend = await backendPromise;
  const port = await backend.findFreePort();
  assert.equal(Number.isInteger(port), true);
  assert.ok(port > 0 && port <= 65535);
});

test('each UI broker start can mint a fresh strong bearer token', async () => {
  const backend = await backendPromise;
  const first = backend.mintUiBrokerToken();
  const second = backend.mintUiBrokerToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);

  const source = readFileSync(join(root, 'electron/pythonBackend.ts'), 'utf8');
  assert.match(source, /const token = mintUiBrokerToken\(\)/);
  assert.match(source, /IEEG_UI_BROKER_TOKEN: token/);
  assert.match(source, /uiBrokerToken: uiBroker\?\.token|options\.uiBrokerToken/);
});

test('agent service token matches Python alias precedence and is minted for an unconfigured launch', async () => {
  const { agentServiceToken } = await backendPromise;
  assert.equal(agentServiceToken({ PYHFO_AGENT_SERVICE_TOKEN: ' primary ', AGENT_SERVICE_TOKEN: ' secondary ' }), 'primary');
  assert.equal(agentServiceToken({ PYHFO_AGENT_SERVICE_TOKEN: ' ', AGENT_SERVICE_TOKEN: ' secondary ' }), 'secondary');
  const minted = agentServiceToken({});
  assert.match(minted, /^[0-9a-f]{48}$/);
  assert.notEqual(agentServiceToken({}), minted);
});

test('agent runtime injects a provider-bound LLM profile as one environment tuple', async () => {
  const backend = await backendPromise;
  const env = backend.llmRuntimeProfileEnv({
    provider: 'deepseek',
    apiBase: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    apiKey: 'profile-secret',
  });

  assert.deepEqual(env, {
    IEEG_LLM_API_KEY: 'profile-secret',
    IEEG_LLM_PROVIDER: 'deepseek',
    IEEG_LLM_API_BASE: 'https://api.deepseek.com',
    IEEG_LLM_MODEL: 'deepseek-v4-flash',
  });
  assert.deepEqual(backend.llmRuntimeProfileEnv(undefined, 'legacy-key'), { IEEG_LLM_API_KEY: 'legacy-key' });
  assert.deepEqual(backend.llmRuntimeProfileEnv(), {});
});

test('python backend startup reports child exits with recent stderr', async () => {
  const backend = await backendPromise;
  const fakeProcess = { exitCode: 48, signalCode: null };
  const runtime = { process: fakeProcess, baseUrl: 'http://127.0.0.1:8765', token: 'token', logs: ['Traceback\n', 'OSError: [Errno 48] Address already in use\n'] };

  assert.match(backend.recentBackendLogs(runtime.logs), /Address already in use/);
  assert.match(backend.backendExitSummary(runtime), /code 48/);
  assert.match(backend.backendExitSummary(runtime), /Address already in use/);
  await assert.rejects(
    () => backend.waitForHealth('http://127.0.0.1:8765', 'token', 10, fakeProcess, runtime.logs),
    /PyHFO backend exited before becoming healthy/
  );
});

test('python backend startup timeout is configurable and long enough for cold PyHFO imports', async () => {
  const backend = await backendPromise;
  assert.equal(backend.configuredStartupTimeoutMs(), 60000);
  assert.equal(backend.configuredStartupTimeoutMs('90000'), 90000);
  assert.throws(() => backend.configuredStartupTimeoutMs('999'), /Invalid PYHFO_BACKEND_STARTUP_TIMEOUT_MS/);
  assert.throws(() => backend.configuredStartupTimeoutMs('not-a-number'), /Invalid PYHFO_BACKEND_STARTUP_TIMEOUT_MS/);
});

test('guardedModuleArgs wraps a python -m invocation with the parent-death guard', async () => {
  const backend = await backendPromise;
  const wrapped = backend.guardedModuleArgs(['-m', 'uvicorn', 'runtime.main:app', '--host', '127.0.0.1', '--port', '9100']);
  // The guard runs as `python -c <guard> <module> <args...>`.
  assert.equal(wrapped[0], '-c');
  assert.equal(wrapped[1], backend.PARENT_DEATH_GUARD);
  // Module + args stay as real argv tokens after the guard, so `pgrep -f 'uvicorn app.main'` still matches.
  assert.deepEqual(wrapped.slice(2), ['uvicorn', 'runtime.main:app', '--host', '127.0.0.1', '--port', '9100']);
  // The guard watches the parent PID and runpy's the real module as __main__.
  assert.match(backend.PARENT_DEATH_GUARD, /getppid/);
  assert.match(backend.PARENT_DEATH_GUARD, /runpy\.run_module/);
});

test('guardedModuleArgs rejects argv that is not a python -m invocation', async () => {
  const backend = await backendPromise;
  assert.throws(() => backend.guardedModuleArgs(['uvicorn', 'runtime.main:app']), /expects \['-m'/);
  assert.throws(() => backend.guardedModuleArgs(['-m']), /expects \['-m'/);
});

test('agent runtime and UI broker can spawn from the packaged executable contract', () => {
  const source = readFileSync(join(root, 'electron/pythonBackend.ts'), 'utf8');
  assert.match(source, /process\.env\.IEEG_AGENT_RUNTIME_EXECUTABLE/);
  assert.match(source, /\['serve', '--host', '127\.0\.0\.1', '--port', String\(port\)\]/);
  assert.match(source, /process\.env\.IEEG_UI_BROKER_EXECUTABLE/);
  assert.match(source, /\['--ui-broker', '--host', '127\.0\.0\.1', '--port', String\(port\)\]/);
  assert.match(source, /guardedModuleArgs\(\['-m', 'uvicorn', 'runtime\.main:app'/);
  assert.match(source, /guardedModuleArgs\(\['-m', 'ui_mcp\.broker'/);
});

function resolvePython() {
  for (const candidate of [process.env.PYHFO_BACKEND_PYTHON, 'python3', 'python'].filter(Boolean)) {
    try {
      const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
      if (!probe.error && probe.status === 0) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The core orphan-prevention guarantee: a guarded backend child must self-terminate when its
// parent dies non-gracefully (no 'before-quit', no SIGTERM). We stand an intermediate Python
// process in for the Electron main process: it spawns the guarded grandchild (a harmless
// long-lived http.server), reports the grandchild PID, then blocks. SIGKILLing the intermediate
// reproduces a force-quit/crash; the grandchild's ppid changes and its watchdog must hard-exit.
test('guarded backend child self-exits when its parent dies non-gracefully', async (t) => {
  // The guard is a POSIX mechanism: it watches for os.getppid() to change when the parent dies,
  // and the test reproduces that with SIGKILL. Windows has neither real signals nor the same
  // reparenting semantics, so this can't be exercised there (it aborts the runner mid-teardown).
  if (process.platform === 'win32') {
    t.skip('parent-death guard relies on POSIX signals and ppid reparenting');
    return;
  }
  const python = resolvePython();
  if (!python) {
    t.skip('no python interpreter available to exercise the parent-death guard');
    return;
  }
  const backend = await backendPromise;
  const guard = backend.PARENT_DEATH_GUARD;
  // Mirror production: the spawner passes its own PID as IEEG_PARENT_PID so the guard knows which
  // parent is legitimate (and fires even if the parent dies before the child finishes booting).
  const parentSrc = [
    'import os, sys, subprocess, time',
    'guard = sys.argv[1]',
    "env = dict(os.environ, IEEG_PARENT_PID=str(os.getpid()), IEEG_PARENT_GUARD_INTERVAL='0.3')",
    "child = subprocess.Popen([sys.executable, '-c', guard, 'http.server', '0'], env=env)",
    'print(child.pid, flush=True)',
    'time.sleep(600)',
  ].join('\n');

  const parent = spawn(python, ['-c', parentSrc, guard], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  let grandchildPid;
  try {
    grandchildPid = await new Promise((resolve, reject) => {
      let buffered = '';
      const timer = setTimeout(() => reject(new Error('guarded grandchild did not report its PID in time')), 20000);
      parent.stdout.on('data', (chunk) => {
        buffered += String(chunk);
        const match = /(\d+)/.exec(buffered);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      parent.once('error', (error) => { clearTimeout(timer); reject(error); });
      parent.once('exit', () => { clearTimeout(timer); reject(new Error('intermediate parent exited before reporting a PID')); });
    });

    assert.equal(pidAlive(grandchildPid), true, 'guarded grandchild should be running before the parent dies');

    // Non-graceful parent death: the child gets no SIGTERM, only the reparenting signal.
    parent.kill('SIGKILL');

    // Watchdog polls every 0.3s; poll up to ~10s for generous CI headroom.
    let exited = false;
    for (let i = 0; i < 100; i += 1) {
      if (!pidAlive(grandchildPid)) {
        exited = true;
        break;
      }
      await sleep(100);
    }
    assert.equal(exited, true, 'guarded grandchild must self-exit after its parent is SIGKILLed');
  } finally {
    if (!parent.killed) parent.kill('SIGKILL');
    if (grandchildPid && pidAlive(grandchildPid)) {
      try { process.kill(grandchildPid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
});
