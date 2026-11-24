import asyncio
from datetime import datetime, timedelta

import pytest
from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule

from runtime.agent_runtime.user_input import (
    _pending_user_inputs,
    cancel_pending_input,
    cleanup_expired_inputs,
    cleanup_pending_input,
    create_user_input_request,
    get_pending_input,
    get_user_input_tool_definition,
    submit_user_input,
    wait_for_user_input,
)


class UserInputStateMachine(RuleBasedStateMachine):
    stateful_step_count = 20

    def __init__(self):
        super().__init__()
        self.conversation_id = "conv-state-machine"
        self.current_user_id = "user-1"
        self.current_input_id = None
        self.expected_pending = False
        self.is_expired = False
        cleanup_pending_input(self.conversation_id)

    def teardown(self):
        cleanup_pending_input(self.conversation_id)

    @rule(
        user_id=st.text(min_size=1, max_size=12),
        prompt=st.text(min_size=1, max_size=40),
        input_type=st.sampled_from(["text", "confirm", "choice"]),
        timeout=st.integers(min_value=1, max_value=30),
    )
    def create(self, user_id, prompt, input_type, timeout):
        pending = create_user_input_request(
            conversation_id=self.conversation_id,
            user_id=user_id,
            prompt=prompt,
            input_type=input_type,
            options=["A", "B"] if input_type == "choice" else None,
            timeout=timeout,
            skill="test-skill",
            step_id="step-1",
        )
        self.current_user_id = user_id
        self.current_input_id = pending.input_id
        self.expected_pending = True
        self.is_expired = False

    @rule()
    @precondition(lambda self: self.expected_pending)
    def expire(self):
        pending = get_pending_input(self.conversation_id)
        if pending is not None:
            pending.created_at = datetime.now() - timedelta(seconds=pending.timeout + 1)
            self.is_expired = True

    @rule(value=st.one_of(st.text(max_size=20), st.integers(), st.booleans()))
    @precondition(lambda self: self.expected_pending and self.current_input_id is not None)
    def submit_valid(self, value):
        result = submit_user_input(
            conversation_id=self.conversation_id,
            user_id=self.current_user_id,
            input_id=self.current_input_id,
            value=value,
        )
        if self.is_expired:
            assert result["success"] is False
        else:
            assert result["success"] is True
            assert result["submitted_value"] == value
        self.expected_pending = False
        self.current_input_id = None
        self.is_expired = False

    @rule(value=st.one_of(st.text(max_size=20), st.integers(), st.booleans()))
    @precondition(lambda self: self.expected_pending and self.current_input_id is not None)
    def submit_wrong_user(self, value):
        wrong_user = self.current_user_id + "_x"
        result = submit_user_input(
            conversation_id=self.conversation_id,
            user_id=wrong_user,
            input_id=self.current_input_id,
            value=value,
        )
        assert result["success"] is False
        assert get_pending_input(self.conversation_id) is not None

    @rule(value=st.one_of(st.text(max_size=20), st.integers(), st.booleans()))
    @precondition(lambda self: self.expected_pending and self.current_input_id is not None)
    def submit_wrong_id(self, value):
        result = submit_user_input(
            conversation_id=self.conversation_id,
            user_id=self.current_user_id,
            input_id="ui_wrong_id",
            value=value,
        )
        assert result["success"] is False
        assert get_pending_input(self.conversation_id) is not None

    @rule()
    @precondition(lambda self: self.expected_pending)
    def cancel(self):
        cancel_pending_input(self.conversation_id, reason="state-machine-cancel")
        self.expected_pending = False
        self.current_input_id = None
        self.is_expired = False

    @rule()
    def cleanup(self):
        cleanup_pending_input(self.conversation_id)
        self.expected_pending = False
        self.current_input_id = None
        self.is_expired = False

    @invariant()
    def pending_registry_matches_model(self):
        pending = get_pending_input(self.conversation_id)
        assert (pending is not None) == self.expected_pending
        if pending is not None:
            assert _pending_user_inputs[self.conversation_id] is pending
            assert pending.conversation_id == self.conversation_id
            assert pending.input_id == self.current_input_id


TestUserInputStateMachine = UserInputStateMachine.TestCase


def test_create_user_input_request_supersedes_existing_waiter():
    conversation_id = "conv-supersede"
    cleanup_pending_input(conversation_id)

    async def _run():
        first_wait = asyncio.create_task(
            wait_for_user_input(
                conversation_id=conversation_id,
                user_id="user-1",
                prompt="first",
                input_type="text",
                timeout=2,
            )
        )
        await asyncio.sleep(0)

        replacement = create_user_input_request(
            conversation_id=conversation_id,
            user_id="user-1",
            prompt="second",
            input_type="choice",
            options=["A", "B"],
            timeout=30,
        )

        first_result = await asyncio.wait_for(first_wait, timeout=1)
        return first_result, replacement

    first_result, replacement = asyncio.run(_run())

    assert first_result == {"value": None, "success": False, "error": "superseded"}
    assert get_pending_input(conversation_id) is replacement
    cleanup_pending_input(conversation_id)


