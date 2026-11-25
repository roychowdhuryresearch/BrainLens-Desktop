import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { AgentArtifact, AgentChatMessage, AgentPanelTab, RuntimeLogEntry, RuntimeOperation } from '../../app/workspaceState';
import { safetyCopy } from './agentPayload';
import { filterHistory, type AgentAutonomyLevel, type HistoryEntry, type UICommandSource, type UICommandStatus } from './uiCommands';
import { LlmKeyButton } from './LlmKeyButton';
import { backendClient } from '../../api/backendClient';
import { filterAgentReply } from './agentReplyFilter';

type AgentArtifactFilter = AgentArtifact['type'] | 'all';
const AGENT_ARTIFACT_COLLAPSED_STORAGE_KEY = 'ieeg.agentArtifactCollapsedGroups';
const AGENT_ARTIFACT_FILTERS: AgentArtifactFilter[] = ['all', 'recording', 'session', 'detection', 'summary', 'workbook', 'report', 'snapshot', 'other'];
// Empty-chat suggestions: clicking one only fills the composer (HITL culture -- the
// clinician presses Enter), so the first screen sells "no params, just type".
const AGENT_SUGGESTED_PROMPTS = [
  'Inspect this recording and flag QC issues',
  'Suggest safe detector settings for this recording',
  'Run detection and summarize the top events'
];
// Tab switching lives ONLY on the activity rail (AgentActivityBar) -- the panel renders the
// active view without its own duplicate tab strip. These ids stay so the rail buttons'
// aria-controls keep pointing at real panels.
const AGENT_PANEL_TABPANEL_IDS: Record<AgentPanelTab, string> = {
  Chat: 'agent-panel-chat-tabpanel',
  Actions: 'agent-panel-actions-tabpanel',
  Artifacts: 'agent-panel-artifacts-tabpanel',
  Safety: 'agent-panel-safety-tabpanel'
};
const AGENT_AUTONOMY_OPTIONS: Array<{ value: AgentAutonomyLevel; label: string; detail: string }> = [
  { value: 'review', label: 'Guarded (default)', detail: 'Read-only analysis is agent-driven. Runs, exports, annotations, and recording changes require your Apply action.' },
  { value: 'auto-run', label: 'Auto-run (guarded)', detail: 'Standing delegation is not configured, so clinician-authorized writes still wait for Apply. The agent may continue read-only analysis and navigation.' },
  { value: 'full', label: 'Full (guarded)', detail: 'Full delegation is not configured. Every clinician-authorized side effect still waits for Apply and a durable broker authorization.' }
];

function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    lastIndex = match.index + token.length;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function tableCells(line: string): string[] {
  return line.replace(/^\s*\|?/, '').replace(/\|?\s*$/, '').split('|').map((cell) => cell.trim());
}

function isMarkdownTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderMarkdownMessage(text: string): ReactNode {
  const normalized = text.replace(/^AGENT\s*/i, '').trim();
  const lines = normalized.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: Array<{ ordered: boolean; text: string }> = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const value = paragraph.join(' ').trim();
    if (value) blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(value, `p-${blocks.length}`)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const ordered = list.every((item) => item.ordered);
    const items = list.map((item, index) => <li key={index}>{inlineMarkdown(item.text, `li-${blocks.length}-${index}`)}</li>);
    blocks.push(ordered ? <ol key={`ol-${blocks.length}`}>{items}</ol> : <ul key={`ul-${blocks.length}`}>{items}</ul>);
    list = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isMarkdownTableDivider(lines[i + 1])) {
      flushParagraph();
      flushList();
      const headers = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      i -= 1;
      blocks.push(
        <div className="agent-markdown-table-wrap" key={`table-${blocks.length}`}>
          <table>
            <thead><tr>{headers.map((header, index) => <th key={index}>{inlineMarkdown(header, `th-${blocks.length}-${index}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] || '', `td-${blocks.length}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const content = inlineMarkdown(heading[2], `h-${blocks.length}`);
      blocks.push(level === 1 ? <h3 key={`h-${blocks.length}`}>{content}</h3> : <h4 key={`h-${blocks.length}`}>{content}</h4>);
      continue;
    }

    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      list.push({ ordered: Boolean(ordered), text: (bullet || ordered)?.[1] || '' });
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();

  return <div className="agent-message-markdown">{blocks.length ? blocks : <p>{normalized}</p>}</div>;
}

// What the action IS, in the words the UI uses for it. `severity.run` is the wire name; a person
// approving an action should read the same thing the button they would have clicked says.
const COMMAND_LABELS: Record<string, string> = {
  'severity.run': 'Run severity scoring',
  'detection.run': 'Run detection',
  'detection.set_parameters': 'Change detector parameters',
  'detection.create_consensus_run': 'Create a consensus run',
  'classification.run': 'Run the classifier',
  'classification.set_parameters': 'Change classifier parameters',
  'analysis.prepare_recording': 'Prepare the recording (filter/resample)',
  'analysis.run_qc': 'Run channel QC',
  'analysis.compute_spectral_profile': 'Compute the spectral profile',
  'batch.create': 'Create a batch project',
  'batch.run': 'Run the batch project',
  'export.report': 'Export a report',
  'export.session': 'Export the session',
  'export.workbook': 'Export the workbook',
  'review.accept_run': 'Accept this run',
  'project.save': 'Save the project',
};

function commandLabel(type: string): string {
  if (COMMAND_LABELS[type]) return COMMAND_LABELS[type];
  // Fall back to something readable rather than the raw dotted name.
  const [, action] = type.split('.');
  return `${(action || type).replace(/_/g, ' ')}`.replace(/^./, (char) => char.toUpperCase());
}

/** Payload entries worth showing beside the button: the values that change what the run does. */
function commandParameters(payload: Record<string, unknown> | undefined): Array<[string, string]> {
  if (!payload) return [];
  return Object.entries(payload)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [
      key.replace(/_/g, ' '),
      Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value),
    ]);
}

export const AgentPanel = memo(function AgentPanel({ activeTab, message, agentChatLog, conversations, activeConversationId, onSelectConversation, onNewConversation, onCloseConversation, agentResponding, agentStreamingText, agentAutonomy, onAgentAutonomyChange, onMessageChange, onSend, onClose, recordingPath, runtimeOperation, runtimeLog, commandHistory, artifacts, onOpenArtifact, onRevealArtifact, onRemoveArtifact, onClearArtifacts, onApplyStagedCommand, onDismissStagedCommand }: { activeTab: AgentPanelTab; message: string; agentChatLog: AgentChatMessage[]; conversations: Array<{ id: string; title: string }>; activeConversationId: string; onSelectConversation: (conversationId: string) => void; onNewConversation: () => void; onCloseConversation: (conversationId: string) => void; agentResponding: boolean; agentStreamingText: string; agentAutonomy: AgentAutonomyLevel; onAgentAutonomyChange: (level: AgentAutonomyLevel) => void; onMessageChange: (value: string) => void; onSend: () => void; onClose: () => void; recordingPath: string | null; runtimeOperation: RuntimeOperation; runtimeLog: RuntimeLogEntry[]; commandHistory: HistoryEntry[]; artifacts: AgentArtifact[]; onOpenArtifact: (path: string) => Promise<void> | void; onRevealArtifact: (path: string) => Promise<void> | void; onRemoveArtifact: (id: string) => void; onClearArtifacts: () => void; onApplyStagedCommand: (commandId: string) => void; onDismissStagedCommand: (commandId: string) => void }) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const conversationTabsRef = useRef<HTMLDivElement>(null);
  // A vertical wheel does nothing to a horizontally-scrolling strip in Chromium unless Shift is held,
  // so the tabs looked stuck. Translate the wheel into horizontal movement, and only when there is
  // something to scroll -- otherwise the gesture is swallowed and the panel below stops scrolling.
  // Native listener with passive:false: React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const strip = conversationTabsRef.current;
    if (!strip) return;
    function onWheel(event: WheelEvent) {
      const overflow = strip!.scrollWidth - strip!.clientWidth;
      if (overflow <= 0) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      const next = Math.max(0, Math.min(overflow, strip!.scrollLeft + delta));
      if (next === strip!.scrollLeft) return;
      event.preventDefault();
      strip!.scrollLeft = next;
    }
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);
  // Keep the newest message in view — without this the agent's reply lands below the fold and reads as "no reply".
  // Tracking the streaming text/flag too keeps the live reply bubble pinned to the bottom as it grows.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agentChatLog, activeTab, agentResponding, agentStreamingText]);

  // The live bubble gets the same treatment as the finished message: a half-written plan envelope
  // streaming in is still scaffolding, not conversation.
  const streamingBody = filterAgentReply(agentStreamingText).text;

  // Surface staged (confirmation-gated) commands inline in the Chat thread, not only in the Actions tab —
  // otherwise an agent action waiting for Apply is invisible to a clinician looking at the conversation.
  const stagedCommands = useMemo(() => commandHistory.filter((entry) => entry.status === 'staged'), [commandHistory]);
  // A tool the agent could not run is the one thing a user MUST see: without this the model
  // narrates around the failure and the answer looks confident with nothing behind it.
  const failedCommands = useMemo(
    () => commandHistory.filter((entry) => entry.status === 'rejected').slice(-3),
    [commandHistory],
  );
  // Ticks so a request that has been waiting says so, instead of sitting silently forever.
  // Which model is answering, shown beside the title: with several providers configurable and a
  // local server in the mix, 'who am I talking to' is not something the user should have to open a
  // settings panel to answer.
  const [activeModel, setActiveModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void backendClient.llmKeyStatus().then((status) => {
        const settings = (status as { settings?: { model?: string } })?.settings;
        if (!cancelled) setActiveModel(settings?.model || null);
      }).catch(() => { /* browser preview */ });
    };
    read();
    // The model can change from the settings panel; a slow poll keeps the label honest without
    // plumbing an event through for one string.
    const timer = window.setInterval(read, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!stagedCommands.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [stagedCommands.length]);

  function handleChatSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSend();
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSend();
  }

  return (
    <section className="agent-panel" data-testid="agent-panel" aria-label="BrainLens Agent panel">
      <header className="agent-panel-header">
        <strong>BrainLens Agent</strong>
        {activeModel && (
          <span className="agent-panel-model" data-testid="agent-panel-model" title={`This conversation is using ${activeModel}`}>{activeModel}</span>
        )}
        <span className="agent-panel-header-status">{activeTab}</span>
        <LlmKeyButton />
        <button data-testid="agent-panel-close" onClick={onClose} aria-label="Close Agent panel">×</button>
      </header>
      {activeTab === 'Chat' && (
        // Threads, not one endless log: a new conversation starts a fresh backend history, so the
        // co-pilot is not still reasoning about the last recording when you move on.
        <div className="agent-conversation-tabs" data-testid="agent-conversation-tabs" role="tablist" aria-label="Conversations" ref={conversationTabsRef}>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              role="tab"
              aria-selected={conversation.id === activeConversationId}
              className={conversation.id === activeConversationId ? 'active' : ''}
              data-testid="agent-conversation-tab"
              data-conversation-id={conversation.id}
              onClick={() => onSelectConversation(conversation.id)}
            >
              <span className="agent-conversation-title">{conversation.title}</span>
              {conversations.length > 1 && (
                // A span, not a nested <button>: a button inside a button is invalid and Chromium
                // drops the inner one's clicks.
                <span
                  className="agent-conversation-close"
                  role="button"
                  tabIndex={0}
                  data-testid="agent-conversation-close"
                  aria-label={`Close ${conversation.title}`}
                  title={`Close ${conversation.title}`}
                  onClick={(event) => { event.stopPropagation(); onCloseConversation(conversation.id); }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseConversation(conversation.id);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button
            className="agent-conversation-new"
            data-testid="agent-conversation-new"
            title="Start a new conversation"
            aria-label="Start a new conversation"
            onClick={onNewConversation}
          >
            +
          </button>
        </div>
      )}
      {activeTab === 'Chat' && (
        <div className="agent-tab-content agent-chat-tab" data-testid="agent-chat-tab" id={AGENT_PANEL_TABPANEL_IDS.Chat} aria-label="Agent chat">
          <div ref={transcriptRef} className="agent-chat-transcript" data-testid="agent-chat-transcript" data-empty={agentChatLog.length === 0 && !agentResponding ? 'true' : 'false'}>
            {agentChatLog.length === 0 && !agentResponding && (
              <div className="agent-chat-empty" data-testid="agent-chat-empty">
                <span className="agent-chat-empty-glyph" aria-hidden="true">
                  <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
                </span>
                <h3>EEG analysis co-pilot</h3>
                <p>Inspect the recording, tune detectors, and stage workspace actions — nothing runs without your approval.</p>
                <div className="agent-chat-suggestions" data-testid="agent-chat-suggestions">
                  {AGENT_SUGGESTED_PROMPTS.map((prompt) => (
                    <button key={prompt} type="button" data-testid="agent-chat-suggestion" onClick={() => onMessageChange(prompt)}>{prompt}</button>
                  ))}
                </div>
              </div>
            )}
            {agentChatLog.map((entry, index) => {
              if (entry.role === 'run' && entry.run) {
                const run = entry.run;
                return (
                  <article key={`${entry.ts}-${index}`} className="agent-message-card agent-run-card" data-testid="agent-chat-run-message" data-status={run.status} aria-live="polite">
                    <span className="agent-message-role">Detection run</span>
                    <p className="agent-run-card-label">{run.label}</p>
                    <p className="agent-run-card-status">
                      {run.status === 'running' && (
                        <>Running<span className="agent-thinking" aria-hidden="true"><span className="agent-thinking-dot" /><span className="agent-thinking-dot" /><span className="agent-thinking-dot" /></span></>
                      )}
                      {run.status === 'complete' && (run.detail || 'Complete')}
                      {run.status === 'failed' && (run.detail ? `Failed · ${run.detail}` : 'Failed')}
                    </p>
                  </article>
                );
              }
              // System/observation lines are the agent's working notes -- what it looked at, what a
              // tool returned. They belong in the thread (hiding them would make the agent opaque) but
              // not at the same weight as speech: one collapsed line, openable when someone cares.
              if (entry.role === 'observation') {
                const [summary] = entry.text.split(/\r?\n/);
                const hasDetail = entry.text.trim().length > summary.trim().length;
                return (
                  <details key={`${entry.ts}-${index}`} className="agent-activity-row" data-testid="agent-chat-observation-message">
                    <summary>
                      <span className="agent-activity-icon" aria-hidden="true">⛭</span>
                      <span className="agent-activity-summary">{summary.slice(0, 120)}</span>
                    </summary>
                    {hasDetail && <pre className="agent-activity-detail">{entry.text}</pre>}
                  </details>
                );
              }
              const roleClass = entry.role === 'user' ? 'user' : 'reply';
              const roleLabel = entry.role === 'user' ? 'You' : 'Agent';
              return (
                <article key={`${entry.ts}-${index}`} className={`agent-message-card agent-message-card-${roleClass}`} data-testid={`agent-chat-${entry.role}-message`}>
                  <span className="agent-message-role">{roleLabel}</span>
                  {entry.role === 'agent' ? renderMarkdownMessage(entry.text) : <p className="agent-message-text" style={{ whiteSpace: 'pre-wrap' }}>{entry.text}</p>}
                </article>
              );
            })}
            {agentResponding && !streamingBody && (
              // Nothing to show yet: say what is happening on one quiet line instead of an empty
              // 'Agent' bubble, which reads as a failed reply.
              <p className="agent-working" data-testid="agent-chat-working" aria-live="polite">
                <span className="agent-thinking-dot" />
                <span className="agent-thinking-dot" />
                <span className="agent-thinking-dot" />
                <span className="agent-working-label">Working…</span>
              </p>
            )}
            {agentResponding && streamingBody && (
              <article className="agent-message-card agent-message-card-reply agent-message-card-streaming" data-testid="agent-chat-streaming-message" aria-live="polite" aria-busy="true">
                <span className="agent-message-role">Agent</span>
                {streamingBody ? (
                  <div className="agent-streaming-body">
                    {renderMarkdownMessage(streamingBody)}
                    <span className="agent-streaming-caret" aria-hidden="true" />
                  </div>
                ) : (
                  <p className="agent-thinking" aria-label="Agent is responding">
                    <span className="agent-thinking-dot" />
                    <span className="agent-thinking-dot" />
                    <span className="agent-thinking-dot" />
                  </p>
                )}
              </article>
            )}
          </div>
          {failedCommands.length > 0 && (
            <div className="agent-chat-failures" data-testid="agent-chat-failures" aria-live="polite">
              {failedCommands.map((entry) => (
                <article
                  key={`${entry.command.command_id}-failed`}
                  className="agent-message-card agent-chat-failure-card"
                  data-testid="agent-chat-failure-card"
                  data-command-type={entry.command.type}
                >
                  <span className="agent-message-role">Could not run</span>
                  <p className="agent-chat-staged-type"><strong>{commandLabel(entry.command.type)}</strong></p>
                  <p className="agent-chat-failure-reason">{entry.reason || 'The workspace rejected this action.'}</p>
                </article>
              ))}
            </div>
          )}
          {stagedCommands.length > 0 && (
            <div className="agent-chat-staged" data-testid="agent-chat-staged" aria-live="polite">
              <p className="agent-chat-staged-title">{stagedCommands.length === 1 ? 'Waiting for you' : `${stagedCommands.length} actions waiting for you`}</p>
              <div className="agent-chat-staged-list">
              {stagedCommands.map((entry) => (
                <article
                  key={entry.command.command_id}
                  className="agent-message-card agent-chat-staged-card"
                  data-testid="agent-chat-staged-card"
                  data-command-id={entry.command.command_id}
                  data-command-type={entry.command.type}
                >
                  <span className="agent-message-role">Agent wants to run</span>
                  <p className="agent-chat-staged-type"><strong>{commandLabel(entry.command.type)}</strong></p>
                  {entry.command.reason && <p className="agent-chat-staged-reason">{entry.command.reason}</p>}
                  {(() => {
                    const waitedMs = now - new Date(entry.timestamp).getTime();
                    if (!Number.isFinite(waitedMs) || waitedMs < 45000) return null;
                    const minutes = Math.round(waitedMs / 60000);
                    return (
                      <p className="agent-chat-staged-waiting" data-testid="agent-chat-staged-waiting">
                        Waiting {minutes < 1 ? 'under a minute' : `${minutes} min`} for you — nothing has run yet.
                      </p>
                    );
                  })()}
                  {commandParameters(entry.command.payload).length > 0 && (
                    <dl className="agent-chat-staged-params" data-testid="agent-chat-staged-params">
                      {commandParameters(entry.command.payload).map(([key, value]) => (
                        <div key={key}><dt>{key}</dt><dd title={value}>{value}</dd></div>
                      ))}
                    </dl>
                  )}
                  <div className="button-row">
                    <button className="agent-chat-staged-run" data-testid="agent-chat-staged-apply" onClick={() => onApplyStagedCommand(entry.command.command_id)}>Run</button>
                    <button data-testid="agent-chat-staged-dismiss" onClick={() => onDismissStagedCommand(entry.command.command_id)}>Dismiss</button>
                  </div>
                </article>
              ))}
              </div>
            </div>
          )}
          <form className="agent-chat-composer" data-testid="agent-chat-composer" onSubmit={handleChatSubmit}>
            <label className="sr-only" htmlFor="agent-prompt-input">Agent prompt</label>
            <textarea id="agent-prompt-input" value={message} onChange={(event) => onMessageChange(event.target.value)} onKeyDown={handleComposerKeyDown} aria-label="Agent prompt" placeholder="Ask about this recording…" />
            <div className="agent-composer-footer">
              <span className="agent-context-chip" data-testid="agent-context-chip" title={recordingPath || 'No recording loaded'}>{recordingPath ? recordingPath.split(/[\\/]/).pop() : 'No recording loaded'}</span>
              <span className="agent-composer-hint" aria-hidden="true">Enter sends · Shift+Enter for a new line</span>
              <button type="submit">Send</button>
            </div>
          </form>
        </div>
      )}
      {activeTab === 'Actions' && <AgentActionsTab runtimeOperation={runtimeOperation} runtimeLog={runtimeLog} commandHistory={commandHistory} onApplyStagedCommand={onApplyStagedCommand} onDismissStagedCommand={onDismissStagedCommand} />}
      {activeTab === 'Artifacts' && <AgentArtifactsTab artifacts={artifacts} onOpenArtifact={onOpenArtifact} onRevealArtifact={onRevealArtifact} onRemoveArtifact={onRemoveArtifact} onClearArtifacts={onClearArtifacts} />}
      {activeTab === 'Safety' && (
        <div className="agent-tab-content" data-testid="agent-safety-tab" id={AGENT_PANEL_TABPANEL_IDS.Safety} aria-label="Agent safety and context">
          <h3>Safety / Context</h3>
          <p>{safetyCopy}</p>
          <p>Nyquist, filter, provenance, and clinical-boundary warnings stay visible before write actions.</p>
          <section className="agent-autonomy" data-testid="agent-autonomy">
            <h4>Agent autonomy</h4>
            <label className="agent-autonomy-field">Apply actions
              <select data-testid="agent-autonomy-select" value={agentAutonomy} onChange={(event) => onAgentAutonomyChange(event.target.value as AgentAutonomyLevel)}>
                {AGENT_AUTONOMY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
            <p className="agent-autonomy-detail" data-testid="agent-autonomy-detail">{AGENT_AUTONOMY_OPTIONS.find((option) => option.value === agentAutonomy)?.detail}</p>
            {agentAutonomy === 'full' && <p className="agent-autonomy-warning" data-testid="agent-autonomy-warning">No local preference can mint clinician authority. Writes remain staged until your explicit Apply action is accepted.</p>}
          </section>
        </div>
      )}
    </section>
  );
});

const AgentActionsTab = memo(function AgentActionsTab({ runtimeOperation, runtimeLog, commandHistory, onApplyStagedCommand, onDismissStagedCommand }: { runtimeOperation: RuntimeOperation; runtimeLog: RuntimeLogEntry[]; commandHistory: HistoryEntry[]; onApplyStagedCommand: (commandId: string) => void; onDismissStagedCommand: (commandId: string) => void }) {
  const [sourceFilter, setSourceFilter] = useState<UICommandSource | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<UICommandStatus | 'all'>('all');
  const recent = useMemo(() => runtimeLog.slice(-30).reverse(), [runtimeLog]);
  const filteredCommands = useMemo(() => filterHistory(commandHistory, {
    source: sourceFilter === 'all' ? undefined : sourceFilter,
    status: statusFilter === 'all' ? undefined : statusFilter
  }).slice(-30).reverse(), [commandHistory, sourceFilter, statusFilter]);
  const stagedCount = useMemo(() => commandHistory.filter((entry) => entry.status === 'staged').length, [commandHistory]);
  return (
    <div className="agent-tab-content" data-testid="agent-actions-tab" id={AGENT_PANEL_TABPANEL_IDS.Actions} aria-label="Agent action trace">
      <h3>Action trace</h3>
      <section className="agent-current-operation" data-testid="agent-current-operation">
        <strong>{runtimeOperation.label}</strong>
        <span className={`status-pill runtime-${runtimeOperation.status}`}>{runtimeOperation.status}</span>
        <progress value={runtimeOperation.indeterminate ? undefined : runtimeOperation.progress} max={100} aria-label="Current operation progress" />
      </section>
      <div className="agent-command-toolbar" data-testid="agent-command-toolbar">
        <label>Source
          <select data-testid="agent-command-source-filter" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as UICommandSource | 'all')}>
            {(['all', 'user', 'agent', 'system'] as Array<UICommandSource | 'all'>).map((source) => <option key={source} value={source}>{source}</option>)}
          </select>
        </label>
        <label>Status
          <select data-testid="agent-command-status-filter" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as UICommandStatus | 'all')}>
            {(['all', 'staged', 'applied', 'rejected', 'dismissed'] as Array<UICommandStatus | 'all'>).map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
        </label>
        <span className="status-pill" data-testid="agent-staged-command-count">{stagedCount} staged</span>
        <span className="status-pill" data-testid="agent-command-filter-count">{filteredCommands.length}/{commandHistory.length} commands</span>
      </div>
      <div className="agent-command-history" data-testid="agent-command-history">
        {filteredCommands.map((entry) => (
          <article
            key={`${entry.command.command_id}-${entry.timestamp}`}
            className="agent-command-card"
            data-testid="agent-command-card"
            data-command-id={entry.command.command_id}
            data-command-type={entry.command.type}
            data-command-status={entry.status}
            data-command-source={entry.source}
          >
            <header>
              <strong>{entry.command.type}</strong>
              <span className="status-pill">{entry.source}</span>
              <span className="status-pill">{entry.status}</span>
              <span className="status-pill">{entry.diffState}</span>
            </header>
            <p>{entry.command.reason}</p>
            <details>
              <summary>Before / after diff</summary>
              <pre data-testid="agent-command-diff">{formatCommandDiff(entry)}</pre>
            </details>
            {entry.status === 'staged' && (
              <div className="button-row">
                <button data-testid="agent-command-apply" onClick={() => onApplyStagedCommand(entry.command.command_id)}>Apply</button>
                <button data-testid="agent-command-dismiss" onClick={() => onDismissStagedCommand(entry.command.command_id)}>Dismiss</button>
              </div>
            )}
          </article>
        ))}
        {!filteredCommands.length && <p className="agent-empty-row">No UI command history matches the current source/status filters.</p>}
      </div>
      <h4>Runtime log</h4>
      <ul className="agent-action-list" data-testid="agent-action-list">
        {recent.map((entry) => (
          <li key={entry.id} className={`agent-action-entry runtime-log-${entry.level}`}>
            <time>{new Date(entry.timestamp).toLocaleTimeString()}</time>
            <span>{entry.message}</span>
          </li>
        ))}
        {!recent.length && <li className="agent-empty-row">No actions yet.</li>}
      </ul>
      <p className="helper-copy">Agent Actions combines your UI command history with runtime logs, so staged, applied, and rejected changes stay inspectable before anything is committed.</p>
    </div>
  );
});

