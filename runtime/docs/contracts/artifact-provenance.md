# Artifact and provenance contract

Status: Canonical
Contract: IC-ARTIFACT

Reports, workbooks, session bundles and project files are writes. They require an
approved action where the catalog says so and produce a terminal receipt naming
artifact kind, safe display name, content hash, producing run(s), software and
schema version, warnings and completion status. A dialog opening or path proposal
is not an exported artifact.

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-ARTIFACT-001 | Export/project actions require confirmation and terminal artifact proof. | `tests/test_ui_action_contract.py` |
| IC-ARTIFACT-002 | Artifact lineage resolves recording, run, parameters and review revision. | `tests/test_clinical_evidence_contract.py` |
| IC-ARTIFACT-003 | Public output exposes safe artifact references, not unredacted local paths. | `tests/test_history_redaction_contract.py` |
| IC-ARTIFACT-004 | Partial/failed export cannot be narrated as complete. | `tests/test_ui_mcp_server_contract.py` |
