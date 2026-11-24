# Analysis, detection and classification contract

Status: Canonical
Contracts: IC-ANALYSIS, IC-EVIDENCE

QC, spectral analysis, detection, classification and ranking are explicit run
operations. Their effective parameters are validated against recording metadata
before execution. Nyquist, filter ordering, detector compatibility, model asset
availability and channel scope fail deterministically.

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-ANALYSIS-001 | Detection requires explicit biomarker, detector, parameters/preset and channel scope. | `tests/test_ui_mcp_server_contract.py` |
| IC-ANALYSIS-002 | Filter bounds and Nyquist constraints are checked before compute. | `desktop/tests/prepare-controls-nyquist.test.js` |
| IC-ANALYSIS-003 | Classification identifies model/version and never silently changes the selected run. | `tests/test_pyhfo_tools.py` |
| IC-ANALYSIS-004 | Candidate ranking binds to exactly one explicit run unless comparison is requested. | `tests/test_clinical_evidence_contract.py` |
| IC-ANALYSIS-005 | Partial channel failures and cancellations remain visible in output and provenance. | `tests/test_clinical_evidence_contract.py` |
| IC-ANALYSIS-006 | Co-pilot analysis writes route through `ieeg_ui`; deprecated environment flags and tool arguments cannot self-authorize direct execution. | `tests/test_pyhfo_authority_guard.py` |
