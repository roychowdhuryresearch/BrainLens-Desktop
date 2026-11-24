import asyncio
from dataclasses import asdict
from pathlib import Path
from types import SimpleNamespace

from runtime.agent_runtime.orchestrator import AgentTurnRequest
from runtime.models.memory import DurableMemoryPromptContext, DurableMemoryPromptItem
from runtime.services import agent_service as agent_service_module
from runtime.services.agent_service import AgentService
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, StepResult


class FakeAIService:
    def __init__(self, content: str):
        self.content = content
        self.calls = []

    async def chat(self, messages, tools=None, max_retries=None):
        self.calls.append({"messages": messages, "tools": tools, "max_retries": max_retries})
        return {
            "content": self.content,
            "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
            "model_used": "fake-memory-model",
        }


def _make_service(ai_service):
    return AgentService(ai_service=ai_service, mcp_manager=None, router_model_config=None, ai_models=[])


def _make_state(*, user_id="u1", output=None, tool_calls_count=0):
    step = ExecutionStep(
        step_id="s1",
        skill_name="general_assistant",
        goal="handle request",
        instructions="finish request",
        step_type="general",
        is_final_step=True,
    )
    state = ExecutionState(
        conversation_id="conv-1",
        current_turn_id="turn-1",
        user_id=user_id,
        plan=ExecutionPlan(
            user_goal="goal",
            routing_reason="test",
            routing_method="test",
            steps=[step],
            multi_skill_mode=False,
        ),
    )
    state.step_results["s1"] = StepResult(
        step_id="s1",
        skill_name="general_assistant",
        success=True,
        summary="done",
        output=output or {},
        raw_text="done",
        sources=[],
        tool_calls_count=tool_calls_count,
    )
    return state


def test_auto_memory_write_skips_plain_greeting(monkeypatch):
    ai_service = FakeAIService(
        '{"should_write": true, "reason": "should not run", "records": []}'
    )
    service = _make_service(ai_service)
    state = _make_state()

    request = AgentTurnRequest(
        message="你好",
        conversation_id="conv-1",
        user_id="u1",
    )


    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="你好，有什么可以帮你？",
            sources=[],
        )
    )

    assert persisted == []
    assert ai_service.calls == []


def test_auto_memory_write_persists_confirmed_preference(monkeypatch):
    ai_service = FakeAIService(
        """
        {
          "should_write": true,
          "reason": "user explicitly confirmed a lasting preference",
          "records": [
            {
              "memory_kind": "preference",
              "scope_level": "user",
              "namespace": "assistant_style",
              "key": "reply_style_default",
              "title": "回答风格",
              "summary": "用户确认偏好，默认用中文并保持简短。",
              "value": {"language": "zh", "style": "concise"},
              "source": "user_confirmed",
              "retrieval_targets": ["bootstrap", "controller", "prompt"],
              "priority": 70,
              "confidence": 95
            }
          ]
        }
        """
    )
    service = _make_service(ai_service)
    state = _make_state()
    request = AgentTurnRequest(
        message="记住，以后默认用中文并且回答简短一点。",
        conversation_id="conv-1",
        user_id="u1",
    )

    saved = []

    def fake_upsert(cls, *, access_context, data):
        saved.append({"access_context": access_context, "data": data})
        payload = {
            "id": 1,
            "scope_level": "user",
            "scope_id": access_context.user_id,
            "tenant_id": None,
            "team_id": None,
            "owner_user_id": access_context.user_id,
            "memory_kind": data.memory_kind,
            "memory_type": data.memory_kind,
            "namespace": data.namespace,
            "key": data.key,
            "title": data.title,
            "description": data.description,
            "value": data.value,
            "source": data.source,
            "write_policy": data.write_policy,
            "tags": data.tags,
            "retrieval_targets": data.retrieval_targets or [],
            "priority": data.priority,
            "confidence": data.confidence,
            "confirmed": data.source == "user_confirmed",
            "status": data.status,
            "access_count": 0,
            "created_at": None,
            "updated_at": None,
            "last_accessed_at": None,
        }
        return SimpleNamespace(model_dump=lambda: payload)

    monkeypatch.setattr(agent_service_module.MemoryService, "upsert_memory_record", classmethod(fake_upsert))

    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="好的，之后我会默认用中文并保持简短。",
            sources=[],
        )
    )

    assert len(ai_service.calls) == 1
    assert len(saved) == 1
    assert persisted[0]["memory_kind"] == "preference"
    assert saved[0]["data"].source == "user_confirmed"
    assert saved[0]["data"].namespace == "assistant_style"
    assert saved[0]["data"].key == "reply_style_default"


