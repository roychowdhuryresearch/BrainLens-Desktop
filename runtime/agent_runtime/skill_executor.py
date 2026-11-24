"""Skill 执行器

解析 SKILL.md 的 workflow，逐步执行每个步骤。
每个步骤内部由 LLM 决定调用哪个 tool。
"""

import logging
import re
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set

from .state import RuntimeState
from .actions import ExecutionResult, SkillWorkflowStep, SkillConfig
from .exceptions import SkillExecutionException, WorkflowParseException

if TYPE_CHECKING:
    from .runtime import AgentRuntime

logger = logging.getLogger(__name__)


class SkillExecutor:
    """Skill 执行器
    
    解析 SKILL.md 的 workflow，逐步执行每个步骤。
    每个步骤内部由 LLM 决定调用哪个 tool。
    """
    
    def __init__(self, skill_package, runtime: "AgentRuntime"):
        """
        Args:
            skill_package: SkillPackage 对象
            runtime: AgentRuntime 实例
        """
        self.skill_package = skill_package
        self.runtime = runtime
        self.workflow_steps: List[SkillWorkflowStep] = []
        self._parse_workflow()
    
    def _parse_workflow(self) -> None:
        """从 SKILL.md 解析 workflow 步骤"""
        try:
            skill_content = self._get_skill_content()
            if not skill_content:
                raise WorkflowParseException(
                    skill_name=self.skill_package.name,
                    error="SKILL.md 内容为空"
                )
            
            self.workflow_steps = self._extract_workflow_steps(skill_content)
            
            if not self.workflow_steps:
                # 如果没有明确的 workflow，创建一个默认步骤
                self.workflow_steps = [
                    SkillWorkflowStep(
                        step_id=1,
                        title="执行 Skill",
                        description=f"执行 {self.skill_package.name} skill",
                        suggested_tools=[]
                    )
                ]
            
            logger.info(f"Skill '{self.skill_package.name}' 解析出 {len(self.workflow_steps)} 个 workflow 步骤")
            
        except WorkflowParseException:
            raise
        except Exception as e:
            raise WorkflowParseException(
                skill_name=self.skill_package.name,
                error=str(e)
            )
    
    def _get_skill_content(self) -> str:
        """获取 SKILL.md 内容"""
        # SkillPackage 可能有不同的属性存储内容
        if hasattr(self.skill_package, 'content'):
            return self.skill_package.content
        elif hasattr(self.skill_package, 'skill_content'):
            return self.skill_package.skill_content
        elif hasattr(self.skill_package, 'markdown_content'):
            return self.skill_package.markdown_content
        else:
            # 尝试读取文件
            try:
                import os
                skill_path = getattr(self.skill_package, 'path', None)
                if skill_path:
                    skill_file = os.path.join(skill_path, 'SKILL.md')
                    if os.path.exists(skill_file):
                        with open(skill_file, 'r', encoding='utf-8') as f:
                            return f.read()
            except Exception as e:
                logger.warning(f"无法读取 SKILL.md 文件: {e}")
        
        return ""
    
    def _extract_workflow_steps(self, content: str) -> List[SkillWorkflowStep]:
        """从内容中提取 workflow 步骤"""
        steps = []
        
        # 查找 Workflow 或 Steps 部分
        workflow_section = self._find_workflow_section(content)
        
        if workflow_section:
            # 解析步骤列表
            steps = self._parse_steps_from_section(workflow_section)
        
        # 如果没有找到明确的 workflow，尝试从标题解析
        if not steps:
            steps = self._parse_steps_from_headings(content)
        
        return steps
    
    def _find_workflow_section(self, content: str) -> str:
        """查找 workflow 部分"""
        # 尝试匹配 ## Workflow 或 ## Steps 等标题
        patterns = [
            r'##\s*[Ww]orkflow\s*\n([\s\S]*?)(?=\n##|\Z)',
            r'##\s*[Ss]teps\s*\n([\s\S]*?)(?=\n##|\Z)',
            r'##\s*[Ee]xecution\s*[Pp]lan\s*\n([\s\S]*?)(?=\n##|\Z)',
            r'##\s*执行步骤\s*\n([\s\S]*?)(?=\n##|\Z)',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, content)
            if match:
                return match.group(1)
        
        return ""
    
    def _parse_steps_from_section(self, section: str) -> List[SkillWorkflowStep]:
        """从 section 解析步骤"""
        steps = []
        
        # 匹配数字编号的步骤 (1. xxx 或 1) xxx)
        step_pattern = r'(?:^|\n)\s*(\d+)[.、)]\s*(.+?)(?=(?:\n\s*\d+[.、)])|\Z)'
        matches = re.findall(step_pattern, section, re.DOTALL)
        
        for i, (step_num, step_content) in enumerate(matches):
            step_content = step_content.strip()
            if step_content:
                # 尝试分离标题和描述
                lines = step_content.split('\n')
                title = lines[0].strip()
                description = '\n'.join(lines[1:]).strip() if len(lines) > 1 else title
                
                # 提取建议的工具
                suggested_tools = self._extract_suggested_tools(step_content)
                
                steps.append(SkillWorkflowStep(
                    step_id=int(step_num) if step_num else i + 1,
                    title=title,
                    description=description,
                    suggested_tools=suggested_tools
                ))
        
        return steps
    
    def _parse_steps_from_headings(self, content: str) -> List[SkillWorkflowStep]:
        """从标题解析步骤"""
        steps = []
        
        # 匹配 ### 或 #### 标题
        heading_pattern = r'(?:^|\n)(#{2,4})\s+(\d+\.?\s*)?(.+?)(?=\n|$)'
        matches = re.findall(heading_pattern, content)
        
        for i, (level, num, title) in enumerate(matches):
            title = title.strip()
            if title and not title.lower().startswith(('overview', 'description', '概述', '描述')):
                steps.append(SkillWorkflowStep(
                    step_id=i + 1,
                    title=title,
                    description=title,
                    suggested_tools=[]
                ))
        
        return steps
    
    def _extract_suggested_tools(self, text: str) -> List[str]:
        """从文本中提取建议的工具名称"""
        tools = []
        
        # 匹配工具名称（假设工具名称格式为 tool_name 或 `tool_name`）
        tool_pattern = r'`([a-zA-Z_][a-zA-Z0-9_]*)`'
        matches = re.findall(tool_pattern, text)
        
        for match in matches:
            if match not in tools and not match.startswith('STEP'):
                tools.append(match)
        
        return tools
    
    async def execute(
        self,
        state: RuntimeState,
        visited: Set[str] = None
    ) -> ExecutionResult:
        """执行整个 skill workflow
        
        Args:
            state: 运行时状态
            visited: 已访问的 skill 集合（防止循环调用）
        
        Returns:
            ExecutionResult: 执行结果
        """
        visited = visited or set()
        skill_name = self.skill_package.name
        
        # 防止循环调用
        if skill_name in visited:
            return ExecutionResult.error_result(
                error=f"检测到循环调用 skill: {skill_name}",
                message="Skill 调用循环"
            )
        visited.add(skill_name)
        
        # 保存当前 skill 上下文
        prev_skill_name = state.active_skill_name
        prev_step_index = state.skill_step_index
        
        # 设置当前 skill 上下文
        state.active_skill_name = skill_name
        
        # 记录 skill 开始
        state.add_trace_event("skill_step_start", {
            "skill_name": skill_name,
            "total_steps": len(self.workflow_steps)
        })
        
        try:
            # 逐步执行 workflow
            for i, step in enumerate(self.workflow_steps):
                state.skill_step_index = i
                
                logger.info(f"执行 Skill '{skill_name}' 步骤 {i+1}/{len(self.workflow_steps)}: {step.title}")
                
                # 执行单个步骤
                result = await self.execute_step(step, state, visited)
                
                if not result.success:
                    # 步骤失败
                    state.add_trace_event("skill_step_end", {
                        "skill_name": skill_name,
                        "step_index": i,
                        "success": False,
                        "error": result.error
                    })
                    return result
                
                if result.should_terminate:
                    # 步骤要求终止
                    state.add_trace_event("skill_step_end", {
                        "skill_name": skill_name,
                        "step_index": i,
                        "success": True,
                        "terminated": True
                    })
                    return result
            
            # 所有步骤成功完成
            state.add_trace_event("skill_step_end", {
                "skill_name": skill_name,
                "success": True,
                "completed_steps": len(self.workflow_steps)
            })
            
            return ExecutionResult.success_result(
                message=f"Skill '{skill_name}' 执行完成",
                output={"skill_name": skill_name, "steps_completed": len(self.workflow_steps)}
            )
            
        except Exception as e:
            logger.error(f"Skill '{skill_name}' 执行异常: {e}")
            return ExecutionResult.error_result(
                error=str(e),
                message=f"Skill '{skill_name}' 执行异常"
            )
        finally:
            # 恢复之前的 skill 上下文
            state.active_skill_name = prev_skill_name
            state.skill_step_index = prev_step_index
    
    async def execute_step(
        self,
        step: SkillWorkflowStep,
        state: RuntimeState,
        visited: Set[str]
    ) -> ExecutionResult:
        """执行单个 workflow 步骤
        
        每个步骤内部由 LLM 决定调用哪个 tool/sub-skill。
        """
        # 记录步骤开始
        state.add_trace_event("skill_step_start", {
            "step_id": step.step_id,
            "title": step.title,
            "suggested_tools": step.suggested_tools
        })
        
        try:
            # 获取可用的工具和 skills
            available_tools = self._get_available_tools(step)
            available_skills = self._get_available_skills()
            
            # 让 LLM 决定下一步
            decision = await self.runtime.llm_decision.select_next_action(
                state,
                available_tools,
                available_skills
            )
            
            # 验证决策
            self.runtime.llm_decision.validate_action_decision(
                decision,
                self.runtime.tool_registry,
                self.runtime.skill_registry
            )
            
            # 执行决策
            if decision.is_finish():
                return ExecutionResult.terminate_result(
                    message=f"步骤 '{step.title}' 完成，LLM 决定结束"
                )
            
            result = await self.runtime.dispatch_action(decision, state, visited)
            
            # 记录历史
            state.add_history({
                "step_id": step.step_id,
                "action_type": decision.action_type,
                "action_name": decision.action_name,
                "success": result.success,
                "message": result.message
            })
            
            return result
            
        except Exception as e:
            logger.error(f"步骤 '{step.title}' 执行异常: {e}")
            return ExecutionResult.error_result(
                error=str(e),
                message=f"步骤 '{step.title}' 执行失败"
            )
    
    def _get_available_tools(self, step: SkillWorkflowStep) -> List[Dict[str, Any]]:
        """获取可用的工具列表"""
        tools = []
        
        # 获取所有 MCP 工具
        all_tools = self.runtime.get_available_tools()
        
        if step.suggested_tools:
            # 如果有建议工具，优先显示
            for tool in all_tools:
                tool_name = tool.get("name", "")
                if tool_name in step.suggested_tools:
                    tools.insert(0, tool)  # 建议工具放前面
                else:
                    tools.append(tool)
        else:
            tools = all_tools
        
        return tools
    
    def _get_available_skills(self) -> List[Dict[str, Any]]:
        """获取可用的 skills 列表"""
        return self.runtime.get_available_skills()
    
    @classmethod
    def from_config(cls, config: SkillConfig, runtime: "AgentRuntime") -> "SkillExecutor":
        """从配置创建执行器"""
        skill_package = runtime.skill_registry.get_skill(config.skill_name)
        if not skill_package:
            raise SkillExecutionException(
                skill_name=config.skill_name,
                error="Skill 不存在"
            )
        return cls(skill_package, runtime)