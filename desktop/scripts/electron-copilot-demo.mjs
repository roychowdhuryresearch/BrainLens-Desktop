#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
/**
 * COPILOT DEMO — a recording-paced driver for the in-app co-pilot, for screen-capturing a story video.
 *
 * Same real stack as qa:copilot-deep (real Electron + PyHFO scientific backend + the LLM agent runtime +
 * a real model + a real EDF), but tuned for FILMING instead of asserting:
 *   - drives the app's OWN chat composer (the product story: a clinician talks to their data);
 *   - types each prompt CHARACTER BY CHARACTER so the viewer sees it being typed;
 *   - holds deliberate, configurable pauses around every beat so a voiceover can breathe;
 *   - on the human-in-the-loop gate (run-detection / annotate) it lets the STAGED command sit on
 *     screen — the "AI proposes, human approves" money shot — then clicks Apply (or waits for YOU to
 *     click it, with DEMO_GATE_MANUAL=1);
 *   - on the set-parameters beat it walks into the Prepare panel so the camera catches the filter
 *     fields physically change to what the agent asked for;
 *   - never aborts on a weak/odd model turn (it's a take, not a gate) — just re-run for a cleaner one;
 *   - writes artifacts/copilot-demo/cues.json (per-beat wall-clock offsets + reply snippets) so you can
 *     line captions up in post, plus a per-beat screenshot storyboard.
 *
 * The only hard failures are infra (agent runtime didn't boot, EDF didn't load) — those mean there is
 * nothing to film.
 *
 * Requires a real model/API key (user_config.yaml) + network egress, and a build (npm run build).
 * Run (after npm run build):   npm run qa:copilot-demo
 * It self-records the app to artifacts/copilot-demo/footage.webm via Playwright (NO macOS screen-
 * recording permission needed — it captures the rendered window content, not your desktop). That
 * footage is the base track for the HyperFrames story (captions/title cards/voiceover) — see
 * docs/copilot-demo-video.md.
 *
 * Handy env knobs (all optional):
 *   DEMO_ONLY=look,detect        only these beats (load always happens); keys below in TURNS
 *   DEMO_START_HOLD_MS=4000      intro hold before the story starts (leaves room for a title card)
 *   DEMO_TYPE_DELAY=30           ms per typed character in the composer
 *   DEMO_PAUSE_BEFORE=1500       hold before each turn starts typing
 *   DEMO_SETTLE=3500             hold after a reply lands (camera reads it)
 *   DEMO_GATE_PAUSE=4500         hold on a STAGED command before Apply (the HITL beat)
 *   DEMO_RESULT_PAUSE=4000       hold after Apply (camera reads the result)
 *   DEMO_GATE_MANUAL=1           don't auto-click Apply — wait for YOU to click it on camera
 *   DEMO_WINDOW=1440x900         resize the window to a clean recording frame ("" = leave as-is)
 *   PYHFO_AGENT_MODEL=qwen3.5-plus   pin the capable model (turbo/flash are too weak to tool-call)
 *   PYHFO_ELECTRON_REAL_FIXTURE_RECORDING=/path.edf   film a different recording
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const artifactsDir = join(desktopRoot, 'artifacts');
const STORY = (process.env.DEMO_STORY || 'classic').trim();
const AGENT_DRIVEN = STORY === 'agent-driven';
const artifactName = AGENT_DRIVEN ? 'copilot-agent-video' : 'copilot-demo';
const outDir = join(artifactsDir, artifactName);
const cuesPath = join(outDir, 'cues.json');
const electronExecutable = require('electron');
const defaultFixture = join(repoRoot, 'data/Omni-iEEG/sub-sourcesinkumf001/ses-extraoperative/ieeg/sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf');

const num = (name, def) => { const v = Number(process.env[name]); return Number.isFinite(v) && v >= 0 ? v : def; };
const START_HOLD_MS = num('DEMO_START_HOLD_MS', AGENT_DRIVEN ? 2500 : 4000);
const TYPE_DELAY = num('DEMO_TYPE_DELAY', AGENT_DRIVEN ? 15 : 30);
const PAUSE_BEFORE = num('DEMO_PAUSE_BEFORE', AGENT_DRIVEN ? 700 : 1500);
const SETTLE = num('DEMO_SETTLE', AGENT_DRIVEN ? 2200 : 3500);
const GATE_PAUSE = num('DEMO_GATE_PAUSE', AGENT_DRIVEN ? 3500 : 4500);
const RESULT_PAUSE = num('DEMO_RESULT_PAUSE', AGENT_DRIVEN ? 2500 : 4000);
const GATE_MANUAL = Boolean(process.env.DEMO_GATE_MANUAL);
const GATE_WAIT = num('DEMO_GATE_WAIT', 30000);
const REPLY_TIMEOUT = num('DEMO_REPLY_TIMEOUT', 150000);
const COMPUTE_TIMEOUT = num('DEMO_COMPUTE_TIMEOUT', 240000);
const WINDOW = (process.env.DEMO_WINDOW ?? (AGENT_DRIVEN ? '1920x1080' : '1440x900')).trim();
const BIG = 240000; // window awaits both backends (~60s); generous.
const ONLY = (process.env.DEMO_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── The story. Each beat is one natural-language turn into the real co-pilot composer. ──
// Mirrors the proven qa:copilot-deep prompts (qwen3.5-plus handles these) with light polish for camera.
const CLASSIC_TURNS = [
  {
    key: 'look',
    prompt:
      'This is an intracranial EEG recording from a patient being evaluated for epilepsy surgery. Look at the waveform on screen and tell me what stands out — any high-frequency bursts, noisy or flat channels, or obvious artifact. Move the viewport if it helps you see.',
  },
  {
    key: 'qc',
    prompt:
      'Run quality control and check the line noise and the Nyquist limit. Which channels look usable for HFO detection, and do we need a notch filter?',
  },
  {
    key: 'detector',
    prompt:
      'Good. Set the detection filter band to 80 to 250 hertz and set the line-noise notch to 60 Hz so we are ready to detect ripples.',
    showPrepare: true, // walk into the Prepare panel so the camera sees the fields change
  },
  {
    key: 'classifier',
    prompt: 'Set the classifier to run on the CPU with a batch size of 64.',
    optional: true, // a technical beat; trim with DEMO_ONLY if you want a tighter cut
  },
  {
    key: 'detect',
    prompt: 'Now run HFO detection using the STE detector. Stage it for me and I will approve.',
    gate: true,
    computeWaitMs: 6000,
    waitForEvents: true, // detection on a long recording takes minutes — wait for it to finish before the verdict
    timeout: COMPUTE_TIMEOUT,
  },
  {
    key: 'annotate',
    prompt: 'Mark the first detected event as a confirmed HFO for review.',
    gate: true,
  },
  {
    key: 'verdict',
    prompt:
      'Taking everything together, decide whether this recording is suitable for HFO analysis and which channels are the strongest HFO generators. Do whatever steps you need, then give me your final verdict.',
    timeout: COMPUTE_TIMEOUT,
  },
];

const AGENT_DRIVEN_TURNS = [
  {
    key: 'metadata',
    prompt:
      'Before we run anything, inspect the loaded recording. In concise English, report its duration, sampling rate, channel count, and Nyquist limit. Do not change settings or run detection.',
  },
  {
    key: 'qc',
    prompt:
      'Run one read-only QC and spectral pass. In concise English, report any flat or amplitude-outlier channels, a Nyquist-safe ripple band, and whether the spectrum supports a line-noise notch. Do not prepare the recording, change settings, or start detection.',
    expectedCommands: ['analysis.run_qc'],
  },
  {
    key: 'configure',
    prompt:
      'Set the Prepare panel to a ripple band of fp 80 Hz and fs 250 Hz. Keep the line-noise notch unset. Do not prepare the recording or run detection yet. Confirm the change in concise English.',
    expectedCommands: ['detection.set_parameters'],
    showPrepare: true,
  },
  {
    key: 'detect',
    prompt:
      'Run ripple detection with the STE detector on all loaded channels, using confirmed defaults, the 80 to 250 Hz band, one job, and CSV, session, and summary exports. Stage the run and wait for my approval. Respond in concise English.',
    gate: true,
    computeWaitMs: 1500,
    waitForEvents: true,
    timeout: COMPUTE_TIMEOUT,
  },
  {
    key: 'rank',
    prompt:
      'Use only the currently active detection run. Rank channels by candidate count and rate, then show the top eight channels in the waveform. Do not re-run detection, combine runs, infer anatomy, or infer the seizure onset zone. Respond in concise English.',
    expectedCommands: ['detection.rank_candidates', 'waveform.focus_hotspot_channels'],
  },
  {
    key: 'focus',
    prompt:
      'Take me to the single busiest candidate channel and center one representative event in a two-second window. Do not run detection or annotate the event. Respond in concise English.',
    expectedCommands: ['detection.focus_top_candidate_channel'],
  },
];

const TURNS = AGENT_DRIVEN ? AGENT_DRIVEN_TURNS : CLASSIC_TURNS;

const diagnostics = { electronLogs: [] };
const cues = [];
let t0 = 0;
let storyOffsetS = 0;
let videoStartedAt = 0;
const elapsed = () => Math.round((Date.now() - t0) / 1000);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const banner = (msg) => console.log(`\n[demo +${elapsed()}s] ${msg}`);

function getFreePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
  });
}
async function waitForServer(url, timeoutMs = 30000) {
  const dl = Date.now() + timeoutMs; let last = '';
  while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; last = `HTTP ${r.status}`; } catch (e) { last = String(e); } await wait(250); }
  throw new Error(`renderer dev server not ready at ${url}: ${last}`);
}
function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], text: true });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
function fail(message, extra = {}) {
  mkdirSync(outDir, { recursive: true });
  if (AGENT_DRIVEN) rmSync(join(outDir, 'video'), { recursive: true, force: true });
  writeFileSync(cuesPath, `${JSON.stringify({ status: 'failed', message, ...extra, cues }, null, 2)}\n`);
  console.error(`\nFAIL: ${message}`);
  console.error(`Cues/log: ${cuesPath}`);
  process.exit(2);
}

async function countIn(ms) {
  if (ms <= 0) return;
  banner('▶  Recording footage (Playwright) — telling the story…');
  let left = Math.ceil(ms / 1000);
  while (left > 0) { process.stdout.write(`\r    story begins in ${left}…   `); await wait(1000); left -= 1; }
  process.stdout.write('\r    rolling.                     \n');
}

async function main() {
  t0 = Date.now();
  const fixturePath = (process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING || '').trim()
    ? resolve(process.env.PYHFO_ELECTRON_REAL_FIXTURE_RECORDING.trim()) : defaultFixture;
  if (!existsSync(fixturePath)) fail(`Need an EDF fixture. Set PYHFO_ELECTRON_REAL_FIXTURE_RECORDING. Tried: ${fixturePath}`);
  if (!existsSync(join(desktopRoot, 'dist-electron', 'main.js')) || !existsSync(join(desktopRoot, 'dist-electron', 'preload.cjs'))) {
    fail('Requires built Electron outputs. Run npm run build first.');
  }
  mkdirSync(outDir, { recursive: true });
  const userDataDir = join(tmpdir(), `ieeg-agent-video-${process.pid}-${Date.now()}`);
  if (AGENT_DRIVEN) mkdirSync(userDataDir, { recursive: true });

  const rendererPort = await getFreePort();
  const backendPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = startVite(rendererPort);
  let app;
  let videoObj = null; // Playwright page video — saved on graceful close
  let shotIndex = 0;
  const screenshot = async (page, label) => {
    const name = `${String(++shotIndex).padStart(2, '0')}-${label}.png`;
    await page.screenshot({ path: join(outDir, name), fullPage: false }).catch(() => {});
    return join('artifacts', artifactName, name);
  };

  const installDemoCursor = async (page) => {
    if (!AGENT_DRIVEN) return;
    await page.evaluate(() => {
      document.getElementById('agent-video-cursor')?.remove();
      const cursor = document.createElement('div');
      cursor.id = 'agent-video-cursor';
      cursor.innerHTML = '<svg viewBox="0 0 30 36" aria-hidden="true"><path d="M3 2 L3 29 L10 22 L15 34 L21 31 L16 20 L26 20 Z" fill="#f8fbff" stroke="#0b1220" stroke-width="2" stroke-linejoin="round"/></svg><span></span>';
      const style = document.createElement('style');
      style.id = 'agent-video-cursor-style';
      style.textContent = `
        #agent-video-cursor { position: fixed; left: 86%; top: 8%; width: 30px; height: 36px; z-index: 2147483647; pointer-events: none; transform: translate(-2px, -2px); transition: left 420ms cubic-bezier(.22,.75,.18,1), top 420ms cubic-bezier(.22,.75,.18,1); filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
        #agent-video-cursor svg { display: block; width: 30px; height: 36px; }
        #agent-video-cursor span { position: absolute; left: 2px; top: 2px; width: 18px; height: 18px; border: 3px solid rgba(79,156,249,.95); border-radius: 999px; opacity: 0; transform: scale(.35); }
        #agent-video-cursor.is-clicking span { animation: agent-video-click 520ms ease-out; }
        @keyframes agent-video-click { 0% { opacity: 1; transform: scale(.35); } 100% { opacity: 0; transform: scale(2.2); } }
      `;
      document.getElementById('agent-video-cursor-style')?.remove();
      document.head.appendChild(style);
      document.body.appendChild(cursor);
    });
  };

  const moveCursorTo = async (page, locator, { click = false } = {}) => {
    if (!AGENT_DRIVEN) {
      if (click) await locator.click({ timeout: 8000 });
      return;
    }
    const box = await locator.boundingBox().catch(() => null);
    if (!box) {
      if (click) await locator.click({ timeout: 8000 });
      return;
    }
    await page.evaluate(({ x, y }) => {
      const cursor = document.getElementById('agent-video-cursor');
      if (!cursor) return;
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
    }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await wait(480);
    if (!click) return;
    await page.evaluate(() => {
      const cursor = document.getElementById('agent-video-cursor');
      if (!cursor) return;
      cursor.classList.remove('is-clicking');
      void cursor.getBoundingClientRect();
      cursor.classList.add('is-clicking');
    });
    await wait(120);
    await locator.click({ timeout: 8000 });
    await wait(260);
  };

  // Switch the agent rail to its Chat or Actions face.
  const showChat = async (page) => moveCursorTo(page, page.getByTestId('agent-activity-chat'), { click: true }).catch(() => {});
  const showActions = async (page) => moveCursorTo(page, page.getByTestId('agent-activity-actions'), { click: true }).catch(() => {});

  const verifyExpectedCommands = async (page, turn, cue) => {
    if (!AGENT_DRIVEN || !turn.expectedCommands?.length) return;
    await showActions(page);
    await page.getByTestId('agent-command-source-filter').selectOption('all').catch(() => {});
    await page.getByTestId('agent-command-status-filter').selectOption('all').catch(() => {});
    await wait(850);
    const entries = await page.getByTestId('agent-command-card').evaluateAll((cards) => cards.map((card) => ({
      id: card.getAttribute('data-command-id') || '',
      type: card.getAttribute('data-command-type') || '',
      status: card.getAttribute('data-command-status') || '',
    }))).catch(() => []);
    cue.commands = entries;
    const types = new Set(entries.map((entry) => entry.type));
    const missing = turn.expectedCommands.filter((type) => !types.has(type));
    if (missing.length) throw new Error(`Expected Agent command(s) missing: ${missing.join(', ')}.`);
    const detectionRuns = entries.filter((entry) => entry.type === 'detection.run');
    if (turn.key !== 'detect' && detectionRuns.length > 1) throw new Error('More than one detection.run appeared; this take is invalid.');
    await screenshot(page, `${turn.key}-action-trace`);
    await wait(900);
    await showChat(page);
  };

  // Count the Apply buttons currently staged (the human-gate queue).
  const stagedCount = async (page) => page.getByTestId('agent-command-apply').count().catch(() => 0);

  // The HITL beat: let the staged command sit on camera, then approve (auto, or wait for the human).
  const runGate = async (page, cue) => {
    await showActions(page);
    if (AGENT_DRIVEN) {
      await page.getByTestId('agent-command-source-filter').selectOption('agent').catch(() => {});
      await page.getByTestId('agent-command-status-filter').selectOption('staged').catch(() => {});
    }
    await screenshot(page, 'gate-staged');
    const stagedRun = page.locator('[data-testid="agent-command-card"][data-command-type="detection.run"][data-command-status="staged"]');
    const n = AGENT_DRIVEN ? await stagedRun.count().catch(() => 0) : await stagedCount(page);
    if (!n) {
      if (AGENT_DRIVEN) throw new Error('Agent did not stage detection.run; this take is invalid.');
      banner('gate: nothing staged (agent may have answered without a write) — moving on'); return;
    }
    cue.t_staged_s = elapsed();
    if (GATE_MANUAL) {
      banner(`gate: ${n} command(s) STAGED — click Apply on camera now (waiting up to ${Math.round(GATE_WAIT / 1000)}s)…`);
      const dl = Date.now() + GATE_WAIT;
      while (Date.now() < dl && (await stagedCount(page)) > 0) await wait(600);
      if ((await stagedCount(page)) > 0) { banner('gate: human did not click in time — auto-approving as fallback'); }
    } else {
      banner(`gate: ${n} command(s) STAGED — holding ${Math.round(GATE_PAUSE / 1000)}s, then Apply`);
      await wait(GATE_PAUSE);
    }
    if (AGENT_DRIVEN) {
      const apply = stagedRun.first().getByTestId('agent-command-apply');
      await moveCursorTo(page, apply, { click: true });
    } else {
      for (let i = 0; i < 8; i += 1) {
        const apply = page.getByTestId('agent-command-apply');
        if (!(await apply.count().catch(() => 0))) break;
        await apply.first().click({ timeout: 5000 }).catch(() => {});
        await wait(800);
      }
    }
    cue.t_apply_s = elapsed();
    await screenshot(page, 'gate-applied');
  };

  // Walk into the Prepare panel so the camera sees the filter fields the agent just set.
  const showPrepareParams = async (page) => {
    try {
      await moveCursorTo(page, page.getByTestId('pyqt-header_prepare_button'), { click: true });
      await page.waitForSelector('[data-testid="pyqt-fp_input"]', { timeout: 8000 });
      const read = async (tid) => page.getByTestId(tid).inputValue().catch(() => '');
      const params = { fp: await read('pyqt-fp_input'), fs: await read('pyqt-fs_input'), notch: await read('pyqt-line_noise_notch_input') };
      banner(`prepare panel now shows fp=${params.fp} fs=${params.fs} notch=${params.notch}`);
      await screenshot(page, 'prepare-params');
      await wait(SETTLE);
      await moveCursorTo(page, page.getByTestId('pyqt-subpage_back_to_main_button').first(), { click: true }).catch(() => {});
      await wait(800);
      return params;
    } catch { return null; }
  };

  // One paced turn through the real composer: type it out, wait for the reply, hold, capture a cue.
  const ask = async (page, turn) => {
    const cue = { beat: turn.key, t_start_s: elapsed(), prompt: turn.prompt, reply: '', ok: false };
    banner(`beat «${turn.key}» — typing prompt`);
    await showChat(page);
    await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 8000 }).catch(() => {});
    await wait(PAUSE_BEFORE);
    const before = await page.getByTestId('agent-chat-agent-message').count().catch(() => 0);
    const input = page.locator('#agent-prompt-input');
    await moveCursorTo(page, input, { click: true }).catch(() => {});
    await input.fill('');
    await input.pressSequentially(turn.prompt, { delay: TYPE_DELAY }); // visible typing
    await wait(400);
    cue.t_submit_s = elapsed();
    await moveCursorTo(page, page.getByTestId('agent-chat-composer').locator('button[type="submit"]'), { click: true });
    try {
      await page.waitForFunction(
        (n) => document.querySelectorAll('[data-testid="agent-chat-agent-message"]').length > n,
        before, { timeout: turn.timeout || REPLY_TIMEOUT, polling: 1000 },
      );
      cue.reply = (await page.getByTestId('agent-chat-agent-message').last().innerText().catch(() => '')).trim();
      cue.ok = true;
      cue.t_reply_s = elapsed();
      cue.english_only = !/[\u3400-\u9fff]/u.test(cue.reply);
    } catch (e) {
      cue.note = e instanceof Error ? e.message.split('\n')[0] : String(e);
      banner(`beat «${turn.key}» — no reply in time (${cue.note}); continuing`);
    }
    if (AGENT_DRIVEN && cue.ok && !cue.english_only) throw new Error(`Agent reply for ${turn.key} contains non-English CJK text.`);
    banner(`beat «${turn.key}» — reply: "${cue.reply.slice(0, 110).replace(/\s+/g, ' ')}"`);
    await wait(SETTLE);
    if (!turn.gate) await verifyExpectedCommands(page, turn, cue);
    if (turn.showPrepare) cue.prepareParams = await showPrepareParams(page);
    if (AGENT_DRIVEN && turn.showPrepare) {
      const p = cue.prepareParams || {};
      if (String(p.fp) !== '80' || String(p.fs) !== '250' || String(p.notch || '').trim() !== '') {
        throw new Error(`Prepare parameters are not camera-safe: ${JSON.stringify(p)}.`);
      }
    }
    if (turn.gate) {
      if (turn.computeWaitMs) await wait(turn.computeWaitMs);
      await runGate(page, cue);
      if (turn.waitForEvents) {
        banner('waiting for detection to complete (events to load)…');
        const dl = Date.now() + (turn.timeout || COMPUTE_TIMEOUT);
        let q = { count: 0 };
        while (Date.now() < dl) {
          q = await page.evaluate(async () => { const a = window.ieeg; if (!a?.listEvents) return { count: 0 }; try { const r = await a.listEvents({}); return { count: (r?.events || []).length }; } catch { return { count: 0 }; } });
          if (q.count > 0) break;
          await wait(2500);
        }
        banner(`detection: ${q.count} events loaded`);
        cue.events = q.count;
        cue.t_events_s = elapsed();
        if (AGENT_DRIVEN && q.count <= 0) throw new Error('Detection completed without loaded events; this take is invalid.');
      }
      await wait(RESULT_PAUSE);
      await showChat(page);
    }
    cue.screenshot = await screenshot(page, turn.key);
    cue.t_end_s = elapsed();
    cues.push(cue);
    return cue;
  };

  try {
    await waitForServer(`${baseUrl}/`);
    const win = /^\d+x\d+$/.test(WINDOW) ? WINDOW.split('x').map(Number) : null;
    app = await electron.launch({
      executablePath: electronExecutable,
      args: AGENT_DRIVEN ? [desktopRoot, `--user-data-dir=${userDataDir}`, '--lang=en-US'] : [desktopRoot],
      cwd: desktopRoot,
      // Self-record the rendered window — no OS screen-recording permission, captures only the app.
      recordVideo: { dir: join(outDir, 'video'), size: { width: 1920, height: 1080 } },
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/`,
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS || '90000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_AGENT_ROOT: repoRoot,
        // Pin the capable model on the desktop turn (turbo/flash are too weak to reliably tool-call).
        PYHFO_AGENT_MODEL: process.env.PYHFO_AGENT_MODEL || 'qwen3.5-plus',
        IEEG_AGENT_MODEL: process.env.IEEG_AGENT_MODEL || process.env.PYHFO_AGENT_MODEL || 'qwen3.5-plus',
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: BIG,
    });
    const proc = app.process();
    proc?.stdout?.on('data', (c) => diagnostics.electronLogs.push(String(c)));
    proc?.stderr?.on('data', (c) => diagnostics.electronLogs.push(String(c)));
    const page = await app.firstWindow({ timeout: BIG });
    page.setDefaultTimeout(15000);
    videoObj = page.video();
    videoStartedAt = Date.now();
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });

    // Infra gate: the agent runtime must be up — otherwise there is nothing to film.
    const status = await page.evaluate(async () => (window.ieeg?.getBackendStatus ? window.ieeg.getBackendStatus() : null));
    if (!(status && status.agent_runtime && status.agent_runtime.up)) {
      fail('Agent runtime did not start; co-pilot cannot run.', { backend_status: status, electron_log_tail: diagnostics.electronLogs.join('').split('\n').slice(-40) });
    }

    // A clean recording frame.
    if (win) await app.evaluate(async ({ BrowserWindow }, [w, h]) => { const b = BrowserWindow.getAllWindows()[0]; if (b) { b.setContentSize(w, h); b.center(); b.show(); b.focus(); } }, win).catch(() => {});

    // Load the real EDF via the recents path (the native open dialog is not scriptable).
    await page.evaluate(({ fixture, agentDriven }) => {
      window.localStorage.setItem('ieeg.recentRecordings', JSON.stringify([{ path: fixture, label: fixture.split('/').pop() || fixture, openedAt: new Date().toISOString(), metadata: null }]));
      if (agentDriven) {
        window.localStorage.setItem('ieeg.agentAutonomy', 'review');
        window.localStorage.setItem('ieeg.agentPanelWidth', '520');
        window.localStorage.setItem('ieeg.agentPanelTab', 'Chat');
        window.localStorage.setItem('ieeg.workspaceSplitPercent', '60');
      }
    }, { fixture: fixturePath, agentDriven: AGENT_DRIVEN });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });
    await page.waitForSelector('[data-testid="pyqt-recent_recording_open_button"]', { timeout: 15000, state: 'attached' });
    await page.getByTestId('pyqt-recent_recording_open_button').first().evaluate((el) => el.click());
    await page.waitForSelector('[data-testid="pyqt-waveformWiget"]', { timeout: BIG });
    await wait(1200);
    await installDemoCursor(page);
    // Normalize the vertical scale so each channel fills its lane — post-filter EEG isn't flat/ugly on camera.
    await page.getByTestId('pyqt-normalize_tool_button').click({ timeout: 8000 }).catch(() => {});
    await wait(900);
    await showChat(page);
    await screenshot(page, 'baseline-loaded');

    // Count the operator in so they can start the screen recorder, then tell the story.
    await countIn(START_HOLD_MS);
    storyOffsetS = Math.round((Date.now() - videoStartedAt) / 100) / 10;
    t0 = Date.now(); // reset clock so cue offsets are relative to "rolling", not to boot

    const plan = TURNS.filter((tn) => (ONLY.length ? ONLY.includes(tn.key) : true));
    for (const turn of plan) await ask(page, turn);

    if (!AGENT_DRIVEN) {
      // Close on the Actions ledger — the full list of what the agent did, with its approvals.
      await showActions(page);
      await wait(SETTLE);
      await screenshot(page, 'final-actions-ledger');
      await wait(RESULT_PAUSE);
    } else {
      await screenshot(page, 'final-focused-candidate');
      await wait(RESULT_PAUSE + 1000);
    }

    const okCount = cues.filter((c) => c.ok).length;
    const validTake = okCount === plan.length && cues.every((cue) => cue.english_only !== false);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(cuesPath, `${JSON.stringify({
      status: validTake ? 'recorded' : 'invalid_take',
      generated_at: new Date().toISOString(),
      fixture_path: fixturePath,
      story: STORY,
      story_offset_s: storyOffsetS,
      model: process.env.PYHFO_AGENT_MODEL || 'qwen3.5-plus',
      footage: `artifacts/${artifactName}/footage.webm`,
      beats_ok: `${okCount}/${cues.length}`,
      cues,
    }, null, 2)}\n`);
    banner(`done — ${okCount}/${cues.length} beats replied. Cues + storyboard: ${outDir}`);
    console.log(JSON.stringify({ status: validTake ? 'recorded' : 'invalid_take', beats_ok: `${okCount}/${cues.length}`, cues: cuesPath }, null, 2));
    if (!validTake) process.exitCode = 2;
  } catch (e) {
    writeFileSync(cuesPath, `${JSON.stringify({ status: 'error', message: e instanceof Error ? e.message : String(e), cues, electron_log_tail: diagnostics.electronLogs.join('').split('\n').slice(-40) }, null, 2)}\n`);
    console.error(e);
    process.exitCode = 1;
  } finally {
    await wait(1200);
    if (app) {
      try {
        await app.close(); // graceful: flushes the recorded video AND reaps the backends (before-quit)
        if (videoObj) {
          const dest = join(outDir, 'footage.webm');
          await videoObj.saveAs(dest).catch(() => {});
          banner(`footage saved: ${dest}`);
        }
      } catch { try { await app.close(); } catch {} }
    }
    vite.kill();
    if (AGENT_DRIVEN) {
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
