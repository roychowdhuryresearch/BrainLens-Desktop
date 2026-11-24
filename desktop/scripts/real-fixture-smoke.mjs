#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, extname, join, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const outputPath = join(desktopRoot, 'artifacts/real-fixture-smoke.json');
const fixture = (process.env.PYHFO_PARITY_FIXTURE_RECORDING || '').trim();
const supportedSuffixes = ['.edf', '.bdf', '.fif', '.vhdr', '.set', '.cnt'];

function writeReport(report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({ generated_at: new Date().toISOString(), ...report }, null, 2)}\n`);
}

if (!fixture) {
  writeReport({ status: 'missing_env', required_env: 'PYHFO_PARITY_FIXTURE_RECORDING', command: 'PYHFO_PARITY_FIXTURE_RECORDING=/path/to/case.edf npm run qa:real-fixture' });
  console.error('Real fixture smoke requires PYHFO_PARITY_FIXTURE_RECORDING=/path/to/EDF-or-FIF-or-BrainVision file.');
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}

const fixturePath = resolve(fixture);
const suffix = fixturePath.toLowerCase().endsWith('.fif.gz') ? '.fif.gz' : extname(fixturePath).toLowerCase();
if (!existsSync(fixturePath)) {
  writeReport({ status: 'missing_fixture', fixture_path: fixturePath });
  console.error(`Real fixture path does not exist: ${fixturePath}`);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}
if (!supportedSuffixes.includes(suffix) && suffix !== '.fif.gz') {
  writeReport({ status: 'unsupported_fixture_extension', fixture_path: fixturePath, suffix, supported_suffixes: [...supportedSuffixes, '.fif.gz'] });
  console.error(`Unsupported fixture extension ${suffix}. Expected one of ${[...supportedSuffixes, '.fif.gz'].join(', ')}.`);
  console.error(`Report: ${outputPath}`);
  process.exit(2);
}

const fixtureOutputDir = process.env.PYHFO_PARITY_FIXTURE_OUTPUT_DIR || join(desktopRoot, 'artifacts/real-fixture');
const env = {
  ...process.env,
  PYTHONPATH: [join(repoRoot, 'pyhfo', 'src'), process.env.PYTHONPATH].filter(Boolean).join(delimiter),
  PYHFO_PARITY_FIXTURE_RECORDING: fixturePath,
  PYHFO_PARITY_FIXTURE_OUTPUT_DIR: fixtureOutputDir,
  // Keep real-fixture export artifacts inside the same scoped root used by the
  // smoke test so backend export safety remains enabled instead of bypassed.
  PYHFO_AGENT_EXPORT_DIR: process.env.PYHFO_AGENT_EXPORT_DIR || fixtureOutputDir
};
const args = ['-m', 'pytest', '../pyhfo/tests/test_electron_real_recording_fixture.py', '-q'];
const result = spawnSync('python', args, { cwd: desktopRoot, env, encoding: 'utf8', stdio: 'pipe' });
const report = {
  status: result.status === 0 ? 'passed' : 'failed',
  fixture_path: fixturePath,
  output_dir: env.PYHFO_PARITY_FIXTURE_OUTPUT_DIR,
  optional_detection_enabled: /^(1|true|yes|on)$/i.test(process.env.PYHFO_PARITY_RUN_DETECTION || ''),
  command: `PYHFO_PARITY_FIXTURE_RECORDING=${fixturePath} npm run qa:real-fixture`,
  pytest: { status: result.status, stdout: result.stdout, stderr: result.stderr }
};
writeReport(report);
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.status !== 0) {
  console.error(`Real fixture smoke failed. Report: ${outputPath}`);
  process.exit(result.status || 1);
}
console.log(`Real fixture smoke passed. Report: ${outputPath}`);
