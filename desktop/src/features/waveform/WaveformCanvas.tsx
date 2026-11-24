import React, { useEffect, useRef, type WheelEvent as ReactWheelEvent } from 'react';
import type { ReviewEvent, RunRecord } from '../../app/workspaceState';
import { displayChannelName, resolveEventTypeColor, type WaveformEventColorStyle } from '../../app/workspaceState';
import { createWaveformGLRenderer, type WaveformGLRenderer } from './waveformGL';

export type WaveformWindow = { channels: string[]; data: number[][]; times_seconds: number[]; units: string; source?: string; filters_applied?: string[]; display_to_uv_scale?: number; offset_value?: number };

export type WaveformEventOverlay = {
  event: ReviewEvent;
  run: RunRecord | null;
  active: boolean;
  accepted: boolean;
  visible: boolean;
};

export type WaveformTrackpadSensitivity = 'gentle' | 'default' | 'fast';
type CanvasMetrics = { width: number; height: number };
type OverlayHitRegion = { overlay: WaveformEventOverlay; x: number; y: number; width: number; height: number };
type ChannelHitRegion = { channel: string; x: number; y: number; width: number; height: number };
export type WaveformWheelNavigation = { timeSteps: number; channelSteps: number; zoomSteps: number; anchorRatio: number };
export type WaveformCanvasPoint = { x: number; y: number; timeSeconds: number; channel: string; rawValueUv: number; sampleIndex: number; valueIsUv: boolean };
export type WaveformMeasurementStatus = { text: string; tooltip: string; overlayText: string; pointCount: number };

const CHANNEL_GUTTER_WIDTH = 96;
const WAVEFORM_TRACE_SCALE = 0.15;
const PYQT_WAVEFORM_BACKGROUND = '#ffffff';
/* Prominent trace ink: a near-black slate (classic paper-EEG style) at near-full opacity for maximum
 * contrast against the white plot background (PyQt color parity retired 2026-06-05). The old
 * desaturated grey-blue at 0.66α read as washed-out. Keep the RGB/α in sync with
 * PYQT_WAVEFORM_TRACE_GL below. */
const PYQT_WAVEFORM_TRACE = 'rgba(15, 23, 42, 0.95)';
/* Same trace stroke as PYQT_WAVEFORM_TRACE, expressed as GL-clip-space color channels (0..1) for
 * the offscreen WebGL polyline renderer so GPU traces match the 2D fallback color/opacity. */
const PYQT_WAVEFORM_TRACE_GL = { r: 15 / 255, g: 23 / 255, b: 42 / 255, a: 0.95 };
const PYQT_WAVEFORM_GRID = 'rgba(203, 213, 225, 0.18)';
const PYQT_WAVEFORM_AXIS = 'rgba(148, 163, 184, 0.22)';
const PYQT_WAVEFORM_LABEL = 'rgba(82, 101, 121, 0.84)';
const PYQT_EVENT_MARKER_HIT_WIDTH = 10;
const PYQT_TIME_AXIS_HEIGHT = 34;
/* PyQt draw_scale_bar parity (main_waveform_plot_view.py ~736-779): a vertical calibration
 * bar with end caps + a "<N> µV" label inset at the bottom-right of the plot. Colors mirror
 * the PyQt scale_pen "#486277" and label text "#304657". */
const PYQT_SCALE_BAR_LINE = '#486277';
const PYQT_SCALE_BAR_LABEL = '#304657';
/* Model y_100_length (main_waveform_plot_model.py ~337/341): 100 µV raw, 50 µV filtered. */
const PYQT_SCALE_BAR_UV_RAW = 100;
const PYQT_SCALE_BAR_UV_FILTERED = 50;
/* Responsive backing-store bounds. The model floors render points at MIN_RENDER_POINTS=1500 and
 * targets render_width_px*2 (main_waveform_plot_model.py ~39/222-223); we keep a comparable
 * pixel-width floor/cap so server downsampling tracks the on-screen plot width. */
const WAVEFORM_MIN_RENDER_WIDTH = 320;
const WAVEFORM_MAX_RENDER_WIDTH = 4096;
const WAVEFORM_FALLBACK_WIDTH = 900;
const WAVEFORM_FALLBACK_HEIGHT = 360;
const TRACKPAD_WHEEL_PROFILES: Record<WaveformTrackpadSensitivity, { threshold: number; unit: number; maxSteps: number }> = {
  gentle: { threshold: 12, unit: 180, maxSteps: 1 },
  default: { threshold: 1e-6, unit: 120, maxSteps: 2 },
  fast: { threshold: 0.25, unit: 60, maxSteps: 4 }
};

