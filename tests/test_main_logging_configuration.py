import importlib
import logging
import logging.handlers
import sys


class _InMemoryRotatingFileHandler(logging.Handler):
    def __init__(self, *args, **kwargs):
        super().__init__()

    def emit(self, record):
        pass


def test_agent_console_logging_suppresses_third_party_debug_events(monkeypatch):
    monkeypatch.setattr(logging.handlers, "RotatingFileHandler", _InMemoryRotatingFileHandler)
    sys.modules.pop("runtime.main", None)

    importlib.import_module("runtime.main")

    console_handlers = [
        handler
        for handler in logging.getLogger().handlers
        if isinstance(handler, logging.StreamHandler)
    ]

    assert console_handlers
    assert all(handler.level >= logging.INFO for handler in console_handlers)
    assert logging.getLogger("watchdog").getEffectiveLevel() >= logging.WARNING
    assert logging.getLogger("watchdog.observers.inotify_buffer").getEffectiveLevel() >= logging.WARNING
