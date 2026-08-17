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
  isVerifierKind,
  observeCommitDiff,
  observeLifecycle,
  observeRunnerResult
} from './evidence';
import { directoryContainsIdentities } from './claim-walk';
import { filesystemIdentityMaterial } from './workspace-key';

const execFileAsync = promisify(execFile);
const SCHEMA = 1;
const DEFAULT_MAX_ROUNDS = 32;
const LOCK_TIMEOUT_MS = 10_000;

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

export type MailboxStatus = MailboxState & {
  unread: Record<string, number>;
  workspaceCommit?: CommitStamp;
  /** Human-facing warning emitted before the round guard begins failing mutations closed. */
  roundWarning?: string;
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

function messageFileName(seq: number, from: string, to: string) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${String(seq).padStart(6, '0')}-${safe(from)}-to-${safe(to)}.json`;
}

export class MailboxStore {
  readonly paths: MailboxPaths;
  readonly evidence: EvidenceStore;
  private readonly renameFile: (source: string, destination: string) => Promise<void>;

  constructor(
    root: string,
    options?: { renameFile?: (source: string, destination: string) => Promise<void> }
  ) {
    const resolvedRoot = path.resolve(root);
    this.renameFile = options?.renameFile ?? fs.rename;
    this.evidence = new EvidenceStore(resolvedRoot);
    const mailboxDir = path.join(resolvedRoot, '.ai-bus', 'runtime', 'mailbox');
    this.paths = {
      root: resolvedRoot,
      mailboxDir,
      inboxDir: path.join(mailboxDir, 'inbox'),
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
      if (requireRunning && (state.halted || state.round >= state.maxRounds)) {
        throw new BusHaltedError(state.stopReason ?? `round guard reached (${state.round}/${state.maxRounds})`);
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
      if (state.halted || state.round >= state.maxRounds) {
        if (!state.halted) {
          state.halted = true;
          state.stopReason = `maxRounds (${state.maxRounds}) reached`;
          await this.writeStateUnsafe(state);
        }
        throw new BusHaltedError(state.stopReason ?? 'bus halted');
      }

      const knownAgents = this.uniqueAgents([...state.agents, input.from, input.to]);
      const seq = Math.max(state.seq, await this.maxMessageSequenceUnsafe()) + 1;
      const round = state.round + 1;
      const message: BusMessage = {
        schema: SCHEMA,
        seq,
        round,
        createdAt: nowIso(),
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
            reason: `#${seq} ${message.from} acked and is working: ${message.subject}`
          }
        : {
            holder: message.to,
            since: message.createdAt,
            reason: `#${seq} from ${message.from}: ${message.subject}`
          };
      const designatedRound = state.haltPolicy.atRounds.includes(round) ||
        (state.haltPolicy.everyRounds !== null && round % state.haltPolicy.everyRounds === 0);
      if (round >= state.maxRounds || designatedRound) {
        state.halted = true;
        state.stopReason = round >= state.maxRounds
          ? `maxRounds (${state.maxRounds}) reached`
          : `designated round checkpoint (${round}) reached`;
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
    this.assertAgent(agent, 'agent');
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000)) throw new Error('read limit must be 1..10000.');
    return this.withLock(async () => {
      const unread = (await this.allMessagesUnsafe()).filter(
        (message) => message.to === agent && !message.read && message.supersededBy === undefined
      );
      const selected = all ? unread.slice(0, limit ?? unread.length) : unread.slice(0, 1);
      const readAt = nowIso();
      for (const message of selected) {
        message.read = true;
        message.readAt = readAt;
        const messagePath = await this.findMessagePathUnsafe(message.seq);
        if (!messagePath) {
          throw new Error(`Message file disappeared while reading sequence ${message.seq}.`);
        }
        await this.atomicJson(messagePath, message);
      }
      return selected;
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
      const bySeq = new Map((await this.allMessagesUnsafe()).map((message) => [message.seq, message]));
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
        const messagePath = await this.findMessagePathUnsafe(message.seq);
        if (!messagePath) {
          throw new Error(`Message file disappeared while acknowledging sequence ${message.seq}.`);
        }
        await this.atomicJson(messagePath, message);
      }
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
      if (!messagePath) throw new Error(`message #${seq} does not exist`);
      if (!replacementPath) throw new Error(`superseding message #${by} does not exist`);
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
      message.supersededBy = by;
      message.supersededAt = nowIso();
      message.supersedeReason = reason.trim();
      await this.atomicJson(messagePath, message);
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
      if (!messagePath) throw new Error(`message #${seq} does not exist`);
      const message = await this.readJson<BusMessage>(messagePath);
      if (message.to !== agent) throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
      const parkedAt = nowIso();
      message.read = true;
      message.readAt = parkedAt;
      message.parkedAt = parkedAt;
      message.parkedReason = reason.trim();
      this.closeCheckpoints(message, agent, 'parked', parkedAt);
      await this.atomicJson(messagePath, message);
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
      if (!messagePath) throw new Error(`message #${seq} does not exist`);
      const message = await this.readJson<BusMessage>(messagePath);
      if (message.to !== agent) throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
      if (!message.parkedAt) throw new Error(`message #${seq} is not parked`);
      message.read = false;
      delete message.readAt;
      delete message.parkedAt;
      delete message.parkedReason;
      this.closeCheckpoints(message, agent, 'requeued');
      await this.atomicJson(messagePath, message);
      return message;
    });
  }

  async openRecovery(agent: string, workId: number, note: string): Promise<RecoveryCheckpoint> {
    this.assertAgent(agent, 'agent');
    if (!Number.isSafeInteger(workId) || workId < 1) throw new Error('workId must be a positive mailbox sequence');
    return this.withLock(async () => {
      const messages = await this.allMessagesUnsafe();
      const source = messages.find((message) => message.seq === workId);
      if (!source) throw new Error(`message #${workId} does not exist`);
      const holdsInherited = (source.recoveryCheckpoints ?? []).some(
        (item) => item.seat === agent && item.status === 'open'
      );
      if (source.to !== agent && !holdsInherited) {
        throw new Error(`message #${workId} is addressed to ${source.to}, not ${agent}`);
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

  async evidenceForWake(workIds: number[]): Promise<EvidenceRecord[]> {
    return this.evidence.forWake(workIds);
  }

  async closeRecovery(agent: string, workId: number, reason: string): Promise<RecoveryCheckpoint | undefined> {
    return this.withLock(async () => {
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
    if (message.to !== seat) return undefined;
    // A retracted instruction is not recalled. Supersession is the revocation path.
    if (message.supersededBy !== undefined) return undefined;
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
    return this.withLock(async () => {
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
    do {
      if (signal?.aborted) return 'server_stopping';
      const state = await this.loadState();
      if (state.halted) {
        throw new BusHaltedError(state.stopReason ?? 'bus halted');
      }
      if ((await this.inbox(agent)).some((message) => message.seq > afterSeq)) {
        return 'message';
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
      const resolved: Array<{ path: string; root: string; identity: string }> = [];
      for (const requestedPath of requested) {
        let match: { path: string; root: string; identity: string } | undefined;
        for (const root of claimRoots) {
          const candidate = path.resolve(root, requestedPath);
          if (!(await this.exists(candidate))) continue;
          try {
            const identity = await fs.stat(candidate, { bigint: true });
            match = {
              path: requestedPath,
              root: this.canonicalComparablePath(await fs.realpath(root)),
              identity: filesystemIdentityMaterial(identity.dev, identity.ino)
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
      const requestedRoot = this.canonicalComparablePath(repoRoot ?? this.paths.root);
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
  async assignGoal(seat: string, responsibility: string): Promise<MailboxState> {
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

  async resume(addRounds = 0): Promise<MailboxState> {
    if (!Number.isInteger(addRounds) || addRounds < 0) {
      throw new Error('addRounds must be a non-negative integer.');
    }
    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      state.halted = false;
      state.stopReason = null;
      state.maxRounds += addRounds;
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(`\n**BUS RESUMED** (max rounds ${state.maxRounds})\n`);
      return state;
    });
  }

  async status(): Promise<MailboxStatus> {
    const [state, messages, workspaceCommit] = await Promise.all([
      this.loadState(),
      this.allMessages(),
      this.gitStamp()
    ]);
    const unread: Record<string, number> = {};
    for (const agent of state.agents) {
      unread[agent] = messages.filter(
        (message) => message.to === agent && !message.read && message.supersededBy === undefined
      ).length;
    }
    const remaining = state.maxRounds - state.round;
    const warningAt = Math.max(10, Math.ceil(state.maxRounds * 0.1));
    const roundWarning = !state.halted && remaining > 0 && remaining <= warningAt
      ? `${remaining} rounds remain before the round guard (${state.round}/${state.maxRounds}); raise the cap or finish the goal before mutating tools fail closed.`
      : undefined;
    return { ...state, unread, workspaceCommit, ...(roundWarning ? { roundWarning } : {}) };
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
        if (state.schema !== SCHEMA) {
          problems.push(`state schema is ${state.schema}; expected ${SCHEMA}`);
        } else if (await this.migrateClaimIdentities(state)) {
          await this.writeStateUnsafe(state);
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
        if (message.schema !== SCHEMA) {
          problems.push(`message ${message.seq} schema is ${message.schema}; expected ${SCHEMA}`);
        }
        if (sequences.has(message.seq)) {
          problems.push(`duplicate message sequence ${message.seq}`);
        }
        sequences.add(message.seq);
      }

      const maximumSequence = messages.reduce((maximum, message) => Math.max(maximum, message.seq), 0);
      if (state) {
        if (state.seq !== maximumSequence) {
          problems.push(`state seq is ${state.seq}; inbox maximum is ${maximumSequence}`);
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

      const mailboxNames = await fs.readdir(this.paths.mailboxDir);
      const temporaryFiles = mailboxNames.filter((name) => name.endsWith('.tmp') || name.endsWith('.candidate'));
      if (temporaryFiles.length > 0) {
        warnings.push(`${temporaryFiles.length} orphan temporary file(s) found`);
      }
      if (!(await this.exists(this.paths.transcriptPath))) {
        warnings.push('transcript.md is missing');
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
      schema: SCHEMA,
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
    if (state.schema !== SCHEMA) {
      throw new Error(`Unsupported mailbox schema ${state.schema}. Expected ${SCHEMA}.`);
    }
    if (await this.migrateClaimIdentities(state)) {
      await this.writeStateUnsafe(state);
    }
    const maxSeq = await this.maxMessageSequenceUnsafe();
    state.seq = Math.max(state.seq, maxSeq);
    state.round = Math.max(state.round, maxSeq);
    return state;
  }

  private async writeStateUnsafe(state: MailboxState) {
    await this.atomicJson(this.paths.statePath, state);
  }

  private async allMessages(): Promise<BusMessage[]> {
    if (!(await this.exists(this.paths.inboxDir))) {
      return [];
    }
    return this.allMessagesUnsafe();
  }

  private async allMessagesUnsafe(): Promise<BusMessage[]> {
    await fs.mkdir(this.paths.inboxDir, { recursive: true });
    const names = (await fs.readdir(this.paths.inboxDir))
      .filter((name) => name.endsWith('.json'))
      .sort();
    const messages = await Promise.all(
      names.map((name) => this.readJson<BusMessage>(path.join(this.paths.inboxDir, name)))
    );
    return messages.sort((left, right) => left.seq - right.seq);
  }

  private async maxMessageSequenceUnsafe() {
    if (!(await this.exists(this.paths.inboxDir))) {
      return 0;
    }
    const names = await fs.readdir(this.paths.inboxDir);
    return names.reduce((maximum, name) => {
      const parsed = Number.parseInt(name.slice(0, 6), 10);
      return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
    }, 0);
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
      const messages = await this.allMessages();
      if (!messages.some((message) => message.seq === workId)) {
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
    try {
      const [{ stdout: sha }, { stdout: dirty }] = await Promise.all([
        execFileAsync('git', ['-C', this.paths.root, 'rev-parse', 'HEAD'], { windowsHide: true }),
        execFileAsync('git', ['-C', this.paths.root, 'status', '--porcelain'], { windowsHide: true })
      ]);
      return { sha: sha.trim(), dirty: Boolean(dirty.trim()) };
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
    const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.renameFile(source, destination);
        return;
      } catch (error) {
        if (attempt >= 7 || !transient.has(errorCode(error) ?? '')) throw error;
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
      const message = await store.send({
        keepBaton: optionalBoolArg(args, 'keep-baton'),
        from: stringArg(args, 'from', true),
        to: stringArg(args, 'to', true),
        kind: stringArg(args, 'kind') || 'note',
        subject: stringArg(args, 'subject', true),
        body
      });
      console.log(json ? JSON.stringify(message, null, 2) : `sent #${message.seq} [round ${message.round}]`);
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
      const status = await store.status();
      console.log(JSON.stringify(status, null, 2));
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
      console.log(json ? JSON.stringify(state, null, 2) : `resumed: round ${state.round}/${state.maxRounds}`);
      return 0;
    }
    default:
      throw new Error(
        'usage: mailbox <init|send|inbox|read|parked|requeue|supersede|wait|claim|release|claims|close-recovery|status|doctor|goal|assign|stall-check|reassign|record-evidence|promote-evidence|list-evidence|configure-halting|complete-step|complete-goal|halt|resume> [options]'
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
