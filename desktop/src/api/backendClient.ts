export type WaveformWindowRequest = {
  input_path?: string;
  start_seconds: number;
  duration_seconds: number;
  channels: string[];
  target_samples_per_channel: number;
  units?: string;
  show_filtered?: boolean;
  filter_60hz?: boolean;
  filter_low?: number;
  filter_high?: number;
};

type IeegBridge = {
  getBackendStatus(): Promise<unknown>;
  getCapabilityManifest(): Promise<unknown>;
  openRecording(): Promise<string | null>;
  openSavedSession(): Promise<string | null>;
  openProjectFile(): Promise<string | null>;
  openClassifierModel(): Promise<string | null>;
  saveProtocolPreset(request: unknown): Promise<unknown>;
  openProtocolPreset(): Promise<unknown | null>;
  openBatchInputDirectory(): Promise<string | null>;
  openBatchOutputDirectory(): Promise<string | null>;
  createProject(request: unknown): Promise<unknown>;
  openProject(request: unknown): Promise<unknown>;
  saveProject(request: unknown): Promise<unknown>;
  setWorkspaceDirty(request: unknown): Promise<unknown>;
  confirmDiscardWorkspace(request: unknown): Promise<unknown>;
  completeSaveBeforeClose(request: unknown): Promise<unknown>;
  onSaveBeforeClose(callback: () => void): () => void;
  loadSavedSession(sessionPath: string): Promise<unknown>;
  loadRecording(inputPath: string): Promise<unknown>;
  analyzeRecordingRoi(request: unknown): Promise<unknown>;
  analyzeRecordingQc(request: unknown): Promise<unknown>;
  analyzeRecordingSpectral(request: unknown): Promise<unknown>;
  prepareRecording(request: unknown): Promise<unknown>;
  requestWaveformWindow(request: WaveformWindowRequest): Promise<unknown>;
  listEvents(request?: unknown): Promise<unknown>;
  moveEventCursor(request: unknown): Promise<unknown>;
  eventSnippet(request: unknown): Promise<unknown>;
  eventFeatureSummary(request: unknown): Promise<unknown>;
  annotateEvent(request: unknown): Promise<unknown>;
  overlapReview(request: unknown): Promise<unknown>;
  createConsensusRun(request: unknown): Promise<unknown>;
  classifyActiveRun(request: unknown): Promise<unknown>;
  runDetection(request: unknown): Promise<unknown>;
  rankCandidateChannels(request: unknown): Promise<unknown>;
  runSeverityScoring(request: unknown): Promise<unknown>;
  getSeverityResult(): Promise<unknown>;
  getSeverityProgress(): Promise<unknown>;
  cancelSeverityScoring(): Promise<unknown>;
  onMenuCommand?(callback: (command: string) => void): () => void;
  createBatchProject(request: unknown): Promise<unknown>;
  runBatch(request: unknown): Promise<unknown>;
  recommendParameters(request: unknown): Promise<unknown>;
  detectorDefaults(request: unknown): Promise<unknown>;
  sendAgentMessage(request: unknown): Promise<unknown>;
  getAgentChatResult(jobId: string): Promise<unknown>;
  llmKeyStatus(): Promise<unknown>;
  setLlmKey(key: string): Promise<unknown>;
  clearLlmKey(): Promise<unknown>;
  setLlmSettings(settings: unknown): Promise<unknown>;
  listLlmModels(draft: unknown): Promise<unknown>;
  testLlmConnection(draft: unknown): Promise<unknown>;
  llmUsageSummary(): Promise<unknown>;
  llmProfileStatus(): Promise<unknown>;
  testLlmProfile(profile: unknown): Promise<unknown>;
  saveLlmProfile(profile: unknown): Promise<unknown>;
  clearLlmProfile(provider: string): Promise<unknown>;
  streamAgentMessage(request: unknown): Promise<unknown>;
  onAgentEvent(callback: (payload: { streamId: string; event: string; data: unknown }) => void): () => void;
  cancelAgentStream(streamId: string): void;
  uiBrokerReportState(request: unknown): Promise<unknown>;
  uiBrokerPoll(): Promise<unknown>;
  uiBrokerAck(request: unknown): Promise<unknown>;
  exportSession(request: unknown): Promise<unknown>;
  saveSessionExport(request: unknown): Promise<unknown>;
  exportReport(request: unknown): Promise<unknown>;
  saveReportExport(request: unknown): Promise<unknown>;
  exportWorkbook(request: unknown): Promise<unknown>;
  saveWorkbookExport(request: unknown): Promise<unknown>;
  savePngSnapshot(request: unknown): Promise<unknown>;
  openArtifactPath(request: unknown): Promise<unknown>;
  revealArtifactPath(request: unknown): Promise<unknown>;
};

