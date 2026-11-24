"""MCP Tool 包装器

为 MCP 工具添加 retry 和 fallback 支持。
MCP 工具本身不可修改，通过包装器添加配置。
"""

import asyncio
import logging
from typing import Any, Dict, Optional, Set

from .state import RuntimeState
from .actions import ExecutionResult, ToolConfig
from .exceptions import ToolExecutionException

logger = logging.getLogger(__name__)


class ToolWrapper:
    """MCP Tool 包装器
    
    为 MCP 工具添加 retry 和 fallback 支持。
    MCP 工具本身不可修改，通过包装器添加配置。
    """
    
    def __init__(
        self,
        tool_name: str,
        mcp_manager,  # MCPManager 类型，避免循环导入
        max_retries: int = 0,
        fallback_tool_name: Optional[str] = None,
        retry_delay: float = 1.0
    ):
        self.tool_name = tool_name
        self.mcp_manager = mcp_manager
        self.max_retries = max_retries
        self.fallback_tool_name = fallback_tool_name
        self.retry_delay = retry_delay
    
    async def run(
        self,
        state: RuntimeState,
        parameters: Dict[str, Any] = None,
        visited: Set[str] = None
    ) -> ExecutionResult:
        """执行工具，支持 retry 和 fallback
        
        Args:
            state: 运行时状态
            parameters: 工具参数
            visited: 已访问的工具集合（防止循环调用）
        
        Returns:
            ExecutionResult: 执行结果
        """
        visited = visited or set()
        parameters = parameters or {}
        
        # 防止循环调用
        if self.tool_name in visited:
            return ExecutionResult.error_result(
                error=f"检测到循环调用: {self.tool_name}",
                message="工具调用循环"
            )
        visited.add(self.tool_name)
        
        # 记录执行开始
        state.add_trace_event("execute_action_start", {
            "action_type": "tool",
            "action_name": self.tool_name,
            "parameters": parameters
        })
        
        # 尝试执行，支持 retry
        result = await self._execute_with_retry(state, parameters)
        
        # 如果失败且有 fallback，尝试 fallback
        if not result.success and self.fallback_tool_name:
            logger.info(f"Tool '{self.tool_name}' 失败，尝试 fallback: {self.fallback_tool_name}")
            state.add_trace_event("fallback", {
                "from_tool": self.tool_name,
                "to_tool": self.fallback_tool_name,
                "reason": result.error
            })
            
            fallback_wrapper = ToolWrapper(
                tool_name=self.fallback_tool_name,
                mcp_manager=self.mcp_manager,
                max_retries=0,  # fallback 不再 retry
                retry_delay=self.retry_delay
            )
            result = await fallback_wrapper.run(state, parameters, visited)
        
        # 记录执行结束
        state.add_trace_event("execute_action_end", {
            "action_type": "tool",
            "action_name": self.tool_name,
            "success": result.success
        })
        
        return result
    
    async def _execute_with_retry(
        self,
        state: RuntimeState,
        parameters: Dict[str, Any]
    ) -> ExecutionResult:
        """带重试的执行"""
        last_error = None
        retry_count = 0
        
        while retry_count <= self.max_retries:
            try:
                # 执行 MCP 工具
                result = await self._call_mcp_tool(parameters)
                
                if result.success:
                    return result
                
                last_error = result.error
                
            except Exception as e:
                last_error = str(e)
                logger.error(f"Tool '{self.tool_name}' 执行异常: {last_error}")
            
            # 如果还有重试机会
            if retry_count < self.max_retries:
                retry_count += 1
                logger.info(f"Tool '{self.tool_name}' 失败，等待 {self.retry_delay}s 后重试 ({retry_count}/{self.max_retries})")
                state.add_trace_event("retry", {
                    "tool_name": self.tool_name,
                    "retry_count": retry_count,
                    "error": last_error
                })
                await asyncio.sleep(self.retry_delay)
            else:
                break
        
        # 所有尝试都失败
        return ExecutionResult.error_result(
            error=last_error or "未知错误",
            message=f"Tool '{self.tool_name}' 执行失败，已重试 {retry_count} 次"
        )
    
    async def _call_mcp_tool(self, parameters: Dict[str, Any]) -> ExecutionResult:
        """调用 MCP 工具"""
        try:
            # 通过 MCP Manager 调用工具
            result = await self.mcp_manager.call_tool(self.tool_name, parameters)
            
            if result.get("isError", False):
                return ExecutionResult.error_result(
                    error=result.get("error", "MCP 工具返回错误"),
                    message="MCP 工具执行失败"
                )
            
            # 成功
            content = result.get("content", [])
            output = self._parse_mcp_content(content)
            
            return ExecutionResult.success_result(
                message=f"Tool '{self.tool_name}' 执行成功",
                output=output
            )
            
        except Exception as e:
            return ExecutionResult.error_result(
                error=str(e),
                message=f"调用 MCP 工具异常: {self.tool_name}"
            )
    
    def _parse_mcp_content(self, content: list) -> Dict[str, Any]:
        """解析 MCP 返回的内容"""
        output = {}
        
        for item in content:
            if isinstance(item, dict):
                item_type = item.get("type", "")
                if item_type == "text":
                    # 文本内容
                    text = item.get("text", "")
                    output["text"] = text
                elif item_type == "resource":
                    # 资源内容
                    resource = item.get("resource", {})
                    output["resource"] = resource
                else:
                    output["raw_content"] = item
            elif isinstance(item, str):
                output["text"] = item
            else:
                output["raw_content"] = item
        
        return output
    
    @classmethod
    def from_config(cls, config: ToolConfig, mcp_manager) -> "ToolWrapper":
        """从配置创建包装器"""
        return cls(
            tool_name=config.tool_name,
            mcp_manager=mcp_manager,
            max_retries=config.max_retries,
            fallback_tool_name=config.fallback_tool_name,
            retry_delay=config.retry_delay
        )