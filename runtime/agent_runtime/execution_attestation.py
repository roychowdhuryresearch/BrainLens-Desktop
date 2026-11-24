from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from runtime.redaction import redact_observability_payload


EXECUTION_ATTESTATION_VERSION = "research-execution.v1"
RUNTIME_SOFTWARE_VERSION = "ieeg-agent@1.0.0"
PYHFO_ADAPTER_VERSION = "pyhfo-adapter.v1"
UI_BROKER_ADAPTER_VERSION = "ui-broker-adapter.v1"
RUNTIME_SOFTWARE_COMPONENTS = [
    {"name": "ieeg-agent-runtime", "version": "1.0.0"},
    {"name": "research-evidence-contract", "version": "1"},
]


TRUSTED_EVIDENCE_KINDS_BY_TOOL: dict[str, frozenset[str]] = {
    "pyhfo_get_recording_info": frozenset({"recording_metadata"}),
    "pyhfo_infer_brain_signal_roi": frozenset({"recording_metadata"}),
    "pyhfo_compute_channel_qc": frozenset({"quality_control"}),
    "pyhfo_compute_spectral_profile": frozenset({"spectral_measurement"}),
    "pyhfo_detect_line_noise": frozenset({"quality_control", "spectral_measurement"}),
    "pyhfo_rank_candidate_channels": frozenset({"channel_ranking", "artifact"}),
    "pyhfo_detect_events": frozenset({"detector_candidate", "artifact"}),
    "pyhfo_prepare_recording": frozenset({"recording_metadata", "quality_control", "artifact"}),
    "pyhfo_run_severity_scoring": frozenset({"severity_score", "artifact"}),
    "pyhfo_batch_run": frozenset(
        {"quality_control", "detector_candidate", "classifier_prediction", "channel_ranking", "artifact"}
    ),
    # Exact UI tools are broker-owned observations.  A model may select a subset
    # of their returned state, but cannot invent a different evidence kind.
    "get_ui_state": frozenset(
        {
            "recording_metadata", "quality_control", "spectral_measurement",
            "detector_candidate", "classifier_prediction", "channel_ranking",
            "severity_score", "human_review", "annotation", "artifact",
        }
    ),
    "wait_for_ui_command": frozenset(
        {
            "recording_metadata", "quality_control", "spectral_measurement",
            "detector_candidate", "classifier_prediction", "channel_ranking",
            "severity_score", "human_review", "annotation", "artifact",
        }
    ),
    "events.stage_annotation": frozenset({"human_review", "annotation"}),
    "review.accept_run": frozenset({"human_review"}),
}


_PATHISH_KEYS = {
    "path", "filepath", "filename", "file", "inputpath", "inputfile", "outputpath",
    "outputfile", "outputdir", "inputdir", "directory", "folder", "manifestpath",
    "modelpath", "sessionpath", "artifactpath", "sourceuri", "uri",
}
_RUN_ID_KEYS = {
    "run_id", "run_ids", "active_run_id", "accepted_run_id", "analysis_run_id",
    "detection_run_id", "source_run_id", "source_run_ids",
}
_EVENT_ID_KEYS = {"event_id", "event_ids"}
_CLINICAL_EXTENSIONS = {
    ".edf", ".bdf", ".fif", ".set", ".vhdr", ".eeg", ".nwb", ".mat",
    ".csv", ".tsv", ".xlsx", ".pdf", ".html", ".json", ".png", ".jpg", ".jpeg",
}


def canonical_json_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _normalize_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def _public_json(value: Any, *, key: str = "", depth: int = 0) -> Any:
    if depth > 12:
        raise ValueError("attestation value is too deeply nested")
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(float(value)):
            raise ValueError("attestation value must be finite")
        return value
    if isinstance(value, str):
        if redact_observability_payload(value, key=key) != value:
            raise ValueError("attestation value is sensitive")
        return value
    if isinstance(value, Mapping):
        projected: dict[str, Any] = {}
        for raw_key, nested in value.items():
            item_key = str(raw_key)
            if _normalize_key(item_key) in _PATHISH_KEYS:
                continue
            try:
                projected[item_key] = _public_json(nested, key=item_key, depth=depth + 1)
            except (TypeError, ValueError):
                continue
        return projected
    if isinstance(value, (list, tuple)):
        projected_items = []
        for item in value:
            try:
                projected_items.append(_public_json(item, depth=depth + 1))
            except (TypeError, ValueError):
                continue
        return projected_items
    raise TypeError("unsupported attestation value")


