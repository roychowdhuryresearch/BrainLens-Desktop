from abc import ABC, abstractmethod
from typing import Any, AsyncGenerator, List, Dict, Optional, Tuple
import httpx
import json
import logging
import os
import re
import traceback
import asyncio
import random
import time
from datetime import datetime, timedelta
from runtime.models.schemas import AIModelConfig, AIServiceConfig, ModelSpecificConfig
from runtime.core.config import config_manager

logger = logging.getLogger(__name__)

# 千问 API 输入长度限制（983616 字符，留安全余量）
MAX_INPUT_CHARS = 900000
TEXT_TOOL_FALLBACK_ENV = "IEEG_AGENT_ALLOW_TEXT_TOOL_CALL_FALLBACK"


class NonRetryableAIError(Exception):
    """A deterministic client-side failure (e.g. HTTP 400) that must NOT be retried.

    chat()'s retry loop catches broad Exceptions and retries with backoff. A 400 Bad
    Request is deterministic (bad payload / context-length / invalid schema), so
    retrying just re-sends the identical rejected request and burns the whole retry
    budget (~7-10s of backoff) before surfacing the same error. Raising this type lets
    the loop re-raise immediately instead of retrying.
    """


class TokenBucket:
    """
    令牌桶算法实现 - 用于客户端限流
    
    原理：
    1. 以固定速率向桶中添加令牌
    2. 每个请求需要消耗与token数量相当的令牌才能执行
    3. 如果桶中没有足够的令牌，则请求被阻塞或拒绝
    """
    
    def __init__(self, rate: float, capacity: int):
        """
        初始化令牌桶
        
        Args:
            rate: 每秒生成的令牌数
            capacity: 桶的最大容量
        """
        self.rate = rate  # 令牌生成速率（令牌/秒）
        self.capacity = capacity  # 桶的最大容量
        self.tokens = capacity  # 当前令牌数
        self.last_refill = time.time()  # 上次填充时间
        self.lock = asyncio.Lock()  # 并发锁
    
    async def acquire(self, tokens: int = 1) -> None:
        """
        获取指定数量的令牌，如果没有足够的令牌则等待

        Args:
            tokens: 需要的令牌数（与实际token消耗相关）
        """
        # 旧实现把 `await asyncio.sleep(time_to_wait)` 放在 `async with self.lock`
        # 里，等待期间其它 coroutine 全部被阻塞在 lock 上 —— N 个并发 LLM 调用
        # 实际是**串行**等令牌而不是并行。改成：在 lock 里算 wait time、
        # 释放锁 → sleep → 再进 lock 结算 tokens。
        while True:
            async with self.lock:
                now = time.time()
                time_since_last_refill = now - self.last_refill

                # 添加令牌
                new_tokens = time_since_last_refill * self.rate
                self.tokens = min(self.capacity, self.tokens + new_tokens)
                self.last_refill = now

                if self.tokens >= tokens:
                    self.tokens -= tokens
                    logger.info(f"[RATE LIMIT] Acquired {tokens} tokens, remaining: {self.tokens:.2f}")
                    return

                time_to_wait = (tokens - self.tokens) / self.rate
                logger.info(
                    "[RATE LIMIT] Token bucket low on tokens, need %d, available %.2f, waiting %.2fs",
                    tokens, self.tokens, time_to_wait,
                )

            # 锁释放后再 sleep，不阻塞其它 acquire 者；循环回到 top 重新结算
            # （别人可能刚好抢先消费了新补的令牌，继续等一轮即可）。
            await asyncio.sleep(time_to_wait)
    
    async def get_available_tokens(self) -> float:
        """
        获取当前可用令牌数
        
        Returns:
            当前可用令牌数
        """
        async with self.lock:
            now = time.time()
            time_since_last_refill = now - self.last_refill
            new_tokens = time_since_last_refill * self.rate
            return min(self.capacity, self.tokens + new_tokens)
    
    async def add_tokens(self, tokens: float) -> None:
        """
        向桶中添加令牌（用于特殊情况的补偿）
        
        Args:
            tokens: 要添加的令牌数
        """
        async with self.lock:
            self.tokens = min(self.capacity, self.tokens + tokens)
            logger.info(f"[RATE LIMIT] Added {tokens} tokens, current: {self.tokens:.2f}")


