from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


CONVERSATION_RUNTIME_STATE_KEY = "runtime_conversation_state"


@dataclass
class ConversationRuntimeState:
    """Persisted conversation-scoped runtime state."""

    conversation_id: str
    turn_count: int = 0
    last_user_goal: str = ""
    last_final_answer: str = ""
    open_goals: List[str] = field(default_factory=list)
    shared_memory: Dict[str, Any] = field(default_factory=dict)
    pending_actions: List[Dict[str, Any]] = field(default_factory=list)
    active_plan_steps: List[Dict[str, Any]] = field(default_factory=list)
    pending_user_input: Optional[Dict[str, Any]] = None
    last_active_skill_name: Optional[str] = None
    skills_executed: List[str] = field(default_factory=list)

    def current_pending_actions(self) -> List[Dict[str, Any]]:
        return list(self.pending_actions or self.active_plan_steps or [])

    def to_dict(self) -> Dict[str, Any]:
        pending_actions = self.current_pending_actions()
        return {
            "turn_count": int(self.turn_count or 0),
            "last_user_goal": self.last_user_goal or "",
            "last_final_answer": self.last_final_answer or "",
            "open_goals": list(self.open_goals or []),
            "shared_memory": dict(self.shared_memory or {}),
            "pending_actions": pending_actions,
            "active_plan_steps": pending_actions,
            "pending_user_input": dict(self.pending_user_input) if isinstance(self.pending_user_input, dict) else None,
            "last_active_skill_name": self.last_active_skill_name,
            "skills_executed": list(self.skills_executed or []),
        }

    @classmethod
    def from_dict(
        cls,
        conversation_id: str,
        payload: Optional[Dict[str, Any]],
    ) -> "ConversationRuntimeState":
        payload = payload or {}
        pending_actions = [
            dict(step)
            for step in (payload.get("pending_actions") or payload.get("active_plan_steps") or [])
            if isinstance(step, dict)
        ]
        return cls(
            conversation_id=conversation_id,
            turn_count=int(payload.get("turn_count") or 0),
            last_user_goal=str(payload.get("last_user_goal") or ""),
            last_final_answer=str(payload.get("last_final_answer") or ""),
            open_goals=[
                str(goal).strip()
                for goal in (payload.get("open_goals") or [])
                if str(goal).strip()
            ],
            shared_memory=dict(payload.get("shared_memory") or {}),
            pending_actions=list(pending_actions),
            active_plan_steps=list(pending_actions),
            pending_user_input=(
                dict(payload.get("pending_user_input"))
                if isinstance(payload.get("pending_user_input"), dict)
                else None
            ),
            last_active_skill_name=(
                str(payload.get("last_active_skill_name")).strip()
                if payload.get("last_active_skill_name")
                else None
            ),
            skills_executed=[
                str(skill).strip()
                for skill in (payload.get("skills_executed") or [])
                if str(skill).strip()
            ],
        )
