"""
Summarizer - 摘要生成模块

使用 LLM 对对话历史进行结构化压缩，生成：
- conversation_goal: 对话目标
- important_facts: 重要事实
- constraints: 约束条件
- decisions_made: 已做决策
- open_questions: 待解决问题
- current_focus: 当前焦点

支持分段压缩：当输入过长时，分段调用 LLM 压缩后合并结果
"""

import json
import logging
import re
import time
from typing import Dict, List, Optional

from runtime.context.models import SummaryResult
from runtime.prompts import load_prompt

logger = logging.getLogger(__name__)


def _extract_usage_metrics(response: Optional[Dict]) -> tuple[int, int, int]:
    usage = response.get("usage") if isinstance(response, dict) else None
    if not isinstance(usage, dict):
        return 0, 0, 0
    return (
        int(usage.get("prompt_tokens") or 0),
        int(usage.get("completion_tokens") or 0),
        int(usage.get("total_tokens") or 0),
    )

# 分段压缩配置
MAX_CHUNK_CHARS = 300000  # 每段最大字符数（约 100K tokens）
COMPRESS_CHUNK_CHARS = 50000  # tool_result 压缩分段大小


SUMMARIZER_PROMPT = load_prompt("context/summarizer.md")


def build_summary_prompt(
    previous_summary: str,
    messages: List[Dict]
) -> str:
    """构建摘要生成的 prompt
    
    Args:
        previous_summary: 之前的摘要（如果有）
        messages: 需要摘要的消息列表
        
    Returns:
        完整的 prompt 字符串
    """
    parts = [SUMMARIZER_PROMPT]
    
    # 如果有之前的摘要，加入上下文
    if previous_summary:
        parts.append("\n\n【之前的摘要】")
        parts.append(previous_summary)
        parts.append("\n\n【新增对话】")
    else:
        parts.append("\n\n【对话历史】")
    
    # 格式化消息
    for msg in messages:
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        
        # 简化角色名称
        role_display = {
            "user": "用户",
            "assistant": "助手",
            "system": "系统",
            "tool": "工具"
        }.get(role, role)
        
        # 截断过长的内容
        if len(content) > 500:
            content = content[:500] + "..."
        
        parts.append(f"\n{role_display}: {content}")
    
    return "\n".join(parts)


def parse_summary_response(response: str) -> SummaryResult:
    """解析 LLM 返回的摘要 JSON
    
    Args:
        response: LLM 返回的文本
        
    Returns:
        SummaryResult 对象
    """
    # 尝试提取 JSON
    json_str = response.strip()
    
    # 如果响应被 markdown 代码块包裹，提取内容
    json_match = re.search(r'```(?:json)?\s*([\s\S]*?)\s*```', json_str)
    if json_match:
        json_str = json_match.group(1)
    
    # 尝试找到 JSON 对象
    json_obj_match = re.search(r'\{[\s\S]*\}', json_str)
    if json_obj_match:
        json_str = json_obj_match.group(0)
    
    try:
        data = json.loads(json_str)
        
        result = SummaryResult(
            conversation_goal=data.get("conversation_goal", ""),
            important_facts=data.get("important_facts", []),
            constraints=data.get("constraints", []),
            decisions_made=data.get("decisions_made", []),
            open_questions=data.get("open_questions", []),
            current_focus=data.get("current_focus", ""),
            raw_text=response
        )
        
        logger.info(f"[Summarizer] Parsed summary: goal={result.conversation_goal[:50] if result.conversation_goal else 'N/A'}, "
                   f"facts={len(result.important_facts)}, constraints={len(result.constraints)}")
        
        return result
        
    except json.JSONDecodeError as e:
        logger.warning(f"[Summarizer] Failed to parse JSON: {e}, using raw text as fallback")
        
        # JSON 解析失败，使用原始文本作为兜底
        return SummaryResult(
            conversation_goal="",
            important_facts=[],
            constraints=[],
            decisions_made=[],
            open_questions=[],
            current_focus="",
            raw_text=response
        )