declare global {
  interface Window {
    ieeg?: IeegBridge;
  }
}

function unavailable(method: string): Promise<never> {
  return Promise.reject(new Error(`Electron preload bridge unavailable for ${method}; open the packaged Electron app for native file/backend actions.`));
}

const browserPreviewBridge: IeegBridge = {
  getBackendStatus: () => Promise.resolve({ status: 'browser-preview', backend: 'unavailable' }),
  getCapabilityManifest: () => unavailable('capability manifest'),
  openRecording: () => Promise.resolve(null),
  openSavedSession: () => Promise.resolve(null),
  openProjectFile: () => Promise.resolve(null),
  openClassifierModel: () => Promise.resolve(null),
  saveProtocolPreset: () => unavailable('save protocol preset'),
  openProtocolPreset: () => unavailable('open protocol preset'),
  openBatchInputDirectory: () => Promise.resolve(null),
  openBatchOutputDirectory: () => Promise.resolve(null),
  createProject: () => unavailable('create project'),
  openProject: () => unavailable('open project'),
  saveProject: () => unavailable('save project'),
  setWorkspaceDirty: () => Promise.resolve({ status: 'ignored', source: 'browser-preview' }),
  confirmDiscardWorkspace: () => Promise.resolve({ action: 'cancel', source: 'browser-preview' }),
  completeSaveBeforeClose: () => Promise.resolve({ status: 'ignored', source: 'browser-preview' }),
  onSaveBeforeClose: () => () => undefined,
  loadSavedSession: () => unavailable('load saved session'),
  loadRecording: () => unavailable('load recording'),
  analyzeRecordingRoi: () => unavailable('analyze ROI'),
  analyzeRecordingQc: () => unavailable('analyze QC'),
  analyzeRecordingSpectral: () => unavailable('analyze spectral profile'),
  prepareRecording: () => unavailable('prepare recording'),
  requestWaveformWindow: () => unavailable('waveform window'),
  listEvents: () => unavailable('list events'),
  moveEventCursor: () => unavailable('move event cursor'),
  eventSnippet: () => unavailable('event snippet'),
  eventFeatureSummary: () => unavailable('event feature summary'),
  annotateEvent: () => unavailable('annotate event'),
  overlapReview: () => unavailable('overlap review'),
  createConsensusRun: () => unavailable('create consensus run'),
  classifyActiveRun: () => unavailable('classify active run'),
  runDetection: () => unavailable('run detection'),
  rankCandidateChannels: () => unavailable('rank candidate channels'),
  runSeverityScoring: () => unavailable('run severity scoring'),
  getSeverityResult: () => unavailable('get severity result'),
  getSeverityProgress: () => unavailable('get severity progress'),
  cancelSeverityScoring: () => unavailable('cancel severity scoring'),
  onMenuCommand: () => () => {},
  createBatchProject: () => unavailable('create batch project'),
  runBatch: () => unavailable('run batch'),
  recommendParameters: () => unavailable('recommend parameters'),
  detectorDefaults: () => unavailable('detector defaults'),
  sendAgentMessage: () => unavailable('send agent message'),
  getAgentChatResult: () => unavailable('get agent chat result'),
  llmKeyStatus: () => Promise.resolve({ hasKey: false, encryptionAvailable: false, agentUp: false }),
  setLlmKey: () => unavailable('set LLM key'),
  clearLlmKey: () => unavailable('clear LLM key'),
  setLlmSettings: () => unavailable('change LLM settings'),
  listLlmModels: () => unavailable('list models'),
  testLlmConnection: () => unavailable('test the connection'),
  llmUsageSummary: () => unavailable('read usage'),
  llmProfileStatus: () => Promise.resolve({ activeProvider: undefined, hasKey: false, legacy: false, profiles: [], providers: [], encryptionAvailable: false, agentUp: false }),
  testLlmProfile: () => unavailable('test LLM profile'),
  saveLlmProfile: () => unavailable('save LLM profile'),
  clearLlmProfile: () => unavailable('clear LLM profile'),
  streamAgentMessage: () => unavailable('stream agent message'),
  onAgentEvent: () => () => undefined,
  cancelAgentStream: () => undefined,
  uiBrokerReportState: () => Promise.resolve({ ok: false, reason: 'browser-preview' }),
  uiBrokerPoll: () => Promise.resolve({ commands: [] }),
  uiBrokerAck: () => Promise.resolve({ ok: false }),
  exportSession: () => unavailable('export session'),
  saveSessionExport: () => unavailable('save session export'),
  exportReport: () => unavailable('export report'),
  saveReportExport: () => unavailable('save report export'),
  exportWorkbook: () => unavailable('export workbook'),
  saveWorkbookExport: () => unavailable('save workbook export'),
  savePngSnapshot: () => unavailable('save PNG snapshot'),
  openArtifactPath: () => unavailable('open artifact'),
  revealArtifactPath: () => unavailable('reveal artifact')
};

