# Integrated iEEG Agent v1 contracts and desktop capabilities

Modules: runtime, ui_mcp, desktop, electron, pyhfo, contracts
Contract-Impact: changed
Contract-Impact-Reason: Establishes versioned Agent wire, stream, action-receipt, scoped-state, research-evidence, and severity-scoring boundaries while preserving explicit compatibility paths for local provider profiles and opt-in artifact retention.
Contract-Owners-Changed: IC-RUNTIME, IC-ACTION, IC-EVIDENCE, IC-SESSION, IC-ANALYSIS, IC-ARTIFACT, IC-HISTORY, IC-CONTROL
Contract-Proof: tests/test_ieeg_cross_layer_contracts.py
Contract-Proof: tests/test_contract_gate.py
Contract-Proof: tests/test_execution_attestation.py
Contract-Proof: tests/test_pyhfo_active_recording.py
Contract-Proof: tests/test_pyhfo_authority_guard.py
Contract-Proof: tests/test_stream_contract.py
Contract-Proof: tests/test_ui_action_contract.py
Contract-Proof: tests/test_backend_cli.py
Contract-Proof: pyhfo/tests/test_agent_api_batch.py
Contract-Proof: pyhfo/tests/test_agent_api_detection.py
Contract-Proof: pyhfo/tests/test_agent_api_preprocessing.py
Contract-Proof: pyhfo/tests/test_agent_api_recording_info.py
Contract-Proof: pyhfo/tests/test_agent_api_sessions.py
Contract-Proof: pyhfo/tests/test_severity_scoring.py
Contract-Proof: pyhfo/tests/test_agent_api_sidecar_web.py
Contract-Proof: desktop/tests/agent-command-recording-scope.test.js
Contract-Proof: desktop/tests/agent-semantic-stream-contract.test.js
Contract-Proof: desktop/tests/agent-terminal-proof-contract.test.js
Contract-Proof: desktop/tests/staged-command-authorization.test.js
Contract-Proof: desktop/tests/desktop-approval-authority.test.js
Contract-Proof: desktop/tests/llm-profile-contract.test.js
Contract-Proof: desktop/tests/llm-key-storage.test.js
Contract-Proof: desktop/tests/llm-key-panel-contract.test.js
Contract-Proof: desktop/tests/artifact-retention.test.js

The change makes request identity, conversation and state scope, public stream
projection, human approval, terminal receipts, clinical evidence, provenance,
history finalization, and observability redaction executable compatibility
boundaries. Unsupported protocol versions, stale scope, actor mismatch,
unproven terminal completion, and unsupported research claims fail closed.

Each asynchronous turn now carries an immutable UI-thread/backend-conversation
scope through streaming, polling, command execution, late replies, and errors;
canonical stream frames and nested commands are rejected before renderer
delivery when their request, conversation, or current-message identity crosses
that scope. Broker issuance freezes the trusted session, revision, resource,
recording fingerprint, and stable idempotency identity in durable receipts so a
restart cannot broaden or replay authority against a different workspace.

Desktop-owned compute and artifact operations remain staged until an authorized
renderer action is durably acknowledged. Runtime-to-desktop handoffs are issued
by the canonical local broker, fail closed when that boundary is unavailable,
and use a freshly minted bearer token for every broker process. Compute
completion requires backend result readback, while project, batch-manifest, and
export completion additionally requires existence readback plus the SHA-256 of
the final file. Severity scoring is added as a recording-bound scalp-EEG
research measurement with explicit model, parameter, recording, result, and
artifact-quality evidence; unavailable artifact screening never silently
relabels raw segments as clean, and severity is neither a diagnosis nor iEEG
evidence.

Provider-bound LLM profiles remain local and encrypted, bind credentials to the
selected provider and endpoint, and preserve the explicit legacy-key migration
path. Artifact retention preserves durable result artifacts and is startup
opt-in while project-reference pinning is unavailable, preventing an upgrade
from silently deleting reopenable workspace state.

The v1 protocols preserve the documented compatibility adapters while making
unsafe legacy mutations, missing contract identity, stale run references, and
false completion claims explicit errors rather than implicit success.
