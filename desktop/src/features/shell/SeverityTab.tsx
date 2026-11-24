import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import type { RecordingMetadata, SeverityScoringResult, SeveritySegmentScore } from '../../app/workspaceState';
import {
  SEVERITY_BUCKET_COLORS,
  SEVERITY_BUCKET_LABELS,
  SEVERITY_SCORE_MAX,
  formatSeverityScore,
  recordingEegType,
  severityBucket,
  severityRankedSegments
} from '../../app/workspaceState';

export type SeverityRunState = {
  status: 'idle' | 'running' | 'complete' | 'failed';
  result: SeverityScoringResult | null;
  error: string | null;
  // Read back off the backend's own tqdm output while a run is in flight; null until the first
  // batch reports. A run over a long recording takes many minutes, so a bare spinner reads as a
  // hang.
  progress?: { percent: number; done: number; total: number; etaSeconds?: number | null } | null;
};

export const DEFAULT_SEVERITY_STATE: SeverityRunState = { status: 'idle', result: null, error: null, progress: null };

export function SeverityTab({
  metadata,
  hasRecording,
  state,
  onRunSeverityScoring,
  onCancelSeverityScoring,
  onSeekToSeconds
}: {
  metadata: RecordingMetadata | null;
  hasRecording: boolean;
  state: SeverityRunState;
  onRunSeverityScoring: () => Promise<unknown> | void;
  // Optional so the component still renders in probes; when present, a run can be stopped.
  onCancelSeverityScoring?: () => Promise<unknown> | void;
  // Moves the waveform viewport. Optional so the component still renders in probes and previews
  // that have no waveform to drive.
  onSeekToSeconds?: (startSeconds: number) => void;
}) {
  const result = state.result;
  const scores = useMemo(() => result?.scores || [], [result]);
  const eegType = recordingEegType(metadata);
  const running = state.status === 'running';
  const runDisabled = !hasRecording || running;
  // Headline numbers exclude artifact segments, as the PyQt app's did: a 3000 uV movement burst
  // would otherwise set the peak and pull the mean. The all-segment values stay in the payload.
  const excludedSegments = Math.max(0, (result?.num_segments || 0) - (result?.num_clean_segments ?? result?.num_segments ?? 0));
  const artifactAssessmentComplete = result?.artifact_quality?.status === 'assessed';
  const hasCleanSummary = artifactAssessmentComplete && Number(result?.num_clean_segments || 0) > 0;
  const meanScore = hasCleanSummary ? result?.clean_mean_score : result?.mean_score;
  const peakScore = hasCleanSummary ? result?.clean_peak_score : result?.peak_score;
  const peakTimeSec = hasCleanSummary ? result?.clean_peak_time_sec : result?.peak_time_sec;
  const meanBucket = severityBucket(meanScore ?? null);
  const peakBucket = severityBucket(peakScore ?? null);

  return (
    <div className="tab-content severity-layout" data-testid="workflow-severity-content">
      <header className="workflow-panel-heading severity-panel-heading">
        <h3>Severity</h3>
        {eegType && <span className="status-pill" data-testid="severity-eeg-type">{eegType === 'scalp' ? 'Scalp EEG' : eegType}</span>}
      </header>

      <div className="severity-workbench-grid">
        <section className="panel-card severity-run-card" data-testid="severity-run-card">
          <div className="severity-run-row">
            <div className="severity-run-copy">
              <h4>Whole-recording severity score</h4>
              <p className="helper-copy">
                Scores the recording in consecutive 15-second segments on a 0–{SEVERITY_SCORE_MAX} scale
                (0 = benign, {SEVERITY_SCORE_MAX} = severe) using the BASED model. Signal-derived research
                output — not a clinical severity diagnosis.
              </p>
            </div>
            <button
              className="primary-action"
              data-testid="severity-run-button"
              disabled={runDisabled}
              aria-disabled={runDisabled}
              onClick={() => onRunSeverityScoring()}
            >
              {running ? (state.progress ? `Scoring… ${state.progress.percent}%` : 'Scoring…') : 'Run severity scoring'}
            </button>
          </div>
          {running && state.progress && (
            <p className="helper-copy" data-testid="severity-progress">
              Scored {state.progress.done} of {state.progress.total} segments ({state.progress.percent}%)
              {typeof state.progress.etaSeconds === 'number' && state.progress.etaSeconds > 0
                ? ` · about ${formatDuration(state.progress.etaSeconds)} left`
                : ''}.
            </p>
          )}
          {running && onCancelSeverityScoring && (
            <button className="severity-cancel" data-testid="severity-cancel-button" onClick={() => onCancelSeverityScoring()}>
              Cancel scoring
            </button>
          )}
          {!hasRecording && <p className="helper-copy" data-testid="severity-no-recording-hint">Load a scalp EEG recording to run severity scoring.</p>}
          {state.error && <p className="error-panel" data-testid="severity-error">{state.error}</p>}
          {(result?.warnings || []).map((warning) => (
            <p className="helper-copy severity-warning" data-testid="severity-warning" key={warning}>{warning}</p>
          ))}
          {result && !artifactAssessmentComplete && (
            <p className="helper-copy severity-warning" data-testid="severity-artifact-quality-warning">
              Artifact screening is {result.artifact_quality?.status || 'unavailable'}; summary values below are raw all-segment scores, not artifact-excluded clean scores.
            </p>
          )}
        </section>

        <section className="panel-card severity-summary-card" data-testid="severity-summary-card">
          <h4>Summary</h4>
          <div className="severity-stat-row">
            <SeverityStat
              label={hasCleanSummary ? 'Mean score' : 'Raw mean score'}
              value={formatSeverityScore(meanScore)}
              bucket={meanBucket ? SEVERITY_BUCKET_LABELS[meanBucket] : null}
              color={meanBucket ? SEVERITY_BUCKET_COLORS[meanBucket] : null}
              testId="severity-stat-mean"
            />
            <SeverityStat
              label={hasCleanSummary ? 'Peak score' : 'Raw peak score'}
              value={formatSeverityScore(peakScore)}
              bucket={peakBucket ? SEVERITY_BUCKET_LABELS[peakBucket] : null}
              color={peakBucket ? SEVERITY_BUCKET_COLORS[peakBucket] : null}
              testId="severity-stat-peak"
            />
            <SeverityStat
              label="Peak at"
              value={peakTimeSec !== null && peakTimeSec !== undefined ? formatClock(peakTimeSec) : '—'}
              bucket={null}
              color={null}
              testId="severity-stat-peak-time"
              // The one timestamp a reader always wants to see for themselves, so it is the
              // shortest path to it -- no need to go via the navigator for rank 1.
              onJump={onSeekToSeconds && Number.isFinite(Number(peakTimeSec))
                ? () => onSeekToSeconds(Number(peakTimeSec))
                : undefined}
            />
          </div>
          {excludedSegments > 0 && (
            <p className="helper-copy" data-testid="severity-artifact-note">
              {`Excludes ${excludedSegments} artifact segment(s) over ${result?.artifact_threshold_uv ?? 1000} µV.`}
            </p>
          )}
          <SeverityLegend />
        </section>

        {onSeekToSeconds && result && (
          <SeverityNavigator result={result} onSeekToSeconds={onSeekToSeconds} />
        )}

        <section className="panel-card severity-histogram-card" data-testid="severity-histogram-card">
          <h4>Score distribution</h4>
          {scores.length > 0 ? (
            <SeverityDistribution scores={scores} />
          ) : (
            <p className="helper-copy" data-testid="severity-histogram-empty">
              {running ? 'Scoring in progress…' : 'Run severity scoring to see the score distribution.'}
            </p>
          )}
          {scores.length > 0 && <SeverityScoreTable scores={scores} />}
        </section>
      </div>
    </div>
  );
}

