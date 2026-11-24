"""
配置管理器 - 支持双配置文件（系统配置 + 用户配置）

配置分离：
- config.yaml: 系统配置（只读，管理员维护）
  - context_config: 上下文管理配置
  - mcp_servers: MCP服务器配置
  
- user_config.yaml: 用户配置（前端可修改）
  - active_model: 当前激活的模型
  - ai_models: AI模型列表
"""
import os
import re
import shlex
from typing import Optional, List, Dict, Any
from pathlib import Path
from urllib.parse import urlsplit
import yaml
from runtime.models.schemas import SystemConfig, AIModelConfig, MCPServerConfig, ContextConfigModel, VLMModelConfig
from runtime.core.mcp_manager import mcp_manager
import logging

logger = logging.getLogger(__name__)

_ENV_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)(?::([^}]*))?\}")


def _configured_mcp_server_allowlist() -> Optional[set[str]]:
    """Return an env-configured MCP server allowlist, or None when unrestricted."""
    raw = (os.environ.get("IEEG_AGENT_MCP_SERVERS") or os.environ.get("AGENT_MCP_SERVERS") or "").strip()
    if not raw:
        return None
    if raw.lower() in {"none", "null", "[]"}:
        return set()
    return {item.strip() for item in raw.split(",") if item.strip()}


def _builtin_ieeg_ui_mcp_server_config() -> Dict[str, Any]:
    ui_mcp_executable = (os.environ.get("IEEG_UI_MCP_EXECUTABLE") or "").strip()
    if ui_mcp_executable:
        command = f"{shlex.quote(ui_mcp_executable)} --ui-mcp-server"
    else:
        python = shlex.quote(os.environ.get("PYHFO_BACKEND_PYTHON") or "python")
        command = f"{python} -m ui_mcp.mcp_server"
    return {
        "type": "local",
        "tool_prefix": "",
        "command": command,
        "env": {
            "IEEG_UI_BROKER_URL": os.environ.get("IEEG_UI_BROKER_URL", "http://127.0.0.1:8770"),
            "IEEG_UI_BROKER_TOKEN": os.environ.get("IEEG_UI_BROKER_TOKEN", ""),
            # The packaged MCP executable has its own parent-death guard. Point
            # it at this Agent process rather than the Electron ancestor.
            "IEEG_PARENT_PID": str(os.getpid()),
        },
        "wait_time": 1,
    }


