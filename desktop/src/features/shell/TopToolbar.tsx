import { useEffect, useRef } from 'react';
type TopToolbarProps = {
  projectLabel: string;
  projectDirty: boolean;
  onNewProject: () => void;
  onOpenProject: () => void;
  onSaveProject: () => void;
  onOpenRecording: () => void;
  onLoadDetection: () => void;
  onQuickDetection: () => void;
  onBatchProject: () => void;
  onWaveformShortcuts: () => void;
  onStatusLog: () => void;
};

type ToolbarIconName = 'openRecording' | 'openSession' | 'quickDetection' | 'shortcuts' | 'settings';

type ToolbarAction = {
  testId: string;
  pyqtAction?: string;
  icon: ToolbarIconName;
  label: string;
  title: string;
  ariaLabel: string;
  onClick: () => void;
};

export function TopToolbar({ projectLabel, projectDirty, onNewProject, onOpenProject, onSaveProject, onOpenRecording, onLoadDetection, onQuickDetection, onBatchProject, onWaveformShortcuts, onStatusLog }: TopToolbarProps) {
  // A <details> menu stays open until its own summary is clicked again, which is not how menus
  // behave anywhere else: clicking the workspace should dismiss it, and so should Escape.
  const settingsMenuRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      const menu = settingsMenuRef.current;
      if (!menu || !menu.open) return;
      if (event.target instanceof Node && menu.contains(event.target)) return;
      menu.open = false;
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      const menu = settingsMenuRef.current;
      if (menu?.open) menu.open = false;
    }
    window.addEventListener('pointerdown', closeFromOutside, true);
    window.addEventListener('keydown', closeFromEscape);
    return () => {
      window.removeEventListener('pointerdown', closeFromOutside, true);
      window.removeEventListener('keydown', closeFromEscape);
    };
  }, []);

  const toolbarActions: ToolbarAction[] = [
    { testId: 'pyqt-actionOpen_EDF_toolbar', pyqtAction: 'action_Open_EDF', icon: 'openRecording', label: 'Open', title: 'Open Recording', ariaLabel: 'Open Recording', onClick: onOpenRecording },
    { testId: 'pyqt-project_open_button', icon: 'openSession', label: 'Session', title: 'Open Project / Session', ariaLabel: 'Open Project or Session', onClick: onOpenProject },
    { testId: 'pyqt-actionQuick_Detection_toolbar', icon: 'quickDetection', label: 'Quick', title: 'Quick Detection', ariaLabel: 'Quick Detection', onClick: onQuickDetection },
    { testId: 'pyqt-actionWaveform_Shortcuts_toolbar', icon: 'shortcuts', label: 'Shortcuts', title: 'Waveform Shortcuts', ariaLabel: 'Waveform Shortcuts', onClick: onWaveformShortcuts },
  ];

  return (
    <header className="pyqt-top-toolbar" data-testid="pyqt-toolBar" aria-label="PyQt-compatible top toolbar">
      <div className="pyqt-menu-row">
        <details className="pyqt-settings-menu pyqt-toolbar-overflow" ref={settingsMenuRef}>
          <summary className="pyqt-menu-button" title="Settings" aria-label="Settings">
            <ToolbarIcon name="settings" />
            <span className="pyqt-toolbar-label">Settings</span>
          </summary>
          <div className="pyqt-toolbar-menu">
            <button data-testid="pyqt-project_new_button" onClick={onNewProject}>New Project</button>
            <button data-testid="pyqt-project_save_button" onClick={onSaveProject}>Save Project</button>
            <button data-testid="pyqt-actionLoad_Detection_toolbar" data-pyqt-action="action_Load_Detection" onClick={onLoadDetection}>Load Detection</button>
            <button data-testid="pyqt-actionBatch_Project_toolbar" onClick={onBatchProject}>Batch Project</button>
            <button data-testid="pyqt-actionStatus_Log_toolbar" onClick={onStatusLog}>Status Log</button>
          </div>
        </details>
        <span className="project-status-pill" data-testid="pyqt-project_status_label" data-dirty={projectDirty ? 'true' : 'false'} title={projectLabel}>{projectLabel}{projectDirty ? ' • unsaved' : ''}</span>
      </div>
      <div className="pyqt-toolbar-row">
        {toolbarActions.map((action) => (
          <button key={action.testId} className="pyqt-toolbar-action" data-testid={action.testId} data-pyqt-action={action.pyqtAction} onClick={action.onClick} title={action.title} aria-label={action.ariaLabel}>
            <ToolbarIcon name={action.icon} />
            <span className="pyqt-toolbar-label">{action.label}</span>
          </button>
        ))}
      </div>
    </header>
  );
}

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  return (
    <span className="pyqt-toolbar-icon" data-toolbar-icon={name} aria-hidden="true">
      <svg viewBox="0 0 20 20" focusable="false">
        {name === 'quickDetection' ? (
          <path d="M7 4.5v11l8-5.5-8-5.5Z" />
        ) : name === 'shortcuts' ? (
          <>
            <path d="M5 5.5h10" />
            <path d="M5 10h10" />
            <path d="M5 14.5h6.5" />
          </>
        ) : name === 'settings' ? (
          <>
            <circle cx="10" cy="10" r="4.3" />
            <circle cx="10" cy="10" r="1.6" />
            <path d="M10 3.7v2.3" />
            <path d="M10 14v2.3" />
            <path d="M3.7 10h2.3" />
            <path d="M14 10h2.3" />
            <path d="M12.8 7.2 14.5 5.5" />
            <path d="M7.2 7.2 5.5 5.5" />
            <path d="M12.8 12.8 14.5 14.5" />
            <path d="M7.2 12.8 5.5 14.5" />
          </>
        ) : (
          <>
            <path d="M3.5 7.5h13v9h-13Z" />
            <path d="M3.5 7.5V5h5l1.6 2.5" />
            {name === 'openSession' ? <path d="M6 10h8M6 12.5h6" /> : <path d="M7.5 11.5h5M10 9v5" />}
          </>
        )}
      </svg>
    </span>
  );
}
