"""
Context Manager - 上下文管理核心类

职责：
- 读取会话上下文状态
- 清洗无效历史
- 对旧历史做总结
- 输出发给主模型的上下文消息列表
- 在每轮结束后更新 summary
"""

import logging
from typing import Dict, List, Optional, Any

from runtime.context.models import (
    ContextPack,
    ConversationContextState,
    ContextConfig,
    SummaryResult,
)
from runtime.context.state_store import InMemoryContextStateStore
from runtime.context.noise_filter import filter_noise
from runtime.context.summarizer import (
    summarize_messages,
    estimate_messages_tokens,
    should_trigger_summary,
    format_summary_for_injection,
)
from runtime.context.context_logger import context_logger

logger = logging.getLogger(__name__)


class ContextManager:
    """上下文管理器
    
    为 Agent 的 stream_message() 方法提供上下文管理能力：
    1. 噪音过滤：清理低价值消息
    2. 上下文摘要：对长对话进行压缩
    3. 滚动摘要：持续更新对话摘要
    
    使用方式：
        # 初始化
        context_manager = ContextManager(ai_service)
        
        # 准备上下文（在构建 prompt 前调用）
        context_pack = await context_manager.prepare_context(
            conversation_id="conv_123",
            history=history,
            user_message="用户消息",
        )
        
        # 使用处理后的消息
        messages.extend(context_pack.messages_for_model)
        
        # 更新摘要（在对话结束后调用）
        await context_manager.update_summary_after_turn(
            conversation_id="conv_123",
            history=clean_history,
            latest_user_message="用户消息",
            latest_assistant_message="助手回复",
        )
    """
    
    def __init__(
        self,
        ai_service: Any,
        context_store: Optional[InMemoryContextStateStore] = None,
        config: Optional[ContextConfig] = None
    ):
        """初始化上下文管理器
        
        Args:
            ai_service: AI 服务实例，用于生成摘要
            context_store: 状态存储，默认使用内存存储
            config: 配置项
        """
        self.ai_service = ai_service
        self.context_store = context_store or InMemoryContextStateStore()
        self.config = config or ContextConfig()
        
        logger.info(f"[ContextManager] Initialized with config: "
                   f"max_tokens={self.config.max_context_tokens}, "
                   f"summary_trigger={self.config.summary_trigger_msg_count} msgs / {self.config.summary_trigger_tokens} tokens")
    
    async def prepare_context(
        self,
        conversation_id: str,
        history: List[Dict],
        user_message: str,
        skill_context: Optional[Any] = None,
        max_context_tokens: Optional[int] = None,
    ) -> ContextPack:
        """准备发送给模型的上下文
        
        主要流程：
        1. 加载会话状态
        2. 过滤噪音消息
        3. 判断是否需要摘要
        4. 如需摘要，调用 LLM 生成
        5. 组装最终消息列表
        
        Args:
            conversation_id: 会话 ID
            history: 对话历史
            user_message: 当前用户消息
            skill_context: Skill 运行时上下文（可选）
            max_context_tokens: 最大上下文 token 数（可选，覆盖配置）
            
        Returns:
            ContextPack 包含处理后的消息和元数据
        """
        max_tokens = max_context_tokens or self.config.max_context_tokens
        
        # 记录请求开始
        context_logger.log_request_start(
            conversation_id=conversation_id,
            history_count=len(history),
            user_message=user_message
        )
        
        logger.info(f"[ContextManager] Preparing context for conversation: {conversation_id}")
        logger.debug(f"[ContextManager] History length: {len(history)}, user_message_len: {len(user_message)}")
        
        # Step 1: 加载会话状态
        state = await self.context_store.load(conversation_id)
        
        # 记录状态加载
        context_logger.log_state_loaded(
            conversation_id=conversation_id,
            total_turns=state.total_turns,
            last_summary_turn=state.last_summary_turn,
            has_rolling_summary=bool(state.rolling_summary)
        )
        
        # Step 2: 过滤噪音消息
        # 优化：对长对话先快速判断是否需要摘要，
        # 不需要时只过滤最近消息，避免处理全部历史
        recent_keep_msgs = self.config.recent_keep_turns * 2
        _quick_need_summary = (
            self.config.enable_context_summary
            and (state.total_turns - state.last_summary_turn) >= self.config.summary_trigger_turns
        )
        if not _quick_need_summary and len(history) > recent_keep_msgs + 20:
            # 只过滤最近部分消息（节省 CPU）
            tail_size = recent_keep_msgs + 10
            tail = history[-tail_size:]
            filtered_tail, removed_noise = filter_noise(
                tail, enable=self.config.enable_noise_filter,
            )
            # 计算总过滤量（前面未过滤的消息按 0 噪音计）
            filtered_history = history[:-tail_size] + filtered_tail
            logger.info(
                "[ContextManager] Fast-path noise filter: only filtered tail %d of %d messages (removed %d)",
                tail_size, len(history), removed_noise,
            )
        else:
            filtered_history, removed_noise = filter_noise(
                history,
                enable=self.config.enable_noise_filter,
            )

        # 记录噪音过滤
        context_logger.log_noise_filtered(
            original_count=len(history),
            filtered_count=len(filtered_history),
            removed_count=removed_noise
        )

        logger.info(f"[ContextManager] After noise filter: {len(filtered_history)} messages (removed {removed_noise})")

        # Step 3: 判断是否需要摘要
        need_summary = should_trigger_summary(filtered_history, state, self.config)
        
        # 计算是否有足够消息可摘要
        turns_since_last = state.total_turns - state.last_summary_turn
        estimated_tokens = estimate_messages_tokens(filtered_history)
        recent_keep_msgs = self.config.recent_keep_turns * 2
        has_enough_messages = len(filtered_history) > recent_keep_msgs
        
        # 记录摘要触发检查（增强版）
        context_logger.log_summary_trigger_check(
            msg_count=len(filtered_history),
            estimated_tokens=estimated_tokens,
            turns_since_last=turns_since_last,
            triggered=need_summary,
            trigger_turns=self.config.summary_trigger_turns,
            trigger_tokens=self.config.summary_trigger_tokens,
            recent_keep_turns=self.config.recent_keep_turns,
            enable_summary=self.config.enable_context_summary,
            has_enough_messages=has_enough_messages,
            recent_keep_msgs=recent_keep_msgs
        )
        
        summary_text = None
        used_summary = False
        dropped_messages = 0
        summary_metrics: Dict[str, Any] = {}
        
        # Step 4: 生成摘要（如果需要）
        # 统一用消息数判断（轮次 * 2 = 消息数）
        if need_summary and len(filtered_history) >= self.config.recent_keep_turns * 2:
            # 按完整轮次切分：保留最近 N 轮，对旧消息进行摘要
            recent_messages, old_messages = self._split_by_turns(
                filtered_history, 
                self.config.recent_keep_turns
            )
            
            if old_messages:
                # 记录摘要开始
                context_logger.log_summary_generation_start(
                    conversation_id=conversation_id,
                    messages_to_summarize=len(old_messages),
                    has_previous_summary=bool(state.rolling_summary)
                )
                
                logger.info(f"[ContextManager] Generating summary for {len(old_messages)} old messages")
                
                # 调用 LLM 生成摘要
                summary_result = await summarize_messages(
                    ai_service=self.ai_service,
                    messages=old_messages,
                    previous_summary=state.rolling_summary,
                    temperature=self.config.summarizer_temperature
                )
                
                summary_text = format_summary_for_injection(summary_result)
                used_summary = True
                dropped_messages = len(old_messages)
                summary_metrics = {
                    "llm_calls": summary_result.llm_calls,
                    "llm_duration_ms": summary_result.llm_duration_ms,
                    "model_used": summary_result.model_used,
                    "prompt_tokens": summary_result.prompt_tokens,
                    "completion_tokens": summary_result.completion_tokens,
                    "total_tokens": summary_result.total_tokens,
                }
                
                # 先捕获上一份 rolling summary，然后再覆盖 —— 否则下面 log
                # 里 `state.rolling_summary != summary_text` 永远为 False，
                # `previous_summary` 传出去永远是空串，摘要版本变更完全没法回溯。
                previous_summary_snapshot = state.rolling_summary or ""

                # 更新状态
                state.rolling_summary = summary_text
                state.last_summary_turn = state.total_turns  # 记录当前轮次
                try:
                    await self.context_store.save(state)
                except Exception as save_exc:
                    logger.error(
                        "[ContextManager] Failed to save context state for %s: %s",
                        conversation_id, save_exc,
                    )

                # 记录摘要完成（基本信息）
                context_logger.log_summary_generated(
                    conversation_id=conversation_id,
                    summary_length=len(summary_text),
                    dropped_messages=dropped_messages,
                    conversation_goal=summary_result.conversation_goal,
                    facts_count=len(summary_result.important_facts),
                    decisions_count=len(summary_result.decisions_made)
                )

                # 记录摘要内容（详细信息：原文和结果）
                context_logger.log_summary_content(
                    conversation_id=conversation_id,
                    original_messages=old_messages,
                    summary_text=summary_text,
                    conversation_goal=summary_result.conversation_goal,
                    important_facts=summary_result.important_facts,
                    constraints=summary_result.constraints,
                    decisions_made=summary_result.decisions_made,
                    open_questions=summary_result.open_questions,
                    current_focus=summary_result.current_focus,
                    previous_summary=previous_summary_snapshot if previous_summary_snapshot != summary_text else ""
                )
                
                logger.info(f"[ContextManager] Summary generated, length: {len(summary_text)}")
        
        # Step 5: 组装最终消息列表
        messages_for_model = self._assemble_messages(
            filtered_history=filtered_history,
            summary_text=summary_text,
            user_message=user_message,
            recent_keep_turns=self.config.recent_keep_turns
        )
        
        # 预估 token 数
        token_estimate = estimate_messages_tokens(messages_for_model)
        
        # 记录上下文组装完成
        context_logger.log_context_prepared(
            conversation_id=conversation_id,
            context_pack_info={
                "messages_for_model": messages_for_model,
                "used_summary": used_summary,
                "summary_text": summary_text,
                "dropped_messages": dropped_messages,
                "removed_noise_count": removed_noise,
                "token_estimate": token_estimate
            }
        )
        
        logger.info(f"[ContextManager] Context prepared: {len(messages_for_model)} messages, "
                   f"~{token_estimate} tokens, used_summary={used_summary}")
        
        return ContextPack(
            messages_for_model=messages_for_model,
            used_summary=used_summary,
            summary_text=summary_text,
            dropped_messages=dropped_messages,
            removed_noise_count=removed_noise,
            token_estimate=token_estimate,
            summary_metrics=summary_metrics,
        )
    
    async def update_summary_after_turn(
        self,
        conversation_id: str,
        history: List[Dict],
        latest_user_message: str = "",
        latest_assistant_message: str = "",
    ) -> None:
        """每轮结束后更新 rolling summary
        
        更新会话状态中的轮次计数，并在必要时触发摘要更新。
        
        Args:
            conversation_id: 会话 ID
            history: 完整对话历史（清理后）
            latest_user_message: 最新的用户消息
            latest_assistant_message: 最新的助手回复
        """
        # 加载状态
        state = await self.context_store.load(conversation_id)
        
        # 更新轮次计数
        state.total_turns += 1
        
        # 记录轮次更新
        context_logger.log_turn_updated(
            conversation_id=conversation_id,
            total_turns=state.total_turns,
            last_summary_turn=state.last_summary_turn
        )
        
        logger.info(f"[ContextManager] Updated turn count: {state.total_turns}")
        
        # 保存状态
        await self.context_store.save(state)
    
    def _split_by_turns(
        self, 
        messages: List[Dict], 
        keep_turns: int
    ) -> tuple[List[Dict], List[Dict]]:
        """按完整轮次切分消息
        
        一轮 = user消息 + assistant消息
        保留最近 N 轮，返回旧消息用于摘要。
        
        Args:
            messages: 消息列表
            keep_turns: 保留的最近轮次数
            
        Returns:
            (recent_messages, old_messages) - 最近消息和旧消息
        """
        if not messages:
            return [], []
        
        # 提取对话消息的索引和信息（user + assistant）
        conversation_msgs = [
            (i, m) for i, m in enumerate(messages)
            if m.get("role") in ["user", "assistant"] and m.get("content")
        ]
        
        # 计算需要保留的消息数（轮次 * 2）
        keep_count = keep_turns * 2
        
        if len(conversation_msgs) <= keep_count:
            # 消息不够，没有旧消息需要摘要
            return messages, []
        
        # 找到分割点：保留最近 keep_count 条消息
        split_index = conversation_msgs[-keep_count][0]
        
        # 切分
        recent_messages = messages[split_index:]
        old_messages = messages[:split_index]
        
        logger.debug(f"[ContextManager] Split by turns: {len(old_messages)} old, {len(recent_messages)} recent")
        
        return recent_messages, old_messages
    
    def _get_recent_turns(self, messages: List[Dict], keep_turns: int) -> List[Dict]:
        """切出最近 N 轮消息
        
        一轮包含一个 user 消息和一个 assistant 消息。
        
        Args:
            messages: 消息列表
            keep_turns: 保留的轮次数
            
        Returns:
            最近的消息列表
        """
        if not messages:
            return []
        
        # 只保留 user 和 assistant 消息用于计算轮次
        conversation_messages = [
            m for m in messages 
            if m.get("role") in ["user", "assistant"] and m.get("content")
        ]
        
        # 计算需要保留的消息数量
        # 每轮约 2 条消息（user + assistant）
        keep_count = keep_turns * 2
        
        if len(conversation_messages) <= keep_count:
            # 消息不够，返回原始列表
            return messages

        # 从后往前数 keep_count 条 user/assistant 消息，定位切割点。
        # 用「位置」计数而非「内容前缀集合」匹配：反复出现的相同提示
        # （如「继续」/「重新检测」）会让基于 set 的标识塌缩，导致
        # found_count 永远到不了 keep_count、最终返回空列表，整段近期
        # 上下文被静默丢弃。按位置计数则不受重复内容影响。
        split_index = 0
        found_count = 0
        for i in range(len(messages) - 1, -1, -1):
            msg = messages[i]
            if msg.get("role") in ["user", "assistant"] and msg.get("content"):
                found_count += 1
                if found_count >= keep_count:
                    split_index = i
                    break

        return messages[split_index:]
    
    def _assemble_messages(
        self,
        filtered_history: List[Dict],
        summary_text: Optional[str],
        user_message: str,
        recent_keep_turns: int
    ) -> List[Dict]:
        """组装最终消息列表
        
        结构：
        - 如果有摘要：[摘要消息] + [最近消息]
        - 如果没有摘要：[所有历史消息]
        - 最后添加当前用户消息
        
        Args:
            filtered_history: 过滤后的历史
            summary_text: 摘要文本
            user_message: 当前用户消息
            recent_keep_turns: 保留的最近轮次
            
        Returns:
            组装好的消息列表
        """
        messages = []
        
        if summary_text:
            # 添加摘要作为系统消息
            messages.append({
                "role": "system",
                "content": f"【历史对话摘要】\n{summary_text}"
            })
            
            # 添加最近的消息
            recent_messages = self._get_recent_turns(filtered_history, recent_keep_turns)
            messages.extend(recent_messages)
            
            logger.debug(f"[ContextManager] Assembled messages: summary + {len(recent_messages)} recent")
        else:
            # 没有摘要，使用全部历史
            messages.extend(filtered_history)
            
            logger.debug(f"[ContextManager] Assembled messages: {len(filtered_history)} history")
        
        # 添加当前用户消息
        messages.append({
            "role": "user",
            "content": user_message
        })
        
        return messages
    
    async def clear_conversation(self, conversation_id: str) -> None:
        """清除会话的上下文状态
        
        Args:
            conversation_id: 会话 ID
        """
        await self.context_store.delete(conversation_id)
        logger.info(f"[ContextManager] Cleared context for conversation: {conversation_id}")
    
    async def get_conversation_state(self, conversation_id: str) -> ConversationContextState:
        """获取会话状态（用于调试）
        
        Args:
            conversation_id: 会话 ID
            
        Returns:
            会话状态对象
        """
        return await self.context_store.load(conversation_id)
