import hmac
import json
import logging
import re
import uuid
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from runtime.agent_runtime.stream_contract import (
    AGENT_CONTRACT_VERSION,
    StreamContractProjector,
    format_sse_event,
)
from runtime.agent_runtime.user_input import submit_user_input
from runtime.api.chat import process_uploaded_attachments
from runtime.core.agent_settings import get_agent_settings
from runtime.models.schemas import AttachmentData, ChatResponse
from runtime.models.user_context import UserContext
from runtime.runtime_bootstrap import get_agent_service
from runtime.services.agent_service import set_cancel_flag
from runtime.skills.skill_registry import skill_registry


router = APIRouter(prefix="/internal/agent/v1", tags=["internal-agent"])
logger = logging.getLogger(__name__)

_INTERNAL_ERROR_MESSAGE = "Internal server error"
_CONTRACT_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
_PAYLOAD_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_OPERATION_TRANSITION_ERROR = "operation_scope_or_state_invalid"
_OPERATION_PAYLOAD_ERROR = "operation_payload_invalid"


class AllowedSkill(BaseModel):
    name: str
    version: Optional[str] = None
    config_ref: Optional[str] = None


class SkillRecommendationCandidate(BaseModel):
    name: str
    score: float = 0.0
    reason: Optional[str] = None
    description: Optional[str] = None
    when_to_use: Optional[str] = None
    matched_keywords: List[str] = Field(default_factory=list)
    matched_tags: List[str] = Field(default_factory=list)


class AllowedMCP(BaseModel):
    name: str
    server_id: str
    capabilities: List[str] = Field(default_factory=list)


class AuthContext(BaseModel):
    permissions: List[str] = Field(default_factory=list)
    session_id: Optional[str] = None


class RequestMetadata(BaseModel):
    source: str = "backend"
    trace_id: Optional[str] = None
    client_version: Optional[str] = None
    request_id: Optional[str] = None


class InternalUserContext(BaseModel):
    user_id: str
    username: str
    role: str
    tenant_id: str = "default"
    team_ids: List[str] = Field(default_factory=list)
    # None: follow system default; []: explicitly disable all MCP servers.
    allowed_mcp_servers: Optional[List[str]] = None


