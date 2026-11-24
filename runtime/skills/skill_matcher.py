"""
Skill 关键词匹配器

根据用户查询，基于标签 / 关键词 / when_to_use / 示例等维度打分，
返回 top-K 候选 SkillManifest。不涉及 LLM 决策 —— 生产路由由
agent_runtime 的 bootstrap → controller 动态完成；本模块只服务于
离线候选挑选（比如 plan_preview_service 的候选预览和 e2e 的评测）。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import List, Optional, Tuple

from runtime.models.schemas import SkillManifest, SkillMatch
from runtime.skills.skill_registry import SkillRegistry, skill_registry
from runtime.skills.models import SkillPackage

logger = logging.getLogger(__name__)


SPLIT_SIGNALS = ["并且", "同时", "还有", "另外", "顺便", "以及", "另外再"]


def decompose_query(query: str) -> List[str]:
    """按 SPLIT_SIGNALS 拆分复合查询；无信号则返回单元素列表。"""
    for signal in SPLIT_SIGNALS:
        if signal in query:
            parts = query.split(signal, maxsplit=1)
            sub_queries = [p.strip().rstrip("，,、") for p in parts]
            sub_queries = [q for q in sub_queries if q]
            if len(sub_queries) > 1:
                return sub_queries
    return [query]


class SkillMatcher:
    """关键词匹配器：给候选 Skill 打分并返回 top-K。"""

    TAG_WEIGHT = 10.0
    KEYWORD_WEIGHT = 5.0
    DESCRIPTION_WEIGHT = 2.0
    WHEN_TO_USE_WEIGHT = 2.0
    MIN_SCORE_THRESHOLD = 5.0

    def __init__(self, registry: Optional[SkillRegistry] = None):
        self.registry = registry or skill_registry

    def find_candidates(
        self,
        query: str,
        top_k: int = 3,
        user_id: Optional[str] = None,
        skill_environment: Optional[str] = None,
        user_role: Optional[str] = None,
    ) -> List[SkillMatch]:
        if not query or not query.strip():
            return []

        skill_packages = self.registry.get_all_packages(
            user_id=user_id,
            user_role=user_role,
            skill_environment=skill_environment,
        )
        return self.find_candidates_from_packages(
            query=query,
            skill_packages=skill_packages,
            top_k=top_k,
        )

    def find_candidates_from_packages(
        self,
        *,
        query: str,
        skill_packages: List[SkillPackage],
        top_k: Optional[int] = None,
        min_score_threshold: float = MIN_SCORE_THRESHOLD,
    ) -> List[SkillMatch]:
        """Score and rank a provided candidate set using the standard matcher rules."""
        if not query or not query.strip():
            return []

        query_lower = query.lower()
        query_words = set(re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+", query_lower))

        candidates: List[SkillMatch] = []
        for pkg in skill_packages:
            skill = self.registry._package_to_manifest(pkg)
            score, matched_keywords, matched_tags = self._calculate_score(
                skill, query_lower, query_words
            )
            if score >= min_score_threshold:
                candidates.append(
                    SkillMatch(
                        skill=skill,
                        score=score,
                        matched_keywords=matched_keywords,
                        matched_tags=matched_tags,
                    )
                )

        candidates.sort(key=lambda x: x.score, reverse=True)
        if top_k is None:
            return candidates
        return candidates[:top_k]

    def _calculate_score(
        self,
        skill: SkillManifest,
        query_lower: str,
        query_words: set,
    ) -> Tuple[float, List[str], List[str]]:
        score = 0.0
        matched_keywords: List[str] = []
        matched_tags: List[str] = []

        for tag in skill.tags:
            tag_lower = tag.strip().lower()
            if not tag_lower:
                continue
            if tag_lower in query_lower or tag_lower in query_words:
                score += self.TAG_WEIGHT
                matched_tags.append(tag)

        for keyword in skill.keywords:
            keyword_lower = keyword.strip().lower()
            if not keyword_lower:
                continue
            if keyword_lower in query_lower:
                score += self.KEYWORD_WEIGHT
                matched_keywords.append(keyword)
            elif keyword_lower in query_words:
                score += self.KEYWORD_WEIGHT * 0.8
                matched_keywords.append(keyword)

        if skill.description:
            description_words = set(
                re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+", skill.description.lower())
            )
            overlap = description_words & query_words
            if overlap:
                score += self.DESCRIPTION_WEIGHT * len(overlap)

        if skill.when_to_use:
            when_to_use_words = set(
                re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+", skill.when_to_use.lower())
            )
            overlap = when_to_use_words & query_words
            if overlap:
                score += self.WHEN_TO_USE_WEIGHT * len(overlap)

        if skill.examples:
            for example in skill.examples:
                example_lower = example.lower()
                if example_lower in query_lower:
                    score += self.KEYWORD_WEIGHT * 1.5
                    if example not in matched_keywords:
                        matched_keywords.append(example)

        if skill.name:
            name_parts = skill.name.replace("-", " ").split()
            for part in name_parts:
                if part.lower() in query_lower:
                    score += self.KEYWORD_WEIGHT

        return score, matched_keywords, matched_tags

    def add_skill(self, manifest: SkillManifest) -> None:
        """将一个 manifest 注册进底层 registry（给动态加 skill 的场景用）。"""
        if hasattr(self.registry, "register"):
            from runtime.skills.models import SkillPackage
            pkg = SkillPackage(
                name=manifest.name,
                root_dir=Path(manifest.path).parent if manifest.path else Path("."),
                skill_md_path=Path(manifest.path) if manifest.path else Path("."),
                description=manifest.description,
                tags=manifest.tags,
                keywords=manifest.keywords,
                when_to_use=manifest.when_to_use,
                do_not_use=manifest.do_not_use,
                examples=manifest.examples,
                priority=0,
                metadata={},
            )
            self.registry.register(pkg)

    def remove_skill(self, skill_name: str) -> None:
        if hasattr(self.registry, "unregister"):
            self.registry.unregister(skill_name)
