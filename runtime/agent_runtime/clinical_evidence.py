from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import urlsplit

from runtime.agent_runtime.action_receipts import canonical_action_receipt
from runtime.agent_runtime.execution_attestation import (
    EXECUTION_ATTESTATION_VERSION,
    TRUSTED_EVIDENCE_KINDS_BY_TOOL,
    canonical_json_sha256,
)
from runtime.redaction import redact_observability_payload, redact_observability_text


_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_SHA256_RE = re.compile(r"^[A-Fa-f0-9]{64}$")
_CLINICAL_REVIEW_COMMANDS = {"events.stage_annotation", "review.accept_run"}
_REVIEW_ROLES = {"researcher", "clinician", "reviewer"}
_CLAIM_KINDS = {
    "candidate", "qc", "anatomy", "soz", "ranking", "comparison", "numeric", "summary",
}
_EPISTEMIC_STATUSES = {"observed", "derived", "reviewed", "confirmed", "hypothesis"}
_EVIDENCE_KINDS = {
    "recording_metadata",
    "quality_control",
    "spectral_measurement",
    "severity_score",
    "detector_candidate",
    "classifier_prediction",
    "channel_ranking",
    "human_review",
    "annotation",
    "artifact",
    "external_source",
}
_RUN_BOUND_EVIDENCE_KINDS = {
    "quality_control", "spectral_measurement", "detector_candidate",
    "classifier_prediction", "channel_ranking", "artifact",
}
_CLAIM_EVIDENCE_KINDS = {
    "candidate": {"detector_candidate", "classifier_prediction", "human_review", "annotation"},
    "qc": {"quality_control"},
    "anatomy": {"human_review", "annotation", "external_source"},
    "soz": {"human_review", "annotation"},
    "ranking": {"channel_ranking"},
    "comparison": {
        "quality_control", "spectral_measurement", "severity_score", "detector_candidate",
        "classifier_prediction", "channel_ranking", "artifact",
    },
    "numeric": set(_EVIDENCE_KINDS),
}
_ANATOMY_SOURCE_MARKERS = {
    "anatomy_mapping", "electrode_localization", "atlas_registration", "clinical_annotation", "clinician_review",
}
_SOZ_SOURCE_MARKERS = {
    "clinical_annotation", "clinician_review", "soz", "seizure_onset_zone",
    "seizure_onset_site", "ictal_onset_site",
}
_NUMBER_WORD_ATOM = (
    r"zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|"
    r"fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|"
    r"fifty|sixty|seventy|eighty|ninety|hundred|thousand"
)
_NUMBER_WORD_PATTERN = rf"(?:{_NUMBER_WORD_ATOM})(?:[- ](?:and[- ]+)?(?:{_NUMBER_WORD_ATOM}))*"
_NUMBER_TOKEN_PATTERN = rf"(?:\d+(?:\.\d+)?|{_NUMBER_WORD_PATTERN})"
_DIAGNOSTIC_LANGUAGE_RE = re.compile(
    r"\b(diagnos(?:is|ed|tic)?|epilep(?:sy|tic|togenic)|seizure[- ](?:onset|focus)|"
    r"ictal[- ]onset|onset[- ](?:site|zone)|patholog(?:y|ical)|soz)\b"
    r"|\bseizures?\s+(?:begin|start|originate)s?\b|癫痫|致痫|发作起始|病理",
    re.IGNORECASE,
)
_SOZ_LANGUAGE_RE = re.compile(
    r"\b(?:soz|seizure[- ](?:onset\s+(?:zone|site)|focus)|ictal[- ]onset(?:\s+(?:site|zone))?|"
    r"onset[- ](?:site|zone))\b"
    r"|\b(?:lead|contact|electrode|channel)\b.{0,40}\b(?:starts?|begins?|originates?)\s+(?:the\s+)?seizures?\b"
    r"|\bseizures?\s+(?:begin|start|originate)s?\s+(?:at|in|from|on)\b"
    r"|\bwhere\s+seizures?\s+(?:begin|start|originate)\b|发作起始(?:区|灶)?|致痫灶",
    re.IGNORECASE,
)
_CASE_DIAGNOSTIC_QUESTION_RE = re.compile(
    r"\b(?:which|what|where|identify|locali[sz]e)\b.{0,80}"
    r"\b(?:lead|contact|electrode|channel|soz|seizure[- ](?:onset|focus)|ictal[- ]onset|epileptogenic)\b"
    r"|\b(?:lead|contact|electrode|channel|soz|seizure[- ](?:onset|focus)|ictal[- ]onset|epileptogenic)\b.{0,80}"
    r"\b(?:which|what|where|likely|most)\b"
    r"|\bwhich\s+(?:lead|contact|electrode|channel)\b.{0,40}\b(?:starts?|begins?|originates?)\s+(?:the\s+)?seizures?\b"
    r"|\bwhat\s+is\s+the\s+ictal[- ]onset\s+(?:site|zone|contact|channel|electrode|lead)\b"
    r"|(?:哪个|什么|哪里|定位|判断).{0,40}(?:触点|电极|通道|发作起始|致痫|SOZ)",
    re.IGNORECASE,
)
_CASE_QUANTITATIVE_QUESTION_RE = re.compile(
    r"\bhow\s+many\b.{0,60}\b(?:hfo|candidate|event|oscillation)s?\b"
    r"|\b(?:count|number)\s+of\b.{0,40}\b(?:hfo|candidate|event|oscillation)s?\b"
    r"|(?:多少|几个|数量).{0,30}(?:HFO|候选|事件|振荡)",
    re.IGNORECASE,
)
_UNTYPED_NUMERIC_RESULT_RE = re.compile(
    rf"\b(?:detected?|found|identified|count(?:ed)?|yield(?:ed|s)?|contains?|reports?)\s+"
    rf"({_NUMBER_TOKEN_PATTERN})\s+(?:hfo|candidate|event|oscillation)s?\b"
    rf"|\bthere\s+(?:are|were)\s+({_NUMBER_TOKEN_PATTERN})\s+(?:hfo|candidate|event|oscillation)s?\b"
    rf"|\b({_NUMBER_TOKEN_PATTERN})\s+(?:hfo|candidate|event|oscillation)s?\s+"
    r"(?:were\s+)?(?:detected|found|identified|present)\b"
    r"|(?:检测到|发现|识别出)\s*(\d+(?:\.\d+)?)\s*(?:个)?(?:HFO|候选|事件|振荡)",
    re.IGNORECASE,
)
_CASE_SPECIFIC_RESULT_RE = re.compile(
    r"\b(?:this|the|current|loaded)\s+(?:recording|case|patient|run|interval|event)\b"
    r"|\b(?:channel|electrode|contact)\s+[A-Za-z]{1,8}\d{1,4}(?:-\d{1,4})?\b"
    r"|\b[A-Za-z]{1,8}\d{1,4}(?:-\d{1,4})?\s+(?:appears?|is|was|shows?|demonstrates?)\b"
    r"|\b(?:the\s+)?[A-Za-z][A-Za-z -]{0,48}(?:contact|electrode|channel)\s+"
    r"(?:appears?|is|was|shows?|demonstrates?)\b"
    r"|\b(?:qc|quality\s+control)\s+(?:shows?|showed|finds?|found|indicates?|proved?|passes?|fails?)\b"
    rf"|\b{_NUMBER_TOKEN_PATTERN}\s+(?:hfo|candidate|event|oscillation)s?\b"
    r"|\b(?:lead|contact|electrode|channel)\b.{0,40}\b(?:starts?|begins?|originates?)\s+(?:the\s+)?seizures?\b"
    r"|\b(?:ictal[- ]onset|where\s+seizures?\s+(?:begin|start|originate))\b"
    r"|\b(?:event|run)[-_: ]+[A-Za-z0-9][A-Za-z0-9_.:-]*\b"
    r"|(?:本次|当前|该)(?:记录|病例|患者|运行|区间|事件)"
    r"|(?:通道|电极|触点)\s*[A-Za-z]{1,8}\d{1,4}"
    r"|(?:检测到|发现了?)\s*\d+\s*(?:个)?(?:HFO|候选|事件)",
    re.IGNORECASE,
)
_CASE_REQUEST_RE = re.compile(
    r"\b(?:review|analy[sz]e|inspect|detect|classif|rank|compare|qc)\b.{0,35}"
    r"\b(?:this|that|the|current|loaded|attached|my|our)\s+(?:recording|case|patient|ieeg|eeg|edf|event|run)\b"
    r"|^\s*(?:review|analy[sz]e|inspect|detect|classif|rank|compare|qc)\s+"
    r"(?:recording|case|patient|ieeg|eeg|edf|event|run)\b"
    r"|(?:审阅|分析|检查|检测|分类|排序|比较|质控).{0,20}(?:这|该|本次|当前|已加载|我的|我们)(?:段|个|份)?(?:记录|病例|脑电|事件|运行)",
    re.IGNORECASE,
)
_CASE_ACTION_INTENT_RE = re.compile(
    r"^\s*(?:please\s+)?(?:review|analy[sz]e|inspect|detect|classif|rank|compare|run\s+qc|run\s+detection)\b"
    r"|\b(?:can|could|would)\s+you\s+(?:review|analy[sz]e|inspect|detect|classif|rank|compare)\b"
    r"|^\s*(?:请)?(?:审阅|分析|检查|检测|分类|排序|比较|质控)\b",
    re.IGNORECASE,
)
_NON_COMPLETION_RE = re.compile(
    r"\b(?:cannot|can't|unable|not able|need|needs|requires?|missing|unavailable|not loaded|not provided)\b"
    r".{0,60}\b(?:recording|file|data|event|run|context|upload|input)\b"
    r"|\b(?:please|must)\s+(?:upload|provide|load|select)\b"
    r"|\b(?:inconclusive|insufficient\s+evidence|cannot\s+determine|can't\s+determine|"
    r"unable\s+to\s+determine|cannot\s+locali[sz]e|no\s+evidence\s+(?:supports?|establishes?)|"
    r"evidence\s+(?:is|was)\s+insufficient|evidence\s+does\s+not\s+support)\b"
    r"|(?:无法|不能|尚未|没有|缺少|需要|请).{0,30}(?:上传|提供|加载|选择|记录|文件|数据|事件|运行|判断|定位|证据)"
    r"|(?:证据不足|无法判断|无法定位|没有证据支持)",
    re.IGNORECASE,
)
_CASE_CONTEXT_RE = re.compile(
    r"\b(?:review|analy[sz]e|inspect|detect|classif|rank|compare|qc|quality\s+control)\b.{0,50}"
    r"\b(?:recording|ieeg|eeg|edf|channel|electrode|event|run|hfo)\b"
    r"|\b(?:recording|ieeg|eeg|edf|channel|electrode|event|run|hfo)\b.{0,50}"
    r"\b(?:review|analy[sz]e|inspect|detect|classif|rank|compare|qc|quality\s+control)\b"
    r"|(?:审阅|分析|检查|检测|分类|排序|比较|质控).{0,30}(?:记录|脑电|通道|电极|事件|运行|HFO)"
    r"|(?:记录|脑电|通道|电极|事件|运行|HFO).{0,30}(?:审阅|分析|检查|检测|分类|排序|比较|质控)",
    re.IGNORECASE,
)
_ASSERTIVE_CLINICAL_RE = re.compile(
    r"\b(?:proves?|establishes?|confirms?|shows?|indicates?|demonstrates?|is|are|was|were)\b"
    r".{0,80}\b(?:epilepsy|seizure[- ]onset|soz|pathological|diagnosis)\b"
    r"|\b(?:epilepsy|seizure[- ]onset|soz|pathological|diagnosis)\b.{0,80}"
    r"\b(?:proved?|established|confirmed|shown|indicated|demonstrated|is|are|was|were)\b"
    r"|(?:证明|表明|显示|确认|就是|属于).{0,50}(?:癫痫|发作起始|病理|SOZ)"
    r"|(?:癫痫|发作起始|病理|SOZ).{0,50}(?:证明|表明|显示|确认|就是|属于)",
    re.IGNORECASE,
)
_AFFIRMATIVE_DIAGNOSTIC_RE = re.compile(
    r"\b(?:is|are|was|were|appears?|seems?|shows?|indicates?|confirms?|establishes?|proves?)\b"
    r".{0,50}\b(?:epileptogenic|epilepsy|pathological|soz|seizure[- ]onset|ictal[- ]onset)\b"
    r"|\b(?:epileptogenic|pathological|soz|seizure[- ]onset|ictal[- ]onset)\b.{0,50}"
    r"\b(?:site|zone|focus|contact|channel|lead|is|are|was|were)\b"
    r"|(?:就是|属于|显示|表明|确认|证明).{0,40}(?:癫痫|致痫|发作起始|病理|SOZ)",
    re.IGNORECASE,
)
_CHANNEL_LABEL_RE = re.compile(
    r"\b[A-Za-z]{1,8}\d{1,4}(?:-(?:[A-Za-z]{1,8})?\d{1,4})?\b"
)
_FINDING_TERMS = {
    "flat", "outlier", "artifact", "noisy", "line noise", "hfo", "spindle", "spike",
    "candidate", "accepted", "rejected", "spectral", "ranking", "ranked", "classifier",
    "abnormal", "normal", "clean", "contaminated", "true positive", "false positive",
}
_REVIEW_AUTHORITY_LANGUAGE_RE = re.compile(
    r"\b(?:confirm(?:ed|s)?|accept(?:ed|s)?|true[- ]positive|clinician[- ]reviewed|"
    r"human[- ]reviewed|adjudicat(?:ed|ion)|reviewed\s+as)\b"
    r"|(?:临床|人工|医生).{0,12}(?:确认|复核|审阅)|(?:已确认|已接受|真阳性)",
    re.IGNORECASE,
)
_NEGATED_REVIEW_AUTHORITY_RE = re.compile(
    r"\b(?:not|never|un)\s*(?:confirmed|accepted|reviewed|adjudicated)\b"
    r"|(?:未确认|未接受|未经复核|并非真阳性)",
    re.IGNORECASE,
)
_ASSERTED_HFO_RE = re.compile(r"\bHFOs?\b|high[- ]frequency oscillation", re.IGNORECASE)
_ASSERTED_ARTIFACT_RE = re.compile(r"\b(?:artifact|artefact)s?\b|伪迹", re.IGNORECASE)
_ASSERTED_REJECTED_RE = re.compile(r"\b(?:reject(?:ed|ion)?|false[- ]positive)\b|排除|拒绝", re.IGNORECASE)
_ASSERTED_UNCERTAIN_RE = re.compile(r"\buncertain\b|不确定", re.IGNORECASE)
_ASSERTED_CLEAR_RE = re.compile(r"\b(?:clear(?:ed)?|unannotated)\b|清除|未标注", re.IGNORECASE)
_ASSERTED_SPIKE_RE = re.compile(r"\bspikes?\b|尖波", re.IGNORECASE)
_POSITIVE_HFO_REVIEW_LABELS = {"hfo", "accepted", "pathological", "physiological", "real"}
_COUNT_RESULT_LANGUAGE_RE = re.compile(r"\b(?:hfo|candidate|event|oscillation)s?\b", re.IGNORECASE)
_COUNT_METRIC_KEY_RE = re.compile(
    r"(?:^|_)(?:count|number|total|num|n)(?:_|$)|(?:hfo|candidate|event|oscillation).*(?:count|number|total|num)",
    re.IGNORECASE,
)
_NUMERIC_METRIC_KEY_RE = re.compile(
    r"(?:^|_)(?:value|count|number|total|num|n|rate|frequency|freq|power|duration|score|rank|"
    r"amplitude|threshold|ratio|percent|percentage|start|end|minimum|maximum|min|max|mean|median|std)(?:_|$)",
    re.IGNORECASE,
)
_NEGATED_DIAGNOSTIC_RE = re.compile(
    r"\b(?:not|never)\s+(?:a\s+)?(?:diagnosis|diagnostic|epileptogenic|pathological|soz)\b"
    r"|\b(?:cannot|can't|does\s+not|do\s+not|did\s+not|no\s+evidence\s+to)\s+"
    r"(?:diagnose|establish|confirm|support|locali[sz]e|determine)\b"
    r"|(?:不能|无法|不支持|未能|不是).{0,20}(?:诊断|癫痫|致痫|发作起始|病理|SOZ)",
    re.IGNORECASE,
)

