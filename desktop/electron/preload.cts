import { contextBridge, ipcRenderer } from 'electron';

const ieegApi = {
  getBackendStatus: () => ipcRenderer.invoke('backend:status'),
  getCapabilityManifest: () => ipcRenderer.invoke('backend:manifest'),
  openRecording: () => ipcRenderer.invoke('recording:open-dialog'),
  openSavedSession: () => ipcRenderer.invoke('session:open-dialog'),
  openProjectFile: () => ipcRenderer.invoke('project:open-dialog'),
  openClassifierModel: () => ipcRenderer.invoke('classifier-model:open-dialog'),
  saveProtocolPreset: (request: unknown) => ipcRenderer.invoke('protocol-preset:save-dialog', request),
  openProtocolPreset: () => ipcRenderer.invoke('protocol-preset:open-dialog'),
  openBatchInputDirectory: () => ipcRenderer.invoke('batch:open-input-directory'),
  openBatchOutputDirectory: () => ipcRenderer.invoke('batch:open-output-directory'),
  createProject: (request: unknown) => ipcRenderer.invoke('project:create', request),
  openProject: (request: unknown) => ipcRenderer.invoke('project:open', request),
  saveProject: (request: unknown) => ipcRenderer.invoke('project:save', request),
  setWorkspaceDirty: (request: unknown) => ipcRenderer.invoke('workspace:set-dirty', request),
  confirmDiscardWorkspace: (request: unknown) => ipcRenderer.invoke('workspace:confirm-discard', request),
  completeSaveBeforeClose: (request: unknown) => ipcRenderer.invoke('workspace:save-before-close-result', request),
  onSaveBeforeClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('workspace:save-before-close', listener);
    return () => ipcRenderer.removeListener('workspace:save-before-close', listener);
  },
  loadSavedSession: (sessionPath: string) => ipcRenderer.invoke('session:load', { session_path: sessionPath }),
  loadRecording: (inputPath: string) => ipcRenderer.invoke('recording:load', { input_path: inputPath }),
  analyzeRecordingRoi: (request: unknown) => ipcRenderer.invoke('recording:roi', request),
  analyzeRecordingQc: (request: unknown) => ipcRenderer.invoke('recording:qc', request),
  analyzeRecordingSpectral: (request: unknown) => ipcRenderer.invoke('recording:spectral', request),
  prepareRecording: (request: unknown) => ipcRenderer.invoke('recording:prepare', request),
  requestWaveformWindow: (request: { input_path?: string; start_seconds: number; duration_seconds: number; channels: string[]; target_samples_per_channel: number; units?: string; show_filtered?: boolean; filter_60hz?: boolean; filter_low?: number; filter_high?: number }) => ipcRenderer.invoke('waveform:window', request),
  listEvents: (request?: unknown) => ipcRenderer.invoke('events:list', request),
  moveEventCursor: (request: unknown) => ipcRenderer.invoke('events:cursor', request),
  eventSnippet: (request: unknown) => ipcRenderer.invoke('events:snippet', request),
  eventFeatureSummary: (request: unknown) => ipcRenderer.invoke('events:feature-summary', request),
  annotateEvent: (request: unknown) => ipcRenderer.invoke('events:annotate', request),
  overlapReview: (request: unknown) => ipcRenderer.invoke('events:overlap-review', request),
  createConsensusRun: (request: unknown) => ipcRenderer.invoke('runs:create-consensus', request),
  classifyActiveRun: (request: unknown) => ipcRenderer.invoke('runs:classify-active', request),
  runDetection: (request: unknown) => ipcRenderer.invoke('detections:run', request),
  rankCandidateChannels: (request: unknown) => ipcRenderer.invoke('detections:rank-candidates', request),
  runSeverityScoring: (request: unknown) => ipcRenderer.invoke('severity:run', request),
  getSeverityResult: () => ipcRenderer.invoke('severity:get'),
  getSeverityProgress: () => ipcRenderer.invoke('severity:progress'),
  cancelSeverityScoring: () => ipcRenderer.invoke('severity:cancel'),
  createBatchProject: (request: unknown) => ipcRenderer.invoke('batch:create', request),
  runBatch: (request: unknown) => ipcRenderer.invoke('batch:run', request),
  recommendParameters: (request: unknown) => ipcRenderer.invoke('parameters:recommend', request),
  detectorDefaults: (request: unknown) => ipcRenderer.invoke('parameters:detector-defaults', request),
  sendAgentMessage: (request: unknown) => ipcRenderer.invoke('agent:chat', request),
  getAgentChatResult: (jobId: string) => ipcRenderer.invoke('agent:chat-result', jobId),
  // BYO-key: read/set/clear the user's LLM API key (stored encrypted in OS secure storage by main).
  llmKeyStatus: () => ipcRenderer.invoke('llm-key:status'),
  setLlmKey: (key: string) => ipcRenderer.invoke('llm-key:set', key),
  clearLlmKey: () => ipcRenderer.invoke('llm-key:clear'),
  setLlmSettings: (settings: unknown) => ipcRenderer.invoke('llm-settings:set', settings),
  listLlmModels: (draft: unknown) => ipcRenderer.invoke('llm-models:list', draft),
  testLlmConnection: (draft: unknown) => ipcRenderer.invoke('llm-connection:test', draft),
  llmUsageSummary: () => ipcRenderer.invoke('llm-usage:summary'),
  llmProfileStatus: () => ipcRenderer.invoke('llm-profile:status'),
  testLlmProfile: (profile: unknown) => ipcRenderer.invoke('llm-profile:test', profile),
  saveLlmProfile: (profile: unknown) => ipcRenderer.invoke('llm-profile:save', profile),
  clearLlmProfile: (provider: string) => ipcRenderer.invoke('llm-profile:clear', provider),
  // D (Phase 1): start a streamed agent turn (events arrive via onAgentEvent), and subscribe to them.
  streamAgentMessage: (request: unknown) => ipcRenderer.invoke('agent:chat-stream', request),
  // Menu commands travel main -> renderer; the renderer owns what they do.
  onMenuCommand: (callback: (command: string) => void) => {
    const listener = (_event: unknown, command: string) => callback(command);
    ipcRenderer.on('menu:command', listener);
    return () => ipcRenderer.removeListener('menu:command', listener);
  },
  onAgentEvent: (callback: (payload: { streamId: string; event: string; data: unknown }) => void) => {
    const listener = (_event: unknown, payload: { streamId: string; event: string; data: unknown }) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
  // Abort an in-flight streamed turn so main stops reading its SSE and stops emitting on 'agent:event'.
  cancelAgentStream: (streamId: string) => { void ipcRenderer.invoke('agent:chat-stream-cancel', streamId); },
  // UI MCP connector (last mile): renderer reports its state to the broker and drains its commands.
  uiBrokerReportState: (request: unknown) => ipcRenderer.invoke('ui-broker:report-state', request),
  uiBrokerPoll: () => ipcRenderer.invoke('ui-broker:poll'),
  uiBrokerAck: (request: unknown) => ipcRenderer.invoke('ui-broker:ack', request),
  exportSession: (request: unknown) => ipcRenderer.invoke('exports:session', request),
  saveSessionExport: (request: unknown) => ipcRenderer.invoke('exports:session-save-dialog', request),
  exportReport: (request: unknown) => ipcRenderer.invoke('exports:report', request),
  saveReportExport: (request: unknown) => ipcRenderer.invoke('exports:report-save-dialog', request),
  exportWorkbook: (request: unknown) => ipcRenderer.invoke('exports:workbook', request),
  saveWorkbookExport: (request: unknown) => ipcRenderer.invoke('exports:workbook-save-dialog', request),
  savePngSnapshot: (request: unknown) => ipcRenderer.invoke('exports:snapshot-png', request),
  openArtifactPath: (request: unknown) => ipcRenderer.invoke('artifact:open-path', request),
  revealArtifactPath: (request: unknown) => ipcRenderer.invoke('artifact:reveal-path', request)
};

contextBridge.exposeInMainWorld('ieeg', ieegApi);

export type IEEGPreloadApi = typeof ieegApi;
