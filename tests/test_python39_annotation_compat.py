import ast
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1] / "runtime"


def _uses_pep604_in_annotations(tree: ast.AST) -> bool:
    def annotation_has_bitor(node: ast.AST | None) -> bool:
        if node is None:
            return False
        return any(
            isinstance(child, ast.BinOp) and isinstance(child.op, ast.BitOr)
            for child in ast.walk(node)
        )

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if annotation_has_bitor(node.returns):
                return True
            args = list(node.args.args) + list(node.args.kwonlyargs)
            if any(annotation_has_bitor(arg.annotation) for arg in args):
                return True
            if annotation_has_bitor(getattr(node.args.vararg, "annotation", None)):
                return True
            if annotation_has_bitor(getattr(node.args.kwarg, "annotation", None)):
                return True
        if isinstance(node, ast.AnnAssign) and annotation_has_bitor(node.annotation):
            return True
    return False


def _has_future_annotations_import(tree: ast.Module) -> bool:
    body = list(tree.body)
    if (
        body
        and isinstance(body[0], ast.Expr)
        and isinstance(getattr(body[0], "value", None), ast.Constant)
        and isinstance(body[0].value.value, str)
    ):
        body = body[1:]

    if not body:
        return False

    first_stmt = body[0]
    return (
        isinstance(first_stmt, ast.ImportFrom)
        and first_stmt.module == "__future__"
        and any(alias.name == "annotations" for alias in first_stmt.names)
    )


def test_agent_app_pep604_annotations_use_future_import() -> None:
    incompatible_files = []

    for path in APP_ROOT.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source)
        if not _uses_pep604_in_annotations(tree):
            continue

        if not _has_future_annotations_import(tree):
            incompatible_files.append(str(path.relative_to(APP_ROOT.parent)))

    assert incompatible_files == []