function ieegBridge(): IeegBridge {
  return window.ieeg ?? browserPreviewBridge;
}

export const backendClient = {
  health: () => ieegBridge().getBackendStatus(),
  manifest: () => ieegBridge().getCapabilityManifest(),
  openRecording: () => ieegBridge().openRecording(),
  openSavedSession: () => ieegBridge().openSavedSession(),
  openProjectFile: () => ieegBridge().openProjectFile(),
  openClassifierModel: () => ieegBridge().openClassifierModel(),
  saveProtocolPreset: (request: unknown) => ieegBridge().saveProtocolPreset(request),
  openProtocolPreset: () => ieegBridge().openProtocolPreset(),
  openBatchInputDirectory: () => ieegBridge().openBatchInputDirectory(),
  openBatchOutputDirectory: () => ieegBridge().openBatchOutputDirectory(),
  createProject: (request: unknown) => ieegBridge().createProject(request),
  openProject: (request: unknown) => ieegBridge().openProject(request),
  saveProject: (request: unknown) => ieegBridge().saveProject(request),
  setWorkspaceDirty: (request: unknown) => ieegBridge().setWorkspaceDirty(request),
  confirmDiscardWorkspace: (request: unknown) => ieegBridge().confirmDiscardWorkspace(request),
  completeSaveBeforeClose: (request: unknown) => ieegBridge().completeSaveBeforeClose(request),
  onSaveBeforeClose: (callback: () => void) => ieegBridge().onSaveBeforeClose(callback),
  loadSavedSession: (sessionPath: string) => ieegBridge().loadSavedSession(sessionPath),
  loadRecording: (inputPath: string) => ieegBridge().loadRecording(inputPath),
  analyzeRecordingRoi: (request: unknown) => ieegBridge().analyzeRecordingRoi(request),
  analyzeRecordingQc: (request: unknown) => ieegBridge().analyzeRecordingQc(request),
  analyzeRecordingSpectral: (request: unknown) => ieegBridge().analyzeRecordingSpectral(request),
  prepareRecording: (request: unknown) => ieegBridge().prepareRecording(request),
  waveformWindow: (request: WaveformWindowRequest) => ieegBridge().requestWaveformWindow(request),
  listEvents: (request?: unknown) => ieegBridge().listEvents(request),
  moveEventCursor: (request: unknown) => ieegBridge().moveEventCursor(request),
  eventSnippet: (request: unknown) => ieegBridge().eventSnippet(request),
  eventFeatureSummary: (request: unknown) => ieegBridge().eventFeatureSummary(request),
  annotateEvent: (request: unknown) => ieegBridge().annotateEvent(request),
  overlapReview: (request: unknown) => ieegBridge().overlapReview(request),
  createConsensusRun: (request: unknown) => ieegBridge().createConsensusRun(request),
  classifyActiveRun: (request: unknown) => ieegBridge().classifyActiveRun(request),
  runDetection: (request: unknown) => ieegBridge().runDetection(request),
  rankCandidateChannels: (request: unknown) => ieegBridge().rankCandidateChannels(request),
  runSeverityScoring: (request: unknown) => ieegBridge().runSeverityScoring(request),
  getSeverityResult: () => ieegBridge().getSeverityResult(),
  getSeverityProgress: () => ieegBridge().getSeverityProgress(),
  cancelSeverityScoring: () => ieegBridge().cancelSeverityScoring(),
  onMenuCommand: (callback: (command: string) => void) => ieegBridge().onMenuCommand?.(callback) ?? (() => {}),
  createBatchProject: (request: unknown) => ieegBridge().createBatchProject(request),
  runBatch: (request: unknown) => ieegBridge().runBatch(request),
  recommendParameters: (request: unknown) => ieegBridge().recommendParameters(request),
  detectorDefaults: (request: unknown) => ieegBridge().detectorDefaults(request),
  sendAgentMessage: (request: unknown) => ieegBridge().sendAgentMessage(request),
  getAgentChatResult: (jobId: string) => ieegBridge().getAgentChatResult(jobId),
  llmKeyStatus: () => ieegBridge().llmKeyStatus(),
  setLlmKey: (key: string) => ieegBridge().setLlmKey(key),
  clearLlmKey: () => ieegBridge().clearLlmKey(),
  setLlmSettings: (settings: unknown) => ieegBridge().setLlmSettings(settings),
  listLlmModels: (draft: unknown) => ieegBridge().listLlmModels(draft),
  testLlmConnection: (draft: unknown) => ieegBridge().testLlmConnection(draft),
  llmUsageSummary: () => ieegBridge().llmUsageSummary(),
  llmProfileStatus: () => ieegBridge().llmProfileStatus(),
  testLlmProfile: (profile: unknown) => ieegBridge().testLlmProfile(profile),
  saveLlmProfile: (profile: unknown) => ieegBridge().saveLlmProfile(profile),
  clearLlmProfile: (provider: string) => ieegBridge().clearLlmProfile(provider),
  streamAgentMessage: (request: unknown) => ieegBridge().streamAgentMessage(request),
  onAgentEvent: (callback: (payload: { streamId: string; event: string; data: unknown }) => void) => ieegBridge().onAgentEvent(callback),
  cancelAgentStream: (streamId: string) => ieegBridge().cancelAgentStream(streamId),
  uiBrokerReportState: (request: unknown) => ieegBridge().uiBrokerReportState(request),
  uiBrokerPoll: () => ieegBridge().uiBrokerPoll(),
  uiBrokerAck: (request: unknown) => ieegBridge().uiBrokerAck(request),
  exportSession: (request: unknown) => ieegBridge().exportSession(request),
  saveSessionExport: (request: unknown) => ieegBridge().saveSessionExport(request),
  exportReport: (request: unknown) => ieegBridge().exportReport(request),
  saveReportExport: (request: unknown) => ieegBridge().saveReportExport(request),
  exportWorkbook: (request: unknown) => ieegBridge().exportWorkbook(request),
  saveWorkbookExport: (request: unknown) => ieegBridge().saveWorkbookExport(request),
  savePngSnapshot: (request: unknown) => ieegBridge().savePngSnapshot(request),
  openArtifactPath: (request: unknown) => ieegBridge().openArtifactPath(request),
  revealArtifactPath: (request: unknown) => ieegBridge().revealArtifactPath(request)
};
