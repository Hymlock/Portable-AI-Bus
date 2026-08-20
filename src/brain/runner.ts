/**
 * The wake loop. A long-lived process that owns a seat.
 *
 *   wait for wake  ->  drain mail  ->  brain.takeTurn()  ->  wait for wake  ->  ...
 *
 * It never exits because a brain finished reporting. That single property is what this whole
 * module exists for; everything else here is bookkeeping around it.
 */

import { Brain, BrainMessage, BrainTools, WakeReason, WakeResult } from './contract';
import { RecoveryCheckpoint } from '../mailbox';
import { StallLedger, StallOutcome } from './stall-ledger';

export type BusClient = {
  /** Blocks until mail arrives or the deadline passes. Resolves 'mail' or 'timeout'. */
  listen(
    seat: string,
    deadlineSeconds: number,
    /** Ignore the batch already presented to an in-flight wake. */
    afterSeq?: number,
    signal?: AbortSignal
  ): Promise<'mail' | 'timeout'>;
  read(seat: string): Promise<BrainMessage[]>;
  /** Peek without acknowledging. Used with acknowledge() for transactional wakes. */
  peek?(seat: string): Promise<BrainMessage[]>;
  /** Commit the unread messages after a usable turn. */
  acknowledge?(seat: string, seqs: number[]): Promise<BrainMessage[]>;
  /** Move one poison message out of delivery while retaining its durable record. */
  park?(seat: string, seq: number, reason: string): Promise<unknown>;
  loadRecovery?(seat: string): Promise<RecoveryCheckpoint | undefined>;
  /**
   * Item 10. Recall the assignment a checkpoint is FOR, from its source message.
   * Returns undefined when the source is gone or was superseded — a retracted brief must not
   * come back through recovery.
   */
  recallAssignment?(seat: string, workId: number): Promise<string | undefined>;
  openRecovery?(seat: string, workId: number, note: string): Promise<RecoveryCheckpoint>;
  recordRecoveryAction?(seat: string, workId: number, actionId: string): Promise<RecoveryCheckpoint>;
  closeRecovery?(seat: string, workId: number, reason: string): Promise<unknown>;
  listEvidence?(workIds: number[]): Promise<import('../evidence').EvidenceRecord[]>;
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
  /** Failed deliveries allowed for one message before it is parked. */
  maxMessageAttempts?: number;
  /** Delay between continuation wakes while an external claim remains blocked. */
  blockedBackoffMs?: number;
  /** Blocked delivery cycles allowed before the message is visibly parked for intervention. */
  maxBlockedAttempts?: number;
  /** Injected by tests so blocked-backoff coverage does not sleep in real time. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Emit stall-start after an in-flight turn has exceeded this duration. */
  providerStallMs?: number;
  /**
   * Persisted stall pair. Without it, stall-start is only a log line and a restart silently
   * forgets every unresolved stall — the exact ambiguity item 5 is removing.
   */
  stallLedger?: StallLedger;
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
  parkedMessages: number;
  stoppedBy: 'signal' | 'maxWakes';
};

const DEFAULT_BUDGET = 30;
const DEFAULT_LISTEN_SECONDS = 300;
const DEFAULT_ACK_KINDS = ['ack', 'receipt', 'ping'];
/**
 * Sends that inform without completing assigned work. Item 8: a wake whose
 * only mailbox products are these must not close the recovery checkpoint.
 * `note` is included because done-requires-report treats it as a report and
 * that is how "working on it" evaporated live assignments.
 */
const COURTESY_SEND_KINDS = new Set(['ack', 'receipt', 'ping', 'note']);
const DEFAULT_MAX_MESSAGE_ATTEMPTS = 3;
const DEFAULT_MAX_BLOCKED_ATTEMPTS = 3;
const DEFAULT_PROVIDER_STALL_MS = 30_000;

