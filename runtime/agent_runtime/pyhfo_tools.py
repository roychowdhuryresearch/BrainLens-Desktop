"""Built-in PyHFO research tools backed by the bundled PyHFO CLI.

The generic agent runtime keeps PyHFO behind a JSON-only process boundary. In the
merged project the PyHFO app lives under ``pyhfo/``; deployments may still point
``PYHFO_AGENT_APP_ROOT`` at an external checkout when needed.
"""
from __future__ import annotations

import contextvars
import copy
import json
import logging
import os
import subprocess
import sys
import threading
import urllib.request
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.parse import urlparse

from runtime.pyhfo_env import pyhfo_process_env
from runtime.agent_runtime import ui_command_context
from runtime.agent_runtime.clinical_evidence import recording_fingerprint_for_path
from runtime.agent_runtime.execution_attestation import (
    build_execution_attestation,
    canonical_json_sha256,
)

PYHFO_LIST_CAPABILITIES = "pyhfo_list_capabilities"
PYHFO_GET_CAPABILITY_MANIFEST = "pyhfo_get_capability_manifest"
PYHFO_GET_RECORDING_INFO = "pyhfo_get_recording_info"
PYHFO_INFER_BRAIN_SIGNAL_ROI = "pyhfo_infer_brain_signal_roi"
PYHFO_COMPUTE_CHANNEL_QC = "pyhfo_compute_channel_qc"
PYHFO_COMPUTE_SPECTRAL_PROFILE = "pyhfo_compute_spectral_profile"
PYHFO_DETECT_LINE_NOISE = "pyhfo_detect_line_noise"
PYHFO_RECOMMEND_DETECTOR_PLAN = "pyhfo_recommend_detector_plan"
PYHFO_RANK_CANDIDATE_CHANNELS = "pyhfo_rank_candidate_channels"
PYHFO_DETECT_EVENTS = "pyhfo_detect_events"
PYHFO_PREPARE_RECORDING = "pyhfo_prepare_recording"
PYHFO_RUN_SEVERITY_SCORING = "pyhfo_run_severity_scoring"
PYHFO_BATCH_CREATE = "pyhfo_batch_create"
PYHFO_BATCH_RUN = "pyhfo_batch_run"
TOOL_NAMES = {
    PYHFO_LIST_CAPABILITIES,
    PYHFO_GET_CAPABILITY_MANIFEST,
    PYHFO_GET_RECORDING_INFO,
    PYHFO_INFER_BRAIN_SIGNAL_ROI,
    PYHFO_COMPUTE_CHANNEL_QC,
    PYHFO_COMPUTE_SPECTRAL_PROFILE,
    PYHFO_DETECT_LINE_NOISE,
    PYHFO_RECOMMEND_DETECTOR_PLAN,
    PYHFO_RANK_CANDIDATE_CHANNELS,
    PYHFO_DETECT_EVENTS,
    PYHFO_PREPARE_RECORDING,
    PYHFO_RUN_SEVERITY_SCORING,
    PYHFO_BATCH_CREATE,
    PYHFO_BATCH_RUN,
}

# These built-ins create or mutate durable research artifacts. They are useful in a
# dedicated headless runner, but calling them directly from the desktop co-pilot skips
# the ieeg_ui approval/receipt boundary. Direct execution therefore fails closed unless
# the *process* was started in the explicit operator-controlled headless profile. Tool
# arguments cannot select or elevate this profile.
WRITE_CAPABLE_TOOL_NAMES = frozenset(
    {
        PYHFO_DETECT_EVENTS,
        PYHFO_PREPARE_RECORDING,
        PYHFO_RUN_SEVERITY_SCORING,
        PYHFO_BATCH_CREATE,
        PYHFO_BATCH_RUN,
    }
)
EXECUTION_PROFILE_ENV = "PYHFO_AGENT_EXECUTION_PROFILE"
DEFAULT_EXECUTION_PROFILE = "copilot"
AUTHORIZED_HEADLESS_PROFILE = "authorized_headless"

logger = logging.getLogger(__name__)

# Tools whose CLI takes a single-recording ``--input``. When the model omits ``input_path``,
# or copies the loaded path with a typographic-character change that no longer exists on disk,
# we fall back to the recording the desktop actually has loaded (see ``begin_active_recording``).
# Tools NOT listed here either take no recording (manifest/state/dispatch), consume CSV runs
# (rank_candidate_channels), or operate on a directory (batch_create/batch_run) — leave them alone.
_INPUT_PATH_TOOLS = {
    PYHFO_GET_RECORDING_INFO,
    PYHFO_INFER_BRAIN_SIGNAL_ROI,
    PYHFO_COMPUTE_CHANNEL_QC,
    PYHFO_COMPUTE_SPECTRAL_PROFILE,
    PYHFO_DETECT_LINE_NOISE,
    PYHFO_RECOMMEND_DETECTOR_PLAN,
    PYHFO_DETECT_EVENTS,
    PYHFO_PREPARE_RECORDING,
    PYHFO_RUN_SEVERITY_SCORING,
}

# Canonical effective defaults are materialized before command construction and
# attestation.  This prevents argparse defaults from becoming invisible research
# parameters and makes omitted values equivalent to explicitly supplied defaults.
# Schema defaults remain the primary source; this table supplements CLI defaults
# that are operational but not represented in the public tool schema.
_CLI_EFFECTIVE_DEFAULTS: Dict[str, Dict[str, Any]] = {
    PYHFO_COMPUTE_CHANNEL_QC: {"exclude_channels": []},
    PYHFO_COMPUTE_SPECTRAL_PROFILE: {"exclude_channels": []},
    PYHFO_DETECT_LINE_NOISE: {
        "exclude_channels": [],
        "site_line_freq_hz": None,
    },
    PYHFO_RANK_CANDIDATE_CHANNELS: {
        "duration_seconds": 0.0,
        "exclude_channels": [],
    },
    PYHFO_DETECT_EVENTS: {
        "detector": None,
        "filter": {},
        "detector_params": {},
        "classifier": {},
    },
    PYHFO_PREPARE_RECORDING: {
        "line_noise_notch_hz": None,
        "bandpass": {},
        "resample_sfreq": None,
    },
}

_DETECTION_EFFECTIVE_DEFAULTS: Dict[str, Any] = {
    "biomarker": "HFO",
    "detector": None,
    "n_jobs": 1,
    "filter": {},
    "detector_params": {},
    "classifier": {},
    "exports": ["summary-json"],
    "include_channels": [],
    "exclude_channels": [],
}

DEFAULT_TIMEOUT_SECONDS = 900
logger = logging.getLogger(__name__)

_AVAILABILITY_CACHE: Dict[tuple[str, str], Dict[str, Any]] = {}

# Adapter-owned, content-addressed proof that a prepared recording was produced
# from a particular source recording. Paths and model arguments are not lineage
# evidence. Conflicting source claims for identical derived bytes are made
# permanently ambiguous (empty sentinel) and therefore fail closed.
_LINEAGE_MAX = 512
_LINEAGE_LOCK = threading.Lock()
_DERIVED_RECORDING_LINEAGE: "OrderedDict[str, str]" = OrderedDict()

# The recording the desktop currently has loaded, bound per turn by the orchestrator.
# Used as the default input_path when the model omits it,
# so the agent operates on the actually-loaded file instead of a stale PyHFO session recording.
_ACTIVE_RECORDING: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "ieeg_active_recording", default=None
)


def begin_active_recording(recording_path: Optional[str]) -> None:
    """Bind the active (loaded) recording path for the current turn.

    Pass the inbound chat request's ``recording_path``. ``None``/empty clears it.
    """
    value = str(recording_path).strip() if recording_path else ""
    _ACTIVE_RECORDING.set(value or None)


def end_active_recording() -> None:
    _ACTIVE_RECORDING.set(None)


# The desktop's PyHFO session for the current turn. Bound from the chat request, because this process
# is started before the backend exists and therefore cannot inherit PYHFO_SESSION_URL from it.
_SESSION_URL: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("ieeg_session_url", default=None)
_SESSION_TOKEN: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar("ieeg_session_token", default=None)


def begin_desktop_session(session_url: Optional[str], session_token: Optional[str]) -> None:
    """Bind the desktop PyHFO session for this turn. Empty values clear it (headless/CLI use)."""
    _SESSION_URL.set(str(session_url).strip() if session_url else None)
    _SESSION_TOKEN.set(str(session_token).strip() if session_token else None)


def _session_url() -> str:
    """The turn's session, falling back to the environment for callers that do set it."""
    return (_SESSION_URL.get() or os.environ.get(_SESSION_URL_ENV) or '').strip()


def _session_token() -> str:
    return (_SESSION_TOKEN.get() or os.environ.get(_SESSION_TOKEN_ENV) or '').strip()


def get_active_recording() -> Optional[str]:
    return _ACTIVE_RECORDING.get()


def _clear_recording_lineage_for_tests() -> None:
    with _LINEAGE_LOCK:
        _DERIVED_RECORDING_LINEAGE.clear()


def _recording_lineage_source(derived_fingerprint: Optional[str]) -> Optional[str]:
    if not derived_fingerprint:
        return None
    with _LINEAGE_LOCK:
        source = _DERIVED_RECORDING_LINEAGE.get(derived_fingerprint)
        if source is not None:
            _DERIVED_RECORDING_LINEAGE.move_to_end(derived_fingerprint)
    return source or None


def _register_recording_lineage(*, source_fingerprint: Optional[str], derived_fingerprint: Optional[str]) -> bool:
    if not source_fingerprint or not derived_fingerprint or source_fingerprint == derived_fingerprint:
        return False
    with _LINEAGE_LOCK:
        existing = _DERIVED_RECORDING_LINEAGE.get(derived_fingerprint)
        if existing is None and derived_fingerprint not in _DERIVED_RECORDING_LINEAGE:
            _DERIVED_RECORDING_LINEAGE[derived_fingerprint] = source_fingerprint
        elif existing != source_fingerprint:
            _DERIVED_RECORDING_LINEAGE[derived_fingerprint] = ""
        _DERIVED_RECORDING_LINEAGE.move_to_end(derived_fingerprint)
        while len(_DERIVED_RECORDING_LINEAGE) > _LINEAGE_MAX:
            _DERIVED_RECORDING_LINEAGE.popitem(last=False)
        return _DERIVED_RECORDING_LINEAGE.get(derived_fingerprint) == source_fingerprint


def _path_exists(value: Any) -> bool:
    raw = str(value or "").strip()
    if not raw:
        return False
    try:
        return Path(raw).expanduser().exists()
    except (OSError, ValueError):
        return False


def _input_path_or_active_recording(input_path: Any) -> str:
    raw = str(input_path or "").strip()
    active_recording = get_active_recording()
    if not active_recording:
        return raw
    if not raw:
        return active_recording
    if _path_exists(raw):
        return raw
    # Models often normalize smart punctuation in copied local paths.
    # A matching basename lets us recover the live desktop path.
    if _path_exists(active_recording) and Path(raw).name == Path(active_recording).name:
        return active_recording
    return raw


