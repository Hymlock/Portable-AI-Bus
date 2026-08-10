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
  /**
   * Message kinds that are pure courtesy: they inform, and they never need an answer.
   *
   * A wake carrying ONLY these does not reach the brain, so it costs no model call. This is not
   * an optimisation, it is a termination condition. Two brains that each acknowledge every
   * message they receive will acknowledge each other's acknowledgements forever, and both are
   * behaving exactly as instructed. Observed live between the codex and grok seats: a relay test
   * completed correctly, then the receipts alone kept both seats calling the model until they
   * were killed.
   *
   * The prompt already says "acknowledge every message". It cannot also say "except this one" and
   * be relied on - a model asked to reply will reply. So the loop is cut where it can be cut
   * deterministically: no model call, therefore no reply, therefore no next wake.
   */
  ackKinds?: string[];
  /**
   * Call the brain on an idle timeout wake — one with no mail at all.
   *
   * Off by default. On, every seat pays a model call per listen window forever whether or not
   * anything is happening, which on Windows also means a console flash per call.
   */
  thinkWhenIdle?: boolean;
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
const DEFAULT_ACK_KINDS = ['ack', 'receipt', 'ping'];

export async function runBrain(options: RunnerOptions): Promise<RunnerSummary> {
  const {
    seat,
    brain,
    bus,
    budgetPerWake = DEFAULT_BUDGET,
    listenSeconds = DEFAULT_LISTEN_SECONDS,
    maxWakes,
    ackKinds = DEFAULT_ACK_KINDS,
    thinkWhenIdle = false,
    log = () => {},
    stopSignal
  } = options;
  const isAck = (message: BrainMessage) =>
    ackKinds.includes(String((message as { kind?: unknown }).kind ?? '').trim().toLowerCase());

  let stopped = false;
  void stopSignal?.then(() => {
    stopped = true;
    log('stop-requested', { seat });
  });

  await brain.start?.();

  const summary: RunnerSummary = { wakes: 0, cappedWakes: 0, errors: 0, stoppedBy: 'signal' };
  let reason: WakeReason = 'startup';
  /**
   * Did the last turn end with work still to do?
   *
   * Carried across iterations so a seat can finish something that does not fit in one wake.
   * Without it, a long task can only ever advance when someone happens to send mail.
   */
  let hasOpenWork = false;

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

      if (messages.length === 0 && reason !== 'startup' && !hasOpenWork) {
        const outcome = await bus.listen(seat, listenSeconds);
        if (stopped) break;
        reason = outcome === 'mail' ? 'mail' : 'timeout';
        if (outcome === 'mail') {
          messages = await bus.read(seat);
        }
      } else if (messages.length > 0) {
        reason = 'mail';
      } else if (hasOpenWork) {
        // Do not spend a listen window on a seat that already knows what it is doing. Blocking
        // here for `listenSeconds` is what turned "I have more to do" into a five-minute pause
        // per step, which is indistinguishable from a stall to anyone watching.
        reason = 'timeout';
      }

      summary.wakes += 1;

      // Cut the ack loop here, BEFORE any model call. The messages are still drained and still
      // counted, so nothing is lost and the log records that they arrived - they simply do not
      // earn a reply, which is the only property that ends the exchange.
      if (messages.length > 0 && messages.every(isAck)) {
        log('wake-acks-only', {
          seat,
          messages: messages.length,
          kinds: [...new Set(messages.map((m) => (m as { kind?: unknown }).kind))]
        });
        reason = 'timeout';
        continue;
      }

      // An IDLE timeout wake carries no mail and no startup work. Thinking about nothing costs a
      // full model call - and on Windows each of those spawns the agent CLI, which spawns `git`,
      // which flashes a console window. Three seats at a 300s listen is a model call every 100
      // seconds forever, on a bus where nothing is happening.
      //
      // `thinkWhenIdle` restores the old behaviour for anyone who wants a seat that acts
      // unprompted. It is off by default because "no mail" is the overwhelmingly common case and
      // the cost is paid on every seat, forever.
      // ...unless the seat left work UNFINISHED. `done: false` means "I have more to do", and a
      // seat that says so must get another turn without waiting for someone to write to it.
      //
      // This is the regression that made the idle-skip dangerous. Two seats were given
      // multi-step audits, acknowledged them, and stopped - grok logged `messages:1, calls:0`
      // and worker's own note read "Audit remains open". Nothing was broken and nothing was
      // working: no mail meant no wake, no wake meant no thinking, and open work could never
      // resume. Silence again looked exactly like progress.
      if (reason === 'timeout' && messages.length === 0 && !thinkWhenIdle && !hasOpenWork) {
        log('wake-idle-skipped', { seat });
        continue;
      }

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

      // Carry "unfinished" into the next iteration, but NOT past an exhausted chain or a capped
      // wake. A seat with no provider left cannot continue by trying harder, and a brain that
      // just burned its whole budget is the last thing to hand another turn to immediately -
      // both would spin at full speed on a problem they cannot solve.
      hasOpenWork = result.done === false && !result.exhausted && !result.capped;

      log('wake-complete', {
        seat,
        reason,
        messages: messages.length,
        calls,
        done: result.done,
        capped: result.capped ?? false,
        continuing: hasOpenWork,
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
