"""
Conversation Summary Service - 用户可见的对话摘要

让用户可以获取对话的结构化摘要：讨论了什么、达成了什么结论、待办事项。
复用现有的 context summarizer 能力。

使用方式::

    svc = get_conversation_summary_service()
    summary = await svc.generate_user_summary("conv-1")
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ConversationSummaryService:
    """用户可见的对话摘要服务。

    复用现有 context/summarizer 的摘要能力，但面向用户输出。
    """

    def __init__(self, ai_service=None, history_service=None):
        self._ai_service = ai_service
        self._history_service = history_service

    def _get_ai_service(self):
        if self._ai_service is None:
            from runtime.runtime_bootstrap import get_agent_service
            self._ai_service = get_agent_service().ai_service
        return self._ai_service

    def _get_history_service(self):
        if self._history_service is None:
            from runtime.agent_history.service import get_agent_history_service
            self._history_service = get_agent_history_service()
        return self._history_service

    async def generate_user_summary(
        self,
        conversation_id: str,
        *,
        max_messages: int = 50,
    ) -> Dict[str, Any]:
        """生成用户可见的对话摘要。

        Returns:
            {
                "conversation_id": "conv-1",
                "summary": "本次对话讨论了...",
                "topics": ["服务连接", "参数调整"],
                "conclusions": ["建议检查网络连通性", "timeout 设置为 30s"],
                "open_questions": ["需要确认软件版本"],
                "message_count": 12,
            }
        """
        history_svc = self._get_history_service()
        messages = history_svc.get_recent_messages(conversation_id, limit=max_messages)
        # The recent slice is capped at max_messages; report the TRUE total so a long
        # conversation isn't under-counted as just `max_messages`.
        total_count = history_svc.get_message_count(conversation_id)
        if not isinstance(total_count, int) or total_count < len(messages):
            total_count = len(messages)

        if not messages:
            return {
                "conversation_id": conversation_id,
                "summary": "暂无对话记录",
                "topics": [],
                "conclusions": [],
                "open_questions": [],
                "message_count": 0,
            }

        # 提取用户和助手的消息
        user_msgs = [m.get("content", "") for m in messages if m.get("role") == "user"]
        assistant_msgs = [m.get("content", "") for m in messages if m.get("role") == "assistant"]

        # 简单的规则化摘要（不调用 LLM，零成本）
        topics = self._extract_topics(user_msgs)
        conclusions = self._extract_conclusions(assistant_msgs)

        # 拼接摘要文本
        summary_parts = []
        if topics:
            summary_parts.append(f"讨论话题：{'、'.join(topics[:5])}")
        if conclusions:
            summary_parts.append(f"主要结论：{'；'.join(conclusions[:3])}")
        summary_parts.append(f"共 {total_count} 条消息（最近 {len(user_msgs)} 条用户消息，{len(assistant_msgs)} 条助手回复）")

        return {
            "conversation_id": conversation_id,
            "summary": "。".join(summary_parts),
            "topics": topics[:10],
            "conclusions": conclusions[:10],
            "open_questions": [],
            "message_count": total_count,
        }

    @staticmethod
    def _extract_topics(user_messages: List[str]) -> List[str]:
        """从用户消息中提取讨论话题。"""
        import re
        topics = []
        seen = set()
        for msg in user_messages:
            # 提取关键短语（简单启发式）
            phrases = re.findall(r"[\u4e00-\u9fa5]{2,8}", msg)
            for phrase in phrases:
                if len(phrase) >= 3 and phrase.lower() not in seen:
                    seen.add(phrase.lower())
                    topics.append(phrase)
        return topics[:10]

    @staticmethod
    def _extract_conclusions(assistant_messages: List[str]) -> List[str]:
        """从助手消息中提取结论性内容。"""
        conclusions = []
        # 找包含"建议"、"推荐"、"结论"、"设置为"等关键词的句子
        keywords = ["建议", "推荐", "应该", "设置为", "需要", "可以使用"]
        for msg in assistant_messages:
            sentences = msg.replace("。", "。\n").replace("；", "；\n").split("\n")
            for sent in sentences:
                sent = sent.strip()
                if any(kw in sent for kw in keywords) and 10 < len(sent) < 100:
                    conclusions.append(sent)
        return conclusions[:10]


_summary_service: Optional[ConversationSummaryService] = None


def get_conversation_summary_service() -> ConversationSummaryService:
    global _summary_service
    if _summary_service is None:
        _summary_service = ConversationSummaryService()
    return _summary_service
