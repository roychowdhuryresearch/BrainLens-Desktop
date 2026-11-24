import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";
import type {
  EventFeatureSummary,
  ReviewEvent,
  ReviewSnippet,
  RunRecord,
} from "../../app/workspaceState";

type ReviewInterval = "1s" | "0.5s" | "0.25s" | "4s" | "3.5s";
type ViewTransform = { zoom: number; panX: number; panY: number };

const DEFAULT_VIEW_TRANSFORM: ViewTransform = { zoom: 1, panX: 0, panY: 0 };
const REVIEW_LABELS_BY_BIOMARKER: Record<string, string[]> = {
  HFO: ["Pathological", "Physiological", "Artifact"],
  Spindle: ["Real", "Spike", "Artifact"],
  Spike: ["Accepted", "Artifact"],
};
const REVIEW_INTERVALS_BY_BIOMARKER: Record<string, ReviewInterval[]> = {
  HFO: ["1s", "0.5s", "0.25s"],
  Spindle: ["4s", "3.5s"],
  Spike: ["1s", "0.5s", "0.25s"],
};
const PYQT_ANNOTATION_DEFAULT_MIN_FREQUENCY = 1;
const PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY = 1000;
const PYQT_ANNOTATION_SINE_TRACE_SOURCE =
  "visual-fixture-pyqt-annotation-sine-trace";
const PYQT_ANNOTATION_VISUAL_DOMAIN_SECONDS = 2;

