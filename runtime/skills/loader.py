"""
Skill Loader - 加载 Skill 目录为 SkillPackage

扫描 skills 根目录，找到所有 SKILL.md 文件，解析并创建 SkillPackage 对象。
"""

import os
import re
import json
import logging
from pathlib import Path
from typing import List, Optional, Dict

from runtime.skills.models import SkillPackage
from runtime.skills.parser import SkillParser, skill_parser

logger = logging.getLogger(__name__)


class SkillLoader:
    """加载 Skill 目录为 SkillPackage
    
    职责：
    - 扫描 skills 根目录
    - 检测每个 skill 的子目录结构
    - 使用 SkillParser 解析 SKILL.md
    - 创建完整的 SkillPackage 对象
    
    使用方式：
        loader = SkillLoader()
        skills = loader.load_from_root(Path("skills/skills"))
        skill = loader.load_one(Path("skills/skills/meeting-followup-score"))
    """
    
    def __init__(self, parser: Optional[SkillParser] = None):
        """初始化 Loader
        
        Args:
            parser: SkillParser 实例，默认使用全局实例
        """
        self.parser = parser or skill_parser
    
    def load_from_root(self, skills_root: Path) -> List[SkillPackage]:
        """扫描根目录，加载所有 skill
        
        遍历 skills_root 下的所有子目录，查找 SKILL.md 文件并解析。
        如果根目录下直接包含 SKILL.md 文件，也会加载它。
        
        Args:
            skills_root: Skills 根目录路径（如 skills/skills/）
            
        Returns:
            SkillPackage 列表
        """
        if not skills_root.exists():
            logger.warning(f"Skills root directory not found: {skills_root}")
            return []
        
        skills = []
        
        # 检查根目录下是否直接包含 SKILL.md 文件
        root_skill_md = skills_root / "SKILL.md"
        if root_skill_md.exists():
            logger.info(f"Found SKILL.md in root directory: {skills_root}")
            skill_package = self.load_one(skills_root)
            if skill_package:
                skills.append(skill_package)
                logger.info(f"Loaded skill from root: {skill_package.name}")
        
        # 遍历所有子目录（跳过 _ 开头的共享/内部目录）
        for skill_dir in skills_root.iterdir():
            if not skill_dir.is_dir():
                continue
            if skill_dir.name.startswith("_") or skill_dir.name.startswith("."):
                continue
            
            # 尝试加载单个 skill
            skill_package = self.load_one(skill_dir)
            if skill_package:
                skills.append(skill_package)
                logger.info(f"Loaded skill from subdir: {skill_package.name}")
        
        logger.info(f"Total skills loaded: {len(skills)}")
        return skills
    
    def load_one(self, skill_dir: Path) -> Optional[SkillPackage]:
        """
        加载单个 skill 目录
        
        解析 skill_dir/SKILL.md 文件，检测子目录，创建 SkillPackage。
        
        Args:
            skill_dir: Skill 目录路径（如 skills/skills/meeting-followup-score/）
            
        Returns:
            SkillPackage 对象，加载失败返回 None
        """
        try:
            # 1. 读取 SKILL.md 内容（主要信息来源）
            skill_md_path = skill_dir / "SKILL.md"
            if not skill_md_path.exists():
                logger.error(f"SKILL.md not found in {skill_dir} - cannot load skill")
                return None
            
            logger.info(f"=== 开始读取 SKILL.md: {skill_md_path} ===")
            content = skill_md_path.read_text(encoding='utf-8')
            
            # 2. 解析 YAML frontmatter 获取元数据
            metadata, instructions = self.parser.parse(content)
            logger.info(f"解析后的 metadata: {json.dumps(metadata, ensure_ascii=False)}")
            
            # 验证必要字段
            if not metadata.get('name'):
                logger.error(f"✗ SKILL.md 缺少必要的 'name' 字段")
                return None
            
            if not metadata.get('description'):
                logger.error(f"✗ SKILL.md 缺少必要的 'description' 字段")
                return None
            
            # 3. 检测子目录和资源文件
            subdirs = self._detect_subdirs(skill_dir)
            scripts = self._list_files(subdirs.get('scripts'), '.py')
            templates = self._list_files(subdirs.get('templates'), '.md')
            references = self._list_files(subdirs.get('references'), '.md')
            
            # 4. 处理元信息
            meta_info = {
                'author': metadata.get('author'),
                'version': metadata.get('version'),  # 版本号可选，有则使用
                'category': metadata.get('category', 'default'),
                'tags': ''
            }
            
            # 处理嵌套的metadata字段（兼容旧格式）
            if 'metadata' in metadata and isinstance(metadata['metadata'], dict):
                if not meta_info['author']:
                    meta_info['author'] = metadata['metadata'].get('author')
                if not meta_info['version']:
                    meta_info['version'] = metadata['metadata'].get('version')
                if not meta_info['category']:
                    meta_info['category'] = metadata['metadata'].get('category', 'default')
                if 'tags' in metadata['metadata']:
                    meta_info['tags'] = metadata['metadata']['tags']

            
            if meta_info['version']:
                logger.info(f"✓ 从 SKILL.md 读取到版本号: {meta_info['version']}")
            else:
                logger.info(f"✓ SKILL.md 未指定版本号")
            
            # 处理标签格式
            if 'tags' in metadata:
                if isinstance(metadata['tags'], list):
                    meta_info['tags'] = ','.join(metadata['tags'])
                elif isinstance(metadata['tags'], str):
                    meta_info['tags'] = metadata['tags']
            
            # 提取其他字段
            keywords = metadata.get('keywords', [])
            examples = metadata.get('examples', [])
            workflow = metadata.get('workflow', [])
            when_to_use = metadata.get('when_to_use', '')
            do_not_use = metadata.get('do_not_use', '')
            output_format = metadata.get('output_format')
            
            # 获取 triggers（按优先级，支持多种格式）：
            # 1. 嵌套 metadata.tags 或 metadata.triggers
            # 2. 顶层 triggers 字段
            # 3. 顶层 tags 字段
            # 支持格式：数组 [a, b, c] 或逗号分隔字符串 "a, b, c"
            triggers = []
            
            def normalize_tags(value):
                """将 tags/triggers 标准化为列表"""
                if not value:
                    return []
                if isinstance(value, list):
                    return value
                if isinstance(value, str):
                    # 逗号分隔的字符串
                    return [t.strip() for t in value.split(',') if t.strip()]
                return []
            
            # 1. 从嵌套 metadata 获取
            if 'metadata' in metadata and isinstance(metadata['metadata'], dict):
                nested = metadata['metadata']
                triggers = normalize_tags(nested.get('triggers') or nested.get('tags'))
            
            # 2. 从顶层 triggers 获取
            if not triggers and 'triggers' in metadata:
                triggers = normalize_tags(metadata.get('triggers'))
            
            # 3. 从顶层 tags 获取
            if not triggers and 'tags' in metadata:
                triggers = normalize_tags(metadata.get('tags'))
            
            logger.info(f"✓ 获取到的 triggers: {triggers}")
            
            # 以下字段如果在 SKILL.md frontmatter 中没有定义，尝试从正文 sections 中提取
            if content:
                try:
                    sections = self.parser.extract_sections(content)
                    if not workflow:
                        workflow = self.parser.extract_workflow(sections)
                    if not keywords:
                        keywords = self.parser.extract_keywords(metadata, sections)
                    if not examples:
                        examples = self.parser.extract_examples(sections)
                    if not triggers:
                        triggers = self.parser.extract_triggers(metadata, sections)
                    if not when_to_use:
                        when_to_use = self.parser.extract_when_to_use(metadata, sections)
                    if not output_format:
                        output_format = self.parser.extract_output_format(sections)
                    if not do_not_use:
                        do_not_use = self.parser.extract_do_not_use(sections)
                except Exception as e:
                    logger.warning(f"Failed to extract additional info from SKILL.md sections: {e}")
            
            # 设置默认值
            keywords = keywords or []
            examples = examples or []
            workflow = workflow or []
            triggers = triggers or []
            
            # 创建 SkillPackage
            skill_package = SkillPackage(
                name=metadata.get('name', skill_dir.name),
                root_dir=skill_dir,
                skill_md_path=skill_md_path,
                scripts_dir=subdirs.get('scripts'),
                templates_dir=subdirs.get('templates'),
                assets_dir=subdirs.get('assets'),
                references_dir=subdirs.get('references'),
                metadata=metadata,
                description=metadata.get('description', ''),
                instructions=instructions,
                triggers=triggers,
                examples=examples,
                allowed_tools=metadata.get('allowed_tools', []),
                priority=metadata.get('priority', 0),
                workflow=workflow,
                output_format=output_format,
                when_to_use=when_to_use,
                do_not_use=do_not_use,
                tags=[tag.strip() for tag in meta_info.get('tags', '').split(',')] if isinstance(meta_info.get('tags'), str) else meta_info.get('tags', []),
                keywords=keywords,
                scripts=scripts,
                templates=templates,
                references=references,
                author=meta_info.get('author'),
                version=meta_info.get('version'),
                category=meta_info.get('category')
            )
            
            return skill_package
            
        except Exception as e:
            logger.error(f"Failed to load skill from {skill_dir}: {e}")
            import traceback
            logger.error(f"错误堆栈: {traceback.format_exc()}")
            return None
    
    def _detect_subdirs(self, skill_dir: Path) -> Dict[str, Path]:
        """检测 skill 目录的子目录
        
        检测标准 Anthropic 风格的目录结构：
        - scripts/ - 脚本文件
        - templates/ - 模板文件
        - assets/ - 静态资源
        - references/ - 参考文档
        
        Args:
            skill_dir: Skill 目录路径
            
        Returns:
            子目录名称到路径的映射
        """
        subdirs = {}
        
        for subdir_name in ['scripts', 'templates', 'assets', 'references']:
            subdir_path = skill_dir / subdir_name
            if subdir_path.exists() and subdir_path.is_dir():
                subdirs[subdir_name] = subdir_path
        
        return subdirs
    
    def _list_files(self, directory: Optional[Path], extension: str) -> List[str]:
        """列出目录中指定扩展名的文件
        
        Args:
            directory: 目录路径
            extension: 文件扩展名（如 '.py'）
            
        Returns:
            文件名列表
        """
        if not directory or not directory.exists():
            return []
        
        files = []
        for f in directory.iterdir():
            if f.is_file() and f.suffix == extension:
                files.append(f.name)
        
        return files
    
    def reload(self, skill_dir: Path) -> Optional[SkillPackage]:
        """重新加载单个 skill
        
        用于 skill 文件更新后重新加载。
        
        Args:
            skill_dir: Skill 目录路径
            
        Returns:
            重新加载的 SkillPackage
        """
        return self.load_one(skill_dir)


# 创建全局实例供复用
skill_loader = SkillLoader()