"""
技能提交状态管理

管理开发用户提交的测试技能状态

状态流转：
- 未提交：技能存在于测试环境，但未提交审核
- 已提交：技能已提交给管理员审核
- 已发布：技能已被管理员发布到正式环境
"""
import json
import os
from pathlib import Path
from typing import Dict, List, Optional
from datetime import datetime
import logging
from runtime.skills.skill_registry import _resolve_default_skills_base_dir, ensure_directory_exists

logger = logging.getLogger(__name__)

_data_dir = os.environ.get("IEEG_AGENT_DATA_DIR", "").strip()
_state_root = (
    Path(_data_dir).expanduser() if _data_dir
    else _resolve_default_skills_base_dir(Path(__file__).resolve().parents[2])
)
SUBMITTED_SKILLS_FILE = _state_root / "submitted_skills.json"


def load_submitted_skills() -> Dict:
    """
    加载已提交的技能状态
    
    Returns:
        提交状态字典 {user_id: {skill_name: {"status": str, "submitted_at": str, "published_at": str}}}
        status: "submitted" | "published"
    """
    if not SUBMITTED_SKILLS_FILE.exists():
        return {}
    
    try:
        with open(SUBMITTED_SKILLS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load submitted skills: {e}")
        return {}


def save_submitted_skills(data: Dict) -> None:
    """
    保存已提交的技能状态
    
    Args:
        data: 提交状态字典
    """
    if not ensure_directory_exists(SUBMITTED_SKILLS_FILE.parent):
        raise IOError(f"Failed to create directory for {SUBMITTED_SKILLS_FILE}")
    
    try:
        with open(SUBMITTED_SKILLS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        logger.info(f"Saved submitted skills to {SUBMITTED_SKILLS_FILE}")
    except PermissionError:
        logger.error(f"Permission denied when writing to {SUBMITTED_SKILLS_FILE}")
        raise
    except IOError as e:
        logger.error(f"IO error when writing to {SUBMITTED_SKILLS_FILE}: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to save submitted skills: {e}")
        raise


def submit_skill(user_id: str, skill_name: str) -> Dict:
    """
    提交技能审核
    
    Args:
        user_id: 用户ID
        skill_name: 技能名称
        
    Returns:
        更新后的提交状态
    """
    data = load_submitted_skills()
    
    if user_id not in data:
        data[user_id] = {}
    
    data[user_id][skill_name] = {
        "status": "submitted",
        "submitted_at": datetime.now().isoformat(),
        "published_at": None
    }
    
    save_submitted_skills(data)
    
    return data[user_id][skill_name]


def unsubmit_skill(user_id: str, skill_name: str) -> bool:
    """
    取消提交技能（开发用户取消提交）
    
    Args:
        user_id: 用户ID
        skill_name: 技能名称
        
    Returns:
        是否成功
    """
    data = load_submitted_skills()
    
    if user_id in data and skill_name in data[user_id]:
        del data[user_id][skill_name]
        save_submitted_skills(data)
        return True
    
    return False


def publish_skill_submission(user_id: str, skill_name: str) -> bool:
    """
    标记技能为已发布状态（管理员发布后调用）
    
    Args:
        user_id: 用户ID
        skill_name: 技能名称
        
    Returns:
        是否成功
    """
    data = load_submitted_skills()
    
    if user_id in data and skill_name in data[user_id]:
        data[user_id][skill_name]["status"] = "published"
        data[user_id][skill_name]["published_at"] = datetime.now().isoformat()
        save_submitted_skills(data)
        return True
    
    return False


def get_skill_submission_status(user_id: str, skill_name: str) -> Optional[Dict]:
    """
    获取技能的提交状态
    
    Args:
        user_id: 用户ID
        skill_name: 技能名称
        
    Returns:
        提交状态，如果未提交则返回None
        {"status": "submitted"|"published", "submitted_at": str, "published_at": str}
    """
    data = load_submitted_skills()
    
    if user_id in data and skill_name in data[user_id]:
        return data[user_id][skill_name]
    
    return None


def get_all_submitted_skills() -> List[Dict]:
    """
    获取所有已提交的技能列表（管理员用）
    只返回状态为"submitted"的技能（等待审核的）
    
    Returns:
        已提交的技能列表
    """
    data = load_submitted_skills()
    submitted_list = []
    
    for user_id, skills in data.items():
        for skill_name, status_info in skills.items():
            if status_info.get("status") == "submitted":
                submitted_list.append({
                    "user_id": user_id,
                    "skill_name": skill_name,
                    "submitted_at": status_info.get("submitted_at")
                })
    
    submitted_list.sort(key=lambda x: x.get("submitted_at", ""), reverse=True)
    
    return submitted_list


def remove_skill_submission(user_id: str, skill_name: str) -> bool:
    """
    移除技能提交记录（删除技能文件时调用）
    
    Args:
        user_id: 用户ID
        skill_name: 技能名称
        
    Returns:
        是否成功
    """
    return unsubmit_skill(user_id, skill_name)
