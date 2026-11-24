"""
User Profiling Service - 用户画像自适应

根据用户交互历史（提问复杂度、术语使用、是否跳过基础步骤）
自动调整回答详细度：新手 → 详细教程，老手 → 直接给值。

使用方式::

    svc = get_user_profiling_service()
    svc.record_interaction("u-1", message="API 网关的 timeout 和 retry policy 怎么改")
    profile = svc.get_profile("u-1")
    # profile.expertise_level = "expert"
    # profile.preferred_detail_level = "concise"
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# 专业术语列表（出现越多说明用户越专业）
_EXPERT_TERMS = {
    "API", "SDK", "CLI", "HTTP", "JSON", "schema", "token",
    "timeout", "retry", "rate limit", "namespace", "slug",
    "SQL", "PostgreSQL", "Redis", "queue", "cache", "index",
    "Kubernetes", "Docker", "CI", "CD", "SSE", "WebSocket",
    "算法", "参数", "配置", "模型", "嵌入式", "寄存器", "固件",
}

# 基础/入门级表达
_BEGINNER_PHRASES = [
    "怎么用", "什么意思", "是什么", "教我", "不太懂",
    "不会", "第一次", "入门", "基础", "简单介绍",
]


@dataclass
class UserProfile:
    """用户画像。"""
    user_id: str
    interaction_count: int = 0
    expert_term_count: int = 0
    beginner_phrase_count: int = 0
    avg_message_length: float = 0.0
    expertise_level: str = "unknown"  # beginner | intermediate | expert | unknown
    preferred_detail_level: str = "standard"  # detailed | standard | concise

    def to_dict(self) -> Dict[str, Any]:
        return {
            "user_id": self.user_id,
            "interaction_count": self.interaction_count,
            "expert_term_count": self.expert_term_count,
            "beginner_phrase_count": self.beginner_phrase_count,
            "avg_message_length": round(self.avg_message_length, 1),
            "expertise_level": self.expertise_level,
            "preferred_detail_level": self.preferred_detail_level,
        }

    def get_prompt_hint(self) -> str:
        """生成注入 system prompt 的详细度提示。"""
        if self.expertise_level == "expert":
            return "[用户画像：专业用户，回答请简洁直接，直接给参数值和步骤，不需要解释基础概念]"
        elif self.expertise_level == "beginner":
            return "[用户画像：新手用户，回答请详细，解释每个步骤，使用通俗语言，避免未解释的专业术语]"
        return ""


class UserProfilingService:
    """用户画像服务。"""

    def __init__(self) -> None:
        self._profiles: Dict[str, UserProfile] = {}
        self._message_lengths: Dict[str, List[int]] = {}

    def record_interaction(self, user_id: str, message: str) -> None:
        """记录一次用户交互，更新画像。"""
        if not user_id or not message:
            return

        profile = self._profiles.setdefault(user_id, UserProfile(user_id=user_id))
        profile.interaction_count += 1

        # 统计专业术语
        for term in _EXPERT_TERMS:
            if term.lower() in message.lower() or term in message:
                profile.expert_term_count += 1

        # 统计入门表达
        for phrase in _BEGINNER_PHRASES:
            if phrase in message:
                profile.beginner_phrase_count += 1

        # 平均消息长度
        lengths = self._message_lengths.setdefault(user_id, [])
        lengths.append(len(message))
        if len(lengths) > 50:
            lengths.pop(0)
        profile.avg_message_length = sum(lengths) / len(lengths)

        # 更新专业度判断
        self._update_expertise(profile)

    def _update_expertise(self, profile: UserProfile) -> None:
        """根据累计数据更新专业度。"""
        if profile.interaction_count < 3:
            profile.expertise_level = "unknown"
            profile.preferred_detail_level = "standard"
            return

        ratio = profile.expert_term_count / max(profile.interaction_count, 1)
        beginner_ratio = profile.beginner_phrase_count / max(profile.interaction_count, 1)

        if ratio >= 1.5 and beginner_ratio < 0.2:
            profile.expertise_level = "expert"
            profile.preferred_detail_level = "concise"
        elif beginner_ratio >= 0.5 or (ratio < 0.3 and profile.avg_message_length < 20):
            profile.expertise_level = "beginner"
            profile.preferred_detail_level = "detailed"
        else:
            profile.expertise_level = "intermediate"
            profile.preferred_detail_level = "standard"

    def get_profile(self, user_id: str) -> UserProfile:
        """获取用户画像。"""
        return self._profiles.get(user_id, UserProfile(user_id=user_id))

    def get_prompt_hint(self, user_id: str) -> str:
        """获取注入 prompt 的详细度提示。"""
        return self.get_profile(user_id).get_prompt_hint()


_profiling_service: Optional[UserProfilingService] = None


def get_user_profiling_service() -> UserProfilingService:
    global _profiling_service
    if _profiling_service is None:
        _profiling_service = UserProfilingService()
    return _profiling_service
