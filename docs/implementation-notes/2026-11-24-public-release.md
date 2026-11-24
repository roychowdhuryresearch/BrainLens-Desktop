# Public release configuration and authentication

Modules: runtime, electron, contracts
Contract-Impact: changed
Contract-Impact-Reason: Internal API requests now return HTTP 503 until the runtime receives a service token. Configured clients retain the existing bearer authentication, wire formats, approval checks and evidence requirements.
Contract-Owners-Changed: IC-CONTROL
Contract-Proof: tests/test_api_internal_audit.py
Contract-Proof: tests/test_backend_cli.py
Contract-Proof: tests/test_auth_service_jwt_secret_env.py
Contract-Proof: tests/test_backend_memory_client_regression.py
Contract-Proof: tests/test_memory_service_runtime_cache.py
Contract-Proof: tests/test_storage_service.py
Contract-Proof: tests/test_config_manager_env_expansion.py
Contract-Proof: tests/test_runtime_bootstrap_cache.py
Contract-Proof: tests/test_runtime_robustness.py
Contract-Proof: tests/test_product_agent_eval.py
Contract-Proof: tests/test_eeg_skill_entrypoint.py
Contract-Proof: desktop/tests/llm-key-storage.test.js
Contract-Proof: desktop/tests/external-qa-gates-runtime.test.js

The desktop generates a service token when it starts its own runtime. Operators
starting a standalone runtime supply the token to the server and its clients.
Connecting a durable memory service requires its own credential. Initializing
a user database creates its schema without provisioning accounts.

Attachments use the local file store by default. Installations with objects
in an existing S3-compatible store can select the S3 backend and configure
the same endpoint, buckets and AWS SDK credentials. Uploaded attachment
records continue to identify objects by bucket and key.

Runtime configuration, skills and the bundled engine resolve within the checkout
unless the operator configures an alternate location. Saved LLM credentials
are reused only for their configured endpoint.

Desktop QA scripts accept operator-selected recordings. Trajectory evaluations
resolve their scenario fixture relative to the checkout or accept the path
visible to a remote runtime through IEEG_EVAL_RECORDING.