class InternalAgentChatRequest(BaseModel):
    contract_version: str = AGENT_CONTRACT_VERSION
    # The model for THIS turn (declared once, below with the other model fields). Absent, the process
    # default is used, so older callers are unaffected.
    provider: Optional[str] = None
    api_base: Optional[str] = None
    # The desktop's PyHFO session, per turn. Sent by the request rather than read from this process's
    # environment because the runtime is spawned before the backend exists and so never inherits it.
    session_url: Optional[str] = None
    session_token: Optional[str] = None
    request_id: str
    conversation_id: Optional[str] = None
    message: str
    response_language: Optional[Literal["en-US", "zh-CN"]] = None
    knowledge_base_id: Optional[str] = None
    use_search: bool = True
    active_skill: Optional[str] = None
    model: Optional[str] = None
    skill_environment: str
    response_mode: str = "default"
    user_context: InternalUserContext
    auth_context: AuthContext = Field(default_factory=AuthContext)
    # None: unrestricted; []: no skill allowed; [..]: explicit whitelist
    allowed_skills: Optional[List[AllowedSkill]] = None
    skill_recommendation_candidates: List[SkillRecommendationCandidate] = Field(default_factory=list)
    allowed_mcps: List[AllowedMCP] = Field(default_factory=list)
    request_metadata: RequestMetadata = Field(default_factory=RequestMetadata)
    attachments: Optional[List[AttachmentData]] = None
    # Deprecated compatibility field. Desktop UI state must be read via the ieeg_ui MCP get_ui_state
    # tool; new desktop clients report state to the UI broker and do not send this field.
    ui_state: Optional[dict] = None
    # The EDF the desktop currently has loaded. Used as the default input_path for pyhfo_* tools
    # when the model omits it, so the agent operates on the actually-loaded recording.
    recording_path: Optional[str] = None
    # Opaque renderer/broker revision of the workspace state used for this turn.
    state_revision: Optional[str] = None

    @field_validator("contract_version")
    @classmethod
    def validate_contract_version(cls, value: str) -> str:
        if value != AGENT_CONTRACT_VERSION:
            raise ValueError(f"contract_version must be {AGENT_CONTRACT_VERSION}")
        return value

    @field_validator("request_id")
    @classmethod
    def validate_request_id(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if not _CONTRACT_IDENTIFIER.fullmatch(normalized):
            raise ValueError("request_id is not a valid contract identifier")
        return normalized

    @field_validator("conversation_id")
    @classmethod
    def validate_conversation_id(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        if not _CONTRACT_IDENTIFIER.fullmatch(normalized):
            raise ValueError("conversation_id is not a valid contract identifier")
        return normalized

    @field_validator("state_revision")
    @classmethod
    def validate_agent_state_revision(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value or "").strip()
        if not _CONTRACT_IDENTIFIER.fullmatch(normalized):
            raise ValueError("state_revision is not a valid contract identifier")
        return normalized

    @field_validator("message")
    @classmethod
    def validate_message(cls, value: str) -> str:
        if not str(value or "").strip():
            raise ValueError("message must be non-blank")
        return value


_DERIVED_CONVERSATION_NAMESPACE = uuid.UUID("83d4ff42-52e7-50e7-8674-80a29128d59d")


def _resolve_internal_conversation_id(req: InternalAgentChatRequest) -> str:
    """Resolve one isolated scope for every accepted API turn.

    Legacy callers may omit ``conversation_id``.  Retrying the same request for
    the same actor must resolve to the same scope, while unrelated requests must
    never fall into a shared global conversation.
    """
    explicit = str(req.conversation_id or "").strip()
    if explicit:
        return explicit
    user_id = str(req.user_context.user_id or "").strip()
    request_id = str(req.request_id or "").strip()
    if not user_id or not request_id:
        return f"conv_ephemeral_{uuid.uuid4().hex}"
    seed = f"{user_id}\x1f{request_id}"
    return f"conv_{uuid.uuid5(_DERIVED_CONVERSATION_NAMESPACE, seed).hex}"


def _resolve_response_language(req: InternalAgentChatRequest) -> Literal["en-US", "zh-CN"]:
    """Return the explicit language or a deterministic legacy-client adapter.

    The canonical wire request carries ``response_language``.  During the
    desktop migration, omitted values are inferred from the current request
    only (never from shared or previous-conversation state).
    """
    if req.response_language in {"en-US", "zh-CN"}:
        return req.response_language
    if re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", req.message or ""):
        return "zh-CN"
    return "en-US"


class InternalToolListRequest(BaseModel):
    user_context: InternalUserContext
    auth_context: AuthContext = Field(default_factory=AuthContext)
    allowed_mcps: List[AllowedMCP] = Field(default_factory=list)
    request_metadata: RequestMetadata = Field(default_factory=RequestMetadata)


class UserInputRequest(BaseModel):
    conversation_id: str
    input_id: str
    value: Any
    user_id: str


def _format_hitl_history_message(
    submission_value: Any,
    input_metadata: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    payload = submission_value if isinstance(submission_value, dict) else {}
    decision = str(payload.get("decision") or "approved").strip().lower()
    real_tool_name = str(
        (input_metadata or {}).get("real_tool_name")
        or (input_metadata or {}).get("tool_name")
        or payload.get("tool_name")
        or "tool"
    ).strip()
    if decision != "approved":
        return f"我已拒绝执行 {real_tool_name}。"

    final_args = payload.get("final_args")
    if not isinstance(final_args, dict):
        final_args = {}
    serialized_args = json.dumps(final_args, ensure_ascii=False, indent=2) if final_args else "{}"
    return f"我已确认执行 {real_tool_name}，最终参数如下：\n{serialized_args}"


def _validate_internal_token(authorization: Optional[str] = Header(default=None)) -> None:
    token = get_agent_settings().service_token
    if not token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="internal authentication is not configured",
        )
    if not hmac.compare_digest((authorization or "").encode(), f"Bearer {token}".encode()):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid internal token")


def _validate_agent_contract_version(
    x_contract_version: Optional[str] = Header(default=None, alias="X-Contract-Version"),
) -> None:
    provided = str(x_contract_version or "")
    if not hmac.compare_digest(provided, AGENT_CONTRACT_VERSION):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="unsupported agent contract version",
            headers={"X-Contract-Version": AGENT_CONTRACT_VERSION},
        )


def _build_user_context(
    payload: InternalUserContext,
    allowed_mcps: List[AllowedMCP],
    auth_context: Optional[AuthContext] = None,
    request_source: Optional[str] = None,
) -> UserContext:
    if payload.allowed_mcp_servers is not None:
        allowed_servers: Optional[List[str]] = payload.allowed_mcp_servers
        if (
            request_source == "backend-api"
            and allowed_servers == []
            and not allowed_mcps
        ):
            # Legacy backend may collapse None to [] during merge-conflict windows.
            allowed_servers = None
    elif allowed_mcps:
        allowed_servers = [item.server_id for item in allowed_mcps if item.server_id]
    else:
        allowed_servers = None

    return UserContext(
        user_id=payload.user_id,
        username=payload.username,
        role=payload.role,
        tenant_id=payload.tenant_id,
        team_ids=list(payload.team_ids or []),
        permissions=list((auth_context.permissions if auth_context else []) or []),
        allowed_mcp_servers=allowed_servers,
    )


def _resolve_recording_path(payload: InternalAgentChatRequest) -> Optional[str]:
    """The recording the desktop has loaded. UI state fallback is intentionally not used."""
    explicit = (payload.recording_path or "").strip()
    if explicit:
        return explicit
    return None


def _allowed_skill_names(payload: InternalAgentChatRequest) -> Optional[List[str]]:
    if payload.allowed_skills is None:
        return None
    names = []
    for item in payload.allowed_skills:
        name = (item.name or "").strip()
        if name:
            names.append(name)
    return names


def _load_allowed_skill_packages(payload: InternalAgentChatRequest):
    if not payload.allowed_skills:
        return None

    if not skill_registry.is_initialized:
        skill_registry.scan_skills()

    user_id = payload.user_context.user_id
    user_role = payload.user_context.role
    skill_registry.scan_user_skills(user_id)

    env_cache: Dict[str, Dict[str, Any]] = {}
    selected = []
    seen = set()

    for item in payload.allowed_skills:
        name = item.name.strip() if item.name else ""
        if not name:
            continue
        env = (item.config_ref or payload.skill_environment or "prod").strip()
        if env not in env_cache:
            packages = skill_registry.get_all_packages(
                user_id=user_id,
                user_role=user_role,
                skill_environment=env,
            )
            env_cache[env] = {pkg.name: pkg for pkg in packages}
        pkg = env_cache[env].get(name)
        if pkg is None and env != "prod":
            # Fallback for malformed config_ref values or legacy callers.
            fallback_packages = env_cache.setdefault(
                "prod",
                {pkg.name: pkg for pkg in skill_registry.get_all_packages(
                    user_id=user_id,
                    user_role=user_role,
                    skill_environment="prod",
                )},
            )
            pkg = fallback_packages.get(name)
        if pkg and pkg.name not in seen:
            seen.add(pkg.name)
            selected.append(pkg)

    return selected or None


@router.get("/health")
async def health(_: None = Depends(_validate_internal_token)) -> Dict[str, str]:
    return {"status": "healthy"}


@router.get("/ready")
async def ready(_: None = Depends(_validate_internal_token)) -> Dict[str, str]:
    return {"status": "ready"}


@router.get("/version")
async def version(_: None = Depends(_validate_internal_token)) -> Dict[str, str]:
    return {"version": "1.0.0", "contract_version": AGENT_CONTRACT_VERSION}


@router.post("/tools")
async def list_tools(
    req: InternalToolListRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    user_context = _build_user_context(
        req.user_context,
        req.allowed_mcps,
        req.auth_context,
        req.request_metadata.source,
    )
    from runtime.core.mcp_manager import get_mcp_manager
    mcp_manager = get_mcp_manager()
    tools = list(mcp_manager.get_tools_for_user(user_context))
    from runtime.agent_runtime import pyhfo_tools
    if pyhfo_tools.is_available():
        for tool in pyhfo_tools.get_tool_definitions():
            function = tool.get("function", {})
            tools.append({
                "name": function.get("name", ""),
                "description": function.get("description", ""),
                "inputSchema": function.get("parameters", {}),
                "mcp_server": "builtin_pyhfo",
            })
    return {
        "status": "success",
        "tools": tools,
        "total": len(tools),
        "servers": mcp_manager.list_available_servers(),
    }


@router.post("/chat")
async def chat(
    req: InternalAgentChatRequest,
    _: None = Depends(_validate_internal_token),
    __: None = Depends(_validate_agent_contract_version),
) -> Dict[str, Any]:
    conversation_id = _resolve_internal_conversation_id(req)
    response_language = _resolve_response_language(req)
    user_context = _build_user_context(
        req.user_context,
        req.allowed_mcps,
        req.auth_context,
        req.request_metadata.source,
    )
    logger.info(
        "[InternalAgent] /chat conv_id=%s source=%s user=%s incoming_allowed=%s incoming_mcps=%s resolved_allowed=%s",
        conversation_id,
        req.request_metadata.source,
        req.user_context.username,
        req.user_context.allowed_mcp_servers,
        [item.server_id for item in req.allowed_mcps],
        user_context.allowed_mcp_servers,
    )
    attachment_summary, attachment_urls = process_uploaded_attachments(
        conversation_id,
        req.attachments,
        message_id=req.request_id,
        user_id=req.user_context.user_id,
    )
    message = req.message
    if attachment_summary:
        message = f"{message}\n\n{attachment_summary}"
    try:
        # Bind the desktop session HERE, at request ingress, not later during execution: the tool
        # list is resolved before the turn runs, and whether a desktop session is attached decides
        # whether the workspace-owned capabilities are offered at all.
        from runtime.agent_runtime import pyhfo_tools as _pyhfo_tools
        _pyhfo_tools.begin_desktop_session(req.session_url, req.session_token)
        _pyhfo_tools.begin_active_recording(_resolve_recording_path(req))
        agent_service = get_agent_service(req.model, req.provider, req.api_base)
        skill_packages_override = _load_allowed_skill_packages(req)
        response: ChatResponse = await agent_service.process_message(
            message=message,
            request_id=req.request_id,
            conversation_id=conversation_id,
            knowledge_base_id=req.knowledge_base_id,
            use_search=req.use_search,
            active_skill_name=req.active_skill,
            user_id=req.user_context.user_id,
            user_role=req.user_context.role,
            skill_environment=req.skill_environment,
            response_mode=req.response_mode,
            response_language=response_language,
            user_context=user_context,
            recording_path=_resolve_recording_path(req),
            session_url=req.session_url,
            session_token=req.session_token,
            state_revision=req.state_revision,
            skill_packages_override=skill_packages_override,
            allowed_skill_names=_allowed_skill_names(req),
            skill_recommendation_candidates=[
                item.model_dump(mode="json")
                for item in req.skill_recommendation_candidates
            ],
        )
    except Exception as exc:
        logger.error("Internal agent chat failed type=%s", exc.__class__.__name__)
        raise HTTPException(status_code=500, detail=_INTERNAL_ERROR_MESSAGE) from exc

    result = {
        "contract_version": AGENT_CONTRACT_VERSION,
        "request_id": req.request_id,
        "conversation_id": conversation_id,
        "message_id": response.message_id,
        "outcome": "completed",
        "status": "completed",
        "content": response.content,
        "response_language": response_language,
        "action_receipts": response.action_receipts,
        "sources": response.sources,
        "model_used": response.model_used,
        "tokens_used": response.tokens_used,
        "active_skill": response.active_skill,
        "used_skill": response.active_skill,
        "used_mcps": [item.server_id for item in req.allowed_mcps],
        "ui_commands": getattr(response, "ui_commands", []) or [],
        "finish_reason": "completed",
        "metrics": {},
    }
    if response.research_output is not None:
        result["research_output"] = response.research_output
    if attachment_urls:
        result["image_urls"] = attachment_urls
        result["attachment_urls"] = attachment_urls
    return result


@router.post("/chat/stream")
async def chat_stream(
    req: InternalAgentChatRequest,
    request: Request,
    _: None = Depends(_validate_internal_token),
    __: None = Depends(_validate_agent_contract_version),
):
    conversation_id = _resolve_internal_conversation_id(req)
    response_language = _resolve_response_language(req)
    user_context = _build_user_context(
        req.user_context,
        req.allowed_mcps,
        req.auth_context,
        req.request_metadata.source,
    )
    logger.info(
        "[InternalAgent] /chat/stream conv_id=%s source=%s user=%s incoming_allowed=%s incoming_mcps=%s resolved_allowed=%s",
        conversation_id,
        req.request_metadata.source,
        req.user_context.username,
        req.user_context.allowed_mcp_servers,
        [item.server_id for item in req.allowed_mcps],
        user_context.allowed_mcp_servers,
    )
    attachment_summary, attachment_urls = process_uploaded_attachments(
        conversation_id,
        req.attachments,
        message_id=req.request_id,
        user_id=req.user_context.user_id,
    )
    message = req.message
    if attachment_summary:
        message = f"{message}\n\n{attachment_summary}"

    async def generate():
        # Bind the desktop session HERE, at request ingress, not later during execution: the tool
        # list is resolved before the turn runs, and whether a desktop session is attached decides
        # whether the workspace-owned capabilities are offered at all.
        from runtime.agent_runtime import pyhfo_tools as _pyhfo_tools
        _pyhfo_tools.begin_desktop_session(req.session_url, req.session_token)
        _pyhfo_tools.begin_active_recording(_resolve_recording_path(req))
        agent_service = get_agent_service(req.model, req.provider, req.api_base)
        skill_packages_override = _load_allowed_skill_packages(req)
        projector = StreamContractProjector(
            request_id=req.request_id,
            conversation_id=conversation_id,
            response_language=response_language,
            actor_user_id=req.user_context.user_id,
            state_revision=req.state_revision,
        )
        # 手动持有 upstream async generator：旧实现在 `is_disconnected()` 直接
        # `return` 会让 outer gen 停止迭代，但 inner `stream_message` 已经开着
        # LLM / MCP 流，不会收到 aclose。agent 端继续烧 token + 占内存直到
        # 自然结束。这里在 finally 里显式 aclose，保证客户端一断开 upstream
        # 立即收到 GeneratorExit 并清理。
        upstream = agent_service.stream_message(
            message=message,
            request_id=req.request_id,
            conversation_id=conversation_id,
            knowledge_base_id=req.knowledge_base_id,
            active_skill_name=req.active_skill,
            user_id=req.user_context.user_id,
            user_role=req.user_context.role,
            skill_environment=req.skill_environment,
            response_mode=req.response_mode,
            response_language=response_language,
            user_context=user_context,
            recording_path=_resolve_recording_path(req),
            session_url=req.session_url,
            session_token=req.session_token,
            state_revision=req.state_revision,
            skill_packages_override=skill_packages_override,
            allowed_skill_names=_allowed_skill_names(req),
            skill_recommendation_candidates=[
                item.model_dump(mode="json")
                for item in req.skill_recommendation_candidates
            ],
        )
        try:
            # Send persisted attachment URLs first so frontend can keep history lightweight.
            if attachment_urls:
                for envelope in projector.project(
                    {
                        "event": "image_urls",
                        "data": {
                            "image_urls": attachment_urls,
                            "attachment_urls": attachment_urls,
                        },
                    }
                ):
                    yield format_sse_event(envelope)
            async for event in upstream:
                if await request.is_disconnected():
                    return
                for envelope in projector.project(event):
                    yield format_sse_event(envelope)
                if projector.is_terminal:
                    break
            if not projector.is_terminal:
                for envelope in projector.finish():
                    yield format_sse_event(envelope)
        except Exception as exc:
            logger.error("Internal agent stream failed type=%s", exc.__class__.__name__)
            for envelope in projector.fail(code="internal_error"):
                yield format_sse_event(envelope)
        finally:
            aclose = getattr(upstream, "aclose", None)
            if callable(aclose):
                try:
                    await aclose()
                except Exception:
                    pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
            "X-Contract-Version": AGENT_CONTRACT_VERSION,
        },
    )


