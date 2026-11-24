import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

function readCssWithImports(path, seen = new Set()) {
  if (seen.has(path)) return '';
  seen.add(path);
  const source = readFileSync(path, 'utf8');
  return source.replace(/@import\s+(?:url\()?['"]([^'")]+)['"]\)?\s*;/g, (statement, specifier) => {
    const importedPath = join(dirname(path), specifier);
    return `${statement}\n${readCssWithImports(importedPath, seen)}`;
  });
}

const read = (p) => {
  const path = join(root, p);
  if (p === 'src/styles/workspace.css') return readCssWithImports(path);
  return readFileSync(path, 'utf8');
};

test('package exposes development, build, typecheck, and test scripts', () => {
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['dev', 'electron', 'build', 'typecheck', 'test', 'qa:layout', 'qa:geometry', 'qa:buttons', 'qa:electron-e2e', 'qa:electron-real-recording', 'qa:interactions', 'qa:real-fixture', 'qa:packaged', 'qa:hf-onnx-runtime', 'qa:signoff', 'qa:production-parity', 'package:mac-smoke']) assert.ok(pkg.scripts[script]);
  assert.equal(pkg.scripts['qa:layout'], 'node scripts/layout-smoke.mjs');
  assert.equal(pkg.scripts['qa:geometry'], 'node scripts/ui-geometry-audit.mjs');
  assert.equal(pkg.scripts['qa:buttons'], 'python scripts/button-parity-audit.py');
  assert.equal(pkg.scripts['qa:electron-e2e'], 'node scripts/electron-e2e-smoke.mjs');
  assert.equal(pkg.scripts['qa:electron-real-recording'], 'node scripts/electron-real-recording-smoke.mjs');
  assert.equal(pkg.scripts['qa:interactions'], 'node scripts/product-interaction-audit.mjs');
  assert.equal(pkg.scripts['qa:real-fixture'], 'node scripts/real-fixture-smoke.mjs');
  assert.equal(pkg.scripts['qa:packaged'], 'node scripts/packaged-electron-smoke.mjs');
  assert.equal(pkg.scripts['qa:hf-onnx-runtime'], 'node scripts/hf-onnx-runtime-smoke.mjs');
  assert.equal(pkg.scripts['qa:signoff'], 'node scripts/production-signoff-audit.mjs');
  assert.ok(pkg.scripts['package:mac-smoke'].includes('scripts/package-macos-app.mjs'));
  assert.ok(pkg.scripts['package:mac-smoke'].includes('PYHFO_PARITY_ELECTRON_APP=artifacts/packaged/iEEG.app'));
  for (const phrase of ['npm run typecheck', 'npm run build', 'npm run qa:layout', 'npm run qa:geometry', 'npm run qa:buttons', 'npm run qa:electron-e2e', 'npm run qa:electron-real-recording', 'npm run qa:interactions', 'npm test -- --runInBand', 'test_electron_parity_fixture_smoke.py']) assert.ok(pkg.scripts['qa:production-parity'].includes(phrase), phrase);
});

test('geometry audit gate detects UI overlap, control sizing, and cross-page layout drift', () => {
  const script = read('scripts/ui-geometry-audit.mjs');
  for (const phrase of [
    'getBoundingClientRect',
    'visual-overlap',
    'too-small-control',
    'oversized-classifier-action-button',
    'CLASSIFIER_ACTION_BUTTON_LIMITS',
    'oversized-workflow-field',
    'WORKFLOW_FIELD_WIDTH_LIMITS',
    'button-text-overflow',
    'document-overflow-x',
    'tight-control-gap',
    'height-inconsistency',
    'font-size-inconsistency',
    'cross-page-layout-drift',
    'auditLayoutConsistency',
    'primary workflow shell',
    'workflow subpages',
    'pyqt-header_prepare_button',
    'pyqt-header_detect_button',
    'pyqt-header_classify_button',
    'pyqt-classifier_run_button',
    'pyqt-default_cpu_button',
    'pyqt-default_gpu_button',
    'pyqt-classifier_save_button',
	    'pyqt-detector_mode_combo',
	    'pyqt-classifier_mode_combo',
	    'pyqt-overview_ignore_before_input',
	    'pyqt-overview_ignore_after_input',
	    'pyqt-tabWidget',
	    'UI_GEOMETRY_VIEWPORTS',
	    'minimum-main',
	    'ui-geometry-audit.json',
	    'ui-geometry-audit',
	    'index.html',
	    'screenshots',
	    'rmSync(screenshotsDir'
	  ]) assert.ok(script.includes(phrase), phrase);
	});

test('desktop minimum window contract is shared by Electron and geometry QA', () => {
  const main = read('electron/main.ts');
  const script = read('scripts/ui-geometry-audit.mjs');
  const harness = read('scripts/lib/ui-audit-harness.mjs');
  for (const phrase of ['MAIN_WINDOW_MIN_WIDTH = 1440', 'MAIN_WINDOW_MIN_HEIGHT = 860', 'minWidth: MAIN_WINDOW_MIN_WIDTH', 'minHeight: MAIN_WINDOW_MIN_HEIGHT']) assert.ok(main.includes(phrase), phrase);
  for (const source of [script, harness]) {
    for (const phrase of ['MIN_VIEWPORT_WIDTH = 1440', 'MIN_VIEWPORT_HEIGHT = 860', "name: 'minimum-main'", 'width: 1440', 'height: 860', 'below Electron minimum window size']) assert.ok(source.includes(phrase), phrase);
  }
});

test('shared UI audit viewport parser rejects unreachable Electron sizes', async () => {
  const { DEFAULT_VIEWPORTS, MIN_VIEWPORT_WIDTH, MIN_VIEWPORT_HEIGHT, parseViewports } = await import(new URL('../scripts/lib/ui-audit-harness.mjs', import.meta.url));
  assert.equal(MIN_VIEWPORT_WIDTH, 1440);
  assert.equal(MIN_VIEWPORT_HEIGHT, 860);
  assert.ok(DEFAULT_VIEWPORTS.every((viewport) => viewport.width >= MIN_VIEWPORT_WIDTH && viewport.height >= MIN_VIEWPORT_HEIGHT));
  assert.deepEqual(parseViewports('minimum-main:1440x860'), [{ name: 'minimum-main', width: 1440, height: 860 }]);
  assert.throws(() => parseViewports('impossible:801x900'), /below Electron minimum window size/);
  assert.throws(() => parseViewports('too-short:1440x859'), /below Electron minimum window size/);
});

