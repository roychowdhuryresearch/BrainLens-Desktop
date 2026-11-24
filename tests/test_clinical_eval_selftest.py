"""Deterministic gate for the clinical-register rubric (no API key needed).

This is the test-suite half of the eval rework: it asserts the heuristic scorer accepts the
hand-verified good real-model replies and rejects bad ones on the correct dimension, so a
regression in the rubric (or in the behaviors it guards: calibration, evidence attribution,
two-sided boundary, concordance, register) trips a normal `pytest` run.
"""
from evals.clinical.selftest import check_all


def test_clinical_rubric_discriminates_good_from_bad():
    rows = check_all()
    failures = [(label, msg) for (label, ok, msg) in rows if not ok]
    assert not failures, "clinical rubric mis-scored: " + "; ".join(f"{l} ({m})" for l, m in failures)
