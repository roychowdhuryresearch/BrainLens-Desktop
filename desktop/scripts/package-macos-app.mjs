#!/usr/bin/env node
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const repoRoot = normalize(join(desktopRoot, '..'));
const desktopPackage = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8'));
const appVersion = String(desktopPackage.version || '').trim();
if (!/^\d+(?:\.\d+){0,2}$/.test(appVersion)) fail(`Invalid desktop package version for macOS bundle metadata: ${appVersion || '(empty)'}`);
const agentRuntimeRoot = join(repoRoot, 'runtime');
const require = createRequire(import.meta.url);
const outputApp = normalize(process.env.PYHFO_PACKAGE_OUTPUT_APP || join(desktopRoot, 'artifacts/packaged/iEEG.app'));
const pyhfoRoot = join(repoRoot, 'pyhfo');
const backendBundleSourceRoot = normalize(process.env.PYHFO_BACKEND_BUNDLE_DIR || join(pyhfoRoot, 'dist', 'pyhfo-backend'));
const backendExecutableSource = join(backendBundleSourceRoot, 'pyhfo-backend');
const agentRuntimeBundleSourceRoot = normalize(process.env.IEEG_AGENT_RUNTIME_BUNDLE_DIR || join(agentRuntimeRoot, 'dist', 'ieeg-agent-runtime'));
const agentRuntimeExecutableSource = join(agentRuntimeBundleSourceRoot, 'ieeg-agent-runtime');
const electronExecutable = require('electron');
const electronAppRoot = electronExecutable.includes('.app/Contents/MacOS/')
  ? electronExecutable.slice(0, electronExecutable.indexOf('.app/Contents/MacOS/') + '.app'.length)
  : '';

function fail(message) {
  console.error(message);
  process.exit(1);
}

const electronLocaleFamilies = new Set(['en', 'en_GB', 'zh_CN', 'zh_TW']);

function retainedElectronLocale(entryName) {
  if (!entryName.endsWith('.lproj')) return false;
  const locale = entryName
    .slice(0, -'.lproj'.length)
    .replace(/_(?:FEMININE|MASCULINE|NEUTER)$/, '');
  return electronLocaleFamilies.has(locale);
}