// The PyQt app's severity navigation: jump straight to the worst segment, then walk the ranking
// with prev/next or pick the k-th most severe outright. Ranking skips artifact segments, so the
// list is of moments worth reading rather than of the largest voltages in the file.
function SeverityNavigator({ result, onSeekToSeconds }: { result: SeverityScoringResult; onSeekToSeconds: (startSeconds: number) => void }) {
  const ranked = useMemo(() => severityRankedSegments(result), [result]);
  const [rank, setRank] = useState(0);
  const excluded = (result.num_segments || 0) - (result.num_clean_segments ?? result.num_segments ?? 0);
  if (!ranked.length) return null;
  const current = ranked[Math.min(rank, ranked.length - 1)];

  function goTo(nextRank: number) {
    const clamped = Math.max(0, Math.min(ranked.length - 1, nextRank));
    setRank(clamped);
    onSeekToSeconds(Number(ranked[clamped].start_sec) || 0);
  }

  return (
    <section className="panel-card severity-nav-card" data-testid="severity-nav-card">
      <h4>Jump to severe segments</h4>
      <div className="severity-nav-row">
        <button className="primary-action" data-testid="severity-nav-most-severe" onClick={() => goTo(0)}>
          Most severe
        </button>
        <button data-testid="severity-nav-prev" disabled={rank <= 0} onClick={() => goTo(rank - 1)} title="More severe segment">Prev</button>
        <button data-testid="severity-nav-next" disabled={rank >= ranked.length - 1} onClick={() => goTo(rank + 1)} title="Less severe segment">Next</button>
      </div>
      <label className="severity-nav-select">
        <span>Rank</span>
        <select
          data-testid="severity-nav-rank-select"
          value={Math.min(rank, ranked.length - 1)}
          onChange={(event) => goTo(Number(event.target.value))}
        >
          {ranked.slice(0, 200).map((segment, index) => (
            <option key={segment.segment_idx} value={index}>
              {`Top ${index + 1} — ${formatSeverityScore(segment.score)} at ${formatClock(segment.start_sec)}`}
            </option>
          ))}
        </select>
      </label>
      <p className="helper-copy" data-testid="severity-nav-status">
        {`Rank ${Math.min(rank, ranked.length - 1) + 1} of ${ranked.length} — score ${formatSeverityScore(current.score)} at ${formatClock(current.start_sec)}.`}
        {excluded > 0 ? ` ${excluded} segment(s) excluded as artifact (over ${result.artifact_threshold_uv ?? 1000} µV).` : ''}
      </p>
    </section>
  );
}

