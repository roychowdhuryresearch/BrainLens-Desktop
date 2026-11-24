from __future__ import annotations

import asyncio

from runtime.main import global_exception_handler


def test_agent_global_exception_handler_masks_detail():
    response = asyncio.run(global_exception_handler(None, RuntimeError("internal stack trace")))
    assert response.status_code == 500
    assert response.body == b'{"detail":"Internal server error"}'
