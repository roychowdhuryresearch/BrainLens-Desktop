"""
Token Estimation Utilities - 统一 token 估算逻辑

避免 summarizer.py 和 ai_service.py 各自维护一份相同的估算代码。
"""

import json
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# 默认参数
DEFAULT_CHAR_TO_TOKEN_RATIO = 2.0
DEFAULT_OVERHEAD_TOKENS = 50


def estimate_messages_tokens(
    messages: List[Dict],
    *,
    char_to_token_ratio: float = DEFAULT_CHAR_TO_TOKEN_RATIO,
    overhead_tokens: int = DEFAULT_OVERHEAD_TOKENS,
    tools: Optional[List[Dict]] = None,
) -> int:
    """估算消息列表的 token 数。

    基于字符数的保守估算：
    - 中文约 1.5 字符/token
    - 英文约 4 字符/token
    - 默认取 2.0 字符/token（偏保守）

    Args:
        messages:             消息列表
        char_to_token_ratio:  字符到 token 的转换比例
        overhead_tokens:      请求基础开销 token 数
        tools:                工具定义列表（可选，计入估算）

    Returns:
        预估的 token 数
    """
    total_chars = 0

    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            total_chars += len(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text") or ""
                    total_chars += len(text)

    if tools:
        total_chars += len(json.dumps(tools, ensure_ascii=False))

    estimated = int(total_chars / char_to_token_ratio) + overhead_tokens
    return estimated


def estimate_text_tokens(
    text: str,
    *,
    char_to_token_ratio: float = DEFAULT_CHAR_TO_TOKEN_RATIO,
) -> int:
    """估算单段文本的 token 数。"""
    if not text:
        return 0
    return int(len(text) / char_to_token_ratio)