def test_auto_memory_write_filters_invalid_kinds_and_persists_project_context(monkeypatch):
    ai_service = FakeAIService(
        """
        {
          "should_write": true,
          "reason": "contains one reusable project context",
          "records": [
            {
              "memory_kind": "fact",
              "scope_level": "user",
              "namespace": "news",
              "key": "latest_status",
              "title": "最新状态",
              "summary": "今天的临时状态",
              "value": {"status": "temporary"},
              "source": "agent_completed"
            },
            {
              "memory_kind": "project_context",
              "scope_level": "user",
              "namespace": "project_context",
              "key": "legacy_profile_note",
              "title": "当前项目背景",
              "summary": "用户当前重点是先完成 agent 的并发评测与鲁棒性修复。",
              "value": "当前重点是先完成 agent 的并发评测与鲁棒性修复。",
              "source": "agent_completed",
              "retrieval_targets": ["bootstrap", "prompt"],
              "priority": 60,
              "confidence": 88
            }
          ]
        }
        """
    )
    service = _make_service(ai_service)
    state = _make_state(
        output={"priority": "robustness", "track": "concurrency_eval"},
        tool_calls_count=2,
    )
    request = AgentTurnRequest(
        message="记住我当前的长期重点是先完成并发评测和鲁棒性修复。",
        conversation_id="conv-1",
        user_id="u1",
    )

    saved = []

    def fake_upsert(cls, *, access_context, data):
        saved.append(data)
        payload = {
            "id": len(saved),
            "scope_level": "user",
            "scope_id": access_context.user_id,
            "tenant_id": None,
            "team_id": None,
            "owner_user_id": access_context.user_id,
            "memory_kind": data.memory_kind,
            "memory_type": data.memory_kind,
            "namespace": data.namespace,
            "key": data.key,
            "title": data.title,
            "description": data.description,
            "value": data.value,
            "source": data.source,
            "write_policy": data.write_policy,
            "tags": data.tags,
            "retrieval_targets": data.retrieval_targets or [],
            "priority": data.priority,
            "confidence": data.confidence,
            "confirmed": data.source == "user_confirmed",
            "status": data.status,
            "access_count": 0,
            "created_at": None,
            "updated_at": None,
            "last_accessed_at": None,
        }
        return SimpleNamespace(model_dump=lambda: payload)

    monkeypatch.setattr(agent_service_module.MemoryService, "upsert_memory_record", classmethod(fake_upsert))

    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="好的，我记住你当前的长期重点是先完成并发评测和鲁棒性修复。",
            sources=[{"title": "evaluation note", "url": "https://example.com/eval"}],
        )
    )

    assert len(ai_service.calls) == 1
    assert len(saved) == 1
    assert saved[0].memory_kind == "project_context"
    assert persisted[0]["key"] == "legacy_profile_note"
    assert persisted[0]["source"] == "agent_completed"


