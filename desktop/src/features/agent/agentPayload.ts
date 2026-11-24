import type { WorkspaceState } from './uiCommands';

export function buildAgentPayload(message: string, _workspace: WorkspaceState, recordingPath?: string) {
  return {
    message,
    recording_path: recordingPath
  };
}


export const safetyCopy = 'Signal-derived candidates are research evidence, not definitive clinical pathology or treatment guidance.';
