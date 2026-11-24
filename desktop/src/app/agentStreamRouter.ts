// Cross-turn frame router for the agent SSE bridge.
//
// The renderer subscribes to the shared 'agent:event' channel BEFORE it learns this
// turn's streamId — the id only comes back once `streamAgentMessage()` resolves. During
// that window the streamId filter cannot run, so a previous turn's late frames (main keeps
// reading an abandoned stream and emitting on the same channel) would be mistaken for this
// turn's, bleeding stray content and re-applying stale emit_ui_command entries.
//
// This router closes that gap: it buffers frames until the streamId is known, then replays
// only the ones that match and rejects the rest. Once resolved it filters live frames the
// same way. It is intentionally free of React/Electron imports so it can be unit-tested.

export type AgentEventPayload = { streamId?: string; event: string; data: unknown };

export interface AgentStreamRouter {
  /** Feed a raw frame delivered by onAgentEvent. */
  push(payload: AgentEventPayload): void;
  /** Called once this turn's streamId is known; drains buffered frames that belong to it. */
  resolve(streamId: string): void;
  /** Stop buffering and routing (teardown). */
  dispose(): void;
}

export function createAgentStreamRouter(handle: (payload: AgentEventPayload) => void): AgentStreamRouter {
  let streamId = '';
  let resolved = false;
  let disposed = false;
  let buffered: AgentEventPayload[] = [];

  // A frame belongs to this turn when it carries our streamId. If our streamId is empty
  // (the backend returned none — a single-stream fallback), accept everything, matching the
  // pre-router behavior. An untagged frame while we DO have an id is rejected (it isn't ours).
  const belongs = (p: AgentEventPayload): boolean => (streamId ? p.streamId === streamId : true);

  return {
    push(payload: AgentEventPayload): void {
      if (disposed) return;
      if (!resolved) {
        buffered.push(payload);
        return;
      }
      if (belongs(payload)) handle(payload);
    },
    resolve(id: string): void {
      if (disposed || resolved) return;
      streamId = id || '';
      resolved = true;
      const pending = buffered;
      buffered = [];
      // Drain in arrival order so content deltas stay contiguous. This block is synchronous, so no
      // live frame can interleave; but a buffered terminal frame can trigger finish() -> dispose()
      // mid-drain, so stop as soon as we're disposed to avoid resurrecting a settled turn.
      for (const p of pending) {
        if (disposed) break;
        if (belongs(p)) handle(p);
      }
    },
    dispose(): void {
      disposed = true;
      resolved = true;
      buffered = [];
    },
  };
}