def _nonempty_text(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


_DESKTOP_DETECTORS_BY_BIOMARKER = {
    "hfo": {"ste": "STE", "mni": "MNI", "hil": "HIL", "rms": "RMS", "linelength": "LineLength", "line length": "LineLength", "ll": "LineLength"},
    "spindle": {"yasa": "YASA", "lsm": "LSM", "kramer lsm": "LSM", "a7": "A7", "molle": "MOLLE", "fasst": "MOLLE", "spindle rms": "MOLLE"},
    "spike": {"rms/ll": "RMS/LL", "rmsll": "RMS/LL", "ll": "RMS/LL", "rms": "RMS/LL"},
}

_DESKTOP_DEFAULT_DETECTOR_BY_BIOMARKER = {
    "hfo": "STE",
    "spindle": "MOLLE",
    "spike": "RMS/LL",
}


def _desktop_biomarker(value: Any) -> str:
    raw = str(value or "").strip().lower()
    aliases = {
        "hfo": "HFO",
        "hfos": "HFO",
        "ripple": "HFO",
        "ripples": "HFO",
        "spindle": "Spindle",
        "spindles": "Spindle",
        "spike": "Spike",
        "spikes": "Spike",
    }
    return aliases.get(raw, "HFO")


def _desktop_detector_for_biomarker(biomarker: str, value: Any) -> str:
    return _desktop_detector_match_for_biomarker(biomarker, value) or _DESKTOP_DEFAULT_DETECTOR_BY_BIOMARKER.get(biomarker.strip().lower(), "STE")


def _desktop_detector_match_for_biomarker(biomarker: str, value: Any) -> Optional[str]:
    key = biomarker.strip().lower()
    aliases = _DESKTOP_DETECTORS_BY_BIOMARKER.get(key, _DESKTOP_DETECTORS_BY_BIOMARKER["hfo"])
    raw = _nonempty_text(value)
    if not raw:
        return None
    normalized = raw.lower().replace("_", " ").replace("-", " ").strip()
    squashed = normalized.replace(" ", "").replace("/", "")
    for alias, detector in aliases.items():
        alias_squashed = alias.replace(" ", "").replace("/", "")
        if normalized == alias or squashed == alias_squashed:
            return detector
    return None


def _explicit_detector_value(parameters: Dict[str, Any]) -> Optional[str]:
    return _nonempty_text(parameters.get("detector")) or _nonempty_text(parameters.get("method"))


def _desktop_detection_has_confirmed_default_contract(parameters: Dict[str, Any]) -> bool:
    if parameters.get("confirmed_defaults") is True or parameters.get("use_defaults") is True:
        return True
    return False


def _desktop_detection_has_protocol_contract(parameters: Dict[str, Any]) -> bool:
    if _desktop_detection_has_confirmed_default_contract(parameters):
        return True
    return any(
        _nonempty_text(parameters.get(key))
        for key in ("protocol", "detection_protocol", "protocol_name")
    )


def _desktop_detection_has_parameter_contract(parameters: Dict[str, Any]) -> bool:
    if _desktop_detection_has_protocol_contract(parameters):
        return True
    if _nonempty_text(parameters.get("parameter_preset")) or _nonempty_text(parameters.get("preset")):
        return True
    for key in ("detector_params", "ui_values"):
        value = parameters.get(key)
        if isinstance(value, dict) and any(item not in (None, "", []) for item in value.values()):
            return True
    return False


def _desktop_detection_has_filter_contract(parameters: Dict[str, Any]) -> bool:
    if _desktop_detection_has_protocol_contract(parameters):
        return True
    value = parameters.get("filter")
    return isinstance(value, dict) and any(item not in (None, "", []) for item in value.values())


def _desktop_detection_has_scope_contract(parameters: Dict[str, Any]) -> bool:
    if _desktop_detection_has_protocol_contract(parameters):
        return True
    if parameters.get("all_channels") is True or parameters.get("allChannels") is True:
        return True
    if any(_nonempty_text(parameters.get(key)) for key in ("scope", "channel_scope", "channelScope")):
        return True
    for key in ("include_channels", "exclude_channels", "channels", "channel_names"):
        value = parameters.get(key)
        if isinstance(value, (list, tuple, set)) and len(value) > 0:
            return True
        if _nonempty_text(value):
            return True
    return False


def _desktop_detection_clarification(parameters: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    detector = _explicit_detector_value(parameters)
    biomarker = _desktop_biomarker(parameters.get("biomarker"))
    incompatible_detector = bool(detector) and _desktop_detector_match_for_biomarker(biomarker, detector) is None
    missing_parameter_contract = bool(detector) and not incompatible_detector and not _desktop_detection_has_parameter_contract(parameters)
    missing_filter_contract = bool(detector) and not incompatible_detector and not _desktop_detection_has_filter_contract(parameters)
    missing_scope_contract = bool(detector) and not incompatible_detector and not _desktop_detection_has_scope_contract(parameters)
    if detector and not incompatible_detector and not (missing_parameter_contract or missing_filter_contract or missing_scope_contract):
        return None
    if biomarker == "HFO":
        question = "Which HFO detector/protocol and result-shaping settings should I use: filter band, detector parameters or preset/defaults, and channel scope? For example: STE 80-500 Hz on all channels."
    elif biomarker == "Spindle":
        question = "Which spindle detector/protocol and result-shaping settings should I use: spindle band or preset/defaults, filter band, and channel scope? For example: MOLLE with freq_sp 11-16 Hz on all channels."
    else:
        question = "Which detector/protocol and result-shaping settings should I use for spike detection: parameters or preset/defaults, filter band, and channel scope?"
    error = "Detection was not staged because the user did not specify the detector/protocol."
    if incompatible_detector:
        error = f"Detection was not staged because detector {detector!r} is not a supported {biomarker} detector."
    elif missing_parameter_contract or missing_filter_contract or missing_scope_contract:
        missing_choices = []
        if missing_parameter_contract:
            missing_choices.append("detector parameters, a preset, or confirmed defaults")
        if missing_filter_contract:
            missing_choices.append("filter band")
        if missing_scope_contract:
            missing_choices.append("channel scope")
        error = f"Detection was not staged because the user did not specify {', '.join(missing_choices)}."
    return {
        "success": False,
        "tool": PYHFO_DETECT_EVENTS,
        "clarification_required": True,
        "error": error,
        "question": question,
        "llm_guidance": {
            "interpretation_policy": [
                "Do not choose detector defaults for underspecified or incompatible-detector desktop requests.",
                "Ask the user to confirm the detector/protocol, result-shaping parameters or preset/defaults, and channel scope before calling emit_ui_command.",
            ],
            "next_safe_actions": [question],
        },
    }


def _desktop_spindle_payload_filter_and_params(parameters: Dict[str, Any], detector: str) -> tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
    raw_detector_params = parameters.get("detector_params")
    detector_params = dict(raw_detector_params) if isinstance(raw_detector_params, dict) else {}
    if detector == "MOLLE" and "method" not in detector_params:
        detector_params["method"] = "MOLLE"
    filter_params = parameters.get("filter")
    if not isinstance(filter_params, dict):
        return None, detector_params
    filtered = _normalize_filter_band({key: value for key, value in filter_params.items() if key in {"fp", "fs", "low", "high"}})
    fp = filtered.get("fp")
    fs = filtered.get("fs")
    try:
        fp_value = float(fp)
        fs_value = float(fs)
    except (TypeError, ValueError):
        return filtered, detector_params
    looks_like_spindle_band = 8 <= fp_value < fs_value <= 20
    if not looks_like_spindle_band:
        return filtered, detector_params
    if "freq_sp" not in detector_params:
        detector_params["freq_sp"] = [fp_value, fs_value]
    return {**filtered, "fp": 1, "fs": 30}, detector_params


def _normalize_filter_band(filt: Any) -> Any:
    """Map the low/high band aliases to fp/fs — the only keys the backend's _filter_param_for
    reads. Without this an agent naming the band as {low, high} has it silently dropped and
    replaced by defaults (the requested upper edge is lost)."""
    if not isinstance(filt, dict):
        return filt
    out = dict(filt)
    low = out.pop("low", None)
    high = out.pop("high", None)
    if "fp" not in out and low is not None:
        out["fp"] = low
    if "fs" not in out and high is not None:
        out["fs"] = high
    return out


def _desktop_detection_payload(parameters: Dict[str, Any]) -> Dict[str, Any]:
    biomarker = _desktop_biomarker(parameters.get("biomarker"))
    detector = _explicit_detector_value(parameters)
    normalized_detector = _desktop_detector_for_biomarker(biomarker, detector)
    payload: Dict[str, Any] = {
        "biomarker": biomarker,
        "detector": normalized_detector,
    }
    scope = _nonempty_text(parameters.get("scope")) or _nonempty_text(parameters.get("channel_scope")) or _nonempty_text(parameters.get("channelScope"))
    if scope:
        payload["scope"] = scope
    if parameters.get("all_channels") is True or parameters.get("allChannels") is True:
        payload["all_channels"] = True
    if biomarker.lower() == "spindle":
        filter_payload, detector_params = _desktop_spindle_payload_filter_and_params(parameters, normalized_detector)
        if filter_payload:
            payload["filter"] = filter_payload
        if detector_params:
            payload["detector_params"] = detector_params
    else:
        filter_params = parameters.get("filter")
        if isinstance(filter_params, dict):
            payload["filter"] = _normalize_filter_band({key: value for key, value in filter_params.items() if key in {"fp", "fs", "low", "high"}})
    for source_key, payload_key in (
        ("detector_params", "detector_params"),
        ("ui_values", "ui_values"),
        ("include_channels", "include_channels"),
        ("exclude_channels", "exclude_channels"),
        ("n_jobs", "n_jobs"),
        ("exports", "exports"),
        ("session_format", "session_format"),
        ("classifier", "classifier"),
        ("classifier_label", "classifier_label"),
    ):
        if payload_key in payload:
            continue
        if parameters.get(source_key) not in (None, "", []):
            payload[payload_key] = parameters[source_key]
    return payload


def get_execution_profile() -> str:
    """Return the non-elevatable process execution profile.

    Unknown values deliberately collapse to the closed co-pilot profile. In
    particular, the legacy ``PYHFO_AGENT_FORCE_HEADLESS_DETECTION`` switch has no
    authority here and is intentionally ignored.
    """

    raw = str(os.getenv(EXECUTION_PROFILE_ENV) or "").strip()
    if raw == AUTHORIZED_HEADLESS_PROFILE:
        return AUTHORIZED_HEADLESS_PROFILE
    return DEFAULT_EXECUTION_PROFILE


def direct_write_execution_authorized() -> bool:
    return get_execution_profile() == AUTHORIZED_HEADLESS_PROFILE


def _emit_ui_step(command_type: str, payload: Dict[str, Any], reason: str) -> Dict[str, Any]:
    return {
        "tool": "emit_ui_command",
        "arguments": {
            "type": command_type,
            "payload": payload,
            "reason": reason,
        },
    }


def _wait_ui_step(command_reference: str) -> Dict[str, Any]:
    return {
        "tool": "wait_for_ui_command",
        "arguments": {"command_id": command_reference},
        "require_terminal_receipt": True,
    }


def _nonempty_parameter(parameters: Dict[str, Any], key: str) -> bool:
    value = parameters.get(key)
    return value not in (None, "", [], {})


def _prepare_controls_for_ui(parameters: Dict[str, Any]) -> tuple[Dict[str, Any], List[str]]:
    payload: Dict[str, Any] = {}
    filter_payload: Dict[str, Any] = {}
    bandpass = parameters.get("bandpass")
    if isinstance(bandpass, dict):
        if bandpass.get("l_freq") not in (None, ""):
            filter_payload["fp"] = bandpass.get("l_freq")
        if bandpass.get("h_freq") not in (None, ""):
            filter_payload["fs"] = bandpass.get("h_freq")
    filter_design = parameters.get("filter_design")
    if isinstance(filter_design, dict):
        for key in ("fp", "fs", "rp", "rs"):
            if filter_design.get(key) not in (None, ""):
                filter_payload[key] = filter_design.get(key)
    if filter_payload:
        payload["filter"] = filter_payload

    for key in (
        "line_noise_notch_hz",
        "resample_sfreq",
        "drop_bad_channels",
        "drop_flat_channels",
        "mark_outlier_channels",
        "drop_outlier_channels",
        "n_jobs",
    ):
        if parameters.get(key) not in (None, ""):
            payload[key] = parameters.get(key)

    notch_freqs = parameters.get("notch_freqs")
    if (
        "line_noise_notch_hz" not in payload
        and isinstance(notch_freqs, (list, tuple))
        and len(notch_freqs) == 1
    ):
        payload["line_noise_notch_hz"] = notch_freqs[0]

    unmapped: List[str] = []
    if isinstance(bandpass, dict):
        if any(key not in {"l_freq", "h_freq"} for key in bandpass):
            unmapped.append("bandpass")
    if isinstance(notch_freqs, (list, tuple)) and len(notch_freqs) > 1:
        unmapped.append("notch_freqs")
    for key in (
        "extra_bad_channels",
        "bipolar_pairs",
        "outlier_z_threshold",
    ):
        if _nonempty_parameter(parameters, key):
            unmapped.append(key)
    if parameters.get("drop_original_after_bipolar") is True:
        unmapped.append("drop_original_after_bipolar")
    bipolar_montage = str(parameters.get("bipolar_montage") or "none").strip().lower()
    if bipolar_montage not in {"", "none"}:
        unmapped.append("bipolar_montage")
    return payload, sorted(set(unmapped))


def _ui_route_for_write_tool(tool_name: str, parameters: Dict[str, Any]) -> Dict[str, Any]:
    steps: List[Dict[str, Any]] = []
    unmapped: List[str] = []
    desktop_managed: List[str] = []
    target_command = ""

    if tool_name == PYHFO_DETECT_EVENTS:
        payload = _desktop_detection_payload(parameters)
        target_command = "detection.run"
        steps.append(
            _emit_ui_step(
                target_command,
                payload,
                f"Stage {payload.get('biomarker', 'HFO')} detection with {payload.get('detector', 'the selected detector')}",
            )
        )
        steps.append(_wait_ui_step("<command_id_from_previous_step>"))
        if _nonempty_parameter(parameters, "output_dir"):
            desktop_managed.append("output_dir")
    elif tool_name == PYHFO_PREPARE_RECORDING:
        target_command = "analysis.prepare_recording"
        control_payload, unmapped = _prepare_controls_for_ui(parameters)
        if control_payload:
            steps.append(
                _emit_ui_step(
                    "detection.set_parameters",
                    control_payload,
                    "Apply the explicitly requested preparation controls before creating a prepared recording",
                )
            )
            steps.append(_wait_ui_step("<command_id_from_previous_step>"))
        if _nonempty_parameter(parameters, "output_path"):
            desktop_managed.append("output_path")
        if unmapped:
            steps.append(
                {
                    "tool": "clinician_resolution_required",
                    "parameters": unmapped,
                    "reason": "The current ieeg_ui preparation contract cannot represent these headless-only parameters exactly.",
                }
            )
        else:
            steps.append(
                _emit_ui_step(
                    target_command,
                    {},
                    "Create a prepared recording using the reviewed Prepare-panel controls",
                )
            )
            steps.append(_wait_ui_step("<command_id_from_previous_step>"))
    elif tool_name == PYHFO_BATCH_CREATE:
        target_command = "batch.create"
        payload = {
            key: parameters.get(key)
            for key in ("input_dir", "output_dir", "recursive")
            if parameters.get(key) not in (None, "")
        }
        steps.append(_emit_ui_step(target_command, payload, "Create a reviewable batch manifest"))
        steps.append(_wait_ui_step("<command_id_from_previous_step>"))
    elif tool_name == PYHFO_BATCH_RUN:
        target_command = "batch.run"
        detection = parameters.get("detection") if isinstance(parameters.get("detection"), dict) else {}
        payload: Dict[str, Any] = {
            key: parameters.get(key)
            for key in ("manifest_path", "retry_failed", "fail_fast")
            if parameters.get(key) not in (None, "")
        }
        for key in ("biomarker", "detector", "filter", "n_jobs"):
            if detection.get(key) not in (None, "", [], {}):
                payload[key] = detection.get(key)
        unmapped.extend(
            sorted(
                key
                for key, value in detection.items()
                if key not in {"biomarker", "detector", "filter", "n_jobs"}
                and value not in (None, "", [], {})
            )
        )
        if not payload.get("manifest_path") and parameters.get("input_dir"):
            create_payload = {
                key: parameters.get(key)
                for key in ("input_dir", "output_dir", "recursive")
                if parameters.get(key) not in (None, "")
            }
            steps.append(_emit_ui_step("batch.create", create_payload, "Create the batch manifest before running it"))
            steps.append(_wait_ui_step("<command_id_from_previous_step>"))
            payload["manifest_path"] = "<manifest_path_from_terminal_receipt>"
        if not payload.get("manifest_path"):
            steps.append(
                {
                    "tool": "clinician_resolution_required",
                    "parameters": ["manifest_path"],
                    "reason": "batch.run requires a reviewed manifest path in the ieeg_ui contract.",
                }
            )
        elif unmapped:
            steps.append(
                {
                    "tool": "clinician_resolution_required",
                    "parameters": unmapped,
                    "reason": "The current ieeg_ui batch contract cannot represent these detector parameters exactly.",
                }
            )
        else:
            steps.append(_emit_ui_step(target_command, payload, "Run the reviewed batch manifest"))
            steps.append(_wait_ui_step("<command_id_from_previous_step>"))
    elif tool_name == PYHFO_RUN_SEVERITY_SCORING:
        target_command = "severity.run"
        steps.append(_emit_ui_step(target_command, {}, "Run whole-recording severity scoring"))
        steps.append(_wait_ui_step("<command_id_from_previous_step>"))
        if _nonempty_parameter(parameters, "export_csv"):
            desktop_managed.append("export_csv")

    return {
        "kind": "ieeg_ui_mcp",
        "mcp_server": "ieeg_ui",
        "available": None,
        "target_command": target_command,
        "ready_to_stage": not unmapped and not any(step.get("tool") == "clinician_resolution_required" for step in steps),
        "requires_loaded_recording": tool_name in {
            PYHFO_DETECT_EVENTS,
            PYHFO_PREPARE_RECORDING,
            PYHFO_RUN_SEVERITY_SCORING,
        },
        "steps": steps,
        "unmapped_parameters": unmapped,
        "desktop_managed_parameters": desktop_managed,
        "terminal_receipt_required": True,
    }


def get_direct_execution_denial(tool_name: str, parameters: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Return a safe authority denial, or ``None`` when direct execution is allowed."""

    normalized = str(tool_name or "").strip()
    if normalized not in WRITE_CAPABLE_TOOL_NAMES or direct_write_execution_authorized():
        return None
    # UI routing reflects only the user's requested controls. Canonical CLI
    # defaults are materialized later, after this authority boundary, so safe
    # defaults are not misreported as unmappable clinician intent.
    call_parameters = dict(parameters or {})
    if normalized == PYHFO_DETECT_EVENTS:
        clarification = _desktop_detection_clarification(call_parameters)
        if clarification is not None:
            clarification.update(
                {
                    "status": "clarification_required",
                    "error_code": "ui_route_requires_clarification",
                    "authority": {
                        "direct_execution": False,
                        "current_profile": get_execution_profile(),
                        "required_profile": AUTHORIZED_HEADLESS_PROFILE,
                    },
                }
            )
            policies = clarification.setdefault("llm_guidance", {}).setdefault("interpretation_policy", [])
            policies.append("Do not report event counts because no detector was executed.")
            return clarification

    route = _ui_route_for_write_tool(normalized, call_parameters)
    result: Dict[str, Any] = {
        "success": False,
        "tool": normalized,
        "status": "authorization_required",
        "error_code": "direct_execution_not_authorized",
        "error": "Direct execution of this write-capable PyHFO tool is disabled for the current process profile.",
        "authority": {
            "direct_execution": False,
            "current_profile": get_execution_profile(),
            "required_profile": AUTHORIZED_HEADLESS_PROFILE,
            "profile_source": "process_startup",
        },
        "route": route,
        "llm_guidance": {
            "read_these_fields": ["route.steps", "route.unmapped_parameters", "route.terminal_receipt_required"],
            "interpretation_policy": [
                "Do not retry this built-in or claim that the write ran.",
                "Use the ieeg_ui route only when it is available and wait for terminal receipts before reporting outcomes.",
                "If route.unmapped_parameters is non-empty, stop for clinician resolution instead of silently dropping intent.",
                "Only an operator-started, isolated headless process may authorize direct execution.",
            ],
            "next_safe_actions": [
                "Follow route.steps through ieeg_ui when available; otherwise use an operator-authorized headless runner.",
            ],
        },
    }
    # Keep the existing detection redirect shape during the contract migration.
    if normalized == PYHFO_DETECT_EVENTS and route.get("steps"):
        first = route["steps"][0]
        result["mcp_tool"] = first.get("tool")
        result["mcp_arguments"] = first.get("arguments")
    return result


def _desktop_detection_mcp_guidance(parameters: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Compatibility wrapper for callers that used the former detection-only guard."""

    return get_direct_execution_denial(PYHFO_DETECT_EVENTS, parameters)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def get_pyhfo_app_root() -> Path:
    configured = os.getenv("PYHFO_AGENT_APP_ROOT") or os.getenv("PYHFO_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return (_repo_root() / "pyhfo").resolve()


def get_pyhfo_python() -> str:
    configured = os.getenv("PYHFO_AGENT_PYTHON")
    if configured:
        return configured
    app_root = get_pyhfo_app_root()
    candidates = [
        app_root / ".venv" / "bin" / "python",
        app_root / "venv" / "bin" / "python",
        app_root / ".venv" / "Scripts" / "python.exe",
        app_root / "venv" / "Scripts" / "python.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return sys.executable


def _availability_status_uncached(root: Path, python: str) -> Dict[str, Any]:
    cli_path = root / "src" / "pyhfo" / "agent_cli.py"
    if not cli_path.exists():
        return {
            "available": False,
            "error": f"PyHFO agent-callable app not found: {root}",
            "hint": "Expected bundled pyhfo/ or set PYHFO_AGENT_APP_ROOT to a PyHFO agent-callable app directory.",
        }
    try:
        completed = subprocess.run(
            [python, "-m", "pyhfo.agent_cli", "manifest", "--callable-only"],
            cwd=str(root),
            env=pyhfo_process_env(root),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except Exception as exc:
        return {
            "available": False,
            "error": str(exc),
            "hint": "PyHFO dependencies may be missing; install pyhfo/requirements.txt or set PYHFO_AGENT_PYTHON.",
        }
    if completed.returncode != 0:
        return {
            "available": False,
            "error": completed.stderr.strip() or completed.stdout.strip() or "PyHFO manifest check failed.",
            "returncode": completed.returncode,
            "hint": "PyHFO dependencies may be missing; install pyhfo/requirements.txt or set PYHFO_AGENT_PYTHON.",
        }
    try:
        payload = _parse_json_payload(completed.stdout)
    except Exception as exc:
        return {
            "available": False,
            "error": f"PyHFO manifest check returned invalid JSON: {exc}",
            "hint": "Check that pyhfo/src/pyhfo/agent_cli.py can run from the configured app root.",
        }
    if not isinstance(payload, dict) or payload.get("schema_version") != "pyhfo-sidecar.v1":
        return {
            "available": False,
            "error": "PyHFO manifest check did not return the expected sidecar manifest.",
            "hint": "Check that PYHFO_AGENT_APP_ROOT points at the agent-callable PyHFO app.",
        }
    return {"available": True, "pyhfo_app_root": str(root), "python": python}


def get_availability_status(*, refresh: bool = False) -> Dict[str, Any]:
    root = get_pyhfo_app_root()
    python = get_pyhfo_python()
    cache_key = (str(root), str(python))
    if not refresh and cache_key in _AVAILABILITY_CACHE:
        return dict(_AVAILABILITY_CACHE[cache_key])
    status = _availability_status_uncached(root, python)
    _AVAILABILITY_CACHE[cache_key] = dict(status)
    return status


def is_available() -> bool:
    return bool(get_availability_status().get("available"))


def _function_tool(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


def _capability_catalog() -> Dict[str, Any]:
    """Catalog PyHFO app workflows for LLM planning.

    This is intentionally explicit: the LLM should understand the full doctor-facing
    PyHFO surface, while also knowing which workflows are already callable headlessly
    and which still need a wrapper before use.
    """
    return {
        "status": "complete",
        "purpose": "LLM-readable map of PyHFO workflows, current tool coverage, safe sequencing, and missing headless wrappers.",
        "global_pipeline": [
            "1. Inspect recording metadata and format.",
            "2. Decide montage/reference, channel inclusion, line-noise handling, broad preprocessing, and sampling-rate constraints.",
            "3. Prepare a reproducible cleaned FIF copy when analysis will proceed.",
            "4. Run a smoke detection with conservative parameters before full/batch analysis.",
            "5. Read event counts, warnings, artifacts, and detector/filter settings; refine parameters from evidence.",
            "6. Export reviewable summaries/tables/sessions and keep clinical interpretation separate from algorithm output.",
        ],
        "capabilities": [
            {
                "name": "recording_metadata",
                "doctor_workflow": "Open an EEG/iEEG recording and understand duration, sampling rate, channels, filters, bad-channel metadata, and format limits.",
                "current_tool": PYHFO_GET_RECORDING_INFO,
                "status": "callable",
                "llm_notes": "Always use this first for unknown files; output is metadata only, not artifact QC.",
            },
            {
                "name": "preprocessing_clean_copy",
                "doctor_workflow": "Create a reproducible analysis copy with bad-channel handling, flat-channel dropping, outlier flagging, optional notch, broad bandpass, resampling, and optional bipolar montage.",
                "current_tool": PYHFO_PREPARE_RECORDING,
                "status": "callable",
                "llm_notes": "Use before detection for real data. Report every preprocessing action and use the cleaned output_path downstream.",
            },
            {
                "name": "bipolar_montage",
                "doctor_workflow": "Create bipolar channels from monopolar contacts or explicit doctor-selected pairs.",
                "current_tool": PYHFO_PREPARE_RECORDING,
                "status": "callable_via_prepare_recording",
                "llm_notes": "Use bipolar_montage=none for already-bipolar labels like A1-A2; auto_adjacent only for clear prefix+number contacts; pairs for protocol-specified pairs.",
            },
            {
                "name": "line_noise_notch",
                "doctor_workflow": "Apply 50/60 Hz line-noise notch filtering when site frequency is known.",
                "current_tool": PYHFO_PREPARE_RECORDING,
                "status": "callable_via_prepare_recording",
                "llm_notes": "Use line_noise_notch_hz=60 or 50 only when header/user/site provides it. Do not silently guess from geography.",
            },
            {
                "name": "line_noise_detection",
                "doctor_workflow": "Quantify candidate 50/60 Hz line-noise peaks and harmonics before deciding whether to apply notch filtering.",
                "current_tool": PYHFO_DETECT_LINE_NOISE,
                "status": "callable",
                "llm_notes": "Use when line-noise handling is uncertain. It supports bounded FFT evidence and reports whether explicit site/header frequency is required before notch.",
            },
            {
                "name": "hfo_spindle_spike_detection",
                "doctor_workflow": "Run HFO, spindle, or spike detectors and export algorithmic event outputs.",
                "current_tool": PYHFO_DETECT_EVENTS,
                "status": "callable",
                "llm_notes": "Smoke first with n_jobs=1. Use Nyquist-safe filter settings. Outputs are research/algorithmic detections requiring expert review.",
            },
            {
                "name": "batch_processing",
                "doctor_workflow": "Create and run resumable manifests for folders/cohorts.",
                "current_tool": [PYHFO_BATCH_CREATE, PYHFO_BATCH_RUN],
                "status": "callable",
                "llm_notes": "Create/inspect manifest before batch_run; summarize per-case failures separately.",
            },
            {
                "name": "classifier_artifact_spike_ehfo",
                "doctor_workflow": "Run artifact, spike, and eHFO classifiers after detection.",
                "current_tool": [PYHFO_DETECT_EVENTS, "emit_ui_command"],
                "status": "callable",
                "llm_notes": "Only enable classifier when user requests it and assets/settings exist. For saved active-run classification on the desktop, select the run and classify via the ieeg_ui MCP emit_ui_command (detection.select_run then classification.run).",
            },
            {
                "name": "doctor_review_annotation",
                "doctor_workflow": "Navigate detected events, mark artifact/pathological/physiological labels, clear labels, and track review progress.",
                "current_tool": "emit_ui_command",
                "status": "callable_via_mcp",
                "llm_notes": "Use the ieeg_ui MCP emit_ui_command (review.open_event, events.select_event, events.stage_annotation, events.clear_staged_annotation). Annotation writes (review_write) always stage for clinician Apply.",
            },
            {
                "name": "cross_channel_overlap_review",
                "doctor_workflow": "Group/review events that overlap across channels and choose visible/primary events.",
                "current_tool": "emit_ui_command",
                "status": "callable_via_mcp",
                "llm_notes": "Use the ieeg_ui MCP emit_ui_command review.group_overlaps for overlap summaries. Do not hide/delete events without explicit doctor policy.",
            },
            {
                "name": "session_import_export",
                "doctor_workflow": "Save/load PyHFO app sessions and active runs for reproducible review.",
                "current_tool": "emit_ui_command",
                "status": "callable_via_mcp",
                "llm_notes": "Use the ieeg_ui MCP emit_ui_command project.save to persist and project.open to resume review state and artifact pointers.",
            },
            {
                "name": "report_table_export",
                "doctor_workflow": "Export JSON, CSV, Excel, and text/report artifacts for external review.",
                "current_tool": [PYHFO_DETECT_EVENTS, "emit_ui_command"],
                "status": "callable",
                "llm_notes": "Use detector exports for run artifacts and the ieeg_ui MCP emit_ui_command export.report/export.workbook/export.session for case-level review packages; always report artifact paths.",
            },
            {
                "name": "waveform_visual_review",
                "doctor_workflow": "Inspect waveform/spectrum snippets around candidate events.",
                "current_tool": "emit_ui_command",
                "status": "callable_via_mcp",
                "llm_notes": "Use the ieeg_ui MCP emit_ui_command waveform.set_viewport/waveform.focus_channel/review.open_event to inspect bounded windows. Keep requests bounded.",
            },
        ],
        "do_not_claim_until_wrapped": [
            "automatic clinical diagnosis or treatment recommendation",
            "ordinary EDF chat access to BIDS/SOZ/resection labels without PYHFO_AGENT_ENABLE_LABEL_LOADING=1",
            "full interactive PyQt GUI control from the generic text agent",
            "ground-truth comparison reports beyond the explicitly gated label-evaluation path",
        ],
    }


def _detection_properties() -> Dict[str, Any]:
    return {
        "input_path": {
            "type": "string",
            "description": (
                "Prepared recording path for detection. Prefer a cleaned .fif/.fif.gz produced by "
                "pyhfo_prepare_recording. Raw EDF/BDF/BrainVision/FIF can be used for smoke tests only "
                "after pyhfo_get_recording_info confirms the file is readable, long enough, and has a safe "
                "sampling rate for the requested biomarker."
            ),
        },
        "output_dir": {
            "type": "string",
            "description": (
                "Dedicated output directory for this case/run. Use a fresh case-specific folder; PyHFO writes "
                "JSON summaries, tables, session files, warnings, and logs here. Never point this at the source "
                "data directory."
            ),
        },
        "biomarker": {
            "type": "string",
            "enum": ["HFO", "Spindle", "Spike"],
            "description": (
                "Biomarker workflow. Use HFO for high-frequency oscillation/ripple work, Spindle for sleep "
                "spindles, and Spike for epileptiform spike workflows. Default to HFO only when the user asks "
                "for HFO/ripple analysis or an HFO smoke test."
            ),
            "default": "HFO",
        },
        "detector": {
            "type": "string",
            "description": (
                "Detector algorithm. For ordinary user requests, ask when the detector/protocol, parameter preset, "
                "filter band, or channel scope is not specified; do not silently default from an underspecified request. "
                "For a reproducible HFO smoke test, or after the user "
                "confirms the default, use STE unless the user/protocol specifies another detector. Common options "
                "include STE, MNI, HIL, RMS, LineLength, YASA, A7, MOLLE, and LL. For Spindle, check "
                "pyhfo_get_capability_manifest detector_availability first: YASA is optional, MOLLE/A7 are "
                "built-in smoke-test fallbacks, and LSM requires a parameter file or explicit model_parameters. "
                "Do not invent detector-specific parameters unless provided or documented."
            ),
        },
        "protocol": {
            "type": "string",
            "description": "Named user/protocol-confirmed detection protocol that defines detector parameters, filter band, and channel scope.",
        },
        "n_jobs": {
            "type": "integer",
            "minimum": 1,
            "description": (
                "Worker count. Use n_jobs=1 for smoke tests, debugging, and reproducible single-case runs. "
                "Use larger values only for explicit batch/throughput work after the pipeline succeeds."
            ),
            "default": 1,
        },
        "filter": {
            "type": "object",
            "description": (
                "Detector filter overrides. For HFO/ripple smoke tests start with {\"fp\":80,\"fs\":upper_edge}. "
                "Here fs is the detector stop/high edge parameter, not the recording sampling frequency. Choose "
                "upper_edge below Nyquist from pyhfo_get_recording_info; safe rule: min(500, 0.95*sfreq/2). "
                "If sfreq is too low for the requested band, do not run detection; explain the sampling-rate limit."
            ),
            "additionalProperties": True,
            "examples": [{"fp": 80, "fs": 450}],
        },
        "detector_params": {
            "type": "object",
            "description": (
                "Detector-specific parameters, only when the user/protocol gives them or PyHFO documentation is "
                "known. For smoke tests, leave empty rather than guessing."
            ),
            "additionalProperties": True,
        },
        "parameter_preset": {
            "type": "string",
            "description": "Named user/protocol-confirmed detector parameter preset, if supplied.",
        },
        "confirmed_defaults": {
            "type": "boolean",
            "description": "True only when the user/protocol explicitly confirmed using visible/default detector parameters, filter band, and channel scope.",
        },
        "classifier": {
            "type": "object",
            "description": (
                "Optional classifier parameters. Leave empty/disabled for smoke tests. Add enabled=true only when "
                "the user explicitly asks for a classifier stage and the classifier assets/settings are available."
            ),
            "additionalProperties": True,
        },
        "exports": {
            "type": "array",
            "items": {"type": "string", "enum": ["summary-json", "excel", "csv", "session"]},
            "description": (
                "Artifacts to export. For smoke tests request at least summary-json; add excel/csv/session when "
                "the user wants reviewable tables or resumable PyHFO sessions."
            ),
            "default": ["summary-json"],
        },
        "scope": {
            "type": "string",
            "enum": ["all", "include", "exclude", "visible", "selected"],
            "description": "User/protocol-confirmed channel scope for the detector run.",
        },
        "all_channels": {
            "type": "boolean",
            "description": "True only when the user/protocol explicitly requested all recording channels.",
        },
        "include_channels": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Optional exact channel allow-list for detection. Use brain_signal_channels or prepared-channel names when ROI is known.",
            "default": [],
        },
        "exclude_channels": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Optional exact channel block-list for detection, usually default_detection_exclusions from pyhfo_infer_brain_signal_roi.",
            "default": [],
        },
    }


_GET_RECORDING_INFO_DESCRIPTION = (
    "Read-only first-step inspection for EEG/iEEG/sEEG/ECoG recordings. When to use: call this before "
    "pyhfo_prepare_recording or pyhfo_detect_events whenever file metadata is unknown. Returns JSON metadata "
    "such as format, sampling frequency, duration, channel names, filters, line frequency, and declared bad "
    "channels. Do not use this as data cleaning or QC: it does not detect flat channels, saturation, amplitude "
    "outliers, line noise, artifacts, or HFO/spike/spindle events. If duration is too short or sampling rate is "
    "insufficient, stop and explain instead of running detection."
)

_INFER_ROI_DESCRIPTION = (
    "Infer a label-free brain-signal ROI from channel names before detection. Use this after metadata and before "
    "QC/detection for EDF-only pathology or abnormal-channel requests. Excludes EKG/ECG/EOG/EMG/AUX/STIM/TRIG "
    "and marks ambiguous channels such as X* as uncertain. Does not read SOZ/resection/pathology labels."
)

_RUN_SEVERITY_SCORING_DESCRIPTION = (
    "Score a scalp EEG recording's overall severity with the BASED transformer model: consecutive "
    "15-second segments, each 0-5 (0 = benign, 5 = severe), plus mean/peak and the peak's timestamp. "
    "When to use: the user asks how severe / how abnormal a recording is, or wants it graded or scored "
    "overall. This is whole-recording and needs NO detection run, no biomarker, and no detector -- do "
    "not run detection first. ONLY meaningful for scalp EEG in the conventional 10-20 layout: check "
    "pyhfo_get_recording_info's eeg_type == 'scalp' first, and if it is 'ieeg' say severity scoring "
    "does not apply to intracranial recordings rather than scoring anyway. Report the number as a "
    "signal-derived research score for human review, never as a clinical severity diagnosis. "
    "Use clean_mean_score / clean_peak_score / clean_peak_time_sec only when artifact_quality.status is assessed. "
    "If screening is partial or unavailable, say that clean summaries were withheld; mean_score/peak_score may be "
    "reported only when explicitly labelled as raw all-segment scores."
)

_CHANNEL_QC_DESCRIPTION = (
    "Compute label-free channel QC metrics on the selected ROI: RMS, standard deviation, peak-to-peak, flat fraction, "
    "NaN fraction, and robust amplitude outliers. Use before detection to identify technical bad/noisy candidates; "
    "treat output as heuristic QC requiring review."
)

_SPECTRAL_PROFILE_DESCRIPTION = (
    "Compute a compact spectral profile for detector planning: relative band power, line-noise candidates, Nyquist, "
    "and recommended HFO band. Use to choose filters from signal evidence and avoid Nyquist-invalid HFO settings."
)

_DETECTOR_PLAN_DESCRIPTION = (
    "Recommend conservative Spike/HFO detector runs from recording metadata and label-free brain ROI. Returns planned "
    "detectors, filters, n_jobs, exports, and warnings. Use before pyhfo_detect_events for EDF-only signal analysis."
)

_RANK_CANDIDATES_DESCRIPTION = (
    "Rank candidate channels from one or more detector CSV outputs after ROI exclusions, returning counts and event "
    "rates by biomarker. Use after Spike/HFO detection to report candidate signal-derived channels, not clinical labels."
)

_PREPARE_RECORDING_DESCRIPTION = (
    "Create a PyHFO-ready cleaned FIF/FIF.GZ copy for reproducible preprocessing — this EXECUTES preprocessing and "
    "writes a new file (a heavy whole-recording operation). Do NOT call it merely to SET or change parameters the "
    "clinician names (detection filter band fp/fs, line-noise notch, resample rate, n_jobs, channel drops): in the "
    "desktop co-pilot those are an instant UI control write — use emit_ui_command with type=detection.set_parameters, "
    "NOT this tool. Reach for pyhfo_prepare_recording only when the user explicitly asks to clean/prepare/produce a "
    "preprocessed recording copy. When to use: before detection "
    "when the user wants auto-cleaning, bad-channel handling, bipolar re-referencing, notch/broad filtering, resampling, or a stable "
    "artifact to analyze. Preconditions: run pyhfo_get_recording_info first unless metadata is already known. "
    "Safe default policy: drop file-declared bad channels and user-specified bad channels, drop flat channels, "
    "flag high-amplitude outlier candidates, and do not drop outliers unless the user explicitly asks for "
    "aggressive cleaning. Keep broad preprocessing filters separate from detector-specific HFO filters. If "
    "line_freq is missing, ask the user or use a configured site default before setting line_noise_notch_hz/notch_freqs. Output_path "
    "must end with .fif or .fif.gz. Direct execution requires an operator-started authorized headless process; "
    "otherwise the tool returns an ieeg_ui approval route and does not start PyHFO."
)

_DETECT_EVENTS_DESCRIPTION = (
    "Run headless PyHFO event detection for HFO, spindle, or spike research analysis. Do not call for metadata-only "
    "requests or desktop UI staging requests; in the desktop co-pilot, use emit_ui_command with type=detection.run "
    "so compute is staged for human Apply. Preconditions: pyhfo_get_recording_info should confirm the recording is readable, duration is long "
    "enough, and sampling rate supports the requested biomarker; prefer pyhfo_prepare_recording first for real data. "
    "If detector/protocol, parameter preset/default confirmation, filter band, or channel scope is underspecified, ask before running. "
    "For HFO smoke tests or confirmed defaults use biomarker=HFO, detector=STE, n_jobs=1, exports=[\"summary-json\"], and filter "
    "{\"fp\":80,\"fs\":min(500,0.95*Nyquist)} unless the user/protocol says otherwise. "
    "For Spindle smoke tests, inspect detector_availability first; use MOLLE or A7 when YASA is unavailable, "
    "and use LSM only with a provided parameter file or explicit model_parameters. Do not run full HFO "
    "detection on recordings shorter than 10 seconds; treat 10-60 seconds as smoke-test only; use longer segments "
    "for research statistics. Returns structured JSON with event counts, warnings, timing, and artifact paths. "
    "Research support only; not clinical diagnosis. Direct execution requires an operator-started authorized "
    "headless process; otherwise the tool returns an ieeg_ui approval route and does not start detection."
)

_BATCH_CREATE_DESCRIPTION = (
    "Create a resumable PyHFO batch manifest from a folder of recordings. When to use: folder/cohort work before "
    "batch detection. This scans and records cases but does not run event detection. Do not use for a single file; "
    "use pyhfo_get_recording_info / pyhfo_prepare_recording / pyhfo_detect_events instead. In the desktop co-pilot, "
    "build the cohort manifest from the UI with emit_ui_command type=batch.create instead of this headless tool. "
    "Inspect the manifest before running large batches. Direct execution requires an operator-started authorized "
    "headless process; otherwise the tool returns an ieeg_ui approval route and does not write a manifest."
)

_BATCH_RUN_DESCRIPTION = (
    "Run PyHFO detection over a batch manifest or input directory. Do not use batch_run for metadata-only inspection "
    "or a single-file test; in the desktop co-pilot, stage cohort runs with emit_ui_command type=batch.run (a compute "
    "write held for human Apply) instead of this headless tool. Preconditions: call pyhfo_batch_create first "
    "or provide a known-good manifest_path; use detection.n_jobs=1 for first smoke batches, then increase only "
    "after success. Prefer retry_failed=true only when rerunning a prior failed batch. Returns per-case status and artifact metadata. "
    "Direct execution requires an operator-started authorized headless process; otherwise the tool returns an "
    "ieeg_ui approval route and does not start the batch."
)


def get_desktop_tool_definitions() -> List[Dict[str, Any]]:
    """The capabilities the WORKSPACE performs, which need no PyHFO CLI in this process.

    `is_available()` asks whether a PyHFO source tree and an interpreter are on disk, because most of
    these tools shell out to `pyhfo.agent_cli`. A packaged install has neither -- only a frozen
    backend -- so that check drops every PyHFO tool and the co-pilot tells the user it has no access
    to severity scoring. True, and entirely self-inflicted: these particular tools never run here.
    They hand the command to the desktop, which runs it in its own session. So they stay available
    whenever a desktop session is attached, CLI or no CLI.
    """
    desktop_owned = set(_UI_COMMAND_FOR_TOOL)
    return [
        definition for definition in get_tool_definitions()
        if definition.get("function", {}).get("name") in desktop_owned
    ]


def get_tool_definitions() -> List[Dict[str, Any]]:
    return [
        _function_tool(
            PYHFO_LIST_CAPABILITIES,
            (
                "Return the decoupled PyHFO sidecar capability manifest: explicit action schemas, state/control "
                "contract, safe doctor-facing workflow phases, and wrappers that still need implementation. Use "
                "this before broad PyHFO work or UI-control planning. This does not process data."
            ),
            {
                "include_missing": {
                    "type": "boolean",
                    "description": "Whether to include doctor-facing workflows that are known but not yet callable headlessly.",
                    "default": True,
                }
            },
            [],
        ),
        _function_tool(
            PYHFO_GET_CAPABILITY_MANIFEST,
            (
                "Alias for pyhfo_list_capabilities. Return the PyHFO sidecar action manifest from the PyHFO app, "
                "not from the generic agent prompt. Use it as the source of truth for what the agent/UI can do."
            ),
            {
                "include_missing": {
                    "type": "boolean",
                    "description": "Whether to include planned doctor-review actions that are not callable yet.",
                    "default": True,
                }
            },
            [],
        ),
        _function_tool(
            PYHFO_GET_RECORDING_INFO,
            _GET_RECORDING_INFO_DESCRIPTION,
            {
                "input_path": {
                    "type": "string",
                    "description": (
                        "Path to a recording readable by PyHFO/MNE, such as EDF, BDF, BrainVision .vhdr, FIF, "
                        "or FIF.GZ. Use an absolute path when available. The tool is read-only and does not "
                        "modify this file."
                    ),
                }
            },
            ["input_path"],
        ),
        _function_tool(
            PYHFO_INFER_BRAIN_SIGNAL_ROI,
            _INFER_ROI_DESCRIPTION,
            {"input_path": {"type": "string", "description": "Path to EDF/BDF/BrainVision/FIF recording."}},
            ["input_path"],
        ),
        _function_tool(
            PYHFO_RUN_SEVERITY_SCORING,
            _RUN_SEVERITY_SCORING_DESCRIPTION,
            {
                "input_path": {"type": "string", "description": "Path to a scalp EEG recording (EDF/BDF/BrainVision/FIF). Defaults to the loaded recording."},
                "model_dir": {"type": "string", "description": "Optional directory containing config.json and model.safetensors. Also configurable through PYHFO_SEVERITY_MODEL_DIR."},
                "export_csv": {"type": "string", "description": "Optional path to also write per-segment scores as CSV."},
            },
            [],
        ),
        _function_tool(
            PYHFO_COMPUTE_CHANNEL_QC,
            _CHANNEL_QC_DESCRIPTION,
            {
                "input_path": {"type": "string"},
                "exclude_channels": {"type": "array", "items": {"type": "string"}, "description": "Channels excluded from ROI/QC, usually from pyhfo_infer_brain_signal_roi."},
                "outlier_z_threshold": {"type": "number", "default": 8.0},
                "max_duration_seconds": {"type": "number", "default": 60.0, "description": "Bounded preview duration for memory-safe QC on long recordings."},
            },
            ["input_path"],
        ),
        _function_tool(
            PYHFO_COMPUTE_SPECTRAL_PROFILE,
            _SPECTRAL_PROFILE_DESCRIPTION,
            {
                "input_path": {"type": "string"},
                "exclude_channels": {"type": "array", "items": {"type": "string"}},
                "max_channels": {"type": "integer", "default": 32},
                "max_duration_seconds": {"type": "number", "default": 60.0, "description": "Bounded preview duration for memory-safe spectral planning on long recordings."},
            },
            ["input_path"],
        ),
        _function_tool(
            PYHFO_DETECT_LINE_NOISE,
            (
                "Detect candidate 50/60 Hz mains/line-noise peaks and harmonics in a bounded preview. Use before "
                "pyhfo_prepare_recording when notch filtering is being considered and line frequency is not already "
                "explicit. Do not use geography alone to choose 50/60 Hz; read result.decision.requires_user_confirmation."
            ),
            {
                "input_path": {"type": "string"},
                "exclude_channels": {"type": "array", "items": {"type": "string"}},
                "candidate_frequencies_hz": {"type": "array", "items": {"type": "number"}, "default": [50.0, 60.0]},
                "site_line_freq_hz": {"type": "number", "description": "Explicit site/header mains frequency when known, usually 50 or 60."},
                "max_channels": {"type": "integer", "default": 32},
                "max_harmonics": {"type": "integer", "default": 4},
                "bandwidth_hz": {"type": "number", "default": 1.0},
                "shoulder_width_hz": {"type": "number", "default": 5.0},
                "ratio_threshold": {"type": "number", "default": 5.0},
                "max_duration_seconds": {"type": "number", "default": 60.0},
            },
            ["input_path"],
        ),
        _function_tool(
            PYHFO_RECOMMEND_DETECTOR_PLAN,
            _DETECTOR_PLAN_DESCRIPTION,
            {
                "input_path": {"type": "string"},
                "recording_info": {"type": "object", "additionalProperties": True},
                "roi": {"type": "object", "additionalProperties": True},
            },
            [],
        ),
        _function_tool(
            PYHFO_RANK_CANDIDATE_CHANNELS,
            _RANK_CANDIDATES_DESCRIPTION,
            {
                "runs": {"type": "array", "items": {"type": "object"}, "description": "List of {biomarker, events_csv} detector outputs."},
                "duration_seconds": {"type": "number"},
                "exclude_channels": {"type": "array", "items": {"type": "string"}},
                "top_n": {"type": "integer", "default": 20},
            },
            ["runs"],
        ),
        _function_tool(
            PYHFO_DETECT_EVENTS,
            _DETECT_EVENTS_DESCRIPTION,
            _detection_properties(),
            ["input_path", "output_dir"],
        ),
        _function_tool(
            PYHFO_PREPARE_RECORDING,
            _PREPARE_RECORDING_DESCRIPTION,
            {
                "input_path": {
                    "type": "string",
                    "description": (
                        "Source EEG/iEEG recording readable by PyHFO/MNE. Prefer raw EDF/BDF/BrainVision/FIF. "
                        "Run pyhfo_get_recording_info first so the LLM can reason about duration, sampling rate, "
                        "declared bad channels, line frequency, and whether preprocessing is appropriate."
                    ),
                },
                "output_path": {
                    "type": "string",
                    "description": (
                        "Destination cleaned copy. Must end with .fif or .fif.gz. Use a new path under an "
                        "analysis/output directory; never overwrite the raw source recording."
                    ),
                },
                "bipolar_montage": {
                    "type": "string",
                    "enum": ["none", "auto_adjacent", "pairs"],
                    "description": (
                        "Optional bipolar re-referencing mode for monopolar iEEG/sEEG/ECoG contacts. Use none "
                        "when channels are already bipolar such as A1-A2 or when montage is unknown. Use "
                        "auto_adjacent only when channel names clearly share a prefix plus numeric contact order "
                        "(for example A1,A2,A3 or LA1,LA2,LA3). Use pairs only when explicit bipolar_pairs are "
                        "provided. Always report generated bipolar channel names."
                    ),
                    "default": "none",
                },
                "bipolar_pairs": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "anode": {"type": "string"},
                            "cathode": {"type": "string"},
                            "name": {"type": "string"},
                        },
                        "required": ["anode", "cathode"],
                    },
                    "description": (
                        "Explicit bipolar pairs for bipolar_montage=pairs. Use exact channel names from metadata. "
                        "name is optional; if omitted the output channel is named anode-cathode."
                    ),
                    "default": [],
                },
                "drop_original_after_bipolar": {
                    "type": "boolean",
                    "description": (
                        "Whether to remove source monopolar channels after adding bipolar channels. Safe default: "
                        "false for auditability; set true only when the user/protocol wants detection only on "
                        "derived bipolar channels."
                    ),
                    "default": False,
                },
                "line_noise_notch_hz": {
                    "type": "number",
                    "description": (
                        "Single mains notch frequency shortcut, typically 50 or 60. Prefer this when the user says "
                        "filter 60 Hz or filter 50 Hz. If file metadata lacks line_freq and the user did not specify "
                        "site frequency, ask or leave unset rather than guessing. This is merged into notch_freqs."
                    ),
                },
                "extra_bad_channels": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Channel names to treat as bad from user/domain knowledge or prior QC. Use exact channel "
                        "names from pyhfo_get_recording_info. Do not invent channel names."
                    ),
                    "default": [],
                },
                "drop_bad_channels": {
                    "type": "boolean",
                    "description": "Drop file-declared and extra_bad_channels from the prepared copy. Safe default: true.",
                    "default": True,
                },
                "drop_flat_channels": {
                    "type": "boolean",
                    "description": "Drop channels whose signal is effectively flat/zero-range. Safe default: true.",
                    "default": True,
                },
                "mark_outlier_channels": {
                    "type": "boolean",
                    "description": (
                        "Flag robust high-amplitude outlier channels in the report. Safe default: true so the "
                        "user can review candidates before exclusion."
                    ),
                    "default": True,
                },
                "drop_outlier_channels": {
                    "type": "boolean",
                    "description": (
                        "Drop robust high-amplitude outlier channels automatically. Safe default: false; set true "
                        "only if the user asks for aggressive auto-cleaning or a protocol explicitly requires it."
                    ),
                    "default": False,
                },
                "outlier_z_threshold": {
                    "type": "number",
                    "description": "Robust modified z-score threshold for amplitude outlier candidates. Default 8.0 is conservative.",
                    "default": 8.0,
                },
                "notch_freqs": {
                    "type": "array",
                    "items": {"type": "number"},
                    "description": (
                        "Optional mains/line-noise notch frequencies, usually [50] or [60]. If file line_freq is "
                        "missing, ask the user or use configured site default; do not guess silently. Leave empty "
                        "when line-noise handling is intentionally deferred."
                    ),
                    "default": [],
                },
                "bandpass": {
                    "type": "object",
                    "description": (
                        "Optional broad preprocessing filter using MNE keys, e.g. {\"l_freq\":1,\"h_freq\":300}. "
                        "Do not use this for detector-specific HFO fp/fs settings; pass those to pyhfo_detect_events.filter. "
                        "Keep h_freq below Nyquist. Leave empty for conservative smoke tests unless needed."
                    ),
                    "additionalProperties": True,
                },
                "resample_sfreq": {
                    "type": "number",
                    "description": (
                        "Optional target sampling frequency for the prepared copy. Do not downsample below the "
                        "Nyquist requirement for the intended detector band; for HFO/ripple work keep enough "
                        "bandwidth for the selected upper edge."
                    ),
                },
            },
            ["input_path", "output_path"],
        ),
        _function_tool(
            PYHFO_BATCH_CREATE,
            _BATCH_CREATE_DESCRIPTION,
            {
                "input_dir": {
                    "type": "string",
                    "description": "Directory containing EEG/iEEG recordings. Use a folder, not a single file path.",
                },
                "output_dir": {
                    "type": "string",
                    "description": "Directory for the batch manifest and later batch outputs; use a fresh analysis folder.",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether to scan subdirectories. Use true for BIDS-like datasets; false for a flat folder.",
                    "default": True,
                },
            },
            ["input_dir", "output_dir"],
        ),
        _function_tool(
            PYHFO_BATCH_RUN,
            _BATCH_RUN_DESCRIPTION,
            {
                "manifest_path": {
                    "type": "string",
                    "description": "Existing batch_project.json path from pyhfo_batch_create. Prefer this over input_dir/output_dir for reruns.",
                },
                "input_dir": {
                    "type": "string",
                    "description": "Input directory used only when manifest_path is omitted; pyhfo_batch_run may create/use a manifest from it.",
                },
                "output_dir": {
                    "type": "string",
                    "description": "Output directory used when manifest_path is omitted. Required with input_dir.",
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether to scan subdirectories when using input_dir/output_dir instead of manifest_path.",
                    "default": True,
                },
                "retry_failed": {
                    "type": "boolean",
                    "description": "Retry failed cases from a previous batch. Use only for reruns, not first runs.",
                    "default": False,
                },
                "fail_fast": {
                    "type": "boolean",
                    "description": "Stop after the first failed case. Useful for debugging a batch configuration.",
                    "default": False,
                },
                "detection": {
                    "type": "object",
                    "description": (
                        "Detection configuration shared by cases: biomarker, detector, filter, detector_params, "
                        "classifier, n_jobs, and exports. For first batch smoke tests use biomarker=HFO, "
                        "detector=STE, n_jobs=1, exports=[\"summary-json\"], and a Nyquist-safe HFO filter."
                    ),
                    "additionalProperties": True,
                },
            },
            [],
        ),
    ]

