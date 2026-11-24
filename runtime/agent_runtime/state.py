"""Runtime 状态数据结构

定义 RuntimeState 和 TraceEvent 数据结构。
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, TYPE_CHECKING
import time

if TYPE_CHECKING:
    from runtime.models.schemas import ImageReference, MemoryReference


@dataclass
class TraceEvent:
    """追踪事件
    
    记录运行时发生的各种事件，用于 replay/debug。
    """
    step_id: int                              # 主循环步数
    event_type: str                           # 事件类型
    payload: Dict[str, Any]                   # 事件详情
    timestamp: float = field(default_factory=time.time)
    
    # event_type 枚举值:
    # - select_action_start / select_action_end
    # - execute_action_start / execute_action_end
    # - retry
    # - fallback
    # - error
    # - skill_step_start / skill_step_end
    # - finalize_start / finalize_end
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式"""
        return {
            "step_id": self.step_id,
            "event_type": self.event_type,
            "payload": self.payload,
            "timestamp": self.timestamp
        }


@dataclass
class RuntimeState:
    """统一运行时状态
    
    管理整个 Agent 执行过程中的状态。
    """
    user_input: str                           # 用户原始输入
    done: bool = False                        # 是否完成
    current_step: int = 0                     # 当前主循环步数
    max_steps: int = 10                       # 最大步数限制
    
    # NOTE 2026-04：字段重命名 —— 以前叫 memory / history，容易跟"用户长期记忆"（backend durable_memories）
    # 和"会话历史"（agent_messages）混淆。这里是单次 agent run 内部的工作状态，跑完就丢。
    scratchpad: Dict[str, Any] = field(default_factory=dict)      # 单次 run 内的工作变量（结构化数据）
    react_trace: List[Dict[str, Any]] = field(default_factory=list)  # ReAct 执行轨迹（给 LLM 看）
    trace: List[TraceEvent] = field(default_factory=list)     # 完整追踪（用于 replay / debug）
    
    final_answer: Optional[str] = None        # 最终回答
    last_error: Optional[str] = None          # 最后错误信息
    
    # Skill 执行上下文
    active_skill_name: Optional[str] = None   # 当前激活的 skill
    skill_step_index: int = 0                 # 当前 skill workflow 步骤索引
    
    # 图片引用存储（VL Tool 支持）
    image_references: Dict[str, Any] = field(default_factory=dict)  # ref_id -> ImageReference
    
    # Memory 引用存储（预留，供后续 Reference-based Working Memory 使用）
    memory_references: Dict[str, Any] = field(default_factory=dict)  # ref_id -> MemoryReference
    
    def is_done(self) -> bool:
        """检查是否完成"""
        return self.done or self.current_step >= self.max_steps
    
    def increment_step(self) -> int:
        """增加步数并返回新步数"""
        self.current_step += 1
        return self.current_step
    
    def add_trace_event(self, event_type: str, payload: Dict[str, Any]) -> TraceEvent:
        """添加追踪事件"""
        event = TraceEvent(
            step_id=self.current_step,
            event_type=event_type,
            payload=payload
        )
        self.trace.append(event)
        return event
    
    def add_react_trace(self, event: Dict[str, Any]) -> None:
        """给 ReAct 执行轨迹追加一条（给 LLM 看的上下文）。"""
        self.react_trace.append(event)

    def update_scratchpad(self, data: Dict[str, Any]) -> None:
        """合并到单次 run 的工作变量里。"""
        self.scratchpad.update(data)

    # --- Deprecated 别名（下版本删除）----------------------------
    # 老方法名保留暂作兼容，打一条 warning 提醒迁移。

    @property
    def memory(self) -> Dict[str, Any]:
        import warnings

        warnings.warn(
            "RuntimeState.memory 已更名为 RuntimeState.scratchpad（2026-04）",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.scratchpad

    @property
    def history(self) -> List[Dict[str, Any]]:
        import warnings

        warnings.warn(
            "RuntimeState.history 已更名为 RuntimeState.react_trace（2026-04）",
            DeprecationWarning,
            stacklevel=2,
        )
        return self.react_trace

    def add_history(self, event: Dict[str, Any]) -> None:
        """Deprecated：用 add_react_trace。"""
        self.add_react_trace(event)

    def update_memory(self, data: Dict[str, Any]) -> None:
        """Deprecated：用 update_scratchpad。"""
        self.update_scratchpad(data)
    
    def set_error(self, error: str) -> None:
        """设置错误信息"""
        self.last_error = error
    
    def set_final_answer(self, answer: str) -> None:
        """设置最终回答并标记完成"""
        self.final_answer = answer
        self.done = True
    
    def add_image_reference(self, ref_id: str, image_ref: Any) -> None:
        """添加图片引用
        
        Args:
            ref_id: 引用ID，如 'img_ref_001'
            image_ref: ImageReference 对象
        """
        self.image_references[ref_id] = image_ref
    
    def get_image_reference(self, ref_id: str) -> Optional[Any]:
        """获取图片引用
        
        Args:
            ref_id: 引用ID
            
        Returns:
            ImageReference 对象，不存在则返回 None
        """
        return self.image_references.get(ref_id)
    
    def has_image_references(self) -> bool:
        """检查是否有图片引用"""
        return len(self.image_references) > 0
    
    def get_image_reference_summary(self) -> str:
        """获取图片引用摘要（用于注入到 prompt）
        
        Returns:
            图片引用摘要文本，如 "[图片引用: img_ref_001, img_ref_002]"
        """
        if not self.image_references:
            return ""
        
        ref_ids = list(self.image_references.keys())
        return f"[可用图片引用: {', '.join(ref_ids)}]"
    
    def to_dict(self) -> Dict[str, Any]:
        """转换为字典格式（用于序列化）"""
        return {
            "user_input": self.user_input,
            "done": self.done,
            "current_step": self.current_step,
            "max_steps": self.max_steps,
            "memory": self.memory,
            "history": self.history,
            "trace": [t.to_dict() for t in self.trace],
            "final_answer": self.final_answer,
            "last_error": self.last_error,
            "active_skill_name": self.active_skill_name,
            "skill_step_index": self.skill_step_index
        }