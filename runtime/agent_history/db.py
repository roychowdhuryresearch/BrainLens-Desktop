"""Agent History 数据库连接."""

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from pathlib import Path

# 数据库文件路径
_agent_data_dir = (os.environ.get("IEEG_AGENT_DATA_DIR") or "").strip()
DATA_DIR = Path(_agent_data_dir).expanduser() if _agent_data_dir else (Path(__file__).resolve().parents[2] / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)
HISTORY_DB_PATH = DATA_DIR / "agent_history.db"

# 创建引擎
# Default QueuePool (NOT StaticPool): StaticPool hands ONE shared sqlite connection to every
# thread, and the history/observability writes run on asyncio.to_thread worker threads
# concurrently, so a single shared connection interleaves transactions and silently drops rows.
# Per-thread connections + WAL + busy_timeout handle cross-connection contention safely.
_engine = create_engine(
    f"sqlite:///{HISTORY_DB_PATH}",
    connect_args={"check_same_thread": False, "timeout": 30},
    echo=False
)


@event.listens_for(_engine, "connect")
def set_sqlite_pragma(dbapi_conn, connection_record):
    """设置 SQLite 性能优化"""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


# 会话工厂
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)

# 声明基类
Base = declarative_base()


def get_db_session():
    """获取数据库会话（上下文管理器）"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    """初始化数据库表"""
    # 导入模型以确保它们被注册到 Base.metadata
    from runtime.agent_history.models import (
        AgentConversation,
        AgentMessage,
        AgentAttachment,
        AgentTurn,
        AgentSummary,
        AgentTelemetrySpan,
    )
    Base.metadata.create_all(bind=_engine)
    _ensure_agent_message_metadata_column(_engine)


def _ensure_agent_message_metadata_column(engine) -> None:
    """Apply the additive message-audit migration for pre-contract databases."""

    inspector = inspect(engine)
    if "agent_messages" not in inspector.get_table_names():
        return
    columns = {str(column.get("name") or "") for column in inspector.get_columns("agent_messages")}
    if "metadata_json" in columns:
        return
    try:
        with engine.begin() as connection:
            connection.execute(text("ALTER TABLE agent_messages ADD COLUMN metadata_json TEXT"))
    except OperationalError:
        # Concurrent startup may have applied the same additive migration
        # after our initial inspection.  Only suppress that exact end state.
        refreshed = {
            str(column.get("name") or "")
            for column in inspect(engine).get_columns("agent_messages")
        }
        if "metadata_json" not in refreshed:
            raise


# 导出
