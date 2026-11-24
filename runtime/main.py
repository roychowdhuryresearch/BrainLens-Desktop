import asyncio
import logging
import os
import re
from logging.handlers import RotatingFileHandler
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from runtime.agent_history.db import init_db
from runtime.agent_runtime.user_input import cleanup_expired_inputs
from runtime.api import internal_agent, internal_history, internal_observability
from runtime.core.config import config_manager
from runtime.skills.skill_registry import skill_registry


_agent_data_dir = (os.environ.get("IEEG_AGENT_DATA_DIR") or "").strip()
log_dir = (Path(_agent_data_dir).expanduser() / "logs") if _agent_data_dir else (Path(__file__).parent.parent / "logs")
log_dir.mkdir(parents=True, exist_ok=True)

root_logger = logging.getLogger()
root_logger.setLevel(logging.DEBUG)
root_logger.handlers.clear()


class SensitiveLogFormatter(logging.Formatter):
    _SECRET_PATTERNS = (
        re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+"),
        re.compile(r"(?i)\b((?:api[_-]?key|secret|token|password)\s*[:=]\s*)[^\s,;]+"),
        re.compile(r"(?i)\b(?:sk|ak)-[A-Za-z0-9_\-]{12,}\b"),
    )

    @classmethod
    def redact(cls, value: str) -> str:
        redacted = str(value)
        for pattern in cls._SECRET_PATTERNS:
            if pattern.groups:
                redacted = pattern.sub(r"\1[REDACTED]", redacted)
            else:
                redacted = pattern.sub("[REDACTED]", redacted)
        return redacted

    def format(self, record: logging.LogRecord) -> str:
        original_msg = record.msg
        original_args = record.args
        try:
            record.msg = self.redact(record.getMessage())
            record.args = ()
            rendered = super().format(record)
            return self.redact(rendered)
        finally:
            record.msg = original_msg
            record.args = original_args


LOG_FORMAT = "%(asctime)s - %(name)s - %(levelname)s - %(message)s"

console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_handler.setFormatter(SensitiveLogFormatter(LOG_FORMAT))
root_logger.addHandler(console_handler)

file_handler = RotatingFileHandler(log_dir / "agent.log", maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8")
file_handler.setFormatter(SensitiveLogFormatter(LOG_FORMAT))
root_logger.addHandler(file_handler)

logging.getLogger("watchdog").setLevel(logging.WARNING)
logging.getLogger("watchdog.observers.inotify_buffer").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)

SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": (
        "default-src 'self'; "
        "base-uri 'self'; "
        "object-src 'none'; "
        "frame-ancestors 'none'; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
}


def _api_docs_enabled() -> bool:
    value = os.getenv("IEEG_ENABLE_API_DOCS") or os.getenv("AGENT_ENABLE_API_DOCS") or ""
    return value.strip().lower() in {"1", "true", "yes", "on"}


_ENABLE_API_DOCS = _api_docs_enabled()
app = FastAPI(
    title="iEEG Agent Runtime",
    description="Internal iEEG agent runtime service",
    version="1.0.0",
    docs_url="/docs" if _ENABLE_API_DOCS else None,
    redoc_url="/redoc" if _ENABLE_API_DOCS else None,
    openapi_url="/openapi.json" if _ENABLE_API_DOCS else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000", "http://127.0.0.1:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_security_headers(request, call_next):
    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response

app.include_router(internal_agent.router)
app.include_router(internal_history.router)
# NOTE: internal_memory router 已下线；memory 现在由 backend 提供（/internal/api/memories/*），
# agent 通过 app.services.memory_service (HTTP shim) 访问。
app.include_router(internal_observability.router)


@app.get("/health")
async def health_check():
    return {"status": "healthy"}


@app.get("/ready")
async def ready_check():
    return {"status": "ready"}


@app.on_event("startup")
async def startup_event():
    logger.info("Agent service starting up...")
    init_db()
    # init_memory_db 已下线：memory 存储迁移到 backend
    from runtime.services.storage_service import get_storage_service
    get_storage_service()
    config_manager.load_config()
    # Electron selects the UI connector through IEEG_AGENT_MCP_SERVERS.
    if os.getenv("IEEG_AGENT_SKIP_MCP", "").strip().lower() in {"1", "true", "yes", "on"}:
        logger.info("IEEG_AGENT_SKIP_MCP set; skipping MCP server initialization for fast startup")
    else:
        config_manager.init_mcp_servers()
    skill_registry.scan_skills()
    asyncio.create_task(cleanup_expired_inputs())
    logger.info("Agent service initialized")


@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Agent service shutting down...")
    try:
        from runtime.agent_runtime import post_turn

        await post_turn.await_all(timeout=10.0)
    except Exception as exc:
        logger.warning("Failed to drain post-turn tasks cleanly: %s", exc)
    try:
        from runtime.core.mcp_manager import get_mcp_manager

        await get_mcp_manager().stop_all_servers()
    except Exception as exc:
        logger.warning("Failed to stop MCP servers cleanly: %s", exc)


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    request_path = getattr(getattr(request, "url", None), "path", None) or "unknown"
    logger.error(
        "Unhandled agent exception type=%s path=%s",
        exc.__class__.__name__,
        request_path,
        exc_info=True,
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("runtime.main:app", host="0.0.0.0", port=8001, reload=True)