def _append_key_values(args: List[str], flag: str, values: Optional[Dict[str, Any]]) -> None:
    for key, value in (values or {}).items():
        if value is None:
            continue
        if isinstance(value, (list, tuple, dict)):
            # JSON-encode non-scalars so list-valued params (e.g. freq_sp=[11, 16])
            # round-trip as real lists. Python repr ("[11, 16]") would reach the CLI
            # key=value parser as a non-numeric string and crash float() in the
            # spindle/A7 detector init.
            token = f"{key}={json.dumps(value, ensure_ascii=False)}"
        else:
            token = f"{key}={value}"
        args.extend([flag, token])


def _append_exports(args: List[str], exports: Iterable[Any]) -> None:
    for item in exports or []:
        value = str(item or "").strip()
        if value:
            args.extend(["--export", value])


def _detection_args(parameters: Dict[str, Any]) -> List[str]:
    args: List[str] = []
    biomarker = str(parameters.get("biomarker") or "HFO").strip()
    if biomarker:
        args.extend(["--biomarker", biomarker])
    detector = str(parameters.get("detector") or "").strip()
    if detector:
        args.extend(["--detector", detector])
    n_jobs = parameters.get("n_jobs")
    if n_jobs in (None, ""):
        # Honor the tool schema's documented default of 1 for omitted/smoke-test runs.
        # The CLI's own argparse default is 4, so NOT emitting the flag would silently
        # run 4 workers and cause the GIL/CPU contention the project notes warn about.
        n_jobs = 1
    args.extend(["--n-jobs", str(n_jobs)])
    _append_key_values(args, "--filter", parameters.get("filter") if isinstance(parameters.get("filter"), dict) else {})
    _append_key_values(
        args,
        "--detector-param",
        parameters.get("detector_params") if isinstance(parameters.get("detector_params"), dict) else {},
    )
    _append_key_values(
        args,
        "--classifier-param",
        parameters.get("classifier") if isinstance(parameters.get("classifier"), dict) else {},
    )
    _append_exports(args, parameters.get("exports") if isinstance(parameters.get("exports"), list) else [])
    for channel in parameters.get("include_channels") or []:
        args.extend(["--include-channel", str(channel)])
    for channel in parameters.get("exclude_channels") or []:
        args.extend(["--exclude-channel", str(channel)])
    return args


