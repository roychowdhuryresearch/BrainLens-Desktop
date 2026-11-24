import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Dict, List, Optional, Protocol, Tuple

from runtime.redaction import redact_observability_payload
from runtime.context.noise_filter import sanitize_tool_result
from runtime.agent_runtime.user_input import create_user_input_request
from runtime.services.search_refiner import get_search_refiner
from runtime.skills.skill_logger import skill_logger

logger = logging.getLogger(__name__)


def deep_parse_json(obj):
    if isinstance(obj, dict):
        return {key: deep_parse_json(value) for key, value in obj.items()}
    if isinstance(obj, list):
        return [deep_parse_json(item) for item in obj]
    if isinstance(obj, str):
        stripped = obj.strip()
        if (stripped.startswith("{") and stripped.endswith("}")) or (
            stripped.startswith("[") and stripped.endswith("]")
        ):
            try:
                parsed = json.loads(stripped)
                return deep_parse_json(parsed)
            except json.JSONDecodeError:
                pass
    return obj


def parse_tool_arguments(raw_arguments: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Parse an LLM tool_call's ``function.arguments`` into a dict.

    Returns ``(parsed_dict, None)`` on success or ``(None, error_message)`` when
    the arguments are not valid JSON / not an object. Weak models routinely
    stream truncated or malformed JSON; the caller must feed that error back to
    the model instead of silently coercing to ``{}`` and executing the tool with
    blank parameters — which the model then reads as a successful call (e.g. a
    ``detection.set_parameters`` that quietly set nothing).
    """
    if raw_arguments is None or raw_arguments == "":
        return {}, None
    if isinstance(raw_arguments, dict):
        return raw_arguments, None
    if not isinstance(raw_arguments, str):
        return None, f"function.arguments must be a JSON object string, got {type(raw_arguments).__name__}"
    try:
        parsed = json.loads(raw_arguments)
    except json.JSONDecodeError as exc:
        return None, (
            "function.arguments must be valid JSON: "
            f"{exc.msg} at line {exc.lineno} column {exc.colno}"
        )
    parsed = deep_parse_json(parsed)
    if not isinstance(parsed, dict):
        return None, f"function.arguments must be a JSON object, got {type(parsed).__name__}"
    return parsed, None


class ToolExecutorServices(Protocol):
    def record_observability_span(self, **kwargs) -> None:
        ...

    def normalize_tool_args(self, function_args: Any) -> Dict[str, Any]:
        ...

    def track_tool_call_signature(
        self,
        *,
        turn_id: Optional[str],
        step_id: Optional[str],
        function_name: str,
        function_args: Dict[str, Any],
    ) -> Dict[str, Any]:
        ...

    def classify_tool_family(self, tool_name: str) -> str:
        ...

    def tool_provider_name(self, tool_name: str) -> str:
        ...

    def extract_tool_focus_args(self, function_args: Dict[str, Any]) -> Dict[str, Any]:
        ...

    async def execute_tool(
        self,
        *,
        tool_name: str,
        args: Dict[str, Any],
        conversation_id: Optional[str] = None,
        user_role: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Any:
        ...

    def summarize_tool_result(self, tool_result: Any) -> Dict[str, Any]:
        ...

    def extract_sources_from_tool_result(self, result: Any) -> List[Dict]:
        ...

    def extract_knowledge_base_slugs_from_sources(self, sources: List[Dict]) -> List[str]:
        ...

    def tool_args_signature(self, function_name: str, function_args: Dict[str, Any]) -> str:
        ...

    def infer_tool_error_type(self, error: Optional[str], status: str) -> str:
        ...

    def resolve_real_tool_name(self, tool_name: str) -> str:
        ...

    def get_hitl_tool_policy(
        self,
        tool_name: str,
        function_args: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        ...


@dataclass
class ToolExecutionRequest:
    tool_calls: List[Dict]
    tools: List[Dict]
    messages: List[Dict]
    ai_response: Dict
    sources: List[Dict]
    active_skill_name_result: Optional[str]
    iteration: int
    conversation_id: str
    turn_id: Optional[str] = None
    user_id: Optional[str] = None
    user_role: Optional[str] = None
    step_id: Optional[str] = None
    user_message: str = ""


class ToolExecutor:
    """Headless tool-call validator and dispatcher for one ReAct iteration."""

    # Tool results larger than this trigger LLM summarization
    SUMMARIZE_THRESHOLD_CHARS = 20000
    # Hard cap before summarization (safety net)
    HARD_CAP_CHARS = 60000
    # Target size after summarization
    SUMMARIZE_TARGET_CHARS = 8000
    # Deterministic model-context compaction for structured scientific tool
    # results. The full payload is still emitted in tool_result events; this
    # only limits what is appended back into the next LLM prompt.
    MODEL_CONTEXT_LIST_SAMPLE = 8
    MODEL_CONTEXT_STRING_CHARS = 600
    MODEL_CONTEXT_INSPECT_RESULT_CHARS = 1200

    def __init__(
        self,
        services: ToolExecutorServices,
        *,
        max_parallel_tool_calls: int = 10,
        tool_call_timeout_seconds: int = 20,
        vl_tool_timeout_seconds: int = 90,
    ):
        self.services = services
        self.max_parallel_tool_calls = max_parallel_tool_calls
        self.tool_call_timeout_seconds = tool_call_timeout_seconds
        self.vl_tool_timeout_seconds = vl_tool_timeout_seconds

    @staticmethod
    def _is_empty_search_result(tool_result: Any) -> bool:
        if isinstance(tool_result, dict):
            if isinstance(tool_result.get("results"), list):
                return len(tool_result.get("results") or []) == 0
            if isinstance(tool_result.get("data"), list):
                return len(tool_result.get("data") or []) == 0
        if isinstance(tool_result, list):
            return len(tool_result) == 0
        return False

    @staticmethod
    def _interpret_tool_result_status(tool_result: Any) -> tuple[bool, Optional[str]]:
        if isinstance(tool_result, dict):
            explicit_success = tool_result.get("success")
            if isinstance(explicit_success, bool):
                if explicit_success:
                    return True, None
                error = str(
                    tool_result.get("message")
                    or tool_result.get("error")
                    or "Tool returned success=false"
                ).strip()
                return False, error or "Tool returned success=false"

            explicit_error = str(tool_result.get("error") or "").strip()
            if explicit_error:
                return False, explicit_error

        return True, None

    @staticmethod
    def _build_bing_retry_queries(query: str) -> List[str]:
        original = str(query or "").strip()
        if not original:
            return []
        candidates = get_search_refiner().refine_query(original)
        seed_queries = ["人工智能 最新 新闻", "最新 人工智能 大新闻"]
        seen = set()
        variants: List[str] = []
        for candidate in [original, *candidates, *seed_queries]:
            normalized = str(candidate or "").strip()
            if not normalized:
                continue
            lowered = normalized.lower()
            if lowered in seen:
                continue
            seen.add(lowered)
            variants.append(normalized)
        return variants[:4]

    async def _execute_tool_once(
        self,
        *,
        function_name: str,
        function_args: Dict[str, Any],
        conversation_id: Optional[str],
        user_role: Optional[str],
        user_id: Optional[str] = None,
    ) -> Any:
        if function_name in {"vl_query", "inspect_waveform"}:
            timeout = self.vl_tool_timeout_seconds
        elif str(function_name or "").startswith("pyhfo_"):
            timeout = max(self.tool_call_timeout_seconds, 900)
        else:
            timeout = self.tool_call_timeout_seconds
        return await asyncio.wait_for(
            self.services.execute_tool(
                tool_name=function_name,
                args=function_args,
                conversation_id=conversation_id,
                user_role=user_role,
                user_id=user_id,
            ),
            timeout=timeout,
        )

    @staticmethod
    def _routed_tool_items(tool_result: Any) -> List[Dict[str, Any]]:
        if not isinstance(tool_result, dict):
            return []
        items: List[Dict[str, Any]] = []
        routed_tool = tool_result.get("routed_tool")
        if isinstance(routed_tool, dict):
            items.append(routed_tool)
        routed_tools = tool_result.get("routed_tools")
        if isinstance(routed_tools, list):
            items.extend(item for item in routed_tools if isinstance(item, dict))

        if not items:
            tool_chain = tool_result.get("tool_chain")
            if isinstance(tool_chain, list) and len(tool_chain) > 1:
                routed_args = {
                    key: tool_result.get(key)
                    for key in ("attachment_ref", "mcp_args_kind")
                    if tool_result.get(key) not in (None, "", [], {})
                }
                items.append(
                    {
                        "tool_name": str(tool_chain[-1] or "").strip(),
                        "source_tool": str(tool_chain[0] or "").strip(),
                        "args": routed_args,
                        "result": tool_result.get("result"),
                    }
                )

        return [item for item in items if str(item.get("tool_name") or item.get("name") or "").strip()]

    @classmethod
    def _build_tool_routing_metadata(cls, tool_result: Any) -> Dict[str, Any]:
        if not isinstance(tool_result, dict):
            return {}
        metadata: Dict[str, Any] = {}
        tool_chain = tool_result.get("tool_chain")
        if isinstance(tool_chain, list) and tool_chain:
            metadata["tool_chain"] = [str(item) for item in tool_chain]
        mcp_args_kind = str(tool_result.get("mcp_args_kind") or "").strip()
        if mcp_args_kind:
            metadata["mcp_args_kind"] = mcp_args_kind
        routed_items = cls._routed_tool_items(tool_result)
        if routed_items:
            primary = routed_items[0]
            metadata["routed_tool_name"] = str(primary.get("tool_name") or primary.get("name") or "").strip()
            provider_name = str(primary.get("provider_name") or "").strip()
            if provider_name:
                metadata["routed_provider_name"] = provider_name
            routed_duration_ms = primary.get("duration_ms")
            if routed_duration_ms not in (None, ""):
                metadata["routed_duration_ms"] = routed_duration_ms
        return metadata

    @staticmethod
    def _routed_tool_status(routed: Dict[str, Any], routed_result: Any, parent_success: bool) -> tuple[str, Optional[str]]:
        error = routed.get("error")
        if not error and isinstance(routed_result, dict):
            error = routed_result.get("error")
        explicit_success = routed.get("success")
        if explicit_success is None and isinstance(routed_result, dict) and isinstance(routed_result.get("success"), bool):
            explicit_success = routed_result.get("success")
        if explicit_success is None:
            explicit_success = bool(parent_success and not error)
        return ("success" if bool(explicit_success) else "failed", str(error) if error else None)

    def _record_routed_tool_observability_spans(
        self,
        *,
        request: ToolExecutionRequest,
        parent_tool_call_id: str,
        parent_function_name: str,
        parent_function_args: Dict[str, Any],
        parent_tool_result: Any,
        parent_success: bool,
        telemetry: Dict[str, Any],
        fallback_duration_ms: float,
    ) -> None:
        for routed in self._routed_tool_items(parent_tool_result):
            routed_tool_name = str(routed.get("tool_name") or routed.get("name") or "").strip()
            if not routed_tool_name:
                continue
            routed_args = routed.get("args") if isinstance(routed.get("args"), dict) else {}
            routed_result = routed.get("result")
            if routed_result is None and isinstance(parent_tool_result, dict):
                routed_result = parent_tool_result.get("result")
            result_summary = self.services.summarize_tool_result(routed_result)
            span_status, routed_error = self._routed_tool_status(routed, routed_result, parent_success)
            duration_ms = float(routed.get("duration_ms") or fallback_duration_ms or 0.0)
            tool_family = str(routed.get("tool_family") or self.services.classify_tool_family(routed_tool_name))
            provider_name = str(routed.get("provider_name") or self.services.tool_provider_name(routed_tool_name))
            mcp_args_kind = str(
                routed.get("mcp_args_kind")
                or routed_args.get("mcp_args_kind")
                or (parent_tool_result.get("mcp_args_kind") if isinstance(parent_tool_result, dict) else "")
                or ""
            ).strip()
            routed_metadata = {
                "tool_call_id": parent_tool_call_id,
                "parent_tool_name": parent_function_name,
                "parent_args": parent_function_args,
                "parent_args_signature": telemetry.get("args_signature")
                or self.services.tool_args_signature(parent_function_name, parent_function_args),
                "step_id": request.step_id,
                "tool_family": tool_family,
                "provider_name": provider_name,
                "args": routed_args,
                "arg_keys": sorted(routed_args.keys()),
                "focus_args": self.services.extract_tool_focus_args(routed_args),
                "args_signature": self.services.tool_args_signature(routed_tool_name, routed_args),
                "is_repeated_call": False,
                "is_repeated_in_step": False,
                "result_kind": result_summary.get("result_kind"),
                "result_count": result_summary.get("result_count"),
                "result_size_chars": result_summary.get("result_size_chars"),
                "is_empty_result": result_summary.get("is_empty_result"),
                "sample_ids": result_summary.get("sample_ids", []),
                "sample_titles": result_summary.get("sample_titles", []),
                "error": routed_error,
                "error_type": self.services.infer_tool_error_type(routed_error, span_status),
                "error_message": routed_error or "",
            }
            source_tool = str(routed.get("source_tool") or parent_function_name).strip()
            if source_tool:
                routed_metadata["source_tool"] = source_tool
            if mcp_args_kind:
                routed_metadata["mcp_args_kind"] = mcp_args_kind
            for key in ("attachment_ref", "content_type", "filename"):
                value = routed.get(key)
                if value not in (None, "", [], {}):
                    routed_metadata[key] = value

            self.services.record_observability_span(
                turn_id=request.turn_id,
                conversation_id=request.conversation_id,
                user_id=request.user_id,
                span_type="tool",
                phase="loop",
                name=routed_tool_name,
                status=span_status,
                loop_index=request.iteration + 1,
                duration_ms=duration_ms,
                tool_name=routed_tool_name,
                skill_name=request.active_skill_name_result,
                metadata=routed_metadata,
            )

    def _resolve_real_tool_name(self, tool_name: str) -> str:
        resolver = getattr(self.services, "resolve_real_tool_name", None)
        if callable(resolver):
            resolved = str(resolver(tool_name) or "").strip()
            if resolved:
                return resolved
        normalized = str(tool_name or "").strip()
        if normalized.startswith("hitl__"):
            return normalized[len("hitl__") :]
        return normalized

    def _get_hitl_tool_policy(self, tool_name: str, function_args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        getter = getattr(self.services, "get_hitl_tool_policy", None)
        if not callable(getter):
            return None
        policy = getter(tool_name, function_args)
        if isinstance(policy, dict) and policy:
            return dict(policy)
        return None

    def _build_tool_approval_metadata(
        self,
        *,
        tool_name: str,
        real_tool_name: str,
        function_args: Dict[str, Any],
        policy: Dict[str, Any],
    ) -> Dict[str, Any]:
        risk_level = str(policy.get("risk_level") or "high").strip() or "high"
        title = str(policy.get("title") or "Tool approval required").strip()
        description = str(policy.get("description") or "").strip()
        message = description or f"Confirm execution of {real_tool_name} with the following arguments."
        return {
            "kind": "tool_approval",
            "variant": "hitl_confirm",
            "tool_name": tool_name,
            "real_tool_name": real_tool_name,
            "title": title,
            "message": message,
            "risk_level": risk_level,
            "editable": bool(policy.get("editable", True)),
            "original_args": dict(function_args or {}),
            "params": dict(function_args or {}),
        }

    async def _execute_guarded_tool_call(
        self,
        *,
        tool_call_id: str,
        function_name: str,
        function_args: Dict[str, Any],
        conversation_id: Optional[str],
        user_id: Optional[str],
        step_id: Optional[str],
        user_role: Optional[str],
        pending_events: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        result = {
            "tool_call_id": tool_call_id,
            "name": function_name,
            "args": function_args,
            "result": None,
            "success": False,
            "error": None,
            "duration_ms": 0.0,
        }
        real_tool_name = self._resolve_real_tool_name(function_name)
        policy = self._get_hitl_tool_policy(function_name, function_args)
        if not policy:
            return await self._execute_single_tool_call(
                tool_call={
                    "tool_call_id": tool_call_id,
                    "function_name": function_name,
                    "function_args": function_args,
                },
                semaphore=asyncio.Semaphore(1),
                conversation_id=conversation_id,
                user_role=user_role,
                user_id=user_id,
            )

        approval_metadata = self._build_tool_approval_metadata(
            tool_name=function_name,
            real_tool_name=real_tool_name,
            function_args=function_args,
            policy=policy,
        )
        prompt = approval_metadata["message"]
        timeout_seconds = int(policy.get("timeout_seconds") or 300)
        pending = create_user_input_request(
            conversation_id=conversation_id or "default",
            user_id=user_id or "anonymous",
            prompt=prompt,
            input_type="confirm",
            timeout=timeout_seconds,
            skill="tool_approval",
            step_id=step_id,
            input_metadata=approval_metadata,
        )
        pending_events.append({"event": "user_input_required", "data": pending.to_sse_data()})

        started_at = time.perf_counter()
        try:
            # Phase 1: approval wait — a timeout here is a genuine approval timeout.
            try:
                await asyncio.wait_for(pending.event.wait(), timeout=timeout_seconds)
            except asyncio.TimeoutError:
                result["error"] = f"Tool approval timed out after {timeout_seconds} seconds"
                result["result"] = {"error": result["error"]}
                return result

            # Phase 2: decision + execution. A timeout or any other error here is a
            # tool-EXECUTION failure, not an approval timeout, and must be caught so
            # the caller always gets a paired result instead of an orphaned tool_call.
            try:
                if pending.error:
                    result["error"] = pending.error
                    result["result"] = {"error": pending.error}
                    return result

                submission_value = pending.result.get("value") if isinstance(pending.result, dict) else None
                submission_payload = submission_value if isinstance(submission_value, dict) else {}
                decision = str(submission_payload.get("decision") or "approved").strip().lower()
                final_args = submission_payload.get("final_args")
                if not isinstance(final_args, dict):
                    final_args = dict(function_args or {})
                final_args = self.services.normalize_tool_args(deep_parse_json(final_args))

                if decision != "approved":
                    rejection = {
                        "error": "Tool execution rejected by user",
                        "_hitl": {
                            "approved": False,
                            "real_tool_name": real_tool_name,
                            "original_args": dict(function_args or {}),
                            "final_args": final_args,
                        },
                    }
                    result["result"] = rejection
                    result["error"] = rejection["error"]
                    return result

                tool_result = await self._execute_tool_once(
                    function_name=function_name,
                    function_args=final_args,
                    conversation_id=conversation_id,
                    user_role=user_role,
                    user_id=user_id,
                )
                if isinstance(tool_result, dict):
                    tool_result = {
                        **tool_result,
                        "_hitl": {
                            "approved": True,
                            "real_tool_name": real_tool_name,
                            "original_args": dict(function_args or {}),
                            "final_args": final_args,
                        },
                    }
                else:
                    tool_result = {
                        "value": tool_result,
                        "_hitl": {
                            "approved": True,
                            "real_tool_name": real_tool_name,
                            "original_args": dict(function_args or {}),
                            "final_args": final_args,
                        },
                    }
                success, error = self._interpret_tool_result_status(tool_result)
                result["args"] = final_args
                result["result"] = tool_result
                result["success"] = success
                result["error"] = error
                return result
            except asyncio.TimeoutError:
                result["error"] = "Tool execution timed out"
                result["result"] = {"error": result["error"]}
                return result
            except Exception as exc:
                error_msg = str(exc)
                logger.error("[Agent] Guarded tool %s failed: %s", function_name, error_msg)
                result["error"] = error_msg
                result["result"] = {"error": error_msg}
                return result
        finally:
            result["duration_ms"] = round((time.perf_counter() - started_at) * 1000, 2)

    async def _maybe_summarize_result(
        self,
        content: str,
        user_message: str,
        tool_name: str,
    ) -> str:
        """Summarize large tool results using a fast LLM model.

        Layer 1: Hard cap at HARD_CAP_CHARS (zero latency safety net)
        Layer 2: If > SUMMARIZE_THRESHOLD_CHARS, use fast LLM to extract
                 content relevant to the user's question.
        """
        if len(content) <= self.SUMMARIZE_THRESHOLD_CHARS:
            return content

        # Layer 1: hard cap to prevent feeding >30K to summarizer
        if len(content) > self.HARD_CAP_CHARS:
            content = content[:self.HARD_CAP_CHARS]

        # Layer 2: LLM summarization
        summarizer_ai = self._get_summarizer_ai_service()
        if not summarizer_ai:
            # No summarizer available, fall back to truncation
            return content[:self.SUMMARIZE_THRESHOLD_CHARS] + (
                f"\n\n[文档较长，已截取前 {self.SUMMARIZE_THRESHOLD_CHARS} 字符]"
            )

        try:
            response = await asyncio.wait_for(
                summarizer_ai.chat([
                    {
                        "role": "system",
                        "content": (
                            "你是一个文档摘要助手。从给定的工具返回结果中，"
                            "提取与用户问题最相关的内容，生成一份简洁但信息完整的摘要。"
                            "保留关键数据、参数、步骤、型号等具体信息，不要泛泛而谈。"
                            f"摘要控制在 {self.SUMMARIZE_TARGET_CHARS} 字符以内。"
                        ),
                    },
                    {
                        "role": "user",
                        "content": (
                            f"用户问题：{user_message}\n"
                            f"工具名称：{tool_name}\n"
                            f"工具返回内容（{len(content)} 字符）：\n\n"
                            f"{content}"
                        ),
                    },
                ]),
                timeout=10,
            )
            summary = (response.get("content", "") if isinstance(response, dict) else str(response)).strip()
            if summary and len(summary) >= 50:
                logger.info(
                    "[ToolExecutor] Summarized tool result: %d -> %d chars (tool=%s)",
                    len(content), len(summary), tool_name,
                )
                return summary
        except Exception as exc:
            logger.warning("[ToolExecutor] Summarizer failed for %s, using truncation: %s", tool_name, exc)

        # Fallback: truncation
        return content[:self.SUMMARIZE_THRESHOLD_CHARS] + (
            f"\n\n[文档较长，已截取前 {self.SUMMARIZE_THRESHOLD_CHARS} 字符]"
        )

    def _get_summarizer_ai_service(self):
        """Try to get a fast AI service for summarization (e.g., qwen-turbo)."""
        try:
            getter = getattr(self.services, "get_summarizer_ai_service", None)
            if callable(getter):
                return getter()
            # Fall back to the compress model if available
            getter = getattr(self.services, "get_compress_ai_service", None)
            if callable(getter):
                return getter()
        except Exception:
            pass
        return None

    @classmethod
    def _compact_value_for_model(cls, value: Any, *, depth: int = 0) -> Any:
        if depth > 5:
            if isinstance(value, dict):
                return {"keys": list(value.keys())[: cls.MODEL_CONTEXT_LIST_SAMPLE], "omitted_nested": True}
            if isinstance(value, list):
                return {"count": len(value), "omitted_nested": True}
            return value
        if isinstance(value, str):
            if len(value) <= cls.MODEL_CONTEXT_STRING_CHARS:
                return value
            return f"{value[:cls.MODEL_CONTEXT_STRING_CHARS]}… [truncated {len(value) - cls.MODEL_CONTEXT_STRING_CHARS} chars]"
        if isinstance(value, (int, float, bool)) or value is None:
            return value
        if isinstance(value, list):
            limit = cls.MODEL_CONTEXT_LIST_SAMPLE
            sample = [cls._compact_value_for_model(item, depth=depth + 1) for item in value[:limit]]
            if len(value) <= limit:
                return sample
            numeric = [item for item in value if isinstance(item, (int, float)) and not isinstance(item, bool)]
            compact: Dict[str, Any] = {"count": len(value), "sample": sample, "omitted": len(value) - limit}
            if numeric:
                compact["min"] = min(numeric)
                compact["max"] = max(numeric)
            return compact
        if isinstance(value, dict):
            return {
                str(key): cls._compact_value_for_model(item, depth=depth + 1)
                for key, item in value.items()
            }
        return str(value)

    def _tool_result_for_model_context(self, tool_name: str, tool_result: Any) -> Any:
        if str(tool_name or "").startswith("pyhfo_"):
            return self._compact_value_for_model(tool_result)
        if str(tool_name or "") == "inspect_waveform" and isinstance(tool_result, dict):
            result = str(tool_result.get("result") or "")
            query = str(tool_result.get("query") or "")
            return {
                "success": bool(tool_result.get("success")),
                "repeat_skipped": bool(tool_result.get("repeat_skipped")),
                "result": (
                    result
                    if len(result) <= self.MODEL_CONTEXT_INSPECT_RESULT_CHARS
                    else f"{result[:self.MODEL_CONTEXT_INSPECT_RESULT_CHARS]}… [truncated {len(result) - self.MODEL_CONTEXT_INSPECT_RESULT_CHARS} chars]"
                ),
                "query": (
                    query
                    if len(query) <= self.MODEL_CONTEXT_STRING_CHARS
                    else f"{query[:self.MODEL_CONTEXT_STRING_CHARS]}… [truncated {len(query) - self.MODEL_CONTEXT_STRING_CHARS} chars]"
                ),
                "note": (
                    "Visual inspection is a signal-derived impression only. Use this result to answer; "
                    "do not repeat inspect_waveform unless the user explicitly asks for a new view."
                ),
            }
        return tool_result

    async def _summarize_tool_messages_parallel(
        self,
        pending_messages: List[Dict[str, str]],
        *,
        user_message: str,
    ) -> List[str]:
        if not pending_messages:
            return []

        tasks = [
            self._maybe_summarize_result(
                item["cleaned_content"],
                user_message=user_message,
                tool_name=item["tool_name"],
            )
            for item in pending_messages
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        finalized: List[str] = []
        for item, result in zip(pending_messages, results):
            if isinstance(result, Exception):
                logger.warning(
                    "[ToolExecutor] Parallel summarization failed for %s, using cleaned content: %s",
                    item["tool_name"],
                    result,
                )
                finalized.append(item["cleaned_content"])
            else:
                finalized.append(result)
        return finalized

    async def _execute_single_tool_call(
        self,
        *,
        tool_call: Dict,
        semaphore: asyncio.Semaphore,
        conversation_id: Optional[str] = None,
        user_role: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Dict:
        tool_call_id = str(tool_call.get("tool_call_id", ""))
        function_name = str(tool_call.get("function_name", ""))
        function_args = dict(tool_call.get("function_args", {}))

        result = {
            "tool_call_id": tool_call_id,
            "name": function_name,
            "args": function_args,
            "result": None,
            "success": False,
            "error": None,
            "duration_ms": 0.0,
            "order_index": tool_call.get("order_index", 0),
        }

        async with semaphore:
            started_at = time.perf_counter()
            try:
                tool_result = await self._execute_tool_once(
                    function_name=function_name,
                    function_args=function_args,
                    conversation_id=conversation_id,
                    user_role=user_role,
                    user_id=user_id,
                )
                if function_name == "bing_bing_search" and self._is_empty_search_result(tool_result):
                    original_query = str(function_args.get("query") or "").strip()
                    for retry_query in self._build_bing_retry_queries(original_query)[1:]:
                        logger.info(
                            "[Agent] Retrying empty bing search result with refined query: %s -> %s",
                            original_query,
                            retry_query,
                        )
                        retry_args = dict(function_args)
                        retry_args["query"] = retry_query
                        retry_result = await self._execute_tool_once(
                            function_name=function_name,
                            function_args=retry_args,
                            conversation_id=conversation_id,
                            user_role=user_role,
                            user_id=user_id,
                        )
                        if not self._is_empty_search_result(retry_result):
                            function_args = retry_args
                            tool_result = retry_result
                            result["args"] = retry_args
                            break
                success, error = self._interpret_tool_result_status(tool_result)
                if success:
                    logger.info("[Agent] Tool %s completed successfully", function_name)
                else:
                    logger.warning("[Agent] Tool %s returned failure payload: %s", function_name, error)
                result["result"] = tool_result
                result["success"] = success
                result["error"] = error
            except asyncio.TimeoutError:
                timeout_used = (
                    self.vl_tool_timeout_seconds
                    if function_name in {"vl_query", "inspect_waveform"}
                    else self.tool_call_timeout_seconds
                )
                error_msg = f"Tool execution timed out after {timeout_used} seconds"
                logger.error("[Agent] Tool %s timeout", function_name)
                result["result"] = {"error": error_msg}
                result["error"] = error_msg
            except Exception as exc:
                error_msg = str(exc)
                logger.error("[Agent] Tool %s failed: %s", function_name, error_msg)
                result["result"] = {"error": error_msg}
                result["error"] = error_msg
            finally:
                result["duration_ms"] = round((time.perf_counter() - started_at) * 1000, 2)

        return result

    async def _execute_tool_calls_parallel(
        self,
        *,
        tool_calls: List[Dict],
        conversation_id: Optional[str],
        user_role: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> List[Dict]:
        if not tool_calls:
            return []

        semaphore = asyncio.Semaphore(self.max_parallel_tool_calls)
        logger.info(
            "[Agent] Executing %s tool calls in parallel (max=%s)",
            len(tool_calls),
            self.max_parallel_tool_calls,
        )
        tasks = [
            self._execute_single_tool_call(
                tool_call=tool_call,
                semaphore=semaphore,
                conversation_id=conversation_id,
                user_role=user_role,
                user_id=user_id,
            )
            for tool_call in tool_calls
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        processed_results = []
        for index, result in enumerate(results):
            if isinstance(result, (Exception, asyncio.CancelledError)):
                error_type = type(result).__name__
                logger.error("[Agent] %s in tool %s: %s", error_type, index, result)
                processed_results.append(
                    {
                        "tool_call_id": tool_calls[index].get("tool_call_id", ""),
                        "name": tool_calls[index].get("function_name", ""),
                        "args": tool_calls[index].get("function_args", {}),
                        "result": {"error": f"{error_type}: {str(result)}"},
                        "success": False,
                        "error": str(result),
                        "order_index": tool_calls[index].get("order_index", index),
                    }
                )
            else:
                processed_results.append(result)

        logger.info(
            "[Agent] Completed %s tool calls: %s succeeded, %s failed",
            len(tool_calls),
            sum(1 for item in processed_results if item["success"]),
            sum(1 for item in processed_results if not item["success"]),
        )
        return processed_results

    async def execute(self, request: ToolExecutionRequest) -> AsyncGenerator[Dict, None]:
        valid_tool_calls = []
        invalid_execution_results: List[Dict[str, Any]] = []
        normalized_tool_calls = []
        tool_call_order: Dict[str, int] = {}
        available_tool_names = {
            tool.get("function", {}).get("name", "")
            for tool in request.tools
        }

        def _normalized_args(func: Dict[str, Any]) -> Dict[str, Any]:
            parsed = deep_parse_json(func.get("arguments", {}))
            if not isinstance(parsed, dict):
                parsed = {}
            return self.services.normalize_tool_args(parsed)

        def _invalid_result(tool_call_id: str, func_name: str, args: Dict[str, Any], error_message: str, order_index: int) -> Dict[str, Any]:
            return {
                "tool_call_id": tool_call_id,
                "name": func_name,
                "args": args,
                "result": {"error": error_message},
                "success": False,
                "error": error_message,
                "duration_ms": 0.0,
                "span_status": "invalid",
                "error_type": "invalid_tool",
                "order_index": order_index,
            }

        for index, raw_tool_call in enumerate(request.tool_calls):
            tool_call = dict(raw_tool_call or {})
            func = dict(tool_call.get("function") or {})
            tool_call["function"] = func
            func = tool_call.get("function", {})
            func_name = str(func.get("name") or "").strip()
            if not tool_call.get("id"):
                tool_call["id"] = f"call_missing_{request.iteration + 1}_{index}"
            tool_call_id = str(tool_call.get("id") or "")
            tool_call_order[tool_call_id] = index

            if not func_name:
                logger.warning("[Agent] Skipping tool_call with empty name: %s", tool_call)
                func_name = "unknown_tool"
                func["name"] = func_name
                normalized_tool_calls.append(tool_call)
                invalid_execution_results.append(
                    _invalid_result(
                        tool_call_id,
                        func_name,
                        _normalized_args(func),
                        "Tool name is empty",
                        index,
                    )
                )
                continue

            normalized_tool_calls.append(tool_call)
            if func_name not in available_tool_names:
                logger.warning(
                    "[Agent] Skipping unknown tool: %s, available: %s",
                    func_name,
                    available_tool_names,
                )
                normalized_args = _normalized_args(func)
                invalid_execution_results.append(
                    _invalid_result(
                        tool_call_id,
                        func_name,
                        normalized_args,
                        f"Tool '{func_name}' is not available. Please use only the provided tools.",
                        index,
                    )
                )
                continue

            valid_tool_calls.append(tool_call)

        if normalized_tool_calls:
            request.messages.append(
                {
                    "role": "assistant",
                    "content": request.ai_response.get("content"),
                    "tool_calls": normalized_tool_calls,
                }
            )

        if not valid_tool_calls and not invalid_execution_results:
            logger.info("[Agent] No valid tool_calls found")
            return

        logger.info(
            "[Agent] LLM requested %s valid tool calls (filtered %s invalid)",
            len(valid_tool_calls),
            len(request.tool_calls) - len(valid_tool_calls),
        )

        inspect_waveform_already_used = any(
            msg.get("role") == "tool" and msg.get("name") == "inspect_waveform"
            for msg in request.messages
            if isinstance(msg, dict)
        )
        inspect_waveform_planned_this_iteration = False
        prepared_tool_calls = []
        for tool_call in valid_tool_calls:
            tool_call_id = tool_call.get("id", "")
            function_name = tool_call.get("function", {}).get("name", "")
            raw_arguments = tool_call.get("function", {}).get("arguments", "{}")
            parsed_args, argument_error = parse_tool_arguments(raw_arguments)
            if argument_error is not None:
                # Malformed tool arguments (truncated/invalid JSON from a weak
                # model): feed a structured error back via the same path as
                # unknown-tool calls instead of executing with coerced {} — which
                # the model would otherwise read as a successful no-op.
                preview = (
                    raw_arguments
                    if isinstance(raw_arguments, str)
                    else json.dumps(raw_arguments, ensure_ascii=False, default=str)
                )
                if len(preview) > 500:
                    preview = preview[:500] + "..."
                logger.warning(
                    "[Agent] Skipping tool %s: invalid function.arguments: %s",
                    function_name,
                    argument_error,
                )
                invalid_execution_results.append(
                    _invalid_result(
                        tool_call_id,
                        function_name,
                        {},
                        f"Invalid tool arguments for {function_name}: {argument_error}. Received: {preview}",
                        tool_call_order.get(tool_call_id, len(prepared_tool_calls)),
                    )
                )
                continue

            function_args = self.services.normalize_tool_args(deep_parse_json(parsed_args or {}))
            block_repeated_inspect = False
            if function_name == "inspect_waveform":
                block_repeated_inspect = inspect_waveform_already_used or inspect_waveform_planned_this_iteration
                inspect_waveform_planned_this_iteration = True
            tool_tracking = self.services.track_tool_call_signature(
                turn_id=request.turn_id,
                step_id=request.step_id,
                function_name=function_name,
                function_args=function_args,
            )
            prepared_tool_calls.append(
                {
                    "tool_call_id": tool_call_id,
                    "function_name": function_name,
                    "function_args": function_args,
                    "order_index": tool_call_order.get(tool_call_id, len(prepared_tool_calls)),
                    "telemetry": {
                        "step_id": request.step_id,
                        "tool_family": self.services.classify_tool_family(function_name),
                        "provider_name": self.services.tool_provider_name(function_name),
                        "arg_keys": sorted(function_args.keys()),
                        "focus_args": self.services.extract_tool_focus_args(function_args),
                        "blocked_repeat_in_turn": block_repeated_inspect,
                        **tool_tracking,
                    },
                }
            )

            logger.info(
                "[Agent] Preparing tool: %s arg_keys=%s signature=%s",
                function_name,
                sorted(function_args.keys()),
                self.services.tool_args_signature(function_name, function_args),
            )
            skill_logger.log_tool_call(
                tool_name=function_name,
                tool_args=function_args if isinstance(function_args, dict) else {},
                skill_name=request.active_skill_name_result,
                iteration=request.iteration + 1,
            )
            yield {
                "event": "tool_call",
                "data": {
                    "name": function_name,
                    "args": function_args,
                    "provider_name": self.services.tool_provider_name(function_name),
                    "skill": request.active_skill_name_result,
                    "iteration": request.iteration + 1,
                },
            }

        blocked_tool_calls = []
        guarded_tool_calls = []
        regular_tool_calls = []
        for tool_call in prepared_tool_calls:
            if tool_call.get("telemetry", {}).get("blocked_repeat_in_turn"):
                blocked_tool_calls.append(tool_call)
            elif self._get_hitl_tool_policy(tool_call.get("function_name", ""), tool_call.get("function_args", {})):
                guarded_tool_calls.append(tool_call)
            else:
                regular_tool_calls.append(tool_call)

        execution_results: List[Dict[str, Any]] = list(invalid_execution_results)
        execution_results.extend(
            {
                "tool_call_id": tool_call.get("tool_call_id", ""),
                "name": tool_call.get("function_name", ""),
                "args": tool_call.get("function_args", {}),
                "result": {
                    "success": True,
                    "result": (
                        "inspect_waveform already ran once in this agent turn. "
                        "Use the previous visual inspection result, or emit a UI command and wait for the next user turn if a new view is needed."
                    ),
                    "repeat_skipped": True,
                },
                "success": True,
                "error": None,
                "duration_ms": 0.0,
                "order_index": tool_call.get("order_index", 0),
            }
            for tool_call in blocked_tool_calls
        )
        for tool_call in guarded_tool_calls:
            tool_call_id = tool_call.get("tool_call_id", "")
            function_name = tool_call.get("function_name", "")
            function_args = tool_call.get("function_args", {})
            real_tool_name = self._resolve_real_tool_name(function_name)
            policy = self._get_hitl_tool_policy(function_name, function_args) or {}
            approval_metadata = self._build_tool_approval_metadata(
                tool_name=function_name,
                real_tool_name=real_tool_name,
                function_args=function_args,
                policy=policy,
            )
            timeout_seconds = int(policy.get("timeout_seconds") or 300)
            pending = create_user_input_request(
                conversation_id=request.conversation_id,
                user_id=request.user_id or "anonymous",
                prompt=approval_metadata["message"],
                input_type="confirm",
                timeout=timeout_seconds,
                skill="tool_approval",
                step_id=request.step_id,
                input_metadata=approval_metadata,
            )
            yield {"event": "user_input_required", "data": pending.to_sse_data()}

            result = {
                "tool_call_id": tool_call_id,
                "name": function_name,
                "args": function_args,
                "result": None,
                "success": False,
                "error": None,
                "duration_ms": 0.0,
                "order_index": tool_call.get("order_index", 0),
            }
            started_at = time.perf_counter()
            # Phase 1: wait for the user's approval decision. A timeout HERE is a
            # genuine approval timeout.
            approval_timed_out = False
            try:
                await asyncio.wait_for(pending.event.wait(), timeout=timeout_seconds)
            except asyncio.TimeoutError:
                result["error"] = f"Tool approval timed out after {timeout_seconds} seconds"
                result["result"] = {"error": result["error"]}
                approval_timed_out = True

            # Phase 2: act on the decision and (if approved) execute the tool. A timeout
            # or any other error HERE is a tool-EXECUTION failure: it must not be
            # mislabeled as an approval timeout, and — critically — it must be CAUGHT so
            # the approved tool_call still gets a paired tool-result message instead of
            # orphaning the assistant tool_calls (which the next LLM call rejects 400).
            if not approval_timed_out:
                try:
                    if pending.error:
                        result["error"] = pending.error
                        result["result"] = {"error": pending.error}
                    else:
                        submission_value = pending.result.get("value") if isinstance(pending.result, dict) else None
                        submission_payload = submission_value if isinstance(submission_value, dict) else {}
                        decision = str(submission_payload.get("decision") or "approved").strip().lower()
                        final_args = submission_payload.get("final_args")
                        if not isinstance(final_args, dict):
                            final_args = dict(function_args or {})
                        final_args = self.services.normalize_tool_args(deep_parse_json(final_args))
                        result["args"] = final_args

                        if decision != "approved":
                            result["error"] = "Tool execution rejected by user"
                            result["result"] = {
                                "error": result["error"],
                                "_hitl": {
                                    "approved": False,
                                    "real_tool_name": real_tool_name,
                                    "original_args": dict(function_args or {}),
                                    "final_args": final_args,
                                },
                            }
                        else:
                            tool_result = await self._execute_tool_once(
                                function_name=function_name,
                                function_args=final_args,
                                conversation_id=request.conversation_id,
                                user_role=request.user_role,
                                user_id=request.user_id,
                            )
                            if isinstance(tool_result, dict):
                                tool_result = {
                                    **tool_result,
                                    "_hitl": {
                                        "approved": True,
                                        "real_tool_name": real_tool_name,
                                        "original_args": dict(function_args or {}),
                                        "final_args": final_args,
                                    },
                                }
                            else:
                                tool_result = {
                                    "value": tool_result,
                                    "_hitl": {
                                        "approved": True,
                                        "real_tool_name": real_tool_name,
                                        "original_args": dict(function_args or {}),
                                        "final_args": final_args,
                                    },
                                }
                            success, error = self._interpret_tool_result_status(tool_result)
                            result["result"] = tool_result
                            result["success"] = success
                            result["error"] = error
                except asyncio.TimeoutError:
                    result["error"] = "Tool execution timed out"
                    result["result"] = {"error": result["error"]}
                except Exception as exc:
                    error_msg = str(exc)
                    logger.error("[Agent] Guarded tool %s failed: %s", function_name, error_msg)
                    result["error"] = error_msg
                    result["result"] = {"error": error_msg}
            result["duration_ms"] = round((time.perf_counter() - started_at) * 1000, 2)
            execution_results.append(result)

        execution_results.extend(
            await self._execute_tool_calls_parallel(
                tool_calls=regular_tool_calls,
                conversation_id=request.conversation_id,
                user_role=request.user_role,
                user_id=request.user_id,
            )
        )
        execution_results.sort(key=lambda item: int(item.get("order_index") or 0))

        # O(1) lookup: pre-build telemetry index by tool_call_id
        _telemetry_by_id = {
            item.get("tool_call_id"): item.get("telemetry", {})
            for item in prepared_tool_calls
            if item.get("tool_call_id")
        }

        pending_tool_messages: List[Dict[str, str]] = []
        trailing_events: List[Dict[str, Any]] = []

        for result in execution_results:
            tool_call_id = result.get("tool_call_id", "")
            function_name = result.get("name", "")
            real_function_name = self._resolve_real_tool_name(function_name)
            function_args = self.services.normalize_tool_args(result.get("args", {}))
            tool_result = result.get("result", {})
            success = result.get("success", False)
            error = result.get("error")
            duration_ms = float(result.get("duration_ms") or 0.0)
            telemetry = _telemetry_by_id.get(tool_call_id, {})
            provider_name = str(
                telemetry.get("provider_name")
                or self.services.tool_provider_name(real_function_name)
                or ""
            ).strip()
            result_summary = self.services.summarize_tool_result(tool_result)
            span_status = str(result.get("span_status") or ("success" if success else "failed"))
            routing_metadata = self._build_tool_routing_metadata(tool_result)

            logger.info("[Agent] Tool %s result: success=%s", function_name, success)
            tool_result_sources: List[Dict] = []
            tool_result_knowledge_bases: List[str] = []

            if success and real_function_name in ["search_knowledge_base", "document_search"]:
                tool_result_sources = self.services.extract_sources_from_tool_result(tool_result)
                tool_result_knowledge_bases = self.services.extract_knowledge_base_slugs_from_sources(
                    tool_result_sources
                )
                is_empty_result = False
                if isinstance(tool_result, list) and len(tool_result) == 0:
                    is_empty_result = True
                elif (
                    isinstance(tool_result, dict)
                    and isinstance(tool_result.get("data"), list)
                    and len(tool_result.get("data")) == 0
                ):
                    is_empty_result = True

                if is_empty_result:
                    logger.warning(
                        "[Agent] 搜索工具 %s 返回空结果: %s",
                        function_name,
                        self.services.tool_args_signature(function_name, function_args),
                    )
                else:
                    request.sources.extend(
                        tool_result_sources or self.services.extract_sources_from_tool_result(tool_result)
                    )

            if success:
                skill_logger.log_tool_result(
                    tool_name=function_name,
                    success=True,
                    result_preview=json.dumps(
                        redact_observability_payload(tool_result),
                        ensure_ascii=False,
                    )[:500],
                )
                yield {
                    "event": "tool_result",
                    "data": {
                        "name": function_name,
                        "provider_name": provider_name,
                        "success": True,
                        "skill": request.active_skill_name_result,
                        "duration_ms": duration_ms,
                        "knowledge_bases": tool_result_knowledge_bases,
                        "sources": tool_result_sources[:5],
                        "result_summary": result_summary,
                        "result": tool_result,
                    },
                }
                if isinstance(tool_result, dict) and isinstance(tool_result.get("_hitl"), dict):
                    trailing_events.append(
                        {
                            "event": "tool_approval_result",
                            "data": {
                                "tool_call_id": tool_call_id,
                                "tool_name": tool_result["_hitl"].get("real_tool_name") or function_name,
                                "approved": bool(tool_result["_hitl"].get("approved")),
                                "final_args": tool_result["_hitl"].get("final_args") or function_args,
                            },
                        }
                    )
            else:
                skill_logger.log_tool_result(
                    tool_name=function_name,
                    success=False,
                    error=error or "Unknown error",
                )
                yield {
                    "event": "tool_result",
                    "data": {
                        "name": function_name,
                        "provider_name": provider_name,
                        "success": False,
                        "error": error or "Unknown error",
                        "skill": request.active_skill_name_result,
                        "duration_ms": duration_ms,
                        "result_summary": result_summary,
                        "result": tool_result,
                    },
                }
                if isinstance(tool_result, dict) and isinstance(tool_result.get("_hitl"), dict):
                    trailing_events.append(
                        {
                            "event": "tool_approval_result",
                            "data": {
                                "tool_call_id": tool_call_id,
                                "tool_name": tool_result["_hitl"].get("real_tool_name") or function_name,
                                "approved": bool(tool_result["_hitl"].get("approved")),
                                "final_args": tool_result["_hitl"].get("final_args") or function_args,
                            },
                        }
                    )

            self.services.record_observability_span(
                turn_id=request.turn_id,
                conversation_id=request.conversation_id,
                user_id=request.user_id,
                span_type="tool",
                phase="loop",
                name=function_name,
                status=span_status,
                loop_index=request.iteration + 1,
                duration_ms=duration_ms,
                tool_name=function_name,
                skill_name=request.active_skill_name_result,
                metadata=redact_observability_payload({
                    "tool_call_id": tool_call_id,
                    "step_id": request.step_id,
                    "tool_family": telemetry.get("tool_family")
                    or self.services.classify_tool_family(function_name),
                    "provider_name": telemetry.get("provider_name")
                    or self.services.tool_provider_name(function_name),
                    "args": function_args,
                    "arg_keys": telemetry.get("arg_keys") or sorted(function_args.keys()),
                    "focus_args": telemetry.get("focus_args")
                    or self.services.extract_tool_focus_args(function_args),
                    "args_signature": telemetry.get("args_signature")
                    or self.services.tool_args_signature(function_name, function_args),
                    "is_repeated_call": bool(telemetry.get("is_repeated_call")),
                    "is_repeated_in_step": bool(telemetry.get("is_repeated_in_step")),
                    "result_kind": result_summary.get("result_kind"),
                    "result_count": result_summary.get("result_count"),
                    "result_size_chars": result_summary.get("result_size_chars"),
                    "is_empty_result": result_summary.get("is_empty_result"),
                    "sample_ids": result_summary.get("sample_ids", []),
                    "sample_titles": result_summary.get("sample_titles", []),
                    "error": error,
                    "error_type": result.get("error_type") or self.services.infer_tool_error_type(error, span_status),
                    "error_message": error or "",
                    **routing_metadata,
                }),
            )
            self._record_routed_tool_observability_spans(
                request=request,
                parent_tool_call_id=tool_call_id,
                parent_function_name=function_name,
                parent_function_args=function_args,
                parent_tool_result=tool_result,
                parent_success=success,
                telemetry=telemetry,
                fallback_duration_ms=duration_ms,
            )
            model_context_result = self._tool_result_for_model_context(real_function_name, tool_result)
            raw_content = json.dumps(model_context_result, ensure_ascii=False)
            cleaned_content = sanitize_tool_result(raw_content)
            pending_tool_messages.append(
                {
                    "tool_call_id": tool_call_id,
                    "tool_name": function_name,
                    "cleaned_content": cleaned_content,
                }
            )

        summarized_contents = await self._summarize_tool_messages_parallel(
            pending_tool_messages,
            user_message=request.user_message,
        )

        for item, final_content in zip(pending_tool_messages, summarized_contents):
            request.messages.append(
                {
                    "role": "tool",
                    "tool_call_id": item["tool_call_id"],
                    "name": item["tool_name"],
                    "content": final_content,
                }
            )

        for event in trailing_events:
            yield event