def _split_messages_to_chunks(
    messages: List[Dict], 
    max_chunk_chars: int
) -> List[List[Dict]]:
    """将消息分割成多个 chunk，每个 chunk 不超过 max_chunk_chars 字符
    
    Args:
        messages: 消息列表
        max_chunk_chars: 每个 chunk 的最大字符数
        
    Returns:
        chunk 列表
    """
    chunks = []
    current_chunk = []
    current_chars = 0
    
    for msg in messages:
        msg_chars = len(str(msg.get("content", "")))
        
        if current_chars + msg_chars > max_chunk_chars and current_chunk:
            # 当前 chunk 已满，开始新 chunk
            chunks.append(current_chunk)
            current_chunk = []
            current_chars = 0
        
        current_chunk.append(msg)
        current_chars += msg_chars
    
    # 添加最后一个 chunk
    if current_chunk:
        chunks.append(current_chunk)
    
    return chunks


def _merge_summaries(
    summaries: List[SummaryResult], 
    final_previous: str
) -> SummaryResult:
    """合并多个摘要结果
    
    Args:
        summaries: 各 chunk 的摘要结果列表
        final_previous: 最终的 previous summary
        
    Returns:
        合并后的 SummaryResult
    """
    if not summaries:
        return SummaryResult(raw_text=final_previous)
    
    # 收集所有字段
    all_goals = []
    all_facts = []
    all_constraints = []
    all_decisions = []
    all_questions = []
    all_focus = []
    raw_texts = []
    
    for s in summaries:
        if s.conversation_goal:
            all_goals.append(s.conversation_goal)
        all_facts.extend(s.important_facts)
        all_constraints.extend(s.constraints)
        all_decisions.extend(s.decisions_made)
        all_questions.extend(s.open_questions)
        if s.current_focus:
            all_focus.append(s.current_focus)
        if s.raw_text:
            raw_texts.append(s.raw_text)
    
    # 去重和合并
    unique_facts = list(dict.fromkeys(all_facts))  # 保持顺序去重
    unique_constraints = list(dict.fromkeys(all_constraints))
    unique_decisions = list(dict.fromkeys(all_decisions))
    unique_questions = list(dict.fromkeys(all_questions))
    
    # 取最新的 focus 和 goal
    final_goal = all_goals[-1] if all_goals else ""
    final_focus = all_focus[-1] if all_focus else ""
    
    result = SummaryResult(
        conversation_goal=final_goal,
        important_facts=unique_facts[:10],  # 限制数量
        constraints=unique_constraints[:5],
        decisions_made=unique_decisions[:5],
        open_questions=unique_questions[:5],
        current_focus=final_focus,
        raw_text="\n\n".join(raw_texts) if raw_texts else final_previous,
        llm_calls=sum(item.llm_calls for item in summaries),
        llm_duration_ms=sum(item.llm_duration_ms for item in summaries),
        model_used=next((item.model_used for item in reversed(summaries) if item.model_used), ""),
        prompt_tokens=sum(item.prompt_tokens for item in summaries),
        completion_tokens=sum(item.completion_tokens for item in summaries),
        total_tokens=sum(item.total_tokens for item in summaries),
    )
    
    logger.info(f"[Summarizer] Merged {len(summaries)} summaries: "
               f"facts={len(result.important_facts)}, decisions={len(result.decisions_made)}")
    
    return result


