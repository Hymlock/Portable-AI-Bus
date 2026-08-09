/**
 * The wake loop. A long-lived process that owns a seat.
 *
 *   wait for wake  ->  drain mail  ->  brain.takeTurn()  ->  wait for wake  ->  ...
 *
 * It never exits because a brain finished reporting. That single property is what this whole
 * module exists for; everything else here is bookkeeping around it.
 */

import { Brain, BrainMessage, BrainTools, WakeReason, WakeResult } from './contract';

export type BusClient = {
  /** Blocks until mail arrives or the deadline passes. Resolves 'mail' or 'timeout'. */
  listen(seat: string, deadlineSeconds: number): Promise<'mail' | 'timeout'>;
  read(seat: string): Promise<BrainMessage[]>;
  tools(seat: string): BrainTools;
};

export type RunnerOptions = {
  seat: string;
  brain: Brain;
  bus: BusClient;
  /**
   * Called when the brain reports that every provider in its chain is spent.
   *
   * This is the endgame Hymlock asked about: the orchestrating seat runs out of tokens. The
   * runner cannot fix that - no provider left means no thinking - but it CAN make the failure
   * loud and hand the baton to a seat that still has credit, instead of going quiet and
   * looking like it is working.
   */
  onExhausted?: (info: { seat: string; detail: string }) => Promise<void> | void;
  /** Tool calls allowed per wake. Bounds a runaway brain without ending the process. */
  budgetPerWake?: number;
  /** How long a quiet listen blocks before looping. Not a timeout on the agent. */
  listenSeconds?: number;
  /** Stop after N wakes. For tests only — production runs unbounded. */
  maxWakes?: number;
  log?: (event: string, data?: unknown) => void;
  /** Resolves when the caller wants a graceful stop. */
  stopSignal?: Promise<void>;
};

export type RunnerSummary = {
  wakes: number;
  cappedWakes: number;
  errors: number;
  stoppedBy: 'signal' | 'maxWakes';
};

const DEFAULT_BUDGET = 30;
const DEFAULT_LISTEN_SECONDS = 300;

export async function runBrain(options: RunnerOptions): Promise<RunnerSummary> {
  const {
    seat,
    brain,
    bus,
    budgetPerWake = DEFAULT_BUDGET,
    listenSeconds = DEFAULT_LISTEN_SECONDS,
    maxWakes,
    log = () => {},
    stopSignal
  } = options;

  let stopped = false;
  void stopSignal?.then(() => {
    stopped = true;
    log('stop-requested', { seat });
  });

  await brain.start?.();

  const summary: RunnerSummary = { wakes: 0, cappedWakes: 0, errors: 0, stoppedBy: 'signal' };
  let reason: WakeReason = 'startup';

  try {
    while (!stopped) {
      if (maxWakes !== undefined && summary.wakes >= maxWakes) {
        summary.stoppedBy = 'maxWakes';
        break;
      }

      // Drain BEFORE deciding to wait. `listen` returns instantly while mail is unread and only
      // holds a lease while genuinely blocked, so a loop that listens without draining spins and
      // leaves the seat unattended while reporting success. That is a real failure this project
      // hit twice; draining first makes it structurally impossible here.
      let messages = await bus.read(seat);

      if (messages.length === 0 && reason !== 'startup') {
        const outcome = await bus.listen(seat, listenSeconds);
        if (stopped) break;
        reason = outcome === 'mail' ? 'mail' : 'timeout';
        if (outcome === 'mail') {
          messages = await bus.read(seat);
        }
      } else if (messages.length > 0) {
        reason = 'mail';
      }

      summary.wakes += 1;
      let calls = 0;
      const counted: BrainTools = wrapWithBudget(bus.tools(seat), () => {
        calls += 1;
        if (calls > budgetPerWake) {
          throw new BudgetExceededError(seat, budgetPerWake);
        }
      });

      let result: WakeResult = { done: true };
      try {
        result = await brain.takeTurn({
          seat,
          reason,
          messages,
          tools: counted,
          budget: budgetPerWake,
          log
        });
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          summary.cappedWakes += 1;
          result = { done: true, capped: true, note: error.message };
          log('wake-capped', { seat, budget: budgetPerWake });
        } else {
          // A brain that throws must not take the process with it. The seat stays attended and
          // the next wake gets a fresh chance - an agent that dies on one bad message is the
          // stall we are removing, not a stall we should reintroduce here.
          summary.errors += 1;
          log('wake-error', { seat, error: (error as Error)?.message ?? String(error) });
        }
      }

      // A brain signals a spent chain by returning `exhausted`. Distinct from an error on
      // purpose: an error is a bad wake, exhaustion is a seat that cannot have a good one.
      if (result.exhausted) {
        log('chain-exhausted', { seat, note: result.note });
        try {
          await options.onExhausted?.({ seat, detail: result.note ?? 'all providers spent' });
        } catch (error) {
          log('exhausted-handler-failed', { seat, error: (error as Error)?.message });
        }
      }

      log('wake-complete', {
        seat,
        reason,
        messages: messages.length,
        calls,
        done: result.done,
        capped: result.capped ?? false,
        note: result.note
      });

      // NOTE: `result.done` is deliberately NOT a reason to leave this loop. It means this
      // wake's work finished. The agent is still alive and still owns the seat.
      reason = 'timeout';
    }
  } finally {
    await brain.stop?.().catch(() => {});
  }

  log('runner-stopped', summary);
  return summary;
}

export class BudgetExceededError extends Error {
  constructor(seat: string, budget: number) {
    super(`seat ${seat} used its ${budget}-call budget for this wake`);
    this.name = 'BudgetExceededError';
  }
}

function wrapWithBudget(tools: BrainTools, onCall: () => void): BrainTools {
  return {
    send: (input) => { onCall(); return tools.send(input); },
    status: () => { onCall(); return tools.status(); },
    claim: (paths, why) => { onCall(); return tools.claim(paths, why); },
    release: (paths) => { onCall(); return tools.release(paths); },
    runCapability: (id, timeoutMs) => { onCall(); return tools.runCapability(id, timeoutMs); }
  };
}
