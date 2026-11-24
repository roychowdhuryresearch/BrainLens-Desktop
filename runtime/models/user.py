# -*- coding: utf-8 -*-
import json
import os
import logging
from datetime import datetime
from sqlalchemy import create_engine, Column, String, DateTime, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool


logger = logging.getLogger(__name__)
_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'users.db')

engine = create_engine(
    'sqlite:///' + _DB_PATH,
    connect_args={'check_same_thread': False},
    poolclass=NullPool,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


class User(Base):
    __tablename__ = 'users'
    id = Column(String, primary_key=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default='USER')
    allowed_mcp_servers = Column(
        Text, default='default',
        comment='"default"=follow system, []=none, ["x"]=custom',
    )
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def get_allowed_mcp_servers(self):
        val = self.allowed_mcp_servers
        if val is None or val == 'default':
            return None
        try:
            return json.loads(val)
        except Exception:
            return None


def init_db():
    Base.metadata.create_all(bind=engine)
    logger.info('[DB] user tables initialized')

    _migrate_allowed_mcp()
    _migrate_roles()


def _migrate_allowed_mcp():
    try:
        import sqlite3
        conn = sqlite3.connect(_DB_PATH)
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(users)')
        cols = [c[1] for c in cur.fetchall()]
        if 'allowed_mcp_servers' not in cols:
            cur.execute(
                "ALTER TABLE users ADD COLUMN "
                "allowed_mcp_servers TEXT DEFAULT 'default'"
            )
            conn.commit()
            logger.info('[DB] added allowed_mcp_servers col')
        conn.close()
    except Exception as exc:
        logger.warning(f'[DB] migration: {exc}')


def _migrate_roles():
    db = SessionLocal()
    try:
        mapping = {
            'super_admin': 'SUPER_ADMIN',
            'admin': 'ADMIN',
            'user': 'USER',
            'developer': 'DEVELOPER',
        }
        for old, new in mapping.items():
            for u in db.query(User).filter(User.role == old).all():
                u.role = new
        db.commit()
    finally:
        db.close()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