export function WaveformCanvas({ windowData, eventOverlays = [], selectedEventId = '', selectedChannel = '', cursorEnabled = false, measureEnabled = false, amplitudeScale = 1, normalizeVertically = false, showFiltered = false, trackpadSensitivity = 'default', onOverlaySelect, onChannelSelect, onWheelNavigation, onMeasurementStatusChange, onRenderWidthChange }: { windowData?: WaveformWindow | null; eventOverlays?: WaveformEventOverlay[]; selectedEventId?: string; selectedChannel?: string; cursorEnabled?: boolean; measureEnabled?: boolean; amplitudeScale?: number; normalizeVertically?: boolean; showFiltered?: boolean; trackpadSensitivity?: WaveformTrackpadSensitivity; onOverlaySelect?: (overlay: WaveformEventOverlay) => void; onChannelSelect?: (channel: string) => void; onWheelNavigation?: (request: WaveformWheelNavigation) => void; onMeasurementStatusChange?: (status: WaveformMeasurementStatus) => void; onRenderWidthChange?: (renderWidthPx: number) => void }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const hitRegionsRef = useRef<OverlayHitRegion[]>([]);
  const channelHitRegionsRef = useRef<ChannelHitRegion[]>([]);
  // Offscreen GPU trace renderer. Created lazily once; stays null in jsdom / GPU-less environments
  // so the draw effect transparently falls back to the existing 2D trace loop. `glInitialized`
  // guards against re-attempting context creation every render after a known failure.
  const glRendererRef = useRef<WaveformGLRenderer | null>(null);
  const glInitializedRef = useRef(false);
  const [hoveredEventId, setHoveredEventId] = React.useState('');
  const [hoveredChannel, setHoveredChannel] = React.useState('');
  const [cursorPoint, setCursorPoint] = React.useState<WaveformCanvasPoint | null>(null);
  const [measurementPoints, setMeasurementPoints] = React.useState<WaveformCanvasPoint[]>([]);
  // Logical (CSS-pixel) canvas size. The backing store is scaled by devicePixelRatio for crisp
  // HiDPI rendering, while all drawing/hit-testing math stays in these logical coordinates.
  const [canvasSize, setCanvasSize] = React.useState<CanvasMetrics>({ width: WAVEFORM_FALLBACK_WIDTH, height: WAVEFORM_FALLBACK_HEIGHT });
  const measurementStatus = measurementStatusFromPoints(measureEnabled, measurementPoints);
  const metrics: CanvasMetrics = { width: canvasSize.width, height: canvasSize.height };

  // Responsive sizing: observe the canvas's own rendered box (it fills its grid cell via CSS
  // width/height:100%) and track its measured CSS size. Updating the backing-store resolution does
  // not change the CSS layout box, so self-observation is stable. The measured plot width feeds the
  // backend downsampling target (parity with model.set_render_width_pixels / get_render_width,
  // main_waveform_plot_model.py ~208-212 / view get_render_width ~709-710).
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return;
    const applyMeasuredSize = () => {
      const rect = canvas.getBoundingClientRect();
      const nextWidth = Math.max(WAVEFORM_MIN_RENDER_WIDTH, Math.min(WAVEFORM_MAX_RENDER_WIDTH, Math.round(rect.width) || WAVEFORM_FALLBACK_WIDTH));
      const nextHeight = Math.max(120, Math.round(rect.height) || WAVEFORM_FALLBACK_HEIGHT);
      setCanvasSize((current) => (current.width === nextWidth && current.height === nextHeight ? current : { width: nextWidth, height: nextHeight }));
    };
    applyMeasuredSize();
    const observer = new ResizeObserver(applyMeasuredSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  // Report the measured plot render width so the parent can size target_samples_per_channel.
  useEffect(() => {
    onRenderWidthChange?.(resolveWaveformRenderWidth(canvasSize.width));
  }, [canvasSize.width, onRenderWidthChange]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !windowData?.data?.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = devicePixelRatioSafe();
    const backingWidth = Math.round(metrics.width * dpr);
    const backingHeight = Math.round(metrics.height * dpr);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
    // Draw in logical coordinates; the DPR transform handles physical-pixel crispness.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, metrics.width, metrics.height);
    const plotHeight = pyqtPlotHeight(metrics);
    drawPyqtWaveformBackground(ctx, metrics, windowData, CHANNEL_GUTTER_WIDTH, plotHeight);
    channelHitRegionsRef.current = drawChannelGutter(ctx, metrics, windowData, selectedChannel, hoveredChannel, plotHeight);
    hitRegionsRef.current = drawEventOverlays(ctx, metrics, windowData, eventOverlays, selectedEventId, hoveredEventId, CHANNEL_GUTTER_WIDTH, plotHeight);
    ctx.strokeStyle = PYQT_WAVEFORM_TRACE;
    const rowHeight = plotHeight / Math.max(1, windowData.data.length);
    // GPU-accelerated channel traces. The many-channel polylines (N channels × M samples) are the
    // perf bottleneck for large montages, so they render on an OFFSCREEN WebGL canvas and composite
    // here via drawImage; every overlay above/below is still 2D for pixel-identical PyQt parity. The
    // snapshot toDataURL on this visible canvas therefore captures the full composited image. If
    // WebGL is unavailable (jsdom test env, GPU-less machines) glRendererRef stays null and we fall
    // back to the EXISTING inline 2D trace loop below — same transforms, same pixels.
    const glRenderer = ensureWaveformGLRenderer(glRendererRef, glInitializedRef);
    if (glRenderer && !glRenderer.isLost?.()) {
      const tracePixels = buildChannelTracePixels(metrics, windowData, rowHeight, amplitudeScale, normalizeVertically, plotHeight);
      glRenderer.resize(backingWidth, backingHeight);
      glRenderer.drawTraces(tracePixels, metrics.width, metrics.height, PYQT_WAVEFORM_TRACE_GL);
      // Composite the GPU-rendered traces under the remaining 2D overlays. Source canvas is backing
      // sized; dest rect is logical sized and the active DPR transform scales it to device pixels.
      ctx.drawImage(glRenderer.canvas, 0, 0, metrics.width, metrics.height);
    } else {
      // 2D fallback (also the parity reference for the GPU path). Do NOT remove: it renders the
      // traces directly when WebGL is unavailable.
      windowData.data.forEach((row, rowIndex) => {
        const traceScale = traceScaleForRow(row, rowHeight, amplitudeScale, normalizeVertically);
        ctx.beginPath();
        row.forEach((value, index) => {
          const x = CHANNEL_GUTTER_WIDTH + (index / Math.max(1, row.length - 1)) * pyqtPlotWidth(metrics, CHANNEL_GUTTER_WIDTH);
          const y = displayYForSample(rowIndex, rowHeight, value, traceScale);
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();
      });
    }
    drawPyqtScaleBar(ctx, metrics, rowHeight, showFiltered, normalizeVertically, amplitudeScale, plotHeight);
    drawPyqtTimeAxis(ctx, metrics, windowData, CHANNEL_GUTTER_WIDTH, plotHeight);
    drawCursorOverlay(ctx, metrics, cursorEnabled ? cursorPoint : null, plotHeight);
    drawMeasurementOverlay(ctx, metrics, measureEnabled ? measurementPoints : [], measurementStatus.overlayText);
  }, [windowData, eventOverlays, selectedEventId, selectedChannel, hoveredEventId, hoveredChannel, cursorEnabled, measureEnabled, amplitudeScale, normalizeVertically, showFiltered, cursorPoint, measurementPoints, measurementStatus.overlayText, canvasSize.width, canvasSize.height]);

  // Release the offscreen WebGL context (buffer + program) when the component unmounts so GPU
  // resources are not leaked across montage reloads.
  useEffect(() => {
    return () => {
      glRendererRef.current?.dispose();
      glRendererRef.current = null;
      glInitializedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!cursorEnabled) setCursorPoint(null);
  }, [cursorEnabled]);

  useEffect(() => {
    if (!measureEnabled) setMeasurementPoints([]);
  }, [measureEnabled]);

  useEffect(() => {
    setCursorPoint(null);
    setMeasurementPoints([]);
  }, [windowData]);

  useEffect(() => {
    onMeasurementStatusChange?.(measurementStatus);
  }, [measurementStatus.text, measurementStatus.tooltip, measurementStatus.overlayText, measurementStatus.pointCount, onMeasurementStatusChange]);

  function canvasPointer(event: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } | null {
    const canvas = ref.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    // Map client pixels into logical canvas coordinates (independent of devicePixelRatio).
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * metrics.width,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * metrics.height
    };
  }

  function overlayAtPointer(event: React.MouseEvent<HTMLCanvasElement>): WaveformEventOverlay | null {
    const point = canvasPointer(event);
    if (!point) return null;
    const { x, y } = point;
    const hit = [...hitRegionsRef.current].reverse().find((region) => x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height);
    return hit?.overlay || null;
  }

  function channelAtPointer(event: React.MouseEvent<HTMLCanvasElement>): string {
    const point = canvasPointer(event);
    if (!point) return '';
    const { x, y } = point;
    const hit = channelHitRegionsRef.current.find((region) => x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height);
    return hit?.channel || '';
  }

  function waveformPointAtPointer(event: React.MouseEvent<HTMLCanvasElement>): WaveformCanvasPoint | null {
    const point = canvasPointer(event);
    if (!point || !windowData?.data?.length || !windowData.times_seconds.length) return null;
    if (point.x < CHANNEL_GUTTER_WIDTH || point.x > metrics.width) return null;
    const plotHeight = pyqtPlotHeight(metrics);
    if (point.y >= plotHeight) return null;
    const rowHeight = plotHeight / Math.max(1, windowData.channels.length);
    const channelIndex = Math.max(0, Math.min(windowData.channels.length - 1, Math.floor(point.y / Math.max(1, rowHeight))));
    const row = windowData.data[channelIndex] || [];
    if (!row.length) return null;
    const traceScale = traceScaleForRow(row, rowHeight, amplitudeScale, normalizeVertically);
    const plotWidth = pyqtPlotWidth(metrics, CHANNEL_GUTTER_WIDTH);
    const ratio = Math.max(0, Math.min(1, (point.x - CHANNEL_GUTTER_WIDTH) / plotWidth));
    const sampleIndex = Math.max(0, Math.min(row.length - 1, Math.round(ratio * Math.max(0, row.length - 1))));
    const timeSeconds = interpolateTimeAtRatio(windowData.times_seconds, ratio);
    const displayValue = Number(row[sampleIndex] ?? 0);
    // PyQt model.get_measurement_point reports raw_value_uv from the unnormalized window
    // (main_waveform_plot_model.py ~202). Our window payload only carries display-space samples
    // unless the backend exposes display_to_uv_scale; recover true µV when it does, otherwise keep
    // the display value and flag valueIsUv=false so readouts are not mislabeled as µV.
    const { value: rawValueUv, isUv } = displaySampleToUv(displayValue, windowData);
    const x = CHANNEL_GUTTER_WIDTH + ratio * plotWidth;
    const y = displayYForSample(channelIndex, rowHeight, displayValue, traceScale);
    return {
      x,
      y,
      timeSeconds,
      channel: windowData.channels[channelIndex] || '',
      rawValueUv,
      sampleIndex,
      valueIsUv: isUv
    };
  }

  function handleMouseMove(event: React.MouseEvent<HTMLCanvasElement>) {
    const channel = channelAtPointer(event);
    const overlay = channel ? null : overlayAtPointer(event);
    setHoveredChannel(channel);
    setHoveredEventId(overlay?.event.event_id || '');
    if (cursorEnabled) setCursorPoint(waveformPointAtPointer(event));
  }

  function handleClick(event: React.MouseEvent<HTMLCanvasElement>) {
    const channel = channelAtPointer(event);
    if (channel) {
      onChannelSelect?.(channel);
      return;
    }
    const waveformPoint = waveformPointAtPointer(event);
    if (measureEnabled && waveformPoint) {
      onChannelSelect?.(waveformPoint.channel);
      setMeasurementPoints((points) => points.length >= 2 ? [waveformPoint] : [...points, waveformPoint]);
      return;
    }
    if (cursorEnabled && waveformPoint) {
      onChannelSelect?.(waveformPoint.channel);
      setCursorPoint(waveformPoint);
      return;
    }
    const overlay = overlayAtPointer(event);
    if (overlay) onOverlaySelect?.(overlay);
  }

  function handleWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    const request = wheelNavigationFromEvent(event, trackpadSensitivity, metrics.width);
    if (!request.timeSteps && !request.channelSteps && !request.zoomSteps) return;
    if (event.cancelable) event.preventDefault();
    onWheelNavigation?.(request);
  }

  const cursorStyle = cursorEnabled || measureEnabled ? 'crosshair' : (hoveredEventId || hoveredChannel ? 'pointer' : 'default');
  // No fixed width/height attributes: the canvas fills its grid cell via CSS (width/height:100%)
  // and the draw effect sizes the backing store to the measured logical size * devicePixelRatio.
  return <canvas ref={ref} className="waveform-canvas" aria-label="Bounded waveform viewer with PyQt channel gutter, cursor, measurement, vertical scaling, calibration scale bar, and visible-run event overlays" data-testid="pyqt-waveform_event_overlay_canvas" data-channel-gutter-width={CHANNEL_GUTTER_WIDTH} data-render-width={resolveWaveformRenderWidth(canvasSize.width)} data-logical-width={canvasSize.width} data-logical-height={canvasSize.height} data-selected-channel={selectedChannel} data-hovered-channel={hoveredChannel} data-amplitude-scale={amplitudeScale} data-normalize-vertically={normalizeVertically ? 'true' : 'false'} data-show-filtered={showFiltered ? 'true' : 'false'} data-trackpad-sensitivity={trackpadSensitivity} data-cursor-enabled={cursorEnabled ? 'true' : 'false'} data-measure-enabled={measureEnabled ? 'true' : 'false'} data-cursor-time={cursorPoint ? cursorPoint.timeSeconds.toFixed(4) : ''} data-measurement-point-count={measurementPoints.length} data-measurement-summary={measurementStatus.text} data-overlay-count={eventOverlays.length} data-selected-event-id={selectedEventId} data-hovered-event-id={hoveredEventId} data-fetch-contract="/waveform/window bounded viewport requests only" data-window-start-seconds={windowData?.times_seconds && windowData.times_seconds.length ? windowData.times_seconds[0].toFixed(3) : ''} data-window-duration-seconds={windowData?.times_seconds && windowData.times_seconds.length > 1 ? (windowData.times_seconds[windowData.times_seconds.length - 1] - windowData.times_seconds[0]).toFixed(3) : ''} onMouseMove={handleMouseMove} onMouseLeave={() => { setHoveredEventId(''); setHoveredChannel(''); setCursorPoint(null); }} onClick={handleClick} onWheel={handleWheel} style={{ cursor: cursorStyle, width: '100%', height: '100%', display: 'block' }} />;
}

