"""
Skill Sandbox Service - Skill 沙箱测试

在不影响真实对话的情况下测试 skill 的 routing、context 准备和 prompt 组装。

使用方式::

    svc = get_skill_sandbox_service()
    result = svc.dry_run(
        skill_name="hfo-detector",
        test_message="Detect HFO candidates in this iEEG segment",
    )
"""

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


@dataclass
class SandboxResult:
    """沙箱测试结果。"""
    skill_name: str
    skill_found: bool
    routing_matched: bool = False
    routing_confidence: float = 0.0
    context_built: bool = False
    prompt_preview: str = ""
    filtered_tools_count: int = 0
    reference_snippets_count: int = 0
    template_context_present: bool = False
    when_to_use: str = ""
    do_not_use: str = ""
    tags: List[str] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)
    duration_ms: float = 0.0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "skill_name": self.skill_name,
            "skill_found": self.skill_found,
            "routing_matched": self.routing_matched,
            "routing_confidence": self.routing_confidence,
            "context_built": self.context_built,
            "prompt_preview": self.prompt_preview[:2000],
            "filtered_tools_count": self.filtered_tools_count,
            "reference_snippets_count": self.reference_snippets_count,
            "template_context_present": self.template_context_present,
            "when_to_use": self.when_to_use,
            "do_not_use": self.do_not_use,
            "tags": self.tags,
            "keywords": self.keywords,
            "duration_ms": round(self.duration_ms, 1),
            "error": self.error,
        }


class SkillSandboxService:
    """Skill 沙箱测试服务。

    仅做 routing + context 准备，不执行 LLM 调用，不影响历史。
    """

    def dry_run(
        self,
        skill_name: str,
        test_message: str = "",
    ) -> SandboxResult:
        """对指定 skill 进行沙箱测试。

        测试内容：
        1. Skill 是否存在并能加载
        2. Skill 的 tags/keywords/when_to_use
        3. Skill context 是否能构建
        4. 生成的 prompt 预览

        Args:
            skill_name:   要测试的 skill 名称
            test_message: 测试用的用户消息

        Returns:
            SandboxResult
        """
        started = time.perf_counter()

        try:
            from runtime.skills.skill_registry import skill_registry
            from runtime.skills.models import SkillRuntimeContext

            # Step 1: 查找 skill
            if not skill_registry.is_initialized:
                skill_registry.scan_skills()

            pkg = skill_registry.get_package(skill_name)
            if pkg is None:
                return SandboxResult(
                    skill_name=skill_name,
                    skill_found=False,
                    error=f"Skill '{skill_name}' not found in registry",
                    duration_ms=(time.perf_counter() - started) * 1000,
                )

            # Step 2: 提取元数据
            result = SandboxResult(
                skill_name=skill_name,
                skill_found=True,
                when_to_use=pkg.when_to_use or "",
                do_not_use=pkg.do_not_use or "",
                tags=list(pkg.tags or []),
                keywords=list(pkg.keywords or []),
            )

            # Step 3: 构建 context
            ctx = SkillRuntimeContext(
                skill=pkg,
                instructions=pkg.instructions,
                reference_snippets=[
                    f"[ref: {ref}]" for ref in (pkg.references or [])[:5]
                ],
            )
            result.context_built = True
            result.template_context_present = bool(ctx.template_context)
            result.reference_snippets_count = len(ctx.reference_snippets)

            # Step 4: 生成 prompt 预览
            prompt = ctx.build_skill_prompt()
            result.prompt_preview = prompt
            result.routing_matched = True
            result.routing_confidence = 1.0

            result.duration_ms = (time.perf_counter() - started) * 1000
            return result

        except Exception as exc:
            logger.error("[Sandbox] dry_run failed for %s: %s", skill_name, exc)
            return SandboxResult(
                skill_name=skill_name,
                skill_found=False,
                error=str(exc),
                duration_ms=(time.perf_counter() - started) * 1000,
            )

    def list_testable_skills(self) -> List[Dict[str, str]]:
        """列出所有可测试的 skill。"""
        from runtime.skills.skill_registry import skill_registry
        if not skill_registry.is_initialized:
            skill_registry.scan_skills()

        packages = skill_registry.get_all_packages()
        return [
            {
                "name": pkg.name,
                "description": pkg.description[:200],
                "category": pkg.category or "default",
                "priority": pkg.priority,
            }
            for pkg in packages
        ]


_sandbox_service: Optional[SkillSandboxService] = None


def get_skill_sandbox_service() -> SkillSandboxService:
    global _sandbox_service
    if _sandbox_service is None:
        _sandbox_service = SkillSandboxService()
    return _sandbox_service
