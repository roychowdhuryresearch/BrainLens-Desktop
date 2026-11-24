"""
Context models used by context assembly and summarization.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ContextPack:
    """Prepared context bundle for one model request."""

    messages_for_model: List[Dict]
    used_summary: bool = False
    summary_text: Optional[str] = None
    dropped_messages: int = 0
    removed_noise_count: int = 0
    token_estimate: int = 0
    summary_metrics: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ConversationContextState:
    """Persisted rolling summary state for one conversation."""

    conversation_id: str
    rolling_summary: str = ""
    last_summary_turn: int = 0
    total_turns: int = 0


@dataclass
class ContextConfig:
    """Configuration for context trimming and summary refresh."""

    max_context_tokens: int = 12000
    recent_keep_turns: int = 6
    enable_context_summary: bool = True
    enable_noise_filter: bool = True
    summarizer_temperature: float = 0.3

    @property
    def summary_trigger_turns(self) -> int:
        return self.recent_keep_turns + 2

    @property
    def summary_trigger_tokens(self) -> int:
        return int(self.max_context_tokens * 0.75)

    @property
    def summary_trigger_msg_count(self) -> int:
        return self.summary_trigger_turns * 2

    @property
    def summary_refresh_every_turns(self) -> int:
        return self.recent_keep_turns + 2

    _legacy_summary_trigger_msg_count: Optional[int] = None
    _legacy_summary_trigger_tokens: Optional[int] = None
    _legacy_summary_refresh_every_turns: Optional[int] = None


@dataclass
class SummaryResult:
    """Structured summary output plus telemetry."""

    conversation_goal: str = ""
    important_facts: List[str] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    decisions_made: List[str] = field(default_factory=list)
    open_questions: List[str] = field(default_factory=list)
    current_focus: str = ""
    raw_text: str = ""
    llm_calls: int = 0
    llm_duration_ms: float = 0.0
    model_used: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def to_summary_text(self) -> str:
        parts: List[str] = []

        if self.conversation_goal:
            parts.append(f"[Conversation Goal] {self.conversation_goal}")
        if self.important_facts:
            parts.append(f"[Important Facts] {'; '.join(self.important_facts)}")
        if self.constraints:
            parts.append(f"[Constraints] {'; '.join(self.constraints)}")
        if self.decisions_made:
            parts.append(f"[Decisions] {'; '.join(self.decisions_made)}")
        if self.open_questions:
            parts.append(f"[Open Questions] {'; '.join(self.open_questions)}")
        if self.current_focus:
            parts.append(f"[Current Focus] {self.current_focus}")

        return "\n".join(parts) if parts else self.raw_text