function devicePixelRatioSafe(): number {
  const dpr = typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1;
  return Math.max(1, Math.min(4, dpr || 1));
}

// Clamp the measured plot width to a sane floor/cap before it drives backend downsampling.
export function resolveWaveformRenderWidth(measuredWidth: number): number {
  const width = Number(measuredWidth);
  if (!Number.isFinite(width) || width <= 0) return WAVEFORM_FALLBACK_WIDTH;
  return Math.round(Math.max(WAVEFORM_MIN_RENDER_WIDTH, Math.min(WAVEFORM_MAX_RENDER_WIDTH, width)));
}

// Recover true µV from a display-space sample when the backend exposes a display->µV scale,
// matching the intent of model.get_measurement_point raw_value_uv. Without a scale we cannot
// invert the per-window z-score/normalization, so we return the display value flagged non-µV.
function displaySampleToUv(displayValue: number, windowData: WaveformWindow): { value: number; isUv: boolean } {
  const scale = Number(windowData.display_to_uv_scale);
  const unitsAreUv = String(windowData.units || '').trim().toLowerCase() === 'uv' || String(windowData.units || '').trim().toLowerCase() === 'µv';
  if (Number.isFinite(scale) && scale > 0) return { value: displayValue * scale, isUv: true };
  // If the backend already delivered the window in µV (no normalization applied), the display
  // value IS µV. Otherwise it is a unitless display amplitude.
  if (unitsAreUv && !Number.isFinite(scale)) return { value: displayValue, isUv: true };
  return { value: displayValue, isUv: false };
}

