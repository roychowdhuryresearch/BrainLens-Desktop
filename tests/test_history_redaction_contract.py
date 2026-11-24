import logging

import pytest

from runtime.redaction import ObservabilityRedactionFilter, redact_observability_payload
from runtime.agent_history.observability_service import AgentObservabilityService
from runtime.core.mcp_logger import MCPLogger


def test_structured_secrets_clinical_identifiers_and_paths_are_redacted():
    raw = {
        "authorization": "Bearer secret",
        "patient_id": "MRN-123",
        "recording_path": "/Users/alice/cases/Jane_Doe.edf",
        "nested": {"api_key": "abc", "message": "loaded /private/tmp/case.edf"},
    }

    redacted = redact_observability_payload(raw)

    assert redacted["authorization"] == "[REDACTED-SECRET]"
    assert redacted["patient_id"] == "[REDACTED-CLINICAL]"
    assert redacted["recording_path"].startswith("artifact:")
    assert "Jane_Doe" not in redacted["recording_path"]
    assert redacted["nested"]["api_key"] == "[REDACTED-SECRET]"
    assert "/private/tmp" not in redacted["nested"]["message"]


def test_redaction_preserves_non_sensitive_shape_and_values():
    payload = {"run_id": "run-1", "counts": [1, 2], "status": "complete"}
    assert redact_observability_payload(payload) == payload


def test_redaction_preserves_public_and_opaque_uris_but_redacts_file_uris():
    payload = {
        "source": "https://example.org/reports/research-output.pdf",
        "artifact": "artifact://sha256/" + "a" * 64,
        "local": "file:///private/Patient%20A/session.edf",
    }

    redacted = redact_observability_payload(payload)

    assert redacted["source"] == payload["source"]
    assert redacted["artifact"] == payload["artifact"]
    assert redacted["local"].startswith("artifact:")
    assert "Patient" not in redacted["local"]


@pytest.mark.parametrize(
    ("key", "value", "replacement_prefix"),
    [
        ("patient_identifier", "PAT-123", "[REDACTED-CLINICAL]"),
        ("medical_record_number", "998877", "[REDACTED-CLINICAL]"),
        ("participant_name", "Jane Doe", "[REDACTED-CLINICAL]"),
        ("client_secret", "sk-proj-supersecret", "[REDACTED-SECRET]"),
        ("credential", "sk-proj-supersecret", "[REDACTED-SECRET]"),
        ("file", "cases/Jane_Doe/session.edf", "artifact:"),
    ],
)
def test_common_sensitive_key_aliases_are_redacted(key, value, replacement_prefix):
    redacted = redact_observability_payload({"nested": {key: value}})
    assert redacted["nested"][key].startswith(replacement_prefix)
    assert value not in str(redacted)


@pytest.mark.parametrize(
    ("key", "value", "replacement"),
    [
        ("patient_id_value", "PAT-123", "[REDACTED-CLINICAL]"),
        ("subject_identifier_raw", "SUBJECT-9", "[REDACTED-CLINICAL]"),
        ("accession_number_value", "ACC-12345", "[REDACTED-CLINICAL]"),
        ("access_token_value", "secret-token", "[REDACTED-SECRET]"),
        ("api_key_material", "secret-key", "[REDACTED-SECRET]"),
        ("recording_file_value", "/Users/Jane Doe/private/session", "artifact:"),
    ],
)
def test_sensitive_prefix_and_suffix_key_aliases_fail_closed(key, value, replacement):
    redacted = redact_observability_payload({"outer": {key: value}})
    assert str(redacted["outer"][key]).startswith(replacement)
    assert value not in str(redacted)


def test_aggregate_and_digest_keys_remain_observable_without_exposing_values():
    payload = {
        "llm_token_count": 42,
        "patient_count": 3,
        "access_token_sha256": "a" * 64,
        "password_hash": "b" * 64,
    }
    assert redact_observability_payload(payload) == payload


@pytest.mark.parametrize(
    "value",
    [
        r"\\server\share\Jane_Doe.edf",
        "cases/Jane_Doe/session.edf",
        "sk-proj-supersecret",
    ],
)
def test_sensitive_signatures_are_redacted_even_under_generic_keys(value):
    redacted = redact_observability_payload({"source": value})
    assert redacted["source"] != value
    assert value not in str(redacted)


