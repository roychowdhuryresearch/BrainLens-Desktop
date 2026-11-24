"""
WebSocket 连接管理器

用于实时推送技能提交状态更新
"""
from fastapi import WebSocket
from typing import Dict, List, Set
import logging
import json

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        # 存储管理员连接: {websocket}
        self.admin_connections: Set[WebSocket] = set()
        # 存储用户连接: {user_id: {websocket}}
        self.user_connections: Dict[str, Set[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, user_id: str, is_admin: bool):
        await websocket.accept()
        if is_admin:
            self.admin_connections.add(websocket)
        else:
            if user_id not in self.user_connections:
                self.user_connections[user_id] = set()
            self.user_connections[user_id].add(websocket)

    def disconnect(self, websocket: WebSocket, user_id: str, is_admin: bool):
        if is_admin:
            self.admin_connections.discard(websocket)
        else:
            if user_id in self.user_connections:
                self.user_connections[user_id].discard(websocket)
                if not self.user_connections[user_id]:
                    del self.user_connections[user_id]

    async def broadcast_to_admins(self, message: dict):
        """广播消息给所有管理员"""
        if not self.admin_connections:
            return
        
        message_json = json.dumps(message, ensure_ascii=False)
        disconnected = set()
        
        for connection in self.admin_connections:
            try:
                await connection.send_text(message_json)
            except Exception as e:
                logger.error(f"Failed to send message to admin: {e}")
                disconnected.add(connection)
        
        # 清理断开的连接
        for conn in disconnected:
            self.admin_connections.discard(conn)

    async def send_to_user(self, user_id: str, message: dict):
        """发送消息给特定用户"""
        if user_id not in self.user_connections:
            return
        
        message_json = json.dumps(message, ensure_ascii=False)
        disconnected = set()
        
        for connection in self.user_connections[user_id]:
            try:
                await connection.send_text(message_json)
            except Exception as e:
                logger.error(f"Failed to send message to user {user_id}: {e}")
                disconnected.add(connection)
        
        # 清理断开的连接
        for conn in disconnected:
            self.user_connections[user_id].discard(conn)

    async def notify_skill_submitted(self, user_id: str, skill_name: str, username: str):
        """通知管理员有新技能提交"""
        await self.broadcast_to_admins({
            "type": "skill_submitted",
            "data": {
                "user_id": user_id,
                "skill_name": skill_name,
                "username": username
            }
        })
        logger.info(f"Notified admins about skill submission: {skill_name} from user {user_id}")

    async def notify_skill_unsubmitted(self, user_id: str, skill_name: str):
        """通知管理员技能取消提交"""
        await self.broadcast_to_admins({
            "type": "skill_unsubmitted",
            "data": {
                "user_id": user_id,
                "skill_name": skill_name
            }
        })
        logger.info(f"Notified admins about skill unsubmission: {skill_name} from user {user_id}")

    async def notify_skill_published(self, user_id: str, skill_name: str):
        """通知用户技能已发布"""
        # 向技能所属用户发送详细的发布通知
        await self.send_to_user(user_id, {
            "type": "skill_published",
            "data": {
                "skill_name": skill_name,
                "status": "published",
                "message": "您的技能已被管理员发布到正式环境"
            }
        })
        
        # 同时通知管理员刷新列表
        await self.broadcast_to_admins({
            "type": "skill_published",
            "data": {
                "user_id": user_id,
                "skill_name": skill_name,
                "status": "published"
            }
        })
        
        logger.info(f"Skill published: {skill_name} by user {user_id}")

    async def broadcast_to_all_users(self, message: dict):
        """广播消息给所有连接的用户"""
        if not self.user_connections:
            return
        
        message_json = json.dumps(message, ensure_ascii=False)
        disconnected = {}  # {user_id: [connections]}
        
        for user_id, connections in self.user_connections.items():
            for connection in connections:
                try:
                    await connection.send_text(message_json)
                except Exception as e:
                    logger.error(f"Failed to send message to user {user_id}: {e}")
                    if user_id not in disconnected:
                        disconnected[user_id] = []
                    disconnected[user_id].append(connection)
        
        # 清理断开的连接
        for user_id, conns in disconnected.items():
            for conn in conns:
                self.user_connections[user_id].discard(conn)
            if not self.user_connections[user_id]:
                del self.user_connections[user_id]

    async def notify_skill_deleted(self, user_id: str, skill_name: str):
        """通知技能被删除"""
        # 通知所有用户技能被删除
        await self.broadcast_to_all_users({
            "type": "skill_deleted",
            "data": {
                "user_id": user_id,
                "skill_name": skill_name
            }
        })
        # 同时通知管理员
        await self.broadcast_to_admins({
            "type": "skill_deleted",
            "data": {
                "user_id": user_id,
                "skill_name": skill_name
            }
        })
        logger.info(f"Notified about skill deletion: {skill_name}")


manager = ConnectionManager()
