"""Regression tests for the adversarial bug-hunt fixes (runtime/ui side).

Each test locks in one confirmed bug found by the bug hunt. The pyhfo-package
side (agent_cli list-param round-trip, etc.) is covered in pyhfo/tests/.
"""

import os

from ui_mcp.broker import UiBus
from runtime.agent_runtime.pyhfo_tools import _append_key_values, _detection_args
from runtime.cli import _env_port
from runtime.services.ai_service import NonRetryableAIError


# --- Bug #4: non-dict UI command payload must not crash the broker -----------

def _bus():
    return UiBus(catalog={
        "recording.select_channel": {"type": "recording.select_channel", "required_payload": ["channel"]},
        "review.refresh": {"type": "review.refresh"},
    })


def test_broker_rejects_non_dict_payload_cleanly():
    bus = _bus()
    # A list payload used to hit `(payload or {}).get(key)` -> AttributeError, killing
    # the request thread (mis-reported to the model as "broker unreachable").
    cmd, err = bus.emit("recording.select_channel", ["POL A1"], "pick")
    assert cmd is None
    assert err and "object" in err
    # Valid dict payload still works.
    cmd, err = bus.emit("recording.select_channel", {"channel": "POL A1"}, "pick")
    assert cmd is not None and err is None


# --- Bug #16: broker ack map is bounded --------------------------------------

def test_broker_ack_map_is_bounded():
    bus = UiBus()
    command_ids = []
    for i in range(bus._ACKS_MAX + 200):
        command, error = bus.emit("workspace.reset_waveform_view", {}, f"reset-{i}")
        assert error is None and command is not None
        command_ids.append(command["command_id"])
        receipt, error = bus.record_ack(command["command_id"], {"status": "noop"})
        assert error is None and receipt is not None
    assert len(bus.acks) == bus._ACKS_MAX
    # The most recent ack is retained; the oldest is evicted.
    assert command_ids[-1] in bus.acks
    assert command_ids[0] not in bus.acks


# --- Bug #1: list-valued detector params are JSON-encoded, not Python repr ----

def test_append_key_values_json_encodes_lists():
    args = []
    _append_key_values(args, "--detector-param", {"freq_sp": [11, 16], "thresh": 0.5})
    # token order is [flag, "key=value", flag, "key=value"]
    tokens = {args[i + 1].split("=", 1)[0]: args[i + 1].split("=", 1)[1] for i in range(0, len(args), 2)}
    assert tokens["freq_sp"] == "[11, 16]"  # JSON, parseable back to a list
    assert tokens["thresh"] == "0.5"
    # A Python repr of a list is also "[11, 16]" here, but a dict proves JSON encoding:
    args2 = []
    _append_key_values(args2, "--filter", {"band": {"low": 80, "high": 250}})
    assert args2[1] == 'band={"low": 80, "high": 250}'  # JSON object, not Python repr


# --- Bug #14: omitted n_jobs emits the schema default of 1 (not the CLI's 4) --

def test_detection_args_defaults_n_jobs_to_one_when_omitted():
    args = _detection_args({"biomarker": "Spindle"})
    assert "--n-jobs" in args
    assert args[args.index("--n-jobs") + 1] == "1"
    # An explicit value is honored.
    args2 = _detection_args({"biomarker": "HFO", "n_jobs": 8})
    assert args2[args2.index("--n-jobs") + 1] == "8"


# --- Bug #12: malformed port env var must not crash the CLI ------------------

def test_env_port_is_defensive(monkeypatch):
    monkeypatch.setenv("X_TEST_PORT", "notaport")
    assert _env_port("X_TEST_PORT", 8011) == 8011  # falls back, no crash
    monkeypatch.setenv("X_TEST_PORT", "")
    assert _env_port("X_TEST_PORT", 8011) == 8011
    monkeypatch.setenv("X_TEST_PORT", "9000")
    assert _env_port("X_TEST_PORT", 8011) == 9000
    monkeypatch.delenv("X_TEST_PORT", raising=False)
    assert _env_port("X_TEST_PORT", 8011) == 8011


# --- Bug #8/#9: 400 client errors are a distinct, non-retryable exception ----

def test_non_retryable_ai_error_is_distinct_exception():
    # The retry loop catches broad Exception; NonRetryableAIError must be catchable
    # separately so a deterministic 400 is re-raised instead of retried.
    assert issubclass(NonRetryableAIError, Exception)
    try:
        raise NonRetryableAIError("智谱AI请求失败(400): bad")
    except NonRetryableAIError as exc:
        assert "400" in str(exc)
