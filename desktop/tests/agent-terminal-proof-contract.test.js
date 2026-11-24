import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');

test('agent compute completions carry backend result digests and command scope', () => {
  assert.match(app, /function backendComputeTerminalProof[\s\S]*source: 'backend_readback'[\s\S]*backend_status: status[\s\S]*result_sha256: canonicalJsonSha256\(result\)/);
  assert.match(app, /const terminalProof = backendComputeTerminalProof\(result, \{[\s\S]{0,180}recording_fingerprint: recordingFingerprint,[\s\S]{0,80}run_id: activeRun\.runId/);
  assert.match(app, /terminalProof = backendComputeTerminalProof\(result, \{[\s\S]{0,100}run_id: consensusRun\.runId/);
  assert.match(app, /const terminalProof = backendComputeTerminalProof\(result\);[\s\S]{0,500}Agent batch run/);
  assert.match(app, /Backend consensus failed; no agent-approved renderer fallback was applied/);
});

test('agent artifact completions require backend existence readback and actual SHA-256', () => {
  assert.match(app, /function backendArtifactTerminalProof[\s\S]*result\.artifact_exists !== true[\s\S]*SHA256_HEX_PATTERN\.test\(artifactSha256\)/);
  assert.match(app, /artifact_exists: true,[\s\S]*artifact_sha256: artifactSha256,[\s\S]*result_sha256: canonicalJsonSha256\(result\)/);
  assert.equal((app.match(/backendArtifactTerminalProof\(/g) || []).length, 5,
    'helper definition plus project, batch manifest, session, and report/workbook call sites must remain covered');
  assert.match(app, /Save session cancelled by user\.', undefined, 'failed', \{ code: 'cancelled'/);
  assert.match(app, /`\$\{label\} cancelled by user\.`, undefined, 'failed', \{ code: 'cancelled'/);
});
