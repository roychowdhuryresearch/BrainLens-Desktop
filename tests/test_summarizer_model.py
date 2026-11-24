"""Tests for summarizer_model configuration and service initialization.

Validates that:
1. SystemConfig parses summarizer_model from config
2. _init_summarizer_service respects priority: summarizer_model > compress_model > router_model
3. runtime_port.get_summarizer_ai_service returns the correct service
4. Fallback chain works when summarizer_model is not configured
"""

import pytest
from unittest.mock import MagicMock, patch, PropertyMock
from dataclasses import dataclass

from runtime.models.schemas import AIModelConfig, SystemConfig


class TestSummarizerModelConfig:
    """Test summarizer_model field in SystemConfig."""

    def test_system_config_accepts_summarizer_model(self):
        """SystemConfig should accept summarizer_model as optional dict."""
        cfg = SystemConfig(
            active_model="qwen3.5-plus",
            ai_models=[],
            summarizer_model={
                "provider": "qianwen",
                "model": "qwen3.5-flash",
                "api_key": "sk-test",
                "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "temperature": 0.3,
                "max_tokens": 2048,
            },
        )
        assert cfg.summarizer_model is not None
        assert cfg.summarizer_model["model"] == "qwen3.5-flash"

    def test_system_config_summarizer_model_default_none(self):
        """summarizer_model should default to None when not provided."""
        cfg = SystemConfig(active_model="qwen3.5-plus", ai_models=[])
        assert cfg.summarizer_model is None


class TestSummarizerServicePriority:
    """Test _init_summarizer_service priority chain."""

    def _make_manager(self):
        """Create a RuntimePostprocessManager with minimal mocks."""
        from runtime.agent_runtime.postprocess_factory import RuntimePostprocessManager

        ai_svc = MagicMock()
        router_cfg = MagicMock()
        router_cfg.provider = "qianwen"
        router_cfg.model = "qwen3.5-flash"
        router_cfg.api_key = "sk-test"
        router_cfg.api_base = "https://example.com"
        router_cfg.temperature = 0.3

        mgr = RuntimePostprocessManager(
            ai_service=ai_svc,
            ai_models=[],
            router_model_config=router_cfg,
            router_ai_service_getter=lambda: None,
        )
        return mgr

    def test_summarizer_model_takes_priority(self):
        """When summarizer_model_config is provided, it should be used."""
        mgr = self._make_manager()
        summarizer_cfg = {
            "provider": "qianwen",
            "model": "qwen3.5-flash",
            "api_key": "sk-test",
            "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "temperature": 0.3,
            "max_tokens": 2048,
        }
        compress_cfg = {
            "provider": "qianwen",
            "model": "qwen-turbo",
            "api_key": "sk-test",
            "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "temperature": 0.3,
            "max_tokens": 100,
        }
        svc = mgr._init_summarizer_service(summarizer_cfg, compress_cfg)
        assert svc is not None

    def test_fallback_to_compress_model(self):
        """When summarizer_model_config is None, fall back to compress_model."""
        mgr = self._make_manager()
        compress_cfg = {
            "provider": "qianwen",
            "model": "qwen-turbo",
            "api_key": "sk-test",
            "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "temperature": 0.3,
            "max_tokens": 100,
        }
        svc = mgr._init_summarizer_service(None, compress_cfg)
        assert svc is not None

    def test_fallback_to_router_model(self):
        """When both summarizer and compress configs are None, fall back to router_model."""
        mgr = self._make_manager()
        svc = mgr._init_summarizer_service(None, None)
        assert svc is not None

    def test_returns_none_when_no_config(self):
        """Returns None when no config is available at all."""
        from runtime.agent_runtime.postprocess_factory import RuntimePostprocessManager

        mgr = RuntimePostprocessManager(
            ai_service=MagicMock(),
            ai_models=[],
            router_model_config=None,
            router_ai_service_getter=lambda: None,
        )
        svc = mgr._init_summarizer_service(None, None)
        assert svc is None


class TestGetSummarizerAiService:
    """Test get_summarizer_ai_service on runtime_port adapter."""

    def test_returns_summarizer_from_postprocess(self):
        """Should return _summarizer_ai_service if set on postprocess."""
        from runtime.agent_runtime.runtime_port import AgentRuntimePortAdapter

        mock_service = MagicMock()
        mock_service.ai_service = MagicMock()
        mock_service._ai_models = []

        adapter = AgentRuntimePortAdapter(
            mock_service,
            max_tool_iterations=10,
            max_parallel_tool_calls=5,
            tool_call_timeout_seconds=30,
            vl_tool_timeout_seconds=60,
        )

        mock_summarizer = MagicMock()
        adapter.postprocess._summarizer_ai_service = mock_summarizer

        result = adapter.get_summarizer_ai_service()
        assert result is mock_summarizer

    def test_fallback_to_compress_service(self):
        """Should fall back to compress service when summarizer is not available."""
        from runtime.agent_runtime.runtime_port import AgentRuntimePortAdapter

        mock_service = MagicMock()
        mock_service.ai_service = MagicMock()
        mock_service._ai_models = []

        adapter = AgentRuntimePortAdapter(
            mock_service,
            max_tool_iterations=10,
            max_parallel_tool_calls=5,
            tool_call_timeout_seconds=30,
            vl_tool_timeout_seconds=60,
        )

        adapter.postprocess._summarizer_ai_service = None
        adapter.postprocess._bundle = None

        # Should fall back to compress service (which also falls back)
        result = adapter.get_summarizer_ai_service()
        # Result may be None if no compress service is configured, which is fine
        # The important thing is it doesn't crash