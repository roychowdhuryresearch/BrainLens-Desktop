"""
Skill Models

Core dataclasses shared by loader/router/runtime/orchestrator.
This file is intentionally UTF-8 clean to avoid comment/docstring mojibake.
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Any, List, Dict


@dataclass
class SkillPackage:
    """Parsed skill package from one skill directory."""

    name: str
    root_dir: Path
    skill_md_path: Path

    scripts_dir: Optional[Path] = None
    templates_dir: Optional[Path] = None
    assets_dir: Optional[Path] = None
    references_dir: Optional[Path] = None

    metadata: Dict[str, Any] = field(default_factory=dict)
    description: str = ""
    instructions: str = ""
    triggers: List[str] = field(default_factory=list)
    examples: List[str] = field(default_factory=list)
    allowed_tools: List[str] = field(default_factory=list)
    priority: int = 0

    workflow: List[str] = field(default_factory=list)
    output_format: Optional[str] = None
    when_to_use: Optional[str] = None
    do_not_use: Optional[str] = None

    tags: List[str] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)

    scripts: List[str] = field(default_factory=list)
    templates: List[str] = field(default_factory=list)
    references: List[str] = field(default_factory=list)

    author: Optional[str] = None
    version: Optional[str] = None
    category: Optional[str] = None

    def get_catalog_entry(self) -> Dict[str, Any]:
        """Compact record used by routing prompt."""
        return {
            "name": self.name,
            "description": self.description,
            "triggers": self.triggers,
            "when_to_use": self.when_to_use,
        }


@dataclass
class RoutingResult:
    """Result of routing decision produced by agent_runtime bootstrap."""

    selected_skill: Optional[SkillPackage] = None
    skill_name: Optional[str] = None
    confidence: float = 0.0
    reason: str = ""
    routing_method: str = "llm"
    candidates_count: int = 0
    error: Optional[str] = None

    # Multi-skill support
    candidate_skills: List["SkillPackage"] = field(default_factory=list)
    planned_order: List[str] = field(default_factory=list)
    # Intent-level routing (optional): each item {"intent": str, "skill_name": Optional[str], "reason": str}
    intent_plans: List[Dict[str, Any]] = field(default_factory=list)
    llm_calls: int = 0
    llm_duration_ms: float = 0.0
    llm_model_used: Optional[str] = None
    llm_usage: Dict[str, Any] = field(default_factory=dict)

    @property
    def has_skill(self) -> bool:
        return self.selected_skill is not None

    @property
    def has_candidates(self) -> bool:
        return len(self.candidate_skills) > 0

    @property
    def has_intent_plans(self) -> bool:
        return len(self.intent_plans) > 0

    @property
    def is_high_confidence(self) -> bool:
        return self.confidence >= 0.8

    @property
    def is_low_confidence(self) -> bool:
        return self.confidence < 0.3

    def get_ordered_skills(self) -> List["SkillPackage"]:
        """Return candidate skills ordered by planned_order when present."""
        if not self.planned_order or not self.candidate_skills:
            return self.candidate_skills

        skill_map = {s.name: s for s in self.candidate_skills}
        ordered = [skill_map[name] for name in self.planned_order if name in skill_map]
        ordered_names = {s.name for s in ordered}
        for skill in self.candidate_skills:
            if skill.name not in ordered_names:
                ordered.append(skill)
        return ordered


@dataclass
class SkillRuntimeContext:
    """Runtime context prepared from a selected skill."""

    skill: SkillPackage

    instructions: str = ""
    template_context: Optional[str] = None
    reference_snippets: List[str] = field(default_factory=list)

    filtered_tools: List[Dict] = field(default_factory=list)
    tool_filter_applied: bool = False

    routing_info: Optional[RoutingResult] = None
    load_time_ms: float = 0.0

    def build_skill_prompt(self) -> str:
        """Render this skill context into prompt text."""
        parts = [
            f"## Active Skill: {self.skill.name}",
            "",
            f"Description: {self.skill.description}",
        ]

        if self.skill.when_to_use:
            parts.extend(["", f"When to use: {self.skill.when_to_use}"])

        if self.instructions:
            parts.extend(["", "### Skill Instructions", self.instructions])

        if self.template_context:
            parts.extend(["", "### Template Context", self.template_context])

        if self.reference_snippets:
            parts.extend(["", "### References"])
            parts.extend(self.reference_snippets)

        if self.skill.output_format and not self.instructions:
            parts.extend(["", f"Output format: {self.skill.output_format}"])

        if self.skill.do_not_use and not self.instructions:
            parts.extend(["", f"Do not use: {self.skill.do_not_use}"])

        parts.extend(["", "Follow this skill scope strictly."])
        return "\n".join(parts)


@dataclass
class SkillCatalog:
    """Catalog of available skills for router prompts."""

    skills: List[SkillPackage]

    def to_routing_prompt(self) -> str:
        import json

        entries = [skill.get_catalog_entry() for skill in self.skills]
        return json.dumps(entries, ensure_ascii=False, indent=2)

    def get_by_name(self, name: str) -> Optional[SkillPackage]:
        for skill in self.skills:
            if skill.name == name:
                return skill
        return None


@dataclass
class ExecutionStep:
    """One executable step in a turn-level plan."""

    step_id: str
    skill_name: str
    goal: str
    instructions: str
    step_type: str = "skill"  # skill | general | synthesis
    target_intents: List[str] = field(default_factory=list)
    blocked_intents: List[str] = field(default_factory=list)
    allowed_tool_names: List[str] = field(default_factory=list)
    explicit_tool_selection: bool = False
    allow_all_tools: bool = False
    tools_disabled_by_user: bool = False
    done_when: str = ""
    output_schema: Optional[Dict[str, Any]] = None
    depends_on: List[str] = field(default_factory=list)
    is_final_step: bool = False


@dataclass
class RuntimeAction:
    """Runtime-owned action scratchpad item.

    This is the runtime-native representation used during execution.
    `ExecutionStep` remains as the compatibility view for prompts/logging/tests.
    """

    action_id: str
    skill_name: str
    goal: str
    instructions: str
    step_type: str = "skill"
    target_intents: List[str] = field(default_factory=list)
    blocked_intents: List[str] = field(default_factory=list)
    allowed_tool_names: List[str] = field(default_factory=list)
    explicit_tool_selection: bool = False
    allow_all_tools: bool = False
    tools_disabled_by_user: bool = False
    done_when: str = ""
    output_schema: Optional[Dict[str, Any]] = None
    depends_on: List[str] = field(default_factory=list)
    is_final_step: bool = False

    @classmethod
    def from_execution_step(cls, step: "ExecutionStep") -> "RuntimeAction":
        return cls(
            action_id=step.step_id,
            skill_name=step.skill_name,
            goal=step.goal,
            instructions=step.instructions,
            step_type=step.step_type,
            target_intents=list(step.target_intents or []),
            blocked_intents=list(step.blocked_intents or []),
            allowed_tool_names=list(step.allowed_tool_names or []),
            explicit_tool_selection=bool(step.explicit_tool_selection),
            allow_all_tools=bool(step.allow_all_tools),
            tools_disabled_by_user=bool(step.tools_disabled_by_user),
            done_when=step.done_when,
            output_schema=dict(step.output_schema) if isinstance(step.output_schema, dict) else None,
            depends_on=list(step.depends_on or []),
            is_final_step=bool(step.is_final_step),
        )

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "RuntimeAction":
        action_id = str(payload.get("action_id") or payload.get("step_id") or "").strip()
        return cls(
            action_id=action_id,
            skill_name=str(payload.get("skill_name") or "general_assistant").strip() or "general_assistant",
            goal=str(payload.get("goal") or "").strip(),
            instructions=str(payload.get("instructions") or "").strip(),
            step_type=str(payload.get("step_type") or "general").strip() or "general",
            target_intents=[
                str(intent).strip()
                for intent in (payload.get("target_intents") or [])
                if str(intent).strip()
            ],
            blocked_intents=[
                str(intent).strip()
                for intent in (payload.get("blocked_intents") or [])
                if str(intent).strip()
            ],
            allowed_tool_names=[
                str(name).strip()
                for name in (payload.get("allowed_tool_names") or [])
                if str(name).strip()
            ],
            explicit_tool_selection=bool(payload.get("explicit_tool_selection", False)),
            allow_all_tools=bool(payload.get("allow_all_tools", False)),
            tools_disabled_by_user=bool(payload.get("tools_disabled_by_user", False)),
            done_when=str(payload.get("done_when") or "").strip(),
            output_schema=(
                dict(payload.get("output_schema"))
                if isinstance(payload.get("output_schema"), dict)
                else None
            ),
            depends_on=[
                str(dep).strip()
                for dep in (payload.get("depends_on") or [])
                if str(dep).strip()
            ],
            is_final_step=bool(payload.get("is_final_step", False)),
        )

    def to_execution_step(self) -> "ExecutionStep":
        return ExecutionStep(
            step_id=self.action_id,
            skill_name=self.skill_name,
            goal=self.goal,
            instructions=self.instructions,
            step_type=self.step_type,
            target_intents=list(self.target_intents or []),
            blocked_intents=list(self.blocked_intents or []),
            allowed_tool_names=list(self.allowed_tool_names or []),
            explicit_tool_selection=bool(self.explicit_tool_selection),
            allow_all_tools=bool(self.allow_all_tools),
            tools_disabled_by_user=bool(self.tools_disabled_by_user),
            done_when=self.done_when,
            output_schema=dict(self.output_schema) if isinstance(self.output_schema, dict) else None,
            depends_on=list(self.depends_on or []),
            is_final_step=bool(self.is_final_step),
        )

    def to_dict(self) -> Dict[str, Any]:
        payload = {
            "action_id": self.action_id,
            "step_id": self.action_id,
            "skill_name": self.skill_name,
            "goal": self.goal,
            "instructions": self.instructions,
            "step_type": self.step_type,
            "target_intents": list(self.target_intents or []),
            "blocked_intents": list(self.blocked_intents or []),
            "allowed_tool_names": list(self.allowed_tool_names or []),
            "explicit_tool_selection": bool(self.explicit_tool_selection),
            "allow_all_tools": bool(self.allow_all_tools),
            "tools_disabled_by_user": bool(self.tools_disabled_by_user),
            "done_when": self.done_when,
            "depends_on": list(self.depends_on or []),
            "is_final_step": bool(self.is_final_step),
        }
        if self.output_schema is not None:
            payload["output_schema"] = dict(self.output_schema)
        return payload


@dataclass
class ExecutionPlan:
    """Plan generated from routing output."""

    user_goal: str
    routing_reason: str
    routing_method: Optional[str]
    steps: List[ExecutionStep] = field(default_factory=list)
    multi_skill_mode: bool = False
    planner_metrics: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RuntimeScratchpad:
    """Runtime-owned pending action list.

    This becomes the source of truth for execution sequencing. `ExecutionPlan`
    is synchronized from this scratchpad for compatibility.
    """

    actions: List[RuntimeAction] = field(default_factory=list)
    current_action_index: int = 0

    @classmethod
    def from_execution_plan(
        cls,
        plan: Optional["ExecutionPlan"],
        *,
        current_action_index: int = 0,
    ) -> "RuntimeScratchpad":
        scratchpad = cls(
            actions=[
                RuntimeAction.from_execution_step(step)
                for step in ((plan.steps or []) if plan else [])
            ],
            current_action_index=max(int(current_action_index or 0), 0),
        )
        scratchpad.normalize_final_flags()
        return scratchpad

    @classmethod
    def from_action_dicts(
        cls,
        actions: List[Dict[str, Any]],
        *,
        current_action_index: int = 0,
    ) -> "RuntimeScratchpad":
        parsed_actions = []
        for payload in actions or []:
            if not isinstance(payload, dict):
                continue
            action = RuntimeAction.from_dict(payload)
            if action.action_id:
                parsed_actions.append(action)
        scratchpad = cls(
            actions=parsed_actions,
            current_action_index=max(int(current_action_index or 0), 0),
        )
        scratchpad.normalize_final_flags()
        return scratchpad

    def normalize_final_flags(self) -> None:
        for action in self.actions:
            action.is_final_step = False
        if self.actions:
            self.actions[-1].is_final_step = True

    def total_steps(self) -> int:
        return len(self.actions)

    def get_step(self, index: int) -> Optional["ExecutionStep"]:
        if index < 0 or index >= len(self.actions):
            return None
        return self.actions[index].to_execution_step()

    def remaining_steps_from(self, index: int) -> List["ExecutionStep"]:
        start = max(int(index or 0), 0)
        return [action.to_execution_step() for action in self.actions[start:]]

    def serialize_from(self, index: int) -> List[Dict[str, Any]]:
        start = max(int(index or 0), 0)
        return [action.to_dict() for action in self.actions[start:]]

    def set_steps(self, steps: List["ExecutionStep"]) -> None:
        self.actions = [RuntimeAction.from_execution_step(step) for step in (steps or [])]
        self.normalize_final_flags()

    def apply_adjustment(
        self,
        *,
        step_index: int,
        inserted_steps: List["ExecutionStep"],
        replace_remaining: bool,
    ) -> None:
        insertion_index = max(int(step_index or 0), 0) + 1
        if replace_remaining:
            self.actions = self.actions[:insertion_index]
        if inserted_steps:
            self.actions[insertion_index:insertion_index] = [
                RuntimeAction.from_execution_step(step)
                for step in inserted_steps
            ]
        self.normalize_final_flags()

    def to_execution_steps(self) -> List["ExecutionStep"]:
        return [action.to_execution_step() for action in self.actions]


@dataclass
class StepResult:
    """Structured output from one step execution."""

    step_id: str
    skill_name: str
    success: bool
    summary: str
    output: Dict[str, Any] = field(default_factory=dict)
    raw_text: str = ""
    sources: List[Dict] = field(default_factory=list)
    tool_calls_count: int = 0


@dataclass
class ExecutionState:
    """Mutable orchestrator state during one turn."""

    conversation_id: str
    current_turn_id: Optional[str]
    plan: ExecutionPlan
    request_id: Optional[str] = None
    # Preallocated assistant message identity.  The same value is placed in the
    # research output, durable message row, and terminal done envelope.
    message_id: Optional[str] = None
    # Revision of the loaded recording/workspace state observed for this turn.
    state_revision: Optional[str] = None
    user_id: Optional[str] = None  # 用户ID，用于用户输入请求隔离
    user_role: Optional[str] = None  # 用户角色，用于工具层权限控制
    current_step_index: int = 0
    total_iterations: int = 0
    available_skill_packages: Dict[str, SkillPackage] = field(default_factory=dict)
    durable_memory_context: Optional[Any] = None
    response_tone: Dict[str, Any] = field(default_factory=dict)
    response_mode: str = "default"
    response_language: Optional[str] = None
    # Bound turn input.  The raw path is never rendered into public output; its
    # presence only helps decide whether case-specific evidence is mandatory.
    recording_path: Optional[str] = None
    shared_memory: Dict[str, Any] = field(default_factory=dict)
    open_goals: List[str] = field(default_factory=list)
    pending_user_input: Optional[Dict[str, Any]] = None
    last_active_skill_name: Optional[str] = None
    step_results: Dict[str, StepResult] = field(default_factory=dict)
    all_sources: List[Dict] = field(default_factory=list)
    skills_executed: List[str] = field(default_factory=list)
    runtime_scratchpad: RuntimeScratchpad = field(default_factory=RuntimeScratchpad)
    # 统计本 turn 内 agent_control 介入次数（非 step_output 的 PlanAdjustment）。
    # 用于 _should_skip_post_step_replanning 的硬上限，避免"再加一步"死循环。
    agent_control_interventions: int = 0
    # Accumulator for UI commands emitted through the ieeg_ui MCP connector this turn.
    ui_commands: List[Dict[str, Any]] = field(default_factory=list)
    # Canonical structured research output is attached only after the clinical
    # evidence validator accepts every claim/provenance invariant.  Keeping it
    # on state lets final persistence and the public stream share one verdict.
    research_output: Optional[Dict[str, Any]] = None
    # Review receipts may be supplied by an authorized adapter.  Empty is the
    # safe default: reviewed/confirmed claims then fail closed.
    action_receipts: List[Dict[str, Any]] = field(default_factory=list)
    # Trusted, turn-local results captured only from exact built-in evidence
    # tools.  Raw values stay internal and are used to prove public claims.
    research_evidence_ledger: List[Dict[str, Any]] = field(default_factory=list)
    # Raw final-answer text that was already streamed to the client live (token by
    # token). Lets the final emitter skip re-sending the body and emit only the
    # un-streamed tail (e.g. an appended advisory disclaimer). "" = nothing streamed.
    streamed_answer: str = ""

    def __post_init__(self) -> None:
        if self.runtime_scratchpad.actions:
            self.runtime_scratchpad.current_action_index = max(int(self.current_step_index or 0), 0)
            self.runtime_scratchpad.normalize_final_flags()
        else:
            self.runtime_scratchpad = RuntimeScratchpad.from_execution_plan(
                self.plan,
                current_action_index=self.current_step_index,
            )
        self.sync_plan_from_runtime()

    def sync_plan_from_runtime(self) -> None:
        self.runtime_scratchpad.current_action_index = max(int(self.current_step_index or 0), 0)
        self.plan.multi_skill_mode = self.runtime_multi_skill_mode()

    def set_current_step_index(self, index: int) -> None:
        self.current_step_index = max(int(index or 0), 0)
        self.runtime_scratchpad.current_action_index = self.current_step_index

    def runtime_steps(self) -> List[ExecutionStep]:
        return self.runtime_scratchpad.to_execution_steps()

    def total_runtime_steps(self) -> int:
        return self.runtime_scratchpad.total_steps()

    def get_runtime_step(self, index: int) -> Optional[ExecutionStep]:
        return self.runtime_scratchpad.get_step(index)

    def remaining_runtime_steps(self, start_index: int) -> List[ExecutionStep]:
        return self.runtime_scratchpad.remaining_steps_from(start_index)

    def serialize_pending_runtime_actions(self, start_index: int) -> List[Dict[str, Any]]:
        return self.runtime_scratchpad.serialize_from(start_index)

    def runtime_multi_skill_mode(self) -> bool:
        return self.total_runtime_steps() > 1

    def get_last_runtime_step(self) -> Optional[ExecutionStep]:
        if self.total_runtime_steps() <= 0:
            return None
        return self.get_runtime_step(self.total_runtime_steps() - 1)

    def count_runtime_steps_with_prefix(self, prefix: str) -> int:
        normalized_prefix = str(prefix or "")
        if not normalized_prefix:
            return 0
        return sum(
            1
            for action in self.runtime_scratchpad.actions
            if str(action.action_id).startswith(normalized_prefix)
        )

    def plan_view(self) -> ExecutionPlan:
        return ExecutionPlan(
            user_goal=self.plan.user_goal,
            routing_reason=self.plan.routing_reason,
            routing_method=self.plan.routing_method,
            steps=self.runtime_steps(),
            multi_skill_mode=self.runtime_multi_skill_mode(),
            planner_metrics=dict(self.plan.planner_metrics or {}),
        )

    def set_runtime_steps(self, steps: List[ExecutionStep]) -> None:
        self.runtime_scratchpad.set_steps(steps)
        self.sync_plan_from_runtime()

    def apply_runtime_plan_adjustment(
        self,
        *,
        step_index: int,
        inserted_steps: List[ExecutionStep],
        replace_remaining: bool,
    ) -> None:
        self.runtime_scratchpad.apply_adjustment(
            step_index=step_index,
            inserted_steps=inserted_steps,
            replace_remaining=replace_remaining,
        )
        self.sync_plan_from_runtime()
