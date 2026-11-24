from __future__ import annotations

import fnmatch
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator, Mapping, Sequence


REGISTRY_PATH = Path("runtime/docs/contracts/ownership-map.json")
NOTE_PREFIX = "docs/implementation-notes/"
_FIELD_RE = re.compile(r"^([A-Za-z][A-Za-z0-9-]*):\s*(.*?)\s*$")
_REGULAR_TEST_PREFIXES = ("tests/", "desktop/tests/", "pyhfo/tests/")
_SUPPLEMENTAL_MARKERS = ("/e2e/", "supplemental", "smoke.mjs", "playwright")


@dataclass(frozen=True)
class ImpactDeclaration:
    path: str
    modules: frozenset[str]
    impact: str
    reason: str
    owners_changed: frozenset[str]
    proofs: tuple[str, ...]


@dataclass
class AuditResult:
    changed_paths: tuple[str, ...]
    impacted_modules: frozenset[str] = frozenset()
    candidate_owners: frozenset[str] = frozenset()
    selected_proofs: tuple[str, ...] = ()
    declarations: tuple[ImpactDeclaration, ...] = ()
    errors: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def _normalize_path(value: str | Path) -> str:
    normalized = str(value).replace("\\", "/").strip()
    while normalized.startswith("./"):
        normalized = normalized[2:]
    normalized = re.sub(r"/+", "/", normalized)
    if not normalized or normalized.startswith("/") or normalized == ".." or normalized.startswith("../"):
        raise ValueError(f"path must be repository-relative: {value!r}")
    if "/../" in f"/{normalized}/":
        raise ValueError(f"path traversal is forbidden: {value!r}")
    return normalized.rstrip("/")


def _matches(path: str, pattern: str) -> bool:
    return fnmatch.fnmatchcase(path, pattern) or (
        pattern.endswith("/**") and path == pattern[:-3].rstrip("/")
    )


def load_registry(repo_root: str | Path) -> dict:
    root = Path(repo_root).resolve()
    data = json.loads((root / REGISTRY_PATH).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("capabilities"), dict):
        raise ValueError("ownership registry must define capabilities")
    if not isinstance(data.get("rules"), list) or not isinstance(data.get("modules"), list):
        raise ValueError("ownership registry must define rules and modules")
    return data


def owners_for_path(path: str, registry: Mapping[str, object]) -> frozenset[str]:
    owners: set[str] = set()
    for rule in registry.get("rules", []):
        if not isinstance(rule, dict):
            continue
        pattern = str(rule.get("glob") or "")
        if pattern and _matches(path, pattern):
            owners.update(str(owner) for owner in (rule.get("owners") or []) if str(owner))
    return frozenset(owners)


def modules_for_path(path: str, registry: Mapping[str, object]) -> frozenset[str]:
    modules: set[str] = set()
    for rule in registry.get("modules", []):
        if not isinstance(rule, dict):
            continue
        pattern = str(rule.get("glob") or "")
        if pattern and _matches(path, pattern):
            name = str(rule.get("name") or "").strip()
            if name:
                modules.add(name)
    return frozenset(modules)


def is_production_path(path: str, registry: Mapping[str, object]) -> bool:
    return any(path.startswith(str(prefix)) for prefix in registry.get("production_roots", []))


def _parse_csv(values: Iterable[str]) -> frozenset[str]:
    parsed: set[str] = set()
    for value in values:
        parsed.update(item.strip() for item in value.split(",") if item.strip())
    return frozenset(parsed)


def parse_impact_note(path: str, text: str) -> ImpactDeclaration:
    fields: dict[str, list[str]] = {}
    for line in text.splitlines():
        match = _FIELD_RE.match(line.strip())
        if match:
            fields.setdefault(match.group(1), []).append(match.group(2).strip())

    modules = _parse_csv(fields.get("Modules", []))
    impacts = fields.get("Contract-Impact", [])
    reasons = fields.get("Contract-Impact-Reason", [])
    owners = _parse_csv(fields.get("Contract-Owners-Changed", []))
    proofs = tuple(
        dict.fromkeys(
            _normalize_path(item)
            for value in fields.get("Contract-Proof", [])
            for item in value.split(",")
            if item.strip()
        )
    )
    if len(impacts) != 1 or len(reasons) != 1:
        raise ValueError(
            f"{path}: exactly one Contract-Impact and Contract-Impact-Reason are required"
        )
    return ImpactDeclaration(
        path=path,
        modules=modules,
        impact=impacts[0],
        reason=reasons[0],
        owners_changed=owners,
        proofs=proofs,
    )