def test_auto_memory_write_skips_duplicate_existing_memory(monkeypatch):
    ai_service = FakeAIService(
        """
        {
          "should_write": true,
          "reason": "duplicate preference",
          "records": [
            {
              "memory_kind": "preference",
              "scope_level": "user",
              "namespace": "assistant_style",
              "key": "reply_style_default",
              "title": "回答风格",
              "summary": "用户确认偏好，默认用中文并保持简短。",
              "value": {"language": "zh", "style": "concise"},
              "source": "user_confirmed"
            }
          ]
        }
        """
    )
    service = _make_service(ai_service)
    state = _make_state()
    state.durable_memory_context = DurableMemoryPromptContext(
        user_preferences=[
            DurableMemoryPromptItem(
                id=1,
                scope_level="user",
                memory_kind="preference",
                namespace="assistant_style",
                key="reply_style_default",
                title="回答风格",
                summary="用户确认偏好，默认用中文并保持简短。",
                value={"language": "zh", "style": "concise"},
            )
        ]
    )
    request = AgentTurnRequest(
        message="记住，以后默认用中文并且回答简短一点。",
        conversation_id="conv-1",
        user_id="u1",
    )

    monkeypatch.setattr(
        agent_service_module.MemoryService,
        "upsert_memory_record",
        classmethod(lambda cls, *, access_context, data: (_ for _ in ()).throw(AssertionError("should not persist"))),
    )

    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="好的，之后我会默认用中文并保持简短。",
            sources=[],
        )
    )

    assert len(ai_service.calls) == 1
    assert persisted == []


def test_auto_memory_write_persists_confirmed_working_style(monkeypatch):
    ai_service = FakeAIService(
        """
        {
          "should_write": true,
          "reason": "user confirmed a durable working style",
          "records": [
            {
              "memory_kind": "working_style",
              "scope_level": "user",
              "namespace": "working_style",
              "key": "step_by_step",
              "title": "工作方式",
              "summary": "用户希望助手一步一步推进，不要一次给太多信息。",
              "value": {"instruction": "step_by_step", "avoid": "too_much_once"},
              "source": "user_confirmed",
              "retrieval_targets": ["bootstrap", "controller"],
              "priority": 75,
              "confidence": 96
            }
          ]
        }
        """
    )
    service = _make_service(ai_service)
    state = _make_state()
    request = AgentTurnRequest(
        message="记住，我更喜欢你一步一步来，别一次性给我太多内容。",
        conversation_id="conv-1",
        user_id="u1",
    )

    saved = []

    def fake_upsert(cls, *, access_context, data):
        saved.append(data)
        payload = {
            "id": len(saved),
            "scope_level": "user",
            "scope_id": access_context.user_id,
            "tenant_id": None,
            "team_id": None,
            "owner_user_id": access_context.user_id,
            "memory_kind": data.memory_kind,
            "memory_type": "entity",
            "namespace": data.namespace,
            "key": data.key,
            "title": data.title,
            "description": data.description,
            "value": data.value,
            "source": data.source,
            "write_policy": data.write_policy,
            "tags": data.tags,
            "retrieval_targets": data.retrieval_targets or [],
            "priority": data.priority,
            "confidence": data.confidence,
            "confirmed": data.source == "user_confirmed",
            "status": data.status,
            "access_count": 0,
            "created_at": None,
            "updated_at": None,
            "last_accessed_at": None,
        }
        return SimpleNamespace(model_dump=lambda: payload)

    monkeypatch.setattr(agent_service_module.MemoryService, "upsert_memory_record", classmethod(fake_upsert))

    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="好的，我会按步骤推进，避免一次性给你太多信息。",
            sources=[],
        )
    )

    assert len(ai_service.calls) == 1
    assert len(saved) == 1
    assert saved[0].memory_kind == "working_style"
    assert saved[0].namespace == "working_style"
    assert persisted[0]["memory_kind"] == "working_style"


