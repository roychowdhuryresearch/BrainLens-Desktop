import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadRouter() {
  const source = readFileSync(join(root, 'src/app/agentStreamRouter.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022, isolatedModules: true },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const routerPromise = loadRouter();

function frame(streamId, event, text) {
  return { streamId, event, data: { text } };
}

test('frames pushed before the streamId resolves are buffered, then replayed in order', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  const router = createAgentStreamRouter((p) => seen.push(p.data.text));
  router.push(frame('s1', 'content', 'a'));
  router.push(frame('s1', 'content', 'b'));
  assert.deepEqual(seen, [], 'nothing handled before resolve');
  router.resolve('s1');
  assert.deepEqual(seen, ['a', 'b'], 'buffered frames replay in arrival order');
});

test('a previous turn\'s late frames (different streamId) are rejected, not bled in', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  const router = createAgentStreamRouter((p) => seen.push(p.data.text));
  // Turn A abandoned; its late frames arrive on the shared channel before THIS turn's id is known.
  router.push(frame('stale-A', 'content', 'ghost'));
  router.push(frame('s2', 'content', 'mine'));
  router.resolve('s2');
  assert.deepEqual(seen, ['mine'], 'only the frame matching our streamId is handled');
});

test('after resolve, live frames are filtered by streamId', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  const router = createAgentStreamRouter((p) => seen.push(p.data.text));
  router.resolve('s3');
  router.push(frame('s3', 'content', 'keep'));
  router.push(frame('other', 'content', 'drop'));
  router.push(frame('s3', 'content', 'keep2'));
  assert.deepEqual(seen, ['keep', 'keep2']);
});

test('an empty resolved streamId falls open to all frames (single-stream fallback)', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  const router = createAgentStreamRouter((p) => seen.push(p.data.text));
  router.push(frame('whatever', 'content', 'x'));
  router.resolve('');
  router.push(frame(undefined, 'content', 'y'));
  assert.deepEqual(seen, ['x', 'y']);
});

test('dispose stops all handling and drops the buffer', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  const router = createAgentStreamRouter((p) => seen.push(p.data.text));
  router.push(frame('s4', 'content', 'buffered'));
  router.dispose();
  router.resolve('s4');            // no-op after dispose
  router.push(frame('s4', 'content', 'live')); // ignored after dispose
  assert.deepEqual(seen, []);
});

test('resolve is idempotent', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  const router = createAgentStreamRouter((p) => seen.push(p.data.text));
  router.push(frame('s5', 'content', 'a'));
  router.resolve('s5');
  router.resolve('s5');   // second resolve must not re-drain
  assert.deepEqual(seen, ['a']);
});

test('a terminal frame that disposes the router mid-drain stops further handling', async () => {
  const { createAgentStreamRouter } = await routerPromise;
  const seen = [];
  let router;
  router = createAgentStreamRouter((p) => {
    seen.push(p.data.text);
    if (p.event === 'done') router.dispose();   // mirrors finish() -> router.dispose() on a terminal frame
  });
  router.push(frame('s6', 'content', 'a'));
  router.push(frame('s6', 'done', 'terminal'));
  router.push(frame('s6', 'content', 'after-terminal')); // buffered after the terminal
  router.resolve('s6');
  assert.deepEqual(seen, ['a', 'terminal'], 'frames after the disposing terminal are not resurrected');
});
