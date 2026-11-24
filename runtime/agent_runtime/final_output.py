import asyncio
import logging
import time
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy
from runtime.agent_runtime.clinical_evidence import (
    ClinicalEvidenceIssue,
    ResearchOutputContractError,
    find_research_output,
    recording_fingerprint_for_path,
    requires_research_output,
    render_research_output,
    validate_research_output,
)
from runtime.agent_runtime.orchestrator import RuntimeFinalizationResult
from runtime.agent_runtime.output_utils import append_extra_message, sanitize_content
from runtime.agent_runtime.verifier import VerificationService
from runtime.core.config import config_manager
from runtime.models.verification import VerificationResult
from runtime.prompts import render_prompt
from runtime.skills.models import ExecutionState
from runtime.skills.skill_logger import skill_logger

logger = logging.getLogger(__name__)
class RuntimeFinalOutputCoordinator:
    """Verification, alignment, persistence, and final SSE delivery owner."""

    def __init__(self, service: Any, *, postprocess) -> None:
        self._service = service
        self._postprocess = postprocess

    @property
    def _verification_config(self):
        return self._postprocess.bundle.verification_config

    @property
    def _verification_service(self):
        return self._postprocess.bundle.verification_service

    @property
    def _compress_ai_service(self):
        return getattr(self._postprocess.bundle, "compress_ai_service", None)

    @property
    def _verification_model_name(self) -> Optional[str]:
        return self._postprocess.bundle.verification_model_name

    @staticmethod
    def _is_fast_path_plan(state: ExecutionState) -> bool:
        return RuntimePlanningPolicy.is_fast_path_plan(getattr(state, "plan", None))

    async def evaluate_runtime_final_answer(
        self,
        *,
        conversation_id: str,
        user_question: str,
        final_content: str,
        sources: List[Dict],
        state: ExecutionState,
    ) -> RuntimeFinalizationResult:
        research_output = find_research_output(state.step_results)
        if research_output is not None:
            if not str(state.request_id or "").strip():
                raise ResearchOutputContractError(
                    (
                        ClinicalEvidenceIssue(
                            "missing_runtime_request_scope",
                            "$.request_id",
                            "structured research output requires a bound runtime request ID",
                        ),
                    )
                )
            if not str(state.message_id or "").strip():
                raise ResearchOutputContractError(
                    (
                        ClinicalEvidenceIssue(
                            "missing_runtime_message_scope",
                            "$.message_id",
                            "structured research output requires a preallocated assistant message ID",
                        ),
                    )
                )
            expected_fingerprint = recording_fingerprint_for_path(state.recording_path)
            if not str(state.state_revision or "").strip() and expected_fingerprint:
                state.state_revision = f"recording-{expected_fingerprint[:24]}"
            evidence_issues = validate_research_output(
                research_output,
                receipts=state.action_receipts,
                execution_evidence=state.research_evidence_ledger,
                expected_request_id=state.request_id,
                expected_conversation_id=conversation_id,
                expected_message_id=state.message_id,
                expected_state_revision=state.state_revision,
                expected_recording_fingerprint=expected_fingerprint,
                expected_response_language=state.response_language,
            )
            if evidence_issues:
                raise ResearchOutputContractError(evidence_issues)
            state.research_output = dict(research_output)
            final_content = render_research_output(research_output)
        elif requires_research_output(
            user_question=user_question,
            final_content=final_content,
            state=state,
        ):
            raise ResearchOutputContractError(
                (
                    ClinicalEvidenceIssue(
                        "missing_research_output",
                        "$",
                        "case-specific research conclusions require canonical structured evidence",
                    ),
                )
            )

        if self._is_fast_path_plan(state):
            return RuntimeFinalizationResult(
                final_content=final_content,
                sources=sources,
            )

        verified_content, verification_event = await self.run_verification_stage(
            conversation_id=conversation_id,
            user_question=user_question,
            final_content=final_content,
            state=state,
        )

        return RuntimeFinalizationResult(
            final_content=verified_content,
            sources=sources,
            verification_event=verification_event,
        )

    async def run_verification_stage(
        self,
        *,
        conversation_id: str,
        user_question: str,
        final_content: str,
        state: ExecutionState,
    ) -> Tuple[str, Optional[Dict[str, Any]]]:
        """Advisory-only answer-quality check.

        Detects empty / off-topic / incoherent final answers (cheap rule-based
        fast-path + a light LLM judge) and, on failure, APPENDS a guide or
        disclaimer. It never rewrites the answer or re-runs the ReAct loop, so
        it stays compatible with live token streaming.
        """
        if self._is_fast_path_plan(state):
            return final_content, None

        verification_service = self._verification_service
        verification_config = self._verification_config
        if not verification_config.enabled or not verification_service:
            return final_content, None

        started = datetime.now()
        original_content = final_content
        verification_result = VerificationResult(verdict="success", reason="", confidence=0.0)
        verifier_source = "unknown"
        verifier_model = "unknown"
        verifier_output = ""
        event: Optional[Dict[str, Any]] = None

        try:
            total_tool_calls = sum((result.tool_calls_count or 0) for result in state.step_results.values())
            has_sources = bool(
                state.all_sources
                or any(result.sources for result in state.step_results.values())
            )
            final_step = state.get_last_runtime_step()
            final_step_type = final_step.step_type if final_step else "general"
            verification_result = await asyncio.wait_for(
                verification_service.verify(
                    user_question=user_question,
                    final_answer=final_content,
                    tool_calls_count=total_tool_calls,
                    has_sources=has_sources,
                    step_type=final_step_type,
                ),
                timeout=verification_config.timeout_seconds,
            )
            verifier_debug = getattr(verification_service, "last_debug", None)
            if isinstance(verifier_debug, dict):
                verifier_source = str(verifier_debug.get("mode", "unknown"))
                verifier_output = str(verifier_debug.get("raw_output", ""))
        except Exception as exc:
            logger.warning("[Agent] verification timeout/failure, fallback: %s", exc)

        verification_ai_service = getattr(verification_service, "ai_service", None)
        verification_ai_cfg = getattr(verification_ai_service, "config", None)
        if verification_ai_cfg and getattr(verification_ai_cfg, "model", None):
            verifier_model = str(verification_ai_cfg.model)
        elif self._verification_model_name:
            verifier_model = str(self._verification_model_name)

        if verification_result.verdict == "failure":
            reason = verification_result.reason or ""
            if VerificationService.is_content_empty_failure(reason):
                guide = (verification_config.guide_message or "").strip()
                if guide:
                    final_content = append_extra_message(final_content, guide)
                elif not (final_content or "").strip():
                    final_content = verification_config.fallback_message
            else:
                disclaimer = (verification_config.disclaimer_message or "").strip()
                if disclaimer:
                    final_content = append_extra_message(final_content, disclaimer)
                elif not (final_content or "").strip():
                    final_content = verification_config.fallback_message
            event = {
                "event": "verification",
                "data": {"verdict": "failure", "reason": reason},
            }
        elif verification_result.verdict == "partial_success":
            event = {
                "event": "verification",
                "data": {
                    "verdict": "partial_success",
                    "reason": verification_result.reason,
                },
            }

        duration_ms = (datetime.now() - started).total_seconds() * 1000
        skill_logger.log_verification(
            conversation_id=conversation_id,
            verdict=verification_result.verdict,
            reason=verification_result.reason,
            confidence=verification_result.confidence,
            duration_ms=duration_ms,
            repair_triggered=False,
            source=verifier_source,
            verification_model=verifier_model,
            model_output=verifier_output,
            user_question=user_question,
            answer_before=original_content or "",
            answer_after=final_content,
        )
        self._service.record_observability_span(
            turn_id=state.current_turn_id,
            conversation_id=state.conversation_id or conversation_id,
            user_id=state.user_id,
            span_type="llm" if verifier_source == "llm" else "skill",
            phase="verification",
            name="response_verification",
            status=verification_result.verdict,
            duration_ms=duration_ms,
            model_used=verifier_model,
            metadata={
                "verdict": verification_result.verdict,
                "reason": verification_result.reason,
                "confidence": verification_result.confidence,
                "repair_triggered": False,
                "source": verifier_source,
                "answer_changed": final_content != original_content,
                "answer_length_before": len(original_content or ""),
                "answer_length_after": len(final_content or ""),
            },
        )
        return final_content, event

    async def _finalize_turn(
        self,
        *,
        conversation_id: str,
        current_turn_id: Optional[str],
        final_content: Optional[str] = None,
        status: str = "completed",
        error_message: Optional[str] = None,
        total_iterations: Optional[int] = None,
        model_used: Optional[str] = None,
        tokens_used: Optional[int] = None,
        sources: Optional[List[Dict]] = None,
        message_id: Optional[str] = None,
        request_id: Optional[str] = None,
        state_revision: Optional[str] = None,
        action_receipts: Optional[List[Dict[str, Any]]] = None,
        research_output: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        return await self._service.persist_turn_completion(
            conversation_id=conversation_id,
            current_turn_id=current_turn_id,
            final_content=final_content,
            status=status,
            error_message=error_message,
            total_iterations=total_iterations,
            model_used=model_used,
            tokens_used=tokens_used,
            sources=sources,
            message_id=message_id,
            request_id=request_id,
            state_revision=state_revision,
            action_receipts=action_receipts,
            research_output=research_output,
        )

    async def finalize_success_response(
        self,
        *,
        conversation_id: str,
        current_turn_id: Optional[str],
        final_content: str,
        total_iterations: int,
        model_used: str,
        tokens_used: Optional[int],
        sources: List[Dict],
        message_id: Optional[str] = None,
        request_id: Optional[str] = None,
        state_revision: Optional[str] = None,
        action_receipts: Optional[List[Dict[str, Any]]] = None,
        research_output: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        assistant_message_id = await self._finalize_turn(
            conversation_id=conversation_id,
            current_turn_id=current_turn_id,
            final_content=final_content,
            status="completed",
            total_iterations=total_iterations,
            model_used=model_used,
            tokens_used=tokens_used,
            sources=sources,
            message_id=message_id,
            request_id=request_id,
            state_revision=state_revision,
            action_receipts=action_receipts,
            research_output=research_output,
        )
        if message_id and assistant_message_id != message_id:
            raise RuntimeError("assistant_message_scope_mismatch")
        return {
            "message_id": assistant_message_id or message_id or f"msg_{conversation_id or 'default'}_{int(time.time() * 1000)}",
            "model_used": model_used,
            "tokens_used": tokens_used,
        }

    async def finalize_failure_response(
        self,
        *,
        conversation_id: str,
        current_turn_id: Optional[str],
        status: str,
        error_message: str,
        total_iterations: Optional[int],
    ) -> None:
        await self._finalize_turn(
            conversation_id=conversation_id,
            current_turn_id=current_turn_id,
            status=status,
            error_message=error_message,
            total_iterations=total_iterations,
        )

    def _resolve_sanitize_replacements(self) -> List[Tuple[str, str]]:
        try:
            cfg = config_manager.config
            if cfg and cfg.sanitize_replacements:
                return [(item[0], item[1]) for item in cfg.sanitize_replacements]
        except Exception:
            pass
        return []

    async def emit_final_content_and_done(
        self,
        *,
        final_content: str,
        conversation_id: str,
        active_skill_name_result: Optional[str],
        skill_reason: str,
        routing_result,
        total_iterations: int,
        request_start_time: datetime,
        sources: List[Dict],
        success_result: Dict,
        ui_commands: Optional[List[Dict]] = None,
        action_receipts: Optional[List[Dict]] = None,
        research_output: Optional[Dict[str, Any]] = None,
        already_streamed: str = "",
    ) -> AsyncGenerator[Dict, None]:
        replacements = self._resolve_sanitize_replacements() or None
        sanitized = sanitize_content(final_content, replacements=replacements)
        # If the answer body was already streamed live (token by token), don't
        # re-send it — emit only the un-streamed tail (e.g. an appended advisory
        # disclaimer). Any mismatch falls back to emitting the full content, so a
        # stale/divergent streamed prefix can never drop content.
        remainder = sanitized
        if already_streamed:
            # Match strip-tolerantly: the final body is whitespace-cleaned
            # (clean_step_output_for_final / scrub / strip) vs the raw streamed
            # text. A real mismatch falls through to the full re-emit, so a
            # divergent prefix can never drop content.
            streamed_norm = sanitize_content(already_streamed, replacements=replacements).strip()
            final_norm = sanitized.strip()
            if streamed_norm and final_norm.startswith(streamed_norm):
                remainder = final_norm[len(streamed_norm):]
        chunk_size = 50
        for i in range(0, len(remainder), chunk_size):
            yield {"event": "content", "data": {"text": remainder[i : i + chunk_size]}}

        duration_ms = (datetime.now() - request_start_time).total_seconds() * 1000
        skill_logger.log_response_completed(
            conversation_id=conversation_id,
            skill_name=active_skill_name_result,
            total_iterations=total_iterations,
            duration_ms=duration_ms,
            sources_count=len(sources),
        )
        yield {
            "event": "done",
            "data": {
                "message_id": success_result["message_id"],
                "sources": sources,
                "model_used": success_result["model_used"],
                "active_skill": active_skill_name_result,
                "skill_reason": skill_reason,
                "routing_method": routing_result.routing_method if routing_result else None,
                "action_receipts": action_receipts or [],
                "ui_commands": ui_commands or [],
                **({"research_output": research_output} if research_output is not None else {}),
            },
        }
