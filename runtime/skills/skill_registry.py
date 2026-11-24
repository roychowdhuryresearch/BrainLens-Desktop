"""
Skill注册表 - 扫描、解析、缓存所有Skill

服务启动时扫描skills/skills/*/SKILL.md，解析YAML frontmatter和Markdown章节，
缓存所有Skill元数据供匹配器使用。

重构说明：
- 现在使用 SkillLoader 加载 SkillPackage
- 内部存储 SkillPackage 而非 SkillManifest
- 提供 get_package() 获取 SkillPackage
- 保留 get() 返回 SkillManifest 以兼容现有 API
"""

import os
import logging
import time
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Set

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent

from runtime.models.schemas import (
    SkillManifest,
    SkillType,
    SkillInvocationMode
)
from runtime.skills.models import SkillPackage
from runtime.skills.loader import SkillLoader

def get_user_cache_key(user_id: str) -> str:
    """Normalize user ids so cache keys are stable across user- and user_ prefixes."""
    normalized = str(user_id or "").strip()
    if normalized.startswith("user-") or normalized.startswith("user_"):
        return normalized[5:]
    return normalized

def get_user_dir_name(user_id: str) -> str:
    """
    获取用户目录名称，处理用户ID可能已有user-前缀的情况
    
    Args:
        user_id: 用户ID
        
    Returns:
        用户目录名称
    """
    user_key = get_user_cache_key(user_id)
    return f"user-{user_key}"

def safe_file_delete(file_path: Path, max_attempts: int = 3, delay: float = 0.5) -> bool:
    """
    安全删除文件，支持重试机制
    
    Args:
        file_path: 文件路径
        max_attempts: 最大重试次数
        delay: 重试间隔（秒）
        
    Returns:
        是否成功删除
    """
    if not file_path.exists():
        return True
    
    for attempt in range(max_attempts):
        try:
            os.remove(file_path)
            return True
        except PermissionError:
            logger.warning(f"Permission error when deleting {file_path}, attempt {attempt + 1}/{max_attempts}")
            if attempt < max_attempts - 1:
                time.sleep(delay)
        except Exception as e:
            logger.error(f"Error deleting {file_path}: {e}")
            break
    
    return False

def safe_directory_delete(directory_path: Path, max_attempts: int = 3, delay: float = 0.5) -> bool:
    """
    安全删除目录，支持重试机制
    
    Args:
        directory_path: 目录路径
        max_attempts: 最大重试次数
        delay: 重试间隔（秒）
        
    Returns:
        是否成功删除
    """
    if not directory_path.exists():
        return True
    
    for attempt in range(max_attempts):
        try:
            shutil.rmtree(directory_path)
            return True
        except PermissionError:
            logger.warning(f"Permission error when deleting {directory_path}, attempt {attempt + 1}/{max_attempts}")
            if attempt < max_attempts - 1:
                time.sleep(delay)
        except Exception as e:
            logger.error(f"Error deleting {directory_path}: {e}")
            break
    
    return False

def ensure_directory_exists(directory_path: Path) -> bool:
    """
    确保目录存在，如果不存在则创建
    
    Args:
        directory_path: 目录路径
        
    Returns:
        是否成功创建或目录已存在
    """
    try:
        directory_path.mkdir(parents=True, exist_ok=True)
        return True
    except Exception as e:
        logger.error(f"Failed to create directory {directory_path}: {e}")
        return False

logger = logging.getLogger(__name__)


def _resolve_default_skills_base_dir(repo_root: Path) -> Path:
    """Load bundled skills unless the operator provides a skills directory."""
    override = os.getenv("SKILLS_BASE_DIR", "").strip()
    return repo_root / (Path(override).expanduser() if override else "skills")