def public_effective_parameters(
    parameters: Mapping[str, Any] | None,
    *,
    allowed_names: Iterable[str] | None = None,
) -> dict[str, Any]:
    allowed = {str(name) for name in allowed_names} if allowed_names is not None else None
    projected: dict[str, Any] = {}
    for raw_key, value in (parameters or {}).items():
        key = str(raw_key)
        if allowed is not None and key not in allowed:
            continue
        if _normalize_key(key) in _PATHISH_KEYS:
            continue
        try:
            projected[key] = _public_json(value, key=key)
        except (TypeError, ValueError):
            continue
    return projected


def _iter_nodes(value: Any, *, depth: int = 0):
    if depth > 12:
        return
    if isinstance(value, Mapping):
        yield value
        for nested in value.values():
            yield from _iter_nodes(nested, depth=depth + 1)
    elif isinstance(value, list):
        for nested in value:
            yield from _iter_nodes(nested, depth=depth + 1)


def identifier_values(value: Any, keys: set[str]) -> set[str]:
    found: set[str] = set()
    for node in _iter_nodes(value):
        for key in keys:
            raw = node.get(key)
            items = raw if isinstance(raw, list) else [raw]
            for item in items:
                normalized = str(item or "").strip()
                if normalized:
                    found.add(normalized)
    return found


def _first_number(value: Any, keys: Sequence[str]) -> float | None:
    for node in _iter_nodes(value):
        for key in keys:
            candidate = node.get(key)
            if isinstance(candidate, (int, float)) and not isinstance(candidate, bool):
                number = float(candidate)
                if math.isfinite(number) and number > 0:
                    return number
    return None


def _channel_names(value: Any) -> list[str]:
    for node in _iter_nodes(value):
        for key in ("channel_names", "recording_channel_names", "prepared_channels", "channels"):
            raw = node.get(key)
            if isinstance(raw, list):
                names = [str(item).strip() for item in raw if str(item or "").strip()]
                if names and len(names) == len(set(names)):
                    return names
    per_channel: list[str] = []
    for node in _iter_nodes(value):
        channel = str(node.get("channel") or node.get("channel_name") or "").strip()
        if channel and channel not in per_channel:
            per_channel.append(channel)
    return per_channel


def _evaluated_interval(value: Any) -> dict[str, float] | None:
    for node in _iter_nodes(value):
        start = node.get("start_seconds", node.get("start"))
        end = node.get("stop_seconds", node.get("end_seconds", node.get("end")))
        if (
            isinstance(start, (int, float)) and not isinstance(start, bool)
            and isinstance(end, (int, float)) and not isinstance(end, bool)
            and math.isfinite(float(start)) and math.isfinite(float(end))
            and float(start) >= 0 and float(end) > float(start)
        ):
            return {"start": float(start), "end": float(end)}
    duration = _first_number(value, ("duration_seconds", "duration"))
    if duration:
        return {"start": 0.0, "end": duration}
    return None


def recording_metadata_fragment(result_payload: Any, *, source_fingerprint: str | None) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    if source_fingerprint:
        metadata.update(
            {
                "recording_id": f"recording-{source_fingerprint[:24]}",
                "sha256": source_fingerprint,
            }
        )
    sample_freq = _first_number(
        result_payload,
        ("sampling_frequency_hz", "sample_frequency_hz", "sample_freq", "sfreq", "sampling_frequency"),
    )
    if sample_freq:
        metadata["sampling_frequency_hz"] = sample_freq
        metadata["nyquist_hz"] = sample_freq / 2.0
    line_freq = _first_number(result_payload, ("line_frequency_hz", "line_freq", "line_noise_notch_hz"))
    if line_freq:
        metadata["line_frequency_hz"] = line_freq
    channels = _channel_names(result_payload)
    if channels:
        metadata["channel_names"] = channels
    interval = _evaluated_interval(result_payload)
    if interval:
        metadata["evaluated_interval_seconds"] = interval
    return metadata


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_kind(tool_name: str, key: str, path: Path) -> str:
    lowered = f"{tool_name} {key} {path.suffix.lower()}".lower()
    if "prepare" in lowered or path.suffix.lower() in {".fif", ".edf", ".bdf"}:
        return "prepared_recording"
    if "detect" in lowered:
        return "detection_run"
    if "classif" in lowered:
        return "classification_run"
    if path.suffix.lower() == ".xlsx":
        return "workbook"
    if path.suffix.lower() in {".html", ".pdf"}:
        return "report"
    if path.suffix.lower() in {".png", ".jpg", ".jpeg"}:
        return "snapshot"
    if "session" in lowered:
        return "session"
    return "other"


