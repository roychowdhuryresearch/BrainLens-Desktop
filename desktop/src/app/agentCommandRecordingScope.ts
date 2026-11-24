import type { UICommand } from '../features/agent/uiCommands';

function normalizedRecordingLocator(value: unknown): string {
  const normalized = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

/** Reject a compute command unless its immutable broker recording scope is this loaded file. */
export function agentCommandRecordingScopeError(
  command: UICommand,
  currentRecordingPath: string | null,
  currentRecordingFingerprint?: string | null,
): string | null {
  if (!currentRecordingPath) return 'No recording is loaded.';
  const requestedPath = normalizedRecordingLocator(command.payload.input_path);
  if (requestedPath && requestedPath !== normalizedRecordingLocator(currentRecordingPath)) {
    return 'The command input_path is not the recording currently loaded in this workspace.';
  }
  const payloadFingerprint = String(command.payload.recording_fingerprint || '').trim().toLowerCase();
  const resourceFingerprint = String(command.resource_scope?.recording_sha256 || '').trim().toLowerCase();
  const fingerprints = [payloadFingerprint, resourceFingerprint].filter(Boolean);
  if (fingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value))) {
    return 'The command recording fingerprint is invalid.';
  }
  if (new Set(fingerprints).size > 1) {
    return 'The command payload and broker resource scope identify different recordings.';
  }
  const scopedFingerprint = fingerprints[0] || '';
  if (command.command_id.startsWith('mcp-') && !scopedFingerprint) {
    return 'The broker command is missing a recording fingerprint and must be re-issued.';
  }
  const currentFingerprint = String(currentRecordingFingerprint || '').trim().toLowerCase();
  if (scopedFingerprint && !/^[a-f0-9]{64}$/.test(currentFingerprint)) {
    return 'The loaded recording has no verifiable fingerprint; reload it before applying this command.';
  }
  if (scopedFingerprint && scopedFingerprint !== currentFingerprint) {
    return 'The command fingerprint does not match the recording currently loaded in this workspace.';
  }
  return null;
}
