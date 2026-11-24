// Dev-only probe: mounts the real AgentPanel with fixture props so chat UI changes can be checked
// against the vite dev server in seconds, instead of packaging the whole app to look at a bubble.
// Not referenced by the app; safe to delete.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentPanel } from './features/agent/AgentPanel';
import type { AgentChatMessage } from './app/workspaceState';

export function mountAgentPanel(hostId: string) {
  document.body.innerHTML = '';
  const host = document.createElement('div');
  host.id = hostId;
  host.style.inlineSize = '420px';
  host.style.blockSize = '900px';
  document.body.appendChild(host);

  const chatLog: AgentChatMessage[] = [
    { role: 'user', text: 'How severe is this recording?', ts: Date.now() - 5000 },
    { role: 'observation', text: 'Read recording metadata\n21 channels, 1801 s, eeg_type=scalp', ts: Date.now() - 4000 },
    { role: 'agent', text: 'The mean score is **2.31** with a peak of 4.42 at 12:45.', ts: Date.now() - 3000 },
  ];

  const stagedEntry = {
    command: {
      command_id: 'cmd-1',
      type: 'severity.run',
      payload: { input_path: 'C:/data/0.edf', export_csv: 'C:/data/scores.csv' },
      reason: 'Scoring overall severity using the BASED model',
    },
    source: 'agent',
    status: 'staged',
    diffState: 'unchanged',
    before: {},
    after: {},
    timestamp: new Date(Date.now() - 4 * 60000).toISOString(),
  };

  const rejectedEntry = {
    command: { command_id: 'cmd-2', type: 'detection.run', payload: {}, reason: 'Detect HFOs' },
    source: 'agent',
    status: 'rejected',
    diffState: 'blocked',
    before: {},
    after: {},
    timestamp: new Date().toISOString(),
    reason: 'missing recording',
  };

  createRoot(host).render(
    createElement(AgentPanel as never, {
      activeTab: 'Chat',
      message: '',
      agentChatLog: chatLog,
      conversations: Array.from({ length: 12 }, (_, index) => ({ id: `conversation-${index + 1}`, title: `Chat ${index + 1}` })),
      activeConversationId: 'conversation-1',
      onSelectConversation: () => {},
      onNewConversation: () => {},
      onCloseConversation: () => {},
      agentResponding: true,
      agentStreamingText: '',
      agentAutonomy: 'review',
      onAgentAutonomyChange: () => {},
      onMessageChange: () => {},
      onSend: () => {},
      onClose: () => {},
      recordingPath: 'C:/data/0.edf',
      runtimeOperation: { id: '', label: '', kind: 'idle', status: 'idle', progress: 0, startedAt: 0 },
      runtimeLog: [],
      commandHistory: [stagedEntry, rejectedEntry],
      artifacts: [],
      onOpenArtifact: () => {},
      onRevealArtifact: () => {},
      onRemoveArtifact: () => {},
      onClearArtifacts: () => {},
      onApplyStagedCommand: () => {},
      onDismissStagedCommand: () => {},
    } as never),
  );
  return new Promise<void>((resolve) => setTimeout(resolve, 700));
}
