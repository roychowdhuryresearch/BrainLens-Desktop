from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from runtime.agent_history.service import get_agent_history_service
from runtime.api.internal_agent import _validate_internal_token


router = APIRouter(prefix="/internal/agent/v1", tags=["internal-agent-history"])


class CreateConversationRequest(BaseModel):
    user_id: str
    source: str = "web"
    external_conversation_id: Optional[str] = None
    title: Optional[str] = None


class GetOrCreateConversationRequest(BaseModel):
    conversation_id: str
    user_id: str
    source: str = "web"
    external_conversation_id: Optional[str] = None
    title: Optional[str] = None


class AddMessageRequest(BaseModel):
    conversation_id: str
    role: str
    content: str
    name: Optional[str] = None
    tool_call_id: Optional[str] = None
    sources: Optional[List] = None


class StartTurnRequest(BaseModel):
    conversation_id: str
    user_message: str
    active_skill: Optional[str] = None
    skill_reason: Optional[str] = None
    routing_method: Optional[str] = None


class CompleteTurnRequest(BaseModel):
    turn_id: str
    status: str = "completed"
    error_message: Optional[str] = None
    total_iterations: Optional[int] = None
    model_used: Optional[str] = None
    tokens_used: Optional[int] = None


class SaveSummaryRequest(BaseModel):
    conversation_id: str
    summary_text: str
    summary_turn: int
    important_facts: Optional[List] = None
    constraints: Optional[List] = None
    decisions_made: Optional[List] = None
    open_questions: Optional[List] = None


class UpdateTitleRequest(BaseModel):
    conversation_id: str
    title: str


@router.post("/conversations")
async def create_conversation(request: CreateConversationRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.create_conversation(
        user_id=request.user_id,
        source=request.source,
        external_conversation_id=request.external_conversation_id or "",
        title=request.title or "",
    )


@router.post("/conversations/get-or-create")
async def get_or_create_conversation(request: GetOrCreateConversationRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.get_or_create_conversation(
        conversation_id=request.conversation_id,
        user_id=request.user_id,
        source=request.source,
        external_conversation_id=request.external_conversation_id or "",
        title=request.title or "",
    )


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    conv = service.get_conversation(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.put("/conversations/title")
async def update_conversation_title(request: UpdateTitleRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    conv = service.update_conversation_title(request.conversation_id, request.title)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conv


@router.get("/users/{user_id}/conversations")
async def list_user_conversations(user_id: str, limit: int = 20, offset: int = 0, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    convs = service.list_user_conversations(user_id, limit, offset)
    return {"conversations": convs, "total": len(convs)}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    existing = service.get_conversation(conversation_id)
    if not existing:
        raise HTTPException(status_code=404, detail="Conversation not found")
    await service.delete_conversation(conversation_id)
    return {"success": True}


@router.post("/messages")
async def add_message(request: AddMessageRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.add_message(
        conversation_id=request.conversation_id,
        role=request.role,
        content=request.content,
        name=request.name or "",
        tool_call_id=request.tool_call_id or "",
        sources=request.sources or [],
    )


@router.get("/conversations/{conversation_id}/messages")
async def get_conversation_messages(conversation_id: str, limit: int = 100, offset: int = 0, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.get_conversation_messages(conversation_id, limit=limit, offset=offset)


@router.get("/conversations/{conversation_id}/messages/recent")
async def get_recent_messages(conversation_id: str, count: int = 20, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.get_recent_messages(conversation_id, limit=count)


@router.post("/turns/start")
async def start_turn(request: StartTurnRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.start_turn(
        conversation_id=request.conversation_id,
        user_message=request.user_message,
        active_skill=request.active_skill,
        skill_reason=request.skill_reason,
        routing_method=request.routing_method,
    )


@router.post("/turns/complete")
async def complete_turn(request: CompleteTurnRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    turn = service.complete_turn(
        turn_id=request.turn_id,
        status=request.status,
        error_message=request.error_message,
        total_iterations=request.total_iterations,
        model_used=request.model_used,
        tokens_used=request.tokens_used,
    )
    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")
    return turn


@router.get("/turns/{turn_id}")
async def get_turn(turn_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    turn = service.get_turn(turn_id)
    if not turn:
        raise HTTPException(status_code=404, detail="Turn not found")
    return turn


@router.get("/conversations/{conversation_id}/turns")
async def get_conversation_turns(conversation_id: str, limit: int = 50, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    turns = service.get_conversation_turns(conversation_id)
    return turns[:limit]


@router.post("/summaries")
async def save_summary(request: SaveSummaryRequest, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.save_summary(
        conversation_id=request.conversation_id,
        summary_text=request.summary_text,
        summary_turn=request.summary_turn,
        important_facts=request.important_facts or [],
        constraints=request.constraints or [],
        decisions_made=request.decisions_made or [],
        open_questions=request.open_questions or [],
    )


@router.get("/conversations/{conversation_id}/summary")
async def get_summary(conversation_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.get_summary(conversation_id)


@router.get("/conversations/{conversation_id}/summary/metadata")
async def get_summary_metadata(conversation_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.get_summary_metadata(conversation_id)


@router.get("/conversations/{conversation_id}/context")
async def get_conversation_context(conversation_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_history_service()
    return service.get_full_context(conversation_id)
