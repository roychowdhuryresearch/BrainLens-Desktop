#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = normalize(join(dirname(fileURLToPath(import.meta.url)), '..'));
const outputPath = join(desktopRoot, 'artifacts/layout-smoke.json');
const files = {
  css: join(desktopRoot, 'src/styles/workspace.css'),
  shell: join(desktopRoot, 'src/app/MainWindowShell.tsx'),
  topToolbar: join(desktopRoot, 'src/features/shell/TopToolbar.tsx'),
  biomarkerBar: join(desktopRoot, 'src/features/shell/BiomarkerBar.tsx'),
  workspaceTabs: join(desktopRoot, 'src/features/shell/WorkspaceTabs.tsx'),
  waveformToolbar: join(desktopRoot, 'src/features/shell/WaveformToolbar.tsx'),
  detector: join(desktopRoot, 'src/features/shell/DetectorForms.tsx'),
  classifier: join(desktopRoot, 'src/features/shell/ClassifierTab.tsx'),
  review: join(desktopRoot, 'src/features/shell/EventReviewDialog.tsx'),
  runStats: join(desktopRoot, 'src/features/shell/RunStatisticsDialog.tsx'),
  agentPanel: join(desktopRoot, 'src/features/agent/AgentPanel.tsx'),
  agentActivity: join(desktopRoot, 'src/features/agent/AgentActivityBar.tsx'),
  viteIndex: join(desktopRoot, 'index.html'),
  distIndex: join(desktopRoot, 'dist-renderer/index.html')
};

function read(path) {
  if (path.endsWith('.css')) return readCssWithImports(path);
  return readFileSync(path, 'utf8');
}

function readCssWithImports(path, seen = new Set()) {
  if (seen.has(path)) return '';
  seen.add(path);
  const source = readFileSync(path, 'utf8');
  return source.replace(/@import\s+(?:url\()?['"]([^'")]+)['"]\)?\s*;/g, (statement, specifier) => {
    const importedPath = join(dirname(path), specifier);
    return `${statement}\n${readCssWithImports(importedPath, seen)}`;
  });
}

function requireFile(label, path, failures) {
  if (!existsSync(path)) failures.push(`Missing ${label}: ${path}`);
}

const failures = [];
for (const [label, path] of Object.entries(files)) requireFile(label, path, failures);

const css = existsSync(files.css) ? read(files.css) : '';
const sourceBundle = Object.values(files).filter((path) => existsSync(path) && path.endsWith('.tsx')).map(read).join('\n');
const shell = existsSync(files.shell) ? read(files.shell) : '';
const dist = existsSync(files.distIndex) ? read(files.distIndex) : '';

const layoutContracts = [
  { name: 'viewport-bound main window', evidence: ['.pyqt-main-window', 'inline-size:100vw', 'block-size:100vh', 'overflow:hidden'] },
  { name: 'fixed left workspace with right docked agent rail', evidence: ['--agent-rail-width:48px', '--agent-panel-width:336px', 'grid-template-columns:minmax(0,1fr) var(--agent-rail-width) var(--agent-effective-panel-width)!important', 'max-inline-size:calc(100vw - var(--agent-rail-width))'] },
  { name: 'workspace shell fixed rows', evidence: ['.pyqt-workspace-shell', 'grid-template-rows:48px 44px 58px 96px minmax(0,1fr) 32px'] },
  { name: 'waveform/workflow splitter', evidence: ['.loaded-workspace-splitter-handle', 'cursor:col-resize', '--workspace-waveform-percent'] },
  { name: 'internal tab scrolling', evidence: ['.workspace-tabs .tab-content', 'overflow:auto', 'overscroll-behavior:contain'] },
  { name: 'annotation left fixed scroll pane', evidence: ['Event Review main layout owner', '.event-review-body', 'grid-template-columns:minmax(640px,1.25fr) minmax(390px,.75fr)!important', '.event-review-left-panel', 'overflow:hidden!important', 'contain:layout paint!important'] },
  { name: 'prepare workbench scroll', evidence: ['Prepare workbench scroll owner', '.workspace-tab-panel[data-active-tab="Prepare"]>.prepare-grid', 'grid-auto-rows:min-content!important', 'overflow:auto!important', 'grid-template-columns:minmax(0,1fr)!important', '.case-console-workspace'] },
  { name: 'VS Code-like agent activity bar', evidence: ['.agent-activity-bar', '.agent-panel', 'agent-panel-resize-handle'] }
];

for (const contract of layoutContracts) {
  for (const phrase of contract.evidence) {
    if (!css.includes(phrase) && !shell.includes(phrase)) failures.push(`Layout contract missing (${contract.name}): ${phrase}`);
  }
}

const requiredTestIds = [
  'pyqt-toolBar',
  'pyqt-biomarker_selection_widget',
  'pyqt-workflowHeader',
  'pyqt-waveform-toolbar',
  'pyqt-waveformWiget',
  'pyqt-tabWidget',
  'workflow-tab-${tab.toLowerCase()}',
  'pyqt-detector_subtabs',
  'pyqt-classifier_mode_combo',
  'pyqt-run_stats_run_table',
  'pyqt-sidebar_run_actions_card',
  'pyqt-annotation_window',
  'pyqt-AnnotationPlot',
  'pyqt-FFT_layout',
  'agent-activity-bar',
  'agent-panel'
];

for (const testId of requiredTestIds) {
  if (!sourceBundle.includes(testId)) failures.push(`Required rendered test id missing: ${testId}`);
}

const shellContracts = [
  "useState(false)",
  'data-agent-open={agentOpen ? \'true\' : \'false\'}',
  'AgentActivityBar',
  'AgentPanel',
  'agentOpen && <AgentPanel',
  'beginAgentPanelResize',
  'beginWorkspaceSplitResize',
  'localStorage.setItem(AGENT_PANEL_WIDTH_STORAGE_KEY',
  'localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY'
];
for (const phrase of shellContracts) {
  if (!shell.includes(phrase)) failures.push(`Shell layout/state contract missing: ${phrase}`);
}

const distContracts = ['<div id="root"></div>', '/assets/index-'];
for (const phrase of distContracts) {
  if (!dist.includes(phrase)) failures.push(`Built renderer index missing: ${phrase}`);
}

const report = {
  generated_at: new Date().toISOString(),
  checked_files: Object.fromEntries(Object.entries(files).map(([key, path]) => [key, existsSync(path)])),
  layout_contracts: layoutContracts.map((contract) => contract.name),
  required_test_ids: requiredTestIds,
  shell_contracts: shellContracts,
  failures,
  limitation: 'Static renderer layout smoke: verifies production bundle and layout/test-id contracts without a clinical recording fixture or pixel comparator.'
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);

if (failures.length) {
  console.error(`Layout smoke failed with ${failures.length} issue(s).`);
  for (const failure of failures) console.error(`- ${failure}`);
  console.error(`Report: ${outputPath}`);
  process.exit(1);
}

console.log(`Layout smoke passed: ${layoutContracts.length} layout contracts, ${requiredTestIds.length} rendered test ids.`);
console.log(`Report: ${outputPath}`);
