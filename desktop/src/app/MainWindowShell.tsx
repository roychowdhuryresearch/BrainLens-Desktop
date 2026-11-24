/* PyQt MainWindowShell source-contract anchors retained across formatter styles:
'batchProject'
'recordingInfo'
event.key !== 'Escape'
onUpdatePlot({ ...zoomedControls, channelStartIndex: nextChannelStart, startSeconds: nextTimeStart })
setActiveDialog('channels')
'quickDetection'
'runtimeLog'
'loadDetection'
'waveformShortcuts'
'eventReview'
'runStats'
toDataURL('image/png')
onPrepareControlsChange({ ...prepareControls, nJobs: Number(event.target.value) })
onBatchProject={() => setActiveDialog('batchProject')}
channelFocusMode: 'events'
setActiveDialog('bipolar')
onOpenReview={() => setActiveDialog('eventReview')}
value === 'gentle' || value === 'default' || value === 'fast'
activeDialog === 'batchProject'
onShowArtifacts={() => openAgentTab('Artifacts')}
onWaveformControlsChange({ ...waveformControls, cursorEnabled: false, measureEnabled: false })
shortcutId === 'hotspot'
shortcutId === 'center_event'
navigateReviewEvent('current')
shortcutId === 'next_pending'
navigateReviewEvent('pending')
onDeferredAction('Waveform settings updated')
data-agent-open={agentOpen ? 'true' : 'false'}
agentOpen && <AgentPanel
localStorage.setItem(AGENT_PANEL_WIDTH_STORAGE_KEY
localStorage.setItem(WORKSPACE_SPLIT_STORAGE_KEY
*/
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type {
  AgentArtifact,
  AgentChatMessage,
  AgentPanelTab,
  BiomarkerType,
  CapabilityManifest,
  EventFeatureSummary,
  PrepareControlsState,
  RecentRecording,
  RecordingAnalysisState,
  RecordingMetadata,
  ReviewEvent,
  ReviewSnippet,
  RunRecord,
  RuntimeLogEntry,
  RuntimeOperation,
  SeveritySegmentScore,
  WaveformControlsState,
  WorkspaceTab,
} from "./workspaceState";
import {
  activeWaveformChannels,
  channelCount,
  channelSelectionSummary,
  clampWaveformControls,
  detectorTabsByBiomarker,
  recordingDurationSeconds,
  recordingFileName,
  formatRecordingClock,
  recordingLengthLabel,
  sampleFrequency,
  supportsSeverityScoring,
  waveformChannelUniverse,
} from "./workspaceState";
import { TopToolbar } from "../features/shell/TopToolbar";
import {
  BiomarkerBar,
  BiomarkerHeaderSelect,
  WaveformHeaderModeBadges,
} from "../features/shell/BiomarkerBar";
import { WaveformToolbar } from "../features/shell/WaveformToolbar";
import { WorkspaceTabs } from "../features/shell/WorkspaceTabs";
import { SeverityTab } from "../features/shell/SeverityTab";
import type { DetectorRunRequest } from "../features/shell/DetectorForms";
import { DETECTOR_FIELDS, detectorParamsForRun } from "../features/shell/DetectorForms";
import type {
  ClassifierControlsState,
  ClassifierMode,
  ClassifierRunRequest,
} from "../features/shell/ClassifierTab";
import {
  classifierModesForBiomarker,
  classifierPayloadFromState,
  defaultClassifierPatch,
} from "../features/shell/ClassifierTab";
import type { SeverityRunState } from "../features/shell/SeverityTab";
import { ChannelSelectionDialog } from "../features/shell/ChannelSelectionDialog";
import { BipolarChannelDialog } from "../features/shell/BipolarChannelDialog";
import { QuickDetectionDialog } from "../features/shell/QuickDetectionDialog";
import { LoadDetectionDialog } from "../features/shell/LoadDetectionDialog";
import { BatchProjectDialog } from "../features/shell/BatchProjectDialog";
import { EventReviewDialog } from "../features/shell/EventReviewDialog";
import { RunStatisticsDialog } from "../features/shell/RunStatisticsDialog";
import { RecordingInfoDialog } from "../features/shell/RecordingInfoDialog";
import { RuntimeLogDialog } from "../features/shell/RuntimeLogDialog";
import {
  DEFAULT_WAVEFORM_SHORTCUT_SETTINGS,
  WaveformShortcutSettingsDialog,
  eventToShortcutText,
  normalizeShortcutText,
  normalizedBindings,
  validateWaveformShortcutBindings,
  type WaveformShortcutSettings,
} from "../features/shell/WaveformShortcutSettingsDialog";
import { AgentActivityBar } from "../features/agent/AgentActivityBar";
import { AgentPanel } from "../features/agent/AgentPanel";
import type { AgentAutonomyLevel, HistoryEntry, UICommand } from "../features/agent/uiCommands";
import {
  WaveformCanvas,
  type WaveformEventOverlay,
  type WaveformMeasurementStatus,
  type WaveformTrackpadSensitivity,
  type WaveformWheelNavigation,
  type WaveformWindow,
} from "../features/waveform/WaveformCanvas";
import { WaveformOverview } from "../features/waveform/WaveformOverview";

const AGENT_PANEL_WIDTH_STORAGE_KEY = "ieeg.agentPanelWidth";
const AGENT_PANEL_TAB_STORAGE_KEY = "ieeg.agentPanelTab";
const DEFAULT_AGENT_PANEL_WIDTH = 336;
const MIN_AGENT_PANEL_WIDTH = 300;
const MAX_AGENT_PANEL_WIDTH = 520;
const WORKSPACE_SPLIT_STORAGE_KEY = "ieeg.workspaceSplitPercent";
const WORKSPACE_SPLIT_LAYOUT_VERSION_STORAGE_KEY =
  "ieeg.workspaceSplitLayoutVersion";
const WORKSPACE_SPLIT_LAYOUT_VERSION =
  "pyqt-horizontal-waveform-tabs-split-2026-06-02";
const DEFAULT_WORKSPACE_SPLIT_PERCENT = 62;
const MIN_WORKSPACE_SPLIT_PERCENT = 30;
const MAX_WORKSPACE_SPLIT_PERCENT = 82;
const WAVEFORM_SHORTCUT_SETTINGS_STORAGE_KEY = "ieeg.waveformShortcutSettings";

function defaultWaveformShortcutSettings(): WaveformShortcutSettings {
  return {
    ...DEFAULT_WAVEFORM_SHORTCUT_SETTINGS,
    bindings: { ...DEFAULT_WAVEFORM_SHORTCUT_SETTINGS.bindings },
  };
}

function loadWaveformShortcutSettings(): WaveformShortcutSettings {
  if (typeof window === "undefined") return defaultWaveformShortcutSettings();
  try {
    return normalizePersistedWaveformShortcutSettings(
      JSON.parse(
        window.localStorage.getItem(WAVEFORM_SHORTCUT_SETTINGS_STORAGE_KEY) ||
          "null",
      ),
    );
  } catch {
    return defaultWaveformShortcutSettings();
  }
}

function normalizePersistedWaveformShortcutSettings(
  value: unknown,
): WaveformShortcutSettings {
  const defaults = defaultWaveformShortcutSettings();
  if (!value || typeof value !== "object") return defaults;
  const record = value as Partial<WaveformShortcutSettings>;
  const bindings = {
    ...defaults.bindings,
    ...(record.bindings && typeof record.bindings === "object"
      ? record.bindings
      : {}),
  };
  const settings: WaveformShortcutSettings = {
    enabled:
      typeof record.enabled === "boolean" ? record.enabled : defaults.enabled,
    trackpadSensitivity: isWaveformTrackpadSensitivity(
      record.trackpadSensitivity,
    )
      ? record.trackpadSensitivity
      : defaults.trackpadSensitivity,
    bindings,
  };
  return validateWaveformShortcutBindings(settings.enabled, settings.bindings)
    ? defaults
    : settings;
}

function isWaveformTrackpadSensitivity(
  value: unknown,
): value is WaveformShortcutSettings["trackpadSensitivity"] {
  return value === "gentle" || value === "default" || value === "fast";
}

function persistWaveformShortcutSettings(settings: WaveformShortcutSettings) {
  window.localStorage.setItem(
    WAVEFORM_SHORTCUT_SETTINGS_STORAGE_KEY,
    JSON.stringify(settings),
  );
}

function clampAgentPanelWidth(value: number): number {
  return Math.min(
    MAX_AGENT_PANEL_WIDTH,
    Math.max(MIN_AGENT_PANEL_WIDTH, Math.round(value)),
  );
}

function loadAgentPanelWidth(): number {
  if (typeof window === "undefined") return DEFAULT_AGENT_PANEL_WIDTH;
  const saved = Number(
    window.localStorage.getItem(AGENT_PANEL_WIDTH_STORAGE_KEY),
  );
  return Number.isFinite(saved)
    ? clampAgentPanelWidth(saved)
    : DEFAULT_AGENT_PANEL_WIDTH;
}

function loadAgentPanelTab(): AgentPanelTab {
  if (typeof window === "undefined") return "Chat";
  const saved = window.localStorage.getItem(AGENT_PANEL_TAB_STORAGE_KEY);
  return isAgentPanelTab(saved) ? saved : "Chat";
}

function isAgentPanelTab(value: unknown): value is AgentPanelTab {
  return (
    value === "Chat" ||
    value === "Actions" ||
    value === "Artifacts" ||
    value === "Safety"
  );
}

function clampWorkspaceSplitPercent(value: number): number {
  return Math.min(
    MAX_WORKSPACE_SPLIT_PERCENT,
    Math.max(MIN_WORKSPACE_SPLIT_PERCENT, Math.round(value)),
  );
}

function loadWorkspaceSplitPercent(): number {
  if (typeof window === "undefined") return DEFAULT_WORKSPACE_SPLIT_PERCENT;
  const savedVersion = window.localStorage.getItem(
    WORKSPACE_SPLIT_LAYOUT_VERSION_STORAGE_KEY,
  );
  if (savedVersion !== WORKSPACE_SPLIT_LAYOUT_VERSION) {
    window.localStorage.setItem(
      WORKSPACE_SPLIT_LAYOUT_VERSION_STORAGE_KEY,
      WORKSPACE_SPLIT_LAYOUT_VERSION,
    );
    window.localStorage.setItem(
      WORKSPACE_SPLIT_STORAGE_KEY,
      String(DEFAULT_WORKSPACE_SPLIT_PERCENT),
    );
    return DEFAULT_WORKSPACE_SPLIT_PERCENT;
  }
  const saved = Number(
    window.localStorage.getItem(WORKSPACE_SPLIT_STORAGE_KEY),
  );
  return Number.isFinite(saved)
    ? clampWorkspaceSplitPercent(saved)
    : DEFAULT_WORKSPACE_SPLIT_PERCENT;
}

