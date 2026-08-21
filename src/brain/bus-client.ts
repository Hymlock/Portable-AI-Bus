/**
 * Binds the brain runner to the real harness, IN PROCESS.
 *
 * The first version drove `worker-client.js` as a child process, reasoning that the CLI already
 * owned lease acquisition, heartbeats and the exit contract, so reusing it kept the brain path
 * and the human path from disagreeing. The reuse argument was right; the transport was wrong.
 *
 * What it cost, observed live: one wake is not one call. It is listen, then read, then a send,
 * often a status and a claim — six to ten process launches, every wake, per seat. A detached
 * brain has no console of its own, so Windows gave each of those children a fresh console, and
 * under Windows 11 a console is a Windows Terminal WINDOW. Hymlock watched roughly thirty
 * windows open and close during a single pair of wakes. `windowsHide` did not save it: the flag
 * is only dependable when the parent is not detached, and detaching is what keeps a brain alive
 * past the shell that started it.
 *
 * So the same functions are called directly instead. `waitForMailbox` and `callSeatTool` are the
 * exact entry points the CLI itself uses — the reuse is preserved, one layer lower down — and a
 * wake now spawns exactly one process: the model.
 */

import { BrainMessage, BrainTools } from './contract';
import { BusClient } from './runner';
import { callSeatTool, waitForMailbox } from '../worker-client';
import { MailboxStore } from '../mailbox';
import { DEFAULT_LEASE_STALE_MS } from '../harness';

export type CliBusOptions = {
  root: string;
  /** Unused; kept so existing callers that pass it still compile. */
  distDir?: string;
  log?: (event: string, data?: unknown) => void;
  /** Injected in tests. Defaults to the real long poll. */
  waitForMailbox?: typeof waitForMailbox;
  /** Injected in tests. Defaults to the authenticated harness tool call. */
  callSeatTool?: typeof callSeatTool;
  /** Injected in tests so a backoff test does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only clock and lease-policy overrides. Production derives from the harness constant. */
  now?: () => number;
  leaseStaleMs?: number;
  listenErrorBackoffMs?: number;
};

/**
 * The harness caps a single long poll at 30s. Ask for slightly less, so a value that is legal
 * here cannot become illegal after rounding on the other side.
 */
const MAX_POLL_MS = 25_000;

/**
 * How long to wait after a FAILED listen before trying again.
 *
 * Not a tuning knob — a safety floor. Passing the full deadline to a call capped at 30s made
 * every listen throw immediately; the failure was reported as a clean timeout, so the runner
 * woke again at once, and each wake spawned a model process. That is a hot loop that looks,
 * in the log, exactly like a busy healthy seat. It put roughly thirty console windows on
 * Hymlock's screen in seconds.
 *
 * Any listen that fails must cost real time before it can be retried.
 */
const LISTEN_ERROR_BACKOFF_MS = 5_000;

export class ListenTerminalError extends Error {
  constructor(message: string, readonly causeValue: unknown) {
    super(message);
    this.name = 'ListenTerminalError';
  }
}

export class ListenExhaustedError extends Error {
  constructor(message: string, readonly causeValue: unknown) {
    super(message);
    this.name = 'ListenExhaustedError';
  }
}

