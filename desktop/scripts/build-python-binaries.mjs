#!/usr/bin/env node
/**
 * Builds BOTH bundled Python binaries with the interpreter each one actually needs, then proves the
 * result is complete.
 *
 * The two binaries have disjoint dependency sets living in different interpreters, and PyInstaller
 * does not fail when an import is missing — it silently ships a smaller bundle that dies at runtime.
 * Building the agent runtime with the `pyhfo` env once produced a binary with no web server at all
 * (`ModuleNotFoundError: No module named 'uvicorn'`), which packaged and launched cleanly and only
 * failed in the user's hands. Hence the marker checks below: a build that cannot show its own
 * dependencies is treated as a failed build.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));

const TARGETS = [
  {
    name: 'pyhfo-backend',
    cwd: join(repoRoot, 'pyhfo'),
    spec: 'pyhfo_windows.spec',
    // torch / mne / transformers live in the pyhfo mamba env and nowhere else.
    command: ['mamba', ['run', '-n', 'pyhfo', 'python', '-m', 'PyInstaller']],
    dist: join(repoRoot, 'pyhfo', 'dist', 'pyhfo-backend'),
    exe: 'pyhfo-backend.exe',
    selfTest: ['--self-test'],
    minMegabytes: 40,
  },
  {
    name: 'ieeg-agent-runtime',
    cwd: join(repoRoot, 'runtime'),
    spec: 'ieeg_agent_runtime_windows.spec',
    // runtime/.venv, built from requirements.txt. Neither the pyhfo env nor system Python carries the
    // full set -- system Python has fastapi and uvicorn but not watchdog, aiofiles, aiosqlite,
    // dashscope... and PyInstaller can only bundle what the building interpreter can import, so each
    // wrong-env build surfaced one more missing module at runtime.
    command: [join(repoRoot, 'runtime', '.venv', 'Scripts', 'python.exe'), ['-m', 'PyInstaller']],
    requiresVenv: join(repoRoot, 'runtime', '.venv', 'Scripts', 'python.exe'),
    dist: join(repoRoot, 'runtime', 'dist', 'ieeg-agent-runtime'),
    exe: 'ieeg-agent-runtime.exe',
    selfTest: ['--self-test'],
    minMegabytes: 10,
  },
];

function build(target) {
  if (target.requiresVenv && !existsSync(target.requiresVenv)) {
    throw new Error(
      `${target.name}: ${target.requiresVenv} is missing. Create it once with:
`
      + `  python -m venv runtime/.venv
`
      + `  runtime/.venv/Scripts/python.exe -m pip install -r requirements.txt pyinstaller`,
    );
  }
  const [bin, prefix] = target.command;
  console.log(`\n=== ${target.name}: ${bin} ${prefix.join(' ')} ${target.spec} ===`);
  const result = spawnSync(bin, [...prefix, '--noconfirm', '--clean', target.spec], {
    cwd: target.cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`${target.name}: PyInstaller exited ${result.status}`);
}

function verify(target) {
  const exePath = join(target.dist, target.exe);
  if (!existsSync(exePath)) throw new Error(`${target.name}: ${exePath} was not produced`);
  const megabytes = statSync(exePath).size / (1024 * 1024);
  if (megabytes < target.minMegabytes) {
    throw new Error(
      `${target.name}: ${megabytes.toFixed(1)} MB is below the ${target.minMegabytes} MB floor — `
      + 'dependencies were almost certainly not found. Check the interpreter.',
    );
  }
  // The bundle's own offline check, which imports what it needs: pure-python packages compile
  // into the embedded PYZ and never show up as folders, so nothing on disk can prove they landed.
  const selfTest = spawnSync(exePath, target.selfTest, { encoding: 'utf8', timeout: 180000 });
  if (selfTest.status !== 0) {
    const detail = String(selfTest.stderr || selfTest.stdout || selfTest.error?.message || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    throw new Error(`${target.name}: the frozen binary fails its own self-test — ${detail || 'no output'}`);
  }
  console.log(`[ok] ${target.name}: ${megabytes.toFixed(1)} MB, self-test passed`);
}

const only = process.argv[2];
const selected = only ? TARGETS.filter((target) => target.name === only) : TARGETS;
if (!selected.length) {
  console.error(`Unknown target "${only}". Known: ${TARGETS.map((target) => target.name).join(', ')}`);
  process.exit(2);
}

for (const target of selected) {
  build(target);
  verify(target);
}
console.log('\nAll Python binaries built and verified.');