def _json_cli_arg(value: Any, default: Any) -> str:
    return json.dumps(value if value is not None else default, ensure_ascii=False)


def _prepare_args(parameters: Dict[str, Any]) -> List[str]:
    args = [
        "--input",
        str(parameters.get("input_path") or ""),
        "--output",
        str(parameters.get("output_path") or ""),
    ]
    for channel in parameters.get("extra_bad_channels") or []:
        args.extend(["--extra-bad-channel", str(channel)])
    if parameters.get("drop_bad_channels") is False:
        args.append("--keep-bad-channels")
    if parameters.get("drop_flat_channels") is False:
        args.append("--keep-flat-channels")
    if parameters.get("drop_outlier_channels"):
        args.append("--drop-outlier-channels")
    if parameters.get("outlier_z_threshold") not in (None, ""):
        args.extend(["--outlier-z-threshold", str(parameters.get("outlier_z_threshold"))])
    if parameters.get("bipolar_montage") not in (None, ""):
        args.extend(["--bipolar-montage", str(parameters.get("bipolar_montage"))])
    if parameters.get("bipolar_pairs"):
        args.extend(["--bipolar-pairs-json", _json_cli_arg(parameters.get("bipolar_pairs"), [])])
    if parameters.get("drop_original_after_bipolar"):
        args.append("--drop-original-after-bipolar")
    if parameters.get("line_noise_notch_hz") not in (None, ""):
        args.extend(["--line-noise-notch-hz", str(parameters.get("line_noise_notch_hz"))])
    for freq in parameters.get("notch_freqs") or []:
        args.extend(["--notch", str(freq)])
    if isinstance(parameters.get("bandpass"), dict) and parameters.get("bandpass"):
        args.extend(["--bandpass-json", _json_cli_arg(parameters.get("bandpass"), {})])
    if parameters.get("resample_sfreq") not in (None, ""):
        args.extend(["--resample-sfreq", str(parameters.get("resample_sfreq"))])
    return args


