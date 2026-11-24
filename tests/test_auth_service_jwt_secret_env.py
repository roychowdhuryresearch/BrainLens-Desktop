from __future__ import annotations

import importlib

import pytest


def _reload_auth_service(monkeypatch, secret: str | None):
    if secret is None:
        monkeypatch.delenv("IEEG_JWT_SECRET_KEY", raising=False)
        monkeypatch.delenv("AGENT_JWT_SECRET_KEY", raising=False)
    else:
        monkeypatch.setenv("IEEG_JWT_SECRET_KEY", secret)

    import runtime.services.auth_service as auth_service

    return importlib.reload(auth_service)


def test_create_access_token_requires_env_secret(monkeypatch):
    auth_service = _reload_auth_service(monkeypatch, None)

    with pytest.raises(RuntimeError, match="IEEG_JWT_SECRET_KEY"):
        auth_service.create_access_token({"sub": "alice"})


def test_decode_token_requires_env_secret(monkeypatch):
    auth_service = _reload_auth_service(monkeypatch, None)

    with pytest.raises(RuntimeError, match="IEEG_JWT_SECRET_KEY"):
        auth_service.decode_token("not-a-real-token")


def test_jwt_round_trip_uses_env_secret(monkeypatch):
    auth_service = _reload_auth_service(monkeypatch, "agent-test-secret")

    token = auth_service.create_access_token({"sub": "alice", "role": "USER"})
    payload = auth_service.decode_token(token)

    assert payload is not None
    assert payload["sub"] == "alice"
    assert payload["role"] == "USER"


def test_user_database_initialization_preserves_only_configured_accounts(monkeypatch, tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from runtime.models import user

    path = tmp_path / "users.db"
    engine = create_engine(f"sqlite:///{path}")
    sessions = sessionmaker(bind=engine)
    monkeypatch.setattr(user, "_DB_PATH", str(path))
    monkeypatch.setattr(user, "engine", engine)
    monkeypatch.setattr(user, "SessionLocal", sessions)
    user.init_db()
    with sessions() as db:
        assert db.query(user.User).count() == 0
        db.add(user.User(id="test-id", username="researcher", role="user", password_hash="test-hash"))
        db.commit()
    user.init_db()
    with sessions() as db:
        account = db.query(user.User).one()
        assert account.username == "researcher"
        assert account.role == "USER"
