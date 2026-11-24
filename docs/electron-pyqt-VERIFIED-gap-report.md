# Electron ↔ PyQt — VERIFIED Gap Report (independent re-verification)

_Generated: 2026-06-01 by a fresh ground-truth audit. This supersedes the optimistic claims in `electron-pyqt-production-status.md`._

## Why this doc exists

The user asked for the Electron app to become functionally ≈ the PyQt app (plus Electron-native optimizations), and explicitly said **not to trust** the existing "all green" status. This report is the result of reading the actual code on both sides (not manifests, comments, or marker strings).

## Verdict on the existing "green" suite: largely self-referential

The passing `qa:production-parity` suite does **not** measure behavioral parity:

- **`parity-audit.mjs`** regex-greps `src/parity/pyqtParityManifest.ts` for hand-written `status: 'implemented'` strings and checks that *evidence files exist*. It never runs the app.
- **`pyqt-source-audit.mjs`** is a string-presence crosswalk: it checks PyQt `.ui` objects exist and that the Electron source literally `.includes("marker")`. Presence of a substring ≠ working feature.
- The **59 node tests** assert the Electron side's *own* module contracts — they cannot detect divergence from PyQt because PyQt is never consulted.
- **Visual baseline is partly fabricated**: 3 of 5 "PyQt reference" screenshots (`closed-agent-loaded-workspace`, `open-agent-workspace`, `recording-info-or-runtime-log-dialog`) are byte-identical (md5 `c69e34bc…`) — the same image reused for 3 states.
- The prior ralph run self-graded a "visual_verdict score 94 / pass" — a self-assessment, not external verification, and it missed every clinical-safety bug below.

Net: the suite is green, yet real clinical-parameter divergences sail straight through it.

## Architecture (so "wired" means something)

The Electron renderer (`desktop/src`, ~13k LOC React/TS) is a thin front-end over the **same Python backend** the PyQt app uses (`desktop/src/api/backendClient.ts` → `pyhfo/src/pyhfo/agent_api` sidecar). So detector *algorithms* are shared; true parity is about **UI/interaction coverage, parameter fidelity, and wiring**.

## VERIFIED P0 — clinical-safety / correctness (must match PyQt)

| ID | Gap | PyQt source of truth | Electron | Evidence |
|----|-----|----------------------|----------|----------|
| P0-1 | YASA spindle `duration` max default is wrong | `ParamYASA duration=(0.5, 2)` → **2.0 s** (`param_detector.py:282`) | `'2.5'` (copied from A7 by mistake) | `quickDetectionModel.ts:81` |
| P0-2 | Quick Detection filter band not retuned per biomarker | Spike → `pass_band=4, stop_band=80` (`ParamSpikeRMSLL`, `param_detector.py:485`); Spindle → its own band | QD filter hardcoded `fp:'80', fs:'500'` for **all** biomarkers; `setBiomarker` never touches filter | `quickDetectionModel.ts:259`, `QuickDetectionDialog.tsx:92-94` |
| P0-3 | Annotation label fidelity lost | PyQt persists literal `Pathological`/`Physiological`/`Real`/`Spike` | All collapse to backend `label='accepted'`; only `display_label` keeps the class → scope filters & exports keyed on `label` are lossy | `App.tsx:1463` |
| P0-4 | Classifier required-file validation missing | PyQt blocks run if artifact model path missing when classifier enabled (`quick_detection.py:1724`) | QD submits `artifact_path: null` with no guard | `quickDetectionModel.ts:478-499` |
| P0-5 | STE window unit display mismatch | `ParamSTE rms_window=3e-3, min_window=6e-3, min_gap=10e-3` | ms/seconds display differs; fields blank if backend unreachable | `quickDetectionModel.ts:45-49` |

## VERIFIED P1 — important behavior / parity gaps

**Waveform plot (`WaveformCanvas.tsx`, `WaveformToolbar.tsx`):**
- Canvas size hardcoded `width={900} height={360}`, no `ResizeObserver` → distorted on any non-900px layout (`WaveformCanvas.tsx:183`).
- Calibration **scale bar (100 µV)** missing (PyQt `main_waveform_plot_view.py:736`).
- **Event-type colors** (artifact/spike/eHFO) missing; all events colored by run-state only (`WaveformCanvas.tsx:491`).
- **Measurement µV readout** reports normalized display value as if µV (`WaveformCanvas.tsx:133`).
- **Neighbors / Clean focus modes are stubs** — button sets state, no channel subsetting logic exists.
- **Overview / range-band minimap** missing (PyQt has full-recording navigator).
- Norm/amplitude applied client-side only vs PyQt server-side std-normalization → different trace amplitudes.

**Event Review / Annotation (`EventReviewDialog.tsx`):**
- Footer advertises "Shift-drag: box zoom | Alt-drag: FFT ROI | Wheel: zoom | Drag: pan" but **none are implemented** (SVG panes have no pointer handlers).
- **FFT ROI** (Alt-drag region → recompute FFT) missing.
- **Frequency-range Apply** only clips already-loaded client bins; does not round-trip to backend `review_time_frequency` with the new range.
- **FFT** is a naive ≤64-bin JS DFT (no Hann window, no PSD-% normalization) vs PyQt scipy `periodogram`.
- **Sync-X** checkbox is inert (no plot reads it).
- **Compare Runs** button sums counts locally; doesn't use backend `overlap_review`.
- No live **hover readout** on any plot.