class AIService(ABC):
    """AI服务基类"""
    
    def __init__(self, config: AIModelConfig):
        self.config = config
        self.client = httpx.AsyncClient(
            timeout=300.0,
            limits=httpx.Limits(max_connections=500, max_keepalive_connections=100),
            trust_env=False,
        )
        
        # 从配置文件加载参数
        system_config = config_manager.config
        ai_service_config = system_config.ai_service or AIServiceConfig()
        
        # 加载模型特定配置
        self.model_config = self._get_model_specific_config(ai_service_config, config.model)
        
        # 确定使用的令牌桶配置
        if self.model_config.token_bucket:
            tb_config = self.model_config.token_bucket
            logger.info(f"[AI RATE LIMIT] Using model-specific token bucket config for {config.model}")
        else:
            tb_config = ai_service_config.token_bucket
            logger.info(f"[AI RATE LIMIT] Using global token bucket config for {config.model}")
        
        # 令牌桶参数
        self.tokens_per_second = tb_config.token_refill_rate
        self.token_bucket_capacity = tb_config.token_bucket_capacity
        logger.info(f"[AI RATE LIMIT] Token bucket config: rate={self.tokens_per_second:.0f} tokens/s, capacity={self.token_bucket_capacity} tokens")
        
        # 客户端令牌桶限流 - 基于实际token消耗
        self.rate_limiter = TokenBucket(rate=self.tokens_per_second, capacity=self.token_bucket_capacity)
        
        # 加载token估算配置（使用全局配置）
        self.char_to_token_ratio = ai_service_config.token_estimation.char_to_token_ratio
        self.overhead_tokens = ai_service_config.token_estimation.overhead_tokens
        logger.info(f"[AI RATE LIMIT] Loaded token estimation config: ratio={self.char_to_token_ratio}, overhead={self.overhead_tokens}")
        
        # 确定使用的重试配置
        if self.model_config.retry:
            self.retry_config = self.model_config.retry
            logger.info(f"[AI RETRY] Using model-specific retry config for {config.model}")
        else:
            self.retry_config = ai_service_config.retry
            logger.info(f"[AI RETRY] Using global retry config for {config.model}")
        
        logger.info(f"[AI RETRY] Retry config: max_retries={self.retry_config.max_retries}, base_delay={self.retry_config.base_delay}s, max_delay={self.retry_config.max_delay}s")

    def _is_retryable_network_error(self, error: Exception) -> bool:
        """Classify transient network/transport failures that deserve an explicit retry log."""
        if isinstance(
            error,
            (
                httpx.NetworkError,
                httpx.ReadError,
                httpx.WriteError,
                httpx.ConnectError,
                httpx.CloseError,
                httpx.RemoteProtocolError,
            ),
        ):
            return True

        message = str(error).lower()
        retryable_markers = (
            "tls/ssl connection has been closed",
            "server disconnected without sending a response",
            "connection reset by peer",
            "eof occurred in violation of protocol",
            "remote end closed connection",
        )
        return any(marker in message for marker in retryable_markers)
    
    def _get_model_specific_config(self, ai_config: AIServiceConfig, model_name: str) -> ModelSpecificConfig:
        """
        获取模型特定配置，如果不存在则返回默认配置
        
        Args:
            ai_config: 全局AI服务配置
            model_name: 模型名称
            
        Returns:
            模型特定配置或默认配置
        """
        if ai_config.model_specific and model_name in ai_config.model_specific:
            model_config = ai_config.model_specific[model_name]
            if model_config.enabled:
                logger.info(f"[CONFIG] Using model-specific configuration for {model_name}")
                return model_config
        
        # 返回默认配置
        logger.info(f"[CONFIG] Using default configuration for {model_name}")
        return ModelSpecificConfig(enabled=True)
    
    @abstractmethod
    async def chat(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        max_retries: Optional[int] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """聊天接口"""
        pass

    async def chat_stream(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Streaming chat interface.

        Yields incremental events while the model generates:
          {"type": "content", "text": <delta>}     # user-visible answer tokens
          {"type": "reasoning", "text": <delta>}    # thinking trace (usually off)
        and finishes with exactly one terminal event:
          {"type": "final", "response": <dict>}     # same shape as chat()'s return

        Default has no real streaming: it awaits chat() and emits the whole
        content as a single delta. Providers override for true token streaming.
        """
        response = await self.chat(messages, tools=tools, extra_body=extra_body)
        content = (response or {}).get("content") or ""
        if content:
            yield {"type": "content", "text": content}
        yield {"type": "final", "response": response or {}}

    async def _stream_openai_compatible(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
        *,
        include_usage: bool = True,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """Generic OpenAI-compatible SSE token streaming, shared by providers whose
        /chat/completions speaks the OpenAI streaming protocol (Qianwen DashScope,
        Zhipu GLM). Uses self.api_base + self.headers + self.client.

        Yields {"type":"content"|"reasoning","text":delta} as tokens arrive, then
        one {"type":"final","response":<same shape as chat()>}. Deltas are RAW
        model output (chat()'s nested-JSON / XML tool-call fallback parsing is
        skipped — it needs the whole string); the final carries native tool_calls
        accumulated across delta chunks.
        """
        messages = self._hard_truncate_messages(messages)
        payload: Dict[str, Any] = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
            "stream": True,
        }
        if include_usage:
            payload["stream_options"] = {"include_usage": True}
        if tools:
            payload["tools"] = tools
        if extra_body:
            payload.update(extra_body)

        content_parts: List[str] = []
        reasoning_parts: List[str] = []
        tool_calls_acc: Dict[int, Dict[str, Any]] = {}
        finish_reason: Optional[str] = None
        usage: Dict[str, Any] = {}

        async with self.client.stream(
            "POST", self.api_base, json=payload, headers=self.headers
        ) as response:
            response.raise_for_status()
            async for raw_line in response.aiter_lines():
                line = (raw_line or "").strip()
                if not line or not line.startswith("data:"):
                    continue
                data = line[len("data:"):].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if chunk.get("usage"):
                    usage = chunk["usage"]
                choices = chunk.get("choices") or []
                if not choices:
                    continue
                choice = choices[0]
                if choice.get("finish_reason"):
                    finish_reason = choice["finish_reason"]
                delta = choice.get("delta") or {}
                piece = delta.get("content")
                if piece:
                    content_parts.append(piece)
                    yield {"type": "content", "text": piece}
                reasoning_piece = delta.get("reasoning_content")
                if reasoning_piece:
                    reasoning_parts.append(reasoning_piece)
                    yield {"type": "reasoning", "text": reasoning_piece}
                for tc in (delta.get("tool_calls") or []):
                    idx = tc.get("index", 0) or 0
                    slot = tool_calls_acc.setdefault(
                        idx,
                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                    )
                    if tc.get("id"):
                        slot["id"] = tc["id"]
                    if tc.get("type"):
                        slot["type"] = tc["type"]
                    fn = tc.get("function") or {}
                    if fn.get("name"):
                        slot["function"]["name"] = fn["name"]
                    if fn.get("arguments"):
                        slot["function"]["arguments"] += fn["arguments"]

        content = "".join(content_parts)
        reasoning_content = "".join(reasoning_parts) or None
        tool_calls = [tool_calls_acc[i] for i in sorted(tool_calls_acc)] or None
        response_dict = {
            "content": content,
            "reasoning_content": reasoning_content,
            "model_used": self.config.model,
            "tokens_used": usage.get("total_tokens"),
            "usage": {
                "prompt_tokens": usage.get("prompt_tokens"),
                "completion_tokens": usage.get("completion_tokens"),
                "total_tokens": usage.get("total_tokens"),
            },
            "tool_calls": tool_calls,
            "tool_call_origin": "native" if tool_calls else None,
            "finish_reason": finish_reason,
        }
        yield {"type": "final", "response": response_dict}

    @abstractmethod
    def get_available_models(self) -> List[str]:
        """获取可用模型列表"""
        pass
    
    def validate_config(self, config: AIModelConfig) -> bool:
        """验证配置"""
        return bool(config.api_key)

    def _ensure_api_key(self) -> None:
        """Fail fast on an empty / unexpanded api_key.

        An empty or ``${...}``-placeholder key builds an illegal ``Bearer ``
        header that httpx rejects, after which the whole retry budget is burned
        on a LocalProtocolError that points nowhere near the real problem. Raise
        a clear, actionable error before the request instead.
        """
        key = str(getattr(self.config, "api_key", "") or "").strip()
        if not key or key.startswith("${"):
            model = getattr(self.config, "model", "?")
            raise ValueError(
                f"[AI CONFIG] api_key for model {model} is empty or unexpanded "
                "(a ${...} placeholder?). Set the provider's API key env var, or "
                "fix config.yaml / user_config.yaml."
            )

    async def close(self):
        """关闭客户端"""
        await self.client.aclose()
    
    def estimate_tokens(self, messages: List[Dict], tools: Optional[List[Dict]] = None) -> int:
        """估计请求所需的 token 数量（委托给 token_utils 统一实现）。"""
        from runtime.utils.token_utils import estimate_messages_tokens
        return estimate_messages_tokens(
            messages,
            char_to_token_ratio=self.char_to_token_ratio,
            overhead_tokens=self.overhead_tokens,
            tools=tools,
        )
    
    def calculate_response_tokens(self, content: str) -> int:
        """
        计算响应内容的tokens数量
        
        Args:
            content: 响应内容
            
        Returns:
            估计的token数量
        """
        if not content:
            return 0
        
        # 保守估计：1 token ≈ 2个字符
        return int(len(content) / 2)

    def _allow_text_tool_call_fallback(self) -> bool:
        return str(os.environ.get(TEXT_TOOL_FALLBACK_ENV, "")).strip().lower() in {"1", "true", "yes", "on"}

    def _normalize_text_tool_calls(self, tool_calls: Any) -> Optional[List[Dict[str, Any]]]:
        if not isinstance(tool_calls, list):
            return None
        normalized: List[Dict[str, Any]] = []
        for index, raw_call in enumerate(tool_calls):
            if not isinstance(raw_call, dict):
                return None
            call = dict(raw_call)
            function = call.get("function")
            if not isinstance(function, dict):
                return None
            call["function"] = dict(function)
            if not call.get("id"):
                call["id"] = f"call_text_{int(time.time() * 1000)}_{index}"
            if not call.get("type"):
                call["type"] = "function"
            normalized.append(call)
        return normalized

    def _text_json_tool_calls_or_none(self, tool_calls: Any) -> Optional[List[Dict[str, Any]]]:
        if not self._allow_text_tool_call_fallback():
            logger.warning(
                "[AI] Ignoring text-encoded tool_calls because %s is not enabled; only native message.tool_calls are executable.",
                TEXT_TOOL_FALLBACK_ENV,
            )
            return None
        return self._normalize_text_tool_calls(tool_calls)

    def _parse_xml_tool_call_fallback(self, content: str) -> Tuple[str, Optional[List[Dict[str, Any]]]]:
        if not content or "_invoke" not in content:
            return content, None
        if not self._allow_text_tool_call_fallback():
            logger.warning(
                "[AI] Ignoring XML/text tool call because %s is not enabled; only native message.tool_calls are executable.",
                TEXT_TOOL_FALLBACK_ENV,
            )
            return content, None
        tool_call_pattern = r'_invoke\s*<function=(\w+)>\s*<parameter=(\w+)>(.*?)</parameter>\s*</function>\s*_invoke'
        match = re.search(tool_call_pattern, content, re.DOTALL)
        if not match:
            return content, None
        function_name = match.group(1)
        param_name = match.group(2)
        param_value = match.group(3).strip()
        logger.info("[AI] Parsed XML/text tool call fallback: function=%s", function_name)
        tool_calls = [
            {
                "id": f"call_text_{int(time.time() * 1000)}_0",
                "type": "function",
                "function": {
                    "name": function_name,
                    "arguments": json.dumps({param_name: param_value}, ensure_ascii=False),
                },
            }
        ]
        return content.replace(match.group(0), "").strip(), tool_calls
    
    async def _consume_tokens(self, estimated_tokens: int) -> None:
        """
        从令牌桶中消耗估计的tokens数量
        
        Args:
            estimated_tokens: 估计的tokens数量
        """
        # 确保至少消耗1个token
        tokens_to_consume = max(1, estimated_tokens)
        await self.rate_limiter.acquire(tokens_to_consume)
    
    async def _exponential_backoff_with_jitter(self, attempt: int, response: Optional[httpx.Response] = None) -> float:
        """
        指数退避 + 抖动机制（使用配置的参数）
        
        Args:
            attempt: 当前重试次数（从0开始）
            response: HTTP响应对象（用于检查Retry-After头）
            
        Returns:
            等待时间（秒）
        """
        # 检查响应头中的Retry-After字段
        retry_after = None
        if response and 'Retry-After' in response.headers:
            retry_after_header = response.headers['Retry-After']
            try:
                # Retry-After可以是秒数（整数）或HTTP日期
                if retry_after_header.isdigit():
                    retry_after = int(retry_after_header)
                    logger.info(f"[RATE LIMIT] Server specified Retry-After: {retry_after}s")
                else:
                    # 解析HTTP日期格式
                    retry_after_date = datetime.strptime(retry_after_header, '%a, %d %b %Y %H:%M:%S GMT')
                    retry_after = (retry_after_date - datetime.utcnow()).total_seconds()
                    if retry_after < 0:
                        retry_after = 0
                    logger.info(f"[RATE LIMIT] Server specified Retry-After until {retry_after_header}, waiting {retry_after:.2f}s")
            except Exception as e:
                logger.warning(f"[RATE LIMIT] Failed to parse Retry-After header: {e}")
        
        if retry_after is not None:
            return retry_after
        
        # 指数退避算法（使用配置的参数）
        base_delay = self.retry_config.base_delay
        max_delay = self.retry_config.max_delay
        exponent = min(attempt, 6)  # 最多退避6次
        
        # 计算指数延迟：base_delay * (2^exponent)
        delay = base_delay * (2 ** exponent)
        delay = min(delay, max_delay)  # 限制最大延迟
        
        # 添加抖动：使用配置的抖动范围
        jitter = random.uniform(0, self.retry_config.jitter_range)
        total_delay = delay + jitter
        
        logger.info(f"[RATE LIMIT] Exponential backoff: attempt={attempt}, delay={total_delay:.2f}s (base={delay:.2f}s + jitter={jitter:.2f}s)")
        
        return total_delay
    
    @staticmethod
    def _message_char_len(message: Dict) -> int:
        """估算一条消息占用的输入长度。

        content 之外，assistant 的 `tool_calls` JSON 负载同样计入 API 输入长度。
        只统计 content 会把正文全在 `tool_calls` 里的工具调用消息算成 0，导致截断
        时低估体量、删多删少。name/tool_call_id 等短字段忽略不计。
        """
        n = len(str(message.get("content", "") or ""))
        tool_calls = message.get("tool_calls")
        if tool_calls:
            try:
                n += len(json.dumps(tool_calls, ensure_ascii=False))
            except (TypeError, ValueError):
                n += len(str(tool_calls))
        return n

    def _hard_truncate_messages(self, messages: List[Dict], max_chars: int = MAX_INPUT_CHARS) -> List[Dict]:
        """硬截断消息列表，确保不超过 API 输入长度限制

        策略：
        1. 计算总字符数（content + tool_calls 负载）
        2. 如果超限，从最旧的消息开始删除（跳过 system）
        3. 删除带 tool_calls 的 assistant 消息时，连同其后续的 tool 响应一并删除。
           否则会留下没有父 assistant.tool_calls 的"孤儿" tool 消息——OpenAI 兼容
           接口（Qwen/Zhipu）会以 HTTP 400 拒绝这种破损的配对，而 400 是不可重试
           的（NonRetryableAIError），整轮请求直接硬失败。

        Args:
            messages: 消息列表
            max_chars: 最大字符数

        Returns:
            截断后的消息列表
        """
        total_chars = sum(self._message_char_len(m) for m in messages)

        if total_chars <= max_chars:
            return messages

        logger.warning(f"[AI] Input too long ({total_chars} > {max_chars}), hard truncating...")

        # 复制消息列表，避免修改原列表
        truncated = list(messages)

        # 从最旧的消息开始删除（跳过 system），并保持 tool_call 配对完整。
        while total_chars > max_chars and len(truncated) > 3:
            # 找到第一个非 system 消息的索引
            idx = next((i for i, m in enumerate(truncated) if m.get("role") != "system"), None)
            if idx is None:
                break
            removed = truncated.pop(idx)
            total_chars -= self._message_char_len(removed)
            logger.debug(f"[AI] Removed message at index {idx}, total_chars now: {total_chars}")
            # 若删除的是带 tool_calls 的 assistant，连同紧随其后的 tool 响应一起删除，
            # 避免留下孤儿 tool 消息（此清理不受上面的长度/条数守卫限制，配对完整优先）。
            if removed.get("role") == "assistant" and removed.get("tool_calls"):
                while idx < len(truncated) and truncated[idx].get("role") == "tool":
                    orphan = truncated.pop(idx)
                    total_chars -= self._message_char_len(orphan)
                    logger.debug(f"[AI] Removed paired tool response, total_chars now: {total_chars}")

        logger.warning(f"[AI] Hard truncated from {len(messages)} to {len(truncated)} messages, "
                      f"total_chars: {total_chars}")

        return truncated


class ZhipuAIService(AIService):
    """智谱AI服务"""
    
    def __init__(self, config: AIModelConfig):
        super().__init__(config)
        self.api_base = config.api_base.rstrip('/') if config.api_base else "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        if not self.api_base.endswith('/chat/completions'):
            self.api_base = self.api_base.rstrip('/') + '/chat/completions'
        self.headers = {
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json"
        }
    
    async def chat(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        max_retries: Optional[int] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """智谱AI聊天 - 带重试机制"""
        self._ensure_api_key()
        # 第3层：硬截断保护（兜底）
        messages = self._hard_truncate_messages(messages)
        
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens
        }
        
        if tools:
            payload["tools"] = tools
        if extra_body:
            payload.update(extra_body)
        
        # 打印AI请求摘要（脱敏：不打印完整 payload 避免泄露 key）
        logger.info(
            "[AI REQUEST] url=%s model=%s messages=%d tools=%d",
            self.api_base, payload.get("model"), len(messages),
            len(tools) if tools else 0,
        )

        # 打印完整请求原文（DEBUG级别）
        logger.debug(
            "\n%s\n[AI REQUEST RAW] url=%s\n%s\n%s",
            '=' * 60, self.api_base,
            json.dumps(payload, ensure_ascii=False, indent=2),
            '=' * 60,
        )

        last_error = None
        # 估计请求所需的tokens数量
        estimated_tokens = self.estimate_tokens(messages, tools)

        # 使用配置的重试次数或默认值
        retry_count = max_retries if max_retries is not None else self.retry_config.max_retries
        logger.info(f"[AI RETRY] Using retry count: {retry_count} (max_retries) for model {self.config.model}")

        # 总尝试次数 = max_retries + 1 (原始请求 + 重试次数)
        for attempt in range(retry_count + 1):
            try:
                # 客户端令牌桶限流 - 基于估计的token数量
                await self._consume_tokens(estimated_tokens)

                response = await self.client.post(self.api_base, json=payload, headers=self.headers)

                if response.status_code == 400:
                    error_detail = response.text
                    logger.warning(f"[AI ERROR] 400 Bad Request (not retryable): {error_detail}")
                    try:
                        error_json = response.json()
                        if "error" in error_json:
                            error_msg = error_json["error"].get("message", error_detail)
                        else:
                            error_msg = error_detail
                    except:
                        error_msg = error_detail

                    raise NonRetryableAIError(f"智谱AI请求失败(400): {error_msg}")

                # 处理429速率限制错误
                if response.status_code == 429:
                    error_detail = response.text
                    logger.error(f"[AI RATE LIMIT] 429 Too Many Requests: {error_detail}")
                    
                    if attempt < retry_count:
                        wait_time = await self._exponential_backoff_with_jitter(attempt, response)
                        logger.warning(f"[AI RETRY] Rate limited, retrying in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                        continue
                    
                    raise Exception(f"智谱AI请求失败(429): 速率限制，请求过于频繁")
                
                response.raise_for_status()
                
                result = response.json()
                
                # 先检查 error 字段（更符合 API 习惯）
                if "error" in result:
                    error_msg = result["error"]
                    if isinstance(error_msg, dict):
                        error_msg = error_msg.get("message", str(error_msg))
                    
                    # 检查是否是速率限制错误
                    if "rate limit" in error_msg.lower() or "too many requests" in error_msg.lower():
                        logger.error(f"[AI RATE LIMIT] Error: {error_msg}")
                        if attempt < retry_count:
                            wait_time = await self._exponential_backoff_with_jitter(attempt)
                            logger.warning(f"[AI RETRY] Rate limited by API error, retrying in {wait_time}s...")
                            await asyncio.sleep(wait_time)
                            continue
                    
                    raise Exception(f"智谱AI错误: {error_msg}")
                
                # 再检查 choices 是否存在且非空
                if not result.get("choices"):
                    raise Exception(f"智谱AI返回空结果")
                
                # 打印AI响应原文
                logger.info(f"\n{'='*60}\n[AI RESPONSE]:\n{json.dumps(result, ensure_ascii=False, indent=2)}\n{'='*60}")
                
                content = result["choices"][0]["message"].get("content", "")
                tool_calls = result["choices"][0]["message"].get("tool_calls")
                tool_call_origin = "native" if tool_calls else None
                reasoning_content = result["choices"][0]["message"].get("reasoning_content")  # 智谱 GLM-4-Z1 等推理模型支持
                finish_reason = result["choices"][0].get("finish_reason")  # 提取finish_reason
                
                # 如果没有JSON格式的tool_calls，但内容包含XML格式的tool_call，则尝试解析
                if not tool_calls and "_invoke" in content:
                    content, tool_calls = self._parse_xml_tool_call_fallback(content)
                    if tool_calls:
                        tool_call_origin = "text_xml_fallback"
                
                return {
                    "content": content,
                    "reasoning_content": reasoning_content,  # 返回思考过程
                    "model_used": self.config.model,
                    "tokens_used": result.get("usage", {}).get("total_tokens"),
                    "usage": {
                        "prompt_tokens": result.get("usage", {}).get("prompt_tokens"),
                        "completion_tokens": result.get("usage", {}).get("completion_tokens"),
                        "total_tokens": result.get("usage", {}).get("total_tokens"),
                    },
                    "tool_calls": tool_calls,
                    "tool_call_origin": tool_call_origin,
                    "finish_reason": finish_reason  # 返回finish_reason
                }
                
            except httpx.HTTPStatusError as e:
                last_error = e
                logger.error(f"[AI ERROR] HTTP {e.response.status_code}")
                
                # 处理429速率限制错误
                if e.response.status_code == 429:
                    if attempt < retry_count:
                        wait_time = await self._exponential_backoff_with_jitter(attempt, e.response)
                        logger.warning(f"[AI RETRY] Rate limited (HTTP 429), retrying in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                        continue
                
                # 处理服务器错误(5xx)
                elif attempt < retry_count and e.response.status_code >= 500:
                    wait_time = await self._exponential_backoff_with_jitter(attempt, e.response)
                    logger.warning(f"[AI RETRY] Server error, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue
                
                raise Exception(f"智谱AI请求失败({e.response.status_code}): {e.response.text}")
                
            except httpx.TimeoutException:
                last_error = Exception("请求超时")
                logger.error(f"[AI ERROR] Request timeout")
                if attempt < retry_count:
                    wait_time = await self._exponential_backoff_with_jitter(attempt)
                    logger.warning(f"[AI RETRY] Timeout, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue
                    
            except NonRetryableAIError:
                # Deterministic client error (e.g. 400): re-raise immediately instead
                # of retrying the identical rejected request.
                raise
            except Exception as e:
                last_error = e
                logger.error(f"[AI ERROR] {type(e).__name__}: {e}")
                logger.error(traceback.format_exc())
                if attempt < retry_count:
                    wait_time = await self._exponential_backoff_with_jitter(attempt)
                    if self._is_retryable_network_error(e):
                        logger.warning(
                            f"[AI RETRY] Retryable network error, retrying in {wait_time}s..."
                        )
                    else:
                        logger.warning(f"[AI RETRY] Error, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue
        
        raise last_error or Exception("智谱AI请求失败")

    async def chat_stream(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """True token streaming over Zhipu GLM's OpenAI-compatible SSE (delegates
        to the shared base streamer)."""
        async for event in self._stream_openai_compatible(
            messages, tools=tools, extra_body=extra_body
        ):
            yield event

    def get_available_models(self) -> List[str]:
        return ["glm-4", "glm-4-plus", "glm-4-0520", "glm-4-air", "glm-4-flash"]


class QianwenAIService(AIService):
    """千问AI服务"""
    
    def __init__(self, config: AIModelConfig):
        super().__init__(config)
        # 千问 OpenAI 兼容模式 API
        self.api_base = config.api_base.rstrip('/') if config.api_base else "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        # 如果用户只提供了基础URL，自动补全
        if not self.api_base.endswith('/chat/completions'):
            self.api_base = self.api_base.rstrip('/') + '/chat/completions'
        self.headers = {
            "Authorization": f"Bearer {config.api_key}",
            "Content-Type": "application/json"
        }
    
    async def chat(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        max_retries: Optional[int] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """千问AI聊天 - 带重试机制"""
        self._ensure_api_key()
        # 第3层：硬截断保护（兜底）
        messages = self._hard_truncate_messages(messages)
        
        payload = {
            "model": self.config.model,
            "messages": messages,
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens
        }
        
        if tools:
            payload["tools"] = tools
        if extra_body:
            payload.update(extra_body)
        
        # 打印AI请求摘要（脱敏：不打印完整 payload 避免泄露 key）
        logger.info(
            "[AI REQUEST] url=%s model=%s messages=%d tools=%d",
            self.api_base, payload.get("model"), len(messages),
            len(tools) if tools else 0,
        )

        # 打印完整请求原文（DEBUG级别）
        logger.debug(
            "\n%s\n[AI REQUEST RAW] url=%s\n%s\n%s",
            '=' * 60, self.api_base,
            json.dumps(payload, ensure_ascii=False, indent=2),
            '=' * 60,
        )

        last_error = None
        # 估计请求所需的tokens数量
        estimated_tokens = self.estimate_tokens(messages, tools)

        # 使用配置的重试次数或默认值
        retry_count = max_retries if max_retries is not None else self.retry_config.max_retries
        logger.info(f"[AI RETRY] Using retry count: {retry_count} (max_retries) for model {self.config.model}")

        # 总尝试次数 = max_retries + 1 (原始请求 + 重试次数)
        for attempt in range(retry_count + 1):
            try:
                # 客户端令牌桶限流 - 基于估计的token数量
                await self._consume_tokens(estimated_tokens)

                response = await self.client.post(self.api_base, json=payload, headers=self.headers)

                if response.status_code == 400:
                    error_detail = response.text
                    logger.warning(f"[AI ERROR] 400 Bad Request (not retryable): {error_detail}")
                    try:
                        error_json = response.json()
                        if "error" in error_json:
                            error_msg = error_json["error"].get("message", error_detail)
                        else:
                            error_msg = error_detail
                    except:
                        error_msg = error_detail

                    raise NonRetryableAIError(f"千问AI请求失败(400): {error_msg}")

                # 处理429速率限制错误
                if response.status_code == 429:
                    error_detail = response.text
                    logger.error(f"[AI RATE LIMIT] 429 Too Many Requests: {error_detail}")
                    
                    if attempt < retry_count:
                        wait_time = await self._exponential_backoff_with_jitter(attempt, response)
                        logger.warning(f"[AI RETRY] Rate limited, retrying in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                        continue
                    
                    raise Exception(f"千问AI请求失败(429): 速率限制，请求过于频繁")
                
                response.raise_for_status()
                
                result = response.json()
                
                # 先检查 error 字段（更符合 API 习惯）
                if "error" in result:
                    error_msg = result["error"]
                    if isinstance(error_msg, dict):
                        error_msg = error_msg.get("message", str(error_msg))
                    
                    # 检查是否是速率限制错误
                    if "rate limit" in error_msg.lower() or "too many requests" in error_msg.lower():
                        logger.error(f"[AI RATE LIMIT] Error: {error_msg}")
                        if attempt < retry_count:
                            wait_time = await self._exponential_backoff_with_jitter(attempt)
                            logger.warning(f"[AI RETRY] Rate limited by API error, retrying in {wait_time}s...")
                            await asyncio.sleep(wait_time)
                            continue
                    
                    raise Exception(f"千问AI错误: {error_msg}")
                
                # 再检查 choices 是否存在且非空
                if not result.get("choices"):
                    raise Exception(f"千问AI返回空结果")
                
                # 打印AI响应原文
                logger.info(f"\n{'='*60}\n[AI RESPONSE]:\n{json.dumps(result, ensure_ascii=False, indent=2)}\n{'='*60}")
                
                content = result["choices"][0]["message"].get("content", "")
                tool_calls = result["choices"][0]["message"].get("tool_calls")
                tool_call_origin = "native" if tool_calls else None
                reasoning_content = result["choices"][0]["message"].get("reasoning_content")  # 千问 QwQ 等推理模型支持
                finish_reason = result["choices"][0].get("finish_reason")  # 提取finish_reason
                
                # 处理模型返回的嵌套JSON格式（如包含```json标记的JSON字符串）
                if content and (content.startswith('```json') and content.endswith('```')):
                    logger.warning("[AI] 检测到嵌套JSON格式响应，尝试解析...")
                    raw_content = content
                    # 移除代码块标记
                    content = content[7:-3].strip()
                    try:
                        # 尝试解析内部JSON
                        content_json = json.loads(content)
                        # 检查是否包含reasoning_content和content的结构
                        if "reasoning_content" in content_json and "content" in content_json:
                            logger.info("[AI] 成功提取嵌套JSON中的reasoning_content和content字段")
                            reasoning_content = content_json["reasoning_content"]
                            content = content_json["content"]
                        # 检查是否只有content字段
                        elif "content" in content_json:
                            logger.info("[AI] 成功提取嵌套JSON中的content字段")
                            content = content_json["content"]
                        # 检查是否有tool_calls字段
                        elif "tool_calls" in content_json and not tool_calls:
                            parsed_tool_calls = self._text_json_tool_calls_or_none(content_json["tool_calls"])
                            if parsed_tool_calls:
                                logger.info("[AI] 通过兼容模式提取嵌套JSON中的tool_calls字段")
                                tool_calls = parsed_tool_calls
                                tool_call_origin = "text_json_fallback"
                                content = ""
                            else:
                                content = raw_content
                    except json.JSONDecodeError:
                        # 解析失败时，生成友好的错误提示
                        logger.warning("[AI] 嵌套JSON解析失败，将返回友好提示")
                        content = "抱歉，请尝试重新描述您的问题或稍后再试。"
                        reasoning_content = "模型返回了异常格式的响应，无法解析内容。"
                        tool_calls = None  # 清空工具调用，避免后续处理出错
                
                # 处理模型返回异常格式的情况：content中包含完整的reasoning_content和content结构
                if content and not reasoning_content and (not tool_calls or tool_calls == []):
                    # 检查是否包含reasoning_content和content的结构
                    import re
                    reasoning_match = re.search(r'reasoning_content:\s*"(.*?)"\s*\n\ncontent:\s*({.*})', content, re.DOTALL)
                    if reasoning_match:
                        logger.warning("[AI] 检测到异常响应格式，尝试解析...")
                        # 提取reasoning_content
                        extracted_reasoning = reasoning_match.group(1)
                        # 提取content（可能是工具调用JSON）
                        extracted_content = reasoning_match.group(2)
                        
                        try:
                            # 尝试解析content为JSON，看是否是工具调用
                            content_json = json.loads(extracted_content)
                            if "tool_calls" in content_json:
                                parsed_tool_calls = self._text_json_tool_calls_or_none(content_json["tool_calls"])
                                if parsed_tool_calls:
                                    tool_calls = parsed_tool_calls
                                    tool_call_origin = "text_json_fallback"
                                    content = ""  # 清空content，因为工具调用信息已经在tool_calls中
                                else:
                                    content = extracted_content
                            else:
                                content = extracted_content
                            # 设置reasoning_content
                            reasoning_content = extracted_reasoning
                            logger.info("[AI] 成功解析异常响应格式")
                        except json.JSONDecodeError:
                            # 解析失败时，生成友好的错误提示
                            logger.warning("[AI] 解析异常响应格式失败，将返回友好提示")
                            content = "抱歉，请尝试重新描述您的问题或稍后再试。"
                            reasoning_content = "模型返回了异常格式的响应，无法解析工具调用信息。"
                            tool_calls = None  # 清空工具调用，避免后续处理出错
                
                # 如果没有JSON格式的tool_calls，但内容包含XML格式的tool_call，则尝试解析
                if not tool_calls and "_invoke" in content:
                    content, tool_calls = self._parse_xml_tool_call_fallback(content)
                    if tool_calls:
                        tool_call_origin = "text_xml_fallback"
                
                return {
                    "content": content,
                    "reasoning_content": reasoning_content,  # 返回思考过程
                    "model_used": self.config.model,
                    "tokens_used": result.get("usage", {}).get("total_tokens"),
                    "usage": {
                        "prompt_tokens": result.get("usage", {}).get("prompt_tokens"),
                        "completion_tokens": result.get("usage", {}).get("completion_tokens"),
                        "total_tokens": result.get("usage", {}).get("total_tokens"),
                    },
                    "tool_calls": tool_calls,
                    "tool_call_origin": tool_call_origin,
                    "finish_reason": finish_reason  # 返回finish_reason
                }
                
            except httpx.HTTPStatusError as e:
                last_error = e
                logger.error(f"[AI ERROR] HTTP {e.response.status_code}")
                
                # 处理429速率限制错误
                if e.response.status_code == 429:
                    if attempt < retry_count:
                        wait_time = await self._exponential_backoff_with_jitter(attempt, e.response)
                        logger.warning(f"[AI RETRY] Rate limited (HTTP 429), retrying in {wait_time}s...")
                        await asyncio.sleep(wait_time)
                        continue
                
                # 处理服务器错误(5xx)
                elif attempt < retry_count and e.response.status_code >= 500:
                    wait_time = await self._exponential_backoff_with_jitter(attempt, e.response)
                    logger.warning(f"[AI RETRY] Server error, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue
                
                raise Exception(f"千问AI请求失败({e.response.status_code}): {e.response.text}")
                
            except httpx.TimeoutException:
                last_error = Exception("请求超时")
                logger.error(f"[AI ERROR] Request timeout")
                if attempt < retry_count:
                    wait_time = await self._exponential_backoff_with_jitter(attempt)
                    logger.warning(f"[AI RETRY] Timeout, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue
                    
            except NonRetryableAIError:
                # Deterministic client error (e.g. 400): re-raise immediately instead
                # of retrying the identical rejected request.
                raise
            except Exception as e:
                last_error = e
                logger.error(f"[AI ERROR] {type(e).__name__}: {e}")
                logger.error(traceback.format_exc())
                if attempt < retry_count:
                    wait_time = await self._exponential_backoff_with_jitter(attempt)
                    if self._is_retryable_network_error(e):
                        logger.warning(
                            f"[AI RETRY] Retryable network error, retrying in {wait_time}s..."
                        )
                    else:
                        logger.warning(f"[AI RETRY] Error, retrying in {wait_time}s...")
                    await asyncio.sleep(wait_time)
                    continue
        
        raise last_error or Exception("千问AI请求失败")

    async def chat_stream(
        self,
        messages: List[Dict],
        tools: Optional[List[Dict]] = None,
        extra_body: Optional[Dict[str, Any]] = None,
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """True token streaming over DashScope's OpenAI-compatible SSE (delegates
        to the shared base streamer)."""
        async for event in self._stream_openai_compatible(
            messages, tools=tools, extra_body=extra_body
        ):
            yield event

    def get_available_models(self) -> List[str]:
        return ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-long"]


class OpenAICompatibleAIService(QianwenAIService):
    """Generic OpenAI-compatible chat/completions service."""

    default_api_base = "https://api.openai.com/v1"
    display_name = "OpenAI-compatible"
    available_models: List[str] = []

    def __init__(self, config: AIModelConfig):
        if not config.api_base:
            config = config.model_copy(update={"api_base": self.default_api_base})
        super().__init__(config)

    def get_available_models(self) -> List[str]:
        return self.available_models


class DeepSeekAIService(OpenAICompatibleAIService):
    """DeepSeek service through its OpenAI-compatible API."""

    default_api_base = "https://api.deepseek.com"
    display_name = "DeepSeek"
    available_models = ["deepseek-v4-flash", "deepseek-v4-pro"]


class AIServiceFactory:
    """AI服务工厂"""
    
    @staticmethod
    def create_service(config: AIModelConfig) -> AIService:
        """创建AI服务实例"""
        if config.provider == "zhipu":
            return ZhipuAIService(config)
        elif config.provider == "qianwen":
            return QianwenAIService(config)
        # Any server that speaks OpenAI's /chat/completions: Ollama, llama.cpp's server, LM Studio,
        # vLLM, or a hosted gateway. The api_base is the whole configuration. 'local' used to route
        # to the Zhipu client, which cannot talk to a local server at all.
        elif config.provider in ("openai", "openai_compatible", "local"):
            return OpenAICompatibleAIService(config)
        elif config.provider == "deepseek":
            return DeepSeekAIService(config)
        else:
            raise ValueError(f"Unsupported AI provider: {config.provider}")
    
    @staticmethod
    def get_supported_providers() -> List[str]:
        """获取支持的AI提供商"""
        return ["zhipu", "qianwen", "local", "openai", "openai_compatible", "deepseek"]
