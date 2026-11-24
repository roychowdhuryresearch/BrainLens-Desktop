# Electron Real-Recording Release Coverage Matrix

Date: 2026-06-03

This matrix separates **local production parity signoff** from **external release readiness**.

Current local signoff evidence proves the Electron app can load one real EDF through the Electron bridge, run a bounded preparation/detection/classification/review/export workflow, and produce signoff artifacts. It does not prove every recording format, detector family, device profile, or release packaging path is ready for outside users.

## Current Passing Evidence

Latest artifact: `desktop/artifacts/electron-real-recording-smoke.json`.

| Area | Current evidence | Status |
| --- | --- | --- |
| Recording format | EDF fixture: `data/Omni-iEEG/sub-sourcesinkumf001/..._ieeg.edf` | Passed |
| Renderer + backend bridge | Electron preload to local PyHFO backend, 0 console errors, 0 page errors, 0 dialogs | Passed |
| Recording metadata | 10 channels, ~999.41 Hz sample frequency | Passed |
| Prepare flow | 10 prepared channels | Passed |
| Detection | HFO / STE, 12 events across 8 channels | Passed |
| Classification | default CPU artifact classifier, 12 classified events | Passed |
| Review | One event annotation persisted with reviewer/source metadata | Passed |
| Exports | session, report, workbook artifacts generated | Passed |
| Packaged structure | `desktop/artifacts/packaged/iEEG.app` smoke passed | Passed |
| Visual parity | Six PyQt/Electron states in manifest mode with manual-region metadata | Passed locally |

## Release Coverage Still Needed

Use this table before external distribution, especially if the app will be used outside this machine or by non-developer researchers.

| Release surface | Required coverage | Current status |
| --- | --- | --- |
| Formats | EDF, BDF, FIF, FIF.GZ, BrainVision/VHDR representative cases | EDF only |
| Biomarkers | HFO, Spindle, Spike end-to-end detection/review/export | HFO only |
| HFO detectors | STE, MNI, HIL, RMS, LineLength | STE only |
| Spindle detectors | YASA, LSM, A7, MOLLE, including optional dependency unavailable states | Not release-covered |
| Spike detector | RMS/LL real fixture | Not release-covered |
| Classifier modes | default CPU, default GPU where available, local model archive, offline model cache failure | CPU artifact only |
| Native dialogs | open/save/cancel/error for recording, session, project, protocol, report, workbook, snapshot | Partly smoke-tested; semantic native-dialog coverage still marked as a gap |
| Waveform matrix | channel caps, average reference, auto bipolar, manual bipolar, filtered source, 60 Hz, partial backend failure | Partly covered |
| Close/save lifecycle | save-before-close, discard, timeout, save failure, repeated close | Unit-covered; Electron integration still partial |
| Agent/batch/artifact side effects | agent chat, staged commands, batch create/run, artifact open/reveal/remove/recovery | Partly skipped by safe-click smoke |
| Packaging | signed, notarized, installer/distribution channel, versioning, rollback | Local structure smoke only |
| Security/privacy | PHI handling policy, local-only data boundary, secrets review, crash log redaction | Not release-certified |
| Clinical/regulatory | research-only labeling, CDS/SaMD assessment, user-facing limitations | Not release-certified |

## Commands

Local parity bundle:

```bash
cd desktop
npm run qa:production-parity
npm run qa:signoff
```

Electron real-recording smoke:

```bash
cd desktop
npm run qa:electron-real-recording
```

Format-specific smoke, when representative recordings are available:

```bash
cd desktop
PYHFO_PARITY_FIXTURE_RECORDING=/absolute/path/to/case.edf \
PYHFO_PARITY_RUN_DETECTION=1 \
PYHFO_PARITY_BIOMARKER=HFO \
PYHFO_PARITY_DETECTOR=STE \
npm run qa:real-fixture
```

For release candidates, run the format/biomarker/detector matrix above and attach each artifact path to the release checklist. Do not substitute the synthetic visual fixture for clinical detector evidence.
