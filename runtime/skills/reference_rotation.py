"""
Reference Rotation - 大规模参考数据分块轮转检索

对于数据量较大的 references 目录（文件数量多或单文件超大），
传统的全量加载+关键词匹配会消耗大量内存且响应慢。

本模块提供分块（chunk）+ 轮转（rotation）策略：
1. 将大文件按 chunk_size 字符切分，相邻块有 overlap 重叠以避免上下文截断
2. 维护每个文件的"上次返回位置"游标（rotation index），
   保证多次查询时不会总返回同一块
3. 支持跨文件、跨块的相关性评分，优先返回最相关的块
4. 提供分页（page）接口：可按页取任意窗口范围内的块

典型用法::

    manager = ReferenceRotationManager(chunk_size=800, overlap=100)

    # 单次检索（自动轮转）
    snippets = manager.search_with_rotation(
        references_dir=skill_pkg.references_dir,
        query="参数设置",
        top_k=3,
    )

    # 分页浏览所有块
    page = manager.paginate(
        references_dir=skill_pkg.references_dir,
        page=0,
        page_size=5,
    )
"""

import re
import math
import logging
from pathlib import Path
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# 每块默认字符数（约 500 中文字或 800 英文字符）
_DEFAULT_CHUNK_SIZE: int = 800
# 相邻块的重叠字符数，避免句子被截断
_DEFAULT_OVERLAP: int = 100
# 单次检索最多扫描的文件数（防止目录过大时卡死）
_MAX_FILES_PER_SEARCH: int = 200


class ChunkIndex:
    """一个文件的分块信息及轮转游标。"""

    __slots__ = ("file_path", "chunks", "_rotation_cursor")

    def __init__(self, file_path: Path, chunks: List[str]) -> None:
        self.file_path = file_path
        self.chunks = chunks
        self._rotation_cursor: int = 0

    # ------------------------------------------------------------------
    # 游标管理
    # ------------------------------------------------------------------

    def advance_cursor(self) -> None:
        """将游标推进到下一块（循环）。"""
        if self.chunks:
            self._rotation_cursor = (self._rotation_cursor + 1) % len(self.chunks)

    def reset_cursor(self) -> None:
        self._rotation_cursor = 0

    @property
    def cursor(self) -> int:
        return self._rotation_cursor

    # ------------------------------------------------------------------
    # 检索接口
    # ------------------------------------------------------------------

    def get_chunks_from_cursor(self, window: int) -> List[Tuple[int, str]]:
        """从当前游标起，返回最多 window 个块（循环）。

        Returns:
            [(chunk_index, chunk_text), ...]
        """
        n = len(self.chunks)
        if n == 0:
            return []
        result = []
        for i in range(min(window, n)):
            idx = (self._rotation_cursor + i) % n
            result.append((idx, self.chunks[idx]))
        return result

    def __repr__(self) -> str:
        return (
            f"ChunkIndex(file={self.file_path.name}, "
            f"chunks={len(self.chunks)}, cursor={self._rotation_cursor})"
        )


