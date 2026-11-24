from typing import Literal

from pydantic import BaseModel, Field


class VerificationResult(BaseModel):
    """回复对齐校验结果。"""

    verdict: Literal["success", "partial_success", "failure"] = Field(
        ...,
        description="校验结论",
    )
    reason: str = Field(default="", description="对齐问题说明")
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)
