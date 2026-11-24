import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { AgentPanelTab } from '../../app/workspaceState';

const tabs: Array<{ id: AgentPanelTab; label: string; tooltip: string }> = [
  { id: 'Chat', label: 'Chat', tooltip: 'Chat transcript and prompt composer' },
  { id: 'Actions', label: 'Actions', tooltip: 'Action trace, staged commands, and runtime log' },
  { id: 'Artifacts', label: 'Artifacts', tooltip: 'Artifacts, reports, snapshots, and exports' },
  { id: 'Safety', label: 'Safety/Context', tooltip: 'Safety, context, and clinical-boundary checks' }
];

// Crisp line icons (Feather geometry) drawn with currentColor so each glyph
// inherits the activity-bar button state (muted when idle, white when active).
const ACTIVITY_ICONS: Record<AgentPanelTab, ReactNode> = {
  Chat: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  Actions: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  ),
  Artifacts: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  ),
  Safety: (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  )
};
const AGENT_ACTIVITY_BUTTON_IDS: Record<AgentPanelTab, string> = {
  Chat: 'agent-activity-chat-control',
  Actions: 'agent-activity-actions-control',
  Artifacts: 'agent-activity-artifacts-control',
  Safety: 'agent-activity-safety-control'
};

export function AgentActivityBar({ activeTab, isOpen, onOpenTab }: { activeTab: AgentPanelTab; isOpen: boolean; onOpenTab: (tab: AgentPanelTab) => void }) {
  function handleActivityKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, tab: AgentPanelTab) {
    const currentIndex = tabs.findIndex((item) => item.id === tab);
    let nextTab: AgentPanelTab | null = null;
    if (event.key === 'ArrowDown') nextTab = tabs[(currentIndex + 1) % tabs.length].id;
    else if (event.key === 'ArrowUp') nextTab = tabs[(currentIndex - 1 + tabs.length) % tabs.length].id;
    else if (event.key === 'Home') nextTab = tabs[0].id;
    else if (event.key === 'End') nextTab = tabs[tabs.length - 1].id;
    if (!nextTab) return;
    event.preventDefault();
    onOpenTab(nextTab);
    requestAnimationFrame(() => document.getElementById(AGENT_ACTIVITY_BUTTON_IDS[nextTab])?.focus());
  }

  return (
    <aside className="agent-activity-bar" data-testid="agent-activity-bar" aria-label="VS Code-like Agent activity bar" role="toolbar" aria-orientation="vertical" data-open={isOpen ? 'true' : 'false'}>
      {tabs.map((tab) => (
        <button key={tab.id} id={AGENT_ACTIVITY_BUTTON_IDS[tab.id]} className={activeTab === tab.id && isOpen ? 'active' : ''} title={tab.tooltip} aria-label={`Open Agent ${tab.label}`} aria-pressed={activeTab === tab.id && isOpen} aria-controls={`agent-panel-${tab.id.toLowerCase()}-tabpanel`} data-agent-activity-tab={tab.id} data-testid={`agent-activity-${tab.id.toLowerCase()}`} onClick={() => onOpenTab(tab.id)} onKeyDown={(event) => handleActivityKeyDown(event, tab.id)}>
          <span className="activity-icon" aria-hidden="true">{ACTIVITY_ICONS[tab.id]}</span>
          <span className="activity-label">{tab.label}</span>
        </button>
      ))}
    </aside>
  );
}
