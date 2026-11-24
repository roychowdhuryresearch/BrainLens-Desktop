#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = join(desktopRoot, 'artifacts');
const outputPath = join(artifactsDir, 'product-interaction-audit.json');

function walk(dir, predicate, files = []) {
  for (const entry of readDirSafe(dir)) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-electron' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, files);
    else if (predicate(path)) files.push(path);
  }
  return files;
}

function readDirSafe(dir) {
  try {
    return existsSync(dir) ? readdirWithTypes(dir) : [];
  } catch {
    return [];
  }
}

function readdirWithTypes(dir) {
  return readdirSync(dir, { withFileTypes: true });
}

async function main() {
  const sourceFiles = [
    ...walk(join(desktopRoot, 'src'), (path) => /\.(tsx?|jsx?)$/.test(path)),
    ...walk(join(desktopRoot, 'electron'), (path) => /\.(tsx?|cts|mts|jsx?)$/.test(path))
  ];
  const evidenceFiles = [
    ...walk(join(desktopRoot, 'tests'), (path) => /\.(mjs|js|ts|tsx)$/.test(path)),
    ...walk(join(desktopRoot, 'scripts'), (path) => /\.(mjs|js|py|ts|tsx)$/.test(path))
  ];

  const evidenceText = evidenceFiles.map(readText).join('\n');
  const sourceTextByFile = sourceFiles.map((path) => ({ path, text: readText(path) }));
  const uiTestIds = collectStaticTestIds(sourceTextByFile);
  const eventHandlers = collectEventHandlers(sourceTextByFile);
  const mainText = readText(join(desktopRoot, 'electron/main.ts'));
  const preloadText = readText(join(desktopRoot, 'electron/preload.cts'));
  const clientText = readText(join(desktopRoot, 'src/api/backendClient.ts'));
  const mainIpcChannels = unique([...mainText.matchAll(/ipcMain\.handle\(['"]([^'"]+)/g)].map((match) => match[1]));
  const preloadIpcChannels = unique([...preloadText.matchAll(/ipcRenderer\.invoke\(['"]([^'"]+)/g)].map((match) => match[1]));
  const backendClientMethods = unique([...clientText.matchAll(/^\s+([a-zA-Z0-9_]+):\s*\(/gm)].map((match) => match[1]));
  const backendEndpoints = unique([...mainText.matchAll(/backendFetch\((?:`([^`]+)`|'([^']+)'|"([^"]+)")/g)].map((match) => match[1] || match[2] || match[3]));

  const missingMainHandlers = preloadIpcChannels.filter((channel) => !mainIpcChannels.includes(channel));
  const missingPreloadExposure = mainIpcChannels.filter((channel) => !preloadIpcChannels.includes(channel));
  const unreferencedTestIds = uiTestIds.filter(({ id }) => !evidenceText.includes(id));

  const buttonAudit = readJson(join(artifactsDir, 'button-parity-audit.json'));
  const electronE2e = readJson(join(artifactsDir, 'electron-e2e-smoke.json'));
  const realRecording = readJson(join(artifactsDir, 'electron-real-recording-smoke.json'));

  const productAreas = [
    productArea('shell_navigation_layout', 'surface', [
      'layout smoke',
      'geometry audit',
      e2eSummary(electronE2e)
    ], 'Main shell, workflow tabs, modal visibility, safe non-mutating clicks.'),
    productArea('native_dialogs_project_session_exports', 'gap', [
      'source-contract coverage',
      'safe-click audits intentionally skip native file/export/session/project actions'
    ], 'Needs behavior coverage for open/save/cancel/error paths with mocked native dialogs.'),
    productArea('backend_ipc_bridge', missingMainHandlers.length || missingPreloadExposure.length ? 'fail' : 'covered', [
      `${preloadIpcChannels.length} preload invoke channels`,
      `${mainIpcChannels.length} main IPC handlers`,
      `${backendEndpoints.length} backend endpoints routed from Electron main`
    ], 'Static bridge consistency is checked; runtime failure modes still need per-endpoint assertions.'),
    productArea('real_recording_pipeline', realRecording?.status === 'passed' ? 'covered' : 'gap', [
      realRecordingSummary(realRecording)
    ], 'Covers one real fixture pipeline, not all UI controls or failure branches.'),
    productArea('waveform_interaction_matrix', 'partial', [
      'pure batching/stale-response tests',
      'real smoke waveform request',
      'large-channel and derived-mode matrix still needs runtime coverage'
    ], 'Needs renderer-to-backend tests for channel cap, avg-ref, bipolar, filtering, and partial failure.'),
    productArea('close_save_discard_lifecycle', 'partial', [
      'close guard unit tests',
      'Electron dialog behavior still needs mocked close-event integration'
    ], 'Save pending, discard, timeout, save failure, and repeated close must stay explicitly covered.'),
    productArea('agent_batch_artifact_side_effects', 'gap', [
      'policy/pure tests and source contracts',
      'end-to-end backend side effects are mostly skipped by safe-click smoke'
    ], 'Needs behavior coverage for batch create/run, artifact open/reveal, agent chat, and recovery.')
  ];

  const warnings = [
    `${unreferencedTestIds.length} static data-testid values are not referenced by tests/scripts.`,
    skippedSummary('button audit', buttonAudit?.summary?.skipped_disabled_or_external_buttons),
    skippedSummary('electron e2e', electronE2e?.summary?.skipped_disabled_native_or_backend_buttons),
    'Green smoke tests do not prove every product interaction has semantic assertions.'
  ].filter(Boolean);

  const failures = [
    ...missingMainHandlers.map((channel) => `preload invokes ${channel} but Electron main does not handle it`),
    ...missingPreloadExposure.map((channel) => `Electron main handles ${channel} but preload does not expose it`)
  ];

  for (const [name, audit] of [['button-parity-audit', buttonAudit], ['electron-e2e-smoke', electronE2e], ['electron-real-recording-smoke', realRecording]]) {
    if (audit && audit.status !== 'passed') failures.push(`${name} artifact status is ${audit.status}`);
  }

  const report = {
    status: failures.length ? 'failed' : 'passed',
    generated_at: new Date().toISOString(),
    totals: {
      source_files: sourceFiles.length,
      evidence_files: evidenceFiles.length,
      static_data_testids: uiTestIds.length,
      static_data_testids_unreferenced_by_tests_or_scripts: unreferencedTestIds.length,
      react_event_handler_props: eventHandlers.length,
      preload_ipc_invokes: preloadIpcChannels.length,
      main_ipc_handlers: mainIpcChannels.length,
      backend_client_methods: backendClientMethods.length,
      backend_endpoints_routed_from_main: backendEndpoints.length
    },
    bridge_contract: {
      missing_main_handlers: missingMainHandlers,
      missing_preload_exposure: missingPreloadExposure
    },
    smoke_evidence: {
      button_audit: summaryOrMissing(buttonAudit),
      electron_e2e: summaryOrMissing(electronE2e),
      electron_real_recording: summaryOrMissing(realRecording)
    },
    unreferenced_testids_by_file: summarizeUnreferencedTestIds(unreferencedTestIds),
    product_areas: productAreas,
    warnings,
    failures
  };

  mkdirSync(artifactsDir, { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    status: report.status,
    summary: report.totals,
    product_area_statuses: Object.fromEntries(productAreas.map((area) => [area.id, area.status])),
    warnings,
    report: outputPath,
    failures
  }, null, 2));
  if (failures.length) process.exitCode = 1;
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectStaticTestIds(sourceTextByFile) {
  const testIds = [];
  for (const { path, text } of sourceTextByFile) {
    for (const match of text.matchAll(/data-testid=\{?['"`]([^'"`}$]+)['"`]/g)) {
      testIds.push({ id: match[1], file: relative(desktopRoot, path) });
    }
  }
  return testIds;
}

function collectEventHandlers(sourceTextByFile) {
  const handlers = [];
  for (const { path, text } of sourceTextByFile) {
    for (const match of text.matchAll(/\bon([A-Z][A-Za-z]+)=/g)) {
      handlers.push({ handler: `on${match[1]}`, file: relative(desktopRoot, path) });
    }
  }
  return handlers;
}

function summarizeUnreferencedTestIds(unreferenced) {
  const grouped = new Map();
  for (const item of unreferenced) {
    const group = grouped.get(item.file) || [];
    group.push(item.id);
    grouped.set(item.file, group);
  }
  return [...grouped.entries()].map(([file, ids]) => ({ file, count: ids.length, sample: ids.slice(0, 10) }));
}

function summaryOrMissing(report) {
  return report ? { status: report.status, summary: report.summary || null } : { status: 'missing', summary: null };
}

function e2eSummary(report) {
  if (!report?.summary) return 'Electron e2e artifact missing';
  return `${report.summary.clicked_safe_buttons || 0} safe clicks, ${report.summary.skipped_disabled_native_or_backend_buttons || 0} skipped native/backend buttons`;
}

function realRecordingSummary(report) {
  if (!report?.summary) return 'real-recording artifact missing';
  return `${report.summary.channel_count || 0} channels, ${report.summary.detection_events || 0} detection events, ${report.summary.classified_events || 0} classified events`;
}

function skippedSummary(label, value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? `${label} skipped ${value} interactions.` : '';
}

function productArea(id, status, evidence, note) {
  return { id, status, evidence, note };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
