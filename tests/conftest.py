import inspect
import os
import sys
import multiprocessing
import multiprocessing.context


AGENT_PATH = os.path.join(os.path.dirname(__file__), "..")
if AGENT_PATH not in sys.path:
    sys.path.insert(0, AGENT_PATH)


def _patch_httpx_testclient_app_kwarg() -> None:
    """Bridge ``starlette`` 0.35.1's ``TestClient`` to ``httpx`` >= 0.28.

    ``requirements.txt`` pins ``httpx==0.26.0`` / ``starlette==0.35.1`` (the
    latter forced by the ``fastapi==0.109.0`` pin). Under that pinned combo
    everything works and this shim is a no-op.

    When the runtime env drifts to ``httpx>=0.28`` (e.g. a transitive bump from
    installing the ``mcp`` SDK, which needs ``httpx>=0.27.1``), ``httpx`` drops
    the ``app=`` shortcut from ``Client.__init__``. ``starlette`` 0.35.1's
    ``TestClient`` still passes ``app=self.app`` alongside an explicit
    ``transport=`` (which already routes to the app), so construction blows up
    with ``TypeError: Client.__init__() got an unexpected keyword argument
    'app'`` before any endpoint code runs. Since the ``transport`` does the
    routing, the ``app`` kwarg is vestigial here and is safe to drop.
    """
    import httpx

    if "app" in inspect.signature(httpx.Client.__init__).parameters:
        return  # pinned httpx 0.26.x still accepts ``app`` — nothing to do.
    if getattr(httpx.Client.__init__, "_drops_app_kwarg", False):
        return  # already patched (idempotent across repeated conftest imports).

    _orig_init = httpx.Client.__init__

    def _init(self, *args, app=None, **kwargs):
        _orig_init(self, *args, **kwargs)

    _init._drops_app_kwarg = True
    httpx.Client.__init__ = _init


_patch_httpx_testclient_app_kwarg()


if os.environ.get("MUTANT_UNDER_TEST") and "mutmut.__main__" not in sys.modules:
    _original_set_start_method = multiprocessing.context.set_start_method

    def _safe_set_start_method(method, force=False):
        try:
            return _original_set_start_method(method, force=force)
        except RuntimeError as exc:
            if "context has already been set" not in str(exc):
                raise
            return None

    multiprocessing.context.set_start_method = _safe_set_start_method
    multiprocessing.set_start_method = _safe_set_start_method

    import mutmut.__main__  # noqa: F401
