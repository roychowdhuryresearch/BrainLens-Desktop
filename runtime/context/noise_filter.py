"""
Noise Filter - 噪音过滤模块

清理对话历史中的低价值消息：
- 空内容消息
- 低价值短句（好的、收到、继续等）
- Assistant 套话（这是一个很好的问题、下面我来分析等）
- 错误回显（Tool not available、JSON error 等）
"""

import re
import logging
from typing import Dict, List, Tuple

logger = logging.getLogger(__name__)


# 低价值短句模式（通常是用户的简短确认）
LOW_VALUE_PATTERNS = [
    r"^好的[。！!]*$",
    r"^嗯[。！!]*$",
    r"^行[。！!]*$",
    r"^收到[。！!]*$",
    r"^继续[。！!]*$",
    r"^ok[。！!]*$",
    r"^yes[。！!]*$",
    r"^可以[。！!]*$",
    r"^对[。！!]*$",
    r"^是[。！!]*$",
    r"^明白[。！!]*$",
    r"^清楚[。！!]*$",
]

# Assistant 套话模式（AI 的固定开场白和无效输出）
ASSISTANT_NOISE_PATTERNS = [
    r"这是一个很好的问题",
    r"这是一个非常重要的问题",
    r"下面我来",
    r"让我来帮你",
    r"让我为您",
    r"我来帮你分析",
    r"完成思考",
    r"正在思考",
    r"Tool .* is not available",
    r"Tool .* is unavailable",
    r"JSON.*error",
    r"json.*error",
    r"tool execution failed",
    r"工具调用失败",
    r"调用失败",
    r"抱歉，我无法",
    r"对不起，我无法",
]

# 最小有效内容长度（字符数）
MIN_VALID_CONTENT_LENGTH = 2

# 单个 tool result 最大保留字符数
# document_get 等工具返回 50K-200K 字符，截断到 15K 已足够 LLM 理解
MAX_TOOL_RESULT_CHARS = 15000


def is_empty_content(msg: Dict) -> bool:
    """判断是否为空内容
    
    Args:
        msg: 消息字典
        
    Returns:
        是否为空内容
    """
    content = msg.get("content")
    
    # 完全没有 content 字段
    if content is None:
        return True
    
    # content 为空字符串或纯空白
    if isinstance(content, str):
        return len(content.strip()) == 0
    
    # 其他情况（如列表、字典等）视为非空
    return False


def is_low_value_short_phrase(msg: Dict) -> bool:
    """判断是否为低价值短句
    
    匹配用户常见的简短确认回复。
    
    Args:
        msg: 消息字典
        
    Returns:
        是否为低价值短句
    """
    content = (msg.get("content") or "").strip()
    
    # 内容太长不考虑
    if len(content) > 20:
        return False
    
    # 匹配低价值模式
    for pattern in LOW_VALUE_PATTERNS:
        if re.match(pattern, content, re.IGNORECASE):
            return True
    
    return False


def is_assistant_noise(msg: Dict) -> bool:
    """判断是否为 assistant 套话
    
    匹配 AI 常见的无效开场白和错误回显。
    
    Args:
        msg: 消息字典
        
    Returns:
        是否为 assistant 套话
    """
    role = msg.get("role")
    
    # 只检查 assistant 消息
    if role != "assistant":
        return False
    
    content = (msg.get("content") or "").strip()
    
    # 空内容不算套话
    if not content:
        return False
    
    # 匹配套话模式
    for pattern in ASSISTANT_NOISE_PATTERNS:
        if re.search(pattern, content, re.IGNORECASE):
            return True
    
    return False


def is_error_trace(msg: Dict) -> bool:
    """判断是否为错误回显
    
    检测工具调用错误、JSON 解析错误等。
    
    Args:
        msg: 消息字典
        
    Returns:
        是否为错误回显
    """
    content = (msg.get("content") or "").strip()
    
    # 检查是否包含错误模式
    error_patterns = [
        r"Tool .* is not available",
        r"Tool .* is unavailable", 
        r"JSON.*error",
        r"json.*error",
        r"tool execution failed",
        r"工具调用失败",
        r"调用失败",
        r"error:",
        r"Error:",
        r"exception:",
        r"Exception:",
    ]
    
    for pattern in error_patterns:
        if re.search(pattern, content, re.IGNORECASE):
            return True
    
    return False