**Quick Detection (`quickDetectionModel.ts`, `QuickDetectionDialog.tsx`):**
- No filter `fp<fs` / Nyquist validation.
- CPU/GPU default buttons only flip device string; don't load HuggingFace default model cards/paths (PyQt populates them).
- STE/HIL/Spike(RMS/LL) fields have no local default seeds → blank when `detectorDefaults` call fails (PyQt always seeded).

**Export (`App.tsx`):**
- Waveform snapshot not embedded in Electron-triggered HTML report package (`exportRunReport`).
- Electron session schema is `electron-pyqt-session.v1` (Electron RunRecord DTOs), may not round-trip into PyQt `load_checkpoint`.

## Where Electron is genuinely solid (verified)

- **Prepare/Detect/Classify tabs**: 79/94 features wired, mostly P2. All 10 detector forms + full LSM 20-field model surface present and wired; classifier GPU gating reads real capability manifest; ROI/QC exclusions flow into detection payload. Detector defaults fetched from backend (arguably better than PyQt's local defaults).
- **Shell/toolbar**: 21/27 wired, no stubs; project layer + dirty tracking + save-before-close are real improvements over PyQt.
- Most annotation panes (waveform/filtered/TF) use **real backend payloads**, and annotation writes persist via the review API.

## Aggregate (verified, not manifest-claimed)

| Region | Total | Wired | Stub | Missing | Divergent | P0 | P1 |
|--------|------:|------:|-----:|--------:|----------:|---:|---:|
| Shell / toolbar | 27 | 21 | 0 | 2 | 2 | (launchers) | 9 |
| Waveform | 63 | 36 | 3 | 3 | 10 | 0 | 11 |
| Quick Detection | 106 | 58 | 2 | 3 | 42 | 4 | 20 |
| Event Review | 46 | 22 | 2 | 3 | 19 | 3 | 15 |
| Prepare/Detect/Classify/Export | 94 | 79 | 3 | 5 | 3 | 0 | 3 |

## Fixes applied and verified this session

All P0 clinical-safety divergences fixed; major P1 parity gaps closed; architect-reviewed (APPROVED); validated on real clinical data.

| ID | Fix | Verification |
|----|-----|-------------|
| P0-1 | YASA `duration` max `2.5`→`2.0` (ParamYASA) | node test `P0-1 parity` |
| P0-2 | Per-biomarker filter retune + **Nyquist clamp** (HFO 80/500, Spike 4/80, Spindle 1/30; fs clamps below Nyquist, e.g. 98.9 @ 200 Hz) | node tests `P0-2 parity` (×2) |
| P0-4 | Classifier default-loading: `default_cpu/default_gpu`+null paths now loads bundled `ckpt/model_{a,s,e}.tar` (was loading **no model**; the legacy `ckpt/` tar files have since been removed from the repository — weights now come from the pinned Hugging Face model cards, see `pyhfo/docs/checkpoint-to-onnx.md`) | 5 pytest cases; real-fixture run |
| P0-5 | STE/HIL/Spike QD field defaults seeded from Param classes; STE ms↔s round-trip | node test `P0-5 parity` |
| P1-QD | Filter `fp<fs` + `fs<Nyquist` validation | node test `P1-QD parity` |
| P1-WF | Responsive canvas (ResizeObserver+DPR, removed 900×360), 100 µV scale bar, event-type colors, neighbors/clean focus, µV measurement | 10 node tests |
| P1-ER | Prediction-based review scope (Artifact/Non-artifact/spkHFO/eHFO/Overlap), honest pane interactions (wheel-zoom + hover; removed fake gestures), Hann+PSD% FFT, sync-X | 15 node tests |
| Backend | `_review_events_for_run` emits prediction columns (visibility-aligned) so prediction scopes work on real recordings | 4 pytest cases |
| P1-EXP | (Already implemented — agent finding was false) waveform snapshot embedded in HTML report | existing pytest |

**Aggregate verification:** typecheck clean · 89 node tests · 69+ python tests · `qa:production-parity` EXIT=0 · architect review APPROVED · real-fixture detector smoke on `sub-sourcesinkumf005` interictal EDF → STE ran end-to-end, **5 HFO events detected**.

### Corrected over-reported findings (verified false)

Three sub-agent "gap" findings were **false on inspection** — a reminder that even the audit needs auditing:
- "Annotation label collapse loses clinical class" → FALSE: `display_label` preserves Pathological/Physiological/Real/Spike end-to-end. Real gap was prediction-scope parity (fixed).
- "Waveform snapshot missing from HTML report" → FALSE: already captured + embedded + tested.
- "App without `set_default_*` (Spindle/Spike)" → FALSE: both inherit it from `SpindleApp`.

## Genuine external blockers for FINAL signoff (need user/resources)

1. ~~**Real clinical EDF/FIF fixture**~~ → DONE: ran on `data/Omni-iEEG` (sub-sourcesinkumf005), detection complete, 5 events.
2. **Human five-state side-by-side visual review** — still requires a person; the synthetic/duplicated baselines remain unacceptable evidence (3 of 5 PyQt reference PNGs were byte-identical).

## Remaining scoped work (not blockers)

- **OPT** (Electron-native optimizations): overview/range-band minimap (also a parity gap), WebGL/OffscreenCanvas waveform, streaming fetch, async progress. P1-WF already delivered DPR-crisp rendering, responsive canvas, and adaptive render-width downsampling.
- **Follow-up**: Event Review frequency-range Apply backend round-trip (currently clips client bins).
