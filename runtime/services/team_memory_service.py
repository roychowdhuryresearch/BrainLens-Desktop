"""
Team Memory Service - 多用户协作上下文（团队共享记忆）

在 durable memory 的 scope_level=team 基础上，
提供主动关联和推荐机制：A 用户排查了某个问题，B 用户问相同主题时能看到结论。

使用方式::

    svc = get_team_memory_service()
    svc.share_finding("team-1", user_id="A", key="API 超时", value="调高 timeout 并检查重试策略")
    related = svc.find_related("team-1", query="API 报错")
"""

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class SharedFinding:
    """一条团队共享的发现/结论。"""
    finding_id: str
    team_id: str
    user_id: str
    key: str
    value: str
    tags: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    equipment_id: Optional[str] = None  # 关联的设备标识

    def to_dict(self) -> Dict[str, Any]:
        return {
            "finding_id": self.finding_id,
            "team_id": self.team_id,
            "user_id": self.user_id,
            "key": self.key,
            "value": self.value,
            "tags": self.tags,
            "equipment_id": self.equipment_id,
            "created_at": self.created_at,
        }


class TeamMemoryService:
    """团队共享记忆服务。

    内存实现；可后续切换到 durable memory team scope。
    """

    def __init__(self) -> None:
        self._store: Dict[str, List[SharedFinding]] = {}  # {team_id: [findings]}
        self._counter = 0

    def _next_id(self) -> str:
        self._counter += 1
        return f"tf_{self._counter:06d}"

    def share_finding(
        self,
        team_id: str,
        *,
        user_id: str,
        key: str,
        value: str,
        tags: Optional[List[str]] = None,
        equipment_id: Optional[str] = None,
    ) -> SharedFinding:
        """分享一条发现到团队。"""
        finding = SharedFinding(
            finding_id=self._next_id(),
            team_id=team_id,
            user_id=user_id,
            key=key[:500],
            value=value[:5000],
            tags=list(tags or [])[:10],
            equipment_id=equipment_id,
        )
        if team_id not in self._store:
            self._store[team_id] = []
        self._store[team_id].append(finding)
        logger.info("[TeamMemory] Shared: team=%s user=%s key=%s", team_id, user_id, key[:50])
        return finding

    def find_related(
        self,
        team_id: str,
        query: str,
        *,
        limit: int = 5,
    ) -> List[SharedFinding]:
        """根据查询文本查找团队中相关的发现。"""
        findings = self._store.get(team_id, [])
        if not findings:
            return []

        query_words = set(re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+\d*", query.lower()))
        if not query_words:
            return findings[-limit:]

        scored = []
        for f in findings:
            text = f"{f.key} {f.value} {' '.join(f.tags)} {f.equipment_id or ''}"
            text_words = set(re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+\d*", text.lower()))
            overlap = len(query_words & text_words)
            if overlap > 0:
                scored.append((overlap, f))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [f for _, f in scored[:limit]]

    def get_team_findings(self, team_id: str, limit: int = 20) -> List[SharedFinding]:
        """获取团队所有发现。"""
        findings = self._store.get(team_id, [])
        return findings[-limit:]

    def get_equipment_history(self, team_id: str, equipment_id: str) -> List[SharedFinding]:
        """获取指定设备的所有历史记录。"""
        return [
            f for f in self._store.get(team_id, [])
            if f.equipment_id == equipment_id
        ]


_team_memory_service: Optional[TeamMemoryService] = None


def get_team_memory_service() -> TeamMemoryService:
    global _team_memory_service
    if _team_memory_service is None:
        _team_memory_service = TeamMemoryService()
    return _team_memory_service
