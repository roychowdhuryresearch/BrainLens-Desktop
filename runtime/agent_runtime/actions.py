"""Runtime Action 数据结构

定义 ExecutionResult, ActionDecision, SkillWorkflowStep 数据结构。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Literal, Optional


@dataclass
class ExecutionResult:
    """Tool/Skill 执行结果"""
    success: bool                             # 是否成功
    output: Dict[str, Any] = field(default_factory=dict)  # 结构化输出（写入 memory）
    message: str = ""                         # 简洁描述
    error: Optional[str] = None               # 错误信息
    should_terminate: bool = False            # 是否要求立即结束
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "success": self.success,
            "output": self.output,
            "message": self.message,
            "error": self.error,
            "should_terminate": self.should_terminate
        }
    
    @classmethod
    def success_result(cls, message: str, output: Dict[str, Any] = None) -> "ExecutionResult":
        """创建成功结果"""
        return cls(
            success=True,
            output=output or {},
            message=message
        )
    
    @classmethod
    def error_result(cls, error: str, message: str = "") -> "ExecutionResult":
        """创建错误结果"""
        return cls(
            success=False,
            error=error,
            message=message or f"执行失败: {error}"
        )
    
    @classmethod
    def terminate_result(cls, message: str, output: Dict[str, Any] = None) -> "ExecutionResult":
        """创建终止结果"""
        return cls(
            success=True,
            output=output or {},
            message=message,
            should_terminate=True
        )


@dataclass
class ActionDecision:
    """LLM 的 action 选择"""
    action_type: Literal["skill", "tool", "FINISH"]  # 动作类型
    action_name: str                          # 动作名称（或 FINISH）
    reason: str = ""                          # 选择理由
    parameters: Dict[str, Any] = field(default_factory=dict)  # 动作参数
    
    def is_finish(self) -> bool:
        """检查是否为完成动作"""
        return self.action_type == "FINISH"
    
    def is_skill(self) -> bool:
        """检查是否为 skill 动作"""
        return self.action_type == "skill"
    
    def is_tool(self) -> bool:
        """检查是否为 tool 动作"""
        return self.action_type == "tool"
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "action_type": self.action_type,
            "action_name": self.action_name,
            "reason": self.reason,
            "parameters": self.parameters
        }
    
    @classmethod
    def finish_decision(cls, reason: str = "") -> "ActionDecision":
        """创建完成决策"""
        return cls(
            action_type="FINISH",
            action_name="FINISH",
            reason=reason
        )
    
    @classmethod
    def skill_decision(cls, skill_name: str, reason: str = "", parameters: Dict[str, Any] = None) -> "ActionDecision":
        """创建 skill 决策"""
        return cls(
            action_type="skill",
            action_name=skill_name,
            reason=reason,
            parameters=parameters or {}
        )
    
    @classmethod
    def tool_decision(cls, tool_name: str, reason: str = "", parameters: Dict[str, Any] = None) -> "ActionDecision":
        """创建 tool 决策"""
        return cls(
            action_type="tool",
            action_name=tool_name,
            reason=reason,
            parameters=parameters or {}
        )


@dataclass
class SkillWorkflowStep:
    """从 SKILL.md 解析的 workflow 步骤"""
    step_id: int                              # 步骤编号
    title: str                                # 步骤标题
    description: str                          # 步骤描述
    suggested_tools: List[str] = field(default_factory=list)  # 建议使用的工具
    expected_output: Optional[str] = None     # 期望输出
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "step_id": self.step_id,
            "title": self.title,
            "description": self.description,
            "suggested_tools": self.suggested_tools,
            "expected_output": self.expected_output
        }


@dataclass
class ToolConfig:
    """Tool 配置（retry/fallback）"""
    tool_name: str                            # 工具名称
    max_retries: int = 0                      # 最大重试次数
    fallback_tool_name: Optional[str] = None  # 备用工具名称
    retry_delay: float = 1.0                  # 重试延迟（秒）
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "tool_name": self.tool_name,
            "max_retries": self.max_retries,
            "fallback_tool_name": self.fallback_tool_name,
            "retry_delay": self.retry_delay
        }


@dataclass
class SkillConfig:
    """Skill 配置（retry/fallback）"""
    skill_name: str                           # Skill 名称
    max_retries: int = 0                      # 最大重试次数
    fallback_skill_name: Optional[str] = None  # 备用 skill 名称
    retry_delay: float = 1.0                  # 重试延迟（秒）
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "skill_name": self.skill_name,
            "max_retries": self.max_retries,
            "fallback_skill_name": self.fallback_skill_name,
            "retry_delay": self.retry_delay
        }