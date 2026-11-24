"""
Inspection Report Service - 定期巡检报告

聚合 observability 数据，生成"本周大家都在问什么、哪些问题答不上来"的报告。

使用方式::

    svc = get_inspection_report_service()
    report = svc.generate_report(days=7)
"""

import logging
from collections import Counter
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class InspectionReportService:
    """定期巡检报告服务。

    从 observability spans 和 feedback 数据中聚合。
    """

    def __init__(self, observability_service=None, feedback_service=None):
        self._obs = observability_service
        self._feedback = feedback_service

    def _get_obs(self):
        if self._obs is None:
            from runtime.agent_history.observability_service import get_agent_observability_service
            self._obs = get_agent_observability_service()
        return self._obs

    def _get_feedback(self):
        if self._feedback is None:
            from runtime.services.feedback_service import get_feedback_service
            self._feedback = get_feedback_service()
        return self._feedback

    def generate_report(
        self,
        *,
        days: int = 7,
        limit_topics: int = 20,
    ) -> Dict[str, Any]:
        """生成巡检报告。

        Returns:
            {
                "period_days": 7,
                "total_conversations": 0,
                "skill_usage": {"hfo-detector": 15, ...},
                "top_topics": [{"topic": "HFO detection", "count": 5}, ...],
                "unanswered_queries": [...],
                "feedback_summary": {"positive": 10, "negative": 3},
                "tool_usage": {"document_search": 50, ...},
            }
        """
        report: Dict[str, Any] = {
            "period_days": days,
            "total_conversations": 0,
            "skill_usage": {},
            "top_topics": [],
            "unanswered_queries": [],
            "feedback_summary": {},
            "tool_usage": {},
        }

        # Feedback summary
        try:
            fb_svc = self._get_feedback()
            report["feedback_summary"] = fb_svc.count_by_rating()
            negatives = fb_svc.get_negative_feedback_summary(limit=10)
            report["unanswered_queries"] = [
                {"query": n.get("comment", "")[:200], "user_id": n.get("user_id")}
                for n in negatives
            ]
        except Exception as exc:
            logger.warning("[InspectionReport] Feedback aggregation failed: %s", exc)

        return report

    def generate_skill_health(self) -> List[Dict[str, Any]]:
        """生成各 skill 的健康度摘要。"""
        try:
            fb_svc = self._get_feedback()
            all_feedback = fb_svc.list_feedback(limit=1000)

            skill_stats: Dict[str, Dict[str, int]] = {}
            # 这里如果有 skill 维度的 feedback 字段可以聚合
            # 当前 feedback 没有 skill 字段，返回总体统计
            return [{
                "total_feedback": len(all_feedback),
                "positive": sum(1 for f in all_feedback if f.rating == "positive"),
                "negative": sum(1 for f in all_feedback if f.rating == "negative"),
            }]
        except Exception:
            return []


_report_service: Optional[InspectionReportService] = None


def get_inspection_report_service() -> InspectionReportService:
    global _report_service
    if _report_service is None:
        _report_service = InspectionReportService()
    return _report_service