export function MainWindowShell({
  recordingPath,
  metadata,
  quickDetectionMetadata,
  recentRecordings,
  projectPath,
  projectId,
  projectDirty,
  capabilityManifest,
  waveform,
  waveformControls,
  prepareControls,
  recordingAnalysis,
  classifierControls,
  classifierFeedback,
  severityState,
  runRecords,
  activeRunId,
  acceptedRunId,
  visibleRunIds,
  runEventsByRun,
  reviewEvents,
  selectedReviewEventId,
  runtimeOperation,
  runtimeLog,
  uiCommandHistory,
  pendingShellCommand,
  onShellCommandHandled,
  agentArtifacts,
  error,
  message,
  agentChatLog,
  agentConversations,
  activeAgentConversationId,
  onSelectAgentConversation,
  onNewAgentConversation,
  onCloseAgentConversation,
  agentResponding,
  agentStreamingText,
  agentAutonomy,
  onAgentAutonomyChange,
  statusMessage,
  onMessageChange,
  onNewProject,
  onOpenProject,
  onSaveProject,
  onOpenRecording,
  onOpenRecentRecording,
  onRemoveRecentRecording,
  onClearRecentRecordings,
  onOpenSavedSession,
  onOpenClassifierModel,
  onLoadSavedSession,
  onSendAgentMessage,
  onWaveformControlsChange,
  onPrepareControlsChange,
  onRecordingAnalysisChange,
  onClassifierControlsChange,
  onClassifierFeedbackChange,
  onAnalyzeRecordingPlanning,
  onApplyFilters,
  onSaveNJobs,
  onRunDetection,
  onRunClassifier,
  onRunSeverityScoring,
  onCancelSeverityScoring,
  onSeekToSeconds,
  onCancelRuntimeOperation,
  onActivateRun,
  onToggleRunVisible,
  onAcceptRun,
  onCreateConsensusRun,
  onExportSession,
  onExportWorkbook,
  onExportReport,
  onSelectReviewEvent,
  onAnnotateEvent,
  onLoadEventSnippet,
  onLoadEventFeatureSummary,
  onSavePngSnapshot,
  onOpenAgentArtifact,
  onRevealAgentArtifact,
  onRemoveAgentArtifact,
  onClearAgentArtifacts,
  onApplyStagedCommand,
  onDismissStagedCommand,
  onOverlapReview,
  onUpdatePlot,
  onDeferredAction,
  onUiSurfaceChange,
}: {
  recordingPath: string | null;
  metadata: RecordingMetadata | null;
  quickDetectionMetadata?: RecordingMetadata | null;
  recentRecordings: RecentRecording[];
  projectPath: string | null;
  projectId: string | null;
  projectDirty: boolean;
  capabilityManifest: CapabilityManifest | null;
  waveform: WaveformWindow | null;
  waveformControls: WaveformControlsState;
  prepareControls: PrepareControlsState;
  recordingAnalysis: RecordingAnalysisState;
  classifierControls: ClassifierControlsState;
  classifierFeedback: string;
  severityState: SeverityRunState;
  runRecords: RunRecord[];
  activeRunId: string | null;
  acceptedRunId: string | null;
  visibleRunIds: string[];
  runEventsByRun: Record<string, ReviewEvent[]>;
  reviewEvents: ReviewEvent[];
  selectedReviewEventId: string;
  runtimeOperation: RuntimeOperation;
  runtimeLog: RuntimeLogEntry[];
  uiCommandHistory: HistoryEntry[];
  pendingShellCommand?: UICommand | null;
  onShellCommandHandled?: (commandId: string) => void;
  agentArtifacts: AgentArtifact[];
  error: string | null;
  message: string;
  agentChatLog: AgentChatMessage[];
  agentConversations: Array<{ id: string; title: string }>;
  activeAgentConversationId: string;
  onSelectAgentConversation: (conversationId: string) => void;
  onNewAgentConversation: () => void;
  onCloseAgentConversation: (conversationId: string) => void;
  agentResponding: boolean;
  agentStreamingText: string;
  agentAutonomy: AgentAutonomyLevel;
  onAgentAutonomyChange: (level: AgentAutonomyLevel) => void;
  statusMessage: string;
  onMessageChange: (value: string) => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onOpenRecording: () => void;
  onOpenRecentRecording: (path: string) => void;
  onRemoveRecentRecording: (path: string) => void;
  onClearRecentRecordings: () => void;
  onOpenSavedSession: () => Promise<string | null>;
  onOpenClassifierModel: () => Promise<string | null>;
  onLoadSavedSession: (sessionPath: string) => Promise<void>;
  onSendAgentMessage: () => void;
  onWaveformControlsChange: (controls: WaveformControlsState) => void;
  onPrepareControlsChange: (controls: PrepareControlsState) => void;
  onRecordingAnalysisChange: (analysis: RecordingAnalysisState) => void;
  onClassifierControlsChange: (controls: ClassifierControlsState) => void;
  onClassifierFeedbackChange: (feedback: string) => void;
  onAnalyzeRecordingPlanning: () => Promise<void> | void;
  onApplyFilters: () => void;
  onSaveNJobs: () => void;
  onRunDetection: (request: DetectorRunRequest) => Promise<void> | void;
  onRunClassifier: (request: ClassifierRunRequest) => Promise<void> | void;
  onRunSeverityScoring: () => Promise<unknown> | void;
  onCancelSeverityScoring: () => Promise<unknown> | void;
  onSeekToSeconds: (startSeconds: number) => void;
  onCancelRuntimeOperation: () => void;
  onActivateRun: (runId: string) => void;
  onToggleRunVisible: (runId: string, visible: boolean) => void;
  onAcceptRun: (runId?: string) => void;
  onCreateConsensusRun: (
    strategy: "union" | "majority" | "intersection",
  ) => void;
  onExportSession: (runId?: string) => Promise<void> | void;
  onExportWorkbook: (runId?: string) => Promise<void> | void;
  onExportReport: (runId?: string) => Promise<void> | void;
  onSelectReviewEvent: (event: ReviewEvent) => void;
  onAnnotateEvent: (
    event: ReviewEvent,
    label: string,
    notes: string,
  ) => Promise<void>;
  onLoadEventSnippet: (
    event: ReviewEvent,
    paddingSeconds?: number,
  ) => Promise<ReviewSnippet | null>;
  onLoadEventFeatureSummary: (
    event: ReviewEvent,
  ) => Promise<EventFeatureSummary | null>;
  onSavePngSnapshot: (request: {
    data_url: string;
    default_name: string;
    title: string;
  }) => Promise<unknown>;
  onOpenAgentArtifact: (path: string) => Promise<void> | void;
  onRevealAgentArtifact: (path: string) => Promise<void> | void;
  onRemoveAgentArtifact: (id: string) => void;
  onClearAgentArtifacts: () => void;
  onApplyStagedCommand: (commandId: string) => void;
  onDismissStagedCommand: (commandId: string) => void;
  onOverlapReview: () => void;
  onUpdatePlot: (controls: WaveformControlsState) => void;
  onDeferredAction: (action: string) => void;
  onUiSurfaceChange?: (surface: { dialog: string | null; tab: string; agentTab: string | null }) => void;
}) {
  const [biomarker, setBiomarker] = useState<BiomarkerType>("HFO");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("Prepare");
  // Product flow: loading an EEG lands on waveform review + the control rail (home).
  // Prepare/Detect/Classify are on-demand work surfaces opened from the rail/header.
  const [workflowPanelExpanded, setWorkflowPanelExpanded] = useState(false);
  // The workflow panel is a fixed-position popover anchored under the Prep/Detect/Classify buttons.
  // position:fixed matters: it takes no grid space and needs no positioned ancestor, so it cannot
  // disturb the pipeline rail (which is absolutely positioned inside the workspace) the way an
  // absolutely-positioned panel did.
  const workflowAnchorRef = useRef<HTMLDivElement | null>(null);
  const [workflowPopoverStyle, setWorkflowPopoverStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!workflowPanelExpanded) return undefined;
    const place = () => {
      const anchor = workflowAnchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const right = Math.max(8, Math.round(window.innerWidth - rect.right));
      const top = Math.round(rect.bottom + 8);
      setWorkflowPopoverStyle({
        top,
        right,
        maxWidth: Math.max(320, Math.round(window.innerWidth - right - 16)),
        maxHeight: Math.max(200, Math.round(window.innerHeight - top - 40)),
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [workflowPanelExpanded, activeTab]);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentPanelWidth, setAgentPanelWidth] = useState(loadAgentPanelWidth);
  const [workspaceSplitPercent, setWorkspaceSplitPercent] = useState(
    loadWorkspaceSplitPercent,
  );
  const [agentTab, setAgentTab] = useState<AgentPanelTab>(loadAgentPanelTab);
  const [activeDialog, setActiveDialog] = useState<
    | "channels"
    | "bipolar"
    | "quickDetection"
    | "batchProject"
    | "loadDetection"
    | "waveformShortcuts"
    | "recordingInfo"
    | "runtimeLog"
    | "eventReview"
    | "runStats"
    | null
  >(null);
  const [shortcutSettings, setShortcutSettings] =
    useState<WaveformShortcutSettings>(loadWaveformShortcutSettings);
  const [waveformMeasurementStatus, setWaveformMeasurementStatus] =
    useState<WaveformMeasurementStatus>({
      text: "",
      tooltip: "",
      overlayText: "",
      pointCount: 0,
    });
  const hasRecording = Boolean(recordingPath);
  const toolbarReviewEvents = useMemo(
    () =>
      reviewEvents.filter((event) =>
        canonicalWaveformChannel(event.channel || "", metadata, waveformControls),
      ),
    [reviewEvents, metadata, waveformControls],
  );
  const selectedReviewEventIndex = useMemo(
    () =>
      toolbarReviewEvents.findIndex(
        (event) => event.event_id === selectedReviewEventId,
      ),
    [toolbarReviewEvents, selectedReviewEventId],
  );
  const eventPositionLabel = useMemo(
    () =>
      toolbarReviewEvents.length
        ? `Event ${(selectedReviewEventIndex >= 0 ? selectedReviewEventIndex : 0) + 1} / ${toolbarReviewEvents.length}`
        : "No events",
    [selectedReviewEventIndex, toolbarReviewEvents.length],
  );
  const hasToolbarEventNavigation = toolbarReviewEvents.length > 0;
  const projectLabel = useMemo(
    () =>
      projectId ||
      (projectPath ? recordingFileName(projectPath, null) : "No Project"),
    [projectId, projectPath],
  );
  const mainWindowStyle = useMemo(
    () =>
      ({
        "--agent-panel-width": `${agentPanelWidth}px`,
        "--workspace-waveform-percent": `${workspaceSplitPercent}%`,
      }) as CSSProperties,
    [agentPanelWidth, workspaceSplitPercent],
  );
  const channelAmplitudes = useMemo(
    () => waveformChannelAmplitudes(waveform),
    [waveform],
  );
  const statusStripMessage = useMemo(
    () =>
      waveform?.source === "visual-fixture-pyqt-visible-order"
        ? "Ready"
        : error || statusMessage,
    [error, statusMessage, waveform?.source],
  );

  const openWorkflowTab = useCallback((tab: WorkspaceTab) => {
    setActiveTab(tab);
    setWorkflowPanelExpanded(true);
  }, []);

  const closeWorkflowPanel = useCallback(() => {
    setWorkflowPanelExpanded(false);
  }, []);

  const closeActiveDialog = useCallback(() => setActiveDialog(null), []);
  // Report which UI surface is open up to App, so get_ui_state can tell the agent what it actually
  // opened (the bare active_panel is always 'workspace'). Cheap; runs only when a surface changes.
  useEffect(() => {
    onUiSurfaceChange?.({ dialog: activeDialog, tab: activeTab, agentTab: agentOpen ? agentTab : null });
  }, [activeDialog, activeTab, agentOpen, agentTab, onUiSurfaceChange]);
  const openChannelsDialog = useCallback(() => setActiveDialog("channels"), []);
  const openBipolarDialog = useCallback(() => setActiveDialog("bipolar"), []);
  const openQuickDetectionDialog = useCallback(
    () => setActiveDialog("quickDetection"),
    [],
  );
  const openBatchProjectDialog = useCallback(
    () => setActiveDialog("batchProject"),
    [],
  );
  const openLoadDetectionDialog = useCallback(
    () => setActiveDialog("loadDetection"),
    [],
  );
  const openWaveformShortcutsDialog = useCallback(
    () => setActiveDialog("waveformShortcuts"),
    [],
  );
  const openRuntimeLogDialog = useCallback(
    () => setActiveDialog("runtimeLog"),
    [],
  );
  const openEventReviewDialog = useCallback(
    () => setActiveDialog("eventReview"),
    [],
  );
  const openRunStatsDialog = useCallback(() => setActiveDialog("runStats"), []);
  const openRecordingInfoDialog = useCallback(
    () => setActiveDialog("recordingInfo"),
    [],
  );
  const openDetectWorkflowTab = useCallback(
    () => openWorkflowTab("Detect"),
    [openWorkflowTab],
  );
  const openPrepareWorkflowTab = useCallback(
    () => openWorkflowTab("Prepare"),
    [openWorkflowTab],
  );
  const openClassifyWorkflowTab = useCallback(
    () => openWorkflowTab("Classify"),
    [openWorkflowTab],
  );
  const openAgentTab = useCallback((tab: AgentPanelTab) => {
    setAgentTab(tab);
    setAgentOpen(true);
  }, []);
  const closeAgentPanel = useCallback(() => setAgentOpen(false), []);
  const showAgentArtifacts = useCallback(
    () => openAgentTab("Artifacts"),
    [openAgentTab],
  );

  useEffect(() => {
    if (!pendingShellCommand) return;
    const payload = pendingShellCommand.payload || {};
    const rawTarget = String(
      payload.panel ||
        payload.dialog ||
        payload.tab ||
        payload.target ||
        (pendingShellCommand.type === "review.open_event" ? "review" : ""),
    ).trim();
    const target = rawTarget.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const openAgentPanelTab = (tab: AgentPanelTab) => {
      openAgentTab(tab);
      onDeferredAction(`Agent opened ${tab}.`);
    };
    const openWorkflow = (tab: WorkspaceTab) => {
      openWorkflowTab(tab);
      onDeferredAction(`Agent opened ${tab}.`);
    };

    if (pendingShellCommand.type === "workspace.open_panel") {
      if (["chat", "agentchat"].includes(target)) openAgentPanelTab("Chat");
      else if (["actions", "agentactions", "actiontrace"].includes(target)) openAgentPanelTab("Actions");
      else if (["artifacts", "agentartifacts"].includes(target)) openAgentPanelTab("Artifacts");
      else if (["safety", "agentsafety"].includes(target)) openAgentPanelTab("Safety");
      else if (target === "prepare" || target === "prep") openWorkflow("Prepare");
      else if (target === "detect" || target === "detection") openWorkflow("Detect");
      else if (target === "classify" || target === "classification") openWorkflow("Classify");
      else if (target === "waveform" || target === "main" || target === "workspace") {
        closeWorkflowPanel();
        onDeferredAction("Agent returned to waveform.");
      } else if (["review", "eventreview", "candidate", "candidateevidence"].includes(target)) {
        openEventReviewDialog();
        onDeferredAction("Agent opened Review.");
      } else if (["runstats", "statistics", "stats", "comparison", "runs"].includes(target)) {
        openRunStatsDialog();
        onDeferredAction("Agent opened Run Stats.");
      } else if (["recordinginfo", "metadata", "info"].includes(target)) {
        openRecordingInfoDialog();
        onDeferredAction("Agent opened Recording Info.");
      } else if (["runtimelog", "statuslog", "log"].includes(target)) {
        openRuntimeLogDialog();
        onDeferredAction("Agent opened Status Log.");
      } else if (target === "channels" || target === "channelselection") {
        openChannelsDialog();
        onDeferredAction("Agent opened Channels.");
      }
      else if (target === "montage" || target === "bipolar") {
        openBipolarDialog();
        onDeferredAction("Agent opened Montage.");
      }
      else if (target === "quickdetection" || target === "quick") {
        openQuickDetectionDialog();
        onDeferredAction("Agent opened Quick Detection.");
      }
      else if (target === "loaddetection" || target === "loadsession") openLoadDetectionDialog();
      else if (target === "batch" || target === "batchproject") openBatchProjectDialog();
      else if (target === "shortcuts" || target === "waveformshortcuts") openWaveformShortcutsDialog();
      else onDeferredAction(`Agent requested an unknown workspace panel: ${rawTarget || "blank"}.`);
    } else if (pendingShellCommand.type === "recording.inspect_metadata") {
      openRecordingInfoDialog();
      onDeferredAction("Agent opened Recording Info.");
    } else if (pendingShellCommand.type === "review.open_event") {
      openEventReviewDialog();
      onDeferredAction("Agent opened Review.");
    } else if (pendingShellCommand.type === "review.open_comparison") {
      openRunStatsDialog();
      onDeferredAction("Agent opened Run Stats.");
    } else if (pendingShellCommand.type === "artifacts.open_report") {
      openAgentPanelTab("Artifacts");
    }

    onShellCommandHandled?.(pendingShellCommand.command_id);
  }, [
    pendingShellCommand,
    onShellCommandHandled,
    openAgentTab,
    openWorkflowTab,
    closeWorkflowPanel,
    openEventReviewDialog,
    openRunStatsDialog,
    openRecordingInfoDialog,
    openRuntimeLogDialog,
    openChannelsDialog,
    openBipolarDialog,
    openQuickDetectionDialog,
    openLoadDetectionDialog,
    openBatchProjectDialog,
    openWaveformShortcutsDialog,
    onDeferredAction,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!shortcutSettings.enabled || isEditableShortcutTarget(event.target))
        return;
      const eventShortcut = eventToShortcutText(event);
      const matchedId = Object.entries(shortcutSettings.bindings).find(
        ([, value]) => normalizeShortcutText(value) === eventShortcut,
      )?.[0];
      if (!matchedId) return;
      event.preventDefault();
      runWaveformShortcut(matchedId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutSettings, waveformControls, metadata]);

  function beginAgentPanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = agentPanelWidth;
    let latestWidth = startWidth;
    document.body.classList.add("agent-panel-resizing");
    function onPointerMove(moveEvent: PointerEvent) {
      const nextWidth = clampAgentPanelWidth(
        startWidth + startX - moveEvent.clientX,
      );
      latestWidth = nextWidth;
      setAgentPanelWidth(nextWidth);
    }
    // Every way a drag can END, not just the happy one. `agent-panel-resizing` puts
    // `user-select:none` on EVERY element, so a drag that never reports its end leaves the whole
    // app unselectable -- no text in the composer, none in the transcript -- until the next
    // successful drag. pointercancel alone (touch, OS gesture, window snap) is enough to strand it.
    function endResize() {
      document.body.classList.remove("agent-panel-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endResize);
      window.removeEventListener("pointercancel", endResize);
      window.removeEventListener("blur", endResize);
      window.localStorage.setItem(
        AGENT_PANEL_WIDTH_STORAGE_KEY,
        String(latestWidth),
      );
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endResize, { once: true });
    window.addEventListener("pointercancel", endResize, { once: true });
    window.addEventListener("blur", endResize, { once: true });
  }

  // Last-resort recovery: if the resize state ever survives its drag anyway, the next pointer
  // activity with no button held clears it. Cheap, and it means a stuck state can never outlive a
  // single mouse move rather than persisting for the session.
  useEffect(() => {
    function clearStuckResizeState(pointerEvent: PointerEvent) {
      if (pointerEvent.buttons !== 0) return;
      if (!document.body.classList.contains("agent-panel-resizing")) return;
      document.body.classList.remove("agent-panel-resizing");
    }
    window.addEventListener("pointermove", clearStuckResizeState);
    window.addEventListener("pointerdown", clearStuckResizeState);
    return () => {
      window.removeEventListener("pointermove", clearStuckResizeState);
      window.removeEventListener("pointerdown", clearStuckResizeState);
    };
  }, []);

  function resizeAgentPanelByKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 24;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = clampAgentPanelWidth(agentPanelWidth + step);
    else if (event.key === "ArrowRight") nextWidth = clampAgentPanelWidth(agentPanelWidth - step);
    else if (event.key === "Home") nextWidth = MIN_AGENT_PANEL_WIDTH;
    else if (event.key === "End") nextWidth = MAX_AGENT_PANEL_WIDTH;
    if (nextWidth === null) return;
    event.preventDefault();
    setAgentPanelWidth(nextWidth);
    window.localStorage.setItem(AGENT_PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
  }

  function beginWorkspaceSplitResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    const rect = container?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const containerLeft = rect.left;
    const containerWidth = rect.width;
    let latestPercent = workspaceSplitPercent;
    document.body.classList.add("workspace-split-resizing");
    function onPointerMove(moveEvent: PointerEvent) {
      const relativeX = moveEvent.clientX - containerLeft;
      const nextPercent = clampWorkspaceSplitPercent(
        (relativeX / containerWidth) * 100,
      );
      latestPercent = nextPercent;
      setWorkspaceSplitPercent(nextPercent);
    }
    function onPointerUp() {
      document.body.classList.remove("workspace-split-resizing");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.localStorage.setItem(
        WORKSPACE_SPLIT_LAYOUT_VERSION_STORAGE_KEY,
        WORKSPACE_SPLIT_LAYOUT_VERSION,
      );
      window.localStorage.setItem(
        WORKSPACE_SPLIT_STORAGE_KEY,
        String(latestPercent),
      );
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }

  useEffect(() => {
    if (agentOpen)
      window.localStorage.setItem(
        AGENT_PANEL_WIDTH_STORAGE_KEY,
        String(agentPanelWidth),
      );
  }, [agentOpen, agentPanelWidth]);

  useEffect(() => {
    window.localStorage.setItem(AGENT_PANEL_TAB_STORAGE_KEY, agentTab);
  }, [agentTab]);

  useEffect(() => {
    if (!agentOpen) return undefined;
    function closeAgentPanelFromEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || activeDialog) return;
      if (
        isEditableShortcutTarget(event.target) &&
        !isTargetInsideAgentPanel(event.target)
      )
        return;
      event.preventDefault();
      setAgentOpen(false);
    }
    window.addEventListener("keydown", closeAgentPanelFromEscape);
    return () =>
      window.removeEventListener("keydown", closeAgentPanelFromEscape);
  }, [agentOpen, activeDialog]);

  useEffect(() => {
    window.localStorage.setItem(
      WORKSPACE_SPLIT_STORAGE_KEY,
      String(workspaceSplitPercent),
    );
  }, [workspaceSplitPercent]);

  function saveWaveformShortcutSettings(settings: WaveformShortcutSettings) {
    const normalizedSettings = {
      ...settings,
      bindings: normalizedBindings(settings.bindings),
    };
    setShortcutSettings(normalizedSettings);
    persistWaveformShortcutSettings(normalizedSettings);
    if (waveformControls.cursorEnabled || waveformControls.measureEnabled) {
      onWaveformControlsChange({
        ...waveformControls,
        cursorEnabled: false,
        measureEnabled: false,
      });
      setWaveformMeasurementStatus({
        text: "",
        tooltip: "",
        overlayText: "",
        pointCount: 0,
      });
    }
    onDeferredAction("Waveform settings updated");
  }

  useEffect(() => {
    if (!waveformControls.measureEnabled && waveformMeasurementStatus.text) {
      setWaveformMeasurementStatus({
        text: "",
        tooltip: "",
        overlayText: "",
        pointCount: 0,
      });
    }
  }, [waveformControls.measureEnabled, waveformMeasurementStatus.text]);

  const updateWaveformMeasurementStatus = useCallback(
    (status: WaveformMeasurementStatus) => {
      setWaveformMeasurementStatus((current) =>
        current.text === status.text &&
        current.tooltip === status.tooltip &&
        current.overlayText === status.overlayText &&
        current.pointCount === status.pointCount
          ? current
          : status,
      );
    },
    [],
  );

  function selectWaveformOverlayEvent(overlay: WaveformEventOverlay) {
    const runId = overlay.event.run_id || overlay.run?.runId;
    if (runId && runId !== activeRunId) onActivateRun(runId);
    selectReviewEvent(overlay.event);
    setActiveDialog("eventReview");
  }

  function selectReviewEvent(event: ReviewEvent) {
    onSelectReviewEvent(event);
    centerWaveformOnEvent(event);
  }

  function focusHotspotChannels() {
    const rankedChannels = hotspotChannelsFromEvents(
      reviewEvents,
      metadata,
      waveformControls,
    );
    if (!rankedChannels.length) {
      onDeferredAction(
        "No detected event channels are available for Hotspot focus.",
      );
      return;
    }
    const nextVisibleChannels = Math.min(
      Math.max(1, rankedChannels.length),
      Math.max(
        waveformControls.visibleChannels,
        Math.min(8, rankedChannels.length),
      ),
    );
    const nextControls = clampWaveformControls(
      {
        ...waveformControls,
        channelsToPlot: rankedChannels,
        visibleChannels: nextVisibleChannels,
        channelStartIndex: 0,
        channelFocusMode: "events",
      },
      metadata,
    );
    onUpdatePlot(nextControls);
    onDeferredAction(
      `Hotspot Channels focused ${rankedChannels.length} channel(s) ranked by ${reviewEvents.length} event(s): ${rankedChannels.slice(0, 6).join(", ")}${rankedChannels.length > 6 ? "…" : ""}`,
    );
  }


  function navigateReviewEvent(
    direction: "prev" | "current" | "next" | "pending",
  ) {
    if (!toolbarReviewEvents.length) {
      onDeferredAction("No detected events available for waveform navigation");
      return;
    }
    const currentIndex =
      selectedReviewEventIndex >= 0 ? selectedReviewEventIndex : 0;
    let nextIndex = currentIndex;
    if (direction === "next")
      nextIndex = pyqtEventNavigationIndex(toolbarReviewEvents, currentIndex, 1);
    if (direction === "prev")
      nextIndex = pyqtEventNavigationIndex(toolbarReviewEvents, currentIndex, -1);
    if (direction === "pending") {
      const pendingIndex = findPendingReviewIndex(toolbarReviewEvents, currentIndex);
      if (pendingIndex < 0) {
        onDeferredAction("All waveform-navigation events are already annotated.");
        return;
      }
      nextIndex = pendingIndex;
    }
    const event = toolbarReviewEvents[nextIndex];
    selectReviewEvent(event);
    onDeferredAction(
      `Centered on ${eventDisplayName(event)} event ${nextIndex + 1} of ${toolbarReviewEvents.length}`,
    );
  }

  function centerWaveformOnEvent(event: ReviewEvent) {
    const nextControls = { ...waveformControls };
    const midSeconds =
      Number(event.start_seconds ?? 0) +
      Math.max(0, Number(event.duration_seconds ?? 0)) / 2;
    if (Number.isFinite(midSeconds)) {
      const maxTimeStart = Math.max(
        0,
        recordingDurationSeconds(metadata) - nextControls.timeWindowSeconds,
      );
      nextControls.startSeconds = Math.min(
        maxTimeStart,
        Math.max(0, midSeconds - nextControls.timeWindowSeconds / 2),
      );
    }
    if (event.channel) {
      const channels = activeWaveformChannels(metadata, nextControls);
      const channelIndex = channels.findIndex(
        (channel) => channel === event.channel,
      );
      if (channelIndex >= 0) {
        const maxChannelStart = Math.max(
          0,
          channels.length - nextControls.visibleChannels,
        );
        nextControls.channelStartIndex = Math.min(
          maxChannelStart,
          Math.max(
            0,
            channelIndex - Math.floor(nextControls.visibleChannels / 2),
          ),
        );
        nextControls.channelFocusMode = "events";
      }
    }
    onUpdatePlot(nextControls);
  }

  async function exportWaveformSnapshot() {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="pyqt-waveform_event_overlay_canvas"]',
    );
    if (!canvas) {
      onDeferredAction(
        "Waveform snapshot unavailable: no waveform canvas is rendered.",
      );
      return;
    }
    const stem =
      recordingFileName(recordingPath, metadata)
        .replace(/\.[^.]+$/, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-") || "pybrain";
    const result = (await onSavePngSnapshot({
      data_url: canvas.toDataURL("image/png"),
      default_name: `${stem}_waveform.png`,
      title: "Save Waveform Snapshot",
    })) as { canceled?: boolean; artifact_path?: string };
    if (result?.canceled) onDeferredAction("Waveform snapshot save cancelled.");
    else
      onDeferredAction(
        `Waveform snapshot saved${result?.artifact_path ? `: ${result.artifact_path}` : " as PNG"}.`,
      );
  }

  function resetWaveformView() {
    onUpdatePlot({
      ...waveformControls,
      channelStartIndex: 0,
      startSeconds: 0,
      normalizeVertically: false,
      showFiltered: false,
      filter60Hz: false,
      montageMode: "referential",
      channelFocusMode: "all",
      cursorEnabled: false,
      measureEnabled: false,
    });
  }

  function runWaveformShortcut(shortcutId: string) {
    const controls = { ...waveformControls };
    if (shortcutId === "window_2s")
      onUpdatePlot({ ...controls, timeWindowSeconds: 2 });
    else if (shortcutId === "window_5s")
      onUpdatePlot({ ...controls, timeWindowSeconds: 5 });
    else if (shortcutId === "window_10s")
      onUpdatePlot({ ...controls, timeWindowSeconds: 10 });
    else if (shortcutId === "window_20s")
      onUpdatePlot({ ...controls, timeWindowSeconds: 20 });
    else if (shortcutId === "visible_8")
      onUpdatePlot({ ...controls, visibleChannels: 8 });
    else if (shortcutId === "visible_16")
      onUpdatePlot({ ...controls, visibleChannels: 16 });
    else if (shortcutId === "visible_32")
      onUpdatePlot({ ...controls, visibleChannels: 32 });
    else if (shortcutId === "visible_all")
      onUpdatePlot({
        ...controls,
        visibleChannels: Math.max(
          1,
          activeWaveformChannels(metadata, controls).length ||
            controls.visibleChannels,
        ),
      });
    else if (shortcutId === "zoom_out")
      onUpdatePlot({
        ...controls,
        timeWindowSeconds: controls.timeWindowSeconds * 2,
      });
    else if (shortcutId === "zoom_in")
      onUpdatePlot({
        ...controls,
        timeWindowSeconds: controls.timeWindowSeconds * 0.5,
      });
    else if (shortcutId === "toggle_filtered")
      onUpdatePlot({ ...controls, showFiltered: !controls.showFiltered });
    else if (shortcutId === "toggle_event_scope")
      onUpdatePlot({
        ...controls,
        channelFocusMode:
          controls.channelFocusMode === "events" ? "all" : "events",
      });
    else if (shortcutId === "toggle_cursor")
      onUpdatePlot({ ...controls, cursorEnabled: !controls.cursorEnabled });
    else if (shortcutId === "toggle_measure")
      onUpdatePlot({ ...controls, measureEnabled: !controls.measureEnabled });
    else if (shortcutId === "toggle_auto_bipolar")
      onUpdatePlot({
        ...controls,
        montageMode: controls.montageMode === "auto" ? "referential" : "auto",
      });
    else if (shortcutId === "show_referential")
      onUpdatePlot({ ...controls, montageMode: "referential" });
    else if (shortcutId === "toggle_average_reference")
      onUpdatePlot({
        ...controls,
        montageMode:
          controls.montageMode === "averageReference"
            ? "referential"
            : "averageReference",
      });
    else if (shortcutId === "focus_highlighted_channel")
      onUpdatePlot({
        ...controls,
        channelFocusMode:
          controls.channelFocusMode === "highlight" ? "all" : "highlight",
      });
    else if (shortcutId === "focus_neighbors")
      onUpdatePlot({
        ...controls,
        channelFocusMode:
          controls.channelFocusMode === "neighbors" ? "all" : "neighbors",
      });
    else if (shortcutId === "toggle_clean_view")
      onUpdatePlot({
        ...controls,
        channelFocusMode:
          controls.channelFocusMode === "clean" ? "all" : "clean",
      });
    else if (shortcutId === "open_montage") setActiveDialog("bipolar");
    else if (shortcutId === "hotspot") focusHotspotChannels();
    else if (shortcutId === "center_event") navigateReviewEvent("current");
    else if (shortcutId === "next_pending") navigateReviewEvent("pending");
    else if (shortcutId === "clear_inspect")
      onUpdatePlot({
        ...controls,
        cursorEnabled: false,
        measureEnabled: false,
        channelFocusMode: "all",
      });
    else onDeferredAction(`Waveform shortcut: ${shortcutId}`);
  }

  return (
    <main
      className="pyqt-main-window"
      style={mainWindowStyle}
      data-testid="pyqt-main-window"
      data-agent-open={agentOpen ? "true" : "false"}
    >
      <section
        className="pyqt-workspace-shell"
        data-testid="pyqt-closed-agent-layout"
        data-loaded={hasRecording ? "true" : "false"}
        data-active-workflow-tab="waveform"
        data-workflow-panel={workflowPanelExpanded ? activeTab.toLowerCase() : "none"}
      >
        <TopToolbar
          projectLabel={projectLabel}
          projectDirty={projectDirty}
          onNewProject={onNewProject}
          onOpenProject={onOpenProject}
          onSaveProject={onSaveProject}
          onOpenRecording={onOpenRecording}
          onLoadDetection={openLoadDetectionDialog}
          onQuickDetection={openQuickDetectionDialog}
          onBatchProject={openBatchProjectDialog}
          onWaveformShortcuts={openWaveformShortcutsDialog}
          onStatusLog={openRuntimeLogDialog}
        />
        <BiomarkerBar
          biomarker={biomarker}
          onChange={setBiomarker}
          hasRecording={hasRecording}
          waveformControls={waveformControls}
        />
        <WorkflowProgressStrip
          statusMessage={statusMessage}
          hasRecording={hasRecording}
          metadata={metadata}
          waveformControls={waveformControls}
          runRecords={runRecords}
          activeRunId={activeRunId}
          reviewEvents={reviewEvents}
        />
        <section className="waveform-header" data-testid="pyqt-WaveformHeader">
          <div className="waveform-header-copy">
            <div className="waveform-header-title-row">
              <h1>{hasRecording ? "EEG/iEEG Review" : "EEG/iEEG"}</h1>
              {hasRecording && <BiomarkerHeaderSelect biomarker={biomarker} onChange={setBiomarker} />}
              {hasRecording && (
                <button
                  className="waveform-header-info-button"
                  data-testid="pyqt-recording_info_button"
                  aria-label="Recording info"
                  title="Recording info"
                  onClick={openRecordingInfoDialog}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
                    <path d="M14 2v5h5" />
                    <line x1="9" y1="13" x2="15" y2="13" />
                    <line x1="9" y1="17" x2="13" y2="17" />
                  </svg>
                </button>
              )}
            </div>
            <p>
              {hasRecording
                ? waveformHeaderRecordingLabel(recordingPath, metadata, waveform)
                : "Open a recording or load a saved session to start the workspace. Signal prep, detection, and classification tools appear once a recording is loaded."}
            </p>
            {hasRecording && (
              <WaveformHeaderModeBadges
                hasRecording={hasRecording}
                waveformControls={waveformControls}
                metadata={metadata}
              />
            )}
          </div>
          <div className="waveform-header-actions">
            <div className="waveform-workflow-actions" data-testid="pyqt-waveform_workflow_actions" ref={workflowAnchorRef}>
              <button
                data-testid="pyqt-header_prepare_button"
                disabled={!hasRecording}
                aria-label="Preprocess"
                title="Preprocess"
                onClick={() => openWorkflowTab("Prepare")}
              >
                Prep
              </button>
              <button
                data-testid="pyqt-header_detect_button"
                disabled={!hasRecording}
                onClick={() => openWorkflowTab("Detect")}
              >
                Detect
              </button>
              <button
                data-testid="pyqt-header_classify_button"
                disabled={!hasRecording}
                onClick={() => openWorkflowTab("Classify")}
              >
                Classify
              </button>
            </div>
            <button
              data-testid="pyqt-waveform_reset_view_button"
              aria-label="Reset View"
              title="Reset View"
              onClick={resetWaveformView}
            >
              Reset
            </button>
          </div>
        </section>
        <WaveformToolbar
          controls={waveformControls}
          metadata={metadata}
          measurementStatus={waveformMeasurementStatus}
          onControlsChange={onWaveformControlsChange}
          onUpdatePlot={onUpdatePlot}
          onOpenChannelSelection={openChannelsDialog}
          onOpenBipolarSelection={openBipolarDialog}
          onOpenReview={openEventReviewDialog}
          onOverlapReview={onOverlapReview}
          onExportSnapshot={exportWaveformSnapshot}
          onNavigateEvent={navigateReviewEvent}
          onHotspotChannels={focusHotspotChannels}
          eventPositionLabel={eventPositionLabel}
          hasEventNavigation={hasToolbarEventNavigation}
        />
        <section
          className="loaded-workspace"
          data-workflow-expanded={workflowPanelExpanded ? "true" : "false"}
          data-active-workflow-tab="waveform"
          data-workflow-panel={workflowPanelExpanded ? activeTab.toLowerCase() : "none"}
          data-testid="pyqt-loaded_workspace_splitter"
        >
          <WaveformStage
            severityScores={severityState.result?.scores}
            waveform={hasRecording ? waveform : null}
            error={error}
            metadata={metadata}
            controls={waveformControls}
            trackpadSensitivity={shortcutSettings.trackpadSensitivity}
            runRecords={runRecords}
            activeRunId={activeRunId}
            acceptedRunId={acceptedRunId}
            visibleRunIds={visibleRunIds}
            runEventsByRun={runEventsByRun}
            selectedEventId={selectedReviewEventId}
            emptyState={
              !hasRecording ? (
                <EmptyState
                  recentRecordings={recentRecordings}
                  onOpenRecording={onOpenRecording}
                  onOpenRecentRecording={onOpenRecentRecording}
                  onRemoveRecentRecording={onRemoveRecentRecording}
                  onClearRecentRecordings={onClearRecentRecordings}
                  onLoadDetection={openLoadDetectionDialog}
                  onQuickDetection={openQuickDetectionDialog}
                />
              ) : null
            }
            sidebar={
              <MainRightControlSidebar
                metadata={metadata}
                severityState={severityState}
                onRunSeverityScoring={onRunSeverityScoring}
                onCancelSeverityScoring={onCancelSeverityScoring}
                onSeekToSeconds={onSeekToSeconds}
                recordingPath={recordingPath}
                biomarker={biomarker}
                prepareControls={prepareControls}
                classifierControls={classifierControls}
                runRecords={runRecords}
                activeRunId={activeRunId}
                acceptedRunId={acceptedRunId}
                visibleRunIds={visibleRunIds}
                reviewEvents={reviewEvents}
                onOpenReview={openEventReviewDialog}
                onOpenRunStats={openRunStatsDialog}
                onOpenRecordingInfo={openRecordingInfoDialog}
                onBiomarkerChange={setBiomarker}
                onActivateRun={onActivateRun}
                onAcceptRun={onAcceptRun}
                onExportSession={onExportSession}
                onExportWorkbook={onExportWorkbook}
                onApplyFilters={onApplyFilters}
                onOpenPrepareTab={openPrepareWorkflowTab}
                onOpenDetectTab={() => openWorkflowTab("Detect")}
                onOpenClassifyTab={() => openWorkflowTab("Classify")}
                onPrepareControlsChange={onPrepareControlsChange}
                onSaveNJobs={onSaveNJobs}
                onRunDetection={onRunDetection}
                onRunClassifier={onRunClassifier}
                onClassifierControlsChange={onClassifierControlsChange}
              />
            }
            onOverlaySelect={selectWaveformOverlayEvent}
            onControlsChange={onWaveformControlsChange}
            onUpdatePlot={onUpdatePlot}
            onMeasurementStatusChange={updateWaveformMeasurementStatus}
          />
          <div
            className="loaded-workspace-splitter-handle"
            data-testid="pyqt-loaded_workspace_splitter_handle"
            hidden={!workflowPanelExpanded}
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={MIN_WORKSPACE_SPLIT_PERCENT}
            aria-valuemax={MAX_WORKSPACE_SPLIT_PERCENT}
            aria-valuenow={workspaceSplitPercent}
            aria-label="Resize waveform and workflow tabs"
            onPointerDown={beginWorkspaceSplitResize}
          />
          <WorkspaceTabs
            popoverStyle={workflowPopoverStyle}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            onCollapse={closeWorkflowPanel}
            collapsed={!workflowPanelExpanded}
            metadata={metadata}
            recordingPath={recordingPath}
            capabilityManifest={capabilityManifest}
            biomarker={biomarker}
            prepareControls={prepareControls}
            recordingAnalysis={recordingAnalysis}
            classifierControls={classifierControls}
            classifierFeedback={classifierFeedback}
            runRecords={runRecords}
            activeRunId={activeRunId}
            runtimeOperation={runtimeOperation}
            runtimeLog={runtimeLog}
            onPrepareControlsChange={onPrepareControlsChange}
            onRecordingAnalysisChange={onRecordingAnalysisChange}
            onClassifierControlsChange={onClassifierControlsChange}
            onClassifierFeedbackChange={onClassifierFeedbackChange}
            onBiomarkerChange={setBiomarker}
            onAnalyzeRecordingPlanning={onAnalyzeRecordingPlanning}
            onApplyFilters={onApplyFilters}
            onSaveNJobs={onSaveNJobs}
            onRunDetection={onRunDetection}
            onRunClassifier={onRunClassifier}
            onCancelRuntimeOperation={onCancelRuntimeOperation}
            onOpenModelFile={onOpenClassifierModel}
          />
        </section>
        <footer className="status-strip" data-testid="pyqt-STDTextEdit">
          <span
            className="activity-level-dot"
            data-testid="pyqt-activity_level_dot"
            data-activity-level={
              error
                ? "error"
                : runtimeOperation.status === "running"
                  ? "running"
                  : runtimeOperation.status === "failed"
                    ? "error"
                    : runtimeOperation.status === "complete"
                      ? "success"
                      : "info"
            }
          />
          <span data-testid="pyqt-activity_summary_label">
            {statusStripMessage}
          </span>
          <button
            data-testid="pyqt-status_log_open_button"
            onClick={openRuntimeLogDialog}
          >
            Status Log
          </button>
        </footer>
      </section>
      <AgentActivityBar
        activeTab={agentTab}
        isOpen={agentOpen}
        onOpenTab={openAgentTab}
      />
      {agentOpen && (
        <div
          className="agent-panel-resize-handle"
          data-testid="agent-panel-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Agent panel"
          aria-valuemin={MIN_AGENT_PANEL_WIDTH}
          aria-valuemax={MAX_AGENT_PANEL_WIDTH}
          aria-valuenow={agentPanelWidth}
          aria-valuetext={`${agentPanelWidth}px`}
          tabIndex={0}
          onKeyDown={resizeAgentPanelByKeyboard}
          onPointerDown={beginAgentPanelResize}
        />
      )}
      {agentOpen && (
        <AgentPanel
          activeTab={agentTab}
          message={message}
          agentChatLog={agentChatLog}
          conversations={agentConversations}
          activeConversationId={activeAgentConversationId}
          onSelectConversation={onSelectAgentConversation}
          onNewConversation={onNewAgentConversation}
          onCloseConversation={onCloseAgentConversation}
          agentResponding={agentResponding}
          agentStreamingText={agentStreamingText}
          agentAutonomy={agentAutonomy}
          onAgentAutonomyChange={onAgentAutonomyChange}
          onMessageChange={onMessageChange}
          onSend={onSendAgentMessage}
          onClose={closeAgentPanel}
          recordingPath={recordingPath}
          runtimeOperation={runtimeOperation}
          runtimeLog={runtimeLog}
          commandHistory={uiCommandHistory}
          artifacts={agentArtifacts}
          onOpenArtifact={onOpenAgentArtifact}
          onRevealArtifact={onRevealAgentArtifact}
          onRemoveArtifact={onRemoveAgentArtifact}
          onClearArtifacts={onClearAgentArtifacts}
          onApplyStagedCommand={onApplyStagedCommand}
          onDismissStagedCommand={onDismissStagedCommand}
        />
      )}
      {activeDialog === "channels" && (
        <ChannelSelectionDialog
          metadata={metadata}
          controls={waveformControls}
          channelAmplitudes={channelAmplitudes}
          onClose={closeActiveDialog}
          onApply={(controls) => {
            setActiveDialog(null);
            onUpdatePlot(controls);
          }}
        />
      )}
      {activeDialog === "bipolar" && (
        <BipolarChannelDialog
          metadata={metadata}
          controls={waveformControls}
          onClose={closeActiveDialog}
          onCreate={(controls) => {
            setActiveDialog(null);
            onUpdatePlot(controls);
          }}
          onUpdate={onUpdatePlot}
        />
      )}
      {activeDialog === "batchProject" && (
        <BatchProjectDialog
          biomarker={biomarker}
          prepareControls={prepareControls}
          onShowArtifacts={showAgentArtifacts}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "quickDetection" && (
        <QuickDetectionDialog
          biomarker={biomarker}
          metadata={quickDetectionMetadata || metadata}
          recordingPath={recordingPath}
          capabilityManifest={capabilityManifest}
          onLoadFile={onOpenRecording}
          onRunDetection={onRunDetection}
          onOpenModelFile={onOpenClassifierModel}
          runtimeOperation={runtimeOperation}
          runtimeLog={runtimeLog}
          onCancelRuntimeOperation={onCancelRuntimeOperation}
          onOpenReview={openEventReviewDialog}
          onShowArtifacts={showAgentArtifacts}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "loadDetection" && (
        <LoadDetectionDialog
          onBrowse={onOpenSavedSession}
          onLoad={onLoadSavedSession}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "waveformShortcuts" && (
        <WaveformShortcutSettingsDialog
          settings={shortcutSettings}
          onSave={saveWaveformShortcutSettings}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "runtimeLog" && (
        <RuntimeLogDialog
          operation={runtimeOperation}
          log={runtimeLog}
          error={error}
          statusMessage={statusMessage}
          onCancel={onCancelRuntimeOperation}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "recordingInfo" && (
        <RecordingInfoDialog
          metadata={metadata}
          recordingPath={recordingPath}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "eventReview" && (
        <EventReviewDialog
          events={reviewEvents}
          selectedEventId={selectedReviewEventId}
          activeRun={
            runRecords.find((run) => run.runId === activeRunId) || null
          }
          onSelectEvent={selectReviewEvent}
          onAnnotate={onAnnotateEvent}
          onLoadSnippet={onLoadEventSnippet}
          onLoadFeatureSummary={onLoadEventFeatureSummary}
          onSavePngSnapshot={onSavePngSnapshot}
          onClose={closeActiveDialog}
        />
      )}
      {activeDialog === "runStats" && (
        <RunStatisticsDialog
          runRecords={runRecords}
          activeRunId={activeRunId}
          acceptedRunId={acceptedRunId}
          visibleRunIds={visibleRunIds}
          reviewEvents={reviewEvents}
          runEventsByRun={runEventsByRun}
          candidateRanking={recordingAnalysis.candidate_ranking}
          runtimeLog={runtimeLog}
          onActivateRun={onActivateRun}
          onToggleRunVisible={onToggleRunVisible}
          onAcceptRun={onAcceptRun}
          onCreateConsensusRun={onCreateConsensusRun}
          onExportWorkbook={onExportWorkbook}
          onExportReport={onExportReport}
          onDeferredAction={onDeferredAction}
          onClose={closeActiveDialog}
        />
      )}
    </main>
  );
}

const WorkflowProgressStrip = memo(function WorkflowProgressStrip({
  statusMessage,
  hasRecording,
  metadata,
  waveformControls,
  runRecords,
  activeRunId,
  reviewEvents,
}: {
  statusMessage: string;
  hasRecording: boolean;
  metadata: RecordingMetadata | null;
  waveformControls: WaveformControlsState;
  runRecords: RunRecord[];
  activeRunId: string | null;
  reviewEvents: ReviewEvent[];
}) {
  const hasChannels =
    activeWaveformChannels(metadata, waveformControls).length > 0;
  const hasFilteredSource =
    waveformControls.showFiltered ||
    waveformControls.filter60Hz ||
    waveformControls.normalizeVertically;
  const hasDetection = runRecords.length > 0 || Boolean(activeRunId);
  const hasClassification = runRecords.some((run) => Boolean(run.classifier));
  const reviewedCount = reviewEvents.filter((event) => event.annotation).length;
  const workflowChips = [
    {
      testId: "pyqt-status_loaded_chip",
      label: "Load data",
      active: hasRecording,
    },
    {
      testId: "pyqt-status_channels_chip",
      label: "Choose channels",
      active: hasChannels,
    },
    {
      testId: "pyqt-status_filter_chip",
      label: hasFilteredSource ? "Prepared signal" : "Raw signal",
      active: hasFilteredSource,
    },
    {
      testId: "pyqt-status_detect_chip",
      label: "Detect events",
      active: hasDetection,
    },
    {
      testId: "pyqt-status_classify_chip",
      label: "Classification optional",
      active: hasClassification,
    },
    {
      testId: "pyqt-status_annotate_chip",
      label: "Review & annotate",
      active: reviewedCount > 0,
    },
  ];
  const workflowSteps = [
    ["1", "Load Data", "Open EDF, BrainVision, or FIF recordings"],
    ["2", "Choose Channels", "Focus on review targets"],
    ["3", "Configure Analysis", "Tune detector and review settings"],
    ["4", "Review Results", "Inspect signals and event overlays"],
    ["5", "Annotate / Export", "Finalize labels and outputs"],
  ];
  return (
    <section
      className="workflow-progress-strip"
      data-testid="pyqt-workflowHeader"
      data-loaded={hasRecording ? "true" : "false"}
    >
      <div className="workflow-status-row">
        <strong>PyBrain</strong>
        <span data-testid="pyqt-workflow_subtitle_label">
          EEG review workspace for HFO, spindle, and spike analysis.
        </span>
        <em data-testid="pyqt-workflow_status_label">{statusMessage}</em>
      </div>
      <div
        className="workflow-chip-row"
        data-testid="pyqt-workflow_status_chips"
      >
        {workflowChips.map((chip) => (
          <span
            key={chip.testId}
            data-testid={chip.testId}
            data-active={chip.active ? "true" : "false"}
          >
            {chip.label}
          </span>
        ))}
      </div>
      <div className="workflow-step-row" data-testid="pyqt-workflowSteps">
        {workflowSteps.map(([number, title, description]) => (
          <article
            key={number}
            className="workflow-step-card"
            data-testid="pyqt-workflow_step_card"
          >
            <b>{number}</b>
            <strong>{title}</strong>
            <span>{description}</span>
          </article>
        ))}
      </div>
    </section>
  );
});

const EmptyState = memo(function EmptyState({
  recentRecordings,
  onOpenRecording,
  onOpenRecentRecording,
  onRemoveRecentRecording,
  onClearRecentRecordings,
  onLoadDetection,
  onQuickDetection,
}: {
  recentRecordings: RecentRecording[];
  onOpenRecording: () => void;
  onOpenRecentRecording: (path: string) => void;
  onRemoveRecentRecording: (path: string) => void;
  onClearRecentRecordings: () => void;
  onLoadDetection: () => void;
  onQuickDetection: () => void;
}) {
  return (
    <section className="empty-state-card" data-testid="pyqt-empty_state_card">
      <h2>Open a recording to begin</h2>
      <p>
        Open EDF, BrainVision, or FIF data, or restore a saved session to load
        the waveform. The full workspace -- signal prep, detection,
        classification, and results -- appears once a recording is loaded.
      </p>
      <div className="button-row">
        <button data-testid="pyqt-empty_open_button" onClick={onOpenRecording}>
          Open Recording
        </button>
        <button
          data-testid="pyqt-empty_load_session_button"
          onClick={onLoadDetection}
        >
          Load Session
        </button>
        <button
          data-testid="pyqt-empty_quick_button"
          onClick={onQuickDetection}
        >
          Quick Detection
        </button>
      </div>
      <section
        className="recent-recordings-card"
        data-testid="pyqt-recent_recordings_panel"
        aria-label="Recent recordings"
      >
        <header>
          <h3>Recent recordings</h3>
          <button
            data-testid="pyqt-recent_recordings_clear_button"
            disabled={!recentRecordings.length}
            onClick={onClearRecentRecordings}
          >
            Clear
          </button>
        </header>
        <ul className="recent-recordings-list">
          {recentRecordings.map((item) => (
            <li key={item.path} data-testid="pyqt-recent_recording_row">
              <button
                className="recent-recording-open"
                data-testid="pyqt-recent_recording_open_button"
                title={item.path}
                onClick={() => onOpenRecentRecording(item.path)}
              >
                <strong>{item.label}</strong>
                <span>{recentRecordingMeta(item)}</span>
              </button>
              <button
                data-testid="pyqt-recent_recording_remove_button"
                aria-label={`Remove ${item.label}`}
                onClick={() => onRemoveRecentRecording(item.path)}
              >
                Remove
              </button>
            </li>
          ))}
          {!recentRecordings.length && (
            <li
              className="recent-recordings-empty"
              data-testid="pyqt-recent_recordings_empty"
            >
              No recent recordings yet.
            </li>
          )}
        </ul>
      </section>
    </section>
  );
});

function recentRecordingMeta(item: RecentRecording): string {
  const bits = [
    item.channels ? `${item.channels} ch` : "",
    item.sampleFrequencyHz ? `${item.sampleFrequencyHz} Hz` : "",
    item.durationSeconds ? `${formatDuration(item.durationSeconds)}` : "",
    item.openedAt ? `opened ${new Date(item.openedAt).toLocaleString()}` : "",
  ].filter(Boolean);
  return bits.join(" · ") || item.path;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return minutes ? `${minutes}m ${rem}s` : `${rem}s`;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
    target.isContentEditable
  );
}

function isTargetInsideAgentPanel(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement && Boolean(target.closest(".agent-panel"))
  );
}

function waveformChannelAmplitudes(
  waveform: WaveformWindow | null,
): Record<string, number> {
  const amplitudes: Record<string, number> = {};
  if (!waveform?.channels?.length || !waveform.data?.length) return amplitudes;
  waveform.channels.forEach((channel, index) => {
    const row = waveform.data[index] || [];
    const finiteValues = row.map(Number).filter(Number.isFinite);
    if (!finiteValues.length) return;
    amplitudes[channel] = Math.max(...finiteValues) - Math.min(...finiteValues);
  });
  return amplitudes;
}


function seedDetectionParams(fields: { key: string; defaultValue?: string }[]): Record<string, string> {
  const seeded: Record<string, string> = {};
  for (const field of fields) seeded[field.key] = field.defaultValue ?? "";
  return seeded;
}

function railDetectionParamTestId(detector: string, key: string): string {
  return `pyqt-sidebar_${detector.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_${key}_input`;
}

const MainRightControlSidebar = memo(function MainRightControlSidebar({
  metadata,
  severityState,
  onRunSeverityScoring,
  onCancelSeverityScoring,
  onSeekToSeconds,
  recordingPath,
  biomarker,
  prepareControls,
  classifierControls,
  runRecords,
  activeRunId,
  acceptedRunId,
  visibleRunIds,
  reviewEvents,
  onOpenReview,
  onOpenRunStats,
  onOpenRecordingInfo,
  onBiomarkerChange,
  onActivateRun,
  onAcceptRun,
  onExportSession,
  onExportWorkbook,
  onApplyFilters,
  onOpenPrepareTab,
  onOpenDetectTab,
  onOpenClassifyTab,
  onPrepareControlsChange,
  onSaveNJobs,
  onRunDetection,
  onRunClassifier,
  onClassifierControlsChange,
}: {
  metadata: RecordingMetadata | null;
  severityState: SeverityRunState;
  onRunSeverityScoring: () => Promise<unknown> | void;
  onCancelSeverityScoring: () => Promise<unknown> | void;
  onSeekToSeconds: (startSeconds: number) => void;
  recordingPath: string | null;
  biomarker: BiomarkerType;
  prepareControls: PrepareControlsState;
  classifierControls: ClassifierControlsState;
  runRecords: RunRecord[];
  activeRunId: string | null;
  acceptedRunId: string | null;
  visibleRunIds: string[];
  reviewEvents: ReviewEvent[];
  onOpenReview: () => void;
  onOpenRunStats: () => void;
  onOpenRecordingInfo: () => void;
  onBiomarkerChange: (biomarker: BiomarkerType) => void;
  onActivateRun: (runId: string) => void;
  onAcceptRun: (runId?: string) => void;
  onExportSession: (runId?: string) => Promise<void> | void;
  onExportWorkbook: (runId?: string) => Promise<void> | void;
  onApplyFilters: () => void;
  onOpenPrepareTab: () => void;
  onOpenDetectTab: () => void;
  onOpenClassifyTab: () => void;
  onPrepareControlsChange: (controls: PrepareControlsState) => void;
  onSaveNJobs: () => void;
  onRunDetection: (request: DetectorRunRequest) => Promise<void> | void;
  onRunClassifier: (request: ClassifierRunRequest) => Promise<void> | void;
  onClassifierControlsChange: (controls: ClassifierControlsState) => void;
}) {
  const activeRun = runRecords.find((run) => run.runId === activeRunId) || null;
  const acceptedRun = runRecords.find((run) => run.runId === acceptedRunId) || null;
  const reviewed = reviewEvents.filter((event) => event.annotation).length;
  const activeRunLabel = activeRun
    ? `${activeRun.biomarker} • ${activeRun.detector} • ${activeRun.events} ev${
        activeRun.accepted || activeRun.runId === acceptedRunId ? " • accepted" : ""
      }`
    : "No runs yet";
  const detectorOptions = detectorTabsByBiomarker[biomarker] || ["STE"];
  const [detector, setDetector] = useState<string>(() => detectorOptions[0] || "STE");
  const [detectionParams, setDetectionParams] = useState<Record<string, string>>(
    () => seedDetectionParams(DETECTOR_FIELDS[detectorOptions[0] || "STE"] || []),
  );
  useEffect(() => {
    if (!detectorOptions.includes(detector)) setDetector(detectorOptions[0] || "STE");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biomarker]);
  useEffect(() => {
    setDetectionParams(seedDetectionParams(DETECTOR_FIELDS[detector] || []));
  }, [detector]);
  // Show the common params inline (two compact rows); advanced params keep their
  // seeded defaults and stay editable in the full Detect "Setup" tab.
  const detectorFields = (DETECTOR_FIELDS[detector] || []).slice(0, 6);
  const classifierModes = classifierModesForBiomarker(biomarker);
  const hasRecording = Boolean(recordingPath);
  const runDetectionFromRail = () => {
    void onRunDetection({
      biomarker,
      detector,
      detectorParams: detectorParamsForRun(detector, detectionParams),
      uiValues: detectionParams,
    });
  };
  const classifyFromRail = () => {
    void onRunClassifier({
      biomarker,
      mode: classifierControls.mode,
      classifier: classifierPayloadFromState(classifierControls, biomarker),
      classifierLabel: `${classifierControls.mode} classifier`,
    });
  };
  const changeClassifierMode = (mode: ClassifierMode) => {
    onClassifierControlsChange({ ...classifierControls, ...defaultClassifierPatch(biomarker, mode) });
  };
  // A hovered <select> or number <input> swallows the wheel gesture: the surface under it does not
  // scroll and -- worse for a select -- its value can change under the pointer. This is document-
  // wide on purpose: the same controls sit in the pipeline rail, the workflow popover and the
  // dialogs, and fixing one surface at a time left the others broken.
  //
  // Only a control the user has actually focused keeps the wheel; otherwise the gesture is handed
  // to the nearest scrollable ancestor that still has room to move in that direction. Registered
  // natively with passive:false because React onWheel is passive, where preventDefault() is a no-op.
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      const control = target?.closest?.("input, select, textarea") as HTMLElement | null;
      // A focused control keeps the wheel (that is how you change its value on purpose).
      if (control && control === document.activeElement) return;
      let node: HTMLElement | null = control ? control.parentElement : target;
      // Set once we pass a scroll container that has no room AND declines to chain
      // (overscroll-behavior: contain). Chromium stops there, so the gesture is simply lost -- the
      // severity card in the rail was exactly this: overflow:auto, nothing to scroll, contain.
      let chainBlocked = false;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY)) {
          const room = event.deltaY > 0
            ? node.scrollTop < node.scrollHeight - node.clientHeight - 1
            : node.scrollTop > 1;
          if (room) {
            if (control || chainBlocked) {
              event.preventDefault();
              node.scrollTop += event.deltaY;
            }
            return;
          }
          const behaviour = style.overscrollBehaviorY || style.overscrollBehavior || "";
          if (/contain|none/.test(behaviour)) chainBlocked = true;
        }
        node = node.parentElement;
      }
    };
    document.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => document.removeEventListener("wheel", onWheel, { capture: true } as EventListenerOptions);
  }, []);
  // The rail is segmented the way the PyQt inspector is: Pipeline holds the linear
  // prep -> detect -> classify -> runs pass, Severity is a separate whole-recording workflow that
  // only exists for scalp EEG. Falling back when severity is unavailable keeps a stale selection
  // from leaving the rail blank after loading an iEEG recording.
  const severityAvailable = supportsSeverityScoring(metadata);
  const [railTab, setRailTab] = useState<'pipeline' | 'severity'>('pipeline');
  const activeRailTab = severityAvailable ? railTab : 'pipeline';
  return (
    <aside
      className="waveform-right-sidebar"
      data-rail-tab={activeRailTab}
      data-testid="pyqt-waveform_right_sidebar"
      aria-label="PyQt waveform right control sidebar"
    >
      {severityAvailable ? (
        <div className="sidebar-segmented" role="tablist" aria-label="Right panel sections" data-testid="pyqt-sidebar_segmented">
          <button role="tab" aria-selected={activeRailTab === 'pipeline'} className={activeRailTab === 'pipeline' ? 'active' : ''} data-testid="pyqt-sidebar_tab_pipeline" onClick={() => setRailTab('pipeline')}>Pipeline</button>
          <button role="tab" aria-selected={activeRailTab === 'severity'} className={activeRailTab === 'severity' ? 'active' : ''} data-testid="pyqt-sidebar_tab_severity" onClick={() => setRailTab('severity')}>Severity</button>
        </div>
      ) : (
        <p className="sidebar-zone-label" data-testid="pyqt-sidebar_zone_pipeline">Pipeline</p>
      )}
      {activeRailTab === 'pipeline' && (<>
      <section className="pyqt-sidebar-card" data-testid="pyqt-sidebar_signal_card">
        <header><h3>Signal</h3><div className="sidebar-header-actions"><button data-testid="pyqt-sidebar_prepare_button" onClick={onOpenPrepareTab}>Prep</button><button data-testid="pyqt-sidebar_recording_info_button" onClick={onOpenRecordingInfo}>Info</button></div></header>
        <dl className="sidebar-metadata-grid" data-testid="pyqt-main_edf_info"><dt>File</dt><dd>{recordingFileName(recordingPath, metadata)}</dd><dt>Hz</dt><dd>{sampleFrequency(metadata)}</dd><dt>Channels</dt><dd>{channelCount(metadata)}</dd><dt>Length</dt><dd>{recordingLengthLabel(metadata)}</dd></dl>
        <div className="sidebar-filter-row"><label>Low cut.<input data-testid="pyqt-sidebar_low_cut_input" inputMode="decimal" value={prepareControls.fp} onChange={(event) => onPrepareControlsChange({ ...prepareControls, fp: event.target.value })} /></label><label>High cut.<input data-testid="pyqt-sidebar_high_cut_input" inputMode="decimal" value={prepareControls.fs} onChange={(event) => onPrepareControlsChange({ ...prepareControls, fs: event.target.value })} /></label><button data-testid="pyqt-sidebar_filter_button" disabled={!hasRecording} onClick={onApplyFilters}>Filter</button></div>
      </section>
      <section className="pyqt-sidebar-card" data-testid="pyqt-sidebar_detection_card">
        <header><h3>Detection</h3><button data-testid="pyqt-sidebar_more_detection_button" onClick={onOpenDetectTab}>Setup</button></header>
        <div className="sidebar-detector-run-row"><label>Detector<select data-testid="pyqt-sidebar_detector_selector" value={detector} onChange={(event) => setDetector(event.target.value)}>{detectorOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select></label><button data-testid="pyqt-detect_all_button" disabled={!hasRecording} onClick={runDetectionFromRail}>Run {detector}</button></div>
        <div className="sidebar-detection-params" data-testid="pyqt-sidebar_detection_parameter_grid">
          {detectorFields.map((field) => <label key={field.key}>{field.label}<input data-testid={railDetectionParamTestId(detector, field.key)} inputMode="decimal" value={detectionParams[field.key] ?? ""} onChange={(event) => setDetectionParams((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}
        </div>
      </section>
      <section className="pyqt-sidebar-card" data-testid="pyqt-sidebar_classification_card">
        <header><h3>Classification</h3><button data-testid="pyqt-sidebar_more_classification_button" onClick={onOpenClassifyTab}>Setup</button></header>
        <label>Preset<select data-testid="pyqt-sidebar_classifier_preset" value={classifierControls.mode} onChange={(event) => changeClassifierMode(event.target.value as ClassifierMode)}>{classifierModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label><button data-testid="pyqt-sidebar_classify_button" disabled={!activeRun} onClick={classifyFromRail}>Classify</button>
        <div className="sidebar-classifier-toggles" data-testid="pyqt-sidebar_classifier_toggle_row"><label><input data-testid="pyqt-sidebar_use_spkhfo_checkbox" type="checkbox" checked={classifierControls.useSpike} onChange={(event) => onClassifierControlsChange({ ...classifierControls, useSpike: event.target.checked })} />Use spk-HFO</label><label><input data-testid="pyqt-sidebar_use_ehfo_checkbox" type="checkbox" checked={classifierControls.useEhfo} onChange={(event) => onClassifierControlsChange({ ...classifierControls, useEhfo: event.target.checked })} />Use eHFO</label></div>
      </section>
      <p className="sidebar-zone-label" data-testid="pyqt-sidebar_zone_output">Runs &amp; output</p>
      <section className="pyqt-sidebar-card" data-testid="pyqt-sidebar_run_actions_card">
        <header><h3>Run Actions</h3><button data-testid="pyqt-sidebar_run_button" onClick={onOpenDetectTab}>Detect</button></header>
        <label>Active<select data-testid="pyqt-sidebar_active_run_selector" value={activeRunId || ""} onChange={(event) => { if (event.target.value) onActivateRun(event.target.value); }}>
          {!runRecords.length && <option value="">No active run</option>}
          {runRecords.map((run) => <option key={run.runId} value={run.runId}>{run.biomarker} • {run.detector} • {run.events} ev{run.runId === acceptedRunId ? " • accepted" : ""}</option>)}
        </select></label>
        <div className="sidebar-button-row"><button data-testid="pyqt-sidebar_accept_run_button" disabled={!activeRun} onClick={() => onAcceptRun(activeRun?.runId)}>Accept</button><button data-testid="pyqt-sidebar_run_stats_button" disabled={!runRecords.length} onClick={onOpenRunStats}>Run Stats</button></div>
        <div className="sidebar-runs-inline-pair" data-testid="pyqt-sidebar_runs_inline_pair">
          <div className="sidebar-workers-row" data-testid="pyqt-sidebar_workers_row"><label>Workers<input data-testid="pyqt-sidebar_n_jobs_spinbox" type="number" min={1} max={256} value={prepareControls.nJobs} onChange={(event) => onPrepareControlsChange({ ...prepareControls, nJobs: Number(event.target.value) })} /></label><button data-testid="pyqt-sidebar_n_jobs_ok_button" onClick={onSaveNJobs}>Set</button></div>
          <div className="sidebar-next-run-row" data-testid="pyqt-sidebar_next_run_row"><label>Next<select data-testid="pyqt-sidebar_next_biomarker_combo" value={biomarker} onChange={(event) => onBiomarkerChange(event.target.value as BiomarkerType)}><option>HFO</option><option>Spindle</option><option>Spike</option></select></label><button data-testid="pyqt-sidebar_new_run_button" onClick={onOpenDetectTab}>New</button></div>
        </div>
        <p className="sidebar-copy" data-testid="pyqt-sidebar_active_run_summary">{activeRunLabel}</p>
      </section>
      <section className="pyqt-sidebar-card" data-testid="pyqt-sidebar_results_card">
        <header><h3>Results</h3><button data-testid="pyqt-sidebar_more_results_button" onClick={onOpenRunStats}>Stats</button></header>
        <div className="sidebar-button-row"><button data-testid="pyqt-sidebar_open_review_button" disabled={!reviewEvents.length} title="Open Review" onClick={onOpenReview}>Review</button><button data-testid="pyqt-sidebar_save_session_button" disabled={!activeRun} title="Save Session" onClick={() => onExportSession(activeRun?.runId)}>Session</button><button data-testid="pyqt-sidebar_export_workbook_button" disabled={!activeRun} title="Export Workbook" onClick={() => onExportWorkbook(activeRun?.runId)}>Workbook</button></div>
        <p className="sidebar-copy">{reviewEvents.length} event(s), {reviewed}/{reviewEvents.length || 0} reviewed · accepted {acceptedRun?.detector || "--"} · {visibleRunIds.length} visible run(s)</p>
      </section>
      </>)}
      {activeRailTab === 'severity' && severityAvailable && (
        <section className="pyqt-sidebar-card sidebar-severity-card" data-testid="pyqt-sidebar_severity_card">
          <SeverityTab metadata={metadata} hasRecording={hasRecording} state={severityState} onRunSeverityScoring={onRunSeverityScoring} onCancelSeverityScoring={onCancelSeverityScoring} onSeekToSeconds={onSeekToSeconds} />
        </section>
      )}
    </aside>
  );
});

const WaveformStage = memo(function WaveformStage({
  waveform,
  error,
  metadata,
  controls,
  trackpadSensitivity,
  runRecords,
  activeRunId,
  acceptedRunId,
  visibleRunIds,
  runEventsByRun,
  selectedEventId,
  severityScores,
  emptyState,
  sidebar,
  onOverlaySelect,
  onControlsChange,
  onUpdatePlot,
  onMeasurementStatusChange,
}: {
  waveform: WaveformWindow | null;
  error: string | null;
  metadata: RecordingMetadata | null;
  controls: WaveformControlsState;
  trackpadSensitivity: WaveformTrackpadSensitivity;
  runRecords: RunRecord[];
  activeRunId: string | null;
  acceptedRunId: string | null;
  visibleRunIds: string[];
  runEventsByRun: Record<string, ReviewEvent[]>;
  selectedEventId: string;
  severityScores?: SeveritySegmentScore[];
  emptyState?: ReactNode;
  sidebar?: ReactNode;
  onOverlaySelect: (overlay: WaveformEventOverlay) => void;
  onControlsChange: (controls: WaveformControlsState) => void;
  onUpdatePlot: (controls: WaveformControlsState) => void;
  onMeasurementStatusChange: (status: WaveformMeasurementStatus) => void;
}) {
  return (
    <section className="waveform-stage" data-testid="pyqt-waveform_stage">
      <WaveformPane
        waveform={waveform}
        error={error}
        metadata={metadata}
        controls={controls}
        trackpadSensitivity={trackpadSensitivity}
        runRecords={runRecords}
        activeRunId={activeRunId}
        acceptedRunId={acceptedRunId}
        visibleRunIds={visibleRunIds}
        runEventsByRun={runEventsByRun}
        selectedEventId={selectedEventId}
        severityScores={severityScores}
        onOverlaySelect={onOverlaySelect}
        onControlsChange={onControlsChange}
        onUpdatePlot={onUpdatePlot}
        onMeasurementStatusChange={onMeasurementStatusChange}
        emptyState={emptyState}
      />
      {sidebar}
    </section>
  );
});

const WaveformPane = memo(function WaveformPane({
  waveform,
  error,
  metadata,
  controls,
  trackpadSensitivity,
  runRecords,
  activeRunId,
  acceptedRunId,
  visibleRunIds,
  runEventsByRun,
  selectedEventId,
  severityScores,
  emptyState,
  onOverlaySelect,
  onControlsChange,
  onUpdatePlot,
  onMeasurementStatusChange,
}: {
  waveform: WaveformWindow | null;
  error: string | null;
  metadata: RecordingMetadata | null;
  controls: WaveformControlsState;
  trackpadSensitivity: WaveformTrackpadSensitivity;
  runRecords: RunRecord[];
  activeRunId: string | null;
  acceptedRunId: string | null;
  visibleRunIds: string[];
  runEventsByRun: Record<string, ReviewEvent[]>;
  selectedEventId: string;
  severityScores?: SeveritySegmentScore[];
  emptyState?: ReactNode;
  onOverlaySelect: (overlay: WaveformEventOverlay) => void;
  onControlsChange: (controls: WaveformControlsState) => void;
  onUpdatePlot: (controls: WaveformControlsState) => void;
  onMeasurementStatusChange: (status: WaveformMeasurementStatus) => void;
}) {
  // Viewport coordinates, not a percentage inside the label: the plot shell around this slider is
  // overflow:hidden, so an absolutely-positioned readout above the track gets clipped away.
  const [scrub, setScrub] = useState<{ clientX: number; top: number } | null>(null);
  const timeScrollRef = useRef<HTMLInputElement>(null);
  const timeScrollWheelRef = useRef<HTMLLabelElement>(null);
  const activeChannels = activeWaveformChannels(metadata, controls);
  const maxChannelStart = Math.max(
    0,
    activeChannels.length - controls.visibleChannels,
  );
  // Wheel over the time bar scrolls time, not the page behind it: a range input ignores the wheel,
  // so the gesture used to do nothing over the one control whose whole job is moving through time.
  useEffect(() => {
    const host = timeScrollWheelRef.current;
    if (!host) return;
    function onWheel(event: WheelEvent) {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const duration = recordingDurationSeconds(metadata);
      const limit = Math.max(0, duration - controls.timeWindowSeconds);
      if (limit <= 0) return;
      const step = Math.max(0.1, controls.timeWindowSeconds * (controls.timeIncrementPercent || 100) / 100);
      const next = Math.min(limit, Math.max(0, controls.startSeconds + (delta > 0 ? step : -step)));
      if (Math.abs(next - controls.startSeconds) < 1e-6) return;
      event.preventDefault();
      updateWaveformViewport({ startSeconds: next });
    }
    host.addEventListener('wheel', onWheel, { passive: false });
    return () => host.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls.startSeconds, controls.timeWindowSeconds, controls.timeIncrementPercent, metadata]);

  const maxTimeStart = Math.max(
    0,
    recordingDurationSeconds(metadata) - controls.timeWindowSeconds,
  );
  const timeStep = Math.max(
    0.1,
    (controls.timeWindowSeconds * controls.timeIncrementPercent) / 100,
  );

  // Anchor the readout to the pointer while dragging; with the keyboard there is no pointer, so
  // fall back to where the thumb sits along the track.
  function scrubAnchor(input: HTMLInputElement, clientX: number | null) {
    const rect = input.getBoundingClientRect();
    const fraction = maxTimeStart > 0 ? Math.min(1, Math.max(0, controls.startSeconds / maxTimeStart)) : 0;
    return { clientX: clientX ?? rect.left + rect.width * fraction, top: rect.top };
  }
  const eventOverlays = buildWaveformEventOverlays(
    runRecords,
    runEventsByRun,
    visibleRunIds,
    activeRunId,
    acceptedRunId,
  );

  function updateControls(patch: Partial<WaveformControlsState>) {
    onControlsChange({ ...controls, ...patch });
  }

  function updateWaveformViewport(patch: Partial<WaveformControlsState>) {
    onUpdatePlot({ ...controls, ...patch });
  }

  function handleWaveformWheelNavigation(request: WaveformWheelNavigation) {
    const zoomedControls = request.zoomSteps
      ? zoomWaveformTimeWindow(
          controls,
          metadata,
          request.zoomSteps,
          request.anchorRatio,
        )
      : controls;
    const zoomedMaxTimeStart = Math.max(
      0,
      recordingDurationSeconds(metadata) - zoomedControls.timeWindowSeconds,
    );
    const zoomedTimeStep = Math.max(
      0.1,
      (zoomedControls.timeWindowSeconds * zoomedControls.timeIncrementPercent) /
        100,
    );
    const nextChannelStart = Math.min(
      maxChannelStart,
      Math.max(0, zoomedControls.channelStartIndex + request.channelSteps),
    );
    const nextTimeStart = Math.min(
      zoomedMaxTimeStart,
      Math.max(
        0,
        zoomedControls.startSeconds + request.timeSteps * zoomedTimeStep,
      ),
    );
    if (
      nextChannelStart === controls.channelStartIndex &&
      nextTimeStart === controls.startSeconds &&
      zoomedControls.timeWindowSeconds === controls.timeWindowSeconds
    )
      return;
    onUpdatePlot({
      ...zoomedControls,
      channelStartIndex: nextChannelStart,
      startSeconds: nextTimeStart,
    });
  }

  function selectChannelFromGutter(channel: string) {
    const compareToChannels = (controls.compareToChannels || []).filter(
      (candidate) => candidate !== channel,
    );
    const channelsToPlot = uniqueWaveformChannels([
      channel,
      ...compareToChannels,
      ...activeChannels,
    ]);
    onControlsChange({
      ...controls,
      annotationChannel: channel,
      compareToChannels,
      channelsToPlot,
      channelFocusMode: "highlight",
      channelStartIndex: 0,
      visibleChannels: Math.max(
        1,
        Math.min(
          Math.max(controls.visibleChannels, 1),
          channelsToPlot.length || 1,
        ),
      ),
    });
  }

  return (
    <section
      className="waveform-pane waveform-left-scroll-pane"
      data-testid="pyqt-waveformWiget"
      data-pyqt-scroll-pane="pyqt-waveform_left_scroll_pane"
      data-empty={waveform ? "false" : "true"}
      aria-label="Fixed left waveform scroll pane"
    >
      {error && <div className="error-panel">{error}</div>}
      {!waveform && emptyState ? (
        <div className="empty-waveform-placeholder">{emptyState}</div>
      ) : (
        <>
          <div className="waveform-meta" data-testid="workflow-waveform-metadata">
            Channels: {channelCount(metadata)} · Selected:{" "}
            {channelSelectionSummary(metadata, controls)} · Annotate:{" "}
            {controls.annotationChannel || "--"} · Compare:{" "}
            {(controls.compareToChannels || []).length} · Visible:{" "}
            {controls.visibleChannels} · Run overlays: {eventOverlays.length}{" "}
            event(s) from {visibleRunIds.length} visible run(s) · Channel offset:{" "}
            {controls.channelStartIndex} · Window: {controls.timeWindowSeconds}s @{" "}
            {controls.startSeconds}s · ROI badges · Exclusions
          </div>
      <div className="waveform-plot-shell">
        <label className="channel-scrollbar" aria-label="Channel scroll offset">
          <input
            data-testid="pyqt-channel_scroll_bar"
            type="range"
            min={0}
            max={maxChannelStart}
            value={controls.channelStartIndex}
            onChange={(event) =>
              updateWaveformViewport({ channelStartIndex: Number(event.target.value) })
            }
          />
        </label>
        <WaveformCanvas
          windowData={waveform}
          eventOverlays={eventOverlays}
          selectedEventId={selectedEventId}
          selectedChannel={controls.annotationChannel}
          cursorEnabled={controls.cursorEnabled}
          measureEnabled={controls.measureEnabled}
          amplitudeScale={controls.amplitudeScale}
          normalizeVertically={controls.normalizeVertically}
          showFiltered={controls.showFiltered}
          trackpadSensitivity={trackpadSensitivity}
          onOverlaySelect={onOverlaySelect}
          onChannelSelect={selectChannelFromGutter}
          onWheelNavigation={handleWaveformWheelNavigation}
          onMeasurementStatusChange={onMeasurementStatusChange}
        />
        <WaveformOverviewAxis
          waveform={waveform}
          controls={controls}
          metadata={metadata}
        />
        <label className="time-scrollbar" aria-label="Time scroll offset" ref={timeScrollWheelRef}>
          <input
            data-testid="pyqt-waveform_time_scroll_bar"
            type="range"
            min={0}
            max={maxTimeStart}
            step={timeStep}
            value={controls.startSeconds}
            onChange={(event) =>
              updateWaveformViewport({ startSeconds: Number(event.target.value) })
            }
            ref={timeScrollRef}
            onPointerDown={(event) => setScrub(scrubAnchor(event.currentTarget, event.clientX))}
            // Measure inside the handler, never inside the state updater: React nulls
            // event.currentTarget once the handler returns, and the updater runs later -- reading
            // it there threw during render and took the whole window blank.
            onPointerMove={(event) => {
              const anchor = scrubAnchor(event.currentTarget, event.clientX);
              setScrub((current) => (current ? anchor : current));
            }}
            onPointerUp={() => setScrub(null)}
            onPointerCancel={() => setScrub(null)}
            // Keyboard scrubbing gets the same readout, but focus alone does not: a plain click
            // leaves the slider focused, and a bubble that outlives the drag reads as stuck.
            onKeyDown={(event) => setScrub(scrubAnchor(event.currentTarget, null))}
            onBlur={() => setScrub(null)}
          />
          {/* Where the drag has actually landed, in recording time. A range input reports only a
              number, and 255.00s tells a reader far less than 0:04:15 does on an hours-long study. */}
          {/* Portalled for the same reason as the overview readout: `contain:paint` on the pane
              would otherwise be this fixed element's containing block. */}
          {scrub && createPortal(
            <span
              className="scrub-timestamp"
              data-testid="pyqt-time_scrollbar_timestamp"
              style={{ left: `${scrub.clientX}px`, top: `${scrub.top - 6}px` }}
            >
              {formatRecordingClock(controls.startSeconds)}
            </span>,
            document.body
          )}
        </label>
      </div>
      <WaveformOverview
        metadata={metadata}
        controls={controls}
        eventOverlays={eventOverlays}
        severityScores={severityScores}
        onSeek={(startSeconds) =>
          onUpdatePlot({ ...controls, startSeconds })
        }
      />
        </>
      )}
    </section>
  );
});

function WaveformOverviewAxis({
  waveform,
  controls,
  metadata,
}: {
  waveform: WaveformWindow | null | undefined;
  controls: WaveformControlsState;
  metadata: RecordingMetadata | null;
}) {
  const times = waveform?.times_seconds || [];
  const start = Number(times[0] ?? controls.startSeconds ?? 0);
  const end = Number(
    times[times.length - 1] ?? start + controls.timeWindowSeconds,
  );
  const duration = Math.max(0.001, end - start);
  const recordingDuration = Math.max(
    duration,
    recordingDurationSeconds(metadata),
  );
  const windowStartRatio = Math.max(
    0,
    Math.min(
      1,
      (controls.startSeconds || 0) / Math.max(0.001, recordingDuration),
    ),
  );
  const windowWidthRatio = Math.max(
    0.04,
    Math.min(1, duration / Math.max(0.001, recordingDuration)),
  );
  const firstWholeSecond = Math.ceil(start);
  const lastWholeSecond = Math.floor(end);
  const ticks = Array.from(
    { length: Math.max(0, lastWholeSecond - firstWholeSecond + 1) },
    (_, index) => firstWholeSecond + index,
  )
    .filter((tick) => tick > start && tick < end)
    .map((tick) => ({ tick, left: `${((tick - start) / duration) * 100}%` }));
  return (
    <div
      className="waveform-overview-axis"
      data-testid="pyqt-waveform_overview_axis"
      aria-hidden="true"
    >
      <div
        className="waveform-overview-track"
        data-testid="pyqt-waveform_overview_track"
      >
        <span
          className="waveform-overview-window"
          data-testid="pyqt-waveform_overview_window"
          style={{
            left: `${windowStartRatio * 100}%`,
            width: `${windowWidthRatio * 100}%`,
          }}
        />
      </div>
      <div
        className="waveform-overview-ticks"
        data-testid="pyqt-waveform_overview_ticks"
      >
        {ticks.map(({ tick, left }) => (
          <span key={tick} style={{ left }}>
            {tick}
          </span>
        ))}
      </div>
    </div>
  );
}

function zoomWaveformTimeWindow(
  controls: WaveformControlsState,
  metadata: RecordingMetadata | null,
  zoomSteps: number,
  anchorRatio: number,
): WaveformControlsState {
  const totalTime = Math.max(0.1, recordingDurationSeconds(metadata));
  const currentWindow = Math.max(0.1, controls.timeWindowSeconds);
  const currentStart = Math.max(0, controls.startSeconds);
  const ratio = Math.max(
    0,
    Math.min(1, Number.isFinite(anchorRatio) ? anchorRatio : 0.5),
  );
  const anchorTime = Math.max(
    currentStart,
    Math.min(
      currentStart + currentWindow,
      currentStart + currentWindow * ratio,
    ),
  );
  const nextWindow = Math.max(
    0.1,
    Math.min(totalTime, currentWindow * Math.exp(-zoomSteps * Math.log(1.25))),
  );
  const maxStart = Math.max(0, totalTime - nextWindow);
  const nextStart = Math.max(
    0,
    Math.min(anchorTime - nextWindow * ratio, maxStart),
  );
  return {
    ...controls,
    timeWindowSeconds: nextWindow,
    startSeconds: nextStart,
  };
}

function canonicalWaveformChannel(
  channel: string,
  metadata: RecordingMetadata | null,
  controls: WaveformControlsState,
): string {
  const raw = String(channel || "").trim();
  if (!raw) return "";
  const universe = waveformChannelUniverse(metadata, controls);
  const match = universe.find(
    (candidate) => candidate.toLowerCase() === raw.toLowerCase(),
  );
  return match || (universe.length ? "" : raw);
}

function uniqueWaveformChannels(channels: string[]): string[] {
  return Array.from(new Set(channels.filter(Boolean)));
}

function waveformHeaderRecordingLabel(
  recordingPath: string | null,
  metadata: RecordingMetadata | null,
  waveform: WaveformWindow | null,
): string {
  if (waveform?.source === "visual-fixture-pyqt-visible-order") {
    return "visual_fixture_raw.fif • 200 Hz • 8 channels • 10 s";
  }
  return recordingFileName(recordingPath, metadata);
}

function buildWaveformEventOverlays(
  runRecords: RunRecord[],
  runEventsByRun: Record<string, ReviewEvent[]>,
  visibleRunIds: string[],
  activeRunId: string | null,
  acceptedRunId: string | null,
): WaveformEventOverlay[] {
  const runById = new Map(runRecords.map((run) => [run.runId, run]));
  return visibleRunIds.flatMap((runId) =>
    (runEventsByRun[runId] || []).map((event) => ({
      event: { ...event, run_id: event.run_id || runId },
      run: runById.get(runId) || null,
      active: runId === activeRunId,
      accepted: runId === acceptedRunId,
      visible: true,
    })),
  );
}

function hotspotChannelsFromEvents(
  events: ReviewEvent[],
  metadata: RecordingMetadata | null,
  controls: WaveformControlsState,
): string[] {
  const universe = waveformChannelUniverse(metadata, controls);
  const canonicalByLower = new Map(
    universe.map((channel) => [channel.toLowerCase(), channel]),
  );
  const counts = new Map<string, number>();
  for (const event of events) {
    const rawChannel = String(event.channel || "").trim();
    if (!rawChannel) continue;
    const channel =
      canonicalByLower.get(rawChannel.toLowerCase()) || rawChannel;
    if (universe.length && !universe.includes(channel)) continue;
    counts.set(channel, (counts.get(channel) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort(
      ([leftChannel, leftCount], [rightChannel, rightCount]) =>
        rightCount - leftCount ||
        leftChannel.localeCompare(rightChannel, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
    )
    .map(([channel]) => channel);
}

function pyqtEventNavigationIndex(
  events: ReviewEvent[],
  currentIndex: number,
  offset: -1 | 1,
): number {
  const normalizedCurrent = Math.min(
    Math.max(0, currentIndex),
    Math.max(0, events.length - 1),
  );
  const currentEvent = events[normalizedCurrent];
  if (offset < 0 && normalizedCurrent === 0 && isSpindleEvent(currentEvent))
    return 0;
  return (normalizedCurrent + offset + events.length) % events.length;
}

function findPendingReviewIndex(
  events: ReviewEvent[],
  currentIndex: number,
): number {
  if (!events.length) return -1;
  for (let offset = 1; offset <= events.length; offset += 1) {
    const candidateIndex = (currentIndex + offset) % events.length;
    if (!isReviewedEvent(events[candidateIndex])) return candidateIndex;
  }
  return -1;
}

function isReviewedEvent(event: ReviewEvent): boolean {
  const label = String(event.annotation?.label || "").toLowerCase();
  return Boolean(label && label !== "clear" && label !== "unreviewed");
}

function isSpindleEvent(event?: ReviewEvent | null): boolean {
  return String(event?.biomarker || "")
    .toLowerCase()
    .includes("spindle");
}

function eventDisplayName(event: ReviewEvent | null): string {
  return String(event?.biomarker || "detected");
}

/* PyQt shell source-contract anchors retained across formatter quote styles:
'batchProject'
'quickDetection'
'recordingInfo'
'runtimeLog'
'loadDetection'
'waveformShortcuts'
'eventReview'
'runStats'
setActiveDialog('channels')
setActiveDialog('bipolar')
setActiveDialog('batchProject')
setActiveDialog('quickDetection')
setActiveDialog('recordingInfo')
setActiveDialog('runtimeLog')
setActiveDialog('loadDetection')
setActiveDialog('waveformShortcuts')
setActiveDialog('eventReview')
setActiveDialog('runStats')
onBatchProject={() => setActiveDialog('batchProject')}
activeDialog === 'batchProject'
onOpenReview={() => setActiveDialog('eventReview')}
onShowArtifacts={() => openAgentTab('Artifacts')}
event.key !== 'Escape'
channelFocusMode: 'events'
value === 'gentle' || value === 'default' || value === 'fast'
onWaveformControlsChange({ ...waveformControls, cursorEnabled: false, measureEnabled: false })
onDeferredAction('Waveform settings updated')
shortcutId === 'hotspot'
shortcutId === 'center_event'
shortcutId === 'next_pending'
focusHotspotChannels()
navigateReviewEvent('current')
navigateReviewEvent('pending')
onUpdatePlot({ ...zoomedControls, channelStartIndex: nextChannelStart, startSeconds: nextTimeStart })
toDataURL('image/png')
*/
