"""
MCP Logger - 独立的 MCP 调用日志记录器

提供专门的日志文件记录 MCP 系统的运行情况：
- MCP 服务器启动/停止日志
- 工具调用日志（请求/响应）
- 错误和异常日志
- 性能统计日志

日志文件位置: logs/mcp.log
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
import json

from runtime.redaction import ObservabilityRedactionFilter, redact_observability_payload


class MCPLogger:
    """MCP 调用日志记录器
    
    提供独立的日志文件，专门记录 MCP 客户端的运行情况。
    日志格式为结构化文本，便于分析和调试。
    
    使用方式：
        from runtime.core.mcp_logger import mcp_logger
        
        # 记录服务器启动
        mcp_logger.log_server_start()
        
        # 记录工具调用
        mcp_logger.log_tool_call("document_search", {"query": "test"})
        
        # 记录工具响应
        mcp_logger.log_tool_result("document_search", result)
    """
    
    def __init__(self, log_dir: str = "logs", log_file: str = "mcp.log"):
        """初始化 MCP 日志记录器
        
        Args:
            log_dir: 日志目录路径
            log_file: 日志文件名
        """
        # 确保日志目录存在
        self.log_dir = Path(log_dir)
        if not self.log_dir.is_absolute():
            agent_data_dir = os.environ.get("IEEG_AGENT_DATA_DIR", "").strip()
            if agent_data_dir and log_dir == "logs":
                self.log_dir = Path(agent_data_dir).expanduser() / "logs"
            else:
                # 相对于项目根目录
                project_root = Path(__file__).parent.parent.parent
                self.log_dir = project_root / log_dir
        
        self.log_dir.mkdir(parents=True, exist_ok=True)
        
        self.log_path = self.log_dir / log_file
        
        # 创建专用的 logger
        self.logger = logging.getLogger("mcp_client")
        self.logger.setLevel(logging.DEBUG)  # MCP 日志使用 DEBUG 级别，记录更详细
        if not any(isinstance(item, ObservabilityRedactionFilter) for item in self.logger.filters):
            self.logger.addFilter(ObservabilityRedactionFilter())
        
        # 避免重复添加 handler
        if not self.logger.handlers:
            # 文件 handler
            file_handler = logging.FileHandler(
                self.log_path,
                encoding='utf-8',
                mode='a'  # 追加模式
            )
            file_handler.setLevel(logging.DEBUG)
            
            # 日志格式
            formatter = logging.Formatter(
                '%(asctime)s | %(levelname)-8s | %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            file_handler.setFormatter(formatter)
            
            self.logger.addHandler(file_handler)
    
    def _format_json(self, data: Any) -> str:
        """格式化 JSON 数据为字符串
        
        Args:
            data: 要格式化的数据
            
        Returns:
            JSON 字符串
        """
        if isinstance(data, (dict, list)):
            try:
                return json.dumps(data, ensure_ascii=False, indent=2)
            except Exception:
                return str(data)
        return str(data)
    
    def _truncate(self, text: str, max_len: int = 500) -> str:
        """截断文本
        
        Args:
            text: 原始文本
            max_len: 最大长度
            
        Returns:
            截断后的文本
        """
        if not text:
            return ""
        if len(text) <= max_len:
            return text
        return text[:max_len] + "..."
    
    def log_separator(self) -> None:
        """记录分隔线，用于区分不同请求"""
        self.logger.info("=" * 80)
    
    def log_server_start(self, command: str = "npx -y documents-mcp") -> None:
        """记录 MCP 服务器启动
        
        Args:
            command: 启动命令
        """
        self.log_separator()
        self.logger.info("[MCP SERVER] Starting...")
        self.logger.info(f"  Command: {redact_observability_payload(command)}")
        self.logger.info(f"  Timestamp: {datetime.now().isoformat()}")
    
    def log_server_started(self, wait_time: float = 0) -> None:
        """记录 MCP 服务器启动成功
        
        Args:
            wait_time: 等待时间（秒）
        """
        self.logger.info(f"[MCP SERVER] Started successfully")
        if wait_time:
            self.logger.info(f"  Wait Time: {wait_time:.1f}s")
    
    def log_server_stop(self) -> None:
        """记录 MCP 服务器停止"""
        self.logger.info("[MCP SERVER] Stopping...")
    
    def log_server_stopped(self) -> None:
        """记录 MCP 服务器已停止"""
        self.logger.info("[MCP SERVER] Stopped")
        self.log_separator()
    
    def log_server_error(self, error: str, stderr: Optional[str] = None) -> None:
        """记录 MCP 服务器错误
        
        Args:
            error: 错误信息
            stderr: 标准错误输出
        """
        self.logger.error(f"[MCP SERVER ERROR] {redact_observability_payload(error)}")
        if stderr:
            safe_stderr = str(redact_observability_payload(stderr))
            self.logger.error(f"  Stderr: {self._truncate(safe_stderr, 1000)}")
    
    def log_handshake_start(self) -> None:
        """记录 MCP 握手开始"""
        self.logger.info("[MCP HANDSHAKE] Starting initialization...")
    
    def log_handshake_complete(self) -> None:
        """记录 MCP 握手完成"""
        self.logger.info("[MCP HANDSHAKE] Completed successfully")
    
    def log_request(self, method: str, params: Optional[Dict] = None, request_id: Optional[int] = None) -> None:
        """记录 MCP 请求
        
        Args:
            method: 方法名
            params: 参数
            request_id: 请求ID
        """
        self.logger.debug(f"[MCP REQUEST] id={request_id}, method={method}")
        if params:
            params_str = self._format_json(redact_observability_payload(params))
            self.logger.debug(f"  Params: {self._truncate(params_str)}")
    
    def log_response(self, response: Dict, duration_ms: float = 0) -> None:
        """记录 MCP 响应
        
        Args:
            response: 响应数据
            duration_ms: 耗时（毫秒）
        """
        has_error = 'error' in response
        level = logging.ERROR if has_error else logging.DEBUG
        
        status = "ERROR" if has_error else "SUCCESS"
        self.logger.log(level, f"[MCP RESPONSE] status={status}, duration={duration_ms:.0f}ms")
        
        if has_error:
            error_info = redact_observability_payload(response.get('error', {}), key="error")
            self.logger.error(f"  Error: {self._format_json(error_info)}")
        else:
            result = redact_observability_payload(response.get('result', {}), key="result")
            result_str = self._format_json(result)
            self.logger.log(level, f"  Result: {self._truncate(result_str)}")
    
    def log_tool_call(self, tool_name: str, arguments: Optional[Dict] = None) -> None:
        """记录工具调用
        
        Args:
            tool_name: 工具名称
            arguments: 工具参数
        """
        self.logger.info(f"[TOOL CALL] tool={tool_name}")
        if arguments:
            args_str = self._format_json(redact_observability_payload(arguments))
            self.logger.info(f"  Arguments: {self._truncate(args_str)}")
    
    def log_tool_result(self, tool_name: str, result: Any, duration_ms: float = 0) -> None:
        """记录工具执行结果
        
        Args:
            tool_name: 工具名称
            result: 执行结果
            duration_ms: 耗时（毫秒）
        """
        # 判断结果类型和大小
        if isinstance(result, dict):
            if 'error' in result:
                self.logger.error(f"[TOOL RESULT] tool={tool_name}, status=ERROR, duration={duration_ms:.0f}ms")
                self.logger.error(f"  Error: {redact_observability_payload(result.get('error'), key='error')}")
            else:
                result_str = self._format_json(redact_observability_payload(result))
                self.logger.info(f"[TOOL RESULT] tool={tool_name}, status=SUCCESS, duration={duration_ms:.0f}ms")
                self.logger.info(f"  Result: {self._truncate(result_str)}")
        elif isinstance(result, list):
            self.logger.info(f"[TOOL RESULT] tool={tool_name}, status=SUCCESS, duration={duration_ms:.0f}ms")
            self.logger.info(f"  Result: List with {len(result)} items")
            if result:
                safe_result = redact_observability_payload(result)
                preview = self._format_json(safe_result[:2]) if len(safe_result) > 2 else self._format_json(safe_result)
                self.logger.info(f"  Preview: {self._truncate(preview)}")
        else:
            self.logger.info(f"[TOOL RESULT] tool={tool_name}, status=SUCCESS, duration={duration_ms:.0f}ms")
            safe_result = str(redact_observability_payload(result, key="result"))
            self.logger.info(f"  Result: {self._truncate(safe_result)}")
    
    def log_tool_error(self, tool_name: str, error: str, duration_ms: float = 0) -> None:
        """记录工具执行错误
        
        Args:
            tool_name: 工具名称
            error: 错误信息
            duration_ms: 耗时（毫秒）
        """
        self.logger.error(f"[TOOL ERROR] tool={tool_name}, duration={duration_ms:.0f}ms")
        self.logger.error(f"  Error: {redact_observability_payload(error, key='error')}")
    
    def log_tools_list(self, tools: list) -> None:
        """记录工具列表
        
        Args:
            tools: 工具列表
        """
        self.logger.info(f"[TOOLS LIST] count={len(tools)}")
        for tool in tools:
            name = tool.get('name', 'unknown')
            desc = str(redact_observability_payload(tool.get('description', ''), key="description"))[:100]
            self.logger.info(f"  - {name}: {desc}...")
    
    def log_timeout(self, operation: str, timeout: float) -> None:
        """记录超时
        
        Args:
            operation: 操作名称
            timeout: 超时时间（秒）
        """
        self.logger.error(f"[TIMEOUT] operation={operation}, timeout={timeout}s")
    
    def log_error(self, error_type: str, error_message: str, context: Optional[Dict] = None) -> None:
        """记录错误
        
        Args:
            error_type: 错误类型
            error_message: 错误信息
            context: 上下文信息
        """
        self.logger.error(f"[ERROR] type={error_type}")
        self.logger.error(f"  Message: {redact_observability_payload(error_message, key='error_message')}")
        if context:
            self.logger.error(f"  Context: {self._format_json(redact_observability_payload(context))}")


# 创建全局实例
mcp_logger = MCPLogger()