test('workspace visual architecture keeps cleanup owners split by surface', () => {
  const workspaceEntry = readFileSync(join(root, 'src/styles/workspace.css'), 'utf8');
  const foundation = read('src/styles/workspace/00-foundation-reset.css');
  const sharedTheme = read('src/styles/workspace/shared-clinical-theme.css');
  const sharedControlTheme = read('src/styles/workspace/shared-control-theme.css');
  const sharedWorkflowSurfaceTheme = read('src/styles/workspace/shared-workflow-surface-theme.css');
  const sharedRuntimeTheme = read('src/styles/workspace/shared-runtime-feedback-theme.css');
  const waveformChrome = read('src/styles/workspace/waveform-chrome.css');
  const modalChrome = read('src/styles/workspace/modal-chrome.css');
  const shellStructural = read('src/styles/workspace/shell-structure.css');
  const topToolbar = read('src/styles/workspace/top-toolbar.css');
  const topToolbarMenu = read('src/styles/workspace/top-toolbar-menu.css');
  const topToolbarActions = read('src/styles/workspace/top-toolbar-actions.css');
  const topToolbarSurface = [topToolbar, topToolbarMenu, topToolbarActions].join('\n');
  const workspaceShellChrome = read('src/styles/workspace/workspace-shell-chrome.css');
  const waveformHeaderChrome = read('src/styles/workspace/waveform-header-chrome.css');
  const statusStripLayout = read('src/styles/workspace/status-strip-layout.css');
  const workspaceTabsChrome = read('src/styles/workspace/workspace-tabs-chrome.css');
  const recentRecordingsCard = read('src/styles/workspace/recent-recordings-card.css');
  const shellChromeSurface = [workspaceShellChrome, waveformHeaderChrome, statusStripLayout, workspaceTabsChrome, recentRecordingsCard].join('\n');
  const workflowCards = read('src/styles/workspace/workflow-card-visuals.css');
  const agentPanel = read('src/styles/workspace/agent-panel.css');
  const agentRuntimeContent = read('src/styles/workspace/agent-runtime-content.css');
  const agentArtifactsCommands = read('src/styles/workspace/agent-artifacts-commands.css');
  const agentActivityBar = read('src/styles/workspace/agent-activity-bar.css');
  const agentVisualChrome = read('src/styles/workspace/agent-visual-chrome.css');
  const agentResponsive = read('src/styles/workspace/agent-responsive.css');
  const density = read('src/styles/workspace/main-window-density.css');
  const waveformNavigation = read('src/styles/workspace/waveform-navigation.css');
  const waveformToolbarLayout = read('src/styles/workspace/waveform-toolbar-layout.css');
  const waveformToolbarControls = read('src/styles/workspace/waveform-toolbar-controls.css');
  const waveformToolbarPopovers = read('src/styles/workspace/waveform-toolbar-popovers.css');
  const waveformToolbarResponsive = read('src/styles/workspace/waveform-toolbar-responsive.css');
  const waveformToolbar = [waveformToolbarLayout, waveformToolbarControls, waveformToolbarPopovers, waveformToolbarResponsive].join('\n');
  const annotation = read('src/styles/workspace/annotation-controls.css');
  const workflowExpanded = read('src/styles/workspace/workflow-expanded-layout.css');
  const classify = read('src/styles/workspace/classify-workbench.css');
  const classifyExecution = read('src/styles/workspace/classify-execution-card.css');
  const classifySource = read('src/styles/workspace/classify-source-card.css');
  const classifyResponsive = read('src/styles/workspace/classify-responsive.css');
  const classifyControls = read('src/styles/workspace/classify-controls.css');
  const classifyStack = read('src/styles/workspace/classify-stack.css');
  const classifySurface = [classify, classifyExecution, classifySource, classifyResponsive, classifyControls, classifyStack].join('\n');
  const batchProject = read('src/styles/workspace/batch-project-dialog.css');
  const recordingInfoDialog = read('src/styles/workspace/recording-info-dialog.css');
  const runtimeLogDialog = read('src/styles/workspace/runtime-log-dialog.css');
  const runStatisticsDialog = read('src/styles/workspace/run-statistics-dialog.css');
  const waveformShortcutsDialog = read('src/styles/workspace/waveform-shortcuts-dialog.css');
  const loadDetectionDialog = read('src/styles/workspace/load-detection-dialog.css');
  const reviewRail = read('src/styles/workspace/review-rail.css');
  const reviewRailCardChrome = read('src/styles/workspace/review-rail-card-chrome.css');
  const reviewRailControls = read('src/styles/workspace/review-rail-controls.css');
  const reviewRailDetectionParams = read('src/styles/workspace/review-rail-detection-params.css');
  const reviewRailLoadedDensity = read('src/styles/workspace/review-rail-loaded-density.css');
  const reviewRailResponsive = read('src/styles/workspace/review-rail-responsive.css');
  const reviewRailSurface = [reviewRail, reviewRailCardChrome, reviewRailControls, reviewRailDetectionParams, reviewRailLoadedDensity, reviewRailResponsive].join('\n');
  const detectWorkbench = read('src/styles/workspace/detect-workbench.css');
  const detectModeControls = read('src/styles/workspace/detect-mode-controls.css');
  const detectParameterForm = read('src/styles/workspace/detect-parameter-form.css');
  const detectAppliedDisplay = read('src/styles/workspace/detect-applied-display.css');
  const detectResponsive = read('src/styles/workspace/detect-responsive.css');
  const detectSurface = [detectWorkbench, detectModeControls, detectParameterForm, detectAppliedDisplay, detectResponsive].join('\n');
  const prepareWorkbench = read('src/styles/workspace/prepare-workbench.css');
  const prepareSectionChrome = read('src/styles/workspace/prepare-section-chrome.css');
  const prepareCaseConsole = read('src/styles/workspace/prepare-case-console.css');
  const prepareOutputRuntime = read('src/styles/workspace/prepare-output-runtime.css');
  const prepareAnalysis = read('src/styles/workspace/prepare-analysis.css');
  const prepareAnalysisPanel = read('src/styles/workspace/prepare-analysis-panel.css');
  const prepareAnalysisSummary = read('src/styles/workspace/prepare-analysis-summary.css');
  const prepareAnalysisSpectral = read('src/styles/workspace/prepare-analysis-spectral.css');
  const prepareAnalysisRoi = read('src/styles/workspace/prepare-analysis-roi.css');
  const prepareAnalysisResponsive = read('src/styles/workspace/prepare-analysis-responsive.css');
  const prepareAnalysisSurface = [prepareAnalysis, prepareAnalysisPanel, prepareAnalysisSummary, prepareAnalysisSpectral, prepareAnalysisRoi, prepareAnalysisResponsive].join('\n');
  const prepareControls = read('src/styles/workspace/prepare-controls.css');
  const prepareFilterFields = read('src/styles/workspace/prepare-filter-fields.css');
  const prepareFilterActions = read('src/styles/workspace/prepare-filter-actions.css');
  const prepareControlsResponsive = read('src/styles/workspace/prepare-controls-responsive.css');
  const prepareControlSurface = [prepareControls, prepareFilterFields, prepareFilterActions, prepareControlsResponsive].join('\n');
  const quickDetection = read('src/styles/workspace/quick-detection-shell.css');
  const quickDetectionGridRails = read('src/styles/workspace/quick-detection-layout.css');
  const quickDetectionFields = read('src/styles/workspace/quick-detection-fields.css');
  const quickDetectionClassifierExport = read('src/styles/workspace/quick-detection-classifier-export.css');
  const quickDetectionFooterResponsive = read('src/styles/workspace/quick-detection-footer-responsive.css');
  const channelModal = read('src/styles/workspace/channel-modal.css');
  const eventReviewDetail = read('src/styles/workspace/event-review-detail.css');
  const eventReviewSideStack = read('src/styles/workspace/event-review-side-stack.css');
  const eventReviewViewControls = read('src/styles/workspace/event-review-view-controls.css');
  const eventReviewResponsive = read('src/styles/workspace/event-review-responsive.css');
  const eventReviewControls = read('src/styles/workspace/event-review-controls.css');
  const eventReviewProgressFlow = read('src/styles/workspace/event-review-progress-flow.css');
  const eventReviewRightColumnFlow = read('src/styles/workspace/event-review-right-column-flow.css');
  const eventReviewNavigationControls = read('src/styles/workspace/event-review-navigation-controls.css');
  const eventReviewPredictionControls = read('src/styles/workspace/event-review-prediction-controls.css');
  const eventReviewFrequencyControls = read('src/styles/workspace/event-review-frequency-controls.css');
  const eventReviewDetailActions = read('src/styles/workspace/event-review-detail-actions.css');
  const controlSizing = read('src/styles/workspace/shared-control-sizing.css');
  const waveformPaneOverview = read('src/styles/workspace/waveform-overview.css');
  const legacyAgentPanelSelectors = /agent-activity-bar|agent-panel(?!-width)|agent-message|agent-command|agent-artifact|agent-chat|agent-composer|agent-current-operation|agent-action|intent-preview|activity-label|activity-icon|agent-tab-content|agent-panel-resize/;
  const batchProjectSelectors = /batch-project|batch-summary-card|batch-cases-card|pyqt-batch_/;
  const recordingInfoDialogSelectors = /recording-info-dialog|recording-info-header|recording-info-channel-card|recording-info-channel-list|recording-info-raw-card|pyqt-recording_info_button/;
  const runtimeLogDialogSelectors = /runtime-log-dialog|runtime-log-header|runtime-log-summary|runtime-log-toolbar|runtime-log-table-shell|runtime-log-table|runtime-backend-health|runtime-backend-log-shell|runtime-ui-log-shell|pyqt-runtime_log_cancel_button/;
  const runStatisticsDialogSelectors = /run-statistics-dialog|run-statistics-body|run-statistics-management|pyqt-run_stats_action_row|pyqt-run_stats_close_button/;
  const waveformShortcutsDialogSelectors = /waveform-shortcuts-dialog|shortcut-trackpad-card|shortcut-scroll|shortcut-grid|shortcut-actions|pyqt-waveform_shortcut_/;
  const loadDetectionDialogSelectors = /load-detection-dialog|session-load-row|pyqt-load_detection_/;
  const quickDetectionSelectors = /quick-detection-backdrop|quick-detection-dialog|quick-detection-grid|quick-detection-header|quick-detection-left-rail|quick-detection-main-column|quick-detection-right-rail|quick-detection-action-strip|quick-detection-action-rail|quick-detection-status-card|quick-detection-metadata-grid|quick-detector-panel|quick-detector-heading|quick-detector-field|quick-filter-grid|quick-filter-field|quick-classifier-param-grid|quick-classifier-actions|quick-classifier-model-grid|quick-model-row|quick-classifier-run-toggle|quick-detection-export-options|pyqt-qd_|pyqt-quick_detection/;
  const legacyPrepareFoundationBlocks = /Final geometry recovery must remain last|Audit-specific final tuning|Geometry recovery: fixed PyQt-equivalent panes|Prepare preprocessing strategy|PyQt Overview statistics box|Recording ROI\/QC\/Spectral planning parity|PyQt Case Console parity|Right-panel cramming fix/;
  const legacyPrepareFoundationSelectors = /workspace-tab-panel\[data-active-tab="Prepare"\] \.(?:filter-parameter-panel|prepare-control-cluster|prepare-toggle-grid|runtime-control-row|roi-exclusion-editor)|recording-planning-panel|recording-analysis-grid|roi-channel-review|spectral-curve-plot|spectral-band-bars|case-console-workspace|case-console-column/;
  const legacyDetectFoundationBlocks = /PyQt detector display pages|PyQt detector selector\/action header/;
  const legacyDetectFoundationSelectors = /detector-applied-display|detector-display-heading|detector-display-grid|detector-display-cell|detector-mode-header|detector-mode-hint|detector-runtime-warning|detector-form-card button:disabled|detector-mode-header button:disabled/;
  assert.equal(existsSync(join(root, 'src/styles/workspace/130-prepare-product-redesign.css')), false);
  assert.doesNotMatch(workspaceEntry, /130-prepare-product-redesign\.css/);
  assert.equal(existsSync(join(root, 'src/styles/workspace/120-product-geometry-locks.css')), false);
  assert.doesNotMatch(workspaceEntry, /120-product-geometry-locks\.css/);
  assert.equal(existsSync(join(root, 'src/styles/workspace/150-final-visual-architecture.css')), false);
  assert.doesNotMatch(workspaceEntry, /150-final-visual-architecture\.css/);
  for (const retiredFile of [
    '00-foundation-and-early-parity.css',
    '10-agent-and-dialog-polish.css',
    '20-pyqt-visual-parity.css',
    '30-loaded-and-quick-detection.css',
    '50-waveform-toolbar-and-native-controls.css',
    '60-shell-structural-parity.css',
    '70-audited-ui-repair-layer.css',
    '80-react-workbench-normalization.css',
    '90-form-controls-and-toolbar-redesign.css',
    '100-modern-subwindows-and-annotation.css',
    '110-product-workflow-hardening.css',
    '140-clinical-design-refresh.css',
    '150-final-shell-and-prepare-visuals.css',
    '151-final-prepare-toolbar-geometry.css',
    'dialog-clearance.css',
    'prepare-agent-compression.css',
    'shared-workspace-chrome-theme.css',
    'shared-waveform-modal-chrome.css',
    'shared-responsive-typography.css',
    'waveform-toolbar.css',
    '153-final-narrow-viewport-recovery.css',
    '155-final-waveform-contract.css',
    '158-final-workflow-alignment-contract.css',
  ]) {
    assert.equal(existsSync(join(root, `src/styles/workspace/${retiredFile}`)), false, `${retiredFile} is deleted`);
    assert.equal(workspaceEntry.includes(`./workspace/${retiredFile}`), false, `${retiredFile} is not imported`);
  }
  const channelModalSelectors = /channel-dialog|channel-dialog-scroll|channel-choice|selected-channels-dialog|selected-channels-grid|selected-channel-list|compare-channel-scroll|selected-channel-spacer|bipolar-dialog|bipolar-form-card/;
  const eventReviewDialogSelectors = /event-review-dialog|event-review-body|event-review-left-panel|event-review-header|event-review-summary|event-detail-card|event-feature-summary-card|annotation-side-stack|annotation-detail-actions|annotation-view-controls|annotation-plot-card|annotation-hover-readout|annotation-progress-card|annotation-navigation-row|annotation-select-row|prediction-scope-card|annotation-info-card|frequency-controls|event-table|review-svg|fft-heading|pyqt-annotation_window|pyqt-actionStart_Over|pyqt-viewControlsGroupBox|pyqt-frequency_range_group|pyqt-FFT_layout|pyqt-progressCard|pyqt-predictionScopeCard|pyqt-UnannotatedOnlyCheckBox|pyqt-spinBox_minFreq|pyqt-spinBox_maxFreq|pyqt-SetFreqLimit/;
  for (const phrase of [
    'shared-clinical-theme.css',
    'shared-control-theme.css',
    'shared-workflow-surface-theme.css',
    'shared-runtime-feedback-theme.css',
    'waveform-chrome.css',
    'modal-chrome.css',
    'shell-structure.css',
    'top-toolbar.css',
    'top-toolbar-menu.css',
    'top-toolbar-actions.css',
    'workspace-shell-chrome.css',
    'waveform-header-chrome.css',
    'status-strip-layout.css',
    'workspace-tabs-chrome.css',
    'recent-recordings-card.css',
    'workflow-card-visuals.css',
    'main-window-density.css',
    'agent-panel.css',
    'agent-runtime-content.css',
    'agent-artifacts-commands.css',
    'agent-activity-bar.css',
    'agent-visual-chrome.css',
    'agent-responsive.css',
    'waveform-navigation.css',
    'waveform-toolbar-layout.css',
    'waveform-toolbar-controls.css',
    'waveform-toolbar-popovers.css',
    'waveform-toolbar-responsive.css',
    'annotation-controls.css',
    'workflow-expanded-layout.css',
    'review-rail.css',
    'review-rail-card-chrome.css',
    'review-rail-controls.css',
    'review-rail-detection-params.css',
    'review-rail-loaded-density.css',
    'review-rail-responsive.css',
    'detect-workbench.css',
    'detect-mode-controls.css',
    'detect-parameter-form.css',
    'detect-applied-display.css',
    'detect-responsive.css',
    'prepare-workbench.css',
    'prepare-section-chrome.css',
    'prepare-case-console.css',
    'prepare-output-runtime.css',
    'prepare-analysis.css',
    'prepare-analysis-panel.css',
    'prepare-analysis-summary.css',
    'prepare-analysis-spectral.css',
    'prepare-analysis-roi.css',
    'prepare-analysis-responsive.css',
    'prepare-controls.css',
    'prepare-filter-fields.css',
    'prepare-filter-actions.css',
    'prepare-controls-responsive.css',
    'quick-detection-shell.css',
    'quick-detection-layout.css',
    'quick-detection-fields.css',
    'quick-detection-classifier-export.css',
    'quick-detection-footer-responsive.css',
    'channel-modal.css',
    'event-review-detail.css',
    'event-review-side-stack.css',
    'event-review-view-controls.css',
    'event-review-responsive.css',
    'event-review-controls.css',
    'event-review-progress-flow.css',
    'event-review-right-column-flow.css',
    'event-review-navigation-controls.css',
    'event-review-prediction-controls.css',
    'event-review-frequency-controls.css',
    'event-review-detail-actions.css',
    'shared-control-sizing.css',
    'classify-workbench.css',
    'classify-execution-card.css',
    'classify-source-card.css',
    'classify-responsive.css',
    'classify-controls.css',
    'classify-stack.css',
    'batch-project-dialog.css',
    'recording-info-dialog.css',
    'runtime-log-dialog.css',
    'run-statistics-dialog.css',
    'waveform-shortcuts-dialog.css',
    'load-detection-dialog.css',
  ]) {
    assert.ok(workspaceEntry.includes(`./workspace/${phrase}`), `workspace.css imports ${phrase}`);
  }
  assert.ok(workspaceEntry.includes('./workspace/waveform-overview.css'));
  assert.ok(workspaceEntry.includes('./workspace/00-foundation-reset.css'));
  assert.doesNotMatch(workspaceEntry, /40-loaded-right-rail-and-annotation\.css/);
  assert.ok(!existsSync(join(root, 'src/styles/workspace/40-loaded-right-rail-and-annotation.css')));
  assert.ok(workspaceEntry.indexOf('./workspace/shared-clinical-theme.css') < workspaceEntry.indexOf('./workspace/shared-control-theme.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/shared-control-theme.css') < workspaceEntry.indexOf('./workspace/shared-workflow-surface-theme.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/shared-workflow-surface-theme.css') < workspaceEntry.indexOf('./workspace/shared-runtime-feedback-theme.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/shared-runtime-feedback-theme.css') < workspaceEntry.indexOf('./workspace/waveform-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-chrome.css') < workspaceEntry.indexOf('./workspace/modal-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/modal-chrome.css') < workspaceEntry.indexOf('./workspace/top-toolbar.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/top-toolbar.css') < workspaceEntry.indexOf('./workspace/top-toolbar-menu.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/top-toolbar-menu.css') < workspaceEntry.indexOf('./workspace/top-toolbar-actions.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/top-toolbar-actions.css') < workspaceEntry.indexOf('./workspace/workspace-shell-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/workspace-shell-chrome.css') < workspaceEntry.indexOf('./workspace/waveform-header-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-header-chrome.css') < workspaceEntry.indexOf('./workspace/status-strip-layout.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/status-strip-layout.css') < workspaceEntry.indexOf('./workspace/workspace-tabs-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/workspace-tabs-chrome.css') < workspaceEntry.indexOf('./workspace/recent-recordings-card.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/recent-recordings-card.css') < workspaceEntry.indexOf('./workspace/workflow-card-visuals.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/workflow-card-visuals.css') < workspaceEntry.indexOf('./workspace/agent-panel.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/agent-panel.css') < workspaceEntry.indexOf('./workspace/agent-runtime-content.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/agent-runtime-content.css') < workspaceEntry.indexOf('./workspace/agent-artifacts-commands.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/agent-artifacts-commands.css') < workspaceEntry.indexOf('./workspace/agent-activity-bar.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/agent-activity-bar.css') < workspaceEntry.indexOf('./workspace/agent-visual-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/agent-visual-chrome.css') < workspaceEntry.indexOf('./workspace/agent-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-navigation.css') < workspaceEntry.indexOf('./workspace/waveform-toolbar-layout.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-toolbar-layout.css') < workspaceEntry.indexOf('./workspace/waveform-toolbar-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-toolbar-controls.css') < workspaceEntry.indexOf('./workspace/waveform-toolbar-popovers.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-toolbar-popovers.css') < workspaceEntry.indexOf('./workspace/waveform-toolbar-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-toolbar-responsive.css') < workspaceEntry.indexOf('./workspace/annotation-controls.css'));
  assert.doesNotMatch(workspaceEntry, /151-final-prepare-toolbar-geometry\.css/);
  assert.ok(workspaceEntry.indexOf('./workspace/workflow-expanded-layout.css') < workspaceEntry.indexOf('./workspace/review-rail.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/review-rail.css') < workspaceEntry.indexOf('./workspace/review-rail-card-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/review-rail-card-chrome.css') < workspaceEntry.indexOf('./workspace/review-rail-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/review-rail-controls.css') < workspaceEntry.indexOf('./workspace/review-rail-detection-params.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/review-rail-detection-params.css') < workspaceEntry.indexOf('./workspace/review-rail-loaded-density.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/review-rail-loaded-density.css') < workspaceEntry.indexOf('./workspace/review-rail-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/review-rail-responsive.css') < workspaceEntry.indexOf('./workspace/detect-workbench.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/detect-workbench.css') < workspaceEntry.indexOf('./workspace/detect-mode-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/detect-mode-controls.css') < workspaceEntry.indexOf('./workspace/detect-parameter-form.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/detect-parameter-form.css') < workspaceEntry.indexOf('./workspace/detect-applied-display.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/detect-applied-display.css') < workspaceEntry.indexOf('./workspace/detect-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/detect-responsive.css') < workspaceEntry.indexOf('./workspace/prepare-workbench.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-workbench.css') < workspaceEntry.indexOf('./workspace/prepare-section-chrome.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-section-chrome.css') < workspaceEntry.indexOf('./workspace/prepare-case-console.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-case-console.css') < workspaceEntry.indexOf('./workspace/prepare-output-runtime.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-output-runtime.css') < workspaceEntry.indexOf('./workspace/prepare-analysis.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-analysis.css') < workspaceEntry.indexOf('./workspace/prepare-analysis-panel.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-analysis-panel.css') < workspaceEntry.indexOf('./workspace/prepare-analysis-summary.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-analysis-summary.css') < workspaceEntry.indexOf('./workspace/prepare-analysis-spectral.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-analysis-spectral.css') < workspaceEntry.indexOf('./workspace/prepare-analysis-roi.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-analysis-roi.css') < workspaceEntry.indexOf('./workspace/prepare-analysis-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-analysis-responsive.css') < workspaceEntry.indexOf('./workspace/prepare-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-controls.css') < workspaceEntry.indexOf('./workspace/prepare-filter-fields.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-filter-fields.css') < workspaceEntry.indexOf('./workspace/prepare-filter-actions.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-filter-actions.css') < workspaceEntry.indexOf('./workspace/prepare-controls-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/prepare-controls-responsive.css') < workspaceEntry.indexOf('./workspace/quick-detection-shell.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/quick-detection-shell.css') < workspaceEntry.indexOf('./workspace/quick-detection-layout.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/quick-detection-layout.css') < workspaceEntry.indexOf('./workspace/quick-detection-fields.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/quick-detection-fields.css') < workspaceEntry.indexOf('./workspace/quick-detection-classifier-export.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/quick-detection-classifier-export.css') < workspaceEntry.indexOf('./workspace/quick-detection-footer-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/quick-detection-footer-responsive.css') < workspaceEntry.indexOf('./workspace/channel-modal.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-detail.css') < workspaceEntry.indexOf('./workspace/event-review-side-stack.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-side-stack.css') < workspaceEntry.indexOf('./workspace/event-review-view-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-view-controls.css') < workspaceEntry.indexOf('./workspace/event-review-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-responsive.css') < workspaceEntry.indexOf('./workspace/event-review-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-controls.css') < workspaceEntry.indexOf('./workspace/event-review-progress-flow.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-progress-flow.css') < workspaceEntry.indexOf('./workspace/event-review-right-column-flow.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-right-column-flow.css') < workspaceEntry.indexOf('./workspace/event-review-navigation-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-navigation-controls.css') < workspaceEntry.indexOf('./workspace/event-review-prediction-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-prediction-controls.css') < workspaceEntry.indexOf('./workspace/event-review-frequency-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-frequency-controls.css') < workspaceEntry.indexOf('./workspace/event-review-detail-actions.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/event-review-detail-actions.css') < workspaceEntry.indexOf('./workspace/shared-control-sizing.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/agent-responsive.css') < workspaceEntry.indexOf('./workspace/classify-workbench.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/classify-workbench.css') < workspaceEntry.indexOf('./workspace/classify-execution-card.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/classify-execution-card.css') < workspaceEntry.indexOf('./workspace/classify-source-card.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/classify-source-card.css') < workspaceEntry.indexOf('./workspace/classify-responsive.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/classify-responsive.css') < workspaceEntry.indexOf('./workspace/main-window-density.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/shared-control-sizing.css') < workspaceEntry.indexOf('./workspace/classify-controls.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/classify-controls.css') < workspaceEntry.indexOf('./workspace/classify-stack.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/classify-stack.css') < workspaceEntry.indexOf('./workspace/batch-project-dialog.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/batch-project-dialog.css') < workspaceEntry.indexOf('./workspace/recording-info-dialog.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/recording-info-dialog.css') < workspaceEntry.indexOf('./workspace/runtime-log-dialog.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/runtime-log-dialog.css') < workspaceEntry.indexOf('./workspace/run-statistics-dialog.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/run-statistics-dialog.css') < workspaceEntry.indexOf('./workspace/waveform-shortcuts-dialog.css'));
  assert.ok(workspaceEntry.indexOf('./workspace/waveform-shortcuts-dialog.css') < workspaceEntry.indexOf('./workspace/load-detection-dialog.css'));
  assert.ok(foundation.includes('Foundation reset only'));
  assert.doesNotMatch(foundation, /pyqt-main-window|pyqt-workspace-shell|workspace-tabs|workspace-tab-panel|loaded-workspace|waveform-toolbar|waveform-header|waveform-pane|Prepare|Detect|Classify|prepare-|detector-|classifier-|agent-panel|agent-activity-bar|modal-card|runtime-log-panel|data-table/);
  for (const phrase of ['Shared clinical theme owner', '--ui-font:', '--lab-canvas:', ':root{', 'body{', '.sr-only{', '.select-toggle{']) assert.ok(sharedTheme.includes(phrase), phrase);
  for (const phrase of ['Shared control theme owner', 'All-window modernization pass', '--window-control-h:34px', '.modal-card input:not([type="checkbox"]):not([type="radio"])', '.workflow-panel-heading{', '.modal-card strong', 'font-weight:400!important', 'button:focus-visible', 'input[type="checkbox"],']) assert.ok(sharedControlTheme.includes(phrase), phrase);
  for (const phrase of ['Shared workflow surface theme owner', '.panel-card{', '.field-grid{', '.primary-action,', '.status-pill,', '.data-table th', 'letter-spacing:0!important', '.mini-list{', '.comparison-table tr[data-jaccard-high="true"] td']) assert.ok(sharedWorkflowSurfaceTheme.includes(phrase), phrase);
  for (const phrase of ['Shared runtime feedback theme owner', '.runtime-current{', '.runtime-log-list{', '.runtime-log-list li', '.runtime-running{', '@media(max-width:900px)', '.runtime-log-heading{', 'display:grid']) assert.ok(sharedRuntimeTheme.includes(phrase), phrase);
  for (const phrase of ['Waveform chrome owner', '.waveform-canvas{', '.waveform-pane{', 'border-color:var(--lab-line)!important', 'border-radius:var(--lab-radius)!important', '.channel-scrollbar,', '.time-scrollbar{', 'loaded-workspace-splitter-handle', '.status-strip{', '.empty-waveform-placeholder,']) assert.ok(waveformChrome.includes(phrase), phrase);
  for (const phrase of ['Modal chrome owner', '--ui-modal-bottom-clearance:18px', '.modal-backdrop{', 'position:fixed!important', 'inset:0!important', '.modal-card{', 'position:relative', 'max-height:calc(100vh - 48px)!important', '.modal-card>.modal-window-close-button', '.modal-window-close-button', 'opacity:1!important', 'pointer-events:auto!important', 'visibility:visible!important', '.modal-actions{', 'grid-template-columns:1fr 1fr!important']) assert.ok(modalChrome.includes(phrase), phrase);
  for (const source of [sharedTheme, sharedControlTheme, sharedWorkflowSurfaceTheme, sharedRuntimeTheme, waveformChrome, modalChrome]) {
    assert.doesNotMatch(source, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
    assert.doesNotMatch(source, /agent-activity-bar|agent-panel|agent-message|agent-command|agent-artifact|agent-chat|agent-composer|agent-current-operation|intent-preview/);
  }
  assert.doesNotMatch(sharedTheme, /All-window modernization pass|--window-control-h|\.runtime-current|\.runtime-log-list|\.run-chip-grid|\.pyqt-workspace-shell|\.workspace-tab-panel|\.panel-card|\.run-management-box|\.data-table|\.modal-backdrop|\.modal-card|\.modal-actions|\.workflow-panel-heading/);
  for (const phrase of ['Agent panel shell/dock owner', 'VS Code-like Agent panel resizing', 'Docked agent layout', 'Prepare/Detect/Classify', '--agent-effective-panel-width:var(--agent-panel-width)', 'right:var(--agent-effective-panel-width)!important', '.pyqt-main-window[data-agent-open="true"] .agent-panel', 'grid-template-columns:minmax(0,1fr) var(--agent-rail-width) var(--agent-effective-panel-width)!important', 'position:relative!important', '.agent-panel{', 'grid-template-rows:44px max-content minmax(0,1fr)!important', '.agent-panel-header{', '.agent-panel button', '.agent-chat-tab{', '.agent-chat-transcript{', '.agent-chat-composer{', '.agent-context-chip{', '.agent-chat-empty{', '.agent-panel-resize-handle']) assert.ok(agentPanel.includes(phrase), phrase);
  for (const phrase of ['Agent runtime content owner', 'Agent panel production content', '.agent-current-operation{', '.agent-current-operation progress', 'height:4px!important', '.agent-current-operation .runtime-idle+progress', 'height:2px!important', '.agent-action-list', '.agent-artifact-list', '.agent-artifact-group', '.agent-artifact-card', '.agent-empty-row']) assert.ok(agentRuntimeContent.includes(phrase), phrase);
  for (const phrase of ['Agent artifacts and command history owner', 'Persistent Agent artifacts controls', '.agent-artifacts-toolbar', '.agent-artifact-filter-row', '.agent-artifact-search', '.agent-artifact-actions', 'Agent Actions command history', '.agent-command-toolbar', '.agent-command-history', '.agent-command-card pre']) assert.ok(agentArtifactsCommands.includes(phrase), phrase);
  for (const phrase of ['Agent activity bar owner', '.agent-activity-bar button', '.agent-activity-bar button::before', '.agent-activity-bar .activity-label', '.agent-activity-bar{', 'grid-auto-rows:36px!important']) assert.ok(agentActivityBar.includes(phrase), phrase);
  for (const phrase of ['Agent visual chrome owner', '.agent-panel{', '.agent-panel-header{', '.agent-message-card,', '.agent-chat-empty,', '.agent-context-chip{', '.agent-composer-footer button[type="submit"]', '.agent-current-operation progress']) assert.ok(agentVisualChrome.includes(phrase), phrase);
  for (const phrase of ['Agent responsive owner', '@media(max-width:1100px)', '--agent-effective-panel-width:min(276px,var(--agent-panel-width),calc(100vw - var(--agent-rail-width) - 8px))', '@media(max-width:980px)', '@media(max-width:760px)', '.agent-command-toolbar']) assert.ok(agentResponsive.includes(phrase), phrase);
  assert.doesNotMatch(agentPanel, /Agent panel production content|Persistent Agent artifacts controls|Agent Actions command history|Agent activity bar owner|Agent visual chrome owner|@media\(max-width:1100px\)/);
  for (const source of [agentPanel, agentRuntimeContent, agentArtifactsCommands, agentActivityBar, agentVisualChrome, agentResponsive]) assert.doesNotMatch(source, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  assert.doesNotMatch(foundation, legacyAgentPanelSelectors);
  assert.doesNotMatch(foundation, /(?:^|\n)\s*\.modal-(?:backdrop|card|actions)\b|(?:^|\n)\s*\.primary-action\b/);
  const toolbarOwnershipSelectors = /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/;
  for (const phrase of ['Top toolbar layout owner', '.pyqt-top-toolbar{', '--top-toolbar-control-h:32px', '.pyqt-toolbar-row{', '.pyqt-menu-row{', '.project-status-pill:not([data-dirty="true"])', 'display:none!important', 'border-radius:0']) assert.ok(topToolbar.includes(phrase), phrase);
  for (const phrase of ['Top toolbar menu owner', '.pyqt-settings-menu{', '.pyqt-settings-menu>.pyqt-menu-button', '.pyqt-settings-menu:not([open]) .pyqt-toolbar-menu', '.pyqt-settings-menu[open] .pyqt-toolbar-menu', 'position:fixed!important', 'inset-inline-start:auto!important', 'inset-inline-end:8px!important', '.pyqt-toolbar-overflow[open]>.pyqt-toolbar-menu', 'min-block-size:30px!important', '.pyqt-toolbar-overflow>summary']) assert.ok(topToolbarMenu.includes(phrase), phrase);
  for (const phrase of ['Top toolbar actions owner', '.pyqt-toolbar-action{', 'flex:0 0 auto!important', 'white-space:nowrap!important', 'border-radius:6px!important', 'background:transparent', 'box-shadow:none', '.pyqt-toolbar-label', '.pyqt-toolbar-icon svg', 'stroke-linecap:round!important']) assert.ok(topToolbarActions.includes(phrase), phrase);
  assert.doesNotMatch(topToolbarSurface, /@media\(max-width:1120px\)|@media\(max-width:980px\)|clip-path:inset\(50%\)!important/);
  assert.doesNotMatch(topToolbarSurface, /font-weight:(?:6\d{2}|7\d{2}|8\d{2}|9\d{2}|bold)/);
  assert.doesNotMatch(topToolbarSurface, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field/);
  assert.doesNotMatch(topToolbar, /pyqt-settings-menu|pyqt-toolbar-action|pyqt-toolbar-overflow|pyqt-toolbar-icon/);
  assert.doesNotMatch(topToolbarMenu, /pyqt-toolbar-action:hover|pyqt-toolbar-icon|pyqt-toolbar-label/);
  assert.doesNotMatch(topToolbarActions, /pyqt-settings-menu|pyqt-toolbar-overflow|pyqt-toolbar-menu/);
  for (const phrase of ['Workspace shell chrome owner', '.pyqt-main-window{', '.pyqt-workspace-shell{', 'gap:7px!important', '@media(max-width:1100px)', 'padding:6px!important']) assert.ok(workspaceShellChrome.includes(phrase), phrase);
  for (const phrase of ['Waveform header chrome owner', 'Loaded waveform header relocation', '.waveform-header{', '.waveform-header h1{', '.waveform-header p{', '.pyqt-workspace-shell[data-loaded="true"]>.biomarker-bar', '.pyqt-workspace-shell[data-loaded="true"] .waveform-header-actions', '.pyqt-workspace-shell[data-loaded="true"] .waveform-header-actions button', 'align-self:center!important', 'block-size:var(--ui-action-h)!important', 'pyqt-waveform_reset_view_button', '.waveform-workflow-actions{', 'grid-template-columns:repeat(3,minmax(58px,max-content))!important', '.waveform-workflow-actions button', 'min-inline-size:max-content']) assert.ok(waveformHeaderChrome.includes(phrase), phrase);
  const resetButtonRule = waveformHeaderChrome.match(/\[data-testid="pyqt-waveform_reset_view_button"\]\{([\s\S]*?)\n\}/)?.[1] || '';
  assert.ok(resetButtonRule, 'loaded waveform Reset button needs an explicit visual contract');
  for (const phrase of ['min-inline-size:72px!important', 'border-color:#b8c7d2!important', 'border-radius:var(--lab-radius)!important', 'background:#fff!important', 'color:#1f3446!important']) assert.ok(resetButtonRule.includes(phrase), phrase);
  assert.doesNotMatch(resetButtonRule, /border-inline-start|border-start-start-radius|border-end-start-radius|border-color:transparent|background:transparent/);
  for (const phrase of ['Status strip layout owner', '.status-strip,', 'pyqt-activity_summary_label', 'pyqt-status_log_open_button', 'grid-template-columns:10px minmax(0,1fr) auto!important', 'min-inline-size:96px!important']) assert.ok(statusStripLayout.includes(phrase), phrase);
  for (const phrase of ['Workspace tabs chrome owner', '.workspace-tabs{', 'grid-template-rows:auto minmax(0,1fr)!important', '.workspace-tabs-header,', '.tab-bar{', '.workflow-tab-list button,', 'flex:0 0 auto!important', 'min-inline-size:92px!important', '.workspace-tab-panel{', '.tab-content{']) assert.ok(workspaceTabsChrome.includes(phrase), phrase);
  for (const phrase of ['Recent recordings card owner', '.recent-recordings-card{', '.recent-recordings-list{', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.recent-recording-open', '.recent-recordings-empty']) assert.ok(recentRecordingsCard.includes(phrase), phrase);
  assert.doesNotMatch(shellChromeSurface, /pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow|waveform-toolbar-row|waveform-tool-group|toolbar-field|display_time_window|go_to_time/);
  assert.doesNotMatch(workspaceShellChrome, /waveform-header|status-strip|workspace-tabs|workspace-tab-panel|tab-content|recent-recordings|loaded-workspace-splitter-handle/);
  assert.doesNotMatch(waveformHeaderChrome, /status-strip|workspace-tabs|workspace-tab-panel|tab-content|recent-recordings|loaded-workspace-splitter-handle/);
  assert.doesNotMatch(statusStripLayout, /waveform-header|workspace-tabs|workspace-tab-panel|tab-content|recent-recordings|loaded-workspace-splitter-handle/);
  assert.doesNotMatch(workspaceTabsChrome, /waveform-header|status-strip|recent-recordings|loaded-workspace-splitter-handle/);
  assert.doesNotMatch(recentRecordingsCard, /waveform-header|status-strip|workspace-tabs|workspace-tab-panel|tab-content|loaded-workspace-splitter-handle/);
  for (const phrase of ['Workflow card visuals owner', 'Owns only generic workflow card chrome', '.panel-card,', '.annotation-progress-card,', '.panel-heading-row{']) assert.ok(workflowCards.includes(phrase), phrase);
  assert.doesNotMatch(workflowCards, /classifier-status-grid|classifier-status-list|classifier-stack-list|stack-display/);
  assert.doesNotMatch(workflowCards, /workspace-tab-panel\[data-active-tab=|detector-|classifier-|detect-layout|classify-layout/);
  assert.doesNotMatch(workflowCards, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  for (const phrase of ['Main-window density owner', '--ui-main-min-inline-size:1024px', '--ui-density-field-short:136px', '--ui-density-detector-input:128px']) assert.ok(density.includes(phrase), phrase);
  assert.doesNotMatch(density, /waveform-tool|viewControlsGroupBox|workflow-expanded contract|data-workflow-expanded="true":has|workspace-tab-panel\[data-active-tab=|quick-detection-dialog/);
  assert.ok(waveformNavigation.includes('Waveform navigation owner'));
  for (const phrase of ['Waveform toolbar layout owner', '[data-testid="pyqt-waveform-toolbar"].waveform-toolbar-clinical-console', 'margin-inline-end:calc(var(--pyqt-main-sidebar-width,268px) + var(--pyqt-main-sidebar-gap,8px))!important', ':has(.loaded-workspace[data-workflow-expanded="true"])>[data-testid="pyqt-waveform-toolbar"].waveform-toolbar-clinical-console', 'margin-inline-end:0!important', '.waveform-toolbar-row{', '[data-testid="pyqt-waveform-channel-row"]', '.waveform-tool-group{', 'gap:4px!important']) assert.ok(waveformToolbarLayout.includes(phrase), phrase);
  for (const phrase of ['Waveform toolbar controls owner', '.waveform-tool-group-label,', '.waveform-tool-group button,', '.waveform-toolbar-svg-icon{', '[data-testid="pyqt-Choose_Channels_Button"]', '[data-testid="pyqt-bipolar_button"]', '.clinical-selector-trigger{', '.waveform-view-summary{', '.clinical-output-more-trigger{']) assert.ok(waveformToolbarControls.includes(phrase), phrase);
  for (const phrase of ['Waveform toolbar popover owner', '.clinical-selector-popover,', '.waveform-view-settings-popover{', 'position:absolute!important', '.clinical-selector-popover-output', 'inset-inline-end:0!important', '.clinical-inline-field{', '.waveform-view-settings-grid{', '.toolbar-field-label{', '.waveform-view-settings-apply{']) assert.ok(waveformToolbarPopovers.includes(phrase), phrase);
  for (const phrase of ['Waveform toolbar responsive owner', '@media(max-width:1120px)', 'block-size:116px!important', '--waveform-toolbar-row-h:32px', '[data-testid="pyqt-waveform-channel-row"]', 'flex-wrap:wrap!important', 'block-size:64px!important', '[data-testid="pyqt-waveform-source-row"] .waveform-tool-group-scope', 'inline-size:34px!important', 'min-inline-size:180px!important', 'inset-inline-start:-40px!important', 'inline-size:470px!important']) assert.ok(waveformToolbarResponsive.includes(phrase), phrase);
  assert.doesNotMatch(waveformToolbar, /@media\(max-width:1120px\)[\s\S]*?\.waveform-tool-group\{[\s\S]*?gap:[23]px!important/);
  for (const phrase of ['Waveform overview owner', 'User-confirmed main waveform left fixed-scroll parity', 'PyQt loaded waveform canvas adjacency parity', 'PyQt waveform overview/range band parity', 'Full-recording overview minimap', '.waveform-left-scroll-pane', 'data-pyqt-scroll-pane="pyqt-waveform_left_scroll_pane"', '.waveform-stage>.waveform-pane .waveform-plot-shell', '.waveform-overview-axis', '.waveform-overview-canvas']) assert.ok(waveformPaneOverview.includes(phrase), phrase);
  assert.doesNotMatch(waveformPaneOverview, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row/);
  assert.doesNotMatch(waveformPaneOverview, /event-review-dialog|event-review-body|event-review-left-panel|event-review-header|event-review-summary|event-detail-card|annotation-side-stack|annotation-detail-actions|annotation-plot-card|pyqt-FFT_layout|pyqt-groupBox|pyqt-progressCard|pyqt-frequency_range_group/);
  assert.doesNotMatch(waveformPaneOverview, /quick-detection|quick-classifier|pyqt-quick_detection|pyqt-classifier_groupbox_4/i);
  assert.doesNotMatch(waveformPaneOverview, /waveform-right-sidebar|pyqt-sidebar-card|sidebar-(?:button|workers|next-run|filter|detector-run|detection-params|classifier-toggles|copy|metadata-grid)|pyqt-sidebar_/);
  assert.doesNotMatch(waveformPaneOverview, /biomarker-bar|waveform-header(?:-|[{\s])/);
  for (const phrase of ['PyQt light waveform plot parity', 'Modern waveform navigation', '--waveform-nav-track', '.waveform-stage>.waveform-pane .waveform-plot-shell', '.waveform-stage>.waveform-pane .waveform-overview-canvas']) assert.ok(waveformNavigation.includes(phrase), phrase);
  assert.doesNotMatch(waveformNavigation, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|waveform-right-sidebar|pyqt-sidebar-card|pyqt-sidebar_/);
  assert.ok(annotation.includes('Annotation compact controls owner'));
  assert.ok(workflowExpanded.includes('Workflow-expanded layout owner'));
  for (const phrase of ['Preprocessing workbench opens on demand from waveform review', 'Cross-page workflow geometry contract', 'data-active-workflow-tab="prepare"', 'data-active-workflow-tab="detect"', 'data-active-workflow-tab="classify"', 'grid-template-rows:48px minmax(62px,auto) minmax(0,1fr) 32px!important', 'margin-inline-end:0!important', '.loaded-workspace[data-workflow-expanded="true"]>.workspace-tabs']) assert.ok(workflowExpanded.includes(phrase), phrase);
  assert.doesNotMatch(workflowExpanded, /data-agent-open|prepare-toggle-grid|runtime-log-panel/);
  assert.doesNotMatch(foundation, /Classifier tab parity|\.classify-layout|\.classifier-header-card|\.classifier-stack-card|\.classifier-mode-row|\.classifier-toggle-row|\.model-source-row|\.classifier-ignore-grid|\.classifier-source-card/);
  for (const phrase of ['Classify workbench layout owner', '.classifier-workbench-grid', '--classify-stack-column-max:min(480px,calc(100vw - var(--agent-rail-width,48px) - 390px))', 'grid-template-columns:minmax(0,400px)!important', '"setup"', '"stack"', '"local"', '"hub"!important', 'justify-content:start!important', '.classify-panel-heading', 'border:0!important', 'background:transparent!important', '.classifier-workbench-grid>*', 'grid-column:auto!important']) assert.ok(classify.includes(phrase), phrase);
  for (const phrase of ['Classify execution card owner', '.classifier-header-card{', 'grid-area:setup!important', 'grid-template-areas:', '"params"!important', '.classifier-mode-row', 'grid-template-columns:minmax(0,1fr) 104px!important', 'inline-size:100%!important', 'max-inline-size:none!important', '[data-testid="pyqt-classifier_run_button"]', '.classifier-status-list', '.classifier-status-item', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', 'text-transform:uppercase!important', '[data-tone="blocked"] dd', 'text-overflow:ellipsis!important']) assert.ok(classifyExecution.includes(phrase), phrase);
  for (const phrase of ['Classify source card owner', '.classifier-source-card{', 'grid-area:local!important', '.classifier-source-card[data-testid="pyqt-groupBox_2"]', 'grid-area:hub!important', '.classifier-hub-banner', '.classifier-source-list', 'grid-template-columns:minmax(0,1fr)!important', '.classifier-source-list .model-source-row', 'grid-template-columns:minmax(0,1fr) 104px!important', 'max-inline-size:470px!important', '.classifier-source-card input']) assert.ok(classifySource.includes(phrase), phrase);
  for (const phrase of ['Classify responsive owner', '@media(max-width:980px)', 'grid-template-areas:', '"setup"', '"stack"', '"local"', '"hub"!important', '.classifier-status-list', 'grid-template-columns:repeat(2,max-content)!important', '.classifier-source-list .model-source-row', '@media(max-width:900px)', '.classifier-controls-card{', '.classifier-control-grid{']) assert.ok(classifyResponsive.includes(phrase), phrase);
  assert.doesNotMatch(classifySurface, /classifier-status-grid|span\[data-tone|grid-template-rows:auto minmax\(16px,auto\)!important/);
  for (const phrase of ['Classify controls owner', 'setup-card parameter strip', 'grid-area:params!important', 'grid-template-columns:repeat(2,max-content)!important', '.classifier-device-grid', 'grid-template-columns:repeat(2,var(--ui-density-classifier-tiny))!important', 'grid-template-columns:repeat(auto-fit,minmax(var(--ui-density-field-short-min),var(--ui-density-field-short)))!important', '.classifier-ignore-grid label', 'grid-template-columns:16px minmax(0,1fr)!important', 'block-size:var(--ui-density-control-h)!important', 'grid-template-columns:repeat(3,minmax(0,1fr))!important', '.classifier-toggle-row input[type="checkbox"]']) assert.ok(classifyControls.includes(phrase), phrase);
  for (const phrase of ['.classifier-controls-card .classifier-section-heading', 'gap:6px!important', 'margin:0!important', 'padding:0!important', 'flex:0 0 auto!important']) assert.ok(classifyControls.includes(phrase), phrase);
  for (const phrase of ['Classify stack owner', '.classifier-stack-list', '.classifier-stack-item', '.classifier-stack-item-path', '.classifier-stack-item-source', '.classifier-stack-item-steps', 'grid-column:1 / -1!important', 'grid-area:stack!important', '.classifier-workbench-grid>.classifier-stack-card', 'inline-size:100%!important', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', 'grid-template-columns:minmax(58px,max-content) minmax(0,1fr)!important', '.stack-display', 'border:0!important', 'background:transparent!important', 'text-overflow:ellipsis!important']) assert.ok(classifyStack.includes(phrase), phrase);
  assert.doesNotMatch(classifyStack, /classifier-stack-grid|block-size:var\(--ui-density-control-h\)!important|border:1px solid #b8c8d4!important|max-inline-size:248px!important/);
  assert.doesNotMatch(density, /workspace-tab-panel\[data-active-tab="Classify"\]|pyqt-classifier_device_input|pyqt-classifier_batch_size_input/);
  assert.doesNotMatch(classify, /grid-template-columns:260px\s+(?:minmax\(0,1fr\)|300px)/);
  assert.doesNotMatch(classify, /classifier-header-card|classifier-source-card|classifier-status-list|classifier-controls-card|classifier-control-grid|classifier-toggle-row|classifier-stack-card|classifier-stack-grid|classifier-stack-list|stack-display|pyqt-classifier_device_input|pyqt-classifier_batch_size_input|pyqt-classifier_source_preference_display/);
  assert.doesNotMatch(classifyExecution, /classifier-source-card|classifier-source-list|classifier-hub-banner|classifier-controls-card|classifier-control-grid|classifier-toggle-row|classifier-stack-card|classifier-stack-list|stack-display/);
  assert.doesNotMatch(classifySource, /classifier-mode-row|classifier-status-list|classifier-status-item|classifier-controls-card|classifier-control-grid|classifier-toggle-row|classifier-stack-card|classifier-stack-list|stack-display/);
  assert.doesNotMatch(classifyControls, /@media\(max-width:900px\)|pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|classifier-header-card|classifier-source-card|classifier-hub-banner|classifier-stack-card|classifier-stack-grid|classifier-stack-list|stack-display/);
  assert.doesNotMatch(classifyStack, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|classifier-controls-card|classifier-control-grid|classifier-toggle-row|pyqt-classifier_device_input|pyqt-classifier_batch_size_input/);
  assert.doesNotMatch(classifyResponsive, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time/);
  for (const phrase of ['Review rail geometry owner', '@media(max-width:1180px)', '[data-active-workflow-tab="waveform"]>.waveform-header', '[data-active-workflow-tab="waveform"]>.loaded-workspace', 'margin-inline-end:calc(var(--pyqt-main-sidebar-width) + var(--pyqt-main-sidebar-gap))!important', ':has(.loaded-workspace[data-workflow-expanded="true"])>.loaded-workspace', 'margin-inline-end:0!important', 'child of the waveform workspace in the DOM', '.loaded-workspace[data-workflow-expanded="false"]>.waveform-stage', 'overflow:visible!important', 'grid-auto-rows:min-content!important', 'min-block-size:0!important', 'padding-block-end:24px!important']) assert.ok(reviewRail.includes(phrase), phrase);
  for (const phrase of ['Review rail card chrome owner', '.pyqt-sidebar-card{', '.pyqt-sidebar-card header', '.sidebar-header-actions', '@media(max-width:760px)']) assert.ok(reviewRailCardChrome.includes(phrase), phrase);
  for (const phrase of ['Review rail controls owner', '.pyqt-workspace-shell .pyqt-sidebar-card button', '.sidebar-workers-row', '.sidebar-next-run-row', '.sidebar-filter-row', '.sidebar-detector-run-row', '.waveform-right-sidebar .sidebar-classifier-toggles label', 'grid-template-columns:16px minmax(0,1fr)!important', '.pyqt-sidebar-card [data-testid="pyqt-sidebar_open_review_button"]']) assert.ok(reviewRailControls.includes(phrase), phrase);
  for (const phrase of ['Review rail detection parameter owner', '[data-testid="pyqt-sidebar_ste_peak_threshold_input"]', '.waveform-right-sidebar .sidebar-detection-params', 'display:grid!important', 'grid-template-columns:repeat(3,72px)!important']) assert.ok(reviewRailDetectionParams.includes(phrase), phrase);
  for (const phrase of ['Loaded review rail density owner', 'Loaded review rail control density', '.pyqt-workspace-shell[data-loaded="true"] .waveform-right-sidebar .sidebar-copy', 'pyqt-sidebar_results_card', 'pyqt-sidebar_classification_card', 'var(--ui-density-control-h-compact)', 'pyqt-sidebar_more_results_button', 'pyqt-sidebar_classifier_preset']) assert.ok(reviewRailLoadedDensity.includes(phrase), phrase);
  for (const phrase of ['Review rail responsive owner', '@media(max-width:1180px),(max-height:820px)', 'pyqt-sidebar_run_actions_card', 'pyqt-sidebar_active_run_summary', 'pyqt-sidebar_signal_card', 'pyqt-sidebar_detection_card', 'pyqt-sidebar_classification_card']) assert.ok(reviewRailResponsive.includes(phrase), phrase);
  assert.doesNotMatch(reviewRailSurface, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time/);
  assert.doesNotMatch(reviewRail, /pyqt-sidebar-card|pyqt-sidebar_|sidebar-copy|sidebar-detection-params|sidebar-classifier-toggles/);
  assert.doesNotMatch(reviewRailCardChrome, /waveform-stage|pyqt-sidebar_|sidebar-copy|sidebar-detection-params|sidebar-classifier-toggles|ui-density-control-h-compact/);
  assert.doesNotMatch(reviewRailControls, /waveform-stage|sidebar-copy|sidebar-detection-params|ui-density-control-h-compact|@media\(max-width:1180px\)|pyqt-sidebar_active_run_summary/);
  assert.doesNotMatch(reviewRailDetectionParams, /waveform-stage|sidebar-copy|sidebar-classifier-toggles|ui-density-control-h-compact|pyqt-sidebar_active_run_summary|pyqt-sidebar_classification_card/);
  assert.doesNotMatch(reviewRailLoadedDensity, /waveform-stage|sidebar-detection-params\{|sidebar-classifier-toggles label|@media\(max-width:1180px\)/);
  assert.doesNotMatch(reviewRailResponsive, /border-color:var\(--lab-line\)|box-shadow:var\(--lab-inset\)|sidebar-detection-params\{|sidebar-classifier-toggles label|ui-density-control-h-compact/);
  const detectorSetupStripBlock = detectModeControls.match(/\.workspace-tab-panel\[data-active-tab="Detect"\] \.detector-setup-strip\{[\s\S]*?\n\}/)?.[0] || '';
  for (const phrase of ['Detect workbench layout owner', '.workspace-tab-panel[data-active-tab="Detect"]{', 'container-type:inline-size', 'min-inline-size:0!important', 'min-block-size:0!important', 'scrollbar-gutter:stable both-edges!important', '.workflow-panel-heading{', 'margin:0!important', 'padding:0!important']) assert.ok(detectWorkbench.includes(phrase), phrase);
  for (const phrase of ['Detect mode controls owner', '.detector-setup-strip{', 'grid-template-areas:', '"mode"', 'inline-size:100%!important', '.detector-mode-primary-row', '.detector-mode-field', 'grid-area:mode!important', 'flex-wrap:wrap!important']) assert.ok(detectModeControls.includes(phrase), phrase);
  for (const phrase of ['Detect parameter form owner', 'grid-template-columns:minmax(0,1fr)!important', 'max-inline-size:440px!important', 'grid-auto-rows:min-content!important', 'background:#fff!important', 'box-shadow:var(--lab-card-shadow)!important', 'block-size:auto!important', 'grid-template-columns:repeat(2,var(--ui-density-field-medium))!important', 'max-inline-size:var(--ui-density-field-medium)!important', 'pyqt-lsm_parameter_file_input', '.lsm-model-parameters>.helper-copy', 'grid-template-columns:minmax(0,var(--ui-density-detector-input)) auto!important', 'inline-size:var(--ui-density-detector-input)!important', '.detector-runtime-warning', '.detector-feedback-line', 'min-block-size:auto!important']) assert.ok(detectParameterForm.includes(phrase), phrase);
  for (const phrase of ['Detect applied display owner', 'max-inline-size:none!important', '.detector-display-grid', 'grid-template-columns:repeat(2,minmax(168px,220px))!important', 'grid-template-columns:minmax(84px,max-content) minmax(0,1fr)!important', '.detector-display-title', '.detector-display-cell output', 'border:0!important', 'background:transparent!important']) assert.ok(detectAppliedDisplay.includes(phrase), phrase);
  for (const phrase of ['Detect responsive owner', '@container (max-width:860px)', '.detector-form-header,', '.detector-form-body,', '.detector-applied-display,', '.detector-feedback-line{']) assert.ok(detectResponsive.includes(phrase), phrase);
  assert.ok(detectorSetupStripBlock, 'Detect setup strip block exists');
  assert.doesNotMatch(detectorSetupStripBlock, /inline-size:max-content!important|justify-self:start!important/);
  assert.doesNotMatch(detectSurface, /detector-mode-controls|detector-protocol-row|detector-display-heading strong|detector-form-card>\.status-line|detector-form-card>\.button-row|workflow-panel-heading\.detect-panel-heading \.helper-copy|detector-form-header \.helper-copy/);
  assert.doesNotMatch(detectWorkbench, /detector-setup-strip|detector-mode-header|detector-subtabs|detector-form-card|detector-field-grid|detector-applied-display|detector-display-grid|detector-feedback-line/);
  assert.doesNotMatch(detectModeControls, /detector-form-card|detector-field-grid|detector-applied-display|detector-display-grid|detector-feedback-line/);
  assert.doesNotMatch(detectParameterForm, /detector-setup-strip|detector-subtabs|detector-display-grid|detector-display-cell output/);
  assert.doesNotMatch(detectAppliedDisplay, /detector-mode-primary-row|detector-field-grid|pyqt-lsm_parameter_file_input|detector-feedback-line/);
  assert.doesNotMatch(detectSurface, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time/);
  assert.doesNotMatch(foundation, legacyDetectFoundationBlocks);
  assert.doesNotMatch(foundation, legacyDetectFoundationSelectors);
  assert.doesNotMatch(density, /workspace-tab-panel\[data-active-tab="Detect"\]|pyqt-lsm_parameter_file_input/);
  for (const phrase of ['Prepare workbench scroll owner', '.workspace-tab-panel[data-active-tab="Prepare"]>.prepare-grid', 'min-inline-size:0!important', 'min-block-size:0!important', 'grid-auto-rows:min-content!important', 'grid-template-columns:minmax(0,1fr)!important', 'overflow:auto!important']) assert.ok(prepareWorkbench.includes(phrase), phrase);
  for (const phrase of ['Prepare section chrome owner', '.prepare-section{', 'padding:9px!important', '.prepare-section-heading h3', '@media(max-height:820px)', '.prepare-section-heading{']) assert.ok(prepareSectionChrome.includes(phrase), phrase);
  for (const phrase of ['Prepare case console owner', '.case-console{', '.case-console-workspace', 'grid-template-columns:minmax(0,1fr)!important', 'justify-self:start!important', 'max-inline-size:560px!important', '.case-console-column', 'scrollbar-gutter:stable both-edges!important', '.configure-column', 'order:1!important', '.review-settings-column', 'order:2!important', '@container (max-width:1080px)', '@media(max-height:820px)']) assert.ok(prepareCaseConsole.includes(phrase), phrase);
  for (const phrase of ['Prepare output/runtime owner', '.runtime-log-heading .helper-copy', 'pyqt-runtime_operation_label', 'overflow-wrap:anywhere!important', '.runtime-log-panel', 'display:none!important']) assert.ok(prepareOutputRuntime.includes(phrase), phrase);
  for (const phrase of ['Prepare analysis chrome owner', '.recording-analysis-grid article', 'padding:7px!important', '.recording-analysis-grid article h4', '.recording-analysis-grid article p', '.recording-analysis-grid article strong', 'font-family:var(--ui-mono)!important', '.recording-analysis-grid .mini-list']) assert.ok(prepareAnalysis.includes(phrase), phrase);
  for (const phrase of ['Prepare analysis panel owner', '.recording-planning-panel', 'grid-template-columns:minmax(0,1fr)!important', '.recording-planning-panel>.panel-heading-row', 'grid-template-columns:max-content auto!important', '.recording-planning-panel>.panel-heading-row h3', 'text-overflow:clip!important', '[data-testid="pyqt-recording_analysis_button"]', '.recording-planning-panel>.recording-analysis-grid', '.recording-planning-panel>.roi-exclusion-editor', '.recording-planning-panel>.roi-channel-review', '.recording-planning-panel>.button-row', '.recording-planning-panel>.error-panel']) assert.ok(prepareAnalysisPanel.includes(phrase), phrase);
  for (const phrase of ['Prepare analysis summary cards owner', '.recording-analysis-grid{', 'display:grid!important', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.recording-analysis-stat-card{', 'grid-template-columns:max-content minmax(0,1fr)!important', '.recording-analysis-stat-card h4', '.recording-analysis-stat-card p:not(.mini-list)', '.recording-analysis-stat-card>span', 'text-overflow:ellipsis!important', '.recording-analysis-stat-card .mini-list', '.recording-analysis-stat-card strong', 'font-size:var(--fs-md)!important']) assert.ok(prepareAnalysisSummary.includes(phrase), phrase);
  for (const phrase of ['Prepare spectral analysis owner', '.recording-analysis-spectral-card{', 'grid-column:1 / -1!important', 'grid-template-columns:minmax(0,1fr) 112px!important', '.spectral-card-heading', '.spectral-card-heading h4', '.spectral-card-heading p', 'line-height:1.15!important', '.recording-analysis-spectral-card>.spectral-curve-plot', '.spectral-band-bars', '.spectral-band-row', '.spectral-line-noise-list', '.spectral-line-noise-list .ln-caption', '.spectral-curve-plot polyline', 'height:32px!important']) assert.ok(prepareAnalysisSpectral.includes(phrase), phrase);
  for (const phrase of ['Prepare ROI review owner', '.roi-exclusion-editor textarea', 'height:40px!important', 'resize:none!important', '.roi-channel-review{', 'overflow:auto!important', '.roi-channel-review td:first-child', 'place-items:center!important', '.roi-channel-review [data-testid="pyqt-recording_roi_channel_checkbox"]', 'transform:none!important', '.recording-planning-panel>.button-row button']) assert.ok(prepareAnalysisRoi.includes(phrase), phrase);
  for (const phrase of ['Prepare analysis responsive owner', '@media(max-width:1320px)', '@container (max-width:760px)', '.recording-planning-panel>.recording-analysis-grid', '.recording-planning-panel>.roi-exclusion-editor', '.recording-planning-panel>.roi-channel-review', '.recording-planning-panel>.button-row', 'grid-column:1!important', 'grid-row:auto!important']) assert.ok(prepareAnalysisResponsive.includes(phrase), phrase);
  for (const phrase of ['Prepare control chrome owner', '.filter-parameter-panel input:not([type="checkbox"]):not([type="radio"])', '.prepare-strategy-grid input', 'font-weight:400!important', '.runtime-control-row,', '.prepare-toggle-grid{', '.filter-parameter-panel .prepare-section-heading']) assert.ok(prepareControls.includes(phrase), phrase);
  for (const phrase of ['Prepare filter field owner', '.filter-parameter-panel .field-grid.compact', 'grid-template-columns:repeat(4,minmax(0,var(--ui-density-field-short)))!important', 'column-gap:11px!important', '.field-grid.compact label', 'max-inline-size:none!important', '.filter-parameter-panel input:not([type="checkbox"]):not([type="radio"])', '.prepare-strategy-grid', 'grid-column:2!important']) assert.ok(prepareFilterFields.includes(phrase), phrase);
  for (const phrase of ['Prepare filter action owner', '.prepare-toggle-grid', 'inline-size:max-content!important', '.prepare-toggle-option', 'grid-template-columns:16px max-content!important', '.prepare-toggle-grid input[type="checkbox"]', 'inline-size:16px!important', '.runtime-control-row', '.filter-parameter-panel .runtime-control-row label', 'grid-template-columns:39px minmax(0,1fr)!important', '.prepare-runtime-jobs', 'grid-template-columns:56px max-content!important', '.prepare-runtime-action', '.prepare-filter-action-strip']) assert.ok(prepareFilterActions.includes(phrase), phrase);
  for (const phrase of ['Prepare controls responsive owner', '@container (max-width:1080px)', 'grid-template-columns:repeat(4,max-content)!important', '@container (max-width:520px)', 'grid-template-columns:repeat(2,minmax(0,var(--ui-density-field-short)))!important', '@media(max-height:820px)', '.prepare-control-cluster', 'display:none!important', 'column-gap:24px!important']) assert.ok(prepareControlsResponsive.includes(phrase), phrase);
  assert.doesNotMatch(prepareWorkbench, /case-console|prepare-title-stack|prepare-readiness-strip|recording-info|statistics-box|decision-desk|runtime-log|recording-planning-panel|recording-analysis-grid|recording-analysis-stat-card|recording-analysis-spectral-card|spectral-card-heading|spectral-curve-plot|spectral-band-bars|spectral-line-noise-list|roi-exclusion-editor|roi-channel-review|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-|data-agent-open="true"/);
  assert.doesNotMatch(prepareSectionChrome, /filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|recording-analysis-grid|roi-channel-review|pyqt-workspace-shell \.decision-desk/);
  assert.doesNotMatch(prepareCaseConsole, /prepare-title-stack|prepare-readiness-strip|recording-info|statistics-box|decision-desk|runtime-log|recording-analysis-grid|filter-parameter-panel|prepare-toggle-grid/);
  assert.doesNotMatch(prepareOutputRuntime, /case-console-workspace|prepare-title-stack|prepare-readiness-strip|recording-info-grid|recording-analysis-grid|filter-parameter-panel|prepare-toggle-grid|pyqt-workspace-shell \.decision-desk/);
  assert.doesNotMatch(prepareAnalysis, /recording-planning-panel|recording-analysis-stat-card|recording-analysis-spectral-card|spectral-card-heading|spectral-curve-plot|spectral-band-bars|spectral-line-noise-list|roi-exclusion-editor|roi-channel-review|@media|@container|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-|data-agent-open="true"/);
  assert.doesNotMatch(prepareAnalysisPanel, /spectral-card-heading|spectral-curve-plot|spectral-band-bars|spectral-line-noise-list|recording-analysis-stat-card|roi-channel-review td:first-child|pyqt-recording_roi_channel_checkbox|textarea|@media|@container|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-/);
  assert.doesNotMatch(prepareAnalysisSummary, /recording-planning-panel|recording-analysis-spectral-card|spectral-card-heading|spectral-curve-plot|spectral-band-bars|spectral-line-noise-list|roi-exclusion-editor|roi-channel-review|@media|@container|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-/);
  assert.doesNotMatch(prepareAnalysisSpectral, /recording-planning-panel|recording-analysis-stat-card|roi-exclusion-editor|roi-channel-review|pyqt-recording_roi_channel_checkbox|@media|@container|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-/);
  assert.doesNotMatch(prepareAnalysisRoi, /recording-analysis-grid|recording-analysis-stat-card|recording-analysis-spectral-card|spectral-card-heading|spectral-curve-plot|spectral-band-bars|spectral-line-noise-list|pyqt-recording_analysis_button|@media|@container|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-/);
  assert.doesNotMatch(prepareAnalysisResponsive, /border-color|background:linear-gradient|box-shadow|font-size|font-family|polyline|pyqt-recording_roi_channel_checkbox|pyqt-recording_analysis_button|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid|runtime-control-row|prepare-runtime-/);
  assert.doesNotMatch(prepareControls, /\.field-grid\.compact|prepare-filter-action-strip|prepare-runtime-jobs|grid-template-columns:repeat\(4,minmax\(0,var\(--ui-density-field-short\)\)\)!important|@media|@container|recording-planning-panel|recording-analysis-grid|recording-analysis-stat-card|recording-analysis-spectral-card|spectral-card-heading|spectral-curve-plot|roi-channel-review|\[data-testid="pyqt-recording_analysis_button"\]/);
  assert.doesNotMatch(prepareFilterFields, /prepare-toggle-grid|runtime-control-row|prepare-runtime-|prepare-filter-action-strip|@media|@container|recording-planning-panel|recording-analysis-grid|roi-channel-review/);
  assert.doesNotMatch(prepareFilterActions, /\.field-grid\.compact|prepare-strategy-grid|@media|@container|recording-planning-panel|recording-analysis-grid|roi-channel-review/);
  assert.doesNotMatch(prepareControlsResponsive, /recording-planning-panel|recording-analysis-grid|roi-channel-review|case-console-workspace|decision-desk/);
  assert.ok(prepareFilterFields.includes('.prepare-control-cluster'), 'filter fields own prepare-control-cluster base layout');
  assert.doesNotMatch(prepareControlSurface, /prepare-strategy-grid label:nth-child\(2\)[\s\S]{0,180}grid-column:3!important/);
  for (const source of [prepareWorkbench, prepareSectionChrome, prepareCaseConsole, prepareOutputRuntime, prepareAnalysis, prepareAnalysisPanel, prepareAnalysisSummary, prepareAnalysisSpectral, prepareAnalysisRoi, prepareAnalysisResponsive, prepareControls, prepareFilterFields, prepareFilterActions, prepareControlsResponsive]) assert.doesNotMatch(source, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time/);
  assert.doesNotMatch(prepareAnalysisSurface, /prepare-control-cluster/);
  assert.doesNotMatch(prepareWorkbench, /translateY\(|prepare-toggle-grid label|grid-template-columns:repeat\(auto-fit,minmax\(136px,max-content\)\)!important|grid-template-columns:repeat\(2,minmax\(126px,1fr\)\)!important|grid-template-columns:repeat\(2,minmax\(0,170px\)\)!important|minmax\(96px,112px\)/);
  assert.doesNotMatch(density, /workspace-tab-panel\[data-active-tab="Prepare"\]|data-active-workflow-tab="prepare"|case-console-workspace|roi-channel-review|runtime-control-row|filter-parameter-panel|prepare-strategy-grid|prepare-toggle-grid/);
  assert.doesNotMatch(foundation, legacyPrepareFoundationBlocks);
  assert.doesNotMatch(foundation, legacyPrepareFoundationSelectors);
  for (const phrase of ['Quick Detection shell/status owner', '--quick-detector-input:104px', '.quick-detection-dialog{', 'grid-template-rows:auto minmax(0,1fr) auto!important', '.quick-detection-dialog label:has(>input[type="checkbox"])', 'grid-template-columns:16px minmax(0,1fr)!important', '.quick-detection-header .modal-window-close-button', '[data-testid="pyqt-quick_detection_close_button"]', 'position:absolute!important', 'inset-inline-end:0!important', '.quick-detection-status-card .quick-detection-runtime[data-run-status="idle"]', '.quick-detection-action-rail .quick-detection-setup-copy']) assert.ok(quickDetection.includes(phrase), phrase);
  for (const phrase of ['Quick Detection layout owner', 'decoupled main column', '.quick-detection-dialog>.quick-detection-grid', 'grid-template-columns:minmax(300px,310px) minmax(420px,1fr) minmax(300px,340px)!important', '.quick-detection-dialog [data-testid="pyqt-qd_action_rail"]', 'grid-template-columns:minmax(0,1fr)!important', '.quick-detection-dialog [data-testid="pyqt-qd_action_rail"]>button', '.quick-detection-dialog [data-testid="pyqt-qd_action_rail"]>[data-testid="pyqt-qd_loadEDF_button"]', 'min-inline-size:150px!important', '.quick-detection-dialog [data-testid="pyqt-qd_action_rail"] .quick-setup-field', '.quick-detection-dialog [data-testid="pyqt-qd_action_rail"] .quick-setup-field-short', 'grid-template-columns:max-content 104px!important', '.quick-detection-dialog .quick-detection-left-rail', '.quick-detection-dialog .quick-detection-main-column', 'grid-row:1!important', 'display:grid!important', 'margin:0!important', '.quick-detection-grid>.quick-detection-right-rail', 'grid-template-rows:min-content min-content!important', '.quick-detection-dialog .quick-detection-right-rail>[data-testid="pyqt-classifier_groupbox_4"]', 'block-size:max-content!important']) assert.ok(quickDetectionGridRails.includes(phrase), phrase);
  for (const phrase of ['Quick Detection fields owner', '.quick-detection-dialog .quick-filter-grid', '.quick-detection-dialog .quick-classifier-param-grid', '.quick-detection-dialog .quick-detector-heading', 'justify-content:flex-start!important', '.quick-detection-dialog .quick-detector-field', 'pyqt-qd_lsm_parameter_file_input', 'grid-template-columns:repeat(auto-fit,minmax(calc(var(--quick-detector-input) + 40px),1fr))!important', 'grid-template-rows:auto var(--ui-density-control-h)!important', 'grid-template-columns:minmax(0,var(--quick-detector-input)) max-content!important']) assert.ok(quickDetectionFields.includes(phrase), phrase);
  for (const phrase of ['Quick Detection classifier/export owner', '.quick-detection-right-rail .quick-classifier-model-grid', '.quick-detection-dialog .quick-detection-right-rail .quick-classifier-param-grid', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.quick-detection-dialog .quick-detection-grid .quick-classifier-actions', 'grid-template-columns:repeat(2,116px)!important', '.quick-classifier-run-toggle', 'grid-template-columns:16px max-content!important']) assert.ok(quickDetectionClassifierExport.includes(phrase), phrase);
  for (const phrase of ['Quick Detection footer/responsive owner', '.quick-detection-dialog>.quick-detection-action-strip', 'grid-template-columns:repeat(3,124px)!important', 'justify-content:end!important', 'justify-self:end!important', 'inline-size:max-content!important', 'background:transparent!important', '@media(max-width:1280px)', 'grid-template-columns:minmax(84px,84px) minmax(96px,1fr) minmax(84px,84px) minmax(96px,1fr)!important', '.quick-detection-metadata-grid [data-testid="pyqt-qd_filename"]', '@media(min-width:1000px) and (max-width:1179px)', 'grid-template-columns:176px minmax(0,1fr) 292px!important', '--quick-detector-input:80px', '@media(min-width:1180px) and (max-width:1280px)', '@media(max-width:880px)']) assert.ok(quickDetectionFooterResponsive.includes(phrase), phrase);
  assert.doesNotMatch(quickDetection, /quick-detection-dialog>\.quick-detection-grid|quick-detection-left-rail|quick-detection-right-rail|quick-filter-grid|quick-detector-field|quick-classifier-model-grid|quick-detection-action-strip/);
  for (const source of [quickDetection, quickDetectionGridRails, quickDetectionFields, quickDetectionClassifierExport, quickDetectionFooterResponsive]) assert.doesNotMatch(source, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|workspace-tab-panel\[data-active-tab=/);
  assert.doesNotMatch(foundation, quickDetectionSelectors);
  assert.ok(shellStructural.includes('Shell structure owner'));
  assert.doesNotMatch(shellStructural, /PyQt subwindow close affordance repair|modal-window-close-button|annotation-menu-actions|pyqt-annotation_close_button|pyqt-actionStart_Over/);
  for (const phrase of ['Batch Project dialog owner', 'Batch project parity', 'Product action sizing contract', '.batch-project-backdrop', '.batch-project-dialog', '.batch-project-grid', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.batch-project-grid label.select-toggle', 'grid-template-columns:16px minmax(0,1fr)!important', '[data-testid="pyqt-batch_project_setup_card"] button', '[data-testid="pyqt-batch_input_dir_browse_button"]', '.batch-cases-card .data-table']) assert.ok(batchProject.includes(phrase), phrase);
  assert.doesNotMatch(batchProject, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  assert.doesNotMatch(foundation, batchProjectSelectors);
  for (const phrase of ['Recording Information dialog owner', '.recording-info-dialog', 'grid-template-rows:auto max-content minmax(150px,180px) minmax(0,1fr)', '.recording-info-header', '.recording-info-channel-list', 'grid-template-columns:repeat(3,minmax(0,1fr))', '.recording-info-raw-card', 'padding-block-end:var(--ui-modal-bottom-clearance)!important', '[data-testid="pyqt-recording_info_button"]', 'block-size:34px!important']) assert.ok(recordingInfoDialog.includes(phrase), phrase);
  assert.doesNotMatch(recordingInfoDialog, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  assert.doesNotMatch(foundation, recordingInfoDialogSelectors);
  for (const phrase of ['Runtime Log dialog owner', '.runtime-log-dialog', 'grid-template-rows:auto auto auto auto minmax(88px,.34fr) minmax(0,1fr)', '.runtime-log-header .helper-copy', '.runtime-log-summary', '[data-testid="pyqt-runtime_log_cancel_button"]', '.runtime-log-toolbar', '.runtime-backend-health', '.runtime-log-table-shell', '.runtime-backend-log-shell', '.runtime-ui-log-shell', '.runtime-log-table tr[data-level="error"] td']) assert.ok(runtimeLogDialog.includes(phrase), phrase);
  assert.doesNotMatch(runtimeLogDialog, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  assert.doesNotMatch(foundation, runtimeLogDialogSelectors);
  for (const phrase of ['Run Statistics dialog owner', '.modal-backdrop:has(.run-statistics-dialog)', '.run-statistics-dialog', 'grid-template-rows:auto auto minmax(0,1fr)', '.run-statistics-dialog .button-row[data-testid="pyqt-run_stats_action_row"]', 'grid-template-columns:repeat(auto-fit,minmax(142px,max-content))!important', '.run-statistics-dialog .button-row[data-testid="pyqt-run_stats_action_row"]>button', 'block-size:var(--window-control-h)!important', 'display:flex!important', 'justify-content:stretch!important', 'font-size:0!important', 'flex:1 1 auto!important', '.run-statistics-body', 'grid-template-columns:minmax(0,1.25fr) minmax(260px,.8fr)', '.run-statistics-management', '.run-progress-grid', '.run-artifacts-empty', '.run-statistics-dialog .runtime-log-list', 'max-height:132px', '.run-statistics-dialog .comparison-table th']) assert.ok(runStatisticsDialog.includes(phrase), phrase);
  assert.doesNotMatch(runStatisticsDialog, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  assert.doesNotMatch(foundation, runStatisticsDialogSelectors);
  assert.doesNotMatch(sharedTheme, runStatisticsDialogSelectors);
  for (const phrase of ['Waveform Shortcuts dialog owner', '.modal-backdrop:has(.waveform-shortcuts-dialog)', '.waveform-shortcuts-dialog', 'height:min(800px,calc(100vh - 48px))!important', 'grid-template-rows:auto auto auto auto minmax(0,1fr) auto auto!important', '.shortcut-trackpad-card', '.waveform-shortcuts-dialog .shortcut-scroll', 'block-size:min(100%,384px)!important', 'max-block-size:min(384px,calc(100vh - 376px))!important', 'margin-block-end:10px!important', '.waveform-shortcuts-dialog .shortcut-grid', 'grid-template-columns:minmax(260px,1fr) minmax(96px,132px) minmax(76px,108px) 70px!important', '.waveform-shortcuts-dialog .shortcut-actions', 'inline-size:112px!important', '@media(min-height:860px)', '[data-testid="pyqt-waveform_shortcut_toggle_event_scope"]']) assert.ok(waveformShortcutsDialog.includes(phrase), phrase);
  assert.doesNotMatch(waveformShortcutsDialog, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow/);
  assert.doesNotMatch(foundation, waveformShortcutsDialogSelectors);
  assert.doesNotMatch(sharedTheme, waveformShortcutsDialogSelectors);
  for (const phrase of ['Load Detection dialog owner', '.load-detection-dialog', 'width:min(760px,calc(100vw - 48px))!important', '.load-detection-dialog>.helper-copy', 'background:transparent!important', '.session-load-row', 'grid-template-columns:minmax(0,1fr) minmax(132px,max-content)!important', '.load-detection-dialog .status-line', 'min-block-size:auto!important', '.load-detection-dialog .modal-actions', '.load-detection-dialog .modal-actions button', 'inline-size:128px!important', '@media(max-width:760px)']) assert.ok(loadDetectionDialog.includes(phrase), phrase);
  assert.doesNotMatch(loadDetectionDialog, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|waveform-tool-group|toolbar-field|pyqt-top-toolbar|pyqt-toolbar-row|pyqt-toolbar-action|pyqt-toolbar-overflow|pyqt-actionLoad_Detection_toolbar/);
  assert.doesNotMatch(foundation, loadDetectionDialogSelectors);
  assert.doesNotMatch(sharedTheme, loadDetectionDialogSelectors);
  assert.doesNotMatch(channelModal, loadDetectionDialogSelectors);
  for (const phrase of ['Channel/Bipolar dialog owner', '.channel-dialog', 'grid-template-rows:auto auto minmax(120px,.8fr) minmax(180px,1fr) auto!important', '.bipolar-dialog', '.channel-dialog-scroll', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.channel-dialog .channel-choice', '.bipolar-form-card', '.channel-dialog>.helper-copy', '.bipolar-dialog>.helper-copy', '.channel-dialog .selected-channels-dialog', '.channel-dialog .selected-channels-grid', 'grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr)!important', '.channel-dialog .selected-channel-list', 'letter-spacing:0!important', '.channel-dialog .compare-channel-scroll', '.channel-dialog .modal-actions', '.bipolar-dialog .modal-actions button', 'appearance:none!important']) assert.ok(channelModal.includes(phrase), phrase);
  assert.doesNotMatch(channelModal, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|event-review-dialog|pyqt-frequency_range_group/);
  assert.doesNotMatch(foundation, channelModalSelectors);
  assert.doesNotMatch(sharedTheme, channelModalSelectors);
  for (const phrase of ['Event Review detail owner', 'Event Review main layout owner', '.modal-backdrop:has(.event-review-dialog)', '.event-review-body', '.event-review-left-panel', 'box-shadow:0 22px 52px rgba(15,23,42,.3)!important', '.event-review-header .modal-window-close-button', '[data-testid="pyqt-annotation_close_button"]', 'pyqt-actionStart_Over', '.event-review-dialog .event-detail-card', 'pyqt-viewControlsGroupBox', 'pyqt-FFT_layout']) assert.ok(eventReviewDetail.includes(phrase), phrase);
  for (const phrase of ['Event Review side-stack source-order owner', 'pyqt-progressCard', 'pyqt-predictionScopeCard', 'pyqt-frequency_range_group', 'text-overflow:clip!important']) assert.ok(eventReviewSideStack.includes(phrase), phrase);
  for (const phrase of ['Event Review view controls owner', 'pyqt-viewControlsGroupBox', 'flex-wrap:wrap!important', 'flex:0 0 auto!important']) assert.ok(eventReviewViewControls.includes(phrase), phrase);
  for (const phrase of ['@media(max-width:1320px)', 'grid-template-columns:minmax(0,1.28fr) minmax(340px,.72fr)!important', 'grid-template-columns:repeat(2,minmax(0,1fr))!important']) assert.ok(eventReviewResponsive.includes(phrase), phrase);
  for (const phrase of ['Event Review shared form controls owner', '.event-review-dialog input:not([type="checkbox"])', '.event-review-dialog select', '.event-review-dialog label.select-toggle', 'grid-template-columns:16px minmax(0,1fr)!important', 'pyqt-UnannotatedOnlyCheckBox', 'transform:none!important']) assert.ok(eventReviewControls.includes(phrase), phrase);
  for (const phrase of ['Annotation progress/queue chrome owner', 'pyqt-progressCard', 'pyqt-progressTextbox', '.annotation-queue-row', '.annotation-queue-label', '.annotation-queue-row select']) assert.ok(eventReviewProgressFlow.includes(phrase), phrase);
  for (const phrase of ['Event Review right-column flow owner', '.event-review-dialog .event-detail-card', 'padding-block-end:var(--ui-modal-bottom-clearance)!important', '.event-review-dialog .annotation-side-stack{', 'display:contents!important', '.event-review-dialog .annotation-side-stack>*', 'flex:0 0 auto!important', '.event-review-dialog .event-detail-card>.status-line', 'overflow-wrap:anywhere!important']) assert.ok(eventReviewRightColumnFlow.includes(phrase), phrase);
  for (const phrase of ['Event Review annotation navigation owner', '.annotation-side-stack .annotation-navigation-row', 'display:flex!important', 'flex:1 1 76px!important', '@media(max-width:760px)']) assert.ok(eventReviewNavigationControls.includes(phrase), phrase);
  for (const phrase of ['Event Review prediction controls owner', 'pyqt-PredictionScopeBox', 'transform:none!important', 'pyqt-predictionScopeCard', 'min-inline-size:0!important']) assert.ok(eventReviewPredictionControls.includes(phrase), phrase);
  for (const phrase of ['Event Review frequency controls owner', 'pyqt-frequency_range_group', 'grid-template-columns:repeat(3,92px)!important', 'pyqt-spinBox_minFreq', 'pyqt-spinBox_maxFreq', 'pyqt-SetFreqLimit', 'scoped to the annotation dialog']) assert.ok(eventReviewFrequencyControls.includes(phrase), phrase);
  for (const phrase of ['Event Review detail actions owner', '.event-review-dialog .event-detail-card .annotation-detail-actions', 'position:static!important', 'display:grid!important', 'grid-template-columns:repeat(5,minmax(0,1fr))!important', 'inline-size:100%!important', 'font-size:var(--fs-xs)!important', 'grid-template-columns:repeat(2,minmax(0,1fr))!important']) assert.ok(eventReviewDetailActions.includes(phrase), phrase);
  for (const source of [eventReviewDetail, eventReviewSideStack, eventReviewViewControls, eventReviewResponsive, eventReviewControls, eventReviewProgressFlow, eventReviewRightColumnFlow, eventReviewNavigationControls, eventReviewPredictionControls, eventReviewFrequencyControls, eventReviewDetailActions]) assert.doesNotMatch(source, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|channel-dialog|bipolar-dialog|agent-panel-tab-strip/);
  assert.doesNotMatch(eventReviewDetail, /Event Review side-stack source-order owner|Event Review view controls owner|Event Review shared form controls owner|Annotation progress\/queue chrome owner|Event Review right-column flow owner|Event Review annotation navigation owner|Event Review frequency controls owner|Event Review detail actions owner/);
  assert.doesNotMatch(eventReviewControls, /annotation-navigation-row|pyqt-frequency_range_group|annotation-detail-actions|pyqt-PredictionScopeBox|right-column|progressCard/);
  assert.doesNotMatch(eventReviewProgressFlow, /pyqt-frequency_range_group|annotation-detail-actions|right-column non-overlap|pyqt-PredictionScopeBox|annotation-navigation-row button/);
  assert.doesNotMatch(eventReviewFrequencyControls, /(?:^|\n)\s*\[data-testid="pyqt-spinBox_minFreq"\]|(?:^|\n)\s*\[data-testid="pyqt-spinBox_maxFreq"\]|(?:^|\n)\s*\[data-testid="pyqt-SetFreqLimit"\]/);
  assert.doesNotMatch(foundation, eventReviewDialogSelectors);
  for (const phrase of ['Shared control sizing owner', '--ui-control-h:34px', '--ui-action-h:34px', '--ui-field-gap:8px', '--ui-control-radius:6px', '.workspace-tabs .tab-bar button', '.workspace-tab-panel button', '.panel-card button', '.modal-card button:not([data-pyqt-toolbutton-style="icon-only"])', '.modal-card input[type="checkbox"]', '.workspace-tab-panel input[type="checkbox"]', '.button-row,', '.field-grid,', '.field-unit,', '.agent-panel select']) assert.ok(controlSizing.includes(phrase), phrase);
  assert.doesNotMatch(controlSizing, /pyqt-waveform-toolbar|waveform-toolbar-row|display_time_window|go_to_time|pyqt-top-toolbar|pyqt-toolbar-row|waveform-header-actions/);
});

test('alignment audit scopes rows to real cards instead of whole dialogs', () => {
  const script = read('scripts/ui-alignment-audit.mjs');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['qa:alignment'].includes('ui-alignment-audit.mjs'));
  for (const phrase of [
    'pyqt-qd_action_rail',
    'pyqt-quick_detection_status_rail',
    'pyqt-quick-detector-card',
    'quick-classifier-card',
    'quick-detection-action-strip',
    'quick-detection-action-rail',
    'quick-classifier-model-grid',
    'sidebar-detection-params',
    'classifier-source-list',
    'detector-display-grid',
    'pyqt-batch_project_setup_card',
    'pyqt-batch_project_run_card',
    'pyqt-predictionScopeCard',
    'pyqt-frequency_range_group',
    'pyqt-annotation_detail_actions',
    'annotation-side-stack',
    'event-detail-card',
    'pyqt-waveform_shortcuts_scroll_area',
    '.shortcut-actions',
    'isIntentionalTitleBar',
    'modal-window-close-button',
    'isBinaryInputKind',
    'isFieldKind',
    'visibleClipRect',
    'clipRectFor',
    'non-checkbox controls',
    'field-column-width-mismatch',
    'same visual column',
    'isVisualCard',
    'annotation-plot-card',
    'structuralBlocks',
    'structuralInk',
    'partial scroll-viewport exposure',
  ]) assert.ok(script.includes(phrase), phrase);
});

test('PyQt subwindows expose visible close controls in the first viewport', () => {
  const css = read('src/styles/workspace.css');
  const files = [
    ['src/features/shell/QuickDetectionDialog.tsx', 'pyqt-quick_detection_close_button'],
    ['src/features/shell/EventReviewDialog.tsx', 'pyqt-annotation_close_button'],
    ['src/features/shell/LoadDetectionDialog.tsx', 'pyqt-load_detection_close_button'],
    ['src/features/shell/WaveformShortcutSettingsDialog.tsx', 'pyqt-waveform_shortcuts_close_button'],
    ['src/features/shell/ChannelSelectionDialog.tsx', 'pyqt-channel_selection_close_button'],
    ['src/features/shell/BipolarChannelDialog.tsx', 'pyqt-bipolar_close_button'],
    ['src/features/shell/BatchProjectDialog.tsx', 'pyqt-batch_project_close_button'],
    ['src/features/shell/RunStatisticsDialog.tsx', 'pyqt-run_stats_close_button'],
    ['src/features/shell/RecordingInfoDialog.tsx', 'pyqt-recording_info_close_button'],
    ['src/features/shell/RuntimeLogDialog.tsx', 'pyqt-runtime_log_close_button'],
  ];
  for (const [path, testId] of files) {
    const source = read(path);
    assert.ok(source.includes('modal-window-close-button'), path);
    assert.ok(source.includes(testId), testId);
  }
  for (const phrase of [
    'Modal chrome owner',
    '.modal-card>.modal-window-close-button',
    '.modal-window-close-button',
    'opacity:1!important',
    'pointer-events:auto!important',
    'visibility:visible!important',
    '.quick-detection-header .modal-window-close-button',
    '.event-review-header .modal-window-close-button',
    '[data-testid="pyqt-annotation_close_button"]',
    '[data-testid="pyqt-actionStart_Over"]',
  ]) assert.ok(css.includes(phrase), phrase);
});

test('waveform header recording info action remains a real visible control', () => {
  const css = read('src/styles/workspace.css');
  const shell = read('src/app/MainWindowShell.tsx');
  assert.ok(shell.includes('pyqt-recording_info_button'));
  assert.ok(css.includes('min-inline-size:48px!important'));
  assert.doesNotMatch(css, /\[data-testid="pyqt-recording_info_button"\]\s*\{[^}]*display:none/s);
  assert.doesNotMatch(css, /\[data-testid="pyqt-recording_info_button"\]\s*\{[^}]*position:absolute[^}]*inline-size:1px/s);
  assert.doesNotMatch(css, /\[data-testid="pyqt-recording_info_button"\]\s*\{[^}]*opacity:0[^}]*pointer-events:none/s);
});









test('macOS package smoke script assembles a real Electron app without new packager dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = read('scripts/package-macos-app.mjs');
  for (const phrase of ['createRequire', "require('electron')", 'Electron.app runtime', 'Contents/Resources/app', 'dist-electron', 'dist-renderer', 'PACKAGED_FROM.txt', 'PYHFO_PACKAGE_OUTPUT_APP']) assert.ok(script.includes(phrase), phrase);
  assert.ok(pkg.scripts['package:mac-smoke'].includes('npm run build'));
  assert.ok(pkg.scripts['package:mac-smoke'].includes('npm run qa:packaged'));
  assert.ok(pkg.scripts['package:mac-smoke'].includes('npm run qa:hf-onnx-runtime'));
});


test('product interaction audit makes skipped semantic interactions visible', () => {
  const script = read('scripts/product-interaction-audit.mjs');
  for (const phrase of [
    'product-interaction-audit.json',
    'static_data_testids_unreferenced_by_tests_or_scripts',
    'react_event_handler_props',
    'preload_ipc_invokes',
    'main_ipc_handlers',
    'missing_main_handlers',
    'missing_preload_exposure',
    'button-parity-audit.json',
    'electron-e2e-smoke.json',
    'electron-real-recording-smoke.json',
    'skipped_disabled_or_external_buttons',
    'skipped_disabled_native_or_backend_buttons',
    'Green smoke tests do not prove every product interaction has semantic assertions',
    'native_dialogs_project_session_exports',
    'backend_ipc_bridge',
    'waveform_interaction_matrix',
    'close_save_discard_lifecycle',
    'agent_batch_artifact_side_effects'
  ]) assert.ok(script.includes(phrase), phrase);
});


test('layout smoke gate enforces fixed workspace and VS Code-like agent layout contracts', () => {
  const script = read('scripts/layout-smoke.mjs');
  for (const phrase of ['viewport-bound main window', 'fixed left workspace with right docked agent rail', 'grid-template-columns:minmax(0,1fr) var(--agent-rail-width) var(--agent-effective-panel-width)!important', 'waveform/workflow splitter', 'annotation left fixed scroll pane', 'Event Review main layout owner', 'grid-template-columns:minmax(640px,1.25fr) minmax(390px,.75fr)!important', 'contain:layout paint!important', 'VS Code-like agent activity bar', 'required_test_ids', 'artifacts/layout-smoke.json', 'Static renderer layout smoke']) assert.ok(script.includes(phrase), phrase);
  assert.doesNotMatch(script, /max-inline-size:680px|clamp\(520px,48vw,680px\)/);
});

test('main process starts local Python backend and keeps renderer sandboxed', () => {
  const main = read('electron/main.ts');
  const backend = read('electron/pythonBackend.ts');
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(main, /safeDevServerUrl/);
  assert.match(main, /authorization/);
  for (const phrase of ['fileURLToPath(import.meta.url)', 'electronBundleDir', 'workspaceDirty', 'allowUnsafeClose', 'closeSaveInProgress', 'closeDiscardPromptInProgress', 'closePromptForState', 'closeSaveTimeout', 'setTimeout', 'clearTimeout', 'Save Project Timed Out', 'Project Save Still Running', "buttons: ['Keep Open', 'Discard Changes']", 'discardWorkspaceAndClose', "mainWindow.on('close'", 'dialog.showMessageBox', 'Discard Changes', 'Save Project', 'Discard Current Workspace', "action: 'save'", "action: 'discard'", "action: 'cancel'", "webContents.send('workspace:save-before-close')", 'completeSaveBeforeClose', 'workspace:save-before-close-result', 'confirmDiscardWorkspace', 'setDocumentEdited', 'workspace:set-dirty', 'workspace:confirm-discard', 'setWorkspaceDirty']) assert.ok(main.includes(phrase), phrase);
  assert.match(backend, /randomBytes\(24\)/);
  assert.match(backend, /127\.0\.0\.1/);
  assert.match(backend, /pyhfo\.agent_api\.server/);
  assert.match(backend, /waitForHealth/);
  assert.match(backend, /authorization/);
  for (const phrase of ['findFreePort', 'configuredPort(process.env.PYHFO_BACKEND_PORT) ?? await findFreePort()', 'configuredStartupTimeoutMs(process.env.PYHFO_BACKEND_STARTUP_TIMEOUT_MS)', "child.once('exit'", 'waitForHealth(baseUrl, token, startupTimeoutMs, child, logs)', 'PyHFO backend exited before becoming healthy']) assert.ok(backend.includes(phrase), phrase);
  for (const phrase of ['backendDiagnostics', 'endpointLabel', 'PyHFO backend request failed before response', 'Network error:', 'responseText', 'PyHFO backend returned a non-JSON response']) assert.ok(main.includes(phrase), phrase);
});

test('preload exposes narrow ieeg API without filesystem primitives', () => {
  const preload = read('electron/preload.cts');
  assert.match(preload, /contextBridge\.exposeInMainWorld\('ieeg'/);
  assert.doesNotMatch(preload, /readFile|writeFile|exec\(/);
  for (const method of ['getBackendStatus', 'openRecording', 'openSavedSession', 'openProjectFile', 'openClassifierModel', 'saveProtocolPreset', 'openProtocolPreset', 'openBatchInputDirectory', 'openBatchOutputDirectory', 'createProject', 'openProject', 'saveProject', 'setWorkspaceDirty', 'confirmDiscardWorkspace', 'completeSaveBeforeClose', 'onSaveBeforeClose', 'loadSavedSession', 'loadRecording', 'analyzeRecordingRoi', 'analyzeRecordingQc', 'analyzeRecordingSpectral', 'prepareRecording', 'requestWaveformWindow', 'sendAgentMessage', 'exportSession', 'exportReport', 'saveReportExport', 'exportWorkbook', 'savePngSnapshot', 'saveReportExport', 'openArtifactPath', 'revealArtifactPath']) assert.match(preload, new RegExp(method));
});


test('browser preview uses a safe fallback when Electron preload is absent', () => {
  const client = read('src/api/backendClient.ts');
  for (const phrase of ['type IeegBridge', 'ieeg?: IeegBridge', 'browserPreviewBridge', 'Electron preload bridge unavailable', 'open the packaged Electron app', 'setWorkspaceDirty: () => Promise.resolve', 'onSaveBeforeClose: () => () => undefined', 'window.ieeg ?? browserPreviewBridge', 'ieegBridge().getBackendStatus()', 'ieegBridge().requestWaveformWindow(request)']) assert.ok(client.includes(phrase), phrase);
});



test('batch project dialog exposes resumable manifest and run workflow', () => {
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const toolbar = read('src/features/shell/TopToolbar.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const dialog = read('src/features/shell/BatchProjectDialog.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['create_batch', 'run_batch', '"/batch/create"', '"/batch/run"', 'session.last_batch']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['batch:open-input-directory', 'batch:open-output-directory', 'batch:create', 'batch:run', 'lastBatchInputDirectory', 'lastBatchOutputDirectory']) assert.ok(main.includes(phrase), phrase);
  for (const phrase of ['openBatchInputDirectory', 'openBatchOutputDirectory', 'createBatchProject', 'runBatch']) assert.ok(preload.includes(phrase) && client.includes(phrase), phrase);
  for (const phrase of ['pyqt-actionBatch_Project_toolbar', 'Batch Project']) assert.ok(toolbar.includes(phrase), phrase);
  for (const phrase of ['BatchProjectDialog', "'batchProject'", "onBatchProject={() => setActiveDialog('batchProject')}", "activeDialog === 'batchProject'", "openAgentTab('Artifacts')"]) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-batch_project_window', 'pyqt-batch_input_dir_input', 'pyqt-batch_output_dir_input', 'pyqt-batch_create_manifest_button', 'pyqt-batch_run_button', 'pyqt-batch_case_table', 'prepareFilterPayload', 'backendClient.createBatchProject', 'backendClient.runBatch', 'detectorTabsByBiomarker', 'retry_failed', 'fail_fast']) assert.ok(dialog.includes(phrase), phrase);
  assert.ok(css.includes('Batch project parity'));
  assert.ok(css.includes('batch-project-dialog'));
});

test('protocol presets export and import detector settings through native dialogs', () => {
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const detector = read('src/features/shell/DetectorForms.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['protocolPresetDefaultName', 'saveProtocolPresetWithDialog', 'openProtocolPresetWithDialog', 'protocol-preset:save-dialog', 'protocol-preset:open-dialog', 'lastProtocolDirectory', 'PyBrain Protocol Preset']) assert.ok(main.includes(phrase), phrase);
  assert.ok(detector.includes('pybrain-protocol-preset'));
  for (const phrase of ['saveProtocolPreset', 'openProtocolPreset']) assert.ok(preload.includes(phrase) && client.includes(phrase), phrase);
  for (const phrase of ['ProtocolPreset', 'buildProtocolPreset', 'restoreProtocolPreset', "format: 'pybrain-protocol-preset'", 'prepareControls', 'detector_params: detectorParamsForRun', 'pyqt-protocol_preset_actions', 'pyqt-protocol_export_button', 'pyqt-protocol_import_button', 'Export Protocol', 'Import Protocol', 'onBiomarkerChange(restored.biomarker)', 'onPrepareControlsChange(restored.prepareControls)', 'restoreProtocolPrepareControls', 'protocolPositiveInteger', 'Prepare/filter/N Jobs restored', 'setAppliedFingerprints']) assert.ok(detector.includes(phrase), phrase);
  assert.ok(shell.includes('onBiomarkerChange={setBiomarker}'));
  assert.ok(css.includes('protocol-preset-actions'));
});

test('renderer shell follows PyQt-functional parity layout instead of dashboard placeholders', () => {
  const shell = [read('src/app/MainWindowShell.tsx'), read('src/features/shell/TopToolbar.tsx'), read('src/features/shell/BiomarkerBar.tsx'), read('src/features/shell/WaveformToolbar.tsx'), read('src/features/shell/WorkspaceTabs.tsx'), read('src/features/shell/RecordingInfoDialog.tsx'), read('src/features/shell/RuntimeLogDialog.tsx')].join('\n');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['pyqt-top-toolbar', 'Biomarker Type:', 'Open Recording', 'Load Detection', 'Quick Detection', 'action_Open_EDF', 'action_Load_Detection', 'Waveform Shortcuts', 'Status Log', 'pyqt-actionStatus_Log_toolbar', 'pyqt-workflowHeader', 'pyqt-workflowSteps', 'pyqt-activity_level_dot', 'pyqt-activity_summary_label', 'Load Data', 'Choose Channels', 'Configure Analysis', 'Review Results', 'Annotate / Export', 'Number of Channels to Display', 'Display Time Window', 'Normalize Vertically', 'Toggle Filtered', 'Prepare', 'Detect', 'Classify', 'Workers', 'pyqt-sidebar_n_jobs_spinbox', 'pyqt-sidebar_n_jobs_ok_button', 'pyqt-recording_info_button', 'RecordingInfoDialog', 'RuntimeLogDialog']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['PYQT_BIOMARKER_LEGEND_COLORS', 'PYQT_BIOMARKER_LEGEND_COLORS.hfo', 'PYQT_BIOMARKER_LEGEND_COLORS.artifact', 'PYQT_BIOMARKER_LEGEND_COLORS.spike', 'PYQT_BIOMARKER_LEGEND_COLORS.ehfo']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['waveformControls={waveformControls}', 'waveformSourceBadgePayload', 'waveformScopeBadgePayload', 'waveformToolBadgePayload', 'pyqt-waveform_source_mode_badge', 'pyqt-waveform_scope_mode_badge', 'pyqt-waveform_tool_mode_badge', 'badges.length', 'Auto: Bipolar', 'Avg', 'Filtered', '60 Hz notch', 'Normalized', 'Scope Custom', 'Events', 'Scope Highlight', 'Tool Cursor', 'Tool Measure', 'data-active']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['WORKSPACE_SPLIT_STORAGE_KEY', 'WORKSPACE_SPLIT_LAYOUT_VERSION_STORAGE_KEY', 'ieeg.workspaceSplitPercent', 'ieeg.workspaceSplitLayoutVersion', 'pyqt-horizontal-waveform-tabs-split-2026-06-02', 'workspaceSplitPercent', 'DEFAULT_WORKSPACE_SPLIT_PERCENT = 62', 'MAX_WORKSPACE_SPLIT_PERCENT = 82', 'workflowPanelExpanded', 'openWorkflowTab', 'closeWorkflowPanel', 'data-workflow-expanded', 'data-active-workflow-tab', 'collapsed={!workflowPanelExpanded}', 'onCollapse={closeWorkflowPanel}', 'pyqt-subpage_back_to_main_button', 'Close', 'return_to_main_button', 'quickDetectionMetadata', 'metadata={quickDetectionMetadata || metadata}', 'beginWorkspaceSplitResize', 'pyqt-loaded_workspace_splitter_handle', 'aria-orientation="vertical"', 'Resize waveform and workflow tabs', '--workspace-waveform-percent', 'WaveformHeaderModeBadges', 'waveform-header-title-row', 'waveform-header-mode-badges', 'waveformHeaderRecordingLabel', 'visual-fixture-pyqt-visible-order', 'visual_fixture_raw.fif • 200 Hz • 8 channels • 10 s', 'statusStripMessage', '? "Ready"', 'workflow-waveform-metadata']) assert.ok(shell.includes(phrase), phrase);
  assert.ok(css.includes('pyqt-main-window'));
  assert.ok(css.includes('agent-activity-bar'));
  assert.ok(css.includes('PyQt waveform context badges parity'));
  assert.ok(css.includes('.waveform-mode-badges span[data-active="true"]'));
  assert.ok(css.includes('PyQt loaded workspace splitter parity'));
  assert.ok(css.includes('loaded-workspace-splitter-handle'));
  assert.ok(css.includes('Recording Information dialog owner'));
  assert.ok(css.includes('Runtime Log dialog owner'));
  for (const phrase of ['.status-strip,', '.pyqt-workspace-shell>.status-strip', 'grid-template-columns:10px minmax(0,1fr) auto!important', 'pyqt-status_log_open_button', 'Waveform chrome owner', '.status-strip{']) assert.ok(css.includes(phrase), phrase);
  assert.ok(css.includes('PyQt workflowHeader/workflowSteps parity'));
  assert.ok(css.includes('PyQt main waveform dominance parity'));
  assert.ok(css.includes('PyQt main-window empty/loaded layout unification, authoritative'));
  assert.ok(css.includes('.pyqt-workspace-shell>.workflow-progress-strip'));
  assert.ok(css.includes('display:none!important'));
  assert.ok(css.includes('PyQt loaded biomarker-header relocation parity'));
  assert.ok(css.includes('visibility:hidden'));
  assert.ok(css.includes('pointer-events:none'));
  assert.ok(css.includes('grid-template-rows:42px 0 0 62px 64px minmax(0,1fr) 28px'));
  for (const phrase of ['.pyqt-workspace-shell[data-loaded="true"] .loaded-workspace', '.pyqt-workspace-shell[data-loaded="true"]>.biomarker-bar', 'visibility:hidden', 'waveform-header-mode-badges', 'PyQt loaded waveform canvas adjacency parity', '.waveform-stage>.waveform-pane .waveform-meta', 'clip:rect(0,0,0,0)', 'grid-template-rows:minmax(0,1fr)']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['PyQt waveform overview/range band parity', '.waveform-overview-axis', '.waveform-overview-track', '.waveform-overview-window', '.waveform-overview-ticks', 'grid-template-rows:minmax(0,1fr) 34px 18px']) assert.ok(css.includes(phrase), phrase);
  assert.ok(css.includes('grid-template-columns:minmax(220px,var(--workspace-waveform-percent,62%)) 8px minmax(0,1fr)'));
  assert.ok(css.includes('PyQt horizontal waveform|tabs split parity'));
  assert.ok(css.includes('cursor:col-resize'));
  for (const phrase of ['PyQt main-window empty/loaded layout unification, authoritative', '.loaded-workspace[data-workflow-expanded="false"]', '.subpage-back-button']) assert.ok(css.includes(phrase), phrase);
  assert.ok(css.includes('PyQt status strip and Case Inspector Run Actions parity'));
  assert.doesNotMatch(css, /grid-template-columns:220px 1fr 360px/);
});

test('main shell exposes PyQt workflow header status chips and step guide', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['WorkflowProgressStrip', 'pyqt-workflowHeader', 'pyqt-workflow_subtitle_label', 'pyqt-workflow_status_label', 'pyqt-workflow_status_chips', 'pyqt-status_loaded_chip', 'pyqt-status_channels_chip', 'pyqt-status_filter_chip', 'pyqt-status_detect_chip', 'pyqt-status_classify_chip', 'pyqt-status_annotate_chip', 'pyqt-workflowSteps', 'pyqt-workflow_step_card', 'workflow-chip-row', 'workflow-step-row', 'workflow-step-card']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['workflow-progress-strip', 'grid-template-rows:48px 44px 118px 58px 96px minmax(0,1fr) 32px', 'overflow:auto', 'scrollbar-gutter:stable']) assert.ok(css.includes(phrase), phrase);
});

test('prepare case console left pane is fixed-size and scroll-contained', () => {
  const css = read('src/styles/workspace.css');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  for (const phrase of [
    'Prepare workbench scroll owner',
    '.workspace-tab-panel[data-active-tab="Prepare"]>.prepare-grid',
    'grid-auto-rows:min-content!important',
    'overflow:auto!important',
    'grid-template-columns:minmax(0,1fr)!important',
    '.case-console-workspace',
    'scrollbar-gutter:stable both-edges',
    '@media(max-width:1100px)'
  ]) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['workflow-case-console', 'pyqt-case_workspace_body', 'pyqt-configure_column', 'pyqt-review_settings_column']) assert.ok(tabs.includes(phrase), phrase);
});

test('left workspace and annotation review pane are fixed-size scroll containers', () => {
  const css = read('src/styles/workspace.css');
  const dialog = read('src/features/shell/EventReviewDialog.tsx');
  for (const phrase of [
    'User-requested fixed-scroll contract: the left PyQt workspace column stays fixed to the viewport',
    '.pyqt-main-window',
    'inline-size:100vw',
    'block-size:100vh',
    '.pyqt-workspace-shell',
    'max-block-size:100vh',
    '.workspace-tab-panel[data-active-tab="Prepare"] .case-console-column',
    'overflow:auto',
    'overscroll-behavior:contain',
    'scrollbar-gutter:stable both-edges'
  ]) assert.ok(css.includes(phrase), phrase);
  for (const phrase of [
    'Event Review detail owner',
    'Event Review main layout owner',
    '.modal-backdrop:has(.event-review-dialog)',
    'grid-template-rows:40px minmax(0,1fr)!important',
    'grid-template-columns:minmax(640px,1.25fr) minmax(390px,.75fr)!important',
    'overflow:hidden!important',
    'contain:layout paint!important',
    '[data-testid="pyqt-TimeFrequencyPlot"]',
    'grid-template-rows:20px minmax(0,1fr)!important',
    '[data-testid="pyqt-viewControlsGroupBox"]',
    'min-block-size:38px!important',
    'Event Review view controls owner',
    '.event-review-left-panel .event-table',
    'display:none!important',
    'annotation-side-stack',
    '.event-review-header',
    'position:static!important',
    'Event Review side-stack source-order owner',
    'Event Review right-column flow owner',
    'Event Review shared form controls owner',
    'Event Review frequency controls owner',
    'Event Review detail actions owner',
    '.event-review-dialog .annotation-side-stack>*',
    'flex:0 0 auto!important',
    'grid-template-columns:repeat(3,92px)!important',
    'flex:1 1 120px!important'
  ]) assert.ok(css.includes(phrase), phrase);
  assert.ok(dialog.includes('pyqt-annotation_left_scroll_pane'));
  assert.ok(dialog.includes('pyqt-annotation_side_stack'));
});

test('recording info dialog exposes PyQt-style EDF metadata subwindow', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const dialog = read('src/features/shell/RecordingInfoDialog.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ["'recordingInfo'", 'RecordingInfoDialog', "setActiveDialog('recordingInfo')", 'activeDialog === "recordingInfo"', 'pyqt-recording_info_button', 'metadata={metadata}', 'recordingPath={recordingPath}', 'onClose={closeActiveDialog}']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-recording_info_backdrop', 'recording-info-backdrop', 'aria-modal="false"', 'pyqt-recording_info_dialog', 'pyqt-recording_info_summary_card', 'pyqt-recording_info_filename', 'pyqt-recording_info_input_path', 'pyqt-recording_info_sample_frequency', 'pyqt-recording_info_channel_count', 'pyqt-recording_info_length', 'pyqt-recording_info_channel_card', 'pyqt-recording_info_channel_list', 'pyqt-recording_info_channel_row', 'pyqt-recording_info_raw_metadata', 'pyqt-recording_info_metadata_row', 'recordingMetadataRows', 'formatMetadataValue']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['Recording Information dialog owner', 'recording-info-dialog', 'recording-info-channel-list', 'recording-info-raw-card', '.recording-info-dialog .recording-info-grid dt', 'pyqt-recording_info_button']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(shell, /recordingInfoOpen|onCloseRecordingInfo|presentation="sidebar"/);
  assert.doesNotMatch(dialog, /presentation\?:|"sidebar"|recording-info-inline-host/);
  assert.doesNotMatch(css, /recording-info-inline-host/);
});

test('VS Code-like agent panel is additive and closed by default', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const activity = read('src/features/agent/AgentActivityBar.tsx');
  const panel = read('src/features/agent/AgentPanel.tsx');
  const css = read('src/styles/workspace.css');
  assert.match(shell, /useState\(false\)/);
  for (const phrase of ['agent-activity-bar', 'Chat', 'Actions', 'Artifacts', 'Safety']) assert.ok(activity.includes(phrase) || panel.includes(phrase), phrase);
  for (const phrase of ['AgentActionsTab', 'AgentArtifactsTab', 'commandHistory', 'filterHistory(commandHistory', 'sourceFilter', 'statusFilter', 'agent-command-toolbar', 'agent-command-source-filter', 'agent-command-status-filter', 'agent-command-history', 'agent-command-card', 'agent-command-diff', 'agent-staged-command-count', 'agent-command-filter-count', 'agent-command-apply', 'agent-command-dismiss', 'formatCommandDiff', 'commandDiffSnapshot', 'Before / after diff', 'staged, applied, and rejected', 'agent-action-list', 'agent-artifact-list', 'agent-current-operation', 'agent-artifact-open', 'agent-artifact-reveal', 'agent-artifact-copy', 'agent-artifact-remove', 'agent-artifact-clear', 'agent-artifacts-persistence', 'AGENT_ARTIFACT_FILTERS', 'AgentArtifactFilter', 'AGENT_ARTIFACT_COLLAPSED_STORAGE_KEY', 'ieeg.agentArtifactCollapsedGroups', 'loadPersistedArtifactCollapsedGroups', 'persistArtifactCollapsedGroups', 'artifactTypeCounts', 'artifactFilterLabel', 'artifactMatchesSearch', 'groupArtifactsByRunOrProject', 'workspaceArtifactGroupLabel', 'collapsedGroups', 'toggleArtifactGroup', 'setArtifactGroupCollapsed', 'handleArtifactGroupKeyDown', "event.key === 'ArrowLeft'", "event.key === 'ArrowRight'", 'agent-artifact-group-toggle', 'aria-expanded', 'data-collapsed', '▸', '▾', 'agent-artifact-group', 'Run ${key.slice(4)}', 'Workspace inputs', 'agent-artifact-type-filter', 'agent-artifact-filter-count', 'agent-artifact-search-input', 'filteredArtifacts', 'artifactGroups', 'Label, path, run, type, source', 'runtimeOperation', 'runtimeLog', 'artifacts']) assert.ok(panel.includes(phrase), phrase);
  for (const phrase of ['AGENT_PANEL_WIDTH_STORAGE_KEY', 'ieeg.agentPanelWidth', 'AGENT_PANEL_TAB_STORAGE_KEY', 'ieeg.agentPanelTab', 'loadAgentPanelTab', 'isAgentPanelTab', 'agentTab', 'closeAgentPanelFromEscape', "event.key !== 'Escape'", 'isTargetInsideAgentPanel', 'window.localStorage.setItem(AGENT_PANEL_TAB_STORAGE_KEY, agentTab)', 'agentPanelWidth', 'beginAgentPanelResize', 'agent-panel-resize-handle', 'Resize Agent panel', '--agent-panel-width']) assert.ok(shell.includes(phrase) || activity.includes(phrase) || panel.includes(phrase), phrase);
  for (const phrase of ['resizeAgentPanelByKeyboard', 'type KeyboardEvent as ReactKeyboardEvent', 'event.key === "ArrowLeft"', 'event.key === "ArrowRight"', 'event.key === "Home"', 'event.key === "End"', 'event.shiftKey ? 48 : 24', 'aria-valuemin={MIN_AGENT_PANEL_WIDTH}', 'aria-valuemax={MAX_AGENT_PANEL_WIDTH}', 'aria-valuenow={agentPanelWidth}', 'aria-valuetext={`${agentPanelWidth}px`}', 'tabIndex={0}', 'onKeyDown={resizeAgentPanelByKeyboard}']) assert.ok(shell.includes(phrase), phrase);
  assert.ok(css.includes('VS Code-like Agent panel resizing'));
  assert.ok(css.includes('Docked agent layout'));
  assert.ok(css.includes('Agent panel production content'));
  assert.ok(css.includes('Persistent Agent artifacts controls'));
  assert.ok(css.includes('Agent Actions command history'));
  assert.ok(css.includes('agent-command-toolbar'));
  assert.ok(css.includes('agent-command-card'));
  assert.ok(css.includes('[data-command-status="staged"]'));
  assert.ok(css.includes('agent-artifact-filter-row'));
  assert.ok(css.includes('agent-artifact-search'));
  assert.ok(css.includes('agent-artifact-group'));
  assert.ok(css.includes('[data-collapsed="true"]'));
  assert.ok(css.includes('Docked agent layout'));
  assert.ok(css.includes('.pyqt-main-window[data-agent-open="true"] .agent-panel'));
  assert.ok(css.includes('grid-template-columns:minmax(0,1fr) var(--agent-rail-width) var(--agent-effective-panel-width)!important'));
  assert.ok(css.includes('cursor:col-resize'));
  for (const phrase of ['AGENT_PANEL_TABPANEL_IDS', 'id={AGENT_PANEL_TABPANEL_IDS.Chat}', 'aria-label="Agent chat"', 'agent-chat-transcript', 'agent-chat-empty', 'agent-context-chip', 'agent-chat-composer', 'agent-composer-footer', 'agent-message-card', 'agent-message-role', 'Agent prompt', 'handleChatSubmit']) assert.ok(panel.includes(phrase) || shell.includes(phrase), phrase);
  for (const phrase of ['handleComposerKeyDown', "event.key !== 'Enter'", 'event.shiftKey', 'event.nativeEvent.isComposing', 'event.preventDefault()', 'onKeyDown={handleComposerKeyDown}', 'Shift+Enter for a new line']) assert.ok(panel.includes(phrase), phrase);
  for (const phrase of ['data-agent-activity-tab', 'role="toolbar"', 'aria-orientation="vertical"', 'AGENT_ACTIVITY_BUTTON_IDS', 'handleActivityKeyDown', "event.key === 'ArrowDown'", "event.key === 'ArrowUp'", "event.key === 'Home'", "event.key === 'End'", 'requestAnimationFrame(() => document.getElementById(AGENT_ACTIVITY_BUTTON_IDS[nextTab])?.focus())', 'onKeyDown={(event) => handleActivityKeyDown(event, tab.id)}', 'aria-pressed={activeTab === tab.id && isOpen}', 'aria-controls={`agent-panel-${tab.id.toLowerCase()}-tabpanel`}', 'activity-icon', 'activity-label', 'Chat transcript and prompt composer', 'Action trace, staged commands, and runtime log', 'Artifacts, reports, snapshots, and exports', 'Safety, context, and clinical-boundary checks']) assert.ok(activity.includes(phrase), phrase);
  for (const phrase of ['Agent panel shell/dock owner', 'grid-template-rows:44px max-content minmax(0,1fr)', '.agent-chat-transcript', '.agent-chat-composer', 'position:sticky', '.agent-activity-bar button::before', '.agent-activity-bar .activity-icon', '.agent-activity-bar .activity-label', '.sr-only']) assert.ok(css.includes(phrase), phrase);
  const app = read('src/app/App.tsx');
  const client = read('src/api/backendClient.ts');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  for (const phrase of ['uiCommandHistory', 'setUiCommandHistory', 'agentWorkspaceState', 'recordUICommand', 'ingestAgentUICommands', 'extractAgentUICommands', 'pollAgentChatResult', 'backendClient.getAgentChatResult', 'ui_commands', 'requires_confirmation', 'applyStagedUICommand', 'dismissStagedUICommand', 'executeAppliedUICommand', 'focusWaveformOnCommandEvent', 'applyUICommand', 'workspace.show_toast', 'agent.show_trace_step', "command.type === 'detection.select_run'", "command.type === 'waveform.set_viewport'", "command.type === 'recording.select_channel'", "command.type === 'waveform.focus_channel'", "command.type === 'waveform.center_event'", "command.type === 'events.stage_annotation'", "command.type === 'events.clear_staged_annotation'", 'void annotateEvent(eventId, label', "void annotateEvent(eventId, 'clear'", "'clinician', 'agent-proposal-clinician-confirmed'", 'backendAnnotationLabel', 'display_label: label', 'pathological', 'physiological', 'real', 'activateRun(String(command.payload.run_id', 'selectReviewEventForCursor(event)', 'void updatePlot(nextControls)', 'setWaveformControls(nextControls)', 'uiCommandHistory={uiCommandHistory}', 'onApplyStagedCommand={applyStagedUICommand}', 'onDismissStagedCommand={dismissStagedUICommand}', 'agentArtifacts', 'recordAgentArtifact', 'recordDetectionArtifacts', 'openAgentArtifact', 'onOpenAgentArtifact', 'savePngSnapshot', 'AGENT_ARTIFACTS_STORAGE_KEY', 'ieeg.agentArtifacts', 'loadPersistedAgentArtifacts', 'persistAgentArtifacts', 'clearAgentArtifacts', 'revealAgentArtifact', 'removeAgentArtifact', 'MAX_AGENT_ARTIFACTS']) assert.ok(app.includes(phrase) || shell.includes(phrase), phrase);
  assert.ok(client.includes('openArtifactPath') && client.includes('revealArtifactPath') && client.includes('getAgentChatResult'));
  assert.ok(main.includes('artifact:open-path') && main.includes('shell.openPath'));
  assert.ok(main.includes('artifact:reveal-path') && main.includes('shell.showItemInFolder'));
  assert.ok(main.includes('agent:chat-result') && main.includes('getAgentChatResult'));
  assert.ok(preload.includes('artifact:open-path') && preload.includes('artifact:reveal-path') && preload.includes('agent:chat-result'));
  assert.doesNotMatch(shell, /right-dock|left-rail|bottom-panel/);
});

test('parity manifest tracks shell, waveform, and agent groups', () => {
  const manifest = read('src/parity/pyqtParityManifest.ts');
  for (const phrase of ['actionOpen_EDF_toolbar', 'recent_recordings', 'recording.recent-list', 'actionLoad_Detection_toolbar', 'actionQuick_Detection_toolbar', 'actionWaveform_Shortcuts_toolbar', 'workflowHeader', 'workflowSteps', 'activity_summary_label', 'run_actions_card', 'combo_box_biomarker', 'QSplitter(Qt.Vertical)', 'workspace.loaded-splitter', 'ChannelSelectionWindow', 'selected_channels.ui', 'BipolarChannelSelectionWindow', 'n_channel_input', 'display_time_window_input', 'agent.activity-bar', 'main-shell', 'waveform', 'agent']) assert.ok(manifest.includes(phrase), phrase);
  const implementedManifestPhrases = [
    "id: 'dialog.channel-selection', pyqtObject: 'ChannelSelectionWindow', label: 'Choose visible channels', group: 'waveform', status: 'implemented'",
    "id: 'dialog.selected-channels', pyqtObject: 'selected_channels.ui', label: 'Channel to Annotate / Compare To', group: 'waveform', status: 'implemented'",
    "id: 'dialog.bipolar-selection', pyqtObject: 'BipolarChannelSelectionWindow', label: 'Create bipolar channel', group: 'waveform', status: 'implemented'",
    "id: 'waveform.channels-count', pyqtObject: 'n_channel_input', label: 'Number of Channels to Display', group: 'waveform', status: 'implemented'",
    "id: 'waveform.time-window', pyqtObject: 'display_time_window_input', label: 'Display Time Window', group: 'waveform', status: 'implemented'",
    "id: 'waveform.time-increment', pyqtObject: 'Time_Increment_Input', label: 'Display Time Window Increment', group: 'waveform', status: 'implemented'",
    "id: 'waveform.amplitude', pyqtObject: 'waveform_amplitude_input', label: 'Amp', group: 'waveform', status: 'implemented'",
    "id: 'waveform.go-to-time', pyqtObject: 'go_to_time_input', label: 'Go', group: 'waveform', status: 'implemented'",
    "id: 'waveform.normalize', pyqtObject: 'normalize_vertical_input', label: 'Normalize Vertically', group: 'waveform', status: 'implemented'",
    "id: 'waveform.filtered', pyqtObject: 'toggle_filtered_checkbox', label: 'Toggle Filtered', group: 'waveform', status: 'implemented'",
    "id: 'waveform.filter60', pyqtObject: 'Filter60Button', label: '60 Hz', group: 'waveform', status: 'implemented'",
    "id: 'waveform.bipolar', pyqtObject: 'bipolar_button', label: 'Bipolar/Montage', group: 'waveform', status: 'implemented'",
    "id: 'waveform.choose-channels', pyqtObject: 'Choose_Channels_Button', label: 'Channels', group: 'waveform', status: 'implemented'",
    "id: 'waveform.review-tools', pyqtObject: 'waveform_toolbar_frame', label: 'Event/review waveform tools', group: 'waveform', status: 'implemented'",
    "id: 'dialog.quick-detection', pyqtObject: 'QuickDetection', label: 'Quick Detection', group: 'quick-detection', status: 'implemented'",
    "id: 'detect.hfo-forms', pyqtObject: 'detector_subtabs', label: 'HFO detector parameter forms', group: 'detect', status: 'implemented'",
    "id: 'detect.spindle-forms', pyqtObject: 'detector_subtabs', label: 'Spindle detector parameter forms', group: 'detect', status: 'implemented'",
    "id: 'detect.spike-form', pyqtObject: 'detector_subtabs', label: 'Spike detector parameter form', group: 'detect', status: 'implemented'",
    "id: 'classifier.mode-header', pyqtObject: 'classifier_mode_combo', label: 'Classifier preset and classify action', group: 'classifier', status: 'implemented'",
    "id: 'classifier.local-models', pyqtObject: 'groupBox', label: 'Local classifier model sources', group: 'classifier', status: 'implemented'",
    "id: 'classifier.hub-models', pyqtObject: 'groupBox_2', label: 'Hugging Face classifier model sources', group: 'classifier', status: 'implemented'",
    "id: 'classifier.stack', pyqtObject: 'classifier_groupbox_4', label: 'Classifier stack overview and run button', group: 'classifier', status: 'implemented'",
    "id: 'review.run-registry', pyqtObject: 'run_table', label: 'Run registry and decision desk', group: 'review', status: 'implemented'",
    "id: 'review.active-run', pyqtObject: 'active_run_name_label', label: 'Active run snapshot', group: 'review', status: 'implemented'",
    "id: 'review.annotation-window', pyqtObject: 'Annotation', label: 'Event-by-event annotation window', group: 'review', status: 'implemented'",
    "id: 'review.annotation-waveform', pyqtObject: 'AnnotationPlot', label: 'Annotation waveform snippet pane', group: 'review', status: 'implemented'",
    "id: 'review.annotation-fft', pyqtObject: 'FFT_layout', label: 'Annotation FFT/frequency pane', group: 'review', status: 'implemented'",
    "id: 'review.annotation-view-controls', pyqtObject: 'SyncViewsCheckBox', label: 'Annotation Sync X, history, snapshot controls', group: 'review', status: 'implemented'",
    "id: 'review.backend-events', pyqtObject: 'list_events', label: 'Review events, annotations, overlap review backend bridge', group: 'review', status: 'implemented'"
  ];
  for (const phrase of implementedManifestPhrases) assert.ok(manifest.includes(phrase), phrase);
});

test('ui command validator covers stale conflicts, source history, diff states, and replay', () => {
  const commands = read('src/features/agent/uiCommands.ts');
  for (const phrase of ['stale or conflicting session command', "'user' | 'agent' | 'system'", "'staged' | 'applied' | 'rejected'", 'diffState', 'filterHistory', 'replayCommands']) assert.ok(commands.includes(phrase));
});

test('electron renderer unwraps sidecar action envelopes before updating PyQt parity state', () => {
  const app = read('src/app/App.tsx');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const sidecar = read('../pyhfo/src/pyhfo/agent_api/sidecar.py');
  for (const phrase of ['function unwrapSidecarResult<T>', "'result' in record", "typeof record.action === 'string' || 'state' in record", 'return record.result as T', 'unwrapSidecarResult<{ recording_info?: RecordingMetadata } & RecordingMetadata>', 'unwrapSidecarResult<PrepareRecordingResult>', 'unwrapSidecarResult<RecordingRoiSummary>', 'unwrapSidecarResult<RecordingQcSummary>', 'unwrapSidecarResult<RecordingSpectralSummary>', 'unwrapSidecarResult<DetectionRunResult>', "unwrapSidecarResult<RecordingAnalysisState['candidate_ranking']>"]) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['return session.dispatch("load_recording", payload)', 'return session.dispatch("infer_brain_signal_roi", payload)', 'return session.dispatch("compute_channel_qc", payload)', 'return session.dispatch("compute_spectral_profile", payload)', 'return session.dispatch("prepare_recording", payload)', 'return session.dispatch("run_detection", payload)', 'return session.dispatch("rank_candidate_channels", payload)']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['"status": "complete"', '"action": normalized', '"result": result', '"state": self.get_state()']) assert.ok(sidecar.includes(phrase), phrase);
});

test('bounded waveform client contract is present', () => {
  const client = read('src/api/backendClient.ts');
  const app = read('src/app/App.tsx');
  const workspace = read('src/app/workspaceState.ts');
  const shell = [read('src/app/MainWindowShell.tsx'), read('src/features/shell/WaveformToolbar.tsx')].join('\n');
  const canvas = read('src/features/waveform/WaveformCanvas.tsx');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const sidecar = read('../pyhfo/src/pyhfo/agent_api/sidecar.py');
  const waveformApi = read('../pyhfo/src/pyhfo/agent_api/waveform.py');
  assert.match(client, /target_samples_per_channel/);
  assert.match(client, /units\?:\s*string/);
  assert.match(client, /requestWaveformWindow/);
  for (const phrase of ['show_filtered?: boolean', 'filter_60hz?: boolean']) assert.ok(client.includes(phrase), phrase);
  for (const phrase of ['clampWaveformControls', 'selectedWaveformChannels', 'expandDerivedChannelsForRequest', 'materializeDerivedWaveform', 'chunkWaveformRequestChannels(requestChannels)', 'mergeWaveformWindowBatches(windows)', 'start_seconds: controls.startSeconds', 'duration_seconds: controls.timeWindowSeconds', "units: 'uV'", 'show_filtered: controls.showFiltered', 'filter_60hz: controls.filter60Hz', "resolvedMontage === 'averageReference'", "source: 'average_reference'", "'average_reference'", 'resolveMontageMode(controls.montageMode, metadata)', 'montageBipolarChannels(metadata, controls)', "source: bipolarApplied ? 'auto_bipolar'", 'montageStateForRecording(info)', 'normalizeMontageMode(payload.montage_mode)']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['MAX_WAVEFORM_REQUEST_CHANNELS = 32', 'chunkWaveformRequestChannels', 'mergeWaveformWindowBatches', 'At least one waveform window batch is required']) assert.ok(workspace.includes(phrase), phrase);
  for (const phrase of ['show_filtered=_bool(query, "show_filtered")', 'filter_60hz=_bool(query, "filter_60hz")', 'show_filtered=bool(args.get("show_filtered", False))', 'filter_60hz=bool(args.get("filter_60hz", False))', '_apply_waveform_filters', '_safe_notch_filter', 'filters_applied', 'filter_request', 'notch_60hz', 'bandpass_1_80hz']) assert.ok(server.includes(phrase) || sidecar.includes(phrase) || waveformApi.includes(phrase), phrase);
  for (const phrase of ['pyqt-channel_scroll_bar', 'pyqt-waveform_time_scroll_bar', 'channelStartIndex', 'startSeconds', 'onControlsChange', 'buildWaveformEventOverlays', 'runEventsByRun', 'eventOverlays', 'selectWaveformOverlayEvent', 'selectReviewEvent', 'navigateReviewEvent', 'focusHotspotChannels', 'canonicalWaveformChannel', 'hotspotChannelsFromEvents', 'handleWaveformWheelNavigation', 'WaveformWheelNavigation', 'WaveformMeasurementStatus', 'WaveformTrackpadSensitivity', 'waveformMeasurementStatus', 'updateWaveformMeasurementStatus', 'cursorEnabled={controls.cursorEnabled}', 'measureEnabled={controls.measureEnabled}', 'amplitudeScale={controls.amplitudeScale}', 'normalizeVertically={controls.normalizeVertically}', 'trackpadSensitivity={shortcutSettings.trackpadSensitivity}', 'trackpadSensitivity={trackpadSensitivity}', 'onMeasurementStatusChange', 'zoomWaveformTimeWindow', 'Math.exp(-zoomSteps * Math.log(1.25))', 'request.anchorRatio', 'timeWindowSeconds: nextWindow', 'onUpdatePlot({ ...zoomedControls, channelStartIndex: nextChannelStart, startSeconds: nextTimeStart })', 'selectChannelFromGutter', 'uniqueWaveformChannels', 'annotationChannel: channel', 'compareToChannels', 'Annotate:', 'waveformChannelUniverse', 'clampWaveformControls', 'channelsToPlot: rankedChannels', "channelFocusMode: 'events'", 'findPendingReviewIndex', 'centerWaveformOnEvent', 'selectedReviewEventId', 'onSelectReviewEvent', 'selectedReviewEventIndex', 'toolbarReviewEvents', 'hasToolbarEventNavigation', 'No detected events available for waveform navigation', 'eventPositionLabel', 'WaveformOverviewAxis', 'pyqt-waveform_overview_axis', 'pyqt-waveform_overview_track', 'pyqt-waveform_overview_window', 'pyqt-waveform_overview_ticks']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['draftControls', 'setDraftControls', 'useEffect(() =>', 'refreshDraftControls', 'submitDraftOnEnter', "event.key !== 'Enter' && event.key !== 'Return'", 'onKeyDown={submitDraftOnEnter}', 'onClick={refreshDraftControls}', 'formatPyQtSecondsInput(draftControls.timeWindowSeconds)', 'formatPyQtSecondsInput(draftControls.startSeconds)', 'value={draftControls.visibleChannels}']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['WaveformEventOverlay', 'OverlayHitRegion', 'ChannelHitRegion', 'WaveformCanvasPoint', 'WaveformMeasurementStatus', 'WaveformTrackpadSensitivity', 'CHANNEL_GUTTER_WIDTH = 96', 'WAVEFORM_TRACE_SCALE', 'PYQT_WAVEFORM_BACKGROUND', 'PYQT_WAVEFORM_TRACE', 'PYQT_WAVEFORM_GRID', 'PYQT_WAVEFORM_AXIS', 'PYQT_WAVEFORM_LABEL', 'PYQT_EVENT_MARKER_HIT_WIDTH', 'PYQT_TIME_AXIS_HEIGHT', 'pyqtPlotHeight', 'pyqtPlotWidth', 'drawPyqtTimeAxis', 'formatPyqtTimeTick', 'drawPyqtWaveformBackground', 'TRACKPAD_WHEEL_PROFILES', 'gentle: { threshold: 12, unit: 180, maxSteps: 1 }', 'fast: { threshold: 0.25, unit: 60, maxSteps: 4 }', 'traceScaleForRow', 'displayYForSample', 'normalizeVertically', 'amplitudeScale', 'trackpadSensitivity', 'channelHitRegionsRef', 'drawChannelGutter', 'channelAtPointer', 'waveformPointAtPointer', 'interpolateTimeAtRatio', 'measurementStatusFromPoints', 'formatMeasurementDuration', 'formatMeasurementAmplitude', 'drawCursorOverlay', 'drawMeasurementOverlay', 'drawOverlayLabel', 'onChannelSelect', 'onWheelNavigation', 'WaveformWheelNavigation', 'handleWheel', 'wheelNavigationFromEvent', 'wheelAnchorRatio', 'zoomSteps', 'anchorRatio', 'event.ctrlKey || event.metaKey', 'wheelStepFromDelta(event.deltaY, sensitivity)', 'event.preventDefault()', 'cursorEnabled', 'measureEnabled', 'selectedChannel', 'data-channel-gutter-width', 'data-selected-channel', 'data-hovered-channel', 'data-amplitude-scale', 'data-normalize-vertically', 'data-trackpad-sensitivity', 'data-cursor-enabled', 'data-measure-enabled', 'data-measurement-point-count', 'data-measurement-summary', 'dt ${formatMeasurementDuration', 'dA ${formatMeasurementAmplitude', 'elideChannelLabel', 'overlayAtPointer', 'onOverlaySelect', 'drawEventOverlays', 'drawOverlayLegend', 'CHANNEL_GUTTER_WIDTH + 16', 'overlayColor', 'pyqt-waveform_event_overlay_canvas', 'data-overlay-count', 'data-selected-event-id', 'data-hovered-event-id']) assert.ok(canvas.includes(phrase), phrase);
  assert.ok(existsSync(join(root, 'src/features/waveform/WaveformCanvas.tsx')));
});

test('channel and bipolar selection dialogs match PyQt subwindow workflows', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const channelDialog = read('src/features/shell/ChannelSelectionDialog.tsx');
  const bipolarDialog = read('src/features/shell/BipolarChannelDialog.tsx');
  const state = read('src/app/workspaceState.ts');
  const app = read('src/app/App.tsx');
  const toolbar = read('src/features/shell/WaveformToolbar.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['activeDialog', 'ChannelSelectionDialog', 'BipolarChannelDialog', "setActiveDialog('channels')", "setActiveDialog('bipolar')", 'waveformChannelAmplitudes', 'Math.max(...finiteValues) - Math.min(...finiteValues)', 'channelAmplitudes={channelAmplitudes}']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['Choose visible channels', 'Select None', 'Select All', 'Select Channels', 'Channel to Annotate', 'Compare To', 'pyqt-selected_channels_window', 'pyqt-selected_channels_gridLayout', 'pyqt-selected_channels_listWidget', 'pyqt-selected_channels_horizontalSpacer', 'pyqt-selected_channels_listWidget_2', 'pyqt-selected_channels_summary', 'annotationChannel', 'compareToChannels', "channelFocusMode: annotationChannel ? 'highlight'", 'channelAmplitudes', 'formatChannelAmplitude', 'pyqt-channel_amplitude_', 'µV p-p', 'unavailable', 'uniqueChannels', 'pyqt-channel_selection_ok_button', 'pyqt-channel_selection_cancel_button', 'channelsToPlot']) assert.ok(channelDialog.includes(phrase), phrase);
  for (const phrase of ['Create bipolar channel', 'Channel 1', 'Channel 2', 'New channel = Channel 1 - Channel 2', 'pyqt-ch_1_dropdown', 'pyqt-ch_2_dropdown', 'pyqt-bipolar_pair_row', 'pyqt-bipolar_add_pair_button', 'pyqt-bipolar_conventional_button', 'montageBipolarChannels(metadata, controls)', "montageMode: 'bipolar' as const"]) assert.ok(bipolarDialog.includes(phrase), phrase);
  for (const phrase of ['DerivedBipolarChannel', "kind?: 'manual' | 'autoBipolar'", 'channelsToPlot', 'annotationChannel', 'compareToChannels', 'derivedBipolarChannels', 'BIPOLAR_TOKEN', 'AVERAGE_REFERENCE_SUFFIX', 'CONVENTIONAL_BIPOLAR_CHAINS', 'averageReferenceChannelNames', 'autoBipolarDerivedChannels', 'canonicalConventionalChannel', 'parseNumberedContact', "resolved === 'averageReference'", "resolved === 'bipolar'", 'waveformChannelUniverse', 'resolveMontageMode', 'montageModeLabel', 'montageStateForRecording', 'normalizeMontageMode', 'conventionalBipolarDerivedChannels', 'montageBipolarChannels', 'activeWaveformChannels', 'channelSelectionSummary', 'BIPOLAR_TOKEN', 'AVERAGE_REFERENCE_SUFFIX', 'averageReferenceChannelName', 'averageReferenceChannelNames', 'autoBipolarDerivedChannels', 'CONVENTIONAL_BIPOLAR_CHAINS', 'MIN_CONVENTIONAL_AUTO_ENTRIES']) assert.ok(state.includes(phrase), phrase);
  for (const phrase of ['expandDerivedChannelsForRequest(channels, controls, info)', "resolvedMontage === 'averageReference'", "=== 'bipolar' ? montageBipolarChannels(metadata, controls)", 'sourceRows.reduce', "source: 'average_reference'", "'average_reference'", "source: bipolarApplied ? 'auto_bipolar'", "'auto_bipolar'"]) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['function selectMontage(mode: MontageMode)', 'applyPatchAndRefresh({ montageMode: mode, channelStartIndex: 0 })', "selectMontage('referential')", "selectMontage('averageReference')", "selectMontage('bipolar')", "selectMontage('auto')", 'pyqt-average_reference_button', 'pyqt-bipolar_montage_button', 'pyqt-auto_bipolar_button', "montageModeLabel('auto', metadata)"]) assert.ok(toolbar.includes(phrase), phrase);
  // The montage popover offers exactly four selectable modes; the old build rendered a fifth,
  // unclickable <span> status badge that read as a broken option.
  assert.ok(!toolbar.includes('pyqt-montage_status_badge'), 'montage status badge should no longer render as a pseudo-option');
  for (const phrase of ['Channel/Bipolar dialog owner', 'selected-channels-dialog', 'selected-channels-grid', 'grid-template-columns:minmax(0,1fr) 20px minmax(0,1fr)!important', 'compare-channel-scroll']) assert.ok(css.includes(phrase), phrase);
});

test('recent recordings list reopens removes and clears recording history', () => {
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const state = read('src/app/workspaceState.ts');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['RecentRecording', 'sampleFrequencyHz', 'durationSeconds']) assert.ok(state.includes(phrase), phrase);
  for (const phrase of ['RECENT_RECORDINGS_STORAGE_KEY', 'ieeg.recentRecordings', 'MAX_RECENT_RECORDINGS', 'loadPersistedRecentRecordings', 'persistRecentRecordings', 'isPersistableRecentRecording', 'recentRecordings', 'loadSelectedRecording', 'upsertRecentRecording', 'openRecentRecording', 'removeRecentRecording', 'clearRecentRecordings', 'recordingLabelFromPath']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['pyqt-recent_recordings_panel', 'pyqt-recent_recordings_clear_button', 'pyqt-recent_recording_row', 'pyqt-recent_recording_open_button', 'pyqt-recent_recording_remove_button', 'pyqt-recent_recordings_empty', 'recentRecordingMeta', 'onOpenRecentRecording', 'onRemoveRecentRecording', 'onClearRecentRecordings']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['recording:open-dialog', 'lastRecordingDirectory', 'open-dialog-directory-state.json', 'loadOpenDialogLastDirectory', 'persistOpenDialogLastDirectory']) assert.ok(read('electron/main.ts').includes(phrase), phrase);
  for (const phrase of ['Recent recordings parity', 'recent-recordings-card', 'recent-recordings-list', 'recent-recording-open']) assert.ok(css.includes(phrase), phrase);
});

test('project store toolbar creates opens saves and shows dirty state', () => {
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const toolbar = read('src/features/shell/TopToolbar.tsx');
  const state = read('src/app/workspaceState.ts');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const manifest = read('src/parity/pyqtParityManifest.ts');
  const css = read('src/styles/workspace.css');
  const topToolbarCss = [
    read('src/styles/workspace/top-toolbar.css'),
    read('src/styles/workspace/top-toolbar-menu.css'),
    read('src/styles/workspace/top-toolbar-actions.css'),
  ].join('\n');
  for (const phrase of ['ProjectStoreState', 'project_id', 'recording_info', 'review_events_by_run', 'recording_analysis', 'classifier_controls', 'waveform_controls']) assert.ok(state.includes(phrase), phrase);
  for (const phrase of ['projectPath', 'projectId', 'projectDirty', 'markWorkspaceDirty', 'confirmDiscardWorkspace', 'backendClient.confirmDiscardWorkspace', 'backendClient.onSaveBeforeClose', 'backendClient.completeSaveBeforeClose', 'renderer-save-before-close', 'Save before close failed; workspace kept open', "result.action === 'save'", 'const saved = await saveProject()', 'paused because project save failed', 'opening another project', 'opening another recording', 'opening a recent recording', 'loading a saved session', 'cancelled to keep the unsaved workspace', 'buildProjectStoreState', 'recording_analysis: recordingAnalysis', 'waveform_controls: waveformControls', 'restoredWaveformControls', 'newProject', 'openProject', 'saveProject', 'Promise<boolean>', 'restoreProjectState', 'setRecordingAnalysis(state.recording_analysis', 'setProjectDirty', 'Project created', 'Project opened', 'Project saved', 'backendClient.setWorkspaceDirty', 'renderer-project-state', 'if (isVisualFixtureMode()) return']) assert.ok(app.includes(phrase), phrase);
  assert.ok(app.includes('markWorkspaceDirty();'));
  assert.ok(!app.includes('setProjectDirty(Boolean(projectPath))'));
  for (const phrase of ['projectLabel', 'projectDirty', 'onNewProject', 'onOpenProject', 'onSaveProject']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-project_status_label', 'pyqt-project_new_button', 'pyqt-project_open_button', 'pyqt-project_save_button', 'New Project', 'Open Project', 'Save Project', 'data-dirty', 'pyqt-menu-row', 'pyqt-settings-menu', 'pyqt-toolbar-row', 'pyqt-toolbar-action', 'pyqt-toolbar-label', "ariaLabel: 'Open Recording'", 'Settings', 'Open', 'Session', 'Quick', 'Shortcuts', 'pyqt-toolbar-overflow', 'function ToolbarIcon', 'data-toolbar-icon', 'svg viewBox']) assert.ok(toolbar.includes(phrase), phrase);
  assert.doesNotMatch(toolbar, /[\u{1F300}-\u{1FAFF}]|\u25B6|\u25A4/u);
  assert.doesNotMatch(toolbar, />More<|>More<\/summary>/);
  for (const phrase of ['project:open-dialog', 'project:create', 'project:open', 'project:save', 'workspace:set-dirty', 'workspace:confirm-discard', 'workspace:save-before-close-result', '/projects/create', '/projects/open', '/projects/save', 'lastProjectDirectory', 'open-dialog-directory-state.json']) assert.ok(main.includes(phrase) || preload.includes(phrase), phrase);
  for (const phrase of ['openProjectFile', 'createProject', 'openProject', 'saveProject', 'setWorkspaceDirty', 'confirmDiscardWorkspace', 'completeSaveBeforeClose', 'onSaveBeforeClose']) assert.ok(client.includes(phrase) && preload.includes(phrase), phrase);
  assert.ok(manifest.includes('project.store'));
  for (const phrase of ['Top toolbar layout owner', 'Top toolbar menu owner', 'Top toolbar actions owner', 'project-status-pill', '[data-dirty="true"]', '.project-status-pill:not([data-dirty="true"])', 'display:none!important', '.pyqt-menu-row', '.pyqt-settings-menu:not([open]) .pyqt-toolbar-menu', '.pyqt-settings-menu[open] .pyqt-toolbar-menu', 'position:fixed!important', 'inset-inline-end:8px!important', '.pyqt-toolbar-row', '.pyqt-toolbar-overflow>summary', '.pyqt-toolbar-label', 'white-space:nowrap!important', 'background:transparent', 'box-shadow:none', 'border-radius:0']) assert.ok(topToolbarCss.includes(phrase), phrase);
  assert.doesNotMatch(topToolbarCss, /@media\(max-width:1120px\)|@media\(max-width:980px\)|clip-path:inset\(50%\)!important/);
  assert.doesNotMatch(topToolbarCss, /Project store parity|PyQt main toolbar visual parity|PyQt Settings text-menu polish|clip:rect\(0,0,0,0\)/);
});

test('quick detection dialog exposes PyQt workflow controls', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const toolbar = read('src/features/shell/TopToolbar.tsx');
  const dialog = read('src/features/shell/QuickDetectionDialog.tsx');
  const model = read('src/features/shell/quickDetectionModel.ts');
  const css = read('src/styles/workspace.css');
  const quickDetectionCss = [
    read('src/styles/workspace/quick-detection-shell.css'),
    read('src/styles/workspace/quick-detection-layout.css'),
    read('src/styles/workspace/quick-detection-fields.css'),
    read('src/styles/workspace/quick-detection-classifier-export.css'),
    read('src/styles/workspace/quick-detection-footer-responsive.css'),
  ].join('\n');
  const quick = `${dialog}\n${model}`;
  const manifest = read('src/parity/pyqtParityManifest.ts');
  assert.ok(shell.includes("'quickDetection'"));
  assert.ok(toolbar.includes('onQuickDetection'));
  for (const phrase of ['Quick Detection', 'quickDetectionTitle', 'pyqt-quick_detection_window_title', 'data-window-title={quickDetectionTitle}', "Quick Detection - Running...", "Quick Detection - Complete", "Quick Detection - Failed", 'pyqt-qd_left_rail', 'pyqt-qd_action_rail', 'Run Setup', 'quick-setup-field', 'quick-setup-field-short', 'pyqt-qd_run_detection_button', 'Run Detection', 'pyqt-quick_detection_status_rail', 'Waiting for EEG file', 'pyqt-qd_main_column', 'quick-detection-main-column', 'pyqt-qd_edfInfo', 'pyqt-qd_filters', 'pyqt-qd_right_rail', 'pyqt-classifier_groupbox_4', 'pyqt-qd_saveAs', 'quick-detection-export-panel', 'pyqt-quick_detection_biomarker_combo', 'pyqt-detectionTypeComboBox', 'pyqt-quick_detection_active_detector_page', 'pyqt-qd_MNI_detector', 'pyqt-qd_STE_detector', 'pyqt-qd_HIL_detector', 'quickDetectionDetectorPageObject', 'qd_page_MNI', 'qd_page_STE', 'qd_page_HIL', 'pyqt-qd_RMS_detector', 'pyqt-qd_LineLength_detector', 'pyqt-qd_YASA_detector', 'pyqt-qd_LSM_detector', 'pyqt-qd_A7_detector', 'pyqt-qd_MOLLE_detector', 'pyqt-qd_RMS_LL_detector', 'pyqt-run_button', 'pyqt-quick_detection_action_strip']) assert.ok(quick.includes(phrase), phrase);
  for (const phrase of ['type KeyboardEvent as ReactKeyboardEvent', 'quickDetectionRunDisabled', 'submitQuickDetectionFromField', "event.key !== 'Enter' && event.key !== 'Return'", 'isQuickDetectionReturnSubmitTarget', "target.tagName === 'INPUT'", 'onKeyDown={submitQuickDetectionFromField}', 'pyqt-quick_detection_return_hint', 'returnPressed workflow', 'disabled={quickDetectionRunDisabled}']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['pyqt-qd_fp_input', 'pyqt-qd_fs_input', 'pyqt-qd_rp_input', 'pyqt-qd_rs_input', 'pyqt-qd_classifier_artifact_filename_display', 'pyqt-qd_classifier_spike_filename_display', 'pyqt-qd_classifier_ehfo_filename_display', 'No model selected', 'Hugging Face CPU', 'Hugging Face GPU', 'capabilityManifest: CapabilityManifest | null', 'classifierGpuAvailable(capabilityManifest)', 'classifierGpuHint(capabilityManifest)', 'disabled={!supportsClassifier || !gpuAvailable}', 'gpuAvailable && setClassifier', "trimmed !== 'No model selected'", 'pyqt-qd_use_classifier_checkbox', 'pyqt-quick_classifier_bottom_run_toggle', 'quick-classifier-run-toggle', 'pyqt-qd_npz_checkbox', 'pyqt-qd_excel_checkbox']) assert.ok(quick.includes(phrase), phrase);
  for (const phrase of ['onRunDetection', 'quickDetectionDetectorParams', 'percentFraction', 'millisecondsToSeconds', 'backendExports', "sessionFormat: state.saveAs.npz ? \'npz\' : undefined", "session_format: state.saveAs.npz ? 'npz' : 'none'", 'quickDetectionClassifierPayload', 'quickDetectionFilterRequest', 'chooseClassifierModel', 'chooseDetectorPath', 'onOpenModelFile', 'classifierLabel', 'ignore_region', 'model_type', 'summary_json', 'excel', 'min_osc', 'epoch_len', 'thrd_perc', 'LineLength', 'YASA', 'LSM', 'A7', 'MOLLE', 'RMS/LL', 'freq_sp', 'prob_threshold', 'rms_thres', 'll_thres']) assert.ok(quick.includes(phrase), phrase);
  for (const phrase of ['backendClient.detectorDefaults', 'quickDetectionModel', 'QUICK_DETECTION_DEFAULT_FIELD_MAP', 'QUICK_DETECTION_DETECTORS_BY_BIOMARKER', 'quickDetectionDefaultValues', 'quickDefaultDisplayValue', 'quickDetectionSampleFrequency', 'quickDetectionDetectorsForBiomarker', 'quickDetectionDefaultDetectorForBiomarker', "HFO: ['MNI', 'STE', 'HIL', 'RMS', 'LineLength']", "window: 'rms_window'", "min_duration: 'min_window'", "rel_power: 'rel_pow'", "correlation: 'corr'", "probability: 'prob_threshold'", "freq_low: 'freq_sp_low'", "rms_threshold: 'rms_thres'", "ll_threshold: 'll_thres'", 'mni_epoch_time', 'ste_rms_window', 'hil_sample_freq', 'Math.round(numeric * 1000)', 'Quick Detection defaults loaded from PyHFO parameter objects']) assert.ok(quick.includes(phrase), phrase);
  for (const phrase of ['mergeQuickDetectorDefaults', 'current === fallback', 'defaults[field.key] ?? fallback', 'detectorValues: mergeQuickDetectorDefaults']) assert.ok(quick.includes(phrase), phrase);
  for (const phrase of ['addQuickRangeValidation', 'quickRangeFieldsForDetector', 'Min duration must be lower than max duration', 'low value must be lower than the high value', "['freq_sp_low', 'freq_sp_high', 'Spindle band']", "['duration_low', 'duration_high', 'Duration']", "field.type !== 'path'"]) assert.ok(quick.includes(phrase), phrase);
  for (const phrase of ['pyqt-quick_detection_classifier_scope', 'Classifier is HFO-only in PyQt Quick Detection', 'disabled={!supportsClassifier}', 'supportsClassifier && state.classifier.useClassifier']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ = 2000', 'PYQT_QUICK_DETECTION_VISUAL_FIXTURE_INPUT_PATH', 'quickDetectionVisualFixtureMetadata', 'sample_freq: PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ', 'sampling_frequency: PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ', 'sample_frequency_hz: PYQT_QUICK_DETECTION_VISUAL_SAMPLE_RATE_HZ', 'quickDetectionSampleFrequency(quickDetectionMetadata)', 'sampleFrequency(quickDetectionMetadata)', 'recordingFileName(recordingPath, quickDetectionMetadata)', 'real recording metadata remains untouched']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['runStatus', "setRunStatus('running')", "setRunStatus('complete')", 'pyqt-quick_detection_runtime_card', 'pyqt-quick_detection_progress_card', 'pyqt-quick_detection_progress_bar', 'pyqt-quick_detection_runtime_log', 'pyqt-quick_detection_cancel_button', 'pyqt-quick_detection_open_review_button', 'pyqt-quick_detection_show_artifacts_button', 'onShowArtifacts', 'run registry, waveform overlays, review table, and artifacts were updated']) assert.ok(dialog.includes(phrase), phrase);
  assert.doesNotMatch(dialog, /Quick Detection artifacts are listed in the Agent Artifacts panel/);
  for (const phrase of ['biomarker={biomarker}', 'capabilityManifest={capabilityManifest}', 'runtimeOperation={runtimeOperation}', 'runtimeLog={runtimeLog}', 'onCancelRuntimeOperation={onCancelRuntimeOperation}', "onOpenReview={() => setActiveDialog('eventReview')}", "onShowArtifacts={() => openAgentTab('Artifacts')}"]) assert.ok(shell.includes(phrase), phrase);
  const app = read('src/app/App.tsx');
  for (const phrase of ['const filter = request.filter || filterRequestFromPrepareControls(controls)', 'const nJobs = request.nJobs || controls.nJobs', 'n_jobs: nJobs']) assert.ok(app.includes(phrase), phrase);
  assert.ok(manifest.includes('quick-detection'));
  assert.ok(manifest.includes("id: 'dialog.quick-detection', pyqtObject: 'QuickDetection', label: 'Quick Detection', group: 'quick-detection', status: 'implemented'"));
  for (const phrase of ['Quick Detection shell/status owner', 'Quick Detection layout owner', 'Quick Detection footer/responsive owner', 'All-window modernization pass', '.quick-detection-dialog', 'grid-template-rows:auto minmax(0,1fr) auto!important', '.quick-detection-dialog>.quick-detection-grid', 'grid-template-columns:minmax(300px,310px) minmax(420px,1fr) minmax(300px,340px)!important', '@media(max-width:1280px)', '@media(max-width:880px)', 'scrollbar-gutter:stable both-edges!important', '.quick-detection-dialog .quick-detection-left-rail', '.quick-detection-dialog .quick-detection-main-column', 'position:static!important', 'grid-row:1!important', '.quick-detection-grid>.quick-detection-right-rail', 'grid-template-rows:min-content min-content!important', '.quick-detection-right-rail>[data-testid="pyqt-classifier_groupbox_4"]', '.quick-detection-right-rail>[data-testid="pyqt-qd_saveAs"]', '.quick-detection-dialog>.quick-detection-action-strip', 'grid-template-columns:repeat(3,124px)!important', 'justify-content:end!important', 'justify-self:end!important', 'inline-size:max-content!important', '.quick-detection-dialog>.quick-detection-action-strip button', 'min-block-size:38px!important']) assert.ok(css.includes(phrase), phrase);
  for (const pattern of [/max-block-size:calc\(100vh - 138px\)!important/, /grid-template-columns:minmax\(260px,320px\) minmax\(480px,1fr\) minmax\(360px,.82fr\)!important/, /grid-template-columns:minmax\(260px,300px\) minmax\(0,1fr\)!important/, /grid-template-columns:minmax\(92px,.6fr\) repeat\(2,minmax\(132px,1fr\)\)!important/, /block-size:116px!important/, /max-block-size:116px!important/]) assert.doesNotMatch(quickDetectionCss, pattern);
  for (const phrase of ['pyqtStatusTitle', 'Ready for ${state.detector}', 'pyqtStatusCopy', 'quick-detection-setup-copy', 'title={runFeedback}', 'data-run-status={runStatus}']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['.quick-detection-action-rail .quick-detection-setup-copy', '.quick-detection-status-card .quick-detection-runtime', '.quick-detection-status-card .status-line', '.quick-detection-status-card .quick-detection-runtime[data-run-status="idle"]']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['.quick-detection-dialog .quick-detection-rail-run-button', 'font-weight:400', '.quick-detection-dialog .quick-detection-rail-run-button:disabled']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['.quick-detection-dialog input:not([type="checkbox"])', '.quick-detection-dialog select', 'min-block-size:var(--ui-control-h)!important', 'font-size:var(--fs-base)!important']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['.quick-detection-metadata-grid', '.quick-detection-main-column>[data-testid="pyqt-qd_edfInfo"] .recording-info-grid.quick-detection-metadata-grid', 'justify-self:stretch!important', 'Quick Detection layout owner', 'Quick Detection fields owner', 'Quick Detection classifier/export owner', '.quick-detection-dialog .quick-filter-grid', '.quick-detection-dialog .quick-classifier-param-grid', '.quick-detection-dialog .detector-field-grid', '.quick-detection-dialog .quick-detector-field .inline-field', 'grid-template-columns:minmax(0,var(--quick-detector-input)) max-content!important', '.quick-classifier-model-grid', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.quick-detection-right-rail>[data-testid="pyqt-classifier_groupbox_4"] .quick-classifier-actions.button-row', '.quick-detection-right-rail .quick-model-row', 'grid-template-columns:minmax(0,1fr) minmax(64px,74px)!important', '.quick-detection-grid .quick-classifier-actions', 'grid-auto-rows:var(--ui-action-h)!important', 'Modal chrome owner']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /stylesheet still contains earlier PyQt-era responsive overrides/);
  for (const phrase of ['.quick-detection-action-strip:not([data-run-status="complete"])', 'position:static!important', '.quick-detection-action-strip[data-run-status="complete"]', 'display:grid!important', '.quick-detection-dialog>.quick-detection-action-strip button']) assert.ok(css.includes(phrase), phrase);
});

test('prepare filter and n-jobs controls are stateful instead of decorative', () => {
  const app = read('src/app/App.tsx');
  const state = read('src/app/workspaceState.ts');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  for (const phrase of ['DEFAULT_PREPARE_CONTROLS', 'clampPrepareControls', 'validateFilterControls', 'lineNoiseNotchHz', 'resampleSfreq', 'dropBadChannels', 'dropFlatChannels', 'markOutlierChannels', 'dropOutlierChannels']) assert.ok(state.includes(phrase), phrase);
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const signalAnalysis = read('../pyhfo/src/pyhfo/agent_api/signal_analysis.py');
  const sidecarTests = read('../pyhfo/tests/test_agent_api_sidecar.py');
  for (const phrase of ['recording:roi', 'recording:qc', 'recording:spectral', 'recording:prepare', '/recordings/roi', '/recordings/qc', '/recordings/spectral', 'defaultPreparedOutputPath', '/recordings/prepare', 'prepared-recordings']) assert.ok(main.includes(phrase), phrase);
  for (const phrase of ['analyzeRecordingRoi', 'analyzeRecordingQc', 'analyzeRecordingSpectral', 'prepareRecording']) assert.ok(preload.includes(phrase) && client.includes(phrase), phrase);
  for (const phrase of ['/recordings/roi', '/recordings/qc', '/recordings/spectral', '/recordings/prepare']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['prepareControls', 'recordingAnalysis', 'handleRecordingAnalysisChange', 'confirmedRecordingExclusions', 'roiExclusions', 'const excludeChannels = requestedExclude || roiExclusions', 'exclude_channels: excludeChannels.length ? excludeChannels : undefined', 'analyzeRecordingPlanning', 'onAnalyzeRecordingPlanning', 'backendClient.analyzeRecordingRoi', 'backendClient.analyzeRecordingQc', 'backendClient.analyzeRecordingSpectral', 'unwrapSidecarResult<RecordingRoiSummary>', 'unwrapSidecarResult<RecordingQcSummary>', 'unwrapSidecarResult<RecordingSpectralSummary>', 'Analyze recording ROI/QC/Spectral', 'default_detection_exclusions', 'confirmed_exclusions: defaultExclusions', 'onApplyFilters', 'onSaveNJobs', 'Filter parameter validation failed', 'N Jobs saved', 'backendClient.prepareRecording', 'unwrapSidecarResult<PrepareRecordingResult>', 'filterBandpassFromPrepareControls', 'PrepareRecordingResult', 'Prepared recording', 'Preparing recording with', 'Prepared recording complete', 'optionalPositiveNumber', 'line_noise_notch_hz', 'resample_sfreq', 'drop_outlier_channels']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['value={prepareControls.fp}', 'value={prepareControls.fs}', 'value={prepareControls.rp}', 'value={prepareControls.rs}', 'value={prepareControls.lineNoiseNotchHz}', 'value={prepareControls.resampleSfreq}', 'RecordingPlanningPanel', 'pyqt-recording_planning_panel', 'pyqt-recording_analysis_button', 'pyqt-recording_roi_card', 'pyqt-recording_qc_card', 'pyqt-recording_spectral_card', 'pyqt-recording_spectral_band_bars', 'pyqt-recording_spectral_band_row', 'pyqt-recording_spectral_line_noise_list', 'pyqt-recording_spectral_psd_plot', 'pyqt-recording_spectral_psd_curve', 'pyqt-recording_spectral_hfo_band', 'SpectralCurvePlot', 'spectralCurvePolyline', 'psd_curve', 'spectralBandRows', 'pyqt-recording_roi_exclusions_editor', 'pyqt-recording_roi_exclusions_input', 'pyqt-recording_roi_exclusions_reset', 'pyqt-recording_roi_exclusions_count', 'pyqt-recording_roi_channel_review', 'pyqt-recording_roi_channel_table', 'pyqt-recording_roi_channel_checkbox', 'recordingChannelReviewRows', 'RecordingChannelReviewRow', 'qcReasonForChannel', 'setChannelExcluded', 'parseChannelList', 'onAnalysisChange', 'confirmed_exclusions', 'relative_band_power', 'line_noise_candidates', 'recommended_hfo_band', 'pyqt-prepare_strategy_group', 'pyqt-channel_qc_strategy_group', 'prepare-toggle-option', 'prepare-runtime-action', 'pyqt-line_noise_notch_input', 'pyqt-resample_sfreq_input', 'pyqt-drop_bad_channels_checkbox', 'pyqt-drop_flat_channels_checkbox', 'pyqt-mark_outlier_channels_checkbox', 'pyqt-drop_outlier_channels_checkbox', 'pyqt-overview_filter_button', 'action_filter']) assert.ok(tabs.includes(phrase), phrase);

  for (const phrase of ['_compact_psd_curve', 'max_psd_points', 'relative_power', '"psd_curve": psd_curve']) assert.ok(signalAnalysis.includes(phrase), phrase);
  for (const phrase of ['max_psd_points', 'len(spectral["psd_curve"]) <= 32', 'relative_power']) assert.ok(sidecarTests.includes(phrase), phrase);
});

test('waveform toolbar exposes PyQt production toolbar rows and controls', () => {
  const toolbar = read('src/features/shell/WaveformToolbar.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['pyqt-waveform-source-row', 'pyqt-waveform-channel-row', 'pyqt-waveform-event-row', 'pyqt-go_to_time_input', 'pyqt-waveform_amplitude_input', 'data-pyqt-toolbutton-style="text-beside-icon"', 'data-pyqt-toolbutton-style="icon-only"', 'data-icon="⌁"', 'aria-label="Go to time"', 'aria-label="Refresh waveform plot"', 'toolbar-value-with-unit tight-unit', 'toolbar-value-with-unit spaced-unit', 'formatPyQtSecondsInput(draftControls.timeWindowSeconds)', 'formatPyQtSecondsInput(draftControls.startSeconds)', 'formatPyQtMultiplierInput(draftControls.amplitudeScale)', 'function formatPyQtSecondsInput', 'value.toFixed(2)', 'function formatPyQtMultiplierInput', 'waveform-view-value', 'clinical-selector-value', 'pyqt-raw_tool_button', 'pyqt-filtered_tool_button', 'pyqt-filter60_tool_button', 'pyqt-normalize_tool_button', 'pyqt-referential_tool_button', 'pyqt-average_reference_button', 'pyqt-bipolar_montage_button', 'pyqt-auto_bipolar_button', 'MONTAGE_TITLES', 'pyqt-prev_event_button', 'pyqt-center_event_button', 'pyqt-next_event_button', 'pyqt-pending_event_button', 'hasEventNavigation: boolean', 'disabled={!hasEventNavigation}', 'hasEventNavigation && draftControls.channelFocusMode', 'onNavigateEvent', "onNavigateEvent('prev')", "onNavigateEvent('current')", "onNavigateEvent('next')", "onNavigateEvent('pending')", 'onHotspotChannels', 'eventPositionLabel', 'pyqt-cursor_tool_button', 'pyqt-measure_tool_button', 'pyqt-measurement_status_badge', 'measurementStatus.text', 'Click A', 'pyqt-hotspot_tool_button', 'pyqt-snapshot_button', 'onExportSnapshot', 'data-export-format="png"']) assert.ok(toolbar.includes(phrase), phrase);
  assert.doesNotMatch(toolbar, /<strong>/);
  assert.doesNotMatch(toolbar, /onDeferredAction\('Hotspot Channels'\)/);
  assert.doesNotMatch(css, /grid-template-rows:repeat\(3,26px\)/);
  assert.equal((css.match(/--waveform-toolbar-block-size:/g) || []).length, 0);
  assert.equal((css.match(/--ui-control-height-toolbar:/g) || []).length, 0);
  for (const phrase of ['Waveform toolbar layout owner', 'Waveform toolbar controls owner', 'Waveform toolbar popover owner', 'Waveform toolbar responsive owner', '[data-testid="pyqt-waveform-toolbar"].waveform-toolbar-clinical-console', '--waveform-toolbar-row-h:34px', '--waveform-toolbar-control-h:30px', 'margin-inline-end:calc(var(--pyqt-main-sidebar-width,268px) + var(--pyqt-main-sidebar-gap,8px))!important', 'block-size:116px!important']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /font-weight:(?:620|650)!important/);
  for (const phrase of ['PyQt light waveform plot parity', '.waveform-canvas', 'Modern waveform navigation', '.waveform-stage>.waveform-pane .waveform-plot-shell', 'border:1px solid var(--waveform-nav-border)!important', '.channel-scrollbar', '.time-scrollbar', 'appearance:none!important', '::-webkit-slider-runnable-track', '::-webkit-slider-thumb', 'background:linear-gradient(90deg,var(--waveform-nav-thumb-soft),var(--waveform-nav-track))!important', 'background:var(--waveform-nav-thumb)!important', '.waveform-overview-canvas', 'Waveform toolbar layout owner', '.waveform-toolbar-row', 'button[data-pyqt-toolbutton-style="icon-only"]', 'font-size:0!important', 'content:none!important', 'toolbar-value-with-unit', '.waveform-view-settings-popover .toolbar-field input:not([type="checkbox"]):not([type="radio"])']) assert.ok(css.includes(phrase), phrase);
});

test('left workspace is fixed to viewport and scrolls internally', () => {
  const css = read('src/styles/workspace.css');
  const shell = read('src/app/MainWindowShell.tsx');
  for (const phrase of ['Left workspace containment', 'Fixed-left viewport contract', 'Fixed-size left workspace column', 'Left-pane clamp', 'Production left-pane fixed scroll', 'Fixed-scroll left toolbar', 'PyQt loaded workspace splitter parity', 'PyQt waveform-first fixed-left scroll refinement', 'PyQt main loaded workspace tab-strip parity', 'PyQt main-window empty/loaded layout unification, authoritative', 'User-confirmed main waveform left fixed-scroll parity', 'PyQt horizontal waveform|tabs split parity', '--agent-rail-width:48px', '--agent-panel-width:336px', '--agent-effective-panel-width:var(--agent-panel-width)', 'calc(100vw - var(--agent-rail-width))', 'Docked agent layout', 'contain:size layout', 'contain:size layout paint', 'height:100vh;max-height:100vh;overflow:hidden', 'grid-template-rows:48px 44px 58px 96px minmax(0,1fr) 32px', 'grid-template-columns:minmax(220px,var(--workspace-waveform-percent,62%)) 8px minmax(0,1fr)', 'grid-template-rows:44px 38px 84px 48px 82px minmax(0,1fr) 30px', 'grid-template-rows:minmax(0,1fr)', 'inline-size:calc(100vw - var(--agent-rail-width))', 'max-inline-size:calc(100vw - var(--agent-rail-width))', 'block-size:100vh', 'max-block-size:100vh', 'block-size:96px;max-block-size:96px;min-block-size:96px;overflow:auto', 'block-size:82px;max-block-size:82px;min-block-size:82px', 'scrollbar-gutter:stable both-edges', 'overscroll-behavior:contain', 'cursor:col-resize', '.waveform-left-scroll-pane', 'data-pyqt-scroll-pane="pyqt-waveform_left_scroll_pane"', 'Waveform chrome owner', 'loaded-workspace-splitter-handle', '.channel-scrollbar,', '.time-scrollbar{', 'Modern waveform navigation', '::-webkit-slider-runnable-track']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /calc\(100vw - var\(--agent-rail-width\) - var\(--agent-panel-width\)\)/);
  for (const phrase of ['waveform-left-scroll-pane', 'data-pyqt-scroll-pane="pyqt-waveform_left_scroll_pane"', 'Fixed left waveform scroll pane']) assert.ok(shell.includes(phrase), phrase);
});

test('Quick Detection and Annotation dialogs use PyQt full-size subwindow layout', () => {
  const css = read('src/styles/workspace.css');
  for (const phrase of ['.quick-detection-dialog', '.event-review-dialog', 'inline-size:calc(100vw - 24px)', 'block-size:calc(100vh - 24px)', 'max-inline-size:none', 'max-block-size:none', 'Event Review main layout owner', 'Event Review right-column flow owner', 'inline-size:calc(100vw - 16px)!important', 'block-size:calc(100vh - 16px)!important', 'grid-template-columns:minmax(640px,1.25fr) minmax(390px,.75fr)!important', '.event-detail-card', 'Event Review side-stack source-order owner', '.quick-detection-grid', 'scrollbar-gutter:stable both-edges', 'Quick Detection shell/status owner', '.quick-detection-backdrop', 'padding:12px!important', 'inline-size:min(1720px,calc(100vw - 48px))!important', 'block-size:auto!important', 'max-block-size:calc(100vh - 64px)!important', 'grid-template-rows:auto minmax(0,1fr) auto!important', '.quick-detection-header [data-testid="pyqt-quick_detection_return_hint"]', 'display:none!important', '[data-testid="pyqt-quick_detection_close_button"]', 'z-index:40!important']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /PyQt full-size subwindow parity/);
  assert.doesNotMatch(css, /grid-template-columns:clamp\(620px,52vw,760px\) minmax\(320px,1fr\)/);
});

test('main workspace lands on waveform review + rail and keeps workbench returns', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const css = read('src/styles/workspace.css');
  // Waveform review keeps the compact Run/Results/Signal/Detection/Classification rail, while Recording Info is a top-level dialog.
  for (const phrase of ['MainRightControlSidebar', 'pyqt-waveform_right_sidebar', 'pyqt-sidebar_run_actions_card', 'pyqt-sidebar_results_card', 'pyqt-sidebar_signal_card', 'pyqt-sidebar_detection_card', 'pyqt-sidebar_classification_card', 'pyqt-sidebar_n_jobs_spinbox', 'activeDialog === "recordingInfo"', 'onOpenDetectTab={() => openWorkflowTab("Detect")}', 'onOpenClassifyTab={() => openWorkflowTab("Classify")}']) assert.ok(shell.includes(phrase), phrase);
  // Loading an EEG lands on waveform review + rail; the workbench is opened on demand and still exposes a route back.
  for (const phrase of ['pyqt-subpage_back_to_main_button', 'Close', 'return_to_main_button', 'onClick={onCollapse}', 'subpage-back-button', 'workflowTabLabel']) assert.ok(tabs.includes(phrase) || css.includes(phrase), phrase);
  for (const phrase of ['Preprocessing workbench opens on demand from waveform review', 'data-active-workflow-tab="prepare"', '.waveform-stage', '.waveform-toolbar']) assert.ok(css.includes(phrase) || shell.includes(phrase), phrase);
  // Collapsed main page must not keep the old QSplitter three-column tab layout visible.
  for (const phrase of ['PyQt main-window empty/loaded layout unification, authoritative', '.loaded-workspace[data-workflow-expanded="false"]', 'grid-template-columns:minmax(0,1fr)!important', '.workspace-tabs[hidden]', 'display:none!important']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /PyQt main\/right-rail restoration|Final collapsed workspace clamp|Repair after header-row cleanup|Final PyQt header height repair|Subpage return affordance/);
  assert.doesNotMatch(css, /\.waveform-right-sidebar,\s*\.pyqt-sidebar-card\s*\{\s*display:none/s);
  assert.doesNotMatch(css, /duplicate right rail is gone|no longer hosts a right sidebar/);
});

test('button parity audit compares PyQt buttons and exercises Electron subpage returns', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = read('scripts/button-parity-audit.py');
  assert.equal(pkg.scripts['qa:buttons'], 'python scripts/button-parity-audit.py');
  assert.ok(pkg.scripts['qa:production-parity'].includes('npm run qa:buttons'));
  for (const phrase of ['REQUIRED_BUTTON_EQUIVALENTS', 'read_pyqt_source_buttons', 'pyqt_source_button_count', 'pyqt-subpage_back_to_main_button', 'subpage_back_smoke', 'clicked_safe_buttons', 'skipped_disabled_or_external_buttons', 'button-parity-audit.json', 'Browser-preview audit skips native file dialogs']) assert.ok(script.includes(phrase), phrase);
  for (const phrase of ['return_to_main_button', 'workflow-tab-detect', 'workflow-tab-classify', 'pyqt-header_prepare_button', 'pyqt-sidebar_prepare_button', 'pyqt-sidebar_more_detection_button', 'pyqt-sidebar_more_classification_button', 'pyqt-quick_detection_close_button', 'pyqt-annotation_close_button']) assert.ok(script.includes(phrase), phrase);
});

test('Electron E2E smoke launches the real app runtime and safe-clicks UI surfaces', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = read('scripts/electron-e2e-smoke.mjs');
  assert.equal(pkg.scripts['qa:electron-e2e'], 'node scripts/electron-e2e-smoke.mjs');
  assert.ok(pkg.scripts['qa:production-parity'].includes('npm run qa:electron-e2e'));
  for (const phrase of ['_electron as electron', 'electron.launch', 'VITE_DEV_SERVER_URL', 'PYHFO_BACKEND_PORT', 'PYHFO_BACKEND_STARTUP_TIMEOUT_MS', 'ELECTRON_STARTUP_TIMEOUT_MS', 'PYHFO_APP_ROOT', 'window.ieeg', 'getBackendStatus', 'preload.hasBridge', "preload.health.status === 'ok'", 'electron-e2e-smoke.json']) assert.ok(script.includes(phrase), phrase);
  for (const phrase of ['prepare-subpage', 'agent-open', 'load-detection', 'waveform-shortcuts', 'channel-selection', 'bipolar', 'batch-project', 'run-stats', 'electron-prepare-subpage.png', 'electron-load-detection.png', 'electron-waveform-shortcuts.png', 'electron-channel-selection.png', 'electron-bipolar.png', 'electron-batch-project.png', 'electron-run-stats.png']) assert.ok(script.includes(phrase), phrase);
  for (const phrase of ['loaded-main', 'detect-subpage', 'classify-subpage', 'quick-detection', 'annotation', 'pyqt-quick_detection_window', 'pyqt-annotation_window', 'pyqt-subpage_back_to_main_button']) assert.ok(script.includes(phrase), phrase);
  for (const phrase of ['electron-main.png', 'electron-quick-detection.png', 'electron-annotation.png', 'clicked_safe_buttons', 'Native file dialogs, save/export dialogs, and mutating detector/classifier backend actions are skipped']) assert.ok(script.includes(phrase), phrase);
});

test('Electron real-recording smoke drives EDF load through classify and exports', () => {
  const pkg = JSON.parse(read('package.json'));
  const script = read('scripts/electron-real-recording-smoke.mjs');
  assert.equal(pkg.scripts['qa:electron-real-recording'], 'node scripts/electron-real-recording-smoke.mjs');
  assert.ok(pkg.scripts['qa:production-parity'].includes('npm run qa:electron-real-recording'));
  for (const phrase of ['sub-sourcesinkumf001_ses-extraoperative_task-interictalasleep_run-01_ieeg.edf', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING', '_electron as electron', 'window.ieeg', 'getBackendStatus', 'pyqt-recent_recording_open_button', 'real-recording-ui-loaded.png']) assert.ok(script.includes(phrase), phrase);
  for (const phrase of ['loadRecording', 'requestWaveformWindow', 'analyzeRecordingRoi', 'analyzeRecordingQc', 'analyzeRecordingSpectral', 'prepareRecording', 'runDetection', 'listEvents', 'eventSnippet', 'eventFeatureSummary', 'annotateEvent', 'overlapReview', 'classifyActiveRun', 'exportSession', 'exportReport', 'exportWorkbook']) assert.ok(script.includes(phrase), phrase);
  for (const phrase of ['Detection completed but produced no review events', "model_type: 'default_cpu'", "steps: ['artifact']", 'electron-real-recording-smoke.json', 'electron-real-smoke-workbook.xlsx']) assert.ok(script.includes(phrase), phrase);
});

test('main Detect tab exposes PyQt detector forms for HFO Spindle and Spike', () => {
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const forms = read('src/features/shell/DetectorForms.tsx');
  const app = read('src/app/App.tsx');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const parameters = read('../pyhfo/src/pyhfo/agent_api/parameters.py');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const manifest = read('src/parity/pyqtParityManifest.ts');
  const css = read('src/styles/workspace.css');
  assert.ok(tabs.includes('DetectTab'));
  for (const phrase of ['STE', 'MNI', 'HIL', 'RMS', 'LineLength', 'YASA', 'LSM', 'A7', 'MOLLE', 'RMS/LL']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ["id: 'detect.hfo-forms', pyqtObject: 'detector_subtabs', label: 'HFO detector parameter forms', group: 'detect', status: 'implemented'", "id: 'detect.spindle-forms', pyqtObject: 'detector_subtabs', label: 'Spindle detector parameter forms', group: 'detect', status: 'implemented'", "id: 'detect.spike-form', pyqtObject: 'detector_subtabs', label: 'Spike detector parameter form', group: 'detect', status: 'implemented'"]) assert.ok(manifest.includes(phrase), phrase);
  for (const phrase of ['pyqt-ste_rms_window_input', 'pyqt-mni_epoch_time_input', 'pyqt-hil_pass_band_input', 'pyqt-hfo_rms_window_input', 'pyqt-hfo_linelength_window_input', 'pyqt-yasa_freq_sp_low_input', 'pyqt-lsm_preset_combo', 'pyqt-spindle_a7_freq_low_input', 'pyqt-spindle_molle_freq_low_input', 'pyqt-spike_rms_window_input', 'pyqt-spike_ll_window_input']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['validateDetectorValues', 'runDetector', 'pyqt-detector_subtabs', 'pyqt-detector_feedback', 'backendClient.detectorDefaults', 'normalizeDefaultUiValues', 'PyHFO parameter objects', 'sampleFrequencyHz', 'nJobs']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['LSM_MODEL_FIELDS', 'LSM_PRESET_HYDRATE_KEYS', 'updateLsmPreset', 'LSM preset ${preset} loaded into PyQt model parameter fields', 'pyqt-lsm_model_parameters_group', 'pyqt-lsm_model_parameters_checkbox', 'pyqt-lsm_model_parameters_content', 'pyqt-lsm_window_duration_input', 'pyqt-lsm_step_duration_input', 'pyqt-lsm_theta_index_input', 'pyqt-lsm_nine_15_index_input', 'pyqt-lsm_mu_log_p_theta1_input', 'pyqt-lsm_sigma_log_p_theta1_input', 'pyqt-lsm_transition_00_input', 'lsmModelParametersForRun', 'parseIndexList', 'model_parameters', 'preset_path', 'preset_paths_json']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['DETECTOR_DISPLAY_FIELDS', 'DetectorAppliedDisplay', 'detectorValueFingerprint', 'currentApplied', 'runDisabled', 'Apply the current detector parameters before running', 'pyqt-ste_epoch_display', 'pyqt-mni_baseline_window_display', 'pyqt-hil_sample_freq_display', 'pyqt-yasa_freq_sp_display', 'pyqt-lsm_parameter_file_display', 'pyqt-spike_peak_threshold_display', 'data-applied-current', 'Ready to Run', 'Changed - Apply again']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['pyqt-detector_mode_header', 'pyqt-detector_mode_combo', 'pyqt-detector_apply_button', 'pyqt-detector_run_button', 'pyqt-detector_mode_hint', 'detectorModeHint', 'Run {activeDetector}', 'Detector set to ${detector}']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['capabilityManifest', 'CapabilityManifest', 'backendClient.manifest', 'getCapabilityManifest', 'backend:manifest']) assert.ok(app.includes(phrase) || tabs.includes(phrase) || forms.includes(phrase) || main.includes(phrase) || preload.includes(phrase) || client.includes(phrase), phrase);
  for (const phrase of ['detectorRuntimeAvailability', 'optional_dependencies?.yasa?.available === false', 'pyqt-detector_runtime_warning', "Install the optional 'yasa' package to run YASA spindle detection"]) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['detector-applied-display', 'detector-display-grid', 'detector-display-cell', 'detector-mode-header', 'detector-runtime-warning', 'button:disabled']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /\.workspace-tab-panel\[data-active-tab="Detect"\] \.detector-mode-hint,?[\s\S]{0,300}display:none!important/);
  for (const phrase of ['numericSampleFrequency(metadata)', 'sampleFrequencyHz={numericSampleFrequency(metadata)}', 'nJobs={prepareControls.nJobs}']) assert.ok(tabs.includes(phrase), phrase);
  for (const phrase of ['detector_defaults', '/parameters/detector-defaults', 'ui_values', 'ParamSTE', 'ParamMNI', 'ParamHIL', 'ParamHFORMS', 'ParamHFOLineLength', 'ParamYASA', 'ParamSpindleLSM', 'ParamSpindleA7', 'ParamSpindleRMS', 'ParamSpikeRMSLL', 'LSM_PRESETS', '_lsm_preset_paths', '_lsm_preset_ui_values', 'lsm_transition_11']) assert.ok(server.includes(phrase) || parameters.includes(phrase), phrase);
  assert.ok(main.includes('parameters:detector-defaults') && main.includes('/parameters/detector-defaults'));
  assert.ok(preload.includes('detectorDefaults') && client.includes('detectorDefaults'));
});


test('detect tab run action reaches backend pipeline and review registry', () => {
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const forms = read('src/features/shell/DetectorForms.tsx');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const detectionTests = read('../pyhfo/tests/test_agent_api_detection.py');
  for (const phrase of ['runDetection', 'backendClient.runDetection', 'unwrapSidecarResult<DetectionRunResult>', 'detector_params: request.detectorParams', "request.exports || ['csv', 'session', 'summary_json']", 'session_format: request.sessionFormat', 'include_channels', 'exclude_channels', 'const excludeChannels = requestedExclude || roiExclusions', 'excludeChannels.length', 'refreshReviewEvents', 'detectionResultRunRecord']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['onRunDetection', 'DetectorRunRequest']) assert.ok(shell.includes(phrase) && tabs.includes(phrase), phrase);
  for (const phrase of ['detectorParamsForRun', 'sessionFormat?:', 'percentFraction', 'epoch_len', 'min_osc', 'thrd_perc', 'per_CHF', 'freq_sp', 'll_window', 'rms_thres', 'Promise.resolve(onRunDetection']) assert.ok(forms.includes(phrase), phrase);
  for (const phrase of ['detections:run', 'defaultDetectionOutputDir', "request.exports ||= ['csv', 'session', 'summary_json']"]) assert.ok(main.includes(phrase), phrase);
  assert.ok(preload.includes('runDetection') && client.includes('runDetection'));
  for (const phrase of ['test_run_detection_honors_include_and_exclude_channels', 'test_run_detection_quick_detection_can_request_legacy_npz_session', 'session_format', 'session.npz', '_ChannelSelectionBackend', 'backend.raw.picked == ["A1", "A2"]', 'Ignored missing include_channels', 'Ignored missing exclude_channels', 'summary["request"]["exclude_channels"]']) assert.ok(detectionTests.includes(phrase), phrase);
});

test('classifier tab exposes PyQt classifier mode, model source, and stack controls', () => {
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const classifier = read('src/features/shell/ClassifierTab.tsx');
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const pipeline = read('../pyhfo/src/pyhfo/agent_api/pipeline.py');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const detectionTests = read('../pyhfo/tests/test_agent_api_detection.py');
  const serverTests = read('../pyhfo/tests/test_agent_api_server.py');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const manifest = read('src/parity/pyqtParityManifest.ts');
  const css = read('src/styles/workspace.css');
  assert.ok(tabs.includes('ClassifierTab'));
  for (const phrase of ['DEFAULT_CLASSIFIER_STATE', 'ClassifierControlsState', 'classifierControls', 'classifierFeedback', 'onClassifierControlsChange', 'onClassifierFeedbackChange']) assert.ok(app.includes(phrase) || shell.includes(phrase) || tabs.includes(phrase) || classifier.includes(phrase), phrase);
  for (const phrase of ["id: 'classifier.mode-header', pyqtObject: 'classifier_mode_combo', label: 'Classifier preset and classify action', group: 'classifier', status: 'implemented'", "id: 'classifier.local-models', pyqtObject: 'groupBox', label: 'Local classifier model sources', group: 'classifier', status: 'implemented'", "id: 'classifier.hub-models', pyqtObject: 'groupBox_2', label: 'Hugging Face classifier model sources', group: 'classifier', status: 'implemented'", "id: 'classifier.stack', pyqtObject: 'classifier_groupbox_4', label: 'Classifier stack overview and run button', group: 'classifier', status: 'implemented'"]) assert.ok(manifest.includes(phrase), phrase);
  for (const phrase of ['pyqt-classifier_mode_combo', 'pyqt-classifier_run_button', 'pyqt-classifier_mode_hint', 'HF CPU', 'HF GPU', 'Custom', 'Review only', 'pyqt-classifier_gpu_status', 'classifierGpuAvailable', 'classifierGpuHint', 'defaultClassifierPatch', 'DEFAULT_CLASSIFIER_HUB_CARDS', 'roychowdhuryresearch/HFO-artifact', 'roychowdhuryresearch/HFO-spkHFO', 'roychowdhuryresearch/HFO-eHFO']) assert.ok(classifier.includes(phrase), phrase);
  for (const phrase of ['pyqt-overview_ignore_before_input', 'pyqt-overview_ignore_after_input', 'pyqt-classifier_device_input', 'pyqt-classifier_batch_size_input', 'pyqt-use_spike_checkbox', 'pyqt-use_ehfo_checkbox']) assert.ok(classifier.includes(phrase), phrase);
  for (const phrase of ['pyqt-classifier_artifact_filename', 'pyqt-classifier_spike_filename', 'pyqt-classifier_ehfo_filename', 'pyqt-choose_artifact_model_button', 'pyqt-choose_spike_model_button', 'pyqt-choose_ehfo_model_button']) assert.ok(classifier.includes(phrase), phrase);
  for (const phrase of ['onOpenModelFile', 'chooseLocalModel', "mode: 'Custom'", 'Selected classifier model']) assert.ok(classifier.includes(phrase) || tabs.includes(phrase) || shell.includes(phrase), phrase);
  for (const phrase of ['classifier-model:open-dialog', 'Classifier model files', "extensions: ['tar', 'onnx']", 'classifierModelDialogStatePath', 'classifier-model-dialog-state.json', 'lastClassifierModelDirectory', 'loadClassifierModelLastDirectory', 'persistClassifierModelLastDirectory', 'defaultPath', "app.getPath('documents')"]) assert.ok(main.includes(phrase), phrase);
  assert.ok(preload.includes('openClassifierModel') && client.includes('openClassifierModel'));
  for (const phrase of ['CLASSIFIER_MODEL_ARCHIVE_EXTENSIONS', 'validateLocalClassifierArchive', 'must be a .tar archive or .onnx classifier model', 'setLocalModelPath', "localArtifact', value", "localSpike', value", "localEhfo', value"]) assert.ok(classifier.includes(phrase), phrase);
  for (const phrase of ['classifier-workbench-grid', 'pyqt-image_label', 'classifier-hub-banner', 'Hugging Face model cards', 'pyqt-classifier_artifact_card_name', 'pyqt-classifier_spike_card_name', 'pyqt-classifier_ehfo_card_name', 'pyqt-classifier_groupbox_4', 'classifier-stack-list', 'classifier-status-list', 'validateClassifierState', 'customSourcesVisible', 'classifierControlsVisible', 'showEhfo', 'spikeToggleLabel', 'Use spike-associated', 'pyqt-classifier_source_preference_display', 'pyqt-classifier_steps_display', 'classifierSourceSummary', 'classifierStepLabels', "data-custom-editable={customSourcesVisible ? \'true\' : \'false\'}"]) assert.ok(classifier.includes(phrase), phrase);
  assert.doesNotMatch(classifier, /classifier-stack-grid|classifier-status-grid/);
  for (const phrase of ['ClassifierRunRequest', 'classifierPayloadFromState', 'classifierPatchChangesState', 'applyDefaultPatch', 'onRunClassifier', 'ignore_region', 'model_type', 'source_preference', 'normalizeDevice', 'capabilityManifest={capabilityManifest}', 'classifierGpuAvailable(capabilityManifest)', 'classifierGpuHint(capabilityManifest)']) assert.ok(classifier.includes(phrase) || tabs.includes(phrase) || shell.includes(phrase), phrase);
  for (const phrase of ['classifier_metadata?: Record<string, unknown>', 'classifier_metadata: result.classifier_metadata ? JSON.stringify(result.classifier_metadata)', 'classifier_source_preference', 'classifier_steps', 'unwrapSidecarResult<DetectionRunResult>(await backendClient.classifyActiveRun']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['runClassifier', 'activeRunSessionPath', 'backendClient.classifyActiveRun', "classification_mode: 'active_run_session'", 'detector discovery was not rerun', 'parseDetectorParams', 'classifier: request.classifier', 'classifierLabel', 'rerun_fallback_no_session_artifact']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['classify_existing_run', '_import_app_from_session', '_run_classifier', 'classification_mode', 'active_run_session', 'classify_artifacts(ignore_region, threshold)', 'classify_spikes', 'classify_ehfos']) assert.ok(pipeline.includes(phrase), phrase);
  for (const phrase of ['/runs/classify', 'classify_existing_run']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['\"classifier\": {', '\"gpu\": _torch_gpu_capability()', '\"cpu\": {', 'Install PyTorch with CUDA support to enable Hugging Face GPU classifier presets']) assert.ok(read('../pyhfo/src/pyhfo/agent_api/sidecar.py').includes(phrase), phrase);
  assert.ok(main.includes('runs:classify-active'));
  assert.ok(preload.includes('classifyActiveRun') && client.includes('classifyActiveRun'));
  for (const phrase of ['test_classify_existing_run_imports_session_without_detector_rerun', 'detect_biomarker', 'not in [call[0] for call in backend.calls]', 'classified_session.pybrain']) assert.ok(detectionTests.includes(phrase), phrase);
  assert.ok(serverTests.includes('/runs/classify'));
  assert.ok(css.includes('Classify workbench layout owner'));
  assert.ok(css.includes('Classify execution card owner'));
  assert.ok(css.includes('Classify source card owner'));
  assert.ok(css.includes('.workspace-tab-panel[data-active-tab="Classify"] .classifier-hub-banner'));
});

test('classifier parameters live in the dedicated Classify step, not duplicated in Prepare', () => {
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const classifier = read('src/features/shell/ClassifierTab.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['ClassifierTab', 'state={classifierControls}', 'feedback={classifierFeedback}', 'onClassifierControlsChange', 'onClassifierFeedbackChange', 'onRunClassifier', 'onOpenModelFile']) assert.ok(tabs.includes(phrase), phrase);
  for (const phrase of ['pyqt-classifier_groupbox_4', 'Classifier stack', 'pyqt-overview_artifact_path_display', 'pyqt-overview_spike_path_display', 'pyqt-overview_ehfo_path_display', 'pyqt-overview_ignore_before_input', 'pyqt-overview_ignore_after_input', 'pyqt-use_spike_checkbox', 'pyqt-use_ehfo_checkbox', 'pyqt-overview_device_display', 'pyqt-overview_batch_size_display', 'pyqt-classifier_run_button']) assert.ok(classifier.includes(phrase), phrase);
  for (const phrase of ['classifierPayloadFromState', 'validateClassifierState', 'classifierModesForBiomarker', 'defaultClassifierPatch', 'classifierSourceSummary', 'classifierStepLabels', 'classifierGpuAvailable', 'classifierGpuHint', 'showEhfo', 'spikeToggleLabel', 'onOpenModelFile', 'onRunClassifier']) assert.ok(classifier.includes(phrase), phrase);
  for (const phrase of ['OverviewClassifierPanel', 'pyqt-prepare_classifier_details', 'prepare-advanced-classifier', "label: 'Classifier'", 'model setup']) assert.ok(!tabs.includes(phrase), phrase);
  assert.ok(!tabs.includes('PrepareTab metadata={metadata} recordingPath={recordingPath} biomarker={biomarker} prepareControls={prepareControls} recordingAnalysis={recordingAnalysis} classifierControls'), 'PrepareTab must not receive classifierControls');
  assert.ok(!css.includes('PyQt Overview classifier parameters'));
  for (const phrase of ['classifierControls', 'classifierFeedback', 'DEFAULT_CLASSIFIER_STATE', 'classifierHint']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['classifierControls={classifierControls}', 'classifierFeedback={classifierFeedback}', 'onClassifierControlsChange', 'onClassifierFeedbackChange']) assert.ok(shell.includes(phrase), phrase);
});

test('prepare tab mirrors PyQt Case Console layout', () => {
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['workflow-case-console', 'pyqt-case_workspace_body', 'pyqt-configure_column', 'pyqt-configure_title', 'pyqt-review_settings_column', 'pyqt-review_settings_title', 'Output readiness for the active run']) assert.ok(tabs.includes(phrase), phrase);
  assert.ok(!tabs.includes('pyqt-prepare_classifier_details'));
  for (const phrase of ['Prepare workbench scroll owner', 'Prepare case console owner', '.case-console-workspace', 'Prepare section chrome owner', 'margin:0!important', 'display:grid!important', 'Prepare output/runtime owner', '.case-console-column', 'scrollbar-gutter:stable both-edges', '.recording-planning-panel', 'order:1!important', 'order:2!important', 'Prepare filter field owner', 'Prepare filter action owner', 'Prepare controls responsive owner']) assert.ok(css.includes(phrase), phrase);
  assert.doesNotMatch(css, /\.workspace-tab-panel\[data-active-tab="Prepare"\] \.case-console-header \.status-line,?[\s\S]{0,300}display:none!important/);
  assert.ok(!css.includes('prepare-advanced-classifier'));
});

test('save/export/review actions live in the rail and Run Statistics dialog', () => {
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const dialog = read('src/features/shell/RunStatisticsDialog.tsx');
  for (const phrase of ['pyqt-sidebar_save_session_button', 'pyqt-sidebar_export_workbook_button', 'pyqt-sidebar_open_review_button', 'Save Session', 'Workbook', 'Open Review']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-statistics_box', 'pyqt-run_stats_export_button', 'pyqt-run_stats_report_button', 'Export Workbook', 'Export Report']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['exportRunSession', 'backendClient.saveSessionExport', 'electron-overview-statistics', 'Save session complete', 'session_state', 'classifier_controls', 'prepare_controls', 'session-${stamp}-${safeRunId}.pybrain', 'biomarker_type', 'detection_runs', 'workbook.xlsx']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['onExportSession', 'onExportWorkbook']) assert.ok(shell.includes(phrase), phrase);
});

test('backend workbook export supports native xlsx parity path', () => {
  const app = read('src/app/App.tsx');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const pyTests = read('../pyhfo/tests/test_agent_api_sessions.py') + read('../pyhfo/tests/test_agent_api_server.py');
  assert.ok(app.includes('workbook.xlsx'));
  for (const phrase of ['zipfile.ZipFile', 'workbook_xlsx', '_write_xlsx', 'xl/workbook.xml', 'xl/worksheets/sheet{idx}.xml', '{".json", ".xlsx"}', '_annotation_rows', '_annotation_display_value', 'review_annotations', 'display_label', 'Display Label']) assert.ok(sessions.includes(phrase), phrase);
  for (const phrase of ['workbook.xlsx', 'workbook_xlsx', 'zipfile.ZipFile', 'Pathological', 'display_label']) assert.ok(pyTests.includes(phrase), phrase);
});

test('backend report export supports PyQt-style HTML and csv parity paths', () => {
  const app = read('src/app/App.tsx');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const pyTests = read('../pyhfo/tests/test_agent_api_sessions.py') + read('../pyhfo/tests/test_agent_api_server.py');
  assert.ok(app.includes('report.html'));
  for (const phrase of ['import base64', 'import csv', 'import html as html_lib', 'report_csv', 'report_html', '_decode_png_data_url', '_report_metadata_payload', 'waveform_snapshot.png', 'Waveform snapshot', '_write_report_csv', '_write_report_html', '_write_report_package_assets', 'metadata.json', 'review_annotations.csv', '{".json", ".csv", ".html", ".htm"}', 'writer.writerow(["section", "key", "value"])', 'Report Package Assets', 'Waveform Snapshot', 'Run Inventory', 'Channel Ranking', 'Event Preview', 'Runtime Log', 'Review Annotations', 'review_annotations', 'display_label', '_report_run_rows', '_report_event_rows', '_report_channel_ranking_rows', '_report_runtime_rows', '_write_dict_rows_csv', 'runs.json', 'channel_ranking.csv', 'events_preview.csv', 'runtime_log.json']) assert.ok(sessions.includes(phrase), phrase);
  for (const phrase of ['report.csv', 'report.html', 'report_files', 'metadata.json', 'review_annotations.csv', 'waveform_snapshot.png', 'data_url_omitted', 'report_csv', 'report_html', 'section,key,value', '<!DOCTYPE html>', 'Analysis Report', 'Report Package Assets', 'Waveform Snapshot', 'Run Inventory', 'Channel Ranking', 'Event Preview', 'Runtime Log', 'runs.json', 'channel_ranking.csv', 'events_preview.csv', 'runtime_log.json', 'Review Annotations', 'Pathological']) assert.ok(pyTests.includes(phrase), phrase);
  for (const phrase of ['currentWaveformSnapshotPayload', 'pyqt-waveform_event_overlay_canvas', "toDataURL('image/png')", 'waveform_snapshot: waveformSnapshot', 'electron-waveform-canvas']) assert.ok(app.includes(phrase), phrase);
});

test('backend session export supports pybrain saved-session parity path', () => {
  const app = read('src/app/App.tsx');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const pyTests = read('../pyhfo/tests/test_agent_api_sessions.py') + read('../pyhfo/tests/test_agent_api_server.py');
  assert.ok(app.includes('.pybrain'));
  const schema = read('../pyhfo/src/pyhfo/agent_api/schemas.py');
  const pipeline = read('../pyhfo/src/pyhfo/agent_api/pipeline.py');
  for (const phrase of ['save_session_checkpoint', 'pybrain_session', 'npz_session', '{".json", ".pybrain", ".npz"}', 'if not detection_runs', 'run_records']) assert.ok(sessions.includes(phrase), phrase);
  for (const phrase of ['session_format: str = "pybrain"', 'sessionFormat', "session_format must be 'pybrain' or 'npz'"]) assert.ok(schema.includes(phrase), phrase);
  for (const phrase of ['session_suffix = ".npz" if request.session_format == "npz" else ".pybrain"', 'f"session{session_suffix}"']) assert.ok(pipeline.includes(phrase), phrase);
  for (const phrase of ['session.pybrain', 'pybrain_session', 'summarize_saved_session', 'load_session_checkpoint']) assert.ok(pyTests.includes(phrase), phrase);
});

test('saved session load restores prepare and classifier controls', () => {
  const app = read('src/app/App.tsx');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const pyTests = read('../pyhfo/tests/test_agent_api_sessions.py');
  for (const phrase of ['loaded.prepare_controls', 'loaded.classifier_controls', 'setPrepareControls(clampPrepareControls({ ...DEFAULT_PREPARE_CONTROLS', 'setClassifierControls({ ...DEFAULT_CLASSIFIER_STATE', 'Classifier controls restored from saved session', 'prepare_controls?: Partial<PrepareControlsState>', 'classifier_controls?: Partial<ClassifierControlsState>']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['\"prepare_controls\": checkpoint_get', '\"classifier_controls\": checkpoint_get']) assert.ok(sessions.includes(phrase), phrase);
  for (const phrase of ['prepare_controls', 'classifier_controls', 'loaded_pybrain[\"prepare_controls\"]', 'loaded_pybrain[\"classifier_controls\"]']) assert.ok(pyTests.includes(phrase), phrase);
});

test('overview session and workbook exports use native save dialogs like PyQt', () => {
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const app = read('src/app/App.tsx');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  for (const phrase of ['saveBackendExportWithDialog', 'safeExportDefaultName', 'dialog.showSaveDialog', 'allowedExtensions', 'Legacy PyBrain NPZ Session', 'exports:session-save-dialog', 'exports:workbook-save-dialog', 'exports:report-save-dialog', 'allow_absolute_path: true', 'Save PyBrain Session', 'Export Workbook', 'Export Analysis Report', 'HTML Report', 'CSV Report', 'JSON Report']) assert.ok(main.includes(phrase), phrase);
  for (const phrase of ['saveSessionExport', 'saveWorkbookExport', 'saveReportExport']) assert.ok(preload.includes(phrase) && client.includes(phrase), phrase);
  for (const phrase of ['backendClient.saveSessionExport', 'backendClient.saveWorkbookExport', 'backendClient.saveReportExport', 'Save session cancelled', '${label} cancelled.']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['allow_absolute_path', 'allow_absolute_path=bool', 'invalid_export_path']) assert.ok(sessions.includes(phrase), phrase);
});


test('runtime progress and status log mirror PyQt worker feedback surface', () => {
  const state = read('src/app/workspaceState.ts');
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const dialog = read('src/features/shell/RuntimeLogDialog.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['RuntimeOperation', 'RuntimeLogEntry', 'IDLE_RUNTIME_OPERATION', 'cancel_requested']) assert.ok(state.includes(phrase), phrase);
  for (const phrase of ['runtimeOperation', 'runtimeLog', 'beginOperation', 'updateOperation', 'finishOperation', 'cancelRuntimeOperation', 'Backend request prepared', 'Backend returned']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['runtimeOperation', 'runtimeLog', 'onCancelRuntimeOperation', "'runtimeLog'", "setActiveDialog('runtimeLog')", 'pyqt-status_log_open_button']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['RuntimeLogPanel', 'pyqt-status_log_group', 'pyqt-run_runtime_host', 'pyqt-runtime_progress_bar', 'pyqt-runtime_cancel_button', 'pyqt-status_log_text']) assert.ok(tabs.includes(phrase), phrase);
  for (const phrase of ['backendClient.health()', 'normalizeBackendHealth', 'pyqt-status_log_dialog', 'pyqt-runtime_log_summary', 'pyqt-runtime_log_search_input', 'pyqt-runtime_log_level_filter', 'pyqt-runtime_log_table', 'pyqt-runtime_log_row', 'pyqt-runtime_log_status_text', 'pyqt-runtime_log_cancel_button', 'pyqt-backend_health_card', 'pyqt-backend_health_refresh_button', 'pyqt-backend_health_status', 'pyqt-backend_log_table', 'pyqt-backend_log_row']) assert.ok(dialog.includes(phrase), phrase);
  assert.ok(css.includes('Runtime/progress parity'));
  assert.ok(css.includes('Runtime Log dialog owner'));
  assert.ok(css.includes('runtime-log-dialog'));
  assert.ok(css.includes('runtime-log-table'));
  assert.ok(css.includes('runtime-backend-health'));
});

test('toolbar Load Detection opens saved-session dialog and backend route', () => {
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const dialog = read('src/features/shell/LoadDetectionDialog.tsx');
  const css = read('src/styles/workspace.css');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const analysis = read('../pyhfo/src/pyhfo/utils/analysis_session.py');
  const hfoApp = read('../pyhfo/src/pyhfo/hfo_app.py');
  const spindleApp = read('../pyhfo/src/pyhfo/spindle_app.py');
  const spikeApp = read('../pyhfo/src/pyhfo/spike_app.py');
  for (const phrase of ['session:open-dialog', 'PyBrain sessions', 'session:load', '/sessions/open-saved', 'lastSessionDirectory', 'open-dialog-directory-state.json', 'loadOpenDialogLastDirectory', 'persistOpenDialogLastDirectory']) assert.ok(main.includes(phrase), phrase);
  for (const phrase of ['openSavedSession', 'loadSavedSession']) assert.ok(preload.includes(phrase) && client.includes(phrase), phrase);
  for (const phrase of ['openSavedSession', 'loadSavedSession', 'session loaded', 'SavedSessionSummary', 'savedSessionRunRecords', 'normalizeSavedEventsByRun', 'detection_runs', 'review_events_by_run', 'active_run_id', 'accepted_run_id', 'visible_run_ids', 'loaded.prepare_controls', 'loaded.classifier_controls', 'setRunEventsByRun(normalizeSavedEventsByRun', 'session_path']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ["'loadDetection'", 'LoadDetectionDialog', 'onLoadDetection']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-load_detection_window', 'pyqt-load_detection_path_input', 'pyqt-load_detection_browse_button', 'pyqt-load_detection_ok_button', '.pybrain or .npz', 'Validation failed: choose a .pybrain or .npz saved session']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['/sessions/open-saved', 'session.saved_session_path', 'session.review_events', 'session.review_cursor_event_id', 'session.review_events_by_run', 'review_run_filters']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['summarize_saved_session', 'load_session_checkpoint', 'review_events_by_run', 'prepare_controls', 'classifier_controls', 'run_records', 'visible_run_ids']) assert.ok(sessions.includes(phrase), phrase);
  const manifest = read('src/parity/pyqtParityManifest.ts');
  assert.ok(manifest.includes("id: 'dialog.load-detection', pyqtObject: 'actionLoad_Detection_toolbar', label: 'Open saved PyBrain session', group: 'session', status: 'implemented'"));
  assert.ok(css.includes('Load Detection dialog owner'));
  assert.ok(css.includes('load-detection-dialog'));
  for (const phrase of ['summarize_saved_session', 'load_session_checkpoint', 'event_count', 'analysis_session', 'detection_runs', 'review_events_by_run', 'active_run_id', 'accepted_run_id', 'visible_run_ids', 'review_events', 'cursor_event_id', '_review_events_by_run_from_analysis_session', '_run_records_from_analysis_session', '_review_events_from_analysis_session', '_review_cursor_from_analysis_session']) assert.ok(sessions.includes(phrase), phrase);
  for (const phrase of ['review_cursor_event_id', 'sync_review_cursor_from_active_run', 'review_event_id']) assert.ok(analysis.includes(phrase), phrase);
  assert.ok(hfoApp.includes('sync_review_cursor_from_active_run'));
  assert.ok(spindleApp.includes('sync_review_cursor_from_active_run'));
  assert.ok(spikeApp.includes('sync_review_cursor_from_active_run'));
});

test('waveform shortcuts dialog mirrors PyQt settings and installs active shortcuts', () => {
  const shell = read('src/app/MainWindowShell.tsx');
  const dialog = read('src/features/shell/WaveformShortcutSettingsDialog.tsx');
  const css = read('src/styles/workspace.css');
  for (const phrase of ["'waveformShortcuts'", 'WaveformShortcutSettingsDialog', 'window.addEventListener', 'runWaveformShortcut', 'eventToShortcutText', 'normalizedBindings', 'WAVEFORM_SHORTCUT_SETTINGS_STORAGE_KEY', 'ieeg.waveformShortcutSettings', 'loadWaveformShortcutSettings', 'normalizePersistedWaveformShortcutSettings', 'validateWaveformShortcutBindings(settings.enabled, settings.bindings)', 'persistWaveformShortcutSettings', 'saveWaveformShortcutSettings', 'onSave={saveWaveformShortcutSettings}', "value === 'gentle' || value === 'default' || value === 'fast'", 'type WaveformTrackpadSensitivity', 'trackpadSensitivity={shortcutSettings.trackpadSensitivity}', 'trackpadSensitivity={trackpadSensitivity}', 'onWaveformControlsChange({ ...waveformControls, cursorEnabled: false, measureEnabled: false })', "onDeferredAction('Waveform settings updated')", "shortcutId === 'hotspot'", 'focusHotspotChannels()', "shortcutId === 'center_event'", "navigateReviewEvent('current')", "shortcutId === 'next_pending'", "navigateReviewEvent('pending')"]) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-waveform_shortcuts_window', 'pyqt-waveform_shortcuts_enabled_checkbox', 'pyqt-waveform_trackpad_sensitivity_combo', 'pyqt-waveform_shortcuts_scroll_area', 'validateWaveformShortcutBindings', 'captureShortcut', 'onKeyDown={(event) => captureShortcut(event, spec.id)}', 'eventToShortcutText(event.nativeEvent)', 'normalizedBindings(bindings)', "event.key === 'Backspace' || event.key === 'Delete'", "['Shift', 'Control', 'Meta', 'Alt'].includes(event.key)", "event.ctrlKey && key !== 'Control' ? 'Ctrl'", "event.metaKey && key !== 'Meta' ? 'Meta'", "event.altKey && key !== 'Alt' ? 'Alt'"]) assert.ok(dialog.includes(phrase), phrase);
  const shortcutIds = ['window_2s', 'window_5s', 'window_10s', 'window_20s', 'visible_8', 'visible_16', 'visible_32', 'visible_all', 'zoom_out', 'zoom_in', 'toggle_filtered', 'toggle_event_scope', 'toggle_cursor', 'toggle_measure', 'toggle_auto_bipolar', 'show_referential', 'toggle_average_reference', 'focus_highlighted_channel', 'focus_neighbors', 'toggle_clean_view', 'open_montage', 'hotspot', 'center_event', 'next_pending', 'clear_inspect'];
  for (const id of shortcutIds) assert.ok(dialog.includes(`id: '${id}'`), id);
  for (const id of shortcutIds) assert.ok(shell.includes(`shortcutId === '${id}'`) || shell.includes(`shortcutId === "${id}"`), id);
  for (const phrase of ['Set window to 2 s', 'Open montage / bipolar tool', 'Highlight hotspot channels', 'Center current event', 'Jump to next unreviewed event', "setActiveDialog('bipolar')", 'focusHotspotChannels()', "navigateReviewEvent('current')", "navigateReviewEvent('pending')", 'cursorEnabled: false, measureEnabled: false']) assert.ok((dialog + shell).includes(phrase), phrase);
  const manifest = read('src/parity/pyqtParityManifest.ts');
  assert.ok(manifest.includes("id: 'dialog.waveform-shortcuts', pyqtObject: 'WaveformShortcutSettingsDialog', label: 'Waveform shortcut settings', group: 'waveform', status: 'implemented'"));
  assert.ok(css.includes('Waveform Shortcuts dialog owner'));
  assert.ok(css.includes('waveform-shortcuts-dialog'));
});

test('run registry decision desk and event review surface replace placeholders', () => {
  const state = read('src/app/workspaceState.ts');
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const review = read('src/features/shell/EventReviewDialog.tsx');
  const toolbar = read('src/features/shell/WaveformToolbar.tsx');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const manifest = read('src/parity/pyqtParityManifest.ts');
  const css = read('src/styles/workspace.css');
  for (const phrase of ["id: 'review.run-registry', pyqtObject: 'run_table', label: 'Run registry and decision desk', group: 'review', status: 'implemented'", "id: 'review.active-run', pyqtObject: 'active_run_name_label', label: 'Active run snapshot', group: 'review', status: 'implemented'", "id: 'review.annotation-window', pyqtObject: 'Annotation', label: 'Event-by-event annotation window', group: 'review', status: 'implemented'", "id: 'review.annotation-waveform', pyqtObject: 'AnnotationPlot', label: 'Annotation waveform snippet pane', group: 'review', status: 'implemented'", "id: 'review.annotation-fft', pyqtObject: 'FFT_layout', label: 'Annotation FFT/frequency pane', group: 'review', status: 'implemented'", "id: 'review.annotation-view-controls', pyqtObject: 'SyncViewsCheckBox', label: 'Annotation Sync X, history, snapshot controls', group: 'review', status: 'implemented'", "id: 'review.backend-events', pyqtObject: 'list_events', label: 'Review events, annotations, overlap review backend bridge', group: 'review', status: 'implemented'"]) assert.ok(manifest.includes(phrase), phrase);
  for (const phrase of ['RunRecord', 'ReviewEvent', 'ReviewAnnotation', 'ChannelRankingRow', 'channelRankingRows', 'channelPriority', 'RunOverlapRow', 'runOverlapRows', 'eventsForRunComparison', 'countTemporalOverlapMatches', 'comparableEvents']) assert.ok(state.includes(phrase), phrase);
  for (const phrase of ['runRecords', 'activeRunId', 'acceptedRunId', 'reviewEvents', 'selectedReviewEventId', 'reviewEventContext', 'backendClient.listEvents({ run_id: runId })', 'async function refreshReviewEvents(runId = activeRunId || undefined, options:', 'async function activateRun', 'backendClient.moveEventCursor', "action: 'select'", 'run_id: context.runId', 'events: context.events', 'cursor_event_id', 'acceptRun', 'annotateEvent', 'overlapReview', 'activeRunEvents', 'backendClient.overlapReview({ run_id: activeRunId || undefined, events, tolerance_seconds: 0 })', "Overlap review complete${activeRunId ? ` for ${activeRunId}` : ''}", 'refreshReviewEvents']) assert.ok(app.includes(phrase), phrase);
  // Decision Desk run-management UI moved out of Prepare into the Run Statistics dialog (asserted in the run-statistics test); the rail carries quick run actions.
  assert.doesNotMatch(tabs, /<div className="table-shell" data-testid="workflow-run-registry">Run registry<\/div>/);
  for (const phrase of ["'eventReview'", 'EventReviewDialog', 'onAnnotateEvent', 'onOverlapReview']) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['pyqt-annotation_window', 'pyqt-annotation_event_table', 'pyqt-annotation_notes_input', 'pyqt-annotation_accept_button', 'disabled={!hasSelectedReviewLabel}', 'pyqt-ClearAnnotationButton', 'pyqt-actionStart_Over', 'pyqt-menuEdit', 'clearCurrentAnnotation']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['pyqt-progressCard', 'pyqt-progressTextbox', 'pyqt-PreviousButton', 'pyqt-NextButton', 'pyqt-PrevPendingButton', 'pyqt-NextPendingButton', 'pyqt-AnotationDropdownBox', 'pyqt-PredictionScopeBox', 'pyqt-UnannotatedOnlyCheckBox', 'pyqt-PrevMatchButton', 'pyqt-NextMatchButton', 'pyqt-match_summary_label', 'pyqt-model_textbox', 'pyqt-reviewed_textbox', 'pyqt-EventDropdown_Box', 'pyqt-IntervalDropdownBox', 'pyqt-viewControlsGroupBox', 'pyqt-ResetViewButton', 'pyqt-ZoomInButton', 'pyqt-ZoomOutButton', 'pyqt-PanLeftButton', 'pyqt-PanRightButton', 'pyqt-PanUpButton', 'pyqt-PanDownButton']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['aria-label="Zoom in"', 'title="Zoom in"', 'aria-label="Zoom out"', 'title="Zoom out"']) assert.ok(review.includes(phrase), phrase);
  assert.doesNotMatch(review, />\s*Zoom \+/);
  assert.doesNotMatch(review, />\s*Zoom -/);
  for (const phrase of ['onOpenReview', 'onOverlapReview', 'pyqt-overlap_review_button', 'pyqt-open_review_button']) assert.ok(toolbar.includes(phrase), phrase);
  for (const phrase of ['events:list', 'events:cursor', 'events:annotate', 'events:overlap-review']) assert.ok(main.includes(phrase) || preload.includes(phrase), phrase);
  for (const phrase of ["query.set('run_id', String(payload.run_id))", '`/events${suffix}`', 'listEvents: (request?: unknown)']) assert.ok(main.includes(phrase) || preload.includes(phrase) || client.includes(phrase), phrase);
  for (const phrase of ['listEvents', 'moveEventCursor', 'annotateEvent', 'overlapReview']) assert.ok(client.includes(phrase), phrase);
  for (const phrase of ['compact-summary-table', 'Run overlap parity', 'comparison-table', 'data-jaccard-high']) assert.ok(css.includes(phrase), phrase);
  // A PyQt-parity anchor used to live here, asserting these run-management concepts existed in
  // pyhfo/src/views/main_window_view.py or main_window_model.py. Those files are gone (the PyQt UI
  // was removed; Electron is the shipped UI), and every phrase was satisfied only by them — never
  // by the React port, which names things differently. The React-side behaviour these lines were
  // shadowing is covered by the run-registry/review assertions above and by the run-statistics test.
});


test('run statistics dialog mirrors PyQt run management subwindow', () => {
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const tabs = read('src/features/shell/WorkspaceTabs.tsx');
  const dialog = read('src/features/shell/RunStatisticsDialog.tsx');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const css = read('src/styles/workspace.css');
  for (const phrase of ['RunStatisticsDialog', "'runStats'", 'visibleRunIds', 'runEventsByRun={runEventsByRun}', 'onActivateRun', 'onToggleRunVisible', 'onCreateConsensusRun', 'onExportWorkbook', 'onExportReport', "setActiveDialog('runStats')"]) assert.ok(shell.includes(phrase), phrase);
  for (const phrase of ['activateRun', 'toggleRunVisible', 'visibleRunIds', 'Accepted run', 'logRuntime', 'runEventsByRun', 'cacheRunEvents', 'applyReviewEventsForRun', 'Event cursor sync failed after run switch', 'createConsensusRun', 'backendClient.createConsensusRun', 'renderer-fallback', 'buildConsensusEvents', 'consensusSupportThreshold', 'refreshCandidateChannelRanking', 'candidateRankingRunsFromRecords', 'backendClient.rankCandidateChannels', 'candidate_ranking', 'Backend channel ranking updated', 'exportRunWorkbook', 'exportRunReport', 'buildRunExportPayload', 'collectRunArtifacts', 'backendClient.saveWorkbookExport', 'backendClient.saveReportExport']) assert.ok(app.includes(phrase), phrase);
  assert.ok(app.includes("beginOperation('Rank candidate channels', 'detection', { indeterminate: true, agentInitiated: true, commandId: opts.commandId })"), 'agent-initiated candidate ranking must create a chat lifecycle card and command callback');
  for (const phrase of ['createConsensusRun', 'runs:create-consensus', '/runs/consensus', 'rankCandidateChannels', 'detections:rank-candidates', '/detections/rank-candidates']) assert.ok(client.includes(phrase) || main.includes(phrase) || preload.includes(phrase), phrase);
  // Run comparison + candidate ranking now live solely in the Run Statistics dialog (asserted below), no longer duplicated in the Prepare tab.
  for (const phrase of ['pyqt-run_stats_dialog', 'pyqt-run_stats_activate_button', 'pyqt-run_stats_accept_button', 'pyqt-run_stats_visible_checkbox', 'onToggleRunVisible', 'runStatus', 'pyqt-run_stats_consensus_button', 'aria-label="Consensus strategy"', 'pyqt-run_stats_consensus_strategy_combo', 'onCreateConsensusRun', 'pyqt-run_stats_export_button', 'pyqt-run_stats_report_button', 'onExportWorkbook', 'onExportReport', 'pyqt-run_stats_run_table', 'pyqt-run_stats_channel_ranking', 'pyqt-run_stats_channel_row', 'candidateChannelRankingRows', 'candidateRanking', 'pyqt-run_stats_backend_ranking_policy', '<th>Accepted</th><th>Total</th><th>Priority</th>', 'runEventsByRun', 'runOverlapRows', 'pyqt-run_stats_comparison_table', 'pyqt-run_stats_comparison_table_grid', 'pyqt-run_stats_comparison_row', 'comparison-table', 'leftOnly', 'rightOnly', 'data-jaccard-high', 'pyqt-run_stats_runtime_tail']) assert.ok(dialog.includes(phrase), phrase);
  for (const phrase of ['exports:session', 'exports:report', 'exports:report-save-dialog', 'exports:workbook']) assert.ok(main.includes(phrase) && preload.includes(phrase), phrase);
  for (const phrase of ['exportSession', 'exportReport', 'saveReportExport', 'exportWorkbook']) assert.ok(client.includes(phrase), phrase);
  assert.ok(server.includes('/exports/workbook'));
  assert.ok(sessions.includes('export_workbook'));
  assert.ok(css.includes('Run Statistics dialog owner'));
  assert.ok(css.includes('comparison-table density'));
});

test('event review dialog exposes waveform snippet FFT frequency controls sync and snapshot', () => {
  const app = read('src/app/App.tsx');
  const shell = read('src/app/MainWindowShell.tsx');
  const review = read('src/features/shell/EventReviewDialog.tsx');
  const main = read('electron/main.ts');
  const preload = read('electron/preload.cts');
  const client = read('src/api/backendClient.ts');
  const css = read('src/styles/workspace.css');
  const fixture = read('src/app/visualFixture.ts');
  for (const phrase of ['loadEventSnippet', 'eventSnippet', 'loadEventFeatureSummary', 'eventFeatureSummary', 'onLoadEventFeatureSummary={loadEventFeatureSummary}', 'reviewEventContext', 'padding_seconds: paddingSeconds', 'target_samples_per_channel: 900, events: context.events', 'run_id: context.runId', 'annotateEvent({ event_id: context.eventId, run_id: context.runId, label: backendLabel, display_label: label, notes, reviewer']) assert.ok(app.includes(phrase), phrase);
  for (const phrase of ['exportWaveformSnapshot', 'pyqt-waveform_event_overlay_canvas', "toDataURL('image/png')", 'onSavePngSnapshot', '_waveform.png', 'Save Waveform Snapshot']) assert.ok(shell.includes(phrase), phrase);
  assert.ok(shell.includes('onLoadEventSnippet'));
  for (const phrase of ['selectedEventId', 'externallySelectedEventId', 'selectedRowRef', "closest('.event-table')", 'table.scrollTop', 'pyqt-annotation_selected_event_row', 'currentEventIndex', 'selectEventByOffset', 'selectPendingEvent', 'saveAndNext', 'pyqtEventNavigationIndex', 'data-event-position', 'aria-selected', 'No detected events available for navigation', 'All events are already annotated', 'onSelectEvent', 'selectEvent(event)', 'onLoadFeatureSummary', 'onLoadFeatureSummary(selectedEvent)', 'onLoadSnippet(selectedEvent', 'onAnnotate(selectedEvent', 'featureSummary', 'featureSummaryRows', 'pyqt-event_feature_summary_card', 'pyqt-event_feature_summary_table', 'pyqt-event_feature_summary_row', 'pyqt-event_feature_summary_status', 'pyqt-event_feature_spectrum_status', 'Event Feature Summary', 'No detector features recorded for this event', 'humanizeFeatureKey', 'formatFeatureValue', 'pyqt-AnnotationPlot', 'pyqt-FilteredTracingPlot', 'pyqt-TimeFrequencyPlot', 'pyqt-FFT_layout', 'pyqt-annotation_bottom_help_footer', 'Shift-drag: box zoom | Alt-drag: FFT ROI | Wheel: zoom | Drag: pan | Esc: clear FFT ROI', 'pyqt-SyncViewsCheckBox', 'pyqt-ExportSnapshotButton', 'pyqt-SetFreqLimit', 'pyqt-spinBox_minFreq', 'pyqt-spinBox_maxFreq', 'const [syncX, setSyncX] = useState(false)', 'annotationDisplayLabel', 'display_label', 'pyqt-annotation_display_label_cell', 'pyqt-annotation_display_label', 'pyqt-annotation_backend_label', 'pyqt-annotation_detail_actions', 'annotation-extra-label-action', 'annotation-queue-row', 'annotation-queue-label', 'reviewed /', 'No.${index + 1}:', 'Event Information', 'DL Suggestion:', 'pyqt-channel_name_textbox', 'pyqt-start_textbox', 'pyqt-end_textbox', 'pyqt-length_textbox', 'pyqt-reviewed_textbox', 'selectedReviewStatusText(selectedEvent)', 'function selectedReviewStatusText(event: ReviewEvent | null): string', 'return annotationDisplayLabel(event?.annotation);', '<th>Backend</th>', 'Reviewer:', 'Source:', 'Label: ${annotationDisplayLabel(annotation)}']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['pyqt-annotation_shortcuts_hint', 'isEditableReviewShortcutTarget', 'annotationShortcutHint', "key === 'arrowright' || key === 'd'", "key === 'arrowleft' || key === 'a'", "key === 'enter'", "key === 'backspace'", "key === 'escape'", '/^[123]$/.test(key)', 'Pathological', 'Physiological', 'Real', 'Accepted', 'Cleared FFT ROI/frequency range via Esc', 'Cleared current annotation via Backspace']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['ReviewInterval', "'1s' | '0.5s' | '0.25s' | '4s' | '3.5s'", 'REVIEW_LABELS_BY_BIOMARKER', 'Pathological', 'Physiological', 'Artifact', "Spindle: [\'Real\', \'Spike\', \'Artifact\']", "Spike: [\'Accepted\', \'Artifact\']", 'REVIEW_INTERVALS_BY_BIOMARKER', "HFO: ['1s', '0.5s', '0.25s']", "Spindle: ['4s', '3.5s']", 'PYQT_ANNOTATION_DEFAULT_MIN_FREQUENCY = 1', 'PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY = 1000', 'setMinFrequency(PYQT_ANNOTATION_DEFAULT_MIN_FREQUENCY)', 'setMaxFrequency(PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY)', 'selectedReviewLabel', 'hasSelectedReviewLabel', 'reviewLabelOptions.includes(selectedReviewLabel)', 'value={hasSelectedReviewLabel ? selectedReviewLabel : ""}', 'disabled={!hasSelectedReviewLabel}', '--- Event Type ---', 'reviewBiomarkerType', 'intervalPaddingSeconds', 'reviewIntervalLabel', 'PredictionScopeBox', 'filterEventsForScope', 'eventScopeOptions', 'eventHasOverlapTag', 'modelSummaryText', 'viewTransform', 'viewHistory', 'applyViewTransform', 'goViewHistory']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['hasScopedMatchNavigation', 'predictionScope !== "All events" || unannotatedOnly', 'disabled={!hasScopedMatchNavigation}', '◀ Previous', 'Next ▶']) assert.ok(review.includes(phrase), phrase);
  assert.doesNotMatch(review, /context_2s|context_5s|Event window only/);
  for (const phrase of ['MiniWaveformSvg', 'MiniFilteredTraceSvg', 'MiniTimeFrequencySvg', 'LightReviewPlotFrame', 'preserveAspectRatio="none"', 'REVIEW_PLOT_BACKGROUND', 'PyQt plot stroke-lightness batch parity', 'REVIEW_PLOT_GRID', 'REVIEW_PLOT_AXIS', 'PyQt Annotation dense axis tick parity', 'REVIEW_TICK_TEXT', 'REVIEW_TICK_FONT_SIZE = 13', 'REVIEW_AXIS_LABEL_FONT_SIZE = 14', 'REVIEW_PYQT_DENSE_TIME_TICK_LIMIT = 20', 'REVIEW_PYQT_FFT_FREQUENCY_TICKS = [200, 400, 600, 800] as const', 'REVIEW_PYQT_FFT_POWER_TICKS = [20, 40, 60, 80] as const', 'REVIEW_SVG_WIDTH = 980', 'REVIEW_PLOT_MARGIN', 'REVIEW_EVENT_BAND', 'pyqt-review_event_highlight_band', 'pyqt-filtered_event_highlight_band', 'pyqt-time_frequency_event_highlight_band', 'reviewTimeTicks', 'duration <= 2.5 ? 0.1 : 0.5', 'if (ticks.length >= REVIEW_PYQT_DENSE_TIME_TICK_LIMIT) break', 'reviewFrequencyTicks', 'reviewFftFrequencyTicks', 'reviewFftPowerTicks', 'fftBinsToPoints', 'reviewEventBandRect', 'Amplitude (µV)', 'Frequency (Hz)', 'PSD (%)', 'Time (s)', 'xLabel && (', 'xLabel=""', 'vectorEffect="non-scaling-stroke"', 'useSvgSize(REVIEW_SVG_WIDTH', 'ResizeObserver', 'REVIEW_RAW_TRACE', 'REVIEW_FILTERED_TRACE', 'REVIEW_FFT_TRACE', 'strokeWidth="1.05"', 'maxFrequency={maxFrequency}', 'filtered_trace?.data', 'time_frequency?.intensity', 'timeFrequencyCellsFromBackend', 'PyQt Annotation time-frequency display-limit parity', 'display_limits', 'display_transform', 'maxIntensity <= 1', 'computeFilteredTrace', 'computeTimeFrequencyCells', 'dftAmplitudeAtFrequency', 'timeFrequencyColor', 'magmaColor', "colormap === 'magma'", 'rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})', 'computeFftBins', 'drawReviewSnapshotPng', 'drawSnapshotWaveform', 'drawSnapshotFft', 'drawLightReviewPlotFrame', "canvas.toDataURL('image/png')", 'review_snapshot.png', 'Save Review Snapshot', 'onSavePngSnapshot', 'Saved review snapshot PNG', 'Updated TF/FFT frequency range']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['high frequency at top', 'Filtered Tracing ·', 'FFT ·', '{minFrequency}-{maxFrequency} Hz']) assert.ok(!review.includes(phrase), phrase);
  for (const phrase of ['exports:snapshot-png', 'showSaveDialog', 'writeFile', 'decodePngDataUrl', 'PNG Image']) assert.ok(main.includes(phrase), phrase);
  for (const phrase of ['events:snippet', 'events:feature-summary']) assert.ok(main.includes(phrase) && preload.includes(phrase), phrase);
  for (const phrase of ["backendFetch('/events/snippet'", "backendFetch('/events/feature-summary'", "method: 'POST'", 'JSON.stringify(payload || {})']) assert.ok(main.includes(phrase), phrase);
  for (const phrase of ['eventSnippet', 'eventFeatureSummary', 'savePngSnapshot']) assert.ok(client.includes(phrase), phrase);
  assert.ok(preload.includes('exports:snapshot-png'));
  for (const phrase of ['Event Review detail owner', 'Event Review main layout owner', 'Event Review right-column flow owner', '.event-review-dialog', 'grid-template-rows:40px minmax(0,1fr)!important', '.event-review-body', 'grid-template-columns:minmax(640px,1.25fr) minmax(390px,.75fr)!important', '.event-review-left-panel', 'contain:layout paint!important', '[data-testid="pyqt-AnnotationPlot"]{order:1!important}', '[data-testid="pyqt-FilteredTracingPlot"]{order:2!important}', '[data-testid="pyqt-TimeFrequencyPlot"]{order:3!important}']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['Event Review right-column flow owner', '.event-review-dialog .annotation-side-stack{', 'flex-direction:column!important', 'Event Review frequency controls owner', '.annotation-side-stack [data-testid="pyqt-frequency_range_group"] .frequency-controls', 'grid-template-columns:repeat(3,92px)!important']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['Event Review annotation navigation owner', '.event-review-dialog .annotation-side-stack .annotation-navigation-row', '.event-review-dialog .annotation-side-stack .annotation-navigation-row button', 'display:flex!important', 'flex:1 1 76px!important', 'text-overflow:ellipsis!important', 'Event Review detail actions owner', '.event-review-dialog .event-detail-card .annotation-detail-actions', 'display:grid!important', 'grid-template-columns:repeat(5,minmax(0,1fr))!important', 'min-block-size:var(--ui-action-h)!important', 'Event Review side-stack source-order owner']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['@media(max-width:760px)', '.event-review-dialog .event-detail-card', 'order:1!important', '.event-review-dialog .event-detail-card .annotation-detail-actions', 'order:6!important', 'grid-template-columns:repeat(2,minmax(0,1fr))!important', '.event-review-dialog .event-review-left-panel', 'order:2!important', 'grid-template-rows:minmax(110px,1fr) minmax(110px,1fr) minmax(150px,1.3fr) minmax(150px,1.3fr) 20px minmax(38px,auto)!important']) assert.ok(css.includes(phrase), phrase);
  for (const phrase of ['PYQT_ANNOTATION_SINE_TRACE_SOURCE', 'visual-fixture-pyqt-annotation-sine-trace', 'pyqtAnnotationSineTraceAt', 'visual-fixture-only', 'production backend snippets continue to show the', "filtered_trace: { status: 'visual-fixture', source: PYQT_ANNOTATION_SINE_TRACE_SOURCE"]) assert.ok(fixture.includes(phrase), phrase);
  for (const phrase of ['useSvgSize(REVIEW_SVG_WIDTH, 260)', 'PYQT_ANNOTATION_VISUAL_DOMAIN_SECONDS = 2', 'reviewSnippetTimeDomain', 'isPyqtAnnotationSineTraceSnippet', 'timeFrequencyCellRect', 'waveform?.times_seconds', 'snippet?.filtered_trace?.times_seconds || waveform?.times_seconds', 'snippet?.time_frequency?.time_bins_seconds', 'domain.start', 'domain.end']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['PyqtAnnotationFixtureFftPeakMarker', 'pyqt-annotation_fixture_fft_peak_marker', 'Peak 1 Hz', '!isPyqtAnnotationSineTraceSnippet(snippet)', 'snippet={snippet}', 'isVisualFixtureFft ?']) assert.ok(review.includes(phrase), phrase);
});

test('backend review APIs preserve run-scoped saved-session event stores', () => {
  const server = read('../pyhfo/src/pyhfo/agent_api/server.py');
  const sidecar = read('../pyhfo/src/pyhfo/agent_api/sidecar.py');
  const review = read('../pyhfo/src/pyhfo/agent_api/review.py');
  const sessions = read('../pyhfo/src/pyhfo/agent_api/sessions.py');
  const state = read('src/app/workspaceState.ts');
  for (const phrase of ['ReviewFilteredTrace', 'ReviewTimeFrequency', 'display_transform?', 'display_percentiles?', 'display_limits?', 'colormap?', 'filtered_trace?', 'time_frequency?']) assert.ok(state.includes(phrase), phrase);
  for (const phrase of ['review_filtered_trace', 'review_time_frequency', 'calculate_time_frequency', 'high_frequency_at_top', 'filtered_trace', 'time_frequency', 'review_run_filters', 'saved_session_eeg_data', '_saved_session_waveform_window', 'load_session_checkpoint', '_review_filter_config', '_percentile_limits', '_normalize_display_matrix', 'pyqt_log10_percentile', 'display_percentiles', 'display_limits', 'colormap', '_downsample_matrix']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['padding_seconds=_float(query, "padding_seconds", 1.0)', 'target_samples_per_channel=_int(query, "target_samples_per_channel", 600)', 'path == "/events/snippet"', 'path == "/events/feature-summary"', 'events=payload.get("events")']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['saved_session_path', 'review_events_by_run', 'review_run_filters', 'review_active_run_id', 'review_accepted_run_id', 'review_visible_run_ids']) assert.ok(sidecar.includes(phrase), phrase);
  for (const phrase of ['run_id=query.get("run_id")', 'path == "/events"', 'session.review_events_by_run', 'session.review_run_filters', 'session.review_active_run_id', 'session.review_visible_run_ids', 'payload.get("run_id")']) assert.ok(server.includes(phrase), phrase);
  for (const phrase of ['_run_filter_params_from_analysis_session', 'review_run_filters', 'param_filter.to_dict()']) assert.ok(sessions.includes(phrase), phrase);
  for (const phrase of ['def session_events(session: Any, explicit_events', 'events_by_run', 'requested_run_id', 'run_id=run_id', 'active_run_id', 'visible_run_ids', 'events_by_run']) assert.ok(review.includes(phrase), phrase);
  for (const phrase of ['run_id=args.get("run_id")', 'review_events_by_run', 'review_run_filters', 'save_sidecar_session', 'load_sidecar_session']) assert.ok(sidecar.includes(phrase), phrase);
});
