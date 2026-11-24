import re
from typing import Dict, List, Optional, Tuple

from runtime.agent_runtime.conversation_state import ConversationRuntimeState
from runtime.skills.models import ExecutionPlan
from runtime.skills.models import ExecutionStep, SkillPackage, SkillRuntimeContext, StepResult


class RuntimePlanningPolicy:
    FAST_PATH_MAX_CHARS = 72
    FAST_PATH_MAX_WORDS = 14
    FAST_PATH_TOOL_KEYWORDS = (
        # 时效性/外部信息
        "最新",
        "天气",
        "新闻",
        # 搜索意图
        "搜",
        "搜索",
        "检索",
        "查一下",
        "查一查",
        "查查",
        "帮我查",
        # 文档/网页
        "网页",
        "网站",
        "链接",
        "文档",
        "说明书",
        "手册",
        "repo",
        "仓库",
        "文件",
        "pdf",
        "上传",
        "图片",
        "图像",
        "截图",
        "生图",
        "文生图",
        "海报",
        "海报生成",
        "配图",
        "插图",
        "封面图",
        "首图",
        "画一张",
        "画一个",
        # 命令/工具
        "shell",
        "终端",
        "命令",
        "benchmark",
        "测试脚本",
        "运行一下",
        "run ",
        "mcp",
        # Domain-specific names and internal terms should be handled
        # by configured skills/MCP tools rather than generic memory.
        "研究对象",
        "内部",
        "参数",
        # iEEG / research data workflows should route through configured tools,
        # datasets, or skills rather than generic fast-path chat.
        "ieeg",
        "seeg",
        "ecog",
        "eeg",
        "edf",
        "bdf",
        "fif",
        "vhdr",
        "brainvision",
        "bids",
        "hfo",
        "pyhfo",
        "ripple",
        "spindle",
        "spike",
        "癫痫",
        "发作",
        "脑电",
        "颅内",
        "通道",
        "电极",
        "数据集",
        "预处理",
        "清洗",
        "坏道",
        "伪迹",
        "频谱",
        "时频",
        "标注",
        # 知识库查询
        "知识库",
        "数据库",
        "版本",
        # durable memory / user preference reads+writes should never bypass bootstrap
        "记住",
        "记忆",
        "偏好",
        "memory",
    )
    FAST_PATH_BLOCKLIST = FAST_PATH_TOOL_KEYWORDS
    FAST_PATH_BLOCKLIST_PATTERNS = (
        re.compile(r"```"),
        re.compile(r"\n"),
        re.compile(r"https?://", re.IGNORECASE),
        re.compile(r"/[\w.\-]+"),
        re.compile(r"`[^`]+`"),
    )
    FAST_PATH_MEMORY_PATTERNS = (
        re.compile(r"你还记得"),
        re.compile(r"还记得"),
        re.compile(r"我喜欢什么"),
        re.compile(r"我不喜欢什么"),
        re.compile(r"我爱吃什么"),
        re.compile(r"我爱喝什么"),
        re.compile(r"我之前说过"),
        re.compile(r"我的偏好"),
        re.compile(r"长期记忆"),
    )
    FAST_PATH_MULTI_STAGE_PATTERNS = (
        re.compile(r"按顺序"),
        re.compile(r"不要一步到位"),
        re.compile(r"分[两二三四五六七八九十]\s*步"),
        re.compile(r"先.+?(再|然后).+?(最后|最终)"),
    )
    FAST_PATH_DIRECT_PATTERNS = (
        re.compile(r"(是什么|什么意思|多少|几|哪里|哪儿|哪个|哪种|谁|何时|首都)"),
        re.compile(r"(只答|只回答|简短回答|一句话回答|一个词)"),
        re.compile(r"^[\d\s+\-*/().=]+$"),
    )

    @staticmethod
    def is_fast_path_plan(plan: Optional[ExecutionPlan]) -> bool:
        if not plan:
            return False
        planner_metrics = plan.planner_metrics if isinstance(plan.planner_metrics, dict) else {}
        return bool(
            planner_metrics.get("fast_path")
            or str(plan.routing_method or "").strip().lower() == "fast_path"
        )

    @classmethod
    def should_use_fast_path(
        cls,
        *,
        message: str,
        active_skill_name: Optional[str],
        conversation_state: Optional[ConversationRuntimeState],
    ) -> bool:
        """Rule-based pre-filter. Only passes truly trivial cases.

        For anything domain-specific, returns False so the bootstrap
        LLM (or the async LLM fast-path check) handles routing.
        """
        normalized = re.sub(r"\s+", " ", (message or "")).strip()
        if not normalized:
            return False
        if active_skill_name:
            return False
        if conversation_state:
            if conversation_state.pending_user_input:
                return False
            if conversation_state.pending_actions:
                return False
            if conversation_state.open_goals:
                return False

        # Only pure arithmetic passes the rule-based fast path
        compact = re.sub(r"\s+", "", normalized)
        if re.match(r"^[\d\s+\-*/().=]+$", compact):
            return True

        return False

    @classmethod
    async def should_use_fast_path_llm(
        cls,
        *,
        message: str,
        ai_service,
        active_skill_name: Optional[str],
        conversation_state: Optional[ConversationRuntimeState],
    ) -> bool:
        """LLM-based fast-path decision for short messages.

        Uses a fast model (qwen-turbo) to decide if a question needs
        tools/knowledge-base or can be answered from general knowledge.
        Only called for short messages without active skill context.
        """
        import asyncio

        normalized = re.sub(r"\s+", " ", (message or "")).strip()
        if not normalized:
            return False
        if active_skill_name:
            return False
        if conversation_state:
            if conversation_state.pending_user_input:
                return False
            if conversation_state.pending_actions:
                return False
            if conversation_state.open_goals:
                return False

        # Only consider short messages for LLM fast-path
        if len(normalized) > cls.FAST_PATH_MAX_CHARS:
            return False

        # Obvious blocklist patterns skip fast-path entirely
        for pattern in cls.FAST_PATH_BLOCKLIST_PATTERNS:
            if pattern.search(normalized):
                return False

        # Multi-intent detection: 2+ non-empty clauses separated by CN/EN
        # punctuation almost always means the user stacked multiple questions,
        # which fast-path cannot handle — force bootstrap.
        clauses = [c for c in re.split(r"[，,、；;]", normalized) if c.strip()]
        if len(clauses) >= 2:
            return False

        # Deterministic keyword gate: any tool/KB keyword → skip fast-path
        # without burning an LLM call. Matches are case-insensitive.
        lowered = normalized.lower()
        for keyword in cls.FAST_PATH_TOOL_KEYWORDS:
            if keyword and keyword.lower() in lowered:
                return False
        for edit_keyword in ("改图", "修图", "重绘", "换背景", "图片编辑", "图像编辑"):
            if edit_keyword in normalized:
                return False
        if re.search(r"^(让这只|让这张|把这张|把这只|把它).+", normalized):
            return False
        for pattern in cls.FAST_PATH_MEMORY_PATTERNS:
            if pattern.search(normalized):
                return False

        try:
            response = await asyncio.wait_for(
                ai_service.chat([
                    {
                        "role": "system",
                        "content": (
                            "You are a routing classifier. Decide whether the user's question can be answered "
                            "directly from general knowledge, or whether it requires internal knowledge bases, "
                            "documents, databases, or tool calls.\n\n"
                            "Needs tools/knowledge-base: specific research subjects, technical parameters, "
                            "operational steps, recording or study details, document lookup, current "
                            "publications or reference material, any image-generation/editing request, "
                            "and anything that depends on durable memory/preferences/history.\n\n"
                            "Does not need tools: greetings, casual chat, general knowledge, pure arithmetic, "
                            "and self-introduction.\n\n"
                            "Answer exactly one word: yes (needs tools) or no (does not need tools)."
                        ),
                    },
                    {"role": "user", "content": normalized},
                ]),
                timeout=5,
            )
            answer = (response.get("content", "") if isinstance(response, dict) else str(response)).strip()
            needs_tools = answer.lower().startswith("yes") or answer.startswith("是")
            return not needs_tools
        except Exception:
            # On any error, don't use fast-path (safer to go through bootstrap)
            return False

    def build_fast_path_plan(self, *, message: str) -> ExecutionPlan:
        instructions = "Answer the user directly. Do not call tools; use current context and general knowledge."
        return ExecutionPlan(
            user_goal=message,
            routing_reason="fast-path direct answer heuristic",
            routing_method="fast_path",
            steps=[
                ExecutionStep(
                    step_id="s1",
                    skill_name="general_assistant",
                    step_type="general",
                    goal="Answer the user directly",
                    instructions=instructions,
                    target_intents=[message],
                    blocked_intents=[],
                    allowed_tool_names=[],
                    allow_all_tools=False,
                    tools_disabled_by_user=True,
                    done_when="Produce a final answer that can be sent directly to the user.",
                    is_final_step=True,
                )
            ],
            multi_skill_mode=False,
            planner_metrics={
                "fast_path": True,
                "strategy": "direct_answer",
            },
        )

    def append_final_synthesis_step_if_needed(
        self,
        steps: List[ExecutionStep],
        intents: List[str],
    ) -> List[ExecutionStep]:
        if not steps or len(intents) <= 1 or steps[-1].step_type == "synthesis":
            return steps

        for step in steps:
            step.is_final_step = False
            step.done_when = "Produce a structured handoff result."
            if step.step_type == "general":
                step.instructions = (
                    f"This step has no dedicated Skill; handle only the current subtask: {'; '.join(step.target_intents) or step.goal}. "
                    "This step should output only an intermediate result, not the final answer."
                )
            elif step.step_type == "skill":
                step.instructions = (
                    f"Handle only the current subtask: {'; '.join(step.target_intents) or step.goal}. Follow the capability boundary of {step.skill_name}. "
                    "This step should output only an intermediate result, not the final answer."
                )

        synthesis_step = ExecutionStep(
            step_id=f"s{len(steps) + 1}",
            skill_name="final_synthesizer",
            step_type="synthesis",
            goal="Synthesize all completed subtask results into the final user answer",
            instructions="Answer based on previous step outputs, cover all subtasks, and do not expose internal execution details.",
            target_intents=list(intents),
            blocked_intents=[],
            allowed_tool_names=[],
            allow_all_tools=False,
            done_when="Produce a complete final answer covering all subtasks.",
            output_schema=None,
            depends_on=[steps[-1].step_id],
            is_final_step=True,
        )
        return [*steps, synthesis_step]

    def infer_general_tools_for_intent(self, intent: str, all_tools: List[Dict]) -> List[str]:
        tool_names = [
            tool.get("function", {}).get("name", "")
            for tool in all_tools
            if tool.get("function", {}).get("name")
        ]
        if not tool_names:
            return []

        # 返回全部可用工具（已是用户权限过滤后的结果），
        # 不再硬编码 documents_/search_ 前缀限制
        return tool_names

    def resolve_skill_step_tool_policy(
        self,
        *,
        selected_skill: SkillPackage,
        intent: str,
        all_tools: List[Dict],
        allow_all_tools_override: Optional[bool] = None,
    ) -> Tuple[List[str], bool]:
        metadata = selected_skill.metadata if isinstance(selected_skill.metadata, dict) else {}
        allow_all_tools = (
            bool(metadata.get("allow_all_tools", False))
            if allow_all_tools_override is None
            else allow_all_tools_override
        )
        allowed_tools = [
            str(name).strip()
            for name in (selected_skill.allowed_tools or [])
            if str(name).strip()
        ]
        if allowed_tools:
            return allowed_tools, allow_all_tools

        if allow_all_tools:
            return [], allow_all_tools

        inferred_tools = self.infer_general_tools_for_intent(intent, all_tools)
        if inferred_tools:
            return inferred_tools, allow_all_tools

        return [], allow_all_tools

    @staticmethod
    def merge_no_tool_instruction(instructions: str) -> str:
        cleaned = re.sub(r"(?:Use tools as needed to supplement information\.?|可按需(?:调用|使用)工具补充信息。?)", "", instructions or "").strip()
        if not cleaned:
            cleaned = "Complete directly from the existing context."
        if "do not call tools" in cleaned.lower() or "do not use tools" in cleaned.lower() or "不要调用任何工具" in cleaned or "不要使用任何工具" in cleaned:
            return cleaned
        if cleaned.endswith(("。", "！", "？", ".", "!", "?")):
            return f"{cleaned} Do not call tools; complete directly from the existing context."
        return f"{cleaned}. Do not call tools; complete directly from the existing context."

    @staticmethod
    def user_explicitly_disallows_tools(message: str) -> bool:
        normalized = re.sub(r"\s+", "", (message or "")).strip().lower()
        if not normalized:
            return False
        patterns = (
            "不要调用工具",
            "不要用工具",
            "不要使用工具",
            "无需调用工具",
            "不能调用工具",
            "别调用工具",
            "不要调用任何工具",
            "不要使用任何工具",
            "不调用工具",
        )
        return any(pattern in normalized for pattern in patterns)

    def apply_user_tool_constraint(
        self,
        *,
        message: str,
        instructions: str,
        allowed_tools: List[str],
        allow_all_tools: bool,
    ) -> Tuple[List[str], bool, str, bool]:
        tools_disabled_by_user = self.user_explicitly_disallows_tools(message)
        if not tools_disabled_by_user:
            return allowed_tools, allow_all_tools, instructions, False
        return [], False, self.merge_no_tool_instruction(instructions), True

    @staticmethod
    def _normalize_tool_name(name: str) -> str:
        normalized = str(name or "").strip()
        if normalized.startswith("hitl__"):
            return normalized[len("hitl__") :]
        return normalized

    @classmethod
    def _tool_name_matches_allowed(cls, tool_name: str, allowed_name: str) -> bool:
        normalized_tool = cls._normalize_tool_name(tool_name)
        normalized_allowed = cls._normalize_tool_name(allowed_name)
        if not normalized_tool or not normalized_allowed:
            return False
        if normalized_tool == normalized_allowed:
            return True
        return (
            normalized_tool.endswith(normalized_allowed)
            or normalized_allowed.endswith(normalized_tool)
        )

    @classmethod
    def filter_tools_by_names(
        cls,
        tools: List[Dict],
        allowed_tool_names: List[str],
    ) -> List[Dict]:
        allowed = [
            cls._normalize_tool_name(name)
            for name in (allowed_tool_names or [])
            if cls._normalize_tool_name(name)
        ]
        if not allowed:
            return []
        filtered: List[Dict] = []
        for tool in tools:
            tool_name = str(tool.get("function", {}).get("name", "")).strip()
            if tool_name and any(
                cls._tool_name_matches_allowed(tool_name, allowed_name)
                for allowed_name in allowed
            ):
                filtered.append(tool)
        return filtered

    @staticmethod
    def _extract_non_mcp_tool_names(tools: List[Dict]) -> set:
        """提取非 MCP 内建工具名称，这些工具不受 skill 级过滤影响。

        MCP 工具名称格式通常为 ``{prefix}_{action}``（如 document_search），
        而内建工具如 vl_query / emit_ui_command / get_ui_state 是系统级能力。
        """
        # UI co-pilot MCP tools（emit_ui_command / get_ui_state / wait_for_ui_command / inspect_waveform）和 vl_query 一样是跨 step 的
        # 系统级能力：任何 step 都可能需要操控 UI。它们必须穿透 step 级工具过滤，否则
        # LLM 发出的调用会被 tool_executor 的 available 白名单当作 "unknown tool" 丢弃，
        # ui_commands 永远为空（co-pilot 静默失效）。
        built_in_tools = {
            "vl_query",
            "emit_ui_command",
            "get_ui_state",
            "wait_for_ui_command",
            "inspect_waveform",
        }
        non_mcp = set()
        for tool in tools:
            name = str(tool.get("function", {}).get("name", "")).strip()
            if name in built_in_tools:
                non_mcp.add(name)
        return non_mcp

    @staticmethod
    def _ensure_non_mcp_tools_preserved(
        result_tools: List[Dict],
        all_tools: List[Dict],
        non_mcp_names: set,
    ) -> List[Dict]:
        """确保非 MCP 内建工具（如 vl_query）始终包含在结果中。

        Args:
            result_tools: 经 skill 级过滤后的工具列表
            all_tools: 全部可用工具（MCP 权限过滤后的结果）
            non_mcp_names: 不受 skill 过滤影响的工具名称集合
        """
        if not non_mcp_names:
            return result_tools
        result_names = {
            str(t.get("function", {}).get("name", "")).strip()
            for t in result_tools
        }
        missing = []
        for tool in all_tools:
            name = str(tool.get("function", {}).get("name", "")).strip()
            if name in non_mcp_names and name not in result_names:
                missing.append(tool)
        if missing:
            return [*result_tools, *missing]
        return result_tools

    def resolve_step_tools(
        self,
        *,
        step: ExecutionStep,
        all_tools: List[Dict],
        skill_context: Optional[SkillRuntimeContext],
    ) -> List[Dict]:
        if step.step_type == "synthesis" or step.tools_disabled_by_user:
            return []

        # 识别非 MCP 内建工具（如 vl_query），这些工具应始终可用
        non_mcp_names = self._extract_non_mcp_tool_names(all_tools)

        base_tools = all_tools
        if step.step_type == "skill" and skill_context and skill_context.tool_filter_applied:
            base_tools = skill_context.filtered_tools

        if step.allow_all_tools:
            return self._ensure_non_mcp_tools_preserved(base_tools, all_tools, non_mcp_names)

        filtered_tools = self.filter_tools_by_names(base_tools, step.allowed_tool_names)
        if filtered_tools:
            return self._ensure_non_mcp_tools_preserved(filtered_tools, all_tools, non_mcp_names)

        if step.explicit_tool_selection:
            return self._ensure_non_mcp_tools_preserved([], all_tools, non_mcp_names)

        # 空 allowlist + allow_all_tools=False 的语义区分：
        # - step_type == "skill" 且 skill 上层没对工具做过滤：skill 明确被路由中但
        #   也没有任何工具限制，严格处理为「不调用任何 MCP 工具」，避免 legacy
        #   skill 因缺配置默默提权到全部工具。仍保留 VL 等非-MCP 内建（系统能力）。
        # - 其他情况（skill 已被过滤 / general / dynamic 步骤）：回退到 base_tools，
        #   保证动态通用步骤仍能使用用户权限范围内的全部工具，并且 skill 已过滤的
        #   结果会继续被尊重。
        skill_without_any_filter = (
            step.step_type == "skill"
            and (skill_context is None or not skill_context.tool_filter_applied)
        )
        if skill_without_any_filter:
            return self._ensure_non_mcp_tools_preserved(list(base_tools), all_tools, non_mcp_names)

        result = list(base_tools)
        if base_tools is not all_tools:
            result = self._ensure_non_mcp_tools_preserved(result, all_tools, non_mcp_names)
        return result

    @staticmethod
    def should_run_agent_control_after_step(
        *,
        ai_service_available: bool,
        state,
        completed_step: ExecutionStep,
        step_result: StepResult,
    ) -> bool:
        if not ai_service_available:
            return False
        if step_result.output.get("waiting_for_input"):
            return False
        if (
            RuntimePlanningPolicy.is_fast_path_plan(getattr(state, "plan", None))
            and completed_step.step_type == "general"
            and completed_step.is_final_step
            and step_result.success
        ):
            return False
        if completed_step.step_type == "synthesis" and completed_step.is_final_step and step_result.success:
            return False

        control_hint = step_result.output.get("agent_control_hint")
        if isinstance(control_hint, str):
            control_hint = control_hint.strip()

        remaining_task_steps = [
            step
            for step in state.remaining_runtime_steps(state.current_step_index + 1)
            if step.step_type != "synthesis"
        ]

        return bool(
            not step_result.success
            or control_hint
            or not remaining_task_steps
        )
