"""
Conversation Resume Service - 对话中断恢复

当用户回到一个有未完成目标的对话时，自动检测中断状态
并生成恢复提示，让用户选择继续还是开始新话题。

使用方式::

    svc = get_conversation_resume_service()
    resume = svc.check_resume("conv-1", conv_state)
    if resume.should_prompt:
        # 注入恢复提示到 agent 回复
        prompt = resume.build_prompt()
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from runtime.agent_runtime.conversation_state import ConversationRuntimeState

logger = logging.getLogger(__name__)

# 对话空闲超过此秒数视为"中断"
_DEFAULT_IDLE_THRESHOLD_SECONDS = 300  # 5 分钟


@dataclass
class ResumeCheckResult:
    """中断恢复检测结果。"""
    conversation_id: str
    should_prompt: bool = False
    resume_type: str = ""  # "open_goals" | "pending_input" | "pending_actions" | ""
    last_user_goal: str = ""
    open_goals: List[str] = field(default_factory=list)
    pending_action_count: int = 0
    last_skill_name: Optional[str] = None
    turn_count: int = 0

    def build_prompt(self) -> str:
        """生成注入到 system prompt 的恢复上下文。"""
        if not self.should_prompt:
            return ""

        parts = ["[对话恢复上下文]"]

        if self.last_user_goal:
            parts.append(f"上次用户的问题是：{self.last_user_goal}")

        if self.open_goals:
            goals_text = "；".join(self.open_goals[:3])
            parts.append(f"尚未完成的目标：{goals_text}")

        if self.pending_action_count > 0:
            parts.append(f"有 {self.pending_action_count} 个待执行的步骤")

        if self.last_skill_name:
            parts.append(f"上次使用的技能：{self.last_skill_name}")

        parts.append("请询问用户是否要继续上次的话题，还是开始新的问题。")
        return "\n".join(parts)

    def build_user_hint(self) -> str:
        """生成面向用户的恢复提示文本。"""
        if not self.should_prompt:
            return ""

        if self.resume_type == "pending_input":
            return "上次对话中有一个等待您回复的问题，是否继续？"

        if self.open_goals:
            goal = self.open_goals[0]
            return f"上次我们聊到「{goal[:50]}」，要继续吗？还是有新的问题？"

        if self.last_user_goal:
            return f"上次您问的是「{self.last_user_goal[:50]}」，需要继续吗？"

        return "检测到上次对话未完成，是否继续？"

    def to_dict(self) -> Dict[str, Any]:
        return {
            "conversation_id": self.conversation_id,
            "should_prompt": self.should_prompt,
            "resume_type": self.resume_type,
            "last_user_goal": self.last_user_goal,
            "open_goals": self.open_goals,
            "pending_action_count": self.pending_action_count,
            "last_skill_name": self.last_skill_name,
            "turn_count": self.turn_count,
            "user_hint": self.build_user_hint(),
        }


class ConversationResumeService:
    """对话中断恢复服务。"""

    def __init__(
        self,
        idle_threshold_seconds: int = _DEFAULT_IDLE_THRESHOLD_SECONDS,
    ) -> None:
        self._idle_threshold = idle_threshold_seconds
        # 记录每个对话最后活跃时间
        self._last_active: Dict[str, float] = {}

    def record_activity(self, conversation_id: str) -> None:
        """记录对话活跃（每次收到消息时调用）。"""
        self._last_active[conversation_id] = time.time()

    def get_idle_seconds(self, conversation_id: str) -> float:
        """获取对话空闲时间（秒）。"""
        last = self._last_active.get(conversation_id)
        if last is None:
            return float("inf")
        return time.time() - last

    def check_resume(
        self,
        conversation_id: str,
        conv_state: Optional[ConversationRuntimeState],
        *,
        is_first_message_in_session: bool = True,
    ) -> ResumeCheckResult:
        """检测是否需要恢复中断的对话。

        判断条件（需全部满足）：
        1. 对话有历史（turn_count > 0）
        2. 有未完成的内容（open_goals / pending_actions / pending_input）
        3. 当前是会话内的第一条消息（避免每轮都提示）

        Args:
            conversation_id:            对话 ID
            conv_state:                 持久化的对话运行时状态
            is_first_message_in_session: 是否为本次连接的第一条消息

        Returns:
            ResumeCheckResult
        """
        result = ResumeCheckResult(conversation_id=conversation_id)

        if conv_state is None or conv_state.turn_count == 0:
            return result

        if not is_first_message_in_session:
            return result

        result.turn_count = conv_state.turn_count
        result.last_user_goal = conv_state.last_user_goal
        result.last_skill_name = conv_state.last_active_skill_name
        result.open_goals = list(conv_state.open_goals or [])
        result.pending_action_count = len(conv_state.current_pending_actions())

        # 优先级：pending_user_input > open_goals > pending_actions
        if conv_state.pending_user_input:
            result.should_prompt = True
            result.resume_type = "pending_input"
            logger.info(
                "[Resume] conv=%s: pending user input detected",
                conversation_id,
            )
        elif conv_state.open_goals:
            result.should_prompt = True
            result.resume_type = "open_goals"
            logger.info(
                "[Resume] conv=%s: %d open goals",
                conversation_id, len(conv_state.open_goals),
            )
        elif conv_state.current_pending_actions():
            result.should_prompt = True
            result.resume_type = "pending_actions"
            logger.info(
                "[Resume] conv=%s: %d pending actions",
                conversation_id, result.pending_action_count,
            )

        return result

    def dismiss_resume(self, conversation_id: str) -> None:
        """用户选择不恢复，标记本轮已处理。"""
        self.record_activity(conversation_id)


_resume_service: Optional[ConversationResumeService] = None


def get_conversation_resume_service() -> ConversationResumeService:
    global _resume_service
    if _resume_service is None:
        _resume_service = ConversationResumeService()
    return _resume_service