def is_low_value_message(msg: Dict) -> bool:
    """判断是否为低价值消息
    
    综合判断消息是否应该被过滤。
    包括：空内容、低价值短句、assistant 套话、错误回显。
    
    Args:
        msg: 消息字典
        
    Returns:
        是否为低价值消息
    """
    # 空内容
    if is_empty_content(msg):
        return True
    
    # 低价值短句
    if is_low_value_short_phrase(msg):
        return True
    
    # Assistant 套话
    if is_assistant_noise(msg):
        return True

    # 错误回显（仅针对非 user 消息）。用户的问题里若提到「失败/报错/error」
    # （如「为什么检测失败了」）不是错误回显，绝不能被当作低价值消息丢出上下文。
    if msg.get("role") != "user" and is_error_trace(msg):
        return True

    return False


def deduplicate_messages(messages: List[Dict]) -> List[Dict]:
    """去重相同 role+content 的消息
    
    移除连续重复的相同消息。
    
    Args:
        messages: 消息列表
        
    Returns:
        去重后的消息列表
    """
    if not messages:
        return []
    
    deduped = []
    prev_key = None
    
    for msg in messages:
        # 构造去重 key
        role = msg.get("role", "")
        content = msg.get("content", "")
        
        # tool 消息需要考虑 tool_call_id
        if role == "tool":
            tool_call_id = msg.get("tool_call_id", "")
            key = f"{role}:{tool_call_id}:{content[:100] if content else ''}"
        else:
            key = f"{role}:{content[:100] if content else ''}"
        
        # 只保留与上一条不同的消息
        if key != prev_key:
            deduped.append(msg)
            prev_key = key
    
    return deduped


def filter_noise(messages: List[Dict], enable: bool = True) -> Tuple[List[Dict], int]:
    """过滤噪音消息
    
    过滤低价值消息并去重。
    
    Args:
        messages: 原始消息列表
        enable: 是否启用噪音过滤
        
    Returns:
        (过滤后的消息列表, 过滤掉的消息数量)
    """
    if not enable:
        return messages, 0
    
    original_count = len(messages)
    
    # Step 1: 过滤低价值消息
    filtered = []
    removed_count = 0
    
    for msg in messages:
        if is_low_value_message(msg):
            removed_count += 1
            # 详细记录被过滤的消息
            content_preview = (msg.get('content') or '')[:50]
            logger.info(f"[NoiseFilter] Removed: role={msg.get('role')}, content='{content_preview}'")
        else:
            filtered.append(msg)
    
    # Step 2: 去重
    deduped = deduplicate_messages(filtered)
    
    # 计算总移除数量
    total_removed = original_count - len(deduped)
    
    if total_removed > 0:
        logger.info(f"[NoiseFilter] Filtered {total_removed} messages "
                   f"(noise: {removed_count}, dedup: {len(filtered) - len(deduped)})")
    
    return deduped, total_removed


def get_content_hash(msg: Dict) -> str:
    """获取消息内容的哈希值（用于去重）
    
    Args:
        msg: 消息字典
        
    Returns:
        内容哈希字符串
    """
    role = msg.get("role", "")
    content = msg.get("content", "")
    
    if role == "tool":
        tool_call_id = msg.get("tool_call_id", "")
        return f"{role}:{tool_call_id}:{hash(content)}"
    
    return f"{role}:{hash(content)}"


# ============================================================================
# Tool Result 内容清理（规则方法，零延迟）
# ============================================================================

# Base64 图片数据模式
BASE64_IMAGE_PATTERN = re.compile(
    r'data:image/[a-zA-Z]+;base64,[A-Za-z0-9+/=]+',
    re.IGNORECASE
)

# Base64 通用模式（长字符串）
BASE64_LONG_PATTERN = re.compile(
    r'[A-Za-z0-9+/]{100,}={0,2}',
    re.IGNORECASE
)

# URL 模式
URL_PATTERN = re.compile(
    r'https?://[^\s<>"{}|\\^`\[\]]+',
    re.IGNORECASE
)

# HTML 标签模式
HTML_TAG_PATTERN = re.compile(
    r'<[^>]+>',
    re.IGNORECASE
)

# 连续空白模式（多个空格、换行、制表符）
WHITESPACE_PATTERN = re.compile(
    r'\s+',
    re.MULTILINE
)

