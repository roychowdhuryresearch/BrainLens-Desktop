import { useEffect, useMemo, useState } from 'react';
import type { RuntimeLogEntry, RuntimeOperation } from '../../app/workspaceState';
import { backendClient } from '../../api/backendClient';

type RuntimeLogLevel = RuntimeLogEntry['level'] | 'all';
type BackendHealthSnapshot = { status: string; backend: string; baseUrl: string; logs: string[]; raw: Record<string, unknown> | null };

export function RuntimeLogDialog({ operation, log, error, statusMessage, onCancel, onClose }: { operation: RuntimeOperation; log: RuntimeLogEntry[]; error: string | null; statusMessage: string; onCancel: () => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<RuntimeLogLevel>('all');
  const [backendHealth, setBackendHealth] = useState<BackendHealthSnapshot>({ status: 'checking', backend: '--', baseUrl: '--', logs: [], raw: null });
  const [backendHealthMessage, setBackendHealthMessage] = useState('Checking compute service...');
  const filteredLog = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return log.filter((entry) => {
      const levelMatches = level === 'all' || entry.level === level;
      const queryMatches = !needle || `${entry.timestamp} ${entry.level} ${entry.operationId || ''} ${entry.message}`.toLowerCase().includes(needle);
      return levelMatches && queryMatches;
    });
  }, [level, log, query]);
  const isRunning = operation.status === 'running' || operation.status === 'cancel_requested';

  useEffect(() => {
    void refreshBackendHealth();
  }, []);

  async function refreshBackendHealth() {
    setBackendHealthMessage('Checking compute service...');
    try {
      const snapshot = normalizeBackendHealth(await backendClient.health());
      setBackendHealth(snapshot);
      setBackendHealthMessage(`Compute service ${snapshot.status}${snapshot.baseUrl !== '--' ? ` at ${snapshot.baseUrl}` : ''}`);
    } catch (err) {
      setBackendHealth({ status: 'unavailable', backend: 'PyHFO service', baseUrl: '--', logs: [err instanceof Error ? err.message : String(err)], raw: null });
      setBackendHealthMessage(`Compute service check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal-card runtime-log-dialog" role="dialog" aria-modal="true" aria-labelledby="runtime-log-title" data-testid="pyqt-status_log_dialog">
        <header className="runtime-log-header">
          <div>
            <h2 id="runtime-log-title">Status and activity</h2>
            <p className="helper-copy">Searchable runtime history for long-running analysis tasks.</p>
          </div>
          <button className="modal-window-close-button" data-testid="pyqt-runtime_log_close_button" onClick={onClose}>Close</button>
        </header>
        <section className="panel-card runtime-log-summary" data-testid="pyqt-runtime_log_summary" data-runtime-status={operation.status}>
          <div><strong>Workflow</strong><span>{operation.label}</span></div>
          <div><strong>Status</strong><span>{operation.status}</span></div>
          <div><strong>Progress</strong><progress data-testid="pyqt-runtime_log_progress_bar" max={100} value={operation.indeterminate ? undefined : Math.max(0, Math.min(100, operation.progress || 0))} /></div>
          <div><strong>Kind</strong><span>{operation.kind}</span></div>
          <div><strong>Started</strong><span>{formatTimestamp(operation.startedAt)}</span></div>
          <div><strong>Finished</strong><span>{formatTimestamp(operation.finishedAt)}</span></div>
          {error && <p className="runtime-log-error" data-testid="pyqt-runtime_log_error">{error}</p>}
          <p className="runtime-log-status-text" data-testid="pyqt-runtime_log_status_text">{error || statusMessage}</p>
          <button data-testid="pyqt-runtime_log_cancel_button" disabled={!isRunning || operation.cancellable === false} onClick={onCancel}>Cancel current task</button>
        </section>
        <section className="runtime-log-toolbar" aria-label="Runtime log filters">
          <label>Search
            <input data-testid="pyqt-runtime_log_search_input" value={query} placeholder="Filter by message, time, or operation" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label>Level
            <select data-testid="pyqt-runtime_log_level_filter" value={level} onChange={(event) => setLevel(event.target.value as RuntimeLogLevel)}>
              <option value="all">All</option>
              <option value="info">Info</option>
              <option value="success">Success</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
          </label>
        </section>
        <section className="panel-card runtime-backend-health" data-testid="pyqt-backend_health_card" data-backend-status={backendHealth.status}>
          <div><strong>Compute</strong><span data-testid="pyqt-backend_health_backend">{backendHealth.backend}</span></div>
          <div><strong>Status</strong><span data-testid="pyqt-backend_health_status">{backendHealth.status}</span></div>
          <div><strong>Base URL</strong><span data-testid="pyqt-backend_health_base_url">{backendHealth.baseUrl}</span></div>
          <button data-testid="pyqt-backend_health_refresh_button" onClick={refreshBackendHealth}>Refresh Service Health</button>
          <p data-testid="pyqt-backend_health_message">{backendHealthMessage}</p>
        </section>
        <section className="runtime-log-table-shell runtime-backend-log-shell">
          <table className="data-table runtime-log-table" data-testid="pyqt-backend_log_table">
            <thead><tr><th>#</th><th>Service log line</th></tr></thead>
            <tbody>
              {backendHealth.logs.map((line, index) => <tr key={`${index}-${line}`} data-testid="pyqt-backend_log_row"><td>{index + 1}</td><td>{line}</td></tr>)}
              {!backendHealth.logs.length && <tr><td colSpan={2} data-testid="pyqt-backend_log_empty">No service log lines are available.</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="runtime-log-table-shell runtime-ui-log-shell">
          <table className="data-table runtime-log-table" data-testid="pyqt-runtime_log_table">
            <thead><tr><th>Time</th><th>Level</th><th>Operation</th><th>Message</th></tr></thead>
            <tbody>
              {filteredLog.map((entry) => (
                <tr key={entry.id} data-testid="pyqt-runtime_log_row" data-level={entry.level}>
                  <td>{formatTimestamp(entry.timestamp)}</td>
                  <td>{entry.level}</td>
                  <td>{entry.operationId || '--'}</td>
                  <td>{entry.message}</td>
                </tr>
              ))}
              {!filteredLog.length && <tr><td colSpan={4} data-testid="pyqt-runtime_log_empty">No runtime log entries match the current filters.</td></tr>}
            </tbody>
          </table>
        </section>
      </section>
    </div>
  );
}

function normalizeBackendHealth(value: unknown): BackendHealthSnapshot {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const logs = Array.isArray(record.logs) ? record.logs.map((line) => String(line)).slice(-100) : [];
  return {
    status: typeof record.status === 'string' ? record.status : typeof record.ok === 'boolean' ? record.ok ? 'healthy' : 'unhealthy' : 'unknown',
    backend: typeof record.backend === 'string' ? record.backend : 'PyHFO service',
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : '--',
    logs,
    raw: Object.keys(record).length ? record : null
  };
}

function formatTimestamp(value?: string): string {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}
