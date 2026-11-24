from fastapi import APIRouter, Depends, HTTPException

from runtime.agent_history.observability_service import get_agent_observability_service
from runtime.api.internal_agent import _validate_internal_token


router = APIRouter(prefix="/internal/agent/v1/observability", tags=["internal-agent-observability"])


@router.get("/turns")
async def list_turns(
    limit: int = 20,
    offset: int = 0,
    sort_by: str = "created_at",
    sort_order: str = "desc",
    _: None = Depends(_validate_internal_token),
):
    service = get_agent_observability_service()
    return service.list_turns(limit=limit, offset=offset, sort_by=sort_by, sort_order=sort_order)


@router.get("/turns/{turn_id}")
async def get_turn_detail(turn_id: str, _: None = Depends(_validate_internal_token)):
    service = get_agent_observability_service()
    detail = service.get_turn_detail(turn_id)
    if not detail:
        raise HTTPException(status_code=404, detail="Turn not found")
    return detail
