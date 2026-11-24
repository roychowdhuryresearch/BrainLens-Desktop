"""Regression tests for round-3 bug-hunt fixes (runtime/ui side)."""

import asyncio

import ui_mcp.mcp_server as mcp
from runtime.services.conversation_summary_service import ConversationSummaryService
import runtime.services.search_refiner as sr
from runtime.services.search_refiner import SearchRefiner


# --- Bug #1/#3: the documented detection.run examples must pass the policy gate ---

def test_documented_hfo_example_passes_policy_gate():
    # The exact "detect all ripples/HFOs" payload the tool description hands the model.
    hfo = {
        "biomarker": "HFO", "detector": "STE", "scope": "all", "all_channels": True,
        "filter": {"fp": 80, "fs": 250}, "confirmed_defaults": True,
        "exports": ["csv", "session", "summary_json"], "n_jobs": 1,
    }
    assert mcp._detection_run_payload_policy_error(hfo) is None


def test_documented_molle_spindle_example_passes_policy_gate():
    molle = {
        "biomarker": "Spindle", "detector": "MOLLE", "scope": "all", "all_channels": True,
        "filter": {"fp": 1, "fs": 30}, "detector_params": {"method": "MOLLE", "freq_sp": [11, 16]},
    }
    assert mcp._detection_run_payload_policy_error(molle) is None


# --- Bug #13: synonym retry rewrites the whole token, not every substring ---

def test_search_refiner_rewrites_whole_token_only(monkeypatch):
    monkeypatch.setattr(sr, "_synonym_index", {"channel": ["electrode"]})
    variants = SearchRefiner().refine_query("channel and multichannel")
    # "multichannel" must NOT be corrupted into "multielectrode".
    assert all("multielectrode" not in v for v in variants)
    assert "electrode and multichannel" in variants


# --- Bug #12: summary reports the TRUE total, not the capped recent slice ---

def test_summary_reports_true_total_not_capped_slice():
    class FakeHistory:
        def get_recent_messages(self, conversation_id, limit=50):
            return [
                {"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"}
                for i in range(limit)
            ]

        def get_message_count(self, conversation_id):
            return 200

    svc = ConversationSummaryService(history_service=FakeHistory())
    result = asyncio.run(svc.generate_user_summary("c", max_messages=50))
    assert result["message_count"] == 200
    assert "共 200 条消息" in result["summary"]
