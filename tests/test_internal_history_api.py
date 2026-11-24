from fastapi import FastAPI
from fastapi.testclient import TestClient

from runtime.api.internal_history import router


class StubHistoryService:
    def create_conversation(self, **kwargs):
        return {"conversation_id": "conv-1", "user_id": kwargs["user_id"]}

    def get_conversation(self, conversation_id):
        if conversation_id == "missing":
            return None
        return {"conversation_id": conversation_id, "user_id": "u-1"}

    def list_user_conversations(self, user_id, limit, offset):
        return [{"conversation_id": "conv-1", "user_id": user_id}]

    def add_message(self, **kwargs):
        return {"message_id": "msg-1", "conversation_id": kwargs["conversation_id"]}

    def get_conversation_messages(self, conversation_id, limit, offset):
        return [{"message_id": "msg-1"}]

    def get_recent_messages(self, conversation_id, limit):
        return [{"message_id": "msg-1"}]

    def start_turn(self, **kwargs):
        return {"turn_id": "turn-1", "conversation_id": kwargs["conversation_id"]}

    def complete_turn(self, **kwargs):
        return {"turn_id": kwargs["turn_id"], "status": kwargs["status"]}

    def get_turn(self, turn_id):
        return {"turn_id": turn_id, "conversation_id": "conv-1"}

    def get_conversation_turns(self, conversation_id):
        return [{"turn_id": "turn-1"}]

    def save_summary(self, **kwargs):
        return {"conversation_id": kwargs["conversation_id"], "summary_text": kwargs["summary_text"]}

    def get_summary(self, conversation_id):
        return {"conversation_id": conversation_id, "summary_text": "summary"}

    def get_summary_metadata(self, conversation_id):
        return {"conversation_id": conversation_id, "summary_turn": 1}

    def get_full_context(self, conversation_id):
        return {"conversation": {"conversation_id": conversation_id}, "messages": [], "summary": None, "turns": []}


def create_client(monkeypatch):
    monkeypatch.setenv("AGENT_SERVICE_TOKEN", "test-agent-service-token")
    app = FastAPI()
    app.include_router(router)
    monkeypatch.setattr("runtime.api.internal_history.get_agent_history_service", lambda: StubHistoryService())
    return TestClient(app), {"Authorization": "Bearer test-agent-service-token"}


def test_create_conversation(monkeypatch):
    client, headers = create_client(monkeypatch)
    response = client.post("/internal/agent/v1/conversations", json={"user_id": "u-1", "title": "Hello"}, headers=headers)

    assert response.status_code == 200
    assert response.json()["user_id"] == "u-1"


def test_get_conversation_not_found(monkeypatch):
    client, headers = create_client(monkeypatch)
    response = client.get("/internal/agent/v1/conversations/missing", headers=headers)

    assert response.status_code == 404


def test_get_summary_metadata(monkeypatch):
    client, headers = create_client(monkeypatch)
    response = client.get("/internal/agent/v1/conversations/conv-1/summary/metadata", headers=headers)

    assert response.status_code == 200
    assert response.json()["summary_turn"] == 1
