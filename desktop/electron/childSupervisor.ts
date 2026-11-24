// Pure restart-decision logic for supervised child processes (agent runtime, UI broker).
//
// The PyHFO backend has long been supervised; the agent runtime and UI broker were not, so an
// OOM-kill or crash left them dead until a full app restart. Adding supervision is subtle because
// those children are ALSO killed deliberately (the agent runtime restarts on a BYO-key change), and
// that intentional kill fires the same 'exit' event. This predicate centralizes every guard so the
// tricky matrix is unit-testable without spinning up Electron.

export interface RestartDecisionInput {
  /** The app is shutting down (before-quit). Never restart. */
  quitting: boolean;
  /** A deliberate kill+respawn is in progress (e.g. key change). That exit is not a crash. */
  intentionalRestart: boolean;
  /** The exiting process is still the active runtime (not already replaced by a newer one). */
  isCurrentRuntime: boolean;
  /** How many auto-restarts have already happened in the current budget window. */
  restartCount: number;
  /** Upper bound on auto-restarts before giving up (crash-loop backstop). */
  maxRestarts: number;
}

/**
 * Decide whether an unexpected child exit should trigger an automatic respawn. Returns false for
 * intentional shutdown, deliberate restarts, superseded runtimes, and an exhausted restart budget.
 */
export function shouldRestartOnExit(input: RestartDecisionInput): boolean {
  if (input.quitting) return false;
  if (input.intentionalRestart) return false;
  if (!input.isCurrentRuntime) return false;
  if (input.restartCount >= input.maxRestarts) return false;
  return true;
}

/**
 * Serializes restarts of a single child so two restart paths never overlap. The agent runtime is
 * restarted from THREE triggers — a crash (supervisor), a BYO-key change (IPC), and a UI-broker
 * re-point. If two fire close together, each would kill+respawn concurrently and leak a duplicate,
 * unsupervised process. This coordinator guarantees at most one restart runs at a time.
 *
 * Coalescing WITH real outcomes: a request made while one restart is in flight does not run
 * concurrently; instead it waits for a single fresh FOLLOW-UP run (so the latest desired state — a
 * new key, the new broker URL — is applied) and settles with THAT run's actual success/failure.
 * This is load-bearing: callers key off request()'s resolution (a crash-retry decides whether to
 * reschedule; the key-change IPC reports ok/error; a stability timer resets the crash budget). If a
 * coalesced request resolved eagerly before its restart actually ran, a caller could log a false
 * success, skip its retry, and reset the budget against a dead process — leaving the child
 * permanently down. So every caller, coalesced or not, is told what really happened.
 *
 * No unhandled rejections: a follow-up run's failure is delivered to the waiting callers' promises;
 * the internally-scheduled follow-up's own promise has no other consumer and is explicitly caught.
 */
export class RestartCoordinator {
  private inFlight = false;
  private waiters: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];

  constructor(private readonly run: () => Promise<void>) {}

  /** True while a restart is actively running — feed this as `intentionalRestart` to the supervisor. */
  isBusy(): boolean {
    return this.inFlight;
  }

  request(): Promise<void> {
    if (this.inFlight) {
      // Coalesce: wait for a fresh follow-up run and settle with its real outcome.
      return new Promise<void>((resolve, reject) => { this.waiters.push({ resolve, reject }); });
    }
    return this.drive();
  }

  private async drive(): Promise<void> {
    this.inFlight = true;
    // This run answers everyone who was already waiting for a fresh restart when it started.
    const owned = this.waiters;
    this.waiters = [];
    try {
      await this.run();
      for (const w of owned) w.resolve();
    } catch (error) {
      for (const w of owned) w.reject(error);
      throw error; // propagate to the direct caller of this run
    } finally {
      this.inFlight = false;
      if (this.waiters.length > 0) {
        // Requests arrived during this run; give them one fresh follow-up. Its outcome reaches those
        // callers via their own promises, so its returned promise has no other consumer — catch it.
        void this.drive().catch(() => { /* waiting callers already carry this outcome */ });
      }
    }
  }
}