function traceScaleForRow(row: number[], rowHeight: number, amplitudeScale: number, normalizeVertically: boolean): number {
  const safeAmplitudeScale = Math.min(10, Math.max(0.25, Number(amplitudeScale) || 1));
  if (!normalizeVertically) return WAVEFORM_TRACE_SCALE * safeAmplitudeScale;
  const peak = Math.max(...row.map((value) => Math.abs(Number(value) || 0)), 1e-6);
  return (rowHeight * 0.38 * safeAmplitudeScale) / peak;
}

function displayYForSample(rowIndex: number, rowHeight: number, value: number, traceScale: number): number {
  return (rowIndex + 0.5) * rowHeight - value * traceScale;
}

// Lazily create the offscreen WebGL trace renderer exactly once. After a failed attempt (jsdom /
// GPU-less) `initializedRef` latches true with a null renderer so we never re-probe getContext and
// the draw effect uses the 2D fallback for the lifetime of the component.
function ensureWaveformGLRenderer(
  rendererRef: React.MutableRefObject<WaveformGLRenderer | null>,
  initializedRef: React.MutableRefObject<boolean>
): WaveformGLRenderer | null {
  if (!initializedRef.current) {
    initializedRef.current = true;
    rendererRef.current = createWaveformGLRenderer();
  }
  return rendererRef.current;
}

// Build the per-channel polyline vertex coordinates in LOGICAL pixels for the GPU path. These are
// byte-for-byte the same x/y the 2D fallback feeds to ctx.moveTo/lineTo (same plotWidth ratio,
// same traceScaleForRow, same displayYForSample), guaranteeing the GPU traces land on identical
// pixels. Each Float32Array is [x0, y0, x1, y1, ...] for one channel row.
export function buildChannelTracePixels(
  metrics: CanvasMetrics,
  windowData: WaveformWindow,
  rowHeight: number,
  amplitudeScale: number,
  normalizeVertically: boolean,
  plotHeight = pyqtPlotHeight(metrics)
): Float32Array[] {
  void plotHeight; // rowHeight already encodes plotHeight; kept for call-site symmetry with the 2D path.
  const plotWidth = pyqtPlotWidth(metrics, CHANNEL_GUTTER_WIDTH);
  const rows: Float32Array[] = [];
  windowData.data.forEach((row, rowIndex) => {
    if (!row.length) return;
    const traceScale = traceScaleForRow(row, rowHeight, amplitudeScale, normalizeVertically);
    const coords = new Float32Array(row.length * 2);
    const denominator = Math.max(1, row.length - 1);
    row.forEach((value, index) => {
      coords[index * 2] = CHANNEL_GUTTER_WIDTH + (index / denominator) * plotWidth;
      coords[index * 2 + 1] = displayYForSample(rowIndex, rowHeight, value, traceScale);
    });
    rows.push(coords);
  });
  return rows;
}

