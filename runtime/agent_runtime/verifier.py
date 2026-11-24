import json
import logging
import re
from typing import Any, Optional

from runtime.models.verification import VerificationResult
from runtime.models.schemas import VerificationConfig
from runtime.prompts import render_prompt
from runtime.agent_runtime.output_utils import build_thinking_chat_kwargs

logger = logging.getLogger(__name__)


class VerificationService:
    """只校验问答对齐，不评估事实准确性。"""

    _FAST_FAILURE_REASONS = {
        "empty_content",
        "too_short",
        "pure_rejection",
    }
    _REJECT_PATTERNS = [
        "无法回答",
        "无法帮助",
        "i cannot",
        "i'm unable",
        "i am unable",
        "无相关权限",
        "该问题超出",
        "请联系人工",
    ]
    _SHORT_PLACEHOLDER_VALUES = {
        "n/a",
        "na",
        "null",
        "none",
        "todo",
        "tbd",
        "待补充",
    }
    _MEANINGFUL_CHAR_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff]")
    _DIRECT_ANSWER_PATTERNS = (
        "只回复最终答案",
        "只回复答案",
        "只要答案",
        "直接回答",
        "直接给答案",
        "只回答",
        "仅回答",
        "只输出答案",
        "只输出最终答案",
        "只输出结果",
        "不要解释",
    )

    def __init__(
        self,
        ai_service: Any,
        config: Optional[VerificationConfig] = None,
    ):
        self.ai_service = ai_service
        self.config = config or VerificationConfig()
        self.last_debug: dict = {}

    async def verify(
        self,
        user_question: str,
        final_answer: str,
        tool_calls_count: int = 0,
        has_sources: bool = False,
        step_type: str = "general",
    ) -> VerificationResult:
        forced = self._build_forced_result()
        if forced is not None:
            self.last_debug = {
                "mode": "forced",
                "raw_output": "",
                "parsed": forced.model_dump(mode="json"),
            }
            return forced

        fast_result = self._fast_check_failure(final_answer)
        if fast_result is not None:
            self.last_debug = {
                "mode": "fast_check",
                "raw_output": "",
                "parsed": fast_result.model_dump(mode="json"),
            }
            return fast_result

        fast_success = self._fast_check_success(
            user_question=user_question,
            final_answer=final_answer,
            tool_calls_count=tool_calls_count,
            has_sources=has_sources,
            step_type=step_type,
        )
        if fast_success is not None:
            self.last_debug = {
                "mode": "fast_success",
                "raw_output": "",
                "parsed": fast_success.model_dump(mode="json"),
            }
            return fast_success

        prompt = self._build_prompt(
            user_question=user_question,
            final_answer=final_answer,
            tool_calls_count=tool_calls_count,
            has_sources=has_sources,
            step_type=step_type,
        )
        try:
            response = await self.ai_service.chat(
                [
                    {
                        "role": "system",
                        "content": render_prompt("runtime/verifier_system.md"),
                    },
                    {"role": "user", "content": prompt},
                ],
                # The advisory verifier was the one chat path still running with
                # Qwen "thinking"/CoT ON, adding seconds of latency after the
                # answer is drafted. Disable it like every other chat call does.
                **build_thinking_chat_kwargs(self.ai_service),
            )
            raw = (
                response.get("content", "")
                if isinstance(response, dict)
                else str(response)
            )
            parsed = self._parse_json(raw)
            self.last_debug = {
                "mode": "llm",
                "raw_output": raw,
                "parsed": parsed,
            }
            return VerificationResult(**parsed)
        except Exception as e:
            logger.warning(
                "[Verifier] verification failed, fallback success: %s",
                e,
            )
            self.last_debug = {
                "mode": "fallback_success",
                "raw_output": "",
                "error": str(e),
                "parsed": {
                    "verdict": "success",
                    "reason": "",
                    "confidence": 0.0,
                },
            }
            return VerificationResult(
                verdict="success",
                reason="",
                confidence=0.0,
            )

    def _build_forced_result(self) -> Optional[VerificationResult]:
        if not self.config.test_mode_enabled:
            return None

        if not self.config.forced_verdict:
            logger.warning(
                "[Verifier] test_mode_enabled=true but forced_verdict is empty"
            )
            return None

        return VerificationResult(
            verdict=self.config.forced_verdict,
            reason=self.config.forced_reason or "forced_by_test_mode",
            confidence=(
                self.config.forced_confidence
                if self.config.forced_confidence is not None
                else 0.99
            ),
        )

    def _build_prompt(
        self,
        user_question: str,
        final_answer: str,
        tool_calls_count: int,
        has_sources: bool,
        step_type: str,
    ) -> str:
        return render_prompt(
            "runtime/verifier_user.md",
            user_question=user_question,
            final_answer=final_answer,
            tool_calls_count=tool_calls_count,
            has_sources=has_sources,
            step_type=step_type,
        )

    def _fast_check_failure(
        self,
        final_answer: str,
    ) -> Optional[VerificationResult]:
        text = (final_answer or "").strip()
        if not text:
            return VerificationResult(
                verdict="failure",
                reason="empty_content",
                confidence=1.0,
            )

        if (
            len(text) < self.config.min_answer_length
            and not self._looks_like_substantive_short_answer(text)
        ):
            return VerificationResult(
                verdict="failure",
                reason="too_short",
                confidence=1.0,
            )

        short_text = len(text) < 50
        lower_text = text.lower()
        has_reject = any(
            pattern in lower_text
            for pattern in self._REJECT_PATTERNS
        )
        if short_text and has_reject:
            return VerificationResult(
                verdict="failure",
                reason="pure_rejection",
                confidence=1.0,
            )
        return None

    def _looks_like_substantive_short_answer(self, text: str) -> bool:
        normalized = re.sub(r"\s+", "", (text or "")).strip().lower()
        if not normalized:
            return False
        if normalized in self._SHORT_PLACEHOLDER_VALUES:
            return False
        if any(
            pattern in normalized
            for pattern in self._REJECT_PATTERNS
        ):
            return False
        return bool(self._MEANINGFUL_CHAR_RE.search(text))

    def _fast_check_success(
        self,
        *,
        user_question: str,
        final_answer: str,
        tool_calls_count: int,
        has_sources: bool,
        step_type: str,
    ) -> Optional[VerificationResult]:
        text = (final_answer or "").strip()
        if not text:
            return None
        if tool_calls_count or has_sources or step_type != "general":
            return None
        if len(text) > 32:
            return None
        if not self._looks_like_substantive_short_answer(text):
            return None
        if not self._expects_brief_direct_answer(user_question):
            return None
        return VerificationResult(
            verdict="success",
            reason="direct_short_answer",
            confidence=0.95,
        )

    def _expects_brief_direct_answer(self, user_question: str) -> bool:
        normalized = re.sub(r"\s+", "", (user_question or "")).strip().lower()
        if not normalized:
            return False
        return any(pattern in normalized for pattern in self._DIRECT_ANSWER_PATTERNS)

    @classmethod
    def is_content_empty_failure(cls, reason: str) -> bool:
        return (reason or "").strip().lower() in cls._FAST_FAILURE_REASONS

    def _parse_json(self, text: str) -> dict:
        raw = (text or "").strip()
        if not raw:
            raise ValueError("empty verifier output")

        fenced = re.search(
            r"```(?:json)?\s*(\{[\s\S]*\})\s*```",
            raw,
            re.IGNORECASE,
        )
        if fenced:
            raw = fenced.group(1).strip()

        try:
            data = json.loads(raw)
        except Exception:
            start = raw.find("{")
            end = raw.rfind("}")
            if start < 0 or end <= start:
                raise
            data = json.loads(raw[start:end + 1])

        if "verdict" not in data:
            raise ValueError("missing verdict")

        data.setdefault("reason", "")
        data.setdefault("confidence", 0.0)
        return data
