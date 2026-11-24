"""Trusted research-evidence extraction shared by the step and turn loops.

The model controls tool arguments and sees tool results, so neither is an
authority boundary by itself.  Only successful results from exact built-in
tool names with an adapter-owned, result-bound attestation can enter the
research evidence ledger or trigger the canonical research-output contract.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

from runtime.agent_runtime.clinical_evidence import recording_fingerprint_for_path
from runtime.agent_runtime.execution_attestation import (
    EXECUTION_ATTESTATION_VERSION,
    TRUSTED_EVIDENCE_KINDS_BY_TOOL,
    UI_BROKER_ADAPTER_VERSION,
    build_execution_attestation,
    canonical_json_sha256,
)


TRUSTED_UI_EVIDENCE_TOOLS = {"get_ui_state", "wait_for_ui_command"}
CANONICAL_UI_EVIDENCE_PROVIDER = "ieeg_ui"
TRUSTED_RESEARCH_EVIDENCE_TOOLS = {
    "get_ui_state",
    "wait_for_ui_command",
    "pyhfo_get_recording_info",
    "pyhfo_infer_brain_signal_roi",
    "pyhfo_compute_channel_qc",
    "pyhfo_compute_spectral_profile",
    "pyhfo_detect_line_noise",
    "pyhfo_rank_candidate_channels",
    "pyhfo_detect_events",
    "pyhfo_prepare_recording",
    "pyhfo_run_severity_scoring",
    "pyhfo_batch_run",
}


def trusted_research_evidence_entries(
    *,
    state: Any,
    events: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Return ledger entries proven by exact tools and adapter attestations.

    UI reads are attested by the broker boundary here.  PyHFO tools must return
    their adapter attestation themselves.  In both cases the attested digest
    and evidence kinds are verified before the result can affect output shape.
    """

    entries: list[dict[str, Any]] = []
    pending_args: dict[tuple[str, str], list[Mapping[str, Any]]] = {}
    for event in events:
        if not isinstance(event, Mapping):
            continue
        data = event.get("data")
        if not isinstance(data, Mapping):
            continue
        name = str(data.get("name") or "").strip()
        if name not in TRUSTED_RESEARCH_EVIDENCE_TOOLS:
            continue
        provider_name = str(data.get("provider_name") or "").strip()
        if name in TRUSTED_UI_EVIDENCE_TOOLS and provider_name != CANONICAL_UI_EVIDENCE_PROVIDER:
            continue
        pending_key = (
            name,
            provider_name if name in TRUSTED_UI_EVIDENCE_TOOLS else "",
        )
        if event.get("event") == "tool_call":
            args = data.get("args")
            pending_args.setdefault(pending_key, []).append(
                dict(args) if isinstance(args, Mapping) else {}
            )
            continue
        if event.get("event") != "tool_result" or data.get("success") is not True:
            continue

        queued = pending_args.get(pending_key) or []
        args = dict(queued.pop(0)) if queued else {}
        result = data.get("result")
        provenance = (
            result.get("execution_provenance")
            if isinstance(result, Mapping)
            and isinstance(result.get("execution_provenance"), Mapping)
            else None
        )
        observed_result = result
        if isinstance(provenance, Mapping) and isinstance(result, Mapping) and "result" in result:
            observed_result = result.get("result")
            provenance = dict(provenance)
            if getattr(state, "state_revision", None):
                provenance["state_revision"] = state.state_revision
        elif provenance is None and name in TRUSTED_UI_EVIDENCE_TOOLS:
            source_fingerprint = recording_fingerprint_for_path(
                getattr(state, "recording_path", None)
            )
            provenance = build_execution_attestation(
                tool_name=name,
                call_parameters=args,
                result_payload=result,
                source_recording_fingerprint=source_fingerprint,
                input_recording_fingerprint=source_fingerprint,
                state_revision=getattr(state, "state_revision", None),
                algorithm_version=UI_BROKER_ADAPTER_VERSION,
            )

        if (
            not isinstance(provenance, Mapping)
            or provenance.get("attestation_version") != EXECUTION_ATTESTATION_VERSION
            or provenance.get("tool_name") != name
        ):
            continue
        try:
            observed_digest = canonical_json_sha256(observed_result)
        except (TypeError, ValueError):
            continue
        if str(provenance.get("result_sha256") or "").lower() != observed_digest:
            continue
        allowed_kinds = set(TRUSTED_EVIDENCE_KINDS_BY_TOOL.get(name, ()))
        attested_kinds = {
            str(value).strip()
            for value in (provenance.get("evidence_kinds") or [])
            if str(value).strip()
        }
        if not attested_kinds or not attested_kinds <= allowed_kinds:
            continue

        entries.append(
            {
                "tool_name": name,
                **(
                    {"provider_name": provider_name}
                    if name in TRUSTED_UI_EVIDENCE_TOOLS
                    else {}
                ),
                "arguments": args,
                "result": result,
                "result_summary": data.get("result_summary"),
                "execution_provenance": dict(provenance),
            }
        )
    return entries
