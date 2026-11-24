from pathlib import Path


API_FILES = [
    Path("runtime/api/internal_agent.py"),
]


FORBIDDEN_SNIPPETS = [
    "detail=str(",
    "'message': str(",
    '"message": str(',
    "'error': str(",
    '"error": str(',
]


def test_agent_internal_routes_do_not_return_raw_exception_text():
    offenders = []
    root = Path(__file__).resolve().parents[1]
    for relative in API_FILES:
        text = (root / relative).read_text(encoding="utf-8")
        for snippet in FORBIDDEN_SNIPPETS:
            if snippet in text:
                offenders.append(f"{relative}: {snippet}")

    assert offenders == []