def test_create_user_input_request_copies_options_and_memory_writeback():
    conversation_id = "conv-copy-inputs"
    cleanup_pending_input(conversation_id)
    options = ["A", "B"]
    memory_writeback = {"scope": "session"}

    pending = create_user_input_request(
        conversation_id=conversation_id,
        user_id="user-1",
        prompt="choose",
        input_type="choice",
        options=options,
        memory_writeback=memory_writeback,
    )

    options.append("C")
    memory_writeback["scope"] = "durable"
    sse_payload = pending.to_sse_data()
    sse_payload["memory_writeback"]["scope"] = "use_once"

    assert pending.options == ["A", "B"]
    assert pending.memory_writeback == {"scope": "session"}
    cleanup_pending_input(conversation_id)


def test_submit_user_input_without_pending_request_fails():
    cleanup_pending_input("conv-missing")

    result = submit_user_input(
        conversation_id="conv-missing",
        user_id="user-1",
        input_id="ui-missing",
        value="ignored",
    )

    assert result == {"success": False, "error": "没有待处理的输入请求"}


def test_wait_for_user_input_returns_submitted_value():
    conversation_id = "conv-success"
    cleanup_pending_input(conversation_id)

    async def _run():
        waiter = asyncio.create_task(
            wait_for_user_input(
                conversation_id=conversation_id,
                user_id="user-1",
                prompt="answer me",
                input_type="text",
                timeout=5,
            )
        )
        await asyncio.sleep(0)
        pending = get_pending_input(conversation_id)
        assert pending is not None
        submit_user_input(
            conversation_id=conversation_id,
            user_id="user-1",
            input_id=pending.input_id,
            value="approved",
        )
        return await waiter

    result = asyncio.run(_run())

    assert result == {"value": "approved", "success": True}


def test_wait_for_user_input_times_out_and_cleans_up(monkeypatch):
    conversation_id = "conv-timeout"
    cleanup_pending_input(conversation_id)

    async def fake_wait_for(awaitable, timeout):
        awaitable.close()
        del timeout
        raise asyncio.TimeoutError()

    monkeypatch.setattr("runtime.agent_runtime.user_input.asyncio.wait_for", fake_wait_for)

    result = asyncio.run(
        wait_for_user_input(
            conversation_id=conversation_id,
            user_id="user-1",
            prompt="timeout",
            input_type="text",
            timeout=1,
        )
    )

    assert result == {"value": None, "success": False, "error": "等待用户输入超时"}
    assert get_pending_input(conversation_id) is None


def test_wait_for_user_input_returns_unknown_error_when_event_has_no_payload(monkeypatch):
    event = asyncio.Event()
    event.set()

    fake_pending = type(
        "FakePending",
        (),
        {"event": event, "error": None, "result": None},
    )()

    monkeypatch.setattr("runtime.agent_runtime.user_input.create_user_input_request", lambda **kwargs: fake_pending)

    result = asyncio.run(
        wait_for_user_input(
            conversation_id="conv-unknown",
            user_id="user-1",
            prompt="unknown",
            input_type="text",
            timeout=1,
        )
    )

    assert result == {"value": None, "success": False, "error": "Unknown error"}


def test_wait_for_user_input_returns_exception_message(monkeypatch):
    conversation_id = "conv-exception"
    cleanup_pending_input(conversation_id)

    async def fake_wait_for(awaitable, timeout):
        awaitable.close()
        del timeout
        raise RuntimeError("event-loop-broken")

    monkeypatch.setattr("runtime.agent_runtime.user_input.asyncio.wait_for", fake_wait_for)

    result = asyncio.run(
        wait_for_user_input(
            conversation_id=conversation_id,
            user_id="user-1",
            prompt="exception",
            input_type="text",
            timeout=1,
        )
    )

    assert result == {"value": None, "success": False, "error": "event-loop-broken"}
    assert get_pending_input(conversation_id) is None


def test_get_user_input_tool_definition_exposes_memory_writeback_schema():
    tool_def = get_user_input_tool_definition()

    assert tool_def["type"] == "function"
    assert tool_def["function"]["name"] == "request_user_input"
    assert tool_def["function"]["parameters"]["required"] == ["prompt", "input_type"]
    assert "memory_writeback" in tool_def["function"]["parameters"]["properties"]


def test_cleanup_expired_inputs_marks_requests_and_removes_them(monkeypatch):
    conversation_id = "conv-expired-cleanup"
    pending = create_user_input_request(
        conversation_id=conversation_id,
        user_id="user-1",
        prompt="expire me",
        input_type="text",
        timeout=1,
    )
    pending.created_at = datetime.now() - timedelta(seconds=10)

    sleep_calls = {"count": 0}

    async def fake_sleep(seconds):
        assert seconds == 60
        sleep_calls["count"] += 1
        if sleep_calls["count"] > 1:
            raise asyncio.CancelledError()

    monkeypatch.setattr("runtime.agent_runtime.user_input.asyncio.sleep", fake_sleep)

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(cleanup_expired_inputs())

    assert pending.error == "timeout"
    assert pending.event.is_set() is True
    assert get_pending_input(conversation_id) is None