function interpolateTimeAtRatio(timesSeconds: number[], ratio: number): number {
  if (!timesSeconds.length) return 0;
  if (timesSeconds.length === 1) return Number(timesSeconds[0] || 0);
  const position = Math.max(0, Math.min(timesSeconds.length - 1, ratio * (timesSeconds.length - 1)));
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(timesSeconds.length - 1, lowerIndex + 1);
  const lower = Number(timesSeconds[lowerIndex] || 0);
  const upper = Number(timesSeconds[upperIndex] || lower);
  return lower + (upper - lower) * (position - lowerIndex);
}

function measurementStatusFromPoints(measureEnabled: boolean, points: WaveformCanvasPoint[]): WaveformMeasurementStatus {
  if (!measureEnabled) return { text: '', tooltip: '', overlayText: '', pointCount: 0 };
  if (points.length >= 2) {
    const [pointA, pointB] = points;
    const durationSeconds = Math.abs(pointB.timeSeconds - pointA.timeSeconds);
    const amplitudeDelta = Math.abs(pointB.rawValueUv - pointA.rawValueUv);
    const amplitudeIsUv = pointA.valueIsUv && pointB.valueIsUv;
    const text = `dt ${formatMeasurementDuration(durationSeconds)} | dA ${formatMeasurementAmplitude(amplitudeDelta, amplitudeIsUv)}`;
    return {
      text,
      overlayText: text,
      pointCount: 2,
      tooltip: `A: ${pointA.channel} @ ${pointA.timeSeconds.toFixed(4)} s (${formatMeasurementAmplitude(pointA.rawValueUv, pointA.valueIsUv)})\nB: ${pointB.channel} @ ${pointB.timeSeconds.toFixed(4)} s (${formatMeasurementAmplitude(pointB.rawValueUv, pointB.valueIsUv)})${amplitudeIsUv ? '' : '\nAmplitude shown in display units; backend did not expose a µV scale for this window.'}`
    };
  }
  if (points.length === 1) {
    const [pointA] = points;
    return {
      text: 'Click B',
      overlayText: 'Click second point',
      pointCount: 1,
      tooltip: `A: ${pointA.channel} @ ${pointA.timeSeconds.toFixed(4)} s (${formatMeasurementAmplitude(pointA.rawValueUv, pointA.valueIsUv)})\nClick a second point to measure interval and amplitude difference.`
    };
  }
  return { text: 'Click A', overlayText: '', pointCount: 0, tooltip: 'Click the first waveform point to start a measurement.' };
}

function formatMeasurementDuration(durationSeconds: number): string {
  const duration = Math.abs(Number(durationSeconds) || 0);
  return duration < 1 ? `${(duration * 1000).toFixed(1)} ms` : `${duration.toFixed(3)} s`;
}

function formatMeasurementAmplitude(amplitude: number, isUv = true): string {
  const value = Math.abs(Number(amplitude) || 0).toFixed(1);
  // Only label as µV when the value is genuinely in µV; otherwise mark it as a display-unit delta.
  return isUv ? `${value} µV` : `${value} a.u.`;
}

function drawCursorOverlay(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, point: WaveformCanvasPoint | null, plotHeight = metrics.height) {
  if (!point) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(95, 115, 133, 0.92)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(point.x, 0);
  ctx.lineTo(point.x, plotHeight);
  ctx.moveTo(CHANNEL_GUTTER_WIDTH, point.y);
  ctx.lineTo(metrics.width, point.y);
  ctx.stroke();
  ctx.setLineDash([]);
  drawOverlayLabel(ctx, point.x + 8, 8, `${point.channel} · ${point.timeSeconds.toFixed(2)} s · ${formatMeasurementAmplitude(point.rawValueUv, point.valueIsUv)}`, '#304657');
  ctx.restore();
}

