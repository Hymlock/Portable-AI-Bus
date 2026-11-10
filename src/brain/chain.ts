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

export type GiveUpKind = 'spent' | 'broken' | 'mixed';

export type ChainReply = ModelReply & {
  /** Which link answered. Required by the goal: a chain must record who served. */
  servedBy?: ProviderKind;
  attempts: Attempt[];
  /**
   * Every link failed. Distinct from `isError`, which means a provider answered badly.
   * This is the signal a seat is out of options. `giveUp` says whether that is SPENT,
   * BROKEN, or mixed — `exhausted` alone used to collapse all three into "out of providers".
   */
  exhausted: boolean;
  /** Why the chain gave up. Absent when a link served the reply. */
  giveUp?: GiveUpKind;
  /** True when every failed link is a transport/dependency failure, not a credit/auth miss. */
  broken?: boolean;
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
  // ORDER MATTERS: rate-limit is tested BEFORE quota, because the two demand opposite
  // responses and the messages overlap.
  //
  //   quota      the wallet is empty. Abandon this link for hours.
  //   rate-limit too many at once. Back off briefly and RETRY THE SAME LINK.
  //
  // Learned the expensive way. A live run reported "You've hit your session limit - resets
  // 2:50pm" and I classified it as quota, so the chain abandoned the provider and handed off
  // the baton. The account was at 30% session and 51% weekly - nowhere near spent. The real
  // cause was FOUR SESSIONS IN PARALLEL against one shared limit, which is a concurrency
  // ceiling that clears in moments.
  //
  // Treating a transient throttle as exhaustion is worse than the reverse: it burns a working
  // provider and moves the baton for nothing.
  if (/rate.?limit|429|too many requests|overloaded|slow down|session limit|too many .{0,20}(session|concurrent|parallel)|limit .{0,12}reset/.test(text)) return 'rate-limit';
  if (/\b402\b|payment required|quota|credit|billing|insufficient_quota|out of tokens|spending limit|usage limit|reached your (usage )?limit/.test(text)) return 'quota';
  // "Not signed in" is the xAI CLI's wording, and it matched none of the patterns below - it
  // would have classified as a generic `error`, which falls through identically but reports a
  // useless reason to whoever reads the log.
  if (/unauthor|forbidden|401|403|api key|apikey|not logged in|not signed in|sign in|authentication|credential/.test(text)) return 'auth';
  if (
    /enoent|not found|not installed|command not found|econnrefused|unreachable|cannot find module|module not found|conpty unavailable|conpty spawn failed|conpty capture setup failed/.test(text)
  ) return 'unavailable';
  return 'error';
}

const SPENT_REASONS: FailureReason[] = ['quota', 'auth'];

function isTransportDetail(detail: string): boolean {
  const text = detail.toLowerCase();
  return /conpty|cannot find module|module not found|econnreset|econnrefused|econnaborted|socket hang up|enoent|not installed|command not found/.test(text);
}

function isBrokenAttempt(attempt: Attempt): boolean {
  if (attempt.reason === 'unavailable') return true;
  if (attempt.reason === 'error' && isTransportDetail(attempt.detail ?? '')) return true;
  return false;
}

function isSpentAttempt(attempt: Attempt): boolean {
  return SPENT_REASONS.includes(attempt.reason as FailureReason);
}

/** Inspect the failed attempt vector. Do not collapse mixed reasons to "out of providers". */
export function classifyGiveUp(attempts: Attempt[]): GiveUpKind | undefined {
  const failed = attempts.filter((attempt) => !attempt.ok);
  if (failed.length === 0) return undefined;
  if (failed.every(isSpentAttempt)) return 'spent';
  if (failed.every(isBrokenAttempt)) return 'broken';
  return 'mixed';
}

export function visibleGiveUpError(attempts: Attempt[]): string {
  const failed = attempts.filter((attempt) => !attempt.ok && attempt.detail);
  return failed.map((attempt) => attempt.detail).find(Boolean) ?? 'provider transport failed';
}

export type ChainOptions = {
  /**
   * How many times to RETRY THE SAME LINK on a `rate-limit` before moving on.
   *
   * A throttle is not exhaustion. Falling through on one immediately abandons a working
   * provider and, if every link shares an account, marches straight down the chain hitting
   * the same ceiling - which is exactly what happened on the first live multi-brain run.
   */
  rateLimitRetries?: number;
  /** Generic failures get one bounded second chance, but only when there is no fallback link. */
  errorRetries?: number;
  /** Base backoff in ms; doubles each retry. */
  rateLimitBackoffMs?: number;
  /** Injected in tests so a backoff test does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
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
  const rateLimitRetries = options.rateLimitRetries ?? 2;
  const errorRetries = options.errorRetries ?? 1;
  const backoffMs = options.rateLimitBackoffMs ?? 15_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function ask(
    prompt: string,
    askOptions?: Parameters<ModelProvider['ask']>[1]
  ): Promise<ChainReply> {
    const attempts: Attempt[] = [];

    for (const link of links) {
      let reply: ModelReply;
      let rateLimitAttempt = 0;
      let errorAttempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
      try {
        reply = await link.ask(prompt, askOptions);
      } catch (error) {
        const detail = (error as Error)?.message ?? String(error);
        const reason = classifyFailure(detail);
        if (reason === 'rate-limit' && rateLimitAttempt < rateLimitRetries) {
          const wait = backoffMs * 2 ** rateLimitAttempt;
          rateLimitAttempt += 1;
          log('rate-limited-retrying', { kind: link.kind, attempt: rateLimitAttempt, waitMs: wait });
          await sleep(wait);
          continue;
        }
        if (links.length === 1 && reason === 'error' && errorAttempt < errorRetries) {
          errorAttempt += 1;
          log('error-retrying', { kind: link.kind, attempt: errorAttempt });
          continue;
        }
        attempts.push({ kind: link.kind, ok: false, reason, detail: detail.slice(0, 300) });
        log('link-threw', { kind: link.kind, reason });
        break;
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
      if (reason === 'rate-limit' && rateLimitAttempt < rateLimitRetries) {
        const wait = backoffMs * 2 ** rateLimitAttempt;
        rateLimitAttempt += 1;
        log('rate-limited-retrying', { kind: link.kind, attempt: rateLimitAttempt, waitMs: wait });
        await sleep(wait);
        continue;
      }
      if (links.length === 1 && reason === 'error' && errorAttempt < errorRetries) {
        errorAttempt += 1;
        log('error-retrying', { kind: link.kind, attempt: errorAttempt });
        continue;
      }
      attempts.push({ kind: link.kind, ok: false, reason, detail: detail.slice(0, 300) });
      log('link-failed', { kind: link.kind, reason });
      break;
      }
      const last = attempts[attempts.length - 1];
      if (last && !last.ok && last.reason && !fallThroughOn.has(last.reason)) break;
    }

    const giveUp = classifyGiveUp(attempts) ?? 'mixed';
    const error = visibleGiveUpError(attempts);
    if (giveUp === 'broken') {
      log('chain-broken', { error, attempts: attempts.map((a) => `${a.kind}:${a.reason}`) });
    } else if (giveUp === 'mixed') {
      log('chain-mixed', { error, attempts: attempts.map((a) => `${a.kind}:${a.reason}`) });
    } else {
      log('chain-exhausted', { attempts: attempts.map((a) => `${a.kind}:${a.reason}`) });
    }
    return {
      text: '',
      isError: true,
      attempts,
      exhausted: true,
      giveUp,
      broken: giveUp === 'broken'
    };
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
