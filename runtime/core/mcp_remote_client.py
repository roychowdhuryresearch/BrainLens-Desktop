"""
远程服务型MCP客户端 - 通过HTTP连接远程MCP服务器
"""
import json
import logging
import time
from typing import Any, Dict, List, Optional

import httpx

from runtime.core.mcp_client_base import MCPClientBase
from runtime.core.mcp_logger import mcp_logger

logger = logging.getLogger(__name__)


class RemoteMCPClient(MCPClientBase):
    """远程服务型MCP客户端
    
    通过HTTP POST请求连接远程MCP服务器，使用JSON-RPC 2.0协议。
    """
    
    def __init__(self, name: str, config: Dict[str, Any]):
        """初始化远程MCP客户端
        
        Args:
            name: MCP服务器名称
            config: 配置字典，包含：
                - service_url: MCP服务URL
                - auth: 认证信息字典
                    - access_token: 访问令牌
                - timeout: 请求超时时间（秒），默认30
        """
        super().__init__(name, config)
        self.service_url = config.get('service_url', '')
        auth = config.get('auth')
        self._access_token = (auth.get('access_token') or '').strip() if auth else ''
        if auth and not self._access_token:
            raise ValueError(f"[{name}] Authenticated remote MCP servers require access_token")
        self.timeout = config.get('timeout', 30)
        self._request_id = 0
        self._client: Optional[httpx.AsyncClient] = None
        self._session_id: Optional[str] = None  # MCP 会话 ID
    
    def start(self) -> None:
        """初始化远程MCP连接"""
        if self._initialized:
            return
        
        mcp_logger.log_server_start(f"Remote: {self.service_url}")
        start_time = time.time()
        
        try:
            # 初始化MCP连接
            self._initialize()
            
            # 获取工具列表
            self.list_tools()
            
            # 记录启动成功
            wait_time = time.time() - start_time
            mcp_logger.log_server_started(wait_time)
            
        except Exception as e:
            mcp_logger.log_error("start_failed", str(e))
            raise
    
    async def stop(self) -> None:
        """断开远程MCP连接"""
        mcp_logger.log_server_stop()
        self._initialized = False
        mcp_logger.log_server_stopped()
    
    def _send_request(self, request: Dict) -> Dict:
        """发送JSON-RPC请求到远程服务器"""
        self._request_id += 1
        request["id"] = self._request_id
        
        method = request.get("method", "unknown")
        params = request.get("params")
        
        mcp_logger.log_request(method, params, self._request_id)
        
        headers = {
            "Content-Type": "application/json"
        }
        headers["Accept"] = "application/json, text/event-stream"
        
        # 添加 MCP 会话 ID（如果有）
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        
        # 只有在需要认证且有token时才添加Authorization header
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        
        start_time = time.time()
        
        try:
            with httpx.Client(trust_env=False) as client:
                response = client.post(
                    self.service_url,
                    json=request,
                    headers=headers,
                    timeout=self.timeout
                )
                
                if response.status_code != 200:
                    mcp_logger.log_error("http_error", f"Status: {response.status_code}")
                    raise Exception(f"[{self.name}] HTTP Error: {response.status_code}")
                
                # 获取响应内容
                content = response.text
                logger.debug(f"[{self.name}] Raw Response: {content}")
                
                # 检查是否是 SSE (Server-Sent Events) 格式
                # SSE 格式示例：
                # event: message
                # data: {"jsonrpc":"2.0","id":1,"result":{...}}
                content_type = response.headers.get('content-type', '')
                is_sse = 'text/event-stream' in content_type or content.strip().startswith('event:')
                
                if is_sse:
                    # 解析 SSE 格式，提取 data 行中的 JSON
                    result = None
                    for line in content.split('\n'):
                        line = line.strip()
                        if line.startswith('data:'):
                            data_content = line[5:].strip()  # 去掉 "data:" 前缀
                            if data_content:
                                try:
                                    result = json.loads(data_content)
                                    break
                                except json.JSONDecodeError as e:
                                    mcp_logger.log_error("sse_json_decode_error", f"Invalid JSON in SSE data: {data_content[:200]}")
                                    raise Exception(f"[{self.name}] Invalid JSON in SSE data: {e}")
                    
                    if result is None:
                        mcp_logger.log_error("sse_no_data", "No data line found in SSE response")
                        raise Exception(f"[{self.name}] No data line found in SSE response")
                else:
                    # 普通 JSON 格式
                    if not content or content.strip() == '':
                        mcp_logger.log_error("empty_response", "Empty response from server")
                        raise Exception(f"[{self.name}] Empty response from MCP server")
                    
                    try:
                        result = response.json()
                    except json.JSONDecodeError as e:
                        mcp_logger.log_error("json_decode_error", f"Invalid JSON: {content[:200]}")
                        raise Exception(f"[{self.name}] Invalid JSON response: {e}")
                
        except httpx.TimeoutException:
            mcp_logger.log_timeout(f"MCP request {method}", self.timeout)
            raise TimeoutError(f"[{self.name}] Timeout waiting for MCP response")
        except Exception as e:
            mcp_logger.log_error("request_failed", str(e))
            raise
        
        duration_ms = (time.time() - start_time) * 1000
        mcp_logger.log_response(result, duration_ms)
        
        if 'error' in result:
            error_info = result['error']
            raise Exception(f"[{self.name}] MCP Error: {error_info}")
        
        return result
    
    def _send_request_with_headers(self, request: Dict) -> tuple:
        """发送JSON-RPC请求到远程服务器，返回(result, headers)元组
        
        用于需要获取响应头的场景（如初始化时获取 MCP-Session-Id）
        """
        self._request_id += 1
        request["id"] = self._request_id
        
        method = request.get("method", "unknown")
        params = request.get("params")
        
        mcp_logger.log_request(method, params, self._request_id)
        
        headers = {
            "Content-Type": "application/json"
        }
        headers["Accept"] = "application/json, text/event-stream"
        
        # 添加 MCP 会话 ID（如果有）
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        
        # 只有在需要认证且有token时才添加Authorization header
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        
        start_time = time.time()
        
        try:
            with httpx.Client(trust_env=False) as client:
                response = client.post(
                    self.service_url,
                    json=request,
                    headers=headers,
                    timeout=self.timeout
                )
                
                if response.status_code != 200:
                    error_body = response.text[:500] if response.text else "No response body"
                    mcp_logger.log_error("http_error", f"Status: {response.status_code}, Body: {error_body}")
                    raise Exception(f"[{self.name}] HTTP Error: {response.status_code} - {error_body}")
                
                # 获取响应内容
                content = response.text
                logger.debug(f"[{self.name}] Raw Response: {content}")
                
                # 检查是否是 SSE (Server-Sent Events) 格式
                content_type = response.headers.get('content-type', '')
                is_sse = 'text/event-stream' in content_type or content.strip().startswith('event:')
                
                if is_sse:
                    # 解析 SSE 格式，提取 data 行中的 JSON
                    result = None
                    for line in content.split('\n'):
                        line = line.strip()
                        if line.startswith('data:'):
                            data_content = line[5:].strip()
                            if data_content:
                                try:
                                    result = json.loads(data_content)
                                    break
                                except json.JSONDecodeError as e:
                                    mcp_logger.log_error("sse_json_decode_error", f"Invalid JSON in SSE data: {data_content[:200]}")
                                    raise Exception(f"[{self.name}] Invalid JSON in SSE data: {e}")
                    
                    if result is None:
                        mcp_logger.log_error("sse_no_data", "No data line found in SSE response")
                        raise Exception(f"[{self.name}] No data line found in SSE response")
                else:
                    # 普通 JSON 格式
                    if not content or content.strip() == '':
                        mcp_logger.log_error("empty_response", "Empty response from server")
                        raise Exception(f"[{self.name}] Empty response from MCP server")
                    
                    try:
                        result = response.json()
                    except json.JSONDecodeError as e:
                        mcp_logger.log_error("json_decode_error", f"Invalid JSON: {content[:200]}")
                        raise Exception(f"[{self.name}] Invalid JSON response: {e}")
                
        except httpx.TimeoutException:
            mcp_logger.log_timeout(f"MCP request {method}", self.timeout)
            raise TimeoutError(f"[{self.name}] Timeout waiting for MCP response")
        except Exception as e:
            mcp_logger.log_error("request_failed", str(e))
            raise
        
        duration_ms = (time.time() - start_time) * 1000
        mcp_logger.log_response(result, duration_ms)
        
        if 'error' in result:
            error_info = result['error']
            raise Exception(f"[{self.name}] MCP Error: {error_info}")
        
        return result, response.headers
    
    def _send_notification(self, notification: Dict) -> None:
        """发送JSON-RPC通知到远程服务器（无需等待响应）"""
        method = notification.get("method", "unknown")
        params = notification.get("params")
        
        # 通知没有request_id，使用0表示
        if params:
            mcp_logger.log_request(method, params, 0)
        
        headers = {
            "Content-Type": "application/json"
        }
        
        # 添加 MCP 会话 ID（如果有）
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        
        # 只有在需要认证且有token时才添加Authorization header
        if self._access_token:
            headers["Authorization"] = f"Bearer {self._access_token}"
        
        try:
            with httpx.Client(trust_env=False) as client:
                response = client.post(
                    self.service_url,
                    json=notification,
                    headers=headers,
                    timeout=self.timeout
                )
                
                if response.status_code != 200:
                    logger.warning(f"[{self.name}] Notification {method} failed: {response.status_code}")
                else:
                    logger.debug(f"[{self.name}] Notification {method} sent successfully")
                    
        except Exception as e:
            # 通知失败不应该中断流程，只记录警告
            logger.warning(f"[{self.name}] Notification {method} error: {e}")
    
    def _initialize(self) -> None:
        """MCP协议初始化握手 (2025-11-25规范)"""
        mcp_logger.log_handshake_start()
        
        # 1. 发送 initialize 请求，获取响应和响应头
        response, response_headers = self._send_request_with_headers({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "roots": {
                        "listChanged": True
                    },
                    "sampling": {}
                },
                "clientInfo": {
                    "name": "generic-agent-runtime",
                    "title": "Generic Agent Runtime",
                    "version": "1.0.0",
                    "description": "MCP client for a generic agent runtime"
                }
            }
        })
        
        logger.debug(f"[{self.name}] Initialize response: {response}")
        logger.debug("[%s] MCP initialize response: %s", self.name, response)
        
        # 提取 MCP-Session-Id（如果服务器返回了）
        session_id = response_headers.get('MCP-Session-Id') or response_headers.get('mcp-session-id')
        if session_id:
            self._session_id = session_id
            logger.info(f"[{self.name}] Got MCP-Session-Id: {session_id}")
            logger.debug("[%s] MCP-Session-Id: %s", self.name, session_id)
        else:
            logger.debug(f"[{self.name}] No MCP-Session-Id in response headers")
        
        # 2. 发送 initialized 通知 (MCP 2025-11-25 规范要求)
        self._send_notification({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        })
        
        self._initialized = True
        mcp_logger.log_handshake_complete()
    
    async def call_tool(self, tool_name: str, arguments: Optional[Dict] = None) -> Any:
        """调用MCP工具"""
        if not self._initialized:
            self.start()
        
        # 移除前缀，获取原始工具名（根据配置）
        actual_tool_name = self._remove_prefix(tool_name)
        
        mcp_logger.log_tool_call(actual_tool_name, arguments or {})
        
        start_time = time.time()
        
        response = self._send_request({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": actual_tool_name,
                "arguments": arguments or {}
            }
        })
        
        result = response.get('result', {})
        
        # 使用基类的通用解析方法
        return self._parse_tool_result(result, actual_tool_name, start_time)
    
    def list_tools(self) -> List[Dict]:
        """列出所有可用工具（根据配置添加前缀）
        
        按照MCP协议规范：
        Request: {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {
                "cursor": "optional-cursor-value"
            }
        }
        Response: {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "tools": [...],
                "nextCursor": "next-page-cursor"
            }
        }
        """
        if not self._initialized:
            self.start()
        
        response = self._send_request({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {}
        })
        
        # 验证响应格式符合MCP规范
        result = response.get('result', {})
        if 'tools' not in result:
            raise ValueError(f"[{self.name}] Invalid MCP response: missing 'tools' field in result")
        
        tools = result.get('tools', [])
        logger.debug("[%s] Tools: %s", self.name, tools)
        
        # 根据配置添加前缀
        prefixed_tools = []
        for tool in tools:
            prefixed_tool = tool.copy()
            original_name = tool.get('name', '')
            
            # 添加元数据
            prefixed_tool['original_name'] = original_name
            prefixed_tool['name'] = self._add_prefix(original_name)
            prefixed_tool['mcp_server'] = self.name
            prefixed_tool['tool_prefix'] = self.tool_prefix  # 记录前缀配置
            prefixed_tools.append(prefixed_tool)
        
        self._tools = prefixed_tools
        mcp_logger.log_tools_list(tools)
        
        return prefixed_tools