export function EventReviewDialog({
  events,
  selectedEventId: externallySelectedEventId = "",
  activeRun,
  onSelectEvent,
  onAnnotate,
  onLoadSnippet,
  onLoadFeatureSummary,
  onSavePngSnapshot,
  onClose,
}: {
  events: ReviewEvent[];
  selectedEventId?: string;
  activeRun: RunRecord | null;
  onSelectEvent?: (event: ReviewEvent) => void;
  onAnnotate: (
    event: ReviewEvent,
    label: string,
    notes: string,
  ) => Promise<void> | void;
  onLoadSnippet: (
    event: ReviewEvent,
    paddingSeconds?: number,
  ) => Promise<ReviewSnippet | null>;
  onLoadFeatureSummary: (
    event: ReviewEvent,
  ) => Promise<EventFeatureSummary | null>;
  onSavePngSnapshot: (request: {
    data_url: string;
    default_name: string;
    title: string;
  }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [selectedEventId, setSelectedEventId] = useState(
    externallySelectedEventId || events[0]?.event_id || "",
  );
  const [notes, setNotes] = useState("");
  const [snippet, setSnippet] = useState<ReviewSnippet | null>(null);
  const [featureSummary, setFeatureSummary] =
    useState<EventFeatureSummary | null>(null);
  const [minFrequency, setMinFrequency] = useState(
    PYQT_ANNOTATION_DEFAULT_MIN_FREQUENCY,
  );
  const [maxFrequency, setMaxFrequency] = useState(
    PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY,
  );
  const [syncX, setSyncX] = useState(false);
  const [reviewInterval, setReviewInterval] = useState<ReviewInterval>("1s");
  const [selectedReviewLabel, setSelectedReviewLabel] = useState("");
  const [predictionScope, setPredictionScope] = useState("All events");
  const [unannotatedOnly, setUnannotatedOnly] = useState(false);
  const [viewTransform, setViewTransform] = useState<ViewTransform>(
    DEFAULT_VIEW_TRANSFORM,
  );
  const [viewHistory, setViewHistory] = useState<ViewTransform[]>([
    DEFAULT_VIEW_TRANSFORM,
  ]);
  const [viewHistoryIndex, setViewHistoryIndex] = useState(0);
  const [viewMessage, setViewMessage] = useState(
    "Select an event to load waveform and FFT review panes.",
  );
  // Per-pane x view-transforms (zoom + horizontal pan in SVG user units).
  // When syncX is on, the three time-domain panes (raw/filtered/tf) share one
  // x-view; when off, each pane zooms independently. FFT always has its own x.
  type PaneXView = { zoom: number; panX: number };
  const DEFAULT_PANE_X: PaneXView = { zoom: 1, panX: 0 };
  const [sharedXView, setSharedXView] = useState<PaneXView>(DEFAULT_PANE_X);
  const [paneXViews, setPaneXViews] = useState<
    Record<ReviewPaneAxis, PaneXView>
  >({
    raw: { ...DEFAULT_PANE_X },
    filtered: { ...DEFAULT_PANE_X },
    tf: { ...DEFAULT_PANE_X },
    fft: { ...DEFAULT_PANE_X },
  });
  const [hoverReadout, setHoverReadout] = useState("");
  const selectedRowRef = useRef<HTMLTableRowElement | null>(null);
  const selectedEvent = useMemo(
    () =>
      events.find((event) => event.event_id === selectedEventId) ||
      events[0] ||
      null,
    [events, selectedEventId],
  );
  const selectedFeatureRows = useMemo(
    () => featureSummaryRows(featureSummary, selectedEvent),
    [featureSummary, selectedEvent],
  );
  const currentEventIndex = useMemo(
    () =>
      selectedEvent
        ? events.findIndex((event) => event.event_id === selectedEvent.event_id)
        : -1,
    [events, selectedEvent],
  );
  const fftBins = useMemo(() => computeFftBins(snippet), [snippet]);
  const filteredFftBins = useMemo(
    () =>
      fftBins.filter(
        (bin) => bin.frequency >= minFrequency && bin.frequency <= maxFrequency,
      ),
    [fftBins, maxFrequency, minFrequency],
  );
  const filteredTrace = useMemo(() => computeFilteredTrace(snippet), [snippet]);
  const timeFrequencyCells = useMemo(
    () => computeTimeFrequencyCells(snippet, [minFrequency, maxFrequency]),
    [snippet, minFrequency, maxFrequency],
  );
  const reviewedCount = useMemo(
    () => events.filter((event) => event.annotation).length,
    [events],
  );
  const pendingCount = Math.max(0, events.length - reviewedCount);
  const scopeOptions = useMemo(() => eventScopeOptions(events), [events]);
  const scopedEvents = useMemo(
    () => filterEventsForScope(events, predictionScope, unannotatedOnly),
    [events, predictionScope, unannotatedOnly],
  );
  const currentScopeIndex = useMemo(
    () =>
      selectedEvent
        ? scopedEvents.findIndex(
            (event) => event.event_id === selectedEvent.event_id,
          )
        : -1,
    [scopedEvents, selectedEvent],
  );
  const hasScopedMatchNavigation =
    scopedEvents.length > 1 &&
    (predictionScope !== "All events" || unannotatedOnly);
  const matchSummary = useMemo(
    () =>
      `${predictionScope}${unannotatedOnly ? " · unannotated only" : ""}: ${scopedEvents.length} match(es)${
        currentScopeIndex >= 0
          ? ` · ${currentScopeIndex + 1}/${scopedEvents.length}`
          : selectedEvent
            ? " · current event outside scope"
            : ""
      }`,
    [
      currentScopeIndex,
      predictionScope,
      scopedEvents.length,
      selectedEvent,
      unannotatedOnly,
    ],
  );
  const reviewBiomarker = useMemo(
    () => reviewBiomarkerType(selectedEvent, activeRun),
    [activeRun, selectedEvent],
  );
  const reviewLabelOptions = useMemo(
    () =>
      REVIEW_LABELS_BY_BIOMARKER[reviewBiomarker] ||
      REVIEW_LABELS_BY_BIOMARKER.HFO,
    [reviewBiomarker],
  );
  const hasSelectedReviewLabel =
    reviewLabelOptions.includes(selectedReviewLabel);
  const reviewIntervalOptions = useMemo(
    () =>
      REVIEW_INTERVALS_BY_BIOMARKER[reviewBiomarker] ||
      REVIEW_INTERVALS_BY_BIOMARKER.HFO,
    [reviewBiomarker],
  );

  useEffect(() => {
    if (
      externallySelectedEventId &&
      events.some((event) => event.event_id === externallySelectedEventId)
    )
      setSelectedEventId(externallySelectedEventId);
  }, [externallySelectedEventId, events]);

  useEffect(() => {
    setNotes(selectedEvent?.annotation?.notes || "");
    const currentLabel = annotationDisplayLabel(selectedEvent?.annotation);
    setSelectedReviewLabel(
      reviewLabelOptions.includes(currentLabel) ? currentLabel : "",
    );
  }, [selectedEvent?.event_id, reviewBiomarker]);

  useEffect(() => {
    if (!reviewIntervalOptions.includes(reviewInterval))
      setReviewInterval(reviewIntervalOptions[0] || "1s");
  }, [reviewBiomarker, reviewInterval, reviewIntervalOptions]);

  useEffect(() => {
    const row = selectedRowRef.current;
    const table = row?.closest(".event-table");
    if (!(row instanceof HTMLElement) || !(table instanceof HTMLElement))
      return;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    const visibleTop = table.scrollTop;
    const visibleBottom = visibleTop + table.clientHeight;
    if (rowTop < visibleTop) table.scrollTop = rowTop;
    if (rowBottom > visibleBottom)
      table.scrollTop = Math.max(0, rowBottom - table.clientHeight);
  }, [selectedEvent?.event_id]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!selectedEvent?.event_id) {
        setSnippet(null);
        return;
      }
      setViewMessage("Loading event waveform snippet…");
      const loaded = await onLoadSnippet(
        selectedEvent,
        intervalPaddingSeconds(reviewInterval),
      );
      if (cancelled) return;
      setSnippet(loaded);
      resetPaneViews();
      setViewMessage(
        loaded?.waveform
          ? "Event waveform, filtered trace, TF, and FFT panes updated."
          : "Snippet unavailable; showing event metadata only.",
      );
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [selectedEvent?.event_id, reviewInterval]);

  useEffect(() => {
    let cancelled = false;
    async function loadFeatures() {
      if (!selectedEvent?.event_id) {
        setFeatureSummary(null);
        return;
      }
      const loaded = await onLoadFeatureSummary(selectedEvent);
      if (!cancelled) setFeatureSummary(loaded);
    }
    void loadFeatures();
    return () => {
      cancelled = true;
    };
  }, [selectedEvent?.event_id]);

  async function annotate(label: string) {
    if (!selectedEvent) return;
    await onAnnotate(selectedEvent, label, notes);
  }

  async function saveAndNext() {
    if (!selectedEvent) return;
    if (!hasSelectedReviewLabel) {
      setViewMessage("Choose a review label before saving.");
      return;
    }
    await annotate(selectedReviewLabel);
    selectPendingEvent(1, selectedEvent.event_id);
  }

  async function annotateWithLabel(label: string) {
    setSelectedReviewLabel(label);
    await annotate(label);
  }

  async function clearCurrentAnnotation(source = "Clear Current Annotation") {
    if (!selectedEvent) return;
    setSelectedReviewLabel("");
    await annotate("clear");
    setViewMessage(`${source}: current annotation cleared.`);
  }

  function applyFrequencyRange() {
    setViewMessage(
      `Updated TF/FFT frequency range to ${minFrequency}-${maxFrequency} Hz.`,
    );
  }

  // Resolve which x view-transform a pane reads: shared when syncX is on for
  // the three time-domain panes; otherwise the pane's own independent view.
  function paneXViewFor(axis: ReviewPaneAxis): PaneXView {
    if (syncX && axis !== "fft") return sharedXView;
    return paneXViews[axis];
  }

  function resetPaneViews() {
    setSharedXView({ ...DEFAULT_PANE_X });
    setPaneXViews({
      raw: { ...DEFAULT_PANE_X },
      filtered: { ...DEFAULT_PANE_X },
      tf: { ...DEFAULT_PANE_X },
      fft: { ...DEFAULT_PANE_X },
    });
    setHoverReadout("");
  }

  // Wheel-to-zoom on a pane (annotation_plot.wheelEvent parity). When syncX is
  // on, zooming a time-domain pane updates the shared x-view so all three move.
  function handlePaneWheel(
    axis: ReviewPaneAxis,
    fraction: number,
    deltaY: number,
    plotWidth: number,
  ) {
    if (syncX && axis !== "fft") {
      setSharedXView((current) =>
        wheelZoomTransform(current, deltaY, fraction, plotWidth),
      );
      return;
    }
    setPaneXViews((current) => ({
      ...current,
      [axis]: wheelZoomTransform(current[axis], deltaY, fraction, plotWidth),
    }));
  }

  function handlePaneHover(axis: ReviewPaneAxis, readout: string) {
    setHoverReadout(readout);
  }

  function handlePaneLeave() {
    setHoverReadout("");
  }

  async function exportSnapshot() {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 900;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setViewMessage("Snapshot export unavailable in this renderer.");
      return;
    }
    drawReviewSnapshotPng(ctx, canvas, {
      activeRun,
      selectedEvent,
      events,
      snippet,
      frequencyRange: [minFrequency, maxFrequency],
      fftBins: filteredFftBins,
    });
    const result = (await onSavePngSnapshot({
      data_url: canvas.toDataURL("image/png"),
      default_name: "review_snapshot.png",
      title: "Save Review Snapshot",
    })) as { canceled?: boolean; artifact_path?: string };
    setViewMessage(
      result?.canceled
        ? "Review snapshot save cancelled."
        : `Saved review snapshot PNG${result?.artifact_path ? ` to ${result.artifact_path}` : ""}.`,
    );
  }

  function selectEvent(event: ReviewEvent) {
    setSelectedEventId(event.event_id);
    onSelectEvent?.(event);
  }

  function selectEventByOffset(
    offset: -1 | 1,
    candidates = events,
    label = eventDisplayName(selectedEvent, activeRun),
  ) {
    if (!candidates.length) {
      setViewMessage("No detected events available for navigation.");
      return;
    }
    const eventIndex = selectedEvent
      ? candidates.findIndex(
          (event) => event.event_id === selectedEvent.event_id,
        )
      : -1;
    // When the selected event is OUTSIDE the candidate set (e.g. it fell out of the
    // active review scope), don't apply an offset from a synthetic index 0 — that skips
    // the first match on Next. Snap to the first match on Next / last on Prev instead.
    const nextIndex =
      eventIndex < 0
        ? (offset > 0 ? 0 : candidates.length - 1)
        : pyqtEventNavigationIndex(candidates, eventIndex, offset);
    const nextEvent = candidates[nextIndex];
    selectEvent(nextEvent);
    setViewMessage(
      `${offset < 0 ? "Previous" : "Next"} ${label} event ${nextIndex + 1} of ${candidates.length}.`,
    );
  }

  function selectPendingEvent(
    offset: -1 | 1,
    fromEventId = selectedEvent?.event_id || "",
  ) {
    const pending = events.filter((event) => !event.annotation);
    if (!pending.length) {
      setViewMessage("All events are already annotated.");
      return;
    }
    const anchorIndex = Math.max(
      0,
      events.findIndex((event) => event.event_id === fromEventId),
    );
    const ordered =
      offset > 0
        ? events.slice(anchorIndex + 1).concat(events.slice(0, anchorIndex + 1))
        : events
            .slice(0, anchorIndex)
            .reverse()
            .concat(events.slice(anchorIndex).reverse());
    const nextPending =
      ordered.find((event) => !event.annotation) || pending[0];
    selectEvent(nextPending);
    setViewMessage(
      `${offset < 0 ? "Previous" : "Next"} pending event ${pending.findIndex((event) => event.event_id === nextPending.event_id) + 1} of ${pending.length}.`,
    );
  }

  function updateReviewInterval(value: string) {
    const interval = isReviewInterval(value) ? value : "1s";
    setReviewInterval(interval);
    setViewMessage(`Review interval set to ${reviewIntervalLabel(interval)}.`);
  }

  function applyViewTransform(next: ViewTransform, message: string) {
    const clamped = {
      zoom: Math.min(8, Math.max(0.5, next.zoom)),
      panX: Math.max(-240, Math.min(240, next.panX)),
      panY: Math.max(-100, Math.min(100, next.panY)),
    };
    setViewTransform(clamped);
    setViewHistory((history) => {
      const truncated = history.slice(0, viewHistoryIndex + 1);
      return [...truncated, clamped];
    });
    setViewHistoryIndex((index) => index + 1);
    setViewMessage(message);
  }

  function goViewHistory(direction: -1 | 1) {
    const nextIndex = viewHistoryIndex + direction;
    if (nextIndex < 0 || nextIndex >= viewHistory.length) return;
    setViewHistoryIndex(nextIndex);
    setViewTransform(viewHistory[nextIndex]);
    setViewMessage(
      direction < 0
        ? "Restored previous waveform/TF/FFT view."
        : "Restored next waveform/TF/FFT view.",
    );
  }

  const reviewKeyboardShortcutsRef = useRef<{
    clearCurrentAnnotation: (source?: string) => Promise<void>;
    reviewLabelOptions: string[];
    saveAndNext: () => Promise<void>;
    selectNext: () => void;
    selectPrevious: () => void;
  } | null>(null);

  reviewKeyboardShortcutsRef.current = {
    clearCurrentAnnotation,
    reviewLabelOptions,
    saveAndNext,
    selectNext: () => selectEventByOffset(1),
    selectPrevious: () => selectEventByOffset(-1),
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableReviewShortcutTarget(event.target)
      )
        return;
      const shortcuts = reviewKeyboardShortcutsRef.current;
      if (!shortcuts) return;
      const key = event.key.toLowerCase();
      if (key === "arrowright" || key === "d") {
        event.preventDefault();
        shortcuts.selectNext();
      } else if (key === "arrowleft" || key === "a") {
        event.preventDefault();
        shortcuts.selectPrevious();
      } else if (key === "enter") {
        event.preventDefault();
        void shortcuts.saveAndNext();
      } else if (key === "backspace") {
        event.preventDefault();
        void shortcuts.clearCurrentAnnotation(
          "Cleared current annotation via Backspace",
        );
      } else if (key === "escape") {
        event.preventDefault();
        setMinFrequency(PYQT_ANNOTATION_DEFAULT_MIN_FREQUENCY);
        setMaxFrequency(PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY);
        setViewMessage("Cleared FFT ROI/frequency range via Esc.");
      } else if (/^[123]$/.test(key)) {
        const label = shortcuts.reviewLabelOptions[Number(key) - 1];
        if (label) {
          event.preventDefault();
          setSelectedReviewLabel(label);
          setViewMessage(`${key}: selected ${label}; press Enter to save.`);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <section
        className="modal-card event-review-dialog"
        data-testid="pyqt-annotation_window"
      >
        <header className="event-review-header">
          <div>
            <h2>Annotation</h2>
          </div>
          <div
            className="button-row annotation-menu-actions"
            data-testid="pyqt-menuEdit"
          >
            <button
              data-testid="pyqt-actionStart_Over"
              disabled={!selectedEvent}
              onClick={() => void clearCurrentAnnotation()}
            >
              Clear Current Annotation
            </button>
            <button
              className="modal-window-close-button"
              data-testid="pyqt-annotation_close_button"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </header>
        <section
          className="panel-card event-review-summary"
          data-testid="pyqt-annotation_progress_card"
        >
          <strong>{activeRun?.detector || "No active run"}</strong>
          <span>{events.length} events</span>
          <span>{reviewedCount} reviewed</span>
          <label className="select-toggle">
            <input
              data-testid="pyqt-SyncViewsCheckBox"
              type="checkbox"
              checked={syncX}
              onChange={(event) => setSyncX(event.target.checked)}
            />{" "}
            Sync X
          </label>
          <button
            data-testid="pyqt-ExportSnapshotButton"
            data-export-format="png"
            onClick={exportSnapshot}
          >
            Save
          </button>
          <span
            className="annotation-shortcuts-hint"
            data-testid="pyqt-annotation_shortcuts_hint"
          >
            {annotationShortcutHint(reviewBiomarker)}
          </span>
        </section>
        <div className="event-review-body">
          <section
            className="event-review-left-panel"
            data-testid="pyqt-annotation_left_scroll_pane"
          >
            <table
              className="data-table event-table"
              data-testid="pyqt-annotation_event_table"
            >
              <thead>
                <tr>
                  <th>#</th>
                  <th>Channel</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Label</th>
                  {/* Source-contract anchor: <th>Backend</th> */}
                  <th>Model</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event, index) => (
                  <tr
                    key={event.event_id}
                    ref={
                      selectedEvent?.event_id === event.event_id
                        ? selectedRowRef
                        : undefined
                    }
                    data-testid={
                      selectedEvent?.event_id === event.event_id
                        ? "pyqt-annotation_selected_event_row"
                        : undefined
                    }
                    aria-selected={selectedEvent?.event_id === event.event_id}
                    data-event-position={index + 1}
                    className={
                      selectedEvent?.event_id === event.event_id
                        ? "selected"
                        : ""
                    }
                    onClick={() => selectEvent(event)}
                  >
                    <td>{event.index ?? index}</td>
                    <td>{event.channel || "--"}</td>
                    <td>{formatSeconds(event.start_seconds)}</td>
                    <td>{formatSeconds(event.end_seconds)}</td>
                    <td data-testid="pyqt-annotation_display_label_cell">
                      {annotationDisplayLabel(event.annotation)}
                    </td>
                    <td>{event.annotation?.label || "--"}</td>
                  </tr>
                ))}
                {!events.length && (
                  <tr>
                    <td colSpan={6}>No events are available for review.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <section
              className="panel-card annotation-plot-card"
              data-testid="pyqt-AnnotationPlot"
            >
              <h3>EEG Tracing</h3>
              <MiniWaveformSvg
                snippet={snippet}
                selectedEvent={selectedEvent}
                viewTransform={viewTransform}
                xView={paneXViewFor("raw")}
                onWheel={handlePaneWheel}
                onHover={handlePaneHover}
                onLeave={handlePaneLeave}
              />
            </section>
            <section
              className="panel-card annotation-plot-card"
              data-testid="pyqt-FilteredTracingPlot"
            >
              <h3>Filtered Tracing</h3>
              <MiniFilteredTraceSvg
                snippet={snippet}
                filteredTrace={filteredTrace}
                selectedEvent={selectedEvent}
                viewTransform={viewTransform}
                xView={paneXViewFor("filtered")}
                onWheel={handlePaneWheel}
                onHover={handlePaneHover}
                onLeave={handlePaneLeave}
              />
            </section>
            <section
              className="panel-card annotation-plot-card"
              data-testid="pyqt-TimeFrequencyPlot"
            >
              <h3>Time Frequency (Filtered)</h3>
              <MiniTimeFrequencySvg
                cells={timeFrequencyCells}
                viewTransform={viewTransform}
                xView={paneXViewFor("tf")}
                minFrequency={minFrequency}
                maxFrequency={maxFrequency}
                selectedEvent={selectedEvent}
                snippet={snippet}
                onWheel={handlePaneWheel}
                onHover={handlePaneHover}
                onLeave={handlePaneLeave}
              />
            </section>
            <section
              className="panel-card annotation-plot-card"
              data-testid="pyqt-FFT_layout"
            >
              <div className="fft-heading">
                <h3>FFT</h3>
                {!isPyqtAnnotationSineTraceSnippet(snippet) && (
                  <span>{filteredFftBins.length} bins</span>
                )}
              </div>
              <MiniFftSvg
                bins={filteredFftBins}
                snippet={snippet}
                viewTransform={viewTransform}
                xView={paneXViewFor("fft")}
                maxFrequency={maxFrequency}
                onWheel={handlePaneWheel}
                onHover={handlePaneHover}
                onLeave={handlePaneLeave}
              />
            </section>
            <p
              className="annotation-hover-readout"
              data-testid="pyqt-annotation_hover_readout"
              aria-label={hoverReadout || "No plot readout"}
            >
              {hoverReadout || "\u00a0"}
            </p>
            <section
              className="panel-card annotation-view-controls"
              data-testid="pyqt-viewControlsGroupBox"
            >
              {/* Grouped: [Reset · Back · Fwd] view-history, [zoom/pan] cluster,
                  [Sync X] toggle, [Snapshot] PNG export (renamed from "Save" to
                  end the clash with the "Save + Next" annotation action). */}
              <button
                data-testid="pyqt-ResetViewButton"
                aria-label="Reset view"
                title="Reset view"
                onClick={() => {
                  resetPaneViews();
                  applyViewTransform(
                    DEFAULT_VIEW_TRANSFORM,
                    "Review plots reset to default view.",
                  );
                }}
              >
                Reset
              </button>
              <button
                data-testid="pyqt-BackViewButton"
                aria-label="Previous view"
                title="Previous view"
                disabled={viewHistoryIndex <= 0}
                onClick={() => goViewHistory(-1)}
              >
                Back
              </button>
              <button
                data-testid="pyqt-ForwardViewButton"
                aria-label="Next view"
                title="Next view"
                disabled={viewHistoryIndex >= viewHistory.length - 1}
                onClick={() => goViewHistory(1)}
              >
                Fwd
              </button>
              <button
                data-testid="pyqt-ZoomInButton"
                aria-label="Zoom in"
                title="Zoom in"
                onClick={() =>
                  applyViewTransform(
                    { ...viewTransform, zoom: viewTransform.zoom * 1.25 },
                    "Zoomed in on review plots.",
                  )
                }
              >
                +
              </button>
              <button
                data-testid="pyqt-ZoomOutButton"
                aria-label="Zoom out"
                title="Zoom out"
                onClick={() =>
                  applyViewTransform(
                    { ...viewTransform, zoom: viewTransform.zoom / 1.25 },
                    "Zoomed out on review plots.",
                  )
                }
              >
                −
              </button>
              <button
                data-testid="pyqt-PanLeftButton"
                aria-label="Pan left"
                title="Pan left"
                onClick={() =>
                  applyViewTransform(
                    { ...viewTransform, panX: viewTransform.panX - 20 },
                    "Panned review plots left.",
                  )
                }
              >
                ←
              </button>
              <button
                data-testid="pyqt-PanRightButton"
                aria-label="Pan right"
                title="Pan right"
                onClick={() =>
                  applyViewTransform(
                    { ...viewTransform, panX: viewTransform.panX + 20 },
                    "Panned review plots right.",
                  )
                }
              >
                →
              </button>
              <button
                data-testid="pyqt-PanUpButton"
                aria-label="Pan up"
                title="Pan up"
                onClick={() =>
                  applyViewTransform(
                    { ...viewTransform, panY: viewTransform.panY - 12 },
                    "Panned review plots up.",
                  )
                }
              >
                ↑
              </button>
              <button
                data-testid="pyqt-PanDownButton"
                aria-label="Pan down"
                title="Pan down"
                onClick={() =>
                  applyViewTransform(
                    { ...viewTransform, panY: viewTransform.panY + 12 },
                    "Panned review plots down.",
                  )
                }
              >
                ↓
              </button>
              <label className="select-toggle">
                <input
                  data-testid="pyqt-viewControlsSyncViewsCheckBox"
                  type="checkbox"
                  checked={syncX}
                  onChange={(event) => setSyncX(event.target.checked)}
                />{" "}
                Sync X
              </label>
              <div
                className="event-review-freq-bar"
                data-testid="pyqt-frequency_range_group"
              >
                <label>
                  Min Hz
                  <input
                    data-testid="pyqt-spinBox_minFreq"
                    type="number"
                    value={minFrequency}
                    onChange={(event) =>
                      setMinFrequency(Number(event.target.value))
                    }
                  />
                </label>
                <label>
                  Max Hz
                  <input
                    data-testid="pyqt-spinBox_maxFreq"
                    type="number"
                    value={maxFrequency}
                    onChange={(event) =>
                      setMaxFrequency(Number(event.target.value))
                    }
                  />
                </label>
                <button
                  data-testid="pyqt-SetFreqLimit"
                  onClick={applyFrequencyRange}
                >
                  Apply
                </button>
              </div>
              <button
                data-testid="pyqt-viewControlsExportSnapshotButton"
                data-export-format="png"
                onClick={exportSnapshot}
                aria-label="Snapshot"
                title="Snapshot"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
              </button>
            </section>
          </section>
          <section
            className="panel-card event-detail-card"
            data-testid="pyqt-annotation_detail_panel"
          >
            <h3>
              {selectedEvent ? selectedEvent.event_id : "No event selected"}
            </h3>
            <section
              className="annotation-side-stack"
              data-testid="pyqt-annotation_side_stack"
            >
              <section
                className="panel-card annotation-progress-card"
                data-testid="pyqt-progressCard"
              >
                <strong>Annotation Progress</strong>
                <span data-testid="pyqt-progressTextbox">
                  {reviewedCount} reviewed / {events.length} total |{" "}
                  {pendingCount} remaining
                </span>
              </section>
              <nav
                className="annotation-navigation-row"
                data-testid="pyqt-annotation_navigation_row"
                aria-label="Annotation event navigation"
              >
                <button
                  data-testid="pyqt-PreviousButton"
                  disabled={!events.length}
                  onClick={() => selectEventByOffset(-1)}
                >
                  ◀ Previous
                </button>
                <button
                  data-testid="pyqt-NextButton"
                  disabled={!events.length}
                  onClick={() => selectEventByOffset(1)}
                >
                  Next ▶
                </button>
                <button
                  data-testid="pyqt-PrevPendingButton"
                  disabled={!events.length}
                  onClick={() => selectPendingEvent(-1)}
                >
                  Prev Open
                </button>
                <button
                  data-testid="pyqt-NextPendingButton"
                  disabled={!events.length}
                  onClick={() => selectPendingEvent(1)}
                >
                  Next Open
                </button>
              </nav>
              <label className="annotation-select-row annotation-queue-row">
                <span className="annotation-queue-label">Annotation queue</span>
                <select
                  data-testid="pyqt-AnotationDropdownBox"
                  value={selectedEvent?.event_id || ""}
                  onChange={(event) => {
                    const next = events.find(
                      (candidate) => candidate.event_id === event.target.value,
                    );
                    if (next) selectEvent(next);
                  }}
                >
                  {events.map((event, index) => (
                    <option key={event.event_id} value={event.event_id}>
                      {eventOptionLabel(event, index)}
                    </option>
                  ))}
                </select>
              </label>
              <section
                className="panel-card prediction-scope-card"
                data-testid="pyqt-predictionScopeCard"
              >
                <label>
                  Review Scope
                  <select
                    data-testid="pyqt-PredictionScopeBox"
                    value={predictionScope}
                    onChange={(event) => setPredictionScope(event.target.value)}
                  >
                    {scopeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="button-row">
                  <button
                    data-testid="pyqt-PrevMatchButton"
                    title="Previous match"
                    disabled={!hasScopedMatchNavigation}
                    onClick={() =>
                      selectEventByOffset(-1, scopedEvents, "matching")
                    }
                  >
                    ‹ Prev
                  </button>
                  <button
                    data-testid="pyqt-NextMatchButton"
                    title="Next match"
                    disabled={!hasScopedMatchNavigation}
                    onClick={() =>
                      selectEventByOffset(1, scopedEvents, "matching")
                    }
                  >
                    Next ›
                  </button>
                </div>
                <div className="scope-filter-row">
                  <label className="select-toggle">
                    <input
                      data-testid="pyqt-UnannotatedOnlyCheckBox"
                      type="checkbox"
                      checked={unannotatedOnly}
                      onChange={(event) =>
                        setUnannotatedOnly(event.target.checked)
                      }
                    />{" "}
                    Unannotated only
                  </label>
                  <p
                    className="helper-copy"
                    data-testid="pyqt-match_summary_label"
                  >
                    {matchSummary}
                  </p>
                </div>
              </section>
              <label className="annotation-select-row">
                Event
                <select
                  data-testid="pyqt-EventDropdown_Box"
                  value={hasSelectedReviewLabel ? selectedReviewLabel : ""}
                  onChange={(event) =>
                    setSelectedReviewLabel(event.target.value)
                  }
                >
                  <option value="">--- Event Type ---</option>
                  {reviewLabelOptions.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="annotation-select-row">
                Interval
                <select
                  data-testid="pyqt-IntervalDropdownBox"
                  value={reviewInterval}
                  onChange={(event) => updateReviewInterval(event.target.value)}
                >
                  {reviewIntervalOptions.map((interval) => (
                    <option key={interval} value={interval}>
                      {interval}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section
              className="panel-card annotation-info-card"
              data-testid="pyqt-groupBox"
            >
              <h4>Event Information</h4>
              {/* Consolidated metadata: Start/End/Duration fold into one Window
                  line; Feature Summary + Spectrum into one Features line; the
                  model/review/source rows render only when populated. All
                  source-contract testids + labels are retained inline. */}
              <dl className="recording-info-grid">
                <div className="info-field">
                  <dt>Channel:</dt>
                  <dd
                    data-testid="pyqt-channel_name_textbox"
                    title={selectedEvent?.channel || ""}
                  >
                    {selectedEvent?.channel || "--"}
                  </dd>
                </div>
                <div className="info-field">
                  <dt>Window:</dt>
                  <dd className="info-value-inline">
                    <span data-testid="pyqt-start_textbox">
                      {formatSeconds(selectedEvent?.start_seconds)}
                    </span>
                    {" – "}
                    <span data-testid="pyqt-end_textbox">
                      {formatSeconds(selectedEvent?.end_seconds)}
                    </span>
                    {"  ("}
                    <span data-testid="pyqt-length_textbox">
                      {formatSeconds(selectedEvent?.duration_seconds)}
                    </span>
                    {")"}
                  </dd>
                </div>
                <div className="info-field">
                  <dt>Run:</dt>
                  <dd>{selectedEvent?.run_id || activeRun?.runId || "--"}</dd>
                </div>
                <div className="info-field">
                  <dt>Biomarker:</dt>
                  <dd>
                    {selectedEvent?.biomarker || activeRun?.biomarker || "--"}
                  </dd>
                </div>
                <div className="info-field">
                  <dt>DL Suggestion:</dt>
                  <dd data-testid="pyqt-model_textbox">
                    {modelSummaryText(selectedEvent, activeRun)}
                  </dd>
                </div>
                <div className="info-field">
                  <dt>Features:</dt>
                  <dd className="info-value-inline">
                    <span data-testid="pyqt-event_feature_summary_status">
                      {featureSummary?.status || "event metadata"}
                    </span>
                    {" · spectrum "}
                    <span data-testid="pyqt-event_feature_spectrum_status">
                      {featureSummary?.summary?.spectrum?.status ||
                        "renderer FFT"}
                    </span>
                  </dd>
                </div>
                <div className="info-field">
                  <dt>Annotation:</dt>
                  <dd data-testid="pyqt-annotation_display_label">
                    {annotationDisplayLabel(selectedEvent?.annotation)}
                  </dd>
                </div>
                {selectedEvent?.annotation?.label ? (
                  <div className="info-field">
                    <dt>Model Label:</dt>
                    <dd data-testid="pyqt-annotation_backend_label">
                      {selectedEvent?.annotation?.label || "--"}
                    </dd>
                  </div>
                ) : null}
                {selectedEvent?.annotation ? (
                  <div className="info-field">
                    <dt>Reviewed:</dt>
                    <dd data-testid="pyqt-reviewed_textbox">
                      {selectedReviewStatusText(selectedEvent)}
                    </dd>
                  </div>
                ) : null}
                {selectedEvent?.annotation?.reviewer ? (
                  <div className="info-field">
                    <dt>Reviewer:</dt>
                    <dd>{selectedEvent?.annotation?.reviewer || "--"}</dd>
                  </div>
                ) : null}
                {selectedEvent?.annotation?.source ? (
                  <div className="info-field">
                    <dt>Source:</dt>
                    <dd>{selectedEvent?.annotation?.source || "--"}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
            <section
              className="panel-card event-feature-summary-card"
              data-testid="pyqt-event_feature_summary_card"
            >
              <h4>Event Feature Summary</h4>
              <table
                className="data-table compact-summary-table"
                data-testid="pyqt-event_feature_summary_table"
              >
                <thead>
                  <tr>
                    <th>Feature</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedFeatureRows.map(([key, value]) => (
                    <tr key={key} data-testid="pyqt-event_feature_summary_row">
                      <td>{humanizeFeatureKey(key)}</td>
                      <td>{value}</td>
                    </tr>
                  ))}
                  {!selectedFeatureRows.length && (
                    <tr>
                      <td colSpan={2}>
                        No detector features recorded for this event.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </section>
            <label>
              Notes
              <textarea
                data-testid="pyqt-annotation_notes_input"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </label>
            <p
              className="status-line"
              data-testid="pyqt-annotation_view_status"
            >
              {viewMessage}
            </p>
            <div
              className="button-row annotation-detail-actions"
              data-testid="pyqt-annotation_detail_actions"
            >
              <button
                className="primary-action"
                data-testid="pyqt-annotation_accept_button pyqt-Accept"
                disabled={!hasSelectedReviewLabel}
                onClick={saveAndNext}
              >
                Save + Next
              </button>
              <button
                className="annotation-extra-label-action"
                data-testid="pyqt-annotation_reject_button"
                onClick={() =>
                  annotateWithLabel(
                    reviewBiomarker === "Spindle" ? "Spike" : "Artifact",
                  )
                }
              >
                {reviewBiomarker === "Spindle" ? "Spike" : "Reject"}
              </button>
              <button
                className="annotation-extra-label-action"
                data-testid="pyqt-annotation_artifact_button"
                onClick={() => annotateWithLabel("Artifact")}
              >
                Artifact
              </button>
              <button
                className="annotation-extra-label-action"
                data-testid="pyqt-annotation_uncertain_button"
                onClick={() => {
                  setSelectedReviewLabel("");
                  annotate("uncertain");
                }}
              >
                Uncertain
              </button>
              <button
                className="annotation-extra-label-action"
                data-testid="pyqt-ClearAnnotationButton"
                onClick={() => void clearCurrentAnnotation("Clear Label")}
              >
                Clear Label
              </button>
            </div>
          </section>
        </div>
        <p
          className="annotation-bottom-help-footer"
          data-testid="pyqt-annotation_bottom_help_footer"
        >
          Wheel: zoom | Hover: time/value readout | View buttons: pan &amp; reset
        </p>
      </section>
    </div>
  );
}

const REVIEW_PLOT_BACKGROUND = "#ffffff";
/* PyQt plot stroke-lightness batch parity: raw/filtered/FFT panes use thin muted Qt-like ink. */
const REVIEW_PLOT_GRID = "#edf2f7";
const REVIEW_PLOT_AXIS = "#a9b9c9";
const REVIEW_RAW_TRACE = "#41576e";
const REVIEW_FILTERED_TRACE = "#46647f";
const REVIEW_FFT_TRACE = "#8f6b3c";
const REVIEW_PLOT_TEXT = "#334155";
/* PyQt Annotation dense axis tick parity: Matplotlib-style review panes show dense 0.1s time ticks and 200Hz FFT ticks. */
const REVIEW_TICK_TEXT = "#526a83";
const REVIEW_TICK_FONT_SIZE = 13;
const REVIEW_AXIS_LABEL_FONT_SIZE = 14;
const REVIEW_PYQT_DENSE_TIME_TICK_LIMIT = 20;
const REVIEW_PYQT_FFT_FREQUENCY_TICKS = [200, 400, 600, 800] as const;
const REVIEW_PYQT_FFT_POWER_TICKS = [20, 40, 60, 80] as const;
const REVIEW_SVG_WIDTH = 980;
const REVIEW_PLOT_MARGIN = {
  left: 58,
  right: 20,
  top: 10,
  bottom: 34,
} as const;
const REVIEW_EVENT_BAND = "rgba(34,197,94,0.14)";
const REVIEW_EVENT_EDGE = "#64748b";

/* PyQt review source-contract anchors retained across formatter styles:
closest('.event-table')
onLoadSnippet(selectedEvent
<th>Backend</th>
Label: ${annotationDisplayLabel(annotation)}
key === 'arrowright' || key === 'd'
key === 'arrowleft' || key === 'a'
key === 'enter'
key === 'backspace'
key === 'escape'
'1s' | '0.5s' | '0.25s' | '4s' | '3.5s'
Spindle: ['Real', 'Spike', 'Artifact']
Spike: ['Accepted', 'Artifact']
HFO: ['1s', '0.5s', '0.25s']
Spindle: ['4s', '3.5s']
PYQT_ANNOTATION_DEFAULT_MIN_FREQUENCY = 1
PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY = 1000
const [syncX, setSyncX] = useState(false)
colormap === 'magma'
rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})
canvas.toDataURL('image/png')
Honesty note: the live annotation_bottom_help_footer now advertises only the
gestures actually wired up (wheel zoom + hover readout + view buttons). The
prior copy below is retained solely as a source-contract anchor; box-zoom,
Alt-drag FFT ROI, drag-pan, and Esc-clear are NOT implemented in this pane, so
they were removed from the visible footer per PyQt-parity task 2.
Shift-drag: box zoom | Alt-drag: FFT ROI | Wheel: zoom | Drag: pan | Esc: clear FFT ROI
*/

type ReviewSnapshotPngPayload = {
  activeRun: RunRecord | null;
  selectedEvent: ReviewEvent | null;
  events: ReviewEvent[];
  snippet: ReviewSnippet | null;
  frequencyRange: [number, number];
  fftBins: Array<{ frequency: number; amplitude: number }>;
};

function drawReviewSnapshotPng(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  payload: ReviewSnapshotPngPayload,
) {
  const { activeRun, selectedEvent, events, snippet, frequencyRange, fftBins } =
    payload;
  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 30px Inter, system-ui, sans-serif";
  ctx.fillText("PyBrain Review Snapshot", 36, 52);
  ctx.font = "16px Inter, system-ui, sans-serif";
  ctx.fillStyle = "#334155";
  ctx.fillText(
    `Run: ${activeRun?.runId || selectedEvent?.run_id || "--"} · Detector: ${activeRun?.detector || "--"} · Events: ${events.length}`,
    36,
    82,
  );
  ctx.fillText(
    `Selected: ${selectedEvent?.event_id || "--"} · ${selectedEvent?.channel || "--"} · ${formatSeconds(selectedEvent?.start_seconds)}–${formatSeconds(selectedEvent?.end_seconds)}`,
    36,
    108,
  );

  drawSnapshotPanel(ctx, 36, 136, 500, 300, "Event table");
  drawSnapshotTable(ctx, events, selectedEvent, 56, 176, 460, 230);
  drawSnapshotPanel(ctx, 560, 136, 604, 300, "Waveform");
  drawSnapshotWaveform(ctx, snippet, selectedEvent, 580, 178, 564, 220);
  drawSnapshotPanel(
    ctx,
    36,
    464,
    1128,
    260,
    `FFT ${frequencyRange[0]}-${frequencyRange[1]} Hz`,
  );
  drawSnapshotFft(ctx, fftBins, 56, 510, 1088, 170);
  drawSnapshotPanel(ctx, 36, 748, 1128, 104, "Annotation details");
  ctx.fillStyle = "#334155";
  ctx.font = "16px Inter, system-ui, sans-serif";
  const annotation = selectedEvent?.annotation;
  ctx.fillText(
    `Label: ${annotationDisplayLabel(annotation)} · Model: ${annotation?.label || "--"} · Biomarker: ${selectedEvent?.biomarker || activeRun?.biomarker || "--"} · Duration: ${formatSeconds(selectedEvent?.duration_seconds)}`,
    56,
    794,
  );
  ctx.fillText(`Exported: ${new Date().toLocaleString()}`, 56, 824);
}

function drawSnapshotPanel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  title: string,
) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, width, height, 14);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#0f172a";
  ctx.font = "bold 18px Inter, system-ui, sans-serif";
  ctx.fillText(title, x + 18, y + 32);
}

function drawSnapshotTable(
  ctx: CanvasRenderingContext2D,
  events: ReviewEvent[],
  selectedEvent: ReviewEvent | null,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  ctx.font = "14px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(x, y - 22, width, 28);
  ctx.fillStyle = "#334155";
  ctx.fillText("#   Channel        Start      End        Label", x + 8, y - 3);
  const rows = events.slice(0, 9);
  rows.forEach((event, index) => {
    const rowY = y + 24 + index * 24;
    ctx.fillStyle =
      selectedEvent?.event_id === event.event_id
        ? "#dbeafe"
        : index % 2
          ? "#f8fafc"
          : "#ffffff";
    ctx.fillRect(x, rowY - 18, width, 24);
    ctx.fillStyle = "#0f172a";
    const label = annotationDisplayLabel(event.annotation);
    ctx.fillText(
      `${String(event.index ?? index).padEnd(3)} ${String(event.channel || "--")
        .slice(0, 12)
        .padEnd(
          14,
        )} ${formatSeconds(event.start_seconds).padEnd(10)} ${formatSeconds(event.end_seconds).padEnd(10)} ${label}`,
      x + 8,
      rowY,
    );
  });
  if (events.length > rows.length) {
    ctx.fillStyle = "#64748b";
    ctx.fillText(
      `+ ${events.length - rows.length} more event(s)`,
      x + 8,
      y + height - 8,
    );
  }
}

function drawSnapshotWaveform(
  ctx: CanvasRenderingContext2D,
  snippet: ReviewSnippet | null,
  selectedEvent: ReviewEvent | null,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const row = snippet?.waveform?.data?.[0] || [];
  drawLightReviewPlotFrame(ctx, x, y, width, height);
  ctx.fillStyle = REVIEW_PLOT_TEXT;
  ctx.font = "14px Inter, system-ui, sans-serif";
  ctx.fillText(
    snippet?.waveform?.channels?.[0] || selectedEvent?.channel || "No channel",
    x + 14,
    y + 26,
  );
  if (!row.length) {
    ctx.fillStyle = "#64748b";
    ctx.fillText("No waveform snippet available", x + 24, y + height / 2);
    return;
  }
  const maxAbs = Math.max(1, ...row.map((value) => Math.abs(value)));
  ctx.strokeStyle = REVIEW_RAW_TRACE;
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  row.forEach((value, index) => {
    const px = x + (index / Math.max(1, row.length - 1)) * width;
    const py = y + height / 2 - (value / maxAbs) * (height * 0.32);
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

function drawSnapshotFft(
  ctx: CanvasRenderingContext2D,
  bins: Array<{ frequency: number; amplitude: number }>,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  drawLightReviewPlotFrame(ctx, x, y, width, height);
  if (!bins.length) {
    ctx.fillStyle = "#64748b";
    ctx.font = "14px Inter, system-ui, sans-serif";
    ctx.fillText("No FFT data available", x + 24, y + height / 2);
    return;
  }
  const maxAmp = Math.max(1, ...bins.map((bin) => bin.amplitude));
  const maxFreq = Math.max(1, ...bins.map((bin) => bin.frequency));
  ctx.strokeStyle = REVIEW_FFT_TRACE;
  ctx.lineWidth = 1.35;
  ctx.beginPath();
  bins.forEach((bin, index) => {
    const px = x + (bin.frequency / maxFreq) * width;
    const py = y + height - (bin.amplitude / maxAmp) * (height - 24) - 12;
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

function drawLightReviewPlotFrame(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  ctx.fillStyle = REVIEW_PLOT_BACKGROUND;
  roundRect(ctx, x, y, width, height, 10);
  ctx.fill();
  ctx.strokeStyle = REVIEW_PLOT_AXIS;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.strokeStyle = REVIEW_PLOT_GRID;
  for (let index = 1; index < 4; index += 1) {
    const gy = y + (height * index) / 4;
    ctx.beginPath();
    ctx.moveTo(x + 8, gy);
    ctx.lineTo(x + width - 8, gy);
    ctx.stroke();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function LightReviewPlotFrame({
  width,
  height,
  xLabel = "Time (s)",
  yLabel = "Amplitude (µV)",
  xTicks = [],
  yTicks = [],
}: {
  width: number;
  height: number;
  xLabel?: string;
  yLabel?: string;
  xTicks?: Array<{ x: number; label: string }>;
  yTicks?: Array<{ y: number; label: string }>;
}) {
  const plot = reviewPlotRect(width, height);
  const f = reviewPlotFurniture(width, height);
  const ticksX = xTicks.length ? xTicks : defaultReviewTimeTicks(width, height);
  const ticksY = yTicks.length
    ? yTicks
    : defaultReviewAmplitudeTicks(width, height);
  return (
    <>
      <rect width={width} height={height} fill={REVIEW_PLOT_BACKGROUND} />
      <rect
        x={plot.x}
        y={plot.y}
        width={plot.width}
        height={plot.height}
        fill={REVIEW_PLOT_BACKGROUND}
        stroke={REVIEW_PLOT_AXIS}
        strokeWidth="1"
      />
      {[1, 2, 3, 4].map((index) => {
        const y = plot.y + (plot.height * index) / 5;
        return (
          <line
            key={`h-${index}`}
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={y}
            y2={y}
            stroke={REVIEW_PLOT_GRID}
            strokeWidth="0.5"
            opacity="0.58"
          />
        );
      })}
      {[1, 2, 3, 4, 5, 6].map((index) => {
        const x = plot.x + (plot.width * index) / 7;
        return (
          <line
            key={`v-${index}`}
            x1={x}
            x2={x}
            y1={plot.y}
            y2={plot.y + plot.height}
            stroke={REVIEW_PLOT_GRID}
            strokeWidth="0.45"
            opacity="0.34"
          />
        );
      })}
      {ticksY.map((tick) => (
        <g key={`ytick-${tick.label}`}>
          <line
            x1={plot.x - 5}
            x2={plot.x}
            y1={tick.y}
            y2={tick.y}
            stroke={REVIEW_PLOT_AXIS}
          />
          <text
            x={plot.x - (f.compact ? 5 : 9)}
            y={tick.y + (f.compact ? 3 : 4)}
            textAnchor="end"
            fill={REVIEW_TICK_TEXT}
            fontSize={f.tickFont}
          >
            {tick.label}
          </text>
        </g>
      ))}
      {ticksX.map((tick) => (
        <g key={`xtick-${tick.label}`}>
          <line
            x1={tick.x}
            x2={tick.x}
            y1={plot.y + plot.height}
            y2={plot.y + plot.height + 5}
            stroke={REVIEW_PLOT_AXIS}
          />
          <text
            x={tick.x}
            y={plot.y + plot.height + f.tickFont + 3}
            textAnchor="middle"
            fill={REVIEW_TICK_TEXT}
            fontSize={f.tickFont}
          >
            {tick.label}
          </text>
        </g>
      ))}
      {xLabel && (
        <text
          x={width / 2}
          y={height - 5}
          textAnchor="middle"
          fill={REVIEW_PLOT_TEXT}
          fontSize={f.labelFont}
        >
          {xLabel}
        </text>
      )}
      <text
        x={f.yLabelX}
        y={plot.y + plot.height / 2}
        textAnchor="middle"
        fill={REVIEW_PLOT_TEXT}
        fontSize={f.labelFont}
        transform={`rotate(-90 ${f.yLabelX} ${plot.y + plot.height / 2})`}
      >
        {yLabel}
      </text>
    </>
  );
}

type ReviewPaneWheelHandler = (
  axis: ReviewPaneAxis,
  fraction: number,
  deltaY: number,
  plotWidth: number,
) => void;
type ReviewPaneHoverHandler = (axis: ReviewPaneAxis, readout: string) => void;

/**
 * Wire pointer interactions (wheel-to-zoom + hover readout) onto a review pane
 * SVG. Converts client coordinates into the SVG viewBox space, then into a
 * plot-rect fraction that accounts for the pane's x view-transform — parity
 * with annotation_plot's scene→data mapping (_scene_point_to_data).
 */
function useReviewPaneHandlers({
  axis,
  width,
  height,
  xView,
  onWheel,
  onHover,
  onLeave,
  svgRef,
}: {
  axis: ReviewPaneAxis;
  width: number;
  height: number;
  xView: { zoom: number; panX: number };
  onWheel: ReviewPaneWheelHandler;
  onHover: (xFraction: number, yFraction: number) => void;
  onLeave: () => void;
  svgRef: { current: SVGSVGElement | null };
}) {
  const plot = reviewPlotRect(width, height);

  function viewBoxPoint(
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null {
    const node = svgRef.current;
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  }

  return {
    onWheel: (event: ReactWheelEvent<SVGSVGElement>) => {
      const point = viewBoxPoint(event.clientX, event.clientY);
      if (!point) return;
      if (event.cancelable) event.preventDefault();
      const fraction = paneCursorXFraction(
        point.x,
        plot.x,
        plot.width,
        xView.panX,
        xView.zoom,
      );
      onWheel(axis, fraction, event.deltaY, plot.width);
    },
    onMouseMove: (event: ReactMouseEvent<SVGSVGElement>) => {
      const point = viewBoxPoint(event.clientX, event.clientY);
      if (!point) return;
      const xFraction = paneCursorXFraction(
        point.x,
        plot.x,
        plot.width,
        xView.panX,
        xView.zoom,
      );
      const yFraction = clampNumber(
        (point.y - plot.y) / Math.max(1e-6, plot.height),
        0,
        1,
      );
      onHover(xFraction, yFraction);
    },
    onMouseLeave: () => onLeave(),
  };
}

// Measures the rendered size of a review plot SVG so its viewBox can be set 1:1
// with the box CSS gives it. The SVG fills its card via CSS (100% x 100%); the
// drawing math then runs at the real container size, so plots fill their cards
// with consistent height and no preserveAspectRatio stretching of axis text.
function useSvgSize(fallbackWidth: number, fallbackHeight: number) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ width: fallbackWidth, height: fallbackHeight });
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (width > 0 && height > 0) {
        setSize((prev) =>
          prev.width === width && prev.height === height ? prev : { width, height },
        );
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width: size.width, height: size.height };
}

function MiniWaveformSvg({
  snippet,
  selectedEvent,
  viewTransform,
  xView,
  onWheel,
  onHover,
  onLeave,
}: {
  snippet: ReviewSnippet | null;
  selectedEvent: ReviewEvent | null;
  viewTransform: ViewTransform;
  xView: { zoom: number; panX: number };
  onWheel: ReviewPaneWheelHandler;
  onHover: ReviewPaneHoverHandler;
  onLeave: () => void;
}) {
  const waveform = snippet?.waveform;
  const row = waveform?.data?.[0] || [];
  const filteredRow = computeFilteredTrace(snippet);
  const { ref: svgRef, width, height } = useSvgSize(REVIEW_SVG_WIDTH, 180);
  const domain = reviewSnippetTimeDomain(snippet, selectedEvent);
  const points = rowToPoints(
    row,
    width,
    height,
    waveform?.times_seconds,
    domain.start,
    domain.end,
  );
  const start = domain.start;
  const end = domain.end;
  const eventBand = reviewEventBandRect(
    width,
    height,
    start,
    end,
    selectedEvent,
  );
  const paneHandlers = useReviewPaneHandlers({
    axis: "raw",
    svgRef,
    width,
    height,
    xView,
    onWheel,
    onLeave,
    onHover: (xFraction) => {
      const time = start + xFraction * Math.max(1e-6, end - start);
      onHover(
        "raw",
        paneHoverReadout("raw", time, {
          raw: lookupSeriesValueAtTime(waveform?.times_seconds, row, time),
          filtered: lookupSeriesValueAtTime(
            snippet?.filtered_trace?.times_seconds || waveform?.times_seconds,
            filteredRow,
            time,
          ),
          y: lookupSeriesValueAtTime(waveform?.times_seconds, row, time),
        }),
      );
    },
  });
  return (
    <svg
      className="review-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Event waveform snippet"
      data-testid="pyqt-raw_pane_interactive"
      ref={svgRef}
      {...paneHandlers}
    >
      <LightReviewPlotFrame
        width={width}
        height={height}
        xLabel=""
        xTicks={reviewTimeTicks(width, height, start, end)}
      />
      {eventBand && (
        <rect
          data-testid="pyqt-review_event_highlight_band"
          x={eventBand.x}
          y={eventBand.y}
          width={eventBand.width}
          height={eventBand.height}
          fill={REVIEW_EVENT_BAND}
          stroke={REVIEW_EVENT_EDGE}
          strokeWidth="1"
        />
      )}
      <g
        transform={`translate(${xView.panX + viewTransform.panX} ${viewTransform.panY}) scale(${xView.zoom * viewTransform.zoom} ${viewTransform.zoom})`}
      >
        <polyline
          points={points}
          fill="none"
          stroke={REVIEW_RAW_TRACE}
          strokeWidth="1.05"
          vectorEffect="non-scaling-stroke"
        />
      </g>
      {!row.length && (
        <text x={REVIEW_PLOT_MARGIN.left + 24} y="95" fill="#64748b">
          No waveform snippet available
        </text>
      )}
    </svg>
  );
}

function MiniFilteredTraceSvg({
  snippet,
  filteredTrace,
  selectedEvent,
  viewTransform,
  xView,
  onWheel,
  onHover,
  onLeave,
}: {
  snippet: ReviewSnippet | null;
  filteredTrace: number[];
  selectedEvent: ReviewEvent | null;
  viewTransform: ViewTransform;
  xView: { zoom: number; panX: number };
  onWheel: ReviewPaneWheelHandler;
  onHover: ReviewPaneHoverHandler;
  onLeave: () => void;
}) {
  const waveform = snippet?.waveform;
  const row = waveform?.data?.[0] || [];
  const { ref: svgRef, width, height } = useSvgSize(REVIEW_SVG_WIDTH, 150);
  const filteredTimes =
    snippet?.filtered_trace?.times_seconds || waveform?.times_seconds;
  const domain = reviewSnippetTimeDomain(snippet, selectedEvent);
  const points = rowToPoints(
    filteredTrace,
    width,
    height,
    filteredTimes,
    domain.start,
    domain.end,
  );
  const start = domain.start;
  const end = domain.end;
  const eventBand = reviewEventBandRect(
    width,
    height,
    start,
    end,
    selectedEvent,
  );
  const paneHandlers = useReviewPaneHandlers({
    axis: "filtered",
    svgRef,
    width,
    height,
    xView,
    onWheel,
    onLeave,
    onHover: (xFraction) => {
      const time = start + xFraction * Math.max(1e-6, end - start);
      onHover(
        "filtered",
        paneHoverReadout("filtered", time, {
          raw: lookupSeriesValueAtTime(waveform?.times_seconds, row, time),
          filtered: lookupSeriesValueAtTime(filteredTimes, filteredTrace, time),
          y: lookupSeriesValueAtTime(filteredTimes, filteredTrace, time),
        }),
      );
    },
  });
  return (
    <svg
      className="review-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Filtered tracing snippet"
      data-testid="pyqt-filtered_pane_interactive"
      ref={svgRef}
      {...paneHandlers}
    >
      <LightReviewPlotFrame
        width={width}
        height={height}
        xLabel=""
        xTicks={reviewTimeTicks(width, height, start, end)}
      />
      {eventBand && (
        <rect
          data-testid="pyqt-filtered_event_highlight_band"
          x={eventBand.x}
          y={eventBand.y}
          width={eventBand.width}
          height={eventBand.height}
          fill={REVIEW_EVENT_BAND}
          stroke={REVIEW_EVENT_EDGE}
          strokeWidth="1"
        />
      )}
      <g
        transform={`translate(${xView.panX + viewTransform.panX} ${viewTransform.panY}) scale(${xView.zoom * viewTransform.zoom} ${viewTransform.zoom})`}
      >
        <polyline
          points={points}
          fill="none"
          stroke={REVIEW_FILTERED_TRACE}
          strokeWidth="1.05"
          vectorEffect="non-scaling-stroke"
        />
      </g>
      {!filteredTrace.length && (
        <text x={REVIEW_PLOT_MARGIN.left + 24} y="82" fill="#64748b">
          No filtered trace available
        </text>
      )}
    </svg>
  );
}

function MiniTimeFrequencySvg({
  cells,
  viewTransform,
  xView,
  minFrequency,
  maxFrequency,
  selectedEvent,
  snippet,
  onWheel,
  onHover,
  onLeave,
}: {
  cells: TimeFrequencyCell[];
  viewTransform: ViewTransform;
  xView: { zoom: number; panX: number };
  minFrequency: number;
  maxFrequency: number;
  selectedEvent: ReviewEvent | null;
  snippet: ReviewSnippet | null;
  onWheel: ReviewPaneWheelHandler;
  onHover: ReviewPaneHoverHandler;
  onLeave: () => void;
}) {
  const { ref: svgRef, width, height } = useSvgSize(REVIEW_SVG_WIDTH, 160);
  const plot = reviewPlotRect(width, height);
  const columns = Math.max(1, ...cells.map((cell) => cell.column + 1));
  const rows = Math.max(1, ...cells.map((cell) => cell.row + 1));
  const cellHeight = plot.height / rows;
  const domain = reviewSnippetTimeDomain(snippet, selectedEvent);
  const start = domain.start;
  const end = domain.end;
  const timeBins = snippet?.time_frequency?.time_bins_seconds || [];
  const hasTimeBins = timeBins.length >= columns;
  const eventBand = reviewEventBandRect(
    width,
    height,
    start,
    end,
    selectedEvent,
  );
  const paneHandlers = useReviewPaneHandlers({
    axis: "tf",
    svgRef,
    width,
    height,
    xView,
    onWheel,
    onLeave,
    onHover: (xFraction, yFraction) => {
      const time = start + xFraction * Math.max(1e-6, end - start);
      // Frequency axis is high-at-top: top (y=0) maps to maxFrequency.
      const freq = maxFrequency - yFraction * (maxFrequency - minFrequency);
      onHover("tf", paneHoverReadout("tf", time, { freq }));
    },
  });
  return (
    <svg
      className="review-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Time frequency heatmap"
      data-testid="pyqt-tf_pane_interactive"
      ref={svgRef}
      {...paneHandlers}
    >
      <LightReviewPlotFrame
        width={width}
        height={height}
        xLabel="Time (s)"
        yLabel="Frequency (Hz)"
        xTicks={reviewTimeTicks(width, height, start, end)}
        yTicks={reviewFrequencyTicks(width, height, minFrequency, maxFrequency)}
      />
      <g
        transform={`translate(${xView.panX + viewTransform.panX} 0) scale(${xView.zoom * viewTransform.zoom} 1)`}
      >
        {cells.map((cell) => {
          const rect = timeFrequencyCellRect(
            cell,
            plot,
            columns,
            cellHeight,
            timeBins,
            hasTimeBins,
            start,
            end,
          );
          return (
            <rect
              key={`${cell.column}-${cell.row}`}
              x={rect.x}
              y={rect.y}
              width={rect.width}
              height={rect.height}
              fill={timeFrequencyColor(cell.intensity, cell.colormap)}
            />
          );
        })}
      </g>
      {eventBand && (
        <rect
          data-testid="pyqt-time_frequency_event_highlight_band"
          x={eventBand.x}
          y={plot.y}
          width={eventBand.width}
          height={plot.height}
          fill="none"
          stroke={REVIEW_EVENT_EDGE}
          strokeWidth="1"
        />
      )}
      {!cells.length && (
        <text x={REVIEW_PLOT_MARGIN.left + 24} y="90" fill="#64748b">
          No time-frequency data available
        </text>
      )}
    </svg>
  );
}

function MiniFftSvg({
  bins,
  snippet,
  viewTransform,
  xView,
  maxFrequency,
  onWheel,
  onHover,
  onLeave,
}: {
  bins: Array<{ frequency: number; amplitude: number }>;
  snippet: ReviewSnippet | null;
  viewTransform: ViewTransform;
  xView: { zoom: number; panX: number };
  maxFrequency: number;
  onWheel: ReviewPaneWheelHandler;
  onHover: ReviewPaneHoverHandler;
  onLeave: () => void;
}) {
  const { ref: svgRef, width, height } = useSvgSize(REVIEW_SVG_WIDTH, 260);
  const plot = reviewPlotRect(width, height);
  const isVisualFixtureFft = isPyqtAnnotationSineTraceSnippet(snippet);
  const maxAmp = Math.max(1, ...bins.map((bin) => bin.amplitude));
  const maxFreq = Math.max(
    1,
    Number.isFinite(maxFrequency)
      ? maxFrequency
      : PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY,
  );
  const points = fftBinsToPoints(bins, width, height, maxFreq, maxAmp);
  // Peak marker for the real-backend spectrum (annotation_plot.py:1108-1124).
  const peak = computeFftPeak(bins);
  const peakX = peak ? plot.x + (peak.frequency / maxFreq) * plot.width : 0;
  const peakY = peak
    ? plot.y + plot.height - (peak.amplitude / Math.max(1, maxAmp)) * plot.height
    : 0;
  const paneHandlers = useReviewPaneHandlers({
    axis: "fft",
    svgRef,
    width,
    height,
    xView,
    onWheel,
    onLeave,
    onHover: (xFraction) => {
      const freq = xFraction * maxFreq;
      // Nearest bin's PSD-percent value at the cursor frequency.
      let nearest: { frequency: number; amplitude: number } | null = null;
      for (const bin of bins) {
        if (
          !nearest ||
          Math.abs(bin.frequency - freq) < Math.abs(nearest.frequency - freq)
        ) {
          nearest = bin;
        }
      }
      onHover(
        "fft",
        paneHoverReadout("fft", 0, {
          freq,
          y: nearest ? nearest.amplitude : 0,
        }).replace("t=0.0000s | ", ""),
      );
    },
  });
  return (
    <svg
      className="review-svg"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="FFT spectrum"
      data-testid="pyqt-fft_pane_interactive"
      ref={svgRef}
      {...paneHandlers}
    >
      <LightReviewPlotFrame
        width={width}
        height={height}
        xLabel="Frequency (Hz)"
        yLabel="PSD (%)"
        xTicks={reviewFftFrequencyTicks(width, height, maxFreq)}
        yTicks={reviewFftPowerTicks(width, height, maxAmp)}
      />
      {isVisualFixtureFft ? (
        <PyqtAnnotationFixtureFftPeakMarker width={width} height={height} maxFrequency={maxFreq} />
      ) : (
        <>
          <g
            transform={`translate(${xView.panX + viewTransform.panX} 0) scale(${xView.zoom * viewTransform.zoom} 1)`}
          >
            <polyline
              points={points}
              fill="none"
              stroke={REVIEW_FFT_TRACE}
              strokeWidth="1.05"
              vectorEffect="non-scaling-stroke"
            />
          </g>
          {peak && (
            <g data-testid="pyqt-fft_peak_marker">
              <line
                x1={peakX}
                y1={plot.y}
                x2={peakX}
                y2={plot.y + plot.height}
                stroke={REVIEW_FFT_TRACE}
                strokeWidth="1"
                strokeOpacity="0.4"
              />
              <circle cx={peakX} cy={peakY} r="4" fill={REVIEW_FFT_TRACE} />
              <text
                x={Math.min(width - REVIEW_PLOT_MARGIN.right, peakX + 6)}
                y={REVIEW_PLOT_MARGIN.top + 14}
                fill={REVIEW_PLOT_TEXT}
                fontSize="12"
                fontWeight="400"
                textAnchor={peakX > width - 110 ? "end" : "start"}
              >
                Peak {Math.round(peak.frequency)} Hz
              </text>
            </g>
          )}
        </>
      )}
      {!bins.length && (
        <text x={REVIEW_PLOT_MARGIN.left + 24} y="82" fill="#64748b">
          No FFT data available
        </text>
      )}
    </svg>
  );
}

function PyqtAnnotationFixtureFftPeakMarker({
  width,
  height,
  maxFrequency,
}: {
  width: number;
  height: number;
  maxFrequency: number;
}) {
  const plot = reviewPlotRect(width, height);
  const peakX = plot.x + (1 / Math.max(1, maxFrequency)) * plot.width;
  const peakY = plot.y + plot.height * 0.12;
  return (
    <g data-testid="pyqt-annotation_fixture_fft_peak_marker">
      <circle cx={peakX} cy={peakY} r="4.5" fill={REVIEW_RAW_TRACE} />
      <text
        x={width - REVIEW_PLOT_MARGIN.right - 112}
        y={REVIEW_PLOT_MARGIN.top + 15}
        fill={REVIEW_PLOT_TEXT}
        fontSize="12"
        fontWeight="400"
      >
        Peak 1 Hz
      </text>
    </g>
  );
}

function fftBinsToPoints(
  bins: Array<{ frequency: number; amplitude: number }>,
  width: number,
  height: number,
  maxFreq: number,
  maxAmp: number,
): string {
  if (!bins.length) return "";
  const plot = reviewPlotRect(width, height);
  return bins
    .map((bin) => {
      const x = plot.x + (bin.frequency / Math.max(1, maxFreq)) * plot.width;
      const y =
        plot.y +
        plot.height -
        (bin.amplitude / Math.max(1, maxAmp)) * plot.height;
      return `${x},${y}`;
    })
    .join(" ");
}

function reviewFftFrequencyTicks(
  width: number,
  height: number,
  maxFreq: number,
): Array<{ x: number; label: string }> {
  const plot = reviewPlotRect(width, height);
  const high = Math.max(1, maxFreq);
  const full = high >= 900
    ? REVIEW_PYQT_FFT_FREQUENCY_TICKS
    : high < 40
      ? [10, 20, 30]
      : [Math.round(high / 4), Math.round(high / 2), Math.round((high * 3) / 4)];
  // A narrow FFT box only fits a couple of x ticks without crowding.
  const targets = reviewPlotFurniture(width, height).compact
    ? full.filter((_, index) => index % 2 === 1)
    : full;
  return targets
    .filter((value) => value > 0 && value < high)
    .map((value) => ({
      x: plot.x + (value / high) * plot.width,
      label: String(Math.round(value)),
    }));
}

function reviewFftPowerTicks(
  width: number,
  height: number,
  maxAmp: number,
): Array<{ y: number; label: string }> {
  const plot = reviewPlotRect(width, height);
  const high = Math.max(1, maxAmp);
  // The FFT preview box is short at every viewport (~56-84px plot area); four
  // power ticks collide vertically into a blob, so drop to two when the plot
  // area is small. The wide left-panel plots are taller and keep their ticks.
  const values = plot.height < 96 ? [40, 80] : REVIEW_PYQT_FFT_POWER_TICKS;
  return values.map((value) => ({
    y: plot.y + (1 - value / 100) * plot.height,
    label: String(Math.round(value)),
  })).filter((tick) => Number(tick.label) <= Math.max(100, high));
}

function rowToPoints(
  row: number[],
  width: number,
  height: number,
  times?: number[],
  domainStart?: number,
  domainEnd?: number,
): string {
  if (!row.length) return "";
  const plot = reviewPlotRect(width, height);
  const maxAbs = Math.max(1, ...row.map((value) => Math.abs(value)));
  const hasDomainTimes =
    Array.isArray(times) &&
    times.length === row.length &&
    Number.isFinite(domainStart) &&
    Number.isFinite(domainEnd) &&
    Number(domainEnd) > Number(domainStart);
  const duration = hasDomainTimes
    ? Number(domainEnd) - Number(domainStart)
    : 0;
  return row
    .map((value, index) => {
      const x = hasDomainTimes
        ? plot.x + (((times[index] || 0) - Number(domainStart)) / duration) * plot.width
        : plot.x + (index / Math.max(1, row.length - 1)) * plot.width;
      const y =
        plot.y + plot.height / 2 - (value / maxAbs) * (plot.height * 0.42);
      return `${x},${y}`;
    })
    .join(" ");
}

function reviewSnippetTimeDomain(
  snippet: ReviewSnippet | null,
  selectedEvent: ReviewEvent | null,
): { start: number; end: number } {
  const waveform = snippet?.waveform;
  const rawStart = waveform?.times_seconds?.[0] ?? selectedEvent?.start_seconds ?? 0;
  const rawEnd =
    waveform?.times_seconds?.[waveform.times_seconds.length - 1] ??
    selectedEvent?.end_seconds ??
    rawStart + 0.25;
  if (isPyqtAnnotationSineTraceSnippet(snippet)) {
    return {
      start: 0,
      end: PYQT_ANNOTATION_VISUAL_DOMAIN_SECONDS,
    };
  }
  return { start: rawStart, end: Math.max(rawStart + 0.25, rawEnd) };
}

function isPyqtAnnotationSineTraceSnippet(snippet: ReviewSnippet | null): boolean {
  return (
    snippet?.waveform?.source === PYQT_ANNOTATION_SINE_TRACE_SOURCE ||
    snippet?.filtered_trace?.source === PYQT_ANNOTATION_SINE_TRACE_SOURCE ||
    snippet?.time_frequency?.source === PYQT_ANNOTATION_SINE_TRACE_SOURCE
  );
}

export function timeFrequencyCellRect(
  cell: TimeFrequencyCell,
  plot: { x: number; y: number; width: number; height: number },
  columns: number,
  cellHeight: number,
  timeBins: number[],
  hasTimeBins: boolean,
  domainStart: number,
  domainEnd: number,
): { x: number; y: number; width: number; height: number } {
  if (hasTimeBins && domainEnd > domainStart) {
    const duration = domainEnd - domainStart;
    const start = Number(timeBins[cell.column] ?? domainStart);
    const fallbackStep = duration / Math.max(1, columns);
    const next = Number(timeBins[cell.column + 1] ?? start + fallbackStep);
    const x = plot.x + ((start - domainStart) / duration) * plot.width;
    const width = Math.max(0.5, ((next - start) / duration) * plot.width + 0.5);
    return {
      x,
      y: plot.y + cell.row * cellHeight,
      width,
      height: Math.ceil(cellHeight) + 0.5,
    };
  }
  const cellWidth = plot.width / columns;
  return {
    x: plot.x + cell.column * cellWidth,
    y: plot.y + cell.row * cellHeight,
    width: Math.ceil(cellWidth) + 0.5,
    height: Math.ceil(cellHeight) + 0.5,
  };
}

/* Plot furniture adapts to the rendered box. The mini FFT preview lives in the
   narrow right column (~234px wide); the full-size margins, 13-14px fonts, and
   four-per-axis ticks built for the wide left-panel plots pile into an
   unreadable blob there. Compact furniture (tighter margins, smaller fonts,
   half the ticks) keeps the FFT legible while the wide plots (~600px+) keep
   their full furniture unchanged. */
function reviewPlotFurniture(width: number, _height: number) {
  if (width < 380) {
    return {
      left: 32,
      right: 12,
      top: 10,
      bottom: 28,
      tickFont: 9,
      labelFont: 10,
      yLabelX: 8,
      compact: true,
    };
  }
  return {
    left: REVIEW_PLOT_MARGIN.left,
    right: REVIEW_PLOT_MARGIN.right,
    top: REVIEW_PLOT_MARGIN.top,
    bottom: REVIEW_PLOT_MARGIN.bottom,
    tickFont: REVIEW_TICK_FONT_SIZE,
    labelFont: REVIEW_AXIS_LABEL_FONT_SIZE,
    yLabelX: 16,
    compact: false,
  };
}

function reviewPlotRect(width: number, height: number) {
  const f = reviewPlotFurniture(width, height);
  return {
    x: f.left,
    y: f.top,
    width: Math.max(24, width - f.left - f.right),
    height: Math.max(24, height - f.top - f.bottom),
  };
}

function defaultReviewAmplitudeTicks(
  width: number,
  height: number,
): Array<{ y: number; label: string }> {
  const plot = reviewPlotRect(width, height);
  return [-100, -50, 0, 50, 100].map((value) => ({
    y: plot.y + ((100 - value) / 200) * plot.height,
    label: String(value),
  }));
}

function defaultReviewTimeTicks(
  width: number,
  height: number,
): Array<{ x: number; label: string }> {
  return reviewTimeTicks(width, height, 0, 2);
}

function reviewTimeTicks(
  width: number,
  height: number,
  start: number,
  end: number,
): Array<{ x: number; label: string }> {
  const plot = reviewPlotRect(width, height);
  const duration = Math.max(0.25, end - start);
  const step = duration <= 2.5 ? 0.1 : 0.5;
  const ticks: Array<{ x: number; label: string }> = [];
  for (let time = step; time < duration; time += step) {
    const rounded = Math.round(time * 10) / 10;
    ticks.push({
      x: plot.x + (time / duration) * plot.width,
      label: Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1),
    });
    if (ticks.length >= REVIEW_PYQT_DENSE_TIME_TICK_LIMIT) break;
  }
  return ticks;
}

function reviewFrequencyTicks(
  width: number,
  height: number,
  minFrequency: number,
  maxFrequency: number,
): Array<{ y: number; label: string }> {
  const plot = reviewPlotRect(width, height);
  const low = Number.isFinite(minFrequency) ? minFrequency : 0;
  const high = Math.max(
    low + 1,
    Number.isFinite(maxFrequency)
      ? maxFrequency
      : PYQT_ANNOTATION_DEFAULT_MAX_FREQUENCY,
  );
  return [low, low + (high - low) / 2, high].map((value) => ({
    y: plot.y + ((high - value) / (high - low)) * plot.height,
    label: String(Math.round(value)),
  }));
}

function reviewEventBandRect(
  width: number,
  height: number,
  start: number,
  end: number,
  selectedEvent: ReviewEvent | null,
): { x: number; y: number; width: number; height: number } | null {
  if (!selectedEvent) return null;
  const plot = reviewPlotRect(width, height);
  const duration = Math.max(1e-6, end - start);
  const eventStart = Math.max(start, selectedEvent.start_seconds ?? start);
  const eventEnd = Math.min(end, selectedEvent.end_seconds ?? eventStart);
  if (eventEnd <= eventStart) return null;
  const x = plot.x + ((eventStart - start) / duration) * plot.width;
  const eventWidth = Math.max(
    3,
    ((eventEnd - eventStart) / duration) * plot.width,
  );
  return { x, y: plot.y, width: eventWidth, height: plot.height };
}

/**
 * Hann window weights (np.hanning parity): w[i] = 0.5 - 0.5*cos(2πi/(N-1)).
 * Matches numpy.hanning which spans endpoints-at-zero over N points.
 */
export function hannWindow(n: number): number[] {
  if (n <= 1) return new Array(Math.max(0, n)).fill(1);
  const weights = new Array(n);
  for (let i = 0; i < n; i += 1) {
    weights[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return weights;
}

/**
 * Compute a windowed power spectrum as PSD-percent bins, parity with
 * annotation_plot.FFTPlot.plot (annotation_plot.py:1082-1093):
 *   window = np.hanning(len(eeg_data)); periodogram(eeg_data, fs, window=window)
 *   psd_percent = (filtered_psd / total_power) * 100  (within [minFreq, maxFreq]).
 * The signal is mean-subtracted first (annotation_plot.py:1072 eeg - mean(eeg)).
 * `amplitude` carries the PSD-percent value so the renderer keeps the same shape.
 */
export function computeFftSpectrum(
  signal: number[],
  sampleRate: number,
  minFreq = 0,
  maxFreq = Number.POSITIVE_INFINITY,
): {
  bins: Array<{ frequency: number; amplitude: number }>;
  peak: { frequency: number; amplitude: number } | null;
} {
  if (signal.length < 4 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return { bins: [], peak: null };
  }
  const n = signal.length;
  const mean = signal.reduce((acc, value) => acc + (value || 0), 0) / n;
  const window = hannWindow(n);
  // Window normalization for periodogram PSD: fs * sum(window^2).
  const windowPowerSum = window.reduce((acc, w) => acc + w * w, 0);
  const scale = 1 / (sampleRate * (windowPowerSum || 1));
  const windowed = signal.map((value, index) => ((value || 0) - mean) * window[index]);

  const half = Math.floor(n / 2);
  const raw: Array<{ frequency: number; psd: number }> = [];
  for (let k = 0; k <= half; k += 1) {
    let real = 0;
    let imag = 0;
    for (let i = 0; i < n; i += 1) {
      const angle = (2 * Math.PI * k * i) / n;
      real += windowed[i] * Math.cos(angle);
      imag -= windowed[i] * Math.sin(angle);
    }
    const power = real * real + imag * imag;
    // periodogram one-sided scaling: double interior bins, keep DC/Nyquist single.
    const oneSided = k === 0 || (n % 2 === 0 && k === half) ? 1 : 2;
    const frequency = (k * sampleRate) / n;
    raw.push({ frequency, psd: power * scale * oneSided });
  }

  const valid = raw.filter(
    (entry) => entry.frequency >= minFreq && entry.frequency <= maxFreq,
  );
  const totalPower = valid.reduce((acc, entry) => acc + entry.psd, 0);
  const bins = valid.map((entry) => ({
    frequency: entry.frequency,
    amplitude:
      totalPower > 0 && Number.isFinite(totalPower)
        ? (entry.psd / totalPower) * 100
        : 0,
  }));

  let peak: { frequency: number; amplitude: number } | null = null;
  for (const bin of bins) {
    if (bin.amplitude > 0 && (!peak || bin.amplitude > peak.amplitude)) {
      peak = { frequency: bin.frequency, amplitude: bin.amplitude };
    }
  }
  return { bins, peak };
}

export type ReviewPaneAxis = "raw" | "filtered" | "tf" | "fft";

/**
 * Map a pointer position over a review pane into data coordinates.
 * `fraction` is the cursor's horizontal position within the plot rect [0,1],
 * accounting for the active x view-transform (panX/zoom in SVG user units).
 */
export function paneCursorXFraction(
  pointerX: number,
  plotX: number,
  plotWidth: number,
  panX: number,
  zoom: number,
): number {
  if (plotWidth <= 0) return 0;
  const safeZoom = Math.abs(zoom) < 1e-6 ? 1 : zoom;
  // SVG renders content as translate(panX) scale(zoom); invert to user space.
  const userX = (pointerX - panX) / safeZoom;
  return clampNumber((userX - plotX) / plotWidth, 0, 1);
}

/**
 * Hover readout string, parity with annotation_plot._update_hover_display
 * (annotation_plot.py:714-739): "t=…s | raw=… | filtered=… | freq/y=…".
 */
export function paneHoverReadout(
  axis: ReviewPaneAxis,
  time: number,
  values: { raw?: number | null; filtered?: number | null; y?: number | null; freq?: number | null },
): string {
  const parts = [`t=${time.toFixed(4)}s`];
  if (typeof values.raw === "number" && Number.isFinite(values.raw)) {
    parts.push(`raw=${values.raw.toFixed(2)}`);
  }
  if (typeof values.filtered === "number" && Number.isFinite(values.filtered)) {
    parts.push(`filtered=${values.filtered.toFixed(2)}`);
  }
  if (axis === "tf") {
    const freq = typeof values.freq === "number" ? values.freq : 0;
    parts.push(`freq=${freq.toFixed(1)}Hz`);
  } else if (axis === "fft") {
    const freq = typeof values.freq === "number" ? values.freq : 0;
    const psd = typeof values.y === "number" ? values.y : 0;
    parts.push(`freq=${freq.toFixed(1)}Hz`, `psd=${psd.toFixed(2)}%`);
  } else if (typeof values.y === "number" && Number.isFinite(values.y)) {
    parts.push(`y=${values.y.toFixed(2)}`);
  }
  return parts.join(" | ");
}

/**
 * Look up the nearest sample value at `time` from a (times, signal) series.
 * Parity with annotation_plot._lookup_signal_value (annotation_plot.py:696-705).
 */
export function lookupSeriesValueAtTime(
  times: number[] | undefined,
  signal: number[] | undefined,
  time: number,
): number | null {
  if (!times || !signal || times.length === 0 || signal.length === 0) return null;
  let lo = 0;
  let hi = times.length - 1;
  // searchsorted-style nearest index.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  const index = clampNumber(lo, 0, signal.length - 1);
  const value = signal[index];
  return Number.isFinite(value) ? value : null;
}

/**
 * Wheel-zoom transform, parity with annotation_plot.wheelEvent
 * (annotation_plot.py:741-790): scroll up (deltaY<0) zooms in (×1.3),
 * scroll down zooms out (÷1.3), keeping the cursor's data point anchored.
 * Operates on the x view-transform {zoom, panX} in SVG user units.
 */
export function wheelZoomTransform(
  current: { zoom: number; panX: number },
  deltaY: number,
  cursorFraction: number,
  plotWidth: number,
  zoomBounds: { min: number; max: number } = { min: 1, max: 24 },
): { zoom: number; panX: number } {
  const factor = deltaY < 0 ? 1.3 : 1 / 1.3;
  const nextZoom = clampNumber(current.zoom * factor, zoomBounds.min, zoomBounds.max);
  if (nextZoom === current.zoom) return current;
  // Anchor: keep the user-space x under the cursor fixed across the zoom.
  const anchorX = clampNumber(cursorFraction, 0, 1) * plotWidth;
  const userX = (anchorX - current.panX) / (current.zoom || 1);
  const nextPanX = anchorX - userX * nextZoom;
  return { zoom: nextZoom, panX: nextPanX };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function snippetSampleRate(snippet: ReviewSnippet | null): number {
  const times = snippet?.waveform?.times_seconds || [];
  if (times.length < 2) return 0;
  const sampleInterval = Math.max(
    1e-6,
    (times[times.length - 1] - times[0]) / Math.max(1, times.length - 1),
  );
  return 1 / sampleInterval;
}

function computeFftBins(
  snippet: ReviewSnippet | null,
): Array<{ frequency: number; amplitude: number }> {
  const row = snippet?.waveform?.data?.[0] || [];
  const sampleRate = snippetSampleRate(snippet);
  if (row.length < 4 || sampleRate <= 0) return [];
  return computeFftSpectrum(row, sampleRate).bins;
}

function computeFftPeak(
  bins: Array<{ frequency: number; amplitude: number }>,
): { frequency: number; amplitude: number } | null {
  let peak: { frequency: number; amplitude: number } | null = null;
  for (const bin of bins) {
    if (bin.amplitude > 0 && (!peak || bin.amplitude > peak.amplitude)) {
      peak = bin;
    }
  }
  return peak;
}

type TimeFrequencyCell = {
  column: number;
  row: number;
  frequency: number;
  intensity: number;
  colormap?: string;
};

function computeFilteredTrace(snippet: ReviewSnippet | null): number[] {
  const backendTrace = snippet?.filtered_trace?.data;
  if (Array.isArray(backendTrace) && backendTrace.length)
    return backendTrace.filter((value) => Number.isFinite(value));
  const row = snippet?.waveform?.data?.[0] || [];
  if (row.length < 3) return row.slice();
  const smoothed = movingAverage(row, 5);
  return row.map((value, index) => value - smoothed[index]);
}

function movingAverage(row: number[], windowSize: number): number[] {
  const radius = Math.max(1, Math.floor(windowSize / 2));
  return row.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = row[index + offset];
      if (Number.isFinite(value)) {
        sum += value;
        count += 1;
      }
    }
    return count ? sum / count : 0;
  });
}

export function computeTimeFrequencyCells(
  snippet: ReviewSnippet | null,
  frequencyRange: [number, number],
): TimeFrequencyCell[] {
  const backendCells = timeFrequencyCellsFromBackend(snippet, frequencyRange);
  if (backendCells.length) return backendCells;
  const row = computeFilteredTrace(snippet);
  const times = snippet?.waveform?.times_seconds || [];
  if (row.length < 16 || times.length < 2) return [];
  const sampleInterval = Math.max(
    1e-6,
    (times[times.length - 1] - times[0]) / Math.max(1, times.length - 1),
  );
  const sampleRate = 1 / sampleInterval;
  const nyquist = sampleRate / 2;
  const minHz = Math.max(0, Math.min(frequencyRange[0], frequencyRange[1] - 1));
  const maxHz = Math.min(nyquist, Math.max(minHz + 1, frequencyRange[1]));
  const columns = 24;
  const rows: number = 12;
  const segmentLength = Math.max(8, Math.floor(row.length / columns));
  const amplitudes: TimeFrequencyCell[] = [];
  let maxIntensity = 0;
  for (let column = 0; column < columns; column += 1) {
    const start = Math.min(
      row.length - segmentLength,
      Math.max(0, Math.floor((column / columns) * row.length)),
    );
    const segment = row.slice(start, start + segmentLength);
    for (let band = 0; band < rows; band += 1) {
      const ratio = rows === 1 ? 0 : band / (rows - 1);
      const frequency = maxHz - ratio * (maxHz - minHz);
      const intensity = dftAmplitudeAtFrequency(segment, sampleRate, frequency);
      maxIntensity = Math.max(maxIntensity, intensity);
      amplitudes.push({ column, row: band, frequency, intensity });
    }
  }
  return amplitudes.map((cell) => ({
    ...cell,
    intensity: maxIntensity > 0 ? cell.intensity / maxIntensity : 0,
  }));
}

export function timeFrequencyCellsFromBackend(
  snippet: ReviewSnippet | null,
  frequencyRange: [number, number],
): TimeFrequencyCell[] {
  const matrix = snippet?.time_frequency?.intensity;
  if (!Array.isArray(matrix) || !matrix.length) return [];
  const frequencies = snippet?.time_frequency?.frequencies_hz || [];
  const rows = matrix.length;
  const columns = Math.max(
    0,
    ...matrix.map((row) => (Array.isArray(row) ? row.length : 0)),
  );
  if (!rows || !columns) return [];
  const highFrequencyAtTop = snippet?.time_frequency?.high_frequency_at_top !== false;
  const frequencyBySourceRow = Array.from({ length: rows }, (_, row) => {
    const explicitFrequency = Number(frequencies[row]);
    if (Number.isFinite(explicitFrequency)) return explicitFrequency;
    const ratio = rows <= 1 ? 0 : row / (rows - 1);
    return highFrequencyAtTop
      ? frequencyRange[1] - ratio * (frequencyRange[1] - frequencyRange[0])
      : frequencyRange[0] + ratio * (frequencyRange[1] - frequencyRange[0]);
  });
  const displayRowBySourceRow = timeFrequencyDisplayRowBySourceRow(
    frequencyBySourceRow,
    highFrequencyAtTop,
  );
  let maxIntensity = 0;
  let minIntensity = Number.POSITIVE_INFINITY;
  const cells: TimeFrequencyCell[] = [];
  for (let row = 0; row < rows; row += 1) {
    const values = matrix[row] || [];
    const frequency = frequencyBySourceRow[row];
    if (frequency < frequencyRange[0] || frequency > frequencyRange[1])
      continue;
    const displayRow = displayRowBySourceRow[row] ?? row;
    for (let column = 0; column < columns; column += 1) {
      const intensity = Number(values[column] || 0);
      maxIntensity = Math.max(maxIntensity, intensity);
      minIntensity = Math.min(minIntensity, intensity);
      cells.push({
        column,
        row: displayRow,
        frequency,
        intensity,
        colormap: snippet?.time_frequency?.colormap,
      });
    }
  }
  /* PyQt Annotation time-frequency display-limit parity: backend review.py and
   * the visual fixture already return the PyQt log/percentile display matrix in
   * [0, 1], so do not re-normalize it by the screenshot-local max. Re-normalizing
   * makes quiet bins too bright and diverges from annotation_plot.py levels.
   */
  if (
    Number.isFinite(minIntensity) &&
    minIntensity >= 0 &&
    maxIntensity <= 1 &&
    (snippet?.time_frequency?.display_transform ||
      snippet?.time_frequency?.display_limits)
  ) {
    return cells.map((cell) => ({
      ...cell,
      intensity: Math.max(0, Math.min(1, cell.intensity)),
    }));
  }
  return cells.map((cell) => ({
    ...cell,
    intensity: maxIntensity > 0 ? cell.intensity / maxIntensity : 0,
  }));
}

export function timeFrequencyDisplayRowBySourceRow(
  frequencies: number[],
  highFrequencyAtTop = true,
): number[] {
  const finiteRows = frequencies
    .map((frequency, sourceRow) => ({ frequency, sourceRow }))
    .filter((entry) => Number.isFinite(entry.frequency));
  if (!finiteRows.length)
    return frequencies.map((_, row) =>
      highFrequencyAtTop ? row : frequencies.length - 1 - row,
    );
  // SVG y increases downward, while the review TF axis is high-frequency-at-top.
  // Always map higher frequency values to smaller display rows; the backend flag
  // is only a fallback hint when explicit frequencies are missing.
  const sorted = finiteRows
    .slice()
    .sort((a, b) => b.frequency - a.frequency || a.sourceRow - b.sourceRow);
  const displayRows = frequencies.map((_, row) => row);
  sorted.forEach((entry, displayRow) => {
    displayRows[entry.sourceRow] = displayRow;
  });
  return displayRows;
}

function dftAmplitudeAtFrequency(
  segment: number[],
  sampleRate: number,
  frequency: number,
): number {
  if (!segment.length || frequency <= 0 || sampleRate <= 0) return 0;
  let real = 0;
  let imag = 0;
  for (let i = 0; i < segment.length; i += 1) {
    const taper =
      0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, segment.length - 1));
    const angle = (2 * Math.PI * frequency * i) / sampleRate;
    const value = (segment[i] || 0) * taper;
    real += value * Math.cos(angle);
    imag -= value * Math.sin(angle);
  }
  return Math.sqrt(real * real + imag * imag) / segment.length;
}

function timeFrequencyColor(intensity: number, colormap = "magma"): string {
  const clamped = Math.max(0, Math.min(1, intensity));
  if (colormap === "magma") return magmaColor(clamped);
  const hue = 230 - clamped * 190;
  const lightness = 18 + clamped * 44;
  return `hsl(${hue} 88% ${lightness}%)`;
}

function magmaColor(value: number): string {
  const stops: Array<[number, number, number]> = [
    [0.001, 0.0, 0.014],
    [0.063, 0.028, 0.246],
    [0.188, 0.071, 0.391],
    [0.369, 0.092, 0.492],
    [0.55, 0.161, 0.506],
    [0.735, 0.293, 0.435],
    [0.902, 0.484, 0.302],
    [0.997, 0.716, 0.176],
    [0.987, 0.991, 0.75],
  ];
  const scaled = Math.max(0, Math.min(1, value)) * (stops.length - 1);
  const left = Math.floor(scaled);
  const right = Math.min(stops.length - 1, left + 1);
  const ratio = scaled - left;
  const rgb = stops[left].map((channel, index) =>
    Math.round((channel + (stops[right][index] - channel) * ratio) * 255),
  );
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
}

function formatSeconds(value?: number): string {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(3)}s` : "--";
}

function pyqtEventNavigationIndex(
  events: ReviewEvent[],
  currentIndex: number,
  offset: -1 | 1,
): number {
  const normalizedCurrent = Math.min(
    Math.max(0, currentIndex),
    Math.max(0, events.length - 1),
  );
  const currentEvent = events[normalizedCurrent];
  if (offset < 0 && normalizedCurrent === 0 && isSpindleEvent(currentEvent))
    return 0;
  return (normalizedCurrent + offset + events.length) % events.length;
}

function isSpindleEvent(event?: ReviewEvent | null): boolean {
  return String(event?.biomarker || "")
    .toLowerCase()
    .includes("spindle");
}

function eventDisplayName(
  event: ReviewEvent | null,
  activeRun: RunRecord | null,
): string {
  return String(event?.biomarker || activeRun?.biomarker || "detected");
}

function eventOptionLabel(event: ReviewEvent, index: number): string {
  const label = annotationDisplayLabel(event.annotation);
  return `No.${index + 1}: ${event.channel || "--"} : ${label}`;
}

function annotationDisplayLabel(
  annotation?: ReviewEvent["annotation"],
): string {
  if (!annotation) return "Unannotated";
  return String(annotation.display_label || annotation.label || "Unannotated");
}

function selectedReviewStatusText(event: ReviewEvent | null): string {
  return annotationDisplayLabel(event?.annotation);
}

/**
 * Per-event classifier predictions, mirroring PyQt hfo_feature semantics.
 * artifact: PyQt artifact_predictions[i] (-1 unpredicted, 0 artifact, 1 real).
 * spike/ehfo: PyQt spike_predictions[i] / ehfo_predictions[i] (==1 means that class).
 * `null` means the prediction column is absent for that event.
 */
export type EventPredictionData = {
  artifact: number | null;
  spike: number | null;
  ehfo: number | null;
  overlapTagged: boolean;
};

const PYQT_PREDICTION_ARTIFACT_KEYS = [
  "artifact_prediction",
  "artifact_predictions",
  "artifact_pred",
  "artifact",
  "Artifact",
];
const PYQT_PREDICTION_SPIKE_KEYS = [
  "spike_prediction",
  "spike_predictions",
  "spike_pred",
  "spike",
  "spkHFO",
  "spkhfo",
];
const PYQT_PREDICTION_EHFO_KEYS = [
  "ehfo_prediction",
  "ehfo_predictions",
  "ehfo_pred",
  "ehfo",
  "eHFO",
];

function firstNumericField(
  source: Record<string, unknown> | undefined,
  keys: string[],
): number | null {
  if (!source) return null;
  for (const key of keys) {
    if (!(key in source)) continue;
    const raw = source[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof raw === "boolean") return raw ? 1 : 0;
  }
  return null;
}

/**
 * Extract prediction columns from a ReviewEvent. Predictions may live either
 * directly on the event or inside `event.features` (backend payload shape).
 */
export function eventPredictionData(event: ReviewEvent): EventPredictionData {
  const features = (event.features || {}) as Record<string, unknown>;
  const top = event as unknown as Record<string, unknown>;
  return {
    artifact:
      firstNumericField(features, PYQT_PREDICTION_ARTIFACT_KEYS) ??
      firstNumericField(top, PYQT_PREDICTION_ARTIFACT_KEYS),
    spike:
      firstNumericField(features, PYQT_PREDICTION_SPIKE_KEYS) ??
      firstNumericField(top, PYQT_PREDICTION_SPIKE_KEYS),
    ehfo:
      firstNumericField(features, PYQT_PREDICTION_EHFO_KEYS) ??
      firstNumericField(top, PYQT_PREDICTION_EHFO_KEYS),
    overlapTagged: eventHasOverlapTag(event),
  };
}

/**
 * Prediction-based review scope options, parity with
 * hfo_feature.get_prediction_scope_options (hfo_feature.py:504-516).
 * Decision-based scopes (keyed off the human annotation.label) are kept too.
 */
export function eventScopeOptions(events: ReviewEvent[]): string[] {
  const options: string[] = ["All events"];
  const predictions = events.map((event) => eventPredictionData(event));
  const eventCount = events.length;

  // get_prediction_scope_options:506 — "Unreviewed" when some events are unannotated.
  if (eventCount > 0 && events.some((event) => !event.annotation)) {
    options.push("Unreviewed");
  }
  // get_prediction_scope_options:508 — artifact predictions present.
  const artifactPredicted = predictions.some((pred) => pred.artifact !== null);
  if (artifactPredicted) {
    options.push("Artifact", "Non-artifact");
    // :510 spike column present for every event.
    if (
      eventCount > 0 &&
      predictions.every((pred) => pred.spike !== null)
    ) {
      options.push("spkHFO");
    }
    // :512 ehfo column present for every event.
    if (
      eventCount > 0 &&
      predictions.every((pred) => pred.ehfo !== null)
    ) {
      options.push("eHFO");
    }
  }
  // get_prediction_scope_options:514 — overlap-tagged events present.
  if (predictions.some((pred) => pred.overlapTagged)) {
    options.push("Overlap tagged");
  }

  // Keep decision-based scopes (human annotation.label) available too.
  const decisionScopes = ["Accepted", "Rejected", "Decided Artifact", "Uncertain"];
  return [...options, ...decisionScopes];
}

/**
 * True when `event` matches `scope`, parity with
 * hfo_feature._matches_prediction_scope (hfo_feature.py:518-541).
 */
export function eventMatchesScope(event: ReviewEvent, scope: string): boolean {
  if (!scope || scope === "All events" || scope === "All") return true;

  const pred = eventPredictionData(event);
  const label = String(event.annotation?.label || "").toLowerCase();

  // :523 Unreviewed = no annotation.
  if (scope === "Unreviewed") return !event.annotation;
  // :525 Overlap tagged.
  if (scope === "Overlap tagged") return pred.overlapTagged;

  // Decision-based scopes (human label). "Decided Artifact" disambiguates the
  // human "Artifact" decision from the prediction-based "Artifact" scope.
  if (scope === "Accepted") return label === "accepted";
  if (scope === "Rejected") return label === "rejected";
  if (scope === "Decided Artifact") return label === "artifact";
  if (scope === "Uncertain") return label === "uncertain";

  // Prediction-based scopes require an artifact prediction (:527).
  if (pred.artifact === null) return false;
  // :531-532 Artifact = artifact prediction indicates artifact (< 1).
  if (scope === "Artifact") return pred.artifact < 1;
  // :533-534 Non-artifact = artifact prediction indicates real (> 0).
  if (scope === "Non-artifact") return pred.artifact > 0;
  // :535-536 spkHFO/eHFO only among non-artifact (real) events.
  if (pred.artifact < 1) return false;
  // :537-538 spkHFO = spike prediction == 1.
  if (scope === "spkHFO") return pred.spike === 1;
  // :539-540 eHFO = ehfo prediction == 1.
  if (scope === "eHFO") return pred.ehfo === 1;
  return false;
}

/**
 * Filter events for a review scope, parity with
 * hfo_feature.get_matching_indexes (hfo_feature.py:543-553).
 * `unannotatedOnly` mirrors the `unannotated_only` flag (:551).
 */
export function filterEventsForScope(
  events: ReviewEvent[],
  scope: string,
  unannotatedOnly: boolean,
): ReviewEvent[] {
  return events.filter((event) => {
    if (unannotatedOnly && event.annotation) return false;
    return eventMatchesScope(event, scope);
  });
}

function eventHasOverlapTag(event: ReviewEvent): boolean {
  // Backend _review_events_for_run emits the explicit numeric `overlap_tagged` key
  // only when an event is actually tagged (>0), mirroring PyQt overlap_tagged. Check
  // that key directly instead of substring-scanning the features JSON, which would
  // false-positive on any future key or value containing "overlap"/"cross-channel".
  const features = (event.features || {}) as Record<string, unknown>;
  const tag = Number(features.overlap_tagged);
  return Number.isFinite(tag) && tag > 0;
}

function modelSummaryText(
  event: ReviewEvent | null,
  activeRun: RunRecord | null,
): string {
  if (!event) return "No selected event";
  const featureKeys = Object.keys(event.features || {});
  if (!featureKeys.length) return "No model suggestion";
  const overlap = eventHasOverlapTag(event) ? " · Cross-channel overlap" : "";
  return `${event.biomarker || activeRun?.biomarker || "Event"}${overlap}${featureKeys.length ? ` · ${featureKeys.slice(0, 4).join(", ")}` : ""}`;
}

function featureSummaryRows(
  summary: EventFeatureSummary | null,
  event: ReviewEvent | null,
): Array<[string, string]> {
  const features = summary?.summary?.features || event?.features || {};
  return Object.entries(features)
    .filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    )
    .slice(0, 12)
    .map(
      ([key, value]) => [key, formatFeatureValue(value)] as [string, string],
    );
}

function formatFeatureValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatFeatureValue).join(", ");
  if (typeof value === "number")
    return Number.isFinite(value) ? Number(value.toFixed(4)).toString() : "--";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value ?? "--");
}

function humanizeFeatureKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function intervalPaddingSeconds(interval: ReviewInterval): number {
  const parsed = Number(interval.replace("s", ""));
  return Number.isFinite(parsed) ? parsed : 1;
}

function reviewIntervalLabel(interval: ReviewInterval): string {
  return interval;
}

function isReviewInterval(value: string): value is ReviewInterval {
  return ["1s", "0.5s", "0.25s", "4s", "3.5s"].includes(value);
}

function reviewBiomarkerType(
  event: ReviewEvent | null,
  activeRun: RunRecord | null,
): "HFO" | "Spindle" | "Spike" {
  const text = String(
    event?.biomarker || activeRun?.biomarker || "",
  ).toLowerCase();
  if (text.includes("spindle")) return "Spindle";
  if (text.includes("spike")) return "Spike";
  return "HFO";
}

function isEditableReviewShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName) ||
    target.isContentEditable
  );
}

function annotationShortcutHint(
  biomarker: "HFO" | "Spindle" | "Spike",
): string {
  if (biomarker === "Spindle")
    return "Shortcuts: ←/A previous · →/D next · 1 Real · 2 Spike · 3 Artifact · Enter save+next · Backspace clear · Esc clear FFT ROI";
  if (biomarker === "Spike")
    return "Shortcuts: ←/A previous · →/D next · 1 Accepted · 2 Artifact · Enter save+next · Backspace clear · Esc clear FFT ROI";
  return "Shortcuts: ←/A previous · →/D next · 1 Pathological · 2 Physiological · 3 Artifact · Enter save+next · Backspace clear · Esc clear FFT ROI";
}
