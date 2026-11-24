"""
UserContext - 用户上下文模型

贯穿 API → Agent → MCP 整个请求生命周期，
携带用户身份信息用于权限控制和审计日志。
"""
from pydantic import BaseModel, Field
from typing import List, Optional


class UserContext(BaseModel):
    """用户上下文 - 贯穿 API → Agent → MCP 整个请求生命周期"""
    user_id: str = Field(..., description="用户ID")
    username: str = Field(..., description="用户名")
    role: str = Field(..., description="用户角色: SUPER_ADMIN / ADMIN / DEVELOPER / USER")
    tenant_id: Optional[str] = Field(default=None, description="租户 ID")
    team_ids: List[str] = Field(default_factory=list, description="可见团队 ID 列表")
    permissions: List[str] = Field(default_factory=list, description="外围系统下发的权限")
    allowed_mcp_servers: Optional[List[str]] = Field(None, description="可用的MCP服务器白名单")

    def is_admin(self) -> bool:
        """是否为管理员（含超级管理员）"""
        return self.role in ('SUPER_ADMIN', 'ADMIN')

    def is_developer(self) -> bool:
        """是否为开发者"""
        return self.role == 'DEVELOPER'

    def is_super_admin(self) -> bool:
        """是否为超级管理员"""
        return self.role == 'SUPER_ADMIN'

    def to_http_headers(self) -> dict:
        """转换为 HTTP Header 字典，用于传递给远程 MCP 服务"""
        headers = {
            "X-User-Id": self.user_id,
            "X-User-Name": self.username,
            "X-User-Role": self.role,
        }
        if self.tenant_id:
            headers["X-Tenant-Id"] = self.tenant_id
        return headers

    @classmethod
    def from_current_user(cls, current_user: dict) -> Optional["UserContext"]:
        """从 get_current_user 返回的字典构建 UserContext

        Args:
            current_user: get_current_user() 返回的用户字典

        Returns:
            UserContext 实例，如果输入无效返回 None
        """
        if not current_user:
            return None
        user_id = current_user.get("id")
        username = current_user.get("username", "")
        role = current_user.get("role", "USER")
        if not user_id:
            return None
        allowed_mcp_servers = current_user.get("allowed_mcp_servers")
        return cls(
            user_id=str(user_id),
            username=username,
            role=role,
            tenant_id=current_user.get("tenant_id"),
            team_ids=list(current_user.get("team_ids") or []),
            permissions=list(current_user.get("permissions") or []),
            allowed_mcp_servers=allowed_mcp_servers,
        )
