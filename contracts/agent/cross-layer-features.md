# Cross-layer iEEG research features

Status: Canonical

Machine map: [feature-map.json](feature-map.json)

The horizontal XLP protocols define envelopes and schemas. These nine `XLF-*` slices define the end-to-end research outcomes a reviewer must be able to trace through Agent intent, UI/PyHFO execution, receipt evidence, and final claims.

## Shared trace

Every slice follows the same closed loop:

`scoped request → catalog-valid command → actor/precondition validation → execution → typed receipt → read-back/postcondition → evidence-linked claim → done`

Any missing scope, unknown enum, stale state revision, rejected/no-op action, missing terminal receipt, unresolved evidence reference, or stream EOF before `done` breaks that loop and therefore blocks a success claim.

## Feature slices

| Feature | Outcome | Primary command groups | Required proof |
| --- | --- | --- | --- |
| `XLF-LOAD` | One fingerprinted recording and UI revision are authoritative | workspace, recording, project open | fingerprint, sampling frequency, channels, state revision |
| `XLF-QC` | QC/spectral evidence is interval- and channel-scoped | ROI, QC, spectral, prepare | interval, Nyquist/line frequency, exclusions with reasons |
| `XLF-CONFIGURE` | Detector/classifier choices are explicit before compute | plan and set parameters | biomarker, algorithm/version, exact parameter payload/digest, channel scope |
| `XLF-DETECT` | Confirmed detection produces a unique, reproducible run | detection, batch | run ID, algorithm/version, parameters, artifact checksum, candidate count |
| `XLF-CLASSIFY` | Predictions bind to the exact existing run and model | classification | source run, model digest, classifier settings, event prediction refs |
| `XLF-RANK` | Candidate ranking declares denominator and aggregation | rank/show/focus | exact run IDs, duration, exclusions, denominator, aggregation method |
| `XLF-REVIEW` | What the reviewer viewed is tied to run/event/viewport evidence | waveform/event/review | run/event IDs, viewport interval, snippet/feature evidence |
| `XLF-ANNOTATE` | Human review writes are actor-bound and auditable | stage/clear annotation | review receipt and actor, event/run, before/after annotation |
| `XLF-EXPORT` | Saved outputs are reproducible and checksummed | session/workbook/report/project | fingerprint, runs, software/parameter versions, artifact URI/checksum |

## Clinical semantics

### LOAD

Loading is a scope transition, not a cosmetic action. Every downstream command is rejected if its recording fingerprint or state revision no longer matches the desktop. A path string alone is not a stable recording identity.

### QC

QC and spectral output describe the evaluated data interval and method. They do not establish diagnosis, anatomy, or SOZ. Channel exclusion is evidence-bearing: the excluded channel and reason are retained rather than collapsed into a count.

### CONFIGURE

The Agent may recommend parameters, but it may not silently choose clinically meaningful detector families, filter bounds, thresholds, classifiers, or channel scope. The exact parameter object and canonical digest become provenance for every derived run.

### DETECT

Detector output is always represented as candidate evidence. A successful command receipt proves that the run and artifacts exist; it does not upgrade candidates to confirmed events. The output remains bound to recording, run, algorithm version, and parameters.

### CLASSIFY

Classification consumes an explicit source run. If implementation limitations force redetection, that behavior is a declared fallback that creates and returns a new run ID; it cannot masquerade as classification of the original run.

### RANK

Rankings are meaningless without their denominator and run scope. Single-run ranking is the default. Multi-run comparison requires an explicit list of runs and named aggregation method; a tool may not quietly blend all available runs.

### REVIEW

Waveform navigation and event comparison are evidence acquisition. A visual impression remains a hypothesis unless the output records the exact run/event, viewport or snippet, and later review action. Channel labels are identifiers, not anatomy.

### ANNOTATE

`reviewed` and `confirmed` are human provenance states. They require a review receipt and named review actor. Agent-generated text or detector/classifier output cannot self-promote a claim to these states.

### EXPORT

An export succeeds only after the artifact is written, read back, and checksummed. A queued write, chosen output path, or renderer toast is not completion. Exported reports retain the research-only guardrails and all run/recording provenance.

## Ownership and proof

Each row in `feature-map.json` names exact owners and proof files. The contract audit verifies that every catalog command belongs to exactly one slice, every referenced `$def` and event exists, every schema definition/event has reverse ownership through a feature or shared runtime element, and all owner/proof paths resolve in the repository.