def _validate_registry(repo_root: Path, registry: Mapping[str, object]) -> list[str]:
    errors: list[str] = []
    capabilities = registry.get("capabilities", {})
    known = frozenset(str(item) for item in capabilities)
    for owner_id, value in capabilities.items():
        if not isinstance(value, dict):
            errors.append(f"{owner_id}: capability entry must be an object")
            continue
        document = str(value.get("document") or "")
        if not document or not (repo_root / document).is_file():
            errors.append(f"{owner_id}: missing contract document {document or '<empty>'}")
        proofs = value.get("proofs") or []
        if not proofs:
            errors.append(f"{owner_id}: at least one executable proof is required")
        for proof in proofs:
            proof_path = str(proof)
            if not _is_regular_test(proof_path) or not (repo_root / proof_path).is_file():
                errors.append(f"{owner_id}: missing or non-regular proof {proof_path}")
    for rule in registry.get("rules", []):
        if not isinstance(rule, dict):
            errors.append("ownership rule must be an object")
            continue
        unknown = sorted(set(str(item) for item in (rule.get("owners") or [])) - known)
        if unknown:
            errors.append(f"{rule.get('glob')}: unknown owners: {', '.join(unknown)}")
    return errors


def _is_regular_test(path: str) -> bool:
    normalized = str(path).replace("\\", "/")
    return (
        normalized.startswith(_REGULAR_TEST_PREFIXES)
        and normalized.endswith((".py", ".js", ".mjs"))
        and not any(marker in normalized.lower() for marker in _SUPPLEMENTAL_MARKERS)
    )


def audit_change_set(
    repo_root: str | Path,
    changed_paths: Sequence[str | Path],
    *,
    require_declarations: bool = True,
) -> AuditResult:
    root = Path(repo_root).resolve()
    normalized: list[str] = []
    errors: list[str] = []
    for value in changed_paths:
        try:
            path = _normalize_path(value)
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if path not in normalized:
            normalized.append(path)

    try:
        registry = load_registry(root)
    except (OSError, ValueError) as exc:
        errors.append(f"ownership registry is invalid: {exc}")
        return AuditResult(changed_paths=tuple(normalized), errors=errors)
    errors.extend(_validate_registry(root, registry))

    production_paths = [path for path in normalized if is_production_path(path, registry)]
    candidate_owners: set[str] = set()
    impacted_modules: set[str] = set()
    for path in production_paths:
        absolute = root / path
        if absolute.is_symlink():
            errors.append(f"production symlinks are forbidden: {path}")
        owners = owners_for_path(path, registry)
        if not owners:
            errors.append(f"production path has no contract owner: {path}")
        candidate_owners.update(owners)
        impacted_modules.update(modules_for_path(path, registry))

    declarations: list[ImpactDeclaration] = []
    for path in normalized:
        if not path.startswith(NOTE_PREFIX) or not path.endswith(".md"):
            continue
        if Path(path).name.lower() == "readme.md":
            continue
        note_path = root / path
        if not note_path.is_file():
            errors.append(f"changed implementation note is missing: {path}")
            continue
        try:
            declarations.append(parse_impact_note(path, note_path.read_text(encoding="utf-8")))
        except ValueError as exc:
            errors.append(str(exc))

    selected_proofs: list[str] = []
    if production_paths and require_declarations:
        for module in sorted(impacted_modules):
            matches = [declaration for declaration in declarations if module in declaration.modules]
            if len(matches) != 1:
                errors.append(
                    f"module {module} requires exactly one changed implementation note declaration; found {len(matches)}"
                )

        applicable = [
            declaration
            for declaration in declarations
            if declaration.modules & frozenset(impacted_modules)
        ]
        for declaration in applicable:
            if declaration.impact not in {"none", "changed"}:
                errors.append(f"{declaration.path}: Contract-Impact must be 'none' or 'changed'")
            if len(declaration.reason.strip()) < 20:
                errors.append(f"{declaration.path}: Contract-Impact-Reason must be substantive")
            if not declaration.proofs:
                errors.append(f"{declaration.path}: at least one Contract-Proof is required")
            for proof in declaration.proofs:
                if not _is_regular_test(proof) or not (root / proof).is_file():
                    errors.append(f"{declaration.path}: invalid regular proof {proof}")
                elif proof not in normalized:
                    errors.append(f"{declaration.path}: proof must be part of the same change set: {proof}")
                elif proof not in selected_proofs:
                    selected_proofs.append(proof)

            scoped_candidates = set()
            for path in production_paths:
                if modules_for_path(path, registry) & declaration.modules:
                    scoped_candidates.update(owners_for_path(path, registry))
            changed_docs = {
                owner_id
                for owner_id, item in registry.get("capabilities", {}).items()
                if isinstance(item, dict) and str(item.get("document") or "") in normalized
            }
            if declaration.impact == "none":
                if declaration.owners_changed:
                    errors.append(f"{declaration.path}: impact none forbids Contract-Owners-Changed")
                conflicting = sorted(changed_docs & scoped_candidates)
                if conflicting:
                    errors.append(
                        f"{declaration.path}: impact none conflicts with changed owner docs: {', '.join(conflicting)}"
                    )
            elif declaration.impact == "changed":
                if not declaration.owners_changed:
                    errors.append(f"{declaration.path}: impact changed requires Contract-Owners-Changed")
                unknown = sorted(declaration.owners_changed - frozenset(scoped_candidates))
                if unknown:
                    errors.append(f"{declaration.path}: non-candidate owners changed: {', '.join(unknown)}")
                missing_docs = sorted(declaration.owners_changed - frozenset(changed_docs))
                if missing_docs:
                    errors.append(
                        f"{declaration.path}: changed owner docs must be in the change set: {', '.join(missing_docs)}"
                    )
                for owner_id in sorted(declaration.owners_changed):
                    item = registry.get("capabilities", {}).get(owner_id, {})
                    if isinstance(item, dict):
                        for proof in item.get("proofs") or []:
                            if proof not in selected_proofs:
                                selected_proofs.append(str(proof))

    return AuditResult(
        changed_paths=tuple(normalized),
        impacted_modules=frozenset(impacted_modules),
        candidate_owners=frozenset(candidate_owners),
        selected_proofs=tuple(selected_proofs),
        declarations=tuple(declarations),
        errors=errors,
    )


