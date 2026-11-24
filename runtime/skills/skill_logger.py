"""
Skill Logger - 独立的 Skill 响应日志记录器

提供专门的日志文件记录 Skill 系统的响应情况：
- 路由决策日志
- 运行时上下文准备日志
- 工具调用日志
- 响应完成日志

日志文件位置: logs/skills.log
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List
import json

from runtime.redaction import ObservabilityRedactionFilter, redact_observability_payload


class SkillLogger:
    """Skill 响应日志记录器
    
    提供独立的日志文件，专门记录 Skill 系统的运行情况。
    日志格式为结构化文本，便于分析和调试。
    
    使用方式：
        from runtime.skills.skill_logger import skill_logger
        
        # 记录路由决策
        skill_logger.log_routing(message, result)
        
        # 记录上下文准备
        skill_logger.log_context_prepared(context)
        
        # 记录响应完成
        skill_logger.log_response_completed(conv_id, skill_name, duration_ms)
    """
    
    def __init__(self, log_dir: str = "logs", log_file: str = "skills.log"):
        """初始化 Skill 日志记录器
        
        Args:
            log_dir: 日志目录路径
            log_file: 日志文件名
        """
        # 确保日志目录存在
        self.log_dir = Path(log_dir)
        if not self.log_dir.is_absolute():
            agent_data_dir = os.environ.get("IEEG_AGENT_DATA_DIR", "").strip()
            if agent_data_dir and log_dir == "logs":
                self.log_dir = Path(agent_data_dir).expanduser() / "logs"
            else:
                # 相对于项目根目录
                project_root = Path(__file__).parent.parent.parent
                self.log_dir = project_root / log_dir
        
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        self.log_path = self.log_dir / log_file
        self.verification_issue_log_path = self.log_dir / "verification_issues.log"
        
        # 创建专用的 logger
        self.logger = logging.getLogger("skill_response")
        self.logger.setLevel(logging.INFO)
        if not any(isinstance(item, ObservabilityRedactionFilter) for item in self.logger.filters):
            self.logger.addFilter(ObservabilityRedactionFilter())
        
        # 避免重复添加 handler
        if not self.logger.handlers:
            # 文件 handler
            file_handler = logging.FileHandler(
                self.log_path,
                encoding='utf-8',
                mode='a'  # 追加模式
            )
            file_handler.setLevel(logging.INFO)
            
            # 日志格式
            formatter = logging.Formatter(
                '%(asctime)s | %(levelname)s | %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            file_handler.setFormatter(formatter)
            
            self.logger.addHandler(file_handler)

        self.verification_issue_logger = logging.getLogger(
            "skill_verification_issue"
        )
        self.verification_issue_logger.setLevel(logging.INFO)
        if not any(
            isinstance(item, ObservabilityRedactionFilter)
            for item in self.verification_issue_logger.filters
        ):
            self.verification_issue_logger.addFilter(ObservabilityRedactionFilter())
        if not self.verification_issue_logger.handlers:
            issue_file_handler = logging.FileHandler(
                self.verification_issue_log_path,
                encoding='utf-8',
                mode='a'
            )
            issue_file_handler.setLevel(logging.INFO)
            issue_formatter = logging.Formatter(
                '%(asctime)s | %(levelname)s | %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            issue_file_handler.setFormatter(issue_formatter)
            self.verification_issue_logger.addHandler(issue_file_handler)
    
    def _format_json(self, data: Any) -> str:
        """格式化 JSON 数据为字符串
        
        Args:
            data: 要格式化的数据
            
        Returns:
            JSON 字符串
        """
        if isinstance(data, (dict, list)):
            return json.dumps(data, ensure_ascii=False)
        return str(data)
    
    def _truncate(self, text: str, max_len: int = 200) -> str:
        """截断文本
        
        Args:
            text: 原始文本
            max_len: 最大长度
            
        Returns:
            截断后的文本
        """
        if len(text) <= max_len:
            return text
        return text[:max_len] + "..."
    
    def log_separator(self) -> None:
        """记录分隔线，用于区分不同请求"""
        self.logger.info("=" * 80)
    
    def log_request_start(
        self,
        conversation_id: str,
        user_message: str,
        active_skill_name: Optional[str] = None
    ) -> None:
        """记录请求开始
        
        Args:
            conversation_id: 会话ID
            user_message: 用户消息
            active_skill_name: 手动指定的 skill 名称
        """
        self.log_separator()
        self.logger.info(f"[REQUEST START] conv_id={conversation_id}")
        self.logger.info(f"  User Message: {self._truncate(user_message)}")
        if active_skill_name:
            self.logger.info(f"  Manual Skill: {active_skill_name}")
    
    def log_routing(
        self,
        user_message: str,
        routing_result: Dict[str, Any]
    ) -> None:
        """记录路由决策
        
        Args:
            user_message: 用户消息
            routing_result: 路由结果字典，包含：
                - skill_name: 选中skill名称
                - confidence: 置信度
                - reason: 路由理由
                - routing_method: 路由方式 (llm/manual/fallback)
                - candidates_count: 候选数量
        """
        skill_name = routing_result.get("skill_name", "None")
        confidence = routing_result.get("confidence", 0)
        reason = routing_result.get("reason", "")
        method = routing_result.get("routing_method", "unknown")
        candidates = routing_result.get("candidates_count", 0)
        planned_order = routing_result.get("planned_order", [])
        intent_plans = routing_result.get("intent_plans", [])
        
        self.logger.info(f"[ROUTING] method={method}, skill={skill_name}, confidence={confidence:.2f}")
        self.logger.info(f"  Reason: {reason}")
        self.logger.info(f"  Candidates Count: {candidates}")
        if planned_order:
            self.logger.info(f"  Planned Order: {' -> '.join([str(x) for x in planned_order])}")
        if isinstance(intent_plans, list) and intent_plans:
            self.logger.info(f"  Intent Plans Count: {len(intent_plans)}")
            for i, plan in enumerate(intent_plans, 1):
                if not isinstance(plan, dict):
                    continue
                intent = self._truncate(str(plan.get("intent", "")), 120)
                mapped_skill = plan.get("skill_name")
                reason_i = self._truncate(str(plan.get("reason", "")), 160)
                self.logger.info(
                    f"    Intent {i}: skill={mapped_skill if mapped_skill else 'general'} | intent={intent}"
                )
                if reason_i:
                    self.logger.info(f"      Why: {reason_i}")
        self.logger.info(f"  User Message Preview: {self._truncate(user_message)}")
    
    def log_multi_skill_routing(
        self,
        user_message: str,
        routing_result: Dict[str, Any]
    ) -> None:
        """记录多 Skills 路由决策（每个 skill 单独记录）
        
        Args:
            user_message: 用户消息
            routing_result: 路由结果字典，包含：
                - skill_name: 主 skill 名称
                - confidence: 置信度
                - reason: 路由理由
                - routing_method: 路由方式 (llm/manual/fallback)
                - candidates_count: 候选数量
                - planned_order: 规划的执行顺序（skill 名称列表）
                - candidate_skills: 候选 skills 列表，每项包含 name, description
        """
        skill_name = routing_result.get("skill_name", "None")
        confidence = routing_result.get("confidence", 0)
        reason = routing_result.get("reason", "")
        method = routing_result.get("routing_method", "unknown")
        total_candidates = routing_result.get("candidates_count", 0)
        planned_order = routing_result.get("planned_order", [])
        candidate_skills = routing_result.get("candidate_skills", [])
        intent_plans = routing_result.get("intent_plans", [])
        
        # 记录总体路由信息
        multi_skill_count = len(candidate_skills)
        if multi_skill_count > 1:
            self.logger.info(f"[MULTI-ROUTING] method={method}, total_skills={multi_skill_count}, primary={skill_name}, confidence={confidence:.2f}")
            self.logger.info(f"  Planned Order: {' → '.join(planned_order)}")
        else:
            self.logger.info(f"[ROUTING] method={method}, skill={skill_name}, confidence={confidence:.2f}")
        
        self.logger.info(f"  Reason: {reason}")
        self.logger.info(f"  Total Candidates: {total_candidates}")
        
        # 为每个候选 skill 分别记录
        if candidate_skills:
            for i, skill_info in enumerate(candidate_skills):
                skill_name_i = skill_info.get("name", "unknown")
                description = skill_info.get("description", "")
                category = skill_info.get("category", "")
                
                self.logger.info(f"[ROUTING SKILL {i+1}/{multi_skill_count}] {skill_name_i}")
                if category:
                    self.logger.info(f"  Category: {category}")
                self.logger.info(f"  Description: {self._truncate(description, 150)}")
        else:
            # 兼容旧格式：没有 candidate_skills 时只记录主 skill
            self.logger.info(f"[ROUTING SKILL] {skill_name}")
        if isinstance(intent_plans, list) and intent_plans:
            self.logger.info(f"[ROUTING INTENTS] count={len(intent_plans)}")
            for i, plan in enumerate(intent_plans):
                if not isinstance(plan, dict):
                    continue
                intent = self._truncate(str(plan.get("intent", "")), 120)
                mapped_skill = plan.get("skill_name")
                self.logger.info(
                    f"  Intent {i+1}: skill={mapped_skill if mapped_skill else 'general'}, text={intent}"
                )
        
        self.logger.info(f"  User Message Preview: {self._truncate(user_message)}")
    
    def log_context_prepared(
        self,
        skill_name: str,
        context_info: Dict[str, Any]
    ) -> None:
        """记录运行时上下文准备
        
        Args:
            skill_name: Skill 名称
            context_info: 上下文信息字典，包含：
                - load_time_ms: 加载耗时
                - tool_filter_applied: 是否应用工具过滤
                - filtered_tools_count: 过滤后工具数量
                - reference_snippets_count: 参考片段数量
                - has_template: 是否有模板
        """
        load_time = context_info.get("load_time_ms", 0)
        tool_filter = context_info.get("tool_filter_applied", False)
        tools_count = context_info.get("filtered_tools_count", 0)
        refs_count = context_info.get("reference_snippets_count", 0)
        has_template = context_info.get("has_template", False)
        
        self.logger.info(f"[CONTEXT PREPARED] skill={skill_name}, load_time={load_time:.2f}ms")
        self.logger.info(f"  Tool Filter Applied: {tool_filter}, Tools Count: {tools_count}")
        self.logger.info(f"  References Count: {refs_count}, Has Template: {has_template}")
    
    def log_tool_call(
        self,
        tool_name: str,
        tool_args: Dict[str, Any],
        skill_name: Optional[str] = None,
        iteration: int = 1
    ) -> None:
        """记录工具调用
        
        Args:
            tool_name: 工具名称
            tool_args: 工具参数
            skill_name: 当前 skill 名称
            iteration: 迭代次数
        """
        args_str = self._format_json(redact_observability_payload(tool_args))
        self.logger.info(f"[TOOL CALL] iteration={iteration}, tool={tool_name}, skill={skill_name or 'N/A'}")
        self.logger.info(f"  Args: {self._truncate(args_str)}")
    
    def log_tool_result(
        self,
        tool_name: str,
        success: bool,
        result_preview: Optional[str] = None,
        error: Optional[str] = None
    ) -> None:
        """记录工具执行结果
        
        Args:
            tool_name: 工具名称
            success: 是否成功
            result_preview: 结果预览
            error: 错误信息
        """
        status = "SUCCESS" if success else "FAILED"
        self.logger.info(f"[TOOL RESULT] tool={tool_name}, status={status}")
        if success and result_preview:
            safe_preview = redact_observability_payload(result_preview)
            self.logger.info(f"  Result Preview: {self._truncate(str(safe_preview))}")
        if error:
            self.logger.info(f"  Error: {redact_observability_payload(error)}")
    
    def log_response_completed(
        self,
        conversation_id: str,
        skill_name: Optional[str],
        total_iterations: int,
        duration_ms: float,
        sources_count: int = 0
    ) -> None:
        """记录响应完成
        
        Args:
            conversation_id: 会话ID
            skill_name: 使用的 skill 名称
            total_iterations: 总迭代次数
            duration_ms: 总耗时（毫秒）
            sources_count: 来源数量
        """
        self.logger.info(f"[RESPONSE COMPLETED] conv_id={conversation_id}")
        self.logger.info(f"  Skill Used: {skill_name or 'None'}")
        self.logger.info(f"  Total Iterations: {total_iterations}")
        self.logger.info(f"  Duration: {duration_ms:.0f}ms")
        self.logger.info(f"  Sources Count: {sources_count}")
        self.log_separator()
    
    def log_error(
        self,
        error_type: str,
        error_message: str,
        context: Optional[Dict[str, Any]] = None
    ) -> None:
        """记录错误
        
        Args:
            error_type: 错误类型
            error_message: 错误信息
            context: 上下文信息
        """
        self.logger.error(f"[ERROR] type={error_type}")
        self.logger.error(f"  Message: {error_message}")
        if context:
            self.logger.error(f"  Context: {self._format_json(context)}")
    
    def log_no_skill_selected(self, reason: str) -> None:
        """记录未选中任何 skill
        
        Args:
            reason: 原因说明
        """
        self.logger.info(f"[NO SKILL SELECTED] reason={reason}")
    
    def log_fallback_triggered(self, reason: str) -> None:
        """记录降级触发
        
        Args:
            reason: 降级原因
        """
        self.logger.warning(f"[FALLBACK TRIGGERED] reason={reason}")
    
    def log_available_skills(
        self,
        skills: List[Dict[str, Any]]
    ) -> None:
        """记录当前可用的 Skills 列表
        
        Args:
            skills: Skill 信息列表，每个元素包含：
                - name: skill 名称
                - description: 描述
                - category: 分类（可选）
                - tags: 标签列表（可选）
        """
        self.logger.info(f"[AVAILABLE SKILLS] count={len(skills)}")
        for i, skill in enumerate(skills, 1):
            name = skill.get("name", "unknown")
            desc = self._truncate(skill.get("description", ""), 100)
            category = skill.get("category", "")
            tags = skill.get("tags", [])
            
            tag_str = f", tags=[{', '.join(tags[:3])}{'...' if len(tags) > 3 else ''}]" if tags else ""
            cat_str = f", category={category}" if category else ""
            
            self.logger.info(f"  {i}. {name}{cat_str}{tag_str}")
            self.logger.info(f"     Description: {desc}")
    
    def log_skill_loaded(
        self,
        skill_name: str,
        has_workflow: bool = False,
        has_templates: bool = False,
        has_references: bool = False,
        has_scripts: bool = False
    ) -> None:
        """记录单个 Skill 加载信息
        
        Args:
            skill_name: Skill 名称
            has_workflow: 是否有工作流
            has_templates: 是否有模板
            has_references: 是否有参考文档
            has_scripts: 是否有脚本
        """
        features = []
        if has_workflow:
            features.append("workflow")
        if has_templates:
            features.append("templates")
        if has_references:
            features.append("references")
        if has_scripts:
            features.append("scripts")
        
        features_str = f", features=[{', '.join(features)}]" if features else ""
        self.logger.info(f"[SKILL LOADED] name={skill_name}{features_str}")
    
    # ========== 多 Skills 顺序执行日志 ==========
    
    def log_multi_skill_start(
        self,
        conversation_id: str,
        skills_order: List[str],
        routing_reason: str
    ) -> None:
        """记录多 Skills 顺序执行开始
        
        Args:
            conversation_id: 会话ID
            skills_order: 执行顺序（skill 名称列表）
            routing_reason: 路由理由
        """
        self.logger.info(f"[MULTI-SKILL START] conv_id={conversation_id}")
        self.logger.info(f"  Skills Count: {len(skills_order)}")
        self.logger.info(f"  Execution Order: {' → '.join(skills_order)}")
        self.logger.info(f"  Routing Reason: {routing_reason}")
    
    def log_multi_skill_step_start(
        self,
        skill_index: int,
        skill_name: str,
        total_skills: int,
        current_memory_keys: List[str] = None
    ) -> None:
        """记录多 Skills 执行中单个 skill 开始
        
        Args:
            skill_index: 当前 skill 索引（从 0 开始）
            skill_name: Skill 名称
            total_skills: 总 skill 数量
            current_memory_keys: 当前 memory 中的 key 列表
        """
        step_info = f"({skill_index + 1}/{total_skills})"
        self.logger.info(f"[MULTI-SKILL STEP] {step_info} skill={skill_name}")
        if current_memory_keys:
            self.logger.info(f"  Memory Keys: {current_memory_keys}")
    
    def log_multi_skill_step_end(
        self,
        skill_index: int,
        skill_name: str,
        success: bool,
        output_keys: List[str] = None,
        error: str = None
    ) -> None:
        """记录多 Skills 执行中单个 skill 结束
        
        Args:
            skill_index: 当前 skill 索引
            skill_name: Skill 名称
            success: 是否成功
            output_keys: 输出的 key 列表
            error: 错误信息
        """
        status = "SUCCESS" if success else "FAILED"
        self.logger.info(f"[MULTI-SKILL STEP END] skill={skill_name}, status={status}")
        if output_keys:
            self.logger.info(f"  Output Keys: {output_keys}")
        if error:
            self.logger.info(f"  Error: {error}")
    
    def log_multi_skill_completed(
        self,
        conversation_id: str,
        skills_executed: List[str],
        total_steps: int,
        duration_ms: float,
        final_answer_preview: str = None
    ) -> None:
        """记录多 Skills 顺序执行完成
        
        Args:
            conversation_id: 会话ID
            skills_executed: 已执行的 skill 名称列表
            total_steps: 总步骤数
            duration_ms: 总耗时（毫秒）
            final_answer_preview: 最终回答预览
        """
        self.logger.info(f"[MULTI-SKILL COMPLETED] conv_id={conversation_id}")
        self.logger.info(f"  Skills Executed: {' → '.join(skills_executed)}")
        self.logger.info(f"  Total Steps: {total_steps}")
        self.logger.info(f"  Duration: {duration_ms:.0f}ms")
        if final_answer_preview:
            self.logger.info(f"  Final Answer Preview: {self._truncate(final_answer_preview, 300)}")
        self.log_separator()
    
    def log_multi_skill_error(
        self,
        conversation_id: str,
        skill_name: str,
        error: str,
        skills_completed: List[str] = None
    ) -> None:
        """记录多 Skills 执行中的错误
        
        Args:
            conversation_id: 会话ID
            skill_name: 出错的 skill 名称
            error: 错误信息
            skills_completed: 已成功完成的 skill 列表
        """
        self.logger.error(f"[MULTI-SKILL ERROR] conv_id={conversation_id}, skill={skill_name}")
        self.logger.error(f"  Error: {error}")
        if skills_completed:
            self.logger.error(f"  Skills Completed Before Error: {' → '.join(skills_completed)}")


# ========== Orchestrator 运行日志 ==========

def _inject_orchestrator_methods():
    def log_verification(
        self,
        conversation_id: str,
        verdict: str,
        reason: str,
        confidence: float,
        duration_ms: float,
        repair_triggered: bool,
        source: str = "",
        verification_model: str = "",
        model_output: str = "",
        user_question: str = "",
        answer_before: str = "",
        answer_after: str = "",
    ) -> None:
        self.logger.info(
            "[VERIFICATION] conv_id=%s, verdict=%s, source=%s, "
            "model=%s, "
            "confidence=%.2f, "
            "duration=%.0fms, repair=%s, len_before=%s, len_after=%s",
            conversation_id,
            verdict,
            source or "unknown",
            verification_model or "unknown",
            confidence,
            duration_ms,
            repair_triggered,
            len(answer_before or ""),
            len(answer_after or ""),
        )
        if reason:
            self.logger.info("  Reason: %s", self._truncate(reason, 300))
        if user_question:
            self.logger.info(
                "  User Question: %s",
                self._truncate(user_question, 260),
            )
        self.logger.info(
            "  Model Output: %s",
            self._truncate(model_output or "<empty>", 500),
        )

        if verdict in {"partial_success", "failure"}:
            issue_payload = {
                "conversation_id": conversation_id,
                "verdict": verdict,
                "reason": reason,
                "confidence": confidence,
                "duration_ms": round(duration_ms, 2),
                "repair_triggered": repair_triggered,
                "verification_model": verification_model or "unknown",
                "model_output_preview": self._truncate(model_output, 500),
                "user_question_preview": self._truncate(user_question, 300),
                "answer_before_preview": self._truncate(answer_before, 400),
                "answer_after_preview": self._truncate(answer_after, 400),
                "answer_before_len": len(answer_before or ""),
                "answer_after_len": len(answer_after or ""),
            }
            self.verification_issue_logger.warning(
                "[VERIFICATION ISSUE] %s",
                self._format_json(issue_payload),
            )
            self.verification_issue_logger.warning(
                "[VERIFICATION ISSUE TEXT] conv_id=%s, verdict=%s, repair=%s",
                conversation_id,
                verdict,
                repair_triggered,
            )
            self.verification_issue_logger.warning(
                "  User Question: %s",
                self._truncate(user_question or "<empty>", 500),
            )
            self.verification_issue_logger.warning(
                "  Before Text:\n%s",
                self._truncate(answer_before or "<empty>", 2000),
            )
            self.verification_issue_logger.warning(
                "  After Text:\n%s",
                self._truncate(answer_after or "<empty>", 2000),
            )

    def log_execution_plan_created(
        self,
        conversation_id: str,
        multi_skill_mode: bool,
        steps: List[Dict[str, Any]],
        routing_reason: str = "",
    ) -> None:
        self.logger.info(
            f"[PLAN CREATED] conv_id={conversation_id}, multi_skill={multi_skill_mode}, steps={len(steps)}"
        )
        if routing_reason:
            self.logger.info(f"  Routing Reason: {self._truncate(routing_reason, 300)}")
        for i, step in enumerate(steps, 1):
            self.logger.info(
                f"  Step {i}: id={step.get('step_id')}, skill={step.get('skill_name')}, final={step.get('is_final_step')}"
            )
            self.logger.info(f"    Goal: {self._truncate(str(step.get('goal', '')), 240)}")

    def log_step_started(
        self,
        conversation_id: str,
        step_index: int,
        total_steps: int,
        step_id: str,
        skill_name: str,
        goal: str,
    ) -> None:
        self.logger.info(
            f"[STEP STARTED] conv_id={conversation_id}, step={step_index + 1}/{total_steps}, step_id={step_id}, skill={skill_name}"
        )
        self.logger.info(f"  Goal: {self._truncate(goal, 260)}")

    def log_step_iteration(
        self,
        conversation_id: str,
        step_id: str,
        iteration: int,
        message_count: int,
        tool_calls_count: int,
    ) -> None:
        self.logger.info(
            f"[STEP ITERATION] conv_id={conversation_id}, step_id={step_id}, iteration={iteration}, messages={message_count}, tool_calls={tool_calls_count}"
        )

    def log_step_completed(
        self,
        conversation_id: str,
        step_index: int,
        total_steps: int,
        step_id: str,
        skill_name: str,
        success: bool,
        tool_calls_count: int = 0,
        sources_count: int = 0,
    ) -> None:
        status = "SUCCESS" if success else "FAILED"
        self.logger.info(
            f"[STEP COMPLETED] conv_id={conversation_id}, step={step_index + 1}/{total_steps}, step_id={step_id}, skill={skill_name}, status={status}"
        )
        self.logger.info(f"  Tool Calls: {tool_calls_count}, Sources: {sources_count}")

    def log_step_handoff(
        self,
        conversation_id: str,
        step_id: str,
        skill_name: str,
        handoff: Dict[str, Any],
    ) -> None:
        self.logger.info(
            f"[STEP HANDOFF] conv_id={conversation_id}, step_id={step_id}, skill={skill_name}"
        )
        self.logger.info(f"  Handoff: {self._truncate(self._format_json(handoff), 500)}")

    def log_step_failed(
        self,
        conversation_id: str,
        step_id: str,
        skill_name: str,
        error: str,
    ) -> None:
        self.logger.error(
            f"[STEP FAILED] conv_id={conversation_id}, step_id={step_id}, skill={skill_name}, error={error}"
        )

    def log_execution_plan_completed(
        self,
        conversation_id: str,
        success: bool,
        total_steps: int,
        total_iterations: int,
        duration_ms: float,
        skills_executed: Optional[List[str]] = None,
    ) -> None:
        status = "SUCCESS" if success else "FAILED"
        self.logger.info(
            f"[PLAN COMPLETED] conv_id={conversation_id}, status={status}, steps={total_steps}, iterations={total_iterations}, duration={duration_ms:.0f}ms"
        )
        if skills_executed:
            self.logger.info(f"  Skills Executed: {' -> '.join(skills_executed)}")

    SkillLogger.log_execution_plan_created = log_execution_plan_created
    SkillLogger.log_step_started = log_step_started
    SkillLogger.log_step_iteration = log_step_iteration
    SkillLogger.log_step_completed = log_step_completed
    SkillLogger.log_step_handoff = log_step_handoff
    SkillLogger.log_step_failed = log_step_failed
    SkillLogger.log_execution_plan_completed = log_execution_plan_completed
    SkillLogger.log_verification = log_verification


_inject_orchestrator_methods()

# 创建全局实例
skill_logger = SkillLogger()


# 便捷函数
def log_skill_routing(user_message: str, routing_result: Dict[str, Any]) -> None:
    """便捷函数：记录路由决策"""
    skill_logger.log_routing(user_message, routing_result)


def log_skill_context(skill_name: str, context_info: Dict[str, Any]) -> None:
    """便捷函数：记录上下文准备"""
    skill_logger.log_context_prepared(skill_name, context_info)


def log_skill_tool_call(tool_name: str, tool_args: Dict, skill_name: str = None, iteration: int = 1) -> None:
    """便捷函数：记录工具调用"""
    skill_logger.log_tool_call(tool_name, tool_args, skill_name, iteration)


def log_skill_response_completed(
    conversation_id: str,
    skill_name: Optional[str],
    total_iterations: int,
    duration_ms: float,
    sources_count: int = 0
) -> None:
    """便捷函数：记录响应完成"""
    skill_logger.log_response_completed(conversation_id, skill_name, total_iterations, duration_ms, sources_count)
