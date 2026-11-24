#!/usr/bin/env node
/**
 * Gate in front of packaging: the bundled Python binaries must exist, be complete, and be NEWER than
 * the Python sources they were built from.
 *
 * `electron-builder` copies whatever is sitting in those dist folders, so a Python change that was
 * never re-frozen ships silently — the app looks right and behaves like the old code. That happened:
 * artifact-aware severity scoring was edited, packaged, and handed over while the binary in the
 * installer was a day old. Staleness is therefore a build failure, not a warning.
 *
 * Set PYHFO_SKIP_BINARY_CHECK=1 to bypass (renderer-only iteration).
 */
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));

const TARGETS = [
  {
    name: 'pyhfo-backend',
    exe: join(repoRoot, 'pyhfo', 'dist', 'pyhfo-backend', 'pyhfo-backend.exe'),
    dist: join(repoRoot, 'pyhfo', 'dist', 'pyhfo-backend'),
    // The binary's own offline check. Folder markers do not work: pure-python packages are compiled
    // into the embedded PYZ and never appear under _internal, so uvicorn/fastapi are invisible there.
    selfTest: ['--self-test'],
    // Boot arguments and the path that proves it is alive.
    boot: (port, token) => ({ args: ['--host', '127.0.0.1', '--port', String(port)], env: { PYHFO_BACKEND_TOKEN: token }, health: `/health` }),
    sources: [join(repoRoot, 'pyhfo', 'src'), join(repoRoot, 'pyhfo', 'scripts'), { dir: join(repoRoot, 'pyhfo'), shallow: true }],
    rebuild: 'npm run build:python -- pyhfo-backend',
  },
  {
    name: 'ieeg-agent-runtime',
    exe: join(repoRoot, 'runtime', 'dist', 'ieeg-agent-runtime', 'ieeg-agent-runtime.exe'),
    dist: join(repoRoot, 'runtime', 'dist', 'ieeg-agent-runtime'),
    selfTest: ['--self-test'],
    boot: (port, token) => ({ args: ['serve', '--host', '127.0.0.1', '--port', String(port)], env: { AGENT_SERVICE_TOKEN: token, IEEG_AGENT_INTERNAL_TOKEN: token }, health: `/health` }),
    sources: [
      join(repoRoot, 'runtime', 'core'), join(repoRoot, 'runtime', 'services'),
      join(repoRoot, 'runtime', 'agent_runtime'), join(repoRoot, 'runtime', 'api'),
      join(repoRoot, 'runtime', 'scripts'),
      // The runtime's top-level modules -- runtime_bootstrap.py among them. Leaving these out is how a
      // binary that could not resolve a per-request model passed this gate and shipped: every chat turn
      // died mid-stream with "Model '<name>' not found in configuration". Shallow on purpose, so a
      // sibling .venv full of newer site-packages cannot fail the build.
      { dir: join(repoRoot, 'runtime'), shallow: true },
    ],
    rebuild: 'npm run build:python -- ieeg-agent-runtime',
  },
];

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/**
 * Start the binary the way the app starts it and wait for it to answer. This is the check that
 * matters: a bundle can pass --self-test and still be missing an import that only the serving path
 * touches (that is exactly how a runtime with no `watchdog` reached a user).
 */
async function bootProbe(target) {
  const port = await freePort();
  const token = 'verify-' + Math.random().toString(16).slice(2);
  const boot = target.boot(port, token);
  const child = spawn(target.exe, boot.args, {
    env: { ...process.env, ...boot.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const deadline = Date.now() + 120000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode) {
        return { ok: false, detail: logs.join('').trim().split(/\r?\n/).slice(-4).join(' | ') || `exited ${child.exitCode}` };
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}${boot.health}`, { headers: { authorization: `Bearer ${token}` } });
        if (response.status < 500) return { ok: true, detail: `answered ${response.status} on ${boot.health}` };
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return { ok: false, detail: 'did not answer within 120s: ' + (logs.join('').trim().split(/\r?\n/).slice(-3).join(' | ')) };
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
}

const IGNORED_DIRS = new Set(['__pycache__', '.pytest_cache', 'dist', 'build', 'node_modules']);

/**
 * Newest .py mtime under a source entry. An entry is either a path (recursive) or
 * `{ dir, shallow: true }` for a directory whose own files matter but whose subtrees are covered
 * elsewhere -- or contain a virtualenv that must not be scanned.
 */
function newestPythonMtime(entry) {
  const root = typeof entry === 'string' ? entry : entry.dir;
  const shallow = typeof entry === 'string' ? false : Boolean(entry.shallow);
  if (!existsSync(root)) return 0;
  let newest = 0;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!shallow && !IGNORED_DIRS.has(entry.name)) stack.push(join(current, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.py')) continue;
      newest = Math.max(newest, statSync(join(current, entry.name)).mtimeMs);
    }
  }
  return newest;
}

if (process.env.PYHFO_SKIP_BINARY_CHECK === '1') {
  console.log('[skip] PYHFO_SKIP_BINARY_CHECK=1 — packaging whatever binaries are present.');
  process.exit(0);
}

const problems = [];
for (const target of TARGETS) {
  if (!existsSync(target.exe)) {
    problems.push(`${target.name}: not built (${target.exe}). Run: ${target.rebuild}`);
    continue;
  }
  const selfTest = spawnSync(target.exe, target.selfTest, { encoding: 'utf8', timeout: 180000 });
  if (selfTest.status !== 0) {
    const detail = String(selfTest.stderr || selfTest.stdout || selfTest.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    problems.push(`${target.name}: the frozen binary fails its own self-test (${detail || 'no output'}) — built with the wrong interpreter? Run: ${target.rebuild}`);
    continue;
  }
  const boot = await bootProbe(target);
  if (!boot.ok) {
    problems.push(`${target.name}: the frozen binary does not start (${boot.detail}) — a dependency is missing from the build interpreter. Run: ${target.rebuild}`);
    continue;
  }
  console.log(`[ok] ${target.name}: booted and ${boot.detail}`);

  const builtAt = statSync(target.exe).mtimeMs;
  const sourceAt = Math.max(...target.sources.map(newestPythonMtime));
  if (sourceAt > builtAt) {
    const ageMinutes = Math.round((sourceAt - builtAt) / 60000);
    problems.push(
      `${target.name}: Python sources are ${ageMinutes} minute(s) newer than the binary — the package would ship stale code. Run: ${target.rebuild}`,
    );
    continue;
  }
  console.log(`[ok] ${target.name}: built ${new Date(builtAt).toISOString()}, newer than its sources`);
}

if (problems.length) {
  console.error('\nPackaging blocked:\n' + problems.map((problem) => `  - ${problem}`).join('\n'));
  console.error('\n(Set PYHFO_SKIP_BINARY_CHECK=1 to package anyway — renderer-only changes.)');
  process.exit(1);
}
