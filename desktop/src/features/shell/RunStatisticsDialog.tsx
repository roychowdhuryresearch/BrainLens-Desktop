import { useMemo, useState } from 'react';
import type { CandidateChannelRanking, ReviewEvent, RunRecord, RuntimeLogEntry } from '../../app/workspaceState';
import { candidateChannelRankingRows, runOverlapRows } from '../../app/workspaceState';

type ConsensusStrategy = 'union' | 'majority' | 'intersection';

export function RunStatisticsDialog({ runRecords, activeRunId, acceptedRunId, visibleRunIds, reviewEvents, runEventsByRun, candidateRanking, runtimeLog, onActivateRun, onToggleRunVisible, onAcceptRun, onCreateConsensusRun, onExportWorkbook, onExportReport, onClose }: { runRecords: RunRecord[]; activeRunId: string | null; acceptedRunId: string | null; visibleRunIds: string[]; reviewEvents: ReviewEvent[]; runEventsByRun: Record<string, ReviewEvent[]>; candidateRanking?: CandidateChannelRanking | null; runtimeLog: RuntimeLogEntry[]; onActivateRun: (runId: string) => void; onToggleRunVisible: (runId: string, visible: boolean) => void; onAcceptRun: (runId: string) => void; onCreateConsensusRun: (strategy: ConsensusStrategy) => void; onExportWorkbook: (runId?: string) => Promise<void> | void; onExportReport: (runId?: string) => Promise<void> | void; onDeferredAction: (action: string) => void; onClose: () => void }) {
  const [selectedRunId, setSelectedRunId] = useState(activeRunId || runRecords[0]?.runId || '');
  const [consensusStrategy, setConsensusStrategy] = useState<ConsensusStrategy>('majority');
  const selectedRun = runRecords.find((run) => run.runId === selectedRunId) || null;
  const activeRun = runRecords.find((run) => run.runId === activeRunId) || null;
  const channelRanking = useMemo(() => candidateChannelRankingRows(candidateRanking, reviewEvents).slice(0, 12), [candidateRanking, reviewEvents]);
  const comparisonRows = useMemo(() => runOverlapRows(runRecords, runEventsByRun, reviewEvents, activeRunId, visibleRunIds).slice(0, 10), [runRecords, runEventsByRun, reviewEvents, activeRunId, visibleRunIds]);
  const reviewed = reviewEvents.filter((event) => event.annotation).length;
  const artifactEntries = Object.entries(selectedRun?.parameters || {}).filter(([key]) => key.includes('output') || key.includes('path') || key.includes('warnings'));
  // The Consensus handler requires >=2 VISIBLE, NON-consensus source runs; gate the button
  // on that same predicate (not just runRecords.length) so it isn't enabled when hiding a
  // run leaves fewer than two eligible sources.
  const eligibleConsensusSources = runRecords.filter(
    (run) => visibleRunIds.includes(run.runId)
      && !(run.detector.toLowerCase().startsWith('consensus') || Boolean(run.parameters?.consensus_strategy)),
  ).length;

  return (
    <div className="modal-backdrop" role="presentation" data-testid="pyqt-run_stats_dialog">
      <section className="modal-card run-statistics-dialog" data-testid="pyqt-statistics_box" role="dialog" aria-modal="true" aria-labelledby="run-statistics-title">
        <header className="event-review-header">
          <div>
            <h2 id="run-statistics-title">{activeRun?.biomarker || 'Case'} Run Statistics</h2>
            <p className="helper-copy">Run management, detector agreement, channel ranking, review progress, and exports.</p>
          </div>
          <button className="modal-window-close-button" data-testid="pyqt-run_stats_close_button" onClick={onClose}>Close</button>
        </header>

        <div className="button-row" data-testid="pyqt-run_stats_action_row">
          <button data-testid="pyqt-run_stats_activate_button" disabled={!selectedRun} onClick={() => selectedRun && onActivateRun(selectedRun.runId)}>Activate Selected</button>
          <button data-testid="pyqt-run_stats_accept_button" disabled={!selectedRun} onClick={() => selectedRun && onAcceptRun(selectedRun.runId)}>Accept Selected</button>
          <label className="inline-field">Consensus strategy<select aria-label="Consensus strategy" data-testid="pyqt-run_stats_consensus_strategy_combo" value={consensusStrategy} onChange={(event) => setConsensusStrategy(event.target.value as ConsensusStrategy)}><option value="majority">Majority</option><option value="union">Union</option><option value="intersection">Intersection</option></select></label>
          <button data-testid="pyqt-run_stats_consensus_button" disabled={eligibleConsensusSources < 2} onClick={() => onCreateConsensusRun(consensusStrategy)}>Consensus</button>
          <button data-testid="pyqt-run_stats_export_button" disabled={!selectedRun} onClick={() => selectedRun && onExportWorkbook(selectedRun.runId)}>Export Workbook</button>
          <button data-testid="pyqt-run_stats_report_button" disabled={!selectedRun} onClick={() => selectedRun && onExportReport(selectedRun.runId)}>Export Report</button>
        </div>

        <section className="run-statistics-body">
          <section className="panel-card run-statistics-management" data-testid="pyqt-run_stats_management_group">
            <h3>Runs in Session</h3>
            <table className="data-table" data-testid="pyqt-run_stats_run_table">
              <thead><tr><th>Show</th><th>Select</th><th>Detector</th><th>Events</th><th>Channels</th><th>Status</th><th>Classifier</th></tr></thead>
              <tbody>
                {runRecords.map((run) => (
                  <tr key={run.runId} className={run.runId === activeRunId ? 'selected' : ''}>
                    <td><input data-testid="pyqt-run_stats_visible_checkbox" aria-label={`Show ${run.detector}`} type="checkbox" checked={visibleRunIds.includes(run.runId)} onChange={(event) => onToggleRunVisible(run.runId, event.target.checked)} /></td>
                    <td><input aria-label={`Select ${run.detector}`} type="radio" checked={selectedRunId === run.runId} onChange={() => setSelectedRunId(run.runId)} /></td>
                    <td>{run.detector}</td><td>{run.events}</td><td>{run.channels}</td><td>{runStatus(run, activeRunId, acceptedRunId, visibleRunIds)}</td><td>{run.classifier || '--'}</td>
                  </tr>
                ))}
                {!runRecords.length && <tr><td colSpan={7}>Create a run first to open run statistics.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel-card" data-testid="pyqt-run_stats_summary">
            <h3>Review Progress</h3>
            <dl className="run-progress-grid">
              <div><dt>Total events</dt><dd>{reviewEvents.length}</dd></div>
              <div><dt>Reviewed</dt><dd>{reviewed}</dd></div>
              <div><dt>Pending</dt><dd>{Math.max(0, reviewEvents.length - reviewed)}</dd></div>
              <div><dt>Visible runs</dt><dd>{visibleRunIds.length}</dd></div>
              <div><dt>Accepted</dt><dd>{acceptedRunId || '--'}</dd></div>
            </dl>
            <h3>Artifacts</h3>
            {artifactEntries.length ? (
              <dl className="recording-info-grid">
                {artifactEntries.flatMap(([key, value]) => [<dt key={`${key}-dt`}>{key}</dt>, <dd key={`${key}-dd`}>{String(value || '--')}</dd>])}
              </dl>
            ) : (
              <p className="run-artifacts-empty">No artifacts recorded.</p>
            )}
          </section>

          <section className="panel-card" data-testid="pyqt-run_stats_channel_ranking">
            <h3>Channel Ranking</h3>
            <table className="data-table">
              {candidateRanking?.interpretation_policy && <caption data-testid="pyqt-run_stats_backend_ranking_policy">Detector artifact ranking · {candidateRanking.interpretation_policy}</caption>}
              <thead><tr><th>Channel</th><th>Accepted</th><th>Total</th><th>Priority</th></tr></thead>
              <tbody>
                {channelRanking.map((row) => <tr key={row.channel} data-testid="pyqt-run_stats_channel_row"><td>{row.channel}</td><td>{row.accepted}</td><td>{row.total}</td><td>{row.priority}</td></tr>)}
                {!channelRanking.length && <tr><td colSpan={4}>No event rows available.</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel-card" data-testid="pyqt-run_stats_comparison_table">
            <h3>Run Overlap</h3>
            <table className="data-table comparison-table" data-testid="pyqt-run_stats_comparison_table_grid">
              <thead><tr><th>Left</th><th>Right</th><th>Overlap</th><th>Only</th><th>Jaccard</th></tr></thead>
              <tbody>
                {comparisonRows.map((row) => <tr key={`${row.leftRunId}-${row.rightRunId}`} data-testid="pyqt-run_stats_comparison_row" data-jaccard-high={row.jaccard >= 0.5 ? 'true' : 'false'}><td>{row.leftLabel}</td><td>{row.rightLabel}</td><td>{row.overlap}</td><td>{row.leftOnly}/{row.rightOnly}</td><td>{row.jaccard.toFixed(2)}</td></tr>)}
                {!comparisonRows.length && <tr><td colSpan={5}>Run overlap</td></tr>}
              </tbody>
            </table>
          </section>

          <section className="panel-card" data-testid="pyqt-run_stats_runtime_tail">
            <h3>Runtime Tail</h3>
            <ol className="runtime-log-list">
              {[...runtimeLog].slice(-6).reverse().map((entry) => <li key={entry.id} className={`runtime-log-${entry.level}`}><time>{entry.timestamp.slice(11, 19)}</time><span>{entry.message}</span></li>)}
            </ol>
          </section>
        </section>
      </section>
    </div>
  );
}

function runStatus(run: RunRecord, activeRunId: string | null, acceptedRunId: string | null, visibleRunIds: string[]): string {
  const status = [];
  if (run.runId === activeRunId) status.push('Active');
  if (run.runId === acceptedRunId) status.push('Accepted');
  if (!visibleRunIds.includes(run.runId)) status.push('Hidden');
  // Title-case the raw backend fallback so 'complete'/'not run' don't sit lowercase
  // next to the title-cased 'Active, Accepted' states in the same column.
  const fallback = run.status ? run.status.charAt(0).toUpperCase() + run.status.slice(1) : 'Stored';
  return status.join(', ') || fallback;
}
