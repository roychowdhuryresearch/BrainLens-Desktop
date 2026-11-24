# Control and evaluation contract

Status: Canonical
Contract: IC-CONTROL

Control endpoints require a configured service token, a supported contract
version and a matching actor/conversation/request scope. An unconfigured
runtime returns HTTP 503 before dispatch. A configured runtime returns HTTP
401 for a missing or incorrect bearer token. Preview and evaluation are no-side-
effect operations. Synthetic evaluations are bounded, labelled and isolated from
clinical/project history.

| ID | Requirement | Proof |
| --- | --- | --- |
| IC-CONTROL-001 | Confirm, reject, cancel, rollback and resume are actor/scope bound. | `tests/test_operation_safety_contract.py` |
| IC-CONTROL-002 | Preview/eval cannot call side-effecting tools or mutate history. | `tests/test_product_agent_eval.py` |
| IC-CONTROL-003 | Unsupported protocol versions fail before control state mutation. | `tests/test_internal_agent_contract_strong.py` |
| IC-CONTROL-004 | Clinical negative evals cover false completion and unsupported claims. | `tests/test_clinical_evidence_contract.py` |
| IC-CONTROL-005 | Internal endpoints reject requests until the operator or desktop supplies the service token. | `tests/test_api_internal_audit.py` |