def _rank_args(parameters: Dict[str, Any]) -> List[str]:
    args: List[str] = []
    for run in parameters.get("runs") or []:
        if not isinstance(run, dict):
            continue
        biomarker = str(run.get("biomarker") or "event")
        csv_path = str(run.get("events_csv") or run.get("csv") or "")
        if csv_path:
            args.extend(["--run", f"{biomarker}={csv_path}"])
    if parameters.get("duration_seconds") not in (None, ""):
        args.extend(["--duration-seconds", str(parameters.get("duration_seconds"))])
    for channel in parameters.get("exclude_channels") or []:
        args.extend(["--exclude-channel", str(channel)])
    if parameters.get("top_n") not in (None, ""):
        args.extend(["--top-n", str(parameters.get("top_n"))])
    return args


# Tools whose work the DESKTOP can do itself through a UI command. When a desktop session is
# live, running them here instead would compute the answer in this process and leave the
# workspace showing nothing -- the user asked the app to do something and the app would not move.
# Prose in a skill file is not enough to guarantee routing, so the tool itself redirects.
_UI_COMMAND_FOR_TOOL: Dict[str, str] = {
    PYHFO_RUN_SEVERITY_SCORING: 'severity.run',
    PYHFO_DETECT_EVENTS: 'detection.run',
    PYHFO_PREPARE_RECORDING: 'analysis.prepare_recording',
}

