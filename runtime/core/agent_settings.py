from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AgentSettings:
    service_token: str | None


def get_agent_settings() -> AgentSettings:
    return AgentSettings(
        service_token=(
            os.getenv("PYHFO_AGENT_SERVICE_TOKEN", "").strip()
            or os.getenv("AGENT_SERVICE_TOKEN", "").strip()
            or None
        ),
    )
