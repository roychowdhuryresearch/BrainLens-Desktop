#!/usr/bin/env node
// Proves the Severity panel reflects a score it did NOT run itself — the agent case.
// Rather than needing an LLM in the loop, this writes a completed result into the desktop's own
// backend session exactly the way the agent runtime does (POST /severity/adopt) and checks the panel
// adopts it.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE;
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { packagedAppPath, requiredRecording } from './lib/qa-paths.mjs';

const RECORDING = requiredRecording('SEVERITY_SYNC_RECORDING', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING');
const SECOND = requiredRecording('SEVERITY_SYNC_SECOND_RECORDING');
if (SECOND === RECORDING) throw new Error('The sync check requires two different recordings.');
const USER_DATA_DIR = join(tmpdir(), `ieeg-sync-${process.pid}`);

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

const app = await electron.launch({
  executablePath: packagedAppPath,
  args: [`--user-data-dir=${USER_DATA_DIR}`],
  env: { ...process.env, PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '180000' },
  timeout: 180000,
});
const page = await app.firstWindow({ timeout: 180000 });
await page.waitForLoadState('domcontentloaded');
await app.evaluate(async ({ dialog }, filePath) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}, RECORDING);
await page.getByTestId('pyqt-empty_open_button').click();
await page.getByTestId('pyqt-sidebar_tab_severity').waitFor({ state: 'visible', timeout: 180000 });
await page.getByTestId('pyqt-sidebar_tab_severity').click();
await page.waitForTimeout(2000);

const before = await page.locator('[data-testid="severity-stat-mean"] .severity-stat-value').textContent();
check('panel starts with no score', (before || '').trim() === '—', String(before).trim());

// Exactly what the agent runtime does after computing a score in its own process.
const session = await app.evaluate(async () => ({
  url: process.env.PYHFO_SESSION_URL || null,
  token: process.env.PYHFO_SESSION_TOKEN || null,
}));
check('desktop publishes its session endpoint for the agent', Boolean(session.url && session.token), String(session.url));

const scores = Array.from({ length: 40 }, (_, index) => ({
  segment_idx: index,
  start_sec: index * 15,
  end_sec: (index + 1) * 15,
  score: 1 + (index % 5) * 0.7,
  artifact: index % 13 === 0,
}));
const result = {
  status: 'complete',
  input_path: RECORDING,
  eeg_type: 'scalp',
  num_segments: scores.length,
  mean_score: 2.4,
  peak_score: 3.8,
  peak_time_sec: 60,
  num_clean_segments: scores.filter((s) => !s.artifact).length,
  clean_mean_score: 2.35,
  clean_peak_score: 3.8,
  clean_peak_time_sec: 60,
  artifact_threshold_uv: 1000,
  scores,
  artifacts: {},
  warnings: [],
  timing: {},
};
const adoptResponse = await fetch(`${session.url}/severity/adopt`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
  body: JSON.stringify({ result }),
});
const adoptBody = await adoptResponse.text();
check('backend accepts the agent-computed result', adoptResponse.ok, `${adoptResponse.status} ${adoptBody.slice(0, 120)}`);

// Whatever route the write took, the panel must show it within the poll interval.
await page.waitForTimeout(7000);
const after = await page.evaluate(() => ({
  mean: document.querySelector('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent?.trim() ?? null,
  peak: document.querySelector('[data-testid="severity-stat-peak"] .severity-stat-value')?.textContent?.trim() ?? null,
  navStatus: document.querySelector('[data-testid="severity-nav-status"]')?.textContent?.trim() ?? null,
  bars: document.querySelectorAll('[data-testid="severity-histogram-bar"]').length,
}));
console.log('PANEL AFTER', JSON.stringify(after));
check('panel adopts a score written by someone else', after.mean === '2.35' && after.peak === '3.80', JSON.stringify(after));
check('navigation and histogram populate from it', (after.navStatus || '').includes('Rank 1') && after.bars > 0, `${after.navStatus} | bars=${after.bars}`);

// Opening a different recording must not leave -- or resurrect -- the previous file's score.
await app.evaluate(async ({ dialog }, filePath) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}, SECOND);
await page.getByTestId('pyqt-actionOpen_EDF_toolbar').click().catch(async () => {
  await page.evaluate(async (path) => { await window.ieeg.loadRecording(path); }, SECOND);
});
await page.waitForTimeout(12000);
const afterSwitch = await page.evaluate(() => ({
  mean: document.querySelector('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent?.trim() ?? null,
  navStatus: document.querySelector('[data-testid="severity-nav-status"]')?.textContent?.trim() ?? null,
}));
console.log('AFTER SWITCHING RECORDING', JSON.stringify(afterSwitch));
check('a new recording does not inherit the old score', afterSwitch.mean === '—' || afterSwitch.mean === null, JSON.stringify(afterSwitch));

console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close();