@router.post("/chat/cancel/{conversation_id}")
async def cancel(
    conversation_id: str,
    _: None = Depends(_validate_internal_token),
    __: None = Depends(_validate_agent_contract_version),
) -> Dict[str, str]:
    set_cancel_flag(conversation_id)
    # 同时取消该会话下挂起的 post-turn 任务（save_state / summary / memory）。
    # 用户点"停止"语义上放弃整个 turn，部分副作用落盘会让下一轮读到不一致状态。
    from runtime.agent_runtime import post_turn

    cancelled = post_turn.cancel_for_conversation(conversation_id)
    return {
        "status": "success",
        "message": "Request cancelled",
        "post_turn_cancelled": str(cancelled),
    }


@router.get("/images/{bucket}/{path:path}")
async def serve_image(
    bucket: str,
    path: str,
    _: None = Depends(_validate_internal_token),
):
    """Serve image bytes from storage by bucket and object key."""
    from fastapi.responses import Response

    from runtime.services.storage_service import get_storage_service

    storage = get_storage_service()
    data = storage.get_object(bucket, path)
    if data is None:
        raise HTTPException(status_code=404, detail="Image not found")

    ext = path.rsplit(".", 1)[-1].lower()
    ct = {"png": "image/png", "webp": "image/webp", "gif": "image/gif"}.get(ext, "image/jpeg")
    return Response(
        content=data,
        media_type=ct,
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.post("/chat/user-input")
async def user_input(
    req: UserInputRequest,
    _: None = Depends(_validate_internal_token),
    __: None = Depends(_validate_agent_contract_version),
) -> Dict[str, Any]:
    result = submit_user_input(
        conversation_id=req.conversation_id,
        user_id=req.user_id,
        input_id=req.input_id,
        value=req.value,
    )
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Failed to submit user input"))
    agent_service = get_agent_service()
    history_message = _format_hitl_history_message(
        req.value,
        result.get("input_metadata") if isinstance(result.get("input_metadata"), dict) else None,
    )
    history_recorded = False
    history_service = getattr(agent_service, "history_service", None)
    ensure_history_service = getattr(agent_service, "ensure_history_service", None)
    if callable(ensure_history_service):
        ensure_history_service()
        history_service = getattr(agent_service, "history_service", history_service)
    if history_service and history_message:
        try:
            history_service.add_message(
                conversation_id=req.conversation_id,
                role="user",
                content=history_message,
                name="",
                tool_call_id="",
                sources=[],
            )
            history_recorded = True
        except Exception as exc:
            logger.warning("[Agent] Failed to record HITL user-input history message: %s", exc)
    memory_action = None
    if isinstance(result.get("memory_writeback"), dict):
        memory_action = await agent_service.handle_hitl_memory_writeback(
            conversation_id=req.conversation_id,
            user_id=req.user_id,
            submission_value=req.value,
            memory_writeback=result.get("memory_writeback") or {},
        )
    return {
        "status": "success",
        "message": "User input submitted",
        "memory_action": memory_action,
        "history_recorded": history_recorded,
    }


# ===========================================================================
# Feedback — 对话质量反馈
# ===========================================================================

class FeedbackRequest(BaseModel):
    conversation_id: str
    user_id: str
    rating: str  # positive / negative / correction
    turn_id: Optional[str] = None
    message_id: Optional[str] = None
    comment: str = ""
    correction: str = ""
    tags: List[str] = Field(default_factory=list)


@router.post("/feedback")
async def submit_feedback(
    req: FeedbackRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.feedback_service import get_feedback_service
    svc = get_feedback_service()
    entry = svc.submit_feedback(
        conversation_id=req.conversation_id,
        user_id=req.user_id,
        rating=req.rating,
        turn_id=req.turn_id,
        message_id=req.message_id,
        comment=req.comment,
        correction=req.correction,
        tags=req.tags,
    )
    return {"status": "success", "feedback_id": entry.feedback_id}


class FeedbackListRequest(BaseModel):
    conversation_id: Optional[str] = None
    user_id: Optional[str] = None
    rating: Optional[str] = None
    limit: int = 50


@router.post("/feedback/list")
async def list_feedback(
    req: FeedbackListRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.feedback_service import get_feedback_service
    svc = get_feedback_service()
    entries = svc.list_feedback(
        conversation_id=req.conversation_id,
        user_id=req.user_id,
        rating=req.rating,
        limit=req.limit,
    )
    return {"status": "success", "items": [e.to_dict() for e in entries], "total": len(entries)}


# ===========================================================================
# Execution Replay — 执行链路回放
# ===========================================================================

class ReplayRequest(BaseModel):
    conversation_id: str
    turn_id: str


@router.post("/debug/replay")
async def replay_turn(
    req: ReplayRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.execution_replay_service import get_execution_replay_service
    svc = get_execution_replay_service()
    trace = await svc.get_turn_trace(req.conversation_id, req.turn_id)
    return {"status": "success", **trace}


class TimelineRequest(BaseModel):
    conversation_id: str


@router.post("/debug/timeline")
async def conversation_timeline(
    req: TimelineRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.execution_replay_service import get_execution_replay_service
    svc = get_execution_replay_service()
    timeline = await svc.get_conversation_timeline(req.conversation_id)
    return {"status": "success", "conversation_id": req.conversation_id, "turns": timeline}


# ===========================================================================
# Skill Sandbox — Skill 沙箱测试
# ===========================================================================

class SandboxRequest(BaseModel):
    skill_name: str
    test_message: str = ""


@router.post("/debug/sandbox")
async def sandbox_test(
    req: SandboxRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.skill_sandbox_service import get_skill_sandbox_service
    svc = get_skill_sandbox_service()
    result = svc.dry_run(req.skill_name, test_message=req.test_message)
    return {"status": "success", **result.to_dict()}


@router.get("/debug/sandbox/skills")
async def list_testable_skills(
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.skill_sandbox_service import get_skill_sandbox_service
    svc = get_skill_sandbox_service()
    skills = svc.list_testable_skills()
    return {"status": "success", "skills": skills, "total": len(skills)}


# ===========================================================================
# Memory Audit endpoints 已下线 —— durable memory 权威存储已迁到 backend
# 任何 audit 能力请通过 backend `/internal/api/memories/*` 完成
# ===========================================================================


# ===========================================================================
# Conversation Summary — 用户可见对话摘要
# ===========================================================================

class SummaryRequest(BaseModel):
    conversation_id: str
    max_messages: int = 50


@router.post("/chat/summary")
async def conversation_summary(
    req: SummaryRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.conversation_summary_service import get_conversation_summary_service
    svc = get_conversation_summary_service()
    result = await svc.generate_user_summary(req.conversation_id, max_messages=req.max_messages)
    return {"status": "success", **result}


# ===========================================================================
# Plan Preview — 执行计划预览
# ===========================================================================

class PlanPreviewRequest(BaseModel):
    message: str
    user_id: Optional[str] = None
    skill_environment: str = "prod"


@router.post("/chat/plan-preview")
async def plan_preview(
    req: PlanPreviewRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.plan_preview_service import get_plan_preview_service
    svc = get_plan_preview_service()
    result = svc.preview_plan(
        req.message,
        user_id=req.user_id,
        skill_environment=req.skill_environment,
    )
    return {"status": "success", **result}


# ===========================================================================
# Conversation Resume — 对话中断恢复
# ===========================================================================

class ResumeCheckRequest(BaseModel):
    conversation_id: str


@router.post("/chat/resume-check")
async def resume_check(
    req: ResumeCheckRequest,
    _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    """检测对话是否有未完成的内容需要恢复。

    前端在用户回到对话时调用，根据返回的 should_prompt 和 user_hint
    决定是否显示恢复提示。
    """
    from runtime.services.conversation_resume_service import get_conversation_resume_service
    from runtime.agent_runtime.conversation_state import ConversationRuntimeState

    svc = get_conversation_resume_service()

    # 加载对话运行时状态
    try:
        agent_service = get_agent_service()
        conv_state = None
        if hasattr(agent_service, "load_conversation_runtime_state"):
            conv_state = await agent_service.load_conversation_runtime_state(req.conversation_id)
        elif hasattr(agent_service, "history_service") and agent_service.history_service:
            state_data = agent_service.history_service.get_conversation_runtime_state(req.conversation_id)
            if state_data:
                conv_state = ConversationRuntimeState.from_dict(req.conversation_id, state_data)
    except Exception as exc:
        logger.warning("[Resume] Failed to load state for %s: %s", req.conversation_id, exc)
        conv_state = None

    result = svc.check_resume(
        req.conversation_id,
        conv_state,
        is_first_message_in_session=True,
    )
    return {"status": "success", **result.to_dict()}


# ===========================================================================
# Operation Safety — 操作确认与回滚
# ===========================================================================

class OperationCreateRequest(BaseModel):
    # Added in v1 as optional wire fields.  Legacy callers are assigned an
    # isolated server scope and receive it in the create response.
    request_id: Optional[str] = None
    session_id: Optional[str] = None
    conversation_id: str
    user_id: str
    operation_type: str
    target: str
    params: Dict[str, Any] = Field(default_factory=dict)
    description: str = ""
    state_revision: Optional[str] = None

    @field_validator(
        "conversation_id",
        "user_id",
        "operation_type",
        "target",
    )
    @classmethod
    def validate_actor_scope(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if (
            not normalized
            or len(normalized) > 256
            or any(ord(char) < 32 for char in normalized)
        ):
            raise ValueError("operation scope fields must be valid and non-blank")
        return normalized

    @field_validator("request_id", "session_id")
    @classmethod
    def validate_optional_scope(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        if (
            not normalized
            or len(normalized) > 256
            or any(ord(char) < 32 for char in normalized)
        ):
            raise ValueError("operation scope fields must be valid and non-blank")
        return normalized

    @field_validator("state_revision")
    @classmethod
    def validate_state_revision(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        if (
            not normalized
            or len(normalized) > 256
            or any(ord(char) < 32 for char in normalized)
        ):
            raise ValueError("state_revision must be valid and non-blank when provided")
        return normalized

    @field_validator("params")
    @classmethod
    def validate_canonical_params(cls, value: Dict[str, Any]) -> Dict[str, Any]:
        try:
            json.dumps(
                value,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
                allow_nan=False,
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("params must be canonical JSON") from exc
        return value


class OperationActionRequest(BaseModel):
    operation_id: str
    request_id: Optional[str] = None
    session_id: Optional[str] = None
    conversation_id: Optional[str] = None
    user_id: str
    payload_digest: Optional[str] = None
    state_revision: Optional[str] = None

    @field_validator(
        "operation_id",
        "user_id",
    )
    @classmethod
    def validate_actor_scope(cls, value: str) -> str:
        normalized = str(value or "").strip()
        if (
            not normalized
            or len(normalized) > 256
            or any(ord(char) < 32 for char in normalized)
        ):
            raise ValueError("operation scope fields must be valid and non-blank")
        return normalized

    @field_validator("request_id", "session_id", "conversation_id")
    @classmethod
    def validate_optional_scope(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        if (
            not normalized
            or len(normalized) > 256
            or any(ord(char) < 32 for char in normalized)
        ):
            raise ValueError("operation scope fields must be valid and non-blank")
        return normalized

    @field_validator("payload_digest")
    @classmethod
    def validate_payload_digest(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value or "").strip()
        if not _PAYLOAD_DIGEST.fullmatch(normalized):
            raise ValueError("payload_digest must be a lowercase SHA-256 digest")
        return normalized

    @field_validator("state_revision")
    @classmethod
    def validate_state_revision(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        if (
            not normalized
            or len(normalized) > 256
            or any(ord(char) < 32 for char in normalized)
        ):
            raise ValueError("state_revision must be valid and non-blank when provided")
        return normalized


def _operation_action_scope(req: OperationActionRequest) -> Optional[Dict[str, Any]]:
    if not all((req.request_id, req.session_id, req.conversation_id, req.payload_digest)):
        return None
    return {
        "request_id": req.request_id,
        "session_id": req.session_id,
        "conversation_id": req.conversation_id,
        "user_id": req.user_id,
        "payload_digest": req.payload_digest,
        "state_revision": req.state_revision,
    }


def _operation_transition_rejected() -> HTTPException:
    # Deliberately do not reveal whether the handle, actor, payload, or state
    # revision differed.  That keeps the public error stable and prevents
    # operation-handle enumeration.
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_OPERATION_TRANSITION_ERROR)


@router.post("/operation/create")
async def create_operation(
    req: OperationCreateRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.operation_safety_service import get_operation_safety_service
    svc = get_operation_safety_service()
    request_id = req.request_id or f"legacy-request-{uuid.uuid4().hex}"
    session_id = req.session_id or f"legacy-session-{uuid.uuid4().hex}"
    try:
        op = svc.create_pending_operation(
            request_id=request_id,
            session_id=session_id,
            conversation_id=req.conversation_id,
            user_id=req.user_id,
            operation_type=req.operation_type,
            target=req.target,
            params=req.params,
            description=req.description,
            state_revision=req.state_revision,
        )
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=_OPERATION_PAYLOAD_ERROR,
        ) from exc
    operation_scope = {
        "request_id": op.request_id,
        "session_id": op.session_id,
        "conversation_id": op.conversation_id,
        "user_id": op.user_id,
        "payload_digest": op.payload_digest,
        "state_revision": op.state_revision,
    }
    return {
        "status": "success",
        "operation_id": op.operation_id,
        "payload_digest": op.payload_digest,
        "state_revision": op.state_revision,
        "confirmation_prompt": op.confirmation_prompt(),
        "is_high_risk": svc.is_high_risk(req.operation_type),
        "operation_scope": operation_scope,
    }


@router.post("/operation/confirm")
async def confirm_operation(
    req: OperationActionRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.operation_safety_service import get_operation_safety_service
    svc = get_operation_safety_service()
    scope = _operation_action_scope(req)
    if scope is None or not svc.confirm_operation(req.operation_id, **scope):
        raise _operation_transition_rejected()
    return {"status": "success", "operation_id": req.operation_id, "confirmed": True}


@router.post("/operation/rollback")
async def rollback_operation(
    req: OperationActionRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.operation_safety_service import get_operation_safety_service
    svc = get_operation_safety_service()
    scope = _operation_action_scope(req)
    if scope is None:
        raise _operation_transition_rejected()
    prev = svc.rollback_operation(req.operation_id, **scope)
    if prev is None:
        raise _operation_transition_rejected()
    return {"status": "success", "operation_id": req.operation_id, "previous_state": prev}


@router.post("/operation/cancel")
async def cancel_operation(
    req: OperationActionRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.operation_safety_service import get_operation_safety_service
    svc = get_operation_safety_service()
    scope = _operation_action_scope(req)
    if scope is None or not svc.cancel_operation(req.operation_id, **scope):
        raise _operation_transition_rejected()
    return {"status": "success", "operation_id": req.operation_id, "cancelled": True}


# ===========================================================================
# Team Memory — 团队共享记忆
# ===========================================================================

class TeamShareRequest(BaseModel):
    team_id: str
    user_id: str
    key: str
    value: str
    tags: List[str] = Field(default_factory=list)
    equipment_id: Optional[str] = None


class TeamQueryRequest(BaseModel):
    team_id: str
    query: str
    limit: int = 5


@router.post("/team-memory/share")
async def team_share(
    req: TeamShareRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.team_memory_service import get_team_memory_service
    svc = get_team_memory_service()
    f = svc.share_finding(req.team_id, user_id=req.user_id, key=req.key, value=req.value,
                          tags=req.tags, equipment_id=req.equipment_id)
    return {"status": "success", "finding_id": f.finding_id}


@router.post("/team-memory/search")
async def team_search(
    req: TeamQueryRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.team_memory_service import get_team_memory_service
    svc = get_team_memory_service()
    results = svc.find_related(req.team_id, req.query, limit=req.limit)
    return {"status": "success", "results": [r.to_dict() for r in results]}


# ===========================================================================
# Skill A/B Test
# ===========================================================================

class ABTestCreateRequest(BaseModel):
    experiment_id: str
    control: str
    variant: str
    traffic_pct: int = 10


class ABTestResultRequest(BaseModel):
    experiment_id: str


@router.post("/ab-test/create")
async def ab_test_create(
    req: ABTestCreateRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.skill_ab_test_service import get_skill_ab_test_service
    svc = get_skill_ab_test_service()
    exp = svc.create_experiment(req.experiment_id, control=req.control,
                                variant=req.variant, traffic_pct=req.traffic_pct)
    return {"status": "success", **exp.to_dict()}


@router.post("/ab-test/results")
async def ab_test_results(
    req: ABTestResultRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.skill_ab_test_service import get_skill_ab_test_service
    svc = get_skill_ab_test_service()
    r = svc.get_experiment_results(req.experiment_id)
    if r is None:
        raise HTTPException(status_code=404, detail="Experiment not found")
    return {"status": "success", **r}


# ===========================================================================
# Inspection Report + User Profile
# ===========================================================================

@router.post("/report/inspection")
async def inspection_report(_: None = Depends(_validate_internal_token)) -> Dict[str, Any]:
    from runtime.services.inspection_report_service import get_inspection_report_service
    return {"status": "success", **get_inspection_report_service().generate_report(days=7)}


class UserProfileRequest(BaseModel):
    user_id: str


@router.post("/user/profile")
async def get_user_profile(
    req: UserProfileRequest, _: None = Depends(_validate_internal_token),
) -> Dict[str, Any]:
    from runtime.services.user_profiling_service import get_user_profiling_service
    return {"status": "success", **get_user_profiling_service().get_profile(req.user_id).to_dict()}
