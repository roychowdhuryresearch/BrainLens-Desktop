import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecordingMetadata, SeveritySegmentScore, WaveformControlsState } from '../../app/workspaceState';
import {
  SEVERITY_BUCKET_COLORS,
  SEVERITY_SCORE_MAX,
  clampOverviewStartSeconds,
  overviewRangeBandRect,
  overviewTimeToX,
  overviewXToTime,
  formatRecordingClock,
  recordingDurationSeconds,
  severityBucket
} from '../../app/workspaceState';
import { biomarkerOverlayColor, biomarkerOverlayLegend, type WaveformEventOverlay } from './WaveformCanvas';

// Full-recording EVENT INDICATOR (PyQt mini-plot biomarker map parity). This is NOT a signal
// preview: like PyQt's mini plot (mini_plot_controller.plot_all_current_biomarkers_for_all_channels),
// it paints every detected event from the visible runs as a colored tick along ONE
// recording-length time axis. Events from all channels are flattened onto the same row (a
// cross-channel time map of where events occur), exactly as PyQt draws every biomarker at a single
// height. Unlike the main canvas (which colors by clinical event type), the overview colors each
// tick BY BIOMARKER (HFO vs Spindle vs Spike) via biomarkerOverlayColor — so with an HFO run and a
// spindle run both visible, the strip shows where the two biomarkers co-localize. A draggable window
// band marks the live main-window position; dragging/clicking re-seeks via the shared onUpdatePlot
// path. No backend fetch — it consumes the same in-memory eventOverlays the main canvas draws.

const OVERVIEW_HEIGHT = 24;
const OVERVIEW_FALLBACK_WIDTH = 900;
const OVERVIEW_BACKGROUND = '#f8fbff';
const OVERVIEW_BASELINE = 'rgba(148, 163, 184, 0.55)';
// Neutral-gray window-position band so the biomarker tick colors (incl. blue) are
// the only hue signal on the strip and never clash with a blue band.
const OVERVIEW_BAND_FILL = 'rgba(100, 116, 139, 0.12)';
const OVERVIEW_BAND_STROKE = 'rgba(100, 116, 139, 0.82)';
// The severity profile is drawn as a column per scored segment, its height the score against a
// fixed 0-SEVERITY_SCORE_MAX scale (the caller never rescales it -- a relative axis would make a
// benign recording look as severe as a bad one). It sits behind the event ticks, since events are
// what this strip is primarily for.
const OVERVIEW_SEVERITY_ALPHA = 0.55;

type DragState = { active: boolean; grabOffsetSeconds: number };