function SeverityStat({ label, value, bucket, color, testId, onJump }: { label: string; value: string; bucket: string | null; color: string | null; testId: string; onJump?: () => void }) {
  // The whole card is the hit target when it can jump, rather than a link inside it: the stat
  // cards already read as pills, so lighting one up on hover is the affordance -- an underlined
  // number in the middle of a stats row just looks like stray markup.
  return (
    <article
      className="severity-stat"
      data-testid={testId}
      data-jump={onJump ? 'true' : undefined}
      role={onJump ? 'button' : undefined}
      tabIndex={onJump ? 0 : undefined}
      aria-label={onJump ? `Jump the waveform to ${value}` : undefined}
      title={onJump ? 'Jump the waveform to this time' : undefined}
      onClick={onJump}
      onKeyDown={onJump ? (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onJump();
      } : undefined}
    >
      <h5>{label}</h5>
      <p className="severity-stat-value">{value}</p>
      {bucket && (
        <span className="severity-stat-bucket">
          <i className="severity-swatch" style={{ background: color || 'transparent' }} aria-hidden="true" />
          {bucket}
        </span>
      )}
    </article>
  );
}

// Identity is never colour-alone: every ramp step ships with its text label here, and the
// timeline pairs colour with an axis plus a per-segment tooltip.
function SeverityLegend() {
  const buckets: Array<keyof typeof SEVERITY_BUCKET_LABELS> = ['minimal', 'mild', 'moderate', 'severe'];
  return (
    <div className="severity-legend" data-testid="severity-legend" aria-label="Severity score ranges">
      {buckets.map((bucket) => (
        <span className="severity-legend-item" key={bucket}>
          <i className="severity-swatch" style={{ background: SEVERITY_BUCKET_COLORS[bucket] }} aria-hidden="true" />
          {SEVERITY_BUCKET_LABELS[bucket]}
        </span>
      ))}
    </div>
  );
}