# JSON 中的重复键值对（简化）
REPEATED_JSON_FIELD_PATTERN = re.compile(
    r'("[\w_]+"\s*:\s*"[^"]{50,}",\s*)+',
    re.IGNORECASE
)


def sanitize_tool_result(
    content: str,
    max_length: int = MAX_TOOL_RESULT_CHARS,
    remove_images: bool = True,
    truncate_urls: bool = True,
    remove_html: bool = True,
    compress_whitespace: bool = True
) -> str:
    """清理 tool_result 中的无效内容（规则方法，零延迟）

    针对 MCP 工具返回的超长内容进行预处理，移除或压缩：
    1. Base64 图片数据 - 动辄几十万字符，无语义价值
    2. 超长 URL - 保留域名和路径，截断查询参数
    3. HTML 标签 - 移除标签，保留文本
    4. 连续空白 - 压缩为单个空格
    5. 最终截断到 max_length（默认 15K）

    Args:
        content: 原始 tool_result 内容
        max_length: 最大保留长度（字符数），默认 MAX_TOOL_RESULT_CHARS (15K)
        remove_images: 是否移除 base64 图片数据
        truncate_urls: 是否截断超长 URL
        remove_html: 是否移除 HTML 标签
        compress_whitespace: 是否压缩连续空白

    Returns:
        清理后的内容
    """
    if not content:
        return content
    
    original_length = len(content)
    
    # Step 1: 移除 base64 图片数据（最大节省）
    if remove_images:
        # 先处理 data:image 格式
        content = BASE64_IMAGE_PATTERN.sub('[IMAGE]', content)
        # 再处理裸 base64 长字符串（可能是图片数据）
        # 但要小心不要误伤有效的 JSON 字符串
        content = BASE64_LONG_PATTERN.sub('[DATA_TRUNCATED]', content)
    
    # Step 2: 截断超长 URL
    if truncate_urls:
        def truncate_url(match):
            url = match.group(0)
            if len(url) > 200:
                # 保留前 150 字符 + ... + 后 50 字符
                return url[:150] + '...' + url[-50:]
            return url
        content = URL_PATTERN.sub(truncate_url, content)
    
    # Step 3: 移除 HTML 标签
    if remove_html:
        content = HTML_TAG_PATTERN.sub('', content)
    
    # Step 4: 压缩连续空白
    if compress_whitespace:
        content = WHITESPACE_PATTERN.sub(' ', content)
    
    # Step 5: 最终截断（硬限制）
    if len(content) > max_length:
        content = content[:max_length] + f"\n\n[文档内容较长，已截取前 {max_length} 字符，原始长度: {original_length}]"
    
    final_length = len(content)
    compression_ratio = (1 - final_length / original_length) * 100 if original_length > 0 else 0
    
    if original_length != final_length:
        logger.info(f"[NoiseFilter] Sanitized tool_result: {original_length} -> {final_length} chars "
                   f"(saved {compression_ratio:.1f}%)")
    
    return content


def estimate_content_savings(content: str) -> Dict:
    """预估内容清理可节省的空间
    
    用于调试和分析，不实际执行清理。
    
    Args:
        content: 原始内容
        
    Returns:
        包含各项预估节省的字典
    """
    if not content:
        return {"original": 0, "estimated_final": 0}
    
    original = len(content)
    
    # 预估各项节省
    base64_matches = BASE64_IMAGE_PATTERN.findall(content) + BASE64_LONG_PATTERN.findall(content)
    base64_chars = sum(len(m) for m in base64_matches)
    
    url_matches = URL_PATTERN.findall(content)
    url_overhead = sum(max(0, len(u) - 200) for u in url_matches)  # 超过 200 字符的部分
    
    html_matches = HTML_TAG_PATTERN.findall(content)
    html_chars = sum(len(m) for m in html_matches)
    
    # 预估压缩后大小
    estimated_final = original - base64_chars - url_overhead - html_chars
    estimated_final = max(estimated_final, 0)
    
    return {
        "original": original,
        "base64_chars": base64_chars,
        "url_overhead": url_overhead,
        "html_chars": html_chars,
        "estimated_final": estimated_final,
        "estimated_savings": original - estimated_final,
        "compression_ratio": (1 - estimated_final / original) * 100 if original > 0 else 0
    }
