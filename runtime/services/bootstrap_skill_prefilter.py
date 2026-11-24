from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from runtime.models.schemas import BootstrapSkillPrefilterConfig
from runtime.skills.models import SkillPackage
from runtime.skills.skill_matcher import SkillMatcher


@dataclass
class BootstrapSkillPrefilterResult:
    skill_packages: List[SkillPackage]
    original_count: int
    filtered_count: int
    used_prefilter: bool
    fallback_to_full: bool
    top_candidates: List[str] = field(default_factory=list)
    top1_score: float = 0.0
    reason: str = ""


class BootstrapSkillPrefilter:
    def __init__(
        self,
        *,
        config: Optional[BootstrapSkillPrefilterConfig] = None,
        matcher: Optional[SkillMatcher] = None,
    ) -> None:
        self.config = config or BootstrapSkillPrefilterConfig()
        self.matcher = matcher or SkillMatcher()

    def filter_candidates(
        self,
        *,
        message: str,
        all_skill_packages: List[SkillPackage],
        active_skill_name: Optional[str] = None,
    ) -> BootstrapSkillPrefilterResult:
        original_count = len(all_skill_packages)
        full_result = BootstrapSkillPrefilterResult(
            skill_packages=list(all_skill_packages),
            original_count=original_count,
            filtered_count=original_count,
            used_prefilter=False,
            fallback_to_full=False,
            reason="disabled",
        )

        if not self.config.enabled:
            return full_result
        if active_skill_name:
            full_result.reason = "manual_active_skill"
            return full_result
        if original_count < self.config.min_skill_count:
            full_result.reason = "below_min_skill_count"
            return full_result

        matches = self.matcher.find_candidates_from_packages(
            query=message,
            skill_packages=all_skill_packages,
            top_k=self.config.top_k,
            min_score_threshold=0.0,
        )
        if not matches:
            full_result.fallback_to_full = True
            full_result.reason = "no_matches"
            return full_result

        top1_score = float(matches[0].score)
        top_candidates = [match.skill.name for match in matches]
        if top1_score < self.config.min_top1_score:
            full_result.fallback_to_full = True
            full_result.top1_score = top1_score
            full_result.top_candidates = top_candidates
            full_result.reason = "top1_below_threshold"
            return full_result

        selected_names = set(top_candidates)
        filtered_packages = [pkg for pkg in all_skill_packages if pkg.name in selected_names]
        return BootstrapSkillPrefilterResult(
            skill_packages=filtered_packages,
            original_count=original_count,
            filtered_count=len(filtered_packages),
            used_prefilter=True,
            fallback_to_full=False,
            top_candidates=top_candidates,
            top1_score=top1_score,
            reason="matched_top_k",
        )
