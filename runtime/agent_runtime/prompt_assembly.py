import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from runtime.agent_runtime.mcp_prompt_guides import build_mcp_capability_section
from runtime.agent_runtime.hitl_memory import extract_session_defaults, is_session_defaults_payload
from runtime.agent_runtime.clinical_evidence import requires_research_output
from runtime.agent_runtime.completion_contract import (
    is_research_output_completion_schema,
    research_output_completion_schema,
    research_output_contract_example,
    validate_step_output,
)
from runtime.context.models import ContextPack
from runtime.prompts import render_prompt, render_prompt_file
from runtime.redaction import redact_observability_payload
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, SkillRuntimeContext, StepResult

logger = logging.getLogger(__name__)

VOICE_RESPONSE_MODE = "voice"


class PromptAssemblyService:
    def __init__(self, *, prompt_file: Optional[Path] = None) -> None:
        self.prompt_file = prompt_file or (
            Path(__file__).resolve().parents[1] / "prompts" / "system_prompt.md"
        )

    def load_prompt_template(self) -> str:
        try:
            template = render_prompt_file(self.prompt_file, current_date="")
            logger.info("[Agent] Loaded system prompt template from %s", self.prompt_file)
            return template
        except FileNotFoundError:
            logger.warning("[Agent] Prompt file not found: %s, using default template", self.prompt_file)
            default_template = """You are an agent.

You can use these tools:
{tools_text}

Your responsibilities:
1. Understand the user's question.
2. Use appropriate tools to obtain information when needed.
3. Answer based on tool results.
4. If no relevant information is found, say so honestly.
5. Be accurate, concise, and well-structured.

Notes:
- Choose tools according to the user's question.
- Do not fabricate information; answer only from actual tool results.
- Keep an objective and neutral tone.
- Cite information sources at the end when applicable."""
            return default_template

    def bind_step_output_contract(
        self,
        *,
        current_step: ExecutionStep,
        execution_state: ExecutionState,
        user_message: str,
    ) -> bool:
        """Bind canonical research JSON only when this turn can reach a case result.

        Missing-input replies remain ordinary prose.  A loaded recording,
        already-executed case step, or emitted clinical command provides the
        material needed for a case workflow; the shared clinical classifier
        keeps this decision aligned with finalization.
        """

        if not current_step.is_final_step:
            return False
        has_case_material = bool(
            str(getattr(execution_state, "recording_path", "") or "").strip()
            or getattr(execution_state, "ui_commands", None)
            or getattr(execution_state, "action_receipts", None)
            or getattr(execution_state, "research_evidence_ledger", None)
        )
        if not has_case_material:
            return False
        if not requires_research_output(
            user_question=user_message,
            final_content="A grounded case-specific research result is ready.",
            state=execution_state,
        ):
            return False
        if not is_research_output_completion_schema(current_step.output_schema):
            current_step.output_schema = research_output_completion_schema()
        return True

    @staticmethod
    def _research_output_prompt_example(execution_state: ExecutionState) -> str:
        example = research_output_contract_example()
        trusted_scope: Dict[str, Any] = {}
        trusted_attestation: Dict[str, Any] = {}
        for entry in reversed(getattr(execution_state, "research_evidence_ledger", None) or []):
            result = entry.get("result") if isinstance(entry, dict) else None
            provenance = entry.get("execution_provenance") if isinstance(entry, dict) else None
            if not isinstance(provenance, dict):
                provenance = result.get("execution_provenance") if isinstance(result, dict) else None
            if not isinstance(provenance, dict):
                continue
            if not trusted_attestation:
                trusted_attestation = dict(provenance)
            for key in ("recording_fingerprint", "state_revision", "run_ids"):
                if key not in trusted_scope and provenance.get(key) not in (None, "", []):
                    trusted_scope[key] = provenance[key]
        bound_scope = {
            "request_id": getattr(execution_state, "request_id", None),
            "conversation_id": getattr(execution_state, "conversation_id", None),
            "message_id": getattr(execution_state, "message_id", None)
            or getattr(execution_state, "current_turn_id", None),
            "state_revision": getattr(execution_state, "state_revision", None)
            or trusted_scope.get("state_revision"),
            "response_language": getattr(execution_state, "response_language", None),
        }
        for key, value in bound_scope.items():
            normalized = str(value or "").strip()
            if normalized:
                example[key] = normalized
        if trusted_scope.get("recording_fingerprint"):
            example["recording_fingerprint"] = trusted_scope["recording_fingerprint"]
            if isinstance(example.get("provenance"), dict) and isinstance(
                example["provenance"].get("recording"), dict
            ):
                example["provenance"]["recording"]["sha256"] = trusted_scope["recording_fingerprint"]
        if isinstance(example.get("provenance"), dict) and trusted_attestation:
            output_provenance = example["provenance"]
            for output_key, attestation_key in (
                ("software_version", "software_version"),
                ("algorithm", "algorithm"),
                ("algorithm_version", "algorithm_version"),
                ("parameters", "effective_parameters"),
                ("parameters_sha256", "parameters_sha256"),
                ("software_components", "software_components"),
            ):
                if trusted_attestation.get(attestation_key) not in (None, "", []):
                    output_provenance[output_key] = trusted_attestation[attestation_key]
            recording_metadata = trusted_attestation.get("recording_metadata")
            if isinstance(recording_metadata, dict):
                output_provenance.setdefault("recording", {}).update(recording_metadata)
            artifacts = trusted_attestation.get("artifacts")
            if isinstance(artifacts, list):
                example["artifacts"] = artifacts
        if isinstance(trusted_scope.get("run_ids"), list) and trusted_scope["run_ids"]:
            example["run_ids"] = list(trusted_scope["run_ids"])
            for claim in example.get("claims", []):
                if isinstance(claim, dict):
                    claim["run_ids"] = list(trusted_scope["run_ids"])
            for evidence in example.get("evidence", []):
                if isinstance(evidence, dict):
                    evidence["run_id"] = trusted_scope["run_ids"][0]
            if isinstance(example.get("provenance"), dict) and isinstance(
                example["provenance"].get("run_scope"), dict
            ):
                example["provenance"]["run_scope"]["run_ids"] = list(trusted_scope["run_ids"])
                if len(trusted_scope["run_ids"]) > 1:
                    example["provenance"]["run_scope"].update(
                        {"mode": "explicit_multi_run", "aggregation_method": "explicit-side-by-side"}
                    )
                    if isinstance(example.get("guardrails"), dict):
                        example["guardrails"]["aggregation_scope"] = "explicit_multi_run"
        return json.dumps(example, ensure_ascii=False, indent=2)

    @staticmethod
    def _research_execution_scope(execution_state: ExecutionState) -> str:
        records = []
        for entry in (getattr(execution_state, "research_evidence_ledger", None) or [])[-16:]:
            if not isinstance(entry, dict):
                continue
            result = entry.get("result") if isinstance(entry.get("result"), dict) else {}
            execution_provenance = entry.get("execution_provenance")
            if not isinstance(execution_provenance, dict):
                execution_provenance = result.get("execution_provenance")
            records.append(
                {
                    "tool_name": entry.get("tool_name"),
                    "execution_provenance": execution_provenance,
                    "result_summary": entry.get("result_summary"),
                }
            )
        return json.dumps(
            redact_observability_payload(records),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )

    def build_tools_section(self, tools: Optional[List[Dict]] = None) -> str:
        tools = tools or []
        tool_descriptions = []
        for tool in tools:
            func = tool.get("function", {})
            name = func.get("name", "")
            desc = func.get("description", "")
            tool_descriptions.append(f"- **{name}**: {desc}")

        if not tool_descriptions:
            return ""

        tools_text = "\n".join(tool_descriptions)
        return render_prompt("runtime/tools_section.md", tools_text=tools_text)

    def clean_step_summary_for_system(self, text: str, max_len: int = 220) -> str:
        if not text:
            return ""

        stop_keywords = (
            "structured handoff result",
            "handoffpayload",
            "handoff to the next step",
            "step_completed",
            "all tasks complete",
            "task summary",
        )
        cleaned_lines: List[str] = []
        in_code_block = False

        for raw_line in text.splitlines():
            line = raw_line.strip()
            if line.startswith("```"):
                in_code_block = not in_code_block
                continue
            if in_code_block:
                continue
            if not line or line in {"---", "***", "___"}:
                continue

            lowered = line.lower()
            if any(keyword in lowered for keyword in stop_keywords):
                break

            line = line.lstrip("#").strip()
            line = re.sub(r"^[-*]\s+", "", line)
            if re.match(r"^\|.*\|$", line):
                continue
            if not line:
                continue

            cleaned_lines.append(line)
            if len(" ".join(cleaned_lines)) >= max_len:
                break

        summary = re.sub(r"\s+", " ", " ".join(cleaned_lines)).strip()
        if not summary:
            summary = re.sub(r"\s+", " ", text).strip()
        if len(summary) > max_len:
            summary = summary[: max_len - 1].rstrip() + "…"
        return summary

    def build_constraints_section(
        self,
        *,
        skill_context: Optional[SkillRuntimeContext] = None,
        knowledge_base_id: Optional[str] = None,
        execution_plan: Optional[ExecutionPlan] = None,
        current_step: Optional[ExecutionStep] = None,
        execution_state: Optional[ExecutionState] = None,
    ) -> str:
        constraints = ["## Execution constraints", ""]

        plan_steps = []
        multi_skill_mode = False
        user_goal = ""
        if execution_state:
            plan_steps = execution_state.runtime_steps()
            multi_skill_mode = execution_state.runtime_multi_skill_mode()
            user_goal = execution_state.plan.user_goal
        elif execution_plan and execution_plan.steps:
            plan_steps = list(execution_plan.steps)
            multi_skill_mode = bool(execution_plan.multi_skill_mode)
            user_goal = execution_plan.user_goal

        if plan_steps:
            constraints.extend(
                [
                    f"- Task mode: {'multi-step' if multi_skill_mode else 'single-step'}",
                    f"- Global goal: {user_goal}",
                    f"- Total steps: {len(plan_steps)}",
                    "",
                    "### Global plan",
                ]
            )
            for index, step in enumerate(plan_steps, start=1):
                suffix = " (final step)" if step.is_final_step else ""
                constraints.append(f"{index}. {step.skill_name}: {step.goal}{suffix}")

        if current_step:
            constraints.extend(
                [
                    "",
                    "### Current step",
                    f"- step_id: {current_step.step_id}",
                    f"- skill: {current_step.skill_name}",
                    f"- step_type: {current_step.step_type}",
                    f"- goal: {current_step.goal}",
                    f"- done_when: {current_step.done_when or 'Complete the current step goal and produce handoff-ready output.'}",
                ]
            )
            if current_step.target_intents:
                constraints.append(f"- Current target intents: {'; '.join(current_step.target_intents)}")
            if current_step.instructions:
                constraints.append(f"- instructions: {current_step.instructions}")

            if current_step.is_final_step:
                constraints.extend(
                    [
                        "",
                        "You are now on the final step. You may produce the final user-facing answer based on previous step results.",
                    ]
                )
            else:
                constraints.extend(
                    [
                        "",
                        "You are executing an intermediate step in a multi-step plan, not the final-answer stage.",
                        "Requirements:",
                        "1. Complete the current step goal.",
                        "2. Do not directly answer the entire user request.",
                    ]
                )

        if execution_state and execution_state.step_results:
            completed_step_lines: List[str] = []
            for step_id, step_result in execution_state.step_results.items():
                if not self._step_result_has_synthesis_evidence(step_result):
                    continue
                cleaned_summary = self.clean_step_summary_for_system(
                    step_result.summary or step_result.raw_text,
                    max_len=180,
                )
                if cleaned_summary:
                    completed_step_lines.append(f"- {step_id}/{step_result.skill_name}: {cleaned_summary}")
            if completed_step_lines:
                constraints.extend(["", "### Completed step summaries", *completed_step_lines])

        if execution_state and execution_state.open_goals:
            constraints.extend(["", "### Cross-turn open goals"])
            for goal in execution_state.open_goals[:6]:
                constraints.append(f"- {goal}")

        if execution_state:
            contract_scope = [
                ("request_id", getattr(execution_state, "request_id", None)),
                ("conversation_id", getattr(execution_state, "conversation_id", None)),
                ("message_id", getattr(execution_state, "message_id", None)),
                ("state_revision", getattr(execution_state, "state_revision", None)),
                ("response_language", getattr(execution_state, "response_language", None)),
            ]
            scoped_values = [
                (key, str(value).strip())
                for key, value in contract_scope
                if str(value or "").strip()
            ]
            if scoped_values:
                constraints.extend(["", "### Active output contract scope"])
                constraints.extend(f"- {key}: {value}" for key, value in scoped_values)
                constraints.append(
                    "- If you produce research-output.v1, copy these scope values exactly; do not invent replacements."
                )

        if (
            current_step
            and execution_state
            and is_research_output_completion_schema(current_step.output_schema)
        ):
            execution_scope = self._research_execution_scope(execution_state)
            constraints.extend(
                [
                    "",
                    "### Required canonical research output",
                    "- Return exactly one JSON object conforming to research-output.v1; do not wrap it in Markdown or add prose.",
                    "- Copy the active request_id, conversation_id, message_id, and response_language exactly when they are provided above.",
                    "- Use only recording fingerprints, run IDs, claims, evidence, parameters, and provenance grounded in trusted tool results or completed-step handoffs.",
                    "- Never fabricate missing evidence. Use an available tool or request the missing input before claiming a case result.",
                    "- Detector results remain candidates; QC is not diagnosis; channel labels do not establish anatomy or SOZ.",
                    "- Use execution_provenance run_ids, source recording fingerprint, state revision, algorithm/version, effective parameters, software components, recording metadata, and artifacts exactly; these fields are adapter-owned.",
                    f"- Trusted execution scope (adapter-owned, redacted): {execution_scope}",
                    "- The JSON below is a shape-only example. Do not copy its illustrative recording, run, channel, parameter, evidence, or claim values.",
                    "```json",
                    self._research_output_prompt_example(execution_state),
                    "```",
                ]
            )

        if execution_state and execution_state.pending_user_input:
            pending_prompt = str(execution_state.pending_user_input.get("prompt") or "").strip()
            if pending_prompt:
                constraints.extend(
                    [
                        "",
                        "### User input pending from previous turn",
                        f"- prompt: {pending_prompt}",
                    ]
                )
                input_type = str(execution_state.pending_user_input.get("input_type") or "").strip()
                if input_type:
                    constraints.append(f"- input_type: {input_type}")
                options = execution_state.pending_user_input.get("options") or []
                if options:
                    constraints.append(f"- options: {'; '.join(str(option) for option in options)}")
                memory_writeback = execution_state.pending_user_input.get("memory_writeback")
                if isinstance(memory_writeback, dict):
                    scope_options = memory_writeback.get("scope_options") or []
                    if scope_options:
                        constraints.append(
                            f"- memory_scope_options: {'; '.join(str(item) for item in scope_options if str(item).strip())}"
                        )

        if execution_state:
            session_defaults = extract_session_defaults(execution_state.shared_memory)
            if session_defaults:
                constraints.extend(["", "### Session-confirmed defaults"])
                for item in session_defaults[:6]:
                    title = str(item.get("title") or item.get("key") or "session_default").strip()
                    summary = str(item.get("summary") or "").strip()
                    constraints.append(f"- {title}: {summary}")

        if execution_state and execution_state.last_active_skill_name:
            constraints.extend(["", f"- Most recently active skill: {execution_state.last_active_skill_name}"])

        response_tone = getattr(execution_state, "response_tone", None) if execution_state else None
        if current_step and isinstance(response_tone, dict) and response_tone.get("tone"):
            tone = str(response_tone.get("tone") or "").strip()
            style_notes = str(response_tone.get("style_notes") or "").strip()
            constraints.extend(["", "### Response tone for this turn"])
            if current_step.is_final_step:
                constraints.append(f"- tone: {tone}")
                if tone == "serious_grounded":
                    constraints.append("- Final response should be steady, precise, and clear; reassuring but not playful or joke-like. Do not use emoji.")
                elif tone == "bright_positive":
                    constraints.append("- Final response should be brighter, positive, and encouraging; at most one light, restrained flourish or one emoji if appropriate. Do not be cute, oily, or distract from the conclusion.")
                else:
                    constraints.append("- Final response should be natural, positive, optimistic, and progress-oriented; avoid stiffness, bureaucracy, or over-performed personality.")
                if style_notes:
                    constraints.append(f"- Style notes: {style_notes}")
            else:
                constraints.append("- Current step is intermediate: stay neutral, structured, and handoff-ready; do not add stylistic flourishes.")

        response_mode = str(getattr(execution_state, "response_mode", "") or "").strip().lower() if execution_state else ""
        response_language = str(
            getattr(execution_state, "response_language", "") or ""
        ).strip() if execution_state else ""
        if current_step and current_step.is_final_step and response_language in {"en-US", "zh-CN"}:
            language_name = "English" if response_language == "en-US" else "Simplified Chinese"
            constraints.extend(
                [
                    "",
                    "### Contract response language",
                    f"- Required final response language: {language_name} ({response_language}).",
                    "- This explicit transport requirement overrides automatic message-language matching.",
                    "- Preserve identifiers and standard technical abbreviations, but do not mix narrative languages.",
                ]
            )
        if current_step and current_step.is_final_step and response_mode == VOICE_RESPONSE_MODE:
            constraints.extend(
                [
                    "",
                    "### Strict response constraints",
                    "- The current request is intended for real-time voice playback.",
                    "- The final answer must be concise, natural, and suitable to speak aloud.",
                    "- If answering in Chinese, prefer 1-3 sentences, about 80-120 Chinese characters.",
                    "- State the conclusion first. Avoid Markdown tables, code blocks, long lists, and source piles.",
                    "- If there are many details, say only the key conclusion and leave the rest for screen display.",
                ]
            )

        durable_memory_context = getattr(execution_state, "durable_memory_context", None) if execution_state else None
        if durable_memory_context and hasattr(durable_memory_context, "to_system_prompt_text"):
            durable_memory_text = durable_memory_context.to_system_prompt_text()
            if durable_memory_text:
                constraints.extend(["", durable_memory_text])

        if skill_context:
            skill = skill_context.skill
            constraints.extend(
                [
                    "",
                    "### Active Skill execution requirements",
                    "",
                    f"- **Prioritize the workflow of the active Skill ({skill.name}).**",
                    "- Follow the Skill-defined output_format.",
                    "- If the user request is unrelated to the active Skill, answer normally and do not force the Skill.",
                ]
            )

        if knowledge_base_id:
            constraints.extend(
                [
                    "",
                    "### Context setting",
                    "",
                    f"The user-selected content source ID is: {knowledge_base_id}. Prefer this source when searching.",
                ]
            )

        return "\n".join(constraints)

    def build_system_prompt(
        self,
        *,
        knowledge_base_id: Optional[str] = None,
        tools: Optional[List[Dict]] = None,
        skill_context: Optional[SkillRuntimeContext] = None,
        execution_plan: Optional[ExecutionPlan] = None,
        current_step: Optional[ExecutionStep] = None,
        execution_state: Optional[ExecutionState] = None,
    ) -> str:
        current_date = datetime.now().strftime("%Y-%m-%d")
        section_1 = render_prompt_file(self.prompt_file, current_date=current_date)
        section_2 = self.build_constraints_section(
            skill_context=skill_context,
            knowledge_base_id=knowledge_base_id,
            execution_plan=execution_plan,
            current_step=current_step,
            execution_state=execution_state,
        )
        section_3 = ""
        if skill_context:
            section_3 = skill_context.build_skill_prompt()
            logger.info("[Agent] Injected active skill: %s", skill_context.skill.name)
        section_4 = self.build_tools_section(tools)
        section_5 = build_mcp_capability_section(tools or [])
        return "\n\n".join(
            [part for part in (section_1, section_2, section_3, section_4, section_5) if part and part.strip()]
        )

    def render_shared_memory_for_prompt(
        self,
        state: ExecutionState,
        current_step: ExecutionStep,
    ) -> List[Dict[str, Any]]:
        del current_step
        payloads: List[Dict[str, Any]] = []
        seen_step_ids = set()
        for step_id, step_result in state.step_results.items():
            payload = state.shared_memory.get(step_id) or {
                "from_step_id": step_id,
                "from_skill": step_result.skill_name,
                "summary": step_result.summary,
                "output": step_result.output,
                "sources_count": len(step_result.sources),
            }
            payloads.append(payload)
            seen_step_ids.add(str(step_id))

        for step_id, payload in state.shared_memory.items():
            normalized_step_id = str(step_id)
            if normalized_step_id in seen_step_ids:
                continue
            if isinstance(payload, dict):
                if is_session_defaults_payload(payload):
                    continue
                payloads.append(payload)
        return payloads

    def build_step_scoped_user_message(self, current_step: ExecutionStep, user_message: str) -> str:
        if not current_step.target_intents:
            return user_message

        blocked_line = ""
        if current_step.blocked_intents:
            blocked_line = f"Do not answer in the current step: {'; '.join(current_step.blocked_intents)}"
        final_step_line = ""
        if current_step.step_type == "synthesis":
            final_step_line = "This is the final synthesis step: cover all subtasks and preserve each completed step result as completely as possible."
        return render_prompt(
            "runtime/step_scope_message.md",
            user_message=user_message,
            current_intents="; ".join(current_step.target_intents),
            blocked_line=blocked_line,
            final_step_line=final_step_line,
        ).strip()

    def build_step_model_messages(
        self,
        *,
        system_prompt: str,
        base_context_pack: Optional[ContextPack],
        history: List[Dict],
        state: ExecutionState,
        current_step: ExecutionStep,
        user_message: str,
    ) -> List[Dict]:
        messages = [{"role": "system", "content": system_prompt}]
        if base_context_pack and hasattr(base_context_pack, "messages_for_model"):
            messages.extend(base_context_pack.messages_for_model)
        else:
            messages.extend(history[-10:])

        normalized_user_message = (user_message or "").strip()
        has_user_message = any(
            message.get("role") == "user"
            and str(message.get("content", "")).strip() == normalized_user_message
            for message in messages
        )
        if normalized_user_message and not has_user_message:
            messages.append({"role": "user", "content": user_message})

        handoff_payloads = self.render_shared_memory_for_prompt(state, current_step)
        for payload in handoff_payloads:
            from_step_id = str(payload.get("from_step_id", "unknown"))
            from_skill = str(payload.get("from_skill", "unknown")).replace("-", "_")
            messages.append(
                {
                    "role": "assistant",
                    "name": f"handoff_{from_step_id}_{from_skill}",
                    "content": "HandoffPayload:\n" + json.dumps(payload, ensure_ascii=False),
                }
            )

        step_name = (current_step.skill_name or "step").replace("-", "_")
        messages.append(
            {
                "role": "assistant",
                "name": f"plan_hint_{current_step.step_id}_{step_name}",
                "content": self.build_step_scoped_user_message(current_step, user_message),
            }
        )
        return messages

    def is_step_complete(self, step: ExecutionStep, ai_response: Dict[str, Any], final_content: str) -> bool:
        if ai_response.get("tool_calls"):
            return False

        reasoning_content = ai_response.get("reasoning_content", "")
        content_is_empty = not (final_content and final_content.strip())
        if content_is_empty and reasoning_content:
            tool_related_keywords = [
                "call tool",
                "use tool",
                "read document",
                "query information",
                "get data",
                "调用工具",
                "读取文档",
                "查询信息",
                "获取数据",
                "使用工具",
            ]
            if any(keyword in reasoning_content for keyword in tool_related_keywords):
                logger.warning(
                    "[Agent] reasoning_content suggests tool use but model returned no tool_calls and no content"
                )
                return False
        validation = validate_step_output(step, final_content)
        if not validation.ok:
            logger.warning(
                "[Agent] Step %s completion contract rejected output: %s",
                step.step_id,
                "; ".join(validation.errors[:4]),
            )
        return validation.ok

    def parse_step_result(
        self,
        *,
        step: ExecutionStep,
        final_content: str,
        sources: List[Dict],
        tool_calls_count: int,
    ) -> StepResult:
        text = (final_content or "").strip()
        summary = (
            self.clean_step_summary_for_system(text, max_len=220)
            if text
            else f"{step.skill_name} produced no text result"
        )
        validation = validate_step_output(step, text)
        output: Dict[str, Any] = {"text": text, "handoff_summary": summary}
        if validation.parsed_output is not None:
            output["structured_output"] = validation.parsed_output
        if validation.errors:
            output["completion_contract_errors"] = list(validation.errors)
        return StepResult(
            step_id=step.step_id,
            skill_name=step.skill_name,
            success=validation.ok,
            summary=summary,
            output=output,
            raw_text=text,
            sources=sources,
            tool_calls_count=tool_calls_count,
        )

    @staticmethod
    def dedup_sources(sources: List[Dict]) -> List[Dict]:
        seen = set()
        deduped = []
        for source in sources:
            key = (source.get("doc_id"), source.get("url"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(source)
        return deduped

    def clean_step_output_for_final(self, text: str) -> str:
        if not text:
            return ""

        stop_markers = (
            "structured handoff result",
            "step handoff information",
            "handoff to the next step",
            "handoffpayload",
            "HandoffPayload",
            '"from_step_id"',
            '"from_skill"',
            '"handoff_summary"',
            '"sources_count"',
            "step_completed",
            "all tasks complete",
            "task summary",
        )
        stop_prefixes = ("> ⏭️", "⏭️", "HandoffPayload:")
        cleaned_lines: List[str] = []
        for raw_line in text.splitlines():
            line = raw_line.rstrip()
            stripped = line.strip()
            if not stripped:
                cleaned_lines.append("")
                continue

            lowered = stripped.lower()
            if any(marker in lowered for marker in stop_markers):
                break
            if any(stripped.startswith(prefix) for prefix in stop_prefixes):
                break
            cleaned_lines.append(line)

        cleaned = "\n".join(cleaned_lines).strip()
        return cleaned or text.strip()

    _HANDOFF_KEY_LINE_RE = re.compile(
        r'^.*"(?:from_step_id|from_skill|handoff_summary|sources_count|target_intents)"\s*:.*$',
        re.MULTILINE,
    )

    @staticmethod
    def _remove_handoff_json_blocks(text: str) -> str:
        """Remove HandoffPayload JSON blocks including nested braces."""
        result = []
        i = 0
        while i < len(text):
            # Look for HandoffPayload marker
            marker_pos = text.find("HandoffPayload", i)
            if marker_pos == -1:
                result.append(text[i:])
                break
            result.append(text[i:marker_pos])
            # Find the opening brace after the marker
            brace_pos = text.find("{", marker_pos)
            if brace_pos == -1:
                # No JSON block, just remove the marker line
                newline_pos = text.find("\n", marker_pos)
                i = newline_pos + 1 if newline_pos != -1 else len(text)
                continue
            # Count braces to find matching close
            depth = 0
            j = brace_pos
            while j < len(text):
                if text[j] == "{":
                    depth += 1
                elif text[j] == "}":
                    depth -= 1
                    if depth == 0:
                        i = j + 1
                        # Skip trailing whitespace/newline
                        while i < len(text) and text[i] in ('\n', '\r', ' '):
                            i += 1
                        break
                j += 1
            else:
                # Unmatched braces, remove from marker to end
                i = len(text)
        return "".join(result)

    def _scrub_handoff_artifacts(self, text: str) -> str:
        """Remove residual handoff JSON fragments from final output text."""
        if not text:
            return ""
        result = self._remove_handoff_json_blocks(text)
        result = self._HANDOFF_KEY_LINE_RE.sub("", result)
        result = re.sub(r'\n{3,}', '\n\n', result)
        return result.strip()

    def _build_safe_step_summary_for_final(self, step_result: StepResult) -> str:
        """Build a concise fallback summary without leaking intermediate raw text.

        Multi-step fallback must never concatenate user-facing long-form step
        outputs. Prefer the already-derived step summary; only derive a short
        summary from raw output when no summary is available.
        """
        summary = (step_result.summary or "").strip()
        if not summary:
            raw = (
                (step_result.raw_text or "").strip()
                or str(step_result.output.get("text", "")).strip()
                or str(step_result.output.get("final_answer", "")).strip()
            )
            if raw:
                summary = self.clean_step_summary_for_system(raw, max_len=220)

        if not summary:
            return ""

        summary = self.clean_step_output_for_final(summary)
        summary = self._scrub_handoff_artifacts(summary)
        return summary.strip()

    @staticmethod
    def _step_result_has_synthesis_evidence(step_result: Optional[StepResult]) -> bool:
        """Return whether a step result should be treated as downstream evidence.

        Failed/empty/cancelled steps are still stored on ExecutionState for
        observability and controller decisions, but they carry no real content
        (their summary is a placeholder like "X produced no text result"). Such
        steps must NOT be injected as evidence into the system-prompt step
        summaries or replayed as the final-answer fallback — otherwise the
        clinician sees the placeholder text as if it were an answer.
        """
        if not step_result:
            return False
        if not step_result.success:
            return False
        if step_result.sources:
            return True
        output = step_result.output if isinstance(step_result.output, dict) else {}
        text = (
            (step_result.raw_text or "").strip()
            or str(output.get("text") or "").strip()
            or str(output.get("final_answer") or "").strip()
        )
        return bool(text)

    def build_preserved_final_content(self, state: ExecutionState) -> str:
        """Build a safe multi-step fallback from summaries only.

        Historically this concatenated intermediate step raw_text, which could
        leak partial user-facing answers when synthesis failed. Keep only short
        summaries here so the final answer boundary never replays whole step
        bodies.
        """
        sections: List[str] = []
        for step in state.runtime_steps():
            if step.step_type == "synthesis":
                continue
            step_result = state.step_results.get(step.step_id)
            if not step_result:
                continue
            if not self._step_result_has_synthesis_evidence(step_result):
                continue

            body = self._build_safe_step_summary_for_final(step_result)
            if body and body not in sections:
                sections.append(body)

        final_text = "\n\n".join(sections).strip()
        if len(final_text) > 4000:
            logger.warning("[FinalCompose] content too long (%s), truncating", len(final_text))
            final_text = final_text[:4000].rstrip() + "\n\n[Content is long and has been truncated]"
        return final_text

    async def compose_final_answer_from_state(self, state: ExecutionState) -> Dict[str, Any]:
        runtime_steps = state.runtime_steps()
        if not runtime_steps:
            return {"content": "No final answer was generated", "sources": []}

        all_sources: List[Dict] = []
        for result in state.step_results.values():
            all_sources.extend(result.sources)
        deduped_sources = self.dedup_sources(all_sources)

        if len(runtime_steps) == 1:
            only_step = runtime_steps[0]
            only_result = state.step_results.get(only_step.step_id)
            content = only_result.raw_text if only_result and only_result.raw_text else ""
            if not content:
                content = "\n".join(
                    result.summary
                    for result in state.step_results.values()
                    if result.summary and self._step_result_has_synthesis_evidence(result)
                ) or "No final answer was generated"
            content = self.clean_step_output_for_final(content)
            content = self._scrub_handoff_artifacts(content)
            return {"content": content, "sources": deduped_sources}

        synthesis_step = next((step for step in reversed(runtime_steps) if step.step_type == "synthesis"), None)
        if synthesis_step:
            synthesis_result = state.step_results.get(synthesis_step.step_id)
            if synthesis_result:
                synthesis_raw = (
                    (synthesis_result.raw_text or "").strip()
                    or str(synthesis_result.output.get("text", "")).strip()
                    or (synthesis_result.summary or "").strip()
                )
                synthesis_content = self.clean_step_output_for_final(synthesis_raw)
                synthesis_content = self._scrub_handoff_artifacts(synthesis_content)
                if synthesis_content and len(synthesis_content) >= 2:
                    return {"content": synthesis_content, "sources": deduped_sources}

        preserved_content = self.build_preserved_final_content(state)
        if preserved_content:
            preserved_content = self._scrub_handoff_artifacts(preserved_content)
            return {"content": preserved_content, "sources": deduped_sources}

        fallback_parts: List[str] = []
        for step in runtime_steps:
            if step.step_type == "synthesis":
                continue
            result = state.step_results.get(step.step_id)
            intent_text = "; ".join(step.target_intents) if step.target_intents else step.goal
            body = ""
            if result:
                if not self._step_result_has_synthesis_evidence(result):
                    continue
                body = self._build_safe_step_summary_for_final(result)
            if not body:
                body = "The intermediate step completed, but no directly sendable final answer was generated."
            fallback_parts.append(f"{intent_text}\n{body}")
        fallback_content = "\n\n".join(fallback_parts).strip() or "No final answer was generated"
        fallback_content = self._scrub_handoff_artifacts(fallback_content)
        return {"content": fallback_content, "sources": deduped_sources}

    @staticmethod
    def build_step_handoff(step: ExecutionStep, step_result: StepResult) -> Dict[str, Any]:
        return {
            "from_step_id": step.step_id,
            "from_skill": step.skill_name,
            "step_type": step.step_type,
            "target_intents": step.target_intents,
            "summary": step_result.summary,
            "output": step_result.output,
            "sources_count": len(step_result.sources),
        }
