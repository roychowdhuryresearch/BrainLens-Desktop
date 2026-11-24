#!/usr/bin/env node
/**
 * Deterministic, realistic chat-box smoke. Renders the REAL renderer (vite + ?visualFixture=1) and
 * stubs ONLY the agent IPC (window.ieeg.streamAgentMessage/onAgentEvent) with a canned streamed
 * response, so we can assert the whole chat-box loop without the slow/non-deterministic model:
 *
 *   open Chat -> type + send -> YOUR message bubble renders -> "thinking" status ->
 *   the streamed reply text renders as an Agent bubble (the conclusion) ->
 *   an emit_ui_command from the same turn lands in the Actions command history (chat drove the UI).
 *
 * This is the behavioral coverage the source-string contract tests never had — it reproduces and
 * guards the "reply never rendered in Chat" bug.
 *
 * The stub is a Proxy: any window.ieeg method we don't explicitly define becomes a no-op that
 * resolves to {} (the renderer assumes a COMPLETE bridge once window.ieeg is truthy, so a partial
 * object breaks mount). Only the agent methods carry real behaviour.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startVite, getFreePort, waitForServer, withVisualFixture, desktopRoot } from './lib/ui-audit-harness.mjs';

const outputPath = join(desktopRoot, 'artifacts/agent-chat-flow-smoke.json');
const REPLY = 'QC complete: 12 confident EEG channels, all passed. No notch recommended. Conclusion: recording is suitable for HFO detection.';
const USER_MESSAGE = 'do QC';

const STUB = `
window.__agentCb = null;
window.__streamCalls = 0;
const __agent = {
  onAgentEvent: (cb) => { window.__agentCb = cb; return () => { window.__agentCb = null; }; },
  streamAgentMessage: async (req) => {
    window.__streamCalls += 1;
    const streamId = 'stub-stream-' + window.__streamCalls;
    setTimeout(() => {
      const cb = window.__agentCb; if (!cb) return;
      cb({ streamId, event: 'content', data: { text: ${JSON.stringify(REPLY.slice(0, 40))} } });
      cb({ streamId, event: 'content', data: { text: ${JSON.stringify(REPLY)} } });
      cb({ streamId, event: 'tool_result', data: { name: 'emit_ui_command', result: { success: true, command: { command_id: 'stub-cmd-1', type: 'waveform.set_viewport', reason: 'focus the seizure onset window', payload: { start_seconds: 30, duration_seconds: 5 }, requires_confirmation: false } } } });
      cb({ streamId, event: 'end', data: {} });
    }, 40);
    return { streamId };
  },
};
window.ieeg = new Proxy(__agent, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol') return undefined;
    // on* methods are subscriptions: calling them returns an unsubscribe FUNCTION (used as a React
    // effect cleanup). Everything else is an invoke -> Promise. A blanket Promise default breaks
    // useEffect(() => window.ieeg.onSaveBeforeClose(cb)) with "destroy is not a function".
    if (String(prop).startsWith('on')) return () => () => {};
    return () => Promise.resolve({});
  },
});
`;

const consoleErrors = [];

function finish(report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  const full = { ...report, console_errors: consoleErrors.slice(0, 8) };
  writeFileSync(outputPath, `${JSON.stringify(full, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, ...(report.checks || {}), ...(report.message ? { message: report.message } : {}), console_errors: consoleErrors.slice(0, 4) }, null, 2));
  process.exit(report.status === 'passed' ? 0 : 1);
}

const port = await getFreePort();
const { child: vite, logs: viteLogs } = startVite(port);
let browser;
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.addInitScript(STUB);
  await page.goto(withVisualFixture(`${baseUrl}/`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 25000 });

  await page.getByTestId('agent-activity-chat').click();
  await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 10000 });

  await page.fill('#agent-prompt-input', USER_MESSAGE);
  await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();

  await page.waitForSelector('[data-testid="agent-chat-user-message"]', { timeout: 10000 });
  const userText = (await page.getByTestId('agent-chat-user-message').last().innerText()).trim();
  const userOk = userText.includes(USER_MESSAGE);

  await page.waitForSelector('[data-testid="agent-chat-agent-message"]', { timeout: 10000 });
  const replyText = (await page.getByTestId('agent-chat-agent-message').last().innerText()).trim();
  const replyOk = replyText.includes('QC complete') && replyText.includes('Conclusion:');

  await page.getByTestId('agent-activity-actions').click();
  await page.waitForSelector('[data-testid="agent-command-history"]', { timeout: 10000 });
  const historyText = await page.getByTestId('agent-command-history').innerText();
  const commandOk = historyText.includes('waveform.set_viewport');

  const checks = { user_bubble: userOk, reply_bubble: replyOk, ui_command_ingested: commandOk };
  const passed = userOk && replyOk && commandOk && consoleErrors.length === 0;
  finish({
    status: passed ? 'passed' : 'failed',
    message: passed ? undefined : 'chat-box behavioral checks failed',
    checks,
    evidence: { userText, replyText: replyText.slice(0, 200) },
  });
} catch (error) {
  finish({ status: 'failed', message: error instanceof Error ? error.message : String(error), vite_logs: viteLogs.join('').split('\n').slice(-12) });
} finally {
  if (browser) await browser.close();
  vite.kill();
}