function formatCommandDiff(entry: HistoryEntry): string {
  return JSON.stringify({
    before: commandDiffSnapshot(entry.before),
    after: commandDiffSnapshot(entry.after),
    payload: entry.command.payload
  }, null, 2);
}

function commandDiffSnapshot(state: HistoryEntry['before']) {
  return {
    activePanel: state.activePanel,
    selectedChannel: state.selectedChannel,
    selectedEvent: state.selectedEvent,
    selectedRun: state.selectedRun,
    viewport: state.viewport
  };
}

const AgentArtifactsTab = memo(function AgentArtifactsTab({ artifacts, onOpenArtifact, onRevealArtifact, onRemoveArtifact, onClearArtifacts }: { artifacts: AgentArtifact[]; onOpenArtifact: (path: string) => Promise<void> | void; onRevealArtifact: (path: string) => Promise<void> | void; onRemoveArtifact: (id: string) => void; onClearArtifacts: () => void }) {
  const [filter, setFilter] = useState<AgentArtifactFilter>('all');
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(loadPersistedArtifactCollapsedGroups);
  const artifactCounts = useMemo(() => artifactTypeCounts(artifacts), [artifacts]);
  const filteredArtifacts = useMemo(() => artifacts
    .filter((artifact) => filter === 'all' || artifact.type === filter)
    .filter((artifact) => artifactMatchesSearch(artifact, search)), [artifacts, filter, search]);
  const artifactGroups = useMemo(() => groupArtifactsByRunOrProject(filteredArtifacts), [filteredArtifacts]);
  useEffect(() => { persistArtifactCollapsedGroups(collapsedGroups); }, [collapsedGroups]);
  function toggleArtifactGroup(groupKey: string) {
    setCollapsedGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  }
  function setArtifactGroupCollapsed(groupKey: string, collapsed: boolean) {
    setCollapsedGroups((current) => ({ ...current, [groupKey]: collapsed }));
  }
  function handleArtifactGroupKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, groupKey: string) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setArtifactGroupCollapsed(groupKey, true);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setArtifactGroupCollapsed(groupKey, false);
    }
  }
  return (
    <div className="agent-tab-content" data-testid="agent-artifacts-tab" id={AGENT_PANEL_TABPANEL_IDS.Artifacts} aria-label="Agent artifacts">
      <div className="agent-artifacts-toolbar"><h3>Artifacts</h3><button data-testid="agent-artifact-clear" onClick={onClearArtifacts} disabled={!artifacts.length}>Clear History</button></div>
      <div className="agent-artifact-filter-row" data-testid="agent-artifact-filter-row">
        <label>Type
          <select data-testid="agent-artifact-type-filter" value={filter} onChange={(event) => setFilter(event.target.value as AgentArtifactFilter)}>
            {AGENT_ARTIFACT_FILTERS.map((type) => <option key={type} value={type}>{artifactFilterLabel(type, artifactCounts[type] || 0)}</option>)}
          </select>
        </label>
        <span className="status-pill" data-testid="agent-artifact-filter-count">{filteredArtifacts.length}/{artifacts.length} visible</span>
      </div>
      <label className="agent-artifact-search" data-testid="agent-artifact-search-row">Search
        <input data-testid="agent-artifact-search-input" placeholder="Label, path, run, type, source…" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <p className="helper-copy" data-testid="agent-artifacts-persistence">Artifact history persists across renderer refresh and app restart via localStorage.</p>
      <div className="agent-artifact-list" data-testid="agent-artifact-list">
        {artifactGroups.map((group) => (
          <section key={group.key} className="agent-artifact-group" data-testid="agent-artifact-group" data-artifact-group={group.key} data-collapsed={collapsedGroups[group.key] ? 'true' : 'false'}>
            <button className="agent-artifact-group-header" data-testid="agent-artifact-group-toggle" aria-expanded={collapsedGroups[group.key] ? 'false' : 'true'} onClick={() => toggleArtifactGroup(group.key)} onKeyDown={(event) => handleArtifactGroupKeyDown(event, group.key)}>
              <span>{collapsedGroups[group.key] ? '▸' : '▾'} <strong>{group.label}</strong></span>
              <span className="status-pill">{group.artifacts.length}</span>
            </button>
            {!collapsedGroups[group.key] && (
              <ul>
                {group.artifacts.map((artifact) => (
                  <li key={artifact.id} className="agent-artifact-card" data-artifact-type={artifact.type}>
                    <div className="agent-artifact-header"><strong>{artifact.label}</strong><span className="status-pill">{artifact.type}</span></div>
                    <p title={artifact.path}>{artifact.path}</p>
                    <div className="button-row">
                      <button data-testid="agent-artifact-open" onClick={() => onOpenArtifact(artifact.path)}>Open</button>
                      <button data-testid="agent-artifact-reveal" onClick={() => onRevealArtifact(artifact.path)}>Reveal</button>
                      <button data-testid="agent-artifact-copy" onClick={() => void navigator.clipboard?.writeText(artifact.path)}>Copy Path</button>
                      <button data-testid="agent-artifact-remove" onClick={() => onRemoveArtifact(artifact.id)}>Remove</button>
                    </div>
                    <small>{artifact.source} · {artifact.status || 'tracked'} · {new Date(artifact.createdAt).toLocaleString()}{artifact.runId ? ` · ${artifact.runId}` : ''}</small>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {!artifacts.length && <li className="agent-empty-row">No artifacts yet. Load a recording, run detection, export a report/workbook, or save a snapshot.</li>}
        {Boolean(artifacts.length) && !filteredArtifacts.length && <li className="agent-empty-row">No artifacts match the current type/search filters. Change the filter, clear search, or create that artifact type.</li>}
      </div>
    </div>
  );
});

function artifactTypeCounts(artifacts: AgentArtifact[]): Record<AgentArtifactFilter, number> {
  const counts = Object.fromEntries(AGENT_ARTIFACT_FILTERS.map((type) => [type, 0])) as Record<AgentArtifactFilter, number>;
  counts.all = artifacts.length;
  for (const artifact of artifacts) counts[artifact.type] = (counts[artifact.type] || 0) + 1;
  return counts;
}

function artifactFilterLabel(type: AgentArtifactFilter, count: number): string {
  return type === 'all' ? `All (${count})` : `${type} (${count})`;
}

function artifactMatchesSearch(artifact: AgentArtifact, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    artifact.label,
    artifact.path,
    artifact.type,
    artifact.source,
    artifact.status || '',
    artifact.runId || ''
  ].some((value) => value.toLowerCase().includes(query));
}

function groupArtifactsByRunOrProject(artifacts: AgentArtifact[]): Array<{ key: string; label: string; artifacts: AgentArtifact[] }> {
  const groups = new Map<string, AgentArtifact[]>();
  for (const artifact of artifacts) {
    const key = artifact.runId ? `run:${artifact.runId}` : `workspace:${artifact.source}`;
    groups.set(key, [...(groups.get(key) || []), artifact]);
  }
  return Array.from(groups.entries()).map(([key, rows]) => ({
    key,
    label: key.startsWith('run:') ? `Run ${key.slice(4)}` : workspaceArtifactGroupLabel(key.slice('workspace:'.length)),
    artifacts: rows
  }));
}

function workspaceArtifactGroupLabel(source: string): string {
  if (source === 'user') return 'Workspace inputs';
  if (source === 'electron-ui') return 'Workspace UI artifacts';
  if (source === 'backend') return 'Workspace outputs';
  if (source === 'agent') return 'Agent artifacts';
  return 'Workspace artifacts';
}

function loadPersistedArtifactCollapsedGroups(): Record<string, boolean> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_ARTIFACT_COLLAPSED_STORAGE_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => typeof key === 'string' && value === true).slice(0, 200)) as Record<string, boolean>;
  } catch {
    return {};
  }
}

function persistArtifactCollapsedGroups(groups: Record<string, boolean>) {
  if (typeof window === 'undefined') return;
  const collapsedOnly = Object.fromEntries(Object.entries(groups).filter(([, collapsed]) => collapsed).slice(0, 200));
  window.localStorage.setItem(AGENT_ARTIFACT_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedOnly));
}
