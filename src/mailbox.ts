import * as fs from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  BusObservation,
  EvidencePromotionError,
  EvidenceRecord,
  EvidenceStore,
  VerifierKind,
  currentEvidence,
  isVerifierKind,
  observeCommitDiff,
  observeLifecycle,
  observeRunnerResult
} from './evidence';
import { directoryContainsIdentities } from './claim-walk';
import { filesystemIdentityMaterial } from './workspace-key';

const execFileAsync = promisify(execFile);
/**
 * State and message schemas are versioned separately. Messages keep schema 1 so older readers
 * can still parse them; state moved to 2 when the lifetime round guard was replaced by the
 * queue-depth guard. Old binaries throw on state schema 2 inside loadStateUnsafe, before any
 * write, so a stale CLI cannot latch a halt or send under rules it does not understand.
 */
const STATE_SCHEMA = 2;
const MESSAGE_SCHEMA = 1;
const ACCEPTED_STATE_SCHEMAS = new Set([1, 2]);
const DEFAULT_MAX_ROUNDS = 32;
export const QUEUE_GUARD_VERSION = '0.2.0+queue-guard';
/**
 * Written to `stopReason` on every unhalted state write. Old harness guards read
 * `round >= maxRounds` from a lock-free status and refuse with this text. It deliberately does
 * not contain the word that old clients treat as a halt.
 */
export const UPGRADE_SENTINEL = `upgrade required: this mailbox uses the queue-depth guard (Portable-AI-Bus >= ${QUEUE_GUARD_VERSION})`;
export const ROUNDS_IGNORED_NOTICE = 'ignored: rounds are no longer a limit; the queue is bounded by pruning and per-seat caps';
/** Appended to ROUNDS_IGNORED_NOTICE when `resume --add-rounds N` hits a halted bus. */
export const STILL_HALTED_NOTICE = 'the bus is still halted; run plain `resume` (without --add-rounds) to clear the halt';
/**
 * A halt latched by the retired lifetime round guard. Its text told the owner to add rounds,
 * which is now a no-op, so migration rewrites it to point at plain `resume`.
 */
const LEGACY_ROUND_HALT = /maxRounds|max rounds|round guard|round limit|rounds? (?:exhausted|reached)|add-rounds/i;
export const LEGACY_HALT_REWRITE = 'halted by the retired lifetime message counter (no longer a limit); run plain `resume` to clear this halt';
/** Floor for a backstop refusal's retryAfterMs, so clients never spin on retryAfterMs 0. */
const MIN_BACKSTOP_RETRY_MS = 60_000;
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** Wall-clock budget for retrying a Windows sharing violation on an atomic rename. */
const RENAME_RETRY_BUDGET_MS = 2_000;
/** Consecutive post-commit state publish failures an archive run tolerates before it stops. */
const MAX_PUBLISH_FAILURES = 2;

/** The cap a 1 -> 2 migration sets when none is configured: room for the backlog plus 100. */
export function migrationCap(unread: Record<string, number>): number {
  const backlog = Math.max(0, ...Object.values(unread));
  return Math.max(DEFAULT_RETENTION.maxUnreadPerSeat, Math.ceil((backlog + 100) / 100) * 100);
}
export const DEFAULT_RETENTION = {
  keepRecent: 300,
  minAgeHours: 48,
  pinnedAllowance: 200,
  batch: 500,
  maxUnreadPerSeat: 200,
  minIntervalMinutes: 60,
  pressureIntervalMinutes: 5
};
export type RetentionSettings = Partial<typeof DEFAULT_RETENTION>;
/** A recount newer than this (and newer than the seat's last mutation) is trusted for a refusal. */
const RECOUNT_TRUST_MS = 60_000;
/** A per-seat refusal cannot clear until the seat reads, so clients wait this long. */
export const SEAT_RETRY_AFTER_MS = 300_000;
const GIT_STAMP_CACHE_MS = 5_000;
const PRESSURE_FRACTION = 0.8;
const TOLERANT_READ_RETRIES = 3;
const TOLERANT_READ_DELAY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
/** Files read concurrently by a full inbox scan. See allMessagesUnsafe. */
const READ_BATCH = 64;

export type Claim = {
  path: string;
  /** Lexical workspace root against which `path` was resolved. */
  root?: string;
  /** Stable filesystem identity. Symlink, junction, and hardlink aliases share this value. */
  identity?: string;
  why: string;
  at: string;
};

export type CommitStamp = {
  sha: string;
  dirty: boolean;
};

export type BusMessage = {
  schema: number;
  seq: number;
  round: number;
  createdAt: string;
  from: string;
  to: string;
  kind: string;
  subject: string;
  body: string;
  workspaceCommit?: CommitStamp;
  read: boolean;
  readAt?: string;
  parkedAt?: string;
  parkedReason?: string;
  /** A newer mailbox row that replaces this message for current delivery. */
  supersededBy?: number;
  supersededAt?: string;
  supersedeReason?: string;
  /**
   * Item 18. Set on a message SENT with `supersedes`. True when the atomic supersession took
   * effect; false with `supersedeOutcome: 'target-consumed'` when the recipient had already
   * consumed the target, so the correction was delivered but no supersession is claimed.
   */
  superseded?: boolean;
  supersedeOutcome?: string;
  recoveryCheckpoints?: RecoveryCheckpoint[];
  /** Set by the explicit `expire` verb. Expired mail is read mail; `requeue` restores it. */
  expiredAt?: string;
  expiredReason?: string;
  /** Set when `unarchive` copied this message back from an archive segment. */
  restoredAt?: string;
};

export type QueueState = {
  /** Per-seat unread counter, same definition as inbox(). Advisory: recounted, never trusted alone. */
  unread?: Record<string, number>;
  unreadVerifiedAt?: Record<string, string>;
  seatMutatedAt?: Record<string, string>;
  lastRecountAt?: string;
  lastPruneAt?: string;
  lastPruneEligible?: number;
  lastPruneHot?: number;
  lastPruneMode?: 'normal' | 'pressure';
  lastPruneArchived?: number;
  /**
   * Set when an in-send pressure batch failed. The guard waits the pressure interval from here
   * before trying again, so a persistent failure cannot re-scan the inbox on every send.
   */
  lastPruneAttemptAt?: string;
  /** Display counters only. The seq high-water comes from segment filenames. */
  archived?: number;
  archivedThrough?: number;
  archiveWarnings?: string[];
};

export type RecoveryCheckpoint = {
  id: string;
  workId: number;
  seat: string;
  status: 'open' | 'closed';
  note: string;
  actionReceipts: string[];
  openedAt: string;
  updatedAt: string;
  closedAt?: string;
  closeReason?: string;
  /** Previous assignment, when this checkpoint was inherited across a seat change. */
  inheritedFrom?: string;
};

/**
 * The byte budget for `goal.assignments[seat]`.
 *
 * Mirrors `RECOVERY_LIMIT_BYTES` in `brain/brains/agent.ts`, which is where the wake field is
 * actually capped. Duplicated deliberately rather than imported: `mailbox.ts` is the durable
 * store and must not depend on the brain layer. `assignment-cap.test.js` imports both and
 * asserts they agree, so the duplication cannot drift unnoticed.
 */
export const ASSIGNMENT_LIMIT_BYTES = 2 * 1024;

export type MailboxState = {
  schema: number;
  createdAt: string;
  agents: string[];
  seq: number;
  round: number;
  maxRounds: number;
  halted: boolean;
  stopReason: string | null;
  claims: Record<string, Claim[]>;
  haltPolicy: HaltPolicy;
  completions: CompletionEvent[];
  /**
   * Structured goal transitions. Do not overload CompletionEvent.scope.
   * setGoal appends goal-set when no previous goal exists, else goal-replaced.
   * Last 100 retained, same as completions. observeLifecycle binds these.
   */
  lifecycleEvents: LifecycleEvent[];
  /**
   * What this bus is FOR, and how a human will know it is finished.
   *
   * Halt policies answered "have we talked too much?" when the question agents actually need
   * is "are we finished?". Without this, a productive exchange halts at the round cap while an
   * unproductive one burns the same budget saying nothing, and neither outcome is
   * distinguishable afterwards.
   *
   * `doneWhen` is deliberately prose. Nothing here can evaluate whether an architecture is
   * sound, so `complete-goal` records a CLAIM that a human checks against this text - the same
   * freshness-not-truthfulness boundary the rest of the system uses. Writing the criteria
   * down BEFORE the work is what makes the later claim falsifiable.
   */
  goal: Goal | null;
  /**
   * Who owes the next DECISION.
   *
   * NOT a work lock, and reading it as one is expensive. Holding the baton does not mean you
   * are the only seat allowed to act; it means the next judgement call is yours. Every other
   * seat should be working in parallel the whole time - that is the entire reason there is
   * more than one.
   *
   * Concurrency is controlled by CLAIMS, which are per-path and refuse on overlap. The baton
   * and the claim answer different questions: "whose call is it?" versus "who is editing
   * this?". Conflating them serialises two agents into one, at double the wall-clock time,
   * while each waits politely for a turn it did not need.
   *
   * A stall is not a transport failure - every stall on this project happened while both seats
   * were alive, leased and heartbeating. It is a DECISION-ownership failure: nobody owed the
   * next call, and nothing could say so. `status` showed green throughout.
   *
   * Sending passes the baton to the recipient: the sender has just decided, the recipient now
   * owes the next one. If the holder goes quiet past a threshold while the goal is unmet and
   * the bus is not halted, that is a stall with a NAME attached - see `stallCheck`.
   */
  baton: Baton | null;
  /** Retention and queue-guard settings. Missing fields use DEFAULT_RETENTION. */
  retention?: RetentionSettings;
  queue?: QueueState;
  /** Bumped by requeue and unarchive so a waiter rescans even when no new seq appeared. */
  mailEpoch?: number;
};

export type Baton = {
  holder: string;
  since: string;
  reason: string;
};

export type Goal = {
  statement: string;
  doneWhen: string;
  setAt: string;
  setBy: string | null;
  /** Per-seat assignment, so "who owns which part of done_when" is durable, not conversational. */
  assignments: Record<string, string>;
};

export type HaltPolicy = {
  onStepCompletion: boolean;
  onGoalCompletion: boolean;
  atRounds: number[];
  everyRounds: number | null;
};

export type CompletionEvent = {
  id: string;
  scope: 'step' | 'goal';
  actor: string;
  summary: string;
  evidence: string[];
  at: string;
  halted: boolean;
};

export type LifecycleEvent = {
  id: string;
  kind: 'goal-set' | 'goal-replaced';
  at: string;
  previousIdentity: string | null;
  nextIdentity: string;
};

export type QueueView = {
  hot: number;
  maxHot: number;
  unread: Record<string, number>;
  maxUnreadPerSeat: number;
  archived: number;
  archivedThrough: number;
  lastPruneAt: string | null;
};

export type MailboxStatus = MailboxState & {
  unread: Record<string, number>;
  workspaceCommit?: CommitStamp;
  queueView?: QueueView;
  /** Per-seat queue pressure (>= 80% of the seat cap). */
  queueWarning?: string;
  backstopWarning?: string;
  /** Alias of queueWarning, kept for older consumers. Never describes rounds as a limit. */
  roundWarning?: string;
};

export type BriefStatus = {
  brief: true;
  halted: boolean;
  stopReason?: string;
  agents: string[];
  baton: Baton | null;
  /** Informational message counter. Not a limit. */
  round: number;
  unread: Record<string, number>;
  queue: QueueView;
  queueWarning?: string;
  backstopWarning?: string;
  claims?: Claim[];
  claimsTruncated?: number;
  claimCounts: Record<string, number>;
  workspaceCommit?: CommitStamp;
};

export type ArchiveRow = [number, string, string, string, string, boolean, boolean, number];

export type ArchiveBatchReport = {
  mode: 'normal' | 'pressure';
  dryRun: boolean;
  hot: number;
  eligible: number;
  selected: number;
  archived: number;
  kept: number[];
  segment?: string;
  blocked: Record<string, number>;
  hotAfter: number;
  /** Set when the batch committed but its state.json publish failed and was recovered. */
  warning?: string;
};

/**
 * The archive batch committed (segment durable, hot files deleted) but the final state.json
 * publish hit a transient Windows sharing violation. The journal is still on disk, so
 * recoverArchiveUnsafe can finish the counters; the caller must not treat this as data loss.
 */
class ArchivePublishError extends Error {
  constructor(readonly report: ArchiveBatchReport, readonly publishError: unknown) {
    super(`archive state publish failed: ${publishError instanceof Error ? publishError.message : String(publishError)}`);
    this.name = 'ArchivePublishError';
  }
}

export type ArchiveRunReport = {
  mode: 'normal' | 'pressure';
  dryRun: boolean;
  batches: ArchiveBatchReport[];
  hotBefore: number;
  hotAfter: number;
  eligible: number;
  archived: number;
  maxHot: number;
  maxUnreadPerSeat: number;
  unread: Record<string, number>;
  sentences: string[];
};

export type ExpireReport = {
  dryRun: boolean;
  seat: string;
  matched: number[];
  expired: number[];
  skipped: { parked: number[]; checkpoint: number[]; pinned: number[] };
};

export type DoctorReport = {
  ok: boolean;
  problems: string[];
  warnings: string[];
  metrics: {
    messages: number;
    unread: number;
    claims: number;
    temporaryFiles: number;
  };
};

type MailboxPaths = {
  root: string;
  mailboxDir: string;
  inboxDir: string;
  archiveDir: string;
  journalPath: string;
  restoredPath: string;
  statePath: string;
  transcriptPath: string;
  lockPath: string;
  recoveryLockPath: string;
};

type SendInput = {
  from: string;
  to: string;
  kind?: string;
  subject: string;
  body: string;
  /**
   * Keep the baton with the SENDER instead of passing it to the recipient.
   *
   * Default-on for `ack`, because an ack means "received, I am working on it" - the sender is
   * about to act, not handing over. Without this the baton bounced to whoever was WAITING:
   * one exchange after shipping the baton, Grok acked "processing, will pass baton when those
   * land" and the system immediately declared that Claude owed the next action. The signal
   * pointed at the idle seat.
   */
  keepBaton?: boolean;
  /**
   * Item 18. Supersede this message atomically with the one being sent.
   *
   * send(correction) followed by supersedeMessage(target) is two steps, and between them BOTH
   * are current - a seat can read the stale original in that window. One operation, one lock,
   * one pair of writes closes it. An invalid target sends nothing at all; a target the
   * recipient has ALREADY consumed still delivers the correction and reports
   * `supersedeOutcome: 'target-consumed'` rather than claiming a supersession that did not
   * happen.
   */
  supersedes?: number;
  /** Recorded on the superseded row so history says why, as closeCheckpoints already does. */
  supersedeReason?: string;
};

