#!/usr/bin/env node
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1'; // automation: bypass unsaved-workspace close guard (electron/main.ts)
/**
 * Fast smoke for the bring-your-own-key bridge. Launches the REAL Electron app with the LLM agent
 * runtime DISABLED (so the key-set restart is a no-op — no 40s reboot, no real LLM key needed) and
 * round-trips window.ieeg.clearLlmKey / setLlmKey / llmKeyStatus through the OS keychain (safeStorage).
 * Verifies the encrypted store + IPC wiring without touching a provider. Run after npm run build.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const electronExecutable = require('electron');
const BIG = 180000;

function getFreePort() {
  return new Promise((res, rej) => {
    const s = createServer(); s.unref(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
  });
}
async function waitForServer(url, timeoutMs = 45000) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* retry */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error(`renderer dev server not ready at ${url}`);
}
function startVite(port) {
  return spawn('npm', ['run', 'dev', '--', '--port', String(port), '--strictPort'], { cwd: desktopRoot, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'], text: true });
}

async function main() {
  if (!existsSync(join(desktopRoot, 'dist-electron/main.js'))) { console.error('Run npm run build first.'); process.exit(2); }
  const rendererPort = await getFreePort();
  const backendPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${rendererPort}`;
  const vite = startVite(rendererPort);
  let app;
  try {
    await waitForServer(`${baseUrl}/`);
    app = await electron.launch({
      executablePath: electronExecutable,
      args: [desktopRoot],
      cwd: desktopRoot,
      env: {
        ...process.env,
        VITE_DEV_SERVER_URL: `${baseUrl}/`,
        PYHFO_BACKEND_PORT: String(backendPort),
        PYHFO_APP_ROOT: join(repoRoot, 'pyhfo'),
        IEEG_AGENT_ROOT: repoRoot,
        IEEG_DISABLE_AGENT_RUNTIME: '1', // key-set restart becomes a no-op → fast, no provider call
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
      timeout: BIG,
    });
    const page = await app.firstWindow({ timeout: BIG });
    await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: BIG });

    await page.evaluate(async () => { await window.ieeg.clearLlmKey(); });
    const before = await page.evaluate(async () => window.ieeg.llmKeyStatus());
    const setResult = await page.evaluate(async () => window.ieeg.setLlmKey('test-byok-key-abc123'));
    const afterSet = await page.evaluate(async () => window.ieeg.llmKeyStatus());
    await page.evaluate(async () => { await window.ieeg.clearLlmKey(); });
    const afterClear = await page.evaluate(async () => window.ieeg.llmKeyStatus());

    const checks = {
      starts_empty: before?.hasKey === false,
      encryption_available: afterSet?.encryptionAvailable === true,
      set_ok: setResult?.ok === true,
      stored_after_set: afterSet?.hasKey === true,
      cleared_after_clear: afterClear?.hasKey === false,
    };
    const passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ status: passed ? 'passed' : 'failed', checks, before, setResult, afterSet, afterClear }, null, 2));
    process.exitCode = passed ? 0 : 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (app) { try { await app.evaluate(async ({ app }) => app.exit(0)); } catch { try { await app.close(); } catch { /* ignore */ } } }
    vite.kill();
  }
}

main();