class SkillChangeHandler(FileSystemEventHandler):
    """
    文件系统事件处理器，用于监听技能文件的变化并触发缓存刷新
    """
    def __init__(self, skill_registry):
        self.skill_registry = skill_registry
        self.logger = logging.getLogger(__name__)
        # 记录最近处理过的事件，避免重复处理
        self.recent_events: Dict[str, float] = {}  # {event_key: timestamp}
        self.event_cooldown = 1.0  # 事件冷却时间（秒）
        self.last_event_time = 0
        self.event_expiry_time = 30.0  # 事件过期时间（秒）
    
    def on_modified(self, event: FileSystemEvent):
        """当文件或目录被修改时触发"""
        self._handle_event(event)
    
    def on_created(self, event: FileSystemEvent):
        """当文件或目录被创建时触发"""
        self._handle_event(event)
    
    def on_deleted(self, event: FileSystemEvent):
        """当文件或目录被删除时触发"""
        self._handle_event(event)
    
    def on_moved(self, event: FileSystemEvent):
        """当文件或目录被移动时触发"""
        self._handle_event(event)
    
    def _handle_event(self, event: FileSystemEvent):
        """处理文件系统事件"""
        # 忽略临时文件和隐藏文件
        src_path = str(event.src_path)
        if os.path.basename(src_path).startswith('.'):
            return
        
        # 检查是否是技能相关文件或目录
        src_path_str = str(event.src_path)
        
        # 如果是目录，直接处理
        if os.path.isdir(src_path_str):
            # 检查是否是技能相关目录（skills或test下的用户目录）
            if 'skills' in src_path_str or 'test' in src_path_str:
                pass  # 处理目录事件
            else:
                return
        # 如果是文件，检查扩展名
        elif not any(ext in src_path_str for ext in ['.md', '.json', '.yaml', '.yml']):
            return
        
        # 检查冷却时间，避免短时间内重复处理
        current_time = time.time()
        if current_time - self.last_event_time < self.event_cooldown:
            return
        
        # 检查事件是否已经处理过（冷却期内）
        event_key = f"{event.event_type}:{event.src_path}"
        current_time = time.time()
        
        if event_key in self.recent_events:
            # 检查事件是否在冷却期内
            last_event_time = self.recent_events[event_key]
            if current_time - last_event_time < self.event_cooldown:
                return
        
        # 更新事件记录
        self.recent_events[event_key] = current_time
        self.last_event_time = current_time
        
        # 清理过期事件记录
        self._cleanup_old_events()
        
        # 触发技能缓存刷新（不重启文件监听器，避免死锁）
        self.logger.info(f"Detected skill file change: {event.event_type} {event.src_path}")
        self.skill_registry._refresh_without_observer()
    
    def _cleanup_old_events(self):
        """清理过期的事件记录"""
        current_time = time.time()
        events_to_remove = []
        
        # 只清理超过过期时间的事件
        for event_key, timestamp in self.recent_events.items():
            if current_time - timestamp > self.event_expiry_time:
                events_to_remove.append(event_key)
        
        # 移除过期事件
        for event_key in events_to_remove:
            del self.recent_events[event_key]