type ClaimInput = {
  agent: string;
  paths: string[];
  /**
   * Item 7. REQUIRED. The question a human needs answered when a seat dies holding a path is
   * WHY it stopped â€” see the baton path, which has demanded a reason on every refusal since it
   * was written. A claim that cannot say why it exists is exactly the row an operator finds at
   * 3am with an empty string where the explanation should be.
   *
   * Legacy rows persisted before this was required keep their empty `why` and are readable;
   * they are not backfilled with an invented reason. Same rule as the identity migration.
   */
  why: string;
  /** Git repository whose relative paths should also be claimable when the bus root is elsewhere. */
  repoRoot?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeHaltRounds(value: unknown) {
  if (!Array.isArray(value) || value.length > 256 || value.some((item) => !Number.isSafeInteger(item) || (item as number) < 1)) {
    throw new Error('atRounds must contain at most 256 positive integers.');
  }
  return Array.from(new Set(value as number[])).sort((left, right) => left - right);
}

function normalizeEveryRounds(value: unknown): number | null {
  if (value === null || value === 0) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('everyRounds must be a positive integer, zero, or null.');
  return value as number;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayUntil(ms: number, signal?: AbortSignal) {
  if (!signal) return delay(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function isUnreadMessage(message: BusMessage) {
  return !message.read && message.supersededBy === undefined;
}

/** Canonical JSON (sorted keys) for the archive deep-equal check. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const SEGMENT_PATTERN = /^seg-(\d+)-(\d+)(?:-(\d+))?\.ndjson$/;
const HOT_NAME_PATTERN = /^(\d{6,})-.*\.json$/;

function seqTokens(text: string | undefined | null): number[] {
  if (!text) return [];
  return Array.from(text.matchAll(/#(\d+)/g), (match) => Number.parseInt(match[1], 10)).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
}

type ArchiveJournal = {
  runId: string;
  phase: 'writing' | 'committed';
  base: string;
  seqs: number[];
  mode: 'normal' | 'pressure';
  startedAt: string;
};

type RestoredEntry = { seq: number; segment: string; at: string; reason: string };

function messageFileName(seq: number, from: string, to: string) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${String(seq).padStart(6, '0')}-${safe(from)}-to-${safe(to)}.json`;
}

export class MailboxStore {
  readonly paths: MailboxPaths;
  readonly evidence: EvidenceStore;
  private readonly renameFile: (source: string, destination: string) => Promise<void>;
  private readonly clock: () => number;
  private readonly archiveFault?: (point: string) => void | Promise<void>;
  private gitStampCache?: { key: string; at: number; value: CommitStamp | undefined };
  /** Cheap counters so tests can prove which paths scan, spawn git, or recount. */
  readonly metrics = { scans: 0, gitSpawns: 0, recounts: 0, pruneBatches: 0, waitScans: 0, waitFileReads: 0, lastScannedSeq: -1, skipped: 0 };

  constructor(
    root: string,
    options?: {
      renameFile?: (source: string, destination: string) => Promise<void>;
      /** Injectable clock (ms since epoch) for queue and archive timing simulations. */
      now?: () => number;
      /** Test-only crash injection at archive step boundaries. */
      archiveFault?: (point: string) => void | Promise<void>;
    }
  ) {
    const resolvedRoot = path.resolve(root);
    this.renameFile = options?.renameFile ?? fs.rename;
    this.clock = options?.now ?? Date.now;
    this.archiveFault = options?.archiveFault;
    this.evidence = new EvidenceStore(resolvedRoot);
    const mailboxDir = path.join(resolvedRoot, '.ai-bus', 'runtime', 'mailbox');
    this.paths = {
      root: resolvedRoot,
      mailboxDir,
      inboxDir: path.join(mailboxDir, 'inbox'),
      archiveDir: path.join(mailboxDir, 'archive'),
      journalPath: path.join(mailboxDir, 'archive', 'journal.json'),
      restoredPath: path.join(mailboxDir, 'archive', 'restored.json'),
      statePath: path.join(mailboxDir, 'state.json'),
      transcriptPath: path.join(mailboxDir, 'transcript.md'),
      lockPath: path.join(mailboxDir, '.lock'),
      recoveryLockPath: path.join(mailboxDir, '.lock.recovery')
    };
  }

  async ensureInitialized(agents: string[] = [], maxRounds = DEFAULT_MAX_ROUNDS): Promise<MailboxState> {
    return this.withLock(async () => {
      const alreadyInitialized = await this.exists(this.paths.statePath);
      const existing = await this.loadStateUnsafe();
      // The roster PASSED IN is the roster - not an addition to whatever accumulated before.
      // Union semantics made ghost seats permanent: once `hymlock` and `worker` were seated by a
      // mistaken run, no later correct run could evict them, and reports piled up unread against a
      // seat no human could read.
      //
      // An EMPTY list means "do not touch the roster", never "retire everyone". `init` with no
      // --agents is a real thing operators type by accident, and it must stay harmless.
      const normalizedAgents = agents.length === 0
        ? this.uniqueAgents(existing.agents)
        : this.uniqueAgents(agents);
      if (agents.length > 0) {
        const retiring = existing.agents.filter((agent) => !normalizedAgents.includes(agent));
        // Retiring a seat mid-flight would orphan its claims and let another seat edit the same
        // file. Refuse and make the operator resolve it deliberately.
        const encumbered = retiring.filter((agent) => (existing.claims[agent] ?? []).length > 0);
        if (encumbered.length > 0) {
          const detail = encumbered
            .map((agent) => `${agent} (${(existing.claims[agent] ?? []).map((claim) => claim.path).join(', ')})`)
            .join('; ');
          throw new Error(
            `Refusing to retire seat(s) still holding claims: ${detail}. `
            + 'Release those claims first, then re-run init.'
          );
        }
        if (retiring.includes(existing.baton?.holder ?? '')) {
          throw new Error(
            `Refusing to retire ${existing.baton?.holder}: it currently holds the baton. `
            + 'Reassign the baton first, then re-run init.'
          );
        }
        for (const agent of retiring) {
          delete existing.claims[agent];
        }
      }
      const next = {
        ...existing,
        agents: normalizedAgents,
        maxRounds: alreadyInitialized ? Math.max(existing.maxRounds, maxRounds) : maxRounds
      };
      await this.writeStateUnsafe(next);
      if (!(await this.exists(this.paths.transcriptPath))) {
        await this.atomicWrite(this.paths.transcriptPath, '# Portable AI Bus transcript\n');
      }
      return next;
    });
  }

  async registerAgents(agents: string[], requireRunning = false): Promise<MailboxState> {
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      // Rounds are a message counter, not a limit. Only a real halt refuses.
      if (requireRunning && state.halted) {
        throw new BusHaltedError(state.stopReason ?? 'bus halted');
      }
      state.agents = this.uniqueAgents([...state.agents, ...agents]);
      await this.writeStateUnsafe(state);
      return state;
    });
  }

  async send(input: SendInput): Promise<BusMessage> {
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      this.assertSeated(state, input.from, 'sender');
      this.assertSeated(state, input.to, 'recipient');
      if (!input.subject.trim()) {
        throw new Error('Message subject must not be empty.');
      }
      if (!input.body.trim()) {
        throw new Error('Message body must not be empty.');
      }
      if (state.halted) {
        throw new BusHaltedError(state.stopReason ?? 'bus halted');
      }
      // Queue-depth guard: per-seat unread cap, then the computed backstop. Neither latches.
      await this.enforceQueueGuardUnsafe(state, input.to);

      const knownAgents = this.uniqueAgents([...state.agents, input.from, input.to]);
      const seq = Math.max(state.seq, await this.maxMessageSequenceUnsafe()) + 1;
      const round = state.round + 1;
      const message: BusMessage = {
        schema: MESSAGE_SCHEMA,
        seq,
        round,
        createdAt: this.iso(),
        from: input.from,
        to: input.to,
        kind: input.kind?.trim() || 'note',
        subject: input.subject.trim(),
        body: input.body,
        workspaceCommit: await this.gitStamp(),
        read: false
      };

      // Item 18: atomic superseding send. send(correction) then supersedeMessage(target) are two
      // steps, and between them BOTH are current - a seat can read the stale original in that
      // window. One operation closes it. Validation happens BEFORE the correction is written, so
      // an invalid target produces no message at all.
      let supersedeOutcome: { superseded: boolean; reason?: string } = { superseded: false };
      let supersededTarget: { message: BusMessage; file: string } | undefined;
      if (input.supersedes !== undefined) {
        const targetFile = await this.findMessagePathUnsafe(input.supersedes);
        if (!targetFile) {
          await this.throwIfArchivedUnsafe(input.supersedes);
          throw new Error(`Cannot supersede #${input.supersedes}: no such message. Nothing was sent.`);
        }
        const target = await this.readJson<BusMessage>(targetFile);
        if (target.from !== input.from) {
          throw new Error(
            `Cannot supersede #${input.supersedes}: it was sent by ${target.from}, not ${input.from}. `
            + 'Nothing was sent.'
          );
        }
        if (target.supersededBy !== undefined) {
          // An already-superseded but unconsumed target is an invalid relationship, unlike the
          // recoverable consumed case below. Refuse without delivering.
          throw new Error(
            `Cannot supersede #${input.supersedes}: already superseded by #${target.supersededBy}. Nothing was sent.`
          );
        }
        /**
         * Item 18, second audit: the two verbs disagreed about who may be retracted.
         *
         * `supersedeMessage` refuses when the replacement is addressed to a different seat.
         * The atomic path did not, so `send({ to: 'codex', supersedes: <grok's message> })`
         * retracted grok's instruction and delivered the replacement to codex - leaving grok
         * with a silently cancelled brief and no replacement at all. Which verb you used
         * changed what was legal, which means one of them was wrong.
         */
        if (target.to !== message.to) {
          throw new Error(
            `Cannot supersede #${input.supersedes}: it was sent to ${target.to}, not ${message.to}. ` +
            'A replacement must reach the seat whose instruction it retracts. Nothing was sent.'
          );
        }
        if (target.read) {
          // TOO LATE, and say so honestly rather than pretending. The correction is still worth
          // delivering; claiming a supersession that did not happen would be worse than a plain
          // send. This is an atomic decision that supersession was too late, not a supersession.
          supersedeOutcome = { superseded: false, reason: 'target-consumed' };
        } else {
          supersededTarget = { message: target, file: targetFile };
          supersedeOutcome = { superseded: true };
        }
      }

      const messagePath = path.join(this.paths.inboxDir, messageFileName(seq, message.from, message.to));
      if (supersededTarget) {
        // Both effects, one lock, before either is visible to a reader.
        supersededTarget.message.supersededBy = seq;
        // supersededAt was written by the two-step path and not by this one, so history could
        // not say WHEN an atomically retracted message stopped being current.
        supersededTarget.message.supersededAt = nowIso();
        supersededTarget.message.supersedeReason = input.supersedeReason?.trim() || `superseded by #${seq}`;
        await this.atomicJson(supersededTarget.file, supersededTarget.message);
      }
      // Only present when supersession was actually requested. An ordinary send must carry no
      // supersession fields at all - a field that is always there is a field nobody reads.
      if (input.supersedes !== undefined) {
        message.superseded = supersedeOutcome.superseded;
        if (supersedeOutcome.reason) message.supersedeOutcome = supersedeOutcome.reason;
      }
      await this.atomicJson(messagePath, message);
      state.seq = seq;
      state.round = round;
      state.agents = knownAgents;
      {
        const queue = this.queueOf(state);
        if (queue.unread) {
          queue.unread[message.to] = (queue.unread[message.to] ?? 0) + 1;
          if (supersededTarget) {
            queue.unread[message.to] = Math.max(0, queue.unread[message.to] - 1);
            (queue.seatMutatedAt ??= {})[message.to] = this.iso();
          }
        }
      }
      // Sending passes the baton. The sender has just acted; the recipient now owes the next
      // action. This is what makes a stall attributable instead of atmospheric - without it,
      // "nobody is doing anything" is indistinguishable from "someone is thinking hard", and
      // every stall on this project happened with both seats alive and heartbeating.
      // An ack keeps the baton by default: the sender has taken the work, not handed it back.
      const implicitAck = input.keepBaton === undefined && message.kind === 'ack';
      const keepsBaton = input.keepBaton ?? implicitAck;
      // A delayed acknowledgement from an old wake must not steal leadership from a newer
      // holder. An ack still confirms work when its sender already holds the baton (the normal
      // handoff path), while an explicit keepBaton value retains its existing semantics.
      const staleAck = implicitAck && state.baton !== null && state.baton.holder !== message.from;
      state.baton = staleAck
        ? state.baton
        : keepsBaton
        ? {
            holder: message.from,
            since: state.baton?.holder === message.from ? state.baton.since : message.createdAt,
            reason: `#${seq} ${message.from} retained baton (compute unverified): ${message.subject}`
          }
        : {
            holder: message.to,
            since: message.createdAt,
            reason: `#${seq} from ${message.from}: ${message.subject}`
          };
      // haltPolicy checkpoints keep their absolute meaning on `round`. There is no lifetime cap.
      const designatedRound = state.haltPolicy.atRounds.includes(round) ||
        (state.haltPolicy.everyRounds !== null && round % state.haltPolicy.everyRounds === 0);
      if (designatedRound) {
        state.halted = true;
        state.stopReason = `designated round checkpoint (${round}) reached`;
      }
      await this.writeStateUnsafe(state);
      await this.appendTranscriptUnsafe(message);
      return message;
    });
  }

  async inbox(agent: string): Promise<BusMessage[]> {
    this.assertAgent(agent, 'agent');
    return (await this.allMessages()).filter(
      (message) => message.to === agent && !message.read && message.supersededBy === undefined
    );
  }

  async read(agent: string, all = false, limit?: number): Promise<BusMessage[]> {
    return (await this.readWithMore(agent, all, limit)).messages;
  }

  /** One scan: the selected messages and whether more unread mail remains for the seat. */
  async readWithMore(agent: string, all = false, limit?: number): Promise<{ messages: BusMessage[]; hasMore: boolean; remaining: number }> {
    this.assertAgent(agent, 'agent');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)) throw new Error('read limit must be 1..10000.');
    return this.withLock(async () => {
      const { messages, files } = await this.scanUnsafe();
      const unread = messages.filter((message) => message.to === agent && isUnreadMessage(message));
      const selected = all ? unread.slice(0, limit ?? unread.length) : unread.slice(0, 1);
      const readAt = nowIso();
      for (const message of selected) {
        message.read = true;
        message.readAt = readAt;
        const messagePath = files.get(message.seq);
        if (!messagePath) {
          throw new Error(`Message file disappeared while reading sequence ${message.seq}.`);
        }
        await this.atomicJson(messagePath, message);
      }
      await this.adjustUnreadUnsafe({ [agent]: -selected.length });
      return { messages: selected, hasMore: unread.length > selected.length, remaining: unread.length - selected.length };
    });
  }

  /** Acknowledge exactly a previously presented unread set, never the current FIFO head. */
  async acknowledge(agent: string, seqs: number[]): Promise<BusMessage[]> {
    this.assertAgent(agent, 'agent');
    if (!Array.isArray(seqs) || seqs.length < 1 || seqs.length > 10_000) {
      throw new Error('acknowledgement sequences must contain 1..10000 entries');
    }
    if (seqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) {
      throw new Error('acknowledgement sequences must be positive integers');
    }
    if (new Set(seqs).size !== seqs.length) {
      throw new Error('acknowledgement sequences must be unique');
    }

    return this.withLock(async () => {
      const scan = await this.scanUnsafe();
      const bySeq = new Map(scan.messages.map((message) => [message.seq, message]));
      // Validate the complete set before writing. A stale or foreign sequence refuses the
      // transaction instead of consuming whatever mail happens to be current now.
      const selected = seqs.map((seq) => {
        const message = bySeq.get(seq);
        if (!message) throw new Error(`message #${seq} does not exist`);
        if (message.to !== agent) {
          throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
        }
        if (message.read || message.supersededBy !== undefined) {
          throw new Error(`message #${seq} is no longer current unread mail for ${agent}`);
        }
        return message;
      });

      const readAt = nowIso();
      for (const message of selected) {
        message.read = true;
        message.readAt = readAt;
        const messagePath = scan.files.get(message.seq);
        if (!messagePath) {
          throw new Error(`Message file disappeared while acknowledging sequence ${message.seq}.`);
        }
        await this.atomicJson(messagePath, message);
      }
      await this.adjustUnreadUnsafe({ [agent]: -selected.length });
      return selected;
    });
  }

  /**
   * Make a newer message the current replacement for an earlier one.
   *
   * Both immutable message bodies remain in mailbox history. Delivery merely skips the
   * superseded row, so an unread stale instruction cannot be acknowledged as current while an
   * already-read instruction and its correction remain auditable as two separate rows.
   */
  async supersedeMessage(seq: number, by: number, reason: string, actor: string): Promise<BusMessage> {
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('message sequence must be a positive integer');
    if (!Number.isSafeInteger(by) || by < 1) throw new Error('superseding message sequence must be a positive integer');
    if (seq === by) throw new Error('a message cannot supersede itself');
    if (!reason.trim()) throw new Error('supersession reason must not be empty');
    return this.withLock(async () => {
      const [messagePath, replacementPath] = await Promise.all([
        this.findMessagePathUnsafe(seq),
        this.findMessagePathUnsafe(by)
      ]);
      if (!messagePath) {
        await this.throwIfArchivedUnsafe(seq);
        throw new Error(`message #${seq} does not exist`);
      }
      if (!replacementPath) {
        await this.throwIfArchivedUnsafe(by);
        throw new Error(`superseding message #${by} does not exist`);
      }
      const [message, replacement] = await Promise.all([
        this.readJson<BusMessage>(messagePath),
        this.readJson<BusMessage>(replacementPath)
      ]);
      this.assertAgent(actor, 'actor');
      if (message.from !== actor || replacement.from !== actor) {
        throw new Error(`${actor} may supersede only messages it sent itself`);
      }
      if (replacement.seq <= message.seq) {
        throw new Error(`superseding message #${by} must be newer than message #${seq}`);
      }
      if (replacement.to !== message.to) {
        throw new Error(`superseding message #${by} is addressed to ${replacement.to}, not ${message.to}`);
      }
      if (replacement.supersededBy !== undefined) {
        throw new Error(`superseding message #${by} is itself superseded by message #${replacement.supersededBy}`);
      }
      if (message.supersededBy !== undefined) {
        if (message.supersededBy === by && message.supersedeReason === reason.trim()) return message;
        throw new Error(`message #${seq} is already superseded by message #${message.supersededBy}`);
      }
      /**
       * Item 18, second audit: the two verbs disagreed about CONSUMED targets.
       *
       * The atomic path reports `target-consumed` and refuses to mark a message the recipient
       * has already read - you cannot retract an instruction that was already acted on, and
       * saying otherwise is a report that the correction landed when it did not. This path
       * marked it anyway, so the old verb could do what the new one correctly refuses. Marking
       * it also HIDES it from the inbox, which is how a seat loses the record of work it is
       * part-way through doing.
       */
      if (message.read) {
        throw new Error(
          `Cannot supersede #${seq}: ${message.to} has already read it. Supersession retracts UNREAD mail; ` +
          'send a correction instead, and close the checkpoint if the work should stop.'
        );
      }
      message.supersededBy = by;
      message.supersededAt = nowIso();
      message.supersedeReason = reason.trim();
      await this.atomicJson(messagePath, message);
      await this.adjustUnreadUnsafe({ [message.to]: -1 });
      await this.appendLineUnsafe(
        [
          '',
          `## Supersession: message #${message.seq}`,
          '',
          `- supersededBy: ${message.supersededBy}`,
          `- supersedeReason: ${message.supersedeReason}`,
          `- time: ${message.supersededAt}`,
          ''
        ].join('\n')
      );
      return message;
    });
  }

  async park(agent: string, seq: number, reason: string): Promise<BusMessage> {
    this.assertAgent(agent, 'agent');
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('message sequence must be a positive integer');
    if (!reason.trim()) throw new Error('parking reason must not be empty');
    return this.withLock(async () => {
      const messagePath = await this.findMessagePathUnsafe(seq);
      if (!messagePath) {
        await this.throwIfArchivedUnsafe(seq);
        throw new Error(`message #${seq} does not exist`);
      }
      const message = await this.readJson<BusMessage>(messagePath);
      if (message.to !== agent) throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
      const wasUnread = isUnreadMessage(message);
      const parkedAt = nowIso();
      message.read = true;
      message.readAt = parkedAt;
      message.parkedAt = parkedAt;
      message.parkedReason = reason.trim();
      this.closeCheckpoints(message, agent, 'parked', parkedAt);
      await this.atomicJson(messagePath, message);
      await this.adjustUnreadUnsafe({ [agent]: wasUnread ? -1 : 0 }, true);
      return message;
    });
  }

  async parked(agent: string): Promise<BusMessage[]> {
    this.assertAgent(agent, 'agent');
    return (await this.allMessages()).filter((message) => message.to === agent && Boolean(message.parkedAt));
  }

  async requeue(agent: string, seq: number): Promise<BusMessage> {
    this.assertAgent(agent, 'agent');
    if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('message sequence must be a positive integer');
    return this.withLock(async () => {
      const messagePath = await this.findMessagePathUnsafe(seq);
      if (!messagePath) {
        await this.throwIfArchivedUnsafe(seq);
        throw new Error(`message #${seq} does not exist`);
      }
      const message = await this.readJson<BusMessage>(messagePath);
      if (message.to !== agent) throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
      // Requeue restores parked mail and, since `expire`, expired mail. Nothing else.
      if (!message.parkedAt && !message.expiredAt) throw new Error(`message #${seq} is not parked or expired`);
      const wasUnread = isUnreadMessage(message);
      message.read = false;
      delete message.readAt;
      delete message.parkedAt;
      delete message.parkedReason;
      delete message.expiredAt;
      delete message.expiredReason;
      this.closeCheckpoints(message, agent, 'requeued');
      await this.atomicJson(messagePath, message);
      await this.adjustUnreadUnsafe({ [agent]: !wasUnread && isUnreadMessage(message) ? 1 : 0 }, true, true);
      return message;
    });
  }

  async openRecovery(agent: string, workId: number, note: string): Promise<RecoveryCheckpoint> {
    this.assertAgent(agent, 'agent');
    if (!Number.isSafeInteger(workId) || workId < 1) throw new Error('workId must be a positive mailbox sequence');
    return this.withLock(async () => {
      const messages = await this.allMessagesUnsafe();
      const source = messages.find((message) => message.seq === workId);
      if (!source) {
        await this.throwIfArchivedUnsafe(workId);
        throw new Error(`message #${workId} does not exist`);
      }
      const holdsInherited = (source.recoveryCheckpoints ?? []).some(
        (item) => item.seat === agent && item.status === 'open'
      );
      if (source.to !== agent && !holdsInherited) {
        throw new Error(`message #${workId} is addressed to ${source.to}, not ${agent}`);
      }
      /**
       * Item 10, third attack. Being the addressee was enough to open a checkpoint, so after
       * the baton moved the PREDECESSOR could re-open one on the same work - producing two
       * open checkpoints on one assignment and handing the brief back to a seat that no
       * longer had it, alongside the seat that did.
       *
       * One assignment, one holder. Someone else's open checkpoint means the work moved.
       */
      const heldByAnother = (source.recoveryCheckpoints ?? []).find(
        (item) => item.seat !== agent && item.status === 'open'
      );
      if (heldByAnother) {
        throw new Error(
          `work #${workId} is held by ${heldByAnother.seat}, not ${agent}. It moved; ask for it back rather than re-opening it.`
        );
      }
      const at = nowIso();
      for (const message of messages) {
        if (message.seq === workId) continue;
        if (this.closeCheckpoints(message, agent, `superseded by work #${workId}`, at)) {
          const file = await this.findMessagePathUnsafe(message.seq);
          if (file) await this.atomicJson(file, message);
        }
      }
      source.recoveryCheckpoints ??= [];
      let checkpoint = source.recoveryCheckpoints.find((item) => item.seat === agent && item.status === 'open');
      if (checkpoint) {
        if (note.trim()) checkpoint.note = note.trim();
        checkpoint.updatedAt = at;
      } else {
        checkpoint = { id: randomUUID(), workId, seat: agent, status: 'open', note: note.trim(), actionReceipts: [], openedAt: at, updatedAt: at };
        source.recoveryCheckpoints.push(checkpoint);
      }
      const file = await this.findMessagePathUnsafe(workId);
      if (!file) throw new Error(`message #${workId} disappeared`);
      await this.atomicJson(file, source);
      return checkpoint;
    });
  }

  async openRecoveryFor(agent: string): Promise<RecoveryCheckpoint | undefined> {
    this.assertAgent(agent, 'agent');
    return (await this.allMessages()).flatMap((message) => message.recoveryCheckpoints ?? [])
      .filter((item) => item.seat === agent && item.status === 'open')
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1);
  }

  async recordRecoveryAction(agent: string, workId: number, actionId: string): Promise<RecoveryCheckpoint> {
    if (!actionId) throw new Error('action receipt id must not be empty');
    return this.withLock(async () => {
      const file = await this.findMessagePathUnsafe(workId);
      if (!file) throw new Error(`message #${workId} does not exist`);
      const message = await this.readJson<BusMessage>(file);
      const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === agent && item.status === 'open');
      if (!checkpoint) throw new Error(`work #${workId} has no open recovery checkpoint for ${agent}`);
      if (!checkpoint.actionReceipts.includes(actionId)) checkpoint.actionReceipts.push(actionId);
      checkpoint.updatedAt = nowIso();
      await this.atomicJson(file, message);
      return checkpoint;
    });
  }

  /**
   * Record an UNTRUSTED claim. Promotion is a later, observed step.
   *
   * Keyed to mailbox work (a message sequence), never to a seat. A missing workId
   * is resolved from the seat's open recovery checkpoint so a continuation wake
   * can add evidence without re-stating the assignment.
   */
  async recordEvidence(input: {
    agent: string;
    subject: string;
    statement: string;
    workId?: number;
  }): Promise<EvidenceRecord> {
    this.assertAgent(input.agent, 'evidence recorder');
    const subject = input.subject.trim();
    const statement = input.statement.trim();
    if (!subject) throw new Error('evidence subject must not be empty');
    if (!statement) throw new Error('evidence statement must not be empty');
    if (subject.length > 500) throw new Error('evidence subject must be at most 500 characters');
    if (statement.length > 4_096) throw new Error('evidence statement must be at most 4096 characters');
    const workId = await this.resolveEvidenceWorkId(input.agent, input.workId);
    return this.evidence.record({
      workId,
      subject,
      statement,
      recordedBy: input.agent
    });
  }

  /**
   * Promote only after THIS process observes the world. The caller names a
   * verifier kind; it cannot supply an observation. A plain object is not one.
   * Promotion binds a recorded event after the claim: a commit that touched the
   * subject path, a passing receipt, or a structured lifecycle/completion event.
   * Boolean(goal) and HEAD-happened-to-list-it are not enough.
   */
  async promoteEvidence(input: {
    agent: string;
    id: string;
    kind: VerifierKind;
    invocation?: string;
    transition?: string;
  }): Promise<EvidenceRecord> {
    this.assertAgent(input.agent, 'evidence promoter');
    if (!input.id.trim()) throw new Error('evidence id must not be empty');
    if (!isVerifierKind(input.kind)) {
      throw new EvidencePromotionError(`unknown verifier kind: ${String(input.kind)}`);
    }
    const record = await this.evidence.get(input.id);
    const verifier = await this.observeVerifier(record, input);
    return this.evidence.promote(record.id, verifier);
  }

  async listEvidence(workId?: number): Promise<EvidenceRecord[]> {
    return this.evidence.list(workId);
  }

  /**
   * Item 2, audit finding: `consolidate` was CALLED FROM NOWHERE.
   *
   * It was implemented, tested and unreachable - the same defect as item 18, and the reason
   * the bar says the store is not the feature. Memory that only compacts when someone
   * remembers to ask never compacts, so this is wired to the moment an assignment ENDS: the
   * episodes are complete, nothing further will be added under that workId, and the seat is
   * about to stop thinking about it.
   *
   * Deliberately best-effort. Compaction failing must never fail the close - losing the record
   * that work finished, in order to tidy the record of how it went, would be a bad trade.
   */
  async consolidateEvidence(
    workId: number,
    recordedBy: string,
    options: { minEpisodes?: number } = {}
  ): Promise<{ summary?: EvidenceRecord; absorbed: number; reason?: string }> {
    this.assertAgent(recordedBy, 'evidence recorder');
    return this.evidence.consolidate(workId, recordedBy, options);
  }

  async evidenceForWake(workIds: number[]): Promise<EvidenceRecord[]> {
    return this.evidence.forWake(workIds);
  }

  async closeRecovery(agent: string, workId: number, reason: string): Promise<RecoveryCheckpoint | undefined> {
    const checkpoint = await this.withLock(async () => {
      const file = await this.findMessagePathUnsafe(workId);
      if (!file) return undefined;
      const message = await this.readJson<BusMessage>(file);
      const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === agent && item.status === 'open');
      if (!checkpoint) return undefined;
      const at = nowIso();
      checkpoint.status = 'closed'; checkpoint.closedAt = at; checkpoint.updatedAt = at;
      checkpoint.closeReason = reason.trim() || 'settled';
      await this.atomicJson(file, message);
      return checkpoint;
    });
    // Item 2: an assignment ending is when its episodes are complete, so it is the moment to
    // compact them. Outside the mailbox lock - the evidence store takes its own - and
    // best-effort, because tidying the record of HOW work went must never fail the record
    // THAT it finished.
    if (checkpoint) {
      try {
        await this.evidence.consolidate(workId, agent);
      } catch {
        // Intentionally swallowed. Compaction is an optimisation; the close is the fact.
      }
    }
    return checkpoint;
  }

  /**
   * Item 10. Recall the assignment an open checkpoint is FOR.
   *
   * A checkpoint carries STATUS ("work remains open") and not CONTENT. Measured 2026-08-15: a
   * seat woke holding open work and could not state its own assignment, and asked five times
   * for the brief to be resent. Nothing needed storing to fix it — `workId` IS the source
   * message's sequence, so the brief was already on disk with every path and gate in it.
   *
   * Recall, never copy. Duplicated state drifts from its source, and a brief that was later
   * RETRACTED must not return through recovery — so a superseded source yields nothing. That is
   * what makes item 3's supersession the revocation path for item 10's carrying.
   */
  async recallAssignment(seat: string, workId: number): Promise<string | undefined> {
    const file = await this.findMessagePathUnsafe(workId);
    if (!file) return undefined;
    const message = await this.readJson<BusMessage>(file);
    // A retracted instruction is not recalled. Supersession is the revocation path.
    if (message.supersededBy !== undefined) return undefined;

    /**
     * Item 10. RECALL IS GRANTED BY AN OPEN CHECKPOINT, NEVER BY THE ADDRESS.
     *
     * Round 1 made recall follow the baton by falling back to the checkpoint when the address
     * did not match. grok's second audit went around it three ways, all through the address:
     * after inheritance the PREDECESSOR still recalled the brief it had lost; after every
     * checkpoint was closed - by an operator, or by the addressee itself - the addressee still
     * recalled it; and the predecessor could re-open a checkpoint on the same work because the
     * address still named it.
     *
     * `item10-recall.test.js` appeared to cover the second of those, but it only proved the
     * RUNNER declines to ask. The store still answered anyone who did.
     *
     * So drop the address as an authority entirely. Holding an open checkpoint on this work is
     * the whole test: it is true for the addressee that is working, true for a successor that
     * inherited, and false for everyone else including the seat that used to hold it.
     */
    const holdsOpenCheckpoint = (message.recoveryCheckpoints ?? []).some(
      (item) => item.seat === seat && item.status === 'open'
    );
    if (!holdsOpenCheckpoint) return undefined;
    return `#${message.seq} from ${message.from}: ${message.subject}\n\n${message.body}`;
  }

  /**
   * Item 20. An operator route to close a checkpoint whose owning seat can no longer close it.
   *
   * `closeRecovery` is reachable only from the runner, so a checkpoint held by a seat with no
   * running brain can never be closed by anyone. The live case that produced this: a brain seat
   * died when node-pty vanished, its work was inherited by the chat-interface seat, and the row
   * kept asserting "implement item 9" for hours after item 9 was certified.
   *
   * This is deliberately NOT a seat-callable primitive. A seat still cannot close another
   * seat's checkpoint â€” that refusal is correct and stays. This requires an explicit operator
   * reason and records it, so a stale close is legible afterwards rather than silent.
   */
  async operatorCloseRecovery(
    seat: string,
    workId: number,
    operatorReason: string
  ): Promise<RecoveryCheckpoint | undefined> {
    if (typeof operatorReason !== 'string' || operatorReason.trim().length === 0) {
      throw new Error('Operator close refused: a reason is required. Nothing was closed.');
    }
    const checkpoint = await this.withLock(async () => {
      const file = await this.findMessagePathUnsafe(workId);
      if (!file) return undefined;
      const message = await this.readJson<BusMessage>(file);
      const checkpoint = message.recoveryCheckpoints?.find(
        (item) => item.seat === seat && item.status === 'open'
      );
      if (!checkpoint) return undefined;
      const at = nowIso();
      checkpoint.status = 'closed';
      checkpoint.closedAt = at;
      checkpoint.updatedAt = at;
      // Marked as an operator action, not a seat outcome, so it never reads as completed work.
      checkpoint.closeReason = `operator-closed: ${operatorReason.trim()}`;
      await this.atomicJson(file, message);
      return checkpoint;
    });
    // Item 2, found by grok: I wired consolidation into closeRecovery and not into its
    // OPERATOR twin, so an assignment ended by an operator never compacted. Both verbs end an
    // assignment; only one of them tidied up. Inheritance and reassignment still must NOT
    // compact - that work is continuing, not finished.
    if (checkpoint) {
      try {
        await this.evidence.consolidate(workId, seat);
      } catch {
        // Intentionally swallowed. Compaction is an optimisation; the close is the fact.
      }
    }
    return checkpoint;
  }

  /**
   * Move one seat's open recovery onto another seat, keeping the same workId.
   *
   * Checkpoints are assignments, not identities. A credit-loss baton move that left the
   * successor unable to inherit #1321 is the failure this exists to close. History stays on
   * the source message: the previous checkpoint is closed, not deleted.
   */
  private async inheritOpenRecoveryUnsafe(
    from: string,
    to: string,
    reason: string
  ): Promise<number | null> {
    const messages = await this.allMessagesUnsafe();
    const source = messages.find((message) =>
      (message.recoveryCheckpoints ?? []).some((item) => item.seat === from && item.status === 'open')
    );
    const checkpoint = source?.recoveryCheckpoints?.find((item) => item.seat === from && item.status === 'open');
    if (!source || !checkpoint) return null;

    const at = nowIso();
    for (const message of messages) {
      if (message.seq === source.seq) continue;
      if (this.closeCheckpoints(message, to, `superseded by inherited work #${source.seq}`, at)) {
        const file = await this.findMessagePathUnsafe(message.seq);
        if (file) await this.atomicJson(file, message);
      }
    }

    checkpoint.status = 'closed';
    checkpoint.closedAt = at;
    checkpoint.updatedAt = at;
    checkpoint.closeReason = `reassigned to ${to}: ${reason}`;
    this.closeCheckpoints(source, to, `superseded by inherited work #${source.seq}`, at);
    source.recoveryCheckpoints ??= [];
    source.recoveryCheckpoints.push({
      id: randomUUID(),
      workId: source.seq,
      seat: to,
      status: 'open',
      note: checkpoint.note,
      actionReceipts: [...checkpoint.actionReceipts],
      inheritedFrom: from,
      openedAt: at,
      updatedAt: at
    });
    const file = await this.findMessagePathUnsafe(source.seq);
    if (!file) throw new Error(`message #${source.seq} disappeared during reassignment`);
    await this.atomicJson(file, source);
    return source.seq;
  }

  private closeCheckpoints(message: BusMessage, agent: string, reason: string, at = nowIso()) {
    let changed = false;
    for (const checkpoint of message.recoveryCheckpoints ?? []) {
      if (checkpoint.seat !== agent || checkpoint.status !== 'open') continue;
      checkpoint.status = 'closed'; checkpoint.closedAt = at; checkpoint.updatedAt = at; checkpoint.closeReason = reason;
      changed = true;
    }
    return changed;
  }

  async waitFor(
    agent: string,
    timeoutMs = 600_000,
    intervalMs = 500,
    afterSeq = 0,
    signal?: AbortSignal
  ): Promise<'message' | 'timeout' | 'server_stopping'> {
    this.assertAgent(agent, 'agent');
    if (timeoutMs < 0 || intervalMs < 25) {
      throw new Error('Timeout must be non-negative and poll interval must be at least 25 ms.');
    }
    const deadline = Date.now() + timeoutMs;
    // Cheap idle path: a full scan only runs when the high-water seq or mailEpoch moved since
    // the last clean scan. The readdir high-water covers a message file written before
    // state.json (send writes the file first, and a crash can orphan it). A scan that had to
    // skip a file (ENOENT/EBUSY) does not advance the mark, so the next interval rescans.
    let lastScannedSeq = -1;
    let lastEpoch = -1;
    do {
      if (signal?.aborted) return 'server_stopping';
      const state = await this.loadState();
      if (state.halted) {
        throw new BusHaltedError(state.stopReason ?? 'bus halted');
      }
      const epoch = state.mailEpoch ?? 0;
      if (lastScannedSeq < 0 || epoch !== lastEpoch) {
        // First pass, or requeue/unarchive changed old mail: one full scan.
        const highWater = Math.max(state.seq, await this.maxHotSequence());
        const scan = await this.scanTolerant();
        this.metrics.waitScans += 1;
        if (scan.messages.some((message) => message.to === agent && isUnreadMessage(message) && message.seq > afterSeq)) {
          return 'message';
        }
        if (scan.skipped === 0) {
          lastScannedSeq = highWater;
          lastEpoch = epoch;
          this.metrics.lastScannedSeq = lastScannedSeq;
        }
      } else {
        // Idle path: names only. Read just the files newer than the last clean pass, so other
        // seats exchanging mail costs one readdir plus their new files, never a full scan. The
        // filenames (not state.seq) drive it, which also catches a crash-orphaned message file.
        const fresh = (await this.hotNames())
          .map((name) => ({ name, seq: Number.parseInt(name, 10) }))
          .filter((entry) => Number.isFinite(entry.seq) && entry.seq > lastScannedSeq)
          .sort((left, right) => left.seq - right.seq);
        // A file that could not be read (EBUSY/EPERM) holds the mark below itself, so the next
        // interval reads it again; a file that vanished (archived) does not.
        let firstSkipped: number | undefined;
        for (const entry of fresh) {
          this.metrics.waitFileReads += 1;
          const filePath = path.join(this.paths.inboxDir, entry.name);
          const message = await this.readTolerant(filePath);
          if (!message) {
            if (await this.exists(filePath)) {
              firstSkipped ??= entry.seq;
              this.metrics.skipped += 1;
            }
            continue;
          }
          if (message.to === agent && isUnreadMessage(message) && message.seq > afterSeq) return 'message';
        }
        const cleanThrough = firstSkipped !== undefined
          ? firstSkipped - 1
          : Math.max(lastScannedSeq, ...fresh.map((entry) => entry.seq));
        lastScannedSeq = cleanThrough;
        this.metrics.lastScannedSeq = lastScannedSeq;
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delayUntil(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    return 'timeout';
  }

  async claim(input: ClaimInput): Promise<Claim[]> {
    this.assertAgent(input.agent, 'agent');
    // Item 7: a claim must say why it exists. Enforced HERE, at the store, not only at the CLI
    // â€” the invocable surfaces were already safe and the store was not, which is exactly how
    // supersedeMessage's optional actor let a direct call forge a foreign retract.
    if (typeof input.why !== 'string' || input.why.trim().length === 0) {
      throw new ClaimReasonRequiredError();
    }
    const requested = input.paths.map((item) => this.normalizeClaimPath(item));
    if (requested.length === 0) {
      throw new Error('At least one claim path is required.');
    }
    // Item 13: a claim on the repository root is indistinguishable from a legitimate ancestor
    // claim like `src/` under the current rules, and it locks every seat out of everything with
    // no warning and no expiry. Measured 2026-08-15: a seat claimed "." while meaning the files
    // it was editing, and all three seats were blocked until an operator noticed.
    // Ancestor claims BELOW the root stay legal â€” that is what the walk exists to support.
    for (const requestedPath of requested) {
      if (requestedPath === '.' || requestedPath === '' || requestedPath === '/') {
        throw new WholeRepositoryClaimError(requestedPath);
      }
    }

    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      this.assertSeated(state, input.agent, 'agent');
      const missing: string[] = [];
      const claimRoots = input.repoRoot
        ? [path.resolve(input.repoRoot), this.paths.root]
        : [this.paths.root];
      /**
       * Resolve the roots FIRST, before any path is looked at.
       *
       * A configured root that does not exist is a MISCONFIGURATION, not a licence. Under the
       * old code it silently dropped out of the comparison and took the containment rule with
       * it - which is exactly how grok's foreign-tree attack got in. Checking here rather than
       * after resolution also means the caller is told what is actually wrong: a bad root
       * previously surfaced as "path does not exist", sending someone to hunt the wrong bug.
       */
      const rootRealPaths: string[] = [];
      for (const rootPath of claimRoots) {
        try {
          rootRealPaths.push(this.canonicalComparablePath(await fs.realpath(rootPath)));
        } catch {
          throw new Error(
            `claim root does not exist: ${rootPath}. Refusing every claim rather than checking against a root that is not there.`
          );
        }
      }
      // `real` is the resolved destination, junctions and symlinks followed. The lexical path
      // says what was asked for; only this says where it actually lands.
      const resolved: Array<{ path: string; root: string; identity: string; real: string }> = [];
      for (const requestedPath of requested) {
        let match: { path: string; root: string; identity: string; real: string } | undefined;
        for (const root of claimRoots) {
          const candidate = path.resolve(root, requestedPath);
          if (!(await this.exists(candidate))) continue;
          try {
            const identity = await fs.stat(candidate, { bigint: true });
            match = {
              path: requestedPath,
              root: this.canonicalComparablePath(await fs.realpath(root)),
              identity: filesystemIdentityMaterial(identity.dev, identity.ino),
              real: this.canonicalComparablePath(await fs.realpath(candidate))
            };
          } catch {
            // The path can disappear between exists() and identity discovery. Treat that as
            // missing rather than crashing or recording an identity we did not observe.
            continue;
          }
          break;
        }
        if (!match) {
          missing.push(requestedPath);
        } else {
          resolved.push(match);
        }
      }
      if (missing.length > 0) {
        throw new ClaimPathMissingError(missing);
      }
      /**
       * Item 13. The lexical check above cannot see a junction: `everything` pointing at the
       * repo root passes as the path "everything", and claimsOverlap - which compares by inode
       * - then blocks every file in the tree. Another spelling of everything.
       *
       * The first fix refused a claim whose identity EQUALS a claim root, and grok's second
       * audit walked straight around it twice: a junction to the root's PARENT is not equal to
       * the root but contains it, and with a `repoRoot` that does not exist a junction to an
       * unrelated tree is not equal to anything and was simply allowed.
       *
       * Both are the same mistake - enumerating bad destinations. So state the rule positively
       * instead, which is the only form that closes the class: A CLAIM MUST RESOLVE STRICTLY
       * UNDER A CLAIM ROOT. Equal to a root is not under it; above a root is not under it; a
       * foreign tree is not under it. Ancestor claims BELOW a root are untouched, which is the
       * property the overlap walk exists to support.
       */
      for (const candidate of resolved) {
        const under = rootRealPaths.some(
          // canonicalComparablePath normalises to forward slashes, so compare with `/`, not
          // path.sep - on Windows the latter matches nothing and refuses every claim.
          (rootReal) => candidate.real !== rootReal && candidate.real.startsWith(`${rootReal}/`)
        );
        if (!under) {
          throw new WholeRepositoryClaimError(candidate.path);
        }
      }
      for (const [other, claims] of Object.entries(state.claims)) {
        if (other === input.agent) {
          continue;
        }
        for (const requestedClaim of resolved) {
          const conflict = claims.find((claim) => this.claimsOverlap(requestedClaim, claim, claimRoots));
          if (conflict) {
            throw new ClaimConflictError(other, conflict);
          }
        }
      }

      const held = [...(state.claims[input.agent] ?? [])];
      const timestamp = nowIso();
      let changed = false;
      for (const requestedClaim of resolved) {
        if (held.some((claim) => this.claimContains(claim, requestedClaim, claimRoots))) {
          continue;
        }
        for (let index = held.length - 1; index >= 0; index -= 1) {
          if (this.claimContains(requestedClaim, held[index], claimRoots)) {
            held.splice(index, 1);
          }
        }
        held.push({ ...requestedClaim, why: input.why?.trim() || '', at: timestamp });
        changed = true;
      }
      held.sort((left, right) => `${left.root ?? ''}\0${left.path}`.localeCompare(`${right.root ?? ''}\0${right.path}`));
      if (changed) {
        state.claims[input.agent] = held;
        await this.writeStateUnsafe(state);
        await this.appendLineUnsafe(
          `\n- **claim** \`${input.agent}\` -> ${requested.join(', ')} (${input.why?.trim() || ''})\n`
        );
      }
      return held;
    });
  }

  async release(agent: string, paths?: string[], repoRoot?: string): Promise<Claim[]> {
    this.assertAgent(agent, 'agent');
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      const held = state.claims[agent] ?? [];
      if (held.length === 0) {
        return [];
      }
      if (!paths || paths.length === 0) {
        delete state.claims[agent];
        await this.writeStateUnsafe(state);
        await this.appendLineUnsafe(`\n- **release** \`${agent}\` -> all\n`);
        return [];
      }

      const requested = paths.map((item) => this.normalizeClaimPath(item));
      /**
       * REALPATH, to match how claim() stored it.
       *
       * This was `canonicalComparablePath(repoRoot ?? this.paths.root)` - the only root
       * canonicalisation in the file that did NOT resolve links first. claim() stores
       * `canonicalComparablePath(await fs.realpath(root))`, so wherever realpath differs from
       * resolve, a claim could be taken and then never released: the seat held it forever and
       * every later claim on that path was refused as a conflict.
       *
       * Invisible on the author's machine, where the two are equal. Found by CI on
       * windows-latest, whose temp directory is an 8.3 short name that realpath expands -
       * `codex does not hold exact claim(s): src/mailbox.ts` - and reproduced locally through
       * a junction, which has the same property.
       *
       * That is the whole argument for pushing: 28 items were certified on one filesystem
       * where this asymmetry cannot show.
       */
      const requestedRoot = await this.canonicalRootForCompare(repoRoot ?? this.paths.root);
      const selected = requested.map((requestedPath) => {
        const matches = held.filter((claim) => claim.path === requestedPath);
        if (matches.length <= 1) {
          const only = matches[0];
          if (repoRoot && only?.root && only.root !== requestedRoot) return undefined;
          return only;
        }
        return matches.find((claim) => claim.root === requestedRoot);
      });
      const missing = requested.filter((_item, index) => !selected[index]);
      if (missing.length > 0) {
        throw new Error(`${agent} does not hold exact claim(s): ${missing.join(', ')}`);
      }
      // Exact release remains lexical even when load-time migration has strengthened an older
      // claim with an observed root and filesystem identity.
      const released = new Set(selected.map((claim) => `${claim!.root ?? ''}\0${claim!.path}`));
      const remaining = held.filter((claim) => !released.has(`${claim.root ?? ''}\0${claim.path}`));
      if (remaining.length > 0) {
        state.claims[agent] = remaining;
      } else {
        delete state.claims[agent];
      }
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(`\n- **release** \`${agent}\` -> ${requested.join(', ')}\n`);
      return remaining;
    });
  }

  /**
   * Stop the bus deliberately.
   *
   * `force` exists because of a real incident on 2026-08-07: halting while ANOTHER seat held
   * the baton with unread mail left that seat able to read but not send - trapped, unable to
   * either act or hand back. From its side it looked as though the halting agent had failed to
   * pass the baton, and it had no way to say so, because saying so requires a send.
   *
   * Halting is still always allowed - a human must be able to stop anything - but halting ON
   * TOP OF someone else's open action now requires saying you meant it.
   */
  async halt(reason: string, options: { force?: boolean; by?: string } = {}): Promise<MailboxState> {
    if (!options.force) {
      const current = await this.loadState();
      const holder = current.baton?.holder;
      if (holder && holder !== options.by) {
        const unread = (await this.inbox(holder)).length;
        if (unread > 0) {
          throw new Error(
            `Refusing to halt: ${holder} holds the baton with ${unread} unread message(s) and ` +
            `would be trapped - able to read but not reply. Let them act, or pass --force if ` +
            `you know they are gone.`
          );
        }
      }
    }
    return this.haltUnchecked(reason);
  }

  private async haltUnchecked(reason: string): Promise<MailboxState> {
    if (!reason.trim()) {
      throw new Error('Halt reason must not be empty.');
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      state.halted = true;
      state.stopReason = reason.trim();
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(`\n**BUS HALTED** - ${reason.trim()}\n`);
      return state;
    });
  }

  /** Record what the bus is for. Overwrites any previous goal; history lives in the transcript. */
  async setGoal(goal: { statement: string; doneWhen: string; setBy?: string }): Promise<MailboxState> {
    if (!goal.statement?.trim()) throw new Error('goal statement is required.');
    if (!goal.doneWhen?.trim()) {
      // Refusing a goal without completion criteria is the point. A goal you cannot check is
      // a mood, and it would make `complete-goal` unfalsifiable.
      throw new Error('done-when is required: a goal with no completion criteria cannot be checked.');
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      const previous = state.goal;
      const at = nowIso();
      state.goal = {
        statement: goal.statement.trim(),
        doneWhen: goal.doneWhen.trim(),
        setAt: at,
        setBy: goal.setBy ?? null,
        // A replacement goal is a new coordination contract. Carrying the previous goal's
        // assignments forward briefly tells every returning seat to perform obsolete work and
        // is especially dangerous when a brain wakes between `goal` and the later `assign`
        // commands. Require the operator to assign the new goal deliberately.
        assignments: {}
      };
      const event: LifecycleEvent = {
        id: randomUUID(),
        kind: previous ? 'goal-replaced' : 'goal-set',
        at,
        previousIdentity: previous?.setAt ?? null,
        nextIdentity: at
      };
      state.lifecycleEvents.push(event);
      state.lifecycleEvents = state.lifecycleEvents.slice(-100);
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(
        `\n---\n\n## GOAL\n\n${state.goal.statement}\n\n**Done when:** ${state.goal.doneWhen}\n\n---\n`
      );
      return state;
    });
  }

  /**
   * Assign a seat its slice of `doneWhen`.
   *
   * Without this, division of labour lives only in whichever message happened to describe it,
   * so a seat that joins late - or returns after going dark - has no durable answer to "what
   * am I responsible for?". That is how work silently goes unowned.
   */
  /**
   * The seat's standing responsibility, or undefined when it has none.
   *
   * The counterpart to `assignGoal`, and it did not exist until 2026-08-20. `assignGoal`
   * answered "what am I responsible for?" by WRITING it down, and nothing ever read it back on
   * a wake — so the answer was durable and unreachable. Two seats asked for their brief to be
   * re-sent by hand on the same day. That is the cost of a write with no read.
   *
   * Unlike `recallAssignment` this needs no supersession check: `assignGoal` overwrites in
   * place, so there is no earlier version for it to resurrect.
   */
  async currentAssignment(seat: string): Promise<string | undefined> {
    const state = await this.loadState();
    const responsibility = state.goal?.assignments?.[seat];
    return responsibility && responsibility.trim() ? responsibility : undefined;
  }

  async assignGoal(seat: string, responsibility: string): Promise<MailboxState> {
    // Refuse at WRITE time what would truncate at READ time.
    //
    // 2026-08-20, both seats, same defect. The assignment is presented to a waking seat through
    // a field capped at RECOVERY_LIMIT_BYTES. Longer text is cut off on arrival, and the reader
    // cannot know what it did not receive: codex got a brief severed mid-claim and correctly
    // refused to infer the rest; grok held an open checkpoint whose 2845-byte brief truncated
    // before the gates it named, so the gates could never be met and the checkpoint could never
    // close. A closed loop assembled entirely out of correct behaviour at both ends.
    //
    // The operator writing this can fix it in one edit. The seat reading it can do nothing. So
    // the check goes here, and it REFUSES rather than truncating-with-a-warning: this field is a
    // pointer to a brief, not the brief, and silently storing something that cannot be delivered
    // whole is how the loop above was built.
    //
    // Bytes, not characters - the cap is a byte budget, and a char-count guard passes multibyte
    // text that still arrives severed.
    const size = Buffer.byteLength(responsibility, 'utf8');
    if (size > ASSIGNMENT_LIMIT_BYTES) {
      throw new Error(
        `Assignment for ${seat} is ${size} bytes; the wake field holds ${ASSIGNMENT_LIMIT_BYTES}. ` +
        'It would arrive truncated and the seat could not tell. Put a short pointer here - the ' +
        'tasks in order, the permission, and "detail arrives as mail" - and send the brief as mail.'
      );
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      if (!state.goal) throw new Error('No goal set. Run: mailbox goal --statement ... --done-when ...');
      if (!state.agents.includes(seat)) throw new Error(`Unknown seat: ${seat}`);
      state.goal.assignments[seat] = responsibility;
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(`\n**ASSIGNED** ${seat}: ${responsibility}\n`);
      return state;
    });
  }

  /**
   * Is anyone actually on the hook right now?
   *
   * Deliberately reports rather than acts. An automatic reassignment would paper over the
   * question a human needs answered - WHY did the holder stop - and would let a broken loop
   * look self-healing.
   */
  /**
   * Move the baton off a holder that cannot act.
   *
   * Raised by Hymlock 2026-08-09: if the orchestrating seat runs out of tokens, the baton is
   * stranded and the whole system stops - `stallCheck` DETECTS that and nothing fixed it.
   * Detection without recovery is a smoke alarm with no fire exit.
   *
   * The guard is what makes this failover rather than a coup: the current holder must have
   * been silent for `staleAfterSeconds` before anyone may take it. An agent cannot seize the
   * baton from a peer that is actively working, which would be a far worse failure than the
   * stall - two seats making decisions is how you get contradictory work nobody can untangle.
   */
  async reassignBaton(input: {
    to: string;
    reason: string;
    /** Atomic compare-and-move guard for automated failover. */
    expectedFrom?: string;
    staleAfterSeconds?: number;
    /** Operator override: skip the staleness guard. For a human who can see the truth. */
    force?: boolean;
  }): Promise<{ moved: boolean; from: string | null; to: string; why: string; inheritedWorkId: number | null }> {
    const staleAfter = input.staleAfterSeconds ?? 300;
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      const from = state.baton?.holder ?? null;
      if (!state.agents.includes(input.to)) {
        throw new Error(`unknown agent: ${input.to}`);
      }
      if (input.expectedFrom !== undefined && from !== input.expectedFrom) {
        return {
          moved: false,
          from,
          to: input.to,
          inheritedWorkId: null,
          why: `baton holder changed from expected ${input.expectedFrom} to ${from ?? '<nobody>'}; refusing stale failover`
        };
      }
      if (from === input.to) {
        return {
          moved: false,
          from,
          to: input.to,
          inheritedWorkId: null,
          why: `${input.to} already holds the baton`
        };
      }
      const heldSeconds = state.baton
        ? (Date.now() - Date.parse(state.baton.since)) / 1000
        : Number.POSITIVE_INFINITY;
      if (!input.force && from && heldSeconds < staleAfter) {
        return {
          moved: false,
          from,
          to: input.to,
          inheritedWorkId: null,
          why: `${from} has held the baton only ${Math.round(heldSeconds)}s (< ${staleAfter}s). ` +
               'Refusing: taking it from an active holder is a coup, not a failover. Use force ' +
               'only if you can see that the holder is genuinely unable to act.'
        };
      }
      state.baton = {
        holder: input.to,
        since: new Date().toISOString(),
        reason: `reassigned from ${from ?? '<nobody>'} after ${Math.round(heldSeconds)}s: ${input.reason}`
      };
      await this.writeStateUnsafe(state);
      const inheritedWorkId = from
        ? await this.inheritOpenRecoveryUnsafe(from, input.to, input.reason)
        : null;
      return {
        moved: true,
        from,
        to: input.to,
        inheritedWorkId,
        why: state.baton.reason
      };
    });
  }

  async stallCheck(staleAfterSeconds = 300): Promise<{
    stalled: boolean; reason: string; holder: string | null; heldSeconds: number | null;
  }> {
    const state = await this.loadState();
    if (state.halted) {
      return { stalled: false, reason: `halted: ${state.stopReason ?? 'no reason recorded'}`, holder: null, heldSeconds: null };
    }
    if (!state.goal) {
      return { stalled: true, reason: 'no goal set - nothing to be finished, so nobody owes an action', holder: null, heldSeconds: null };
    }
    if (!state.baton) {
      return { stalled: true, reason: 'goal is open but NOBODY holds the baton - no open action exists', holder: null, heldSeconds: null };
    }
    const held = (Date.now() - Date.parse(state.baton.since)) / 1000;
    if (held > staleAfterSeconds) {
      return {
        stalled: true,
        reason: `${state.baton.holder} has held the baton ${Math.round(held)}s without acting (${state.baton.reason})`,
        holder: state.baton.holder,
        heldSeconds: Math.round(held)
      };
    }
    return { stalled: false, reason: `${state.baton.holder} owes the next action`, holder: state.baton.holder, heldSeconds: Math.round(held) };
  }

  async configureHalting(policy: Partial<HaltPolicy>): Promise<MailboxState> {
    if (policy.onStepCompletion === undefined && policy.onGoalCompletion === undefined &&
        policy.atRounds === undefined && policy.everyRounds === undefined) {
      throw new Error('At least one halt policy option is required.');
    }
    const atRounds = policy.atRounds === undefined ? undefined : normalizeHaltRounds(policy.atRounds);
    const everyRounds = policy.everyRounds === undefined ? undefined : normalizeEveryRounds(policy.everyRounds);
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      state.haltPolicy = {
        onStepCompletion: policy.onStepCompletion ?? state.haltPolicy.onStepCompletion,
        onGoalCompletion: policy.onGoalCompletion ?? state.haltPolicy.onGoalCompletion,
        atRounds: atRounds ?? state.haltPolicy.atRounds,
        everyRounds: everyRounds === undefined ? state.haltPolicy.everyRounds : everyRounds
      };
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(
        `\n**HALT POLICY** step=${state.haltPolicy.onStepCompletion} goal=${state.haltPolicy.onGoalCompletion} ` +
        `at=${state.haltPolicy.atRounds.join(',') || 'none'} every=${state.haltPolicy.everyRounds ?? 'off'}\n`
      );
      return state;
    });
  }

  async complete(input: { scope: 'step' | 'goal'; actor: string; summary: string; evidence?: string[] }): Promise<CompletionEvent> {
    this.assertAgent(input.actor, 'completion actor');
    if (input.scope !== 'step' && input.scope !== 'goal') throw new Error('Completion scope must be step or goal.');
    const summary = input.summary.trim();
    if (!summary || summary.length > 10_000) throw new Error('Completion summary must be 1..10000 characters.');
    const evidence = Array.from(new Set(input.evidence ?? []));
    if (evidence.length > 32 || evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 4_096)) {
      throw new Error('Completion evidence must contain at most 32 non-empty strings up to 4096 characters each.');
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      if (state.halted) throw new BusHaltedError(state.stopReason ?? 'bus halted');
      const shouldHalt = input.scope === 'step' ? state.haltPolicy.onStepCompletion : state.haltPolicy.onGoalCompletion;
      const event: CompletionEvent = {
        id: randomUUID(),
        scope: input.scope,
        actor: input.actor,
        summary,
        evidence: evidence.map((item) => item.trim()),
        at: nowIso(),
        halted: shouldHalt
      };
      state.completions.push(event);
      state.completions = state.completions.slice(-100);
      if (shouldHalt) {
        state.halted = true;
        state.stopReason = `${input.scope} completed by ${input.actor}: ${summary}`;
      }
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(
        `\n**${input.scope.toUpperCase()} COMPLETED** by \`${input.actor}\`${shouldHalt ? ' - BUS HALTED' : ''}\n\n${summary}\n` +
        (event.evidence.length > 0 ? `\nEvidence: ${event.evidence.join(', ')}\n` : '')
      );
      return event;
    });
  }

  /**
   * Plain resume clears a halt, writes state schema 2 plus the old-binary sentinel, and
   * recounts unread. `addRounds` is accepted for CLI compatibility only: rounds are no longer a
   * limit, so a non-zero value changes nothing and returns the notice.
   */
  async resume(addRounds = 0): Promise<MailboxState & { notice?: string }> {
    if (!Number.isInteger(addRounds) || addRounds < 0) {
      throw new Error('addRounds must be a non-negative integer.');
    }
    if (addRounds > 0) {
      const current = await this.loadState();
      return { ...current, notice: current.halted ? `${ROUNDS_IGNORED_NOTICE}; ${STILL_HALTED_NOTICE}` : ROUNDS_IGNORED_NOTICE };
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      state.halted = false;
      state.stopReason = null;
      await this.recountUnsafe(state);
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe('\n**BUS RESUMED** (queue-depth guard)\n');
      return state;
    });
  }

  async status(): Promise<MailboxStatus> {
    const [state, messages, workspaceCommit] = await Promise.all([
      this.loadState(),
      this.allMessages(),
      this.gitStamp()
    ]);
    const unread = this.unreadBySeat(state, messages);
    const queueView = this.queueViewOf(state, messages.length, unread);
    const warnings = this.queueWarnings(state, queueView);
    return { ...state, unread, workspaceCommit, queueView, ...warnings };
  }

  async claims(): Promise<Record<string, Claim[]>> {
    return (await this.loadState()).claims;
  }

  async epoch(): Promise<string> {
    return (await this.loadState()).createdAt;
  }

  async doctor(): Promise<DoctorReport> {
    const obstruction = await this.lockObstruction();
    if (obstruction) {
      return {
        ok: false,
        problems: [obstruction],
        warnings: ['Stop all bus processes and verify the recorded PID before removing only the named lock file.'],
        metrics: { messages: 0, unread: 0, claims: 0, temporaryFiles: 0 }
      };
    }
    return this.withLock(async () => {
      const problems: string[] = [];
      const warnings: string[] = [];
      let state: MailboxState | undefined;
      let messages: BusMessage[] = [];

      try {
        state = await this.loadState();
        if (!ACCEPTED_STATE_SCHEMAS.has(state.schema)) {
          problems.push(`state schema is ${state.schema}; expected ${STATE_SCHEMA}`);
        } else {
          if (state.schema !== STATE_SCHEMA) {
            warnings.push(`state schema is ${state.schema}; run "mailbox.js upgrade-state" to enable the queue-depth guard`);
          }
          if (await this.migrateClaimIdentities(state) && state.schema === STATE_SCHEMA) {
            await this.writeStateUnsafe(state);
          }
        }
      } catch (error) {
        problems.push(`state.json cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }

      try {
        messages = await this.allMessagesUnsafe();
      } catch (error) {
        problems.push(`inbox cannot be read: ${error instanceof Error ? error.message : String(error)}`);
      }

      const sequences = new Set<number>();
      for (const message of messages) {
        if (message.schema !== MESSAGE_SCHEMA) {
          problems.push(`message ${message.seq} schema is ${message.schema}; expected ${MESSAGE_SCHEMA}`);
        }
        if (sequences.has(message.seq)) {
          problems.push(`duplicate message sequence ${message.seq}`);
        }
        sequences.add(message.seq);
      }

      // Archive checks: live seqs are unique across hot and (segments minus restored); every
      // sidecar matches its segment; seq never falls below the archive high-water. Gaps are
      // allowed (a crashed send can leave one; 1529/1530 is a real example).
      const archive = await this.doctorArchiveUnsafe(sequences, problems, warnings, state);
      const maximumSequence = Math.max(
        messages.reduce((maximum, message) => Math.max(maximum, message.seq), 0),
        archive.highWater
      );
      if (state) {
        if (state.seq < maximumSequence) {
          problems.push(`state seq is ${state.seq}; inbox maximum is ${maximumSequence} (message high-water, hot + archive)`);
        } else if (state.seq > maximumSequence && archive.highWater === 0 && (state.queue?.archived ?? 0) === 0 && messages.length > 0) {
          warnings.push(`state seq is ${state.seq}; inbox maximum is ${maximumSequence} (gap)`);
        }
        if (state.round < maximumSequence) {
          problems.push(`state round is ${state.round}; cannot be lower than message sequence ${maximumSequence}`);
        }
        const known = new Set(state.agents);
        for (const message of messages) {
          if (!known.has(message.from)) {
            warnings.push(`message ${message.seq} sender is not registered: ${message.from}`);
          }
          if (!known.has(message.to)) {
            warnings.push(`message ${message.seq} recipient is not registered: ${message.to}`);
          }
        }

        const owners = Object.entries(state.claims);
        for (const [owner, claims] of owners) {
          for (const claim of claims) {
            if (!this.isFilesystemIdentity(claim.identity)) {
              const shape = claim.identity ? 'path-only' : 'legacy';
              warnings.push(
                `${owner}:${claim.path} uses weaker ${shape} claim identity; `
                + 'filesystem alias overlap cannot be verified until the path is reachable'
              );
            }
          }
        }
        for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
          const [leftOwner, leftClaims] = owners[leftIndex];
          for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
            const [rightOwner, rightClaims] = owners[rightIndex];
            for (const leftClaim of leftClaims) {
              for (const rightClaim of rightClaims) {
                if (this.claimsOverlap(leftClaim, rightClaim, [this.paths.root])) {
                  problems.push(
                    `claims overlap: ${leftOwner}:${leftClaim.path} and ${rightOwner}:${rightClaim.path}`
                  );
                }
              }
            }
          }
        }
      }

      const listNames = async (dir: string) => fs.readdir(dir).catch(() => [] as string[]);
      const temporaryFiles = [
        ...(await listNames(this.paths.mailboxDir)),
        ...(await listNames(this.paths.inboxDir)),
        ...(await listNames(this.paths.archiveDir))
      ].filter((name) => name.endsWith('.tmp') || name.endsWith('.candidate'));
      if (temporaryFiles.length > 0) {
        warnings.push(`${temporaryFiles.length} orphan temporary file(s) found`);
      }
      if (!(await this.exists(this.paths.transcriptPath))) {
        warnings.push('transcript.md is missing');
      }
      if (state && ACCEPTED_STATE_SCHEMAS.has(state.schema)) {
        const unread = this.unreadBySeat(state, messages);
        const view = this.queueViewOf(state, messages.length, unread);
        if (view.hot >= view.maxHot) warnings.push(`hot inbox has ${view.hot} messages; backstop is ${view.maxHot}`);
        const queueWarnings = this.queueWarnings(state, view);
        if (queueWarnings.queueWarning) warnings.push(queueWarnings.queueWarning);
        // Doctor recounts the advisory unread counter. It writes only on schema 2, so running
        // doctor before upgrade-state never upgrades the mailbox implicitly.
        if (state.schema === STATE_SCHEMA && problems.length === 0) {
          const locked = await this.loadStateUnsafe();
          await this.recountUnsafe(locked, messages);
          await this.writeStateUnsafe(locked);
        }
      }

      return {
        ok: problems.length === 0,
        problems,
        warnings,
        metrics: {
          messages: messages.length,
          unread: messages.filter((message) => !message.read && message.supersededBy === undefined).length,
          claims: state
            ? Object.values(state.claims).reduce((total, claims) => total + claims.length, 0)
            : 0,
          temporaryFiles: temporaryFiles.length
        }
      };
    });
  }

  // ---------------------------------------------------------------------------------------
  // Queue-depth guard, retention and archive (AGREED-PLAN bus-prune-1105).
  //
  // Invariants:
  //  - Unread mail is never archived. Pinned, parked, checkpointed and recent mail is never
  //    archived. Pressure mode drops only the age rule.
  //  - "Hot wins": whenever a seq exists in the hot inbox, that copy is the truth.
  //  - The seq high-water is derived from filenames (hot + segment names), never from counters.
  //  - The per-seat unread counter is advisory. A refusal needs a trusted recount.
  // ---------------------------------------------------------------------------------------

  private iso() {
    return new Date(this.clock()).toISOString();
  }

  retentionOf(state: MailboxState): typeof DEFAULT_RETENTION {
    return { ...DEFAULT_RETENTION, ...(state.retention ?? {}) };
  }

  /** Computed backstop: room for the recent window, pins, every seat at its cap, and slack. */
  maxHotOf(state: MailboxState) {
    const retention = this.retentionOf(state);
    return retention.keepRecent + retention.pinnedAllowance + Math.max(1, state.agents.length) * retention.maxUnreadPerSeat + 100;
  }

  private queueOf(state: MailboxState): QueueState {
    state.queue ??= {};
    return state.queue;
  }

  private unreadBySeat(state: MailboxState, messages: BusMessage[]) {
    const unread: Record<string, number> = {};
    for (const agent of state.agents) unread[agent] = 0;
    for (const message of messages) {
      if (isUnreadMessage(message)) unread[message.to] = (unread[message.to] ?? 0) + 1;
    }
    return unread;
  }

  private queueViewOf(state: MailboxState, hot: number, unread: Record<string, number>): QueueView {
    const retention = this.retentionOf(state);
    return {
      hot,
      maxHot: this.maxHotOf(state),
      unread,
      maxUnreadPerSeat: retention.maxUnreadPerSeat,
      archived: state.queue?.archived ?? 0,
      archivedThrough: state.queue?.archivedThrough ?? 0,
      lastPruneAt: state.queue?.lastPruneAt ?? null
    };
  }

  private queueWarnings(state: MailboxState, view: QueueView): { queueWarning?: string; backstopWarning?: string; roundWarning?: string } {
    const cap = view.maxUnreadPerSeat;
    const pressured = Object.entries(view.unread)
      .filter(([, count]) => count >= Math.ceil(cap * PRESSURE_FRACTION))
      .sort((left, right) => right[1] - left[1]);
    const result: { queueWarning?: string; backstopWarning?: string; roundWarning?: string } = {};
    if (pressured.length > 0) {
      result.queueWarning = pressured
        .map(([seat, count]) => `${seat}: ${count}/${cap} unread; ${seat} must read or the owner may \`expire\``)
        .join('; ');
      result.roundWarning = result.queueWarning;
    }
    if (view.hot >= Math.ceil(view.maxHot * PRESSURE_FRACTION)) {
      result.backstopWarning = `hot inbox ${view.hot}/${view.maxHot}; pruning runs every ${this.retentionOf(state).pressureIntervalMinutes} min under pressure`;
    }
    return result;
  }

  /** Apply counter deltas after a locked mutation. Unknown counters stay unknown (recount). */
  private async adjustUnreadUnsafe(deltas: Record<string, number>, mutated = false, bumpEpoch = false) {
    const changed = Object.entries(deltas).filter(([, delta]) => delta !== 0);
    if (changed.length === 0 && !mutated && !bumpEpoch) return;
    if (!(await this.exists(this.paths.statePath))) return;
    const state = await this.loadStateUnsafe();
    const queue = this.queueOf(state);
    const at = this.iso();
    queue.seatMutatedAt ??= {};
    for (const seat of Object.keys(deltas)) {
      queue.seatMutatedAt[seat] = at;
      if (queue.unread) queue.unread[seat] = Math.max(0, (queue.unread[seat] ?? 0) + deltas[seat]);
    }
    if (bumpEpoch) state.mailEpoch = (state.mailEpoch ?? 0) + 1;
    await this.writeStateUnsafe(state);
  }

  /** Recount unread from a strict scan (or the scan the caller already has). */
  private async recountUnsafe(state: MailboxState, messages?: BusMessage[]) {
    const scanned = messages ?? (await this.allMessagesUnsafe());
    const unread = this.unreadBySeat(state, scanned);
    const queue = this.queueOf(state);
    const at = this.iso();
    queue.unread = unread;
    queue.unreadVerifiedAt = Object.fromEntries(Object.keys(unread).map((seat) => [seat, at]));
    queue.lastRecountAt = at;
    this.metrics.recounts += 1;
    return scanned;
  }

  private pruneIntervalMs(state: MailboxState, pressure: boolean) {
    const retention = this.retentionOf(state);
    // "Nothing eligible" backs off to the long interval only for a run that could have found
    // the same mail: a normal-mode run that found nothing says little about pressure mode
    // (which ignores the age rule), so it must not hold a pressure batch off for 60 minutes.
    const sameModeFoundNothing = state.queue?.lastPruneEligible === 0 &&
      (!pressure || state.queue?.lastPruneMode === 'pressure');
    if (sameModeFoundNothing) return retention.minIntervalMinutes * 60_000;
    return (pressure ? retention.pressureIntervalMinutes : retention.minIntervalMinutes) * 60_000;
  }

  /** After a failed in-send batch, wait at least the pressure interval (and never under 60s). */
  private failedPruneBackoffMs(state: MailboxState) {
    return Math.max(MIN_BACKSTOP_RETRY_MS, this.retentionOf(state).pressureIntervalMinutes * 60_000);
  }

  /** Earliest clock time at which the next prune may run, or NaN when one may run now. */
  private nextPruneAt(state: MailboxState, pressure: boolean) {
    const last = Date.parse(state.queue?.lastPruneAt ?? '');
    const attempt = Date.parse(state.queue?.lastPruneAttemptAt ?? '');
    const candidates: number[] = [];
    if (Number.isFinite(last)) candidates.push(last + this.pruneIntervalMs(state, pressure));
    if (Number.isFinite(attempt)) candidates.push(attempt + this.failedPruneBackoffMs(state));
    return candidates.length > 0 ? Math.max(...candidates) : Number.NaN;
  }

  private pruneDue(state: MailboxState, pressure: boolean) {
    const next = this.nextPruneAt(state, pressure);
    return !Number.isFinite(next) || this.clock() >= next;
  }

  /**
   * Send order under the lock: (1) halted was checked by the caller, (2) per-seat cap with the
   * recount rule, (3) backstop with at most one pressure batch and one recheck. Throws
   * QueueFullError; never latches.
   */
  private async enforceQueueGuardUnsafe(state: MailboxState, to: string) {
    const retention = this.retentionOf(state);
    const queue = this.queueOf(state);
    const cap = retention.maxUnreadPerSeat;
    if (!queue.unread || queue.unread[to] === undefined) {
      await this.recountUnsafe(state);
    }
    let count = queue.unread?.[to] ?? 0;
    if (count >= cap) {
      const verified = Date.parse(queue.unreadVerifiedAt?.[to] ?? '');
      const mutated = Date.parse(queue.seatMutatedAt?.[to] ?? '');
      const trusted = Number.isFinite(verified) &&
        this.clock() - verified < RECOUNT_TRUST_MS &&
        (!Number.isFinite(mutated) || verified > mutated);
      if (!trusted) {
        await this.recountUnsafe(state);
        count = queue.unread?.[to] ?? 0;
      }
      if (count >= cap) {
        await this.writeStateUnsafe(state);
        throw new QueueFullError(to, count, cap, SEAT_RETRY_AFTER_MS, 'seat');
      }
    }
    const maxHot = this.maxHotOf(state);
    let hot = (await this.hotNames()).length;
    if (hot >= Math.ceil(maxHot * PRESSURE_FRACTION)) {
      if (this.pruneDue(state, true)) {
        try {
          await this.archiveBatchUnsafe(state, { mode: 'pressure', dryRun: false, trigger: 'send' });
        } catch (error) {
          // The in-send batch is best effort. A failed batch (for example a Windows sharing
          // violation on the state.json publish while readers hold it open) leaves its journal
          // for the next archive run to finish; the send must not fail with that I/O error.
          // Try to finish it now; then reload so the send never persists a half-applied
          // in-memory batch.
          await this.recoverArchiveUnsafe().catch(() => undefined);
          const fresh = await this.loadStateUnsafe();
          for (const key of Object.keys(state)) delete (state as Record<string, unknown>)[key];
          Object.assign(state, fresh);
          const failed = this.queueOf(state);
          failed.lastPruneAttemptAt = this.iso();
          failed.archiveWarnings = [
            ...(failed.archiveWarnings ?? []),
            `in-send pressure batch failed: ${error instanceof Error ? error.message : String(error)}`
          ].slice(-20);
        }
        hot = (await this.hotNames()).length;
      }
      if (hot >= maxHot) {
        // Never 0: when no prune time is known (or it is already due), wait the failed-prune
        // backoff; otherwise the time until the next allowed prune, floored at 60s.
        const next = this.nextPruneAt(state, true);
        const remaining = Number.isFinite(next) ? next - this.clock() : this.failedPruneBackoffMs(state);
        const retryAfterMs = Math.max(MIN_BACKSTOP_RETRY_MS, remaining);
        await this.writeStateUnsafe(state);
        const totalUnread = Object.values(this.queueOf(state).unread ?? {}).reduce((sum, value) => sum + value, 0);
        throw new QueueFullError('*', totalUnread, maxHot, retryAfterMs, 'backstop', hot);
      }
    }
  }

  /** Full state for the guard path. Lock-free; no inbox scan, no git. */
  async snapshot(): Promise<MailboxState> {
    return this.loadState();
  }

  /**
   * The model-facing status: under 2 KB, bounded by trimming the baton reason and the caller's
   * claims. `{full:true}` callers use status() instead.
   */
  async statusBrief(caller?: string): Promise<BriefStatus> {
    const [state, scan, workspaceCommit] = await Promise.all([this.loadState(), this.scanTolerant(), this.gitStamp()]);
    const unread = this.unreadBySeat(state, scan.messages);
    const queue = this.queueViewOf(state, scan.messages.length + scan.skipped, unread);
    // roundWarning is a full-status alias only; the brief carries queueWarning once.
    const { roundWarning: _alias, ...warnings } = this.queueWarnings(state, queue);
    const claimCounts: Record<string, number> = {};
    for (const [seat, items] of Object.entries(state.claims)) claimCounts[seat] = items.length;
    const trim = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
    const stopReason = state.halted && state.stopReason ? this.displayStopReason(state.stopReason) : undefined;
    const brief: BriefStatus = {
      brief: true,
      halted: state.halted,
      ...(stopReason ? { stopReason: trim(stopReason, 200) } : {}),
      agents: state.agents,
      baton: state.baton ? { ...state.baton, reason: trim(state.baton.reason, 240) } : null,
      round: state.round,
      unread,
      queue,
      ...warnings,
      claimCounts,
      ...(workspaceCommit ? { workspaceCommit } : {})
    };
    if (caller) {
      const mine = (state.claims[caller] ?? []).map((claim) => ({ ...claim, why: trim(claim.why, 120) }));
      brief.claims = mine;
      while (Buffer.byteLength(JSON.stringify(brief), 'utf8') > 1900 && brief.claims && brief.claims.length > 0) {
        brief.claims.pop();
        brief.claimsTruncated = (brief.claimsTruncated ?? 0) + 1;
      }
    }
    return brief;
  }

  /** A legacy round-guard halt reason, shown as the text that points at plain `resume`. */
  private displayStopReason(reason: string) {
    return reason !== LEGACY_HALT_REWRITE && LEGACY_ROUND_HALT.test(reason) ? LEGACY_HALT_REWRITE : reason;
  }

  /** Rewrite a halt latched by the retired round guard. Returns true when it changed. */
  private rewriteLegacyHalt(state: MailboxState) {
    if (!state.halted || !state.stopReason) return false;
    const next = this.displayStopReason(state.stopReason);
    if (next === state.stopReason) return false;
    state.stopReason = next;
    return true;
  }

  /**
   * One-time migration of a schema-1 mailbox: write schema 2 + sentinel, set the per-seat cap
   * (default max(200, roundUp100(maxBacklog + 100)) so no seat is refused at once), recount.
   * Does not archive and does not expire anything.
   */
  async upgradeState(options: { maxUnreadPerSeat?: number } = {}): Promise<{ state: MailboxState; maxUnreadPerSeat: number; unread: Record<string, number>; previousSchema: number }> {
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      const previousSchema = state.schema;
      const messages = await this.recountUnsafe(state);
      const unread = this.unreadBySeat(state, messages);
      state.retention ??= {};
      if (options.maxUnreadPerSeat !== undefined) {
        if (!Number.isSafeInteger(options.maxUnreadPerSeat) || options.maxUnreadPerSeat < 1) throw new Error('max-unread-per-seat must be a positive integer.');
        state.retention.maxUnreadPerSeat = options.maxUnreadPerSeat;
      } else if (state.retention.maxUnreadPerSeat === undefined) {
        state.retention.maxUnreadPerSeat = migrationCap(unread);
      }
      this.rewriteLegacyHalt(state);
      state.mailEpoch ??= 0;
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(`\n**STATE UPGRADED** schema ${previousSchema} -> ${STATE_SCHEMA}; per-seat cap ${state.retention.maxUnreadPerSeat}\n`);
      return { state, maxUnreadPerSeat: state.retention.maxUnreadPerSeat, unread, previousSchema };
    });
  }

  async configureRetention(settings: RetentionSettings): Promise<typeof DEFAULT_RETENTION> {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) continue;
      if (!(key in DEFAULT_RETENTION)) throw new Error(`unknown retention setting ${key}`);
      const minimum = key === 'keepRecent' || key === 'minAgeHours' || key === 'pinnedAllowance' ? 0 : 1;
      if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${key} must be an integer >= ${minimum}.`);
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      state.retention = { ...(state.retention ?? {}), ...Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)) };
      await this.writeStateUnsafe(state);
      return this.retentionOf(state);
    });
  }

  /**
   * Explicit, start-up and timer archive runs. Each batch takes and releases the lock, so
   * writers interleave. Dry-run writes nothing and returns the owner-facing sentences.
   */
  async archive(options: { dryRun?: boolean; pressure?: boolean; auto?: boolean; maxBatches?: number; trigger?: string } = {}): Promise<ArchiveRunReport> {
    const dryRun = options.dryRun ?? false;
    const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
    const batches: ArchiveBatchReport[] = [];
    let mode: 'normal' | 'pressure' = options.pressure ? 'pressure' : 'normal';
    let first: { hot: number; state: MailboxState; messages: BusMessage[] } | undefined;
    let last: { state: MailboxState; hot: number } | undefined;
    let publishFailures = 0;
    while (batches.length < maxBatches) {
      let report: ArchiveBatchReport;
      try {
        report = await this.withLock(async () => {
          const state = await this.loadStateUnsafe();
          const scan = await this.scanUnsafe();
          if (options.auto && !options.pressure) {
            mode = scan.messages.length >= Math.ceil(this.maxHotOf(state) * PRESSURE_FRACTION) ? 'pressure' : 'normal';
          }
          if (!first) first = { hot: scan.messages.length, state: JSON.parse(JSON.stringify(state)), messages: scan.messages };
          const batch = await this.archiveBatchUnsafe(state, { mode, dryRun, trigger: options.trigger ?? 'cli' }, scan);
          last = { state, hot: batch.hotAfter };
          return batch;
        });
        publishFailures = 0;
      } catch (error) {
        if (!(error instanceof ArchivePublishError)) throw error;
        // The batch committed; only the counter publish failed. Finish it from the journal
        // (best effort: a still-held state.json leaves the journal for the next run) and keep
        // going, so one sharing violation does not abort an explicit or timer run.
        publishFailures += 1;
        report = error.report;
        const recovered = await this.withLock(async () => {
          await this.recoverArchiveUnsafe();
          return true;
        }).catch(() => false);
        report.warning = `${error.message}; ${recovered ? 'counters recovered from the journal' : 'journal left for the next archive run'}`;
        await this.withLock(async () => {
          const state = await this.loadStateUnsafe();
          const queue = this.queueOf(state);
          queue.archiveWarnings = [...(queue.archiveWarnings ?? []), report.warning as string].slice(-20);
          await this.writeStateUnsafe(state);
        }).catch(() => undefined);
        const fresh = await this.loadState().catch(() => undefined);
        if (fresh) last = { state: fresh, hot: report.hotAfter };
        if (publishFailures >= MAX_PUBLISH_FAILURES) {
          batches.push(report);
          break;
        }
      }
      batches.push(report);
      if (dryRun || report.archived === 0) break;
    }
    const state = last?.state ?? (await this.loadState());
    const unread = first ? this.unreadBySeat(state, first.messages) : {};
    const retention = this.retentionOf(state);
    const eligible = dryRun ? (batches[0]?.eligible ?? 0) : batches.reduce((sum, batch) => sum + batch.archived, 0);
    const hotBefore = first?.hot ?? 0;
    const hotAfter = dryRun ? hotBefore - eligible : (last?.hot ?? hotBefore);
    return {
      mode,
      dryRun,
      batches,
      hotBefore,
      hotAfter,
      eligible: batches[0]?.eligible ?? 0,
      archived: batches.reduce((sum, batch) => sum + batch.archived, 0),
      maxHot: this.maxHotOf(state),
      maxUnreadPerSeat: retention.maxUnreadPerSeat,
      unread,
      sentences: this.seatSentences(state, first?.messages ?? [], unread)
    };
  }

  /** Owner-facing dry-run sentences: what resume will do to each seat, in plain words. */
  private seatSentences(state: MailboxState, messages: BusMessage[], unread: Record<string, number>) {
    const cap = this.retentionOf(state).maxUnreadPerSeat;
    const now = this.clock();
    const windowMs = 7 * 86_400_000;
    const sentences: string[] = [];
    const seats = Object.keys(unread);
    for (const seat of seats) {
      const count = unread[seat];
      const recent = messages.filter((message) => message.to === seat && now - Date.parse(message.createdAt) <= windowMs);
      const oldest = recent.reduce((minimum, message) => Math.min(minimum, Date.parse(message.createdAt)), now);
      const days = Math.max(1, (now - oldest) / 86_400_000);
      const rate = recent.length / days;
      const others = seats.length > 1 ? ' Other seats are unaffected.' : '';
      if (count >= cap) {
        sentences.push(`${seat} has ${count}/${cap} unread. Sends to ${seat} will be refused immediately at resume unless ${seat} reads or you approve an expire.${others}`);
      } else if (rate > 0) {
        const daysLeft = (cap - count) / rate;
        const when = daysLeft < 1 ? 'in under a day' : `in about ${Math.round(daysLeft)} day${Math.round(daysLeft) === 1 ? '' : 's'}`;
        sentences.push(`${seat} has ${count}/${cap} unread. Sends to ${seat} are allowed at resume. At ${seat}'s past rate (~${Math.round(rate)}/day), sends to ${seat} will be refused ${when} unless ${seat} reads or you approve an expire.${others}`);
      } else {
        sentences.push(`${seat} has ${count}/${cap} unread. Sends to ${seat} are allowed at resume.`);
      }
    }
    return sentences;
  }

  /** Seqs that must stay hot, with the first reason found. */
  private async pinsUnsafe(state: MailboxState, messages: BusMessage[]) {
    const pins = new Map<number, string>();
    const pin = (seq: number, reason: string) => {
      if (!pins.has(seq)) pins.set(seq, reason);
    };
    for (const claims of Object.values(state.claims)) {
      for (const claim of claims) for (const seq of seqTokens(claim.why)) pin(seq, 'claim');
    }
    if (state.baton) for (const seq of seqTokens(state.baton.reason)) pin(seq, 'baton');
    if (state.goal) {
      for (const text of Object.values(state.goal.assignments ?? {})) for (const seq of seqTokens(text)) pin(seq, 'goal');
      for (const seq of seqTokens(state.goal.statement)) pin(seq, 'goal');
      for (const seq of seqTokens(state.goal.doneWhen)) pin(seq, 'goal');
    }
    try {
      for (const record of currentEvidence(await this.evidence.list())) pin(record.workId, 'evidence');
    } catch {
      // Unreadable evidence: fail safe by pinning every hot seq that evidence could reference.
      for (const message of messages) pin(message.seq, 'evidence');
    }
    return pins;
  }

  private blockReason(message: BusMessage, pins: Map<number, string>, keepFrom: number, cutoff: number, mode: 'normal' | 'pressure') {
    if (isUnreadMessage(message)) return 'unread';
    if (message.parkedAt) return 'parked';
    if (message.recoveryCheckpoints?.some((checkpoint) => checkpoint.status === 'open')) return 'checkpoint';
    if (pins.has(message.seq)) return 'pinned';
    if (message.seq >= keepFrom) return 'recent';
    if (mode === 'normal') {
      const touched = Math.max(Date.parse(message.createdAt) || 0, Date.parse(message.restoredAt ?? '') || 0);
      if (touched > cutoff) return 'young';
    }
    return null;
  }

  /** One archive batch under the caller's lock. Writes state (counters) unless dry-run. */
  private async archiveBatchUnsafe(
    state: MailboxState,
    options: { mode: 'normal' | 'pressure'; dryRun: boolean; trigger: string },
    scan?: { messages: BusMessage[]; files: Map<number, string> }
  ): Promise<ArchiveBatchReport> {
    const retention = this.retentionOf(state);
    const { messages, files } = scan ?? (await this.scanUnsafe());
    const pins = await this.pinsUnsafe(state, messages);
    const keepFrom = retention.keepRecent > 0 && messages.length > 0
      ? messages[Math.max(0, messages.length - retention.keepRecent)].seq
      : Number.POSITIVE_INFINITY;
    const cutoff = this.clock() - retention.minAgeHours * 3_600_000;
    const blocked: Record<string, number> = {};
    const eligible: BusMessage[] = [];
    for (const message of messages) {
      const reason = this.blockReason(message, pins, keepFrom, cutoff, options.mode);
      if (reason) blocked[reason] = (blocked[reason] ?? 0) + 1;
      else eligible.push(message);
    }
    const selected = eligible.slice(0, retention.batch);
    const report: ArchiveBatchReport = {
      mode: options.mode,
      dryRun: options.dryRun,
      hot: messages.length,
      eligible: eligible.length,
      selected: selected.length,
      archived: 0,
      kept: [],
      blocked,
      hotAfter: messages.length
    };
    if (options.dryRun) {
      report.hotAfter = messages.length - selected.length;
      return report;
    }
    this.metrics.pruneBatches += 1;
    await this.recountUnsafe(state, messages);
    const queue = this.queueOf(state);
    if (selected.length > 0) {
      const outcome = await this.writeArchiveRunUnsafe(selected, files, options.mode);
      report.archived = outcome.deleted;
      report.kept = outcome.kept;
      report.segment = outcome.segment;
      report.hotAfter = messages.length - outcome.deleted;
      // Step 6: counters, then journal removal, then the transcript line.
      queue.archived = (queue.archived ?? 0) + outcome.deleted;
      queue.archivedThrough = Math.max(queue.archivedThrough ?? 0, ...selected.map((message) => message.seq));
      if (outcome.kept.length > 0) {
        queue.archiveWarnings = [
          ...(queue.archiveWarnings ?? []),
          `archive ${outcome.segment}: hot copy of #${outcome.kept.join(', #')} changed during the run; hot kept`
        ].slice(-20);
      }
    }
    queue.lastPruneAt = this.iso();
    queue.lastPruneEligible = eligible.length;
    queue.lastPruneHot = report.hotAfter;
    queue.lastPruneMode = options.mode;
    queue.lastPruneArchived = report.archived;
    delete queue.lastPruneAttemptAt;
    await this.fault('before-state');
    try {
      await this.writeStateUnsafe(state);
    } catch (error) {
      if (selected.length > 0 && TRANSIENT_FS_CODES.has(errorCode(error) ?? '')) throw new ArchivePublishError(report, error);
      throw error;
    }
    if (selected.length > 0) {
      await this.fault('before-journal-delete');
      await fs.rm(this.paths.journalPath, { force: true });
      await this.appendLineUnsafe(`\n**ARCHIVED** #${selected[0].seq}-#${selected[selected.length - 1].seq} (${report.archived}) -> ${report.segment} [${options.mode}, ${options.trigger}]\n`);
    }
    return report;
  }

  private async fault(point: string) {
    if (this.archiveFault) await this.archiveFault(point);
  }

  private async durableWrite(filePath: string, content: string) {
    const handle = await fs.open(filePath, 'w');
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeJournal(journal: ArchiveJournal) {
    const temporary = `${this.paths.journalPath}.${process.pid}.${randomUUID()}.tmp`;
    await this.durableWrite(temporary, `${JSON.stringify(journal, null, 2)}\n`);
    await this.renameWithRetry(temporary, this.paths.journalPath);
  }

  /** Steps 2-5 of one archive run. Returns how many hot files were deleted and which were kept. */
  private async writeArchiveRunUnsafe(selected: BusMessage[], files: Map<number, string>, mode: 'normal' | 'pressure') {
    await fs.mkdir(this.paths.archiveDir, { recursive: true });
    const firstSeq = selected[0].seq;
    const lastSeq = selected[selected.length - 1].seq;
    let base = `seg-${String(firstSeq).padStart(6, '0')}-${String(lastSeq).padStart(6, '0')}`;
    const existing = new Set(await fs.readdir(this.paths.archiveDir));
    for (let suffix = 1; existing.has(`${base}.ndjson`) || existing.has(`${base}.index.json`); suffix += 1) {
      base = `seg-${String(firstSeq).padStart(6, '0')}-${String(lastSeq).padStart(6, '0')}-${suffix}`;
    }
    const journal: ArchiveJournal = {
      runId: randomUUID(),
      phase: 'writing',
      base,
      seqs: selected.map((message) => message.seq),
      mode,
      startedAt: this.iso()
    };
    await this.writeJournal(journal);
    await this.fault('after-journal');
    const rows: ArchiveRow[] = [];
    let content = '';
    for (const message of selected) {
      const line = `${JSON.stringify(message)}\n`;
      rows.push([message.seq, message.from, message.to, message.kind, message.createdAt, message.read, Boolean(message.expiredAt), Buffer.byteLength(content, 'utf8')]);
      content += line;
    }
    const segmentPath = path.join(this.paths.archiveDir, `${base}.ndjson`);
    const sidecarPath = path.join(this.paths.archiveDir, `${base}.index.json`);
    await this.durableWrite(`${segmentPath}.tmp`, content);
    await this.durableWrite(`${sidecarPath}.tmp`, `${JSON.stringify({ schema: 1, segment: `${base}.ndjson`, count: rows.length, bytes: Buffer.byteLength(content, 'utf8'), rows })}\n`);
    await this.fault('after-tmp');
    await this.renameWithRetry(`${sidecarPath}.tmp`, sidecarPath);
    await this.fault('after-sidecar-rename');
    await this.renameWithRetry(`${segmentPath}.tmp`, segmentPath);
    await this.fault('after-segment-rename');
    journal.phase = 'committed';
    await this.writeJournal(journal);
    await this.fault('after-commit');
    const outcome = await this.deleteArchivedHotUnsafe(base, selected, files);
    await this.fault('after-delete');
    return { ...outcome, segment: `${base}.ndjson` };
  }

  /** Step 5: delete a hot file only when it still deep-equals the archived copy. */
  private async deleteArchivedHotUnsafe(base: string, archivedMessages: BusMessage[], files?: Map<number, string>) {
    let deleted = 0;
    const kept: number[] = [];
    let index = 0;
    for (const archived of archivedMessages) {
      const hotPath = files?.get(archived.seq) ?? (await this.findMessagePathUnsafe(archived.seq));
      if (!hotPath) {
        deleted += 1;
        continue;
      }
      let current: BusMessage;
      try {
        current = await this.readJson<BusMessage>(hotPath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          deleted += 1;
          continue;
        }
        throw error;
      }
      if (stableStringify(current) !== stableStringify(archived)) {
        kept.push(archived.seq);
        await this.addRestoredUnsafe({ seq: archived.seq, segment: `${base}.ndjson`, at: this.iso(), reason: 'hot copy changed during archive; hot kept' });
        continue;
      }
      await fs.rm(hotPath, { force: true });
      deleted += 1;
      index += 1;
      if (index === 1) await this.fault('mid-delete');
    }
    return { deleted, kept };
  }

  /**
   * Crash recovery for an interrupted archive run. Runs inside withLock before every action.
   * writing   -> nothing was deleted: drop the temp files and this run's renamed files.
   * committed -> the segment is durable: redo the guarded delete and the counter update.
   */
  private async recoverArchiveUnsafe() {
    let journal: ArchiveJournal;
    try {
      journal = JSON.parse(await fs.readFile(this.paths.journalPath, 'utf8')) as ArchiveJournal;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return;
      if (error instanceof SyntaxError) {
        // A torn journal can only come from the writing phase (it is fsynced and renamed).
        await fs.rm(this.paths.journalPath, { force: true });
        return;
      }
      throw error;
    }
    const segmentPath = path.join(this.paths.archiveDir, `${journal.base}.ndjson`);
    const sidecarPath = path.join(this.paths.archiveDir, `${journal.base}.index.json`);
    if (journal.phase === 'writing') {
      for (const file of [`${segmentPath}.tmp`, `${sidecarPath}.tmp`, segmentPath, sidecarPath]) await fs.rm(file, { force: true });
      await fs.rm(this.paths.journalPath, { force: true });
      return;
    }
    const archivedMessages = await this.readSegmentUnsafe(journal.base);
    const outcome = await this.deleteArchivedHotUnsafe(journal.base, archivedMessages);
    if (await this.exists(this.paths.statePath)) {
      const state = await this.loadStateUnsafe();
      await this.recountUnsafe(state);
      const queue = this.queueOf(state);
      const already = queue.archivedThrough !== undefined && queue.archivedThrough >= Math.max(...journal.seqs) && queue.lastPruneArchived !== undefined && queue.lastPruneAt !== undefined && Date.parse(queue.lastPruneAt) >= Date.parse(journal.startedAt);
      if (!already) {
        queue.archived = (queue.archived ?? 0) + outcome.deleted;
        queue.archivedThrough = Math.max(queue.archivedThrough ?? 0, ...journal.seqs);
        queue.lastPruneAt = this.iso();
        queue.lastPruneArchived = outcome.deleted;
        queue.lastPruneMode = journal.mode;
      }
      await this.writeStateUnsafe(state);
    }
    await fs.rm(this.paths.journalPath, { force: true });
    await this.appendLineUnsafe(`\n**ARCHIVED** #${journal.seqs[0]}-#${journal.seqs[journal.seqs.length - 1]} (${outcome.deleted}) -> ${journal.base}.ndjson [recovered]\n`);
  }

  private async segmentList(): Promise<{ base: string; first: number; last: number }[]> {
    const names = await fs.readdir(this.paths.archiveDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    return names
      .map((name) => ({ name, match: SEGMENT_PATTERN.exec(name) }))
      .filter((item): item is { name: string; match: RegExpExecArray } => Boolean(item.match))
      .map(({ name, match }) => ({ base: name.slice(0, -'.ndjson'.length), first: Number(match[1]), last: Number(match[2]) }))
      .sort((left, right) => left.first - right.first || left.base.localeCompare(right.base));
  }

  private async archiveHighWater() {
    return (await this.segmentList()).reduce((maximum, segment) => Math.max(maximum, segment.last), 0);
  }

  private async readSidecar(base: string): Promise<{ schema: number; segment: string; count: number; bytes?: number; rows: ArchiveRow[] }> {
    return this.readJson(path.join(this.paths.archiveDir, `${base}.index.json`));
  }

  private async readSegmentUnsafe(base: string): Promise<BusMessage[]> {
    const content = await fs.readFile(path.join(this.paths.archiveDir, `${base}.ndjson`), 'utf8');
    return content.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line) as BusMessage);
  }

  private async readArchivedRow(base: string, row: ArchiveRow): Promise<BusMessage> {
    const sidecar = await this.readSidecar(base);
    const index = sidecar.rows.findIndex((item) => item[0] === row[0] && item[7] === row[7]);
    const handle = await fs.open(path.join(this.paths.archiveDir, `${base}.ndjson`), 'r');
    try {
      const size = (await handle.stat()).size;
      const end = index >= 0 && index + 1 < sidecar.rows.length ? sidecar.rows[index + 1][7] : size;
      const buffer = Buffer.alloc(end - row[7]);
      await handle.read(buffer, 0, buffer.length, row[7]);
      return JSON.parse(buffer.toString('utf8')) as BusMessage;
    } finally {
      await handle.close();
    }
  }

  private async restoredEntries(): Promise<RestoredEntry[]> {
    try {
      return (await this.readJson<{ entries: RestoredEntry[] }>(this.paths.restoredPath)).entries ?? [];
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return [];
      throw error;
    }
  }

  private async addRestoredUnsafe(entry: RestoredEntry) {
    const entries = await this.restoredEntries();
    entries.push(entry);
    await fs.mkdir(this.paths.archiveDir, { recursive: true });
    await this.atomicJson(this.paths.restoredPath, { schema: 1, entries });
  }

  /** Archived rows that are still the live copy: not tombstoned by restored.json. */
  private async liveArchiveIndex(): Promise<Map<number, { base: string; row: ArchiveRow }[]>> {
    const restored = new Set((await this.restoredEntries()).map((entry) => `${entry.seq}\0${entry.segment}`));
    const index = new Map<number, { base: string; row: ArchiveRow }[]>();
    for (const segment of await this.segmentList()) {
      let sidecar;
      try {
        sidecar = await this.readSidecar(segment.base);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        throw error;
      }
      for (const row of sidecar.rows) {
        if (restored.has(`${row[0]}\0${segment.base}.ndjson`)) continue;
        const list = index.get(row[0]) ?? [];
        list.push({ base: segment.base, row });
        index.set(row[0], list);
      }
    }
    return index;
  }

  /** Callers that look up one message by seq throw this when the seq lives in the archive. */
  private async throwIfArchivedUnsafe(seq: number) {
    const index = await this.liveArchiveIndex();
    if (index.has(seq)) throw new Error(`message #${seq} is archived; run "mailbox.js unarchive ${seq}"`);
  }

  async show(seq: number): Promise<BusMessage & { archivedIn?: string }> {
    const hot = await this.findMessagePathUnsafe(seq);
    if (hot) {
      try {
        return await this.readJson<BusMessage>(hot);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    const entries = (await this.liveArchiveIndex()).get(seq);
    if (!entries || entries.length === 0) throw new Error(`message #${seq} does not exist`);
    const entry = entries[entries.length - 1];
    return { ...(await this.readArchivedRow(entry.base, entry.row)), archivedIn: `${entry.base}.ndjson` };
  }

  async archived(filter: { to?: string; expired?: boolean; fromSeq?: number; limit?: number } = {}) {
    const index = await this.liveArchiveIndex();
    const rows: { seq: number; from: string; to: string; kind: string; createdAt: string; read: boolean; expired: boolean; segment: string }[] = [];
    for (const [seq, entries] of [...index.entries()].sort((left, right) => left[0] - right[0])) {
      const { base, row } = entries[entries.length - 1];
      if (filter.to && row[2] !== filter.to) continue;
      if (filter.expired && !row[6]) continue;
      if (filter.fromSeq !== undefined && seq < filter.fromSeq) continue;
      rows.push({ seq, from: row[1], to: row[2], kind: row[3], createdAt: row[4], read: row[5], expired: row[6], segment: `${base}.ndjson` });
    }
    return filter.limit !== undefined ? rows.slice(0, filter.limit) : rows;
  }

  /** Copy archived messages back into the hot inbox. Bumps mailEpoch so waiters rescan. */
  async unarchive(seqs: number[]): Promise<BusMessage[]> {
    if (seqs.length === 0 || seqs.some((seq) => !Number.isSafeInteger(seq) || seq < 1)) throw new Error('unarchive needs positive message sequences.');
    return this.withLock(async () => {
      const index = await this.liveArchiveIndex();
      const restored: BusMessage[] = [];
      const deltas: Record<string, number> = {};
      for (const seq of seqs) {
        if (await this.findMessagePathUnsafe(seq)) throw new Error(`message #${seq} is already in the hot inbox`);
        const entries = index.get(seq);
        if (!entries || entries.length === 0) throw new Error(`message #${seq} is not archived`);
        const entry = entries[entries.length - 1];
        const message = await this.readArchivedRow(entry.base, entry.row);
        message.restoredAt = this.iso();
        // Hot first, tombstone second: a crash between leaves hot + archive, and hot wins.
        await this.atomicJson(path.join(this.paths.inboxDir, messageFileName(message.seq, message.from, message.to)), message);
        for (const item of entries) {
          await this.addRestoredUnsafe({ seq, segment: `${item.base}.ndjson`, at: message.restoredAt, reason: 'unarchive' });
        }
        if (isUnreadMessage(message)) deltas[message.to] = (deltas[message.to] ?? 0) + 1;
        else deltas[message.to] ??= 0;
        restored.push(message);
      }
      const state = await this.loadStateUnsafe();
      const queue = this.queueOf(state);
      for (const [seat, delta] of Object.entries(deltas)) {
        if (queue.unread) queue.unread[seat] = (queue.unread[seat] ?? 0) + delta;
        (queue.seatMutatedAt ??= {})[seat] = this.iso();
      }
      queue.archived = Math.max(0, (queue.archived ?? 0) - restored.length);
      state.mailEpoch = (state.mailEpoch ?? 0) + 1;
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(`\n**UNARCHIVED** #${seqs.join(', #')}\n`);
      return restored;
    });
  }

  /** Copy the archive directory (segments, sidecars, restored.json) somewhere durable. */
  async exportArchive(destination: string): Promise<{ to: string; files: number }> {
    const target = path.resolve(destination);
    await fs.mkdir(target, { recursive: true });
    const names = await fs.readdir(this.paths.archiveDir).catch(() => [] as string[]);
    let files = 0;
    for (const name of names) {
      if (name.endsWith('.tmp') || name === 'journal.json') continue;
      await fs.copyFile(path.join(this.paths.archiveDir, name), path.join(target, name));
      files += 1;
    }
    return { to: target, files };
  }

  /**
   * Owner-approved bulk expire of a seat's unread mail. Expired mail counts as read, keeps its
   * file, and `requeue` restores it. Parked, checkpointed and pinned mail is skipped.
   */
  async expire(options: { seat: string; throughSeq?: number; olderThanHours?: number; kind?: string; reason?: string; dryRun?: boolean }): Promise<ExpireReport> {
    this.assertAgent(options.seat, 'seat');
    const dryRun = options.dryRun ?? false;
    if (!dryRun && !options.reason?.trim()) throw new Error('expire requires --reason (or --dry-run).');
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      const { messages, files } = await this.scanUnsafe();
      const pins = await this.pinsUnsafe(state, messages);
      const cutoff = options.olderThanHours !== undefined ? this.clock() - options.olderThanHours * 3_600_000 : Number.POSITIVE_INFINITY;
      const report: ExpireReport = { dryRun, seat: options.seat, matched: [], expired: [], skipped: { parked: [], checkpoint: [], pinned: [] } };
      const targets: BusMessage[] = [];
      for (const message of messages) {
        if (message.to !== options.seat) continue;
        if (options.throughSeq !== undefined && message.seq > options.throughSeq) continue;
        if (options.kind && message.kind !== options.kind) continue;
        if (Number.isFinite(cutoff) && Date.parse(message.createdAt) > cutoff) continue;
        if (message.parkedAt) {
          report.skipped.parked.push(message.seq);
          continue;
        }
        if (!isUnreadMessage(message)) continue;
        report.matched.push(message.seq);
        if (message.recoveryCheckpoints?.some((checkpoint) => checkpoint.status === 'open')) {
          report.skipped.checkpoint.push(message.seq);
          continue;
        }
        if (pins.has(message.seq)) {
          report.skipped.pinned.push(message.seq);
          continue;
        }
        targets.push(message);
      }
      if (dryRun) {
        report.expired = targets.map((message) => message.seq);
        return report;
      }
      const at = this.iso();
      for (const message of targets) {
        message.read = true;
        message.readAt = at;
        message.expiredAt = at;
        message.expiredReason = options.reason!.trim();
        await this.atomicJson(files.get(message.seq)!, message);
        report.expired.push(message.seq);
      }
      const queue = this.queueOf(state);
      if (queue.unread) queue.unread[options.seat] = Math.max(0, (queue.unread[options.seat] ?? 0) - targets.length);
      (queue.seatMutatedAt ??= {})[options.seat] = at;
      await this.writeStateUnsafe(state);
      if (targets.length > 0) {
        await this.appendLineUnsafe(`\n**EXPIRED** ${targets.length} unread for ${options.seat} (#${targets[0].seq}-#${targets[targets.length - 1].seq}): ${options.reason!.trim()}\n`);
      }
      return report;
    });
  }

  /**
   * Timer path (harness lease sweep). Lock-free due check: one state read and one readdir.
   * When due, recount + archive in up to `maxBatches` batches; pressure mode when hot >= 80%.
   */
  async maintenanceTick(maxBatches = 10): Promise<{ ran: boolean; pressure: boolean; report?: ArchiveRunReport }> {
    const state = await this.loadState();
    if (!ACCEPTED_STATE_SCHEMAS.has(state.schema)) return { ran: false, pressure: false };
    const hot = (await this.hotNames()).length;
    const pressure = hot >= Math.ceil(this.maxHotOf(state) * PRESSURE_FRACTION);
    if (!this.pruneDue(state, pressure)) return { ran: false, pressure };
    const report = await this.archive({ pressure, maxBatches, trigger: 'timer' });
    return { ran: true, pressure, report };
  }

  private async doctorArchiveUnsafe(hotSeqs: Set<number>, problems: string[], warnings: string[], state: MailboxState | undefined) {
    const segments = await this.segmentList();
    const highWater = segments.reduce((maximum, segment) => Math.max(maximum, segment.last), 0);
    if (await this.exists(this.paths.journalPath)) warnings.push('archive journal present (an interrupted run will be recovered by the next locked operation)');
    const restored = new Set((await this.restoredEntries()).map((entry) => `${entry.seq}\0${entry.segment}`));
    const live = new Map<number, string>();
    for (const segment of segments) {
      const segmentName = `${segment.base}.ndjson`;
      let sidecar;
      let archivedMessages: BusMessage[];
      try {
        sidecar = await this.readSidecar(segment.base);
        archivedMessages = await this.readSegmentUnsafe(segment.base);
      } catch (error) {
        problems.push(`archive segment ${segmentName} cannot be read with its sidecar: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (sidecar.rows.length !== archivedMessages.length || sidecar.rows.some((row, index) => row[0] !== archivedMessages[index]?.seq || row[2] !== archivedMessages[index]?.to)) {
        problems.push(`archive sidecar for ${segmentName} does not match its segment`);
      }
      for (const message of archivedMessages) {
        if (restored.has(`${message.seq}\0${segmentName}`)) continue;
        if (live.has(message.seq)) problems.push(`duplicate message sequence ${message.seq} in archive (${live.get(message.seq)} and ${segmentName})`);
        live.set(message.seq, segmentName);
        if (hotSeqs.has(message.seq)) warnings.push(`message ${message.seq} is both hot and archived in ${segmentName}; hot wins`);
      }
    }
    const archivedCount = state?.queue?.archived ?? 0;
    if (segments.length === 0 && archivedCount > 0) {
      problems.push(`state counts ${archivedCount} archived messages but the archive is missing`);
    }
    for (const warning of state?.queue?.archiveWarnings ?? []) warnings.push(warning);
    return { highWater };
  }

  private async lockObstruction() {
    const describe = async (lockPath: string, label: string) => {
      if (!(await this.exists(lockPath))) return undefined;
      const owner = await fs.readFile(lockPath, 'utf8')
        .then((text) => JSON.parse(text) as { id?: unknown; pid?: unknown })
        .catch(() => undefined);
      if (!owner || typeof owner.id !== 'string' || !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) {
        return `${label} is malformed and blocks safe automatic recovery: ${lockPath}`;
      }
      return processAlive(owner.pid as number)
        ? `${label} is held by live PID ${owner.pid}: ${lockPath}`
        : `${label} was left by dead PID ${owner.pid} and blocks safe automatic recovery: ${lockPath}`;
    };
    const recovery = await describe(this.paths.recoveryLockPath, 'mailbox recovery lock');
    if (recovery) return recovery;
    const primary = await describe(this.paths.lockPath, 'mailbox lock');
    if (primary?.includes('malformed') || primary?.includes('held by live')) return primary;
    return undefined;
  }

  private defaultState(): MailboxState {
    return {
      schema: STATE_SCHEMA,
      createdAt: nowIso(),
      agents: [],
      seq: 0,
      round: 0,
      maxRounds: DEFAULT_MAX_ROUNDS,
      halted: false,
      stopReason: null,
      claims: {},
      haltPolicy: { onStepCompletion: false, onGoalCompletion: true, atRounds: [], everyRounds: null },
      completions: [],
      lifecycleEvents: [],
      goal: null,
      baton: null
    };
  }

  private async loadState(): Promise<MailboxState> {
    if (!(await this.exists(this.paths.statePath))) {
      const [transcriptExists, inboxEntries] = await Promise.all([
        this.exists(this.paths.transcriptPath),
        fs.readdir(this.paths.inboxDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return [];
          throw error;
        })
      ]);
      if (transcriptExists || inboxEntries.some((name) => name.endsWith('.json'))) {
        throw new Error(`Mailbox state is missing while durable artifacts remain: ${this.paths.statePath}`);
      }
      return this.defaultState();
    }
    const state = await this.readJson<MailboxState>(this.paths.statePath);
    state.haltPolicy = {
      onStepCompletion: state.haltPolicy?.onStepCompletion === true,
      onGoalCompletion: state.haltPolicy?.onGoalCompletion !== false,
      atRounds: normalizeHaltRounds(state.haltPolicy?.atRounds ?? []),
      everyRounds: normalizeEveryRounds(state.haltPolicy?.everyRounds ?? null)
    };
    state.completions = Array.isArray(state.completions) ? state.completions : [];
    state.lifecycleEvents = Array.isArray(state.lifecycleEvents) ? state.lifecycleEvents : [];
    return state;
  }

  private async loadStateUnsafe(): Promise<MailboxState> {
    await fs.mkdir(this.paths.inboxDir, { recursive: true });
    const state = await this.loadState();
    if (!ACCEPTED_STATE_SCHEMAS.has(state.schema)) {
      throw new Error(`Unsupported mailbox schema ${state.schema}. Expected 1 or ${STATE_SCHEMA}.`);
    }
    if (state.schema === 1) await this.migrateSchemaOneUnsafe(state);
    if (await this.migrateClaimIdentities(state)) {
      await this.writeStateUnsafe(state);
    }
    const maxSeq = await this.maxMessageSequenceUnsafe();
    state.seq = Math.max(state.seq, maxSeq);
    state.round = Math.max(state.round, maxSeq);
    return state;
  }

  /**
   * In-memory part of the 1 -> 2 step, applied before any guard reads the state so the first
   * locked write persists it. A schema-1 mailbox has no per-seat cap; the default (200) could
   * refuse a seat with an existing backlog at once, so the cap is sized to the backlog exactly
   * as `upgrade-state` would. A legacy round-guard halt reason is rewritten. `schema` itself is
   * left at 1 so read-only callers (doctor) still report the pending migration.
   */
  private async migrateSchemaOneUnsafe(state: MailboxState) {
    if (state.retention?.maxUnreadPerSeat === undefined) {
      const unread = this.unreadBySeat(state, await this.allMessagesUnsafe());
      state.retention = { ...(state.retention ?? {}), maxUnreadPerSeat: migrationCap(unread) };
    }
    this.rewriteLegacyHalt(state);
  }

  /**
   * Every locked state write is schema 2 plus the old-binary sentinel: `maxRounds = round` so
   * an old lock-free guard refuses, and an unhalted `stopReason` that says why in words old
   * clients do not treat as a halt. New code ignores maxRounds entirely.
   */
  private async writeStateUnsafe(state: MailboxState) {
    state.schema = STATE_SCHEMA;
    state.maxRounds = state.round;
    if (!state.halted) state.stopReason = UPGRADE_SENTINEL;
    await this.atomicJson(this.paths.statePath, state);
  }

  /** Lock-free full scan. Tolerates files that vanish (archive) or are briefly locked (AV). */
  private async allMessages(): Promise<BusMessage[]> {
    return (await this.scanTolerant()).messages;
  }

  private async scanTolerant(): Promise<{ messages: BusMessage[]; skipped: number }> {
    if (!(await this.exists(this.paths.inboxDir))) {
      return { messages: [], skipped: 0 };
    }
    this.metrics.scans += 1;
    const names = (await fs.readdir(this.paths.inboxDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })).filter((name) => name.endsWith('.json')).sort();
    const messages: BusMessage[] = [];
    let skipped = 0;
    for (let index = 0; index < names.length; index += READ_BATCH) {
      const batch = await Promise.all(
        names.slice(index, index + READ_BATCH).map((name) => this.readTolerant(path.join(this.paths.inboxDir, name)))
      );
      for (const item of batch) {
        if (item) messages.push(item);
        else skipped += 1;
      }
    }
    this.metrics.skipped += skipped;
    return { messages: messages.sort((left, right) => left.seq - right.seq), skipped };
  }

  private async readTolerant(filePath: string): Promise<BusMessage | undefined> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.readJson<BusMessage>(filePath);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') return undefined;
        const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || error instanceof SyntaxError;
        if (!transient) throw error;
        if (attempt >= TOLERANT_READ_RETRIES) return undefined;
        await delay(TOLERANT_READ_DELAY_MS);
      }
    }
  }

  private async allMessagesUnsafe(): Promise<BusMessage[]> {
    return (await this.scanUnsafe()).messages;
  }

  /** Strict scan under the lock: any unreadable file fails the operation. */
  private async scanUnsafe(): Promise<{ messages: BusMessage[]; files: Map<number, string> }> {
    await fs.mkdir(this.paths.inboxDir, { recursive: true });
    this.metrics.scans += 1;
    const names = (await fs.readdir(this.paths.inboxDir))
      .filter((name) => name.endsWith('.json'))
      .sort();
    // Bounded concurrency: with ~4100 inbox files an unbounded Promise.all hit EMFILE on
    // Windows (2026-10-17). Ported from the Parchmap installed bundle (e4327974) so the source
    // and the shipped bin agree again.
    const messages: BusMessage[] = [];
    const files = new Map<number, string>();
    for (let index = 0; index < names.length; index += READ_BATCH) {
      const slice = names.slice(index, index + READ_BATCH);
      const batch = await Promise.all(
        slice.map((name) => this.readJson<BusMessage>(path.join(this.paths.inboxDir, name)))
      );
      batch.forEach((message, offset) => {
        messages.push(message);
        if (!files.has(message.seq)) files.set(message.seq, path.join(this.paths.inboxDir, slice[offset]));
      });
    }
    return { messages: messages.sort((left, right) => left.seq - right.seq), files };
  }

  private async hotNames(): Promise<string[]> {
    return (await fs.readdir(this.paths.inboxDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    })).filter((name) => HOT_NAME_PATTERN.test(name));
  }

  private async maxHotSequence(): Promise<number> {
    return (await this.hotNames()).reduce((maximum, name) => {
      const parsed = Number.parseInt(name, 10);
      return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
    }, 0);
  }

  /**
   * Seq high-water = max(hot filename seqs, last seq of every archive segment filename). Two
   * readdirs of names only, independent of state.json, so archiving everything and losing the
   * counters still cannot reuse a seq.
   */
  private async maxMessageSequenceUnsafe() {
    const [hot, archived] = await Promise.all([this.maxHotSequence(), this.archiveHighWater()]);
    return Math.max(hot, archived);
  }

  private async findMessagePathUnsafe(seq: number) {
    const prefix = `${String(seq).padStart(6, '0')}-`;
    const name = (await fs.readdir(this.paths.inboxDir)).find((item) => item.startsWith(prefix));
    return name ? path.join(this.paths.inboxDir, name) : undefined;
  }

  private async appendTranscriptUnsafe(message: BusMessage) {
    const commit = message.workspaceCommit
      ? `${message.workspaceCommit.sha.slice(0, 12)}${message.workspaceCommit.dirty ? ' (dirty)' : ''}`
      : '<not a git repo>';
    await this.appendLineUnsafe(
      [
        '',
        `## ${message.seq}. ${message.from} -> ${message.to} [${message.kind}] ${message.subject}`,
        '',
        `- round: ${message.round}`,
        `- commit: \`${commit}\``,
        `- time: ${message.createdAt}`,
        '',
        message.body.trim(),
        ''
      ].join('\n')
    );
  }

  private async appendLineUnsafe(content: string) {
    await fs.mkdir(path.dirname(this.paths.transcriptPath), { recursive: true });
    await fs.appendFile(this.paths.transcriptPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  }

  private async resolveEvidenceWorkId(agent: string, workId?: number): Promise<number> {
    if (workId !== undefined) {
      if (!Number.isSafeInteger(workId) || workId < 1) {
        throw new Error('workId must be a positive mailbox sequence');
      }
      if (!(await this.findMessagePathUnsafe(workId))) {
        await this.throwIfArchivedUnsafe(workId);
        throw new Error(`message #${workId} does not exist`);
      }
      return workId;
    }
    const open = await this.openRecoveryFor(agent);
    if (open) return open.workId;
    throw new Error('record requires workId; no open recovery exists for this seat');
  }

  private async observeVerifier(
    record: EvidenceRecord,
    input: { kind: VerifierKind; invocation?: string; transition?: string }
  ): Promise<BusObservation> {
    if (input.kind === 'commit-diff') return observeCommitDiff(this.paths.root, record.subject, record.createdAt);
    if (input.kind === 'runner-result') {
      return observeRunnerResult(this.paths.root, record.subject, input.invocation, record.createdAt);
    }
    return observeLifecycle(this.paths.root, record.subject, input.transition, record.createdAt);
  }

  private async gitStamp(): Promise<CommitStamp | undefined> {
    // Most mailbox roots are runtime directories, not source checkouts. Spawning Git anyway
    // was not merely wasted work on Windows: every status/send created two short-lived console
    // processes, and mailbox/extension polling turned those into visible flashes. Check for Git
    // metadata in-process before launching anything. Walking upward preserves support for a bus
    // rooted in a subdirectory of a repository, including worktrees where `.git` is a file.
    let candidate = path.resolve(this.paths.root);
    while (!(await this.exists(path.join(candidate, '.git')))) {
      const parent = path.dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
    // 5 s in-process cache keyed on HEAD contents and the index mtime: the same answer git
    // would give, except untracked-file changes can be up to 5 s stale.
    const key = await this.gitCacheKey(path.join(candidate, '.git'));
    const cached = this.gitStampCache;
    if (cached && key && cached.key === key && Date.now() - cached.at < GIT_STAMP_CACHE_MS) {
      return cached.value;
    }
    try {
      this.metrics.gitSpawns += 1;
      const [{ stdout: sha }, { stdout: dirty }] = await Promise.all([
        execFileAsync('git', ['-C', this.paths.root, 'rev-parse', 'HEAD'], { windowsHide: true }),
        execFileAsync('git', ['-C', this.paths.root, 'status', '--porcelain'], { windowsHide: true })
      ]);
      const value = { sha: sha.trim(), dirty: Boolean(dirty.trim()) };
      if (key) this.gitStampCache = { key, at: Date.now(), value };
      return value;
    } catch {
      return undefined;
    }
  }

  private async gitCacheKey(dotGit: string): Promise<string | undefined> {
    try {
      let gitDir = dotGit;
      const info = await fs.stat(dotGit);
      if (info.isFile()) {
        const pointer = (await fs.readFile(dotGit, 'utf8')).match(/gitdir:\s*(.+)/);
        if (!pointer) return undefined;
        gitDir = path.resolve(path.dirname(dotGit), pointer[1].trim());
      }
      const head = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8');
      const index = await fs.stat(path.join(gitDir, 'index')).then((item) => item.mtimeMs).catch(() => 0);
      return `${gitDir}\0${head.trim()}\0${index}`;
    } catch {
      return undefined;
    }
  }

  private normalizeClaimPath(value: string) {
    const raw = value.trim().replace(/\\/g, '/');
    if (!raw || path.posix.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) {
      throw new Error(`Claim path must be workspace-relative: ${value}`);
    }
    const normalized = path.posix.normalize(raw).replace(/^\.\//, '').replace(/\/$/, '');
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Claim path escapes the workspace: ${value}`);
    }
    return normalized || '.';
  }

  private comparablePath(value: string) {
    return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
  }

  /**
   * A claim root, canonicalised the way claim() stores it: links resolved, then compared.
   *
   * Falls back to the lexical form when the path cannot be resolved, because release() must
   * still work against a root that has since been deleted - refusing there would strand the
   * claim permanently, which is the failure this exists to prevent, arriving from the other
   * side.
   */
  private async canonicalRootForCompare(value: string): Promise<string> {
    try {
      return this.canonicalComparablePath(await fs.realpath(value));
    } catch {
      return this.canonicalComparablePath(value);
    }
  }

  private canonicalComparablePath(value: string) {
    return this.comparablePath(path.resolve(value).replace(/\\/g, '/').replace(/\/$/, ''));
  }

  private pathContains(parent: string, child: string) {
    const left = this.comparablePath(parent);
    const right = this.comparablePath(child);
    return left === right || left === '.' || right.startsWith(`${left}/`);
  }

  private pathsOverlap(left: string, right: string) {
    return this.pathContains(left, right) || this.pathContains(right, left);
  }

  private isFilesystemIdentity(identity: string | undefined): identity is string {
    return identity?.startsWith('filesystem-v1:') === true;
  }

  private claimPathCandidates(
    claim: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    fallbackRoots: string[]
  ) {
    const candidates = (claim.root ? [claim.root] : fallbackRoots)
      .map((root) => path.resolve(root, claim.path));
    if (claim.identity && !this.isFilesystemIdentity(claim.identity) && path.isAbsolute(claim.identity)) {
      candidates.push(claim.identity);
    }
    return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
  }

  private observedFilesystemIdentity(candidate: string) {
    try {
      const observed = statSync(candidate, { bigint: true });
      return filesystemIdentityMaterial(observed.dev, observed.ino);
    } catch {
      return undefined;
    }
  }

  private claimIdentities(
    claim: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    fallbackRoots: string[]
  ) {
    const identities = new Set<string>();
    if (this.isFilesystemIdentity(claim.identity)) identities.add(claim.identity);
    for (const candidate of this.claimPathCandidates(claim, fallbackRoots)) {
      const observed = this.observedFilesystemIdentity(candidate);
      if (observed) identities.add(observed);
      try {
        identities.add(this.canonicalComparablePath(realpathSync(candidate)));
      } catch {
        identities.add(this.canonicalComparablePath(candidate));
      }
    }
    return [...identities];
  }

  private directoryContainsClaim(
    parent: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    child: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    fallbackRoots: string[]
  ) {
    const targets = new Set(
      this.claimIdentities(child, fallbackRoots).filter((identity) => this.isFilesystemIdentity(identity))
    );
    if (targets.size === 0) return false;

    // Item 14: keep the walk (it joins a parent path to a child inode under a
    // third name) but stay under the claimed directory. Outbound junctions are
    // not descended; hardlinks of in-tree files still match by inode.
    for (const candidate of this.claimPathCandidates(parent, fallbackRoots)) {
      if (directoryContainsIdentities(candidate, targets, { stayUnderRoot: candidate })) {
        return true;
      }
    }
    return false;
  }

  private claimsOverlap(
    left: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    right: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    fallbackRoots: string[]
  ) {
    return this.claimIdentities(left, fallbackRoots).some((leftIdentity) =>
      this.claimIdentities(right, fallbackRoots).some((rightIdentity) =>
        this.pathsOverlap(leftIdentity, rightIdentity)
      )
    ) || this.directoryContainsClaim(left, right, fallbackRoots)
      || this.directoryContainsClaim(right, left, fallbackRoots);
  }

  private claimContains(
    parent: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    child: Pick<Claim, 'path'> & Partial<Pick<Claim, 'root' | 'identity'>>,
    fallbackRoots: string[]
  ) {
    return this.claimIdentities(parent, fallbackRoots).some((parentIdentity) =>
      this.claimIdentities(child, fallbackRoots).some((childIdentity) =>
        this.pathContains(parentIdentity, childIdentity)
      )
    ) || this.directoryContainsClaim(parent, child, fallbackRoots);
  }

  private async migrateClaimIdentities(state: MailboxState) {
    let changed = false;
    for (const claims of Object.values(state.claims)) {
      for (const claim of claims) {
        if (this.isFilesystemIdentity(claim.identity)) continue;
        const roots = claim.root ? [claim.root] : [this.paths.root];
        for (const root of roots) {
          const candidate = path.resolve(root, claim.path);
          try {
            const observed = await fs.stat(candidate, { bigint: true });
            claim.root = this.canonicalComparablePath(await fs.realpath(root));
            claim.identity = filesystemIdentityMaterial(observed.dev, observed.ino);
            changed = true;
            break;
          } catch {
            // Preserve the weaker row when its path cannot be observed. Doctor reports it.
          }
        }
      }
    }
    return changed;
  }

  private uniqueAgents(agents: string[]) {
    return Array.from(new Set(agents.map((agent) => agent.trim()).filter(Boolean))).sort();
  }

  private assertAgent(agent: string, label: string) {
    if (!agent || !/^[a-zA-Z0-9_.-]+$/.test(agent)) {
      throw new Error(`Invalid ${label}: ${agent || '<empty>'}`);
    }
  }

  /**
   * A seat is a funded actor, declared by `init`. Acting must never be a way to become one.
   *
   * This checks membership; `assertAgent` above only checks that the NAME is well formed, which
   * is why five seats accumulated in a three-vendor bus - every well-formed name that claimed or
   * sent was quietly added to the roster.
   */
  private assertSeated(state: MailboxState, agent: string, label: string) {
    this.assertAgent(agent, label);
    if (!state.agents.includes(agent)) {
      throw new Error(
        `${agent} is not a seat (${label}). Seated: ${state.agents.join(', ')}. `
        + 'Seats are declared by init, not created by acting.'
      );
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.paths.mailboxDir, { recursive: true });
    const started = Date.now();
    const lockId = randomUUID();
    let ownsLock = false;
    while (!ownsLock) {
      if (await this.exists(this.paths.recoveryLockPath)) {
        if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error(`Timed out waiting for mailbox lock recovery: ${this.paths.recoveryLockPath}`);
        await delay(25);
        continue;
      }
      try {
        await this.publishExclusiveLock(this.paths.lockPath, { id: lockId, pid: process.pid, at: nowIso() });
        ownsLock = true;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') {
          throw error;
        }
        const owner = await fs.readFile(this.paths.lockPath, 'utf8')
          .then((text) => JSON.parse(text) as { id?: string; pid?: number })
          .catch(() => undefined);
        if (owner?.id && owner.pid && !processAlive(owner.pid) && await this.recoverMailboxLock(owner.id)) continue;
        if (Date.now() - started >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for mailbox lock: ${this.paths.lockPath}`);
        }
        await delay(25);
      }
    }

    try {
      // Archive crash recovery runs inside the lock before every locked operation, including
      // after dead-owner lock recovery, so no writer ever sees a half-finished archive run.
      await this.recoverArchiveUnsafe();
      return await action();
    } finally {
      try {
        const lock = JSON.parse(await fs.readFile(this.paths.lockPath, 'utf8')) as { id?: string };
        if (lock.id === lockId) {
          await fs.rm(this.paths.lockPath, { force: true });
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  private async recoverMailboxLock(expectedId: string) {
    const recoveryId = randomUUID();
    try {
      await this.publishExclusiveLock(this.paths.recoveryLockPath, { id: recoveryId, pid: process.pid, at: nowIso() });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
    try {
      const current = await fs.readFile(this.paths.lockPath, 'utf8')
        .then((text) => JSON.parse(text) as { id?: string; pid?: number })
        .catch(() => undefined);
      if (current?.id !== expectedId || !current.pid || processAlive(current.pid)) return false;
      await fs.rm(this.paths.lockPath, { force: true });
      return true;
    } finally {
      const recovery = await fs.readFile(this.paths.recoveryLockPath, 'utf8')
        .then((text) => JSON.parse(text) as { id?: string })
        .catch(() => undefined);
      if (recovery?.id === recoveryId) await fs.rm(this.paths.recoveryLockPath, { force: true });
    }
  }

  private async publishExclusiveLock(destination: string, owner: Record<string, unknown>) {
    const candidate = `${destination}.${process.pid}.${randomUUID()}.candidate`;
    try {
      await fs.writeFile(candidate, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await fs.link(candidate, destination);
    } finally {
      await fs.rm(candidate, { force: true });
    }
  }

  private async atomicJson(filePath: string, value: unknown) {
    await this.atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async atomicWrite(filePath: string, content: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await this.renameWithRetry(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async renameWithRetry(source: string, destination: string) {
    // Wall-clock budget (~2s), not an attempt count: a reader holding state.json open under
    // parallel load can outlast eight short retries (~450ms), which surfaced as EPERM in T11.
    const deadline = Date.now() + RENAME_RETRY_BUDGET_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.renameFile(source, destination);
        return;
      } catch (error) {
        if (!TRANSIENT_FS_CODES.has(errorCode(error) ?? '') || Date.now() >= deadline) throw error;
        // Antivirus/indexer handles on Windows commonly clear within one scheduler slice.
        // Keep the temporary file intact and retry the atomic publish; never delete the live
        // destination as a workaround because that would create a data-loss window.
        await delay(Math.min(100, 10 * (2 ** attempt)));
      }
    }
  }

  private async readJson<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  }

  private async exists(filePath: string) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
}

export class BusHaltedError extends Error {
  readonly exitCode = 2;

  constructor(reason: string) {
    super(`BUS HALTED: ${reason}`);
    this.name = 'BusHaltedError';
  }
}

/**
 * A send refused because the recipient's unread queue (or the global backstop) is full.
 * Not latched: the next send succeeds as soon as the seat reads or pruning frees room.
 * The message never contains the word old clients treat as a halt.
 */
export class QueueFullError extends Error {
  readonly exitCode = 4;
  readonly code = 'queue_full';

  constructor(
    readonly seat: string,
    readonly unread: number,
    readonly cap: number,
    readonly retryAfterMs: number,
    readonly scope: 'seat' | 'backstop',
    readonly hot?: number
  ) {
    super(scope === 'seat'
      ? `queue full for ${seat}: ${unread} unread (cap ${cap}); ${seat} must read, or ask the owner to expire. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`
      : `queue full: ${hot ?? unread} messages in the hot inbox (backstop ${cap}); pruning frees room on its own schedule. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'QueueFullError';
  }

  toJSON() {
    return { error: 'queue_full', seat: this.seat, unread: this.unread, cap: this.cap, retryAfterMs: this.retryAfterMs, scope: this.scope, message: this.message };
  }
}

export class ClaimConflictError extends Error {
  readonly exitCode = 1;

  constructor(readonly holder: string, readonly claim: Claim) {
    super(`${holder} already holds ${claim.path} since ${claim.at}: ${claim.why}`);
    this.name = 'ClaimConflictError';
  }
}

/** Item 7. A claim with no reason is the row an operator cannot act on. */
export class ClaimReasonRequiredError extends Error {
  readonly exitCode = 1;

  constructor() {
    super(
      'Claim refused: --why is required. Say what the claim is for; a seat that dies holding a '
      + 'path leaves this reason as the only explanation. No claim was recorded.'
    );
    this.name = 'ClaimReasonRequiredError';
  }
}

/** Item 13. A claim that covers everything protects nothing and blocks everyone. */
export class WholeRepositoryClaimError extends Error {
  readonly exitCode = 1;

  constructor(readonly requested: string) {
    super(
      `Claim refused: "${requested}" is the whole repository. Ancestor claims below the root `
      + '(for example src/) are allowed; claiming the root locks every seat out of every file '
      + 'with no expiry. Claim the paths you are actually editing. No claim was recorded.'
    );
    this.name = 'WholeRepositoryClaimError';
  }
}

export class ClaimPathMissingError extends Error {
  readonly exitCode = 1;

  constructor(readonly paths: string[]) {
    super(
      `Claim refused: path(s) do not exist in the workspace: ${paths.join(', ')}. `
      + 'No claim was recorded.'
    );
    this.name = 'ClaimPathMissingError';
  }
}

type CliArgs = Record<string, string | boolean | string[]> & { _: string[] };

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function stringArg(args: CliArgs, name: string, required = false) {
  const value = typeof args[name] === 'string' ? String(args[name]) : '';
  if (required && !value) {
    throw new Error(`Missing --${name}.`);
  }
  return value;
}

function intArg(args: CliArgs, name: string, fallback: number) {
  const raw = stringArg(args, name);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --${name}: ${raw}`);
  }
  return parsed;
}

function listArg(args: CliArgs, name: string) {
  return stringArg(args, name)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionalBoolArg(args: CliArgs, name: string) {
  const raw = stringArg(args, name);
  if (!raw) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`--${name} must be true or false.`);
}

function optionalIntArg(args: CliArgs, name: string) {
  if (args[name] === undefined) return undefined;
  return intArg(args, name, 0);
}

function printMessages(messages: BusMessage[], json: boolean) {
  if (json) {
    console.log(JSON.stringify(messages, null, 2));
    return;
  }
  for (const message of messages) {
    console.log('='.repeat(72));
    console.log(`#${message.seq} ${message.from} -> ${message.to} [${message.kind}]`);
    console.log(`subject: ${message.subject}`);
    console.log(`round  : ${message.round}`);
    if (message.workspaceCommit) {
      console.log(
        `commit : ${message.workspaceCommit.sha.slice(0, 12)}${message.workspaceCommit.dirty ? ' (DIRTY)' : ''}`
      );
    }
    console.log('='.repeat(72));
    console.log(message.body);
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0];
  const root = stringArg(args, 'root') || path.resolve(__dirname, '..', '..');
  const store = new MailboxStore(root);
  const json = Boolean(args.json);

  switch (command) {
    case 'init': {
      const state = await store.ensureInitialized(
        listArg(args, 'agents'),
        intArg(args, 'max-rounds', DEFAULT_MAX_ROUNDS)
      );
      console.log(json ? JSON.stringify(state, null, 2) : `mailbox initialized for ${state.agents.join(', ')}`);
      return 0;
    }
    case 'send': {
      const bodyFile = stringArg(args, 'body-file');
      const body = bodyFile ? await fs.readFile(path.resolve(bodyFile), 'utf8') : stringArg(args, 'body', true);
      // Item 18: `--supersedes` reaches the atomic superseding send. Without it the CLI could
      // only do the two-step send-then-supersede, which is the exact window this replaced:
      // between the two calls BOTH instructions are live and unread.
      const supersedes = intArg(args, 'supersedes', 0);
      const message = await store.send({
        keepBaton: optionalBoolArg(args, 'keep-baton'),
        from: stringArg(args, 'from', true),
        to: stringArg(args, 'to', true),
        kind: stringArg(args, 'kind') || 'note',
        subject: stringArg(args, 'subject', true),
        body,
        ...(supersedes > 0 ? { supersedes } : {}),
        ...(stringArg(args, 'supersede-reason')
          ? { supersedeReason: stringArg(args, 'supersede-reason') }
          : {})
      });
      let line = `sent #${message.seq} [round ${message.round}]`;
      // The outcome is NOT the same as "it worked". A target the recipient already read is
      // reported as target-consumed, and saying so is the difference between a correction that
      // landed and one that only looks like it did.
      if (message.superseded === true) line += ` superseding #${supersedes}`;
      else if (message.supersedeOutcome) line += ` (NOT superseded: ${message.supersedeOutcome})`;
      console.log(json ? JSON.stringify(message, null, 2) : line);
      return 0;
    }
    case 'supersede': {
      const message = await store.supersedeMessage(
        intArg(args, 'seq', 0),
        intArg(args, 'by', 0),
        stringArg(args, 'reason', true),
        stringArg(args, 'from', true)
      );
      console.log(json ? JSON.stringify(message, null, 2) : `superseded #${message.seq} by #${message.supersededBy}`);
      return 0;
    }
    case 'inbox': {
      const messages = await store.inbox(stringArg(args, 'for', true));
      printMessages(messages, json);
      return messages.length > 0 ? 0 : 3;
    }
    case 'read': {
      const messages = await store.read(stringArg(args, 'for', true), Boolean(args.all));
      printMessages(messages, json);
      return messages.length > 0 ? 0 : 3;
    }
    case 'parked': {
      const messages = await store.parked(stringArg(args, 'for', true));
      printMessages(messages, json);
      return messages.length > 0 ? 0 : 3;
    }
    case 'requeue': {
      const message = await store.requeue(
        stringArg(args, 'for', true),
        intArg(args, 'seq', 0)
      );
      console.log(json ? JSON.stringify(message, null, 2) : `requeued #${message.seq}`);
      return 0;
    }
    case 'wait': {
      const result = await store.waitFor(
        stringArg(args, 'for', true),
        intArg(args, 'timeout', 600) * 1000,
        intArg(args, 'interval-ms', 500)
      );
      if (result === 'timeout') {
        console.log('timeout: no message waiting');
        return 3;
      }
      if (result === 'server_stopping') {
        console.log('wait cancelled: server stopping');
        return 4;
      }
      console.log('message waiting');
      return 0;
    }
    case 'claim': {
      const claims = await store.claim({
        agent: stringArg(args, 'agent', true),
        paths: listArg(args, 'paths'),
        why: stringArg(args, 'why'),
        repoRoot: stringArg(args, 'repo') || undefined
      });
      console.log(json
        ? JSON.stringify({
            status: 'HELD NOW',
            message: 'The requested paths are HELD NOW. No acceptance or further claim step is required.',
            held: claims
          }, null, 2)
        : `HELD NOW (no further step required): ${claims.map((claim) => claim.path).join(', ')}`);
      return 0;
    }
    case 'release': {
      const paths = listArg(args, 'paths');
      const claims = await store.release(
        stringArg(args, 'agent', true),
        paths.length > 0 ? paths : undefined,
        stringArg(args, 'repo') || undefined
      );
      console.log(json ? JSON.stringify(claims, null, 2) : `remaining: ${claims.map((claim) => claim.path).join(', ') || 'none'}`);
      return 0;
    }
    case 'claims': {
      const claims = await store.claims();
      console.log(JSON.stringify(claims, null, 2));
      return 0;
    }
    // Item 20. The operator route to a checkpoint whose seat can no longer close it.
    // Seats still cannot close each other's rows; this is deliberately outside that path.
    case 'close-recovery': {
      const closed = await store.operatorCloseRecovery(
        stringArg(args, 'seat', true),
        Number(stringArg(args, 'work-id', true)),
        stringArg(args, 'reason', true)
      );
      if (!closed) {
        console.log('no open checkpoint for that seat and work-id; nothing was closed');
        return 1;
      }
      console.log(json ? JSON.stringify(closed, null, 2) : `closed ${closed.workId}: ${closed.closeReason}`);
      return 0;
    }
    case 'status': {
      const status = args.brief
        ? await store.statusBrief(stringArg(args, 'for') || undefined)
        : await store.status();
      // The brief form is for model context: compact JSON keeps it under 2 KB.
      console.log(args.brief ? JSON.stringify(status) : JSON.stringify(status, null, 2));
      return 0;
    }
    case 'upgrade-state': {
      const result = await store.upgradeState({ maxUnreadPerSeat: optionalIntArg(args, 'max-unread-per-seat') });
      console.log(json
        ? JSON.stringify(result, null, 2)
        : `state schema ${result.previousSchema} -> 2; per-seat unread cap ${result.maxUnreadPerSeat}; unread ${JSON.stringify(result.unread)}`);
      return 0;
    }
    case 'configure-retention': {
      const retention = await store.configureRetention({
        keepRecent: optionalIntArg(args, 'keep-recent'),
        minAgeHours: optionalIntArg(args, 'min-age-hours'),
        pinnedAllowance: optionalIntArg(args, 'pinned-allowance'),
        batch: optionalIntArg(args, 'batch'),
        maxUnreadPerSeat: optionalIntArg(args, 'max-unread-per-seat'),
        minIntervalMinutes: optionalIntArg(args, 'interval-minutes'),
        pressureIntervalMinutes: optionalIntArg(args, 'pressure-interval-minutes')
      });
      console.log(JSON.stringify(retention, null, 2));
      return 0;
    }
    case 'archive': {
      const report = await store.archive({ dryRun: Boolean(args['dry-run']), pressure: Boolean(args.pressure), trigger: 'cli' });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const blocked = report.batches[0]?.blocked ?? {};
        console.log(`${report.dryRun ? 'dry run: would archive' : 'archived'} ${report.dryRun ? report.eligible : report.archived} of ${report.hotBefore} hot messages (${report.mode}); hot after ${report.hotAfter}; backstop ${report.maxHot}`);
        console.log(`kept: ${Object.entries(blocked).map(([reason, count]) => `${reason} ${count}`).join(', ') || 'none'}`);
        for (const sentence of report.sentences) console.log(sentence);
      }
      return 0;
    }
    case 'archived': {
      const rows = await store.archived({
        to: stringArg(args, 'for') || undefined,
        expired: Boolean(args.expired),
        fromSeq: optionalIntArg(args, 'from-seq'),
        limit: optionalIntArg(args, 'limit') ?? 50
      });
      if (json) console.log(JSON.stringify(rows, null, 2));
      else for (const row of rows) console.log(`#${row.seq} ${row.from} -> ${row.to} [${row.kind}] ${row.createdAt}${row.expired ? ' (expired)' : ''} ${row.segment}`);
      return 0;
    }
    case 'show': {
      const seq = optionalIntArg(args, 'seq') ?? Number.parseInt(String(args._[1] ?? ''), 10);
      if (!Number.isSafeInteger(seq)) throw new Error('usage: mailbox show <seq>');
      const message = await store.show(seq);
      if (json) console.log(JSON.stringify(message, null, 2));
      else printMessages([message], false);
      return 0;
    }
    case 'unarchive': {
      const raw = [...args._.slice(1), ...listArg(args, 'seq')];
      const seqs = raw.flatMap((item) => String(item).split(',')).filter(Boolean).map((item) => Number.parseInt(item, 10));
      const restored = await store.unarchive(seqs);
      console.log(json ? JSON.stringify(restored, null, 2) : `unarchived #${restored.map((message) => message.seq).join(', #')}`);
      return 0;
    }
    case 'export': {
      const result = await store.exportArchive(stringArg(args, 'to', true));
      console.log(`exported ${result.files} archive file(s) to ${result.to}`);
      return 0;
    }
    case 'expire': {
      const report = await store.expire({
        seat: stringArg(args, 'for', true),
        throughSeq: optionalIntArg(args, 'through-seq'),
        olderThanHours: optionalIntArg(args, 'older-than-hours'),
        kind: stringArg(args, 'kind') || undefined,
        reason: stringArg(args, 'reason') || undefined,
        dryRun: Boolean(args['dry-run'])
      });
      if (json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const skipped = report.skipped.parked.length + report.skipped.checkpoint.length + report.skipped.pinned.length;
        console.log(`${report.dryRun ? 'dry run: would expire' : 'expired'} ${report.expired.length} unread for ${report.seat}; skipped ${skipped} (parked ${report.skipped.parked.length}, checkpoint ${report.skipped.checkpoint.length}, pinned ${report.skipped.pinned.length})`);
      }
      return 0;
    }
    case 'doctor': {
      const report = await store.doctor();
      console.log(JSON.stringify(report, null, 2));
      return report.ok ? 0 : 1;
    }
    case 'goal': {
      const state = await store.setGoal({
        statement: stringArg(args, 'statement', true)!,
        doneWhen: stringArg(args, 'done-when', true)!,
        setBy: stringArg(args, 'by')
      });
      console.log(json ? JSON.stringify(state, null, 2) :
        `goal set: ${state.goal!.statement}
  done when: ${state.goal!.doneWhen}`);
      return 0;
    }
    case 'assign': {
      const state = await store.assignGoal(stringArg(args, 'seat', true)!, stringArg(args, 'responsibility', true)!);
      console.log(json ? JSON.stringify(state, null, 2) :
        Object.entries(state.goal!.assignments).map(([seat, task]) => `${seat}: ${task}`).join('\n'));
      return 0;
    }
    case 'stall-check': {
      const report = await store.stallCheck(intArg(args, 'stale-after', 300));
      if (json) { console.log(JSON.stringify(report, null, 2)); }
      else {
        console.log(report.stalled ? `STALLED: ${report.reason}` : `ok: ${report.reason}`);
        if (report.holder) console.log(`  baton: ${report.holder} (${report.heldSeconds}s)`);
      }
      return report.stalled ? 1 : 0;
    }
    case 'reassign': {
      const result = await store.reassignBaton({
        to: stringArg(args, 'to', true),
        reason: stringArg(args, 'reason') || 'operator-requested baton recovery',
        staleAfterSeconds: intArg(args, 'stale-after', 300),
        expectedFrom: stringArg(args, 'expected-from') || undefined,
        force: Boolean(args.force)
      });
      console.log(json ? JSON.stringify(result, null, 2) : result.why);
      return result.moved || result.from === result.to ? 0 : 1;
    }
    case 'record-evidence': {
      const record = await store.recordEvidence({
        agent: stringArg(args, 'agent', true),
        subject: stringArg(args, 'subject', true),
        statement: stringArg(args, 'statement', true),
        workId: optionalIntArg(args, 'work-id')
      });
      console.log(json ? JSON.stringify(record, null, 2) : `recorded ${record.id} trust=${record.trust} work#${record.workId}`);
      return 0;
    }
    case 'promote-evidence': {
      const kind = stringArg(args, 'kind', true);
      if (!isVerifierKind(kind)) throw new Error(`--kind must be one of ${['commit-diff', 'runner-result', 'lifecycle-transition'].join(', ')}`);
      const record = await store.promoteEvidence({
        agent: stringArg(args, 'agent', true),
        id: stringArg(args, 'id', true),
        kind,
        invocation: stringArg(args, 'invocation') || undefined,
        transition: stringArg(args, 'transition') || undefined
      });
      console.log(json ? JSON.stringify(record, null, 2) : `promoted ${record.id} trust=${record.trust}`);
      return 0;
    }
    case 'consolidate-evidence': {
      // Item 2: reachable by hand as well as automatically on close, so an operator can compact
      // long-running work without waiting for it to end.
      const result = await store.consolidateEvidence(
        intArg(args, 'work-id', 0),
        stringArg(args, 'agent', true),
        { minEpisodes: optionalIntArg(args, 'min-episodes') ?? undefined }
      );
      console.log(json
        ? JSON.stringify(result, null, 2)
        : result.summary
          ? `consolidated ${result.absorbed} episodes into ${result.summary.id} trust=${result.summary.trust}`
          // Not an error, and not a success either. Saying which is the point.
          : `nothing consolidated: ${result.reason ?? 'no reason given'}`);
      return 0;
    }
    case 'list-evidence': {
      const workId = optionalIntArg(args, 'work-id');
      const records = await store.listEvidence(workId);
      console.log(JSON.stringify(records, null, 2));
      return 0;
    }
    case 'configure-halting': {
      const state = await store.configureHalting({
        onStepCompletion: optionalBoolArg(args, 'on-step'),
        onGoalCompletion: optionalBoolArg(args, 'on-goal'),
        atRounds: args['at-rounds'] === undefined ? undefined : listArg(args, 'at-rounds').map((item) => Number(item)),
        everyRounds: optionalIntArg(args, 'every-rounds')
      });
      console.log(json ? JSON.stringify(state, null, 2) :
        `halt policy: step=${state.haltPolicy.onStepCompletion} goal=${state.haltPolicy.onGoalCompletion} ` +
        `at=${state.haltPolicy.atRounds.join(',') || 'none'} every=${state.haltPolicy.everyRounds ?? 'off'}`);
      return 0;
    }
    case 'complete-step':
    case 'complete-goal': {
      const event = await store.complete({
        scope: command === 'complete-step' ? 'step' : 'goal',
        actor: stringArg(args, 'agent', true),
        summary: stringArg(args, 'summary', true),
        evidence: listArg(args, 'evidence')
      });
      console.log(json ? JSON.stringify(event, null, 2) : `${event.scope} completed${event.halted ? '; bus halted' : ''}`);
      return 0;
    }
    case 'halt': {
      const state = await store.halt(stringArg(args, 'reason', true), {
        force: Boolean(args.force),
        by: stringArg(args, 'by')
      });
      console.log(json ? JSON.stringify(state, null, 2) : `halted: ${state.stopReason}`);
      return 0;
    }
    case 'resume': {
      const state = await store.resume(intArg(args, 'add-rounds', 0));
      if (state.notice) {
        console.log(json ? JSON.stringify({ notice: state.notice }, null, 2) : state.notice);
        return 0;
      }
      console.log(json ? JSON.stringify(state, null, 2) : `resumed (queue-depth guard); round ${state.round} is informational`);
      return 0;
    }
    default:
      throw new Error(
        'usage: mailbox <init|send|inbox|read|parked|requeue|supersede|wait|claim|release|claims|close-recovery|status|doctor|goal|assign|stall-check|reassign|record-evidence|promote-evidence|list-evidence|consolidate-evidence|configure-halting|complete-step|complete-goal|halt|resume|upgrade-state|configure-retention|archive|archived|show|unarchive|export|expire> [options]'
      );
  }
}

if (require.main === module) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode =
        typeof error === 'object' && error !== null && 'exitCode' in error
          ? Number((error as { exitCode: number }).exitCode)
          : 1;
    });
}
