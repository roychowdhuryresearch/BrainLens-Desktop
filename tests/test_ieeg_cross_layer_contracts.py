from __future__ import annotations

import copy
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

import pytest

from ui_mcp.broker import UiBus

try:
    from jsonschema import Draft202012Validator, FormatChecker
    from jsonschema.exceptions import ValidationError
    from referencing import Registry, Resource
except ImportError:  # pragma: no cover - structural checks remain useful in minimal release envs.
    Draft202012Validator = None
    FormatChecker = None
    ValidationError = Exception
    Registry = None
    Resource = None


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_DIR = ROOT / "contracts" / "agent"
SCHEMA_DIR = CONTRACT_DIR / "schemas"
CATALOG_PATH = ROOT / "contracts" / "ui-command-catalog.json"
OWNERSHIP_PATH = CONTRACT_DIR / "ownership-map.json"
FEATURE_PATH = CONTRACT_DIR / "feature-map.json"

PROTOCOL_SCHEMAS = {
    "XLP-IEEG-WIRE-V1": "ieeg-wire-v1.schema.json",
    "XLP-STREAM-EVENT-V1": "stream-event-v1.schema.json",
    "XLP-RESEARCH-OUTPUT-V1": "research-output-v1.schema.json",
    "XLP-ACTION-RECEIPT-V1": "action-receipt-v1.schema.json",
}

EXPECTED_FEATURES = [
    "XLF-LOAD",
    "XLF-QC",
    "XLF-CONFIGURE",
    "XLF-DETECT",
    "XLF-SEVERITY",
    "XLF-CLASSIFY",
    "XLF-RANK",
    "XLF-REVIEW",
    "XLF-ANNOTATE",
    "XLF-EXPORT",
]

EXPECTED_RECEIPT_STATUSES = {
    "queued",
    "applied",
    "running",
    "complete",
    "failed",
    "rejected",
    "noop",
}


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _schemas() -> dict[str, dict[str, Any]]:
    return {path.name: _load(path) for path in sorted(SCHEMA_DIR.glob("*.schema.json"))}


