#!/usr/bin/env node
// Runtime proof for the window-close fix: with a genuinely dirty workspace (real
// recording loaded, non-fixture mode), clicking close must show the native
// unsaved-changes dialog and then ACTUALLY close the window after Discard/Save.
// Before the fix, a renderer beforeunload veto cancelled the programmatic
// mainWindow.close(), so the window stayed open forever (Discard) / raced (Save).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..')); // = repo root
const electronExecutable = require('electron');
const SCENARIO = (process.argv[2] || 'discard').toLowerCase(); // 'discard' | 'save'
const RESPONSE = SCENARIO === 'save' ? 1 : 2; // 0=Cancel 1=Save Project 2=Discard Changes
const EDF = join(repoRoot, 'data/Omni-iEEG/sub-Multicenterumf005/ses-presurgery/ieeg/sub-Multicenterumf005_ses-presurgery_task-ictal_acq-ecog_run-01_ieeg.edf');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function waitForServer(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server not ready at ${url}`);
}
function startVite(port) {
  const child = spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], {
    cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], text: true,
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
async function poll(fn, timeoutMs, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { try { if (await fn()) return true; } catch {} await new Promise((r) => setTimeout(r, intervalMs)); }
  return false;
}

async function main() {
  const rendererPort = await getFreePort();
  const backendPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = startVite(rendererPort);
  let app;
  const log = (m) => console.log(`[${SCENARIO}] ${m}`);
  try {
    await waitForServer(`${baseUrl}/`);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/`, // NON-fixture: needed so beforeunload (old code) would attach
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_BACKEND_PYTHON: process.env.PYHFO_BACKEND_PYTHON || 'python',
        PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '60000',
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        ELECTRON_ENABLE_LOGGING: '1',
      },
      timeout: 90000,
    });
    const page = await app.firstWindow({ timeout: 90000 });
    page.setDefaultTimeout(8000);
    page.on('pageerror', (e) => console.error('  PAGEERROR', String(e).slice(0, 200)));
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 30000 });
    const health = await page.evaluate(async () => (window.ieeg ? await window.ieeg.getBackendStatus() : null));
    log(`backend health: ${JSON.stringify(health)}`);

    // Stub native dialogs in the MAIN process: file picker returns our EDF; the
    // unsaved-changes message box returns the scenario's button.
    await app.evaluate(({ dialog }, { edf, response }) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [edf] });
      globalThis.__msgbox = [];
      dialog.showMessageBox = async (_w, opts) => { globalThis.__msgbox.push((opts && opts.title) || ''); return { response }; };
    }, { edf: EDF, response: RESPONSE });

    // Open the EDF -> real backend load -> markWorkspaceDirty() -> projectDirty=true.
    await page.getByTestId('pyqt-actionOpen_EDF_toolbar').click({ force: true });
    log('clicked Open EDF; waiting for workspace to become dirty…');
    const becameDirty = await poll(() => app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return !!(w && w.isDocumentEdited());
    }), 40000);
    if (!becameDirty) { log('FAIL: workspace never became dirty (recording load did not complete)'); process.exitCode = 2; return; }
    log('workspace is dirty (main setDocumentEdited=true). Triggering window close…');

    // Simulate the user clicking the window close (red X / Cmd+W).
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; if (w) w.close(); });

    const closed = await poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0), 12000);
    const shown = await app.evaluate(() => globalThis.__msgbox || []).catch(() => ['<unknown>']);
    log(`native dialog shown: ${JSON.stringify(shown)}`);
    log(`window closed after ${SCENARIO}: ${closed}`);
    if (closed && shown.length) { log(`PASS ✅ — dialog appeared and window closed on ${SCENARIO}`); process.exitCode = 0; }
    else if (!shown.length) { log('FAIL ❌ — close guard dialog never fired (workspace not seen as dirty by main)'); process.exitCode = 1; }
    else { log(`FAIL ❌ — dialog appeared but window stayed open on ${SCENARIO} (veto still active?)`); process.exitCode = 1; }
  } finally {
    // app.quit() (not app.exit) so Electron's before-quit fires and reaps the
    // Python backend child; before-quit runs synchronously even if a window
    // close is later vetoed, so the backend is stopped regardless.
    try { if (app) await app.evaluate(({ app: a }) => a.quit()); } catch {}
    vite.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(3); });
