import asyncio

from runtime.agent_runtime.planning_policy import RuntimePlanningPolicy


class _StubAI:
    def __init__(self, reply: str = "否"):
        self.reply = reply
        self.calls = 0
        self.last_messages = None

    async def chat(self, messages):  # noqa: ARG002
        self.calls += 1
        self.last_messages = messages
        return {"content": self.reply}


def test_should_use_fast_path_llm_skips_explicit_remember_without_calling_llm():
    ai = _StubAI(reply="否")

    result = asyncio.run(
        RuntimePlanningPolicy.should_use_fast_path_llm(
            message="记住，我喜欢橙子。",
            ai_service=ai,
            active_skill_name=None,
            conversation_state=None,
        )
    )

    assert result is False
    assert ai.calls == 0


def test_should_use_fast_path_llm_skips_memory_query_without_calling_llm():
    ai = _StubAI(reply="否")

    result = asyncio.run(
        RuntimePlanningPolicy.should_use_fast_path_llm(
            message="我喜欢什么水果？",
            ai_service=ai,
            active_skill_name=None,
            conversation_state=None,
        )
    )

    assert result is False
    assert ai.calls == 0


def test_should_use_fast_path_llm_still_allows_simple_greeting_to_reach_llm():
    ai = _StubAI(reply="否")

    result = asyncio.run(
        RuntimePlanningPolicy.should_use_fast_path_llm(
            message="你好",
            ai_service=ai,
            active_skill_name=None,
            conversation_state=None,
        )
    )

    assert result is True
    assert ai.calls == 1


def test_should_use_fast_path_llm_skips_image_generation_request_without_calling_llm():
    ai = _StubAI(reply="否")

    result = asyncio.run(
        RuntimePlanningPolicy.should_use_fast_path_llm(
            message="生成一张小猫图像",
            ai_service=ai,
            active_skill_name=None,
            conversation_state=None,
        )
    )

    assert result is False
    assert ai.calls == 0


def test_should_use_fast_path_llm_skips_follow_up_image_edit_request_without_calling_llm():
    ai = _StubAI(reply="否")

    result = asyncio.run(
        RuntimePlanningPolicy.should_use_fast_path_llm(
            message="让这只小猫躺下",
            ai_service=ai,
            active_skill_name=None,
            conversation_state=None,
        )
    )

    assert result is False
    assert ai.calls == 0
