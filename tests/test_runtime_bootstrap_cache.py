from __future__ import annotations

from types import SimpleNamespace

import pytest

from runtime import runtime_bootstrap


def test_get_agent_service_reuses_service_for_same_model(monkeypatch):
    runtime_bootstrap.clear_agent_service_cache()
    config = SimpleNamespace(
        active_model="model-a",
        ai_models=[SimpleNamespace(model="model-a", provider="openai_compatible", api_base="https://model-a.example.org")],
        router_model=None,
        bootstrap_skill_prefilter=None,
        context_config=None,
    )
    created = []

    class FakeAgentService:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.context_config = None
            created.append(self)

        def init_context_manager(self, config):
            self.context_config = config

    monkeypatch.setattr(runtime_bootstrap, "config_manager", SimpleNamespace(config=config))
    monkeypatch.setattr(runtime_bootstrap.AIServiceFactory, "create_service", lambda ai_config: object())
    monkeypatch.setattr(runtime_bootstrap, "AgentService", FakeAgentService)

    first = runtime_bootstrap.get_agent_service()
    second = runtime_bootstrap.get_agent_service()

    assert first is second
    assert len(created) == 1
    assert first.context_config is not None
    runtime_bootstrap.clear_agent_service_cache()


def test_get_agent_service_cache_is_model_scoped(monkeypatch):
    runtime_bootstrap.clear_agent_service_cache()
    config = SimpleNamespace(
        active_model="model-a",
        ai_models=[
            SimpleNamespace(model="model-a", provider="openai_compatible", api_base="https://model-a.example.org"),
            SimpleNamespace(model="model-b", provider="openai_compatible", api_base="https://model-b.example.org"),
        ],
        router_model=None,
        bootstrap_skill_prefilter=None,
        context_config=None,
    )

    class FakeAgentService:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def init_context_manager(self, config):
            pass

    monkeypatch.setattr(runtime_bootstrap, "config_manager", SimpleNamespace(config=config))
    monkeypatch.setattr(runtime_bootstrap.AIServiceFactory, "create_service", lambda ai_config: object())
    monkeypatch.setattr(runtime_bootstrap, "AgentService", FakeAgentService)

    first = runtime_bootstrap.get_agent_service("model-a")
    second = runtime_bootstrap.get_agent_service("model-b")

    assert first is not second
    runtime_bootstrap.clear_agent_service_cache()


def test_unconfigured_remote_model_requires_a_key(monkeypatch):
    monkeypatch.delenv("IEEG_LLM_API_KEY", raising=False)
    config = SimpleNamespace(active_model="", ai_models=[])
    monkeypatch.setattr(runtime_bootstrap, "config_manager", SimpleNamespace(config=config))
    with pytest.raises(ValueError, match="API key"):
        runtime_bootstrap.get_agent_service(
            "research-model", provider="openai", api_base="https://models.example.org/v1"
        )


@pytest.fixture
def model_factory(monkeypatch):
    from runtime.models.schemas import AIModelConfig, SystemConfig

    profiles = [
        AIModelConfig(provider="openai", model="model-a", api_base="https://models.example.org/a", api_key="test-a"),
        AIModelConfig(provider="openai", model="model-b", api_base="https://models.example.org/b", api_key="test-b"),
    ]
    config = SystemConfig(active_model="model-a", ai_models=profiles)
    created = []

    def create(profile):
        created.append(profile)
        return profile

    runtime_bootstrap.clear_agent_service_cache()
    monkeypatch.setattr(runtime_bootstrap, "config_manager", SimpleNamespace(config=config))
    monkeypatch.setattr(runtime_bootstrap.AIServiceFactory, "create_service", create)
    monkeypatch.setattr(
        runtime_bootstrap, "AgentService", lambda **kwargs: SimpleNamespace(init_context_manager=lambda config: None)
    )
    yield created
    runtime_bootstrap.clear_agent_service_cache()


@pytest.mark.parametrize("name", ["model-a", "new-model"])
@pytest.mark.parametrize(
    ("provider", "base"),
    [
        ("openai", "https://another.example.org/a"),
        ("openai", "https://models.example.org/other"),
        ("deepseek", "https://models.example.org/a"),
    ],
)
def test_per_turn_endpoint_cannot_inherit_other_profile_or_unscoped_env_key(model_factory, monkeypatch, name, provider, base):
    monkeypatch.setenv("IEEG_LLM_API_KEY", "test-env-only")
    with pytest.raises(ValueError, match="API key"):
        runtime_bootstrap.get_agent_service(name, provider=provider, api_base=base)
    assert not model_factory


@pytest.mark.parametrize("name", ["model-a", "new-model"])
def test_per_turn_model_uses_target_profile_key(model_factory, name):
    service = runtime_bootstrap.get_agent_service(name, provider="openai", api_base="https://models.example.org/b/")
    profile, = model_factory
    assert (profile.model, profile.api_key, profile.api_base) == (name, "test-b", "https://models.example.org/b")
    assert runtime_bootstrap.get_agent_service(name, provider="openai", api_base=profile.api_base) is service


def test_per_turn_self_hosted_endpoint_uses_only_the_placeholder(model_factory):
    runtime_bootstrap.get_agent_service("model-a", provider="openai_compatible", api_base="https://self-hosted.example.org/v1")
    profile, = model_factory
    assert profile.api_key == "local"
