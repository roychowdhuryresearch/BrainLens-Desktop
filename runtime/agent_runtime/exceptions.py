"""Agent Runtime 自定义异常

定义运行时可能抛出的各种异常。
"""


class AgentRuntimeException(Exception):
    """Agent Runtime 基础异常"""
    
    def __init__(self, message: str, details: dict = None):
        self.message = message
        self.details = details or {}
        super().__init__(self.message)
    
    def to_dict(self) -> dict:
        """转换为字典格式"""
        return {
            "error_type": self.__class__.__name__,
            "message": self.message,
            "details": self.details
        }


class MaxStepsExceededException(AgentRuntimeException):
    """超过最大步数限制"""
    
    def __init__(self, max_steps: int, current_step: int):
        super().__init__(
            message=f"超过最大步数限制: {max_steps}",
            details={"max_steps": max_steps, "current_step": current_step}
        )


class ToolExecutionException(AgentRuntimeException):
    """Tool 执行异常"""
    
    def __init__(self, tool_name: str, error: str, retry_count: int = 0):
        super().__init__(
            message=f"Tool '{tool_name}' 执行失败: {error}",
            details={"tool_name": tool_name, "error": error, "retry_count": retry_count}
        )


class SkillExecutionException(AgentRuntimeException):
    """Skill 执行异常"""
    
    def __init__(self, skill_name: str, error: str, step_index: int = None):
        details = {"skill_name": skill_name, "error": error}
        if step_index is not None:
            details["step_index"] = step_index
        super().__init__(
            message=f"Skill '{skill_name}' 执行失败: {error}",
            details=details
        )


class LLMDecisionException(AgentRuntimeException):
    """LLM 决策异常"""
    
    def __init__(self, error: str, raw_response: str = None):
        details = {"error": error}
        if raw_response:
            details["raw_response"] = raw_response[:500]  # 截断过长的响应
        super().__init__(
            message=f"LLM 决策失败: {error}",
            details=details
        )


class WorkflowParseException(AgentRuntimeException):
    """Workflow 解析异常"""
    
    def __init__(self, skill_name: str, error: str):
        super().__init__(
            message=f"Skill '{skill_name}' workflow 解析失败: {error}",
            details={"skill_name": skill_name, "error": error}
        )


class ActionValidationException(AgentRuntimeException):
    """Action 验证异常"""
    
    def __init__(self, action_type: str, action_name: str, reason: str):
        super().__init__(
            message=f"无效的 action: {action_type}/{action_name}, 原因: {reason}",
            details={"action_type": action_type, "action_name": action_name, "reason": reason}
        )