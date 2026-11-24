from pathlib import Path

import httpx
import pytest

from runtime.core.config import ConfigManager, _apply_env_api_key, is_keyless_endpoint
from runtime.core.mcp_remote_client import RemoteMCPClient
from runtime.models.schemas import MCPServerConfig


def _write(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def test_agent_config_manager_expands_service_url_env_tokens(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    user_config_path = tmp_path / "user_config.yaml"

    service_url = "https://mcp.example.org/mcp"
    monkeypatch.setenv("MCP_GATEWAY_SERVICE_URL", service_url)
    monkeypatch.setenv("MCP_GATEWAY_ACCESS_TOKEN", "test-token")

    _write(
        config_path,
        "\n".join(
            [
                "mcp_servers:",
                "  - name: mcp_gateway",
                "    type: remote",
                "    enabled: true",
                "    service_url: ${MCP_GATEWAY_SERVICE_URL:http://127.0.0.1:8002/mcp}",
                "    access_token: ${MCP_GATEWAY_ACCESS_TOKEN}",
                "guarded_tool_policies: []",
                "",
            ]
        ),
    )
    _write(user_config_path, "active_model: ''\nai_models: []\n")

    manager = ConfigManager()
    manager.config_path = config_path
    manager.user_config_path = user_config_path

    config = manager.config

    assert config.mcp_servers is not None
    server = config.mcp_servers[0]
    assert server.service_url == service_url
    requests = []

    def mock_post(self, url, *, headers, json, **kwargs):
        requests.append((json["method"], url, headers.get("Authorization")))
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"tools": []}})

    monkeypatch.setattr(httpx.Client, "post", mock_post)
    client = RemoteMCPClient(server.name, manager._build_server_config(server))
    client.start()
    assert requests == [
        (method, service_url, "Bearer test-token")
        for method in ["initialize", "notifications/initialized", "tools/list"]
    ]


def test_remote_mcp_credentials_cannot_fall_back_to_anonymous():
    with pytest.raises(ValueError, match="require access_token"):
        MCPServerConfig(name="test", type="remote", app_id="example-app")


