"""VLM (Vision Language) 服务

支持图片分析的视觉语言模型服务。
支持智谱 GLM-4V 和千问 VL 模型。
"""

import time
import httpx
import logging
from abc import ABC, abstractmethod
from typing import Optional, Dict, Any

from runtime.models.schemas import VLMModelConfig
from runtime.agent_runtime.vl_logger import vl_logger

logger = logging.getLogger(__name__)


class VLMService(ABC):
    """VLM 服务基类"""
    
    def __init__(self, config: VLMModelConfig):
        self.config = config
    
    @abstractmethod
    async def analyze(self, image_source: str, prompt: str, is_url: bool = False) -> str:
        """分析图片
        
        Args:
            image_source: 图片数据（base64 或 URL）
            prompt: 分析提示词
            is_url: True 表示 image_source 是 URL，False 表示是 base64
            
        Returns:
            分析结果文本
        """
        pass
    
    def _build_image_url(self, image_source: str, is_url: bool, content_type: str = "image/jpeg") -> str:
        """构建 image_url 参数
        
        Args:
            image_source: 图片数据（base64 或 URL）
            is_url: 是否为 URL
            content_type: MIME 类型（仅 base64 时使用）
            
        Returns:
            image_url 字符串
        """
        if is_url:
            return image_source
        else:
            return f"data:{content_type};base64,{image_source}"


class ZhipuVLService(VLMService):
    """智谱 GLM-4V 服务
    
    API 文档: https://open.bigmodel.cn/dev/api#multimodal
    
    支持:
    - base64: image_url={"url": "data:image/jpeg;base64,{base64_data}"}
    - URL: image_url={"url": "https://..."}
    """
    
    async def analyze(self, image_source: str, prompt: str, is_url: bool = False) -> str:
        """分析图片
        
        Args:
            image_source: 图片数据（base64 或 URL）
            prompt: 分析提示词
            is_url: True 表示 image_source 是 URL
            
        Returns:
            分析结果文本
        """
        api_base = self.config.api_base or "https://open.bigmodel.cn/api/paas/v4"
        url = f"{api_base.rstrip('/')}/chat/completions"
        
        image_url = self._build_image_url(image_source, is_url)
        
        payload = {
            "model": self.config.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_url
                            }
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ]
                }
            ],
            "max_tokens": self.config.max_tokens
        }
        
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json"
        }
        
        # 记录 VLM API 调用
        vl_logger.log_vlm_api_call(
            provider="zhipu",
            model=self.config.model,
            image_source_type="url" if is_url else "base64",
            prompt_preview=prompt
        )
        
        start_time = time.time()
        try:
            async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
                response = await client.post(url, json=payload, headers=headers)
                
                if response.status_code == 200:
                    data = response.json()
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    duration_ms = (time.time() - start_time) * 1000
                    
                    # 记录成功响应
                    vl_logger.log_vlm_api_response(
                        success=True,
                        content_length=len(content),
                        duration_ms=duration_ms
                    )
                    return content
                elif response.status_code == 401:
                    error_msg = "VLM API Key 无效"
                    duration_ms = (time.time() - start_time) * 1000
                    vl_logger.log_vlm_api_response(
                        success=False,
                        error=error_msg,
                        duration_ms=duration_ms
                    )
                    return f"[VL分析失败] {error_msg}"
                else:
                    error_detail = ""
                    try:
                        error_data = response.json()
                        error_detail = error_data.get("error", {}).get("message", "")
                    except:
                        error_detail = response.text
                    error_msg = f"状态码 {response.status_code}: {error_detail}"
                    duration_ms = (time.time() - start_time) * 1000
                    vl_logger.log_vlm_api_response(
                        success=False,
                        error=error_msg,
                        duration_ms=duration_ms
                    )
                    return f"[VL分析失败] {error_msg}"
                    
        except httpx.TimeoutException:
            error_msg = "VLM 请求超时"
            duration_ms = (time.time() - start_time) * 1000
            vl_logger.log_vlm_api_response(
                success=False,
                error=error_msg,
                duration_ms=duration_ms
            )
            vl_logger.log_timeout("VLM API", 60.0)
            return f"[VL分析失败] {error_msg}"
        except Exception as e:
            error_msg = f"异常: {str(e)}"
            duration_ms = (time.time() - start_time) * 1000
            vl_logger.log_vlm_api_response(
                success=False,
                error=error_msg,
                duration_ms=duration_ms
            )
            return f"[VL分析失败] {error_msg}"


