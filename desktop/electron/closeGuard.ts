export type ClosePromptKind = 'none' | 'unsaved-workspace' | 'save-still-running' | 'discard-prompt-active';

export type CloseGuardState = {
  workspaceDirty: boolean;
  allowUnsafeClose: boolean;
  closeSaveInProgress: boolean;
  closeDiscardPromptInProgress: boolean;
  closePrimaryPromptInProgress?: boolean;
};

export function closePromptForState(state: CloseGuardState): ClosePromptKind {
  if (!state.workspaceDirty || state.allowUnsafeClose) return 'none';
  // A primary unsaved-workspace dialog is already open — suppress a duplicate that a
  // concurrent close (Cmd-Q while the sheet is up) would otherwise stack, avoiding the
  // Save-vs-Discard race between the two sheets.
  if (state.closePrimaryPromptInProgress) return 'discard-prompt-active';
  if (!state.closeSaveInProgress) return 'unsaved-workspace';
  return state.closeDiscardPromptInProgress ? 'discard-prompt-active' : 'save-still-running';
}