function pruneElectronLocales(appRoot) {
  const localeRoots = [
    join(appRoot, 'Contents', 'Resources'),
    join(
      appRoot,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources',
    ),
  ];
  for (const localeRoot of localeRoots) {
    if (!existsSync(localeRoot)) continue;
    for (const entry of readdirSync(localeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.lproj')) continue;
      if (!retainedElectronLocale(entry.name)) {
        rmSync(join(localeRoot, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function ensureBackendBundle() {
  if (existsSync(backendExecutableSource)) return;
  const python = process.env.PYHFO_BACKEND_PYTHON || process.env.PYTHON || 'python';
  const result = spawnSync(
    python,
    ['-m', 'PyInstaller', '--noconfirm', '--clean', 'pyhfo_backend_macos.spec'],
    { cwd: pyhfoRoot, encoding: 'utf8', stdio: 'pipe' },
  );
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`Unable to build the packaged PyHFO backend with ${python}.${detail ? `\n${detail}` : ''}`);
  }
  if (!existsSync(backendExecutableSource)) {
    fail(`PyInstaller completed without the required backend executable: ${backendExecutableSource}`);
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
}

ensureBackendBundle();

function ensureAgentRuntimeBundle() {
  if (existsSync(agentRuntimeExecutableSource)) return;
  const python = process.env.PYHFO_BACKEND_PYTHON || process.env.PYTHON || 'python';
  const result = spawnSync(
    python,
    ['-m', 'PyInstaller', '--noconfirm', '--clean', 'ieeg_agent_runtime_macos.spec'],
    { cwd: agentRuntimeRoot, encoding: 'utf8', stdio: 'pipe' },
  );
  if (result.error || result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`Unable to build the packaged Agent runtime with ${python}.${detail ? `\n${detail}` : ''}`);
  }
  if (!existsSync(agentRuntimeExecutableSource)) {
    fail(`PyInstaller completed without the required Agent runtime executable: ${agentRuntimeExecutableSource}`);
  }
  if (result.stdout?.trim()) console.log(result.stdout.trim());
}

ensureAgentRuntimeBundle();

if (!electronAppRoot || !existsSync(electronAppRoot)) fail(`Electron.app runtime was not found from executable path: ${electronExecutable}`);
for (const requiredPath of [
  join(desktopRoot, 'dist-electron/main.js'),
  join(desktopRoot, 'dist-electron/preload.cjs'),
  join(desktopRoot, 'dist-renderer/index.html')
]) {
  if (!existsSync(requiredPath)) fail(`Missing production build output: ${requiredPath}. Run npm run build first.`);
}

rmSync(outputApp, { recursive: true, force: true });
mkdirSync(dirname(outputApp), { recursive: true });
cpSync(electronAppRoot, outputApp, { recursive: true, verbatimSymlinks: true });

const originalExecutable = join(outputApp, 'Contents/MacOS/Electron');
const packagedExecutable = join(outputApp, 'Contents/MacOS/iEEG');
if (!existsSync(originalExecutable)) fail(`Copied Electron runtime is missing its main executable: ${originalExecutable}`);
renameSync(originalExecutable, packagedExecutable);
rmSync(join(outputApp, 'Contents/Resources/default_app.asar'), { force: true });

const resourcesApp = join(outputApp, 'Contents/Resources/app');
rmSync(resourcesApp, { recursive: true, force: true });
mkdirSync(resourcesApp, { recursive: true });
cpSync(join(desktopRoot, 'dist-electron'), join(resourcesApp, 'dist-electron'), { recursive: true });
cpSync(join(desktopRoot, 'dist-renderer'), join(resourcesApp, 'dist-renderer'), { recursive: true });
const resourcesBackend = join(outputApp, 'Contents/Resources/backend/pyhfo-backend');
rmSync(resourcesBackend, { recursive: true, force: true });
mkdirSync(dirname(resourcesBackend), { recursive: true });
cpSync(backendBundleSourceRoot, resourcesBackend, { recursive: true, verbatimSymlinks: true });
chmodSync(join(resourcesBackend, 'pyhfo-backend'), 0o755);
const resourcesAgentRuntime = join(outputApp, 'Contents/Resources/backend/agent-runtime');
rmSync(resourcesAgentRuntime, { recursive: true, force: true });
mkdirSync(dirname(resourcesAgentRuntime), { recursive: true });
cpSync(agentRuntimeBundleSourceRoot, resourcesAgentRuntime, { recursive: true, verbatimSymlinks: true });
chmodSync(join(resourcesAgentRuntime, 'ieeg-agent-runtime'), 0o755);
writeFileSync(join(resourcesApp, 'package.json'), JSON.stringify({
  name: 'ieeg-electron-desktop',
  version: appVersion,
  type: 'module',
  main: 'dist-electron/main.js',
  description: 'Packaged iEEG Electron parity smoke app assembled from production build outputs.'
}, null, 2));
writeFileSync(
  join(resourcesApp, 'PACKAGED_FROM.txt'),
  `repo=${repoRoot}\nbuild=dist-electron + dist-renderer\nbackend=${backendBundleSourceRoot}\nagent_runtime=${agentRuntimeBundleSourceRoot}\n`,
);

if (process.platform === 'darwin') {
  for (const [key, value] of [
    ['CFBundleExecutable', 'iEEG'],
    ['CFBundleDisplayName', 'iEEG Workstation'],
    ['CFBundleName', 'iEEG'],
    ['CFBundleIdentifier', 'org.pyhfo.ieeg-workstation'],
    ['CFBundleShortVersionString', appVersion],
    ['CFBundleVersion', appVersion],
  ]) {
    const result = spawnSync('/usr/bin/plutil', ['-replace', key, '-string', value, join(outputApp, 'Contents/Info.plist')], { encoding: 'utf8' });
    if (result.error || result.status !== 0) fail(`Unable to update ${key} in the packaged app metadata: ${result.stderr || result.error || 'unknown error'}`);
  }
  const integrityResult = spawnSync('/usr/bin/plutil', ['-remove', 'ElectronAsarIntegrity', join(outputApp, 'Contents/Info.plist')], { encoding: 'utf8' });
  if (integrityResult.error || integrityResult.status !== 0) fail(`Unable to remove the Electron default-app integrity metadata: ${integrityResult.stderr || integrityResult.error || 'unknown error'}`);
  pruneElectronLocales(outputApp);
  const xattrResult = spawnSync('/usr/bin/xattr', ['-cr', outputApp], { encoding: 'utf8' });
  if (xattrResult.error || xattrResult.status !== 0) fail(`Unable to clear packaged app extended attributes before signing: ${xattrResult.stderr || xattrResult.error || 'unknown error'}`);
  const signResult = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', outputApp], { encoding: 'utf8' });
  if (signResult.error || signResult.status !== 0) fail(`Unable to ad-hoc sign the packaged app: ${signResult.stderr || signResult.error || 'unknown error'}`);
  const verifyResult = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', outputApp], { encoding: 'utf8' });
  if (verifyResult.error || verifyResult.status !== 0) fail(`Packaged app signature verification failed: ${verifyResult.stderr || verifyResult.error || 'unknown error'}`);
}

console.log(`Packaged macOS Electron app assembled: ${outputApp}`);
console.log(`Electron runtime source: ${electronAppRoot}`);
console.log(`Bundled PyHFO backend: ${resourcesBackend}`);
console.log(`Bundled Agent runtime: ${resourcesAgentRuntime}`);