_TOP_FIELDS = {
    "schema_version", "output_id", "request_id", "conversation_id", "message_id",
    "state_revision", "recording_fingerprint", "run_ids", "response_language", "summary", "claims",
    "evidence", "provenance", "guardrails", "limitations", "artifacts",
}
_PROVENANCE_FIELDS = {
    "software_version", "algorithm", "algorithm_version", "parameters", "parameters_sha256",
    "recording", "software_components", "algorithm_details", "run_scope", "parent_output_ids", "generated_at",
}
_RECORDING_FIELDS = {
    "recording_id", "sha256", "source_uri", "sampling_frequency_hz", "nyquist_hz",
    "line_frequency_hz", "channel_names", "evaluated_interval_seconds", "montage", "reference",
}
_SOFTWARE_COMPONENT_FIELDS = {"name", "version", "commit", "model_digest"}
_ALGORITHM_DETAIL_FIELDS = {
    "name", "version", "detector", "biomarker", "classifier", "parameters",
    "parameters_sha256", "filter_band_hz", "notch_frequencies_hz",
}
_RUN_SCOPE_FIELDS = {"mode", "run_ids", "aggregation_method"}
_CLAIM_FIELDS = {
    "claim_id", "kind", "assertion", "epistemic_status", "evidence_refs", "run_ids",
    "review_receipt_id", "review_actor", "review_command_payload", "value", "units", "denominator", "scope",
    "limitations", "confidence", "partial_failure_status",
}
_EVIDENCE_FIELDS = {
    "evidence_id", "kind", "source", "recording_id", "run_id", "event_id", "channel",
    "value", "unit", "artifact_id", "source_uri",
}
_ARTIFACT_FIELDS = {"artifact_id", "kind", "uri", "sha256", "created_by", "created_at", "run_id"}
_REVIEW_ACTOR_FIELDS = {"actor_id", "role", "session_id_sha256", "display_name"}
_NUMERIC_SCOPE_FIELDS = {
    "level", "recording_id", "run_id", "channel", "event_id", "interval_seconds", "cohort_id",
}
_GUARDRAIL_FIELDS = {
    "intended_use", "diagnostic_status", "candidate_terminology", "anatomy_inference",
    "soz_inference", "aggregation_scope",
}
_ARTIFACT_KINDS = {
    "prepared_recording", "detection_run", "classification_run", "annotation_set",
    "session", "workbook", "report", "snapshot", "other",
}
_MAX_RESEARCH_OUTPUT_BYTES = 1_000_000
_MAX_RUNS = 64
_MAX_CLAIMS = 128
_MAX_EVIDENCE = 2048
_MAX_ARTIFACTS = 256
_MAX_LIMITATIONS = 64
_MAX_PUBLIC_VALUE_DEPTH = 12
_MAX_PUBLIC_CONTAINER_ITEMS = 4096

_RESEARCH_RESULT_COMMAND_TYPES = {
    "recording.infer_roi",
    "analysis.run_qc",
    "analysis.compute_spectral_profile",
    "analysis.prepare_recording",
    "detection.plan",
    "detection.run",
    "detection.rank_candidates",
    "detection.create_consensus_run",
    "classification.run",
    "severity.run",
    "events.stage_annotation",
    "events.clear_staged_annotation",
    "review.accept_run",
    "review.group_overlaps",
    "batch.create",
    "batch.run",
    "export.session",
    "export.workbook",
    "export.report",
}


@dataclass(frozen=True)
class ClinicalEvidenceIssue:
    code: str
    path: str
    message: str


class ResearchOutputContractError(RuntimeError):
    def __init__(self, issues: Sequence[ClinicalEvidenceIssue]):
        self.issues = tuple(issues)
        super().__init__("research_output_contract_failed")


def _as_nonempty_string(value: Any) -> str:
    return str(value or "").strip()


def _is_identifier(value: Any) -> bool:
    return bool(_IDENTIFIER_RE.fullmatch(_as_nonempty_string(value)))


def _is_sha256(value: Any) -> bool:
    return bool(_SHA256_RE.fullmatch(_as_nonempty_string(value)))


