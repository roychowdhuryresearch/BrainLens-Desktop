"""Clinical-register eval for the iEEG co-pilot (D1-D6 decision layer).

Scores the agent's REPLY on the dimensions the literature says drive clinical trust
(calibration, evidence attribution, two-sided boundary, concordance, register) instead
of just which tools it called. See rubric.py and docs/agent-doctor-channel-repositioning-2026-06-16.md.
"""