def _expand_env_placeholders(value: Any) -> Any:
    """Recursively expand ${VAR} and ${VAR:default} placeholders in config data."""
    if isinstance(value, dict):
        return {key: _expand_env_placeholders(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_expand_env_placeholders(item) for item in value]
    if isinstance(value, str):
        def _replace(match: re.Match[str]) -> str:
            env_name = match.group(1)
            default = match.group(2) or ""
            # ${VAR:default} semantics: fall back to the default when VAR is unset OR set-but-empty
            # (os.environ.get only substitutes when the key is absent, so a present-but-empty var
            # like `export PYHFO_BACKEND_PYTHON=` would otherwise shadow the default with '').
            val = os.environ.get(env_name)
            return val if val not in (None, "") else default

        return _ENV_PATTERN.sub(_replace, value)
    return value


def is_keyless_endpoint(provider: str, api_base: str) -> bool:
    """Allow a client placeholder for explicit self-hosted or loopback endpoints."""
    try:
        endpoint = urlsplit(str(api_base or "").strip())
        host = endpoint.hostname
    except ValueError:
        return False
    if not host or endpoint.scheme not in ("http", "https"):
        return False
    return (
        str(provider or "").strip().lower() in ("local", "openai_compatible")
        or host in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
    )


def _apply_env_api_key(merged_config: dict) -> dict:
    """Apply the encrypted desktop LLM profile to the runtime configuration.

    A complete profile (provider + base + model + key) becomes the sole active chat model and also
    re-points optional routing helpers. This keeps credentials bound to their intended endpoint.
    Custom OpenAI-compatible endpoints use the existing OpenAI adapter at runtime.
    Key-only injection remains as a compatibility path for legacy desktop key storage.
    """
    api_key = (os.environ.get("IEEG_LLM_API_KEY") or "").strip()
    provider_env = (os.environ.get("IEEG_LLM_PROVIDER") or "").strip()
    api_base_env = (os.environ.get("IEEG_LLM_API_BASE") or "").strip()
    # A local server (Ollama, llama.cpp, LM Studio, vLLM) authenticates nothing, so requiring a key
    # here would make it unconfigurable. Its clients still want a non-empty bearer token, hence the
    # placeholder.
    if not api_key:
        if not is_keyless_endpoint(provider_env, api_base_env):
            return merged_config
        api_key = "local"
    api_base = (os.environ.get("IEEG_LLM_API_BASE") or "").strip()
    model = (os.environ.get("IEEG_LLM_MODEL") or "").strip()
    provider = (os.environ.get("IEEG_LLM_PROVIDER") or "").strip()
    runtime_provider = "openai" if provider == "custom" else provider
    models = merged_config.get("ai_models") or []
    if model and api_base:
        existing = next(
            (entry for entry in models if isinstance(entry, dict) and str(entry.get("model") or "") == model),
            {},
        )
        runtime_model = {
            **existing,
            "provider": runtime_provider or str(existing.get("provider") or "openai"),
            "model": model,
            "api_key": api_key,
            "api_base": api_base,
        }
        runtime_model.setdefault("temperature", 0.3)
        runtime_model.setdefault("max_tokens", 8000)
        models = [runtime_model]
        merged_config["ai_models"] = models
        merged_config["active_model"] = model
    else:
        for entry in models:
            if isinstance(entry, dict):
                entry["api_key"] = api_key
                if api_base:
                    entry["api_base"] = api_base
    # Keep router/compress/summarizer on the same credential boundary as the active profile.
    for routing_key in ("router_model", "compress_model", "summarizer_model"):
        sub = merged_config.get(routing_key)
        if isinstance(sub, dict):
            sub["api_key"] = api_key
            if api_base:
                sub["api_base"] = api_base
            if model and api_base:
                sub["model"] = model
                sub["provider"] = runtime_provider or str(sub.get("provider") or "openai")
    logger.info("[Config] Applied encrypted LLM profile to %d model(s)", len(models))
    return merged_config


class ConfigManager:
    """配置管理器 - 支持双配置文件"""
    
    def __init__(self, config_path: str = "config.yaml", user_config_path: str = "user_config.yaml"):
        repo_root = Path(__file__).resolve().parents[2]
        config_dir_override = (os.environ.get("IEEG_AGENT_CONFIG_DIR") or "").strip()
        config_base_dir = Path(config_dir_override).expanduser() if config_dir_override else repo_root
        config_base_dir.mkdir(parents=True, exist_ok=True)

        self.config_path = config_base_dir / config_path
        self.user_config_path = config_base_dir / user_config_path
        self._config: Optional[SystemConfig] = None
        self._user_config: Optional[dict] = None
        self._config_signature: Optional[tuple[Optional[int], Optional[int]]] = None
        logger.info(
            "[Config] Agent config source: config=%s user_config=%s",
            self.config_path,
            self.user_config_path,
        )

    def _get_config_signature(self) -> tuple[Optional[int], Optional[int]]:
        def _mtime_ns(path: Path) -> Optional[int]:
            try:
                return path.stat().st_mtime_ns
            except FileNotFoundError:
                return None

        return (_mtime_ns(self.config_path), _mtime_ns(self.user_config_path))
    
    def load_config(self) -> SystemConfig:
        """加载配置文件（合并系统配置 + 用户配置）
        
        系统配置 (config.yaml):
        - context_config: 上下文管理配置
        - mcp_servers: MCP服务器配置
        
        用户配置 (user_config.yaml):
        - active_model: 当前激活的模型
        - ai_models: AI模型列表
        """
        # 1. 加载系统配置
        system_config_data = {}
        if self.config_path.exists():
            try:
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    system_config_data = yaml.safe_load(f) or {}
                system_config_data = _expand_env_placeholders(system_config_data)
                logger.info(f"[Config] Loaded system config from {self.config_path}")
            except Exception as e:
                logger.error(f"[Config] Failed to load system config: {e}")
        else:
            logger.warning(f"[Config] System config not found: {self.config_path}")
        
        # 2. 加载用户配置
        user_config_data = {}
        if self.user_config_path.exists():
            try:
                with open(self.user_config_path, 'r', encoding='utf-8') as f:
                    user_config_data = yaml.safe_load(f) or {}
                user_config_data = _expand_env_placeholders(user_config_data)
                logger.info(f"[Config] Loaded user config from {self.user_config_path}")
            except Exception as e:
                logger.error(f"[Config] Failed to load user config: {e}")
        else:
            logger.warning(f"[Config] User config not found: {self.user_config_path}, creating default")
            self._create_default_user_config()
            user_config_data = {"active_model": "", "ai_models": []}
        
        # 3. 合并配置：用户配置覆盖系统配置
        merged_config = {}
        merged_config.update(system_config_data)  # 系统配置作为基础
        merged_config.update(user_config_data)    # 用户配置覆盖

        # 3b. BYO-key: a runtime-injected IEEG_LLM_API_KEY (e.g. from the desktop keychain) wins over
        # any api_key in the config files, so a shipped build never has to embed a real key.
        merged_config = _apply_env_api_key(merged_config)
        
        # 4. 构建最终配置对象
        try:
            self._config = SystemConfig(**merged_config)
            self._config_signature = self._get_config_signature()
            logger.info(f"[Config] Merged config: active_model={self._config.active_model}, "
                       f"ai_models={len(self._config.ai_models or [])}, "
                       f"mcp_servers={len(self._config.mcp_servers or [])}")
            return self._config
        except Exception as e:
            logger.error(f"[Config] Failed to create SystemConfig: {e}")
            return self._get_default_config()
    
    def _create_default_user_config(self) -> None:
        """创建默认用户配置文件"""
        default_user_config = {
            "active_model": "",
            "ai_models": []
        }
        try:
            with open(self.user_config_path, 'w', encoding='utf-8') as f:
                yaml.dump(default_user_config, f, allow_unicode=True, default_flow_style=False)
            logger.info(f"[Config] Created default user config at {self.user_config_path}")
        except Exception as e:
            logger.error(f"[Config] Failed to create default user config: {e}")
    
    def load_user_config(self) -> dict:
        """仅加载用户配置"""
        if self.user_config_path.exists():
            try:
                with open(self.user_config_path, 'r', encoding='utf-8') as f:
                    return yaml.safe_load(f) or {}
            except Exception as e:
                logger.error(f"[Config] Failed to load user config: {e}")
        return {}
    
    def save_user_config(self, active_model: Optional[str] = "", ai_models: Optional[List[AIModelConfig]] = None) -> None:
        """保存用户配置（只修改 user_config.yaml）
        
        Args:
            active_model: 当前激活的模型名
            ai_models: AI模型列表
        """
        user_config_data = {}
        
        # 读取现有用户配置
        if self.user_config_path.exists():
            try:
                with open(self.user_config_path, 'r', encoding='utf-8') as f:
                    user_config_data = yaml.safe_load(f) or {}
            except Exception as e:
                logger.error(f"[Config] Failed to read existing user config: {e}")
        
        # 更新指定字段
        if active_model is not None:
            user_config_data['active_model'] = active_model
        if ai_models is not None:
            user_config_data['ai_models'] = [
                model.model_dump(mode='json') if hasattr(model, 'model_dump') else model
                for model in ai_models
            ]
        
        # 保存到文件（保留格式和注释）
        try:
            with open(self.user_config_path, 'w', encoding='utf-8') as f:
                # 写入文件头注释
                f.write("# ===========================================================\n")
                f.write("# 用户配置文件 - 前端可修改\n")
                f.write("# ===========================================================\n")
                f.write("# 此文件存储用户可通过网页界面修改的配置项\n")
                f.write("# 系统配置（MCP服务器、上下文管理等）在 config.yaml 中维护\n\n")
                
                def _yaml_quote(value) -> str:
                    """将值安全引用，防止 YAML 特殊字符（:, #, \\n）破坏格式。"""
                    s = str(value) if value is not None else ""
                    if not s:
                        return "''"
                    # 包含 YAML 特殊字符时用单引号包裹
                    if any(ch in s for ch in (":", "#", "{", "}", "[", "]", ",", "&", "*", "?", "|", "-", "<", ">", "=", "!", "%", "@", "`", "\n", "'")):
                        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
                    return s

                # 写入 active_model
                f.write("# 当前使用的AI模型名称（对应 ai_models 中的 model 字段）\n")
                f.write(f"active_model: {_yaml_quote(user_config_data.get('active_model', ''))}\n\n")

                # 写入 ai_models
                f.write("# AI 模型配置列表\n")
                f.write("# 用户可以添加自己的模型和 API Key\n")
                f.write("ai_models:\n")

                for model in (user_config_data.get('ai_models') or []):
                    f.write(f"  # {model.get('provider', '')} - {model.get('model', '')}\n")
                    f.write(f"  - provider: {_yaml_quote(model.get('provider', ''))}\n")
                    f.write(f"    model: {_yaml_quote(model.get('model', ''))}\n")
                    f.write(f"    api_key: {_yaml_quote(model.get('api_key', ''))}\n")
                    f.write(f"    api_base: {_yaml_quote(model.get('api_base', ''))}\n")
                    f.write(f"    temperature: {model.get('temperature', 0.7)}\n")
                    f.write(f"    max_tokens: {model.get('max_tokens', 8000)}\n\n")
                
            logger.info(f"[Config] Saved user config to {self.user_config_path}")
            
            # 重新加载合并配置
            self._config = None
            self.load_config()
        except Exception as e:
            logger.error(f"[Config] Failed to save user config: {e}")
            raise
    
    def save_config(self, config: SystemConfig) -> None:
        """保存配置文件"""
        try:
            # 使用 mode='json' 将 Enum 转换为其值，避免 YAML Python 特定标签
            config_dict = config.model_dump(mode='json')
            
            with open(self.config_path, 'w', encoding='utf-8') as f:
                yaml.dump(config_dict, f, allow_unicode=True, default_flow_style=False)
            
            self._config = config
            logger.info("Configuration saved successfully")
            
        except Exception as e:
            logger.error(f"Failed to save config: {e}")
            raise
    
    def validate_config(self, config: SystemConfig) -> bool:
        """验证配置 - 只做基本格式验证，实际连接测试由test_connection处理"""
        try:
            # 验证AI模型配置格式
            if config.ai_models:
                for model in config.ai_models:
                    if not model.provider:
                        logger.warning("AI model provider is not specified")
                        return False
                    if not model.model:
                        logger.warning("AI model name is not specified")
                        return False
                    if not model.api_key and not is_keyless_endpoint(model.provider, model.api_base):
                        logger.warning("AI model API key is not specified")
                        return False
            
            logger.info("Configuration validation passed")
            return True
            
        except Exception as e:
            logger.error(f"Configuration validation failed: {e}")
            return False
    
    async def test_ai_connection(self, model_config: AIModelConfig) -> dict:
        """测试AI模型连接"""
        import httpx
        
        try:
            # 根据不同的提供商使用不同的API
            if model_config.provider == "zhipu":
                return await self._test_zhipu_connection(model_config)
            elif model_config.provider == "qianwen":
                return await self._test_qianwen_connection(model_config)
            elif model_config.provider == "openai":
                return await self._test_openai_connection(model_config)
            elif model_config.provider == "deepseek":
                return await self._test_deepseek_connection(model_config)
            elif model_config.provider in ("openai_compatible", "local"):
                return await self._test_openai_connection(model_config)
            else:
                return {"success": False, "message": f"不支持的提供商: {model_config.provider}"}
                
        except Exception as e:
            return {"success": False, "message": f"连接测试失败: {str(e)}"}
    
    async def _test_zhipu_connection(self, model_config: AIModelConfig) -> dict:
        """测试智谱AI连接"""
        import httpx
        
        try:
            api_base = model_config.api_base or "https://open.bigmodel.cn/api/paas/v4"
            url = f"{api_base.rstrip('/')}/chat/completions"
            
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {model_config.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": model_config.model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 10
                    },
                    timeout=15.0
                )
                
                if response.status_code == 200:
                    return {"success": True, "message": f"智谱AI连接成功！模型: {model_config.model}"}
                elif response.status_code == 401:
                    return {"success": False, "message": "API Key无效"}
                else:
                    return {"success": False, "message": f"连接失败，状态码: {response.status_code}"}
                    
        except httpx.TimeoutException:
            return {"success": False, "message": "连接超时"}
        except Exception as e:
            return {"success": False, "message": f"连接失败: {str(e)}"}
    
    async def _test_qianwen_connection(self, model_config: AIModelConfig) -> dict:
        """测试千问连接"""
        import httpx
        
        try:
            api_base = model_config.api_base or "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation"
            
            # 检测是否使用 OpenAI 兼容模式
            is_compatible_mode = "compatible-mode" in api_base
            
            async with httpx.AsyncClient(trust_env=False) as client:
                if is_compatible_mode:
                    # OpenAI 兼容模式
                    url = f"{api_base.rstrip('/')}/chat/completions"
                    response = await client.post(
                        url,
                        headers={
                            "Authorization": f"Bearer {model_config.api_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "model": model_config.model,
                            "messages": [{"role": "user", "content": "hi"}],
                            "max_tokens": 10
                        },
                        timeout=15.0
                    )
                else:
                    # 原生千问 API 格式
                    response = await client.post(
                        api_base,
                        headers={
                            "Authorization": f"Bearer {model_config.api_key}",
                            "Content-Type": "application/json"
                        },
                        json={
                            "model": model_config.model,
                            "input": {"messages": [{"role": "user", "content": "hi"}]}
                        },
                        timeout=15.0
                    )
                
                if response.status_code == 200:
                    return {"success": True, "message": f"千问连接成功！模型: {model_config.model}"}
                elif response.status_code == 401:
                    return {"success": False, "message": "API Key无效"}
                else:
                    error_detail = ""
                    try:
                        error_data = response.json()
                        if "error" in error_data:
                            error_detail = f" - {error_data['error'].get('message', '')}"
                    except:
                        pass
                    return {"success": False, "message": f"连接失败，状态码: {response.status_code}{error_detail}"}
                    
        except httpx.TimeoutException:
            return {"success": False, "message": "连接超时"}
        except Exception as e:
            return {"success": False, "message": f"连接失败: {str(e)}"}
    
    async def _test_openai_connection(self, model_config: AIModelConfig) -> dict:
        """测试OpenAI连接"""
        import httpx
        
        try:
            api_base = model_config.api_base or "https://api.openai.com/v1"
            url = f"{api_base.rstrip('/')}/chat/completions"
            
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {model_config.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": model_config.model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 10
                    },
                    timeout=15.0
                )
                
                if response.status_code == 200:
                    return {"success": True, "message": f"OpenAI连接成功！模型: {model_config.model}"}
                elif response.status_code == 401:
                    return {"success": False, "message": "API Key无效"}
                else:
                    return {"success": False, "message": f"连接失败，状态码: {response.status_code}"}
                    
        except httpx.TimeoutException:
            return {"success": False, "message": "连接超时"}
        except Exception as e:
            return {"success": False, "message": f"连接失败: {str(e)}"}
    
    async def _test_deepseek_connection(self, model_config: AIModelConfig) -> dict:
        """测试DeepSeek连接"""
        import httpx
        
        try:
            api_base = model_config.api_base or "https://api.deepseek.com"
            url = f"{api_base.rstrip('/')}/chat/completions"
            
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {model_config.api_key}",
                        "Content-Type": "application/json"
                    },
                    json={
                        "model": model_config.model,
                        "messages": [{"role": "user", "content": "hi"}],
                        "max_tokens": 10
                    },
                    timeout=15.0
                )
                
                if response.status_code == 200:
                    return {"success": True, "message": f"DeepSeek连接成功！模型: {model_config.model}"}
                elif response.status_code == 401:
                    return {"success": False, "message": "API Key无效"}
                else:
                    return {"success": False, "message": f"连接失败，状态码: {response.status_code}"}
                    
        except httpx.TimeoutException:
            return {"success": False, "message": "连接超时"}
        except Exception as e:
            return {"success": False, "message": f"连接失败: {str(e)}"}
    
    def init_mcp_servers(self) -> None:
        """初始化MCP服务器（从配置加载）"""
        current_signature = self._get_config_signature()
        if not self._config or self._config_signature != current_signature:
            if self._config and self._config_signature != current_signature:
                logger.info(
                    "[Config] Detected config file change, reloading: previous=%s current=%s",
                    self._config_signature,
                    current_signature,
                )
            self._config = self.load_config()
        
        # 清除现有服务器
        for server_name in list(mcp_manager.get_all_servers().keys()):
            mcp_manager.remove_server(server_name)
        
        # Electron sets IEEG_AGENT_MCP_SERVERS=ieeg_ui to load the UI connector.
        allowlist = _configured_mcp_server_allowlist()
        added_servers: set[str] = set()
        if self._config.mcp_servers:
            for server in self._config.mcp_servers:
                if not server.enabled:
                    continue
                if allowlist is not None and server.name not in allowlist:
                    logger.info("[Config] Skipping MCP server %s; not in IEEG_AGENT_MCP_SERVERS", server.name)
                    continue
                
                server_config = self._build_server_config(server)
                mcp_manager.add_server(server.name, server_config)
                added_servers.add(server.name)
                logger.info(f"Added MCP server: {server.name}")

        if allowlist is not None and "ieeg_ui" in allowlist and "ieeg_ui" not in added_servers:
            mcp_manager.add_server("ieeg_ui", _builtin_ieeg_ui_mcp_server_config())
            added_servers.add("ieeg_ui")
            logger.info("Added built-in ieeg_ui MCP server from IEEG_AGENT_MCP_SERVERS")

        if allowlist is not None:
            missing = sorted(allowlist - added_servers)
            if missing:
                logger.warning("[Config] IEEG_AGENT_MCP_SERVERS requested unknown/disabled server(s): %s", missing)
        
        # 启动所有服务器
        mcp_manager.start_all_servers()
    
    def _build_server_config(self, server: MCPServerConfig) -> Dict[str, Any]:
        """构建服务器配置字典"""
        config: Dict[str, Any] = {
            'type': server.type.value,
            'tool_prefix': server.tool_prefix or '',  # 工具名前缀
        }
        
        if server.type.value == 'local':
            # 本地进程型配置
            config['command'] = server.command or ''
            config['env'] = server.env or {}
            config['wait_time'] = server.wait_time or 10
        else:
            # 远程服务型配置
            config['service_url'] = server.service_url or ''
            if server.access_token is not None:
                config['auth'] = {'access_token': server.access_token}
            config['timeout'] = server.timeout or 30
        
        return config
    
    def get_mcp_manager(self):
        """获取MCP管理器实例"""
        return mcp_manager
    
    def _get_default_config(self) -> SystemConfig:
        """获取默认配置"""
        return SystemConfig(
            ai_models=[],
            active_model=""
        )
    
    @property
    def config(self) -> SystemConfig:
        """获取当前配置"""
        current_signature = self._get_config_signature()
        if not self._config or self._config_signature != current_signature:
            if self._config and self._config_signature != current_signature:
                logger.info(
                    "[Config] Detected config file change, reloading: previous=%s current=%s",
                    self._config_signature,
                    current_signature,
                )
            self._config = self.load_config()
        return self._config
    
    async def reload_config(self) -> SystemConfig:
        """重新加载配置"""
        self._config = None
        self._config_signature = None
        return self.load_config()
    
    def get_vlm_config(self) -> Optional[VLMModelConfig]:
        """获取 VLM 配置
        
        Returns:
            VLMModelConfig 如果配置存在且启用，否则 None
        """
        if not self._config:
            self._config = self.load_config()
        
        vlm_config = self._config.vlm_config
        if vlm_config and vlm_config.enabled:
            return vlm_config
        return None
    
    def is_vl_enabled(self) -> bool:
        """检查 VL 功能是否启用"""
        vlm_config = self.get_vlm_config()
        return vlm_config is not None


# 全局配置管理器实例
config_manager = ConfigManager()


def get_vlm_config() -> Optional[VLMModelConfig]:
    """获取 VLM 配置（全局函数）
    
    Returns:
        VLMModelConfig 如果配置存在且启用，否则 None
    """
    return config_manager.get_vlm_config()
