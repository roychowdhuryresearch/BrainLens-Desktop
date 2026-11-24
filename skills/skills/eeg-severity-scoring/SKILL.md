---
name: eeg-severity-scoring
version: 0.1.0
description: Score a scalp EEG recording's overall severity (0-5 per 15-second segment) with the BASED model, for "how severe / how abnormal is this EEG" requests.
category: neuroscience
keywords: [severity, severity score, how severe, how abnormal, abnormality, grade, grading, rate the eeg, overall score, background severity, encephalopathy, BASED, scalp eeg severity]
triggers: [severity, severe, how severe, how bad, how abnormal, abnormality, grade, grading, rate this eeg, score the eeg, overall severity, background severity]
allowed_tools: [get_ui_state, pyhfo_get_recording_info, pyhfo_run_severity_scoring]
priority: 90
when_to_use: Use when the user asks how severe, abnormal, or bad a scalp EEG recording is overall, or wants it graded/scored as a whole rather than asking for detected events.
do_not_use: Do not use on intracranial (iEEG/sEEG/ECoG) recordings - the model is scalp-only. Do not turn the score into a clinical severity diagnosis, prognosis, or treatment guidance. Do not run detection first; severity is whole-recording and needs no detection run.
output_format: The artifact-excluded mean and peak score on the 0-5 scale (clean_mean_score / clean_peak_score / clean_peak_time_sec), when the peak occurred, how many 15-second segments were scored, how many were excluded as artifact, and the explicit caveat that this is a signal-derived research score for human review.
---

## What this is

The BASED severity model scores a scalp EEG in consecutive **15-second segments**, each on a **0-5 scale where 0 is benign and 5 is severe**, and reports the mean, the peak, and the peak's timestamp.

It is **whole-recording**: no detection run, no biomarker, and no detector are involved. Never run HFO/spindle/spike detection as a prerequisite for it.

**Scalp EEG only.** The model consumes the conventional 10-20 (TUEG-19) montage. On an intracranial recording the answer is "severity scoring does not apply to intracranial recordings," not a score.

## Which numbers to report

The result carries two sets of statistics. Report the **clean** ones:

| Field | Meaning |
|---|---|
| `clean_mean_score`, `clean_peak_score`, `clean_peak_time_sec` | Artifact segments excluded. **Quote these.** |
| `mean_score`, `peak_score`, `peak_time_sec` | Every segment, artifact included. Fallback only when the clean fields are absent or null. |
| `num_clean_segments`, `num_segments`, `artifact_threshold_uv` | How many segments survived the artifact filter, out of how many, at what microvolt threshold. |

A segment is flagged `artifact` when any scalp channel in it swings past `artifact_threshold_uv` (1000 uV) - movement or a loose electrode, not brain activity. The desktop panel and its severity navigation both rank on the clean set, so quoting `mean_score` would tell the user a different number from the one on their screen. When segments were excluded, say so: "mean 2.31, peak 4.42 at 12:45 (18 of 240 segments excluded as artifact)".

## Workflow

### Preflight (both modes)

1. Establish the recording type before scoring. `pyhfo_get_recording_info` returns `eeg_type`, and `get_ui_state` exposes the same value on the loaded recording.
   - `eeg_type == "scalp"` → proceed.
   - `eeg_type == "ieeg"` → say severity scoring is scalp-only and stop. Do not score anyway and caveat it afterwards.
2. If the backend returns an `invalid_recording` error saying no channels match the TUEG-19 layout, that is the same situation reported at a lower level: report it as "this recording isn't scalp EEG in the 10-20 layout," not as a crash.

### Running it

There is one way to score a recording: call `pyhfo_run_severity_scoring`. Do not decide where the
work should happen — the tool does that. With the desktop attached it hands the run to the workspace
so the confirmation gate, the progress bar and the Severity panel all behave as they do when the
clinician clicks the button; headless, it computes directly. Same call either way.

1. Call `pyhfo_run_severity_scoring`. `input_path` defaults to the loaded recording; pass it explicitly when scoring a specific file. Optional: `export_csv` to also write per-segment scores, `model_dir` to override the bundled checkpoint.
2. Read the numbers out of the result (`mean_score`, `peak_score`, `peak_time_sec`, `num_segments`) and report them. When the desktop is attached the run happened in the clinician's own workspace, so the Severity panel is already showing what you are about to say — they will match, because they are the same run.
3. Never estimate, recall or invent a score under any circumstance. If you did not receive numbers in a tool result this turn, you do not have them.
4. Surface any `warnings` in the result. In particular, a recording shorter than one 15-second segment produces no score, and a non-scalp recording produces an explicit warning.

Do not call `emit_ui_command` with `severity.run`. It reaches the same place, but two names for one
action is how a run ends up half-tracked.

## Reporting the result

State the mean and peak on the 0-5 scale, note when the peak occurred, and say how many segments were scored (it tells the reader how much recording backed the number).

Keep the framing signal-derived: "the model scored this recording 1.8 mean / 3.1 peak on its 0-5 severity scale," not "this patient has moderate encephalopathy." The score is a research artifact for expert review — it is not a diagnosis, not a prognosis, and not treatment guidance.

If the score is being compared across recordings, note that only recordings scored with the same model and the same montage are comparable.
