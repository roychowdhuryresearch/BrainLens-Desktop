import logging
from typing import Dict, List

from runtime.context.noise_filter import MAX_TOOL_RESULT_CHARS, sanitize_tool_result

logger = logging.getLogger(__name__)


class RuntimeMessageCompressor:
    """Runtime-owned tool/message sanitation before LLM calls."""

    async def compress_messages_if_needed(
        self,
        messages: List[Dict],
        max_chars: int = 400000,
    ) -> List[Dict]:
        total_chars = sum(len(str(message.get("content", ""))) for message in messages)
        if total_chars <= max_chars:
            return messages

        logger.warning(
            "[Agent] Messages too long (%s > %s), applying rule-based compression...",
            total_chars,
            max_chars,
        )
        compressed = list(messages)

        for index, message in enumerate(compressed):
            if message.get("role") != "tool":
                continue
            content = str(message.get("content", ""))
            if len(content) <= MAX_TOOL_RESULT_CHARS:
                continue

            cleaned_content = sanitize_tool_result(
                content,
                max_length=MAX_TOOL_RESULT_CHARS,
                remove_images=True,
                truncate_urls=True,
                remove_html=True,
                compress_whitespace=True,
            )
            old_len = len(content)
            new_len = len(cleaned_content)
            if old_len == new_len:
                continue
            compressed[index] = {**message, "content": cleaned_content}
            total_chars = total_chars - old_len + new_len
            logger.info("[Agent] Rule-based sanitize tool_result: %s -> %s chars", old_len, new_len)

        if total_chars > max_chars:
            logger.warning("[Agent] Still too long (%s), applying hard truncation...", total_chars)
            for index, message in enumerate(compressed):
                if total_chars <= max_chars:
                    break
                content = str(message.get("content", ""))
                if len(content) <= MAX_TOOL_RESULT_CHARS:
                    continue

                truncated = (
                    content[:MAX_TOOL_RESULT_CHARS]
                    + f"\n\n[文档内容较长，已截取前 {MAX_TOOL_RESULT_CHARS} 字符，原始长度: {len(content)}]"
                )
                old_len = len(content)
                new_len = len(truncated)
                total_chars = total_chars - old_len + new_len
                compressed[index] = {**message, "content": truncated}
                logger.info("[Agent] Hard truncated message: %s -> %s chars", old_len, new_len)

        logger.warning("[Agent] Compression complete: %s chars (rule-based, no LLM calls)", total_chars)
        return compressed