def test_init_mcp_servers_honors_env_allowlist(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    user_config_path = tmp_path / "user_config.yaml"
    _write(
        config_path,
        "\n".join(
            [
                "mcp_servers:",
                "  - name: ieeg_ui",
                "    type: local",
                "    enabled: true",
                "    command: python -m ui_mcp.mcp_server",
                "  - name: slow_docs",
                "    type: local",
                "    enabled: true",
                "    command: npx -y slow-docs",
                "guarded_tool_policies: []",
                "",
            ]
        ),
    )
    _write(user_config_path, "active_model: ''\nai_models: []\n")

    class FakeMCPManager:
        def __init__(self):
            self.added = []
            self.started = False

        def get_all_servers(self):
            return {}

        def remove_server(self, name):
            raise AssertionError(f"unexpected remove_server({name})")

        def add_server(self, name, config):
            self.added.append((name, config))

        def start_all_servers(self):
            self.started = True

    fake = FakeMCPManager()
    monkeypatch.setattr("runtime.core.config.mcp_manager", fake)
    monkeypatch.setenv("IEEG_AGENT_MCP_SERVERS", "ieeg_ui")

    manager = ConfigManager()
    manager.config_path = config_path
    manager.user_config_path = user_config_path
    manager.init_mcp_servers()

    assert [name for name, _ in fake.added] == ["ieeg_ui"]
    assert fake.started is True


def test_init_mcp_servers_adds_builtin_ieeg_ui_when_allowlisted(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.yaml"
    user_config_path = tmp_path / "user_config.yaml"
    _write(
        config_path,
        "\n".join(
            [
                "mcp_servers:",
                "  - name: slow_docs",
                "    type: local",
                "    enabled: true",
                "    command: npx -y slow-docs",
                "guarded_tool_policies: []",
                "",
            ]
        ),
    )
    _write(user_config_path, "active_model: ''\nai_models: []\n")

    class FakeMCPManager:
        def __init__(self):
            self.added = []

        def get_all_servers(self):
            return {}

        def remove_server(self, name):
            raise AssertionError(f"unexpected remove_server({name})")

        def add_server(self, name, config):
            self.added.append((name, config))

        def start_all_servers(self):
            pass

    fake = FakeMCPManager()
    monkeypatch.setattr("runtime.core.config.mcp_manager", fake)
    monkeypatch.setenv("IEEG_AGENT_MCP_SERVERS", "ieeg_ui")
    monkeypatch.setenv("IEEG_UI_BROKER_URL", "http://127.0.0.1:61234")

    manager = ConfigManager()
    manager.config_path = config_path
    manager.user_config_path = user_config_path
    manager.init_mcp_servers()

    assert [name for name, _ in fake.added] == ["ieeg_ui"]
    assert fake.added[0][1]["command"].endswith("-m ui_mcp.mcp_server")
    assert fake.added[0][1]["env"]["IEEG_UI_BROKER_URL"] == "http://127.0.0.1:61234"


def test_encrypted_desktop_profile_rebinds_model_provider_and_routing_helpers(monkeypatch) -> None:
    monkeypatch.setenv("IEEG_LLM_API_KEY", "deepseek-secret")
    monkeypatch.setenv("IEEG_LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("IEEG_LLM_API_BASE", "https://api.deepseek.com")
    monkeypatch.setenv("IEEG_LLM_MODEL", "deepseek-v4-flash")
    merged = {
        "active_model": "qwen3.5-plus",
        "ai_models": [
            {
                "provider": "qianwen",
                "model": "qwen3.5-plus",
                "api_key": "old-key",
                "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "temperature": 0.7,
                "max_tokens": 20000,
            }
        ],
        "router_model": {"provider": "qianwen", "model": "qwen3.5-flash", "api_key": "old-key", "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
        "compress_model": {"provider": "qianwen", "model": "qwen-turbo", "api_key": "old-key", "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
        "summarizer_model": {"provider": "qianwen", "model": "qwen3.5-flash", "api_key": "old-key", "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1"},
    }

    result = _apply_env_api_key(merged)

    assert result["active_model"] == "deepseek-v4-flash"
    assert result["ai_models"] == [
        {
            "provider": "deepseek",
            "model": "deepseek-v4-flash",
            "api_key": "deepseek-secret",
            "api_base": "https://api.deepseek.com",
            "temperature": 0.3,
            "max_tokens": 8000,
        }
    ]
    for key in ("router_model", "compress_model", "summarizer_model"):
        assert result[key]["provider"] == "deepseek"
        assert result[key]["model"] == "deepseek-v4-flash"
        assert result[key]["api_key"] == "deepseek-secret"
        assert result[key]["api_base"] == "https://api.deepseek.com"


def test_custom_desktop_profile_uses_openai_compatible_runtime_adapter(monkeypatch) -> None:
    monkeypatch.setenv("IEEG_LLM_API_KEY", "custom-secret")
    monkeypatch.setenv("IEEG_LLM_PROVIDER", "custom")
    monkeypatch.setenv("IEEG_LLM_API_BASE", "https://gateway.example/v1")
    monkeypatch.setenv("IEEG_LLM_MODEL", "custom-model")
    merged = {
        "active_model": "old-model",
        "ai_models": [],
        "router_model": {"provider": "qianwen", "model": "old-router"},
    }

    result = _apply_env_api_key(merged)

    assert result["active_model"] == "custom-model"
    assert result["ai_models"][0] == {
        "provider": "openai",
        "model": "custom-model",
        "api_key": "custom-secret",
        "api_base": "https://gateway.example/v1",
        "temperature": 0.3,
        "max_tokens": 8000,
    }
    assert result["router_model"] == {
        "provider": "openai",
        "model": "custom-model",
        "api_key": "custom-secret",
        "api_base": "https://gateway.example/v1",
    }


@pytest.mark.parametrize(
    ("provider", "base", "keyless"),
    [
        ("openai", "http://localhost:11434/v1", True),
        ("openai", "http://localhost.example.org/v1", False),
        ("openai_compatible", "https://self-hosted.example.org/v1", True),
        ("openai_compatible", "", False),
    ],
)
def test_keyless_placeholder_requires_a_local_or_self_hosted_endpoint(provider, base, keyless):
    assert is_keyless_endpoint(provider, base) is keyless


def test_default_configuration_stays_within_this_checkout(tmp_path, monkeypatch):
    repo = tmp_path / "project"
    (tmp_path / "backend").mkdir()
    (repo / "runtime" / "core").mkdir(parents=True)
    monkeypatch.setattr("runtime.core.config.__file__", str(repo / "runtime" / "core" / "config.py"))
    monkeypatch.delenv("IEEG_AGENT_CONFIG_DIR", raising=False)
    manager = ConfigManager()
    manager.load_config()
    assert manager.config_path == repo / "config.yaml"
    assert manager.user_config_path == repo / "user_config.yaml"
    assert manager.user_config_path.exists()
    assert not list((tmp_path / "backend").iterdir())
