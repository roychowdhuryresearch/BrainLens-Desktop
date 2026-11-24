from typing import Any, Dict, Optional, Tuple

from runtime.context.models import ContextConfig
from runtime.core.config import config_manager, is_keyless_endpoint
from runtime.core.mcp_manager import get_mcp_manager
from runtime.services.agent_service import AgentService
from runtime.models.schemas import AIModelConfig, SystemConfig
from runtime.services.ai_service import AIServiceFactory


_SERVICE_CACHE: Dict[Tuple[Any, ...], AgentService] = {}


def build_context_config(config) -> ContextConfig:
    context_cfg = getattr(config, "context_config", None)
    if context_cfg:
        return ContextConfig(
            max_context_tokens=context_cfg.max_context_tokens,
            recent_keep_turns=context_cfg.recent_keep_turns,
            enable_context_summary=getattr(context_cfg, "enable_context_summary", True),
            enable_noise_filter=context_cfg.enable_noise_filter,
            summarizer_temperature=getattr(context_cfg, "summarizer_temperature", 0.3),
        )
    return ContextConfig()


def clear_agent_service_cache() -> None:
    """Test/config-reload helper: drop cached AgentService instances."""
    _SERVICE_CACHE.clear()


def _model_cache_key(config, active_model: str, ai_config) -> Tuple[Any, ...]:
    router = getattr(config, "router_model", None)
    return (
        id(config),
        active_model,
        getattr(ai_config, "provider", None),
        getattr(ai_config, "model", None),
        getattr(ai_config, "api_base", None),
        getattr(ai_config, "api_key", None),
        getattr(router, "provider", None),
        getattr(router, "model", None),
        getattr(router, "api_base", None),
        getattr(router, "api_key", None),
    )


def _select_model_config(
    config: SystemConfig, model_name: str, provider: Optional[str], api_base: Optional[str]
) -> AIModelConfig:
    """Select credentials from an operator-configured provider and endpoint."""
    profiles = config.ai_models or []
    named_profile = next((profile for profile in profiles if profile.model == model_name), None)
    if not provider and not api_base:
        if named_profile is None:
            raise ValueError(f"Model '{model_name}' not found in configuration")
        return named_profile

    # Use the trusted profile's URL and key together. A different path can identify a
    # different tenant on the same host. Only the terminal slash is interchangeable.
    target_base = (api_base or "").rstrip("/")
    matches = [
        profile for profile in profiles
        if (not provider or provider == profile.provider)
        and (not api_base or target_base == (profile.api_base or "").rstrip("/"))
    ]
    if matches:
        profile = next((item for item in matches if item.model == model_name), matches[0])
        return profile if profile.model == model_name else profile.model_copy(update={"model": model_name})

    # ConfigManager resolves process credentials into profiles. A request to an
    # unconfigured endpoint may use the non-secret self-hosted placeholder only.
    target_provider = provider or (named_profile.provider if named_profile else "")
    if not is_keyless_endpoint(target_provider, api_base):
        raise ValueError("Configure an API key for the requested model endpoint")
    return AIModelConfig(
        provider=target_provider or "openai_compatible",
        model=model_name,
        api_base=api_base,
        api_key="local",
    )


def get_agent_service(
    requested_model: Optional[str] = None,
    provider: Optional[str] = None,
    api_base: Optional[str] = None,
) -> AgentService:
    """The agent service for a turn, optionally on a model chosen per REQUEST.

    Switching model used to mean restarting this whole process, because the model was read once at
    boot -- half a minute of waiting to change one string. A caller can now name the provider,
    model and endpoint for its own turn; services are cached per configuration, so the second turn
    on a given model costs nothing, and two conversations can sit on different models at once.
    """
    config = config_manager.config
    active_model = requested_model if requested_model not in [None, "未指定", ""] else config.active_model
    if not active_model:
        raise ValueError("No active AI model configured")

    ai_config = _select_model_config(config, active_model, provider, api_base)

    cache_key = _model_cache_key(config, active_model, ai_config)
    cached = _SERVICE_CACHE.get(cache_key)
    if cached is not None:
        return cached

    ai_service = AIServiceFactory.create_service(ai_config)
    agent_service = AgentService(
        ai_service=ai_service,
        mcp_manager=get_mcp_manager(),
        router_model_config=config.router_model,
        ai_models=config.ai_models,
        bootstrap_skill_prefilter_config=config.bootstrap_skill_prefilter,
    )
    agent_service.init_context_manager(build_context_config(config))
    _SERVICE_CACHE[cache_key] = agent_service
    return agent_service
