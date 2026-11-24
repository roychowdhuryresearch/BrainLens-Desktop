"""
本地进程型MCP客户端 - 通过子进程启动MCP服务器
适用于：本地 MCP (npx -y documents-mcp) 等本地MCP服务器
"""
import asyncio
import json
import os
import logging
import re
import subprocess
import threading
import time
from queue import Queue, Empty
from typing import Any, Dict, List, Optional

from runtime.core.mcp_client_base import MCPClientBase
from runtime.core.mcp_logger import mcp_logger

logger = logging.getLogger(__name__)


class LocalMCPClient(MCPClientBase):
    """本地进程型MCP客户端
    
    通过子进程启动MCP服务器，使用stdin/stdout进行JSON-RPC通信。
    """
    
    def __init__(self, name: str, config: Dict[str, Any]):
        """初始化本地MCP客户端
        
        Args:
            name: MCP服务器名称
            config: 配置字典，包含：
                - command: 启动命令（如 'npx -y documents-mcp'）
                - env: 环境变量字典
                - wait_time: 启动等待时间（秒），默认10
        """
        super().__init__(name, config)
        self.command = config.get('command', '')
        self.env_vars = config.get('env', {})
        self.wait_time = config.get('wait_time', 10)
        
        self.process: Optional[subprocess.Popen] = None
        self._request_id = 0
        self._stdout_queue: Optional[Queue] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def _build_subprocess_env(self) -> Dict[str, str]:
        env = os.environ.copy()
        for key, value in self.env_vars.items():
            env[key] = str(value)

        # Local Python MCP tools must exchange JSON over UTF-8 stdio.
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        return env
    
    def start(self) -> None:
        """启动MCP服务器进程"""
        if self._initialized:
            return
        
        mcp_logger.log_server_start(self.command)
        start_time = time.time()
        
        try:
            # 准备环境变量
            env = self._build_subprocess_env()
            
            # 启动子进程
            self.process = subprocess.Popen(
                self.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                text=True,
                bufsize=1,
                shell=True,
                encoding='utf-8',
                errors='replace'
            )
            
            self._stdout_queue = Queue()
            
            # 启动后台线程读取stdout
            self._reader_thread = threading.Thread(
                target=self._read_stdout,
                daemon=True
            )
            self._reader_thread.start()
            
            logger.info(f"[{self.name}] MCP server process started, waiting for initialization...")
            time.sleep(self.wait_time)
            
            # 检查进程是否还在运行
            if self.process.poll() is not None:
                stderr = self.process.stderr.read() if self.process.stderr else ""
                mcp_logger.log_server_error(f"Process exited with code {self.process.returncode}", stderr)
                raise RuntimeError(f"MCP process exited: {stderr}")
            
            # MCP协议初始化握手
            self._initialize()
            
            # 获取工具列表
            self.list_tools()
            
            # 记录启动成功
            wait_time = time.time() - start_time
            mcp_logger.log_server_started(wait_time)
            
        except Exception as e:
            mcp_logger.log_error("start_failed", str(e))
            # 手动清理资源，避免使用异步的stop方法
            if self.process:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait()
                except Exception:
                    pass
                finally:
                    self.process = None

            if self._reader_thread and self._reader_thread.is_alive():
                self._reader_thread.join(timeout=2)
            self._initialized = False
            self._stdout_queue = None
            self._reader_thread = None
            raise
    
    def _read_stdout(self):
        """后台线程读取stdout，过滤非JSON内容"""
        try:
            if self.process and self.process.stdout:
                for line in self.process.stdout:
                    if line and self._stdout_queue:
                        line = line.strip()
                        # 过滤非JSON内容（只保留以{开头的行）
                        if line and (line.startswith('{') or line.startswith('[')):
                            self._stdout_queue.put(line)
        except Exception as e:
            mcp_logger.log_error("stdout_read_error", str(e))
    
    async def stop(self) -> None:
        """停止MCP服务器进程"""
        mcp_logger.log_server_stop()
        
        if self.process:
            try:
                self.process.terminate()
                # 使用asyncio.to_thread将同步的wait调用转换为异步，避免阻塞事件循环
                await asyncio.to_thread(self.process.wait, timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                await asyncio.to_thread(self.process.wait)
            except Exception as e:
                mcp_logger.log_error("stop_error", str(e))
            finally:
                # 确保 reader thread 结束后再清理引用
                if self._reader_thread and self._reader_thread.is_alive():
                    self._reader_thread.join(timeout=2)
                self.process = None
                self._initialized = False
                self._stdout_queue = None
                self._reader_thread = None
        
        mcp_logger.log_server_stopped()
    
    def _send_request(self, request: Dict) -> Dict:
        """发送JSON-RPC请求并获取响应"""
        with self._lock:
            if not self.process or not self.process.stdin:
                raise RuntimeError(f"[{self.name}] MCP server not running")
            
            self._request_id += 1
            request["id"] = self._request_id
            
            method = request.get("method", "unknown")
            params = request.get("params")
            
            mcp_logger.log_request(method, params, self._request_id)
            
            request_str = json.dumps(request) + '\n'
            
            start_time = time.time()
            
            try:
                self.process.stdin.write(request_str)
                self.process.stdin.flush()
            except Exception as e:
                mcp_logger.log_error("stdin_write_error", str(e))
                raise
            
            # 从队列读取响应，并按 JSON-RPC id 关联：MCP 服务器可能在两个响应之间发出主动
            # 通知（notifications/*）或把 JSON 诊断行打到 stdout。旧实现把「下一行」当作响应，
            # 一旦有这类带外消息，后续所有请求/响应就永久错位（把上一个调用的结果安到下一个上）。
            # 这里跳过没有 id 的通知和 id 不匹配的行，只认自己这次请求的 id。
            expected_id = self._request_id
            deadline = time.time() + 30
            response = None
            while True:
                remaining = deadline - time.time()
                if remaining <= 0:
                    mcp_logger.log_timeout(f"MCP request {method}", 30)
                    raise TimeoutError(f"[{self.name}] Timeout waiting for MCP response")
                if self._stdout_queue is None:
                    raise RuntimeError(f"[{self.name}] stdout queue is not initialized")
                try:
                    response_line = self._stdout_queue.get(timeout=remaining)
                except Empty:
                    mcp_logger.log_timeout(f"MCP request {method}", 30)
                    raise TimeoutError(f"[{self.name}] Timeout waiting for MCP response")

                try:
                    candidate = json.loads(response_line)
                except json.JSONDecodeError as e:
                    mcp_logger.log_error("json_decode_error", str(e), {"line": response_line[:200]})
                    try:
                        fixed_line = re.sub(r',\s*([}\]])', r'\1', response_line)
                        fixed_line = re.sub(r'[\x00-\x1F\x7F]', '', fixed_line)
                        candidate = json.loads(fixed_line)
                        mcp_logger.log_error("json_fixed", "Fixed JSON format automatically")
                    except json.JSONDecodeError:
                        # 无法解析的行（多半是服务器诊断输出）——跳过，不当作本次响应消费。
                        continue

                # 跳过服务器主动通知（无 id）和 id 不匹配的陈旧响应。
                if not isinstance(candidate, dict) or "id" not in candidate:
                    continue
                if candidate.get("id") != expected_id:
                    continue
                response = candidate
                break

            duration_ms = (time.time() - start_time) * 1000
            mcp_logger.log_response(response, duration_ms)
            
            if 'error' in response:
                error_info = response['error']
                raise Exception(f"[{self.name}] MCP Error: {error_info}")
            
            return response
    
    def _initialize(self) -> None:
        """MCP协议初始化握手"""
        mcp_logger.log_handshake_start()
        
        response = self._send_request({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "at-visual-knowledge-base",
                    "version": "1.0.0"
                }
            }
        })
        
        logger.debug(f"[{self.name}] Initialize response: {response}")
        
        # 发送initialized通知
        if self.process and self.process.stdin:
            notification = json.dumps({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            }) + '\n'
            self.process.stdin.write(notification)
            self.process.stdin.flush()
        
        self._initialized = True
        mcp_logger.log_handshake_complete()
    
    async def call_tool(self, tool_name: str, arguments: Optional[Dict] = None) -> Any:
        """调用MCP工具（直接使用工具名，不做任何转换）"""
        if not self._initialized:
            # 使用asyncio.to_thread将同步的start调用转换为异步，避免阻塞事件循环
            await asyncio.to_thread(self.start)
        
        # 移除前缀，获取原始工具名（根据配置）
        actual_tool_name = self._remove_prefix(tool_name)
        
        mcp_logger.log_tool_call(actual_tool_name, arguments)
        
        start_time = time.time()
        
        # 使用asyncio.to_thread将同步调用转换为异步，避免阻塞事件循环
        response = await asyncio.to_thread(self._send_request, {
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
        """列出所有可用工具（根据配置添加前缀）"""
        if not self._initialized:
            self.start()
        
        response = self._send_request({
            "jsonrpc": "2.0",
            "method": "tools/list",
            "params": {}
        })
        
        tools = response.get('result', {}).get('tools', [])
        
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
