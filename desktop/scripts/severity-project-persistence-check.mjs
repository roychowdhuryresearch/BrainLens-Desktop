#!/usr/bin/env node
// End-to-end: a REAL severity run on a small recording, then save the project, reopen it, and check
// the score comes back instead of being recomputed. Also watches for the ETA while the run is live.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE;
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { packagedAppPath, requiredRecording } from './lib/qa-paths.mjs';

const RECORDING = requiredRecording('SEVERITY_RECORDING', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING');
const USER_DATA_DIR = join(tmpdir(), `ieeg-persist-${process.pid}`);
const PROJECT_DIR = mkdtempSync(join(tmpdir(), 'ieeg-project-'));
const PROJECT_FILE = join(PROJECT_DIR, 'severity-persistence.json');

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

// --- a real run, watching for progress + ETA -------------------------------------------------
await page.getByTestId('severity-run-button').click();
let sawEta = null;
let sawCancel = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const live = await page.evaluate(() => ({
    progress: document.querySelector('[data-testid="severity-progress"]')?.textContent?.replace(/\s+/g, ' ').trim() || null,
    cancel: Boolean(document.querySelector('[data-testid="severity-cancel-button"]')),
    mean: document.querySelector('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent?.trim() ?? null,
  }));
  if (live.cancel) sawCancel = true;
  if (live.progress && /left/.test(live.progress)) sawEta = live.progress;
  if (live.mean && live.mean !== '—') break;
  await page.waitForTimeout(3000);
}
check('a cancel control is offered while scoring runs', sawCancel);
check('the run reports an ETA', Boolean(sawEta), String(sawEta));

await page.getByTestId('severity-stat-mean').getByText(/\d/).waitFor({ timeout: 900000 });
const scored = await page.evaluate(() => ({
  mean: document.querySelector('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent?.trim(),
  peak: document.querySelector('[data-testid="severity-stat-peak"] .severity-stat-value')?.textContent?.trim(),
}));
check('the run completes with a score', /\d/.test(scored.mean || ''), JSON.stringify(scored));

// --- save the project (the backend chooses the path; read it off the status line) ------------
// Save Project lives inside the Settings menu, which has to be opened first.
await page.locator('.pyqt-settings-menu > summary').click();
await page.waitForTimeout(400);
await page.getByTestId('pyqt-project_save_button').click();
await page.waitForTimeout(6000);
const savedStatus = await page.getByTestId('pyqt-workflow_status_label').textContent();
const savedPath = String(savedStatus || '').split('Project saved:').pop().replace(/\.$/, '').trim();
console.log('SAVED PATH', JSON.stringify(savedPath));
check('saving writes a project file', Boolean(savedPath) && existsSync(savedPath), savedPath);

// What actually landed in the file is the question when a restore comes back empty.
const savedRaw = readFileSync(savedPath, 'utf8');
const saved = JSON.parse(savedRaw);
console.log('SAVED KEYS', JSON.stringify(Object.keys(saved)));
console.log('SAVED severity_result', JSON.stringify(saved.severity_result && {
  status: saved.severity_result.status, mean: saved.severity_result.mean_score, segments: saved.severity_result.num_segments,
}));
console.log('SAVED recording', JSON.stringify({ path: saved.recording_path, eeg_type: saved.recording_info?.eeg_type }));

// --- reopen it in a FRESH profile: nothing but the file carries the result --------------------
await app.close();
const app2 = await electron.launch({
  executablePath: packagedAppPath,
  args: [`--user-data-dir=${join(tmpdir(), `ieeg-persist2-${process.pid}`)}`],
  env: { ...process.env, PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '180000' },
  timeout: 180000,
});
const page2 = await app2.firstWindow({ timeout: 180000 });
await page2.waitForLoadState('domcontentloaded');
await app2.evaluate(async ({ dialog }, filePath) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}, savedPath);
await page2.getByTestId('pyqt-project_open_button').click();
await page2.waitForTimeout(20000);
await page2.getByTestId('pyqt-sidebar_tab_severity').click().catch(() => {});
await page2.waitForTimeout(2000);
const shellState = await page2.evaluate(() => ({
  loaded: document.querySelector('.pyqt-workspace-shell')?.getAttribute('data-loaded') ?? null,
  severityTab: Boolean(document.querySelector('[data-testid="pyqt-sidebar_tab_severity"]')),
  railTab: document.querySelector('.waveform-right-sidebar')?.getAttribute('data-rail-tab') ?? null,
  status: document.querySelector('[data-testid="pyqt-status_message"]')?.textContent?.trim() ?? null,
}));
console.log('SHELL AFTER OPEN', JSON.stringify(shellState));

const restored = await page2.evaluate(() => ({
  mean: document.querySelector('[data-testid="severity-stat-mean"] .severity-stat-value')?.textContent?.trim() ?? null,
  peak: document.querySelector('[data-testid="severity-stat-peak"] .severity-stat-value')?.textContent?.trim() ?? null,
  bars: document.querySelectorAll('[data-testid="severity-histogram-bar"]').length,
}));
console.log('RESTORED', JSON.stringify(restored));
check('the saved project restores the score without recomputing',
  restored.mean === scored.mean && restored.peak === scored.peak, JSON.stringify(restored));
check('its distribution comes back too', restored.bars > 0, `bars=${restored.bars}`);

console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await app2.close();
if (results.every(Boolean)) rmSync(PROJECT_DIR, { recursive: true, force: true });
else console.log('project kept for inspection:', PROJECT_FILE);