def _json_sha256(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@lru_cache(maxsize=32)
def _cached_file_sha256(
    path: str,
    size: int,
    modified_ns: int,
    changed_ns: int,
    inode: int,
) -> str:
    del size, modified_ns, changed_ns, inode  # cache-key material; bytes are read from ``path``.
    return _file_sha256(path)


def _file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def recording_fingerprint_for_path(path: Any, *, fresh: bool = False) -> str | None:
    """Return a content fingerprint for an actually readable recording file."""

    raw = _as_nonempty_string(path)
    if not raw:
        return None
    try:
        resolved = Path(raw).expanduser().resolve(strict=True)
        stat = resolved.stat()
        if not resolved.is_file():
            return None
        if fresh:
            return _file_sha256(str(resolved))
        return _cached_file_sha256(
            str(resolved),
            int(stat.st_size),
            int(stat.st_mtime_ns),
            int(stat.st_ctime_ns),
            int(stat.st_ino),
        )
    except (OSError, RuntimeError, ValueError):
        return None


def _is_datetime(value: Any) -> bool:
    raw = _as_nonempty_string(value)
    if not raw:
        return False
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def _is_safe_public_text(value: Any) -> bool:
    raw = _as_nonempty_string(value)
    return bool(raw) and redact_observability_text(raw) == raw


def _is_safe_public_json(
    value: Any,
    *,
    key: str = "",
    depth: int = 0,
    seen: set[int] | None = None,
) -> bool:
    """Reject secrets, PHI, paths, exotic objects, cycles, and unbounded trees.

    Research output is delivered verbatim on the public stream.  It therefore
    needs a stricter boundary than observability logging: finding something the
    redactor *would* change is a validation failure, not permission to mutate
    scientific evidence after its provenance digest was computed.
    """

    if depth > _MAX_PUBLIC_VALUE_DEPTH:
        return False
    if value is None or isinstance(value, bool):
        return True
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(float(value))
    if isinstance(value, str):
        if len(value) > _MAX_RESEARCH_OUTPUT_BYTES:
            return False
        return redact_observability_payload(value, key=key) == value
    if not isinstance(value, (Mapping, list)):
        return False

    seen = seen if seen is not None else set()
    marker = id(value)
    if marker in seen:
        return False
    seen.add(marker)
    try:
        if isinstance(value, Mapping):
            if len(value) > _MAX_PUBLIC_CONTAINER_ITEMS:
                return False
            for raw_key, nested in value.items():
                if not isinstance(raw_key, str) or not raw_key or len(raw_key) > 256:
                    return False
                # Key-aware redaction catches structured MRN/token/path fields
                # even when their value does not look sensitive in isolation.
                try:
                    if redact_observability_payload(nested, key=raw_key) != nested:
                        return False
                except (RecursionError, TypeError, ValueError, OverflowError):
                    return False
                if not _is_safe_public_json(
                    nested,
                    key=raw_key,
                    depth=depth + 1,
                    seen=seen,
                ):
                    return False
            return True
        if len(value) > _MAX_PUBLIC_CONTAINER_ITEMS:
            return False
        return all(
            _is_safe_public_json(item, depth=depth + 1, seen=seen)
            for item in value
        )
    finally:
        seen.remove(marker)


def _iter_mapping_nodes(value: Any, *, depth: int = 0) -> Iterable[Mapping[str, Any]]:
    if depth > _MAX_PUBLIC_VALUE_DEPTH:
        return
    if isinstance(value, Mapping):
        yield value
        for nested in value.values():
            yield from _iter_mapping_nodes(nested, depth=depth + 1)
    elif isinstance(value, list):
        for nested in value:
            yield from _iter_mapping_nodes(nested, depth=depth + 1)


def _trusted_values(value: Any, keys: set[str]) -> set[str]:
    found: set[str] = set()
    for node in _iter_mapping_nodes(value):
        for key in keys:
            raw = node.get(key)
            items = raw if isinstance(raw, list) else [raw]
            for item in items:
                normalized = _as_nonempty_string(item)
                if normalized:
                    found.add(normalized)
    return found


def _mapping_subset(candidate: Mapping[str, Any], observed: Mapping[str, Any]) -> bool:
    return all(
        key in observed and _value_supported_by_result(value, observed[key])
        for key, value in candidate.items()
    )


def _value_supported_by_result(candidate: Any, observed: Any, *, depth: int = 0) -> bool:
    """Return whether a public evidence value is present in trusted tool output."""

    if depth > _MAX_PUBLIC_VALUE_DEPTH:
        return False
    if isinstance(candidate, Mapping):
        if isinstance(observed, Mapping) and _mapping_subset(candidate, observed):
            return True
    elif isinstance(candidate, list):
        if isinstance(observed, list) and candidate == observed:
            return True
    elif candidate == observed:
        return True

    if isinstance(observed, Mapping):
        return any(
            _value_supported_by_result(candidate, nested, depth=depth + 1)
            for nested in observed.values()
        )
    if isinstance(observed, list):
        return any(
            _value_supported_by_result(candidate, nested, depth=depth + 1)
            for nested in observed
        )
    return False


def _severity_score_contract_error(value: Any) -> str | None:
    """Validate the closed scalp-EEG BASED evidence projection."""
    if not isinstance(value, Mapping):
        return "severity_score evidence must be an object"
    summary = value.get("severity_summary")
    if not isinstance(summary, Mapping):
        summary = value
    model_name = _as_nonempty_string(value.get("model_name"))
    model_version = _as_nonempty_string(value.get("model_version"))
    num_segments = summary.get("num_segments")
    num_clean_segments = summary.get("num_clean_segments")
    if (
        _as_nonempty_string(summary.get("eeg_type")).lower() != "scalp"
        or model_name != "BASED"
        or not model_version
        or any(
            not _is_sha256(value.get(field))
            for field in ("model_sha256", "parameters_sha256", "result_sha256")
        )
        or not isinstance(num_segments, int)
        or isinstance(num_segments, bool)
        or num_segments <= 0
        or not isinstance(num_clean_segments, int)
        or isinstance(num_clean_segments, bool)
        or num_clean_segments < 0
        or num_clean_segments > num_segments
    ):
        return "severity_score evidence requires scalp EEG, BASED identity, digests, and positive segment counts"

    def valid_score(field: str, *, required: bool) -> bool:
        score = summary.get(field)
        if score is None:
            return not required
        return (
            isinstance(score, (int, float))
            and not isinstance(score, bool)
            and math.isfinite(float(score))
            and 0.0 <= float(score) <= 5.0
        )

    def valid_time(field: str, *, required: bool) -> bool:
        timestamp = summary.get(field)
        if timestamp is None:
            return not required
        return (
            isinstance(timestamp, (int, float))
            and not isinstance(timestamp, bool)
            and math.isfinite(float(timestamp))
            and float(timestamp) >= 0.0
        )

    if not (
        valid_score("mean_score", required=True)
        and valid_score("peak_score", required=True)
        and valid_time("peak_time_sec", required=True)
        and valid_score("clean_mean_score", required=num_clean_segments > 0)
        and valid_score("clean_peak_score", required=num_clean_segments > 0)
        and valid_time("clean_peak_time_sec", required=num_clean_segments > 0)
    ):
        return "severity_score values must be finite 0-5 scores with non-negative peak times"
    return None


def _severity_value_supported_by_record(value: Any, record: Mapping[str, Any]) -> bool:
    if not isinstance(value, Mapping):
        return False
    claimed_digest = _as_nonempty_string(value.get("result_sha256")).lower()
    attestation = record.get("attestation")
    if (
        not isinstance(attestation, Mapping)
        or not _is_sha256(claimed_digest)
        or claimed_digest != _as_nonempty_string(attestation.get("result_sha256")).lower()
    ):
        return False
    without_digest = {key: item for key, item in value.items() if key != "result_sha256"}
    return _value_supported_by_result(without_digest, record.get("result"))


def _execution_records(
    execution_evidence: Sequence[Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for raw in execution_evidence or []:
        if not isinstance(raw, Mapping):
            continue
        tool_name = _as_nonempty_string(raw.get("tool_name") or raw.get("name"))
        result = raw.get("result")
        if not tool_name or result is None:
            continue
        observed_result = result
        nested_attestation = None
        if isinstance(result, Mapping):
            nested_attestation = result.get("execution_provenance")
            if isinstance(nested_attestation, Mapping) and "result" in result:
                observed_result = result.get("result")
        attestation = raw.get("execution_provenance")
        if not isinstance(attestation, Mapping):
            attestation = nested_attestation

        if not isinstance(attestation, Mapping) and tool_name in _CLINICAL_REVIEW_COMMANDS:
            receipt = canonical_action_receipt(result, terminal_only=True) or {}
            postcondition = receipt.get("postcondition")
            postcondition_evidence = (
                postcondition.get("evidence")
                if isinstance(postcondition, Mapping)
                and isinstance(postcondition.get("evidence"), Mapping)
                else {}
            )
            terminal_proof = (
                postcondition_evidence.get("terminal_proof")
                if isinstance(postcondition_evidence.get("terminal_proof"), Mapping)
                else {}
            )
            if (
                receipt.get("status") == "complete"
                and receipt.get("terminal") is True
                and receipt.get("success") is True
                and receipt.get("effect") == "review_write"
                and isinstance(postcondition, Mapping)
                and postcondition.get("verified") is True
                and terminal_proof
            ):
                attestation = {
                    "attestation_version": EXECUTION_ATTESTATION_VERSION,
                    "tool_name": tool_name,
                    "result_sha256": canonical_json_sha256(result),
                    "run_ids": sorted(
                        _trusted_values(
                            terminal_proof,
                            {"run_id", "accepted_run_id", "detection_run_id"},
                        )
                    ),
                    "event_ids": sorted(_trusted_values(terminal_proof, {"event_id"})),
                    "state_revision": receipt.get("state_revision"),
                    "evidence_kinds": sorted(TRUSTED_EVIDENCE_KINDS_BY_TOOL.get(tool_name, ())),
                    "artifacts": [],
                }

        if (
            not isinstance(attestation, Mapping)
            or attestation.get("attestation_version") != EXECUTION_ATTESTATION_VERSION
            or _as_nonempty_string(attestation.get("tool_name")) != tool_name
        ):
            continue
        try:
            result_digest = canonical_json_sha256(observed_result)
        except (TypeError, ValueError):
            continue
        if _as_nonempty_string(attestation.get("result_sha256")).lower() != result_digest:
            continue

        allowed_evidence_kinds = set(TRUSTED_EVIDENCE_KINDS_BY_TOOL.get(tool_name, ()))
        attested_kinds = {
            _as_nonempty_string(value)
            for value in (attestation.get("evidence_kinds") or [])
            if _as_nonempty_string(value)
        }
        if not attested_kinds or not attested_kinds <= allowed_evidence_kinds:
            continue
        recording_fingerprints = {
            _as_nonempty_string(attestation.get(key))
            for key in (
                "recording_fingerprint",
                "source_recording_fingerprint",
                "input_recording_fingerprint",
                "derived_input_fingerprint",
            )
            if _is_sha256(attestation.get(key))
        }
        records.append(
            {
                "tool_name": tool_name,
                "result": observed_result,
                "attestation": dict(attestation),
                "recording_fingerprints": recording_fingerprints,
                "run_ids": {
                    _as_nonempty_string(value)
                    for value in (attestation.get("run_ids") or [])
                    if _is_identifier(value)
                },
                "event_ids": {
                    _as_nonempty_string(value)
                    for value in (attestation.get("event_ids") or [])
                    if _is_identifier(value)
                },
                "state_revisions": {
                    _as_nonempty_string(attestation.get("state_revision"))
                }
                if _is_identifier(attestation.get("state_revision"))
                else set(),
                "evidence_kinds": attested_kinds,
                "artifacts": list(attestation.get("artifacts") or []),
            }
        )
    return records


def _is_safe_public_uri(value: Any, *, allowed_schemes: set[str]) -> bool:
    raw = _as_nonempty_string(value)
    if not raw or "\\" in raw or any(ord(char) < 32 for char in raw):
        return False
    if raw.lower().startswith("urn:"):
        return "urn" in allowed_schemes and len(raw) > 4 and not any(char.isspace() for char in raw)
    try:
        parsed = urlsplit(raw)
    except ValueError:
        return False
    if parsed.scheme.lower() not in allowed_schemes or not parsed.netloc:
        return False
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return False
    return True


def _has_unsupported_summary_claim(value: Any) -> bool:
    text = _as_nonempty_string(value)
    if not _DIAGNOSTIC_LANGUAGE_RE.search(text):
        return False
    # A disclaimer at the end of a sentence cannot negate an affirmative claim
    # made earlier in that sentence ("A1 is epileptogenic; not a diagnosis").
    if _AFFIRMATIVE_DIAGNOSTIC_RE.search(text):
        return True
    return not bool(_NEGATED_DIAGNOSTIC_RE.search(text))


def _normalize_numeric_token(value: Any) -> str:
    raw = _as_nonempty_string(value).lower().replace("-", " ")
    if not raw:
        return ""
    try:
        number = float(raw)
    except ValueError:
        units = {
            "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
            "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
            "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
            "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
            "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
            "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
        }
        current = 0
        total = 0
        for token in raw.split():
            if token == "and":
                continue
            if token in units:
                current += units[token]
            elif token == "hundred":
                current = max(1, current) * 100
            elif token == "thousand":
                total += max(1, current) * 1000
                current = 0
            else:
                return raw
        return str(total + current)
    if not math.isfinite(number):
        return ""
    return str(int(number)) if number.is_integer() else str(number)


def _numeric_result_values(value: Any) -> set[str]:
    values: set[str] = set()
    for match in _UNTYPED_NUMERIC_RESULT_RE.finditer(_as_nonempty_string(value)):
        for group in match.groups():
            if group:
                normalized = _normalize_numeric_token(group)
                if normalized:
                    values.add(normalized)
    return values


def _numeric_claim_value_supported(
    value: int | float,
    evidence: Mapping[str, Any],
    assertion: str,
) -> bool:
    """Bind a numeric claim to a result field with compatible metric semantics.

    Mere scalar coincidence is not evidence: a 2,000 Hz sampling frequency may
    not be repurposed as a count of 2,000 candidates.  Candidate/event count
    language therefore requires an explicitly count-shaped result key; other
    numeric claims require a named metric key or a scalar evidence value.
    """

    count_semantics = bool(_COUNT_RESULT_LANGUAGE_RE.search(assertion))
    target = float(value)

    def visit(candidate: Any, *, metric_key: str = "", depth: int = 0) -> bool:
        if depth > _MAX_PUBLIC_VALUE_DEPTH:
            return False
        if isinstance(candidate, Mapping):
            for raw_key, nested in candidate.items():
                key = re.sub(r"[^a-z0-9]+", "_", str(raw_key).lower()).strip("_")
                if visit(nested, metric_key=key, depth=depth + 1):
                    return True
            return False
        if isinstance(candidate, list):
            return any(visit(item, metric_key=metric_key, depth=depth + 1) for item in candidate)
        if not isinstance(candidate, (int, float)) or isinstance(candidate, bool):
            return False
        if not math.isfinite(float(candidate)) or float(candidate) != target:
            return False
        if count_semantics:
            return bool(_COUNT_METRIC_KEY_RE.search(metric_key))
        return not metric_key or bool(_NUMERIC_METRIC_KEY_RE.search(metric_key))

    return visit(evidence.get("value"))


def _claim_semantics_supported(
    assertion: str,
    referenced_evidence: Sequence[Mapping[str, Any]],
) -> bool:
    if not assertion or not referenced_evidence:
        return False
    try:
        corpus = json.dumps(
            list(referenced_evidence),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).lower()
    except (TypeError, ValueError):
        return False
    channels = {match.group(0).lower() for match in _CHANNEL_LABEL_RE.finditer(assertion)}
    if any(channel not in corpus for channel in channels):
        return False
    lowered = assertion.lower()
    finding_terms = {term for term in _FINDING_TERMS if term in lowered}
    if any(term not in corpus for term in finding_terms):
        return False
    return True


def _evidence_semantic_projection(evidence: Mapping[str, Any]) -> dict[str, Any]:
    """Expose only fields whose authority is checked before claim semantics."""

    return {
        key: evidence[key]
        for key in (
            "kind", "source", "run_id", "event_id", "channel", "unit",
            "artifact_id", "source_uri", "value",
        )
        if key in evidence
    }


def _evidence_metadata_supported(
    evidence: Mapping[str, Any],
    record: Mapping[str, Any],
) -> bool:
    """Bind model-visible evidence metadata to the same trusted result as value."""

    attestation = record.get("attestation")
    recording_metadata = (
        attestation.get("recording_metadata")
        if isinstance(attestation, Mapping)
        and isinstance(attestation.get("recording_metadata"), Mapping)
        else {}
    )
    for field in ("channel", "unit", "artifact_id", "source_uri"):
        if field not in evidence:
            continue
        candidate = evidence.get(field)
        if not (
            _value_supported_by_result(candidate, record.get("result"))
            or _value_supported_by_result(candidate, record.get("artifacts"))
            or _value_supported_by_result(candidate, recording_metadata)
        ):
            return False
    return True


def _normalized_review_label(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", _as_nonempty_string(value).lower()).strip("_")


def _review_label_supports_assertion(assertion: str, label: Any) -> bool:
    """Ensure an authentic review cannot be quoted with the opposite polarity."""

    normalized = _normalized_review_label(label)
    if _ASSERTED_HFO_RE.search(assertion) and normalized not in _POSITIVE_HFO_REVIEW_LABELS:
        return False
    if _ASSERTED_ARTIFACT_RE.search(assertion) and normalized != "artifact":
        return False
    if _ASSERTED_REJECTED_RE.search(assertion) and normalized not in {"rejected", "artifact"}:
        return False
    if _ASSERTED_UNCERTAIN_RE.search(assertion) and normalized != "uncertain":
        return False
    if _ASSERTED_CLEAR_RE.search(assertion) and normalized != "clear":
        return False
    if _ASSERTED_SPIKE_RE.search(assertion) and normalized != "spike":
        return False
    return True


def _text_semantics_subset_of_claims(
    text: Any,
    claims: Sequence[Mapping[str, Any]],
) -> bool:
    raw = _as_nonempty_string(text)
    if not raw or not claims:
        return False
    claim_projection = [
        {
            "assertion": claim.get("assertion"),
            "value": claim.get("value"),
            "run_ids": claim.get("run_ids"),
        }
        for claim in claims
    ]
    return _claim_semantics_supported(raw, claim_projection)


def requires_research_output(
    *,
    user_question: str,
    final_content: str,
    state: Any,
) -> bool:
    """Return whether a successful turn must carry canonical research evidence.

    Generic education remains available without a recording contract.  Once a
    turn executes a case workflow or states a case-specific clinical result,
    however, prose alone is not an admissible success representation.
    """

    question = _as_nonempty_string(user_question)
    answer = _as_nonempty_string(final_content)
    plan = getattr(state, "plan", None)
    plan_goal = _as_nonempty_string(getattr(plan, "user_goal", ""))
    combined_context = f"{question}\n{plan_goal}"

    clinical_commands = False
    for command in getattr(state, "ui_commands", None) or []:
        if not isinstance(command, Mapping):
            continue
        command_type = _as_nonempty_string(command.get("type") or command.get("command_type"))
        effect = _as_nonempty_string(command.get("effect") or command.get("risk"))
        if command_type in _RESEARCH_RESULT_COMMAND_TYPES and effect not in {"view", "read"}:
            clinical_commands = True
            break

    clinical_skill = any(
        any(marker in _as_nonempty_string(skill).lower() for marker in (
            "pyhfo", "hfo", "ieeg", "eeg", "detection", "classifier",
            "clinical", "quality_control", "qc", "spectral", "ranking",
        ))
        for skill in (getattr(state, "skills_executed", None) or [])
    )
    has_recording = bool(_as_nonempty_string(getattr(state, "recording_path", "")))
    case_context = bool(_CASE_CONTEXT_RE.search(combined_context)) or has_recording
    case_workflow_request = bool(
        _CASE_REQUEST_RE.search(question)
        or _CASE_DIAGNOSTIC_QUESTION_RE.search(question)
        or _CASE_QUANTITATIVE_QUESTION_RE.search(question)
    ) or bool(
        has_recording and _CASE_ACTION_INTENT_RE.search(question)
    )
    case_result = bool(_CASE_SPECIFIC_RESULT_RE.search(answer))
    assertive_clinical_result = bool(
        _DIAGNOSTIC_LANGUAGE_RE.search(answer)
        and _ASSERTIVE_CLINICAL_RE.search(answer)
    )

    if clinical_commands:
        return True
    safe_non_completion = bool(_NON_COMPLETION_RE.search(answer)) and not (
        _AFFIRMATIVE_DIAGNOSTIC_RE.search(answer)
        or _UNTYPED_NUMERIC_RESULT_RE.search(answer)
        or _CHANNEL_LABEL_RE.search(answer)
        or any(term in answer.lower() for term in _FINDING_TERMS)
    )
    if safe_non_completion:
        return False
    if case_workflow_request and answer and not _NON_COMPLETION_RE.search(answer):
        return True
    if assertive_clinical_result and (case_result or case_context):
        return True
    if case_result and _DIAGNOSTIC_LANGUAGE_RE.search(answer):
        return True
    if case_result and (case_context or clinical_skill):
        return True
    return False


def is_safe_non_completion_reply(final_content: str) -> bool:
    """Return whether prose reports a genuine non-result without laundering a claim.

    A case workflow may end with missing input or insufficient evidence.  Such
    replies should remain ordinary prose, but an affirmative claim in a later
    sentence or contrast clause must not escape the research-output contract.
    """

    answer = _as_nonempty_string(final_content)
    if not answer or not _NON_COMPLETION_RE.search(answer):
        return False
    clauses = re.split(
        r"(?:[.!?;,，\n]+|\b(?:but|however|yet|nevertheless|although|despite|while)\b|"
        r"(?:但是|然而|不过|尽管|虽然|但))",
        answer,
        flags=re.IGNORECASE,
    )
    for clause in clauses:
        normalized = clause.strip()
        if not normalized or _NON_COMPLETION_RE.search(normalized):
            continue
        if (
            _AFFIRMATIVE_DIAGNOSTIC_RE.search(normalized)
            or _SOZ_LANGUAGE_RE.search(normalized)
            or _UNTYPED_NUMERIC_RESULT_RE.search(normalized)
            or _CASE_SPECIFIC_RESULT_RE.search(normalized)
        ):
            return False
    return True


def _receipt_index(
    receipts: Sequence[Mapping[str, Any]] | Mapping[str, Mapping[str, Any]] | None,
) -> dict[str, Mapping[str, Any]]:
    if isinstance(receipts, Mapping):
        indexed: dict[str, Mapping[str, Any]] = {}
        for key, value in receipts.items():
            canonical = canonical_action_receipt(value, terminal_only=True)
            if canonical is None:
                continue
            receipt_id = _as_nonempty_string(canonical.get("receipt_id") or key)
            if receipt_id:
                indexed[receipt_id] = canonical
        return indexed
    indexed: dict[str, Mapping[str, Any]] = {}
    for receipt in receipts or []:
        canonical = canonical_action_receipt(receipt, terminal_only=True)
        if canonical is None:
            continue
        receipt_id = _as_nonempty_string(
            canonical.get("receipt_id") or canonical.get("command_id")
        )
        if receipt_id:
            indexed[receipt_id] = canonical
    return indexed


def _unknown_fields(
    value: Mapping[str, Any],
    allowed: set[str],
    *,
    path: str,
) -> list[ClinicalEvidenceIssue]:
    return [
        ClinicalEvidenceIssue("unknown_field", f"{path}.{key}", "unknown fields are rejected by v1")
        for key in sorted(set(value) - allowed)
    ]


def _review_actor(receipt: Mapping[str, Any]) -> Mapping[str, Any]:
    actor = receipt.get("approval_actor") or receipt.get("actor")
    return actor if isinstance(actor, Mapping) else {}


def _source_markers(evidence: Mapping[str, Any]) -> set[str]:
    # ``source`` is model-authored routing metadata.  Only markers present in
    # the evidence value itself are meaningful, and that value is separately
    # required to be a subset of a trusted tool result.
    markers: set[str] = set()
    value = evidence.get("value")
    if isinstance(value, Mapping):
        for key in (
            "source_type", "evidence_subtype", "mapping_type", "review_type",
            "localization_type", "label", "observed_annotation_label",
        ):
            marker = _as_nonempty_string(value.get(key)).lower().replace("-", "_").replace(" ", "_")
            if marker:
                markers.add(marker)
    return {marker for marker in markers if marker}


def _has_supported_localization_evidence(
    claim: Mapping[str, Any],
    evidence_index: Mapping[str, Mapping[str, Any]],
    *,
    soz: bool,
) -> bool:
    required_markers = _SOZ_SOURCE_MARKERS if soz else _ANATOMY_SOURCE_MARKERS
    for reference in claim.get("evidence_refs") or []:
        evidence = evidence_index.get(_as_nonempty_string(reference))
        if not evidence:
            continue
        kind = _as_nonempty_string(evidence.get("kind"))
        if kind not in {"human_review", "annotation", "external_source"}:
            continue
        markers = _source_markers(evidence)
        if markers & required_markers:
            return True
        if any(any(required in marker for required in required_markers) for marker in markers):
            return True
    return False


def _validate_review_binding(
    *,
    claim: Mapping[str, Any],
    path: str,
    indexed_receipts: Mapping[str, Mapping[str, Any]],
    conversation_id: str,
    state_revision: str,
    request_id: str,
    message_id: str,
    evidence_index: Mapping[str, Mapping[str, Any]],
) -> list[ClinicalEvidenceIssue]:
    issues: list[ClinicalEvidenceIssue] = []
    receipt_id = _as_nonempty_string(claim.get("review_receipt_id"))
    claim_actor = claim.get("review_actor")
    if not receipt_id or receipt_id not in indexed_receipts:
        return [
            ClinicalEvidenceIssue(
                "review_without_receipt",
                f"{path}.review_receipt_id",
                "reviewed/confirmed claims require a matching action receipt",
            )
        ]
    if not isinstance(claim_actor, Mapping):
        return [
            ClinicalEvidenceIssue(
                "missing_review_actor",
                f"{path}.review_actor",
                "reviewed/confirmed claims require a structured review actor",
            )
        ]
    issues.extend(_unknown_fields(claim_actor, _REVIEW_ACTOR_FIELDS, path=f"{path}.review_actor"))
    actor_id = _as_nonempty_string(claim_actor.get("actor_id"))
    actor_role = _as_nonempty_string(claim_actor.get("role")).lower()
    claim_session_hash = _as_nonempty_string(claim_actor.get("session_id_sha256"))
    if not _is_identifier(actor_id) or actor_role not in _REVIEW_ROLES or not _is_sha256(claim_session_hash):
        issues.append(
            ClinicalEvidenceIssue(
                "invalid_review_actor",
                f"{path}.review_actor",
                "review actor must have a valid actor_id, review-capable role, and session hash",
            )
        )

    receipt = indexed_receipts[receipt_id]
    receipt_status = _as_nonempty_string(receipt.get("status"))
    receipt_type = _as_nonempty_string(receipt.get("command_type") or receipt.get("type"))
    receipt_effect = _as_nonempty_string(receipt.get("effect"))
    postcondition = receipt.get("postcondition")
    if (
        receipt_status != "complete"
        or receipt.get("terminal") is not True
        or receipt.get("success") is not True
        or receipt_type not in _CLINICAL_REVIEW_COMMANDS
        or receipt_effect != "review_write"
        or not isinstance(postcondition, Mapping)
        or postcondition.get("verified") is not True
        or not isinstance(postcondition.get("evidence"), Mapping)
        or not postcondition.get("evidence")
    ):
        issues.append(
            ClinicalEvidenceIssue(
                "invalid_review_receipt",
                f"{path}.review_receipt_id",
                "review receipt must be terminal successful and owned by a review-write command",
            )
        )

    review_payload = claim.get("review_command_payload")
    if not isinstance(review_payload, Mapping):
        issues.append(
            ClinicalEvidenceIssue(
                "missing_review_command_payload",
                f"{path}.review_command_payload",
                "reviewed/confirmed claims must carry the exact safe command payload",
            )
        )
    else:
        provenance = receipt.get("provenance")
        receipt_payload_digest = (
            _as_nonempty_string(provenance.get("payload_sha256"))
            if isinstance(provenance, Mapping)
            else ""
        )
        try:
            review_payload_digest = _json_sha256(review_payload)
        except (TypeError, ValueError):
            review_payload_digest = ""
        if (
            not _is_sha256(receipt_payload_digest)
            or not review_payload_digest
            or receipt_payload_digest.lower() != review_payload_digest.lower()
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "review_payload_digest_mismatch",
                    f"{path}.review_command_payload",
                    "review command payload must exactly match the receipt provenance digest",
                )
            )

        if receipt_type == "events.stage_annotation":
            if not {"event_id", "label"} <= set(review_payload) or not set(review_payload) <= {"event_id", "label", "notes"}:
                issues.append(
                    ClinicalEvidenceIssue(
                        "invalid_review_command_payload",
                        f"{path}.review_command_payload",
                        "annotation review payload must contain event_id and label, with optional safe notes",
                    )
                )
            event_id = _as_nonempty_string(review_payload.get("event_id"))
            label = _as_nonempty_string(review_payload.get("label"))
            notes = review_payload.get("notes")
            if notes is not None and (
                not _as_nonempty_string(notes)
                or len(_as_nonempty_string(notes)) > 2000
                or not _is_safe_public_text(notes)
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "invalid_review_command_payload",
                        f"{path}.review_command_payload.notes",
                        "annotation notes must be non-empty bounded public text when provided",
                    )
                )
            referenced_evidence = [
                evidence_index[_as_nonempty_string(reference)]
                for reference in (claim.get("evidence_refs") or [])
                if _as_nonempty_string(reference) in evidence_index
            ]
            referenced_event_ids: set[str] = set()
            for evidence in referenced_evidence:
                exposed_event_id = _as_nonempty_string(evidence.get("event_id"))
                if exposed_event_id:
                    referenced_event_ids.add(exposed_event_id)
                referenced_event_ids.update(
                    _trusted_values(evidence.get("value"), {"event_id", "event_ids"})
                )
            if (
                not _is_identifier(event_id)
                or not label
                or len(label) > 256
                or not _is_safe_public_text(label)
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "invalid_review_command_payload",
                        f"{path}.review_command_payload",
                        "annotation review payload requires a safe event identifier and label",
                    )
                )
            if event_id not in referenced_event_ids:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_event_mismatch",
                        f"{path}.review_command_payload.event_id",
                        "reviewed annotation event must be referenced by this claim's evidence",
                    )
                )
            elif (
                referenced_event_ids != {event_id}
                or len(referenced_evidence) != len(claim.get("evidence_refs") or [])
                or any(_as_nonempty_string(evidence.get("event_id")) != event_id for evidence in referenced_evidence)
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_scope_not_exhaustive",
                        f"{path}.evidence_refs",
                        "one annotation receipt may confirm exactly one referenced event",
                    )
                )
            terminal_evidence = (
                postcondition.get("evidence")
                if isinstance(postcondition, Mapping)
                and isinstance(postcondition.get("evidence"), Mapping)
                else {}
            )
            terminal_proof = (
                terminal_evidence.get("terminal_proof")
                if isinstance(terminal_evidence.get("terminal_proof"), Mapping)
                else {}
            )
            requested_label = _normalized_review_label(
                terminal_proof.get("requested_annotation_label")
            )
            expected_label = _normalized_review_label(
                terminal_proof.get("expected_annotation_label")
            )
            observed_label = _normalized_review_label(
                terminal_proof.get("observed_annotation_label")
            )
            payload_label = _normalized_review_label(label)
            label_proof_matches = requested_label == payload_label
            if payload_label == "clear":
                label_proof_matches = (
                    label_proof_matches
                    and terminal_proof.get("annotation_cleared") is True
                    and not observed_label
                )
            else:
                label_proof_matches = (
                    label_proof_matches
                    and terminal_proof.get("annotation_present") is True
                    and bool(expected_label)
                    and observed_label == expected_label
                )
            if not label_proof_matches:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_terminal_proof_mismatch",
                        f"{path}.review_receipt_id",
                        "review receipt read-back labels must exactly prove the requested annotation payload",
                    )
                )
            if not _review_label_supports_assertion(
                _as_nonempty_string(claim.get("assertion")),
                label,
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_semantic_mismatch",
                        f"{path}.review_command_payload.label",
                        "the reviewed label has the opposite or incompatible meaning from the claim assertion",
                    )
                )
            if (
                _as_nonempty_string(claim.get("epistemic_status")) == "confirmed"
                and payload_label in {"uncertain", "clear"}
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_semantic_mismatch",
                        f"{path}.epistemic_status",
                        "an uncertain or cleared annotation cannot establish a confirmed candidate claim",
                    )
                )
            referenced_run_ids: set[str] = set()
            for evidence in referenced_evidence:
                exposed_run_id = _as_nonempty_string(evidence.get("run_id"))
                if exposed_run_id:
                    referenced_run_ids.add(exposed_run_id)
                referenced_run_ids.update(
                    _trusted_values(
                        evidence.get("value"),
                        {"run_id", "run_ids", "active_run_id", "accepted_run_id", "detection_run_id"},
                    )
                )
            proof_run = _as_nonempty_string(terminal_proof.get("run_id"))
            proof_matches_run = any(
                proof_run in {run_id, f"sha256:{_json_sha256(run_id)}"}
                for run_id in referenced_run_ids
            )
            if not referenced_run_ids or not proof_matches_run:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_run_mismatch",
                        f"{path}.review_receipt_id",
                        "annotation review proof must bind to the referenced evidence run",
                    )
                )
            elif (
                len(referenced_run_ids) != 1
                or any(
                    proof_run
                    not in {
                        _as_nonempty_string(evidence.get("run_id")),
                        f"sha256:{_json_sha256(_as_nonempty_string(evidence.get('run_id')))}",
                    }
                    for evidence in referenced_evidence
                )
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_scope_not_exhaustive",
                        f"{path}.evidence_refs",
                        "one annotation receipt may confirm evidence from exactly one run",
                    )
                )
            claim_kind = _as_nonempty_string(claim.get("kind"))
            normalized_label = _normalized_review_label(label)
            if claim_kind == "soz" and normalized_label not in {
                "soz", "seizure_onset_zone", "seizure_onset_site", "ictal_onset_site",
            }:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_semantic_mismatch",
                        f"{path}.review_command_payload.label",
                        "an HFO/event annotation receipt cannot establish SOZ; the reviewed label must explicitly be a seizure-onset localization",
                    )
                )
        elif receipt_type == "review.accept_run":
            if set(review_payload) != {"run_id"}:
                issues.append(
                    ClinicalEvidenceIssue(
                        "invalid_review_command_payload",
                        f"{path}.review_command_payload",
                        "run review payload must contain only run_id",
                    )
                )
            if _as_nonempty_string(claim.get("kind")) in {"soz", "anatomy"}:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_semantic_mismatch",
                        f"{path}.review_receipt_id",
                        "accepting a detector run does not establish anatomy or seizure-onset localization",
                    )
                )
            reviewed_run_id = _as_nonempty_string(review_payload.get("run_id"))
            claim_run_ids = {
                _as_nonempty_string(value) for value in (claim.get("run_ids") or [])
            }
            if not _is_identifier(reviewed_run_id) or reviewed_run_id not in claim_run_ids:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_run_mismatch",
                        f"{path}.review_command_payload.run_id",
                        "accepted run must be one of this claim's declared runs",
                    )
                )
            elif claim_run_ids != {reviewed_run_id}:
                issues.append(
                    ClinicalEvidenceIssue(
                        "review_scope_not_exhaustive",
                        f"{path}.run_ids",
                        "one run-acceptance receipt may review exactly one claim run",
                    )
                )

    receipt_actor = _review_actor(receipt)
    receipt_role = _as_nonempty_string(receipt_actor.get("role")).lower()
    receipt_actor_hash = _as_nonempty_string(receipt_actor.get("actor_id_sha256"))
    receipt_session_hash = _as_nonempty_string(receipt_actor.get("session_id_sha256"))
    raw_receipt_actor_id = _as_nonempty_string(receipt_actor.get("actor_id"))
    expected_hash = hashlib.sha256(actor_id.encode("utf-8")).hexdigest() if actor_id else ""
    identity_matches = bool(
        actor_id
        and (
            raw_receipt_actor_id == actor_id
            or (receipt_actor_hash and receipt_actor_hash == expected_hash)
        )
    )
    if (
        receipt_actor.get("verified") is False
        or receipt_role != actor_role
        or receipt_session_hash != claim_session_hash
        or not identity_matches
        or _as_nonempty_string(receipt.get("conversation_id")) != conversation_id
    ):
        issues.append(
            ClinicalEvidenceIssue(
                "review_actor_mismatch",
                f"{path}.review_actor",
                "claim review actor must match the verified receipt actor identity and role",
            )
        )
    receipt_revision = _as_nonempty_string(receipt.get("state_revision"))
    if not state_revision or receipt_revision != state_revision:
        issues.append(
            ClinicalEvidenceIssue(
                "review_state_revision_mismatch",
                f"{path}.review_receipt_id",
                "review receipt must belong to the exact claim-affecting workspace state revision",
            )
        )
    for receipt_field, expected_value, code in (
        ("request_id", request_id, "review_request_mismatch"),
        ("message_id", message_id, "review_message_mismatch"),
    ):
        observed_value = _as_nonempty_string(receipt.get(receipt_field))
        if observed_value and expected_value and observed_value != expected_value:
            issues.append(
                ClinicalEvidenceIssue(
                    code,
                    f"{path}.review_receipt_id",
                    f"review receipt {receipt_field} does not match the active output scope",
                )
            )
    return issues