// Twenty bins across the 0-SEVERITY_SCORE_MAX scale, matching the PyQt app's distribution plot.
// The shape of a recording's scores is what this answers -- mostly benign with a few severe
// windows, or uniformly bad? Where those windows fall in time is the mini plot's job.
const SEVERITY_HISTOGRAM_BINS = 20;
// Bar geometry, kept in sync with severity-histogram.css: a 2px surface gap between fills and a 3px
// floor below which a bar is not a readable mark. In the ~175px rail track, 20 bins plus their gaps
// still clear that floor; much narrower than that they would not, so the bin count drops.
const HISTOGRAM_COLUMN_GAP = 2;
const HISTOGRAM_MIN_BAR = 3;

type HistogramBin = { index: number; from: number; to: number; count: number };

function histogramBinCount(plotWidth: number): number {
  if (!plotWidth) return SEVERITY_HISTOGRAM_BINS;
  const fits = Math.floor((plotWidth + HISTOGRAM_COLUMN_GAP) / (HISTOGRAM_MIN_BAR + HISTOGRAM_COLUMN_GAP));
  return fits >= SEVERITY_HISTOGRAM_BINS ? SEVERITY_HISTOGRAM_BINS : Math.max(5, fits);
}

function severityHistogram(scores: SeveritySegmentScore[], bins: number): HistogramBin[] {
  const width = SEVERITY_SCORE_MAX / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const segment of scores) {
    const score = Number(segment.score);
    if (!Number.isFinite(score)) continue;
    // The top of the scale belongs to the last bin rather than falling off the end.
    const index = Math.min(bins - 1, Math.max(0, Math.floor(score / width)));
    counts[index] += 1;
  }
  return counts.map((count, index) => ({ index, count, from: index * width, to: (index + 1) * width }));
}

