#!/usr/bin/env node
/**
 * Run the full user-journey (electron-full-user-journey.mjs) across several REAL EDF fixtures and
 * aggregate a per-recording health report. Each fixture launches its own Electron+backend run, so
 * this is slow (~minutes per fixture) — intended for background use.
 *
 * Override the fixture set with JOURNEY_FIXTURES (newline- or comma-separated paths, abs or relative
 * to data/Omni-iEEG).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(desktopRoot, '..');
const dataRoot = join(repoRoot, 'data/Omni-iEEG');
const journey = join(desktopRoot, 'scripts/electron-full-user-journey.mjs');
const reportPath = join(desktopRoot, 'artifacts/electron-full-user-journey.json');
const outDir = join(desktopRoot, 'artifacts/journey-batch');
mkdirSync(outDir, { recursive: true });

const DEFAULT_FIXTURES = [
  'sub-hupHUP134/ses-01/ieeg/sub-hupHUP134_ses-01_task-interictal_run-01_ieeg.edf',     // 1024 Hz (green baseline)
  'sub-hupHUP134/ses-01/ieeg/sub-hupHUP134_ses-01_task-ictal_run-01_ieeg.edf',          // ictal variant
  'sub-sourcesinkumf003/ses-extraoperative/ieeg/sub-sourcesinkumf003_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf', // ~499 Hz (known detection crash)
  'sub-sourcesinkumf004/ses-extraoperative/ieeg/sub-sourcesinkumf004_ses-extraoperative_task-interictalawake_run-01_ieeg.edf',
  'sub-openieegDetroit019/ses-01/ieeg/sub-openieegDetroit019_ses-01_task-sleep_ieeg.edf',
  'sub-openieegUCLA19/ses-01/ieeg/sub-openieegUCLA19_ses-01_task-sleep_ieeg.edf',
];

const fixtures = (process.env.JOURNEY_FIXTURES || DEFAULT_FIXTURES.join('\n'))
  .split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
  .map((rel) => (rel.startsWith('/') ? rel : join(dataRoot, rel)));

const summary = [];
for (const fx of fixtures) {
  const label = basename(fx);
  if (!existsSync(fx)) { summary.push({ fixture: label, status: 'missing_fixture', path: fx }); console.log(`SKIP (missing): ${label}`); continue; }
  console.log(`\n=================== JOURNEY: ${label} ===================`);
  const r = spawnSync('node', [journey], { cwd: desktopRoot, env: { ...process.env, PYHFO_ELECTRON_REAL_FIXTURE_RECORDING: fx }, stdio: 'inherit', timeout: 600000 });
  let rep = {};
  try { rep = JSON.parse(readFileSync(reportPath, 'utf8')); } catch {}
  try { copyFileSync(reportPath, join(outDir, `${label}.json`)); } catch {}
  const assertOf = (stage) => (rep.results || []).find((x) => x.action === 'assert' && x.stage === stage) || null;
  const detect = assertOf('wf_detect');
  const classify = assertOf('wf_classify');
  summary.push({
    fixture: label,
    exit: r.status,
    status: rep.status || 'no_report',
    coverage: rep.coverage || null,
    detection: detect ? { ok: detect.ok, detail: (detect.detail || '').slice(0, 140) } : 'not reached',
    classify: classify ? { ok: classify.ok, detail: (classify.detail || '').slice(0, 100) } : 'not reached',
    failures: (rep.failures || []).slice(0, 6),
    page_errors: (rep.page_errors || []).length,
  });
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2)); // incremental
}

console.log('\n=================== BATCH SUMMARY ===================');
console.log(JSON.stringify(summary, null, 2));
const passed = summary.filter((s) => s.status === 'passed').length;
console.log(`\n${passed}/${summary.length} fixtures fully passed the journey. Per-fixture reports: ${outDir}`);