def validate_research_output(
    payload: Mapping[str, Any],
    *,
    receipts: Sequence[Mapping[str, Any]] | Mapping[str, Mapping[str, Any]] | None = None,
    execution_evidence: Sequence[Mapping[str, Any]] | None = None,
    expected_request_id: str | None = None,
    expected_conversation_id: str | None = None,
    expected_message_id: str | None = None,
    expected_state_revision: str | None = None,
    expected_recording_fingerprint: str | None = None,
    expected_response_language: str | None = None,
) -> tuple[ClinicalEvidenceIssue, ...]:
    """Fail-closed validation for canonical, structured research output."""

    if not isinstance(payload, Mapping):
        return (ClinicalEvidenceIssue("invalid_payload", "$", "research output must be an object"),)

    issues: list[ClinicalEvidenceIssue] = _unknown_fields(payload, _TOP_FIELDS, path="$")
    try:
        payload_size = len(
            json.dumps(
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        )
    except (TypeError, ValueError):
        payload_size = _MAX_RESEARCH_OUTPUT_BYTES + 1
    if payload_size > _MAX_RESEARCH_OUTPUT_BYTES:
        issues.append(ClinicalEvidenceIssue("research_output_too_large", "$", "research output exceeds the bounded public contract"))
    try:
        public_payload_safe = _is_safe_public_json(payload)
    except (RecursionError, TypeError, ValueError, OverflowError):
        public_payload_safe = False
    if not public_payload_safe:
        issues.append(
            ClinicalEvidenceIssue(
                "unsafe_public_payload",
                "$",
                "research output contains a secret, clinical identifier, raw path, unsupported value, or unbounded structure",
            )
        )
    for field in _TOP_FIELDS:
        if field not in payload:
            issues.append(ClinicalEvidenceIssue("missing_required_field", f"$.{field}", f"{field} is required"))

    if payload.get("schema_version") != "research-output.v1":
        issues.append(
            ClinicalEvidenceIssue(
                "unsupported_schema_version",
                "$.schema_version",
                "schema_version must be exactly research-output.v1",
            )
        )
    for field in ("output_id", "request_id", "conversation_id", "message_id"):
        if not _is_identifier(payload.get(field)):
            issues.append(ClinicalEvidenceIssue(f"invalid_{field}", f"$.{field}", f"{field} must be a valid identifier"))
    expected_scope = (
        ("request_id", expected_request_id, "request_scope_mismatch"),
        ("conversation_id", expected_conversation_id, "conversation_scope_mismatch"),
        ("message_id", expected_message_id, "message_scope_mismatch"),
        ("state_revision", expected_state_revision, "state_revision_mismatch"),
        ("response_language", expected_response_language, "response_language_mismatch"),
    )
    for field, expected, code in expected_scope:
        normalized_expected = _as_nonempty_string(expected)
        if normalized_expected and _as_nonempty_string(payload.get(field)) != normalized_expected:
            issues.append(
                ClinicalEvidenceIssue(
                    code,
                    f"$.{field}",
                    f"{field} must match the active agent turn",
                )
            )

    fingerprint = _as_nonempty_string(payload.get("recording_fingerprint"))
    if not _is_sha256(fingerprint):
        issues.append(
            ClinicalEvidenceIssue(
                "invalid_recording_fingerprint",
                "$.recording_fingerprint",
                "recording_fingerprint must be a 64-character SHA-256 digest",
            )
        )
    normalized_expected_fingerprint = _as_nonempty_string(expected_recording_fingerprint).lower()
    if normalized_expected_fingerprint and fingerprint.lower() != normalized_expected_fingerprint:
        issues.append(
            ClinicalEvidenceIssue(
                "recording_scope_mismatch",
                "$.recording_fingerprint",
                "recording fingerprint must match the recording bound to the active turn",
            )
        )

    state_revision = _as_nonempty_string(payload.get("state_revision"))
    if not _is_identifier(state_revision):
        issues.append(
            ClinicalEvidenceIssue(
                "invalid_state_revision",
                "$.state_revision",
                "state_revision must be a valid non-empty identifier",
            )
        )

    raw_run_ids = payload.get("run_ids")
    run_ids = [_as_nonempty_string(item) for item in raw_run_ids] if isinstance(raw_run_ids, list) else []
    if (
        not run_ids
        or len(run_ids) > _MAX_RUNS
        or any(not _is_identifier(item) for item in run_ids)
        or len(run_ids) != len(set(run_ids))
    ):
        issues.append(ClinicalEvidenceIssue("invalid_run_ids", "$.run_ids", "run_ids must be non-empty, unique identifiers"))
    top_run_ids = set(run_ids)

    raw_receipts = list(receipts.values()) if isinstance(receipts, Mapping) else list(receipts or [])
    authority_records = _execution_records(execution_evidence)
    authority_records.extend(
        _execution_records(
            [
                {
                    "tool_name": _as_nonempty_string(
                        receipt.get("command_type") or receipt.get("type")
                    ),
                    "result": receipt,
                }
                for receipt in raw_receipts
                if isinstance(receipt, Mapping)
            ]
        )
    )
    trusted_attestations = [record["attestation"] for record in authority_records]
    trusted_fingerprints = {
        value.lower()
        for record in authority_records
        for value in record["recording_fingerprints"]
        if _is_sha256(value)
    }
    if normalized_expected_fingerprint:
        trusted_fingerprints.add(normalized_expected_fingerprint)
    trusted_run_ids = {
        value for record in authority_records for value in record["run_ids"]
    }
    trusted_state_revisions = {
        value for record in authority_records for value in record["state_revisions"]
    }
    normalized_expected_revision = _as_nonempty_string(expected_state_revision)
    if normalized_expected_revision:
        trusted_state_revisions.add(normalized_expected_revision)

    if not fingerprint or fingerprint.lower() not in trusted_fingerprints:
        issues.append(
            ClinicalEvidenceIssue(
                "unbound_recording_fingerprint",
                "$.recording_fingerprint",
                "recording fingerprint must be attested by this turn's trusted execution evidence",
            )
        )
    if not state_revision or state_revision not in trusted_state_revisions:
        issues.append(
            ClinicalEvidenceIssue(
                "unbound_state_revision",
                "$.state_revision",
                "state revision must be attested by this turn's trusted execution evidence",
            )
        )
    missing_trusted_runs = sorted(top_run_ids - trusted_run_ids)
    if missing_trusted_runs:
        issues.append(
            ClinicalEvidenceIssue(
                "unbound_run_ids",
                "$.run_ids",
                "every declared run must be present in this turn's trusted execution evidence",
            )
        )

    if payload.get("response_language") not in {"en-US", "zh-CN"}:
        issues.append(ClinicalEvidenceIssue("invalid_response_language", "$.response_language", "unsupported response language"))
    if not _as_nonempty_string(payload.get("summary")) or len(str(payload.get("summary") or "")) > 4000:
        issues.append(ClinicalEvidenceIssue("missing_summary", "$.summary", "summary is required"))
    elif not _is_safe_public_text(payload.get("summary")):
        issues.append(ClinicalEvidenceIssue("sensitive_summary", "$.summary", "summary contains a secret, clinical identifier, or raw local path"))
    elif _has_unsupported_summary_claim(payload.get("summary")):
        issues.append(ClinicalEvidenceIssue("unsupported_summary_claim", "$.summary", "summary may not introduce an untyped diagnosis or SOZ assertion"))

    provenance = payload.get("provenance")
    if not isinstance(provenance, Mapping):
        issues.append(ClinicalEvidenceIssue("missing_provenance", "$.provenance", "provenance is required"))
        provenance = {}
    else:
        issues.extend(_unknown_fields(provenance, _PROVENANCE_FIELDS, path="$.provenance"))
    for field in (
        "software_version", "algorithm", "algorithm_version", "parameters", "parameters_sha256",
        "recording", "software_components", "run_scope", "generated_at",
    ):
        if field not in provenance:
            issues.append(ClinicalEvidenceIssue("missing_provenance_field", f"$.provenance.{field}", f"provenance.{field} is required"))
    for field in ("software_version", "algorithm", "algorithm_version"):
        if not _as_nonempty_string(provenance.get(field)):
            issues.append(ClinicalEvidenceIssue(f"invalid_{field}", f"$.provenance.{field}", f"provenance.{field} is required"))

    parameters = provenance.get("parameters")
    parameters_digest = _as_nonempty_string(provenance.get("parameters_sha256"))
    if not isinstance(parameters, Mapping):
        issues.append(ClinicalEvidenceIssue("missing_effective_parameters", "$.provenance.parameters", "effective parameters must be an object"))
    else:
        try:
            expected_digest = _json_sha256(parameters)
        except (TypeError, ValueError):
            expected_digest = ""
        if not _is_sha256(parameters_digest) or parameters_digest.lower() != expected_digest:
            issues.append(
                ClinicalEvidenceIssue(
                    "parameters_digest_mismatch",
                    "$.provenance.parameters_sha256",
                    "parameters_sha256 must match the canonical complete parameter object",
                )
            )

    recording = provenance.get("recording")
    recording_id = ""
    if not isinstance(recording, Mapping):
        issues.append(ClinicalEvidenceIssue("missing_recording_provenance", "$.provenance.recording", "recording provenance is required"))
    else:
        issues.extend(_unknown_fields(recording, _RECORDING_FIELDS, path="$.provenance.recording"))
        recording_id = _as_nonempty_string(recording.get("recording_id"))
        required_recording = {"recording_id", "sha256", "sampling_frequency_hz", "channel_names", "evaluated_interval_seconds"}
        for field in required_recording:
            if field not in recording:
                issues.append(ClinicalEvidenceIssue("missing_recording_field", f"$.provenance.recording.{field}", f"recording.{field} is required"))
        if not _is_identifier(recording_id):
            issues.append(ClinicalEvidenceIssue("invalid_recording_id", "$.provenance.recording.recording_id", "recording_id is invalid"))
        if _as_nonempty_string(recording.get("sha256")).lower() != fingerprint.lower():
            issues.append(ClinicalEvidenceIssue("recording_fingerprint_mismatch", "$.provenance.recording.sha256", "recording SHA-256 must equal the top-level fingerprint"))
        sample_rate = recording.get("sampling_frequency_hz")
        if not isinstance(sample_rate, (int, float)) or isinstance(sample_rate, bool) or not math.isfinite(float(sample_rate)) or sample_rate <= 0:
            issues.append(ClinicalEvidenceIssue("invalid_sampling_frequency", "$.provenance.recording.sampling_frequency_hz", "sampling frequency must be positive"))
            sample_rate = None
        source_uri = recording.get("source_uri")
        if source_uri is not None and not _is_safe_public_uri(source_uri, allowed_schemes={"recording", "urn"}):
            issues.append(ClinicalEvidenceIssue("invalid_source_uri", "$.provenance.recording.source_uri", "source_uri must be an opaque recording or URN reference"))
        nyquist = recording.get("nyquist_hz")
        if nyquist is not None:
            if (
                not isinstance(nyquist, (int, float))
                or isinstance(nyquist, bool)
                or not math.isfinite(float(nyquist))
                or nyquist <= 0
                or (sample_rate is not None and float(nyquist) > float(sample_rate) / 2)
            ):
                issues.append(ClinicalEvidenceIssue("invalid_nyquist", "$.provenance.recording.nyquist_hz", "nyquist_hz must be positive and no greater than half the sample rate"))
        line_frequency = recording.get("line_frequency_hz")
        if line_frequency is not None and (
            not isinstance(line_frequency, (int, float))
            or isinstance(line_frequency, bool)
            or not math.isfinite(float(line_frequency))
            or line_frequency <= 0
        ):
            issues.append(ClinicalEvidenceIssue("invalid_line_frequency", "$.provenance.recording.line_frequency_hz", "line_frequency_hz must be positive"))
        channels = recording.get("channel_names")
        if not isinstance(channels, list) or not channels or len(channels) != len(set(map(str, channels))) or any(not _as_nonempty_string(item) for item in channels):
            issues.append(ClinicalEvidenceIssue("invalid_channel_names", "$.provenance.recording.channel_names", "channel_names must be non-empty and unique"))
        interval = recording.get("evaluated_interval_seconds")
        if not isinstance(interval, Mapping):
            issues.append(ClinicalEvidenceIssue("invalid_evaluated_interval", "$.provenance.recording.evaluated_interval_seconds", "evaluated interval is required"))
        else:
            issues.extend(_unknown_fields(interval, {"start", "end"}, path="$.provenance.recording.evaluated_interval_seconds"))
            start, end = interval.get("start"), interval.get("end")
            if (
                not isinstance(start, (int, float))
                or isinstance(start, bool)
                or not math.isfinite(float(start))
                or not isinstance(end, (int, float))
                or isinstance(end, bool)
                or not math.isfinite(float(end))
                or start < 0
                or end <= start
            ):
                issues.append(ClinicalEvidenceIssue("invalid_evaluated_interval", "$.provenance.recording.evaluated_interval_seconds", "interval end must be greater than start"))
        for optional_text in ("montage", "reference"):
            if optional_text in recording and not _as_nonempty_string(recording.get(optional_text)):
                issues.append(ClinicalEvidenceIssue("invalid_recording_field", f"$.provenance.recording.{optional_text}", f"{optional_text} must be non-empty when provided"))

    components = provenance.get("software_components")
    if not isinstance(components, list) or not components:
        issues.append(ClinicalEvidenceIssue("missing_software_components", "$.provenance.software_components", "software components are required"))
    else:
        for index, component in enumerate(components):
            path = f"$.provenance.software_components[{index}]"
            if not isinstance(component, Mapping):
                issues.append(ClinicalEvidenceIssue("invalid_software_component", path, "component must be an object"))
                continue
            issues.extend(_unknown_fields(component, _SOFTWARE_COMPONENT_FIELDS, path=path))
            if not _as_nonempty_string(component.get("name")) or not _as_nonempty_string(component.get("version")):
                issues.append(ClinicalEvidenceIssue("invalid_software_component", f"$.provenance.software_components[{index}]", "component name and version are required"))
            commit = component.get("commit")
            if commit is not None and len(_as_nonempty_string(commit)) < 7:
                issues.append(ClinicalEvidenceIssue("invalid_component_commit", f"{path}.commit", "component commit must contain at least seven characters"))
            model_digest = component.get("model_digest")
            if model_digest is not None and not _is_sha256(model_digest):
                issues.append(ClinicalEvidenceIssue("invalid_model_digest", f"{path}.model_digest", "model_digest must be a SHA-256 digest"))

    algorithm_details = provenance.get("algorithm_details")
    if algorithm_details is not None:
        path = "$.provenance.algorithm_details"
        if not isinstance(algorithm_details, Mapping):
            issues.append(ClinicalEvidenceIssue("invalid_algorithm_details", path, "algorithm_details must be an object"))
        else:
            issues.extend(_unknown_fields(algorithm_details, _ALGORITHM_DETAIL_FIELDS, path=path))
            for field in ("name", "version", "parameters", "parameters_sha256"):
                if field not in algorithm_details:
                    issues.append(ClinicalEvidenceIssue("missing_algorithm_detail", f"{path}.{field}", f"algorithm_details.{field} is required"))
            detail_parameters = algorithm_details.get("parameters")
            detail_digest = _as_nonempty_string(algorithm_details.get("parameters_sha256"))
            if not isinstance(detail_parameters, Mapping):
                issues.append(ClinicalEvidenceIssue("invalid_algorithm_parameters", f"{path}.parameters", "algorithm parameters must be an object"))
            else:
                try:
                    expected_detail_digest = _json_sha256(detail_parameters)
                except (TypeError, ValueError):
                    expected_detail_digest = ""
                if not _is_sha256(detail_digest) or detail_digest.lower() != expected_detail_digest:
                    issues.append(ClinicalEvidenceIssue("algorithm_parameters_digest_mismatch", f"{path}.parameters_sha256", "algorithm parameter digest must match the complete parameter object"))
            if algorithm_details.get("biomarker") not in {None, "HFO", "Spindle", "Spike", "Other"}:
                issues.append(ClinicalEvidenceIssue("invalid_biomarker", f"{path}.biomarker", "unsupported biomarker"))
            band = algorithm_details.get("filter_band_hz")
            if band is not None:
                if not isinstance(band, Mapping):
                    issues.append(ClinicalEvidenceIssue("invalid_filter_band", f"{path}.filter_band_hz", "filter band must be an object"))
                else:
                    issues.extend(_unknown_fields(band, {"low", "high"}, path=f"{path}.filter_band_hz"))
                    low, high = band.get("low"), band.get("high")
                    if (
                        not isinstance(low, (int, float)) or isinstance(low, bool)
                        or not isinstance(high, (int, float)) or isinstance(high, bool)
                        or not math.isfinite(float(low)) or not math.isfinite(float(high))
                        or low < 0 or high <= low
                    ):
                        issues.append(ClinicalEvidenceIssue("invalid_filter_band", f"{path}.filter_band_hz", "filter band requires finite 0 <= low < high"))
            notch = algorithm_details.get("notch_frequencies_hz")
            if notch is not None and (
                not isinstance(notch, list)
                or any(
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(float(value))
                    or value <= 0
                    for value in notch
                )
            ):
                issues.append(ClinicalEvidenceIssue("invalid_notch_frequencies", f"{path}.notch_frequencies_hz", "notch frequencies must be positive finite numbers"))

    run_scope = provenance.get("run_scope")
    scope_mode = ""
    if not isinstance(run_scope, Mapping):
        issues.append(ClinicalEvidenceIssue("missing_run_scope", "$.provenance.run_scope", "run scope is required"))
    else:
        issues.extend(_unknown_fields(run_scope, _RUN_SCOPE_FIELDS, path="$.provenance.run_scope"))
        scope_mode = _as_nonempty_string(run_scope.get("mode"))
        scope_run_ids = run_scope.get("run_ids")
        if not isinstance(scope_run_ids, list) or [_as_nonempty_string(item) for item in scope_run_ids] != run_ids:
            issues.append(ClinicalEvidenceIssue("run_scope_mismatch", "$.provenance.run_scope.run_ids", "run scope must exactly match top-level run_ids"))
        if scope_mode == "single_run" and len(run_ids) != 1:
            issues.append(ClinicalEvidenceIssue("invalid_single_run_scope", "$.provenance.run_scope", "single_run requires exactly one run"))
        elif scope_mode == "explicit_multi_run":
            if len(run_ids) < 2 or not _as_nonempty_string(run_scope.get("aggregation_method")):
                issues.append(ClinicalEvidenceIssue("invalid_multi_run_scope", "$.provenance.run_scope", "multi-run output requires at least two runs and an aggregation method"))
        elif scope_mode not in {"single_run", "explicit_multi_run"}:
            issues.append(ClinicalEvidenceIssue("invalid_run_scope_mode", "$.provenance.run_scope.mode", "invalid run scope mode"))
    parent_output_ids = provenance.get("parent_output_ids")
    if parent_output_ids is not None and (
        not isinstance(parent_output_ids, list)
        or len(parent_output_ids) != len(set(map(str, parent_output_ids)))
        or any(not _is_identifier(item) for item in parent_output_ids)
    ):
        issues.append(ClinicalEvidenceIssue("invalid_parent_output_ids", "$.provenance.parent_output_ids", "parent_output_ids must be unique identifiers"))
    if not _is_datetime(provenance.get("generated_at")):
        issues.append(ClinicalEvidenceIssue("invalid_generated_at", "$.provenance.generated_at", "generated_at must be a timezone-aware ISO timestamp"))

    algorithm = _as_nonempty_string(provenance.get("algorithm"))
    algorithm_records = [
        record
        for record in authority_records
        if _as_nonempty_string(record["attestation"].get("algorithm")) == algorithm
    ]
    primary_attestation = None
    for record in algorithm_records:
        candidate = record["attestation"]
        if (
            provenance.get("software_version") == candidate.get("software_version")
            and provenance.get("algorithm_version") == candidate.get("algorithm_version")
            and parameters == candidate.get("effective_parameters")
            and parameters_digest == candidate.get("parameters_sha256")
            and components == candidate.get("software_components")
        ):
            primary_attestation = candidate
            break
    if primary_attestation is None:
        issues.append(
            ClinicalEvidenceIssue(
                "unbound_execution_provenance",
                "$.provenance",
                "software, algorithm, version, effective parameters, and components must exactly match one adapter-owned execution attestation",
            )
        )

    recording_fragments = [
        attestation.get("recording_metadata")
        for attestation in trusted_attestations
        if isinstance(attestation.get("recording_metadata"), Mapping)
        and (
            not fingerprint
            or fingerprint
            in {
                _as_nonempty_string(attestation.get("recording_fingerprint")),
                _as_nonempty_string(attestation.get("source_recording_fingerprint")),
            }
        )
    ]
    if isinstance(recording, Mapping):
        for field, value in recording.items():
            if field == "sha256":
                continue
            supported = any(
                field in fragment and _value_supported_by_result(value, fragment[field])
                for fragment in recording_fragments
            )
            if not supported and field == "source_uri":
                supported = any(
                    _value_supported_by_result(value, record["result"])
                    for record in authority_records
                )
            if not supported:
                issues.append(
                    ClinicalEvidenceIssue(
                        "unbound_recording_metadata",
                        f"$.provenance.recording.{field}",
                        "recording metadata must be present in an adapter-owned execution attestation for this recording",
                    )
                )

    if isinstance(algorithm_details, Mapping):
        if (
            _as_nonempty_string(algorithm_details.get("name")) != algorithm
            or _as_nonempty_string(algorithm_details.get("version"))
            != _as_nonempty_string(provenance.get("algorithm_version"))
            or algorithm_details.get("parameters") != parameters
            or _as_nonempty_string(algorithm_details.get("parameters_sha256")) != parameters_digest
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "unbound_algorithm_details",
                    "$.provenance.algorithm_details",
                    "algorithm details must repeat the adapter-attested algorithm/version/parameters exactly",
                )
            )
        selected_results = [record["result"] for record in algorithm_records]
        for field in set(algorithm_details) - {"name", "version", "parameters", "parameters_sha256"}:
            if not any(
                _value_supported_by_result(algorithm_details[field], result)
                or _value_supported_by_result(algorithm_details[field], parameters)
                for result in selected_results
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "unbound_algorithm_detail",
                        f"$.provenance.algorithm_details.{field}",
                        "algorithm detail must be present in the selected trusted tool result or effective parameters",
                    )
                )

    evidence_raw = payload.get("evidence")
    evidence_items = evidence_raw if isinstance(evidence_raw, list) else []
    if not isinstance(evidence_raw, list):
        issues.append(ClinicalEvidenceIssue("invalid_evidence", "$.evidence", "evidence must be an array"))
    elif not evidence_items:
        issues.append(ClinicalEvidenceIssue("missing_evidence", "$.evidence", "at least one trusted evidence item is required"))
    elif len(evidence_items) > _MAX_EVIDENCE:
        issues.append(ClinicalEvidenceIssue("too_many_evidence_items", "$.evidence", "evidence exceeds the bounded public contract"))
    evidence_index: dict[str, Mapping[str, Any]] = {}
    bound_evidence_records: dict[str, list[Mapping[str, Any]]] = {}
    for index, item in enumerate(evidence_items):
        path = f"$.evidence[{index}]"
        if not isinstance(item, Mapping):
            issues.append(ClinicalEvidenceIssue("invalid_evidence_item", path, "evidence item must be an object"))
            continue
        issues.extend(_unknown_fields(item, _EVIDENCE_FIELDS, path=path))
        evidence_id = _as_nonempty_string(item.get("evidence_id"))
        if not _is_identifier(evidence_id) or evidence_id in evidence_index:
            issues.append(ClinicalEvidenceIssue("invalid_evidence_id", f"{path}.evidence_id", "evidence_id must be valid and unique"))
        else:
            evidence_index[evidence_id] = item
        if item.get("kind") not in _EVIDENCE_KINDS:
            issues.append(ClinicalEvidenceIssue("invalid_evidence_kind", f"{path}.kind", "unsupported evidence kind"))
        if not _as_nonempty_string(item.get("source")) or "value" not in item:
            issues.append(ClinicalEvidenceIssue("incomplete_evidence", path, "evidence source and value are required"))
        if recording_id and _as_nonempty_string(item.get("recording_id")) != recording_id:
            issues.append(ClinicalEvidenceIssue("evidence_recording_mismatch", f"{path}.recording_id", "evidence must bind to the provenance recording"))
        item_run_id = _as_nonempty_string(item.get("run_id"))
        if item_run_id and item_run_id not in top_run_ids:
            issues.append(ClinicalEvidenceIssue("unknown_evidence_run", f"{path}.run_id", "evidence run_id is not declared"))
        if item.get("kind") in _RUN_BOUND_EVIDENCE_KINDS and not item_run_id:
            issues.append(ClinicalEvidenceIssue("missing_evidence_run", f"{path}.run_id", "computed evidence must bind to an explicit run"))
        for identifier_field in ("event_id", "artifact_id"):
            if identifier_field in item and not _is_identifier(item.get(identifier_field)):
                issues.append(ClinicalEvidenceIssue("invalid_evidence_identifier", f"{path}.{identifier_field}", f"{identifier_field} is invalid"))
        for text_field in ("channel", "unit", "source_uri"):
            if text_field in item and not _as_nonempty_string(item.get(text_field)):
                issues.append(ClinicalEvidenceIssue("invalid_evidence_field", f"{path}.{text_field}", f"{text_field} must be non-empty when provided"))
        if "source_uri" in item and not _is_safe_public_uri(
            item.get("source_uri"),
            allowed_schemes={"artifact", "https", "urn"},
        ):
            issues.append(ClinicalEvidenceIssue("unsafe_evidence_uri", f"{path}.source_uri", "evidence URI must be a safe public or opaque reference"))
        if item.get("kind") == "artifact" and not _is_identifier(item.get("artifact_id")):
            issues.append(ClinicalEvidenceIssue("missing_evidence_artifact", f"{path}.artifact_id", "artifact evidence must identify its artifact"))
        if item.get("kind") == "severity_score":
            severity_error = _severity_score_contract_error(item.get("value"))
            if severity_error:
                issues.append(
                    ClinicalEvidenceIssue(
                        "invalid_severity_evidence",
                        f"{path}.value",
                        severity_error,
                    )
                )

        event_id = _as_nonempty_string(item.get("event_id"))
        hidden_run_ids = _trusted_values(
            item.get("value"),
            {"run_id", "run_ids", "active_run_id", "accepted_run_id", "detection_run_id"},
        )
        hidden_event_ids = _trusted_values(item.get("value"), {"event_id", "event_ids"})
        if hidden_run_ids and (not item_run_id or hidden_run_ids != {item_run_id}):
            issues.append(
                ClinicalEvidenceIssue(
                    "evidence_scope_mismatch",
                    f"{path}.value",
                    "run scope may not be hidden in evidence.value and must exactly match the top-level run_id",
                )
            )
        if hidden_event_ids and (not event_id or hidden_event_ids != {event_id}):
            issues.append(
                ClinicalEvidenceIssue(
                    "evidence_scope_mismatch",
                    f"{path}.value",
                    "event scope may not be hidden in evidence.value and must exactly match the top-level event_id",
                )
            )
        if (
            _as_nonempty_string(item.get("source")) == "events.stage_annotation"
            and item.get("kind") in {"human_review", "annotation"}
            and not event_id
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "missing_evidence_event",
                    f"{path}.event_id",
                    "event annotation evidence must expose exactly one reviewed event_id",
                )
            )

        source = _as_nonempty_string(item.get("source"))
        matching_authority = []
        for record in authority_records:
            source_matches = record["tool_name"] == source
            if not source_matches:
                continue
            if item.get("kind") not in record["evidence_kinds"]:
                continue
            record_fingerprints = {
                value.lower() for value in record["recording_fingerprints"] if _is_sha256(value)
            }
            if record_fingerprints and fingerprint.lower() not in record_fingerprints:
                continue
            if not record_fingerprints and item.get("kind") not in {"human_review", "annotation"}:
                continue
            if record["state_revisions"] and state_revision not in record["state_revisions"]:
                continue
            if item_run_id and item_run_id not in record["run_ids"]:
                continue
            if event_id and event_id not in record["event_ids"]:
                continue
            if not (
                _value_supported_by_result(item.get("value"), record["result"])
                or (
                    item.get("kind") == "severity_score"
                    and _severity_value_supported_by_record(item.get("value"), record)
                )
                or _value_supported_by_result(item.get("value"), record["artifacts"])
            ):
                continue
            if not _evidence_metadata_supported(item, record):
                continue
            matching_authority.append(record)
        if not matching_authority:
            issues.append(
                ClinicalEvidenceIssue(
                    "unbound_evidence_item",
                    path,
                    "evidence source, scope, and value must be present in a trusted tool result or review receipt from this turn",
                )
            )
        elif evidence_id:
            bound_evidence_records[evidence_id] = matching_authority

    claims_raw = payload.get("claims")
    claims = claims_raw if isinstance(claims_raw, list) else []
    if not isinstance(claims_raw, list):
        issues.append(ClinicalEvidenceIssue("invalid_claims", "$.claims", "claims must be an array"))
    elif not claims:
        issues.append(ClinicalEvidenceIssue("missing_claims", "$.claims", "at least one typed evidence-linked claim is required"))
    elif len(claims) > _MAX_CLAIMS:
        issues.append(ClinicalEvidenceIssue("too_many_claims", "$.claims", "claims exceed the bounded public contract"))
    indexed_receipts = _receipt_index(receipts)
    seen_claim_ids: set[str] = set()
    for index, claim in enumerate(claims):
        path = f"$.claims[{index}]"
        if not isinstance(claim, Mapping):
            issues.append(ClinicalEvidenceIssue("invalid_claim", path, "claim must be an object"))
            continue
        issues.extend(_unknown_fields(claim, _CLAIM_FIELDS, path=path))
        claim_id = _as_nonempty_string(claim.get("claim_id"))
        if not _is_identifier(claim_id) or claim_id in seen_claim_ids:
            issues.append(ClinicalEvidenceIssue("invalid_claim_id", f"{path}.claim_id", "claim_id must be valid and unique"))
        else:
            seen_claim_ids.add(claim_id)
        kind = _as_nonempty_string(claim.get("kind"))
        status = _as_nonempty_string(claim.get("epistemic_status"))
        assertion = _as_nonempty_string(claim.get("assertion"))
        if kind not in _CLAIM_KINDS:
            issues.append(ClinicalEvidenceIssue("invalid_claim_kind", f"{path}.kind", "unsupported claim kind"))
        if status not in _EPISTEMIC_STATUSES:
            issues.append(ClinicalEvidenceIssue("invalid_epistemic_status", f"{path}.epistemic_status", "unsupported epistemic status"))
        if not assertion or len(assertion) > 4000:
            issues.append(ClinicalEvidenceIssue("missing_assertion", f"{path}.assertion", "claim assertion is required"))
        elif not _is_safe_public_text(assertion):
            issues.append(ClinicalEvidenceIssue("sensitive_assertion", f"{path}.assertion", "claim assertion contains a secret, clinical identifier, or raw local path"))
        if kind == "summary" and (
            _DIAGNOSTIC_LANGUAGE_RE.search(assertion)
            or _CASE_SPECIFIC_RESULT_RE.search(assertion)
            or _UNTYPED_NUMERIC_RESULT_RE.search(assertion)
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "unsupported_summary_claim",
                    f"{path}.assertion",
                    "summary-kind claims may not carry case-specific, diagnostic, SOZ, or numeric findings",
                )
            )
        if _SOZ_LANGUAGE_RE.search(assertion) and kind != "soz":
            issues.append(
                ClinicalEvidenceIssue(
                    "claim_kind_mismatch",
                    f"{path}.kind",
                    "SOZ or seizure-focus assertions must use the SOZ claim contract",
                )
            )
        if (
            _DIAGNOSTIC_LANGUAGE_RE.search(assertion)
            and not _SOZ_LANGUAGE_RE.search(assertion)
            and _has_unsupported_summary_claim(assertion)
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "unsupported_diagnostic_claim",
                    f"{path}.assertion",
                    "research output may not assert epilepsy, pathology, or epileptogenicity as a diagnosis",
                )
            )
        if _UNTYPED_NUMERIC_RESULT_RE.search(assertion) and kind != "numeric":
            issues.append(
                ClinicalEvidenceIssue(
                    "numeric_claim_kind_mismatch",
                    f"{path}.kind",
                    "detected counts must use the numeric claim contract",
                )
            )

        evidence_refs = claim.get("evidence_refs")
        refs = [_as_nonempty_string(item) for item in evidence_refs] if isinstance(evidence_refs, list) else []
        if not isinstance(evidence_refs, list) or len(refs) != len(set(refs)):
            issues.append(ClinicalEvidenceIssue("invalid_evidence_refs", f"{path}.evidence_refs", "evidence_refs must be a unique array"))
        if status != "hypothesis" and not refs:
            issues.append(ClinicalEvidenceIssue("missing_evidence_refs", f"{path}.evidence_refs", "non-hypothesis claims require evidence"))
        if any(reference not in evidence_index for reference in refs):
            issues.append(ClinicalEvidenceIssue("unresolved_evidence_ref", f"{path}.evidence_refs", "all evidence references must resolve"))
        referenced_evidence = [
            evidence_index[reference] for reference in refs if reference in evidence_index
        ]
        bound_semantic_evidence = [
            _evidence_semantic_projection(evidence_index[reference])
            for reference in refs
            if reference in evidence_index and reference in bound_evidence_records
        ]
        if status != "hypothesis" and any(reference not in bound_evidence_records for reference in refs):
            issues.append(
                ClinicalEvidenceIssue(
                    "claim_references_unbound_evidence",
                    f"{path}.evidence_refs",
                    "every non-hypothesis claim must reference evidence bound to this turn's trusted execution ledger",
                )
            )
        required_evidence_kinds = _CLAIM_EVIDENCE_KINDS.get(kind)
        if (
            status != "hypothesis"
            and required_evidence_kinds is not None
            and not any(item.get("kind") in required_evidence_kinds for item in referenced_evidence)
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "claim_evidence_kind_mismatch",
                    f"{path}.evidence_refs",
                    "claim kind is not supported by the typed evidence it references",
                )
            )
        if (
            status != "hypothesis"
            and kind != "summary"
            and referenced_evidence
            and not _claim_semantics_supported(
                assertion,
                [
                    *bound_semantic_evidence,
                    *(
                        [{"review_command_payload": claim.get("review_command_payload")}]
                        if status in {"reviewed", "confirmed"}
                        and isinstance(claim.get("review_command_payload"), Mapping)
                        else []
                    ),
                ],
            )
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "unbound_claim_semantics",
                    f"{path}.assertion",
                    "case identifiers and finding terms in the assertion must be present in referenced trusted evidence",
                )
            )

        claim_run_raw = claim.get("run_ids")
        claim_run_ids = [_as_nonempty_string(item) for item in claim_run_raw] if isinstance(claim_run_raw, list) else []
        if not isinstance(claim_run_raw, list) or len(claim_run_ids) != len(set(claim_run_ids)) or any(item not in top_run_ids for item in claim_run_ids):
            issues.append(ClinicalEvidenceIssue("invalid_claim_run_ids", f"{path}.run_ids", "claim run_ids must be unique and declared"))
        if status != "hypothesis" and kind != "summary" and not claim_run_ids:
            issues.append(ClinicalEvidenceIssue("missing_claim_run_ids", f"{path}.run_ids", "case claims require an explicit run"))
        for reference in refs:
            referenced = evidence_index.get(reference)
            if not referenced:
                continue
            evidence_run_id = _as_nonempty_string(referenced.get("run_id"))
            if evidence_run_id and claim_run_ids and evidence_run_id not in claim_run_ids:
                issues.append(ClinicalEvidenceIssue("claim_evidence_run_mismatch", f"{path}.evidence_refs", "referenced evidence must belong to one of the claim runs"))

        assertion_requires_review = bool(
            _REVIEW_AUTHORITY_LANGUAGE_RE.search(assertion)
            and not _NEGATED_REVIEW_AUTHORITY_RE.search(assertion)
        )
        if assertion_requires_review and status not in {"reviewed", "confirmed"}:
            issues.append(
                ClinicalEvidenceIssue(
                    "review_language_status_mismatch",
                    f"{path}.epistemic_status",
                    "confirmed, accepted, adjudicated, or reviewed wording requires a reviewed/confirmed epistemic status",
                )
            )
        if status in {"reviewed", "confirmed"} or assertion_requires_review:
            issues.extend(
                _validate_review_binding(
                    claim=claim,
                    path=path,
                    indexed_receipts=indexed_receipts,
                    conversation_id=_as_nonempty_string(payload.get("conversation_id")),
                    state_revision=state_revision,
                    request_id=_as_nonempty_string(payload.get("request_id")),
                    message_id=_as_nonempty_string(payload.get("message_id")),
                    evidence_index=evidence_index,
                )
            )
        if kind == "candidate" and (status == "confirmed" or assertion_requires_review) and not claim.get("review_receipt_id"):
            issues.append(ClinicalEvidenceIssue("candidate_confirmation_without_receipt", f"{path}.review_receipt_id", "confirmed candidates require clinician review proof"))

        if kind == "qc" and _DIAGNOSTIC_LANGUAGE_RE.search(assertion) and _has_unsupported_summary_claim(assertion):
            issues.append(ClinicalEvidenceIssue("qc_cannot_diagnose", f"{path}.assertion", "QC assertions may describe technical quality, not diagnosis"))
        if kind == "anatomy" and not _has_supported_localization_evidence(claim, evidence_index, soz=False):
            issues.append(ClinicalEvidenceIssue("unsupported_anatomy_claim", f"{path}.evidence_refs", "anatomy claims require explicit mapping provenance"))
        if kind == "soz" and not _has_supported_localization_evidence(claim, evidence_index, soz=True):
            issues.append(ClinicalEvidenceIssue("unsupported_soz_claim", f"{path}.evidence_refs", "SOZ claims require explicit clinician review provenance"))
        if kind == "soz" and status not in {"reviewed", "confirmed"}:
            issues.append(ClinicalEvidenceIssue("soz_inference_forbidden", f"{path}.epistemic_status", "SOZ requires an explicit terminal clinician localization receipt and may not be inferred or merely observed"))
        if kind == "soz" and not claim.get("review_receipt_id"):
            issues.append(ClinicalEvidenceIssue("soz_requires_review_receipt", f"{path}.review_receipt_id", "SOZ claims require a dedicated terminal clinician localization receipt"))
        if kind == "ranking" and len(claim_run_ids) != 1:
            issues.append(ClinicalEvidenceIssue("ranking_requires_single_run", f"{path}.run_ids", "ranking must bind to exactly one run"))
        if kind == "comparison" and len(claim_run_ids) < 2:
            issues.append(ClinicalEvidenceIssue("comparison_requires_multiple_runs", f"{path}.run_ids", "comparison requires at least two explicit runs"))
        if kind == "comparison":
            evidence_run_ids = {
                _as_nonempty_string(item.get("run_id"))
                for item in referenced_evidence
                if _as_nonempty_string(item.get("run_id"))
            }
            if not set(claim_run_ids) <= evidence_run_ids:
                issues.append(
                    ClinicalEvidenceIssue(
                        "comparison_evidence_scope_incomplete",
                        f"{path}.evidence_refs",
                        "comparison claims require referenced evidence from every compared run",
                    )
                )
        if kind == "numeric":
            value = claim.get("value")
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(float(value)):
                issues.append(ClinicalEvidenceIssue("missing_value", f"{path}.value", "numeric claims require a finite value"))
            elif not any(
                _numeric_claim_value_supported(value, item, assertion)
                for item in referenced_evidence
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "unbound_numeric_value",
                        f"{path}.value",
                        "numeric claim value must be present in the referenced trusted evidence value",
                    )
                )
            assertion_numbers = _numeric_result_values(assertion)
            if (
                assertion_numbers
                and isinstance(value, (int, float))
                and not isinstance(value, bool)
                and assertion_numbers != {_normalize_numeric_token(value)}
            ):
                issues.append(
                    ClinicalEvidenceIssue(
                        "numeric_assertion_mismatch",
                        f"{path}.assertion",
                        "detected count in the assertion must exactly equal the structured numeric value",
                    )
                )
            if not _as_nonempty_string(claim.get("units")):
                issues.append(ClinicalEvidenceIssue("missing_units", f"{path}.units", "numeric claims require units"))
            if not _as_nonempty_string(claim.get("denominator")):
                issues.append(ClinicalEvidenceIssue("missing_denominator", f"{path}.denominator", "numeric claims require a denominator"))
            scope = claim.get("scope")
            if not isinstance(scope, Mapping) or scope.get("level") not in {"recording", "run", "channel", "event", "interval", "cohort"}:
                issues.append(ClinicalEvidenceIssue("missing_scope", f"{path}.scope", "numeric claims require a valid scope"))
            else:
                issues.extend(_unknown_fields(scope, _NUMERIC_SCOPE_FIELDS, path=f"{path}.scope"))
                scoped_recording = _as_nonempty_string(scope.get("recording_id"))
                if scoped_recording and scoped_recording != recording_id:
                    issues.append(ClinicalEvidenceIssue("numeric_scope_recording_mismatch", f"{path}.scope.recording_id", "numeric scope recording must match provenance"))
                scoped_run = _as_nonempty_string(scope.get("run_id"))
                if scoped_run and scoped_run not in claim_run_ids:
                    issues.append(ClinicalEvidenceIssue("numeric_scope_run_mismatch", f"{path}.scope.run_id", "numeric scope run must match the claim"))
                interval_scope = scope.get("interval_seconds")
                if interval_scope is not None:
                    if not isinstance(interval_scope, Mapping):
                        issues.append(ClinicalEvidenceIssue("invalid_numeric_interval", f"{path}.scope.interval_seconds", "numeric interval must be an object"))
                    else:
                        issues.extend(_unknown_fields(interval_scope, {"start", "end"}, path=f"{path}.scope.interval_seconds"))
                        start, end = interval_scope.get("start"), interval_scope.get("end")
                        if (
                            not isinstance(start, (int, float)) or isinstance(start, bool)
                            or not isinstance(end, (int, float)) or isinstance(end, bool)
                            or not math.isfinite(float(start)) or not math.isfinite(float(end))
                            or start < 0 or end <= start
                        ):
                            issues.append(ClinicalEvidenceIssue("invalid_numeric_interval", f"{path}.scope.interval_seconds", "numeric interval end must be greater than start"))
            if claim.get("partial_failure_status") not in {"none", "partial", "unknown"}:
                issues.append(ClinicalEvidenceIssue("missing_partial_failure_status", f"{path}.partial_failure_status", "numeric claims must disclose partial-failure status"))

        claim_limitations = claim.get("limitations")
        if claim_limitations is not None and (
            not isinstance(claim_limitations, list)
            or any(not _as_nonempty_string(item) for item in claim_limitations)
        ):
            issues.append(ClinicalEvidenceIssue("invalid_claim_limitations", f"{path}.limitations", "claim limitations must be non-empty strings"))
        elif isinstance(claim_limitations, list) and any(
            not _is_safe_public_text(item) for item in claim_limitations
        ):
            issues.append(ClinicalEvidenceIssue("sensitive_claim_limitation", f"{path}.limitations", "claim limitations contain sensitive text"))
        elif isinstance(claim_limitations, list) and any(
            not _text_semantics_subset_of_claims(item, [claim])
            for item in claim_limitations
        ):
            issues.append(
                ClinicalEvidenceIssue(
                    "unbound_claim_limitation",
                    f"{path}.limitations",
                    "claim limitations may qualify this claim but may not introduce a new channel, event, run, or finding",
                )
            )
        confidence = claim.get("confidence")
        if confidence is not None and (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not math.isfinite(float(confidence))
            or not 0 <= confidence <= 1
        ):
            issues.append(ClinicalEvidenceIssue("invalid_confidence", f"{path}.confidence", "confidence must be between zero and one"))

    structured_claims = [claim for claim in claims if isinstance(claim, Mapping)]
    if (
        _as_nonempty_string(payload.get("summary"))
        and not _text_semantics_subset_of_claims(payload.get("summary"), structured_claims)
    ):
        issues.append(
            ClinicalEvidenceIssue(
                "unbound_summary_semantics",
                "$.summary",
                "the visible summary may only project identifiers and findings already present in validated structured claims",
            )
        )

    summary_numbers = _numeric_result_values(payload.get("summary"))
    supported_summary_numbers: set[str] = set()
    for claim in claims:
        if not isinstance(claim, Mapping) or claim.get("kind") != "numeric":
            continue
        supported_summary_numbers.update(_numeric_result_values(claim.get("assertion")))
        numeric_value = claim.get("value")
        if isinstance(numeric_value, (int, float)) and not isinstance(numeric_value, bool):
            supported_summary_numbers.add(str(numeric_value))
            if float(numeric_value).is_integer():
                supported_summary_numbers.add(str(int(numeric_value)))
    if summary_numbers - supported_summary_numbers:
        issues.append(
            ClinicalEvidenceIssue(
                "unsupported_summary_claim",
                "$.summary",
                "case-specific detected counts in the summary require a matching evidence-bound numeric claim",
            )
        )
    if _SOZ_LANGUAGE_RE.search(_as_nonempty_string(payload.get("summary"))) and not any(
        isinstance(claim, Mapping) and claim.get("kind") == "soz" for claim in claims
    ):
        issues.append(
            ClinicalEvidenceIssue(
                "unsupported_summary_claim",
                "$.summary",
                "SOZ or seizure-focus language in the summary requires a validated SOZ claim",
            )
        )

    guardrails = payload.get("guardrails")
    expected_guardrails = {
        "intended_use": "research_only",
        "diagnostic_status": "not_a_clinical_diagnosis",
        "candidate_terminology": "detector_candidates_are_not_confirmed_hfo",
        "soz_inference": "not_performed",
    }
    if not isinstance(guardrails, Mapping):
        issues.append(ClinicalEvidenceIssue("missing_guardrails", "$.guardrails", "clinical guardrails are required"))
    else:
        issues.extend(_unknown_fields(guardrails, _GUARDRAIL_FIELDS, path="$.guardrails"))
        for key, expected in expected_guardrails.items():
            if guardrails.get(key) != expected:
                issues.append(ClinicalEvidenceIssue("invalid_guardrail", f"$.guardrails.{key}", f"guardrail must equal {expected}"))
        if guardrails.get("anatomy_inference") not in {"not_performed", "explicit_source_only"}:
            issues.append(ClinicalEvidenceIssue("invalid_guardrail", "$.guardrails.anatomy_inference", "invalid anatomy guardrail"))
        expected_aggregation = "explicit_multi_run" if scope_mode == "explicit_multi_run" else "single_run"
        if guardrails.get("aggregation_scope") != expected_aggregation:
            issues.append(ClinicalEvidenceIssue("aggregation_guardrail_mismatch", "$.guardrails.aggregation_scope", "aggregation guardrail must match run scope"))

    limitations = payload.get("limitations")
    if (
        not isinstance(limitations, list)
        or not limitations
        or len(limitations) > _MAX_LIMITATIONS
        or any(not _as_nonempty_string(item) or len(str(item)) > 2000 for item in limitations)
    ):
        issues.append(ClinicalEvidenceIssue("missing_limitations", "$.limitations", "at least one limitation is required"))
    elif any(not _is_safe_public_text(item) for item in limitations):
        issues.append(ClinicalEvidenceIssue("sensitive_limitation", "$.limitations", "limitations contain a secret, clinical identifier, or raw local path"))
    elif any(
        not _text_semantics_subset_of_claims(item, structured_claims)
        for item in limitations
    ):
        issues.append(
            ClinicalEvidenceIssue(
                "unbound_limitation_semantics",
                "$.limitations",
                "limitations may qualify validated claims but may not introduce a new channel, event, run, or finding",
            )
        )

    artifacts = payload.get("artifacts")
    attested_artifacts = [
        artifact
        for record in authority_records
        for artifact in record["artifacts"]
        if isinstance(artifact, Mapping)
    ]
    if not isinstance(artifacts, list):
        issues.append(ClinicalEvidenceIssue("invalid_artifacts", "$.artifacts", "artifacts must be an array"))
    else:
        if len(artifacts) > _MAX_ARTIFACTS:
            issues.append(ClinicalEvidenceIssue("too_many_artifacts", "$.artifacts", "artifacts exceed the bounded public contract"))
        seen_artifact_ids: set[str] = set()
        for index, artifact in enumerate(artifacts):
            path = f"$.artifacts[{index}]"
            if not isinstance(artifact, Mapping):
                issues.append(ClinicalEvidenceIssue("invalid_artifact", path, "artifact must be an object"))
                continue
            issues.extend(_unknown_fields(artifact, _ARTIFACT_FIELDS, path=path))
            artifact_id = _as_nonempty_string(artifact.get("artifact_id"))
            if not _is_identifier(artifact_id) or artifact_id in seen_artifact_ids:
                issues.append(ClinicalEvidenceIssue("invalid_artifact_id", f"{path}.artifact_id", "artifact_id must be valid and unique"))
            else:
                seen_artifact_ids.add(artifact_id)
            for field in ("kind", "uri", "created_by"):
                if not _as_nonempty_string(artifact.get(field)):
                    issues.append(ClinicalEvidenceIssue("incomplete_artifact", f"{path}.{field}", f"artifact {field} is required"))
            if not _is_safe_public_uri(artifact.get("uri"), allowed_schemes={"artifact", "https", "urn"}):
                issues.append(ClinicalEvidenceIssue("unsafe_artifact_uri", f"{path}.uri", "artifact URI must be a safe public or opaque reference"))
            if artifact.get("kind") not in _ARTIFACT_KINDS:
                issues.append(ClinicalEvidenceIssue("invalid_artifact_kind", f"{path}.kind", "unsupported artifact kind"))
            if not _is_sha256(artifact.get("sha256")):
                issues.append(ClinicalEvidenceIssue("invalid_artifact_sha256", f"{path}.sha256", "artifact SHA-256 is required"))
            if not _is_datetime(artifact.get("created_at")):
                issues.append(ClinicalEvidenceIssue("invalid_artifact_timestamp", f"{path}.created_at", "artifact created_at is invalid"))
            artifact_run = _as_nonempty_string(artifact.get("run_id"))
            if artifact_run and artifact_run not in top_run_ids:
                issues.append(ClinicalEvidenceIssue("unknown_artifact_run", f"{path}.run_id", "artifact run_id is not declared"))
            if not any(dict(artifact) == dict(attested) for attested in attested_artifacts):
                issues.append(
                    ClinicalEvidenceIssue(
                        "unbound_artifact",
                        path,
                        "artifact identity, URI, digest, creator, timestamp, and run must exactly match an adapter-owned artifact attestation",
                    )
                )
        for index, item in enumerate(evidence_items):
            if not isinstance(item, Mapping) or item.get("kind") != "artifact":
                continue
            artifact_id = _as_nonempty_string(item.get("artifact_id"))
            if artifact_id not in seen_artifact_ids:
                issues.append(
                    ClinicalEvidenceIssue(
                        "unresolved_artifact_evidence",
                        f"$.evidence[{index}].artifact_id",
                        "artifact evidence must reference an artifact declared in this output and attested by the execution ledger",
                    )
                )

    return tuple(issues)


