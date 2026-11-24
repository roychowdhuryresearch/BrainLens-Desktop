import asyncio
import copy
import inspect
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional, Protocol, Tuple

from runtime.agent_runtime.user_input import create_user_input_request
from runtime.agent_runtime.tool_executor import ToolExecutionRequest
from runtime.agent_runtime.output_utils import build_thinking_chat_kwargs
from runtime.agent_runtime.completion_contract import completion_repair_prompt, validate_step_output
from runtime.agent_runtime.clinical_evidence import (
    is_safe_non_completion_reply,
    requires_research_output,
)
from runtime.agent_runtime.research_evidence_ledger import trusted_research_evidence_entries
from runtime.context.models import ContextPack
from runtime.prompts import render_prompt
from runtime.skills.models import ExecutionState, ExecutionStep, RoutingResult, StepResult
from runtime.skills.runtime import prepare_skill_context
from runtime.skills.skill_logger import skill_logger
from runtime.skills.skill_registry import skill_registry

logger = logging.getLogger(__name__)

_CASE_SCOPE_INTENT_RE = re.compile(
    r"\b(?:this|that|current|loaded|attached|my|our)\s+"
    r"(?:recording|case|patient|ieeg|eeg|edf|event|run)\b"
    r"|(?:\u8fd9|\u8be5|\u672c\u6b21|\u5f53\u524d|\u5df2\u52a0\u8f7d|\u6211\u7684|\u6211\u4eec\u7684).{0,8}"
    r"(?:\u8bb0\u5f55|\u75c5\u4f8b|\u60a3\u8005|\u8111\u7535|\u4e8b\u4ef6|\u8fd0\u884c)",
    re.IGNORECASE,
)
_CASE_DIAGNOSTIC_INTENT_RE = re.compile(
    r"\b(?:which|where|identify|determine|locali[sz]e|likely|is|are)\b.{0,90}"
    r"\b(?:lead|contact|electrode|channel|soz|seizure[- ]onset|ictal[- ]onset|epileptogenic)\b"
    r"|\b[A-Za-z]{1,8}\d{1,4}(?:-\d{1,4})?\b.{0,50}"
    r"\b(?:soz|seizure[- ]onset|ictal[- ]onset|epileptogenic)\b"
    r"|\bwhich\s+(?:lead|contact|electrode|channel)\b.{0,50}\b(?:starts?|begins?|originates?)\b"
    r"|(?:\u54ea\u4e2a|\u54ea\u91cc|\u5224\u65ad|\u8bc6\u522b|\u5b9a\u4f4d).{0,40}"
    r"(?:\u89e6\u70b9|\u7535\u6781|\u901a\u9053|\u53d1\u4f5c\u8d77\u59cb|\u81f4\u75eb|SOZ)",
    re.IGNORECASE,
)
_GENERIC_CLINICAL_EDUCATION_RE = re.compile(
    r"^\s*(?:what\s+(?:is|are)|define|explain)\s+(?:an?\s+|the\s+)?"
    r"(?:hfos?|high[- ]frequency\s+oscillations?|soz|seizure[- ]onset\s+zone|"
    r"ictal[- ]onset)\s*[?.!]?\s*$",
    re.IGNORECASE,
)


def _stream_final_answer_enabled() -> bool:
    """Live token-streaming of the final answer. Gated, default off — flip
    IEEG_AGENT_STREAM=1 to enable. Read live so it can be toggled per process."""
    return os.environ.get("IEEG_AGENT_STREAM", "").strip().lower() in {"1", "true", "yes", "on"}


class StepExecutorDependencies(Protocol):
    ai_service: Any
    planning_policy: Any
    prompt_assembly: Any
    postprocess: Any
    tool_executor: Any
    message_compressor: Any

    def extract_usage_metrics(self, payload: Optional[Dict[str, Any]]) -> Tuple[int, int, int]:
        ...

    def record_observability_span(self, **kwargs) -> None:
        ...

    def is_cancelled(self, conversation_id: str) -> bool:  # optional in tests
        ...


@dataclass
class StepExecutionRequest:
    step: ExecutionStep
    state: ExecutionState
    message: str
    history: List[Dict]
    knowledge_base_id: Optional[str]
    all_tools: List[Dict]
    base_context_pack: Optional[ContextPack]
    routing_result: RoutingResult
    event_callback: Optional[Callable[[Dict[str, Any]], Optional[Awaitable[None]]]] = None


