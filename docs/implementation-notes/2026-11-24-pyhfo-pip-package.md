# Installable PyHFO headless engine

Modules: pyhfo, runtime, desktop, electron, contracts
Contract-Impact: none
Contract-Impact-Reason: Distribution and module paths change together in the engine, process launchers and capability maps. Each host retains its existing HTTP, MCP and CLI action schemas, approval checks, run identity and terminal receipts. Package version metadata is additive; older sessions retain their original provenance. The engine resolves default state under the user's PyHFO home and reads existing explicit paths.
Contract-Proof: pyhfo/tests/test_agent_api_detection.py
Contract-Proof: pyhfo/tests/test_agent_mcp_protocol.py
Contract-Proof: pyhfo/tests/test_packaged_runtime.py
Contract-Proof: pyhfo/tests/test_severity_scoring.py
Contract-Proof: pyhfo/tests/test_hf_onnx_registry.py
Contract-Proof: tests/test_backend_cli.py
Contract-Proof: tests/test_ui_action_contract.py
Contract-Proof: desktop/tests/source-contract.test.js
Contract-Proof: desktop/tests/onnx-package-contract.test.js

The standalone distribution includes the command catalog and UI resources. The
catalog proof compares the packaged resource with the canonical command catalog.
An install-only test exercises the console scripts, offline HFO detection and
session persistence from outside the checkout.

An enabled classifier with no model selection uses the CPU ONNX preset across
CLI, MCP and HTTP detection. Explicit sources retain precedence. Results record
the preset and the loaded model type alongside the resolved model sources.
The MCP stdio transport sends engine progress to stderr during tool execution.