def attested_artifacts(result_payload: Any, *, tool_name: str, run_ids: Sequence[str]) -> list[dict[str, Any]]:
    candidates: list[tuple[str, Path]] = []
    for node in _iter_nodes(result_payload):
        for raw_key, raw_value in node.items():
            key = str(raw_key)
            normalized = _normalize_key(key)
            if not any(marker in normalized for marker in ("artifact", "output", "export", "session", "report", "workbook", "manifest", "summary")):
                continue
            values = raw_value.values() if isinstance(raw_value, Mapping) else raw_value if isinstance(raw_value, list) else [raw_value]
            for item in values:
                if not isinstance(item, str) or not item.strip():
                    continue
                try:
                    path = Path(item).expanduser().resolve(strict=True)
                except (OSError, RuntimeError, ValueError):
                    continue
                if path.is_file() and (path.suffix.lower() in _CLINICAL_EXTENSIONS or "artifact" in normalized):
                    candidates.append((key, path))

    artifacts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key, path in candidates:
        try:
            digest = _hash_file(path)
            stat = path.stat()
        except OSError:
            continue
        if digest in seen:
            continue
        seen.add(digest)
        artifact: dict[str, Any] = {
            "artifact_id": f"artifact-{digest[:24]}",
            "kind": _artifact_kind(tool_name, key, path),
            "uri": f"artifact://sha256/{digest}",
            "sha256": digest,
            "created_by": f"pyhfo:{tool_name}",
            "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if len(run_ids) == 1:
            artifact["run_id"] = run_ids[0]
        artifacts.append(artifact)
    return artifacts


def build_execution_attestation(
    *,
    tool_name: str,
    call_parameters: Mapping[str, Any] | None,
    result_payload: Any,
    source_recording_fingerprint: str | None = None,
    input_recording_fingerprint: str | None = None,
    state_revision: str | None = None,
    allowed_parameter_names: Iterable[str] | None = None,
    algorithm_version: str = PYHFO_ADAPTER_VERSION,
) -> dict[str, Any]:
    result_sha256 = canonical_json_sha256(result_payload)
    run_ids = sorted(identifier_values(result_payload, _RUN_ID_KEYS))
    if not run_ids:
        run_ids = [f"run_{result_sha256[:24]}"]
    event_ids = sorted(identifier_values(result_payload, _EVENT_ID_KEYS))
    source_fingerprint = source_recording_fingerprint or input_recording_fingerprint
    effective_parameters = public_effective_parameters(
        call_parameters,
        allowed_names=allowed_parameter_names,
    )
    attestation: dict[str, Any] = {
        "attestation_version": EXECUTION_ATTESTATION_VERSION,
        "tool_name": tool_name,
        "result_sha256": result_sha256,
        "run_ids": run_ids,
        "event_ids": event_ids,
        "evidence_kinds": sorted(TRUSTED_EVIDENCE_KINDS_BY_TOOL.get(tool_name, frozenset())),
        "software_version": RUNTIME_SOFTWARE_VERSION,
        "algorithm": tool_name,
        "algorithm_version": algorithm_version,
        "effective_parameters": effective_parameters,
        "parameters_sha256": canonical_json_sha256(effective_parameters),
        "software_components": json.loads(json.dumps(RUNTIME_SOFTWARE_COMPONENTS)),
        "recording_metadata": recording_metadata_fragment(
            result_payload,
            source_fingerprint=source_fingerprint,
        ),
    }
    if source_fingerprint:
        attestation["recording_fingerprint"] = source_fingerprint
        attestation["source_recording_fingerprint"] = source_fingerprint
    if input_recording_fingerprint:
        attestation["input_recording_fingerprint"] = input_recording_fingerprint
    if source_fingerprint and input_recording_fingerprint and source_fingerprint != input_recording_fingerprint:
        attestation["derived_input_fingerprint"] = input_recording_fingerprint
    if state_revision:
        attestation["state_revision"] = state_revision
    attestation["artifacts"] = attested_artifacts(
        result_payload,
        tool_name=tool_name,
        run_ids=run_ids,
    )
    return attestation
