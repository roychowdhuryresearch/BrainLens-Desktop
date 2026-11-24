export type StagedCommandScope = {
  sessionId: string;
  conversationId: string;
  stateRevision: string;
};

export function stagedCommandScopeError(
  captured: StagedCommandScope | undefined,
  current: StagedCommandScope,
): string | null {
  if (!captured) return 'The command has no captured broker scope and must be re-issued.';
  for (const field of ['sessionId', 'conversationId', 'stateRevision'] as const) {
    if (!captured[field] || captured[field] !== current[field]) {
      return `The staged command has stale ${field} scope and must be re-issued.`;
    }
  }
  return null;
}

export async function authorizeStagedCommandExecution(
  commandId: string,
  outcome: Record<string, unknown>,
  capturedScope: StagedCommandScope | undefined,
  currentScope: StagedCommandScope,
  acknowledge: (request: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const scopeError = stagedCommandScopeError(capturedScope, currentScope);
  if (scopeError) throw new Error(scopeError);
  if (!commandId.startsWith('mcp-')) {
    throw new Error('Write command was not issued by the canonical UI broker.');
  }
  const response = await acknowledge({ command_id: commandId, outcome });
  const record = response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, unknown>
    : {};
  const receipt = record.receipt && typeof record.receipt === 'object' && !Array.isArray(record.receipt)
    ? record.receipt as Record<string, unknown>
    : {};
  const actor = receipt.actor && typeof receipt.actor === 'object' && !Array.isArray(receipt.actor)
    ? receipt.actor as Record<string, unknown>
    : {};
  if (
    record.ok !== true
    || receipt.command_id !== commandId
    || receipt.status !== 'applied'
    || receipt.terminal !== false
    || receipt.conversation_id !== capturedScope!.conversationId
    || receipt.state_revision !== capturedScope!.stateRevision
    || receipt.approval_role !== 'clinician'
    || actor.role !== 'clinician'
  ) {
    throw new Error('The UI broker did not durably authorize this command.');
  }
  return record;
}

export async function authorizeAndExecuteFreshStagedCommand(options: {
  commandId: string;
  outcome: Record<string, unknown>;
  capturedScope: StagedCommandScope;
  readCurrentScope: () => StagedCommandScope;
  acknowledge: (request: Record<string, unknown>) => Promise<unknown>;
  rejectAuthorized: (reason: string) => Promise<unknown>;
  execute: () => void;
}): Promise<{ executed: boolean; scopeError: string | null }> {
  await authorizeStagedCommandExecution(
    options.commandId,
    options.outcome,
    options.capturedScope,
    options.readCurrentScope(),
    options.acknowledge,
  );

  // This second read occurs after the awaited broker round-trip. execute() is called in the same
  // synchronous continuation, so no renderer state update can interleave between the check and the
  // side effect dispatch.
  const scopeError = stagedCommandScopeError(options.capturedScope, options.readCurrentScope());
  if (scopeError) {
    try {
      await options.rejectAuthorized(scopeError);
    } catch {
      // The authorization receipt may remain non-terminal if the broker vanished, but execution is
      // still forbidden. A later retry must use a newly issued command in the new scope.
    }
    return { executed: false, scopeError };
  }
  options.execute();
  return { executed: true, scopeError: null };
}
