#!/usr/bin/env node
// Fast chat-UI check: vite dev server + chromium, no packaging. Verifies the selection highlight,
// the collapsed activity rows, the working line, and the approval bubble's contents.
import { mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outDir = join(desktopRoot, 'artifacts', 'agent-ui');
mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

const vite = await createViteServer({ root: desktopRoot, server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' });
await vite.listen();
const { port } = vite.httpServer.address();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 950 } });
page.on('pageerror', (error) => console.log('[pageerror]', error.message));
page.setDefaultTimeout(120000);
await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.evaluate(async () => {
  const probe = await import('/src/__agentPanelProbe.tsx');
  await probe.mountAgentPanel('agent-probe');
});
await page.waitForTimeout(600);

// 1. Selection must be VISIBLE — the bug that made the app look unselectable.
const selection = await page.evaluate(() => {
  const probe = document.createElement('span');
  probe.textContent = 'selection colour probe';
  document.body.appendChild(probe);
  const range = document.createRange();
  range.selectNodeContents(probe);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  let highlight = null;
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules) {
      if ((rule.selectorText || '').includes('::selection')) highlight = rule.style.background || rule.style.backgroundColor;
    }
  }
  return { selected: String(sel), highlight };
});
check('selection highlight is visible (not transparent)',
  Boolean(selection.highlight) && !/transparent/i.test(selection.highlight), `background=${selection.highlight}`);

// 2. Working state is a status line, not an empty Agent bubble.
const working = await page.evaluate(() => ({
  workingLine: document.querySelector('[data-testid="agent-chat-working"]')?.textContent?.trim() || null,
  emptyBubble: Boolean(document.querySelector('[data-testid="agent-chat-streaming-message"]')),
}));
check('working state shows a status line, no empty reply bubble',
  Boolean(working.workingLine) && !working.emptyBubble, JSON.stringify(working));

// 3. Observations collapse into one activity row.
const activity = await page.evaluate(() => {
  const row = document.querySelector('[data-testid="agent-chat-observation-message"]');
  return row ? { tag: row.tagName, open: row.open, summary: row.querySelector('summary')?.textContent?.trim() } : null;
});
check('agent working notes render as a collapsed activity row',
  activity?.tag === 'DETAILS' && activity.open === false, JSON.stringify(activity));

// 4. Approval bubble: readable action name, parameters, Run button.
const staged = await page.evaluate(() => ({
  label: document.querySelector('[data-testid="agent-chat-staged-card"] .agent-chat-staged-type')?.textContent?.trim() || null,
  params: [...document.querySelectorAll('[data-testid="agent-chat-staged-params"] div')].map((row) => row.textContent.trim()),
  runButton: document.querySelector('[data-testid="agent-chat-staged-apply"]')?.textContent?.trim() || null,
}));
check('approval bubble names the action in words', staged.label === 'Run severity scoring', String(staged.label));
check('approval bubble lists the parameters', staged.params.length === 2, JSON.stringify(staged.params));
check('approval bubble button says Run', staged.runButton === 'Run', String(staged.runButton));

const failures = await page.evaluate(() => ({
  card: document.querySelector('[data-testid="agent-chat-failure-card"]')?.textContent?.trim() || null,
  waiting: document.querySelector('[data-testid="agent-chat-staged-waiting"]')?.textContent?.trim() || null,
}));
check('a rejected tool call is visible with its reason',
  Boolean(failures.card) && /Could not run/.test(failures.card) && /missing recording/.test(failures.card), String(failures.card));
check('a staged command shows how long it has waited',
  Boolean(failures.waiting) && /Waiting 4 min/.test(failures.waiting), String(failures.waiting));

const threads = await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('[data-testid="agent-conversation-tab"] .agent-conversation-title')].map((tab) => tab.textContent.trim()),
  active: document.querySelector('[data-testid="agent-conversation-tab"].active .agent-conversation-title')?.textContent?.trim() || null,
  plus: document.querySelector('[data-testid="agent-conversation-new"]')?.textContent?.trim() || null,
  model: document.querySelector('[data-testid="agent-panel-model"]')?.textContent?.trim() || null,
}));
// Resizing must not collapse the strip: it used to sit in an implicit grid row with no size.
await page.setViewportSize({ width: 520, height: 620 });
await page.waitForTimeout(300);
const afterResize = await page.evaluate(() => {
  const strip = document.querySelector('[data-testid="agent-conversation-tabs"]');
  const r = strip?.getBoundingClientRect();
  return r ? { height: Math.round(r.height), visible: r.height > 0 && r.width > 0 } : null;
});
check('the tab strip survives a resize', afterResize?.visible === true && afterResize.height >= 30, JSON.stringify(afterResize));
await page.setViewportSize({ width: 900, height: 950 });
await page.waitForTimeout(300);

const stripBox = await page.evaluate(() => {
  const strip = document.querySelector('[data-testid="agent-conversation-tabs"]');
  if (!strip) return null;
  const r = strip.getBoundingClientRect();
  const cs = getComputedStyle(strip);
  return { height: Math.round(r.height), overflowX: cs.overflowX, scrollable: strip.scrollWidth > strip.clientWidth };
});
check('the tab strip is a compact scrolling row', stripBox && stripBox.height <= 40 && stripBox.overflowX === 'auto', JSON.stringify(stripBox));

const closable = await page.evaluate(() => {
  const tabs = [...document.querySelectorAll('[data-testid="agent-conversation-tab"]')];
  const closes = [...document.querySelectorAll('[data-testid="agent-conversation-close"]')];
  const inner = closes[0]?.closest('button');
  return {
    tabs: tabs.length,
    closes: closes.length,
    labelled: closes[0]?.getAttribute('aria-label') || null,
    // A <button> inside a <button> is invalid markup and its clicks get dropped.
    nestedButton: Boolean(closes[0] && closes[0].tagName === 'BUTTON' && inner),
  };
});
check('every tab offers a close control', closable.closes === closable.tabs && /^Close Chat/.test(closable.labelled || ''), JSON.stringify(closable));
check('the close control is not a nested button', closable.nestedButton === false, JSON.stringify(closable));

const wheeled = await page.evaluate(async () => {
  const strip = document.querySelector('[data-testid="agent-conversation-tabs"]');
  const before = strip.scrollLeft;
  strip.dispatchEvent(new WheelEvent('wheel', { deltaY: 220, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  return { before, after: strip.scrollLeft, overflow: strip.scrollWidth - strip.clientWidth };
});
check('the mouse wheel scrolls the tab strip sideways', wheeled.overflow > 0 && wheeled.after > wheeled.before, JSON.stringify(wheeled));

check('the chat panel lists conversations with a + to start one',
  threads.tabs.length === 12 && threads.active === 'Chat 1' && threads.plus === '+', JSON.stringify(threads));

await page.screenshot({ path: join(outDir, 'agent-chat.png'), fullPage: true });
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await browser.close();
await vite.close();
