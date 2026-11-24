from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from string import Template
from typing import Any

logger = logging.getLogger(__name__)

PROMPTS_ROOT = Path(__file__).resolve().parent


@lru_cache(maxsize=None)
def load_prompt(relative_path: str) -> str:
    return load_prompt_file(PROMPTS_ROOT / relative_path)


@lru_cache(maxsize=None)
def load_prompt_file(path: Path) -> str:
    resolved = Path(path).resolve()
    if not resolved.exists():
        logger.error("[PromptLoader] Prompt file not found: %s", resolved)
        raise FileNotFoundError(f"Prompt file not found: {resolved}")
    return resolved.read_text(encoding="utf-8")


def render_prompt(relative_path: str, **variables: Any) -> str:
    return render_prompt_file(PROMPTS_ROOT / relative_path, **variables)


def render_prompt_file(path: Path, **variables: Any) -> str:
    template = Template(load_prompt_file(path))
    normalized = {
        key: "" if value is None else str(value)
        for key, value in variables.items()
    }
    try:
        return template.substitute(normalized)
    except KeyError as exc:
        missing_key = exc.args[0]
        raise ValueError(
            f"Missing prompt variable '{missing_key}' for template '{Path(path)}'"
        ) from exc
