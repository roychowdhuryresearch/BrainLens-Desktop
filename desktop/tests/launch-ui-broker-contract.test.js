import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const launchScript = () => readFileSync(join(root, 'scripts/launch-electron-app.mjs'), 'utf8');
const launcherPromise = import('../scripts/launch-electron-app.mjs');

function buildFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'ieeg-launch-build-'));
  for (const directory of ['electron', 'src/app', 'dist-electron', 'dist-renderer']) mkdirSync(join(fixture, directory), { recursive: true });
  const securitySource = [
    "import { randomBytes } from 'node:crypto';",
    "export function mintUiBrokerToken() { return randomBytes(32).toString('hex'); }",
    'export function startUiBroker() {',
    '  const token = mintUiBrokerToken();',
    '  return { env: { IEEG_UI_BROKER_TOKEN: token } };',
    '}',
  ].join('\n');
  const compiledSecurity = [
    "function mintUiBrokerToken() { return randomBytes(32).toString('hex'); }",
    'const token = mintUiBrokerToken();',
    'const env = { IEEG_UI_BROKER_TOKEN: token };',
  ].join('\n');
  const files = {
    'electron/pythonBackend.ts': securitySource,
    'electron/main.ts': 'export {};',
    'electron/tsconfig.json': '{}',
    'src/app/App.tsx': 'export function App() { return null; }',
    'index.html': '<main></main>',
    'vite.config.ts': 'export default {};',
    'tsconfig.json': '{}',
    'package.json': '{"type":"module"}',
    'package-lock.json': '{}',
    'dist-electron/main.js': 'export {};',
    'dist-electron/preload.cjs': 'module.exports = {};',
    'dist-electron/pythonBackend.js': compiledSecurity,
    'dist-renderer/index.html': '<main></main>',
  };
  for (const [relativePath, content] of Object.entries(files)) writeFileSync(join(fixture, relativePath), content);
  return fixture;
}

function setFixtureTimes(fixture) {
  const old = new Date('2026-07-15T18:00:00Z');
  const current = new Date('2026-07-15T19:00:00Z');
  for (const relativePath of ['electron/pythonBackend.ts', 'electron/main.ts', 'electron/tsconfig.json', 'src/app/App.tsx', 'index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json']) {
    utimesSync(join(fixture, relativePath), old, old);
  }
  for (const relativePath of ['dist-electron/main.js', 'dist-electron/preload.cjs', 'dist-electron/pythonBackend.js', 'dist-renderer/index.html']) {
    utimesSync(join(fixture, relativePath), current, current);
  }
}

test('production app launcher enables UI broker by default', () => {
  const script = launchScript();

  assert.match(script, /uiBroker: true/);
  assert.match(script, /--no-ui-broker/);
  assert.match(script, /IEEG_DISABLE_UI_BROKER: options\.uiBroker \? '0' : '1'/);
  assert.match(script, /row\.args\.includes\('ui_mcp\.broker'\)/);
  assert.match(script, /brokerHealthy/);
  assert.match(script, /UI broker \$\{broker\.pid\} on \$\{brokerPort\}/);
  assert.match(script, /const staleReasons = buildStalenessReasons\(\)/);
  assert.match(script, /staleReasons\.length[\s\S]{0,500}runChecked\('npm', \['run', 'build'\]/);
  assert.match(script, /compiledTokenMintContractIsCurrent/);
});

test('launcher build integrity accepts a current production build', async (t) => {
  const launcher = await launcherPromise;
  const fixture = buildFixture();
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  launcher.writeBuildManifest(fixture);
  setFixtureTimes(fixture);
  assert.deepEqual(launcher.buildStalenessReasons(fixture), []);
});

test('launcher marks production build stale when any source input is newer', async (t) => {
  const launcher = await launcherPromise;
  const fixture = buildFixture();
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  launcher.writeBuildManifest(fixture);
  setFixtureTimes(fixture);
  const newer = new Date('2026-07-15T20:00:00Z');
  utimesSync(join(fixture, 'src/app/App.tsx'), newer, newer);
  assert.ok(launcher.buildStalenessReasons(fixture).includes('source inputs are newer than production outputs'));
});

test('launcher detects token-mint source drift even when mtimes look current', async (t) => {
  const launcher = await launcherPromise;
  const fixture = buildFixture();
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  launcher.writeBuildManifest(fixture);
  setFixtureTimes(fixture);
  const securityPath = join(fixture, 'electron/pythonBackend.ts');
  writeFileSync(securityPath, `${readFileSync(securityPath, 'utf8')}\n// security-relevant source changed`);
  const old = new Date('2026-07-15T18:00:00Z');
  utimesSync(securityPath, old, old);
  assert.ok(launcher.buildStalenessReasons(fixture).includes('UI broker token-mint source differs from the last production build'));
});

test('launcher rejects compiled output that still has the optional-token broker path', async (t) => {
  const launcher = await launcherPromise;
  const fixture = buildFixture();
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  launcher.writeBuildManifest(fixture);
  setFixtureTimes(fixture);
  const compiledPath = join(fixture, 'dist-electron/pythonBackend.js');
  writeFileSync(compiledPath, "const token = process.env.IEEG_UI_BROKER_TOKEN || '';\n");
  const current = new Date('2026-07-15T19:00:00Z');
  utimesSync(compiledPath, current, current);
  assert.ok(launcher.buildStalenessReasons(fixture).includes('compiled UI broker token-mint contract is missing or stale'));
});
