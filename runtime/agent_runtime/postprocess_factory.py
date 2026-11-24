import asyncio
import logging
import re
from dataclasses import dataclass
from typing import Any, Callable, List, Optional, Tuple

from runtime.agent_runtime.verifier import VerificationService
from runtime.core.config import config_manager
from runtime.models.schemas import AIModelConfig, RouterModelConfig, VerificationConfig
from runtime.prompts import render_prompt
from runtime.services.ai_service import AIService, AIServiceFactory

logger = logging.getLogger(__name__)

REASONING_COMPRESS_TIMEOUT = 15.0
REASONING_MAX_SUMMARY_LENGTH = 50
REASONING_SHORT_THRESHOLD = 100


@dataclass
class PostprocessBundle:
    verification_config: VerificationConfig
    compress_ai_service: Optional[AIService]
    summarizer_ai_service: Optional[AIService]
    verification_ai_service: AIService
    verification_model_name: Optional[str]
    verification_service: VerificationService


class RuntimePostprocessManager:
    def __init__(
        self,
        *,
        ai_service: AIService,
        ai_models: List[AIModelConfig],
        router_model_config: Optional[RouterModelConfig],
        router_ai_service_getter: Callable[[], Optional[AIService]],
        sync_bundle: Optional[Callable[[PostprocessBundle], None]] = None,
    ) -> None:
        self.ai_service = ai_service
        self.ai_models = list(ai_models or [])
        self.router_model_config = router_model_config
        self.router_ai_service_getter = router_ai_service_getter
        self.sync_bundle = sync_bundle

        self._compress_ai_service: Optional[AIService] = None
        self._summarizer_ai_service: Optional[AIService] = None
        self._verification_ai_service: Optional[AIService] = None
        self._verification_model_name: Optional[str] = None
        self._bundle: Optional[PostprocessBundle] = None

    def _init_compress_service(self, compress_model_config: Optional[dict]) -> Optional[AIService]:
        config_to_use = None
        if compress_model_config:
            config_to_use = compress_model_config
        elif self.router_model_config:
            config_to_use = {
                "provider": self.router_model_config.provider,
                "model": self.router_model_config.model,
                "api_key": self.router_model_config.api_key,
                "api_base": self.router_model_config.api_base,
                "temperature": self.router_model_config.temperature or 0.3,
                "max_tokens": 100,
            }

        if not config_to_use:
            return None
        try:
            model_config = AIModelConfig(
                provider=config_to_use.get("provider", "qianwen"),
                model=config_to_use.get("model", "qwen3.5-flash"),
                api_key=config_to_use.get("api_key", ""),
                api_base=config_to_use.get("api_base", ""),
                temperature=config_to_use.get("temperature", 0.3),
                max_tokens=config_to_use.get("max_tokens", 100),
            )
            return AIServiceFactory.create_service(model_config)
        except Exception as exc:
            logger.warning("[Agent] Failed to init compress service: %s", exc)
            return None

    def _init_summarizer_service(
        self,
        summarizer_model_config: Optional[dict],
        compress_model_config: Optional[dict],
    ) -> Optional[AIService]:
        """Initialise the summarizer AI service for tool-result summarization.

        Priority: summarizer_model > compress_model > router_model > None.
        """
        config_to_use = summarizer_model_config or compress_model_config
        if not config_to_use and self.router_model_config:
            config_to_use = {
                "provider": self.router_model_config.provider,
                "model": self.router_model_config.model,
                "api_key": self.router_model_config.api_key,
                "api_base": self.router_model_config.api_base,
                "temperature": self.router_model_config.temperature or 0.3,
                "max_tokens": 2048,
            }
        if not config_to_use:
            return None
        try:
            model_config = AIModelConfig(
                provider=config_to_use.get("provider", "qianwen"),
                model=config_to_use.get("model", "qwen3.5-flash"),
                api_key=config_to_use.get("api_key", ""),
                api_base=config_to_use.get("api_base", ""),
                temperature=config_to_use.get("temperature", 0.3),
                max_tokens=config_to_use.get("max_tokens", 2048),
            )
            svc = AIServiceFactory.create_service(model_config)
            logger.info("[Agent] Summarizer service initialized with model: %s", model_config.model)
            return svc
        except Exception as exc:
            logger.warning("[Agent] Failed to init summarizer service: %s", exc)
            return None

    def _get_postprocess_ai_service(self, prefer_router_model: bool) -> AIService:
        if prefer_router_model:
            try:
                router_ai = self.router_ai_service_getter()
                if router_ai:
                    return router_ai
            except Exception as exc:
                logger.warning("[Agent] Failed to get router model for postprocess: %s", exc)
        return self.ai_service

    def _find_qwen_turbo_model(self, compress_model_config: Optional[dict]) -> Optional[AIModelConfig]:
        for model_cfg in self.ai_models:
            model_name = (model_cfg.model or "").strip().lower()
            if model_name == "qwen-turbo" or model_name.startswith("qwen-turbo-"):
                return model_cfg

        if isinstance(compress_model_config, dict):
            model_name = str(compress_model_config.get("model", "")).strip().lower()
            if model_name == "qwen-turbo" or model_name.startswith("qwen-turbo-"):
                return AIModelConfig(
                    provider=str(compress_model_config.get("provider", "qianwen")),
                    model=str(compress_model_config.get("model", "qwen-turbo")),
                    api_key=str(compress_model_config.get("api_key", "")),
                    api_base=compress_model_config.get("api_base"),
                    temperature=float(compress_model_config.get("temperature", 0.3)),
                    max_tokens=int(compress_model_config.get("max_tokens", 1000)),
                )
        return None

    def _find_model(self, model_name: str, compress_model_config: Optional[dict]) -> Optional[AIModelConfig]:
        normalized = (model_name or "").strip().lower()
        if not normalized:
            return None
        for model_cfg in self.ai_models:
            cfg_model = (model_cfg.model or "").strip().lower()
            if cfg_model == normalized or cfg_model.startswith(f"{normalized}-"):
                return model_cfg
        if normalized == "qwen-turbo":
            return self._find_qwen_turbo_model(compress_model_config)
        return None

    def _get_fixed_verification_ai_service(
        self,
        *,
        fallback_ai: AIService,
        config: VerificationConfig,
        compress_model_config: Optional[dict],
    ) -> Tuple[AIService, Optional[str]]:
        verification_model_name = config.verification_model if config else "qwen-turbo"
        fallback_cfg = getattr(fallback_ai, "config", None)
        if self._verification_ai_service and self._verification_model_name == verification_model_name:
            return self._verification_ai_service, self._verification_model_name

        try:
            if not fallback_cfg:
                self._verification_ai_service = fallback_ai
                self._verification_model_name = getattr(fallback_cfg, "model", None)
                return self._verification_ai_service, self._verification_model_name

            verification_cfg = self._find_model(verification_model_name, compress_model_config)
            verification_model = AIModelConfig(
                provider=(verification_cfg.provider if verification_cfg else fallback_cfg.provider),
                model=(verification_cfg.model if verification_cfg else verification_model_name),
                api_key=(verification_cfg.api_key if verification_cfg else fallback_cfg.api_key),
                api_base=(verification_cfg.api_base if verification_cfg else fallback_cfg.api_base),
                temperature=0.1,
                max_tokens=2048,
            )
            self._verification_ai_service = AIServiceFactory.create_service(verification_model)
            self._verification_model_name = verification_model_name
            return self._verification_ai_service, self._verification_model_name
        except Exception as exc:
            logger.warning("[Agent] Failed to create verification model %s: %s", verification_model_name, exc)
            self._verification_ai_service = fallback_ai
            self._verification_model_name = getattr(fallback_cfg, "model", None)
            return self._verification_ai_service, self._verification_model_name

    def refresh(self) -> PostprocessBundle:
        cfg = None
        try:
            cfg = config_manager.load_config()
            verification_config = cfg.verification if cfg and cfg.verification else VerificationConfig()
            compress_model_config = cfg.compress_model if cfg else None
        except Exception as exc:
            logger.warning("[Agent] Failed to load postprocess config: %s", exc)
            verification_config = VerificationConfig()
            compress_model_config = None

        self._compress_ai_service = self._init_compress_service(compress_model_config)
        summarizer_model_config = getattr(cfg, "summarizer_model", None) if cfg else None
        self._summarizer_ai_service = self._init_summarizer_service(
            summarizer_model_config, compress_model_config,
        )

        verification_fallback_ai = self._get_postprocess_ai_service(verification_config.use_router_model)
        verification_ai, verification_model_name = self._get_fixed_verification_ai_service(
            fallback_ai=verification_fallback_ai,
            config=verification_config,
            compress_model_config=compress_model_config,
        )
        bundle = PostprocessBundle(
            verification_config=verification_config,
            compress_ai_service=self._compress_ai_service,
            summarizer_ai_service=self._summarizer_ai_service,
            verification_ai_service=verification_ai,
            verification_model_name=verification_model_name,
            verification_service=VerificationService(
                ai_service=verification_ai,
                config=verification_config,
            ),
        )
        self._bundle = bundle
        if self.sync_bundle:
            self.sync_bundle(bundle)
        return bundle

    @property
    def bundle(self) -> PostprocessBundle:
        if self._bundle is None:
            return self.refresh()
        return self._bundle

    @staticmethod
    def simplify_reasoning_by_rules(text: str, max_chars: int = REASONING_MAX_SUMMARY_LENGTH) -> str:
        if not text:
            return ""
        patterns = [
            (r"工具[：:]\s*\w+", ""),
            (r"function\s+\w+\s*\([^)]*\)", ""),
            (r"调用\s*`?\w+`?\s*工具", "调用工具"),
            (r"skill[：:]\s*\w+", ""),
            (r"```[\s\S]*?```", ""),
            (r"`[^`]+`", ""),
            (r"\[TOOL_CALL\][\s\S]*?\[/TOOL_CALL\]", ""),
        ]
        result = text
        for pattern, replacement in patterns:
            result = re.sub(pattern, replacement, result, flags=re.IGNORECASE)
        result = re.sub(r"\s+", " ", result).strip()
        if len(result) > max_chars:
            result = result[: max_chars - 3] + "..."
        return result or "正在思考..."

    async def summarize_reasoning(self, text: str) -> str:
        if not text or len(text) < REASONING_SHORT_THRESHOLD:
            return self.simplify_reasoning_by_rules(text)

        text_preview = text[:2000] if len(text) > 2000 else text
        prompt = render_prompt(
            "postprocess/reasoning_summary.md",
            max_chars=REASONING_MAX_SUMMARY_LENGTH,
            text_preview=text_preview,
        )

        try:
            ai_service = self.bundle.compress_ai_service or self.ai_service
            result = await asyncio.wait_for(
                ai_service.chat([{"role": "user", "content": prompt}]),
                timeout=REASONING_COMPRESS_TIMEOUT,
            )
            summary = result.get("content", "").strip()
            if len(summary) > REASONING_MAX_SUMMARY_LENGTH:
                summary = summary[: REASONING_MAX_SUMMARY_LENGTH - 3] + "..."
            return summary or self.simplify_reasoning_by_rules(text)
        except asyncio.TimeoutError:
            logger.warning("[Agent] Reasoning compression timeout, fallback to rules")
            return self.simplify_reasoning_by_rules(text)
        except Exception as exc:
            logger.warning("[Agent] Reasoning compression failed: %s", exc)
            return self.simplify_reasoning_by_rules(text)

    @staticmethod
    def should_skip_llm_reasoning_summary(
        *,
        step,
        step_tools: List[dict],
        final_content: str,
    ) -> bool:
        text = (final_content or "").strip()
        if not text:
            return False
        if step.step_type != "general" or not step.is_final_step:
            return False
        if step_tools:
            return False
        if not step.tools_disabled_by_user:
            return False
        return len(text) <= 64