# Where the desktop's PyHFO session lives, injected by the Electron main process when it spawns
# this runtime. Absent for headless/CLI use, which is exactly when direct execution is right.
_SESSION_URL_ENV = 'PYHFO_SESSION_URL'
_SESSION_TOKEN_ENV = 'PYHFO_SESSION_TOKEN'
_UI_BROKER_URL_ENV = 'IEEG_UI_BROKER_URL'
_UI_BROKER_TOKEN_ENV = 'IEEG_UI_BROKER_TOKEN'


def desktop_session_active() -> bool:
    """True when the Electron desktop is driving this runtime and has a recording loaded."""
    return bool(_session_url()) and bool(_ACTIVE_RECORDING.get())


def _same_recording_locator(left: Any, right: Any) -> bool:
    """Compare desktop recording locators without guessing across distinct existing files."""
    left_text = str(left or "").strip()
    right_text = str(right or "").strip()
    if not left_text or not right_text:
        return False
    try:
        return Path(left_text).expanduser().resolve(strict=False) == Path(right_text).expanduser().resolve(strict=False)
    except (OSError, RuntimeError, ValueError):
        return left_text == right_text


def _desktop_handoff_payload(
    tool_name: str,
    parameters: Dict[str, Any],
) -> tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]]]:
    """Map a built-in write request to the exact payload the desktop can execute.

    The attached desktop always operates on its loaded recording. A different input locator or a
    headless-only parameter must therefore fail before broker issuance rather than being silently
    ignored and later acknowledged against another computation.
    """
    active_recording = get_active_recording()
    requested_recording = str(parameters.get("input_path") or "").strip()
    if not active_recording or not _same_recording_locator(requested_recording, active_recording):
        return None, {
            "success": False,
            "tool": tool_name,
            "status": "scope_conflict",
            "error_code": "desktop_recording_scope_conflict",
            "error": "The requested input is not the recording currently loaded in the desktop; nothing was staged.",
            "staged": False,
        }

    fingerprint = recording_fingerprint_for_path(active_recording, fresh=True)
    recording_scope: Dict[str, Any] = {"input_path": active_recording}
    if fingerprint:
        recording_scope["recording_fingerprint"] = fingerprint

    if tool_name == PYHFO_DETECT_EVENTS:
        return {
            **recording_scope,
            **_desktop_detection_payload(parameters),
            **({"output_dir": parameters["output_dir"]} if _nonempty_parameter(parameters, "output_dir") else {}),
        }, None

    if tool_name == PYHFO_PREPARE_RECORDING:
        controls, unmapped = _prepare_controls_for_ui(parameters)
        if unmapped:
            return None, {
                "success": False,
                "tool": tool_name,
                "status": "unsupported_parameters",
                "error_code": "desktop_parameter_mapping_unavailable",
                "error": (
                    "The attached desktop cannot execute these preparation parameters exactly: "
                    f"{', '.join(unmapped)}. Nothing was staged."
                ),
                "unmapped_parameters": unmapped,
                "staged": False,
            }
        return {
            **recording_scope,
            **controls,
            **({"output_path": parameters["output_path"]} if _nonempty_parameter(parameters, "output_path") else {}),
        }, None

    if tool_name == PYHFO_RUN_SEVERITY_SCORING:
        return {
            **recording_scope,
            **{
                key: parameters[key]
                for key in ("model_dir", "export_csv")
                if _nonempty_parameter(parameters, key)
            },
        }, None

    return None, {
        "success": False,
        "tool": tool_name,
        "status": "delivery_failed",
        "error_code": "desktop_command_mapping_unavailable",
        "error": "This tool has no canonical attached-desktop command mapping; nothing was staged.",
        "staged": False,
    }


