#!/usr/bin/env node
// Exercises the montage rules against real channel lists, in the browser, through the actual
// module the app uses -- the source-contract tests only match strings, which cannot tell you
// whether a scalp recording ends up on a bipolar montage.
//
// The rules under test:
//   * scalp EEG opens on bipolar with the conventional 10-20 pairs prefilled
//   * anything else opens referential with the pair list CLEARED (no leakage between recordings)
//   * Auto reports which montage it chose ("Auto: Bipolar"), it is not a bare label
//   * a montage persisted by an older build ('autoBipolar') still loads
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

// A conventional 10-20 set (as an EDF would label it) and a depth-electrode set.
const SCALP = { channel_names: ['Fp1', 'F3', 'C3', 'P3', 'O1', 'F7', 'T3', 'T5', 'Fp2', 'F4', 'C4', 'P4', 'O2', 'F8', 'T4', 'T6', 'Fz', 'Cz', 'Pz'], eeg_type: 'scalp' };
const IEEG = { channel_names: ['LA1', 'LA2', 'LA3', 'LA4', 'RH1', 'RH2', 'RH3'], eeg_type: 'ieeg' };

async function main() {
  // Bind an explicit free port: vite.config.server.port reports the configured default (5173),
  // not the ephemeral port it actually listened on.
  const port = await new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
  const vite = await createViteServer({ root: desktopRoot, server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'warn' });
  await vite.listen();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    // Vite's first request compiles the entry graph on demand; on a cold cache that regularly
    // exceeds Playwright's 30s default and fails the whole check for no product reason.
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    const out = await page.evaluate(async ({ scalp, ieeg }) => {
      const m = await import('/src/app/workspaceState.ts');
      const bipolarNames = (pairs) => pairs.map((p) => p.name);
      return {
        scalpState: { ...m.montageStateForRecording(scalp), pairs: bipolarNames(m.montageStateForRecording(scalp).derivedBipolarChannels) },
        ieegState: { ...m.montageStateForRecording(ieeg), pairs: bipolarNames(m.montageStateForRecording(ieeg).derivedBipolarChannels) },
        scalpResolved: m.resolveMontageMode('auto', scalp),
        ieegResolvedAuto: m.resolveMontageMode('auto', ieeg),
        scalpLabel: m.montageModeLabel('auto', scalp),
        refLabel: m.montageModeLabel('referential', scalp),
        bipolarLabel: m.montageModeLabel('bipolar', scalp),
        legacy: m.normalizeMontageMode('autoBipolar'),
        junk: m.normalizeMontageMode('nonsense'),
        displayed: m.displayChannelName('Fp1#-#F3'),
        displayedAvg: m.displayChannelName(m.averageReferenceChannelName('Fp1')),
        internalName: m.conventionalBipolarDerivedChannels(scalp)[0]?.name,
        displayPlain: m.displayChannelName('LA1'),
        conventionalCount: m.conventionalBipolarDerivedChannels(scalp).length,
        conventionalOnIeeg: m.conventionalBipolarDerivedChannels(ieeg).length,
        // A bipolar montage renders the configured pairs when there are any.
        universeScalp: m.waveformChannelUniverse(scalp, { ...m.DEFAULT_WAVEFORM_CONTROLS, ...m.montageStateForRecording(scalp) }).slice(0, 3),
        universeIeeg: m.waveformChannelUniverse(ieeg, { ...m.DEFAULT_WAVEFORM_CONTROLS, ...m.montageStateForRecording(ieeg) }).slice(0, 3),
      };
    }, { scalp: SCALP, ieeg: IEEG });

    check('scalp opens on an automatic bipolar montage', out.scalpState.montageMode === 'auto' && out.scalpResolved === 'bipolar',
      `mode=${out.scalpState.montageMode} resolved=${out.scalpResolved}`);
    check('scalp prefills the conventional 10-20 pairs', out.scalpState.pairs.length >= 16 && out.scalpState.pairs[0] === 'Fp1#-#F3',
      `${out.scalpState.pairs.length} pairs, first=${out.scalpState.pairs[0]}`);
    check('scalp waveform renders bipolar derivations', out.universeScalp.every((n) => n.includes('#-#')), out.universeScalp.join(','));

    check('non-scalp opens referential', out.ieegState.montageMode === 'referential', `mode=${out.ieegState.montageMode}`);
    check('non-scalp clears the bipolar pair list', out.ieegState.pairs.length === 0, `${out.ieegState.pairs.length} pairs`);
    check('non-scalp waveform renders source channels', out.universeIeeg.every((n) => !n.includes('#-#')), out.universeIeeg.join(','));
    check('conventional pairs are scalp-only', out.conventionalCount >= 16 && out.conventionalOnIeeg === 0,
      `scalp=${out.conventionalCount} ieeg=${out.conventionalOnIeeg}`);

    check('Auto reports the montage it chose', out.scalpLabel === 'Auto: Bipolar', `label=${out.scalpLabel}`);
    check('explicit modes keep their own labels', out.refLabel === 'Ref' && out.bipolarLabel === 'Bipolar',
      `${out.refLabel} / ${out.bipolarLabel}`);
    check('Auto still offers bipolar on iEEG when chosen', out.ieegResolvedAuto === 'bipolar', `resolved=${out.ieegResolvedAuto}`);
    // The token keys derived channels through state, requests, annotations and exports, so it has
    // to survive untouched -- only the label is rewritten.
    check('derived channels display without the internal token',
      out.displayed === 'Fp1-F3' && out.displayedAvg === 'Fp1-AVG' && out.displayPlain === 'LA1',
      `${out.displayed} / ${out.displayedAvg} / ${out.displayPlain}`);
    check('internal channel identity still carries the token',
      typeof out.internalName === 'string' && out.internalName.includes('#-#'), `name=${out.internalName}`);

    check('a montage saved by an older build still loads', out.legacy === 'auto' && out.junk === null,
      `autoBipolar->${out.legacy} nonsense->${out.junk}`);
  } finally {
    await browser.close().catch(() => {});
    await vite.close().catch(() => {});
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== Montage behavior: ${results.length - failed.length}/${results.length} PASS ===`);
  if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(', ')); process.exitCode = 1; }
}

main().catch((exc) => { console.error(exc); process.exitCode = 1; });
