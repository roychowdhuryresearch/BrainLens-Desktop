import json
import re
from typing import Any, Dict


def parse_json_object(content: str) -> Dict[str, Any]:
    text = (content or "").strip()
    if not text:
        raise ValueError("empty json response")

    fenced = re.search(r"```(?:json)?\s*(\{[\s\S]*\})\s*```", text, re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()

    try:
        parsed = json.loads(text)
    except Exception:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise
        parsed = json.loads(text[start : end + 1])

    if not isinstance(parsed, dict):
        raise ValueError("json response is not an object")
    return parsed
