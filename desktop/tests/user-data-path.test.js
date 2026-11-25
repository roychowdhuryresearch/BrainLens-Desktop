import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../electron/userDataPath.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { configureUserDataPaths } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

const legacy = 'ieeg-electron-desktop';
const product = 'BrainLens Desktop';
for (const [scenario, existing, expected] of [
  ['fresh install', [], product],
  ['legacy only', [legacy], legacy],
  ['both present', [legacy, product], legacy],
  ['new only', [product], product],
]) {
  test(`profile selection on first launch and relaunch: ${scenario}`, (t) => {
    const appData = mkdtempSync(join(tmpdir(), 'brainlens-profile-'));
    t.after(() => rmSync(appData, { recursive: true, force: true }));
    for (const name of existing) {
      mkdirSync(join(appData, name));
      writeFileSync(join(appData, name, 'llm-settings.json'), name);
    }
    const paths = {};
    const app = {
      commandLine: { hasSwitch: () => false },
      getPath(name) { assert.equal(name, 'appData'); return appData; },
      setPath(name, directory) {
        assert.ok(existsSync(directory));
        paths[name] = directory;
      },
    };

    for (let launch = 0; launch < 2; launch++) {
      configureUserDataPaths(app);
      assert.deepEqual(paths, { userData: join(appData, expected), sessionData: join(appData, expected) });
      assert.deepEqual(readdirSync(appData).sort(), [...new Set([...existing, expected])].sort());
    }
    for (const name of existing) {
      assert.equal(readFileSync(join(appData, name, 'llm-settings.json'), 'utf8'), name);
    }
  });
}

test('an explicit --user-data-dir retains Electron’s own path handling', () => {
  configureUserDataPaths({
    commandLine: { hasSwitch: (name) => name === 'user-data-dir' },
    getPath: () => assert.fail('unexpected access to the default profile'),
    setPath: () => assert.fail('explicit profile was overridden'),
  });
});
