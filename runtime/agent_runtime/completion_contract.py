from __future__ import annotations

import copy
import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Mapping, Sequence

from runtime.skills.models import ExecutionStep


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)\s*```", re.IGNORECASE)
_ANNOTATION_KEYWORDS = {
    "$schema", "$id", "$defs", "definitions", "title", "description",
    "default", "examples", "deprecated", "readOnly", "writeOnly",
    "x-ieeg-completion",
}
_ASSERTION_KEYWORDS = {
    "$ref", "type", "enum", "const", "properties", "required",
    "additionalProperties", "minProperties", "maxProperties", "items",
    "minItems", "maxItems", "uniqueItems", "minLength", "maxLength",
    "pattern", "minimum", "maximum", "exclusiveMinimum",
    "exclusiveMaximum", "allOf", "anyOf", "oneOf", "not",
}
_RESEARCH_OUTPUT_SCHEMA_VERSION = "research-output.v1"
_RESEARCH_OUTPUT_COMPLETION_TAG = "research-output.v1"
_RESEARCH_OUTPUT_SCHEMA_PATH = (
    Path(__file__).resolve().parents[2]
    / "contracts"
    / "agent"
    / "schemas"
    / "research-output-v1.schema.json"
)


@dataclass(frozen=True)
class CompletionValidation:
    ok: bool
    parsed_output: Any = None
    errors: tuple[str, ...] = ()


def _normalize_canonical_completion_schema(value: Any) -> Any:
    """Project the canonical schema into the runtime validator's dialect.

    The public contract is Draft 2020-12 and intentionally carries annotations
    that do not belong in the small, fail-closed completion validator.  We drop
    annotations and rewrite ``if``/``then``/``else`` into the already-supported
    boolean combinators instead of silently accepting unsupported keywords.
    The full clinical validator remains the final authority after completion.
    """

    if isinstance(value, list):
        return [_normalize_canonical_completion_schema(item) for item in value]
    if not isinstance(value, Mapping):
        return value

    condition = value.get("if")
    then_branch = value.get("then")
    else_branch = value.get("else")
    normalized: dict[str, Any] = {}
    for key, item in value.items():
        if key in {"if", "then", "else", "format"} or str(key).startswith("x-"):
            continue
        normalized[str(key)] = _normalize_canonical_completion_schema(item)

    if condition is not None:
        normalized_condition = _normalize_canonical_completion_schema(condition)
        normalized_then = _normalize_canonical_completion_schema(then_branch or {})
        if else_branch is None:
            conditional = {
                "anyOf": [
                    {"not": normalized_condition},
                    normalized_then,
                ]
            }
        else:
            normalized_else = _normalize_canonical_completion_schema(else_branch)
            conditional = {
                "oneOf": [
                    {"allOf": [normalized_condition, normalized_then]},
                    {"allOf": [{"not": normalized_condition}, normalized_else]},
                ]
            }
        existing_all_of = normalized.get("allOf")
        if isinstance(existing_all_of, list):
            existing_all_of.append(conditional)
        else:
            normalized["allOf"] = [conditional]
    return normalized


@lru_cache(maxsize=1)
def _canonical_research_output_assets() -> tuple[dict[str, Any], dict[str, Any]]:
    try:
        payload = json.loads(_RESEARCH_OUTPUT_SCHEMA_PATH.read_text(encoding="utf-8"))
        definitions = payload["$defs"]
        research_output = definitions["ResearchOutput"]
        examples = payload["x-ieeg-examples"]
        example = next(
            item["value"]
            for item in examples
            if item.get("definition") == "ResearchOutput"
        )
    except (OSError, json.JSONDecodeError, KeyError, StopIteration, TypeError) as exc:
        raise RuntimeError("canonical research-output.v1 schema is unavailable or malformed") from exc
    if not isinstance(definitions, Mapping) or not isinstance(research_output, Mapping):
        raise RuntimeError("canonical research-output.v1 definitions are malformed")
    if not isinstance(example, Mapping):
        raise RuntimeError("canonical research-output.v1 example is malformed")

    completion_schema = _normalize_canonical_completion_schema(research_output)
    completion_schema["$defs"] = _normalize_canonical_completion_schema(definitions)
    completion_schema["x-ieeg-completion"] = _RESEARCH_OUTPUT_COMPLETION_TAG
    return dict(completion_schema), dict(example)


def research_output_completion_schema() -> dict[str, Any]:
    """Return an isolated canonical-schema projection for one runtime step."""

    schema, _ = _canonical_research_output_assets()
    return copy.deepcopy(schema)


def research_output_contract_example() -> dict[str, Any]:
    """Return the canonical shape example used only as model guidance."""

    _, example = _canonical_research_output_assets()
    return copy.deepcopy(example)


def is_research_output_completion_schema(schema: Any) -> bool:
    if not isinstance(schema, Mapping):
        return False
    properties = schema.get("properties")
    if not isinstance(properties, Mapping):
        return False
    version = properties.get("schema_version")
    return bool(
        schema.get("x-ieeg-completion") == _RESEARCH_OUTPUT_COMPLETION_TAG
        and isinstance(version, Mapping)
        and version.get("const") == _RESEARCH_OUTPUT_SCHEMA_VERSION
    )


def extract_json_output(content: str) -> Any:
    raw = str(content or "").strip()
    fenced = _JSON_FENCE_RE.search(raw)
    if fenced:
        raw = fenced.group(1).strip()
    if not raw:
        raise ValueError("output is empty")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        starts = [position for position in (raw.find("{"), raw.find("[")) if position >= 0]
        if not starts:
            raise ValueError("output does not contain a JSON value")
        try:
            value, _ = json.JSONDecoder().raw_decode(raw[min(starts):])
        except json.JSONDecodeError as exc:
            raise ValueError(f"output JSON is invalid: {exc.msg}") from exc
        return value


def _resolve_ref(root_schema: Mapping[str, Any], reference: str) -> Any:
    if not reference.startswith("#/"):
        raise ValueError(f"only local JSON Schema references are supported: {reference}")
    value: Any = root_schema
    for token in reference[2:].split("/"):
        key = token.replace("~1", "/").replace("~0", "~")
        if not isinstance(value, Mapping) or key not in value:
            raise ValueError(f"unresolved JSON Schema reference: {reference}")
        value = value[key]
    return value


def _is_type(value: Any, expected: str) -> bool:
    return {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "object": isinstance(value, Mapping),
        "array": isinstance(value, list),
        "string": isinstance(value, str),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value)),
    }.get(expected, False)


def _validate(value: Any, schema: Any, *, path: str, root_schema: Mapping[str, Any]) -> list[str]:
    if isinstance(schema, bool):
        return [] if schema else [f"{path}: schema rejects every value"]
    if not isinstance(schema, Mapping):
        return [f"{path}: schema must be an object or boolean"]

    unsupported = sorted(set(schema) - _ANNOTATION_KEYWORDS - _ASSERTION_KEYWORDS)
    if unsupported:
        return [f"{path}: unsupported JSON Schema keywords: {', '.join(unsupported)}"]
    if "$ref" in schema:
        try:
            target = _resolve_ref(root_schema, str(schema["$ref"]))
        except ValueError as exc:
            return [f"{path}: {exc}"]
        siblings = {key: item for key, item in schema.items() if key != "$ref"}
        errors = _validate(value, target, path=path, root_schema=root_schema)
        if siblings:
            errors.extend(_validate(value, siblings, path=path, root_schema=root_schema))
        return errors

    errors: list[str] = []
    expected_type = schema.get("type")
    if expected_type is not None:
        candidates = [expected_type] if isinstance(expected_type, str) else expected_type
        if not isinstance(candidates, list) or not candidates or not all(isinstance(item, str) for item in candidates):
            return [f"{path}: schema type must be a string or non-empty string array"]
        if not any(_is_type(value, candidate) for candidate in candidates):
            return [f"{path}: expected type {'|'.join(candidates)}, got {type(value).__name__}"]

    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: value does not equal const")
    if "enum" in schema and (not isinstance(schema["enum"], list) or value not in schema["enum"]):
        errors.append(f"{path}: value is not in enum")

    if isinstance(value, Mapping):
        properties = schema.get("properties") or {}
        required = schema.get("required") or []
        if not isinstance(properties, Mapping) or not isinstance(required, list):
            return errors + [f"{path}: properties/required schema is malformed"]
        for key in required:
            if key not in value:
                errors.append(f"{path}: missing required property {key}")
        additional = schema.get("additionalProperties", True)
        for key, item in value.items():
            child_path = f"{path}.{key}"
            if key in properties:
                errors.extend(_validate(item, properties[key], path=child_path, root_schema=root_schema))
            elif additional is False:
                errors.append(f"{child_path}: additional property is forbidden")
            elif isinstance(additional, (Mapping, bool)) and additional is not True:
                errors.extend(_validate(item, additional, path=child_path, root_schema=root_schema))
        if "minProperties" in schema and len(value) < int(schema["minProperties"]):
            errors.append(f"{path}: fewer than minProperties")
        if "maxProperties" in schema and len(value) > int(schema["maxProperties"]):
            errors.append(f"{path}: more than maxProperties")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < int(schema["minItems"]):
            errors.append(f"{path}: fewer than minItems")
        if "maxItems" in schema and len(value) > int(schema["maxItems"]):
            errors.append(f"{path}: more than maxItems")
        if schema.get("uniqueItems") is True:
            encoded = [json.dumps(item, sort_keys=True, default=str) for item in value]
            if len(encoded) != len(set(encoded)):
                errors.append(f"{path}: array items are not unique")
        if "items" in schema:
            for index, item in enumerate(value):
                errors.extend(_validate(item, schema["items"], path=f"{path}[{index}]", root_schema=root_schema))

    if isinstance(value, str):
        if "minLength" in schema and len(value) < int(schema["minLength"]):
            errors.append(f"{path}: shorter than minLength")
        if "maxLength" in schema and len(value) > int(schema["maxLength"]):
            errors.append(f"{path}: longer than maxLength")
        if "pattern" in schema:
            try:
                matched = re.search(str(schema["pattern"]), value)
            except re.error as exc:
                errors.append(f"{path}: invalid schema pattern: {exc}")
            else:
                if matched is None:
                    errors.append(f"{path}: string does not match pattern")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        limits = (
            ("minimum", lambda left, right: left >= right, "below minimum"),
            ("maximum", lambda left, right: left <= right, "above maximum"),
            ("exclusiveMinimum", lambda left, right: left > right, "not above exclusiveMinimum"),
            ("exclusiveMaximum", lambda left, right: left < right, "not below exclusiveMaximum"),
        )
        for keyword, comparator, label in limits:
            if keyword in schema and not comparator(value, schema[keyword]):
                errors.append(f"{path}: {label}")

    for keyword in ("allOf", "anyOf", "oneOf"):
        if keyword not in schema:
            continue
        branches = schema[keyword]
        if not isinstance(branches, list) or not branches:
            errors.append(f"{path}: {keyword} must be a non-empty array")
            continue
        passing = sum(
            not _validate(value, branch, path=path, root_schema=root_schema)
            for branch in branches
        )
        if keyword == "allOf" and passing != len(branches):
            errors.append(f"{path}: value does not satisfy allOf")
        elif keyword == "anyOf" and passing == 0:
            errors.append(f"{path}: value does not satisfy anyOf")
        elif keyword == "oneOf" and passing != 1:
            errors.append(f"{path}: value does not satisfy exactly one oneOf branch")
    if "not" in schema and not _validate(value, schema["not"], path=path, root_schema=root_schema):
        errors.append(f"{path}: value matches forbidden not schema")
    return errors


def validate_step_output(step: ExecutionStep, final_content: str) -> CompletionValidation:
    text = str(final_content or "").strip()
    if not text:
        return CompletionValidation(False, errors=("output is empty",))
    schema = step.output_schema
    if schema is None:
        return CompletionValidation(True)
    if not isinstance(schema, Mapping):
        return CompletionValidation(False, errors=("output_schema must be an object",))
    try:
        parsed = extract_json_output(text)
    except ValueError as exc:
        return CompletionValidation(False, errors=(str(exc),))
    try:
        errors = _validate(parsed, schema, path="$", root_schema=schema)
    except (RecursionError, TypeError, ValueError, OverflowError) as exc:
        # A malformed or cyclic schema is untrusted plan/model input.  It must
        # reject completion rather than crashing the turn or accidentally
        # treating unverifiable text as success.
        return CompletionValidation(
            False,
            parsed_output=parsed,
            errors=(f"output_schema is invalid or unsupported ({exc.__class__.__name__})",),
        )
    return CompletionValidation(not errors, parsed_output=parsed, errors=tuple(errors))


def completion_repair_prompt(errors: Sequence[str]) -> str:
    details = "\n".join(f"- {error}" for error in errors[:8])
    return (
        "Your previous response did not satisfy the machine-readable output contract. "
        "Return a corrected JSON value only; do not claim completion until it validates.\n"
        f"Validation errors:\n{details}"
    )
