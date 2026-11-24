import json
import logging
from typing import Any, Dict, List, Optional

from runtime.agent_runtime.vl_tool import create_vl_tool, get_vl_tool_definition
from runtime.core.config import config_manager, get_vlm_config
from runtime.models.user_context import UserContext


logger = logging.getLogger(__name__)

HITL_TOOL_PREFIX = "hitl__"
UI_MCP_TOOL_NAMES = {"emit_ui_command", "get_ui_state", "wait_for_ui_command", "inspect_waveform"}
CANONICAL_UI_MCP_PROVIDER = "ieeg_ui"


class RuntimeInfraAdapter:
    """Infra owner for MCP/VL/tool loading concerns."""

    def __init__(self, service: Any) -> None:
        self._service = service
        self._cached_mcp_tools: Optional[List[Dict]] = None

    @property
    def mcp_manager(self) -> Any:
        return self._service.mcp_manager

    @property
    def config(self) -> Any:
        service_config = getattr(self._service, "config", None)
        if service_config is not None:
            return service_config
        return config_manager.config

    def resolve_real_tool_name(self, tool_name: str) -> str:
        normalized = str(tool_name or "").strip()
        if normalized.startswith(HITL_TOOL_PREFIX):
            return normalized[len(HITL_TOOL_PREFIX) :]
        return normalized

    def _tools_named(self, tool_name: str) -> List[Dict[str, Any]]:
        if not self.mcp_manager:
            return []
        all_tools_getter = getattr(self.mcp_manager, "get_all_tools", None)
        if callable(all_tools_getter):
            try:
                return [
                    dict(tool)
                    for tool in (all_tools_getter() or [])
                    if isinstance(tool, dict) and str(tool.get("name") or "").strip() == tool_name
                ]
            except Exception:
                logger.debug("[MCP] Failed enumerating providers for %s", tool_name, exc_info=True)
                return []
        getter = getattr(self.mcp_manager, "get_tool_by_name", None)
        if callable(getter):
            try:
                tool = getter(tool_name)
                return [dict(tool)] if isinstance(tool, dict) else []
            except Exception:
                logger.debug("[MCP] Failed get_tool_by_name(%s)", tool_name, exc_info=True)
        return []

    @staticmethod
    def _is_canonical_ui_tool(tool_name: str, tool: Dict[str, Any]) -> bool:
        exposed_name = str(tool.get("name") or "").strip()
        original_name = str(tool.get("original_name") or exposed_name).strip()
        provider = str(tool.get("mcp_server") or "").strip()
        prefix = str(tool.get("tool_prefix") or "").strip()
        return (
            exposed_name == tool_name
            and original_name == tool_name
            and provider == CANONICAL_UI_MCP_PROVIDER
            and not prefix
        )

    def _canonical_ui_tool(self, tool_name: str, *, required: bool = False) -> Optional[Dict[str, Any]]:
        matches = self._tools_named(tool_name)
        canonical = [tool for tool in matches if self._is_canonical_ui_tool(tool_name, tool)]
        collision = bool(matches) and (len(matches) != 1 or len(canonical) != 1)
        if collision:
            logger.error("[MCP] Reserved ieeg_ui tool provider collision for %s", tool_name)
            if required:
                raise RuntimeError("Reserved ieeg_ui tool provider collision; UI authority is unavailable")
            return None
        if len(canonical) == 1:
            return canonical[0]
        if required:
            raise RuntimeError(f"UI tool {tool_name!r} is only available from the canonical ieeg_ui MCP provider")
        return None

    def _validate_reserved_ui_bindings(self, tools: List[Dict[str, Any]]) -> None:
        for tool_name in {
            str(tool.get("name") or "").strip()
            for tool in tools
            if isinstance(tool, dict)
        } & UI_MCP_TOOL_NAMES:
            self._canonical_ui_tool(tool_name, required=True)

    async def _call_canonical_ui_tool(self, tool_name: str, args: Dict[str, Any]) -> Any:
        self._canonical_ui_tool(tool_name, required=True)
        call_args = dict(args or {})
        if tool_name == "emit_ui_command":
            # Authority scope is runtime-owned metadata, never model-owned tool input.  Replace any
            # attempted caller value with the current turn binding before crossing into the MCP
            # process; the broker independently validates it against the renderer state.
            from runtime.agent_runtime import ui_command_context

            call_args.pop("authority_scope", None)
            authority_scope = ui_command_context.current_authority_scope()
            if authority_scope is not None:
                call_args["authority_scope"] = authority_scope
            if not str(call_args.get("idempotency_key") or "").strip():
                idempotency_key = ui_command_context.command_idempotency_key(
                    str(call_args.get("type") or ""),
                    call_args.get("payload") if isinstance(call_args.get("payload"), dict) else {},
                )
                if idempotency_key:
                    call_args["idempotency_key"] = idempotency_key
        get_server = getattr(self.mcp_manager, "get_server", None)
        if callable(get_server):
            client = get_server(CANONICAL_UI_MCP_PROVIDER)
            if client is None or not bool(getattr(client, "has_tool", lambda _name: False)(tool_name)):
                raise RuntimeError("Canonical ieeg_ui provider does not expose the requested UI tool")
            return await client.call_tool(tool_name, call_args)
        # Compatibility for manager fakes/older adapters: enumeration above proved
        # there is exactly one provider and it is canonical before generic routing.
        return await self.mcp_manager.call_tool(tool_name, call_args)

    def tool_provider_identity(self, tool_name: str) -> str:
        normalized = self.resolve_real_tool_name(tool_name)
        if normalized in UI_MCP_TOOL_NAMES:
            return CANONICAL_UI_MCP_PROVIDER if self._canonical_ui_tool(normalized) else ""
        from runtime.agent_runtime.pyhfo_tools import TOOL_NAMES as _PYHFO_TOOL_NAMES
        if normalized in _PYHFO_TOOL_NAMES:
            return "builtin:pyhfo"
        if normalized == "vl_query":
            return "builtin:vl"
        matches = self._tools_named(normalized)
        providers = {
            str(tool.get("mcp_server") or "").strip()
            for tool in matches
            if str(tool.get("mcp_server") or "").strip()
        }
        return next(iter(providers)) if len(providers) == 1 else ""

    def _mcp_has_tool(self, tool_name: str) -> bool:
        if tool_name in UI_MCP_TOOL_NAMES:
            return self._canonical_ui_tool(tool_name) is not None
        if not self.mcp_manager:
            return False
        getter = getattr(self.mcp_manager, "get_tool_by_name", None)
        if callable(getter):
            try:
                return bool(getter(tool_name))
            except Exception:
                logger.debug("[MCP] Failed get_tool_by_name(%s)", tool_name, exc_info=True)
        all_tools_getter = getattr(self.mcp_manager, "get_all_tools", None)
        if not callable(all_tools_getter):
            return False
        try:
            return any((tool.get("name") if isinstance(tool, dict) else None) == tool_name for tool in all_tools_getter() or [])
        except Exception:
            logger.debug("[MCP] Failed checking MCP tool availability for %s", tool_name, exc_info=True)
            return False

    def _record_mcp_ui_command_result(self, tool_name: str, result: Any) -> Any:
        if tool_name != "emit_ui_command" or not isinstance(result, dict):
            return result
        command = result.get("command")
        if not isinstance(command, dict):
            return result
        try:
            from runtime.agent_runtime import ui_command_context

            ui_command_context.record_ui_command(command)
        except Exception:
            logger.debug("[MCP] Failed to mirror MCP UI command into response accumulator", exc_info=True)
        return result

    def get_guarded_tool_policy(self, tool_name: str, function_args: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        real_tool_name = self.resolve_real_tool_name(tool_name)
        config = self.config
        raw_policies = getattr(config, "guarded_tool_policies", None) if config else None
        for policy in raw_policies or []:
            policy_tool_name = str(getattr(policy, "tool_name", "") or "").strip()
            if policy_tool_name != real_tool_name:
                continue
            if not bool(getattr(policy, "requires_confirmation", True)):
                return None
            if hasattr(policy, "model_dump"):
                return policy.model_dump(mode="json")
            if hasattr(policy, "dict"):
                return policy.dict()
            if isinstance(policy, dict):
                return dict(policy)
            try:
                return dict(vars(policy))
            except TypeError:
                return None
        return None

    def get_hitl_tool_policy(self, tool_name: str, function_args: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
        return self.get_guarded_tool_policy(tool_name, function_args)

    async def execute_mcp_tool(
        self,
        tool_name: str,
        args: Dict,
        conversation_id: Optional[str] = None,
        user_role: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Any:
        tool_name = self.resolve_real_tool_name(tool_name)
        if tool_name == "vl_query":
            return await self.execute_vl_tool(args, conversation_id)

        if tool_name in UI_MCP_TOOL_NAMES and self._mcp_has_tool(tool_name):
            result = await self._call_canonical_ui_tool(tool_name, args)
            return self._record_mcp_ui_command_result(tool_name, result)
        if tool_name in UI_MCP_TOOL_NAMES:
            self._canonical_ui_tool(tool_name, required=True)
            raise RuntimeError(f"UI tool {tool_name!r} is only available through the ieeg_ui MCP server")

        from runtime.agent_runtime.pyhfo_tools import TOOL_NAMES as _PYHFO_TOOL_NAMES
        if tool_name in _PYHFO_TOOL_NAMES:
            from runtime.agent_runtime import pyhfo_tools as _pyhfo_tools
            # An attached desktop may own this capability and must get first
            # refusal inside pyhfo_tools.execute_sync. Headless calls retain the
            # cheap preflight denial here, before any worker thread or CLI work.
            if not _pyhfo_tools.desktop_session_active():
                authority_denial = _pyhfo_tools.get_direct_execution_denial(tool_name, args)
                if authority_denial is not None:
                    route = authority_denial.get("route")
                    if isinstance(route, dict):
                        route["available"] = self._mcp_has_tool("emit_ui_command")
                    return authority_denial
            result = await _pyhfo_tools.execute(tool_name, args, conversation_id=conversation_id)
            if isinstance(result, dict):
                route = result.get("route")
                if isinstance(route, dict):
                    route["available"] = self._mcp_has_tool("emit_ui_command")
            return result

        if not self.mcp_manager:
            raise RuntimeError("MCP manager not available. Please check MCP server configuration.")

        result = await self.mcp_manager.call_tool(tool_name, args)
        return self._record_mcp_ui_command_result(tool_name, result)

    async def execute_tool(
        self,
        *,
        tool_name: str,
        args: Dict[str, Any],
        conversation_id: Optional[str] = None,
        user_role: Optional[str] = None,
        user_id: Optional[str] = None,
    ) -> Any:
        return await self.execute_mcp_tool(
            tool_name,
            args,
            conversation_id,
            user_role=user_role,
            user_id=user_id,
        )

    async def execute_vl_tool(
        self,
        args: Dict,
        conversation_id: Optional[str] = None,
    ) -> Dict:
        from runtime.api.chat import get_image_store

        image_ref_id = args.get("image_ref")
        query = args.get("query")

        if not image_ref_id:
            return {"error": "缺少参数: image_ref"}
        if not query:
            return {"error": "缺少参数: query"}

        vlm_config = get_vlm_config()
        if not vlm_config or not vlm_config.enabled:
            return {"error": "VLM 服务未启用，请在配置中启用 VLM"}

        vl_tool = create_vl_tool(vlm_config)
        if not vl_tool:
            return {"error": "无法创建 VL 工具，请检查 VLM 配置"}

        conv_id = conversation_id or "default"
        image_store = get_image_store(conv_id)
        image_ref = image_store.get(image_ref_id)
        if not image_ref:
            available_refs = image_store.list_all()
            logger.info(
                "[Agent] VL image ref not found: ref=%s conv=%s available=%s",
                image_ref_id,
                conv_id,
                available_refs,
            )
            return {
                "error": "图片引用不存在或已过期"
            }

        try:
            vl_result = await vl_tool.execute(
                parameters={"image_ref": image_ref_id, "query": query},
                state=None,
                image_store=image_store,
            )
            if vl_result.get("success"):
                vlm_text = str(vl_result.get("result") or "")
                return {"result": vlm_text, "vlm_result": vlm_text}
            return {"error": vl_result.get("error", "VL 分析失败")}
        except Exception as exc:
            logger.error("[Agent] VL tool execution failed: %s", exc)
            return {"error": "VL 分析异常"}

    def _choose_document_search_tool(self) -> Optional[str]:
        if not self.mcp_manager:
            return None
        getter = getattr(self.mcp_manager, "get_all_tools", None)
        tools = []
        if callable(getter):
            try:
                tools = list(getter() or [])
            except Exception:
                logger.debug("[Agent] Failed to inspect MCP tools for document search", exc_info=True)
        names = [str(tool.get("name") or "").strip() for tool in tools if isinstance(tool, dict)]
        for preferred in ("document_search", "search_documents", "search"):
            if preferred in names:
                return preferred
        for name in names:
            lowered = name.lower()
            if "search" in lowered and not lowered.startswith("web_") and not lowered.startswith("bing_"):
                return name
        return None

    async def search_knowledge_base(
        self,
        query: str,
        repo_id: Optional[str] = None,
    ) -> List[Dict]:
        try:
            if not self.mcp_manager:
                logger.warning("[Agent] MCP manager not available for search")
                return []
            tool_name = self._choose_document_search_tool()
            if not tool_name:
                logger.warning("[Agent] No document search MCP tool is available")
                return []

            payload: Dict[str, Any] = {"query": query, "search_type": "doc"}
            if repo_id:
                payload["repo_id"] = repo_id
            results = await self.mcp_manager.call_tool(tool_name, payload)
            if isinstance(results, list):
                return results[:5]
            if isinstance(results, dict) and isinstance(results.get("data"), list):
                return results["data"][:5]
            return []
        except Exception as exc:
            logger.error("Failed to search knowledge base: %s", exc)
            return []

    async def format_context(self, search_results: List[Dict]) -> str:
        if not search_results:
            return ""

        context_parts = []
        for index, result in enumerate(search_results, 1):
            title = result.get("title", "无标题")
            snippet = result.get("snippet", result.get("body", ""))[:500]
            context_parts.append(f"{index}. {title}\n   {snippet}...")
        return "\n\n".join(context_parts)

    def extract_sources(self, search_results: List[Dict]) -> List[Dict]:
        sources = []
        for result in search_results:
            sources.append(
                {
                    "doc_id": result.get("id", ""),
                    "title": result.get("title", ""),
                    "snippet": result.get("snippet", result.get("body", ""))[:200],
                    "url": result.get("url", ""),
                }
            )
        return sources

    def get_mcp_tools(self, user_context: Optional[UserContext] = None) -> List[Dict]:
        if not self.mcp_manager:
            raise RuntimeError("MCP manager not available. Please check MCP server configuration.")

        if user_context:
            try:
                mcp_tools = self.mcp_manager.get_tools_for_user(user_context)
                if mcp_tools:
                    self._validate_reserved_ui_bindings(list(mcp_tools))
                    converted_tools = self.convert_mcp_tools_to_ai_format(mcp_tools)
                    logger.info(
                        "[MCP] Loaded %s tools for user '%s' (role=%s)",
                        len(converted_tools),
                        user_context.username,
                        user_context.role,
                    )
                    return list(converted_tools)
                logger.warning("[MCP] No tools available for user '%s'", user_context.username)
                return []
            except Exception as exc:
                logger.error("[MCP] Failed to get tools for user: %s", exc)
                raise RuntimeError(f"Failed to get tools for user: {exc}")

        if self._cached_mcp_tools is not None:
            logger.debug("[MCP] Using cached tools: %s tools", len(self._cached_mcp_tools))
            return list(self._cached_mcp_tools)

        try:
            mcp_tools = self.mcp_manager.get_all_tools()
            if not mcp_tools:
                logger.warning("[MCP] No tools returned from MCP servers")
                return []
            self._validate_reserved_ui_bindings(list(mcp_tools))
            converted_tools = self.convert_mcp_tools_to_ai_format(mcp_tools)
            self._cached_mcp_tools = converted_tools
            logger.info(
                "[MCP] Loaded %s tools from %s MCP servers",
                len(converted_tools),
                len(self.mcp_manager.get_all_servers()),
            )
            return list(converted_tools)
        except Exception as exc:
            logger.error("[MCP] Failed to get tools from MCP manager: %s", exc)
            raise RuntimeError(f"Failed to get tools from MCP manager: {exc}")

    def convert_mcp_tools_to_ai_format(self, mcp_tools: List[Dict]) -> List[Dict]:
        converted = []
        for tool in mcp_tools:
            name = tool.get("name", "")
            description = tool.get("description", "")
            input_schema = tool.get("inputSchema", {})
            ai_tool = {
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": input_schema,
                },
            }
            for metadata_key in ("original_name", "mcp_server", "tool_prefix"):
                if metadata_key in tool:
                    ai_tool["function"][metadata_key] = tool.get(metadata_key)
            converted.append(ai_tool)
            logger.debug("[MCP] Converted tool: %s -> %s", name, json.dumps(ai_tool, ensure_ascii=False))
        return converted

    def refresh_mcp_tools(self) -> None:
        self._cached_mcp_tools = None
        logger.info("[MCP] Tools cache cleared, will refresh on next call")

    async def resolve_tools_for_request(
        self,
        *,
        message: str,
        user_context: Optional[UserContext],
    ) -> List[Dict]:
        try:
            mcp_tools = list(self.get_mcp_tools(user_context=user_context))
        except RuntimeError as exc:
            if self.mcp_manager is not None:
                raise
            logger.info("[InfraAdapter] MCP manager unavailable; continuing with built-in tools only: %s", exc)
            mcp_tools = []
        all_tools = list(mcp_tools)
        # 始终添加 VL 工具（如果 VLM 已启用），确保图像识别能力可用
        vlm_config = get_vlm_config()
        if vlm_config and vlm_config.enabled:
            all_tools.append(get_vl_tool_definition())
        from runtime.agent_runtime import pyhfo_tools as _pyhfo_tools
        if _pyhfo_tools.is_available():
            all_tools.extend(_pyhfo_tools.get_tool_definitions())
        elif _pyhfo_tools.desktop_session_active():
            # No PyHFO CLI here (a packaged install ships a frozen backend, not a source tree), but a
            # desktop session is attached and performs these itself. Advertising them is what lets the
            # co-pilot act at all; without this it reports having no severity scoring, correctly.
            all_tools.extend(_pyhfo_tools.get_desktop_tool_definitions())
        # UI-control tools are intentionally MCP-only (ieeg_ui). Do not append built-in UI tools here.
        # 诊断日志：跟踪 MCP 权限过滤后的工具列表
        tool_names = [
            t.get("function", {}).get("name", "")
            for t in all_tools
            if t.get("function", {}).get("name")
        ]
        allowed_mcp = getattr(user_context, "allowed_mcp_servers", "MISSING") if user_context else None
        logger.info(
            "[InfraAdapter] resolve_tools_for_request: user=%s allowed_mcp=%s total=%d names=%s",
            getattr(user_context, "username", None) if user_context else None,
            allowed_mcp,
            len(all_tools),
            tool_names,
        )
        return list(all_tools)