async def _summarize_single_chunk(
    ai_service,
    chunk: List[Dict],
    previous_summary: str,
    temperature: float
) -> SummaryResult:
    """压缩单个 chunk
    
    Args:
        ai_service: AI 服务实例
        chunk: 单个 chunk 的消息列表
        previous_summary: 之前的摘要
        temperature: 生成温度
        
    Returns:
        SummaryResult
    """
    prompt = build_summary_prompt(previous_summary, chunk)
    summarizer_messages = [
        {"role": "user", "content": prompt}
    ]

    # 通过 extra_body 传递 temperature，避免修改全局 config（并发安全）
    started_at = time.perf_counter()
    response = await ai_service.chat(
        summarizer_messages,
        tools=None,
        extra_body={"temperature": temperature},
    )
    elapsed_ms = (time.perf_counter() - started_at) * 1000
    
    content = response.get("content", "")
    
    if not content:
        logger.warning("[Summarizer] Empty response for chunk")
        return SummaryResult(raw_text=previous_summary)

    prompt_tokens, completion_tokens, total_tokens = _extract_usage_metrics(response)
    result = parse_summary_response(content)
    result.llm_calls = 1
    result.llm_duration_ms = elapsed_ms
    result.model_used = response.get("model_used", "")
    result.prompt_tokens = prompt_tokens
    result.completion_tokens = completion_tokens
    result.total_tokens = total_tokens
    return result


async def _summarize_in_chunks(
    ai_service,
    messages: List[Dict],
    previous_summary: str = "",
    temperature: float = 0.3
) -> SummaryResult:
    """分段压缩：将消息分成多个 chunk，分别压缩后合并
    
    Args:
        ai_service: AI 服务实例
        messages: 需要摘要的消息列表
        previous_summary: 之前的摘要
        temperature: 生成温度
        
    Returns:
        合并后的 SummaryResult
    """
    # 按字符数分割消息
    chunks = _split_messages_to_chunks(messages, MAX_CHUNK_CHARS)
    
    logger.info(f"[Summarizer] Split into {len(chunks)} chunks")
    
    # 收集每段的摘要结果
    chunk_summaries = []
    current_previous = previous_summary
    
    for i, chunk in enumerate(chunks):
        chunk_chars = sum(len(str(m.get("content", ""))) for m in chunk)
        logger.info(f"[Summarizer] Processing chunk {i+1}/{len(chunks)}, chars={chunk_chars}")
        
        try:
            # 压缩当前 chunk
            result = await _summarize_single_chunk(
                ai_service=ai_service,
                chunk=chunk,
                previous_summary=current_previous,
                temperature=temperature
            )
            
            # 更新 previous_summary 用于下一个 chunk（增量压缩）
            if result.to_summary_text():
                current_previous = result.to_summary_text()
            
            chunk_summaries.append(result)
            
        except Exception as e:
            logger.warning(f"[Summarizer] Failed to summarize chunk {i+1}: {e}")
            # 继续处理下一个 chunk
    
    # 合并所有摘要
    return _merge_summaries(chunk_summaries, previous_summary)


