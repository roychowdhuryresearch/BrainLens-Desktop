import json
import re
from typing import Any, Dict, List, Optional


TOOL_RESULT_LIST_KEYS = (
    "data",
    "items",
    "results",
    "documents",
    "docs",
    "rows",
    "records",
)

TOOL_FOCUS_KEYS = (
    "query",
    "repo_id",
    "doc_id",
    "attachment_ref",
    "image_ref",
    "pdf_file_num",
    "login",
    "count",
    "top_k",
    "url",
    "endpoint",
    "method",
    "table",
    "resource_id",
)


def classify_tool_family(tool_name: str) -> str:
    normalized = (tool_name or "").lower()
    if not normalized:
        return "unknown"
    if normalized.startswith("vl_") or "vision" in normalized or "image" in normalized:
        return "vision"
    if "search" in normalized or "query" in normalized or "find" in normalized:
        return "search"
    if "doc" in normalized or "book" in normalized or "repo" in normalized or "read" in normalized:
        return "document"
    if "db" in normalized or "sql" in normalized or "database" in normalized or "table" in normalized:
        return "database"
    if "file" in normalized or "dir" in normalized or "path" in normalized:
        return "file"
    if "http" in normalized or "api" in normalized or "fetch" in normalized or "request" in normalized:
        return "http"
    if "mcp" in normalized:
        return "mcp"
    if "input" in normalized or "user" in normalized:
        return "interaction"
    return "other"


def tool_provider_name(tool_name: str) -> str:
    normalized = (tool_name or "").strip()
    if not normalized:
        return ""
    return normalized.split("_", 1)[0]


def normalize_tool_args(function_args: Any) -> Dict[str, Any]:
    return function_args if isinstance(function_args, dict) else {}


def tool_args_signature(function_name: str, function_args: Dict[str, Any]) -> str:
    try:
        serialized_args = json.dumps(
            function_args or {},
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
    except TypeError:
        serialized_args = json.dumps(str(function_args), ensure_ascii=False)
    return f"{function_name}:{serialized_args}"


def count_tool_result_items(tool_result: Any) -> int:
    if tool_result is None:
        return 0
    if isinstance(tool_result, list):
        return len(tool_result)
    if isinstance(tool_result, dict):
        for key in TOOL_RESULT_LIST_KEYS:
            value = tool_result.get(key)
            if isinstance(value, list):
                return len(value)
        return 0 if tool_result.get("error") else len(tool_result)
    return 1


def is_empty_tool_result(tool_result: Any) -> bool:
    if tool_result is None:
        return True
    if isinstance(tool_result, (list, tuple, set)):
        return len(tool_result) == 0
    if isinstance(tool_result, dict):
        for key in TOOL_RESULT_LIST_KEYS:
            value = tool_result.get(key)
            if isinstance(value, list):
                return len(value) == 0
        meaningful = {
            key: value
            for key, value in tool_result.items()
            if key != "error" and value not in (None, "", [], {}, ())
        }
        return len(meaningful) == 0
    return False


def tool_result_size_chars(tool_result: Any) -> int:
    try:
        return len(json.dumps(tool_result, ensure_ascii=False, default=str))
    except TypeError:
        return len(str(tool_result))


def infer_tool_error_type(error: Optional[str], status: str) -> str:
    if status == "invalid":
        return "invalid_tool"
    error_text = (error or "").lower()
    if not error_text:
        return ""
    if "timeout" in error_text or "timed out" in error_text:
        return "timeout"
    if "json" in error_text:
        return "json_error"
    if "not available" in error_text or "unknown tool" in error_text:
        return "invalid_tool"
    if "validation" in error_text:
        return "validation_error"
    return "execution_error"


def extract_tool_focus_args(function_args: Dict[str, Any]) -> Dict[str, Any]:
    return {
        key: function_args[key]
        for key in TOOL_FOCUS_KEYS
        if key in function_args and function_args[key] not in (None, "", [], {})
    }


def summarize_tool_result(tool_result: Any) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "result_kind": type(tool_result).__name__,
        "result_count": count_tool_result_items(tool_result),
        "result_size_chars": tool_result_size_chars(tool_result),
        "is_empty_result": is_empty_tool_result(tool_result),
    }
    if isinstance(tool_result, list) and tool_result and isinstance(tool_result[0], dict):
        sample = tool_result[:3]
        summary["sample_ids"] = [
            str(item.get("id", ""))
            for item in sample
            if item.get("id") is not None
        ]
        summary["sample_titles"] = [
            str(item.get("title", ""))
            for item in sample
            if item.get("title")
        ]
    elif isinstance(tool_result, dict):
        sample_list = None
        for key in TOOL_RESULT_LIST_KEYS:
            if isinstance(tool_result.get(key), list):
                sample_list = tool_result.get(key)[:3]
                break
        if sample_list and isinstance(sample_list[0], dict):
            summary["sample_ids"] = [
                str(item.get("id", ""))
                for item in sample_list
                if item.get("id") is not None
            ]
            summary["sample_titles"] = [
                str(item.get("title", ""))
                for item in sample_list
                if item.get("title")
            ]
    return summary


def extract_sources_from_tool_result(result: Any) -> List[Dict[str, Any]]:
    sources: List[Dict[str, Any]] = []
    if isinstance(result, list):
        iterable = result
    elif isinstance(result, dict) and "data" in result and isinstance(result.get("data"), list):
        iterable = result.get("data", [])
    else:
        iterable = []

    for item in iterable:
        if not isinstance(item, dict):
            continue
        sources.append(
            {
                "doc_id": str(item.get("id", "")),
                "title": item.get("title", ""),
                "snippet": (item.get("summary") or item.get("snippet") or "")[:200],
                "url": item.get("url", ""),
            }
        )
    return sources[:5]


def extract_knowledge_base_slugs_from_sources(sources: List[Dict[str, Any]]) -> List[str]:
    knowledge_bases: List[str] = []
    seen = set()
    for source in sources or []:
        if not isinstance(source, dict):
            continue
        url = str(source.get("url", "")).strip()
        if not url:
            continue
        match = re.search(r"https?://([^/\s]+)/([^#?\s]+)", url)
        if not match:
            continue
        host = match.group(1).strip()
        path = match.group(2).strip().strip("/")
        slug = f"{host}/{path}" if path else host
        if slug and slug not in seen:
            seen.add(slug)
            knowledge_bases.append(slug)
    return knowledge_bases