def render_research_output(payload: Mapping[str, Any]) -> str:
    """Render validated research output without introducing new claims."""

    language = payload.get("response_language")
    labels = {
        "en-US": {
            "findings": "Evidence-linked findings",
            "evidence": "evidence",
            "runs": "runs",
            "limitations": "Limitations",
            "footer": "Research use only; this output is not a clinical diagnosis.",
            "truncated": "Additional machine-readable claims are attached in the structured research output.",
        },
        "zh-CN": {
            "findings": "证据关联结果",
            "evidence": "证据",
            "runs": "运行",
            "limitations": "局限性",
            "footer": "仅供研究使用；本输出不构成临床诊断。",
            "truncated": "其余机器可读声明保存在随附的结构化研究输出中。",
        },
    }["zh-CN" if language == "zh-CN" else "en-US"]

    def compact(value: Any) -> str:
        return re.sub(r"\s+", " ", _as_nonempty_string(value))

    sections = [compact(payload.get("summary"))]
    claims = payload.get("claims") if isinstance(payload.get("claims"), list) else []
    if claims:
        claim_lines: list[str] = []
        claim_chars = 0
        for claim in claims:
            if not isinstance(claim, Mapping):
                continue
            assertion = compact(claim.get("assertion"))
            status = compact(claim.get("epistemic_status"))
            refs = ", ".join(compact(value) for value in (claim.get("evidence_refs") or []))
            runs = ", ".join(compact(value) for value in (claim.get("run_ids") or []))
            line = f"- [{status}] {assertion} ({labels['evidence']}: {refs or '—'}; {labels['runs']}: {runs or '—'})"
            if claim_chars + len(line) > 16_000:
                claim_lines.append(f"- {labels['truncated']}")
                break
            claim_lines.append(line)
            claim_chars += len(line)
        sections.append(f"{labels['findings']}:\n" + "\n".join(claim_lines))

    limitation_lines = [
        f"- {compact(item)}"
        for item in (payload.get("limitations") or [])
        if compact(item)
    ]
    sections.append(f"{labels['limitations']}:\n" + "\n".join(limitation_lines))
    sections.append(labels["footer"])
    return "\n\n".join(section for section in sections if section).strip()


def find_research_output(step_results: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Return the single canonical structured output, rejecting ambiguity."""

    candidates: list[Mapping[str, Any]] = []
    for step_result in step_results.values():
        if getattr(step_result, "success", False) is not True:
            continue
        output = getattr(step_result, "output", None)
        structured = output.get("structured_output") if isinstance(output, Mapping) else None
        if not isinstance(structured, Mapping):
            continue
        schema_version = _as_nonempty_string(structured.get("schema_version"))
        if schema_version == "research-output.v1":
            candidates.append(structured)
        elif schema_version.startswith("research-output."):
            raise ResearchOutputContractError(
                [
                    ClinicalEvidenceIssue(
                        "unsupported_schema_version",
                        "$.schema_version",
                        "unsupported research output versions cannot be treated as generic structured output",
                    )
                ]
            )
    if not candidates:
        return None
    if len(candidates) != 1:
        raise ResearchOutputContractError(
            [ClinicalEvidenceIssue("ambiguous_research_output", "$", "exactly one final research output is allowed")]
        )
    return candidates[0]


def evidence_codes(issues: Iterable[ClinicalEvidenceIssue]) -> frozenset[str]:
    return frozenset(issue.code for issue in issues)
