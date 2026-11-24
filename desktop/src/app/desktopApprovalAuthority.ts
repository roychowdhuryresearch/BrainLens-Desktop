export type AgentCommandAckContext = {
  sessionId: string;
  conversationId: string;
  stateRevision: string;
  humanApprovalNonce?: string;
};

const EXECUTION_STATUSES = new Set(['applied', 'running', 'complete']);

export function buildDesktopApprovalActor(
  context: AgentCommandAckContext | undefined,
  fallbackSessionId: string,
  actorScope: string,
): Record<string, string> {
  const humanApproved = Boolean(context?.humanApprovalNonce);
  return {
    role: humanApproved ? 'clinician' : 'service',
    actor_id: `${humanApproved ? 'desktop-clinician' : 'desktop-agent-service'}-${actorScope}`,
    session_id: context?.sessionId || fallbackSessionId,
    source: humanApproved
      ? `desktop_human_apply:${context!.humanApprovalNonce}`
      : 'desktop_renderer',
  };
}

export function bindDesktopApprovalContext(
  outcome: Record<string, unknown>,
  context: AgentCommandAckContext | undefined,
  fallbackSessionId: string,
  actorScope: string,
  fallbackConversationId: string,
  fallbackStateRevision: string,
): Record<string, unknown> {
  const rawStatus = String(outcome.status || '').trim().toLowerCase();
  const status = rawStatus === 'success' ? 'complete' : rawStatus;
  return {
    ...outcome,
    ...(EXECUTION_STATUSES.has(status)
      ? { approval_actor: buildDesktopApprovalActor(context, fallbackSessionId, actorScope) }
      : {}),
    conversation_id: context?.conversationId || fallbackConversationId,
    state_revision: context?.stateRevision || fallbackStateRevision,
  };
}