async def summarize_messages(
    ai_service,
    messages: List[Dict],
    previous_summary: str = "",
    temperature: float = 0.3
) -> SummaryResult:
    """调用 LLM 生成结构化摘要（支持分段压缩）
    
    Args:
        ai_service: AI 服务实例
        messages: 需要摘要的消息列表
        previous_summary: 之前的摘要（用于增量更新）
        temperature: 生成温度
        
    Returns:
        SummaryResult 对象
    """
    if not messages:
        logger.info("[Summarizer] No messages to summarize")
        return SummaryResult(raw_text=previous_summary)
    
    # 计算总字符数
    total_chars = sum(
        len(str(m.get("content", ""))) 
        for m in messages
    )
    
    logger.info(f"[Summarizer] Summarizing {len(messages)} messages, "
               f"total_chars={total_chars}, previous_summary_len={len(previous_summary)}")
    
    try:
        # 判断是否需要分段压缩
        if total_chars > MAX_CHUNK_CHARS:
            logger.info(f"[Summarizer] Content too long ({total_chars} > {MAX_CHUNK_CHARS}), using chunked summarization")
            return await _summarize_in_chunks(
                ai_service=ai_service,
                messages=messages,
                previous_summary=previous_summary,
                temperature=temperature
            )
        
        # 正常单次压缩
        prompt = build_summary_prompt(previous_summary, messages)
        summarizer_messages = [
            {"role": "user", "content": prompt}
        ]
        
        # 调用 LLM（使用较低温度以获得稳定输出）。
        # 通过 extra_body 传 temperature，避免修改进程级共享的 config：
        # 一旦 chat() 抛异常，旧的「mutate + 成功路径才恢复」写法不会还原温度，
        # 会污染本轮后续所有 LLM 调用（且并发不安全）。与分块路径保持一致。
        started_at = time.perf_counter()
        response = await ai_service.chat(
            summarizer_messages,
            tools=None,
            extra_body={"temperature": temperature},
        )
        elapsed_ms = (time.perf_counter() - started_at) * 1000

        content = response.get("content", "")
        
        if not content:
            logger.warning("[Summarizer] Empty response from LLM")
            return SummaryResult(raw_text=previous_summary)
        
        logger.debug(f"[Summarizer] LLM response: {content[:500]}...")
        
        # 解析响应
        result = parse_summary_response(content)
        prompt_tokens, completion_tokens, total_tokens = _extract_usage_metrics(response)
        result.llm_calls = 1
        result.llm_duration_ms = elapsed_ms
        result.model_used = response.get("model_used", "")
        result.prompt_tokens = prompt_tokens
        result.completion_tokens = completion_tokens
        result.total_tokens = total_tokens
        
        # 如果解析失败但有之前的摘要，合并
        if not result.conversation_goal and previous_summary:
            result.raw_text = previous_summary + "\n\n" + result.raw_text
        
        return result
        
    except Exception as e:
        logger.error(f"[Summarizer] Failed to generate summary: {e}")
        
        # 出错时返回之前的摘要
        return SummaryResult(
            raw_text=previous_summary,
            important_facts=[f"摘要生成失败: {str(e)}"]
        )


def format_summary_for_injection(summary: SummaryResult) -> str:
    """将摘要格式化为可注入到 prompt 的文本
    
    Args:
        summary: 摘要结果
        
    Returns:
        格式化的摘要文本
    """
    return summary.to_summary_text()


def estimate_messages_tokens(messages: List[Dict]) -> int:
    """预估消息列表的 token 数（委托给 token_utils 统一实现）。"""
    from runtime.utils.token_utils import estimate_messages_tokens as _estimate
    return _estimate(messages, char_to_token_ratio=2.5, overhead_tokens=0)


def should_trigger_summary(
    messages: List[Dict],
    state,
    config
) -> bool:
    """判断是否需要触发摘要（简化版）
    
    简化后的触发逻辑：
    只检查轮次条件：turns_since_last >= summary_trigger_turns
    
    这样确保触发时有足够的旧消息可以摘要。
    
    Args:
        messages: 消息列表
        state: 会话状态
        config: 配置（使用 property 自动推导阈值）
        
    Returns:
        是否需要触发摘要
    """
    # 摘要功能未启用
    if not config.enable_context_summary:
        return False
    
    # 核心条件：距上次摘要累计足够轮次
    turns_since_last = state.total_turns - state.last_summary_turn
    trigger_turns = config.summary_trigger_turns  # property: recent_keep_turns + 2
    
    if turns_since_last >= trigger_turns:
        logger.info(f"[Summarizer] Trigger summary: turns since last {turns_since_last} >= {trigger_turns}")
        return True
    
    # 保留 token 阈值检查作为备用条件
    estimated_tokens = estimate_messages_tokens(messages)
    if estimated_tokens >= config.summary_trigger_tokens:  # property: max_context_tokens * 0.75
        logger.info(f"[Summarizer] Trigger summary: tokens {estimated_tokens} >= {config.summary_trigger_tokens}")
        return True
    
    return False
