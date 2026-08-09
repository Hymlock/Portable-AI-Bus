/**
 * An ordered chain of providers, so a seat outlives any one vendor's quota.
 *
 * Hymlock's constraint, 2026-08-09: *"What I do not want is a required specific model seat such
 * as the Codex CLI that only works with Codex, and if we run out of tokens on Codex our bus has
 * stopped."*
 *
 * `resolveProvider` let a seat CHOOSE a provider. That is not enough: a seat still dies when its
 * one provider is exhausted. A chain lets a seat DEGRADE instead — first choice, then fallback,
 * then escape hatch — and only when every link is spent does the seat stop, which is the point
 * at which the baton should move to somebody else (`reassignBaton`).
 */

import { ModelProvider, ModelReply, ProviderKind } from './providers';

export type Attempt = {
  kind: ProviderKind;
  ok: boolean;
  /** Why we moved on. Absent when this attempt served the reply. */
  reason?: FailureReason;
  detail?: string;
};

export type ChainReply = ModelReply & {
  /** Which link answered. Required by the goal: a chain must record who served. */
  servedBy?: ProviderKind;
  attempts: Attempt[];
  /**
   * Every link failed. Distinct from `isError`, which means a provider answered badly.
   * This is the signal a seat is out of options and the baton should move.
   */
  exhausted: boolean;
};

export type FailureReason =
  | 'quota'        // out of tokens or credits
  | 'rate-limit'   // temporarily throttled
  | 'auth'         // no or bad credentials
  | 'unavailable'  // provider not installed or not reachable
  | 'error';       // answered, but badly

/**
 * Classify a failure from text, because providers disagree about how to report one: the CLI
 * prints JSON with `is_error`, the SDK throws, and an `exec` command may just exit non-zero.
 *
 * Deliberately generous — an unrecognised failure classifies as `error` and STILL falls through.
 * Being wrong about the reason costs one extra attempt; being wrong about whether to continue
 * costs the seat.
 */
export function classifyFailure(detail: string): FailureReason {
  const text = detail.toLowerCase();
  // "session limit" is what a Claude Code SUBSCRIPTION says when it is spent, as opposed to
  // the API's "insufficient_quota". Missing it classified a real exhaustion as a generic
  // error - it still fell through, because falling through is the default, but the log then
  // said `cli:error` for something that was plainly a quota event. A misleading diagnosis is
  // its own bug: it sends the next person debugging the wrong thing.
  if (/quota|credit|billing|insufficient_quota|out of tokens|spending limit|usage limit|session limit|limit .{0,12}reset|reached your limit/.test(text)) return 'quota';
  if (/rate.?limit|429|too many requests|overloaded|slow down/.test(text)) return 'rate-limit';
  if (/unauthor|forbidden|401|403|api key|apikey|not logged in|authentication|credential/.test(text)) return 'auth';
  if (/enoent|not found|not installed|command not found|econnrefused|unreachable/.test(text)) return 'unavailable';
  return 'error';
}

export type ChainOptions = {
  /**
   * Reasons that justify trying the next link. Defaults to everything, because a seat that
   * stops on a recoverable failure is the bug this module exists to remove.
   *
   * Narrow it only if you have measured a case where falling through wastes real money on a
   * request that would fail identically everywhere - a malformed prompt, say.
   */
  fallThroughOn?: FailureReason[];
  log?: (event: string, data?: unknown) => void;
};

const ALL_REASONS: FailureReason[] = ['quota', 'rate-limit', 'auth', 'unavailable', 'error'];

/**
 * Build one provider from many. The result satisfies `ModelProvider`, so nothing downstream
 * needs to know whether it is talking to one vendor or three.
 */
export function chainProviders(links: ModelProvider[], options: ChainOptions = {}) {
  if (links.length === 0) {
    throw new Error('a provider chain needs at least one link');
  }
  const fallThroughOn = new Set(options.fallThroughOn ?? ALL_REASONS);
  const log = options.log ?? (() => {});

  async function ask(
    prompt: string,
    askOptions?: Parameters<ModelProvider['ask']>[1]
  ): Promise<ChainReply> {
    const attempts: Attempt[] = [];

    for (const link of links) {
      let reply: ModelReply;
      try {
        reply = await link.ask(prompt, askOptions);
      } catch (error) {
        const detail = (error as Error)?.message ?? String(error);
        const reason = classifyFailure(detail);
        attempts.push({ kind: link.kind, ok: false, reason, detail: detail.slice(0, 300) });
        log('link-threw', { kind: link.kind, reason });
        if (!fallThroughOn.has(reason)) break;
        continue;
      }

      if (!reply.isError && reply.text.trim()) {
        attempts.push({ kind: link.kind, ok: true });
        return { ...reply, servedBy: link.kind, attempts, exhausted: false };
      }

      // A provider that returns `isError` or an empty answer has not served the request. Empty
      // counts as failure on purpose: a silent success is indistinguishable from a broken one
      // to everything downstream, and silence is what this whole project keeps mis-reading.
      const detail = reply.text || 'provider reported an error';
      const reason = classifyFailure(detail);
      attempts.push({ kind: link.kind, ok: false, reason, detail: detail.slice(0, 300) });
      log('link-failed', { kind: link.kind, reason });
      if (!fallThroughOn.has(reason)) break;
    }

    log('chain-exhausted', { attempts: attempts.map((a) => `${a.kind}:${a.reason}`) });
    return { text: '', isError: true, attempts, exhausted: true };
  }

  const chained: ModelProvider & { ask: typeof ask } = {
    // Reports the first link's kind so existing logs stay readable; `servedBy` on each reply is
    // the honest per-call answer.
    kind: links[0].kind,
    ask,
    async probe() {
      const results = await Promise.all(links.map(async (link) => ({
        kind: link.kind,
        ...(await link.probe())
      })));
      const usable = results.filter((r) => r.ok);
      return {
        ok: usable.length > 0,
        detail: usable.length > 0
          ? `${usable.length}/${links.length} link(s) usable: ` +
            results.map((r) => `${r.kind}=${r.ok ? 'ok' : 'no'}`).join(', ')
          : `NO usable provider. ${results.map((r) => `${r.kind}: ${r.detail}`).join(' | ')}`
      };
    }
  };
  return chained;
}
