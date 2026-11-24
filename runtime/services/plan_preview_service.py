"""
Plan Preview Service - 执行计划预览

在不执行 LLM 调用的情况下，预览 agent 对给定消息会生成什么样的执行计划。
用于高风险场景下先看计划再执行。

使用方式::

    svc = get_plan_preview_service()
    preview = svc.preview_plan("激光传感器连接失败", all_skills=packages)
"""

import logging
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class PlanPreviewService:
    """执行计划预览服务。

    仅做 skill matching，不调用 LLM，不执行任何工具。
    """

    def preview_plan(
        self,
        message: str,
        *,
        all_skills: Optional[List] = None,
        user_id: Optional[str] = None,
        skill_environment: str = "prod",
    ) -> Dict[str, Any]:
        """预览给定消息的执行计划。

        Returns:
            {
                "message": "用户消息",
                "matched_skills": [
                    {"name": "skill-A", "score": 15.5, "matched_keywords": [...]},
                ],
                "top_skill": "skill-A",
                "estimated_steps": 1,
                "would_use_tools": ["document_search", "document_get_detail"],
                "preview_only": True,
            }
        """
        started = time.perf_counter()

        try:
            from runtime.skills.skill_registry import skill_registry
            from runtime.skills.skill_matcher import SkillMatcher

            if not skill_registry.is_initialized:
                skill_registry.scan_skills()

            matcher = SkillMatcher(skill_registry)
            candidates = matcher.find_candidates(
                message,
                top_k=5,
                user_id=user_id,
            )

            matched = []
            for candidate in candidates:
                matched.append({
                    "name": candidate.skill.name,
                    "score": candidate.score,
                    "matched_keywords": candidate.matched_keywords,
                    "matched_tags": candidate.matched_tags,
                    "description": candidate.skill.description[:200],
                })

            top_skill = matched[0]["name"] if matched else None

            # 推测可能使用的工具
            would_use_tools = []
            if top_skill:
                pkg = skill_registry.get_package(top_skill)
                if pkg and pkg.allowed_tools:
                    would_use_tools = list(pkg.allowed_tools)

            duration_ms = (time.perf_counter() - started) * 1000

            return {
                "message": message[:500],
                "matched_skills": matched,
                "top_skill": top_skill,
                "estimated_steps": 1 if top_skill else 0,
                "would_use_tools": would_use_tools,
                "preview_only": True,
                "duration_ms": round(duration_ms, 1),
            }

        except Exception as exc:
            logger.error("[PlanPreview] Failed: %s", exc)
            return {
                "message": message[:500],
                "matched_skills": [],
                "top_skill": None,
                "estimated_steps": 0,
                "would_use_tools": [],
                "preview_only": True,
                "error": str(exc),
            }


_preview_service: Optional[PlanPreviewService] = None


def get_plan_preview_service() -> PlanPreviewService:
    global _preview_service
    if _preview_service is None:
        _preview_service = PlanPreviewService()
    return _preview_service
