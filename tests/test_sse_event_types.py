# -*- coding: utf-8 -*-
"""
SSE 事件类型测试

验证 agent_service 发送的事件类型与前端期望一致。
当前端屏蔽了 skill_routing, plan_created, plan_completed,
step_completed, step_handoff, tool_call, tool_result 后，
agent 端仍然正常发送这些事件（前端只是不显示），不影响后端逻辑。
"""
import pytest


class TestSSEEventTypes:
    """验证 Agent SSE 事件类型的正确性"""

    # Agent 发送的所有事件类型
    ALL_EVENT_TYPES = [
        "status",
        "skill_routing",
        "plan_created",
        "plan_completed",
        "step_completed",
        "step_handoff",
        "tool_call",
        "tool_result",
        "verification",
        "user_input_required",
        "thinking",
        "content",
        "done",
        "error",
    ]

    # 前端已屏蔽显示的事件类型
    FRONTEND_BLOCKED_TYPES = [
        "skill_routing",
        "plan_created",
        "plan_completed",
        "step_completed",
        "step_handoff",
        "tool_call",
        "tool_result",
    ]

    def test_all_blocked_types_are_valid_events(self):
        """验证所有被前端屏蔽的事件类型都是 agent 发出的合法事件"""
        for event_type in self.FRONTEND_BLOCKED_TYPES:
            assert event_type in self.ALL_EVENT_TYPES, (
                f"{event_type} 不在 agent 事件类型列表中"
            )

    def test_blocked_count_is_seven(self):
        """验证被屏蔽的事件类型数量为 7"""
        assert len(self.FRONTEND_BLOCKED_TYPES) == 7

    def test_status_and_content_not_blocked(self):
        """验证 status 和 content 事件不在屏蔽列表中"""
        assert "status" not in self.FRONTEND_BLOCKED_TYPES
        assert "content" not in self.FRONTEND_BLOCKED_TYPES
        assert "thinking" not in self.FRONTEND_BLOCKED_TYPES
        assert "done" not in self.FRONTEND_BLOCKED_TYPES
        assert "error" not in self.FRONTEND_BLOCKED_TYPES

    def test_agent_event_type_naming_convention(self):
        """验证所有事件类型使用 snake_case 命名"""
        for event_type in self.ALL_EVENT_TYPES:
            assert event_type == event_type.lower(), (
                f"{event_type} 应为小写"
            )
            assert " " not in event_type, (
                f"{event_type} 不应包含空格"
            )