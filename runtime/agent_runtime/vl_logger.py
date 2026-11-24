"""VL Logger - 独立的 VL (Vision Language) 操作日志记录器

提供专门的日志文件记录 VL 系统的运行情况：
- 图片上传和存储日志
- VL 工具调用日志
- VLM API 请求/响应日志
- 错误和超时日志

日志文件位置: logs/vl.log
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any
import json


class VLLogger:
    """VL 操作日志记录器
    
    提供独立的日志文件，专门记录 VL 相关操作。
    日志格式为结构化文本，便于分析和调试。
    
    使用方式：
        from runtime.agent_runtime.vl_logger import vl_logger
        
        # 记录图片上传
        vl_logger.log_image_upload("img_ref_001", "test.png", 12345)
        
        # 记录 VL 工具调用
        vl_logger.log_vl_tool_call("img_ref_001", "描述图片内容")
        
        # 记录 VLM API 调用
        vl_logger.log_vlm_api_call("zhipu", "glm-4v", 1500)
    """
    
    def __init__(self, log_dir: str = "logs", log_file: str = "vl.log"):
        """初始化 VL 日志记录器
        
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
        self.logger = logging.getLogger("vl_operations")
        self.logger.setLevel(logging.DEBUG)
        
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
        """格式化 JSON 数据为字符串"""
        if isinstance(data, (dict, list)):
            try:
                return json.dumps(data, ensure_ascii=False)
            except Exception:
                return str(data)
        return str(data)
    
    def _truncate(self, text: str, max_len: int = 500) -> str:
        """截断文本"""
        if not text:
            return ""
        if len(text) <= max_len:
            return text
        return text[:max_len] + "..."
    
    def log_separator(self) -> None:
        """记录分隔线"""
        self.logger.info("=" * 80)
    
    def log_image_upload(
        self,
        ref_id: str,
        filename: str,
        size_bytes: int,
        content_type: str = "image/jpeg",
        conversation_id: str = None
    ) -> None:
        """记录图片上传
        
        Args:
            ref_id: 图片引用ID
            filename: 文件名
            size_bytes: 文件大小（字节）
            content_type: MIME 类型
            conversation_id: 会话ID
        """
        self.logger.info(f"[IMAGE UPLOAD] ref_id={ref_id}")
        self.logger.info(f"  Filename: {filename}")
        self.logger.info(f"  Size: {size_bytes} bytes ({size_bytes / 1024:.1f} KB)")
        self.logger.info(f"  Content-Type: {content_type}")
        if conversation_id:
            self.logger.info(f"  Conversation: {conversation_id}")
    
    def log_image_ref_summary(self, ref_ids: list, conversation_id: str = None) -> None:
        """记录图片引用摘要
        
        Args:
            ref_ids: 引用ID列表
            conversation_id: 会话ID
        """
        self.logger.info(f"[IMAGE REFS] count={len(ref_ids)}, refs={ref_ids}")
        if conversation_id:
            self.logger.info(f"  Conversation: {conversation_id}")
    
    def log_vl_tool_call(
        self,
        image_ref: str,
        query: str,
        conversation_id: str = None
    ) -> None:
        """记录 VL 工具调用
        
        Args:
            image_ref: 图片引用ID
            query: 查询内容
            conversation_id: 会话ID
        """
        self.logger.info(f"[VL TOOL CALL] image_ref={image_ref}")
        self.logger.info(f"  Query: {self._truncate(query, 200)}")
        if conversation_id:
            self.logger.info(f"  Conversation: {conversation_id}")
    
    def log_vl_tool_result(
        self,
        success: bool,
        result: str = None,
        error: str = None,
        duration_ms: float = 0
    ) -> None:
        """记录 VL 工具执行结果
        
        Args:
            success: 是否成功
            result: 结果内容
            error: 错误信息
            duration_ms: 耗时（毫秒）
        """
        if success:
            self.logger.info(f"[VL TOOL RESULT] status=SUCCESS, duration={duration_ms:.0f}ms")
            if result:
                self.logger.info(f"  Result: {self._truncate(result, 500)}")
        else:
            self.logger.error(f"[VL TOOL RESULT] status=ERROR, duration={duration_ms:.0f}ms")
            if error:
                self.logger.error(f"  Error: {error}")
    
    def log_vlm_api_call(
        self,
        provider: str,
        model: str,
        image_source_type: str,
        prompt_preview: str = None
    ) -> None:
        """记录 VLM API 调用
        
        Args:
            provider: 提供商 (zhipu, qianwen)
            model: 模型名称
            image_source_type: 图片源类型 (url, base64)
            prompt_preview: 提示词预览
        """
        self.logger.info(f"[VLM API] provider={provider}, model={model}")
        self.logger.info(f"  Image Source: {image_source_type}")
        if prompt_preview:
            self.logger.info(f"  Prompt: {self._truncate(prompt_preview, 100)}")
    
    def log_vlm_api_response(
        self,
        success: bool,
        content_length: int = 0,
        error: str = None,
        duration_ms: float = 0
    ) -> None:
        """记录 VLM API 响应
        
        Args:
            success: 是否成功
            content_length: 响应内容长度
            error: 错误信息
            duration_ms: 耗时（毫秒）
        """
        if success:
            self.logger.info(f"[VLM API RESPONSE] status=SUCCESS, duration={duration_ms:.0f}ms")
            self.logger.info(f"  Content Length: {content_length} chars")
        else:
            self.logger.error(f"[VLM API RESPONSE] status=ERROR, duration={duration_ms:.0f}ms")
            if error:
                self.logger.error(f"  Error: {self._truncate(error, 500)}")
    
    def log_timeout(self, operation: str, timeout_seconds: float) -> None:
        """记录超时
        
        Args:
            operation: 操作名称
            timeout_seconds: 超时时间（秒）
        """
        self.logger.error(f"[TIMEOUT] operation={operation}, timeout={timeout_seconds}s")
    
    def log_error(self, error_type: str, error_message: str, context: Dict = None) -> None:
        """记录错误
        
        Args:
            error_type: 错误类型
            error_message: 错误信息
            context: 上下文信息
        """
        self.logger.error(f"[ERROR] type={error_type}")
        self.logger.error(f"  Message: {error_message}")
        if context:
            self.logger.error(f"  Context: {self._format_json(context)}")


# 创建全局实例
vl_logger = VLLogger()
