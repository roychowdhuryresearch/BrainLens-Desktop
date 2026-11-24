export type BrokerCommandLike = { command_id: string };

export type BrokerCommandOutcome = {
  status: string;
  reason: string | null;
};

export type BrokerCommandDispatch = {
  commandId: string;
  shouldAcknowledge: boolean;
  outcome: BrokerCommandOutcome | null;
};

// The same command can arrive on the SSE stream and the UI-broker poll.  The
// first channel owns execution and acknowledgement; the second must become a
// true no-op rather than overwriting a running/terminal receipt as "unknown".
export function dispatchBrokerCommand<T extends BrokerCommandLike>(
  raw: unknown,
  options: {
    normalize: (value: unknown) => T | null;
    isRecorded: (commandId: string) => boolean;
    apply: (command: T) => BrokerCommandOutcome | null;
  },
): BrokerCommandDispatch {
  const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const rawCommandId = typeof rawRecord.command_id === 'string' ? rawRecord.command_id : '';
  const command = options.normalize(raw);
  if (!command) {
    return {
      commandId: rawCommandId,
      shouldAcknowledge: Boolean(rawCommandId),
      outcome: { status: 'rejected', reason: 'command not recognized' },
    };
  }
  if (options.isRecorded(command.command_id)) {
    return { commandId: command.command_id, shouldAcknowledge: false, outcome: null };
  }
  return {
    commandId: command.command_id,
    shouldAcknowledge: true,
    outcome: options.apply(command) ?? {
      status: 'rejected',
      reason: 'command could not be recorded',
    },
  };
}
