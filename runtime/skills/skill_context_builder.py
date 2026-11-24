"""
Skill上下文构建器 - 生成结构化XML上下文

从SkillManifest生成ActiveSkillContext，并转换为XML格式用于注入System Prompt。
"""

from typing import Optional

from runtime.models.schemas import (
    SkillManifest,
    ActiveSkillContext
)


class SkillContextBuilder:
    """
    Skill上下文构建器
    
    职责：
    - 从SkillManifest生成ActiveSkillContext
    - 转换为XML格式用于注入Prompt
    - 构建完整的Skill提示文本
    
    使用方式：
        builder = SkillContextBuilder()
        context = builder.build(skill)
        xml = builder.build_xml(skill)
        prompt = builder.build_for_prompt(skill)
    """
    
    @staticmethod
    def build(skill: SkillManifest) -> ActiveSkillContext:
        """
        从SkillManifest构建ActiveSkillContext
        
        Args:
            skill: Skill元数据
            
        Returns:
            ActiveSkillContext对象
        """
        return ActiveSkillContext(
            name=skill.name,
            description=skill.description,
            when_to_use=skill.when_to_use,
            do_not_use=skill.do_not_use,
            workflow=skill.workflow,
            output_format=skill.output_format
        )
    
    @staticmethod
    def build_xml(skill: SkillManifest) -> str:
        """
        直接生成XML格式的Skill上下文
        
        用于注入System Prompt
        
        Args:
            skill: Skill元数据
            
        Returns:
            XML格式字符串
        """
        context = SkillContextBuilder.build(skill)
        return context.to_xml()
    
    @staticmethod
    def build_for_prompt(skill: SkillManifest) -> str:
        """
        构建完整的Skill提示文本
        
        包含：
        - XML格式的Skill上下文
        - 执行约束说明
        
        Args:
            skill: Skill元数据
            
        Returns:
            完整的Skill提示文本
        """
        xml_context = SkillContextBuilder.build_xml(skill)
        
        # 构建完整提示
        prompt_parts = [
            "# 当前激活的Skill",
            "",
            "以下Skill已被激活，请按照Skill定义的方式处理用户请求：",
            "",
            xml_context,
            "",
            "## 执行要求",
            "",
            "1. **遵循工作流程**：按照Skill定义的workflow步骤执行任务",
            "2. **输出格式**：遵循Skill中定义的output_format要求",
        ]
        
        if skill.when_to_use:
            prompt_parts.extend([
                "",
                f"3. **适用场景**：{skill.when_to_use}",
            ])
        
        if skill.do_not_use:
            prompt_parts.extend([
                "",
                f"4. **注意事项**：{skill.do_not_use}",
            ])
        
        # 添加工作流程详情
        if skill.workflow:
            prompt_parts.extend([
                "",
                "## 工作流程详情",
                "",
            ])
            for i, step in enumerate(skill.workflow, 1):
                prompt_parts.append(f"{i}. {step}")
        
        # 添加输出格式说明
        if skill.output_format:
            prompt_parts.extend([
                "",
                "## 输出格式",
                "",
                skill.output_format,
            ])
        
        return '\n'.join(prompt_parts)
    
    @staticmethod
    def build_skill_section(skill: SkillManifest) -> str:
        """
        构建适合插入到System Prompt中的Skill段落
        
        这个方法生成更简洁的格式，适合插入到现有System Prompt中。
        
        Args:
            skill: Skill元数据
            
        Returns:
            简洁的Skill段落文本
        """
        parts = [
            f"<active_skill name=\"{skill.name}\">",
            f"  <description>{skill.description}</description>",
        ]
        
        if skill.when_to_use:
            parts.append(f"  <when_to_use>{skill.when_to_use}</when_to_use>")
        
        if skill.workflow:
            parts.append("  <workflow>")
            for step in skill.workflow:
                parts.append(f"    <step>{step}</step>")
            parts.append("  </workflow>")
        
        if skill.output_format:
            parts.append(f"  <output_format>{skill.output_format}</output_format>")
        
        parts.append("</active_skill>")
        
        return '\n'.join(parts)
    
    @staticmethod
    def build_system_prompt_extension(skill: SkillManifest) -> str:
        """
        构建System Prompt扩展部分
        
        这部分内容将被追加到原有的System Prompt后面。
        
        Args:
            skill: Skill元数据
            
        Returns:
            System Prompt扩展文本
        """
        extension = f"""

# 激活的技能 (Active Skill)

当前已激活技能：**{skill.name}**

{skill.description}

"""
        
        if skill.when_to_use:
            extension += f"""
**使用场景**：{skill.when_to_use}

"""
        
        if skill.workflow:
            extension += """**工作流程**：
"""
            for i, step in enumerate(skill.workflow, 1):
                extension += f"{i}. {step}\n"
            extension += "\n"
        
        if skill.output_format:
            extension += f"""**输出格式**：
{skill.output_format}

"""
        
        if skill.do_not_use:
            extension += f"""**注意事项**：
{skill.do_not_use}

"""
        
        extension += """请严格按照上述技能定义的方式处理用户的请求。
"""
        
        return extension