class SkillRegistry:
    """
    Skill注册表 - 单例模式
    
    职责：
    - 服务启动时扫描Skills目录
    - 使用 SkillLoader 加载 SkillPackage
    - 缓存所有 SkillPackage
    - 提供查询接口
    - 支持按用户ID加载技能（prod目录对所有用户开放，test目录按用户隔离）
    - 监听技能文件变化并自动刷新缓存
    
    使用方式：
        registry = SkillRegistry()
        registry.scan_skills()  # 扫描prod目录
        registry.scan_user_skills(user_id)  # 扫描特定用户的test目录
        skill_package = registry.get_package("meeting-followup-score", user_id)
        skill_manifest = registry.get("meeting-followup-score", user_id)  # 兼容旧API
    """
    
    _instance = None
    _prod_packages: Dict[str, SkillPackage] = {}  # 正式环境技能包
    _user_packages: Dict[str, Dict[str, SkillPackage]] = {}  # 用户测试环境技能包 {user_id: {skill_name: package}}
    _skills_base_dir: Optional[Path] = None
    _initialized: bool = False
    _observer = None  # 文件系统观察者
    _event_handler = None  # 事件处理器
    
    def __new__(cls) -> 'SkillRegistry':
        """单例模式"""
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    def _start_file_watcher(self):
        """
        启动文件系统监听器，监听技能文件的变化
        """
        if not self._skills_base_dir:
            logger.error("Skills base directory not initialized, cannot start file watcher")
            return
        
        # 停止已有的监听器
        self._stop_file_watcher()
        
        # 创建事件处理器和观察者
        self._event_handler = SkillChangeHandler(self)
        self._observer = Observer()
        
        # 监听正式环境技能目录
        prod_skills_path = self._skills_base_dir / "skills"
        if prod_skills_path.exists() and self._observer and self._event_handler:
            self._observer.schedule(self._event_handler, str(prod_skills_path), recursive=True)
            logger.info(f"Started watching skills directory: {prod_skills_path}")
        
        # 监听测试环境技能目录
        test_skills_path = self._skills_base_dir / "test"
        if test_skills_path.exists() and self._observer and self._event_handler:
            self._observer.schedule(self._event_handler, str(test_skills_path), recursive=True)
            logger.info(f"Started watching test skills directory: {test_skills_path}")
        
        # 启动观察者线程
        if self._observer:
            self._observer.start()
    
    def _stop_file_watcher(self):
        """
        停止文件系统监听器
        """
        if self._observer:
            self._observer.stop()
            self._observer.join()
            self._observer = None
            logger.info("Stopped file watcher")
    
    def scan_skills(self, skills_base_dir: Optional[str] = None) -> List[SkillPackage]:
        """
        扫描正式环境Skills目录(prod)，加载所有技能
        
        Args:
            skills_base_dir: Skills根目录路径
            
        Returns:
            加载后的 SkillPackage 列表
        """
        repo_root = Path(__file__).resolve().parents[2]
        if skills_base_dir:
            self._skills_base_dir = repo_root / Path(skills_base_dir).expanduser()
        else:
            self._skills_base_dir = _resolve_default_skills_base_dir(repo_root)
        logger.info(f"Skills base dir: {self._skills_base_dir}")

        # 扫描正式环境目录 (skills)
        prod_skills_path = self._skills_base_dir / "skills"
        logger.info(f"Scanning default skills from: {prod_skills_path}")
        logger.info(f"Scanning default skills directory: {prod_skills_path}")
        
        # 使用 SkillLoader 加载技能
        loader = SkillLoader()
        prod_packages = []
        
        # 加载正式环境技能
        if prod_skills_path.exists():
            prod_packages = loader.load_from_root(prod_skills_path)
            logger.info(f"Loaded {len(prod_packages)} skills from default directory")
        else:
            logger.warning(f"Default skills directory not found: {prod_skills_path}")
        
        # 存储到正式环境缓存
        self._prod_packages.clear()
        
        # 添加正式环境技能
        for pkg in prod_packages:
            self._prod_packages[pkg.name] = pkg
            logger.info(f"Added default skill: {pkg.name} v{pkg.version}")
        
        # 移除已废弃的 _default_packages 属性
        if hasattr(self, '_default_packages'):
            delattr(self, '_default_packages')
        
        self._initialized = True
        logger.info(f"Total default skills loaded: {len(self._prod_packages)}")
        
        # 启动文件系统监听器
        self._start_file_watcher()
        
        return list(self._prod_packages.values())
    
    def scan_user_skills(self, user_id: str) -> List[SkillPackage]:
        """
        扫描特定用户的测试环境Skills目录，加载所有SKILL.md文件
        
        Args:
            user_id: 用户ID
            
        Returns:
            加载后的 SkillPackage 列表
        """
        if not self._skills_base_dir:
            logger.error("Skills base directory not initialized, call scan_skills first")
            return []
        
        user_key = get_user_cache_key(user_id)
        user_skills_path = self._skills_base_dir / "test" / get_user_dir_name(user_key)
        legacy_user_skills_path = self._skills_base_dir / "test" / f"user_{user_key}"
        if not user_skills_path.exists() and legacy_user_skills_path.exists():
            user_skills_path = legacy_user_skills_path
        logger.info(f"Scanning user skills directory: {user_skills_path}")
        
        if not user_skills_path.exists():
            logger.warning(f"User skills directory not found: {user_skills_path}")
            return []
        
        # 列出目录内容
        logger.info(f"Directory contents: {list(user_skills_path.iterdir())}")
        
        # 使用 SkillLoader 加载所有 skills
        loader = SkillLoader()
        packages = loader.load_from_root(user_skills_path)
        
        logger.info(f"Loaded {len(packages)} skills from user directory")
        for pkg in packages:
            logger.info(f"Loaded skill: {pkg.name}")
        
        # 存储到用户环境缓存
        if user_key not in self._user_packages:
            self._user_packages[user_key] = {}
        self._user_packages[user_key].clear()
        for pkg in packages:
            self._user_packages[user_key][pkg.name] = pkg
        
        logger.info(f"Total skills loaded for user {user_key}: {len(self._user_packages[user_key])}")
        return packages
    
    def get_package(self, name: str, user_id: Optional[str] = None) -> Optional[SkillPackage]:
        """
        按名称获取 SkillPackage
        
        Args:
            name: Skill名称
            user_id: 用户ID（可选，如果提供则同时查找用户测试环境的技能）
            
        Returns:
            SkillPackage对象，不存在返回None
        """
        # 优先级：用户测试环境 > 正式环境
        
        # 1. 先从用户测试环境查找
        user_key = get_user_cache_key(user_id) if user_id else None
        if user_key and user_key in self._user_packages:
            if name in self._user_packages[user_key]:
                logger.info(f"✅ 优先使用用户测试环境技能: {name}")
                return self._user_packages[user_key][name]
        
        # 2. 再从正式环境查找（已包含prod和默认目录的合并结果）
        if name in self._prod_packages:
            logger.info(f"使用正式环境技能: {name}")
            return self._prod_packages[name]
        
        logger.info(f"技能 {name} 在任何环境中都未找到")
        return None
    
    def get_by_name(self, name: str) -> Optional[SkillPackage]:
        """兼容方法：按名称获取 SkillPackage。"""
        return self.get_package(name)
    
    def get(self, name: str, user_id: Optional[str] = None) -> Optional[SkillManifest]:
        """
        按名称获取 SkillManifest（兼容旧API）

        将内部的 SkillPackage 转换为 SkillManifest 返回。

        Args:
            name: Skill名称
            user_id: 用户ID（可选，如果提供则同时查找用户测试环境的技能）

        Returns:
            SkillManifest对象，不存在返回None
        """
        # 旧签名漏写 user_id 但 body 里就引用了 `user_id`。模块 docstring 的示例
        # 也是 `registry.get(name, user_id)` 两参数调用。修复前任何调用点都会
        # 踩到 NameError。
        pkg = self.get_package(name, user_id)
        if not pkg:
            return None
        
        # 转换 SkillPackage -> SkillManifest
        return self._package_to_manifest(pkg)
    
    def get_all(self, user_id: Optional[str] = None) -> List[SkillManifest]:
        """
        获取所有 SkillManifest（兼容旧API）
        
        Args:
            user_id: 用户ID（可选，如果提供则同时返回用户测试环境的技能）
            
        Returns:
            SkillManifest列表
        """
        # 使用字典去重，优先级：用户测试环境 > 正式环境
        skill_dict = {}
        
        # 1. 添加正式环境技能
        for pkg in self._prod_packages.values():
            skill_dict[pkg.name] = self._package_to_manifest(pkg)
        
        # 2. 添加用户测试环境技能（会覆盖正式环境技能，最高优先级）
        user_key = get_user_cache_key(user_id) if user_id else None
        if user_key and user_key in self._user_packages:
            for pkg in self._user_packages[user_key].values():
                manifest = self._package_to_manifest(pkg)
                logger.info(f"✅ 优先使用用户测试环境技能: {pkg.name} v{manifest.version}")
                skill_dict[pkg.name] = manifest
        
        # 转换为列表返回
        manifests = list(skill_dict.values())
        logger.info(f"返回 {len(manifests)} 个技能: {[f'{m.name} v{m.version}' for m in manifests]}")
        return manifests
    
    def get_all_packages(self, user_id: Optional[str] = None, user_role: Optional[str] = None, skill_environment: Optional[str] = None) -> List[SkillPackage]:
        """
        获取所有 SkillPackage（基于用户角色和环境的访问控制）
        
        Args:
            user_id: 用户ID（可选，如果提供则同时返回用户测试环境的技能）
            user_role: 用户角色（可选，用于控制技能访问权限）
            skill_environment: 技能环境（可选，'prod' 或 'test'）
            
        Returns:
            SkillPackage列表
        """
        packages = []
        
        if skill_environment == 'prod':
            # 正式环境：所有用户都能看到正式环境技能
            packages.extend(list(self._prod_packages.values()))
        elif skill_environment == 'test':
            # 测试环境：根据角色返回不同的测试技能
            if user_role in ['ADMIN', 'SUPER_ADMIN']:
                # 管理员：只获取已提交的测试技能
                from runtime.skills.submission_manager import get_all_submitted_skills
                submitted_skills = get_all_submitted_skills()
                
                # 确保已扫描所有用户的测试技能
                if self._skills_base_dir:
                    test_skills_path = self._skills_base_dir / "test"
                    if test_skills_path.exists():
                        for user_dir in test_skills_path.iterdir():
                            if user_dir.is_dir():
                                # 处理 user_ 和 user- 两种前缀
                                admin_user_id = user_dir.name
                                if admin_user_id.startswith("user_"):
                                    admin_user_id = admin_user_id[5:]
                                elif admin_user_id.startswith("user-"):
                                    admin_user_id = admin_user_id[5:]
                                if admin_user_id not in self._user_packages:
                                    self.scan_user_skills(admin_user_id)
                
                # 只返回已提交的测试技能
                for submitted in submitted_skills:
                    sub_user_id = submitted['user_id']
                    skill_name = submitted['skill_name']
                    sub_user_key = get_user_cache_key(sub_user_id)
                    if sub_user_key in self._user_packages and skill_name in self._user_packages[sub_user_key]:
                        packages.append(self._user_packages[sub_user_key][skill_name])
                
                logger.info(f"[SkillRegistry] 管理员获取已提交测试技能: {len(packages)} 个")
            elif user_role == 'DEVELOPER':
                # 开发用户：只获取自己的测试技能
                user_key = get_user_cache_key(user_id) if user_id else None
                if user_key and user_key in self._user_packages:
                    packages.extend(list(self._user_packages[user_key].values()))
                logger.info(f"[SkillRegistry] 开发用户获取测试技能: {len(packages)} 个")
        else:
            # 默认：返回正式环境技能
            packages.extend(list(self._prod_packages.values()))
        
        # 记录当前环境可用技能数量
        logger.info(f"[SkillRegistry] 返回 {len(packages)} 个技能（环境: {skill_environment}, 用户: {user_id}, 角色: {user_role}）")
        logger.info(f"[SkillRegistry] 技能列表: {[pkg.name for pkg in packages]}")
        return packages
    
    def get_by_tag(self, tag: str, user_id: Optional[str] = None, user_role: Optional[str] = None) -> List[SkillManifest]:
        """
        按标签获取Skills（基于用户角色的访问控制）
        
        Args:
            tag: 标签名称
            user_id: 用户ID（可选，如果提供则同时查找用户测试环境的技能）
            user_role: 用户角色（可选，用于控制技能访问权限）
            
        Returns:
            匹配的SkillManifest列表
        """
        results = []
        
        # 从正式环境查找（所有用户都能看到）
        for pkg in self._prod_packages.values():
            if tag in pkg.tags:
                results.append(self._package_to_manifest(pkg))
        
        # 从用户测试环境查找（仅管理员和开发用户能看到）
        user_key = get_user_cache_key(user_id) if user_id else None
        if user_key and user_key in self._user_packages:
            # 管理员或开发用户都能看到自己的测试技能
            for pkg in self._user_packages[user_key].values():
                if tag in pkg.tags:
                    results.append(self._package_to_manifest(pkg))
        
        return results
    
    def get_by_category(self, category: str, user_id: Optional[str] = None, user_role: Optional[str] = None) -> List[SkillManifest]:
        """
        按分类获取Skills（基于用户角色的访问控制）
        
        Args:
            category: 分类名称
            user_id: 用户ID（可选，如果提供则同时查找用户测试环境的技能）
            user_role: 用户角色（可选，用于控制技能访问权限）
            
        Returns:
            匹配的SkillManifest列表
        """
        results = []
        
        # 从正式环境查找（所有用户都能看到）
        for pkg in self._prod_packages.values():
            if pkg.category == category:
                results.append(self._package_to_manifest(pkg))
        
        # 从用户测试环境查找（仅管理员和开发用户能看到）
        user_key = get_user_cache_key(user_id) if user_id else None
        if user_key and user_key in self._user_packages:
            # 管理员或开发用户都能看到自己的测试技能
            for pkg in self._user_packages[user_key].values():
                if pkg.category == category:
                    results.append(self._package_to_manifest(pkg))
        
        return results
    
    def refresh(self) -> None:
        """刷新缓存"""
        self._prod_packages.clear()
        self._user_packages.clear()
        self._initialized = False
        if self._skills_base_dir:
            # 保存当前的观察者状态
            observer_was_running = self._observer is not None
            
            # 刷新技能列表
            self.scan_skills(str(self._skills_base_dir))
            
            # 重新加载所有用户的测试环境技能
            test_skills_path = self._skills_base_dir / "test"
            if test_skills_path.exists():
                for user_dir in test_skills_path.iterdir():
                    if user_dir.is_dir():
                        # 处理 user_ 和 user- 两种前缀
                        admin_user_id = user_dir.name
                        if admin_user_id.startswith("user_"):
                            admin_user_id = admin_user_id[5:]
                        elif admin_user_id.startswith("user-"):
                            admin_user_id = admin_user_id[5:]
                        self.scan_user_skills(admin_user_id)
            
            # 如果观察者之前在运行，确保它现在还在运行
            if not observer_was_running and self._observer:
                logger.info("File watcher started during refresh")
    
    def _refresh_without_observer(self) -> None:
        """
        刷新缓存（不重启文件监听器）
        
        用于文件监听器回调中，避免死锁。
        """
        self._prod_packages.clear()
        self._user_packages.clear()
        self._initialized = False
        if self._skills_base_dir:
            # 直接扫描技能，不重启文件监听器
            self._scan_skills_internal(str(self._skills_base_dir))
            
            # 重新加载所有用户的测试环境技能
            test_skills_path = self._skills_base_dir / "test"
            if test_skills_path.exists():
                for user_dir in test_skills_path.iterdir():
                    if user_dir.is_dir():
                        # 处理 user_ 和 user- 两种前缀
                        admin_user_id = user_dir.name
                        if admin_user_id.startswith("user_"):
                            admin_user_id = admin_user_id[5:]
                        elif admin_user_id.startswith("user-"):
                            admin_user_id = admin_user_id[5:]
                        self.scan_user_skills(admin_user_id)
    
    def _scan_skills_internal(self, skills_dir: str) -> None:
        """
        内部扫描方法（不启动文件监听器）
        
        Args:
            skills_dir: 技能目录路径
        """
        skills_path = Path(skills_dir)
        
        if not skills_path.exists():
            logger.warning(f"Skills directory not found: {skills_path}")
            return
        
        # 扫描正式环境技能
        prod_skills_path = skills_path / "skills"
        if prod_skills_path.exists():
            logger.info(f"Scanning default skills from: {skills_path}")
            self._scan_prod_skills(prod_skills_path)
        
        self._initialized = True
        logger.info(f"Total default skills loaded: {len(self._prod_packages)}")
    
    def _scan_prod_skills(self, prod_skills_path: Path) -> None:
        """
        扫描正式环境技能（内部方法）
        
        Args:
            prod_skills_path: 正式环境技能目录路径
        """
        logger.info(f"Scanning default skills directory: {prod_skills_path}")
        
        # 使用 SkillLoader 加载技能
        loader = SkillLoader()
        prod_packages = loader.load_from_root(prod_skills_path)
        logger.info(f"Loaded {len(prod_packages)} skills from default directory")
        
        # 存储到正式环境缓存
        self._prod_packages.clear()

        # 添加正式环境技能（跳过已废弃技能）
        for pkg in prod_packages:
            if pkg.metadata.get("deprecated") is True:
                logger.info(f"Skipping deprecated skill: {pkg.name} → {pkg.metadata.get('redirect_to', 'unknown')}")
                continue
            self._prod_packages[pkg.name] = pkg
            logger.info(f"Added default skill: {pkg.name} v{pkg.version}")

    def register(self, pkg: SkillPackage) -> None:
        """Explicitly register a single SkillPackage into the prod cache."""
        if pkg.metadata.get("deprecated") is True:
            logger.info(f"Refusing to register deprecated skill: {pkg.name}")
            return
        self._prod_packages[pkg.name] = pkg
        logger.info(f"[SkillRegistry] Registered skill: {pkg.name}")

    def unregister(self, skill_name: str) -> bool:
        """Remove a skill from the prod cache by name. Returns True if removed."""
        if skill_name in self._prod_packages:
            del self._prod_packages[skill_name]
            logger.info(f"[SkillRegistry] Unregistered skill: {skill_name}")
            return True
        return False

    def refresh_user_skills(self, user_id: str) -> None:
        """
        刷新特定用户的技能缓存
        
        Args:
            user_id: 用户ID
        """
        user_key = get_user_cache_key(user_id)
        if user_key in self._user_packages:
            del self._user_packages[user_key]
        self.scan_user_skills(user_key)
    
    def _package_to_manifest(self, pkg: SkillPackage) -> SkillManifest:
        """
        将 SkillPackage 转换为 SkillManifest
        
        用于兼容现有 API。
        
        Args:
            pkg: SkillPackage 对象
            
        Returns:
            SkillManifest 对象
        """
        # 根据root_dir判断技能所在环境
        root_dir_str = str(pkg.root_dir)
        environment = "test" if "test" in root_dir_str else "prod"
        
        # 从root_dir中提取user_id（仅测试环境）
        user_id = None
        if environment == "test":
            import re
            # 使用更灵活的正则表达式，支持 user- 和 user_ 两种前缀格式
            # 保留完整的前缀（user- 或 user_）
            match = re.search(r"test[/\\](user[-_][^/\\]+)", root_dir_str)
            if match:
                user_id = match.group(1)
                logger.info(f"Extracted user_id from path: {user_id}")
        
        logger.info(f"=== Converting package to manifest: {pkg.name} ===")
        logger.info(f"Package version: {pkg.version}")
        logger.info(f"Package root_dir: {pkg.root_dir}")
        logger.info(f"Package skill_md_path: {pkg.skill_md_path}")
        logger.info(f"Extracted environment: {environment}, user_id: {user_id}")
        
        # 使用从SKILL.md中获取的版本号
        version = pkg.version  # 此版本号已从SKILL.md的YAML frontmatter解析而来
        version_info = version if version else "(无版本)"
        logger.info(f"=== Final version for {pkg.name}: {version_info} ===")
        
        # 获取技能的提交状态
        from runtime.skills.submission_manager import get_skill_submission_status
        submitted_status = get_skill_submission_status(user_id, pkg.name) if user_id else None
        
        submitted = False
        submitted_at = None
        published = False
        published_at = None
        
        if submitted_status:
            submitted = True
            submitted_at = submitted_status.get("submitted_at")
            published = submitted_status.get("status") == "published"
            published_at = submitted_status.get("published_at")
            logger.info(f"Skill {pkg.name} submission status: submitted={submitted}, published={published}")
        
        # 获取用户名称
        username = None
        if user_id:
            # 测试环境技能：从数据库查询用户名
            from runtime.services.auth_service import get_user_by_id
            from runtime.models.user import get_db
            db_gen = get_db()
            db = next(db_gen)
            try:
                user = get_user_by_id(db, user_id)
                if user:
                    username = user.username
            finally:
                try:
                    next(db_gen)
                except StopIteration:
                    pass
        else:
            # 正式环境技能：尝试从.skill_metadata.json文件中读取user_id
            metadata_file = pkg.root_dir / ".skill_metadata.json"
            if metadata_file.exists():
                try:
                    import json
                    with open(metadata_file, 'r', encoding='utf-8') as f:
                        metadata = json.load(f)
                        metadata_user_id = metadata.get("user_id")
                        if metadata_user_id:
                            from runtime.services.auth_service import get_user_by_id
                            from runtime.models.user import get_db
                            db_gen = get_db()
                            db = next(db_gen)
                            try:
                                user = get_user_by_id(db, metadata_user_id)
                                if user:
                                    username = user.username
                            finally:
                                try:
                                    next(db_gen)
                                except StopIteration:
                                    pass
                except Exception as e:
                    logger.warning(f"Failed to read skill metadata: {e}")
            
            # 如果没有元数据文件，使用SKILL.md中的author字段作为后备
            if not username and pkg.author:
                username = pkg.author
        
        return SkillManifest(
            name=pkg.name,
            description=pkg.description,
            path=str(pkg.skill_md_path),
            skill_type=SkillType.INSTRUCTIONAL,
            invocation_mode=SkillInvocationMode.BOTH,
            tags=[tag.strip() for tag in pkg.tags.split(',')] if isinstance(pkg.tags, str) else pkg.tags,
            keywords=pkg.keywords,
            when_to_use=pkg.when_to_use,
            do_not_use=pkg.do_not_use,
            examples=pkg.examples,
            workflow=pkg.workflow,
            output_format=pkg.output_format,
            output_style=None,
            scripts=pkg.scripts,
            templates=pkg.templates,
            references=pkg.references,
            author=pkg.author,
            version=version,
            category=pkg.category,
            environment=environment,
            user_id=user_id,
            username=username,
            submitted=submitted,
            submitted_at=submitted_at,
            published=published,
            published_at=published_at
        )
    
    @property
    def is_initialized(self) -> bool:
        """检查是否已初始化"""
        return self._initialized
    
    @property
    def count(self) -> int:
        """获取已加载的Skill数量"""
        return len(self._prod_packages)


# 全局单例实例
skill_registry = SkillRegistry()
