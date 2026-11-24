# iEEG Workstation v0.1.3 slimming benchmark

Compared with the v0.1.2 release bundle, v0.1.3 reduces the installed
application from 891,136 KiB to 767,968 KiB: 123,168 KiB saved (13.82%).

| Metric | v0.1.2 | v0.1.3 | Change |
| --- | ---: | ---: | ---: |
| Application bundle | 891,136 KiB | 767,968 KiB | -123,168 KiB (-13.82%) |
| Agent runtime | 188,932 KiB | 113,716 KiB | -75,216 KiB (-39.81%) |
| Electron frameworks | 279,328 KiB | 232,688 KiB | -46,640 KiB (-16.70%) |
| Electron locales | 48,848 KiB | 2,280 KiB | -46,568 KiB (-95.33%) |
| PyHFO backend | 418,644 KiB | 418,648 KiB | +4 KiB |
| First window | 16,239 ms | 4,646 ms | -11,593 ms (-71.39%) |
| Main window ready | 17,091 ms | 4,707 ms | -12,384 ms (-72.46%) |

The final bundle passes hard limits of 800 MiB for the application, 140 MiB
for the Agent runtime, 15 seconds to first window, and 18 seconds to main
window ready.

Functional checks passed for packaged startup, pinned Hugging Face ONNX
downloads in online and offline-cache modes, a real EDF workflow (34 detected
and classified HFO events), YASA spindle detection (120 events), and production
signoff. The bundle contains no classifier model files, PyTorch, or
Transformers.

PyHFO is intentionally not smaller in this release. Its MNE/YASA execution path
requires Matplotlib, so the 12.4 MiB Matplotlib runtime remains packaged.
Headless startup stubs YASA's plotting and staging modules, preserving the
cold-start improvement without disabling YASA.