class StepExecutor:
    """Headless executor for one ReAct step."""

    MAX_EMPTY_RETRIES = 2

    def __init__(self, services: StepExecutorDependencies, *, max_tool_iterations: int = 10):
        self.services = services
        self.max_tool_iterations = max_tool_iterations

    @staticmethod
    def _allows_live_final_content(
        step: ExecutionStep,
        *,
        user_message: str = "",
        state: Optional[ExecutionState] = None,
    ) -> bool:
        """Only unconstrained prose may cross the public stream pre-validation.

        Structured final output can carry clinical claims and provenance.  It
        must remain buffered until its declared schema and the clinical
        evidence contract have both accepted it.  Case/diagnostic intent is
        buffered even before a recording or evidence ledger exists; otherwise
        an unsafe first-pass claim could escape before final validation.
        """
        if not step.is_final_step or step.output_schema is not None:
            return False
        question = str(user_message or "").strip()
        if not question or state is None:
            return True
        if _CASE_SCOPE_INTENT_RE.search(question):
            return False
        if _GENERIC_CLINICAL_EDUCATION_RE.fullmatch(question):
            return True
        if _CASE_DIAGNOSTIC_INTENT_RE.search(question):
            return False
        if requires_research_output(
            user_question=question,
            final_content="A grounded case-specific research result is ready.",
            state=state,
        ):
            return False
        return True

    @staticmethod
    async def _emit_live_event(
        callback: Optional[Callable[[Dict[str, Any]], Optional[Awaitable[None]]]],
        event: Dict[str, Any],
    ) -> None:
        if not callable(callback):
            return
        maybe_awaitable = callback(event)
        if inspect.isawaitable(maybe_awaitable):
            await maybe_awaitable

    async def _stream_chat(
        self,
        messages: List[Dict],
        step_tools: List[Dict],
        chat_kwargs: Dict[str, Any],
        event_callback: Optional[Callable[[Dict[str, Any]], Optional[Awaitable[None]]]],
    ) -> Tuple[Dict[str, Any], str]:
        """Run one streaming LLM call, forwarding content deltas live as `content`
        events. Returns (ai_response_dict, streamed_text). On any streaming error,
        falls back to a normal non-streaming chat() and reports no streamed text."""
        ai_response: Dict[str, Any] = {}
        pieces: List[str] = []
        try:
            async for ev in self.services.ai_service.chat_stream(
                messages, tools=step_tools, **chat_kwargs,
            ):
                etype = ev.get("type")
                if etype == "content":
                    piece = ev.get("text") or ""
                    if piece:
                        pieces.append(piece)
                        await self._emit_live_event(
                            event_callback, {"event": "content", "data": {"text": piece}},
                        )
                elif etype == "final":
                    ai_response = ev.get("response") or {}
        except Exception as exc:
            logger.warning("[Agent] streaming chat failed, falling back to non-streaming: %s", exc)
            ai_response = await self.services.ai_service.chat(
                messages, tools=step_tools, **chat_kwargs,
            )
            return ai_response, ""
        return ai_response, "".join(pieces)

    async def execute(
        self,
        request: StepExecutionRequest,
    ) -> Tuple[StepResult, int, List[Dict], List[Dict], Optional[str], Optional[int]]:
        step = request.step
        state = request.state
        original_output_schema = step.output_schema
        auto_bound_research_contract = False
        contract_state = state
        bind_output_contract = getattr(
            self.services.prompt_assembly,
            "bind_step_output_contract",
            None,
        )
        if callable(bind_output_contract):
            bound = bind_output_contract(
                current_step=step,
                execution_state=state,
                user_message=request.message,
            )
            auto_bound_research_contract = bool(bound and original_output_schema is None)
        selected_skill = (
            state.available_skill_packages.get(step.skill_name)
            or skill_registry.get_by_name(step.skill_name)
        )
        skill_context = None
        if selected_skill:
            skill_context = prepare_skill_context(
                skill=selected_skill,
                user_message=request.message,
                tools=request.all_tools,
                routing_result=request.routing_result,
            )

        step_tools = self.services.planning_policy.resolve_step_tools(
            step=step,
            all_tools=request.all_tools,
            skill_context=skill_context,
        )
        # 诊断日志：跟踪 tools 在 resolve_step_tools 后是否丢失
        if logger.isEnabledFor(logging.DEBUG):
            all_tool_names = [
                t.get("function", {}).get("name", "")
                for t in request.all_tools
                if t.get("function", {}).get("name")
            ]
            step_tool_names = [
                t.get("function", {}).get("name", "")
                for t in step_tools
                if t.get("function", {}).get("name")
            ]
            logger.debug(
                "[StepExecutor] resolve_step_tools: step=%s type=%s "
                "all_tools(%d)=%s -> step_tools(%d)=%s",
                step.step_id, step.step_type,
                len(all_tool_names), all_tool_names,
                len(step_tool_names), step_tool_names,
            )
        else:
            logger.info(
                "[StepExecutor] resolve_step_tools: step=%s all_tools=%d -> step_tools=%d",
                step.step_id, len(request.all_tools), len(step_tools),
            )

        system_prompt = self.services.prompt_assembly.build_system_prompt(
            knowledge_base_id=request.knowledge_base_id,
            tools=step_tools,
            skill_context=skill_context,
            execution_plan=state.plan_view(),
            current_step=step,
            execution_state=state,
        )

        messages = self.services.prompt_assembly.build_step_model_messages(
            system_prompt=system_prompt,
            base_context_pack=request.base_context_pack,
            history=request.history,
            state=state,
            current_step=step,
            user_message=request.message,
        )

        step_sources: List[Dict] = []
        step_events: List[Dict] = []
        step_iterations = 0
        tool_calls_count = 0
        model_used: Optional[str] = None
        tokens_used: Optional[int] = None
        final_content = ""
        empty_retry_count = 0

        is_cancelled_fn = getattr(self.services, "is_cancelled", None)
        for iteration in range(self.max_tool_iterations):
            # 在每轮 LLM 调用之前检查 cancel flag。原本只在 step 边界 check（orchestrator
            # 主循环开头），long-running step（>30s LLM 调用）期间用户按"停止"会被无视到
            # step 完成。这里把检查粒度收到每个 iteration 之前。
            if callable(is_cancelled_fn) and is_cancelled_fn(state.conversation_id):
                logger.info(
                    "[Step] cancelled mid-step at iteration %d/%d for conv=%s step=%s",
                    iteration, self.max_tool_iterations, state.conversation_id, step.step_id,
                )
                step_result = StepResult(
                    step_id=step.step_id,
                    skill_name=step.skill_name,
                    success=False,
                    summary="step cancelled by user",
                    output={"cancelled": True},
                    raw_text="",
                    sources=step_sources,
                    tool_calls_count=tool_calls_count,
                )
                return step_result, step_iterations, step_sources, step_events, model_used, tokens_used
            messages = await self.services.message_compressor.compress_messages_if_needed(messages)
            # Disable Qwen "thinking" CoT on the main ReAct loop — tool selection is
            # the reasoning here, and the CoT trace multiplies per-iteration latency.
            chat_kwargs = build_thinking_chat_kwargs(self.services.ai_service)
            llm_started_at = time.perf_counter()
            if (
                _stream_final_answer_enabled()
                and self._allows_live_final_content(
                    step,
                    user_message=request.message,
                    state=state,
                )
                and hasattr(self.services.ai_service, "chat_stream")
            ):
                # Live-stream the final answer: forward content deltas as `content`
                # events and record the streamed text so the final emitter skips it.
                ai_response, streamed_text = await self._stream_chat(
                    messages, step_tools, chat_kwargs, request.event_callback,
                )
                state.streamed_answer = streamed_text
            else:
                ai_response = await self.services.ai_service.chat(
                    messages, tools=step_tools, **chat_kwargs,
                )
            llm_duration_ms = (time.perf_counter() - llm_started_at) * 1000
            step_iterations += 1

            reasoning_content = ai_response.get("reasoning_content")
            if reasoning_content:
                logger.info("[Agent] Model returned reasoning_content: %s chars", len(reasoning_content))
                final_content_preview = str(ai_response.get("content") or "").strip()
                if self.services.postprocess.should_skip_llm_reasoning_summary(
                    step=step,
                    step_tools=step_tools,
                    final_content=final_content_preview,
                ):
                    compressed = self.services.postprocess.simplify_reasoning_by_rules(reasoning_content)
                else:
                    compressed = await self.services.postprocess.summarize_reasoning(reasoning_content)
                step_events.append({"event": "thinking", "data": {"content": compressed}})

            model_used = ai_response.get("model_used") or model_used
            if isinstance(ai_response.get("usage"), dict):
                tokens_used = ai_response.get("usage", {}).get("total_tokens", tokens_used)
            prompt_tokens, completion_tokens, total_tokens = self.services.extract_usage_metrics(ai_response)
            self.services.record_observability_span(
                turn_id=state.current_turn_id,
                conversation_id=state.conversation_id,
                user_id=state.user_id,
                span_type="llm",
                phase="loop",
                name=f"{step.step_id}:iteration_{iteration + 1}",
                status="success",
                loop_index=iteration + 1,
                duration_ms=llm_duration_ms,
                model_used=ai_response.get("model_used"),
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                skill_name=step.skill_name,
                metadata={"step_id": step.step_id},
            )

            tool_calls = ai_response.get("tool_calls")
            skill_logger.log_step_iteration(
                conversation_id=state.conversation_id,
                step_id=step.step_id,
                iteration=iteration + 1,
                message_count=len(messages),
                tool_calls_count=len(tool_calls or []),
            )
            if tool_calls:
                user_input_tool_call = None
                other_tool_calls = []
                for tool_call in tool_calls:
                    func_name = tool_call.get("function", {}).get("name", "")
                    if func_name == "request_user_input":
                        user_input_tool_call = tool_call
                    else:
                        other_tool_calls.append(tool_call)

                if other_tool_calls:
                    iteration_event_start = len(step_events)
                    tool_calls_count += len(other_tool_calls)
                    async for event in self.services.tool_executor.execute(
                        ToolExecutionRequest(
                            tool_calls=other_tool_calls,
                            tools=step_tools,
                            messages=messages,
                            ai_response=ai_response,
                            sources=step_sources,
                            active_skill_name_result=step.skill_name,
                            iteration=iteration,
                            conversation_id=state.conversation_id,
                            turn_id=state.current_turn_id,
                            user_id=state.user_id,
                            user_role=state.user_role,
                            step_id=step.step_id,
                            user_message=request.message,
                        )
                    ):
                        data = event.get("data", {})
                        if isinstance(data, dict):
                            data.setdefault("step_id", step.step_id)
                            data.setdefault("step_index", state.current_step_index)
                        step_events.append(event)
                        if event.get("event") == "user_input_required":
                            await self._emit_live_event(request.event_callback, event)

                    trusted_entries = trusted_research_evidence_entries(
                        state=state,
                        events=step_events[iteration_event_start:],
                    )
                    if trusted_entries and callable(bind_output_contract):
                        rebound_state = copy.copy(state)
                        rebound_state.research_evidence_ledger = [
                            *(getattr(contract_state, "research_evidence_ledger", None) or []),
                            *trusted_entries,
                        ][-128:]
                        rebound_state.skills_executed = [
                            *(getattr(state, "skills_executed", None) or []),
                            step.skill_name,
                        ]
                        was_unbound = step.output_schema is None
                        rebound = bind_output_contract(
                            current_step=step,
                            execution_state=rebound_state,
                            user_message=request.message,
                        )
                        if rebound:
                            contract_state = rebound_state
                            if was_unbound and original_output_schema is None:
                                auto_bound_research_contract = True
                            rebound_prompt = self.services.prompt_assembly.build_system_prompt(
                                knowledge_base_id=request.knowledge_base_id,
                                tools=step_tools,
                                skill_context=skill_context,
                                execution_plan=state.plan_view(),
                                current_step=step,
                                execution_state=rebound_state,
                            )
                            for message in messages:
                                if message.get("role") == "system":
                                    message["content"] = rebound_prompt
                                    break
                            else:
                                messages.insert(0, {"role": "system", "content": rebound_prompt})

                if user_input_tool_call:
                    tool_calls_count += 1
                    func_args_str = user_input_tool_call.get("function", {}).get("arguments", "{}")
                    try:
                        func_args = json.loads(func_args_str)
                    except json.JSONDecodeError:
                        func_args = {}

                    prompt = func_args.get("prompt", "请提供输入")
                    input_type = func_args.get("input_type", "text")
                    options = func_args.get("options", [])
                    timeout = func_args.get("timeout", 300)
                    memory_writeback = func_args.get("memory_writeback")
                    pending = create_user_input_request(
                        conversation_id=state.conversation_id,
                        user_id=state.user_id or "anonymous",
                        prompt=prompt,
                        input_type=input_type,
                        options=options,
                        timeout=timeout,
                        skill=step.skill_name,
                        step_id=step.step_id,
                        memory_writeback=memory_writeback,
                    )

                    step_events.append({"event": "user_input_required", "data": pending.to_sse_data()})
                    messages.append(
                        {
                            "role": "assistant",
                            "content": ai_response.get("content"),
                            "tool_calls": [user_input_tool_call],
                        }
                    )
                    logger.info("[Agent] Waiting for user input: input_id=%s", pending.input_id)
                    return (
                        StepResult(
                            step_id=step.step_id,
                            skill_name=step.skill_name,
                            success=False,
                            summary=f"等待用户输入: {prompt}",
                            output={"waiting_for_input": True, "input_id": pending.input_id},
                            raw_text="",
                            sources=step_sources,
                            tool_calls_count=tool_calls_count,
                        ),
                        step_iterations,
                        step_sources,
                        step_events,
                        model_used,
                        tokens_used,
                    )

                if other_tool_calls:
                    continue

            final_content = ai_response.get("content", "")
            reasoning_content = ai_response.get("reasoning_content", "")
            content_is_empty = not (final_content and final_content.strip())
            if content_is_empty and iteration < self.max_tool_iterations - 1:
                empty_retry_count += 1
                if empty_retry_count > self.MAX_EMPTY_RETRIES:
                    logger.info(
                        "[Agent] 空返回重试已达上限 (%s)，停止重试",
                        self.MAX_EMPTY_RETRIES,
                    )
                    break
                prompt = render_prompt("runtime/empty_response_continue.md")
                if reasoning_content:
                    if any(keyword in reasoning_content for keyword in ["读取文档", "调用工具"]):
                        prompt = render_prompt("runtime/empty_response_tool_call.md")
                    elif "总结" in reasoning_content:
                        prompt = render_prompt("runtime/empty_response_summary.md")

                logger.info(
                    "[Agent] 检测到空返回，在迭代 %s/%s 添加引导提示 (空重试 %s/%s): %s",
                    iteration + 1,
                    self.max_tool_iterations,
                    empty_retry_count,
                    self.MAX_EMPTY_RETRIES,
                    prompt,
                )
                messages.append({"role": "user", "content": prompt})
                continue

            if auto_bound_research_contract and is_safe_non_completion_reply(final_content):
                # Missing input and genuinely inconclusive outcomes remain
                # ordinary prose.  This release is limited to contracts the
                # runtime added automatically; explicit plan schemas still
                # fail closed.
                step.output_schema = original_output_schema
                auto_bound_research_contract = False

            if self.services.prompt_assembly.is_step_complete(step, ai_response, final_content):
                return (
                    self.services.prompt_assembly.parse_step_result(
                        step=step,
                        final_content=final_content,
                        sources=self.services.prompt_assembly.dedup_sources(step_sources),
                        tool_calls_count=tool_calls_count,
                    ),
                    step_iterations,
                    step_sources,
                    step_events,
                    model_used,
                    tokens_used,
                )

            completion_validation = validate_step_output(step, final_content)
            if (
                step.output_schema is not None
                and final_content
                and not completion_validation.ok
                and iteration < self.max_tool_iterations - 1
            ):
                messages.append({"role": "assistant", "content": final_content})
                messages.append(
                    {
                        "role": "user",
                        "content": completion_repair_prompt(completion_validation.errors),
                    }
                )
                continue

        logger.info("[Agent] Step %s 达到最大迭代次数 %s", step.step_id, self.max_tool_iterations)
        has_valid_search_results = len(step_sources) > 0
        has_content = bool(final_content and final_content.strip())

        if has_content:
            default_content = final_content
        else:
            # 工具全部失败 / 多轮空返回时，先让主模型基于已有上下文 + 自身知识
            # 给出降级答复，避免直接返回硬编码兜底文案（会被用户视为"没回答"）。
            default_content = await self._generate_tool_failure_fallback(
                step=step,
                state=state,
                messages=messages,
                tools=step_tools,
                has_sources=has_valid_search_results,
            )
            if not default_content:
                if not has_valid_search_results:
                    logger.info("[Agent] 所有搜索都返回空结果，生成默认响应")
                    default_content = "抱歉，我没有找到相关信息。请尝试其他搜索关键词或具体说明你的问题。"
                else:
                    logger.info("[Agent] 有搜索结果但没有生成完整内容，生成默认响应")
                    default_content = "我尝试了多次查找信息，但未能完成你的请求。请尝试更具体的问题或调整搜索关键词。"

        if auto_bound_research_contract and is_safe_non_completion_reply(default_content):
            step.output_schema = original_output_schema

        parsed_result = self.services.prompt_assembly.parse_step_result(
            step=step,
            final_content=default_content,
            sources=self.services.prompt_assembly.dedup_sources(step_sources),
            tool_calls_count=tool_calls_count,
        )
        if step.output_schema is not None and not parsed_result.success:
            parsed_result.raw_text = ""
            parsed_result.summary = f"{step.skill_name} failed its completion contract"
        return (
            parsed_result,
            step_iterations,
            step_sources,
            step_events,
            model_used,
            tokens_used,
        )

    async def _generate_tool_failure_fallback(
        self,
        *,
        step: ExecutionStep,
        state: ExecutionState,
        messages: List[Dict],
        tools: List[Dict],
        has_sources: bool,
    ) -> Optional[str]:
        """多轮工具调用后仍无正文内容时，让 LLM 基于已有上下文 + 自身知识
        给出降级答复；禁止调用工具，避免再次进入失败-重试循环。

        返回 None 表示 LLM 也没给出有用内容，交回上游兜底。"""
        # NOTE: this guidance is a meta-instruction, not user-facing text. Keep it language-neutral and
        # explicitly defer to the user's language — a hardcoded Chinese instruction here used to force the
        # whole degraded reply into Chinese even for English/Japanese/etc. prompts (breaking the language policy).
        if has_sources:
            guidance = (
                "The retrieved material isn't enough for a complete answer. Using the existing context and "
                "your own knowledge, give the most useful answer you can. If you need to note that retrieval "
                "was insufficient, say so briefly. RESPOND IN THE USER'S LANGUAGE (match the user's most recent "
                "message). Do not call any tools."
            )
        else:
            guidance = (
                "Repeated attempts to retrieve external material all failed. Give a best-effort answer from "
                "your own knowledge, and briefly note at the start that retrieval is temporarily unavailable "
                "and you're answering from existing knowledge. RESPOND IN THE USER'S LANGUAGE (match the user's "
                "most recent message), not necessarily English or Chinese. Do not call any tools."
            )
        try:
            # This is the already-degraded path; bound it so a hung provider
            # call can't burn the rest of the step budget — fall back to the
            # upstream default reply instead.
            ai_response = await asyncio.wait_for(
                self.services.ai_service.chat(
                    messages + [{"role": "user", "content": guidance}],
                    tools=[],
                    **build_thinking_chat_kwargs(self.services.ai_service),
                ),
                timeout=20,
            )
        except asyncio.TimeoutError:
            logger.warning("[Agent] Tool-failure fallback LLM call timed out after 20s")
            return None
        except Exception as exc:
            logger.warning("[Agent] Tool-failure fallback LLM call failed: %s", exc)
            return None
        content = (ai_response.get("content") or "").strip() if isinstance(ai_response, dict) else ""
        if not content:
            return None
        self.services.record_observability_span(
            turn_id=state.current_turn_id,
            conversation_id=state.conversation_id,
            user_id=state.user_id,
            span_type="llm",
            phase="loop",
            name=f"{step.step_id}:tool_failure_fallback",
            status="success",
            skill_name=step.skill_name,
            metadata={"step_id": step.step_id, "had_sources": has_sources},
        )
        return content
