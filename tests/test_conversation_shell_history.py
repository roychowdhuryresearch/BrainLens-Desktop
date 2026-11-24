import asyncio

from runtime.agent_runtime.conversation_shell import RuntimeConversationShell


class _HistoryService:
    def __init__(self):
        self.requests = []

    def get_recent_history_messages(self, *, conversation_id, limit):
        self.requests.append((conversation_id, limit))
        return [
            {"id": "1", "role": "user", "content": "old user"},
            {"id": "2", "role": "assistant", "content": "old assistant"},
            {"id": "3", "role": "user", "content": "latest user"},
        ]


def test_desktop_copilot_history_is_kept_short():
    service = _HistoryService()
    shell = RuntimeConversationShell(service)

    history = asyncio.run(shell.load_history_for_request("desktop-copilot-abc-recording"))

    assert service.requests == [("desktop-copilot-abc-recording", 5)]
    assert history == [
        {"role": "user", "content": "old user"},
        {"role": "assistant", "content": "old assistant"},
    ]


def test_non_desktop_history_uses_default_window():
    service = _HistoryService()
    shell = RuntimeConversationShell(service)

    asyncio.run(shell.load_history_for_request("general-conv"))

    assert service.requests == [("general-conv", 21)]