function drawMeasurementOverlay(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, points: WaveformCanvasPoint[], summaryText: string) {
  if (!points.length) return;
  ctx.save();
  const colors = ['#5f7385', '#bf7b30'];
  points.slice(0, 2).forEach((point, index) => {
    ctx.strokeStyle = colors[index] || colors[0];
    ctx.fillStyle = colors[index] || colors[0];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(point.x, 0);
    ctx.lineTo(point.x, metrics.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });
  if (points.length >= 2) {
    ctx.strokeStyle = '#bf7b30';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    ctx.stroke();
  }
  const labelX = Math.max(CHANNEL_GUTTER_WIDTH + 8, Math.min(...points.map((point) => point.x)));
  drawOverlayLabel(ctx, labelX, 36, summaryText || 'Click second point', '#304657');
  ctx.restore();
}

// PyQt draw_scale_bar parity (main_waveform_plot_view.py ~736-779): vertical calibration bar
// with end caps + a "<N> µV" label inset at the bottom-right of the plot. The bar height equals
// one offset_value row spacing (model offset_value=6 → y_scale_length = y_100_length/stds), i.e.
// it spans exactly the on-screen height of y_100_length µV at the current vertical scale.
function drawPyqtScaleBar(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, rowHeight: number, showFiltered: boolean, normalizeVertically: boolean, amplitudeScale: number, plotHeight = pyqtPlotHeight(metrics)) {
  if (normalizeVertically) return; // PyQt only draws the µV calibration bar in native (un-normalized) scale.
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
  const microvolts = showFiltered ? PYQT_SCALE_BAR_UV_FILTERED : PYQT_SCALE_BAR_UV_RAW;
  const safeAmplitudeScale = Math.min(10, Math.max(0.25, Number(amplitudeScale) || 1));
  // WAVEFORM_TRACE_SCALE maps one display unit to pixels; PyQt z-scores the window so 1 display
  // unit ≈ 1 std. y_100_length µV maps to (y_100_length/stds) display units, which we approximate
  // against the row spacing so the bar reads as a calibrated fraction of a channel band.
  const barPixels = Math.max(8, Math.min(rowHeight * 0.92, WAVEFORM_TRACE_SCALE * safeAmplitudeScale * microvolts));
  const inset = Math.max(18, Math.round(pyqtPlotWidth(metrics, CHANNEL_GUTTER_WIDTH) * 0.028));
  const capHalfWidth = 5;
  const barX = Math.round(metrics.width - inset) + 0.5;
  const barBottom = Math.round(plotHeight - rowHeight * 0.35) + 0.5;
  const barTop = barBottom - barPixels;
  ctx.save();
  ctx.strokeStyle = PYQT_SCALE_BAR_LINE;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(barX, barTop);
  ctx.lineTo(barX, barBottom);
  ctx.moveTo(barX - capHalfWidth, barTop);
  ctx.lineTo(barX + capHalfWidth, barTop);
  ctx.moveTo(barX - capHalfWidth, barBottom);
  ctx.lineTo(barX + capHalfWidth, barBottom);
  ctx.stroke();
  ctx.font = '12px Inter, sans-serif';
  const label = `${microvolts} µV`;
  const textWidth = ctx.measureText(label).width;
  const labelRight = barX - capHalfWidth - 6;
  const labelX = Math.max(CHANNEL_GUTTER_WIDTH + 4, labelRight - textWidth - 8);
  const labelMidY = (barTop + barBottom) / 2;
  ctx.fillStyle = 'rgba(250, 252, 253, 0.93)';
  ctx.fillRect(labelX, labelMidY - 9, textWidth + 8, 18);
  ctx.strokeStyle = 'rgba(213, 221, 228, 1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(labelX + 0.5, labelMidY - 9 + 0.5, textWidth + 8, 18);
  ctx.fillStyle = PYQT_SCALE_BAR_LABEL;
  ctx.textBaseline = 'middle';
  ctx.fillText(label, labelX + 4, labelMidY + 1);
  ctx.restore();
}

function drawOverlayLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
  ctx.save();
  ctx.font = '12px Inter, sans-serif';
  const width = Math.min(340, Math.max(90, ctx.measureText(text).width + 16));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(x, y, width, 22);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.strokeRect(x, y, width, 22);
  ctx.fillStyle = color;
  ctx.fillText(text, x + 8, y + 15);
  ctx.restore();
}

function wheelNavigationFromEvent(event: ReactWheelEvent<HTMLCanvasElement>, sensitivity: WaveformTrackpadSensitivity, logicalWidth: number): WaveformWheelNavigation {
  const timeFromHorizontal = Math.abs(event.deltaX) > 0 ? wheelStepFromDelta(event.deltaX, sensitivity) : 0;
  const timeFromShiftVertical = event.shiftKey && Math.abs(event.deltaY) > 0 ? wheelStepFromDelta(event.deltaY, sensitivity) : 0;
  const zoomFromModifiedVertical = (event.ctrlKey || event.metaKey) && Math.abs(event.deltaY) > 0 ? wheelStepFromDelta(event.deltaY, sensitivity) : 0;
  const channelFromVertical = !event.shiftKey && !event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) > 0 ? wheelStepFromDelta(event.deltaY, sensitivity) : 0;
  return {
    timeSteps: timeFromHorizontal + timeFromShiftVertical,
    channelSteps: channelFromVertical,
    zoomSteps: zoomFromModifiedVertical,
    anchorRatio: wheelAnchorRatio(event, logicalWidth)
  };
}

function wheelAnchorRatio(event: ReactWheelEvent<HTMLCanvasElement>, logicalWidth: number): number {
  const rect = event.currentTarget.getBoundingClientRect();
  const canvasX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * logicalWidth;
  const plotWidth = Math.max(1, logicalWidth - CHANNEL_GUTTER_WIDTH);
  return Math.max(0, Math.min(1, (canvasX - CHANNEL_GUTTER_WIDTH) / plotWidth));
}

function wheelStepFromDelta(delta: number, sensitivity: WaveformTrackpadSensitivity): number {
  const profile = TRACKPAD_WHEEL_PROFILES[sensitivity] || TRACKPAD_WHEEL_PROFILES.default;
  const absoluteDelta = Math.abs(delta);
  if (absoluteDelta < profile.threshold) return 0;
  const magnitude = Math.max(1, Math.min(profile.maxSteps, Math.round(absoluteDelta / profile.unit)));
  return delta < 0 ? magnitude : -magnitude;
}

