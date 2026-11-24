"""
Context Logger - 独立的上下文管理日志记录器

提供专门的日志文件记录 ContextManager 的运行情况：
- 上下文预处理日志
- 噪音过滤日志
- 摘要生成日志
- 会话状态更新日志

日志文件位置: logs/context.log
"""

import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, Any, List
import json


class ContextLogger:
    """上下文管理日志记录器
    
    提供独立的日志文件，专门记录 ContextManager 的运行情况。
    日志格式为结构化文本，便于分析和调试。
    
    使用方式：
        from runtime.context.context_logger import context_logger
        
        # 记录上下文预处理
        context_logger.log_context_prepared(conv_id, context_pack)
        
        # 记录噪音过滤
        context_logger.log_noise_filtered(original_count, filtered_count, removed_count)
        
        # 记录摘要生成
        context_logger.log_summary_generated(conv_id, summary_length, dropped_messages)
    """
    
    def __init__(self, log_dir: str = "logs", log_file: str = "context.log"):
        """初始化上下文日志记录器
        
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
        self.logger = logging.getLogger("context_manager")
        self.logger.setLevel(logging.INFO)
        
        # 避免重复添加 handler
        if not self.logger.handlers:
            # 文件 handler
            file_handler = logging.FileHandler(
                self.log_path,
                encoding='utf-8',
                mode='a'  # 追加模式
            )
            file_handler.setLevel(logging.INFO)
            
            # 日志格式
            formatter = logging.Formatter(
                '%(asctime)s | %(levelname)s | %(message)s',
                datefmt='%Y-%m-%d %H:%M:%S'
            )
            file_handler.setFormatter(formatter)
            
            self.logger.addHandler(file_handler)
    
    def _format_json(self, data: Any) -> str:
        """格式化 JSON 数据为字符串"""
        if isinstance(data, (dict, list)):
            return json.dumps(data, ensure_ascii=False)
        return str(data)
    
    def _truncate(self, text: str, max_len: int = 200) -> str:
        """截断文本"""
        if not text:
            return ""
        if len(text) <= max_len:
            return text
        return text[:max_len] + "..."
    
    def log_separator(self) -> None:
        """记录分隔线，用于区分不同请求"""
        self.logger.info("=" * 80)
    
    def log_request_start(
        self,
        conversation_id: str,
        history_count: int,
        user_message: str
    ) -> None:
        """记录请求开始
        
        Args:
            conversation_id: 会话ID
            history_count: 历史消息数量
            user_message: 用户消息
        """
        self.log_separator()
        self.logger.info(f"[CONTEXT REQUEST] conv_id={conversation_id}")
        self.logger.info(f"  History Count: {history_count}")
        self.logger.info(f"  User Message: {self._truncate(user_message)}")
    
    def log_state_loaded(
        self,
        conversation_id: str,
        total_turns: int,
        last_summary_turn: int,
        has_rolling_summary: bool
    ) -> None:
        """记录会话状态加载
        
        Args:
            conversation_id: 会话ID
            total_turns: 总轮次
            last_summary_turn: 上次摘要轮次
            has_rolling_summary: 是否有滚动摘要
        """
        self.logger.info(f"[STATE LOADED] conv_id={conversation_id}")
        self.logger.info(f"  Total Turns: {total_turns}")
        self.logger.info(f"  Last Summary Turn: {last_summary_turn}")
        self.logger.info(f"  Has Rolling Summary: {has_rolling_summary}")
    
    def log_noise_filtered(
        self,
        original_count: int,
        filtered_count: int,
        removed_count: int,
        removed_samples: Optional[List[str]] = None
    ) -> None:
        """记录噪音过滤结果
        
        Args:
            original_count: 原始消息数量
            filtered_count: 过滤后消息数量
            removed_count: 移除的消息数量
            removed_samples: 被移除消息的样本（可选）
        """
        self.logger.info(f"[NOISE FILTERED]")
        self.logger.info(f"  Original Count: {original_count}")
        self.logger.info(f"  Filtered Count: {filtered_count}")
        self.logger.info(f"  Removed Count: {removed_count}")
        
        if removed_samples:
            self.logger.info(f"  Removed Samples:")
            for i, sample in enumerate(removed_samples[:3], 1):
                self.logger.info(f"    {i}. {self._truncate(sample, 100)}")
    
    def log_summary_trigger_check(
        self,
        msg_count: int,
        estimated_tokens: int,
        turns_since_last: int,
        triggered: bool,
        trigger_reason: Optional[str] = None,
        # 新增参数：配置阈值
        trigger_turns: int = 0,
        trigger_tokens: int = 0,
        recent_keep_turns: int = 0,
        enable_summary: bool = True,
        # 新增参数：消息数量检查
        has_enough_messages: bool = True,
        recent_keep_msgs: int = 0
    ) -> None:
        """记录摘要触发检查（增强版）
        
        Args:
            msg_count: 消息数量
            estimated_tokens: 预估 token 数
            turns_since_last: 距上次摘要的轮次
            triggered: 是否触发摘要
            trigger_reason: 触发原因（如果触发）
            trigger_turns: 触发轮次阈值
            trigger_tokens: 触发 token 阈值
            recent_keep_turns: 保留最近轮次
            enable_summary: 是否启用摘要
            has_enough_messages: 是否有足够消息可摘要
            recent_keep_msgs: 保留消息数 (recent_keep_turns * 2)
        """
        status = "TRIGGERED" if triggered else "NOT TRIGGERED"
        self.logger.info(f"[SUMMARY CHECK] status={status}")
        
        # 当前状态
        self.logger.info(f"  当前状态:")
        self.logger.info(f"    Message Count: {msg_count}")
        self.logger.info(f"    Estimated Tokens: {estimated_tokens}")
        self.logger.info(f"    Turns Since Last Summary: {turns_since_last}")
        
        # 触发阈值
        self.logger.info(f"  触发阈值:")
        self.logger.info(f"    Summary Enabled: {enable_summary}")
        self.logger.info(f"    Trigger Turns: {trigger_turns} (需要 turns_since_last >= 此值)")
        self.logger.info(f"    Trigger Tokens: {trigger_tokens} (需要 tokens >= 此值)")
        self.logger.info(f"    Recent Keep Turns: {recent_keep_turns} (保留最近N轮)")
        
        # 判断原因
        if not enable_summary:
            self.logger.info(f"  ❌ 摘要未执行原因: 摘要功能已禁用")
        elif not triggered:
            # 分析为什么没触发
            reasons = []
            if turns_since_last < trigger_turns:
                reasons.append(f"轮次不足: {turns_since_last} < {trigger_turns}")
            if estimated_tokens < trigger_tokens:
                reasons.append(f"Token不足: {estimated_tokens} < {trigger_tokens}")
            self.logger.info(f"  ❌ 摘要未触发原因: {'; '.join(reasons) if reasons else '未知'}")
        elif triggered and not has_enough_messages:
            self.logger.info(f"  ⚠️ 摘要触发但未执行:")
            self.logger.info(f"    原因: 消息数 {msg_count} <= 保留消息数 {recent_keep_msgs}")
            self.logger.info(f"    说明: 需要消息数 > {recent_keep_msgs} 才有旧消息可摘要")
        elif triggered and has_enough_messages:
            self.logger.info(f"  ✅ 摘要已触发，即将执行")
    
    def log_summary_generation_start(
        self,
        conversation_id: str,
        messages_to_summarize: int,
        has_previous_summary: bool
    ) -> None:
        """记录摘要生成开始
        
        Args:
            conversation_id: 会话ID
            messages_to_summarize: 需要摘要的消息数量
            has_previous_summary: 是否有之前的摘要
        """
        self.logger.info(f"[SUMMARY START] conv_id={conversation_id}")
        self.logger.info(f"  Messages to Summarize: {messages_to_summarize}")
        self.logger.info(f"  Has Previous Summary: {has_previous_summary}")
    
    def log_summary_generated(
        self,
        conversation_id: str,
        summary_length: int,
        dropped_messages: int,
        conversation_goal: Optional[str] = None,
        facts_count: int = 0,
        decisions_count: int = 0
    ) -> None:
        """记录摘要生成完成
        
        Args:
            conversation_id: 会话ID
            summary_length: 摘要长度
            dropped_messages: 被摘要的消息数
            conversation_goal: 对话目标
            facts_count: 重要事实数量
            decisions_count: 决策数量
        """
        self.logger.info(f"[SUMMARY GENERATED] conv_id={conversation_id}")
        self.logger.info(f"  Summary Length: {summary_length} chars")
        self.logger.info(f"  Dropped Messages: {dropped_messages}")
        self.logger.info(f"  Conversation Goal: {self._truncate(conversation_goal or '', 100)}")
        self.logger.info(f"  Facts Count: {facts_count}")
        self.logger.info(f"  Decisions Count: {decisions_count}")
    
    def log_summary_content(
        self,
        conversation_id: str,
        original_messages: List[Dict],
        summary_text: str,
        conversation_goal: str = "",
        important_facts: Optional[List[str]] = None,
        constraints: Optional[List[str]] = None,
        decisions_made: Optional[List[str]] = None,
        open_questions: Optional[List[str]] = None,
        current_focus: str = "",
        previous_summary: str = ""
    ) -> None:
        """记录摘要的原文和结果（详细版）
        
        Args:
            conversation_id: 会话ID
            original_messages: 被摘要的原始消息列表
            summary_text: 生成的摘要文本
            conversation_goal: 对话目标
            important_facts: 重要事实列表
            constraints: 约束条件列表
            decisions_made: 已做决策列表
            open_questions: 待解决问题列表
            current_focus: 当前焦点
            previous_summary: 之前的摘要文本
        """
        self.logger.info(f"[SUMMARY CONTENT] conv_id={conversation_id}")
        
        # 记录被总结的原文
        self.logger.info(f"  被摘要的原始消息 ({len(original_messages)} 条):")
        for i, msg in enumerate(original_messages[:5]):  # 最多显示5条
            role = msg.get("role", "unknown")
            content = msg.get("content", "")
            if isinstance(content, str):
                content_display = self._truncate(content, 150)
            else:
                content_display = self._truncate(str(content), 150)
            self.logger.info(f"    [{i+1}] {role}: {content_display}")
        if len(original_messages) > 5:
            self.logger.info(f"    ... 还有 {len(original_messages) - 5} 条消息")
        
        # 记录之前的摘要（如果有）
        if previous_summary:
            self.logger.info(f"  之前的摘要:")
            self.logger.info(f"    {self._truncate(previous_summary, 200)}")
        
        # 记录生成的摘要详情
        self.logger.info(f"  生成的摘要:")
        if conversation_goal:
            self.logger.info(f"    对话目标: {conversation_goal}")
        if important_facts:
            self.logger.info(f"    重要事实 ({len(important_facts)}):")
            for fact in important_facts[:5]:
                self.logger.info(f"      - {self._truncate(fact, 100)}")
        if constraints:
            self.logger.info(f"    约束条件 ({len(constraints)}):")
            for c in constraints[:3]:
                self.logger.info(f"      - {self._truncate(c, 100)}")
        if decisions_made:
            self.logger.info(f"    已做决策 ({len(decisions_made)}):")
            for d in decisions_made[:3]:
                self.logger.info(f"      - {self._truncate(d, 100)}")
        if open_questions:
            self.logger.info(f"    待解决问题 ({len(open_questions)}):")
            for q in open_questions[:3]:
                self.logger.info(f"      - {self._truncate(q, 100)}")
        if current_focus:
            self.logger.info(f"    当前焦点: {current_focus}")
        
        # 完整的摘要文本
        self.logger.info(f"  最终摘要文本:")
        self.logger.info(f"    {self._truncate(summary_text, 300)}")
    
    def log_context_assembled(
        self,
        messages_count: int,
        used_summary: bool,
        token_estimate: int
    ) -> None:
        """记录消息组装完成
        
        Args:
            messages_count: 最终消息数量
            used_summary: 是否使用了摘要
            token_estimate: 预估 token 数
        """
        self.logger.info(f"[CONTEXT ASSEMBLED]")
        self.logger.info(f"  Final Messages Count: {messages_count}")
        self.logger.info(f"  Used Summary: {used_summary}")
        self.logger.info(f"  Token Estimate: {token_estimate}")
    
    def log_context_prepared(
        self,
        conversation_id: str,
        context_pack_info: Dict[str, Any]
    ) -> None:
        """记录上下文预处理完成
        
        Args:
            conversation_id: 会话ID
            context_pack_info: ContextPack 信息字典
        """
        messages_count = len(context_pack_info.get("messages_for_model", []))
        used_summary = context_pack_info.get("used_summary", False)
        summary_length = len(context_pack_info.get("summary_text") or "")
        dropped = context_pack_info.get("dropped_messages", 0)
        noise_removed = context_pack_info.get("removed_noise_count", 0)
        tokens = context_pack_info.get("token_estimate", 0)
        
        self.logger.info(f"[CONTEXT PREPARED] conv_id={conversation_id}")
        self.logger.info(f"  Messages for Model: {messages_count}")
        self.logger.info(f"  Used Summary: {used_summary}")
        self.logger.info(f"  Summary Length: {summary_length} chars")
        self.logger.info(f"  Dropped Messages: {dropped}")
        self.logger.info(f"  Noise Removed: {noise_removed}")
        self.logger.info(f"  Token Estimate: {tokens}")
        self.log_separator()
    
    def log_turn_updated(
        self,
        conversation_id: str,
        total_turns: int,
        last_summary_turn: int
    ) -> None:
        """记录轮次更新
        
        Args:
            conversation_id: 会话ID
            total_turns: 更新后的总轮次
            last_summary_turn: 上次摘要轮次
        """
        self.logger.info(f"[TURN UPDATED] conv_id={conversation_id}")
        self.logger.info(f"  Total Turns: {total_turns}")
        self.logger.info(f"  Last Summary Turn: {last_summary_turn}")
    
    def log_state_cleared(
        self,
        conversation_id: str
    ) -> None:
        """记录状态清除
        
        Args:
            conversation_id: 会话ID
        """
        self.logger.info(f"[STATE CLEARED] conv_id={conversation_id}")
    
    def log_error(
        self,
        error_type: str,
        error_message: str,
        context: Optional[Dict[str, Any]] = None
    ) -> None:
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
    
    def log_config(
        self,
        config: Dict[str, Any]
    ) -> None:
        """记录配置信息
        
        Args:
            config: 配置字典
        """
        self.logger.info(f"[CONFIG]")
        for key, value in config.items():
            self.logger.info(f"  {key}: {value}")


# 创建全局实例
context_logger = ContextLogger()
