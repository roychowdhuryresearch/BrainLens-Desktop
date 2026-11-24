from runtime.core.agent_settings import get_agent_settings


def test_agent_service_token_requires_configuration(monkeypatch):
    monkeypatch.delenv("PYHFO_AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("AGENT_SERVICE_TOKEN", raising=False)

    settings = get_agent_settings()

    assert settings.service_token is None


def test_agent_service_token_uses_env_value(monkeypatch):
    monkeypatch.delenv("PYHFO_AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", "agent-token-123")

    settings = get_agent_settings()

    assert settings.service_token == "agent-token-123"


def test_agent_service_token_prefers_pyhfo_env_value(monkeypatch):
    monkeypatch.setenv("PYHFO_AGENT_SERVICE_TOKEN", "pyhfo-token-123")
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", "agent-token-123")

    settings = get_agent_settings()

    assert settings.service_token == "pyhfo-token-123"
