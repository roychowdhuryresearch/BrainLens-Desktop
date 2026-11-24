import asyncio
import json

from runtime.agent_runtime.verifier import VerificationService
from runtime.models.schemas import VerificationConfig


class StubVerifierAIService:
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    async def chat(self, messages):
        self.calls += 1
        return {"content": json.dumps(self.payload, ensure_ascii=False)}


def test_fast_check_allows_short_substantive_answer():
    service = VerificationService(
        ai_service=StubVerifierAIService(
            {"verdict": "success", "reason": "", "confidence": 0.9}
        ),
        config=VerificationConfig(min_answer_length=10),
    )

    result = service._fast_check_failure("1+1 等于 2。")

    assert result is None


def test_fast_check_rejects_non_substantive_short_answer():
    service = VerificationService(
        ai_service=StubVerifierAIService(
            {"verdict": "success", "reason": "", "confidence": 0.9}
        ),
        config=VerificationConfig(min_answer_length=10),
    )

    result = service._fast_check_failure("...")

    assert result is not None
    assert result.verdict == "failure"
    assert result.reason == "too_short"


def test_verify_short_substantive_answer_uses_llm_path():
    ai_service = StubVerifierAIService(
        {"verdict": "success", "reason": "", "confidence": 0.93}
    )
    service = VerificationService(
        ai_service=ai_service,
        config=VerificationConfig(min_answer_length=10),
    )

    result = asyncio.run(
        service.verify(
            user_question="1+1等于几？",
            final_answer="1+1 等于 2。",
        )
    )

    assert result.verdict == "success"
    assert ai_service.calls == 1
    assert service.last_debug["mode"] == "llm"


def test_verify_direct_short_answer_skips_llm_verifier():
    ai_service = StubVerifierAIService(
        {"verdict": "failure", "reason": "should_not_run", "confidence": 0.0}
    )
    service = VerificationService(
        ai_service=ai_service,
        config=VerificationConfig(min_answer_length=10),
    )

    result = asyncio.run(
        service.verify(
            user_question="请直接回答：1+1等于几？只回复最终答案，不要解释。",
            final_answer="2",
        )
    )

    assert result.verdict == "success"
    assert result.reason == "direct_short_answer"
    assert ai_service.calls == 0
    assert service.last_debug["mode"] == "fast_success"
