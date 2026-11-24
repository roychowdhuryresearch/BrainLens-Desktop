"""
Proactive Clarification Service - 主动追问策略

当用户消息信息不足时，自动生成澄清问题而不是硬猜。
在 step executor 层工具返回模糊结果时也可触发。

使用方式::

    svc = get_proactive_clarification_service()
    result = svc.check_needs_clarification("这段 iEEG 数据有问题")
    if result.needs_clarification:
        question = result.clarification_question
"""

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# 需要澄清的模糊模式
_AMBIGUOUS_PATTERNS = [
    # (模式, 缺少的信息, 追问模板)
    (r"数据有问题|结果不对|异常", "数据与现象", "请说明数据类型、采样率、通道范围和你观察到的具体现象。"),
    (r"参数不对|参数错误", "具体参数", "是哪个分析参数不对？当前值、期望值和对结果的影响是什么？"),
    (r"报错|错误", "错误信息", "能贴出完整错误信息、运行命令和相关数据形状吗？"),
    (r"伪迹|噪声|artifact", "伪迹类型", "请说明伪迹类型、受影响通道、时间范围和当前预处理步骤。"),
    (r"预处理|滤波|重参考", "处理目标", "请说明数据格式、采样率、目标频段和希望保留/去除的成分。"),
    (r"检测|识别|标注", "检测目标", "请说明要检测的事件类型、标注标准、时间窗和评价指标。"),
    (r"怎么调|如何设置", "目标和约束", "请问要调整什么分析目标？当前配置和限制条件是什么？"),
    (r"推荐|选型|用什么", "研究场景", "请问具体研究问题、数据规模、约束和偏好是什么？"),
    (r"对比|比较|PK|VS", "对比对象", "请问要对比哪些方法、数据集或指标？"),
]

# 关键信息字段
_KEY_INFO_FIELDS = {
    "数据格式": r"EDF|BIDS|FIF|MAT|CSV|HDF5",
    "采样率": r"\d+(?:\.\d+)?\s*(?:Hz|hz|赫兹)",
    "通道": r"[A-Za-z]+\d+(?:-[A-Za-z]+\d+)?",
    "版本": r"v?\d+(?:\.\d+){1,3}",
    "错误信息": r"(?:报错|错误|error)\s*[:：]?\s*\S+",
}


@dataclass
class ClarificationResult:
    """澄清检测结果。"""
    needs_clarification: bool = False
    clarification_question: str = ""
    missing_info: List[str] = field(default_factory=list)
    detected_info: Dict[str, str] = field(default_factory=dict)
    confidence: float = 1.0  # 1.0 = 不需要澄清, 0.0 = 完全模糊

    def to_dict(self) -> Dict[str, Any]:
        return {
            "needs_clarification": self.needs_clarification,
            "clarification_question": self.clarification_question,
            "missing_info": self.missing_info,
            "detected_info": self.detected_info,
            "confidence": round(self.confidence, 2),
        }


class ProactiveClarificationService:
    """主动追问策略服务。"""

    def __init__(self, min_confidence: float = 0.5) -> None:
        self._min_confidence = min_confidence

    def check_needs_clarification(
        self,
        message: str,
        *,
        conversation_context: Optional[str] = None,
    ) -> ClarificationResult:
        """检测用户消息是否信息不足需要澄清。

        Args:
            message:               用户消息
            conversation_context:  前几轮对话上下文（可选，用于避免重复追问）

        Returns:
            ClarificationResult
        """
        if not message or not message.strip():
            return ClarificationResult()

        result = ClarificationResult()

        # 提取已有的关键信息
        detected = self._extract_key_info(message)
        if conversation_context:
            detected.update(self._extract_key_info(conversation_context))
        result.detected_info = detected

        # 检测模糊模式
        questions = []
        missing = []
        for pattern, info_type, question in _AMBIGUOUS_PATTERNS:
            if re.search(pattern, message):
                # 如果用户已经提供了这类信息，跳过
                if info_type.split("和")[0] in detected:
                    continue
                questions.append(question)
                missing.append(info_type)

        if not questions:
            result.confidence = 1.0
            return result

        # 计算置信度
        info_ratio = len(detected) / max(len(detected) + len(missing), 1)
        result.confidence = min(info_ratio + 0.3, 1.0)

        if result.confidence < self._min_confidence:
            result.needs_clarification = True
            result.missing_info = missing
            # 只问最重要的一个问题
            result.clarification_question = questions[0]

        return result

    def check_tool_result_ambiguous(
        self,
        tool_name: str,
        tool_result: Any,
        original_query: str,
    ) -> ClarificationResult:
        """检测工具返回结果是否模糊需要追问。

        当搜索返回多个候选但无法确定哪个最相关时触发。
        """
        result = ClarificationResult()

        if not isinstance(tool_result, (list, dict)):
            return result

        # 搜索返回空结果
        items = tool_result if isinstance(tool_result, list) else tool_result.get("data", [])
        if isinstance(items, list) and len(items) == 0:
            result.needs_clarification = True
            result.confidence = 0.2
            result.clarification_question = "没有找到匹配的结果，能换个关键词或者描述得更具体吗？"
            result.missing_info = ["更精确的搜索关键词"]

        # 搜索返回太多结果（> 10）
        elif isinstance(items, list) and len(items) > 10:
            result.needs_clarification = True
            result.confidence = 0.4
            result.clarification_question = f"找到了 {len(items)} 个相关结果，能缩小范围吗？比如指定型号或具体问题。"
            result.missing_info = ["更具体的筛选条件"]

        return result

    @staticmethod
    def _extract_key_info(text: str) -> Dict[str, str]:
        """从文本中提取关键信息。"""
        detected = {}
        for field_name, pattern in _KEY_INFO_FIELDS.items():
            match = re.search(pattern, text)
            if match:
                detected[field_name] = match.group(0)
        return detected


_clarification_service: Optional[ProactiveClarificationService] = None


def get_proactive_clarification_service() -> ProactiveClarificationService:
    global _clarification_service
    if _clarification_service is None:
        _clarification_service = ProactiveClarificationService()
    return _clarification_service
