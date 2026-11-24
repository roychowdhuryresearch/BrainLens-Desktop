"""
Skill A/B Test Service - Skill 效果 A/B 测试

支持同时运行两个版本的 skill，按流量比例分配，
对比 feedback 正负比来判断新版是否更好。

使用方式::

    svc = get_skill_ab_test_service()
    svc.create_experiment("hfo-v2", control="hfo-detector", variant="hfo-detector-v2", traffic_pct=10)
    assigned = svc.assign_variant("hfo-v2", user_id="u-1")
    svc.record_outcome("hfo-v2", user_id="u-1", rating="positive")
    results = svc.get_experiment_results("hfo-v2")
"""

import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class Experiment:
    """A/B 测试实验。"""
    experiment_id: str
    control_skill: str
    variant_skill: str
    traffic_pct: int  # 0-100, variant 分到的流量百分比
    status: str = "active"  # active | paused | completed
    created_at: float = field(default_factory=time.time)
    # {user_id: "control" | "variant"}
    assignments: Dict[str, str] = field(default_factory=dict)
    # {"control": {"positive": N, "negative": N}, "variant": {...}}
    outcomes: Dict[str, Dict[str, int]] = field(default_factory=lambda: {
        "control": {"positive": 0, "negative": 0},
        "variant": {"positive": 0, "negative": 0},
    })

    def to_dict(self) -> Dict[str, Any]:
        return {
            "experiment_id": self.experiment_id,
            "control_skill": self.control_skill,
            "variant_skill": self.variant_skill,
            "traffic_pct": self.traffic_pct,
            "status": self.status,
            "total_assignments": len(self.assignments),
            "outcomes": dict(self.outcomes),
            "created_at": self.created_at,
        }


class SkillABTestService:
    """Skill A/B 测试服务。"""

    def __init__(self) -> None:
        self._experiments: Dict[str, Experiment] = {}

    def create_experiment(
        self,
        experiment_id: str,
        *,
        control: str,
        variant: str,
        traffic_pct: int = 10,
    ) -> Experiment:
        """创建 A/B 测试实验。"""
        if traffic_pct < 0 or traffic_pct > 100:
            raise ValueError(f"traffic_pct must be 0-100, got {traffic_pct}")

        exp = Experiment(
            experiment_id=experiment_id,
            control_skill=control,
            variant_skill=variant,
            traffic_pct=traffic_pct,
        )
        self._experiments[experiment_id] = exp
        logger.info(
            "[ABTest] Created: %s (control=%s variant=%s traffic=%d%%)",
            experiment_id, control, variant, traffic_pct,
        )
        return exp

    def assign_variant(
        self,
        experiment_id: str,
        user_id: str,
    ) -> Optional[str]:
        """为用户分配实验组。

        使用 user_id 的 hash 确保同一用户始终分到同一组。

        Returns:
            分配到的 skill name，或 None（实验不存在/未激活）
        """
        exp = self._experiments.get(experiment_id)
        if exp is None or exp.status != "active":
            return None

        # 已分配过的用户保持一致
        if user_id in exp.assignments:
            group = exp.assignments[user_id]
            return exp.variant_skill if group == "variant" else exp.control_skill

        # 基于 hash 的稳定分流
        hash_val = int(hashlib.md5(f"{experiment_id}:{user_id}".encode()).hexdigest(), 16)
        bucket = hash_val % 100

        if bucket < exp.traffic_pct:
            group = "variant"
            skill = exp.variant_skill
        else:
            group = "control"
            skill = exp.control_skill

        exp.assignments[user_id] = group
        return skill

    def record_outcome(
        self,
        experiment_id: str,
        user_id: str,
        rating: str,  # "positive" | "negative"
    ) -> bool:
        """记录实验结果。"""
        exp = self._experiments.get(experiment_id)
        if exp is None:
            return False

        group = exp.assignments.get(user_id)
        if group is None:
            return False

        if rating in ("positive", "negative"):
            exp.outcomes[group][rating] = exp.outcomes[group].get(rating, 0) + 1
            return True
        return False

    def get_experiment_results(self, experiment_id: str) -> Optional[Dict[str, Any]]:
        """获取实验结果。"""
        exp = self._experiments.get(experiment_id)
        if exp is None:
            return None

        def _calc_rate(outcomes: Dict[str, int]) -> float:
            total = outcomes.get("positive", 0) + outcomes.get("negative", 0)
            if total == 0:
                return 0.0
            return outcomes.get("positive", 0) / total

        control_rate = _calc_rate(exp.outcomes["control"])
        variant_rate = _calc_rate(exp.outcomes["variant"])

        return {
            **exp.to_dict(),
            "control_positive_rate": round(control_rate, 3),
            "variant_positive_rate": round(variant_rate, 3),
            "improvement": round(variant_rate - control_rate, 3),
            "recommendation": (
                "variant_better" if variant_rate > control_rate + 0.05
                else "control_better" if control_rate > variant_rate + 0.05
                else "no_significant_difference"
            ),
        }

    def get_skill_for_user(
        self,
        original_skill: str,
        user_id: str,
    ) -> str:
        """查询用户是否在某个 skill 的 A/B 测试中，返回应使用的 skill。"""
        for exp in self._experiments.values():
            if exp.status != "active":
                continue
            if exp.control_skill == original_skill:
                assigned = self.assign_variant(exp.experiment_id, user_id)
                if assigned:
                    return assigned
        return original_skill

    def list_experiments(self) -> List[Dict[str, Any]]:
        return [exp.to_dict() for exp in self._experiments.values()]

    def stop_experiment(self, experiment_id: str) -> bool:
        exp = self._experiments.get(experiment_id)
        if exp is None:
            return False
        exp.status = "completed"
        return True


_ab_test_service: Optional[SkillABTestService] = None


def get_skill_ab_test_service() -> SkillABTestService:
    global _ab_test_service
    if _ab_test_service is None:
        _ab_test_service = SkillABTestService()
    return _ab_test_service
