export type ParityStatus = 'missing' | 'placeholder' | 'partial' | 'backend-only' | 'implemented' | 'waived';

export type PyQtParityItem = {
  id: string;
  pyqtObject?: string;
  label: string;
  group: string;
  status: ParityStatus;
  evidence?: string[];
};

export const pyqtParityManifest: PyQtParityItem[] = [
  { id: 'toolbar.open-recording', pyqtObject: 'actionOpen_EDF_toolbar', label: 'Open Recording', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/TopToolbar.tsx'] },
  { id: 'recording.recent-list', pyqtObject: 'recent_recordings', label: 'Recent recordings reopen/remove/clear', group: 'session', status: 'implemented', evidence: ['desktop/src/app/App.tsx', 'desktop/src/app/MainWindowShell.tsx'] },
  { id: 'project.store', pyqtObject: 'project_store', label: 'Project create/open/save and dirty state', group: 'session', status: 'implemented', evidence: ['desktop/src/app/App.tsx', 'desktop/src/features/shell/TopToolbar.tsx', 'pyhfo/src/pyhfo/agent_api/sessions.py'] },
  { id: 'toolbar.load-detection', pyqtObject: 'actionLoad_Detection_toolbar', label: 'Load Detection', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/TopToolbar.tsx', 'desktop/src/features/shell/LoadDetectionDialog.tsx'] },
  { id: 'toolbar.quick-detection', pyqtObject: 'actionQuick_Detection_toolbar', label: 'Quick Detection', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/TopToolbar.tsx', 'desktop/src/features/shell/QuickDetectionDialog.tsx'] },
  { id: 'toolbar.waveform-shortcuts', pyqtObject: 'actionWaveform_Shortcuts_toolbar', label: 'Waveform Shortcuts', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/TopToolbar.tsx', 'desktop/src/features/shell/WaveformShortcutSettingsDialog.tsx'] },
  { id: 'workflow.header', pyqtObject: 'workflowHeader', label: 'PyBrain workflow header and status chips', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/app/MainWindowShell.tsx', 'desktop/src/styles/workspace.css'] },
  { id: 'workflow.steps', pyqtObject: 'workflowSteps', label: 'Five-step workflow guide', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/app/MainWindowShell.tsx', 'desktop/src/styles/workspace.css'] },
  { id: 'status.activity', pyqtObject: 'activity_summary_label', label: 'Status strip activity dot and summary', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/app/MainWindowShell.tsx', 'desktop/src/styles/workspace.css'] },
  { id: 'biomarker.selector', pyqtObject: 'combo_box_biomarker', label: 'Biomarker Type:', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/BiomarkerBar.tsx'] },
  { id: 'workspace.empty-state', pyqtObject: 'empty_state_card', label: 'Open a recording to start review', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/app/MainWindowShell.tsx'] },
  { id: 'workspace.loaded-splitter', pyqtObject: 'QSplitter(Qt.Vertical)', label: 'Waveform/workflow vertical splitter', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/app/MainWindowShell.tsx', 'desktop/src/styles/workspace.css'] },
  { id: 'workspace.tabs.prepare', pyqtObject: 'tabWidget', label: 'Prepare', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/WorkspaceTabs.tsx'] },
  { id: 'workspace.tabs.detect', pyqtObject: 'tabWidget', label: 'Detect', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/WorkspaceTabs.tsx'] },
  { id: 'workspace.tabs.classify', pyqtObject: 'tabWidget', label: 'Classify', group: 'main-shell', status: 'implemented', evidence: ['desktop/src/features/shell/WorkspaceTabs.tsx'] },
  { id: 'waveform.channels-count', pyqtObject: 'n_channel_input', label: 'Number of Channels to Display', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx'] },
  { id: 'waveform.time-window', pyqtObject: 'display_time_window_input', label: 'Display Time Window', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx'] },
  { id: 'waveform.time-increment', pyqtObject: 'Time_Increment_Input', label: 'Display Time Window Increment', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx'] },
  { id: 'waveform.amplitude', pyqtObject: 'waveform_amplitude_input', label: 'Amp', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx'] },
  { id: 'waveform.go-to-time', pyqtObject: 'go_to_time_input', label: 'Go', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx'] },
  { id: 'waveform.normalize', pyqtObject: 'normalize_vertical_input', label: 'Normalize Vertically', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx', 'desktop/src/features/waveform/WaveformCanvas.tsx'] },
  { id: 'waveform.filtered', pyqtObject: 'toggle_filtered_checkbox', label: 'Toggle Filtered', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx', 'desktop/src/app/App.tsx', 'pyhfo/src/pyhfo/agent_api/waveform.py'] },
  { id: 'waveform.filter60', pyqtObject: 'Filter60Button', label: '60 Hz', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx', 'desktop/src/app/App.tsx', 'pyhfo/src/pyhfo/agent_api/waveform.py'] },
  { id: 'waveform.bipolar', pyqtObject: 'bipolar_button', label: 'Bipolar/Montage', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx', 'desktop/src/app/workspaceState.ts', 'desktop/src/app/App.tsx'] },
  { id: 'waveform.choose-channels', pyqtObject: 'Choose_Channels_Button', label: 'Channels', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx', 'desktop/src/features/shell/ChannelSelectionDialog.tsx'] },
  { id: 'dialog.channel-selection', pyqtObject: 'ChannelSelectionWindow', label: 'Choose visible channels', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/ChannelSelectionDialog.tsx'] },
  { id: 'dialog.selected-channels', pyqtObject: 'selected_channels.ui', label: 'Channel to Annotate / Compare To', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/ChannelSelectionDialog.tsx'] },
  { id: 'dialog.bipolar-selection', pyqtObject: 'BipolarChannelSelectionWindow', label: 'Create bipolar channel', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/BipolarChannelDialog.tsx'] },
  { id: 'dialog.quick-detection', pyqtObject: 'QuickDetection', label: 'Quick Detection', group: 'quick-detection', status: 'implemented', evidence: ['desktop/src/features/shell/QuickDetectionDialog.tsx', 'desktop/src/features/shell/quickDetectionModel.ts', 'desktop/src/app/App.tsx', 'pyhfo/src/pyhfo/agent_api/parameters.py', 'pyhfo/src/pyhfo/agent_api/pipeline.py'] },
  { id: 'dialog.load-detection', pyqtObject: 'actionLoad_Detection_toolbar', label: 'Open saved PyBrain session', group: 'session', status: 'implemented', evidence: ['desktop/src/features/shell/LoadDetectionDialog.tsx', 'desktop/src/app/App.tsx', 'pyhfo/src/pyhfo/agent_api/sessions.py', 'pyhfo/src/pyhfo/agent_api/server.py'] },
  { id: 'dialog.waveform-shortcuts', pyqtObject: 'WaveformShortcutSettingsDialog', label: 'Waveform shortcut settings', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformShortcutSettingsDialog.tsx', 'desktop/src/app/MainWindowShell.tsx', 'desktop/src/features/waveform/WaveformCanvas.tsx'] },
  { id: 'detect.hfo-forms', pyqtObject: 'detector_subtabs', label: 'HFO detector parameter forms', group: 'detect', status: 'implemented', evidence: ['desktop/src/features/shell/DetectorForms.tsx', 'desktop/src/app/workspaceState.ts', 'pyhfo/src/pyhfo/agent_api/parameters.py', 'pyhfo/src/pyhfo/agent_api/pipeline.py'] },
  { id: 'detect.spindle-forms', pyqtObject: 'detector_subtabs', label: 'Spindle detector parameter forms', group: 'detect', status: 'implemented', evidence: ['desktop/src/features/shell/DetectorForms.tsx', 'desktop/src/app/workspaceState.ts', 'pyhfo/src/pyhfo/agent_api/parameters.py', 'pyhfo/src/pyhfo/agent_api/pipeline.py'] },
  { id: 'detect.spike-form', pyqtObject: 'detector_subtabs', label: 'Spike detector parameter form', group: 'detect', status: 'implemented', evidence: ['desktop/src/features/shell/DetectorForms.tsx', 'desktop/src/app/workspaceState.ts', 'pyhfo/src/pyhfo/agent_api/parameters.py', 'pyhfo/src/pyhfo/agent_api/pipeline.py'] },
  { id: 'classifier.mode-header', pyqtObject: 'classifier_mode_combo', label: 'Classifier preset and classify action', group: 'classifier', status: 'implemented', evidence: ['desktop/src/features/shell/ClassifierTab.tsx', 'desktop/src/features/shell/WorkspaceTabs.tsx', 'pyhfo/src/pyhfo/agent_api/pipeline.py'] },
  { id: 'classifier.local-models', pyqtObject: 'groupBox', label: 'Local classifier model sources', group: 'classifier', status: 'implemented', evidence: ['desktop/src/features/shell/ClassifierTab.tsx', 'desktop/electron/main.ts'] },
  { id: 'classifier.hub-models', pyqtObject: 'groupBox_2', label: 'Hugging Face classifier model sources', group: 'classifier', status: 'implemented', evidence: ['desktop/src/features/shell/ClassifierTab.tsx', 'desktop/src/features/shell/WorkspaceTabs.tsx'] },
  { id: 'classifier.stack', pyqtObject: 'classifier_groupbox_4', label: 'Classifier stack overview and run button', group: 'classifier', status: 'implemented', evidence: ['desktop/src/features/shell/ClassifierTab.tsx', 'desktop/src/features/shell/WorkspaceTabs.tsx', 'pyhfo/src/pyhfo/agent_api/pipeline.py'] },
  { id: 'review.run-actions', pyqtObject: 'run_actions_card', label: 'Run Actions card', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/WorkspaceTabs.tsx'] },
  { id: 'review.run-registry', pyqtObject: 'run_table', label: 'Run registry and decision desk', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/WorkspaceTabs.tsx', 'desktop/src/features/shell/RunStatisticsDialog.tsx', 'desktop/src/app/App.tsx'] },
  { id: 'review.active-run', pyqtObject: 'active_run_name_label', label: 'Active run snapshot', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/WorkspaceTabs.tsx', 'desktop/src/app/workspaceState.ts'] },
  { id: 'review.annotation-window', pyqtObject: 'Annotation', label: 'Event-by-event annotation window', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/EventReviewDialog.tsx', 'desktop/src/app/App.tsx'] },
  { id: 'review.annotation-waveform', pyqtObject: 'AnnotationPlot', label: 'Annotation waveform snippet pane', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/EventReviewDialog.tsx', 'pyhfo/src/pyhfo/agent_api/review.py'] },
  { id: 'review.annotation-fft', pyqtObject: 'FFT_layout', label: 'Annotation FFT/frequency pane', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/EventReviewDialog.tsx', 'pyhfo/src/pyhfo/agent_api/review.py'] },
  { id: 'review.annotation-view-controls', pyqtObject: 'SyncViewsCheckBox', label: 'Annotation Sync X, history, snapshot controls', group: 'review', status: 'implemented', evidence: ['desktop/src/features/shell/EventReviewDialog.tsx', 'desktop/electron/main.ts'] },
  { id: 'review.backend-events', pyqtObject: 'list_events', label: 'Review events, annotations, overlap review backend bridge', group: 'review', status: 'implemented', evidence: ['desktop/src/api/backendClient.ts', 'desktop/electron/main.ts', 'pyhfo/src/pyhfo/agent_api/review.py', 'pyhfo/src/pyhfo/agent_api/server.py'] },
  { id: 'waveform.review-tools', pyqtObject: 'waveform_toolbar_frame', label: 'Event/review waveform tools', group: 'waveform', status: 'implemented', evidence: ['desktop/src/features/shell/WaveformToolbar.tsx', 'desktop/src/app/MainWindowShell.tsx', 'desktop/src/features/waveform/WaveformCanvas.tsx', 'pyhfo/src/pyhfo/agent_api/review.py'] },
  { id: 'agent.activity-bar', label: 'VS Code-like Agent activity bar', group: 'agent', status: 'implemented', evidence: ['desktop/src/features/agent/AgentActivityBar.tsx', 'desktop/src/features/agent/AgentPanel.tsx'] }
];

export const requiredParityGroups = ['main-shell', 'session', 'waveform', 'detect', 'classifier', 'review', 'quick-detection', 'agent'];