export function cliBusClient(options: CliBusOptions): BusClient {
  const log = options.log ?? (() => {});
  const durableMailbox = new MailboxStore(options.root);

  async function tool(seat: string, name: string, input: Record<string, unknown>, timeoutMs = 30_000) {
    try {
      const call = options.callSeatTool ?? callSeatTool;
      const { result } = await call(
        { root: options.root, seat, requestTimeoutMs: timeoutMs }, name, input);
      return result;
    } catch (error) {
      // A failing bus call must never take the seat down with it. The runner survives a throw,
      // but a seat that dies mid-wake still looks attended while doing nothing, which is the
      // worst of the available failures.
      const failure = error as Error & { status?: unknown; code?: unknown; retriable?: unknown };
      log('bus-call-failed', {
        seat,
        name,
        error: failure?.message,
        status: failure?.status,
        code: failure?.code,
        retriable: failure?.retriable
      });
      return {
        error: failure?.message ?? String(error),
        ...(Number.isInteger(failure?.status) ? { status: failure.status } : {}),
        ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
        ...(typeof failure?.retriable === 'boolean' ? { retriable: failure.retriable } : {})
      };
    }
  }

  return {
    async listen(seat, deadlineSeconds, afterSeq = 0, signal) {
      // The deadline is chunked into polls the harness will accept, rather than passed straight
      // through. A brain waits minutes; one poll may last 30 seconds.
      const wait = options.waitForMailbox ?? waitForMailbox;
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const now = options.now ?? Date.now;
      const leaseStaleMs = options.leaseStaleMs ?? DEFAULT_LEASE_STALE_MS;
      const errorBackoffMs = options.listenErrorBackoffMs ?? LISTEN_ERROR_BACKOFF_MS;
      const requestedUntil = now() + deadlineSeconds * 1000;
      let recoveryUntil: number | undefined;
      let lastFailure: unknown;

      while (!signal?.aborted && now() < (recoveryUntil ?? requestedUntil)) {
        const remaining = (recoveryUntil ?? requestedUntil) - now();
        try {
          const wake = await wait({
            root: options.root,
            seat,
            timeoutMs: Math.min(MAX_POLL_MS, remaining),
            afterSeq,
            signal
          });
          if (signal?.aborted) return 'timeout';
          if (wake.wake === 'message') return 'mail';
          // One accepted long poll proves this process owns a working listener again.
          recoveryUntil = undefined;
          lastFailure = undefined;
        } catch (error) {
          if (signal?.aborted) return 'timeout';
          // A retriable outage gets a lease-sized recovery window. It must WAIT between attempts;
          // returning here is what turned a broken poll into a spawn storm. A terminal outage or
          // exhaustion escapes the runner so the process cannot remain alive while deaf.
          const failure = error as Error & { status?: unknown; code?: unknown; retriable?: unknown };
          log('listen-failed', {
            seat,
            error: failure?.message,
            status: failure?.status,
            code: failure?.code,
            retriable: failure?.retriable
          });
          if (failure?.retriable === false) {
            throw new ListenTerminalError(
              `Listening for ${seat} stopped on non-retriable ${failure.code ?? failure.message ?? 'error'}`,
              error
            );
          }
          lastFailure = error;
          // A replacement may start anywhere in the old process's lease. Wait one complete
          // stale interval plus two backoffs so one acquisition is attempted strictly after
          // expiry and still has a full backoff-sized call window.
          recoveryUntil ??= Math.max(requestedUntil, now() + leaseStaleMs + 2 * errorBackoffMs);
          // The FULL backoff, deliberately not clamped to the remaining deadline. Clamping made
          // the last failure before a deadline free, and "free failure" is the precise shape of
          // the bug: overshooting a wake deadline by five seconds costs nothing, while a
          // zero-cost failure path costs a spawn storm.
          await sleep(errorBackoffMs);
        }
      }
      if (lastFailure !== undefined) {
        throw new ListenExhaustedError(
          `Listening for ${seat} stayed unavailable through the ${leaseStaleMs}ms lease-stale window`,
          lastFailure
        );
      }
      return 'timeout';
    },

    async peek(seat) {
      const messages: BrainMessage[] = [];
      let afterSeq = 0;

      // The harness deliberately pages tool results. Follow its explicit truncation bit and
      // advance only through the final sequence actually presented on each page.
      while (true) {
        const result = await tool(seat, 'mailbox_inbox', { agent: seat, all: true, afterSeq });
        const response = result as { messages?: unknown; hasMore?: unknown };
        if (!Array.isArray(response?.messages) || typeof response.hasMore !== 'boolean') break;
        const page = response.messages as BrainMessage[];
        if (page.length === 0) break;
        messages.push(...page);
        const cursor = page.at(-1)?.seq;
        if (!Number.isSafeInteger(cursor) || Number(cursor) <= afterSeq) break;
        afterSeq = Number(cursor);
        if (!response.hasMore) break;
      }
      return messages;
    },

    async acknowledge(seat, seqs) {
      // The queue may change after peek(). The harness/store boundary validates this complete
      // sequence set before mutating mail; it never substitutes the current FIFO head.
      const result = await tool(seat, 'mailbox_read', { agent: seat, seqs });
      if (Array.isArray((result as { messages?: unknown })?.messages)) {
        return (result as { messages: BrainMessage[] }).messages;
      }
      const refusal = result as { error?: unknown; status?: unknown; code?: unknown };
      const error = new Error(typeof refusal?.error === 'string'
        ? refusal.error
        : 'mailbox acknowledgement returned no message set') as Error & { status?: unknown; code?: unknown };
      error.status = refusal?.status;
      error.code = refusal?.code;
      throw error;
    },

    async park(seat, seq, reason) {
      const parked = await durableMailbox.park(seat, seq, reason);
      log('message-durably-parked', { seat, seq, parkedAt: parked.parkedAt, reason: parked.parkedReason });
      return parked;
    },

    loadRecovery(seat) { return durableMailbox.openRecoveryFor(seat); },

    // Both of these were IMPLEMENTED IN THE STORE AND NEVER WIRED HERE, which is why "seat
    // memory" survived the fix that was supposed to end it.
    //
    // `recallAssignment` is Item 10 (2026-08-15). It has extensive coverage — item10-recall,
    // item21-survivable-refusal, audit-fixes, audit-round2 — and every one of those tests
    // builds its OWN bus object with the method attached. `runner.ts` guards on
    // `if (bus.recallAssignment)`, so against this client the answer was always no and the
    // branch never ran in production. The tests proved the store; nothing proved the product.
    //
    // `currentAssignment` is the other half: a seat that was assigned but has no open work.
    // Measured 2026-08-20, both seats on the same day — codex woke and asked for "the open
    // verification requirements and relevant paths/commit", then woke again on a timeout with
    // messages:0 and stalled; grok kept re-running a superseded task.
    recallAssignment(seat, workId) { return durableMailbox.recallAssignment(seat, workId); },
    currentAssignment(seat) { return durableMailbox.currentAssignment(seat); },
    openRecovery(seat, workId, note) { return durableMailbox.openRecovery(seat, workId, note); },
    recordRecoveryAction(seat, workId, actionId) {
      return durableMailbox.recordRecoveryAction(seat, workId, actionId);
    },
    closeRecovery(seat, workId, reason) { return durableMailbox.closeRecovery(seat, workId, reason); },
    listEvidence(workIds) { return durableMailbox.evidenceForWake(workIds); },

    // Kept as the destructive compatibility surface for callers outside the brain runner.
    async read(seat) {
      const result = await tool(seat, 'mailbox_read', { agent: seat, all: true });
      return Array.isArray((result as { messages?: unknown })?.messages)
        ? (result as { messages: BrainMessage[] }).messages
        : [];
    },

    tools(seat): BrainTools {
      return {
        async send(input) {
          // These arguments come from MODEL OUTPUT, so any field may be missing or the wrong
          // shape. An empty body is rejected by the mailbox, so an absent one would fail the
          // send and lose the report entirely — silence being the one failure this project
          // keeps mis-reading as success.
          return tool(seat, 'mailbox_send', {
            from: seat,
            to: String(input?.to ?? '').trim() || 'claude',
            kind: String(input?.kind ?? 'note').trim() || 'note',
            subject: String(input?.subject ?? '(no subject)').slice(0, 200),
            body: String(input?.body ?? '').trim() || '(empty)',
            ...(typeof input?.keepBaton === 'boolean' ? { keepBaton: input.keepBaton } : {}),
            // Item 18, audit finding: a brain could not retract its own stale instruction,
            // because `supersedes` stopped at MailboxStore.send and never reached this
            // surface. Still model output, so accept only a positive integer and drop
            // anything else - a malformed value must not turn a correction into a failed
            // send, for the same reason the body is defaulted rather than rejected above.
            ...(Number.isInteger(input?.supersedes) && Number(input?.supersedes) > 0
              ? { supersedes: Number(input?.supersedes) }
              : {}),
            ...(typeof input?.supersedeReason === 'string' && input.supersedeReason.trim().length > 0
              ? { supersedeReason: input.supersedeReason.trim().slice(0, 1_000) }
              : {})
          });
        },

        async status() {
          const result = await tool(seat, 'mailbox_status', {});
          return (result as Record<string, unknown>) ?? {};
        },

        async supersede(input) {
          return tool(seat, 'mailbox_supersede', {
            agent: seat,
            seq: input.seq,
            by: input.by,
            reason: input.reason
          });
        },

        async claim(paths, why) {
          // `paths.join(...)` on an absent field threw and killed a wake once. Validate at the
          // boundary between the model and the bus, because that is the only place the shape
          // is still in doubt.
          const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
          if (list.length === 0) return { refused: 'claim needs a non-empty paths array' };
          // Item 7, audit finding: this used to send `why || 'unstated'`, which INVENTS a reason
      // for a caller that supplied none - the exact backfill forbidden for legacy rows a few
      // lines from where it is forbidden. A claim that cannot say why it exists must be
      // refused here too, not laundered into a placeholder that reads like an explanation.
      if (typeof why !== 'string' || why.trim().length === 0) {
        return { refused: 'claim needs a non-empty why: say what the claim is for' };
      }
      return tool(seat, 'mailbox_claim', { agent: seat, paths: list, why: why.trim() });
        },

        async release(paths) {
          const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
          return tool(seat, 'mailbox_release', { agent: seat, ...(list.length ? { paths: list } : {}) });
        },

        async runCapability(id, timeoutMs = 60_000) {
          return tool(seat, 'capability_run', { id, timeoutMs }, timeoutMs + 10_000);
        },

        async recordEvidence(input) {
          return tool(seat, 'mailbox_record_evidence', {
            agent: seat,
            subject: String(input?.subject ?? '').trim(),
            statement: String(input?.statement ?? '').trim(),
            ...(Number.isSafeInteger(input?.workId) ? { workId: input.workId } : {})
          });
        },

        async promoteEvidence(input) {
          return tool(seat, 'mailbox_promote_evidence', {
            agent: seat,
            id: String(input?.id ?? '').trim(),
            kind: String(input?.kind ?? '').trim(),
            ...(input?.invocation ? { invocation: String(input.invocation) } : {}),
            ...(input?.transition ? { transition: String(input.transition) } : {})
          });
        },

        async listCapabilities() {
          const result = await tool(seat, 'capability_list', {});
          // Shape-tolerant on purpose: the harness may answer with an array of ids, an array of
          // objects, or a wrapper. A brain that throws here would lose the whole wake over an
          // inventory lookup, which is a worse outcome than simply not knowing.
          const rows = Array.isArray(result)
            ? result
            : Array.isArray((result as { capabilities?: unknown })?.capabilities)
              ? (result as { capabilities: unknown[] }).capabilities
              : [];
          return rows
            .map((row) => (typeof row === 'string' ? row : (row as { id?: unknown })?.id))
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
        }
      };
    }
  };
}
