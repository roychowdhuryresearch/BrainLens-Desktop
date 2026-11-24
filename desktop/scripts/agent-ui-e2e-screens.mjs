#!/usr/bin/env node
/**
 * Screenshot E2E for the Agent <-> UI linkage ("联动").
 *
 * Renders the REAL renderer (vite + ?visualFixture=1 -> a fully loaded 8-channel waveform-review
 * workspace) and scripts a realistic clinician conversation through the REAL streaming agent path
 * (window.ieeg.streamAgentMessage / onAgentEvent). Only the agent IPC is stubbed with a canned
 * stream; everything downstream — chat bubble rendering, UI-command ingestion, auto-applied view
 * commands (executeAppliedUICommand), the workspace status line, the Actions command history — is
 * the production React code path.
 *
 * It captures the full chat -> agent reply -> UI reacts -> conclusion loop as PNG screenshots, so a
 * human can SEE the linkage:
 *
 *   01 baseline      loaded waveform-review workspace, Agent rail open on Chat, empty conversation
 *   02 user-asked    the clinician's question rendered as a YOUR bubble, agent "thinking"
 *   03 agent-reply   the streamed conclusion rendered as an Agent bubble + status "N command(s) ingested"
 *   04 actions       Actions tab: the 3 agent-issued view commands in the command history
 *   05 linkage       Chat + waveform side-by-side — one frame showing the chat that drove the workspace
 *
 * Scope: this proves the RENDERER end-to-end linkage deterministically. The agent BACKEND emitting
 * these commands from a real model is covered separately (runtime tests + evals + qa:copilot-live).
 *
 * The stub is a Proxy: any window.ieeg method we don't define becomes a no-op resolving to {} (the
 * renderer assumes a COMPLETE bridge once window.ieeg is truthy; a partial object breaks mount). on*
 * methods return an unsubscribe FUNCTION (React effect cleanup); everything else returns a Promise.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startVite, getFreePort, waitForServer, withVisualFixture, desktopRoot } from './lib/ui-audit-harness.mjs';

const outDir = join(desktopRoot, 'artifacts/agent-ui-e2e');
const reportPath = join(outDir, 'report.json');

const USER_MESSAGE =
  'QC this recording, focus the waveform on the POL IO3 onset burst, select event evt-hfo-002 for review, then give me a verdict on whether it is suitable for HFO detection.';

// The streamed conclusion. The agent narrates the same actions its UI commands perform, so the reply
// and the workspace stay in lock-step.
const REPLY =
  'QC verdict: 6 of 8 channels are clean brain-signal ROI (POL IO5 flags as an amplitude outlier; EKG excluded). ' +
  'Line noise at 60 Hz is mild, so a notch is optional. I moved the viewport onto the 2.15 s burst on POL IO3, ' +
  'highlighted that channel, and selected event evt-hfo-002 so you can review it. ' +
  'Conclusion: this recording is suitable for HFO detection — proceed with the accepted MNI run (run-mni-002).';

// Three auto-applied view-risk commands (uiCommands.ts: confirmation 'auto'), so they execute via
// executeAppliedUICommand the moment they stream in and visibly move the workspace.
const COMMANDS = [
  { command_id: 'e2e-cmd-1', type: 'waveform.set_viewport', reason: 'center the POL IO3 onset burst', payload: { start_seconds: 1.8, duration_seconds: 0.9 }, requires_confirmation: false },
  { command_id: 'e2e-cmd-2', type: 'waveform.focus_channel', reason: 'highlight the onset channel', payload: { channel: 'POL IO3' }, requires_confirmation: false },
  { command_id: 'e2e-cmd-3', type: 'events.select_event', reason: 'open the second HFO for review', payload: { event_id: 'evt-hfo-002' }, requires_confirmation: false },
];

// Delay the canned stream so the test can screenshot the "thinking" state (user bubble shown, reply
// not yet rendered) before the reply + commands land.
const STREAM_DELAY_MS = 1300;

const STUB = `
window.__agentCb = null;
const __agent = {
  onAgentEvent: (cb) => { window.__agentCb = cb; return () => { window.__agentCb = null; }; },
  streamAgentMessage: async () => {
    const streamId = 'e2e-stream-1';
    setTimeout(() => {
      const cb = window.__agentCb; if (!cb) return;
      const reply = ${JSON.stringify(REPLY)};
      const commands = ${JSON.stringify(COMMANDS)};
      // Interleave growing reply prefixes with the view commands: the workspace moves mid-turn.
      cb({ streamId, event: 'content', data: { text: reply.slice(0, 70) } });
      cb({ streamId, event: 'tool_result', data: { name: 'emit_ui_command', result: { success: true, command: commands[0] } } });
      cb({ streamId, event: 'content', data: { text: reply.slice(0, 180) } });
      cb({ streamId, event: 'tool_result', data: { name: 'emit_ui_command', result: { success: true, command: commands[1] } } });
      cb({ streamId, event: 'tool_result', data: { name: 'emit_ui_command', result: { success: true, command: commands[2] } } });
      cb({ streamId, event: 'content', data: { text: reply } });
      cb({ streamId, event: 'end', data: {} });
    }, ${STREAM_DELAY_MS});
    return { streamId };
  },
};
window.ieeg = new Proxy(__agent, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop === 'symbol') return undefined;
    if (String(prop).startsWith('on')) return () => () => {};
    return () => Promise.resolve({});
  },
});
`;

const consoleErrors = [];
const shot = (name) => join(outDir, name);

function finish(report) {
  rmSync(reportPath, { force: true });
  const full = { ...report, console_errors: consoleErrors.slice(0, 8) };
  writeFileSync(reportPath, `${JSON.stringify(full, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, ...(report.checks || {}), ...(report.message ? { message: report.message } : {}), screenshots: report.screenshots, console_errors: consoleErrors.slice(0, 4) }, null, 2));
  process.exit(report.status === 'passed' ? 0 : 1);
}

mkdirSync(outDir, { recursive: true });
const port = await getFreePort();
const { child: vite, logs: viteLogs } = startVite(port);
let browser;
try {
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(`${baseUrl}/`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  await page.addInitScript(STUB);
  await page.goto(withVisualFixture(`${baseUrl}/`), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="pyqt-main-window"]', { timeout: 25000 });

  // 01 — baseline: loaded workspace + Agent rail open on Chat, empty conversation.
  await page.getByTestId('agent-activity-chat').click();
  await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 10000 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('01-baseline-loaded.png') });

  // Send the clinician's question.
  await page.fill('#agent-prompt-input', USER_MESSAGE);
  await page.getByTestId('agent-chat-composer').locator('button[type="submit"]').click();

  // 02 — user message rendered, agent still thinking (reply delayed by the stub).
  await page.waitForSelector('[data-testid="agent-chat-user-message"]', { timeout: 10000 });
  const userText = (await page.getByTestId('agent-chat-user-message').last().innerText()).trim();
  const userOk = userText.includes('focus the waveform') || userText.includes('POL IO3');
  await page.screenshot({ path: shot('02-user-asked.png') });

  // 03 — streamed conclusion rendered as an Agent bubble.
  await page.waitForSelector('[data-testid="agent-chat-agent-message"]', { timeout: 10000 });
  await page.waitForFunction(
    () => (document.querySelector('[data-testid="agent-chat-agent-message"]')?.textContent || '').includes('Conclusion'),
    { timeout: 10000 },
  );
  const replyText = (await page.getByTestId('agent-chat-agent-message').last().innerText()).trim();
  const replyOk = replyText.includes('QC verdict') && replyText.includes('Conclusion:') && replyText.includes('run-mni-002');
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot('03-agent-conclusion.png') });

  // The status can surface in different places depending on whether the loaded
  // workspace is in the review view or a workflow subpage. Read the persistent
  // status strip first, then the Actions runtime log after switching tabs.
  const statusText = [
    await page.getByTestId('pyqt-workflow_status_label').innerText().catch(() => ''),
    await page.getByTestId('pyqt-activity_summary_label').innerText().catch(() => ''),
  ].join('\n').trim();

  // 04 — Actions tab: the three agent-issued view commands in the command history.
  await page.getByTestId('agent-activity-actions').click();
  await page.waitForSelector('[data-testid="agent-command-history"]', { timeout: 10000 });
  await page.waitForTimeout(200);
  const historyText = await page.getByTestId('agent-command-history').innerText();
  const commandOk =
    historyText.includes('waveform.set_viewport') &&
    historyText.includes('waveform.focus_channel') &&
    historyText.includes('events.select_event');
  const actionsText = await page.getByTestId('agent-panel').innerText().catch(() => '');
  const statusOk = /3\s+UI command/.test([statusText, actionsText, historyText].join('\n'));
  await page.screenshot({ path: shot('04-actions-command-history.png') });

  // 05 — back to Chat: one frame of the conversation beside the workspace it steered.
  await page.getByTestId('agent-activity-chat').click();
  await page.waitForSelector('[data-testid="agent-chat-tab"]', { timeout: 10000 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: shot('05-linkage-chat-and-workspace.png') });

  const screenshots = [
    '01-baseline-loaded.png',
    '02-user-asked.png',
    '03-agent-conclusion.png',
    '04-actions-command-history.png',
    '05-linkage-chat-and-workspace.png',
  ].map((name) => join('artifacts/agent-ui-e2e', name));

  const checks = { user_bubble: userOk, agent_conclusion: replyOk, status_3_commands: statusOk, command_history: commandOk };
  const passed = userOk && replyOk && statusOk && commandOk && consoleErrors.length === 0;
  finish({
    status: passed ? 'passed' : 'failed',
    message: passed ? undefined : 'agent<->UI linkage screenshot checks failed',
    checks,
    screenshots,
    evidence: { userText: userText.slice(0, 160), replyText: replyText.slice(0, 240), statusText: statusText.slice(0, 160) },
  });
} catch (error) {
  finish({ status: 'failed', message: error instanceof Error ? error.message : String(error), vite_logs: viteLogs.join('').split('\n').slice(-12) });
} finally {
  if (browser) await browser.close();
  vite.kill();
}