function SeverityDistribution({ scores }: { scores: SeveritySegmentScore[] }) {
  const [hovered, setHovered] = useState<HistogramBin | null>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = useState(0);
  useLayoutEffect(() => {
    const element = barsRef.current;
    if (!element) return;
    const measure = () => setPlotWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Artifact segments are excluded here for the same reason they are excluded from the mean and
  // peak: their scores describe movement, not the EEG.
  const clean = useMemo(() => {
    const kept = scores.filter((segment) => !segment.artifact);
    return kept.length ? kept : scores;
  }, [scores]);
  const bins = useMemo(() => severityHistogram(clean, histogramBinCount(plotWidth)), [clean, plotWidth]);
  const peakCount = Math.max(1, ...bins.map((bin) => bin.count));
  const excluded = scores.length - clean.length;

  return (
    <div className="severity-histogram" data-testid="severity-histogram">
      <div
        className="severity-histogram-plot"
        role="img"
        aria-label={`Distribution of ${clean.length} segment scores across ${bins.length} bins from 0 to ${SEVERITY_SCORE_MAX}; the tallest bin holds ${peakCount} segments`}
      >
        <div className="severity-histogram-axis" aria-hidden="true">
          <span>{peakCount}</span>
          <span>0</span>
        </div>
        <div className="severity-histogram-bars" ref={barsRef}>
          {bins.map((bin) => {
            // Colour by where the bin sits on the scale, not by its count: the ramp means severity
            // everywhere else in this panel and must not switch to meaning frequency here.
            const bucket = severityBucket((bin.from + bin.to) / 2);
            const heightPercent = bin.count === 0 ? 0 : Math.max(1.5, (bin.count / peakCount) * 100);
            return (
              // A div, not a <button>: the shared control theme floors every button inside
              // .panel-card at control height AND width, which flattens a chart into a row of
              // buttons. A chart mark is not a control; role+tabIndex keep it labelled and
              // reachable.
              <div
                role="img"
                tabIndex={0}
                className="severity-histogram-bar"
                key={bin.index}
                data-testid="severity-histogram-bar"
                data-bucket={bucket || 'minimal'}
                // Height rides a custom property the CSS applies with !important -- a plain inline
                // height loses the cascade fight against the shared logical block-size rule.
                style={{ ['--severity-bar-h' as string]: `${heightPercent}%`, background: bucket ? SEVERITY_BUCKET_COLORS[bucket] : 'transparent' } as React.CSSProperties}
                onMouseEnter={() => setHovered(bin)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(bin)}
                onBlur={() => setHovered(null)}
                aria-label={`Score ${formatSeverityScore(bin.from)} to ${formatSeverityScore(bin.to)}: ${bin.count} segment(s)`}
              />
            );
          })}
        </div>
      </div>
      <div className="severity-histogram-scale" aria-hidden="true">
        <span>0</span>
        <span>{SEVERITY_SCORE_MAX}</span>
      </div>
      <div className="severity-histogram-tooltip" data-testid="severity-histogram-tooltip" data-visible={hovered ? 'true' : 'false'}>
        {hovered ? (
          <>
            <strong>{hovered.count} segment{hovered.count === 1 ? '' : 's'}</strong>
            <span>score {formatSeverityScore(hovered.from)}-{formatSeverityScore(hovered.to)}</span>
            <span>{(() => { const bucket = severityBucket((hovered.from + hovered.to) / 2); return bucket ? SEVERITY_BUCKET_LABELS[bucket] : ''; })()}</span>
          </>
        ) : (
          <span>Hover a bin for its segment count.</span>
        )}
      </div>
      <p className="helper-copy severity-histogram-note" data-testid="severity-histogram-note">
        {`${clean.length.toLocaleString()} segment(s) binned by score.`}
        {excluded > 0 ? ` ${excluded} artifact segment(s) excluded.` : ''}
      </p>
    </div>
  );
}

// The table view is the non-visual path to the same numbers (and what a screen reader reads).
function SeverityScoreTable({ scores }: { scores: SeveritySegmentScore[] }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? scores : scores.slice(0, 10);
  return (
    <details className="severity-score-table" data-testid="severity-score-table" onToggle={(event) => setExpanded((event.target as HTMLDetailsElement).open)}>
      <summary>Per-segment scores ({scores.length})</summary>
      <table className="data-table compact">
        <thead><tr><th>Segment</th><th>Start</th><th>End</th><th>Score</th><th>Level</th></tr></thead>
        <tbody>
          {visible.map((item) => {
            const bucket = severityBucket(item.score);
            return (
              <tr key={item.segment_idx}>
                <td>{item.segment_idx}</td>
                <td>{formatClock(item.start_sec)}</td>
                <td>{formatClock(item.end_sec)}</td>
                <td>{formatSeverityScore(item.score)}</td>
                <td>{bucket ? SEVERITY_BUCKET_LABELS[bucket] : '—'}</td>
              </tr>
            );
          })}
          {!expanded && scores.length > visible.length && (
            <tr><td colSpan={5}>Expand to see all {scores.length} segments.</td></tr>
          )}
        </tbody>
      </table>
    </details>
  );
}

// Long-term monitoring runs for a day, so m:ss alone is unreadable past an hour -- a 20-hour
// timestamp rendered as "1205:30" minutes. Hours are included once there is at least one.
/** Rounded, human duration for an estimate -- '4 min', not '00:03:57'. An ETA is not a stopwatch. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatClock(seconds: number | null | undefined): string {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return '—';
  const total = Math.round(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