class QianwenVLService(VLMService):
    """千问 VL 服务
    
    API 文档: https://help.aliyun.com/zh/dashscope/developer-reference/tongyi-qianwen-vl
    
    支持:
    - base64: image_url={"url": "data:image/jpeg;base64,{base64_data}"}
    - URL: image_url={"url": "https://..."}
    """
    
    async def analyze(self, image_source: str, prompt: str, is_url: bool = False) -> str:
        """分析图片
        
        Args:
            image_source: 图片数据（base64 或 URL）
            prompt: 分析提示词
            is_url: True 表示 image_source 是 URL
            
        Returns:
            分析结果文本
        """
        # 千问 VL 使用 OpenAI 兼容模式
        api_base = self.config.api_base or "https://dashscope.aliyuncs.com/compatible-mode/v1"
        url = f"{api_base.rstrip('/')}/chat/completions"
        
        image_url = self._build_image_url(image_source, is_url)
        
        payload = {
            "model": self.config.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": image_url
                            }
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ]
                }
            ],
            "max_tokens": self.config.max_tokens
        }
        
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json"
        }
        
        # 记录 VLM API 调用
        vl_logger.log_vlm_api_call(
            provider="qianwen",
            model=self.config.model,
            image_source_type="url" if is_url else "base64",
            prompt_preview=prompt
        )
        
        start_time = time.time()
        try:
            async with httpx.AsyncClient(timeout=60.0, trust_env=False) as client:
                response = await client.post(url, json=payload, headers=headers)
                
                if response.status_code == 200:
                    data = response.json()
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    duration_ms = (time.time() - start_time) * 1000
                    
                    vl_logger.log_vlm_api_response(
                        success=True,
                        content_length=len(content),
                        duration_ms=duration_ms
                    )
                    return content
                elif response.status_code == 401:
                    error_msg = "VLM API Key 无效"
                    duration_ms = (time.time() - start_time) * 1000
                    vl_logger.log_vlm_api_response(
                        success=False,
                        error=error_msg,
                        duration_ms=duration_ms
                    )
                    return f"[VL分析失败] {error_msg}"
                else:
                    error_detail = ""
                    try:
                        error_data = response.json()
                        if "error" in error_data:
                            error_detail = error_data["error"].get("message", "")
                        elif "message" in error_data:
                            error_detail = error_data.get("message", "")
                    except:
                        error_detail = response.text
                    error_msg = f"状态码 {response.status_code}: {error_detail}"
                    duration_ms = (time.time() - start_time) * 1000
                    vl_logger.log_vlm_api_response(
                        success=False,
                        error=error_msg,
                        duration_ms=duration_ms
                    )
                    return f"[VL分析失败] {error_msg}"
                    
        except httpx.TimeoutException:
            error_msg = "VLM 请求超时"
            duration_ms = (time.time() - start_time) * 1000
            vl_logger.log_vlm_api_response(
                success=False,
                error=error_msg,
                duration_ms=duration_ms
            )
            vl_logger.log_timeout("VLM API", 60.0)
            return f"[VL分析失败] {error_msg}"
        except Exception as e:
            error_msg = f"异常: {str(e)}"
            duration_ms = (time.time() - start_time) * 1000
            vl_logger.log_vlm_api_response(
                success=False,
                error=error_msg,
                duration_ms=duration_ms
            )
            return f"[VL分析失败] {error_msg}"


class VLMServiceFactory:
    """VLM 服务工厂"""
    
    _instances: Dict[str, VLMService] = {}
    
    @classmethod
    def create_service(cls, config: VLMModelConfig) -> VLMService:
        """创建 VLM 服务实例
        
        Args:
            config: VLM 配置
            
        Returns:
            VLMService 实例
            
        Raises:
            ValueError: 不支持的提供商
        """
        # 缓存实例
        cache_key = f"{config.provider}:{config.model}"
        if cache_key in cls._instances:
            return cls._instances[cache_key]
        
        if config.provider == "zhipu":
            service = ZhipuVLService(config)
        elif config.provider == "qianwen":
            service = QianwenVLService(config)
        else:
            raise ValueError(f"不支持的 VLM 提供商: {config.provider}")
        
        cls._instances[cache_key] = service
        logger.info(f"[VLM] Created VLM service: {cache_key}")
        return service
    
    @classmethod
    def clear_cache(cls):
        """清除缓存的服务实例"""
        cls._instances.clear()