function drawEventOverlays(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, windowData: WaveformWindow, eventOverlays: WaveformEventOverlay[], selectedEventId: string, hoveredEventId: string, plotLeft = 0, plotHeight = pyqtPlotHeight(metrics)): OverlayHitRegion[] {
  const regions: OverlayHitRegion[] = [];
  if (!eventOverlays.length || !windowData.times_seconds.length) return regions;
  const start = windowData.times_seconds[0] ?? 0;
  const end = windowData.times_seconds[windowData.times_seconds.length - 1] ?? start + 1;
  const duration = Math.max(1e-6, end - start);
  const rowHeight = plotHeight / Math.max(1, windowData.channels.length);
  const plotWidth = pyqtPlotWidth(metrics, plotLeft);
  for (const overlay of eventOverlays) {
    const event = overlay.event;
    const channelIndex = windowData.channels.findIndex((channel) => channel === event.channel);
    if (channelIndex < 0) continue;
    const eventStart = Number(event.start_seconds);
    const eventEnd = Number(event.end_seconds ?? event.start_seconds);
    if (!Number.isFinite(eventStart) || !Number.isFinite(eventEnd) || eventEnd < start || eventStart > end) continue;
    const x1 = plotLeft + ((Math.max(start, eventStart) - start) / duration) * plotWidth;
    const x2 = plotLeft + ((Math.min(end, eventEnd) - start) / duration) * plotWidth;
    const left = Math.min(x1, x2);
    const eventWidth = Math.max(0, x2 - x1);
    const y = channelIndex * rowHeight;
    const height = Math.max(8, rowHeight - 4);
    const highlighted = event.event_id === selectedEventId || event.event_id === hoveredEventId;
    // PyHFO parity (main_waveform_plot_controller.py): an HFO event reads as a VISIBLE colored band
    // on the channel lane plus a solid marker bar along the top of the lane — not two hairline edges
    // (which were nearly invisible). Min widths keep a few-millisecond event legible at a wide window.
    const bandWidth = Math.max(eventWidth, 3);
    // 1) translucent class-colored fill across the event, on this channel's lane.
    ctx.fillStyle = overlayColor(overlay, highlighted ? 0.3 : 0.16);
    ctx.fillRect(left, y + 2, bandWidth, height);
    // 2) solid marker bar along the top of the lane (PyHFO marker_width), min ~6px so short events show.
    ctx.fillStyle = overlayColor(overlay, highlighted ? 1 : 0.9);
    ctx.fillRect(left, y + 1, Math.max(eventWidth, 6), highlighted ? 4 : 3);
    // 3) crisp onset line at the event start for precise localization.
    ctx.strokeStyle = overlayColor(overlay, highlighted ? 0.85 : 0.62);
    ctx.lineWidth = highlighted ? 1.6 : 1.1;
    ctx.beginPath();
    ctx.moveTo(x1, y + 2);
    ctx.lineTo(x1, y + height);
    ctx.stroke();
    const hitX = Math.max(plotLeft, left - PYQT_EVENT_MARKER_HIT_WIDTH / 2);
    regions.push({ overlay, x: hitX, y: y + 2, width: Math.max(bandWidth, PYQT_EVENT_MARKER_HIT_WIDTH), height });
  }
  return regions;
}


function pyqtPlotHeight(metrics: CanvasMetrics): number {
  return Math.max(80, metrics.height - PYQT_TIME_AXIS_HEIGHT);
}

function pyqtPlotWidth(metrics: CanvasMetrics, plotLeft: number): number {
  return Math.max(1, metrics.width - plotLeft);
}

function drawPyqtTimeAxis(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, windowData: WaveformWindow, plotLeft: number, plotHeight = pyqtPlotHeight(metrics)) {
  if (!windowData.times_seconds.length) return;
  const start = Number(windowData.times_seconds[0] || 0);
  const end = Number(windowData.times_seconds[windowData.times_seconds.length - 1] ?? start);
  const duration = Math.max(0, end - start);
  const plotWidth = pyqtPlotWidth(metrics, plotLeft);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, plotHeight, metrics.width, metrics.height - plotHeight);
  ctx.strokeStyle = PYQT_WAVEFORM_AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plotLeft, plotHeight + 0.5);
  ctx.lineTo(metrics.width, plotHeight + 0.5);
  ctx.stroke();
  ctx.font = '13px Inter, sans-serif';
  ctx.fillStyle = PYQT_WAVEFORM_LABEL;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  // One decision for the whole axis: mixing 59:59 with 1:00:00 mid-row reads as two different
  // scales, so the hour field is either on for every tick or off for all of them.
  const showHours = end >= 3600;
  const firstWholeSecond = Math.ceil(start);
  const lastWholeSecond = Math.floor(end);
  const ticks = Array.from({ length: Math.max(0, lastWholeSecond - firstWholeSecond + 1) }, (_, index) => firstWholeSecond + index)
    .filter((tick) => tick > start && tick < end);
  for (const tick of ticks) {
    const ratio = duration > 0 ? (tick - start) / duration : 0;
    const x = plotLeft + ratio * plotWidth;
    ctx.strokeStyle = PYQT_WAVEFORM_AXIS;
    ctx.beginPath();
    ctx.moveTo(x, plotHeight + 1);
    ctx.lineTo(x, plotHeight + 6);
    ctx.stroke();
    ctx.fillText(formatPyqtTimeTick(tick, showHours), x, plotHeight + 10);
  }
  ctx.textAlign = 'start';
  ctx.restore();
}

/**
 * Clock time, not a raw second count. A bare '3600' on the axis of an hours-long study tells a
 * reader nothing they can match against the recording; 1:00:00 does. Hours appear only once the
 * recording reaches them, so a short study keeps the compact m:ss form.
 */
