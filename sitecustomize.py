import os
import sys
import multiprocessing
import multiprocessing.context


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