def _walk_refs(value: Any) -> Iterable[str]:
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "$ref" and isinstance(item, str):
                yield item
            else:
                yield from _walk_refs(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk_refs(item)


def _registry(schemas: dict[str, dict[str, Any]]):
    if Registry is None or Resource is None:
        return None
    registry = Registry()
    for schema in schemas.values():
        registry = registry.with_resource(schema["$id"], Resource.from_contents(schema))
    return registry


def _validator(schema: dict[str, Any], schemas: dict[str, dict[str, Any]]):
    if Draft202012Validator is None:
        pytest.skip("jsonschema is not installed; structural contract checks still ran")
    return Draft202012Validator(
        schema,
        registry=_registry(schemas),
        format_checker=FormatChecker(),
    )


def _definition_validator(
    schema: dict[str, Any], definition: str, schemas: dict[str, dict[str, Any]]
):
    return _validator({"$ref": f"{schema['$id']}#/$defs/{definition}"}, schemas)


def test_contract_json_and_draft_2020_12_schemas_are_valid():
    json_paths = sorted(CONTRACT_DIR.rglob("*.json"))
    assert json_paths
    for path in json_paths:
        assert isinstance(_load(path), dict), path

    schemas = _schemas()
    assert set(schemas) == set(PROTOCOL_SCHEMAS.values())
    ids = []
    for name, schema in schemas.items():
        assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema", name
        assert schema["$id"].endswith(f"/{name}"), name
        assert schema["x-ieeg-unknown-field-policy"] == "reject", name
        ids.append(schema["$id"])
        if Draft202012Validator is not None:
            Draft202012Validator.check_schema(schema)
    assert len(ids) == len(set(ids))


def test_every_local_schema_ref_resolves_to_a_real_definition():
    schemas = _schemas()
    for source_name, schema in schemas.items():
        for ref in _walk_refs(schema):
            if ref.startswith("#"):
                target_name, fragment = source_name, ref
            else:
                target, separator, fragment_tail = ref.partition("#")
                assert target in schemas, f"{source_name}: missing local schema {target!r}"
                target_name = target
                fragment = f"#{fragment_tail}" if separator else ""
            if fragment:
                match = re.fullmatch(r"#/\$defs/([^/]+)", fragment)
                assert match, f"{source_name}: unsupported local fragment {ref!r}"
                assert match.group(1) in schemas[target_name]["$defs"], ref


def test_schema_examples_validate_against_their_declared_definition():
    schemas = _schemas()
    for name, schema in schemas.items():
        examples = schema.get("x-ieeg-examples")
        assert isinstance(examples, list) and examples, f"{name} needs executable examples"
        validator = _validator(schema, schemas)
        for example in examples:
            value = example["value"]
            definition = example.get("definition")
            if definition:
                assert definition in schema["$defs"], (name, definition)
                _definition_validator(schema, definition, schemas).validate(value)
            else:
                validator.validate(value)


def test_readme_catalogs_protocols_and_all_local_markdown_links_resolve():
    readme = (CONTRACT_DIR / "README.md").read_text(encoding="utf-8")
    for contract_id, schema_name in PROTOCOL_SCHEMAS.items():
        assert contract_id in readme
        assert schema_name in readme

    for document in CONTRACT_DIR.glob("*.md"):
        text = document.read_text(encoding="utf-8")
        for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", text):
            if target.startswith(("http://", "https://", "#")):
                continue
            relative = target.split("#", 1)[0]
            assert (document.parent / relative).exists(), f"{document}: broken link {target}"


def test_ownership_map_has_real_producers_validators_consumers_and_proofs():
    ownership = _load(OWNERSHIP_PATH)
    assert set(ownership["protocols"]) == set(PROTOCOL_SCHEMAS)
    declared_layers = set(ownership["layers"])
    seen_layers: set[str] = set()

    for contract_id, protocol in ownership["protocols"].items():
        assert (ROOT / protocol["document"]).is_file(), contract_id
        assert (ROOT / protocol["schema"]).is_file(), contract_id
        assert protocol["schema"].endswith(PROTOCOL_SCHEMAS[contract_id])
        for role in ("producers", "validators", "consumers"):
            entries = protocol[role]
            assert entries, f"{contract_id} has no {role}"
            for entry in entries:
                assert entry["layer"] in declared_layers, entry
                assert (ROOT / entry["path"]).is_file(), entry
                assert entry["responsibility"].strip(), entry
                seen_layers.add(entry["layer"])
        assert protocol["proofs"]
        for proof in protocol["proofs"]:
            assert (ROOT / proof).is_file(), (contract_id, proof)

    assert seen_layers == {"runtime", "ui_mcp", "desktop", "pyhfo"}


def test_feature_map_covers_each_catalog_command_exactly_once():
    catalog_types = [item["type"] for item in _load(CATALOG_PATH)["commands"]]
    feature_map = _load(FEATURE_PATH)
    features = feature_map["features"]
    assert feature_map["feature_order"] == EXPECTED_FEATURES
    assert [feature["id"] for feature in features] == EXPECTED_FEATURES

    counts = Counter(command for feature in features for command in feature["commands"])
    assert set(counts) == set(catalog_types)
    assert all(count == 1 for count in counts.values()), {
        command: count for command, count in counts.items() if count != 1
    }


def test_feature_protocol_refs_owners_and_proofs_resolve():
    schemas = _schemas()
    ownership = _load(OWNERSHIP_PATH)
    feature_map = _load(FEATURE_PATH)
    event_names = set(schemas["stream-event-v1.schema.json"]["$defs"]["EventName"]["enum"])

    for feature in feature_map["features"]:
        assert feature["outcome"].strip()
        assert feature["evidence_requirements"]
        assert feature["clinical_invariants"]
        for owner in feature["owners"]:
            assert owner["layer"] in ownership["layers"], (feature["id"], owner)
            assert (ROOT / owner["path"]).is_file(), (feature["id"], owner)
        for proof in feature["proofs"]:
            assert (ROOT / proof).is_file(), (feature["id"], proof)
        for protocol_ref in feature["protocol_refs"]:
            contract_id = protocol_ref["contract_id"]
            assert contract_id in PROTOCOL_SCHEMAS, (feature["id"], contract_id)
            schema = schemas[PROTOCOL_SCHEMAS[contract_id]]
            assert set(protocol_ref.get("defs", [])) <= set(schema["$defs"]), protocol_ref
            if protocol_ref.get("events"):
                assert contract_id == "XLP-STREAM-EVENT-V1"
                assert set(protocol_ref["events"]) <= event_names


def test_every_schema_definition_and_stream_event_has_reverse_feature_ownership():
    schemas = _schemas()
    feature_map = _load(FEATURE_PATH)
    shared = feature_map["shared_protocol_elements"]

    for contract_id, schema_name in PROTOCOL_SCHEMAS.items():
        covered_defs = set(shared.get(contract_id, {}).get("defs", []))
        for feature in feature_map["features"]:
            for protocol_ref in feature["protocol_refs"]:
                if protocol_ref["contract_id"] == contract_id:
                    covered_defs.update(protocol_ref.get("defs", []))
        assert covered_defs == set(schemas[schema_name]["$defs"]), {
            "contract": contract_id,
            "missing": sorted(set(schemas[schema_name]["$defs"]) - covered_defs),
            "unknown": sorted(covered_defs - set(schemas[schema_name]["$defs"])),
        }

    covered_events = set(shared["XLP-STREAM-EVENT-V1"]["events"])
    for feature in feature_map["features"]:
        for protocol_ref in feature["protocol_refs"]:
            if protocol_ref["contract_id"] == "XLP-STREAM-EVENT-V1":
                covered_events.update(protocol_ref.get("events", []))
    event_names = set(schemas["stream-event-v1.schema.json"]["$defs"]["EventName"]["enum"])
    assert covered_events == event_names


def test_ui_command_enums_and_risks_match_authoritative_catalog():
    schemas = _schemas()
    catalog = _load(CATALOG_PATH)
    catalog_types = [item["type"] for item in catalog["commands"]]
    catalog_risks = {item["risk"] for item in catalog["commands"]}

    wire_enum = schemas["ieeg-wire-v1.schema.json"]["$defs"]["UICommandType"]["enum"]
    assert wire_enum == catalog_types

    receipt = schemas["action-receipt-v1.schema.json"]
    assert receipt["$defs"]["CommandType"]["$ref"] == "ieeg-wire-v1.schema.json#/$defs/UICommandType"
    assert set(receipt["$defs"]["ActionReceipt"]["properties"]["effect"]["enum"]) == catalog_risks


def test_stream_terminal_model_and_visibility_are_fail_closed():
    schemas = _schemas()
    stream = schemas["stream-event-v1.schema.json"]
    terminal = stream["x-ieeg-terminal-model"]
    assert terminal == {
        "terminal_events": ["done"],
        "exactly_one_terminal_event": True,
        "events_after_terminal": "forbidden",
        "eof_without_terminal": "failure",
        "error_is_terminal": False,
        "success_requires_done_outcome": "completed",
    }
    assert set(stream["x-ieeg-public-events"]).isdisjoint(stream["x-ieeg-internal-events"])
    assert set(stream["x-ieeg-public-events"]) | set(stream["x-ieeg-internal-events"]) == set(
        stream["$defs"]["EventName"]["enum"]
    )

    validator = _validator(stream, schemas)
    content = copy.deepcopy(stream["x-ieeg-examples"][0]["value"])
    content["event"] = "unknown_event"
    with pytest.raises(ValidationError):
        validator.validate(content)

    content["event"] = "thinking"
    content["visibility"] = "public"
    content["data"] = {"kind": "reasoning", "summary": "private"}
    with pytest.raises(ValidationError):
        validator.validate(content)

    done = copy.deepcopy(stream["x-ieeg-examples"][1]["value"])
    del done["data"]["final_content"]
    with pytest.raises(ValidationError):
        validator.validate(done)


def test_receipt_statuses_match_ui_lifecycle_and_noop_cannot_be_success():
    schemas = _schemas()
    receipt = schemas["action-receipt-v1.schema.json"]
    assert set(receipt["$defs"]["ReceiptStatus"]["enum"]) == EXPECTED_RECEIPT_STATUSES
    assert set(receipt["x-ieeg-terminal-statuses"]) == {
        "complete",
        "failed",
        "rejected",
        "noop",
    }
    assert receipt["x-ieeg-conditionally-terminal-statuses"] == ["applied"]

    validator = _definition_validator(receipt, "ActionReceipt", schemas)
    queued = copy.deepcopy(receipt["x-ieeg-examples"][0]["value"])
    validator.validate(queued)
    complete = copy.deepcopy(receipt["x-ieeg-examples"][1]["value"])
    validator.validate(complete)
    invalid_noop = copy.deepcopy(complete)
    invalid_noop.update(status="noop", reason="nothing changed")
    with pytest.raises(ValidationError):
        validator.validate(invalid_noop)

    async_applied = copy.deepcopy(complete)
    async_applied.update(status="applied", terminal=False)
    async_applied.pop("success")
    async_applied.pop("result")
    async_applied.pop("postcondition")
    validator.validate(async_applied)

    invalid_async_applied = copy.deepcopy(async_applied)
    invalid_async_applied["terminal"] = True
    with pytest.raises(ValidationError):
        validator.validate(invalid_async_applied)

    view_applied = copy.deepcopy(complete)
    view_applied.update(command_type="workspace.open_panel", effect="view", status="applied")
    view_applied["approval_role"] = "none"
    view_applied["requires_confirmation"] = False
    validator.validate(view_applied)


def test_broker_generated_queued_and_terminal_receipts_validate_against_xlp_schema():
    schemas = _schemas()
    validator = _definition_validator(schemas["action-receipt-v1.schema.json"], "ActionReceipt", schemas)
    bus = UiBus()

    command, error = bus.emit("workspace.open_panel", {"panel": "Review"}, "open review")
    assert error is None and command is not None
    validator.validate(bus.get_ack(command["command_id"]))

    terminal, error = bus.record_ack(command["command_id"], {
        "status": "applied",
        "command_type": "workspace.open_panel",
        "conversation_id": "desktop-copilot-contract",
        "state_revision": "desktop-state-contract",
        "diff_state": "review-panel-open",
    })
    assert error is None and terminal is not None
    validator.validate(terminal)


def test_severity_terminal_receipt_requires_exact_model_and_result_provenance():
    bus = UiBus()
    bus.set_state({
        "session_id": "workspace-severity",
        "state_revision": "desktop-state-severity",
        "resource_scope": {
            "state_revision": "desktop-state-severity",
            "recording_sha256": "a" * 64,
        },
    })
    command, error = bus.emit(
        "severity.run",
        {},
        "score severity",
        authority_scope={
            "request_id": "request-severity",
            "message_id": "message-severity",
            "conversation_id": "desktop-copilot-severity",
            "session_id": "workspace-severity",
            "state_revision": "desktop-state-severity",
            "recording_fingerprint": "a" * 64,
            "resource_scope": {
                "recording_sha256": "a" * 64,
                "state_revision": "desktop-state-severity",
            },
        },
    )
    assert error is None and command is not None
    common = {
        "status": "complete",
        "command_type": "severity.run",
        "conversation_id": "desktop-copilot-severity",
        "state_revision": "desktop-state-severity",
        "recording_fingerprint": "a" * 64,
        "approval_actor": {
            "role": "clinician",
            "actor_id": "desktop-clinician",
            "session_id": "workspace-severity",
            "source": "desktop_human_apply:test-nonce",
        },
    }
    rejected, error = bus.record_ack(command["command_id"], {
        **common,
        "terminal_proof": {"source": "backend_readback", "backend_status": "complete"},
    })
    assert rejected is None
    assert error == "terminal severity success requires backend result and model provenance"

    valid_proof = {
        "source": "backend_readback",
        "backend_status": "complete",
        "recording_fingerprint": "a" * 64,
        "model_name": "BASED",
        "model_version": "based-severity-deadbeefcafe",
        "model_sha256": "b" * 64,
        "parameters_sha256": "c" * 64,
        "result_sha256": "d" * 64,
        "severity_summary": {
            "eeg_type": "scalp",
            "num_segments": 8,
            "num_clean_segments": 7,
            "mean_score": 1.2,
            "peak_score": 3.4,
            "peak_time_sec": 45.0,
            "clean_mean_score": 1.0,
            "clean_peak_score": 3.0,
            "clean_peak_time_sec": 45.0,
            "artifact_quality": {
                "status": "assessed",
                "method": "tueg19_peak_amplitude",
                "threshold_uv": 500.0,
                "assessed_segments": 8,
                "total_segments": 8,
                "channel_count": 19,
            },
        },
    }
    unknown_artifact_quality = {
        **valid_proof,
        "severity_summary": {
            **valid_proof["severity_summary"],
            "num_clean_segments": 0,
            "clean_mean_score": None,
            "clean_peak_score": None,
            "clean_peak_time_sec": None,
        },
    }
    unknown_artifact_quality["severity_summary"].pop("artifact_quality")
    assert UiBus._severity_terminal_proof_error(
        "a" * 64,
        {
            "recording_fingerprint": "a" * 64,
            "terminal_proof": unknown_artifact_quality,
        },
    ) is None
    for invalid_summary in (
        {**valid_proof["severity_summary"], "eeg_type": "ieeg"},
        {**valid_proof["severity_summary"], "num_segments": -1},
        {**valid_proof["severity_summary"], "num_segments": 0, "num_clean_segments": 0},
        {**valid_proof["severity_summary"], "num_clean_segments": "7"},
        {**valid_proof["severity_summary"], "mean_score": "bogus"},
        {**valid_proof["severity_summary"], "peak_score": 5.1},
        {
            **valid_proof["severity_summary"],
            "num_clean_segments": 7,
            "artifact_quality": {
                **valid_proof["severity_summary"]["artifact_quality"],
                "status": "partial",
                "assessed_segments": 7,
            },
        },
    ):
        rejected, error = bus.record_ack(command["command_id"], {
            **common,
            "terminal_proof": {**valid_proof, "severity_summary": invalid_summary},
        })
        assert rejected is None
        assert error == "terminal severity success requires backend result and model provenance"

    terminal, error = bus.record_ack(command["command_id"], {
        **common,
        "terminal_proof": valid_proof,
    })
    assert error is None and terminal is not None
    assert terminal["status"] == "complete"
    assert terminal["postcondition"]["name"] == "severity_result_and_model_provenance_are_recorded"


def test_research_output_has_machine_checkable_claim_and_provenance_contracts():
    schemas = _schemas()
    research = schemas["research-output-v1.schema.json"]
    output = research["$defs"]["ResearchOutput"]
    assert {
        "schema_version",
        "recording_fingerprint",
        "run_ids",
        "provenance",
        "claims",
    } <= set(output["required"])

    provenance_required = set(research["$defs"]["ClinicalProvenance"]["required"])
    assert {
        "software_version",
        "algorithm",
        "algorithm_version",
        "parameters",
        "parameters_sha256",
    } <= provenance_required

    claim = research["$defs"]["ResearchClaim"]
    assert set(claim["properties"]["kind"]["enum"]) == {
        "candidate",
        "qc",
        "anatomy",
        "soz",
        "ranking",
        "comparison",
        "numeric",
        "summary",
    }
    assert set(claim["properties"]["epistemic_status"]["enum"]) == {
        "observed",
        "derived",
        "reviewed",
        "confirmed",
        "hypothesis",
    }
    reviewed_requirement = claim["allOf"][0]["then"]["required"]
    assert {
        "review_receipt_id",
        "review_actor",
        "review_command_payload",
    } <= set(reviewed_requirement)

    validator = _definition_validator(research, "ResearchOutput", schemas)
    example = copy.deepcopy(research["x-ieeg-examples"][0]["value"])
    assert example["recording_fingerprint"] == example["provenance"]["recording"]["sha256"]
    assert example["run_ids"] == example["provenance"]["run_scope"]["run_ids"]
    validator.validate(example)

    reviewed_without_actor = copy.deepcopy(example)
    reviewed_without_actor["claims"][0]["epistemic_status"] = "reviewed"
    with pytest.raises(ValidationError):
        validator.validate(reviewed_without_actor)

    numeric_without_units = copy.deepcopy(example)
    numeric_without_units["claims"][0]["kind"] = "numeric"
    with pytest.raises(ValidationError):
        validator.validate(numeric_without_units)

    guardrails = research["$defs"]["ClinicalGuardrails"]["properties"]
    assert guardrails["candidate_terminology"]["const"] == "detector_candidates_are_not_confirmed_hfo"
    assert guardrails["soz_inference"]["const"] == "not_performed"
