"""Agent Runtime 核心类

顺序执行 Agent Runtime，管理主循环，调用 LLM 选择下一步 action，
执行 action（tool/skill），管理 retry/fallback，更新 state，记录 trace/history，finalize 输出。

支持：
1. 单 skill 执行模式
2. 多 skills 顺序执行模式（LLM 规划顺序）
3. VL Tool 图片分析
"""

import logging
from typing import Any, Dict, List, Optional, Set

from .state import RuntimeState
from .actions import ActionDecision, ExecutionResult, ToolConfig, SkillConfig
from .exceptions import (
    MaxStepsExceededException,
    ToolExecutionException,
    SkillExecutionException,
    LLMDecisionException,
    ActionValidationException
)
from .tool_wrapper import ToolWrapper
from .llm_decision import LLMDecisionMaker
from .skill_executor import SkillExecutor
from .image_reference_store import ImageReferenceStore
from .vl_tool import VLQueryTool, get_vl_tool_definition, create_vl_tool
from runtime.skills.skill_logger import skill_logger

logger = logging.getLogger(__name__)


class AgentRuntime:
    """顺序执行 Agent Runtime
    
    核心职责：
    - 管理主循环
    - 调用 LLM 选择下一步 action
    - 执行 action（tool/skill）
    - 管理 retry/fallback
    - 更新 state
    - 记录 trace/history
    - finalize 输出
    """
    
    def __init__(
        self,
        ai_service,
        mcp_manager,
        skill_registry,
        max_steps: int = 10,
        vlm_config=None
    ):
        """
        Args:
            ai_service: AI 服务实例
            mcp_manager: MCP Manager 实例
            skill_registry: Skill Registry 实例
            max_steps: 最大步数限制
            vlm_config: VLM 配置（可选）
        """
        self.ai_service = ai_service
        self.mcp_manager = mcp_manager
        self.skill_registry = skill_registry
        self.max_steps = max_steps
        
        # LLM 决策模块
        self.llm_decision = LLMDecisionMaker(ai_service)
        
        # Tool 配置（retry/fallback）
        self.tool_configs: Dict[str, ToolConfig] = {}
        
        # Skill 配置（retry/fallback）
        self.skill_configs: Dict[str, SkillConfig] = {}
        
        # Tool 注册表（用于验证）
        self.tool_registry: Dict[str, Any] = {}
        
        # Skill 注册表（用于验证）
        self.skill_registry_dict: Dict[str, Any] = {}
        
        # VL (Vision Language) 组件
        self.vlm_config = vlm_config
        self.vl_tool: Optional[VLQueryTool] = None
        self.image_store: Optional[ImageReferenceStore] = None
        
        # 初始化 VL 组件
        self._init_vl_components()
    
    def _init_vl_components(self) -> None:
        """初始化 VL 组件"""
        if self.vlm_config:
            try:
                self.vl_tool = create_vl_tool(self.vlm_config)
                self.image_store = ImageReferenceStore()
                if self.vl_tool:
                    logger.info("[Runtime] VL Tool initialized successfully")
            except Exception as e:
                logger.warning(f"[Runtime] Failed to initialize VL Tool: {e}")
    
    def is_vl_enabled(self) -> bool:
        """检查 VL 功能是否启用"""
        return self.vl_tool is not None
    
    def get_image_store(self) -> Optional[ImageReferenceStore]:
        """获取图片引用存储"""
        return self.image_store
    
    def configure_tool(
        self,
        tool_name: str,
        max_retries: int = 0,
        fallback_tool_name: Optional[str] = None,
        retry_delay: float = 1.0
    ) -> None:
        """配置 tool 的 retry/fallback 策略"""
        self.tool_configs[tool_name] = ToolConfig(
            tool_name=tool_name,
            max_retries=max_retries,
            fallback_tool_name=fallback_tool_name,
            retry_delay=retry_delay
        )
    
    def configure_skill(
        self,
        skill_name: str,
        max_retries: int = 0,
        fallback_skill_name: Optional[str] = None,
        retry_delay: float = 1.0
    ) -> None:
        """配置 skill 的 retry/fallback 策略"""
        self.skill_configs[skill_name] = SkillConfig(
            skill_name=skill_name,
            max_retries=max_retries,
            fallback_skill_name=fallback_skill_name,
            retry_delay=retry_delay
        )
    
    async def run(self, user_input: str) -> RuntimeState:
        """主入口，执行主循环（单 skill 模式)
        
        Args:
            user_input: 用户原始输入
        
        Returns:
            RuntimeState: 最终状态
        """
        # 初始化状态
        state = RuntimeState(
            user_input=user_input,
            max_steps=self.max_steps
        )
        
        # 初始化 tool/skill 注册表
        await self._initialize_registries()
        
        logger.info(f"Agent Runtime 开始执行，用户输入: {user_input[:100]}...")
        
        try:
            # 主循环
            while not state.is_done():
                state.increment_step()
                
                logger.info(f"执行步骤 {state.current_step}/{state.max_steps}")
                
                # 记录步骤开始
                state.add_trace_event("step_start", {
                    "step": state.current_step
                })
                
                # LLM 选择下一步 action
                try:
                    decision = await self.select_next_action(state)
                except LLMDecisionException as e:
                    logger.error(f"LLM 决策失败: {e}")
                    state.set_error(str(e))
                    break
                
                # 检查是否完成
                if decision.is_finish():
                    logger.info(f"LLM 决定结束: {decision.reason}")
                    state.set_final_answer(decision.reason or "任务完成")
                    break
                
                # 执行 action
                result = await self.dispatch_action(decision, state)
                
                # 应用结果到状态
                self.apply_result_to_state(decision, result, state)
                
                # 检查是否需要终止
                if result.should_terminate:
                    logger.info("Action 要求终止执行")
                    break
                
                # 记录步骤结束
                state.add_trace_event("step_end", {
                    "step": state.current_step,
                    "success": result.success
                })
            
            # 检查是否超过最大步数
            if state.current_step >= state.max_steps and not state.done:
                logger.warning(f"超过最大步数限制: {state.max_steps}")
                state.set_error(f"超过最大步数限制: {state.max_steps}")
            
            # 生成最终回答
            final_answer = await self.finalize(state)
            if final_answer and not state.final_answer:
                state.set_final_answer(final_answer)
            
        except Exception as e:
            logger.error(f"Runtime 执行异常: {e}")
            state.set_error(str(e))
            state.add_trace_event("error", {
                "error": str(e),
                "step": state.current_step
            })
        
        logger.info(f"Agent Runtime 执行完成，步数: {state.current_step}")
        return state
    
    async def run_with_ordered_skills(
        self,
        user_input: str,
        ordered_skills: List[Any],
        routing_reason: str = "",
        conversation_id: str = "unknown"
    ) -> RuntimeState:
        """多 Skills 顺序执行模式
        
        LLM 已经规划好了执行顺序，这个方法按顺序依次执行每个 skill。
        
        Args:
            user_input: 用户原始输入
            ordered_skills: 按顺序排列的 SkillPackage 列表
            routing_reason: 路由理由
            conversation_id: 会话ID（用于日志）
        
        Returns:
            RuntimeState: 最终状态
        """
        import time
        start_time = time.time()
        
        # 初始化状态
        state = RuntimeState(
            user_input=user_input,
            max_steps=self.max_steps
        )
        
        # 初始化 tool/skill 注册表
        await self._initialize_registries()
        
        # 提取 skill 名称列表
        skill_names = [s.name if hasattr(s, 'name') else str(s) for s in ordered_skills]
        
        logger.info(f"Agent Runtime 开始执行（多 Skills 模式）， 用户输入: {user_input[:100]}...")
        logger.info(f"计划执行 {len(ordered_skills)} 个 skills: {skill_names}")
        
        # 记录多 skills 执行开始（写入 skills.log）
        skill_logger.log_multi_skill_start(
            conversation_id=conversation_id,
            skills_order=skill_names,
            routing_reason=routing_reason
        )
        
        # 记录已完成的 skills
        completed_skills = []
        
        try:
            # 记录路由信息
            state.add_trace_event("multi_skill_start", {
                "skills_count": len(ordered_skills),
                "skills_order": skill_names,
                "routing_reason": routing_reason
            })
            
            # 按顺序执行每个 skill
            for i, skill in enumerate(ordered_skills):
                skill_name = skill_names[i]
                
                logger.info(f"执行 Skill {i+1}/{len(ordered_skills)}: {skill_name}")
                
                # 记录单个 skill 执行开始
                skill_logger.log_multi_skill_step_start(
                    skill_index=i,
                    skill_name=skill_name,
                    total_skills=len(ordered_skills),
                    current_memory_keys=list(state.memory.keys()) if state.memory else None
                )
                
                state.add_trace_event("skill_execution_start", {
                    "skill_index": i,
                    "skill_name": skill_name,
                    "remaining": len(ordered_skills) - i - 1
                })
                
                # 执行 skill
                result = await self.execute_skill_by_name(skill_name, state)
                
                # 记录单个 skill 执行结束
                skill_logger.log_multi_skill_step_end(
                    skill_index=i,
                    skill_name=skill_name,
                    success=result.success,
                    output_keys=list(result.output.keys()) if result.output else None,
                    error=result.error if not result.success else None
                )
                
                state.add_trace_event("skill_execution_end", {
                    "skill_index": i,
                    "skill_name": skill_name,
                    "success": result.success
                })
                
                # 记录执行历史
                state.add_history({
                    "action_type": "skill",
                    "action_name": skill_name,
                    "success": result.success,
                    "message": result.message,
                    "step": state.current_step,
                    "skill_index": i + 1
                })
                
                # 如果执行失败，决定是否继续
                if not result.success:
                    logger.warning(f"Skill {skill_name} 执行失败: {result.error}")
                    # 可以选择继续执行下一个 skill 或终止
                    # 这里我们选择继续执行，让后续 skill 有机会处理
                
                    # 应用结果到状态（即使失败也可能有部分输出）
                    if result.output:
                        self._safe_merge_memory(state, result.output)
                else:
                    # 成功时也合并输出
                    if result.output:
                        self._safe_merge_memory(state, result.output)
                    completed_skills.append(skill_name)
            
            # 所有 skills 执行完成
            logger.info(f"所有 {len(ordered_skills)} 个 skills 执行完成")
            
            # 生成最终回答
            final_answer = await self.finalize(state)
            if final_answer and not state.final_answer:
                state.set_final_answer(final_answer)
            
            state.add_trace_event("multi_skill_complete", {
                "total_skills": len(ordered_skills),
                "final_step": state.current_step
            })
            
            # 计算总耗时
            duration_ms = (time.time() - start_time) * 1000
            
            # 记录多 skills 执行完成（写入 skills.log）
            skill_logger.log_multi_skill_completed(
                conversation_id=conversation_id,
                skills_executed=skill_names,
                total_steps=state.current_step,
                duration_ms=duration_ms,
                final_answer_preview=state.final_answer
            )
            
        except Exception as e:
            logger.error(f"Runtime 执行异常: {e}")
            state.set_error(str(e))
            state.add_trace_event("error", {
                "error": str(e),
                "step": state.current_step
            })
            
            # 记录多 skills 执行错误
            skill_logger.log_multi_skill_error(
                conversation_id=conversation_id,
                skill_name=skill_names[len(completed_skills)] if len(completed_skills) < len(skill_names) else "unknown",
                error=str(e),
                skills_completed=completed_skills if completed_skills else None
            )
        
        logger.info(f"Agent Runtime 执行完成，步数: {state.current_step}")
        return state
    
    async def select_next_action(self, state: RuntimeState) -> ActionDecision:
        """LLM 决定下一步 action"""
        available_tools = self.get_available_tools()
        available_skills = self.get_available_skills()
        
        decision = await self.llm_decision.select_next_action(
            state,
            available_tools,
            available_skills
        )
        
        # 验证决策
        self.llm_decision.validate_action_decision(
            decision,
            self.tool_registry,
            self.skill_registry_dict
        )
        
        return decision
    
    async def dispatch_action(
        self,
        decision: ActionDecision,
        state: RuntimeState,
        visited: Set[str] = None
    ) -> ExecutionResult:
        """分发执行 action"""
        visited = visited or set()
        
        state.add_trace_event("execute_action_start", {
            "action_type": decision.action_type,
            "action_name": decision.action_name,
            "parameters": decision.parameters
        })
        
        try:
            if decision.is_tool():
                result = await self.execute_tool_by_name(
                    decision.action_name,
                    state,
                    decision.parameters,
                    visited
                )
            elif decision.is_skill():
                result = await self.execute_skill_by_name(
                    decision.action_name,
                    state,
                    visited
                )
            else:
                result = ExecutionResult.error_result(
                    error=f"未知的 action 类型: {decision.action_type}"
                )
            
            # 记录执行历史
            state.add_history({
                "action_type": decision.action_type,
                "action_name": decision.action_name,
                "success": result.success,
                "message": result.message,
                "step": state.current_step
            })
            
            state.add_trace_event("execute_action_end", {
                "action_type": decision.action_type,
                "action_name": decision.action_name,
                "success": result.success
            })
            
            return result
            
        except Exception as e:
            logger.error(f"执行 action 失败: {e}")
            return ExecutionResult.error_result(
                error=str(e),
                message=f"执行 {decision.action_type}/{decision.action_name} 失败"
            )
    
    async def execute_tool_by_name(
        self,
        tool_name: str,
        state: RuntimeState,
        parameters: Dict[str, Any] = None,
        visited: Set[str] = None
    ) -> ExecutionResult:
        """执行 tool（含 retry/fallback）"""
        visited = visited or set()
        parameters = parameters or {}
        
        # 特殊处理 VL Tool
        if tool_name == "vl_query":
            return await self._execute_vl_tool(state, parameters)

        # 获取 tool 配置
        config = self.tool_configs.get(tool_name, ToolConfig(tool_name=tool_name))
        
        # 创建包装器
        wrapper = ToolWrapper.from_config(config, self.mcp_manager)
        
        # 执行
        return await wrapper.run(state, parameters, visited)
    
    async def _execute_vl_tool(
        self,
        state: RuntimeState,
        parameters: Dict[str, Any]
    ) -> ExecutionResult:
        """执行 VL Tool"""
        if not self.is_vl_enabled() or not self.vl_tool:
            return ExecutionResult.error_result(
                error="VL Tool 未启用或未初始化"
            )
        
        try:
            result = await self.vl_tool.execute(
                parameters=parameters,
                state=state,
                image_store=self.image_store
            )
            
            if result.get("success"):
                return ExecutionResult.success_result(
                    output={"vl_analysis": result.get("result", "")},
                    message=f"图片分析完成: {result.get('image_ref')}"
                )
            else:
                return ExecutionResult.error_result(
                    error=result.get("error", "VL 分析失败")
                )
                
        except Exception as e:
            logger.error(f"VL Tool 执行异常: {e}")
            return ExecutionResult.error_result(
                error=f"VL Tool 执行异常: {str(e)}"
            )
    
    async def execute_skill_by_name(
        self,
        skill_name: str,
        state: RuntimeState,
        visited: Set[str] = None
    ) -> ExecutionResult:
        """执行 skill（含 retry/fallback）"""
        visited = visited or set()
        
        skill_package = self._get_skill_package(skill_name)
        if not skill_package:
            return ExecutionResult.error_result(
                error=f"Skill '{skill_name}' 不存在"
            )
        
        executor = SkillExecutor(skill_package, self)
        
        result = await executor.execute(state, visited)
        
        if not result.success:
            config = self.skill_configs.get(skill_name)
            if config and config.fallback_skill_name:
                logger.info(f"Skill '{skill_name}' 失败，尝试 fallback: {config.fallback_skill_name}")
                state.add_trace_event("fallback", {
                    "from_skill": skill_name,
                    "to_skill": config.fallback_skill_name,
                    "reason": result.error
                })
                
                fallback_executor = SkillExecutor(
                    self._get_skill_package(config.fallback_skill_name),
                    self
                )
                result = await fallback_executor.execute(state, visited)
        
        return result
    
    def apply_result_to_state(
        self,
        decision: ActionDecision,
        result: ExecutionResult,
        state: RuntimeState
    ) -> None:
        """更新 state"""
        if result.success and result.output:
            # 安全合并 memory
            self._safe_merge_memory(state, result.output)
        
        if not result.success and result.error:
            state.set_error(result.error)
    
    async def finalize(self, state: RuntimeState) -> str:
        """生成最终回答"""
        state.add_trace_event("finalize_start", {
            "step": state.current_step
        })
        
        try:
            # 如果已经有最终回答，直接返回
            if state.final_answer:
                return state.final_answer
            
            # 构建总结 prompt
            prompt = self._build_finalize_prompt(state)
            
            # 调用 LLM 生成最终回答
            final_answer = await self.ai_service.chat_completion(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.3
            )
            
            state.add_trace_event("finalize_end", {
                "final_answer_length": len(final_answer) if final_answer else 0
            })
            
            return final_answer
            
        except Exception as e:
            logger.error(f"生成最终回答失败: {e}")
            # 返回简单的总结
            if state.memory:
                return f"任务执行完成。收集到 {len(state.memory)} 条数据。"
            else:
                return "任务执行完成。"
    
    def get_available_tools(self) -> List[Dict[str, Any]]:
        """获取可用的工具列表"""
        tools = []
        
        try:
            # 从 MCP Manager 获取工具列表
            if hasattr(self.mcp_manager, 'list_tools'):
                mcp_tools = self.mcp_manager.list_tools()
                for tool in mcp_tools:
                    tools.append({
                        "name": tool.get("name", ""),
                        "description": tool.get("description", "")
                    })
                    # 更新 tool 注册表
                    self.tool_registry[tool.get("name", "")] = tool
        except Exception as e:
            logger.warning(f"获取工具列表失败: {e}")
        
        # 添加 VL Tool（如果启用）
        if self.is_vl_enabled():
            vl_tool_def = get_vl_tool_definition()
            tools.append({
                "name": vl_tool_def["function"]["name"],
                "description": vl_tool_def["function"]["description"]
            })
            # 更新 tool 注册表
            self.tool_registry[vl_tool_def["function"]["name"]] = vl_tool_def

        return tools
    
    def get_available_skills(self) -> List[Dict[str, Any]]:
        """获取可用的 skills 列表"""
        skills = []
        
        try:
            # 从 Skill Registry 获取 skill 列表
            if hasattr(self.skill_registry, 'list_skills'):
                skill_list = self.skill_registry.list_skills()
                for skill in skill_list:
                    skill_name = getattr(skill, 'name', str(skill))
                    skill_desc = getattr(skill, 'description', '')
                    skills.append({
                        "name": skill_name,
                        "description": skill_desc
                    })
                    # 更新 skill 注册表
                    self.skill_registry_dict[skill_name] = skill
        except Exception as e:
            logger.warning(f"获取 skill 列表失败: {e}")
        
        return skills
    
    async def _initialize_registries(self) -> None:
        """初始化注册表"""
        # 初始化 tool 注册表
        self.get_available_tools()
        
        # 初始化 skill 注册表
        self.get_available_skills()
    
    def _get_skill_package(self, skill_name: str):
        """获取 skill package"""
        if hasattr(self.skill_registry, 'get_skill'):
            return self.skill_registry.get_skill(skill_name)
        return self.skill_registry_dict.get(skill_name)
    
    def _safe_merge_memory(self, state: RuntimeState, output: Dict[str, Any]) -> None:
        """安全合并 memory"""
        if not output:
            return
        
        for key, value in output.items():
            if key and value is not None:
                state.memory[key] = value
    
    def _build_finalize_prompt(self, state: RuntimeState) -> str:
        """构建总结 prompt"""
        history_summary = self._build_history_summary(state.history)
        memory_summary = self._build_memory_summary(state.memory)
        
        prompt = f"""请根据执行结果，生成对用户问题的最终回答。

## 用户原始问题
{state.user_input}

## 收集的数据
{memory_summary}

## 执行历史
{history_summary}

## 要求
1. 回答要简洁明了
2. 如果收集到了数据，要展示关键信息
3. 如果执行过程中有错误，要说明
4. 使用中文回答

请直接给出最终回答：
"""
        return prompt
    
    def _build_history_summary(self, history: List[Dict[str, Any]]) -> str:
        """构建历史摘要"""
        if not history:
            return "暂无执行历史"
        
        lines = []
        for event in history:
            action_type = event.get("action_type", "unknown")
            action_name = event.get("action_name", "unknown")
            success = event.get("success", False)
            status = "成功" if success else "失败"
            lines.append(f"- {action_type}/{action_name}: {status}")
        
        return "\n".join(lines)
    
    def _build_memory_summary(self, memory: Dict[str, Any]) -> str:
        """构建内存摘要"""
        if not memory:
            return "暂无收集数据"
        
        lines = []
        for key, value in memory.items():
            if isinstance(value, str) and len(value) > 300:
                value = value[:300] + "..."
            lines.append(f"- **{key}**: {value}")
        
        return "\n".join(lines)
