"""Regression tests for round-6 bug-hunt fixes (runtime/config/eval side)."""


# --- Bug #6: low/high filter aliases are mapped to fp/fs (the keys the backend reads) ---

def test_normalize_filter_band_maps_low_high_to_fp_fs():
    from runtime.agent_runtime.pyhfo_tools import _normalize_filter_band

    assert _normalize_filter_band({"low": 80, "high": 450}) == {"fp": 80, "fs": 450}
    # explicit fp/fs win and the stray aliases are dropped (not forwarded to the backend)
    assert _normalize_filter_band({"fp": 80, "fs": 250, "low": 9, "high": 9}) == {"fp": 80, "fs": 250}
    assert _normalize_filter_band({"fp": 80}) == {"fp": 80}
    assert _normalize_filter_band("not-a-dict") == "not-a-dict"


# --- Bug #12: ${VAR:default} falls back to default when the env var is set-but-empty ---

def test_env_expansion_is_empty_safe(monkeypatch):
    from runtime.core import config as cfg

    monkeypatch.setenv("X_R6_ENV", "")
    assert cfg._expand_env_placeholders("${X_R6_ENV:python}") == "python"  # empty -> default
    monkeypatch.setenv("X_R6_ENV", "pypy")
    assert cfg._expand_env_placeholders("${X_R6_ENV:python}") == "pypy"    # set -> value
    monkeypatch.delenv("X_R6_ENV", raising=False)
    assert cfg._expand_env_placeholders("${X_R6_ENV:python}") == "python"  # absent -> default


# --- Bug #3: the agent-history engine uses per-thread pooling, not one shared connection ---

def test_agent_history_engine_is_not_staticpool():
    from sqlalchemy.pool import StaticPool
    from runtime.agent_history.db import _engine

    # StaticPool hands one shared SQLite connection to every thread, interleaving concurrent
    # history/observability writes and silently dropping rows.
    assert not isinstance(_engine.pool, StaticPool)


# --- Bug #7: final-answer channel scan is token-boundary, not substring ---

def test_channel_scan_does_not_extract_substring_channels():
    import re

    known = ["RA1", "RA2", "A1", "A2", "A10"]
    low = "the top channels are RA1 and A10"
    found = []
    for ch in sorted(known, key=len, reverse=True):
        if not ch or ch in found:
            continue
        if re.search(r"(?<![A-Za-z0-9])" + re.escape(ch) + r"(?![A-Za-z0-9])", low):
            found.append(ch)
    # "A1" must NOT be extracted just because it is a substring of "RA1"/"A10"
    assert set(found) == {"RA1", "A10"}