def test_camel_case_keys_spaced_paths_and_inline_identifiers_are_redacted():
    payload = {
        "apiKey": "top-secret",
        "patientId": "PAT-001",
        "filePath": "/private/cases/John Doe.edf",
        "message": (
            "Bearer bearer-secret; MRN: 12345; "
            "opened '/private/cases/Jane Doe.edf'"
        ),
    }

    redacted = redact_observability_payload(payload)

    assert redacted["apiKey"] == "[REDACTED-SECRET]"
    assert redacted["patientId"] == "[REDACTED-CLINICAL]"
    assert redacted["filePath"].startswith("artifact:")
    rendered = str(redacted)
    for secret in ("top-secret", "PAT-001", "bearer-secret", "12345", "John Doe", "Jane Doe"):
        assert secret not in rendered


@pytest.mark.parametrize(
    "value",
    [
        "Contact jane.doe@example.org for details.",
        "Call +1-415-555-1212 for the case.",
        "Case accession ACC-12345 was reviewed.",
        "Address: 123 Main Street",
        "/Users/Jane Doe/private/session",
        r"C:\Users\Jane Doe\private\session",
        "file:///Users/Jane Doe/private/session",
    ],
)
def test_inline_phi_and_extensionless_spaced_paths_are_redacted_as_whole_spans(value):
    redacted = redact_observability_payload({"message": value})["message"]
    assert redacted != value
    for fragment in ("jane.doe", "415-555", "ACC-12345", "123 Main", "Jane Doe", "private/session", r"private\session"):
        assert fragment not in redacted


def test_last_mile_logging_filter_redacts_preformatted_verification_text():
    record = logging.LogRecord(
        name="test",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="Question for patientId=PAT-9 at '/private/John Doe.edf' token=secret-value",
        args=(),
        exc_info=None,
    )

    assert ObservabilityRedactionFilter().filter(record) is True
    rendered = record.getMessage()
    assert "PAT-9" not in rendered
    assert "John Doe" not in rendered
    assert "secret-value" not in rendered


def test_mcp_logger_redacts_response_list_scalar_and_error_paths():
    messages = []

    class Sink:
        def _capture(self, message, *args):
            messages.append(str(message) % args if args else str(message))

        debug = _capture
        info = _capture
        error = _capture

        def log(self, _level, message, *args):
            self._capture(message, *args)

    logger = object.__new__(MCPLogger)
    logger.logger = Sink()
    logger.log_response({"result": {"patientId": "PAT-1", "filePath": "/private/A B.edf"}})
    logger.log_tool_result("list", [{"apiKey": "secret-1"}, {"path": "/private/C D.edf"}])
    logger.log_tool_result("scalar", "MRN: 9988 in /private/E F.edf")
    logger.log_tool_error("tool", "Bearer secret-2 for patientId=PAT-2")

    rendered = "\n".join(messages)
    for secret in ("PAT-1", "A B", "secret-1", "C D", "9988", "E F", "secret-2", "PAT-2"):
        assert secret not in rendered


def test_observability_service_redacts_before_persistence(monkeypatch):
    captured = {}

    class FakeDB:
        def add(self, span):
            captured["span"] = span

        def commit(self):
            return None

        def refresh(self, span):
            return None

        def close(self):
            return None

    monkeypatch.setattr(
        "runtime.agent_history.observability_service.SessionLocal",
        lambda: FakeDB(),
    )

    AgentObservabilityService().record_span(
        turn_id="turn-1",
        conversation_id="conv-1",
        user_id="u-1",
        span_type="tool",
        phase="loop",
        name="pyhfo_open",
        metadata={
            "args": {
                "patient_id": "MRN-123",
                "recording_path": "/private/cases/patient.edf",
            }
        },
    )

    stored = captured["span"].to_dict()["metadata"]
    assert stored["args"]["patient_id"] == "[REDACTED-CLINICAL]"
    assert stored["args"]["recording_path"].startswith("artifact:")
