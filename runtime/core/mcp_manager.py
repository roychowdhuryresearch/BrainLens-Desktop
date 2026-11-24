"""
MCP管理器 - 统一管理多个MCP客户端
支持本地进程型和远程服务型MCP服务器
"""
import logging
import threading
from typing import Any, Dict, List, Optional

from runtime.core.mcp_client_base import MCPClientBase
from runtime.core.mcp_local_client import LocalMCPClient
from runtime.core.mcp_remote_client import RemoteMCPClient
from runtime.models.user_context import UserContext

logger = logging.getLogger(__name__)


class MCPManager:
    """MCP管理器
    
    统一管理多个MCP服务器连接，提供统一的工具调用接口。
    
    使用方式：
        manager = MCPManager()
        manager.add_server('ieeg_ui', {
            'type': 'local',
            'command': 'python -m ui_mcp.mcp_server',
        })
        manager.start_server('ieeg_ui')
        tools = manager.get_all_tools()
    """
    
    def __init__(self):
        self._clients: Dict[str, MCPClientBase] = {}
        self._lock = threading.Lock()
    
    def add_server(self, name: str, config: Dict[str, Any]) -> None:
        """添加MCP服务器
        
        Args:
            name: 服务器名称（如 'ieeg_ui'）
            config: 服务器配置
                - type: 'local' 或 'remote'
                - tool_prefix: 工具名前缀（可选，用于避免命名冲突）
                - 其他配置见对应客户端类
        """
        with self._lock:
            if name in self._clients:
                logger.warning(f"MCP server '{name}' already exists, replacing...")
                self.remove_server(name)
            
            # 检查前缀配置
            tool_prefix = config.get('tool_prefix', '')
            if tool_prefix:
                logger.info(f"MCP server '{name}' will use tool prefix: '{tool_prefix}'")
            
            server_type = config.get('type', 'local')
            
            if server_type == 'local':
                client = LocalMCPClient(name, config)
            elif server_type == 'remote':
                client = RemoteMCPClient(name, config)
            else:
                raise ValueError(f"Unknown MCP server type: {server_type}")
            
            self._clients[name] = client
            logger.info(f"Added MCP server: {name} (type={server_type}, prefix='{tool_prefix}')")
    
    def remove_server(self, name: str) -> None:
        """移除MCP服务器"""
        with self._lock:
            if name in self._clients:
                client = self._clients.pop(name)
                try:
                    client.stop()
                except Exception as e:
                    logger.error(f"Error stopping MCP server '{name}': {e}")
                logger.info(f"Removed MCP server: {name}")
    
    def get_server(self, name: str) -> Optional[MCPClientBase]:
        """获取指定MCP客户端"""
        return self._clients.get(name)
    
    def get_all_servers(self) -> Dict[str, MCPClientBase]:
        """获取所有MCP客户端"""
        return self._clients.copy()
    
    def start_server(self, name: str) -> None:
        """启动指定MCP服务器"""
        client = self._clients.get(name)
        if client:
            client.start()
            logger.info(f"Started MCP server: {name}")
        else:
            raise ValueError(f"MCP server '{name}' not found")
    
    def start_all_servers(self) -> None:
        """启动所有MCP服务器"""
        for name, client in self._clients.items():
            try:
                if not client.is_initialized:
                    client.start()
                    logger.info(f"Started MCP server: {name}")
            except Exception as e:
                logger.error(f"Failed to start MCP server '{name}': {e}")
    
    async def stop_all_servers(self) -> None:
        """停止所有MCP服务器"""
        for name, client in self._clients.items():
            try:
                await client.stop()
                logger.info(f"Stopped MCP server: {name}")
            except Exception as e:
                logger.error(f"Failed to stop MCP server '{name}': {e}")
    
    def get_all_tools(self) -> List[Dict]:
        """获取所有MCP服务器的工具列表（合并）
        
        Returns:
            工具列表，每个工具已添加服务器前缀
        """
        all_tools = []
        for name, client in self._clients.items():
            try:
                if client.is_initialized:
                    all_tools.extend(client.tools)
            except Exception as e:
                logger.error(f"Failed to get tools from '{name}': {e}")
        return all_tools
    
    def get_tool_by_name(self, tool_name: str) -> Optional[Dict]:
        """根据工具名获取工具信息"""
        for tool in self.get_all_tools():
            if tool.get('name') == tool_name:
                return tool
        return None
    
    async def call_tool(self, tool_name: str, arguments: Optional[Dict] = None) -> Any:
        """调用工具（自动路由到对应的MCP服务器）
        
        Args:
            tool_name: 工具名称（带前缀，如 'document_search'）
            arguments: 工具参数
            
        Returns:
            工具执行结果
            
        Raises:
            ValueError: 工具未找到
        """
        # 查找对应的客户端
        client = self._find_client_by_tool_name(tool_name)
        
        if not client:
            # 尝试在没有前缀的情况下查找
            for name, client_candidate in self._clients.items():
                if client_candidate.has_tool(tool_name):
                    logger.warning(f"Tool '{tool_name}' found without prefix in server '{name}', using it")
                    return await client_candidate.call_tool(tool_name, arguments)
            
            # 列出所有可用工具，帮助调试
            all_tools = self.get_all_tools()
            tool_names = [t.get('name') for t in all_tools]
            logger.error(f"Tool '{tool_name}' not found. Available tools: {tool_names}")
            raise ValueError(f"Tool '{tool_name}' not found in any MCP server. Available tools: {tool_names}")
        
        return await client.call_tool(tool_name, arguments)
    
    def _find_client_by_tool_name(self, tool_name: str) -> Optional[MCPClientBase]:
        """根据工具名查找对应的MCP客户端
        
        Args:
            tool_name: 工具名称（带前缀，如 'document_search'）
            
        Returns:
            MCP客户端实例，如果未找到返回None
        """
        for client in self._clients.values():
            # 检查工具是否属于该客户端（根据配置的前缀）
            if client.tool_prefix and tool_name.startswith(client.tool_prefix):
                return client
            # 如果没有配置前缀，检查工具是否在客户端的工具列表中
            if not client.tool_prefix and client.has_tool(tool_name):
                return client
        return None
    
    def get_tools_for_user(
        self,
        user_context: Optional[UserContext] = None
    ) -> List[Dict]:
        """按用户 allowed_mcp_servers 白名单过滤工具列表
        
        三态权限逻辑：
        - user_context 为 None → 返回空列表（无用户信息）
        - allowed is None → 跟随系统默认（读取 config.yaml 的 default_mcp_servers）
        - allowed == [] → 无可用工具
        - allowed 有值 → 按白名单过滤
        
        Args:
            user_context: 用户上下文
            
        Returns:
            过滤后的工具列表
        """
        # 无用户信息，返回[]
        if not user_context:
            logger.info("[MCP Manager] No user_context, return empty list")
            return []
        
        allowed = user_context.allowed_mcp_servers
        
        # 三态判断
        if allowed is None:
            # None = 跟随系统默认，从 config 读取 default_mcp_servers
            from runtime.core.config import config_manager
            default_servers = config_manager.config.default_mcp_servers
            if not default_servers:
                logger.info(f"[MCP Manager] User '{user_context.username}' follows default, but default is empty")
                return []
            allowed = default_servers
        
        if not allowed:
            # 空白名单 = 无可用工具
            logger.info(f"[MCP Manager] User '{user_context.username}' has no allowed MCP servers")
            return []
        
        filtered_tools = []
        for server_name, client in self._clients.items():
            if not client.is_initialized:
                continue
            if server_name in allowed:
                filtered_tools.extend(client.tools)
        
        logger.info(f"[MCP Manager] get_tools_for_user: {len(self.get_all_tools())} -> {len(filtered_tools)} "
                    f"for user '{user_context.username}' (role={user_context.role}, allowed={allowed})")
        return filtered_tools
    
    def list_available_servers(self) -> List[Dict]:
        """列出所有可用的MCP服务器"""
        servers = []
        for name, client in self._clients.items():
            servers.append({
                'name': name,
                'type': 'local' if isinstance(client, LocalMCPClient) else 'remote',
                'initialized': client.is_initialized,
                'tools_count': len(client.tools)
            })
        return servers


# 全局MCP管理器实例
mcp_manager = MCPManager()


def get_mcp_manager() -> MCPManager:
    """获取全局MCP管理器实例"""
    return mcp_manager