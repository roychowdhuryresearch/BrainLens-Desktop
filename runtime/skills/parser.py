"""
Skill Parser - 解析 SKILL.md 文件

从 SKILL.md 文件中提取 YAML frontmatter 和 Markdown 正文，
生成结构化的元数据和指令文本。
"""

import re
import logging
from typing import Dict, Any, Tuple, List, Optional

import yaml

logger = logging.getLogger(__name__)


class SkillParser:
    """解析 SKILL.md 文件
    
    职责：
    - 提取 YAML frontmatter（---之间的内容）
    - 解析 Markdown 正文章节
    - 提取工作流程步骤
    - 提取关键词和示例
    
    使用方式：
        parser = SkillParser()
        metadata, instructions = parser.parse(skill_md_text)
    """
    
    def parse(self, skill_md_text: str) -> Tuple[Dict[str, Any], str]:
        """解析 SKILL.md 文件内容
        
        Args:
            skill_md_text: SKILL.md 文件的完整文本
            
        Returns:
            (metadata, instructions) 元组
            - metadata: YAML frontmatter 解析后的字典
            - instructions: Markdown 正文内容
        """
        # 提取 YAML frontmatter
        metadata = self._extract_frontmatter(skill_md_text)
        
        # 提取 Markdown 正文
        instructions = self._extract_markdown_body(skill_md_text)
        
        return metadata, instructions
    
    def _extract_frontmatter(self, content: str) -> Dict[str, Any]:
        """提取 YAML frontmatter
        
        YAML frontmatter 是文件开头由 --- 包围的部分。
        
        Args:
            content: 文件内容
            
        Returns:
            解析后的字典，解析失败返回空字典
        """
        # 匹配 --- 之间的YAML内容
        pattern = r'^---\s*\n(.*?)\n---'
        match = re.match(pattern, content, re.DOTALL)
        
        if not match:
            logger.debug("No YAML frontmatter found")
            return {}
        
        yaml_content = match.group(1)
        try:
            result = yaml.safe_load(yaml_content)
            return result if result else {}
        except yaml.YAMLError as e:
            logger.error(f"YAML parsing error: {e}")
            return {}
    
    def _extract_markdown_body(self, content: str) -> str:
        """提取 Markdown 正文
        
        移除 YAML frontmatter 后的剩余内容。
        
        Args:
            content: 文件内容
            
        Returns:
            Markdown 正文文本
        """
        # 移除 frontmatter
        body = re.sub(r'^---\s*\n.*?\n---\s*\n?', '', content, flags=re.DOTALL)
        return body.strip()
    
    def extract_sections(self, content: str) -> Dict[str, str]:
        """提取 Markdown 章节内容
        
        解析 ## 标题为章节，返回章节名称到内容的映射。
        
        Args:
            content: Markdown 正文内容
            
        Returns:
            章节名称到内容的映射
        """
        sections = {}
        
        # 移除 frontmatter
        body = self._extract_markdown_body(content)
        
        # 匹配 ## 标题
        pattern = r'^##\s+(.+?)\s*\n(.*?)(?=^##\s|\Z)'
        matches = re.finditer(pattern, body, re.MULTILINE | re.DOTALL)
        
        for match in matches:
            section_name = match.group(1).strip()
            section_content = match.group(2).strip()
            sections[section_name] = section_content
        
        return sections
    
    def extract_workflow(self, sections: Dict[str, str]) -> List[str]:
        """从工作流程章节提取步骤
        
        支持 Step N: 格式和数字列表格式。
        
        Args:
            sections: 章节字典
            
        Returns:
            步骤列表
        """
        workflow = []
        workflow_content = sections.get('工作流程', sections.get('Workflow', ''))
        
        if not workflow_content:
            return workflow
        
        # 匹配 ### Step N: 或 Step N: 格式
        step_pattern = r'(?:###\s+)?Step\s+\d+[:：]\s*(.+?)(?=(?:###\s+)?Step\s+\d+|$)'
        steps = re.findall(step_pattern, workflow_content, re.DOTALL | re.IGNORECASE)
        
        for step in steps:
            step = step.strip()
            if step:
                # 提取步骤标题（第一行或粗体内容）
                lines = step.split('\n')
                title = lines[0].strip()
                # 移除Markdown格式
                title = re.sub(r'\*\*(.+?)\*\*', r'\1', title)
                if title:
                    workflow.append(title)
        
        # 如果没有Step格式，尝试匹配数字列表
        if not workflow:
            list_pattern = r'^\d+[\.\、]\s*(.+)$'
            for line in workflow_content.split('\n'):
                match = re.match(list_pattern, line.strip())
                if match:
                    workflow.append(match.group(1).strip())
        
        return workflow
    
    def extract_keywords(self, metadata: Dict[str, Any], sections: Dict[str, str]) -> List[str]:
        """从 description、tags、when_to_use 提取关键词
        
        Args:
            metadata: YAML frontmatter
            sections: Markdown 章节
            
        Returns:
            关键词列表
        """
        keywords = set()
        
        # 从 tags 提取（支持列表和逗号分隔字符串两种格式）
        tags = metadata.get('metadata', {}).get('tags', [])
        if isinstance(tags, list):
            keywords.update(tags)
        elif isinstance(tags, str):
            # 支持逗号分隔的字符串格式（包括中文逗号）
            keywords.update([t.strip() for t in tags.replace('，', ',').split(',') if t.strip()])
        
        # 从 description 提取关键词
        description = metadata.get('description', '')
        # 提取中文关键词
        chinese_keywords = re.findall(r'[\u4e00-\u9fa5]{2,}', description)
        keywords.update(chinese_keywords)
        
        # 从 name 提取
        name = metadata.get('name', '')
        if name:
            # 转换 kebab-case 为关键词
            parts = name.replace('-', ' ').split()
            keywords.update(parts)
        
        # 从章节标题提取
        for section_name in sections.keys():
            keywords.add(section_name)
        
        return list(keywords)
    
    def extract_examples(self, sections: Dict[str, str]) -> List[str]:
        """提取示例查询
        
        从"使用方法"章节提取触发示例。
        
        Args:
            sections: Markdown 章节
            
        Returns:
            示例列表
        """
        examples = []
        
        # 从使用方法章节提取
        usage_content = sections.get('使用方法', '')
        
        # 匹配"触发指令"部分
        trigger_pattern = r'触发指令[：:]\s*["「]([^"」]+)["」]'
        triggers = re.findall(trigger_pattern, usage_content)
        examples.extend(triggers)
        
        # 匹配引号内的示例
        quote_pattern = r'["「]([^"」]{5,30})["」]'
        quotes = re.findall(quote_pattern, usage_content)
        examples.extend(quotes)
        
        return examples[:5]  # 最多返回5个示例
    
    def extract_triggers(self, metadata: Dict[str, Any], sections: Dict[str, str]) -> List[str]:
        """提取触发关键词
        
        从多个来源提取触发关键词，用于路由匹配。
        
        Args:
            metadata: YAML frontmatter
            sections: Markdown 章节
            
        Returns:
            触发关键词列表
        """
        triggers = []
        
        # # 从 description 提取
        # description = metadata.get('description', '')
        # if description:
        #     # 提取中文关键词（2-4字）
        #     chinese_words = re.findall(r'[\u4e00-\u9fa5]{2,4}', description)
        #     triggers.extend(chinese_words)
        
        # 从 tags 提取（支持列表和逗号分隔字符串两种格式）
        tags = metadata.get('metadata', {}).get('tags', [])
        if isinstance(tags, list):
            triggers.extend(tags)
        elif isinstance(tags, str):
            # 处理逗号分隔的字符串形式的 tags
            tag_list = [tag.strip() for tag in tags.split(',')]
            triggers.extend(tag_list)
        
        # 从 when_to_use 提取
        when_to_use = sections.get('使用场景', sections.get('使用方法', ''))
        if when_to_use:
            # 提取关键词
            words = re.findall(r'[\u4e00-\u9fa5]{2,4}', when_to_use)
            triggers.extend(words)
        
        # 去重并返回
        return list(set(triggers))
    
    def extract_when_to_use(self, metadata: Dict[str, Any], sections: Dict[str, str]) -> Optional[str]:
        """提取使用场景描述
        
        Args:
            metadata: YAML frontmatter
            sections: Markdown 章节
            
        Returns:
            使用场景描述
        """
        # 优先从专门章节获取
        when_to_use = sections.get('使用场景', sections.get('使用方法', ''))
        if when_to_use:
            # 提取第一段
            first_para = when_to_use.split('\n\n')[0]
            if first_para:
                return first_para.strip()
        
        # 从 description 中提取
        desc = metadata.get('description', '')
        if '当' in desc and '时使用' in desc:
            match = re.search(r'当(.+?)时使用', desc)
            if match:
                return match.group(1)
        
        # 从 description 提取句子
        if desc:
            # 提取句号前的内容
            sentences = desc.split('。')
            if sentences:
                return sentences[0]
        
        return None
    
    def extract_output_format(self, sections: Dict[str, str]) -> Optional[str]:
        """提取输出格式说明
        
        Args:
            sections: Markdown 章节
            
        Returns:
            输出格式说明
        """
        output_format = sections.get('输出格式', '')
        if output_format:
            # 提取第一段
            first_para = output_format.split('\n\n')[0]
            return first_para.strip() if first_para else None
        
        return None
    
    def extract_do_not_use(self, sections: Dict[str, str]) -> Optional[str]:
        """提取注意事项
        
        Args:
            sections: Markdown 章节
            
        Returns:
            注意事项
        """
        do_not_use = sections.get('注意事项', '')
        if do_not_use:
            return do_not_use.strip()
        
        return None


# 创建全局实例供复用
skill_parser = SkillParser()