def _hand_to_desktop(
    tool_name: str,
    command: str,
    parameters: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Ask the canonical UI broker to stage work for the attached desktop.

    The model invokes a capability; it never drives the UI and never chooses where the work runs.
    The broker validates and signs the command, and every clinician-authorized write remains staged
    until the clinician presses Apply. The run then happens in the workspace -- one code path, the
    same one the panel's own button takes -- so the panels update because their state changed, not
    because anything told them to.

    Returning prose telling the model to call emit_ui_command made correctness depend on a small
    model obeying instructions inside a tool result. Inventing a renderer command locally is also
    insufficient: the desktop rejects writes that were not issued by this broker.

    Returns immediately after durable broker enqueue. A staged command waits on a click that may
    never come, and a tool call is the wrong place to block on a human.
    """
    broker_url = str(os.environ.get(_UI_BROKER_URL_ENV) or "").strip().rstrip("/")
    broker_token = str(os.environ.get(_UI_BROKER_TOKEN_ENV) or "").strip()
    parsed_broker_url = urlparse(broker_url)
    if (
        not broker_url
        or not broker_token
        or parsed_broker_url.scheme != "http"
        or parsed_broker_url.hostname not in {"127.0.0.1", "localhost", "::1"}
    ):
        return {
            "success": False,
            "status": "delivery_failed",
            "error_code": "ui_broker_unavailable",
            "error": "The attached desktop UI broker is not securely configured; nothing was staged.",
            "staged": False,
            "tool": tool_name,
            "command_type": command,
        }

    # The tool's own parameters ARE the command payload: same names, same pipeline on the other
    # side. Sending an empty payload would quietly run a different analysis than the one asked for
    # and report it as a success. Authority metadata is runtime-owned and bound to this immutable
    # turn; the model cannot supply or replace it. The stable retry key lets a restarted broker
    # recover the same durable queued command without minting a second clinical computation.
    command_payload = dict(parameters or {})
    authority_scope = ui_command_context.current_authority_scope()
    idempotency_key = ui_command_context.command_idempotency_key(command, command_payload)
    if authority_scope is None or idempotency_key is None:
        return {
            "success": False,
            "status": "delivery_failed",
            "error_code": "ui_command_scope_unavailable",
            "error": "The current Agent turn has no complete trusted desktop authority scope; nothing was staged.",
            "staged": False,
            "tool": tool_name,
            "command_type": command,
        }
    body = {
        "type": command,
        "payload": command_payload,
        "reason": f"{tool_name} requested by the assistant",
        "authority_scope": authority_scope,
        "idempotency_key": idempotency_key,
    }
    try:
        request = urllib.request.Request(
            f"{broker_url}/ui/emit",
            data=json.dumps(body, ensure_ascii=False, allow_nan=False).encode("utf-8"),
            headers={
                "authorization": f"Bearer {broker_token}",
                "content-type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            broker_result = json.loads(response.read().decode("utf-8") or "{}")
    except Exception as exc:  # noqa: BLE001 - fail closed across the local process boundary
        logger.warning("[pyhfo_tools] canonical UI broker handoff failed for %s: %s", tool_name, exc)
        return {
            "success": False,
            "status": "delivery_failed",
            "error_code": "ui_broker_unavailable",
            "error": "The command was not delivered to the attached desktop; nothing was staged.",
            "staged": False,
            "tool": tool_name,
            "command_type": command,
        }

    issued = broker_result.get("command") if isinstance(broker_result, dict) else None
    receipt = broker_result.get("receipt") if isinstance(broker_result, dict) else None
    command_id = str(issued.get("command_id") or "") if isinstance(issued, dict) else ""
    issued_resource_scope = issued.get("resource_scope") if isinstance(issued, dict) else None
    expected_resource_scope = authority_scope.get("resource_scope")
    scope_matches = all(
        str(issued.get(field) or "") == str(authority_scope.get(field) or "")
        for field in ("request_id", "message_id", "conversation_id", "state_revision")
    ) if isinstance(issued, dict) else False
    if isinstance(expected_resource_scope, dict) and expected_resource_scope:
        scope_matches = scope_matches and issued_resource_scope == expected_resource_scope
    if (
        not isinstance(broker_result, dict)
        or broker_result.get("success") is not True
        or not isinstance(issued, dict)
        or not command_id.startswith("mcp-")
        or str(issued.get("type") or "") != command
        or issued.get("source") != "mcp"
        or issued.get("requires_confirmation") is not True
        or not scope_matches
        or not isinstance(receipt, dict)
        or receipt.get("command_id") != command_id
        or receipt.get("status") != "queued"
        or receipt.get("requires_confirmation") is not True
        or receipt.get("request_id") != authority_scope.get("request_id")
        or receipt.get("message_id") != authority_scope.get("message_id")
        or receipt.get("conversation_id") != authority_scope.get("conversation_id")
        or receipt.get("state_revision") != authority_scope.get("state_revision")
        or (receipt.get("idempotency") or {}).get("key_supplied") is not True
        or (
            authority_scope.get("recording_fingerprint")
            and receipt.get("recording_fingerprint") != authority_scope.get("recording_fingerprint")
        )
    ):
        broker_error = broker_result.get("error") if isinstance(broker_result, dict) else None
        return {
            "success": False,
            "status": "delivery_failed",
            "error_code": "ui_broker_rejected",
            "error": str(broker_error or "The UI broker rejected the command; nothing was staged."),
            "staged": False,
            "tool": tool_name,
            "command_type": command,
        }

    # Mirror the exact broker-issued command into the current SSE/final response. The renderer also
    # polls the broker queue; it deduplicates the two delivery paths by this canonical command_id.
    ui_command_context.record_ui_command(issued)
    return {
        "success": True,
        "status": "staged",
        "staged": True,
        "tool": tool_name,
        "command_id": command_id,
        "command_type": command,
        "message": (
            "The canonical UI broker delivered this command to the workspace. It is waiting for the "
            "clinician to press Apply before the workspace starts it. You have no result numbers yet; "
            "report only that it was staged, and never invent a score."
        ),
    }


def _write_back_to_session(tool_name: str, result: Dict[str, Any]) -> None:
    """Push a locally-computed result into the desktop session so its panels can show it.

    Best-effort: a headless run has no session, and a failure here must not turn a successful
    computation into a tool error.
    """
    if tool_name != PYHFO_RUN_SEVERITY_SCORING:
        return
    base = _session_url().rstrip('/')
    if not base or not isinstance(result, dict) or result.get('status') != 'complete':
        return
    token = _session_token()
    payload = json.dumps({'result': result}).encode('utf-8')
    request = urllib.request.Request(
        f'{base}/severity/adopt',
        data=payload,
        headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {})},
        method='POST',
    )
    try:
        with urllib.request.urlopen(request, timeout=15):
            pass
    except Exception as exc:  # noqa: BLE001 - reporting the score matters more than mirroring it
        logger.warning('[pyhfo_tools] could not mirror %s into the desktop session: %s', tool_name, exc)


def _build_command(tool_name: str, parameters: Dict[str, Any]) -> List[str]:
    python = get_pyhfo_python()
    if tool_name in {PYHFO_LIST_CAPABILITIES, PYHFO_GET_CAPABILITY_MANIFEST}:
        command = [python, "-m", "pyhfo.agent_cli", "manifest"]
        if not parameters.get("include_missing", True):
            command.append("--callable-only")
        return command
    if tool_name == PYHFO_GET_RECORDING_INFO:
        return [python, "-m", "pyhfo.agent_cli", "info", "--input", str(parameters.get("input_path") or ""), "--json"]
    if tool_name == PYHFO_INFER_BRAIN_SIGNAL_ROI:
        return [python, "-m", "pyhfo.agent_cli", "roi", "--input", str(parameters.get("input_path") or "")]
    if tool_name == PYHFO_RUN_SEVERITY_SCORING:
        command = [python, "-m", "pyhfo.agent_cli", "severity", "--input", str(parameters.get("input_path") or "")]
        if parameters.get("model_dir"):
            command.extend(["--model-dir", str(parameters.get("model_dir"))])
        if parameters.get("export_csv"):
            command.extend(["--export-csv", str(parameters.get("export_csv"))])
        return command
    if tool_name == PYHFO_COMPUTE_CHANNEL_QC:
        command = [python, "-m", "pyhfo.agent_cli", "qc", "--input", str(parameters.get("input_path") or "")]
        for channel in parameters.get("exclude_channels") or []:
            command.extend(["--exclude-channel", str(channel)])
        if parameters.get("outlier_z_threshold") not in (None, ""):
            command.extend(["--outlier-z-threshold", str(parameters.get("outlier_z_threshold"))])
        if parameters.get("max_duration_seconds") not in (None, ""):
            command.extend(["--max-duration-seconds", str(parameters.get("max_duration_seconds"))])
        return command
    if tool_name == PYHFO_COMPUTE_SPECTRAL_PROFILE:
        command = [python, "-m", "pyhfo.agent_cli", "spectral", "--input", str(parameters.get("input_path") or "")]
        for channel in parameters.get("exclude_channels") or []:
            command.extend(["--exclude-channel", str(channel)])
        if parameters.get("max_channels") not in (None, ""):
            command.extend(["--max-channels", str(parameters.get("max_channels"))])
        if parameters.get("max_duration_seconds") not in (None, ""):
            command.extend(["--max-duration-seconds", str(parameters.get("max_duration_seconds"))])
        return command
    if tool_name == PYHFO_DETECT_LINE_NOISE:
        command = [python, "-m", "pyhfo.agent_cli", "line-noise", "--input", str(parameters.get("input_path") or "")]
        for channel in parameters.get("exclude_channels") or []:
            command.extend(["--exclude-channel", str(channel)])
        for freq in parameters.get("candidate_frequencies_hz") or []:
            command.extend(["--candidate-frequency", str(freq)])
        if parameters.get("site_line_freq_hz") not in (None, ""):
            command.extend(["--site-line-freq-hz", str(parameters.get("site_line_freq_hz"))])
        for key, flag in [
            ("max_channels", "--max-channels"),
            ("max_harmonics", "--max-harmonics"),
            ("bandwidth_hz", "--bandwidth-hz"),
            ("shoulder_width_hz", "--shoulder-width-hz"),
            ("ratio_threshold", "--ratio-threshold"),
            ("max_duration_seconds", "--max-duration-seconds"),
        ]:
            if parameters.get(key) not in (None, ""):
                command.extend([flag, str(parameters.get(key))])
        return command
    if tool_name == PYHFO_RECOMMEND_DETECTOR_PLAN:
        command = [python, "-m", "pyhfo.agent_cli", "detector-plan", "--input", str(parameters.get("input_path") or "")]
        recording_info = parameters.get("recording_info")
        if isinstance(recording_info, dict) and recording_info:
            command.extend(["--recording-info-json", json.dumps(recording_info, ensure_ascii=False)])
        roi = parameters.get("roi")
        if isinstance(roi, dict) and roi:
            command.extend(["--roi-json", json.dumps(roi, ensure_ascii=False)])
        return command
    if tool_name == PYHFO_RANK_CANDIDATE_CHANNELS:
        return [python, "-m", "pyhfo.agent_cli", "rank-candidates", *_rank_args(parameters)]
    if tool_name == PYHFO_DETECT_EVENTS:
        return [
            python,
            "-m",
            "pyhfo.agent_cli",
            "detect",
            "--input",
            str(parameters.get("input_path") or ""),
            "--output",
            str(parameters.get("output_dir") or ""),
            *_detection_args(parameters),
        ]
    if tool_name == PYHFO_PREPARE_RECORDING:
        return [python, "-m", "pyhfo.agent_cli", "prepare", *_prepare_args(parameters)]
    if tool_name == PYHFO_BATCH_CREATE:
        command = [
            python,
            "-m",
            "pyhfo.agent_cli",
            "batch-create",
            "--input",
            str(parameters.get("input_dir") or ""),
            "--output",
            str(parameters.get("output_dir") or ""),
        ]
        if parameters.get("recursive") is False:
            command.append("--no-recursive")
        return command
    if tool_name == PYHFO_BATCH_RUN:
        detection = parameters.get("detection") if isinstance(parameters.get("detection"), dict) else {}
        command = [python, "-m", "pyhfo.agent_cli", "batch-run"]
        if parameters.get("manifest_path"):
            command.extend(["--manifest", str(parameters.get("manifest_path"))])
        if parameters.get("input_dir"):
            command.extend(["--input", str(parameters.get("input_dir"))])
        if parameters.get("output_dir"):
            command.extend(["--output", str(parameters.get("output_dir"))])
        if parameters.get("retry_failed"):
            command.append("--retry-failed")
        if parameters.get("fail_fast"):
            command.append("--fail-fast")
        if parameters.get("recursive") is False:
            command.append("--no-recursive")
        command.extend(_detection_args(detection))
        return command
    raise ValueError(f"unknown PyHFO tool: {tool_name}")


def _parse_json_payload(text: str) -> Any:
    stripped = (text or "").strip()
    if not stripped:
        return None
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        # Some PyHFO paths can emit progress text before/after the JSON payload.
        # Prefer the final complete JSON object instead of failing the whole tool.
        start = stripped.find("{")
        end = stripped.rfind("}")
        if start >= 0 and end > start:
            return json.loads(stripped[start : end + 1])
        raise


def _timeout_seconds() -> int:
    raw = os.getenv("PYHFO_AGENT_TIMEOUT_SECONDS")
    if not raw:
        return DEFAULT_TIMEOUT_SECONDS
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_TIMEOUT_SECONDS


@lru_cache(maxsize=32)
def _declared_parameter_names(tool_name: str) -> tuple[str, ...]:
    for definition in get_tool_definitions():
        function = definition.get("function") if isinstance(definition, dict) else None
        if not isinstance(function, dict) or function.get("name") != tool_name:
            continue
        parameters = function.get("parameters")
        properties = parameters.get("properties") if isinstance(parameters, dict) else None
        if isinstance(properties, dict):
            return tuple(sorted(str(key) for key in properties))
    return ()


@lru_cache(maxsize=32)
def _declared_parameter_defaults(tool_name: str) -> Dict[str, Any]:
    """Return the complete adapter/CLI default map for a public tool."""

    defaults = copy.deepcopy(_CLI_EFFECTIVE_DEFAULTS.get(tool_name, {}))
    if tool_name == PYHFO_DETECT_EVENTS:
        defaults.update(copy.deepcopy(_DETECTION_EFFECTIVE_DEFAULTS))
    for definition in get_tool_definitions():
        function = definition.get("function") if isinstance(definition, dict) else None
        if not isinstance(function, dict) or function.get("name") != tool_name:
            continue
        parameters = function.get("parameters")
        properties = parameters.get("properties") if isinstance(parameters, dict) else None
        if not isinstance(properties, dict):
            break
        for key, schema in properties.items():
            if isinstance(schema, dict) and "default" in schema:
                defaults[str(key)] = copy.deepcopy(schema["default"])
        break
    return defaults


def _uses_default(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _materialize_default_map(parameters: Any, defaults: Dict[str, Any]) -> Dict[str, Any]:
    explicit = dict(parameters) if isinstance(parameters, dict) else {}
    materialized = copy.deepcopy(defaults)
    for key, value in explicit.items():
        if key in defaults and _uses_default(value):
            continue
        materialized[str(key)] = copy.deepcopy(value)
    return materialized


def _materialize_effective_parameters(tool_name: str, parameters: Any) -> Dict[str, Any]:
    """Resolve every adapter/CLI default before execution and attestation."""

    materialized = _materialize_default_map(
        parameters,
        _declared_parameter_defaults(tool_name),
    )
    if tool_name == PYHFO_BATCH_RUN:
        materialized["detection"] = _materialize_default_map(
            materialized.get("detection"),
            _DETECTION_EFFECTIVE_DEFAULTS,
        )
    elif tool_name == PYHFO_RANK_CANDIDATE_CHANNELS:
        normalized_runs: List[Any] = []
        for run in materialized.get("runs") or []:
            if not isinstance(run, dict):
                normalized_runs.append(copy.deepcopy(run))
                continue
            normalized = copy.deepcopy(run)
            if _uses_default(normalized.get("biomarker")):
                normalized["biomarker"] = "event"
            normalized_runs.append(normalized)
        materialized["runs"] = normalized_runs
    return materialized


def _input_file_lineage(tool_name: str, call_parameters: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Hash rank CSV and batch-manifest inputs without exposing local paths."""

    candidates: List[tuple[str, int, Any]] = []
    if tool_name == PYHFO_RANK_CANDIDATE_CHANNELS:
        for index, run in enumerate(call_parameters.get("runs") or []):
            if isinstance(run, dict):
                candidates.append(
                    ("detector_events_csv", index, run.get("events_csv") or run.get("csv"))
                )
    elif tool_name == PYHFO_BATCH_RUN and call_parameters.get("manifest_path"):
        candidates.append(("batch_manifest", 0, call_parameters.get("manifest_path")))

    lineage: List[Dict[str, Any]] = []
    for kind, source_index, path in candidates:
        digest = recording_fingerprint_for_path(path, fresh=True)
        if not digest:
            continue
        lineage.append(
            {
                "artifact_id": f"input-{digest[:24]}",
                "kind": kind,
                "source_index": source_index,
                "sha256": digest,
                "uri": f"artifact://sha256/{digest}",
            }
        )
    return lineage


def _execution_provenance(
    *,
    tool_name: str,
    call_parameters: Dict[str, Any],
    result_payload: Any,
    source_fingerprint: Optional[str],
    input_fingerprint: Optional[str],
    input_lineage: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """Create adapter-owned evidence scope which the model cannot self-attest."""

    attestation = build_execution_attestation(
        tool_name=tool_name,
        call_parameters=call_parameters,
        result_payload=result_payload,
        source_recording_fingerprint=source_fingerprint,
        input_recording_fingerprint=input_fingerprint,
        state_revision=f"recording-{source_fingerprint[:24]}" if source_fingerprint else None,
        allowed_parameter_names=_declared_parameter_names(tool_name),
    )
    if input_lineage:
        attestation["input_lineage"] = copy.deepcopy(input_lineage)
        attestation["input_lineage_sha256"] = canonical_json_sha256(input_lineage)
    return attestation


def _same_existing_file(left: Any, right: Any) -> bool:
    try:
        return Path(str(left or "")).expanduser().resolve(strict=True).samefile(
            Path(str(right or "")).expanduser().resolve(strict=True)
        )
    except (OSError, RuntimeError, ValueError):
        return False


def _register_successful_prepare_lineage(
    *,
    tool_name: str,
    call_parameters: Dict[str, Any],
    result_payload: Any,
    source_fingerprint: Optional[str],
) -> None:
    """Register only a concrete prepare output proven by this adapter call."""

    if tool_name != PYHFO_PREPARE_RECORDING or not isinstance(result_payload, dict):
        return
    status = str(result_payload.get("status") or "complete").strip().lower()
    if status in {"error", "failed", "cancelled", "rejected"}:
        return
    requested_output = call_parameters.get("output_path")
    observed_output = result_payload.get("output_path")
    if not requested_output or not observed_output or not _same_existing_file(requested_output, observed_output):
        logger.warning("PyHFO prepare result did not prove the requested output identity; lineage was not registered")
        return
    derived_fingerprint = recording_fingerprint_for_path(observed_output, fresh=True)
    if not _register_recording_lineage(
        source_fingerprint=source_fingerprint,
        derived_fingerprint=derived_fingerprint,
    ):
        logger.warning("PyHFO prepare output lineage was ambiguous or incomplete")


def _llm_result_guidance(tool_name: str, success: bool) -> Dict[str, Any]:
    """Return compact instructions that help the model interpret PyHFO tool output.

    Tool descriptions guide argument construction before a call. This payload guides the
    next reasoning step after a call, when the LLM sees concrete metadata, warnings, or
    artifact paths. Keep it domain-specific but stable and non-secret.
    """
    if tool_name in {PYHFO_LIST_CAPABILITIES, PYHFO_GET_CAPABILITY_MANIFEST}:
        return {
            "read_these_fields": [
                "result.recommended_pipeline",
                "result.actions[].name/status/phase/input_schema/llm_usage",
                "result.safety",
            ],
            "interpretation_policy": [
                "Use this sidecar manifest to choose existing tools and avoid claiming missing doctor-facing features are callable.",
                "If a needed workflow status is needs_headless_wrapper, explain the gap or implement a wrapper before use.",
                "Prefer actions marked callable for immediate pipeline execution.",
            ],
            "next_safe_actions": [
                "For data analysis, start with pyhfo_get_recording_info.",
                "For preprocessing, use pyhfo_prepare_recording with explicit montage/notch/filter choices.",
                "For missing review features, propose wrapper work rather than pretending the LLM can use the GUI directly.",
            ],
        }
    if tool_name == PYHFO_GET_RECORDING_INFO:
        return {
            "read_these_fields": [
                "result.channel_names or result.n_channels",
                "result.sample_freq/result.sfreq",
                "result.duration/result.duration_seconds",
                "result.highpass/result.lowpass/result.line_freq",
                "result.bad_channels/result.bads",
            ],
            "interpretation_policy": [
                "Use this as metadata only; do not claim flat/outlier/artifact QC from this tool alone.",
                "Duration <10s means inspect-only; 10-60s means smoke-test only; >60s can support smoke testing but not necessarily robust statistics.",
                "For HFO/ripple work, compute Nyquist = sfreq/2 and keep detector upper edge below Nyquist.",
                "If line_freq is missing, ask for 50/60 Hz site default or state that notch filtering is unresolved.",
                "Exclude obvious non-neural/event/auxiliary channels from detection only after naming the reason.",
            ],
            "next_safe_actions": [
                "For analysis requests, propose pyhfo_prepare_recording before pyhfo_detect_events.",
                "For metadata-only requests, summarize and stop without detection.",
                "For too-short or undersampled recordings, explain the blocker and do not run detection.",
            ],
        }
    if tool_name == PYHFO_INFER_BRAIN_SIGNAL_ROI:
        return {
            "read_these_fields": ["result.brain_signal_channels", "result.default_detection_exclusions", "result.uncertain_channels", "result.warnings"],
            "interpretation_policy": [
                "Use this ROI before QC/detection for EDF-only pathology questions.",
                "Exclude EKG/auxiliary/uncertain channels from default candidate rankings unless user confirms they are neural.",
                "This is label-free signal understanding, not clinical localization.",
            ],
            "next_safe_actions": ["Run pyhfo_compute_channel_qc and pyhfo_compute_spectral_profile on the ROI before detection."],
        }
    if tool_name == PYHFO_COMPUTE_CHANNEL_QC:
        return {
            "read_these_fields": ["result.flat_channels", "result.outlier_channels", "result.per_channel", "result.warnings"],
            "interpretation_policy": ["Treat QC as heuristic; do not call outliers pathological.", "Use QC results to decide exclusions or reruns."],
            "next_safe_actions": ["Use pyhfo_compute_spectral_profile or pyhfo_recommend_detector_plan before detection."],
        }
    if tool_name == PYHFO_COMPUTE_SPECTRAL_PROFILE:
        return {
            "read_these_fields": ["result.nyquist_hz", "result.recommended_hfo_band", "result.line_noise_candidates", "result.relative_band_power"],
            "interpretation_policy": ["Use Nyquist and line-noise evidence to choose filters; do not guess 50/60 Hz notch."],
            "next_safe_actions": ["Call pyhfo_detect_line_noise if notch handling is uncertain, then pyhfo_recommend_detector_plan or Nyquist-safe pyhfo_detect_events."],
        }
    if tool_name == PYHFO_DETECT_LINE_NOISE:
        return {
            "read_these_fields": ["result.detected_frequencies", "result.decision", "result.recommended_notch_hz", "result.warnings"],
            "interpretation_policy": [
                "Use explicit user/site/header frequency before applying notch; detected peaks alone may require confirmation.",
                "Do not present line-noise evidence as a clinical finding.",
            ],
            "next_safe_actions": ["If result.decision.should_notch is true, pass result.recommended_notch_hz to pyhfo_prepare_recording.line_noise_notch_hz; otherwise ask/confirm or leave notch unset."],
        }
    if tool_name == PYHFO_RECOMMEND_DETECTOR_PLAN:
        return {
            "read_these_fields": ["result.recommended_runs", "result.excluded_channels", "result.warnings", "result.interpretation_policy"],
            "interpretation_policy": ["Use recommended runs as a conservative starting point; report detector/filter choices."],
            "next_safe_actions": ["Run pyhfo_detect_events for planned Spike/HFO runs when analysis is requested."],
        }
    if tool_name == PYHFO_RANK_CANDIDATE_CHANNELS:
        return {
            "read_these_fields": ["result.top_channels", "result.excluded_channels", "result.artifact_paths", "result.interpretation_policy"],
            "interpretation_policy": ["Report rankings as algorithmic candidates after ROI exclusions, not clinical pathological labels."],
            "next_safe_actions": ["Suggest visual review, parameter comparison, or explicit label loading only if requested."],
        }
    if tool_name == PYHFO_PREPARE_RECORDING:
        return {
            "read_these_fields": [
                "result.output_path",
                "result.prepared_channels/result.prepared_n_channels",
                "result.dropped_channels",
                "result.flat_channels",
                "result.outlier_channels",
                "result.bipolar_montage.added_channels/result.bipolar_montage.warnings",
                "result.notch_freqs/result.line_noise_notch_hz",
                "result.warnings",
            ],
            "interpretation_policy": [
                "Treat dropped_channels as actual preprocessing actions and outlier_channels as heuristic review candidates unless drop_outlier_channels was true.",
                "If too many channels were dropped, pause and ask for review before detection.",
                "Use result.output_path as the input_path for pyhfo_detect_events.",
                "Report bipolar montage, notch, bandpass, and resampling choices explicitly so results are reproducible.",
            ],
            "next_safe_actions": [
                "If preparation succeeded and enough neural channels remain, run a smoke detection only when requested.",
                "If preparation failed, report the stable error and do not run detection on the raw file as a silent fallback.",
            ],
        }
    if tool_name == PYHFO_DETECT_EVENTS:
        return {
            "read_these_fields": [
                "result.event_counts/result.num_events/result.events",
                "result.artifacts/result.output_paths/result.exports",
                "result.warnings/result.errors",
                "result.detector/result.filter/result.detector_params",
                "result.runtime_seconds/result.timing",
            ],
            "interpretation_policy": [
                "Report event counts as algorithmic detections requiring expert review, not clinical findings.",
                "Always include detector/filter/classifier settings used, because HFO results are parameter-sensitive.",
                "If zero events are found, distinguish true absence from possible parameter/data-quality limitations.",
                "If warnings mention channels, artifacts, or filters, surface them before conclusions.",
            ],
            "next_safe_actions": [
                "Suggest parameter refinement only from observed metadata/warnings/event counts, not guesswork.",
                "For meaningful research output, recommend visual QC and expert review after smoke tests.",
            ],
        }
    if tool_name == PYHFO_BATCH_CREATE:
        return {
            "read_these_fields": [
                "result.manifest_path/result.project_path",
                "result.cases/result.case_count",
                "result.skipped/result.warnings/result.errors",
            ],
            "interpretation_policy": [
                "This created/planned a batch; it did not run detection.",
                "Report how many cases were discovered and any skipped files before recommending batch_run.",
                "Use manifest_path for pyhfo_batch_run rather than reconstructing input/output arguments.",
            ],
            "next_safe_actions": [
                "For first batch validation, run a small smoke batch or fail_fast=true with n_jobs=1.",
            ],
        }
    if tool_name == PYHFO_BATCH_RUN:
        return {
            "read_these_fields": [
                "result.cases/result.case_results",
                "result.completed/result.failed/result.skipped",
                "result.artifacts/result.output_dir",
                "result.warnings/result.errors",
            ],
            "interpretation_policy": [
                "Summarize successes and failures separately; do not hide failed cases behind aggregate counts.",
                "For failed cases, report stable error messages and recommend retry_failed only after fixing the cause.",
                "Treat batch event counts as screening outputs requiring downstream QC, not final scientific claims.",
            ],
            "next_safe_actions": [
                "If failures occurred, inspect one representative failure before broad parameter changes.",
                "If all cases succeeded, point to artifacts and suggest review/aggregation steps.",
            ],
        }
    return {
        "read_these_fields": [],
        "interpretation_policy": ["Check success, result, warnings, errors, and artifact paths before answering."],
        "next_safe_actions": [],
    }


def execute_sync(tool_name: str, parameters: Dict[str, Any], *, conversation_id: Optional[str] = None) -> Dict[str, Any]:
    normalized = str(tool_name or "").strip()
    if normalized not in TOOL_NAMES:
        return {"success": False, "error": f"unknown PyHFO tool: {tool_name}"}

    # A live desktop owns these capabilities. Route the user's requested controls
    # to that workspace before applying the headless direct-write boundary or
    # materializing CLI-only defaults. Otherwise an attached desktop is told to
    # call ieeg_ui even though this adapter can hand the command to it directly,
    # and default values that the user never selected leak into the UI intent.
    requested_parameters = dict(parameters or {})
    if normalized in _INPUT_PATH_TOOLS:
        requested_parameters["input_path"] = _input_path_or_active_recording(
            requested_parameters.get("input_path")
        )
    ui_command = _UI_COMMAND_FOR_TOOL.get(normalized)
    if ui_command and desktop_session_active():
        if normalized == PYHFO_DETECT_EVENTS:
            clarification = _desktop_detection_clarification(requested_parameters)
            if clarification is not None:
                return clarification
        handoff_payload, mapping_error = _desktop_handoff_payload(normalized, requested_parameters)
        if mapping_error is not None:
            return {
                **mapping_error,
                "llm_guidance": _llm_result_guidance(normalized, success=False),
            }
        handoff = _hand_to_desktop(normalized, ui_command, handoff_payload)
        if handoff.get("success") is not True:
            return {
                "success": False,
                "tool": normalized,
                "status": handoff.get("status") or "delivery_failed",
                "error_code": handoff.get("error_code") or "ui_broker_unavailable",
                "error": handoff.get("error") or "The command was not delivered to the desktop UI.",
                "result": handoff,
                "llm_guidance": _llm_result_guidance(normalized, success=False),
            }
        return {
            "success": True,
            "tool": normalized,
            "result": handoff,
            "llm_guidance": _llm_result_guidance(normalized, success=True),
        }

    authority_denial = get_direct_execution_denial(normalized, requested_parameters)
    if authority_denial is not None:
        return authority_denial
    root = get_pyhfo_app_root()
    call_parameters = _materialize_effective_parameters(normalized, requested_parameters)
    # Anchor single-recording tools to the loaded recording when the model omits
    # input_path, or when it copied the same loaded file path with characters
    # normalized into a non-existent path.
    if normalized in _INPUT_PATH_TOOLS:
        call_parameters["input_path"] = _input_path_or_active_recording(call_parameters.get("input_path"))
    if normalized == PYHFO_DETECT_EVENTS:
        mcp_guidance = _desktop_detection_mcp_guidance(call_parameters)
        if mcp_guidance is not None:
            return mcp_guidance
    # The workspace owns the work whenever it is on screen: computing it here would leave every
    # panel the user is watching unchanged.
    if ui_command and not desktop_session_active():
        # Running one of these here means the user watched a panel that never moved: no confirmation
        # bubble, no progress, no result in the workspace. Say which half of the condition failed, so
        # the next person does not have to bisect it from the outside.
        logger.warning(
            '[pyhfo_tools] %s is running LOCALLY, not in the workspace: session_url=%s active_recording=%s',
            normalized,
            bool(_session_url()),
            _ACTIVE_RECORDING.get(),
        )
    # Only the tools that actually shell out need the CLI. Checking it earlier meant a packaged
    # install rejected the workspace-owned tools too -- the model saw severity scoring, called it, and
    # was told the backend was missing, when the workspace next door was perfectly able to run it.
    if not (root / "src" / "pyhfo" / "agent_cli.py").exists():
        logger.warning("PyHFO agent-callable runtime is unavailable")
        return {
            "success": False,
            "error_code": "pyhfo_runtime_unavailable",
            "error": "PyHFO agent-callable runtime is unavailable.",
            "hint": "Expected bundled pyhfo/ or set PYHFO_AGENT_APP_ROOT to a PyHFO agent-callable app directory.",
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }

    input_path = call_parameters.get("input_path") if normalized in _INPUT_PATH_TOOLS else None
    active_path = get_active_recording() if input_path else None
    input_fingerprint_before = recording_fingerprint_for_path(input_path, fresh=True)
    active_fingerprint_before = recording_fingerprint_for_path(active_path, fresh=True)
    proven_lineage_source = _recording_lineage_source(input_fingerprint_before)
    if input_fingerprint_before and active_fingerprint_before == input_fingerprint_before:
        source_fingerprint_before = input_fingerprint_before
    elif input_fingerprint_before and proven_lineage_source:
        source_fingerprint_before = proven_lineage_source
    else:
        # A different model-supplied path is a different source unless this
        # adapter previously witnessed a successful preparation that proves
        # otherwise. Merely having another recording active is not lineage.
        source_fingerprint_before = input_fingerprint_before
    input_lineage_before = _input_file_lineage(normalized, call_parameters)
    command = _build_command(normalized, call_parameters)
    try:
        completed = subprocess.run(
            command,
            cwd=str(root),
            env=pyhfo_process_env(root),
            text=True,
            capture_output=True,
            timeout=_timeout_seconds(),
            check=False,
        )
    except subprocess.TimeoutExpired:
        logger.warning("PyHFO tool %s timed out", normalized)
        return {
            "success": False,
            "error_code": "pyhfo_timeout",
            "error": "PyHFO command timed out",
            "timeout_seconds": _timeout_seconds(),
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }
    except Exception:
        logger.error("PyHFO tool %s failed before returning a result", normalized)
        return {
            "success": False,
            "error_code": "pyhfo_execution_failed",
            "error": "PyHFO command failed before returning a result.",
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }

    payload = None
    for stream_text in (completed.stdout, completed.stderr):
        try:
            payload = _parse_json_payload(stream_text)
            if payload is not None:
                break
        except Exception:
            continue

    if completed.returncode != 0:
        logger.warning("PyHFO tool %s exited with status %s", normalized, completed.returncode)
        return {
            "success": False,
            "error_code": "pyhfo_command_failed",
            "error": "PyHFO command failed.",
            "returncode": completed.returncode,
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }

    if payload is None:
        logger.warning("PyHFO tool %s returned no parseable JSON", normalized)
        return {
            "success": False,
            "error_code": "pyhfo_invalid_response",
            "error": "PyHFO command did not return a valid structured result.",
            "returncode": completed.returncode,
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }

    input_lineage_after = _input_file_lineage(normalized, call_parameters)
    if input_lineage_after != input_lineage_before:
        logger.warning("PyHFO tool %s observed input artifact bytes changing during execution", normalized)
        return {
            "success": False,
            "error_code": "input_artifact_changed_during_execution",
            "error": "Input artifact bytes changed during execution; result provenance is invalid.",
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }

    input_fingerprint_after = recording_fingerprint_for_path(input_path, fresh=True)
    active_fingerprint_after = recording_fingerprint_for_path(active_path, fresh=True)
    source_is_active_recording = bool(
        active_fingerprint_before
        and source_fingerprint_before == active_fingerprint_before
    )
    if (
        input_fingerprint_after != input_fingerprint_before
        or (
            source_is_active_recording
            and active_fingerprint_after != active_fingerprint_before
        )
    ):
        logger.warning("PyHFO tool %s observed recording bytes changing during execution", normalized)
        return {
            "success": False,
            "error_code": "recording_changed_during_execution",
            "error": "Recording bytes changed during execution; result provenance is invalid.",
            "llm_guidance": _llm_result_guidance(normalized, success=False),
        }

    result_payload = payload
    _register_successful_prepare_lineage(
        tool_name=normalized,
        call_parameters=call_parameters,
        result_payload=result_payload,
        source_fingerprint=source_fingerprint_before,
    )
    # Headless runs have no session to mirror into; when there IS one, this is what keeps the
    # workspace from disagreeing with the answer the user was just given.
    if isinstance(result_payload, dict):
        _write_back_to_session(normalized, result_payload)
    return {
        "success": True,
        "tool": normalized,
        "pyhfo_app_root": str(root),
        "result": result_payload,
        "execution_provenance": _execution_provenance(
            tool_name=normalized,
            call_parameters=call_parameters,
            result_payload=result_payload,
            source_fingerprint=source_fingerprint_before,
            input_fingerprint=input_fingerprint_before,
            input_lineage=input_lineage_before,
        ),
        "llm_guidance": _llm_result_guidance(normalized, success=True),
    }


async def execute(tool_name: str, parameters: Dict[str, Any], *, conversation_id: Optional[str] = None) -> Dict[str, Any]:
    import asyncio

    return await asyncio.to_thread(execute_sync, tool_name, parameters or {}, conversation_id=conversation_id)
