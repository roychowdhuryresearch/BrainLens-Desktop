"""
Summary Repository - 摘要仓储

负责滚动摘要的存储（ContextManager 用）
"""

import json
from typing import Dict, Optional
from datetime import datetime
from runtime.agent_history.db import SessionLocal
from runtime.agent_history.models import AgentSummary
from runtime.agent_runtime.conversation_state import CONVERSATION_RUNTIME_STATE_KEY


class SummaryRepository:
    """摘要仓储"""

    @staticmethod
    def _parse_metadata(summary: Optional[AgentSummary]) -> Dict:
        if not summary or not summary.summary_metadata:
            return {}
        try:
            payload = json.loads(summary.summary_metadata)
            return payload if isinstance(payload, dict) else {}
        except json.JSONDecodeError:
            return {}

    def get(self, conversation_id: str) -> Optional[AgentSummary]:
        """获取摘要"""
        db = SessionLocal()
        try:
            return db.query(AgentSummary).filter(
                AgentSummary.conversation_id == conversation_id
            ).first()
        finally:
            db.close()

    def save(
        self,
        conversation_id: str,
        summary_text: str,
        summary_turn: int,
        important_facts: list = None,
        constraints: list = None,
        decisions_made: list = None,
        open_questions: list = None,
    ) -> AgentSummary:
        """保存或更新摘要"""
        db = SessionLocal()
        try:
            summary = db.query(AgentSummary).filter(
                AgentSummary.conversation_id == conversation_id
            ).first()

            metadata = self._parse_metadata(summary)
            metadata.update({
                "important_facts": important_facts or [],
                "constraints": constraints or [],
                "decisions_made": decisions_made or [],
                "open_questions": open_questions or [],
            })

            if summary:
                # 更新
                summary.summary_text = summary_text
                summary.summary_turn = summary_turn
                summary.summary_metadata = json.dumps(metadata, ensure_ascii=False)
                summary.updated_at = datetime.utcnow()
            else:
                # 创建
                summary = AgentSummary(
                    conversation_id=conversation_id,
                    summary_text=summary_text,
                    summary_turn=summary_turn,
                    summary_metadata=json.dumps(metadata, ensure_ascii=False),
                )
                db.add(summary)

            db.commit()
            db.refresh(summary)
            return summary
        finally:
            db.close()

    def delete(self, conversation_id: str) -> bool:
        """删除摘要"""
        db = SessionLocal()
        try:
            summary = db.query(AgentSummary).filter(
                AgentSummary.conversation_id == conversation_id
            ).first()
            if summary:
                db.delete(summary)
                db.commit()
                return True
            return False
        finally:
            db.close()

    def get_metadata(self, conversation_id: str) -> dict:
        """获取摘要的 metadata（结构化数据）"""
        db = SessionLocal()
        try:
            summary = db.query(AgentSummary).filter(
                AgentSummary.conversation_id == conversation_id
            ).first()
            if summary and summary.summary_metadata:
                return self._parse_metadata(summary)
            return {}
        finally:
            db.close()

    def get_runtime_state(self, conversation_id: str) -> Optional[Dict]:
        metadata = self.get_metadata(conversation_id)
        runtime_state = metadata.get(CONVERSATION_RUNTIME_STATE_KEY)
        return dict(runtime_state) if isinstance(runtime_state, dict) else None

    def save_runtime_state(self, conversation_id: str, runtime_state: Dict) -> AgentSummary:
        """保存 conversation-scoped runtime state，同时保留已有 summary metadata。"""
        db = SessionLocal()
        try:
            summary = db.query(AgentSummary).filter(
                AgentSummary.conversation_id == conversation_id
            ).first()
            metadata = self._parse_metadata(summary)
            metadata[CONVERSATION_RUNTIME_STATE_KEY] = dict(runtime_state or {})

            if summary:
                summary.summary_metadata = json.dumps(metadata, ensure_ascii=False)
                summary.updated_at = datetime.utcnow()
            else:
                summary = AgentSummary(
                    conversation_id=conversation_id,
                    summary_text="",
                    summary_turn=0,
                    summary_metadata=json.dumps(metadata, ensure_ascii=False),
                )
                db.add(summary)

            db.commit()
            db.refresh(summary)
            return summary
        finally:
            db.close()


__all__ = ["SummaryRepository"]
