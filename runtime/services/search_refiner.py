"""
Search Refiner - 搜索自动重试与关键词改写

当知识库搜索返回空结果时，自动用同义词/缩写/常见术语变体
重新生成查询词再搜一次，提高命中率。

使用方式::

    refiner = get_search_refiner()
    refined = refiner.refine_query("HFO")
    # → ["HFO", "high frequency oscillation", "高频振荡"]
"""

import logging
import re
from typing import Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# Generic synonym mapping (bidirectional expansion).
_SYNONYM_PAIRS: List[List[str]] = [
    ["HFO", "high frequency oscillation", "高频振荡"],
    ["ripple", "fast ripple", "高频振荡"],
    ["iEEG", "intracranial EEG", "颅内脑电"],
    ["sEEG", "stereo EEG", "立体脑电"],
    ["ECoG", "electrocorticography", "皮层脑电"],
    ["artifact", "artefact", "伪迹", "噪声"],
    ["channel", "electrode", "contact", "通道", "电极", "触点"],
    ["seizure onset", "SOZ", "发作起始区", "癫痫灶"],
    ["BIDS", "iEEG-BIDS", "数据集格式"],
    ["接口", "API", "端点", "endpoint"],
    ["配置", "设置", "config"],
]

# 构建快速查找索引
_synonym_index: Dict[str, Set[str]] = {}


def _build_synonym_index() -> None:
    """构建同义词索引（首次调用时初始化）。"""
    if _synonym_index:
        return
    for group in _SYNONYM_PAIRS:
        normalized = [w.strip().lower() for w in group if w.strip()]
        group_set = set(group)  # 保持原始大小写
        for word in normalized:
            if word not in _synonym_index:
                _synonym_index[word] = set()
            _synonym_index[word].update(group_set)


class SearchRefiner:
    """搜索查询改写器。"""

    def __init__(self, max_variants: int = 5) -> None:
        self.max_variants = max_variants
        _build_synonym_index()

    def refine_query(self, query: str) -> List[str]:
        """为原始查询生成变体列表。

        返回原始查询 + 同义词替换后的变体，去重。

        Args:
            query: 原始搜索查询

        Returns:
            查询变体列表（第一个始终是原始查询）
        """
        if not query or not query.strip():
            return []

        results = [query.strip()]
        seen = {query.strip().lower()}

        # 提取查询中的关键词
        words = re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+\d*", query)

        for word in words:
            key = word.strip().lower()
            if key not in _synonym_index:
                continue

            for synonym in _synonym_index[key]:
                # Replace only the standalone token, not every substring occurrence —
                # a global str.replace corrupts longer tokens that contain `word`
                # (e.g. "channel" inside "multichannel", plurals like "artifacts"),
                # producing broken mixed-language retry queries.
                variant = re.sub(
                    rf"(?<![\w一-龥]){re.escape(word)}(?![\w一-龥])",
                    synonym,
                    query,
                )
                if variant.strip().lower() not in seen:
                    seen.add(variant.strip().lower())
                    results.append(variant.strip())

                if len(results) >= self.max_variants:
                    return results

        return results

    def extract_keywords(self, query: str) -> List[str]:
        """从查询中提取关键词。"""
        words = re.findall(r"[\u4e00-\u9fa5]+|[a-zA-Z]+\d*", query)
        return [w for w in words if len(w) >= 2]


_search_refiner: Optional[SearchRefiner] = None


def get_search_refiner() -> SearchRefiner:
    global _search_refiner
    if _search_refiner is None:
        _search_refiner = SearchRefiner()
    return _search_refiner
