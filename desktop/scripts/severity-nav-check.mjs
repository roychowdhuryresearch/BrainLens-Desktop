// Drives the packaged app through a real severity run and checks the navigation, the rail chart,
// and the severity profile on the recording overview.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE;
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { packagedAppPath, requiredRecording } from './lib/qa-paths.mjs';

const RECORDING = requiredRecording('SEVERITY_RECORDING', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING');
const SHOT_DIR = mkdtempSync(join(tmpdir(), 'ieeg-severity-nav-check-'));
console.log(`Saving screenshots to ${SHOT_DIR}`);
const USER_DATA_DIR = join(tmpdir(), `ieeg-nav-${process.pid}`);

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
await page.getByTestId('pyqt-waveform_right_sidebar').waitFor({ state: 'visible', timeout: 180000 });
await page.getByTestId('pyqt-sidebar_tab_severity').click({ timeout: 30000 });
check('severity tab opens', true);

await page.getByTestId('severity-run-button').click();
await page.getByTestId('severity-stat-mean').getByText(/\d/).waitFor({ timeout: 900000 });
const mean = await page.getByTestId('severity-stat-mean').textContent();
check('severity run completes through the UI', /\d/.test(mean || ''), (mean || '').replace(/\s+/g, ' '));

const bars = await page.evaluate(() => {
  const list = [...document.querySelectorAll('[data-testid="severity-histogram-bar"]')];
  return { count: list.length, widths: list.slice(0, 3).map((b) => +b.getBoundingClientRect().width.toFixed(2)) };
});
check('histogram bars have real width', bars.count > 0 && bars.widths.every((w) => w > 0), JSON.stringify(bars));

const overview = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="pyqt-waveform_overview"]');
  return { segments: el?.getAttribute('data-overview-severity-segments') ?? null, label: el?.querySelector('[data-testid="pyqt-waveform_overview_label"]')?.textContent ?? null };
});
check('overview carries the severity profile', Number(overview.segments) > 0, JSON.stringify(overview));

const before = await page.evaluate(() => document.querySelector('[data-testid="pyqt-waveform_overview"]')?.getAttribute('data-overview-band-start'));
await page.getByTestId('severity-nav-most-severe').click();
await page.waitForTimeout(2500);
const after = await page.evaluate(() => document.querySelector('[data-testid="pyqt-waveform_overview"]')?.getAttribute('data-overview-band-start'));
const status = await page.getByTestId('severity-nav-status').textContent();
check('most-severe jump moves the waveform', before !== after, `band ${before} -> ${after}`);
check('rank status reads back', /Rank 1 of \d+/.test(status || ''), (status || '').replace(/\s+/g, ' '));

// 'Peak at' is a jump control: clicking it lands the waveform on the peak segment.
const peakLabel = await page.getByTestId('severity-stat-peak-time').locator('.severity-stat-value').textContent();
await page.getByTestId('pyqt-waveform_time_scroll_bar').evaluate((el) => el.blur());
await page.getByTestId('severity-nav-next').click();
await page.waitForTimeout(1500);
const beforePeak = await page.evaluate(() => document.querySelector('[data-testid="pyqt-waveform_overview"]')?.getAttribute('data-overview-band-start'));
await page.getByTestId('severity-stat-peak-time').click();
await page.waitForTimeout(1800);
const afterPeak = await page.evaluate(() => document.querySelector('[data-testid="pyqt-waveform_overview"]')?.getAttribute('data-overview-band-start'));
const peakSeconds = (() => { const parts = String(peakLabel || '').split(':').map(Number); return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]; })();
check('Peak at jumps to the peak segment', Math.abs(Number(afterPeak) - peakSeconds) < 1 && beforePeak !== afterPeak, `${peakLabel} -> band ${beforePeak} => ${afterPeak}`);
// Back to rank 1 so the prev/next walk below starts where it expects to.
await page.getByTestId('severity-nav-most-severe').click();
await page.waitForTimeout(1200);
check('segment count stat is gone', (await page.getByTestId('severity-stat-segments').count()) === 0);

await page.getByTestId('severity-nav-next').click();
await page.waitForTimeout(2000);
const after2 = await page.evaluate(() => document.querySelector('[data-testid="pyqt-waveform_overview"]')?.getAttribute('data-overview-band-start'));
const status2 = await page.getByTestId('severity-nav-status').textContent();
check('next steps to rank 2', /Rank 2 of \d+/.test(status2 || '') && after2 !== after, `${(status2 || '').replace(/\s+/g, ' ')} | band ${after2}`);

await page.screenshot({ path: `${SHOT_DIR}/nav-check.png` });
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close();
