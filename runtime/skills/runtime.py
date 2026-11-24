"""
Skill Runtime - Skill 运行时上下文管理

准备 Skill 运行时上下文，包括：
- 加载指令文本
- 过滤工具列表
- 加载模板骨架（输出结构）
- 加载参考文档完整内容
- 构建注入 prompt
"""

import time
import logging
from typing import List, Dict, Optional, Tuple

from runtime.skills.models import SkillPackage, SkillRuntimeContext, RoutingResult

logger = logging.getLogger(__name__)


class SkillRuntime:
    """Skill 运行时上下文管理
    
    职责：
    - 准备运行时上下文
    - 根据 allowed_tools 过滤工具
    - 加载模板摘要
    - 检索参考文档片段
    - 构建 skill 注入 prompt
    
    使用方式：
        runtime = SkillRuntime(skill_package)
        context = runtime.prepare_context(user_message, tools)
        injection_prompt = context.build_skill_prompt()
    """
    
    def __init__(self, skill: Optional[SkillPackage] = None):
        """初始化运行时
        
        Args:
            skill: 激活的 SkillPackage，可选
        """
        self.skill = skill
    
    def prepare_context(
        self,
        user_message: str,
        tools: List[Dict],
        routing_result: Optional[RoutingResult] = None
    ) -> Optional[SkillRuntimeContext]:
        """准备运行时上下文
        
        Args:
            user_message: 用户消息
            tools: 可用工具列表
            routing_result: 路由结果（可选）
            
        Returns:
            SkillRuntimeContext 如果有激活的 skill，否则返回 None
        """
        if not self.skill:
            return None
        
        start_time = time.time()
        
        try:
            # 加载指令文本
            instructions = self._load_instructions()
            
            # 过滤工具
            filtered_tools, tool_filter_applied = self._filter_tools(tools)
            
            # 加载模板骨架（输出结构）
            template_context = self._load_template_context()
            
            # 加载参考文档完整内容
            reference_snippets = self._load_all_references()
            
            # 计算加载时间
            load_time_ms = (time.time() - start_time) * 1000
            
            # 创建上下文
            context = SkillRuntimeContext(
                skill=self.skill,
                instructions=instructions,
                template_context=template_context,
                reference_snippets=reference_snippets,
                filtered_tools=filtered_tools,
                tool_filter_applied=tool_filter_applied,
                routing_info=routing_result,
                load_time_ms=load_time_ms
            )
            
            logger.info(f"[Runtime] Prepared context for skill: {self.skill.name} ({load_time_ms:.2f}ms)")
            
            return context
            
        except Exception as e:
            logger.error(f"[Runtime] Failed to prepare context: {e}")
            return None
    
    def _load_instructions(self) -> str:
        """加载指令文本
        
        从 SkillPackage 的 instructions 字段获取。
        
        Returns:
            指令文本
        """
        if not self.skill:
            return ""
        
        # instructions 已经在加载时从 SKILL.md 正文解析
        return self.skill.instructions
    
    def _filter_tools(self, tools: List[Dict]) -> Tuple[List[Dict], bool]:
        """根据 allowed_tools 过滤工具
        
        Args:
            tools: 原始工具列表
            
        Returns:
            (过滤后的工具列表, 是否应用了过滤)
        """
        if not self.skill:
            return tools, False
        
        # 如果没有指定 allowed_tools，不过滤
        if not self.skill.allowed_tools:
            return tools, False
        
        allowed = [
            self._normalize_tool_name(name)
            for name in self.skill.allowed_tools
            if self._normalize_tool_name(name)
        ]
        filtered = []

        for tool in tools:
            # 获取工具名称
            tool_name = self._get_tool_name(tool)
            if any(
                self._tool_name_matches_allowed(tool_name, allowed_name)
                for allowed_name in allowed
            ):
                filtered.append(tool)
        
        # 如果过滤后为空，返回原始列表并记录警告
        if not filtered:
            logger.warning(f"[Runtime] Tool filter resulted in empty list, using all tools")
            return tools, False
        
        logger.info(f"[Runtime] Filtered tools: {len(filtered)}/{len(tools)}")
        return filtered, True
    
    def _get_tool_name(self, tool: Dict) -> str:
        """从工具定义中提取名称
        
        Args:
            tool: 工具定义
            
        Returns:
            工具名称
        """
        # OpenAI 格式: {"type": "function", "function": {"name": "..."}}
        if "function" in tool:
            return tool.get("function", {}).get("name", "")
        
        # 简单格式: {"name": "..."}
        return tool.get("name", "")

    @staticmethod
    def _normalize_tool_name(name: str) -> str:
        normalized = str(name or "").strip()
        if normalized.startswith("hitl__"):
            return normalized[len("hitl__") :]
        return normalized

    @classmethod
    def _tool_name_matches_allowed(cls, tool_name: str, allowed_name: str) -> bool:
        normalized_tool = cls._normalize_tool_name(tool_name)
        normalized_allowed = cls._normalize_tool_name(allowed_name)
        if not normalized_tool or not normalized_allowed:
            return False
        if normalized_tool == normalized_allowed:
            return True
        return (
            normalized_tool.endswith(normalized_allowed)
            or normalized_allowed.endswith(normalized_tool)
        )
    
    def _load_template_context(self) -> Optional[str]:
        """加载模板上下文（输出骨架）
        
        读取模板文件，提取输出结构骨架，让模型知道：
        - 必填字段
        - 输出顺序
        - 字段含义
        
        Returns:
            模板骨架文本，如果没有模板返回 None
        """
        import re
        
        if not self.skill or not self.skill.templates_dir:
            return None
        
        if not self.skill.templates:
            return None
        
        contexts = []
        
        for template_name in self.skill.templates:
            template_path = self.skill.templates_dir / template_name
            
            if not template_path.exists():
                continue
            
            try:
                content = template_path.read_text(encoding='utf-8')
                schema = self._extract_template_schema(content, template_name)
                if schema:
                    contexts.append(schema)
            except Exception as e:
                logger.warning(f"[Runtime] Failed to read template {template_name}: {e}")
        
        if contexts:
            return "\n\n".join(contexts)
        return None
    
    def _extract_template_schema(self, template_content: str, template_name: str) -> Optional[str]:
        """从模板内容提取输出骨架
        
        解析模板的 YAML frontmatter 和 Markdown 结构，
        生成清晰的输出指导。
        
        Args:
            template_content: 模板文件内容
            template_name: 模板文件名
            
        Returns:
            结构化的模板骨架说明
        """
        import re
        
        lines = []
        lines.append(f"### 模板 {template_name} 的输出结构：")
        lines.append("")
        
        # 1. 提取 YAML frontmatter 字段
        yaml_match = re.match(r'^---\s*\n(.*?)\n---', template_content, re.DOTALL)
        if yaml_match:
            yaml_content = yaml_match.group(1)
            lines.append("**【YAML 元数据】** 必填字段：")
            
            # 解析 YAML 字段
            for line in yaml_content.split('\n'):
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                
                # 匹配字段: 值 格式
                field_match = re.match(r'^(\w+):\s*(.*)$', line)
                if field_match:
                    field_name = field_match.group(1)
                    field_value = field_match.group(2).strip()
                    
                    # 检查是否是占位符
                    if field_value.startswith('{{') and field_value.endswith('}}'):
                        placeholder = field_value[2:-2].strip()
                        lines.append(f"- `{field_name}`: {placeholder}")
                    elif field_value:
                        # 有默认值或列表开始
                        lines.append(f"- `{field_name}`: {field_value}")
                    else:
                        lines.append(f"- `{field_name}`: (需要填写)")
            
            lines.append("")
        
        # 2. 提取 Markdown 章节结构
        sections = re.findall(r'^##\s+(.+)$', template_content, re.MULTILINE)
        if sections:
            lines.append("**【正文结构】** 按以下顺序输出：")
            for i, section in enumerate(sections, 1):
                lines.append(f"{i}. {section}")
            lines.append("")
        
        # 3. 提取占位符列表（用于提示需要填充的内容）
        placeholders = re.findall(r'\{\{(\w+)\}\}', template_content)
        if placeholders:
            unique_placeholders = list(dict.fromkeys(placeholders))  # 去重保序
            lines.append("**【需要填充的变量】**：")
            lines.append(", ".join(f"`{{{p}}}`" for p in unique_placeholders))
        
        return "\n".join(lines)
    
    def _load_all_references(self) -> List[str]:
        """直接加载所有参考文档完整内容
        
        不再依赖关键词检索，直接读取 references 目录下的所有文件。
        这样可以确保 AI 获得完整的参考资料。
        
        Returns:
            参考文档内容列表
        """
        if not self.skill or not self.skill.references_dir:
            return []
        
        references = []
        
        try:
            for ref_file in sorted(self.skill.references_dir.iterdir()):
                if ref_file.is_file() and ref_file.suffix in ['.md', '.txt', '.markdown']:
                    try:
                        content = ref_file.read_text(encoding='utf-8').strip()
                        if content:
                            # 添加文件名作为标题
                            references.append(f"### {ref_file.name}\n\n{content}")
                    except Exception as e:
                        logger.warning(f"[Runtime] Failed to read reference {ref_file.name}: {e}")
        except Exception as e:
            logger.error(f"[Runtime] Failed to iterate references directory: {e}")
        
        logger.info(f"[Runtime] Loaded {len(references)} reference files")
        return references
    
    def build_skill_prompt(self, context: SkillRuntimeContext) -> str:
        """构建 skill 注入 prompt
        
        将 SkillRuntimeContext 转换为可注入 system prompt 的文本。
        
        Args:
            context: 运行时上下文
            
        Returns:
            注入 prompt 文本
        """
        return context.build_skill_prompt()
    
    def get_filtered_tools(self, tools: List[Dict]) -> List[Dict]:
        """获取过滤后的工具列表
        
        这是一个便捷方法，不需要创建完整上下文。
        
        Args:
            tools: 原始工具列表
            
        Returns:
            过滤后的工具列表
        """
        filtered, _ = self._filter_tools(tools)
        return filtered


def prepare_skill_context(
    skill: Optional[SkillPackage],
    user_message: str,
    tools: List[Dict],
    routing_result: Optional[RoutingResult] = None
) -> Optional[SkillRuntimeContext]:
    """便捷函数：准备 skill 运行时上下文
    
    Args:
        skill: 激活的 SkillPackage
        user_message: 用户消息
        tools: 可用工具列表
        routing_result: 路由结果
        
    Returns:
        SkillRuntimeContext 或 None
    """
    if not skill:
        return None
    
    runtime = SkillRuntime(skill)
    return runtime.prepare_context(user_message, tools, routing_result)