def test_auto_memory_write_falls_back_to_rule_based_explicit_remember(monkeypatch):
    ai_service = FakeAIService(
        """
        {
          "should_write": false,
          "reason": "llm missed the explicit remember instruction",
          "records": []
        }
        """
    )
    service = _make_service(ai_service)
    state = _make_state()
    request = AgentTurnRequest(
        message="记住，我以后更喜欢你用中文回答，而且简短一点。",
        conversation_id="conv-1",
        user_id="u1",
    )

    saved = []

    def fake_upsert(cls, *, access_context, data):
        saved.append({"access_context": access_context, "data": data})
        payload = {
            "id": len(saved),
            "scope_level": "user",
            "scope_id": access_context.user_id,
            "tenant_id": None,
            "team_id": None,
            "owner_user_id": access_context.user_id,
            "memory_kind": data.memory_kind,
            "memory_type": "preference",
            "namespace": data.namespace,
            "key": data.key,
            "title": data.title,
            "description": data.description,
            "value": data.value,
            "source": data.source,
            "write_policy": data.write_policy,
            "tags": data.tags,
            "retrieval_targets": data.retrieval_targets or [],
            "priority": data.priority,
            "confidence": data.confidence,
            "confirmed": data.source == "user_confirmed",
            "status": data.status,
            "access_count": 0,
            "created_at": None,
            "updated_at": None,
            "last_accessed_at": None,
        }
        return SimpleNamespace(model_dump=lambda: payload)

    monkeypatch.setattr(agent_service_module.MemoryService, "upsert_memory_record", classmethod(fake_upsert))

    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="好的，我记住了。之后默认用中文，回答也会更简短。",
            sources=[],
        )
    )

    assert len(ai_service.calls) == 1
    assert len(saved) == 1
    assert saved[0]["data"].memory_kind == "preference"
    assert saved[0]["data"].source == "user_confirmed"
    assert saved[0]["data"].namespace == "user_preferences"
    assert "中文回答" in saved[0]["data"].description
    assert persisted[0]["memory_kind"] == "preference"


def test_auto_memory_write_falls_back_to_project_fact_for_explicit_personal_fact(monkeypatch):
    ai_service = FakeAIService(
        """
        {
          "should_write": false,
          "reason": "llm missed the explicit favorite-fruit memory",
          "records": []
        }
        """
    )
    service = _make_service(ai_service)
    state = _make_state()
    request = AgentTurnRequest(
        message="记住，我喜欢橙子。",
        conversation_id="conv-1",
        user_id="u1",
    )

    saved = []

    def fake_upsert(cls, *, access_context, data):
        saved.append({"access_context": access_context, "data": data})
        payload = {
            "id": len(saved),
            "scope_level": "user",
            "scope_id": access_context.user_id,
            "tenant_id": None,
            "team_id": None,
            "owner_user_id": access_context.user_id,
            "memory_kind": data.memory_kind,
            "memory_type": "entity",
            "namespace": data.namespace,
            "key": data.key,
            "title": data.title,
            "description": data.description,
            "value": data.value,
            "source": data.source,
            "write_policy": data.write_policy,
            "tags": data.tags,
            "retrieval_targets": data.retrieval_targets or [],
            "priority": data.priority,
            "confidence": data.confidence,
            "confirmed": data.source == "user_confirmed",
            "status": data.status,
            "access_count": 0,
            "created_at": None,
            "updated_at": None,
            "last_accessed_at": None,
        }
        return SimpleNamespace(model_dump=lambda: payload)

    monkeypatch.setattr(agent_service_module.MemoryService, "upsert_memory_record", classmethod(fake_upsert))

    persisted = asyncio.run(
        service.maybe_persist_durable_memory(
            request=request,
            state=state,
            final_content="好的，我记住了，你喜欢橙子。",
            sources=[],
        )
    )

    assert len(ai_service.calls) == 1
    assert len(saved) == 1
    assert saved[0]["data"].memory_kind == "project_fact"
    assert saved[0]["data"].namespace == "user_facts"
    assert saved[0]["data"].title == "长期事实"
    assert saved[0]["data"].description == "我喜欢橙子"
    assert persisted[0]["memory_kind"] == "project_fact"