function formatPyqtTimeTick(seconds: number, showHours: boolean): string {
  const whole = Math.floor(Math.abs(seconds));
  const fraction = Math.abs(seconds) - whole;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  // Sub-second ticks only appear on windows short enough to have them, and there the tenth is the
  // whole point of the label.
  const tail = fraction > 0.001 ? `.${Math.round(fraction * 10)}` : '';
  if (showHours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${tail}`;
  return `${minutes}:${String(secs).padStart(2, '0')}${tail}`;
}

function drawPyqtWaveformBackground(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, windowData: WaveformWindow, plotLeft: number, plotHeight = pyqtPlotHeight(metrics)) {
  ctx.save();
  ctx.fillStyle = PYQT_WAVEFORM_BACKGROUND;
  ctx.fillRect(0, 0, metrics.width, metrics.height);
  const rowHeight = plotHeight / Math.max(1, windowData.channels.length);
  ctx.strokeStyle = PYQT_WAVEFORM_GRID;
  ctx.lineWidth = 1;
  for (let row = 1; row < windowData.channels.length; row += 1) {
    const y = Math.round(row * rowHeight) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(metrics.width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = PYQT_WAVEFORM_AXIS;
  ctx.beginPath();
  ctx.moveTo(plotLeft, Math.round(plotHeight) + 0.5);
  ctx.lineTo(metrics.width, Math.round(plotHeight) + 0.5);
  ctx.stroke();
  ctx.restore();
}

function drawChannelGutter(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, windowData: WaveformWindow, selectedChannel: string, hoveredChannel: string, plotHeight = pyqtPlotHeight(metrics)): ChannelHitRegion[] {
  const regions: ChannelHitRegion[] = [];
  const rowHeight = plotHeight / Math.max(1, windowData.channels.length);
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CHANNEL_GUTTER_WIDTH, plotHeight);
  ctx.strokeStyle = PYQT_WAVEFORM_AXIS;
  ctx.beginPath();
  ctx.moveTo(CHANNEL_GUTTER_WIDTH - 0.5, 0);
  ctx.lineTo(CHANNEL_GUTTER_WIDTH - 0.5, plotHeight);
  ctx.stroke();
  ctx.font = '12px Inter, sans-serif';
  windowData.channels.forEach((channel, index) => {
    const y = index * rowHeight;
    const active = channel === selectedChannel;
    const hovered = channel === hoveredChannel;
    if (active || hovered) {
      ctx.fillStyle = active ? 'rgba(191, 219, 254, 0.24)' : 'rgba(226, 232, 240, 0.42)';
      ctx.fillRect(0, y, 4, rowHeight);
    }
    ctx.fillStyle = PYQT_WAVEFORM_LABEL;
    ctx.fillText(elideChannelLabel(channel, 12), 8, y + rowHeight / 2 + 4);
    regions.push({ channel, x: 0, y, width: CHANNEL_GUTTER_WIDTH, height: rowHeight });
  });
  ctx.restore();
  return regions;
}

function elideChannelLabel(label: string, maxLength: number): string {
  const display = displayChannelName(label);
  return display.length > maxLength ? `${display.slice(0, Math.max(1, maxLength - 1))}…` : display;
}

function drawOverlayLegend(ctx: CanvasRenderingContext2D, metrics: CanvasMetrics, eventOverlays: WaveformEventOverlay[]) {
  if (!eventOverlays.length) return;
  const visibleRuns = Array.from(new Set(eventOverlays.map((overlay) => overlay.event.run_id).filter(Boolean)));
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.fillRect(CHANNEL_GUTTER_WIDTH + 8, 8, 190, 24);
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)';
  ctx.strokeRect(CHANNEL_GUTTER_WIDTH + 8, 8, 190, 24);
  ctx.fillStyle = '#334155';
  ctx.font = '12px Inter, sans-serif';
  ctx.fillText(`${visibleRuns.length} visible run overlay(s)`, CHANNEL_GUTTER_WIDTH + 16, 24);
}

// Per-event-type color (PyQt model._resolve_event_color, main_waveform_plot_model.py ~353-365):
// classify the event by its clinical type/features (artifact, spike/non_spike, eHFO, …) and color
// the overlay accordingly. Run-state styling (accepted/active/consensus) remains the fallback when
// the event has no resolvable clinical type.
export function overlayColor(overlay: WaveformEventOverlay, alpha: number): string {
  const eventTypeColor = resolveEventTypeColor(overlay.event);
  if (eventTypeColor) return applyEventColorAlpha(eventTypeColor, alpha);
  return runStateOverlayColor(overlay, alpha);
}

function runStateOverlayColor(overlay: WaveformEventOverlay, alpha: number): string {
  if (overlay.accepted) return `rgba(51, 65, 85, ${alpha})`;
  if (overlay.active) return `rgba(59, 130, 246, ${alpha})`;
  if (overlay.run?.detector.toLowerCase().startsWith('consensus')) return `rgba(88, 80, 141, ${alpha})`;
  return `rgba(71, 85, 105, ${alpha})`;
}

function applyEventColorAlpha(style: WaveformEventColorStyle, alpha: number): string {
  return `rgba(${style.r}, ${style.g}, ${style.b}, ${alpha})`;
}

// Categorical color BY BIOMARKER (HFO vs Spindle vs Spike) for the full-recording
// event map. The main canvas colors by clinical event type (artifact/spike/eHFO);
// the overview strip instead answers "where do these biomarkers co-localize?", so
// every tick from one run reads as a single biomarker hue regardless of class.
// Maximally-separated categorical hues (warm red vs cool blue vs amber) so thin
// 1.5px ticks on the light strip read as obviously different biomarkers. The
// window-position band is neutral gray (see WaveformOverview) so blue never clashes.
const BIOMARKER_OVERLAY_COLORS: { hfo: WaveformEventColorStyle; spindle: WaveformEventColorStyle; spike: WaveformEventColorStyle } = {
  hfo: { r: 225, g: 29, b: 72 },      // red (rose-600)
  spindle: { r: 37, g: 99, b: 235 },  // blue (blue-600)
  spike: { r: 245, g: 158, b: 11 }    // amber (amber-500)
};
const BIOMARKER_OVERLAY_FALLBACK: WaveformEventColorStyle = { r: 100, g: 116, b: 139 }; // slate

function biomarkerOverlayStyle(biomarker: string): WaveformEventColorStyle {
  const key = biomarker.toLowerCase();
  if (key.includes('hfo') || key.includes('ripple')) return BIOMARKER_OVERLAY_COLORS.hfo;
  if (key.includes('spindle')) return BIOMARKER_OVERLAY_COLORS.spindle;
  if (key.includes('spike')) return BIOMARKER_OVERLAY_COLORS.spike;
  return BIOMARKER_OVERLAY_FALLBACK;
}

export function biomarkerOverlayColor(overlay: WaveformEventOverlay, alpha: number): string {
  return applyEventColorAlpha(biomarkerOverlayStyle(String(overlay.run?.biomarker || '')), alpha);
}

// Distinct biomarkers present in the visible overlays, in first-seen order, with a
// solid swatch color — feeds the overview legend so the hues are self-documenting.
export function biomarkerOverlayLegend(eventOverlays: WaveformEventOverlay[]): Array<{ label: string; color: string }> {
  const seen = new Map<string, string>();
  for (const overlay of eventOverlays) {
    const raw = String(overlay.run?.biomarker || '').trim();
    if (!raw || seen.has(raw.toLowerCase())) continue;
    seen.set(raw.toLowerCase(), raw);
  }
  return Array.from(seen.values()).map((label) => ({ label, color: applyEventColorAlpha(biomarkerOverlayStyle(label), 1) }));
}
