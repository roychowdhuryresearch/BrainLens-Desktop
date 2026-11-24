"""
Turn Repository - 轮次仓储

负责轮次的创建和更新（Agent 核心运行数据）
"""

from typing import Optional, List
from datetime import datetime
from runtime.agent_history.db import SessionLocal
from runtime.agent_history.models import AgentTurn


class TurnRepository:
    """轮次仓储"""

    def create(
        self,
        turn_id: str,
        conversation_id: str,
        turn_number: int,
        user_message: str,
        active_skill: str = None,
        skill_reason: str = None,
        routing_method: str = None,
    ) -> AgentTurn:
        """创建轮次"""
        db = SessionLocal()
        try:
            turn = AgentTurn(
                id=turn_id,
                conversation_id=conversation_id,
                turn_number=turn_number,
                user_message=user_message,
                active_skill=active_skill,
                skill_reason=skill_reason,
                routing_method=routing_method,
                status="running",
            )
            db.add(turn)
            db.commit()
            db.refresh(turn)
            return turn
        finally:
            db.close()

    def get(self, turn_id: str) -> Optional[AgentTurn]:
        """获取轮次"""
        db = SessionLocal()
        try:
            return db.query(AgentTurn).filter(AgentTurn.id == turn_id).first()
        finally:
            db.close()

    def get_by_conversation(
        self,
        conversation_id: str,
    ) -> List[AgentTurn]:
        """获取对话的所有轮次"""
        db = SessionLocal()
        try:
            return (
                db.query(AgentTurn)
                .filter(AgentTurn.conversation_id == conversation_id)
                .order_by(AgentTurn.turn_number.asc())
                .all()
            )
        finally:
            db.close()

    def get_latest(self, conversation_id: str) -> Optional[AgentTurn]:
        """获取最新轮次"""
        db = SessionLocal()
        try:
            return (
                db.query(AgentTurn)
                .filter(AgentTurn.conversation_id == conversation_id)
                .order_by(AgentTurn.turn_number.desc())
                .first()
            )
        finally:
            db.close()

    def get_turn_count(self, conversation_id: str) -> int:
        """获取轮次数量"""
        db = SessionLocal()
        try:
            return (
                db.query(AgentTurn)
                .filter(AgentTurn.conversation_id == conversation_id)
                .count()
            )
        finally:
            db.close()

    def update(
        self,
        turn_id: str,
        total_iterations: int = None,
        model_used: str = None,
        tokens_used: int = None,
    ) -> Optional[AgentTurn]:
        """更新轮次执行信息"""
        db = SessionLocal()
        try:
            turn = db.query(AgentTurn).filter(AgentTurn.id == turn_id).first()
            if turn:
                if total_iterations is not None:
                    turn.total_iterations = total_iterations
                if model_used:
                    turn.model_used = model_used
                if tokens_used is not None:
                    turn.tokens_used = tokens_used
                db.commit()
                db.refresh(turn)
            return turn
        finally:
            db.close()

    def complete(
        self,
        turn_id: str,
        status: str = "completed",
        error_message: str = None,
        total_iterations: int = None,
        model_used: str = None,
        tokens_used: int = None,
    ) -> Optional[AgentTurn]:
        """完成轮次"""
        db = SessionLocal()
        try:
            turn = db.query(AgentTurn).filter(AgentTurn.id == turn_id).first()
            if turn:
                turn.status = status
                turn.error_message = error_message
                turn.completed_at = datetime.utcnow()
                if total_iterations is not None:
                    turn.total_iterations = total_iterations
                if model_used:
                    turn.model_used = model_used
                if tokens_used is not None:
                    turn.tokens_used = tokens_used
                db.commit()
                db.refresh(turn)
            return turn
        finally:
            db.close()

    def update_routing(
        self,
        turn_id: str,
        active_skill: str = None,
        skill_reason: str = None,
        routing_method: str = None,
    ) -> Optional[AgentTurn]:
        """更新轮次的 routing 信息"""
        db = SessionLocal()
        try:
            turn = db.query(AgentTurn).filter(AgentTurn.id == turn_id).first()
            if turn:
                if active_skill is not None:
                    turn.active_skill = active_skill
                if skill_reason is not None:
                    turn.skill_reason = skill_reason
                if routing_method is not None:
                    turn.routing_method = routing_method
                db.commit()
                db.refresh(turn)
            return turn
        finally:
            db.close()

    def delete_by_conversation(self, conversation_id: str) -> int:
        """删除对话的所有轮次"""
        db = SessionLocal()
        try:
            count = (
                db.query(AgentTurn)
                .filter(AgentTurn.conversation_id == conversation_id)
                .delete()
            )
            db.commit()
            return count
        finally:
            db.close()


__all__ = ["TurnRepository"]