export function WaveformOverview({
  metadata,
  controls,
  eventOverlays,
  severityScores,
  onSeek
}: {
  metadata: RecordingMetadata | null;
  controls: WaveformControlsState;
  eventOverlays: WaveformEventOverlay[];
  // Per-segment severity scores, when a run has produced them. Empty for iEEG and before scoring.
  severityScores?: SeveritySegmentScore[];
  onSeek: (startSeconds: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(OVERVIEW_FALLBACK_WIDTH);
  // Time under the pointer, shown while hovering or dragging the strip. Null when the pointer is
  // away, so the readout never lingers over a strip nobody is touching. The viewport coordinates
  // ride along because the readout is position:fixed -- in the loaded workspace this strip is a
  // 30px overflow:hidden box, which clips any absolutely-positioned child placed above it.
  const [hover, setHover] = useState<{ seconds: number; clientX: number; canvasTop: number } | null>(null);
  const dragRef = useRef<DragState>({ active: false, grabOffsetSeconds: 0 });
  const durationSeconds = Math.max(0, recordingDurationSeconds(metadata));
  const eventCount = eventOverlays.length;
  const biomarkerLegend = biomarkerOverlayLegend(eventOverlays);
  const severityProfile = severityScores || [];

  // Track the rendered CSS width so canvas math/hit-testing stay in logical pixels.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      const next = Math.max(1, Math.round(rect.width) || OVERVIEW_FALLBACK_WIDTH);
      setWidth((current) => (current === next ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const band = overviewRangeBandRect(controls.startSeconds, controls.timeWindowSeconds, durationSeconds, width);

  // The wheel over a time strip should move through time -- that is what the strip IS. Nothing
  // here scrolls in the CSS sense, so without this the gesture lands on an ancestor and the
  // recording sits still. One notch moves by the user's own step setting, the same amount the
  // toolbar arrows use. Native listener with passive:false, since React's onWheel cannot
  // preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || durationSeconds <= 0) return;
    function onWheel(event: WheelEvent) {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const step = Math.max(0.1, controls.timeWindowSeconds * (controls.timeIncrementPercent || 100) / 100);
      const next = clampOverviewStartSeconds(
        controls.startSeconds + (delta > 0 ? step : -step),
        controls.timeWindowSeconds,
        durationSeconds,
      );
      if (Math.abs(next - controls.startSeconds) < 1e-6) return;
      onSeek(next);
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [controls.startSeconds, controls.timeWindowSeconds, controls.timeIncrementPercent, durationSeconds, onSeek]);

  // Paint: background, baseline, per-event colored ticks (the event map), then the range band that
  // marks the current main-window position.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = devicePixelRatioSafe();
    const backingWidth = Math.max(1, Math.round(width * dpr));
    const backingHeight = Math.max(1, Math.round(OVERVIEW_HEIGHT * dpr));
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, OVERVIEW_HEIGHT);
    ctx.fillStyle = OVERVIEW_BACKGROUND;
    ctx.fillRect(0, 0, width, OVERVIEW_HEIGHT);

    ctx.strokeStyle = OVERVIEW_BASELINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, OVERVIEW_HEIGHT / 2 + 0.5);
    ctx.lineTo(width, OVERVIEW_HEIGHT / 2 + 0.5);
    ctx.stroke();

    // Current-window band FILL first, as a context layer BEHIND the events.
    const fullWindowBand = durationSeconds > 0 && band.width >= width - 2;
    if (durationSeconds > 0) {
      ctx.fillStyle = fullWindowBand ? 'rgba(100, 116, 139, 0.06)' : OVERVIEW_BAND_FILL;
      ctx.fillRect(band.x, 1, band.width, OVERVIEW_HEIGHT - 2);
    }

    // Severity profile beneath the events: one column per scored segment, height = score / 5.
    if (durationSeconds > 0 && severityProfile.length) {
      const floorY = OVERVIEW_HEIGHT - 1;
      const usableHeight = OVERVIEW_HEIGHT - 3;
      ctx.globalAlpha = OVERVIEW_SEVERITY_ALPHA;
      for (const segment of severityProfile) {
        const score = Number(segment.score);
        if (!Number.isFinite(score)) continue;
        const startX = overviewTimeToX(Number(segment.start_sec) || 0, durationSeconds, width);
        const endX = overviewTimeToX(Number(segment.end_sec) || 0, durationSeconds, width);
        const columnWidth = Math.max(1, endX - startX);
        const columnHeight = Math.max(1, (Math.max(0, Math.min(SEVERITY_SCORE_MAX, score)) / SEVERITY_SCORE_MAX) * usableHeight);
        const bucket = severityBucket(score);
        ctx.fillStyle = bucket ? SEVERITY_BUCKET_COLORS[bucket] : 'transparent';
        ctx.fillRect(startX, floorY - columnHeight, columnWidth, columnHeight);
      }
      ctx.globalAlpha = 1;
    }

    // Event ticks ON TOP of the band fill so the events stay the prominent layer.
    if (durationSeconds > 0 && eventOverlays.length) {
      const top = 3;
      const bottom = OVERVIEW_HEIGHT - 3;
      ctx.lineWidth = 1.5;
      for (const overlay of eventOverlays) {
        const startSeconds = Number(overlay.event.start_seconds);
        if (!Number.isFinite(startSeconds)) continue;
        const x = Math.round(overviewTimeToX(startSeconds, durationSeconds, width)) + 0.5;
        ctx.strokeStyle = biomarkerOverlayColor(overlay, 1);
        ctx.beginPath();
        ctx.moveTo(x, top);
        ctx.lineTo(x, bottom);
        ctx.stroke();
      }
    }

    // Current-window band OUTLINE last so it frames the live view over the events.
    if (durationSeconds > 0) {
      ctx.strokeStyle = fullWindowBand ? 'rgba(100, 116, 139, 0.34)' : OVERVIEW_BAND_STROKE;
      ctx.lineWidth = fullWindowBand ? 1 : 1.5;
      ctx.strokeRect(band.x + 0.75, 1.5, Math.max(1, band.width - 1.5), OVERVIEW_HEIGHT - 3);
    }
  }, [eventOverlays, severityProfile, width, band.x, band.width, durationSeconds]);

  function pointerSeconds(event: React.PointerEvent<HTMLCanvasElement>): number {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    const logicalX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * width;
    return overviewXToTime(logicalX, durationSeconds, width);
  }

  // Drag/click semantics: clicking outside the band centers the window on the cursor; grabbing the
  // band keeps the grab offset so the band slides under the pointer. Both clamp the start so it can
  // never go below 0 or past duration-window, then re-seek via the shared onUpdatePlot path.
  function seekToPointer(event: React.PointerEvent<HTMLCanvasElement>, grabOffsetSeconds: number) {
    if (durationSeconds <= 0) return;
    const cursorSeconds = pointerSeconds(event);
    const nextStart = clampOverviewStartSeconds(cursorSeconds - grabOffsetSeconds, controls.timeWindowSeconds, durationSeconds);
    if (Math.abs(nextStart - controls.startSeconds) < 1e-6) return;
    onSeek(nextStart);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (durationSeconds <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const cursorSeconds = pointerSeconds(event);
    const insideBand = cursorSeconds >= controls.startSeconds && cursorSeconds <= controls.startSeconds + controls.timeWindowSeconds;
    // Clicking the band preserves where the user grabbed it; clicking elsewhere centers the window.
    const grabOffset = insideBand ? cursorSeconds - controls.startSeconds : controls.timeWindowSeconds / 2;
    dragRef.current = { active: true, grabOffsetSeconds: grabOffset };
    seekToPointer(event, grabOffset);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    setHover({
      seconds: pointerSeconds(event),
      clientX: event.clientX,
      canvasTop: event.currentTarget.getBoundingClientRect().top
    });
    if (!dragRef.current.active) return;
    event.preventDefault();
    seekToPointer(event, dragRef.current.grabOffsetSeconds);
  }

  function endDrag(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current.active) return;
    dragRef.current = { active: false, grabOffsetSeconds: 0 };
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  if (!metadata || durationSeconds <= 0) return null;

  return (
    <section
      className="waveform-overview"
      data-testid="pyqt-waveform_overview"
      aria-label="Full-recording event indicator with draggable window band"
      data-overview-events={eventCount}
      data-overview-severity-segments={severityProfile.length}
      data-overview-duration={durationSeconds.toFixed(3)}
      data-overview-band-start={controls.startSeconds.toFixed(3)}
      data-overview-band-window={controls.timeWindowSeconds.toFixed(3)}
    >
      <canvas
        ref={canvasRef}
        className="waveform-overview-canvas"
        data-testid="pyqt-waveform_overview_canvas"
        style={{ width: '100%', height: `${OVERVIEW_HEIGHT}px`, display: 'block', cursor: 'pointer', touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
        onLostPointerCapture={() => {
          dragRef.current = { active: false, grabOffsetSeconds: 0 };
        }}
      />
      {/* Portalled to <body>: the waveform pane carries `contain:paint`, which makes it the
          containing block for fixed-position descendants -- a bubble left inside it resolves its
          coordinates against the pane and lands 250px below where the pointer is. */}
      {hover && durationSeconds > 0 && createPortal(
        <span
          className="overview-timestamp"
          data-testid="pyqt-waveform_overview_timestamp"
          style={{ left: `${hover.clientX}px`, top: `${hover.canvasTop - 6}px` }}
        >
          {formatRecordingClock(hover.seconds)}
        </span>,
        document.body
      )}
      <span className="waveform-overview-label" data-testid="pyqt-waveform_overview_label">
        <span className="waveform-overview-label-lead">Recording overview</span> · {eventCount} event{eventCount === 1 ? '' : 's'} · {controls.startSeconds.toFixed(1)}s / {durationSeconds.toFixed(1)}s
        {severityProfile.length > 0 && ` · severity 0-${SEVERITY_SCORE_MAX} profile`}
        {biomarkerLegend.length > 0 && (
          <span className="waveform-overview-legend" data-testid="pyqt-waveform_overview_legend">
            {biomarkerLegend.map((entry) => (
              <span key={entry.label} className="waveform-overview-legend-item">
                <span className="waveform-overview-legend-swatch" style={{ backgroundColor: entry.color }} aria-hidden="true" />
                {entry.label}
              </span>
            ))}
          </span>
        )}
      </span>
    </section>
  );
}

function devicePixelRatioSafe(): number {
  const dpr = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  return Math.max(1, Math.min(4, dpr || 1));
}
