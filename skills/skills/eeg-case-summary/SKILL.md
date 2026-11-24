---
name: eeg-case-summary
version: 0.1.0
description: Draft a concise case write-up of the signal findings in the register of a clinician presenting at a presurgical case conference — findings, the evidence they rest on, the key uncertainty, research-grade caveats, and what is still needed.
category: neuroscience
keywords: [summary, summarize, write up, write-up, case summary, report, conference, presentation, recap, overview, sign out, hand off, 总结, 汇报, 小结, 报告]
triggers: [summarize, summary, write up, write-up, recap, case summary, report this, give me a report, conference, sign out, 总结, 汇报, 小结]
allowed_tools: [get_ui_state, pyhfo_rank_candidate_channels, emit_ui_command]
priority: 88
when_to_use: Use when the clinician asks to summarize, write up, recap, sign out, or produce a report/conference presentation of the case's signal findings.
do_not_use: Do not state a SOZ/resection/diagnosis; do not invent counts, channels, or paths; do not produce a raw tool dump. Summarize only evidence actually computed in this session.
output_format: A short colleague-style narrative as if presenting at a case conference — (1) what the recording is, (2) what was found and from which run (plain words, no paths), (3) the signal evidence and an honest confidence, (4) the key uncertainty and the research-grade HFO caveat, (5) what is still needed. No headers; no tables unless asked.
---

## Workflow

1. Use `get_ui_state` to read what is ACTUALLY loaded: recording metadata, runs, candidate ranking, review/annotation progress. Summarize only what exists — never fabricate counts, channels, or a run that was not performed.
2. If a detection run exists and the summary needs the ranked channels, ground them with `pyhfo_rank_candidate_channels` (or the candidate ranking already in state) rather than recalling numbers from memory.
3. Write in the voice of a clinician at a presurgical case conference: open with the bottom line (what the signal evidence suggests and how strongly), then the supporting evidence (which run, event counts/rates, ROI/QC caveats, in plain words), then the uncertainty.
4. Always carry the calibration + research-grade frame: PyHFO output is one line of signal evidence to reconcile with semiology, imaging, and conventional EEG — not a clinical determination and not a seizure-onset-zone claim.
5. State what is still needed for a confident read (e.g. review of candidates, artifact classification, concordance with imaging) instead of overclaiming completeness.
6. If the clinician wants a file, stage `emit_ui_command` type `export.report` (or `export.workbook`) and say it is staged for Apply — do not claim a path or that the file is written.
7. Do not print artifact file paths, run directories, or raw run identifiers.
