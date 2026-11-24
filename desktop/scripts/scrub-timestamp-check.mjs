// Checks the H:MM:SS scrub readouts on the time slider and the recording overview.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE;
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { packagedAppPath, requiredRecording } from './lib/qa-paths.mjs';

const RECORDING = requiredRecording('SCRUB_RECORDING', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING');
const SHOT_DIR = mkdtempSync(join(tmpdir(), 'ieeg-scrub-timestamp-check-'));
console.log(`Saving screenshots to ${SHOT_DIR}`);
const USER_DATA_DIR = join(tmpdir(), `ieeg-scrub-${process.pid}`);

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
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.waitForLoadState('domcontentloaded');
await app.evaluate(async ({ dialog }, filePath) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}, RECORDING);
await page.getByTestId('pyqt-empty_open_button').click();
await page.getByTestId('pyqt-waveform_right_sidebar').waitFor({ state: 'visible', timeout: 180000 });
await page.waitForTimeout(4000);

// --- overview strip: hover shows the time under the pointer -------------------------
const strip = page.getByTestId('pyqt-waveform_overview_canvas');
const stripBox = await strip.boundingBox();
const inPageStrip = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="pyqt-waveform_overview_canvas"]');
  const r = el.getBoundingClientRect();
  const pane = el.closest('.waveform-pane');
  const pr = pane?.getBoundingClientRect();
  return { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], scrollY: window.scrollY, paneScrollTop: pane?.scrollTop ?? null, paneRect: pr ? [Math.round(pr.x), Math.round(pr.y), Math.round(pr.width), Math.round(pr.height)] : null, viewport: [window.innerWidth, window.innerHeight], zoom: window.devicePixelRatio };
});
console.log('STRIP playwright', JSON.stringify(stripBox), 'in-page', JSON.stringify(inPageStrip));
await page.mouse.move(stripBox.x + stripBox.width * 0.2, stripBox.y + stripBox.height / 2);
await page.waitForTimeout(200);
await page.mouse.move(stripBox.x + stripBox.width * 0.5, stripBox.y + stripBox.height / 2);
await page.waitForTimeout(400);
const midLabel = await page.getByTestId('pyqt-waveform_overview_timestamp').textContent().catch(() => null);
await page.mouse.move(stripBox.x + stripBox.width * 0.8, stripBox.y + stripBox.height / 2);
await page.waitForTimeout(400);
const lateLabel = await page.getByTestId('pyqt-waveform_overview_timestamp').textContent().catch(() => null);
const duration = Number(await page.evaluate(() => document.querySelector('[data-testid="pyqt-waveform_overview"]')?.getAttribute('data-overview-duration')));
const toSeconds = (text) => {
  const [h, m, s] = String(text || '').split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const bubbleGeo = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="pyqt-waveform_overview_timestamp"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const onScreen = r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
  let clipper = null;
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const cs = getComputedStyle(node);
    if (/(hidden|clip|auto|scroll)/.test(cs.overflowY) || cs.contain.includes('paint')) {
      const nr = node.getBoundingClientRect();
      if (r.y < nr.y) { clipper = `${node.className} top=${Math.round(nr.y)}`; break; }
    }
  }
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), onScreen, viewport: [window.innerWidth, window.innerHeight], visibility: cs.visibility, opacity: cs.opacity, clipper };
});
console.log('BUBBLE', JSON.stringify(bubbleGeo));
check('overview readout is fully on screen and unclipped', bubbleGeo !== null && bubbleGeo.onScreen && bubbleGeo.h > 12 && bubbleGeo.w > 20 && !bubbleGeo.clipper && bubbleGeo.visibility === 'visible', JSON.stringify(bubbleGeo));
check('overview hover shows H:MM:SS', /^\d+:\d{2}:\d{2}$/.test(midLabel || ''), `${midLabel} (duration ${duration}s)`);
check('overview readout tracks the pointer',
  Math.abs(toSeconds(midLabel) - duration * 0.5) < duration * 0.05 && toSeconds(lateLabel) > toSeconds(midLabel),
  `${midLabel} -> ${lateLabel}`);
await page.screenshot({ path: `${SHOT_DIR}/scrub-overview.png` });

await page.mouse.move(stripBox.x + stripBox.width * 0.8, stripBox.y - 60);
await page.waitForTimeout(300);
check('overview readout clears when the pointer leaves',
  (await page.getByTestId('pyqt-waveform_overview_timestamp').count()) === 0);

// --- time slider: readout appears while dragging -------------------------------------
const slider = page.getByTestId('pyqt-waveform_time_scroll_bar');
const sliderBox = await slider.boundingBox();
await page.mouse.move(sliderBox.x + sliderBox.width * 0.35, sliderBox.y + sliderBox.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
const sliderLabel = await page.getByTestId('pyqt-time_scrollbar_timestamp').textContent().catch(() => null);
check('time slider shows H:MM:SS while dragging', /^\d+:\d{2}:\d{2}$/.test(sliderLabel || ''), String(sliderLabel));
const sliderGeo = await page.evaluate(() => {
  const el = document.querySelector('[data-testid="pyqt-time_scrollbar_timestamp"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width), onScreen: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth };
});
check('slider readout is fully on screen and unclipped', sliderGeo !== null && sliderGeo.onScreen && sliderGeo.h > 12 && sliderGeo.w > 20, JSON.stringify(sliderGeo));
const bubbleShot = page.locator('[data-testid="pyqt-time_scrollbar_timestamp"]');
if (await bubbleShot.count()) await page.screenshot({ path: `${SHOT_DIR}/scrub-slider-zoom.png`, clip: { x: Math.max(0, sliderGeo.y ? 0 : 0), y: Math.max(0, sliderGeo.y - 40), width: 900, height: 90 } });
await page.screenshot({ path: `${SHOT_DIR}/scrub-slider.png` });
await page.mouse.up();

// Dragging WITH movement is its own case: a press-and-release never runs the pointermove path,
// which is exactly where a stale synthetic-event read blanked the window.
await page.mouse.move(sliderBox.x + sliderBox.width * 0.2, sliderBox.y + sliderBox.height / 2);
await page.mouse.down();
for (const fraction of [0.3, 0.45, 0.6]) {
  await page.mouse.move(sliderBox.x + sliderBox.width * fraction, sliderBox.y + sliderBox.height / 2, { steps: 4 });
  await page.waitForTimeout(150);
}
await page.mouse.up();
await page.waitForTimeout(800);
const aliveAfterSliderDrag = await page.evaluate(() => Boolean(document.querySelector('[data-testid="pyqt-waveform-toolbar"]')));
check('app survives a slider drag with movement', aliveAfterSliderDrag, `pageErrors=${JSON.stringify(pageErrors.slice(0, 2))}`);

const stripBox2 = await page.getByTestId('pyqt-waveform_overview_canvas').boundingBox().catch(() => null);
if (stripBox2) {
  await page.mouse.move(stripBox2.x + stripBox2.width * 0.3, stripBox2.y + stripBox2.height / 2);
  await page.mouse.down();
  await page.mouse.move(stripBox2.x + stripBox2.width * 0.6, stripBox2.y + stripBox2.height / 2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(800);
}
const aliveAfterStripDrag = await page.evaluate(() => Boolean(document.querySelector('[data-testid="pyqt-waveform-toolbar"]')));
check('app survives an overview strip drag', Boolean(stripBox2) && aliveAfterStripDrag, `pageErrors=${JSON.stringify(pageErrors.slice(0, 2))}`);
check('no uncaught renderer errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));

console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close();
