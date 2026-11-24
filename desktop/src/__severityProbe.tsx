// Dev-only probe used by scripts/severity-ui-render.mjs to mount the real SeverityTab in a
// browser and screenshot it. It lives under src/ so Vite resolves its bare imports (a raw
// import('react') from page.evaluate does not go through Vite's resolver). Not referenced by
// the app; safe to delete.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SeverityTab, type SeverityRunState } from './features/shell/SeverityTab';
import type { RecordingMetadata } from './app/workspaceState';

// Same component, mounted in the rail's real ancestry (shell -> right sidebar -> severity card) at
// rail width, because that context is what the rail-specific overrides key off.
export function mountSeverityInRail(hostId: string, state: SeverityRunState, railWidth = 255) {
  document.body.innerHTML = '';
  document.body.style.background = '#f4f7f8';
  const shell = document.createElement('section');
  shell.className = 'pyqt-workspace-shell';
  shell.setAttribute('data-loaded', 'true');
  shell.setAttribute('data-active-workflow-tab', 'waveform');
  const rail = document.createElement('aside');
  rail.className = 'waveform-right-sidebar';
  rail.style.inlineSize = `${railWidth}px`;
  const card = document.createElement('section');
  card.id = hostId;
  card.className = 'pyqt-sidebar-card sidebar-severity-card';
  rail.appendChild(card);
  shell.appendChild(rail);
  document.body.appendChild(shell);
  const metadata: RecordingMetadata = { channel_names: ['FP1'], eeg_type: 'scalp' };
  createRoot(card).render(
    createElement(SeverityTab, { metadata, hasRecording: true, state, onRunSeverityScoring: () => {}, onCancelSeverityScoring: () => {}, onSeekToSeconds: () => {} })
  );
  return new Promise<void>((resolve) => setTimeout(resolve, 800));
}

export function mountSeverity(hostId: string, state: SeverityRunState, hasRecording = true) {
  document.body.innerHTML = '';
  document.body.style.background = '#f4f7f8';
  const host = document.createElement('div');
  host.id = hostId;
  host.className = 'workspace-tab-panel';
  host.setAttribute('data-active-tab', 'Severity');
  document.body.appendChild(host);
  const metadata: RecordingMetadata = { channel_names: ['FP1'], eeg_type: 'scalp' };
  createRoot(host).render(
    createElement(SeverityTab, { metadata, hasRecording, state, onRunSeverityScoring: () => {} })
  );
  return new Promise<void>((resolve) => setTimeout(resolve, 800));
}
