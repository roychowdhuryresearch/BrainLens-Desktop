"""
Skills Module - Skill 运行时系统

提供 Skill 的加载、运行时管理等核心功能。

核心组件：
- SkillPackage: Skill 运行时包
- SkillRegistry: Skill 注册表
- SkillLoader: Skill 加载器
- SkillParser: SKILL.md 解析器
- SkillRuntime: 运行时上下文管理
- RoutingResult: 路由结果（agent_runtime bootstrap 输出）
- SkillRuntimeContext: 运行时上下文
"""

from runtime.skills.models import SkillCatalog, SkillPackage, SkillRuntimeContext, RoutingResult


def __getattr__(name):
    if name in {"SkillParser", "skill_parser"}:
        from runtime.skills.parser import SkillParser, skill_parser
        return {"SkillParser": SkillParser, "skill_parser": skill_parser}[name]
    if name in {"SkillLoader", "skill_loader"}:
        from runtime.skills.loader import SkillLoader, skill_loader
        return {"SkillLoader": SkillLoader, "skill_loader": skill_loader}[name]
    if name in {"SkillRegistry", "skill_registry"}:
        from runtime.skills.skill_registry import SkillRegistry, skill_registry
        return {"SkillRegistry": SkillRegistry, "skill_registry": skill_registry}[name]
    if name in {"SkillRuntime", "prepare_skill_context"}:
        from runtime.skills.runtime import SkillRuntime, prepare_skill_context
        return {"SkillRuntime": SkillRuntime, "prepare_skill_context": prepare_skill_context}[name]
    if name in {"search_references", "search_in_file"}:
        from runtime.skills.reference_search import search_in_file, search_references
        return {"search_references": search_references, "search_in_file": search_in_file}[name]
    if name in {"SkillLogger", "skill_logger"}:
        from runtime.skills.skill_logger import SkillLogger, skill_logger
        return {"SkillLogger": SkillLogger, "skill_logger": skill_logger}[name]
    if name in {"SkillMatcher", "SkillContextBuilder"}:
        from runtime.skills.skill_context_builder import SkillContextBuilder
        from runtime.skills.skill_matcher import SkillMatcher
        return {"SkillMatcher": SkillMatcher, "SkillContextBuilder": SkillContextBuilder}[name]
    raise AttributeError(name)

__all__ = [
    # 数据模型
    "SkillPackage",
    "RoutingResult",
    "SkillRuntimeContext",
    "SkillCatalog",

    # 解析和加载
    "SkillParser",
    "skill_parser",
    "SkillLoader",
    "skill_loader",

    # 注册表
    "SkillRegistry",
    "skill_registry",

    # 运行时
    "SkillRuntime",
    "prepare_skill_context",

    # 参考文档检索
    "search_references",
    "search_in_file",

    # 关键词匹配（被 plan_preview_service 用于离线候选挑选）
    "SkillMatcher",
    "SkillContextBuilder",
]
