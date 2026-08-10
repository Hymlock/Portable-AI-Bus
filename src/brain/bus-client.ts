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

export function cliBusClient(options: CliBusOptions): BusClient {
  const log = options.log ?? (() => {});

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
      log('bus-call-failed', { seat, name, error: (error as Error)?.message });
      return { error: (error as Error)?.message ?? String(error) };
    }
  }

  return {
    async listen(seat, deadlineSeconds) {
      // The deadline is chunked into polls the harness will accept, rather than passed straight
      // through. A brain waits minutes; one poll may last 30 seconds.
      const wait = options.waitForMailbox ?? waitForMailbox;
      const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      const until = Date.now() + deadlineSeconds * 1000;

      while (Date.now() < until) {
        const remaining = until - Date.now();
        try {
          const wake = await wait({
            root: options.root,
            seat,
            timeoutMs: Math.min(MAX_POLL_MS, remaining)
          });
          if (wake.wake === 'message') return 'mail';
        } catch (error) {
          // An unreachable harness should look like a quiet bus, not a dead agent — the brain
          // keeps listening and recovers when the harness returns. But it must WAIT first.
          // Returning here instead is what turned a broken poll into a spawn storm.
          log('listen-failed', { seat, error: (error as Error)?.message });
          // The FULL backoff, deliberately not clamped to the remaining deadline. Clamping made
          // the last failure before a deadline free, and "free failure" is the precise shape of
          // the bug: overshooting a wake deadline by five seconds costs nothing, while a
          // zero-cost failure path costs a spawn storm.
          await sleep(LISTEN_ERROR_BACKOFF_MS);
        }
      }
      return 'timeout';
    },

    async read(seat) {
      const result = await tool(seat, 'mailbox_read', { agent: seat, all: true });
      return Array.isArray(result) ? (result as BrainMessage[]) : [];
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
            ...(typeof input?.keepBaton === 'boolean' ? { keepBaton: input.keepBaton } : {})
          });
        },

        async status() {
          const result = await tool(seat, 'mailbox_status', {});
          return (result as Record<string, unknown>) ?? {};
        },

        async claim(paths, why) {
          // `paths.join(...)` on an absent field threw and killed a wake once. Validate at the
          // boundary between the model and the bus, because that is the only place the shape
          // is still in doubt.
          const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
          if (list.length === 0) return { refused: 'claim needs a non-empty paths array' };
          return tool(seat, 'mailbox_claim', { agent: seat, paths: list, why: why || 'unstated' });
        },

        async release(paths) {
          const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
          return tool(seat, 'mailbox_release', { agent: seat, ...(list.length ? { paths: list } : {}) });
        },

        async runCapability(id, timeoutMs = 60_000) {
          return tool(seat, 'capability_run', { id, timeoutMs }, timeoutMs + 10_000);
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
