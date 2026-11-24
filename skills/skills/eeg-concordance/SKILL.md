---
name: eeg-concordance
version: 0.1.0
description: Compare the signal-derived evidence against a localization hypothesis or another-modality finding the clinician states, reporting agreement, partial agreement, or conflict as a single (iEEG signal) modality.
category: neuroscience
keywords: [concordance, concordant, agree, agreement, consistent with, support, supports, conflict, discordant, matches, does it match, my hypothesis, the MRI, the PET, semiology, lateralize, localize, 一致, 吻合, 支持, 符合, 矛盾]
triggers: [concord, concordant, agree, consistent with, does it support, does it match, conflict, discordant, my hypothesis, the mri, the pet, semiology, 一致, 吻合, 支持, 符合]
allowed_tools: [get_ui_state, pyhfo_rank_candidate_channels, emit_ui_command]
priority: 89
when_to_use: Use when the clinician offers a localization hypothesis or another-modality finding (imaging, semiology, conventional EEG) and asks whether the signal evidence agrees.
do_not_use: Do not name or confirm a seizure-onset zone or resection target; agreement of signal evidence with a hypothesis is not a clinical localization. Do not invent imaging/semiology you were not given. Do not fabricate a ranking when no run exists.
output_format: A plain-prose read stating whether the SIGNAL evidence agrees / partially agrees / conflicts with the stated hypothesis, which channels or region drive that, an honest confidence, and the explicit single-modality + research-grade caveat.
---

## Workflow

1. Identify the clinician's stated hypothesis or other-modality finding (e.g. "right temporal", "left mesial sclerosis on MRI", "frontal semiology"). You do NOT have the imaging or semiology yourself — you reason only over the iEEG signal evidence you can compute. Say so plainly.
2. Use `get_ui_state`; if a detection run exists, ground the channel/region picture with `pyhfo_rank_candidate_channels` (or the candidate ranking in state). If no run exists, explain detection must run first to have signal evidence to compare — do not fabricate agreement.
3. Map the ranked signal candidates to the clinician's stated region as far as the channel names allow, then state the verdict plainly: the signal evidence AGREES, PARTIALLY agrees, or CONFLICTS with the hypothesis, and which channels drive that.
4. Calibrate: give an honest confidence and the margin (e.g. the top candidates fall in the stated region, but the rate margin is small, or there are competing channels elsewhere).
5. Hold the boundary on EVERY verdict — agree, partial, AND conflict. Close with the single-modality + research-grade caveat: this is signal-derived candidate evidence from one modality (HFOs), to be reconciled with the full multimodal picture, and agreeing with a localization hypothesis is NOT naming a seizure-onset zone or surgical target. This caveat is UNCONDITIONAL: a clean, strong, or one-sided agreement makes it MORE important, not optional — never drop it just because the evidence looks decisive (a confident "yes" is exactly when an over-claim does the most harm).
6. Optionally focus the relevant channels with `emit_ui_command` (`waveform.focus_hotspot_channels` or `detection.focus_top_candidate_channel`) so the workspace follows the read. Do not re-detect when a run already exists.