class ReferenceRotationManager:
    """大规模参考数据分块轮转管理器。

    线程安全说明：本类未加锁，多线程场景下请在调用方做外层保护。
    """

    def __init__(
        self,
        chunk_size: int = _DEFAULT_CHUNK_SIZE,
        overlap: int = _DEFAULT_OVERLAP,
    ) -> None:
        """初始化管理器。

        Args:
            chunk_size: 每个文本块的最大字符数
            overlap:    相邻块的重叠字符数（必须 < chunk_size）
        """
        if overlap >= chunk_size:
            raise ValueError(
                f"overlap ({overlap}) must be smaller than chunk_size ({chunk_size})"
            )
        self.chunk_size = chunk_size
        self.overlap = overlap

        # key = str(file_path), value = ChunkIndex
        self._index: Dict[str, ChunkIndex] = {}

    # ------------------------------------------------------------------
    # 核心：分块
    # ------------------------------------------------------------------

    def chunk_text(self, text: str) -> List[str]:
        """将文本按 chunk_size / overlap 切分为块列表。

        切分优先在段落边界（连续空行 \\n\\n）处断开，
        退而求其次在换行符处，最后才硬截断。

        Args:
            text: 原始文本

        Returns:
            文本块列表，每块长度 ≤ chunk_size
        """
        if not text or not text.strip():
            return []

        if len(text) <= self.chunk_size:
            stripped = text.strip()
            return [stripped] if stripped else []

        chunks: List[str] = []
        start = 0
        total = len(text)

        while start < total:
            end = min(start + self.chunk_size, total)

            if end < total:
                # 优先在段落边界切分
                para_break = text.rfind("\n\n", start, end)
                if para_break != -1 and para_break > start:
                    end = para_break + 2
                else:
                    # 退而求其次：换行符
                    line_break = text.rfind("\n", start, end)
                    if line_break != -1 and line_break > start:
                        end = line_break + 1

            chunk = text[start:end].strip()
            if chunk:
                chunks.append(chunk)

            # 下一块起点往前退 overlap 个字符
            start = end - self.overlap if (end - self.overlap) > start else end

        return chunks

    # ------------------------------------------------------------------
    # 内部：加载 / 缓存
    # ------------------------------------------------------------------

    def _load_file(self, file_path: Path) -> ChunkIndex:
        """加载文件并建立分块索引（使用内部缓存）。"""
        key = str(file_path)
        if key in self._index:
            return self._index[key]

        try:
            content = file_path.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning("Cannot read reference file %s: %s", file_path, exc)
            content = ""

        chunks = self.chunk_text(content)
        idx = ChunkIndex(file_path, chunks)
        self._index[key] = idx
        logger.debug("Indexed %s → %d chunks", file_path.name, len(chunks))
        return idx

    def _iter_reference_files(self, references_dir: Path) -> List[Path]:
        """枚举 references 目录下的文本文件（.md / .txt / .markdown）。"""
        if not references_dir or not references_dir.exists():
            return []
        files = sorted(
            p
            for p in references_dir.iterdir()
            if p.is_file() and p.suffix.lower() in {".md", ".txt", ".markdown"}
        )
        return files[:_MAX_FILES_PER_SEARCH]

    # ------------------------------------------------------------------
    # 相关性评分
    # ------------------------------------------------------------------

    @staticmethod
    def _score_chunk(chunk: str, query: str) -> float:
        """简单关键词重叠分 (0.0–1.0)。

        CJK 文字以单字为 token（避免整段匹配失效），ASCII 以词为 token。
        """
        if not chunk or not query:
            return 0.0

        def _tokenize(text: str) -> set:
            # 每个 CJK 字符单独作为一个 token
            cjk = set(re.findall(r"[\u4e00-\u9fa5]", text))
            # ASCII 按词
            ascii_words = set(re.findall(r"[a-zA-Z]+", text.lower()))
            return cjk | ascii_words

        q_tokens = _tokenize(query)
        if not q_tokens:
            return 0.0
        c_tokens = _tokenize(chunk)
        overlap = q_tokens & c_tokens
        return len(overlap) / len(q_tokens)

    # ------------------------------------------------------------------
    # 公共接口：轮转检索
    # ------------------------------------------------------------------

    def search_with_rotation(
        self,
        references_dir: Path,
        query: str,
        top_k: int = 3,
        *,
        rotation_window: int = 5,
    ) -> List[str]:
        """在 references_dir 中进行分块轮转检索。

        策略：
        1. 对每个文件，从当前游标起取 rotation_window 个候选块
        2. 对所有候选块按相关性打分
        3. 返回 top_k 个最相关块
        4. 将所有被访问文件的游标推进一步（轮转），下次查询会换一批块

        Args:
            references_dir:  Skill 的 references 目录路径
            query:           用户查询文本
            top_k:           返回的最大片段数
            rotation_window: 每个文件每次检索时考察的块数

        Returns:
            相关文本块列表，按分数降序排列
        """
        files = self._iter_reference_files(references_dir)
        if not files:
            return []

        scored: List[Tuple[float, str]] = []

        for file_path in files:
            chunk_idx = self._load_file(file_path)

            for _, chunk_text in chunk_idx.get_chunks_from_cursor(rotation_window):
                score = self._score_chunk(chunk_text, query)
                if score > 0:
                    scored.append((score, chunk_text))

            # 推进游标（无论是否命中，保证下次轮到不同的块）
            chunk_idx.advance_cursor()

        scored.sort(key=lambda x: x[0], reverse=True)
        return [text for _, text in scored[:top_k]]

    # ------------------------------------------------------------------
    # 公共接口：分页浏览
    # ------------------------------------------------------------------

    def paginate(
        self,
        references_dir: Path,
        page: int = 0,
        page_size: int = 5,
    ) -> Dict[str, object]:
        """分页返回 references 目录的所有文本块。

        所有文件的块被扁平化成一个大列表，然后按 page/page_size 切片。
        不改变轮转游标。

        Args:
            references_dir: Skill 的 references 目录路径
            page:           页码（从 0 开始）
            page_size:      每页块数

        Returns:
            {
                "page":        0,
                "page_size":   5,
                "total_chunks": 42,
                "total_pages":  9,
                "chunks": [
                    {"file": "knowledge-base.md", "chunk_index": 0, "text": "..."},
                    ...
                ],
            }
        """
        files = self._iter_reference_files(references_dir)

        all_chunks: List[Dict[str, object]] = []
        for file_path in files:
            chunk_idx = self._load_file(file_path)
            for i, text in enumerate(chunk_idx.chunks):
                all_chunks.append({
                    "file": file_path.name,
                    "chunk_index": i,
                    "text": text,
                })

        total = len(all_chunks)
        total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 0
        page = max(0, min(page, total_pages - 1)) if total_pages > 0 else 0
        start = page * page_size
        end = start + page_size

        return {
            "page": page,
            "page_size": page_size,
            "total_chunks": total,
            "total_pages": total_pages,
            "chunks": all_chunks[start:end],
        }

    # ------------------------------------------------------------------
    # 公共接口：直接按查询获取最佳单块
    # ------------------------------------------------------------------

    def get_best_chunk(
        self,
        references_dir: Path,
        query: str,
    ) -> Optional[str]:
        """返回与 query 最相关的单个文本块（不轮转游标）。

        适用于精确问答场景，只想要最高分的那一块。
        """
        files = self._iter_reference_files(references_dir)
        best_score = 0.0
        best_text: Optional[str] = None

        for file_path in files:
            chunk_idx = self._load_file(file_path)
            for chunk_text in chunk_idx.chunks:
                score = self._score_chunk(chunk_text, query)
                if score > best_score:
                    best_score = score
                    best_text = chunk_text

        return best_text

    # ------------------------------------------------------------------
    # 缓存管理
    # ------------------------------------------------------------------

    def invalidate(self, file_path: Path) -> None:
        """使单个文件的缓存失效（文件内容更新时调用）。"""
        self._index.pop(str(file_path), None)

    def invalidate_all(self) -> None:
        """清除全部缓存。"""
        self._index.clear()

    def reset_rotation(self, references_dir: Optional[Path] = None) -> None:
        """将游标归零。

        Args:
            references_dir: 指定目录下的文件游标归零；None 表示全部归零
        """
        if references_dir is None:
            for idx in self._index.values():
                idx.reset_cursor()
        else:
            for file_path in self._iter_reference_files(references_dir):
                key = str(file_path)
                if key in self._index:
                    self._index[key].reset_cursor()

    def stats(self) -> Dict[str, object]:
        """返回当前缓存统计信息（调试用）。"""
        return {
            "cached_files": len(self._index),
            "total_chunks": sum(len(v.chunks) for v in self._index.values()),
            "cursors": {
                Path(k).name: v.cursor for k, v in self._index.items()
            },
        }


# ---------------------------------------------------------------------------
# Module-level singleton (follows project get_* pattern)
# ---------------------------------------------------------------------------

_rotation_manager: Optional[ReferenceRotationManager] = None


def get_rotation_manager(
    chunk_size: int = _DEFAULT_CHUNK_SIZE,
    overlap: int = _DEFAULT_OVERLAP,
) -> ReferenceRotationManager:
    """返回模块级 ReferenceRotationManager 单例。

    首次调用时用给定参数初始化；后续调用忽略参数，返回已有实例。
    """
    global _rotation_manager
    if _rotation_manager is None:
        _rotation_manager = ReferenceRotationManager(
            chunk_size=chunk_size,
            overlap=overlap,
        )
    return _rotation_manager
