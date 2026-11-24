"""LLM 决策接口

构建 prompt，调用 LLM，解析 JSON 响应。
"""

import json
import logging
import re
from typing import Any, Dict, List, Optional

from .state import RuntimeState
from .actions import ActionDecision
from .exceptions import LLMDecisionException, ActionValidationException

logger = logging.getLogger(__name__)


class LLMDecisionMaker:
    """LLM 决策接口
    
    构建 prompt，调用 LLM，解析 JSON 响应。
    """
    
    def __init__(self, ai_service):
        """
        Args:
            ai_service: AI 服务实例
        """
        self.ai_service = ai_service
    
    async def select_next_action(
        self,
        state: RuntimeState,
        available_tools: List[Dict[str, Any]],
        available_skills: List[Dict[str, Any]]
    ) -> ActionDecision:
        """让 LLM 决定下一步 action
        
        Args:
            state: 运行时状态
            available_tools: 可用工具列表
            available_skills: 可用 skill 列表
        
        Returns:
            ActionDecision: LLM 的决策
        """
        # 记录决策开始
        state.add_trace_event("select_action_start", {
            "step": state.current_step,
            "available_tools_count": len(available_tools),
            "available_skills_count": len(available_skills)
        })
        
        try:
            # 构建决策 prompt
            prompt = self.build_decision_prompt(state, available_tools, available_skills)
            
            # 调用 LLM
            response = await self._call_llm(prompt)
            
            # 解析响应
            decision = self.parse_decision_response(response)
            
            # 记录决策结束
            state.add_trace_event("select_action_end", {
                "decision": decision.to_dict()
            })
            
            return decision
            
        except LLMDecisionException:
            raise
        except Exception as e:
            raise LLMDecisionException(
                error=f"Decision process failed: {str(e)}",
                raw_response=str(e)
            )
    
    def build_decision_prompt(
        self,
        state: RuntimeState,
        available_tools: List[Dict[str, Any]],
        available_skills: List[Dict[str, Any]]
    ) -> str:
        """构建决策 prompt"""
        
        # 构建历史摘要
        history_summary = self._build_history_summary(state.history)
        
        # 构建工具列表
        tools_desc = self._build_tools_description(available_tools)
        
        # 构建 skill 列表
        skills_desc = self._build_skills_description(available_skills)
        
        # 构建当前内存状态
        memory_desc = self._build_memory_description(state.memory)
        
        prompt = f"""You are a decision module for an Agent runtime. Decide the next action from the current state.

## User input
{state.user_input}

## Current state
- Step: {state.current_step}/{state.max_steps}
- Active Skill: {state.active_skill_name or 'none'}
- Skill step index: {state.skill_step_index}

## Working memory
{memory_desc}

## Execution history
{history_summary}

## Available tools
{tools_desc}

## Available Skills
{skills_desc}

## Decision requirements
Choose one action based on the current state:
1. If a tool is needed, choose action_type "tool" and specify the tool name.
2. If a Skill is needed, choose action_type "skill" and specify the Skill name.
3. If the task is complete, choose "FINISH".

Return the decision as JSON:
```json
{{
    "action_type": "tool" | "skill" | "FINISH",
    "action_name": "tool_or_skill_name; FINISH when action_type is FINISH",
    "reason": "reason for the choice",
    "parameters": {{}}
}}
```

Return JSON only, with no extra text.
"""
        return prompt
    
    def parse_decision_response(self, response: str) -> ActionDecision:
        """解析 LLM JSON 响应"""
        try:
            # 尝试提取 JSON
            json_str = self._extract_json(response)
            
            if not json_str:
                raise LLMDecisionException(
                    error="Could not extract JSON from response",
                    raw_response=response
                )
            
            data = json.loads(json_str)
            
            # 验证必要字段
            action_type = data.get("action_type")
            action_name = data.get("action_name")
            
            if not action_type:
                raise LLMDecisionException(
                    error="Missing action_type field",
                    raw_response=response
                )
            
            if not action_name:
                raise LLMDecisionException(
                    error="Missing action_name field",
                    raw_response=response
                )
            
            # 验证 action_type
            valid_types = ["tool", "skill", "FINISH"]
            if action_type not in valid_types:
                raise LLMDecisionException(
                    error=f"Invalid action_type: {action_type}; valid values: {valid_types}",
                    raw_response=response
                )
            
            return ActionDecision(
                action_type=action_type,
                action_name=action_name,
                reason=data.get("reason", ""),
                parameters=data.get("parameters", {})
            )
            
        except json.JSONDecodeError as e:
            raise LLMDecisionException(
                error=f"JSON parse failed: {str(e)}",
                raw_response=response
            )
    
    def validate_action_decision(
        self,
        decision: ActionDecision,
        tool_registry: Dict[str, Any],
        skill_registry: Dict[str, Any]
    ) -> bool:
        """验证 action 有效性"""
        if decision.is_finish():
            return True
        
        if decision.is_tool():
            if decision.action_name not in tool_registry:
                raise ActionValidationException(
                    action_type="tool",
                    action_name=decision.action_name,
                    reason="Tool does not exist"
                )
            return True
        
        if decision.is_skill():
            if decision.action_name not in skill_registry:
                raise ActionValidationException(
                    action_type="skill",
                    action_name=decision.action_name,
                    reason="Skill does not exist"
                )
            return True
        
        raise ActionValidationException(
            action_type=decision.action_type,
            action_name=decision.action_name,
            reason="Unknown action_type"
        )
    
    async def _call_llm(self, prompt: str) -> str:
        """调用 LLM"""
        try:
            # 使用 ai_service 的方法调用 LLM
            response = await self.ai_service.chat_completion(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1  # 低温度以获得更确定性的决策
            )
            return response
        except Exception as e:
            logger.error(f"LLM call failed: {e}")
            raise LLMDecisionException(
                error=f"LLM call failed: {str(e)}"
            )
    
    def _extract_json(self, text: str) -> Optional[str]:
        """从文本中提取 JSON"""
        # 尝试匹配 ```json ... ``` 块
        json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', text)
        if json_match:
            return json_match.group(1).strip()
        
        # 尝试匹配 { ... } 块
        brace_match = re.search(r'\{[\s\S]*\}', text)
        if brace_match:
            return brace_match.group(0)
        
        return None
    
    def _build_history_summary(self, history: List[Dict[str, Any]]) -> str:
        """构建历史摘要"""
        if not history:
            return "No execution history"
        
        lines = []
        for i, event in enumerate(history[-10:]):  # 只取最近 10 条
            action_type = event.get("action_type", "unknown")
            action_name = event.get("action_name", "unknown")
            success = event.get("success", False)
            message = event.get("message", "")
            
            status = "✓" if success else "✗"
            lines.append(f"{i+1}. [{status}] {action_type}/{action_name}: {message}")
        
        return "\n".join(lines)
    
    def _build_tools_description(self, tools: List[Dict[str, Any]]) -> str:
        """构建工具描述"""
        if not tools:
            return "No available tools"
        
        lines = []
        for tool in tools:
            name = tool.get("name", "unknown")
            description = tool.get("description", "No description")
            lines.append(f"- **{name}**: {description}")
        
        return "\n".join(lines)
    
    def _build_skills_description(self, skills: List[Dict[str, Any]]) -> str:
        """构建 skill 描述"""
        if not skills:
            return "No available Skills"
        
        lines = []
        for skill in skills:
            name = skill.get("name", "unknown")
            description = skill.get("description", "No description")
            lines.append(f"- **{name}**: {description}")
        
        return "\n".join(lines)
    
    def _build_memory_description(self, memory: Dict[str, Any]) -> str:
        """构建内存描述"""
        if not memory:
            return "No data"
        
        lines = []
        for key, value in memory.items():
            if isinstance(value, str) and len(value) > 200:
                value = value[:200] + "..."
            lines.append(f"- **{key}**: {value}")
        
        return "\n".join(lines)