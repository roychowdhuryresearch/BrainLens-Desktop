"""
MCP客户端基类 - 定义统一的MCP客户端接口
支持两种连接模式：
- local: 本地进程型（如本地 MCP）
- remote: 远程 HTTP 服务
"""
import json
import time
from abc import ABC, abstractmethod
from typing import Any, Dict, List, Optional

from runtime.core.mcp_logger import mcp_logger


class MCPClientBase(ABC):
    """MCP客户端基类
    
    所有MCP客户端（本地/远程）都需要继承此类并实现抽象方法。
    """
    
    def __init__(self, name: str, config: Dict[str, Any]):
        """初始化MCP客户端
        
        Args:
            name: MCP服务器名称（如 'ieeg_ui'）
            config: MCP配置字典
                - tool_prefix: 工具名前缀（从配置读取，默认为空）
        """
        self.name = name
        self.config = config
        self.tool_prefix = config.get('tool_prefix', '')  # 从配置读取前缀
        self._initialized = False
        self._tools: Optional[List[Dict]] = None
    
    @property
    def is_initialized(self) -> bool:
        """是否已初始化"""
        return self._initialized
    
    @property
    def tools(self) -> List[Dict]:
        """获取工具列表"""
        return self._tools or []
    
    @abstractmethod
    def start(self) -> None:
        """启动/连接MCP服务器
        
        对于本地进程型：启动子进程
        对于远程服务型：建立HTTP连接
        """
        pass
    
    @abstractmethod
    async def stop(self) -> None:
        """停止/断开MCP服务器"""
        pass
    
    @abstractmethod
    async def call_tool(self, tool_name: str, arguments: Optional[Dict] = None) -> Any:
        """调用MCP工具
        
        Args:
            tool_name: 工具名称
            arguments: 工具参数
            
        Returns:
            工具执行结果
        """
        pass
    
    @abstractmethod
    def list_tools(self) -> List[Dict]:
        """列出所有可用工具
        
        Returns:
            工具列表，每个工具包含 name, description, inputSchema
        """
        pass
    
    def get_tool_names(self) -> List[str]:
        """获取所有工具名称列表"""
        return [tool.get('name', '') for tool in self.tools]
    
    def has_tool(self, tool_name: str) -> bool:
        """检查是否有指定工具"""
        return tool_name in self.get_tool_names()
    
    def _add_prefix(self, tool_name: str) -> str:
        """添加工具名前缀（根据配置）
        
        Args:
            tool_name: 原始工具名
            
        Returns:
            带前缀的工具名（如果配置了前缀）
            
        例如：
        - tool_prefix="documents_": "search" -> "document_search"
        - tool_prefix="": "search" -> "search"
        """
        if self.tool_prefix:
            return f"{self.tool_prefix}{tool_name}"
        return tool_name
    
    def _remove_prefix(self, prefixed_name: str) -> str:
        """移除工具名前缀（根据配置）
        
        Args:
            prefixed_name: 带前缀的工具名
            
        Returns:
            原始工具名
            
        例如：
        - tool_prefix="documents_": "document_search" -> "search"
        - tool_prefix="": "search" -> "search"
        """
        if self.tool_prefix and prefixed_name.startswith(self.tool_prefix):
            return prefixed_name[len(self.tool_prefix):]
        return prefixed_name
    
    def _parse_tool_result(self, result: Dict, tool_name: str, start_time: float) -> Any:
        """解析MCP工具返回结果（通用方法）
        
        支持多种MCP内容类型：
        - type='json': 直接返回 data 字段的 JSON 对象
        - type='text': 尝试解析为 JSON，否则返回文本
        - 其他类型: 返回完整的 result 对象
        
        Args:
            result: MCP返回的 result 对象
            tool_name: 工具名称（用于日志）
            start_time: 请求开始时间（用于计算耗时）
            
        Returns:
            解析后的结果
        """
        if 'content' in result:
            for item in result['content']:
                content_type = item.get('type')
                
                # 处理 type: 'json'
                if content_type == 'json':
                    json_data = item.get('data', {})
                    duration_ms = (time.time() - start_time) * 1000
                    mcp_logger.log_tool_result(tool_name, json_data, duration_ms)
                    return json_data
                
                # 处理 type: 'text'
                elif content_type == 'text':
                    text_content = item.get('text', '')
                    try:
                        parsed_result = json.loads(text_content)
                        duration_ms = (time.time() - start_time) * 1000
                        mcp_logger.log_tool_result(tool_name, parsed_result, duration_ms)
                        return parsed_result
                    except json.JSONDecodeError:
                        duration_ms = (time.time() - start_time) * 1000
                        mcp_logger.log_tool_result(tool_name, text_content, duration_ms)
                        return text_content
        
        # 兜底：返回完整的 result
        duration_ms = (time.time() - start_time) * 1000
        mcp_logger.log_tool_result(tool_name, result, duration_ms)
        return result
