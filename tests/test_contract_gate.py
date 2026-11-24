from __future__ import annotations

import json
import subprocess
from pathlib import Path

from contract_gate.audit import (
    _link_staged_proof_dependencies,
    audit_change_set,
    collect_changed_paths,
    owners_for_path,
    parse_impact_note,
    run_proofs,
    staged_index_snapshot,
)


def _write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _fixture_repo(tmp_path: Path) -> Path:
    registry = {
        "version": "1.0.0",
        "production_roots": ["runtime/"],
        "capabilities": {
            "IC-RUNTIME": {
                "document": "runtime/docs/contracts/runtime.md",
                "proofs": ["tests/test_runtime.py"],
            }
        },
        "rules": [
            {"glob": "runtime/owned/**", "owners": ["IC-RUNTIME"]},
            {"glob": "runtime/docs/contracts/**", "owners": ["IC-RUNTIME"]},
        ],
        "modules": [{"name": "runtime", "glob": "runtime/**"}],
    }
    _write(
        tmp_path / "runtime/docs/contracts/ownership-map.json",
        json.dumps(registry),
    )
    _write(tmp_path / "runtime/docs/contracts/runtime.md", "# runtime")
    _write(tmp_path / "runtime/owned/agent.py", "VALUE = 1")
    _write(tmp_path / "tests/test_runtime.py", "def test_ok(): assert True")
    return tmp_path


def _impact_note(*, impact: str = "changed", owners: str = "IC-RUNTIME") -> str:
    owner_line = f"Contract-Owners-Changed: {owners}\n" if owners else ""
    return (
        "Modules: runtime\n"
        f"Contract-Impact: {impact}\n"
        "Contract-Impact-Reason: The accepted runtime behavior and its proof are intentionally updated.\n"
        f"{owner_line}"
        "Contract-Proof: tests/test_runtime.py\n"
    )