export async function runBrain(options: RunnerOptions): Promise<RunnerSummary> {
  const {
    seat,
    brain,
    bus,
    budgetPerWake = DEFAULT_BUDGET,
    listenSeconds = DEFAULT_LISTEN_SECONDS,
    maxWakes,
    maxMessageAttempts = DEFAULT_MAX_MESSAGE_ATTEMPTS,
    maxBlockedAttempts = DEFAULT_MAX_BLOCKED_ATTEMPTS,
    blockedBackoffMs = 30_000,
    providerStallMs = DEFAULT_PROVIDER_STALL_MS,
    stallLedger,
    sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
    ackKinds = DEFAULT_ACK_KINDS,
    thinkWhenIdle = false,
    log = () => {},
    stopSignal
  } = options;
  if (!Number.isSafeInteger(maxMessageAttempts) || maxMessageAttempts < 1) {
    throw new Error('maxMessageAttempts must be a positive integer');
  }
  if (!Number.isSafeInteger(blockedBackoffMs) || blockedBackoffMs < 0) {
    throw new Error('blockedBackoffMs must be a non-negative integer');
  }
  if (!Number.isSafeInteger(maxBlockedAttempts) || maxBlockedAttempts < 1) {
    throw new Error('maxBlockedAttempts must be a positive integer');
  }
  if (!Number.isSafeInteger(providerStallMs) || providerStallMs < 0) {
    throw new Error('providerStallMs must be a non-negative integer');
  }
  const isAck = (message: BrainMessage) =>
    ackKinds.includes(String((message as { kind?: unknown }).kind ?? '').trim().toLowerCase());
  const transactional = typeof bus.peek === 'function' && typeof bus.acknowledge === 'function';
  const receive = (target: string) => transactional ? bus.peek!(target) : bus.read(target);
  const commit = (target: string, seqs: number[]) =>
    transactional ? bus.acknowledge!(target, seqs) : Promise.resolve([]);

  let stopped = false;
  void stopSignal?.then(() => {
    stopped = true;
    log('stop-requested', { seat });
  });

  await brain.start?.();

  // Process death is not a still-open stall. Item 5 persists the pair so a
  // restart can *see* the missing resolve; it does not say the next process
  // should keep lying that the previous runner is still thinking.
  // Measured 2026-08-15: c1086c19 / e8ebb830 / d09e448d stayed open after
  // listen-failed + restart because finally never ran. source=process-host
  // may still have a live sibling watchdog — leave those alone.
  if (stallLedger) {
    for (const open of stallLedger.snapshot().open) {
      if (open.source !== 'runner') continue;
      try {
        stallLedger.resolve(open.id, 'abandoned');
        log('stall-orphaned', {
          seat,
          stallId: open.id,
          source: open.source,
          startedAt: open.startedAt,
          thresholdMs: open.thresholdMs,
          wakeReason: open.wakeReason
        });
      } catch (error) {
        log('stall-ledger-failed', {
          seat,
          phase: 'orphan-reap',
          stallId: open.id,
          error: (error as Error)?.message ?? String(error)
        });
      }
    }
  }

  const summary: RunnerSummary = { wakes: 0, cappedWakes: 0, errors: 0, parkedMessages: 0, stoppedBy: 'signal' };
  // Process-scoped on purpose. A runner restart gives retained mail a fresh budget; persistent
  // counters would let an old provider outage consume a message's future attempts forever.
  const failedAttempts = new Map<number, number>();
  const blockedAttempts = new Map<number, number>();
  let reason: WakeReason = 'startup';
  /**
   * Did the last turn end with work still to do?
   *
   * Carried across iterations so a seat can finish something that does not fit in one wake.
   * Without it, a long task can only ever advance when someone happens to send mail.
   */
  let hasOpenWork = false;
  /** The last unfinished wake's own description of what the next wake must continue. */
  let openWork: string | undefined;
  let recovery = await bus.loadRecovery?.(seat);
  let recoveryData: string | undefined;
  /** Item 10: the assignment the open checkpoint is FOR, recalled from its source message. */
  let assignmentRecall: string | undefined;
  if (recovery) {
    // These are two presentations of the SAME checkpoint.note, not competing sources. The first
    // restarted wake uses recoveryData so the prompt can label and tightly cap untrusted durable
    // bytes; openWork keeps the identical note alive for later in-process continuations. Emitting
    // both on this wake would duplicate content and spend the aggregate argv budget for no gain.
    hasOpenWork = true;
    openWork = recovery.note;
    recoveryData = recovery.note;

    // Item 10: a checkpoint carries STATUS, not CONTENT. Measured 2026-08-15 - a seat woke with
    // open work and could not state its own assignment: "retained only the note that work
    // remains open; the concrete goal, paths, and completion gates are missing". It asked five
    // times for the brief to be resent.
    //
    // Nothing needed to be stored to fix that. workId IS the source message's sequence, so the
    // brief is already on disk, unchanged, with every path and gate in it. The checkpoint held a
    // pointer and only the subject line was ever presented.
    //
    // Deliberately RECALL rather than COPY: no duplicated state to drift from the source, and a
    // brief that was later retracted must not come back - so a superseded source is refused.
    if (bus.recallAssignment) {
      try {
        assignmentRecall = await bus.recallAssignment(seat, recovery.workId);
      } catch {
        // Recall is a convenience over durable state that already exists. If it fails, the wake
        // proceeds with the note alone - the pre-item-10 behaviour - rather than not waking.
        assignmentRecall = undefined;
      }
    }
  }

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
      let messages = await receive(seat);
      // Transactional clients can preserve FIFO while presenting one message at a time. That is
      // what makes the retry budget genuinely per-message: a poison task cannot spend a later
      // task's attempts merely because both happened to be unread in the same snapshot.
      if (transactional && messages.length > 1) messages = messages.slice(0, 1);

      if (messages.length === 0 && reason !== 'startup' && !hasOpenWork) {
        const outcome = await bus.listen(seat, listenSeconds);
        if (stopped) break;
        reason = outcome === 'mail' ? 'mail' : 'timeout';
        if (outcome === 'mail') {
          messages = await receive(seat);
          if (transactional && messages.length > 1) messages = messages.slice(0, 1);
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
        await commit(seat, messages.map((message) => message.seq));
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
      let sentAnything = false;
      let sentCompleting = false;
      const counted: BrainTools = wrapWithBudget(bus.tools(seat), () => {
        calls += 1;
        if (calls > budgetPerWake) {
          throw new BudgetExceededError(seat, budgetPerWake);
        }
      });
      const observed: BrainTools = {
        ...counted,
        send: (input) => {
          sentAnything = true;
          const kind = String(input.kind ?? 'note').trim().toLowerCase();
          if (!COURTESY_SEND_KINDS.has(kind)) sentCompleting = true;
          return counted.send(input);
        }
      };

      let result: WakeResult = { done: true };
      // A courtesy handoff is not new work. Binding recovery or workId to that message
      // was how a successor lost the previous holder's open checkpoint (workId, note,
      // receipts) the moment credit-loss moved the baton.
      const incoming = messages[0];
      const handoffLeavesInheritedWork = Boolean(
        recovery &&
        incoming &&
        incoming.kind === 'handoff' &&
        incoming.seq !== recovery.workId
      );
      const workId = handoffLeavesInheritedWork ? recovery!.workId : (incoming?.seq ?? recovery?.workId);
      if (incoming && bus.openRecovery && !handoffLeavesInheritedWork) {
        recovery = await openRecoverySurvivably(bus, seat, incoming.seq, openWork ?? incoming.subject, recovery, log);
      }
      const evidenceWorkIds = [...new Set([
        ...messages.map((message) => message.seq),
        ...(recovery?.workId ? [recovery.workId] : []),
        ...(workId ? [workId] : [])
      ].filter((item): item is number => Number.isSafeInteger(item) && item > 0))];
      const evidence = bus.listEvidence && evidenceWorkIds.length > 0
        ? await bus.listEvidence(evidenceWorkIds)
        : undefined;
      const presentedThrough = messages.reduce((highest, message) => Math.max(highest, message.seq), 0);
      const receiveController = new AbortController();
      let listeningThrough = presentedThrough;
      const receiveWhileThinking = (transactional ? (async () => {
        while (!receiveController.signal.aborted) {
          log('seat-listening', { seat, afterSeq: listeningThrough, providerInFlight: true });
          const outcome = await bus.listen(seat, listenSeconds, listeningThrough, receiveController.signal);
          if (receiveController.signal.aborted) break;
          if (outcome !== 'mail') {
            // A production long poll already yields for seconds. Test clients and degraded
            // adapters may answer timeout immediately; yield a macrotask so their receive loop
            // cannot starve the provider promise or its stall timer.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            continue;
          }
          // Peek is non-destructive. It only advances the listener cursor; the original
          // presented sequence numbers remain the sole input to acknowledge() below.
          const queued = await receive(seat);
          const next = queued.reduce((highest, message) => Math.max(highest, message.seq), listeningThrough);
          log('mail-queued-during-provider', {
            seat,
            messages: queued.filter((message) => message.seq > listeningThrough).length,
            afterSeq: listeningThrough,
            throughSeq: next
          });
          listeningThrough = next;
        }
      })() : Promise.resolve()).catch((error) => {
        if (!receiveController.signal.aborted) {
          log('seat-listen-failed', { seat, error: (error as Error)?.message ?? String(error) });
        }
      });
      const providerStartedAt = Date.now();
      let providerOutcome: StallOutcome = 'returned';
      let stallId: string | undefined;
      let stallStarted = false;
      log('provider-thinking', { seat, reason, messages: messages.length });
      const reportStall = () => {
        if (stallStarted) return;
        stallStarted = true;
        try {
          stallId = stallLedger?.start({
            seat,
            source: 'runner',
            thresholdMs: providerStallMs,
            wakeReason: reason,
            messages: messages.length
          }).id;
        } catch (error) {
          log('stall-ledger-failed', { seat, phase: 'start', error: (error as Error)?.message ?? String(error) });
        }
        const payload = {
          seat,
          stallId,
          source: 'runner' as const,
          milliseconds: providerStallMs,
          reason,
          messages: messages.length
        };
        // Pair edge. `provider-stalled` stays so existing log greps and the 2026-08-14 count
        // still match; it is the start, not a verdict.
        log('stall-start', payload);
        log('provider-stalled', { seat, milliseconds: providerStallMs, reason, messages: messages.length });
      };
      const stallTimer = providerStallMs === 0 ? undefined : setTimeout(reportStall, providerStallMs);
      if (providerStallMs === 0) reportStall();
      try {
        const wakeContext = {
          seat,
          reason,
          messages,
          openWork,
          recoveryData,
          assignmentRecall,
          evidence,
          recoveryActionIds: recovery?.actionReceipts,
          recordRecoveryAction: workId && bus.recordRecoveryAction
            ? async (actionId: string) => { recovery = await bus.recordRecoveryAction!(seat, workId, actionId); }
            : undefined,
          tools: observed,
          budget: budgetPerWake,
          log
        };
        result = await brain.takeTurn(wakeContext);
        recoveryData = undefined;
      } catch (error) {
        providerOutcome = 'threw';
        if (error instanceof BudgetExceededError) {
          summary.cappedWakes += 1;
          result = { done: true, capped: true, note: error.message };
          log('wake-capped', { seat, budget: budgetPerWake });
        } else {
          // A brain that throws must not take the process with it. The seat stays attended and
          // the next wake gets a fresh chance - an agent that dies on one bad message is the
          // stall we are removing, not a stall we should reintroduce here.
          //
          // BUT a retry is only safe when the turn had NO OBSERVABLE EFFECT. A turn that already
          // sent mail and *then* threw has answered its message; retaining it makes the next wake
          // answer again. Measured 2026-08-20: one seat answered a single question five times
          // (rounds 2052-2056) and reported one audit four times (2081-2087) - each a paid
          // provider call, all from this line. The replies were real work; we bought them
          // repeatedly. On a seat that is out of providers, this is the difference between
          // degraded and dead.
          //
          // `sentAnything` is already tracked for the courtesy-send check below, so the runner
          // has always had this fact - it simply was not consulted here.
          //
          // "Sent something" alone is NOT enough to refuse the retry, and the durable-recovery
          // crash boundary is why. A brain that performs an effect, records a durable receipt,
          // and *then* crashes must come back: its checkpoint suppresses the replay of that
          // effect, so the retry resumes work instead of repeating it. Dropping the message
          // there would strand the task. (Caught by `tests/durable-recovery.test.js` when the
          // first version of this fix used `!sentAnything` alone - the full suite earned its
          // keep.)
          //
          // So the duplicating case is narrower than "sent": it is **sent with no checkpoint**.
          // With a checkpoint, replay is guarded; without one, nothing stops the next wake from
          // saying the same thing again.
          const guardedByCheckpoint = Boolean(recovery);
          const retryIsSafe = !sentAnything || guardedByCheckpoint;
          summary.errors += 1;
          result = { done: true, retainMessages: retryIsSafe };
          log('wake-error', {
            seat,
            error: (error as Error)?.message ?? String(error),
            sentBeforeThrow: sentAnything,
            guardedByCheckpoint,
            retained: retryIsSafe,
            note: retryIsSafe
              ? (sentAnything
                ? 'effect sent but a recovery checkpoint guards replay; retained to resume'
                : 'no outbound effect; retained for the next wake')
              : 'mail already sent and no checkpoint guards replay; committing so the reply is not duplicated'
          });
        }
      } finally {
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        receiveController.abort();
        await receiveWhileThinking;
        const durationMs = Date.now() - providerStartedAt;
        if (stallStarted) {
          try {
            if (stallId) stallLedger?.resolve(stallId, providerOutcome, durationMs);
          } catch (error) {
            log('stall-ledger-failed', { seat, phase: 'resolve', error: (error as Error)?.message ?? String(error) });
          }
          log('stall-resolution', {
            seat,
            stallId,
            source: 'runner',
            durationMs,
            thresholdMs: providerStallMs,
            outcome: providerOutcome
          });
        }
        log('provider-exited', {
          seat,
          outcome: providerOutcome,
          milliseconds: durationMs
        });
      }

      // A brain signals a spent chain by returning `exhausted`. Distinct from an error on
      // purpose: an error is a bad wake, exhaustion is a seat that cannot have a good one.
      // A resolved stall is not this signal. Slow and spent are different measurements;
      // logging one must not suppress or replace the other.
      // BROKEN is a third state: transport/dependency failure. Do not announce SPENT or
      // reassign as "out of providers" — the error must be visible on the event itself.
      if (result.broken) {
        log('chain-broken', { seat, error: result.note ?? 'provider transport failed' });
        // BROKEN is a machine failure, not a task outcome. Closing discarded live
        // assignments (1740, 1722) when node-pty vanished. Retain and resume.
        if (workId) {
          log('recovery-kept-open', { seat, workId, reason: 'broken', note: result.note });
        }
      } else if (result.exhausted) {
        log('chain-exhausted', { seat, note: result.note });
        try {
          await options.onExhausted?.({ seat, detail: result.note ?? 'all providers spent' });
        } catch (error) {
          log('exhausted-handler-failed', { seat, error: (error as Error)?.message });
        }
        // Inherit (item 4) already closes the source as "reassigned to X" when a
        // successor exists. A second close is only live when inherit does not run
        // — no successor, handler missing, handler throws — which is exactly the
        // resume-when-credits-return case. Close is not the loop brake:
        // hasOpenWork already excludes exhausted.
        if (workId) {
          log('recovery-kept-open', { seat, workId, reason: 'exhausted', note: result.note });
        }
      }

      // Inbox delivery is transactional. A malformed provider response is not work: the task
      // that paid for that wake stays unread and the next wake sees it again. Commit only after
      // the brain says it obtained a usable plan. Legacy BusClient implementations without the
      // peek/acknowledge pair retain their historical destructive-read behaviour.
      let blockedEscalated = false;
      if (messages.length > 0 && result.retainMessages !== true) {
        await commit(seat, messages.map((message) => message.seq));
        await brain.settleMessages?.(messages.map((message) => message.seq), 'committed');
        for (const message of messages) {
          blockedAttempts.delete(message.seq);
          const attempts = failedAttempts.get(message.seq);
          if (attempts !== undefined) {
            failedAttempts.delete(message.seq);
            log('message-retry-cleared', { seat, seq: message.seq, attempts });
          }
        }
      } else if (messages.length > 0 && transactional && result.blocked === true) {
        for (const message of messages) {
          const attempts = (blockedAttempts.get(message.seq) ?? 0) + 1;
          blockedAttempts.set(message.seq, attempts);
          log('message-blocked', { seat, seq: message.seq, attempts, maxAttempts: maxBlockedAttempts, note: result.note });
          if (attempts >= maxBlockedAttempts) {
            const detail = result.note?.trim() || 'external condition remained blocked';
            const parkReason = `blocked after ${attempts} cycles: ${detail}`;
            if (bus.park) await bus.park(seat, message.seq, parkReason);
            else await commit(seat, [message.seq]);
            blockedAttempts.delete(message.seq);
            failedAttempts.delete(message.seq);
            await brain.settleMessages?.([message.seq], 'parked');
            summary.parkedMessages += 1;
            blockedEscalated = true;
            if (workId === message.seq) recovery = undefined;
            log('message-blocked-escalated', {
              seat, seq: message.seq, from: message.from, kind: message.kind,
              subject: message.subject, attempts, reason: parkReason,
              recovery: `original mailbox record retained; run mailbox requeue --for ${seat} --seq ${message.seq} to retry`
            });
          }
        }
      } else if (messages.length > 0 && transactional) {
        for (const message of messages) {
          blockedAttempts.delete(message.seq);
          const attempts = (failedAttempts.get(message.seq) ?? 0) + 1;
          failedAttempts.set(message.seq, attempts);
          log('message-retry', { seat, seq: message.seq, attempts, maxAttempts: maxMessageAttempts });
          if (attempts >= maxMessageAttempts) {
            const parkReason = result.note?.trim() || 'brain did not produce a usable plan';
            // New clients mark the mailbox record explicitly. The acknowledge fallback keeps
            // older transactional clients bounded; either way the original record is retained.
            if (bus.park) await bus.park(seat, message.seq, parkReason);
            else await commit(seat, [message.seq]);
            failedAttempts.delete(message.seq);
            await brain.settleMessages?.([message.seq], 'parked');
            summary.parkedMessages += 1;
            if (workId === message.seq) recovery = undefined;
            log('message-parked', {
              seat,
              seq: message.seq,
              from: message.from,
              kind: message.kind,
              subject: message.subject,
              attempts,
              reason: parkReason,
              recovery: `original mailbox record retained; run mailbox requeue --for ${seat} --seq ${message.seq} to retry`
            });
          }
        }
      }

      // Carry "unfinished" into the next iteration, but never past an exhausted chain: a seat
      // with no provider left cannot continue by trying harder, and would spin at full speed on
      // a problem no number of turns can solve.
      //
      // `capped` is deliberately NOT a blocker here, and the distinction cost an audit. There
      // are two different caps. A brain that runs out of its own ROUNDS reports
      // `done: false, capped: true` - honest unfinished work, and refusing to continue it
      // stranded a seat whose own note read "Audit is open". The runner's own budget breach is
      // the dangerous one, and it is already excluded because that path sets `done: true`.
      hasOpenWork = result.done === false && !result.exhausted && !blockedEscalated;
      // Item 8: `done` used to close recovery. Seats emit done:true after an
      // acknowledgement because the prompt taught "done ends this wake". The
      // checkpoint then vanished and the next idle-skip dropped the assignment.
      // A courtesy-only wake ends (do not spin) but the task stays open.
      const courtesyOnly = sentAnything && !sentCompleting;
      const keepUnfinished =
        courtesyOnly &&
        !result.exhausted &&
        !result.broken &&
        !blockedEscalated;
      if (hasOpenWork || keepUnfinished) {
        const nextOpenWork = result.note?.trim();
        // A later partial step may omit its note. Retain the last useful summary rather than
        // erasing the only durable context the next model session has.
        openWork = nextOpenWork || openWork;
        if (workId && bus.openRecovery) {
          recovery = await openRecoverySurvivably(bus, seat, workId, openWork ?? 'unfinished', recovery, log);
        }
        if (keepUnfinished && !hasOpenWork) {
          log('recovery-kept-open', { seat, workId, reason: 'courtesy-only-send', note: openWork });
        }
      } else {
        // Completion closes the continuation. Exhaustion and broken retain the durable
        // row; they only clear the in-process summary so this seat does not spin.
        openWork = undefined;
        if (
          workId &&
          result.retainMessages !== true &&
          !result.exhausted &&
          !result.broken &&
          !blockedEscalated
        ) {
          await bus.closeRecovery?.(seat, workId, result.done ? 'done' : 'settled');
          recovery = undefined;
        }
      }

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

      // Retained mail makes listen return immediately, so a blocked claim needs its own wake
      // boundary delay. Without it, each continuation asks the provider again at full speed
      // while another seat legitimately holds the path.
      if (result.blocked && !blockedEscalated && blockedBackoffMs > 0 && !stopped) {
        log('wake-blocked-backoff', { seat, milliseconds: blockedBackoffMs, note: result.note });
        await sleep(blockedBackoffMs);
      }

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

/**
 * ITEM 21: A REFUSAL MUST BE SURVIVABLE.
 *
 * `openRecovery` refuses when another seat holds the checkpoint - one assignment, one holder.
 * That refusal is CORRECT and item 10 is not weakened by anything here; the store still throws
 * and the predecessor is still denied.
 *
 * The defect was where the throw LANDED. These calls sit outside the `takeTurn` try/catch that
 * exists precisely so a throw cannot take the process, so the refusal escaped to cli.ts as
 * `{"event":"fatal"}` and the seat exited. Measured cost: grok's brain died on EVERY wake for
 * hours while its provider was healthy the entire time, and a seat told "not yours" became
 * indistinguishable from one with no credits and one with no process. Both misdiagnoses were
 * made before the real cause was found.
 *
 * Two properties, and it is only half a fix with either one missing:
 *
 *   1. SURVIVE. Declining work is a normal outcome. The wake continues with whatever
 *      checkpoint the seat legitimately had, which is usually none.
 *   2. SAY SO. A seat that silently declines is as opaque as one that dies - the same
 *      "silence means three different things" failure, arriving from the other direction. The
 *      refusal is logged with the holder named, because "held by claude" is actionable and
 *      "recovery unavailable" sends someone hunting.
 *
 * Only a REFUSAL is survivable. A genuine fault - the store unreachable, the file corrupt -
 * still propagates, because swallowing that would hide a broken mailbox behind a routine
 * message.
 */
function isHeldByAnotherSeat(error: unknown): boolean {
  return error instanceof Error && /is held by \S+, not /.test(error.message);
}

async function openRecoverySurvivably(
  bus: BusClient,
  seat: string,
  workId: number,
  note: string,
  current: RecoveryCheckpoint | undefined,
  log: (event: string, data?: unknown) => void
): Promise<RecoveryCheckpoint | undefined> {
  try {
    return await bus.openRecovery!(seat, workId, note);
  } catch (error) {
    if (!isHeldByAnotherSeat(error)) throw error;
    log('recovery-refused', {
      seat,
      workId,
      reason: (error as Error).message,
      outcome: 'declined the work and continued; the seat is not dead'
    });
    return current;
  }
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
    supersede: (input) => { onCall(); return tools.supersede(input); },
    status: () => { onCall(); return tools.status(); },
    claim: (paths, why) => { onCall(); return tools.claim(paths, why); },
    release: (paths) => { onCall(); return tools.release(paths); },
    runCapability: (id, timeoutMs) => { onCall(); return tools.runCapability(id, timeoutMs); },
    // Deliberately NOT counted against the wake budget. It is an inventory lookup the brain
    // makes once to avoid guessing, and charging for it would push a seat toward guessing
    // again - which is the behaviour that cost whole wakes to `shell`, `workspace_runner` and
    // `read_write_test`, none of which exist.
    listCapabilities: () => tools.listCapabilities(),
    ...(tools.recordEvidence
      ? { recordEvidence: (input) => { onCall(); return tools.recordEvidence!(input); } }
      : {}),
    ...(tools.promoteEvidence
      ? { promoteEvidence: (input) => { onCall(); return tools.promoteEvidence!(input); } }
      : {})
  };
}
