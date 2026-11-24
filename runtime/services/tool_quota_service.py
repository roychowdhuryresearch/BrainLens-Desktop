"""
Tool Quota Service - 工具调用配额管理

按用户/团队限制工具调用次数，防止成本失控。
使用内存计数器（轻量级，无需 Redis），每天自动重置。

使用方式::

    quota = get_tool_quota_service()
    if not quota.check_and_consume("user-123", "document_search"):
        raise QuotaExceededError("Daily quota exceeded")
"""

import logging
import time
from collections import defaultdict
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# 默认每日配额（按工具类别）
DEFAULT_DAILY_QUOTAS: Dict[str, int] = {
    "document_search": 200,
    "document_list_docs": 100,
    "document_get_doc_detail": 100,
    "secondary_document_search": 200,
    "secondary_document_list_docs": 100,
    "secondary_document_get_doc_detail": 100,
    "bing_search": 100,
    "bing_crawl": 50,
    "_default": 500,  # 未列出的工具
}

# 每次对话最大工具调用数
DEFAULT_CONVERSATION_TOOL_LIMIT = 50


class QuotaExceededError(Exception):
    """配额超限异常。"""
    pass


class ToolQuotaService:
    """工具调用配额管理器。

    内存计数器实现，按 (user_id, tool_name, day) 维度计数。
    进程重启后计数器归零（生产环境可切换 Redis 后端）。
    """

    def __init__(
        self,
        daily_quotas: Optional[Dict[str, int]] = None,
        conversation_limit: int = DEFAULT_CONVERSATION_TOOL_LIMIT,
    ) -> None:
        self._quotas = daily_quotas or dict(DEFAULT_DAILY_QUOTAS)
        self._conversation_limit = conversation_limit
        # {f"{user_id}:{tool_name}:{day_key}": count}
        self._user_counters: Dict[str, int] = defaultdict(int)
        # {conversation_id: count}
        self._conv_counters: Dict[str, int] = defaultdict(int)
        self._last_cleanup_day: str = ""

    @staticmethod
    def _day_key() -> str:
        return time.strftime("%Y-%m-%d")

    def _maybe_cleanup(self) -> None:
        """每天自动清理前一天的计数器。"""
        today = self._day_key()
        if today != self._last_cleanup_day:
            stale = [k for k in self._user_counters if not k.endswith(f":{today}")]
            for k in stale:
                del self._user_counters[k]
            self._last_cleanup_day = today

    def _get_limit(self, tool_name: str) -> int:
        return self._quotas.get(tool_name, self._quotas.get("_default", 500))

    def check_user_quota(self, user_id: str, tool_name: str) -> Tuple[bool, int, int]:
        """检查用户的每日工具配额。

        Returns:
            (is_allowed, current_count, daily_limit)
        """
        self._maybe_cleanup()
        key = f"{user_id}:{tool_name}:{self._day_key()}"
        current = self._user_counters[key]
        limit = self._get_limit(tool_name)
        return current < limit, current, limit

    def check_conversation_quota(self, conversation_id: str) -> Tuple[bool, int, int]:
        """检查单次对话的工具调用总量。

        Returns:
            (is_allowed, current_count, limit)
        """
        current = self._conv_counters[conversation_id]
        return current < self._conversation_limit, current, self._conversation_limit

    def check_and_consume(
        self,
        user_id: str,
        tool_name: str,
        conversation_id: Optional[str] = None,
    ) -> bool:
        """检查配额并消费一次。返回 True 表示允许，False 表示超限。"""
        allowed, current, limit = self.check_user_quota(user_id, tool_name)
        if not allowed:
            logger.warning(
                "[Quota] User %s exceeded daily quota for %s: %d/%d",
                user_id, tool_name, current, limit,
            )
            return False

        if conversation_id:
            conv_ok, conv_count, conv_limit = self.check_conversation_quota(conversation_id)
            if not conv_ok:
                logger.warning(
                    "[Quota] Conversation %s exceeded tool limit: %d/%d",
                    conversation_id, conv_count, conv_limit,
                )
                return False
            self._conv_counters[conversation_id] += 1

        key = f"{user_id}:{tool_name}:{self._day_key()}"
        self._user_counters[key] += 1
        return True

    def get_usage_summary(self, user_id: str) -> Dict[str, Dict[str, int]]:
        """获取用户今日用量摘要。"""
        self._maybe_cleanup()
        today = self._day_key()
        prefix = f"{user_id}:"
        result = {}
        for key, count in self._user_counters.items():
            if key.startswith(prefix) and key.endswith(f":{today}"):
                tool = key[len(prefix):-(len(today) + 1)]
                result[tool] = {"used": count, "limit": self._get_limit(tool)}
        return result

    def reset_user(self, user_id: str) -> None:
        """重置用户的所有配额计数（管理员操作）。"""
        today = self._day_key()
        stale = [k for k in self._user_counters if k.startswith(f"{user_id}:")]
        for k in stale:
            del self._user_counters[k]

    def reset_conversation(self, conversation_id: str) -> None:
        """重置对话的工具调用计数。"""
        self._conv_counters.pop(conversation_id, None)


_tool_quota_service: Optional[ToolQuotaService] = None


def get_tool_quota_service() -> ToolQuotaService:
    global _tool_quota_service
    if _tool_quota_service is None:
        _tool_quota_service = ToolQuotaService()
    return _tool_quota_service
