"""
Reference Search - 参考文档轻量检索

在 Skill 的 references 目录中进行简单的关键词匹配检索。
"""

import re
import logging
from pathlib import Path
from typing import List, Tuple, Optional

logger = logging.getLogger(__name__)


def search_references(
    references_dir: Path,
    query: str,
    top_k: int = 3
) -> List[str]:
    """在 references 目录中检索相关片段
    
    使用简单的关键词匹配进行检索。
    
    Args:
        references_dir: references 目录路径
        query: 查询文本
        top_k: 返回的最大片段数
        
    Returns:
        相关片段列表，按相关性排序
    """
    if not references_dir or not references_dir.exists():
        return []
    
    # 读取所有参考文件
    file_contents = _read_files(references_dir)
    
    if not file_contents:
        return []
    
    # 计算每个文件与查询的匹配分数
    scored_snippets: List[Tuple[float, str]] = []
    
    for filename, content in file_contents:
        score = _calculate_match_score(content, query)
        if score > 0:
            # 提取最相关的片段
            snippet = _extract_relevant_snippet(content, query)
            if snippet:
                scored_snippets.append((score, snippet))
    
    # 按分数排序并返回 top_k
    scored_snippets.sort(key=lambda x: x[0], reverse=True)
    
    return [snippet for _, snippet in scored_snippets[:top_k]]


def _read_files(directory: Path) -> List[Tuple[str, str]]:
    """读取目录下所有文件
    
    Args:
        directory: 目录路径
        
    Returns:
        (文件名, 内容) 列表
    """
    files = []
    
    try:
        for file_path in directory.iterdir():
            if file_path.is_file() and file_path.suffix in ['.md', '.txt', '.markdown']:
                try:
                    content = file_path.read_text(encoding='utf-8')
                    files.append((file_path.name, content))
                except Exception as e:
                    logger.warning(f"Failed to read file {file_path}: {e}")
    except Exception as e:
        logger.error(f"Failed to iterate directory {directory}: {e}")
    
    return files


def _calculate_match_score(content: str, query: str) -> float:
    """计算内容与查询的匹配分数
    
    使用简单的关键词重叠计算。
    
    Args:
        content: 文档内容
        query: 查询文本
        
    Returns:
        匹配分数 (0.0 - 1.0)
    """
    if not content or not query:
        return 0.0
    
    # 提取查询关键词
    query_words = set(re.findall(r'[\u4e00-\u9fa5]+|[a-zA-Z]+', query.lower()))
    
    if not query_words:
        return 0.0
    
    # 提取内容中的词
    content_words = set(re.findall(r'[\u4e00-\u9fa5]+|[a-zA-Z]+', content.lower()))
    
    # 计算重叠率
    overlap = query_words & content_words
    
    if not overlap:
        return 0.0
    
    # 分数 = 重叠词数 / 查询词数
    return len(overlap) / len(query_words)


def _extract_relevant_snippet(content: str, query: str, max_length: int = 500) -> Optional[str]:
    """提取最相关的片段
    
    找到包含最多查询关键词的段落或句子。
    
    Args:
        content: 文档内容
        query: 查询文本
        max_length: 最大片段长度
        
    Returns:
        最相关的片段，如果没有匹配返回 None
    """
    if not content or not query:
        return None
    
    # 提取查询关键词
    query_words = set(re.findall(r'[\u4e00-\u9fa5]+|[a-zA-Z]+', query.lower()))
    
    if not query_words:
        return None
    
    # 按段落分割
    paragraphs = content.split('\n\n')
    
    best_paragraph = None
    best_score = 0
    
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        
        # 计算段落分数
        para_words = set(re.findall(r'[\u4e00-\u9fa5]+|[a-zA-Z]+', para.lower()))
        overlap = query_words & para_words
        score = len(overlap)
        
        if score > best_score:
            best_score = score
            best_paragraph = para
    
    if best_paragraph:
        # 截断到最大长度
        if len(best_paragraph) > max_length:
            return best_paragraph[:max_length] + "..."
        return best_paragraph
    
    return None


def search_in_file(file_path: Path, query: str, top_k: int = 3) -> List[str]:
    """在单个文件中检索
    
    Args:
        file_path: 文件路径
        query: 查询文本
        top_k: 返回的最大片段数
        
    Returns:
        相关片段列表
    """
    if not file_path or not file_path.exists():
        return []
    
    try:
        content = file_path.read_text(encoding='utf-8')
    except Exception as e:
        logger.warning(f"Failed to read file {file_path}: {e}")
        return []
    
    # 提取查询关键词
    query_words = set(re.findall(r'[\u4e00-\u9fa5]+|[a-zA-Z]+', query.lower()))
    
    if not query_words:
        return []
    
    # 按段落分割并评分
    paragraphs = content.split('\n\n')
    scored_paras: List[Tuple[float, str]] = []
    
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        
        para_words = set(re.findall(r'[\u4e00-\u9fa5]+|[a-zA-Z]+', para.lower()))
        overlap = query_words & para_words
        
        if overlap:
            score = len(overlap) / len(query_words)
            if len(para) > 500:
                para = para[:500] + "..."
            scored_paras.append((score, para))
    
    # 排序并返回
    scored_paras.sort(key=lambda x: x[0], reverse=True)
    
    return [para for _, para in scored_paras[:top_k]]