"""
Feedback Service - 对话质量反馈

允许用户对 agent 回答进行评价（点赞/标错/纠正），
形成质量闭环，为后续改进提供数据。

使用方式::

    svc = get_feedback_service()
    svc.submit_feedback(
        conversation_id="conv-1",
        turn_id="turn-1",
        user_id="user-1",
        rating="negative",
        comment="参数给错了，应该是 200A 不是 300A",
        correction="正确电流范围是 180-220A",
    )
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class FeedbackEntry:
    """一条反馈记录。"""
    feedback_id: str
    conversation_id: str
    turn_id: Optional[str]
    message_id: Optional[str]
    user_id: str
    rating: str  # "positive" | "negative" | "correction"
    comment: str = ""
    correction: str = ""  # 用户给的正确内容
    tags: List[str] = field(default_factory=list)  # e.g. ["参数错误", "来源不准"]
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "feedback_id": self.feedback_id,
            "conversation_id": self.conversation_id,
            "turn_id": self.turn_id,
            "message_id": self.message_id,
            "user_id": self.user_id,
            "rating": self.rating,
            "comment": self.comment,
            "correction": self.correction,
            "tags": self.tags,
            "created_at": self.created_at,
        }


class FeedbackService:
    """对话质量反馈服务。

    当前使用内存存储；可后续切换为数据库持久化。
    """

    VALID_RATINGS = {"positive", "negative", "correction"}

    def __init__(self) -> None:
        self._store: Dict[str, FeedbackEntry] = {}
        self._counter = 0

    def _next_id(self) -> str:
        self._counter += 1
        return f"fb_{self._counter:06d}"

    def submit_feedback(
        self,
        *,
        conversation_id: str,
        user_id: str,
        rating: str,
        turn_id: Optional[str] = None,
        message_id: Optional[str] = None,
        comment: str = "",
        correction: str = "",
        tags: Optional[List[str]] = None,
    ) -> FeedbackEntry:
        """提交一条反馈。

        Args:
            conversation_id: 对话 ID
            user_id:         用户 ID
            rating:          评价类型 (positive/negative/correction)
            turn_id:         对话轮次 ID（可选）
            message_id:      消息 ID（可选）
            comment:         评论文本
            correction:      用户给的正确内容
            tags:            标签列表

        Returns:
            创建的 FeedbackEntry
        """
        if rating not in self.VALID_RATINGS:
            raise ValueError(f"Invalid rating '{rating}'. Must be one of {self.VALID_RATINGS}")

        entry = FeedbackEntry(
            feedback_id=self._next_id(),
            conversation_id=conversation_id,
            turn_id=turn_id,
            message_id=message_id,
            user_id=user_id,
            rating=rating,
            comment=comment[:5000],  # 限制长度
            correction=correction[:5000],
            tags=list(tags or [])[:10],
        )
        self._store[entry.feedback_id] = entry
        logger.info(
            "[Feedback] Submitted: id=%s conv=%s user=%s rating=%s",
            entry.feedback_id, conversation_id, user_id, rating,
        )
        return entry

    def get_feedback(self, feedback_id: str) -> Optional[FeedbackEntry]:
        return self._store.get(feedback_id)

    def list_feedback(
        self,
        *,
        conversation_id: Optional[str] = None,
        user_id: Optional[str] = None,
        rating: Optional[str] = None,
        limit: int = 50,
    ) -> List[FeedbackEntry]:
        """按条件筛选反馈列表。"""
        results = list(self._store.values())
        if conversation_id:
            results = [e for e in results if e.conversation_id == conversation_id]
        if user_id:
            results = [e for e in results if e.user_id == user_id]
        if rating:
            results = [e for e in results if e.rating == rating]
        results.sort(key=lambda e: e.created_at, reverse=True)
        return results[:limit]

    def count_by_rating(self, conversation_id: Optional[str] = None) -> Dict[str, int]:
        """统计各评价类型的数量。"""
        counts: Dict[str, int] = {r: 0 for r in self.VALID_RATINGS}
        for entry in self._store.values():
            if conversation_id and entry.conversation_id != conversation_id:
                continue
            if entry.rating in counts:
                counts[entry.rating] += 1
        return counts

    def get_negative_feedback_summary(self, limit: int = 20) -> List[Dict[str, Any]]:
        """获取最近的负面反馈摘要（用于质量改进）。"""
        negatives = [
            e for e in self._store.values()
            if e.rating in ("negative", "correction")
        ]
        negatives.sort(key=lambda e: e.created_at, reverse=True)
        return [e.to_dict() for e in negatives[:limit]]


_feedback_service: Optional[FeedbackService] = None


def get_feedback_service() -> FeedbackService:
    global _feedback_service
    if _feedback_service is None:
        _feedback_service = FeedbackService()
    return _feedback_service
