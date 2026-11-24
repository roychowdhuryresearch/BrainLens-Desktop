"""VL Tool 实现

实现 vl_query 工具，让文本 LLM 能够按需调用 VL 能力分析图片。
"""

import time
import logging
from typing import Dict, Any, Optional

from runtime.agent_runtime.image_reference_store import ImageReferenceStore
from runtime.agent_runtime.vl_logger import vl_logger
from runtime.services.vlm_service import VLMService, VLMServiceFactory
from runtime.models.schemas import VLMModelConfig

logger = logging.getLogger(__name__)


class VLQueryTool:
    """VL 查询工具
    
    让文本 LLM 能够调用 VL 模型分析图片。
    
    工具定义（OpenAI Tools 格式）:
    {
        "type": "function",
        "function": {
            "name": "vl_query",
            "description": "分析图片内容...",
            "parameters": {...}
        }
    }
    """
    
    TOOL_NAME = "vl_query"
    
    def __init__(
        self,
        vlm_service: VLMService,
        image_store: Optional[ImageReferenceStore] = None
    ):
        """初始化 VL 查询工具
        
        Args:
            vlm_service: VLM 服务实例
            image_store: 图片引用存储（可选，可从 state 获取）
        """
        self.vlm_service = vlm_service
        self.image_store = image_store
    
    def get_tool_definition(self) -> Dict[str, Any]:
        """获取工具定义（OpenAI Tools 格式）
        
        Returns:
            工具定义字典
        """
        return {
            "type": "function",
            "function": {
                "name": self.TOOL_NAME,
                "description": (
                    "用于普通图片内容理解、场景分析、科研图表解读、影像观察、物体识别等。当上下文包含 image_ref "
                    "时使用此工具。PDF、Word、Excel、PPT、TXT、MD 等文档阅读请使用 document_read_by_attachment。"
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "image_ref": {
                            "type": "string",
                            "description": "图片引用ID，如 img_ref_001"
                        },
                        "query": {
                            "type": "string",
                            "description": "要对图片进行的分析或问题，如'描述图片内容'、'识别图中的文字'、'图中有什么问题'"
                        }
                    },
                    "required": ["image_ref", "query"]
                }
            }
        }
    
    async def execute(
        self,
        parameters: Dict[str, Any],
        state: Optional[Any] = None,
        image_store: Optional[ImageReferenceStore] = None
    ) -> Dict[str, Any]:
        """执行 VL 查询
        
        Args:
            parameters: 工具参数
                - image_ref: 图片引用 ID
                - query: 分析提示词
            state: 运行时状态（可选，duck-typed）
            image_store: 图片引用存储（优先使用传入的，否则使用初始化时的）
            
        Returns:
            执行结果
                - success: 是否成功
                - result: 分析结果（成功时）
                - error: 错误信息（失败时）
        """
        # 获取图片存储
        store = image_store or self.image_store
        
        # 验证参数
        image_ref_id = parameters.get("image_ref")
        query = parameters.get("query")
        
        if not image_ref_id:
            return {
                "success": False,
                "error": "缺少参数: image_ref"
            }
        
        if not query:
            return {
                "success": False,
                "error": "缺少参数: query"
            }
        
        # 获取图片引用
        image_ref = None
        
        # 先从传入的 store 获取
        if store:
            image_ref = store.get(image_ref_id)
        
        # 如果没有，从 state 获取
        if not image_ref and state and hasattr(state, "get_image_reference"):
            image_ref = state.get_image_reference(image_ref_id)
        
        if not image_ref:
            available_refs = []
            if store:
                available_refs = store.list_all()
            elif state and hasattr(state, "has_image_references") and state.has_image_references():
                available_refs = list(state.image_references.keys())
            
            return {
                "success": False,
                "error": f"图片引用不存在: {image_ref_id}。可用引用: {available_refs}"
            }
        
        # 确定图片来源类型和数据
        if image_ref.has_url():
            image_source = image_ref.url or ""
            is_url = True
            source_info = f"URL: {image_source[:50]}..."
        elif image_ref.has_data():
            image_source = image_ref.data or ""
            is_url = False
            source_info = f"base64: {len(image_source)} chars"
        else:
            return {
                "success": False,
                "error": f"图片引用 {image_ref_id} 没有有效的数据或 URL"
            }
        
        # 记录 VL 工具调用
        vl_logger.log_vl_tool_call(
            image_ref=image_ref_id,
            query=query
        )
        
        # 调用 VLM 服务
        start_time = time.time()
        try:
            result = await self.vlm_service.analyze(
                image_source=image_source,
                prompt=query,
                is_url=is_url
            )
            
            duration_ms = (time.time() - start_time) * 1000
            
            # 记录成功结果
            vl_logger.log_vl_tool_result(
                success=True,
                result=result,
                duration_ms=duration_ms
            )
            
            return {
                "success": True,
                "image_ref": image_ref_id,
                "query": query,
                "result": result
            }
            
        except Exception as e:
            duration_ms = (time.time() - start_time) * 1000
            error_msg = f"VL 分析异常: {str(e)}"
            
            # 记录错误
            vl_logger.log_vl_tool_result(
                success=False,
                error=error_msg,
                duration_ms=duration_ms
            )
            
            return {
                "success": False,
                "error": error_msg
            }


def create_vl_tool(vlm_config: VLMModelConfig) -> Optional[VLQueryTool]:
    """创建 VL 工具实例
    
    Args:
        vlm_config: VLM 配置
        
    Returns:
        VLQueryTool 实例，配置无效时返回 None
    """
    if not vlm_config or not vlm_config.enabled:
        logger.info("[VL Tool] VLM not configured or disabled")
        return None
    
    try:
        vlm_service = VLMServiceFactory.create_service(vlm_config)
        return VLQueryTool(vlm_service=vlm_service)
    except Exception as e:
        logger.error(f"[VL Tool] Failed to create VL tool: {e}")
        return None


def get_vl_tool_definition() -> Dict[str, Any]:
    """获取 VL 工具定义（静态方法）
    
    用于在注册工具时获取定义，无需创建实例。
    
    Returns:
        工具定义字典
    """
    return {
        "type": "function",
        "function": {
            "name": "vl_query",
            "description": (
                "用于普通图片内容理解、场景分析、科研图表解读、影像观察、物体识别等。当上下文包含 image_ref "
                "时使用此工具。PDF、Word、Excel、PPT、TXT、MD 等文档阅读请使用 document_read_by_attachment。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "image_ref": {
                        "type": "string",
                        "description": "图片引用ID，如 img_ref_001"
                    },
                    "query": {
                        "type": "string",
                        "description": "要对图片进行的分析或问题，如'描述图片内容'、'识别图中的文字'、'图中有什么问题'"
                    }
                },
                "required": ["image_ref", "query"]
            }
        }
    }
