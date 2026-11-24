"""Router-model helper.

Lightweight resolver that owns the optional dedicated routing model configured
via ``RouterModelConfig``. Exposes:

- ``router_model_config``: the raw config (may be ``None``)
- ``get_router_ai_service()``: a lazily-constructed AI service backed by
  the router model, falling back to the main AI service when unavailable.

Previously this logic lived on ``SkillRouter``; extracted here so the runtime
can reuse the config/AI-service without keeping the legacy router class.
"""

from __future__ import annotations

import logging
from typing import List, Optional

from runtime.models.schemas import AIModelConfig, RouterModelConfig
from runtime.services.ai_service import AIService, AIServiceFactory


logger = logging.getLogger(__name__)


class RouterModelResolver:
    def __init__(
        self,
        *,
        ai_service: Optional[AIService] = None,
        router_model_config: Optional[RouterModelConfig] = None,
        ai_models: Optional[List[AIModelConfig]] = None,
    ) -> None:
        self.ai_service = ai_service
        self.router_model_config = router_model_config
        self.ai_models = ai_models or []
        self._router_ai_service: Optional[AIService] = None

    def get_router_ai_service(self) -> Optional[AIService]:
        if self._router_ai_service:
            return self._router_ai_service

        if self.router_model_config:
            try:
                config = self._build_router_model_config()
                if config:
                    self._router_ai_service = AIServiceFactory.create_service(config)
                    logger.info(
                        "[RouterModel] Using dedicated router model: %s (provider: %s)",
                        config.model,
                        config.provider,
                    )
                    return self._router_ai_service
            except Exception as exc:
                logger.warning(
                    "[RouterModel] Failed to create router AI service: %s, falling back to main ai_service",
                    exc,
                )

        return self.ai_service

    def _build_router_model_config(self) -> Optional[AIModelConfig]:
        if not self.router_model_config:
            return None

        config = self.router_model_config
        api_key = config.api_key
        api_base = config.api_base

        if not api_key and self.ai_models:
            for model_config in self.ai_models:
                if model_config.provider == config.provider:
                    api_key = model_config.api_key
                    api_base = api_base or model_config.api_base
                    break

        if not api_key or not str(api_key).strip():
            logger.warning(
                "[RouterModel] No valid api_key for router model (provider: %s)",
                config.provider,
            )
            return None

        return AIModelConfig(
            provider=config.provider,
            model=config.model,
            api_key=api_key,
            api_base=api_base,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
        )
