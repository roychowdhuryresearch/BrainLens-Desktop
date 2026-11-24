from runtime.api.internal_agent import (
    AllowedMCP,
    AuthContext,
    InternalAgentChatRequest,
    InternalUserContext,
    RequestMetadata,
    _allowed_skill_names,
    _build_user_context,
    _load_allowed_skill_packages,
)


def build_payload():
    return {
        "request_id": "req-1",
        "conversation_id": "conv-1",
        "message": "hello",
        "knowledge_base_id": "kb-1",
        "skill_environment": "prod",
        "user_context": {
            "user_id": "u-1",
            "username": "alice",
            "role": "ADMIN",
            "allowed_mcp_servers": ["filesystem"],
        },
        "allowed_skills": [
            {"name": "knowledge_search"},
            {"name": "summary_writer"},
        ],
        "allowed_mcps": [{"name": "filesystem", "server_id": "filesystem", "capabilities": ["read"]}],
        "request_metadata": {"source": "backend-api", "request_id": "req-1", "trace_id": "req-1"},
    }


def test_internal_agent_chat_request_accepts_backend_contract_shape():
    request = InternalAgentChatRequest.model_validate(build_payload())

    assert request.user_context.user_id == "u-1"
    assert [item.name for item in request.allowed_skills] == ["knowledge_search", "summary_writer"]
    assert request.request_metadata.source == "backend-api"


def test_build_user_context_preserves_backend_default_mcp_semantics():
    user_context = InternalUserContext(
        user_id="u-1",
        username="alice",
        role="USER",
        allowed_mcp_servers=[],
    )

    resolved = _build_user_context(
        user_context,
        allowed_mcps=[],
        auth_context=AuthContext(),
        request_source="backend-api",
    )

    assert resolved.allowed_mcp_servers is None


def test_allowed_skill_names_contract_preserves_order_and_unrestricted_none():
    request = InternalAgentChatRequest.model_validate(build_payload())
    assert _allowed_skill_names(request) == ["knowledge_search", "summary_writer"]

    unrestricted = InternalAgentChatRequest(
        request_id="req-2",
        message="hello",
        skill_environment="prod",
        user_context=InternalUserContext(user_id="u-1", username="alice", role="USER"),
        request_metadata=RequestMetadata(source="backend-api"),
        allowed_skills=None,
    )
    assert _allowed_skill_names(unrestricted) is None


def test_build_user_context_carries_permissions_and_allowed_mcp_fallback():
    resolved = _build_user_context(
        InternalUserContext(
            user_id="u-1",
            username="alice",
            role="ADMIN",
            tenant_id="tenant-1",
            team_ids=["team-a", "team-b"],
            allowed_mcp_servers=None,
        ),
        allowed_mcps=[
            AllowedMCP(name="filesystem", server_id="filesystem", capabilities=["read"]),
            AllowedMCP(name="blank", server_id="", capabilities=[]),
        ],
        auth_context=AuthContext(permissions=["memory:write:team"], session_id="sess-1"),
        request_source="copilot-ui",
    )

    assert resolved.user_id == "u-1"
    assert resolved.tenant_id == "tenant-1"
    assert resolved.team_ids == ["team-a", "team-b"]
    assert resolved.permissions == ["memory:write:team"]
    assert resolved.allowed_mcp_servers == ["filesystem"]


def test_allowed_skill_names_strips_blank_entries():
    request = InternalAgentChatRequest.model_validate(
        {
            **build_payload(),
            "allowed_skills": [
                {"name": " knowledge_search "},
                {"name": "   "},
                {"name": "summary_writer"},
            ],
        }
    )

    assert _allowed_skill_names(request) == ["knowledge_search", "summary_writer"]


def test_load_allowed_skill_packages_falls_back_to_prod_and_deduplicates(monkeypatch):
    request = InternalAgentChatRequest.model_validate(
        {
            **build_payload(),
            "allowed_skills": [
                {"name": "knowledge_search", "config_ref": "broken-env"},
                {"name": "knowledge_search", "config_ref": "prod"},
                {"name": "summary_writer", "config_ref": "prod"},
            ],
        }
    )

    class FakePackage:
        def __init__(self, name):
            self.name = name

    class FakeRegistry:
        def __init__(self):
            self.is_initialized = False
            self.scanned_users = []
            self.requested_envs = []

        def scan_skills(self):
            self.is_initialized = True

        def scan_user_skills(self, user_id):
            self.scanned_users.append(user_id)

        def get_all_packages(self, *, user_id, user_role, skill_environment):
            self.requested_envs.append((user_id, user_role, skill_environment))
            if skill_environment == "prod":
                return [FakePackage("knowledge_search"), FakePackage("summary_writer")]
            return []

    fake_registry = FakeRegistry()
    monkeypatch.setattr("runtime.api.internal_agent.skill_registry", fake_registry)

    selected = _load_allowed_skill_packages(request)

    assert [pkg.name for pkg in selected] == ["knowledge_search", "summary_writer"]
    assert fake_registry.scanned_users == ["u-1"]
    assert fake_registry.requested_envs == [
        ("u-1", "ADMIN", "broken-env"),
        ("u-1", "ADMIN", "prod"),
    ]