def _init_fixture_git(root: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "contracts@example.invalid"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Contract Test"], cwd=root, check=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)


def _stage_contract_change(root: Path, *, note: str | None = None, proof: str | None = None) -> str:
    note_path = "docs/implementation-notes/change.md"
    _write(root / "runtime/owned/agent.py", "VALUE = 2")
    _write(root / "runtime/docs/contracts/runtime.md", "# runtime changed")
    _write(root / "tests/test_runtime.py", proof or "def test_ok(): assert True\n# changed")
    _write(root / note_path, note or _impact_note())
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    return note_path


def test_valid_changed_declaration_binds_code_owner_doc_and_same_change_proof(tmp_path):
    root = _fixture_repo(tmp_path)
    note_path = "docs/implementation-notes/change.md"
    _write(root / note_path, _impact_note())
    changed = [
        "runtime/owned/agent.py",
        "runtime/docs/contracts/runtime.md",
        "tests/test_runtime.py",
        note_path,
    ]

    result = audit_change_set(root, changed)

    assert result.ok, result.errors
    assert result.impacted_modules == {"runtime"}
    assert result.candidate_owners == {"IC-RUNTIME"}
    assert result.selected_proofs == ("tests/test_runtime.py",)


def test_new_production_file_without_owner_fails_closed(tmp_path):
    root = _fixture_repo(tmp_path)
    _write(root / "runtime/unowned/new.py", "VALUE = 2")
    note_path = "docs/implementation-notes/change.md"
    _write(root / note_path, _impact_note(impact="none", owners=""))

    result = audit_change_set(
        root,
        ["runtime/unowned/new.py", "tests/test_runtime.py", note_path],
    )

    assert result.ok is False
    assert any("no contract owner" in error for error in result.errors)


def test_impact_none_cannot_hide_changed_contract_document(tmp_path):
    root = _fixture_repo(tmp_path)
    note_path = "docs/implementation-notes/change.md"
    _write(root / note_path, _impact_note(impact="none", owners=""))

    result = audit_change_set(
        root,
        [
            "runtime/owned/agent.py",
            "runtime/docs/contracts/runtime.md",
            "tests/test_runtime.py",
            note_path,
        ],
    )

    assert result.ok is False
    assert any("impact none conflicts" in error for error in result.errors)


def test_proof_must_be_regular_existing_and_part_of_same_change(tmp_path):
    root = _fixture_repo(tmp_path)
    note_path = "docs/implementation-notes/change.md"
    _write(root / note_path, _impact_note())

    result = audit_change_set(
        root,
        ["runtime/owned/agent.py", "runtime/docs/contracts/runtime.md", note_path],
    )

    assert result.ok is False
    assert any("same change set" in error for error in result.errors)


def test_deleted_production_file_is_collected_and_cannot_bypass_declaration(tmp_path):
    root = _fixture_repo(tmp_path)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "contracts@example.invalid"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Contract Test"], cwd=root, check=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)

    (root / "runtime/owned/agent.py").unlink()
    changed = collect_changed_paths(root)

    assert "runtime/owned/agent.py" in changed
    result = audit_change_set(root, changed)
    assert result.ok is False
    assert any("module runtime requires exactly one" in error for error in result.errors)


def test_parser_requires_exact_single_impact_and_reason():
    note = parse_impact_note("note.md", _impact_note())
    assert note.modules == {"runtime"}
    assert note.impact == "changed"
    assert note.owners_changed == {"IC-RUNTIME"}


def test_repository_ownership_map_covers_all_current_production_files():
    root = Path(__file__).resolve().parents[1]
    registry = json.loads(
        (root / "runtime/docs/contracts/ownership-map.json").read_text(encoding="utf-8")
    )
    missing = []
    for prefix in registry["production_roots"]:
        base = root / prefix
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or "__pycache__" in path.parts:
                continue
            relative = path.relative_to(root).as_posix()
            if not owners_for_path(relative, registry):
                missing.append(relative)
    assert missing == []


def test_repository_registry_documents_and_proofs_resolve():
    root = Path(__file__).resolve().parents[1]
    result = audit_change_set(root, [], require_declarations=False)
    assert result.ok, result.errors


def test_staged_snapshot_links_only_installed_desktop_dependencies(tmp_path):
    source = tmp_path / "source"
    snapshot = tmp_path / "snapshot"
    dependency = source / "desktop/node_modules/typescript/package.json"
    _write(dependency, '{"name":"typescript"}')
    snapshot.mkdir()

    _link_staged_proof_dependencies(source, snapshot)

    linked = snapshot / "desktop/node_modules"
    assert linked.is_symlink()
    assert linked.resolve() == (source / "desktop/node_modules").resolve()
    assert (linked / "typescript/package.json").is_file()
    assert not (snapshot / "runtime").exists()


def test_staged_invalid_note_cannot_be_rescued_by_unstaged_worktree_edit(tmp_path):
    root = _fixture_repo(tmp_path)
    _init_fixture_git(root)
    invalid_note = _impact_note().replace("Contract-Impact: changed\n", "")
    note_path = _stage_contract_change(root, note=invalid_note)

    # The index remains invalid even though the visible worktree is repaired.
    _write(root / note_path, _impact_note())
    changed = collect_changed_paths(root, staged=True)
    with staged_index_snapshot(root) as snapshot:
        result = audit_change_set(snapshot, changed)

    assert result.ok is False
    assert any("exactly one Contract-Impact" in error for error in result.errors)


def test_staged_invalid_registry_cannot_be_rescued_by_unstaged_worktree_edit(tmp_path):
    root = _fixture_repo(tmp_path)
    _init_fixture_git(root)
    _stage_contract_change(root)
    registry_path = root / "runtime/docs/contracts/ownership-map.json"
    valid_registry = registry_path.read_text(encoding="utf-8")
    _write(registry_path, '{"capabilities": {}}')
    subprocess.run(["git", "add", registry_path.relative_to(root)], cwd=root, check=True)

    # Repair only the worktree copy; staged audit must still reject the index.
    _write(registry_path, valid_registry)
    changed = collect_changed_paths(root, staged=True)
    with staged_index_snapshot(root) as snapshot:
        result = audit_change_set(snapshot, changed)

    assert result.ok is False
    assert any("ownership registry is invalid" in error for error in result.errors)


def test_staged_proof_runs_from_index_not_repaired_worktree(tmp_path):
    root = _fixture_repo(tmp_path)
    _init_fixture_git(root)
    _stage_contract_change(root, proof="def test_ok(): assert False")

    # A passing unstaged proof must not change the verdict for the failing index.
    _write(root / "tests/test_runtime.py", "def test_ok(): assert True")
    changed = collect_changed_paths(root, staged=True)
    with staged_index_snapshot(root) as snapshot:
        result = audit_change_set(snapshot, changed)
        proof_errors = run_proofs(snapshot, result.selected_proofs) if result.ok else ()

    assert result.ok, result.errors
    assert proof_errors
    assert "1 failed" in proof_errors[0]


def test_staged_symlink_is_checked_from_index_not_repaired_worktree(tmp_path):
    root = _fixture_repo(tmp_path)
    _init_fixture_git(root)
    note_path = _stage_contract_change(root)
    production_path = root / "runtime/owned/agent.py"
    production_path.unlink()
    production_path.symlink_to("../docs/contracts/runtime.md")
    subprocess.run(["git", "add", production_path.relative_to(root)], cwd=root, check=True)

    # Replace the worktree path with a regular file while leaving the symlink staged.
    production_path.unlink()
    _write(production_path, "VALUE = 3")
    changed = collect_changed_paths(root, staged=True)
    with staged_index_snapshot(root) as snapshot:
        assert (snapshot / "runtime/owned/agent.py").is_symlink()
        result = audit_change_set(snapshot, changed)

    assert note_path in changed
    assert result.ok is False
    assert any("production symlinks are forbidden" in error for error in result.errors)