def collect_changed_paths(
    repo_root: str | Path,
    *,
    staged: bool = False,
    base: str | None = None,
) -> tuple[str, ...]:
    root = Path(repo_root).resolve()
    if staged and base:
        raise ValueError("staged and base modes are mutually exclusive")
    if staged:
        commands = [["git", "diff", "--cached", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z"]]
    elif base:
        commands = [["git", "diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z", f"{base}...HEAD"]]
    else:
        commands = [
            ["git", "diff", "--no-renames", "--name-only", "--diff-filter=ACDMRTUXB", "-z"],
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
        ]
    paths: list[str] = []
    for command in commands:
        output = subprocess.check_output(command, cwd=root)
        for raw in output.decode("utf-8", errors="strict").split("\0"):
            if raw and raw not in paths:
                paths.append(_normalize_path(raw))
    return tuple(paths)


def _proof_environment(snapshot_root: Path) -> dict[str, str]:
    env = dict(os.environ)
    for key in list(env):
        if key.startswith("GIT_") or key in {"PYTHONPATH", "PYTEST_ADDOPTS", "NODE_OPTIONS"}:
            env.pop(key, None)
    env["PYTHONPATH"] = str(snapshot_root)
    return env


def _link_staged_proof_dependencies(source_root: Path, snapshot_root: Path) -> None:
    """Expose installed dependencies to an index-only proof snapshot.

    Dependency directories are intentionally untracked, so ``checkout-index``
    cannot materialize them.  Linking only ``node_modules`` preserves exact
    staged source while letting Node resolve the same lockfile-installed
    packages that CI prepared before invoking the gate.
    """
    for relative in (Path("desktop/node_modules"),):
        source = source_root / relative
        destination = snapshot_root / relative
        if not source.is_dir() or destination.exists():
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.symlink_to(source.resolve(), target_is_directory=True)


@contextmanager
def staged_index_snapshot(repo_root: str | Path) -> Iterator[Path]:
    """Materialize the exact Git index and expose only installed dependencies.

    The returned directory is the execution root for the *entire* staged audit,
    not only for proof execution.  Reading registry data, implementation notes,
    production file types, and proofs from one snapshot prevents unstaged
    worktree edits from changing the staged verdict.
    """

    root = Path(repo_root).resolve()
    with tempfile.TemporaryDirectory(prefix="ieeg-contract-index-") as directory:
        snapshot_root = Path(directory).resolve()
        subprocess.run(
            ["git", "checkout-index", "--all", "--force", f"--prefix={snapshot_root}/"],
            cwd=root,
            check=True,
        )
        _link_staged_proof_dependencies(root, snapshot_root)
        yield snapshot_root


def run_proofs(
    repo_root: str | Path,
    proofs: Sequence[str],
    *,
    staged_snapshot: bool = False,
) -> tuple[str, ...]:
    root = Path(repo_root).resolve()
    if staged_snapshot:
        with staged_index_snapshot(root) as execution_root:
            return run_proofs(execution_root, proofs)

    errors: list[str] = []
    execution_root = root
    missing = [proof for proof in proofs if not (execution_root / proof).is_file()]
    if missing:
        return tuple(f"proof missing from execution snapshot: {proof}" for proof in missing)
    python_proofs = [proof for proof in proofs if proof.endswith(".py")]
    node_proofs = [proof for proof in proofs if proof.endswith((".js", ".mjs"))]
    env = _proof_environment(execution_root)
    if python_proofs:
        completed = subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-o", "addopts=", *python_proofs],
            cwd=execution_root,
            env=env,
            text=True,
            capture_output=True,
        )
        if completed.returncode:
            errors.append(completed.stdout + completed.stderr)
    for proof in node_proofs:
        completed = subprocess.run(
            ["node", "--test", proof.removeprefix("desktop/")],
            cwd=execution_root / "desktop" if proof.startswith("desktop/") else execution_root,
            env=env,
            text=True,
            capture_output=True,
        )
        if completed.returncode:
            errors.append(completed.stdout + completed.stderr)
    return tuple(error.strip() for error in errors if error.strip())
