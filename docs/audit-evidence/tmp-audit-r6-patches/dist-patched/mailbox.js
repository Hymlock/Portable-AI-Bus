"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ClaimPathMissingError = exports.WholeRepositoryClaimError = exports.ClaimReasonRequiredError = exports.ClaimConflictError = exports.BusHaltedError = exports.MailboxStore = void 0;
const fs = __importStar(require("node:fs/promises"));
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_util_1 = require("node:util");
const evidence_1 = require("./evidence");
const claim_walk_1 = require("./claim-walk");
const workspace_key_1 = require("./workspace-key");
const execFileAsync = (0, node_util_1.promisify)(node_child_process_1.execFile);
const SCHEMA = 1;
const DEFAULT_MAX_ROUNDS = 32;
const LOCK_TIMEOUT_MS = 10_000;
function nowIso() {
    return new Date().toISOString();
}
function normalizeHaltRounds(value) {
    if (!Array.isArray(value) || value.length > 256 || value.some((item) => !Number.isSafeInteger(item) || item < 1)) {
        throw new Error('atRounds must contain at most 256 positive integers.');
    }
    return Array.from(new Set(value)).sort((left, right) => left - right);
}
function normalizeEveryRounds(value) {
    if (value === null || value === 0)
        return null;
    if (!Number.isSafeInteger(value) || value < 1)
        throw new Error('everyRounds must be a positive integer, zero, or null.');
    return value;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function delayUntil(ms, signal) {
    if (!signal)
        return delay(ms);
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
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
function errorCode(error) {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : undefined;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errorCode(error) === 'EPERM';
    }
}
function messageFileName(seq, from, to) {
    const safe = (value) => value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
    return `${String(seq).padStart(6, '0')}-${safe(from)}-to-${safe(to)}.json`;
}
class MailboxStore {
    paths;
    evidence;
    renameFile;
    constructor(root, options) {
        const resolvedRoot = path.resolve(root);
        this.renameFile = options?.renameFile ?? fs.rename;
        this.evidence = new evidence_1.EvidenceStore(resolvedRoot);
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
    async ensureInitialized(agents = [], maxRounds = DEFAULT_MAX_ROUNDS) {
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
                    throw new Error(`Refusing to retire seat(s) still holding claims: ${detail}. `
                        + 'Release those claims first, then re-run init.');
                }
                if (retiring.includes(existing.baton?.holder ?? '')) {
                    throw new Error(`Refusing to retire ${existing.baton?.holder}: it currently holds the baton. `
                        + 'Reassign the baton first, then re-run init.');
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
    async registerAgents(agents, requireRunning = false) {
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
    async send(input) {
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
            const message = {
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
            let supersedeOutcome = { superseded: false };
            let supersededTarget;
            if (input.supersedes !== undefined) {
                const targetFile = await this.findMessagePathUnsafe(input.supersedes);
                if (!targetFile) {
                    throw new Error(`Cannot supersede #${input.supersedes}: no such message. Nothing was sent.`);
                }
                const target = await this.readJson(targetFile);
                if (target.from !== input.from) {
                    throw new Error(`Cannot supersede #${input.supersedes}: it was sent by ${target.from}, not ${input.from}. `
                        + 'Nothing was sent.');
                }
                if (target.supersededBy !== undefined) {
                    // An already-superseded but unconsumed target is an invalid relationship, unlike the
                    // recoverable consumed case below. Refuse without delivering.
                    throw new Error(`Cannot supersede #${input.supersedes}: already superseded by #${target.supersededBy}. Nothing was sent.`);
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
                    throw new Error(`Cannot supersede #${input.supersedes}: it was sent to ${target.to}, not ${message.to}. ` +
                        'A replacement must reach the seat whose instruction it retracts. Nothing was sent.');
                }
                if (target.read) {
                    // TOO LATE, and say so honestly rather than pretending. The correction is still worth
                    // delivering; claiming a supersession that did not happen would be worse than a plain
                    // send. This is an atomic decision that supersession was too late, not a supersession.
                    supersedeOutcome = { superseded: false, reason: 'target-consumed' };
                }
                else {
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
                if (supersedeOutcome.reason)
                    message.supersedeOutcome = supersedeOutcome.reason;
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
    async inbox(agent) {
        this.assertAgent(agent, 'agent');
        return (await this.allMessages()).filter((message) => message.to === agent && !message.read && message.supersededBy === undefined);
    }
    async read(agent, all = false, limit) {
        this.assertAgent(agent, 'agent');
        if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000))
            throw new Error('read limit must be 1..10000.');
        return this.withLock(async () => {
            const unread = (await this.allMessagesUnsafe()).filter((message) => message.to === agent && !message.read && message.supersededBy === undefined);
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
    async acknowledge(agent, seqs) {
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
                if (!message)
                    throw new Error(`message #${seq} does not exist`);
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
    async supersedeMessage(seq, by, reason, actor) {
        if (!Number.isSafeInteger(seq) || seq < 1)
            throw new Error('message sequence must be a positive integer');
        if (!Number.isSafeInteger(by) || by < 1)
            throw new Error('superseding message sequence must be a positive integer');
        if (seq === by)
            throw new Error('a message cannot supersede itself');
        if (!reason.trim())
            throw new Error('supersession reason must not be empty');
        return this.withLock(async () => {
            const [messagePath, replacementPath] = await Promise.all([
                this.findMessagePathUnsafe(seq),
                this.findMessagePathUnsafe(by)
            ]);
            if (!messagePath)
                throw new Error(`message #${seq} does not exist`);
            if (!replacementPath)
                throw new Error(`superseding message #${by} does not exist`);
            const [message, replacement] = await Promise.all([
                this.readJson(messagePath),
                this.readJson(replacementPath)
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
                if (message.supersededBy === by && message.supersedeReason === reason.trim())
                    return message;
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
                throw new Error(`Cannot supersede #${seq}: ${message.to} has already read it. Supersession retracts UNREAD mail; ` +
                    'send a correction instead, and close the checkpoint if the work should stop.');
            }
            message.supersededBy = by;
            message.supersededAt = nowIso();
            message.supersedeReason = reason.trim();
            await this.atomicJson(messagePath, message);
            await this.appendLineUnsafe([
                '',
                `## Supersession: message #${message.seq}`,
                '',
                `- supersededBy: ${message.supersededBy}`,
                `- supersedeReason: ${message.supersedeReason}`,
                `- time: ${message.supersededAt}`,
                ''
            ].join('\n'));
            return message;
        });
    }
    async park(agent, seq, reason) {
        this.assertAgent(agent, 'agent');
        if (!Number.isSafeInteger(seq) || seq < 1)
            throw new Error('message sequence must be a positive integer');
        if (!reason.trim())
            throw new Error('parking reason must not be empty');
        return this.withLock(async () => {
            const messagePath = await this.findMessagePathUnsafe(seq);
            if (!messagePath)
                throw new Error(`message #${seq} does not exist`);
            const message = await this.readJson(messagePath);
            if (message.to !== agent)
                throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
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
    async parked(agent) {
        this.assertAgent(agent, 'agent');
        return (await this.allMessages()).filter((message) => message.to === agent && Boolean(message.parkedAt));
    }
    async requeue(agent, seq) {
        this.assertAgent(agent, 'agent');
        if (!Number.isSafeInteger(seq) || seq < 1)
            throw new Error('message sequence must be a positive integer');
        return this.withLock(async () => {
            const messagePath = await this.findMessagePathUnsafe(seq);
            if (!messagePath)
                throw new Error(`message #${seq} does not exist`);
            const message = await this.readJson(messagePath);
            if (message.to !== agent)
                throw new Error(`message #${seq} is addressed to ${message.to}, not ${agent}`);
            if (!message.parkedAt)
                throw new Error(`message #${seq} is not parked`);
            message.read = false;
            delete message.readAt;
            delete message.parkedAt;
            delete message.parkedReason;
            this.closeCheckpoints(message, agent, 'requeued');
            await this.atomicJson(messagePath, message);
            return message;
        });
    }
    async openRecovery(agent, workId, note) {
        this.assertAgent(agent, 'agent');
        if (!Number.isSafeInteger(workId) || workId < 1)
            throw new Error('workId must be a positive mailbox sequence');
        return this.withLock(async () => {
            const messages = await this.allMessagesUnsafe();
            const source = messages.find((message) => message.seq === workId);
            if (!source)
                throw new Error(`message #${workId} does not exist`);
            const holdsInherited = (source.recoveryCheckpoints ?? []).some((item) => item.seat === agent && item.status === 'open');
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
            const heldByAnother = (source.recoveryCheckpoints ?? []).find((item) => item.seat !== agent && item.status === 'open');
            if (heldByAnother) {
                throw new Error(`work #${workId} is held by ${heldByAnother.seat}, not ${agent}. It moved; ask for it back rather than re-opening it.`);
            }
            const at = nowIso();
            for (const message of messages) {
                if (message.seq === workId)
                    continue;
                if (this.closeCheckpoints(message, agent, `superseded by work #${workId}`, at)) {
                    const file = await this.findMessagePathUnsafe(message.seq);
                    if (file)
                        await this.atomicJson(file, message);
                }
            }
            source.recoveryCheckpoints ??= [];
            let checkpoint = source.recoveryCheckpoints.find((item) => item.seat === agent && item.status === 'open');
            if (checkpoint) {
                if (note.trim())
                    checkpoint.note = note.trim();
                checkpoint.updatedAt = at;
            }
            else {
                checkpoint = { id: (0, node_crypto_1.randomUUID)(), workId, seat: agent, status: 'open', note: note.trim(), actionReceipts: [], openedAt: at, updatedAt: at };
                source.recoveryCheckpoints.push(checkpoint);
            }
            const file = await this.findMessagePathUnsafe(workId);
            if (!file)
                throw new Error(`message #${workId} disappeared`);
            await this.atomicJson(file, source);
            return checkpoint;
        });
    }
    async openRecoveryFor(agent) {
        this.assertAgent(agent, 'agent');
        return (await this.allMessages()).flatMap((message) => message.recoveryCheckpoints ?? [])
            .filter((item) => item.seat === agent && item.status === 'open')
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt)).at(-1);
    }
    async recordRecoveryAction(agent, workId, actionId) {
        if (!actionId)
            throw new Error('action receipt id must not be empty');
        return this.withLock(async () => {
            const file = await this.findMessagePathUnsafe(workId);
            if (!file)
                throw new Error(`message #${workId} does not exist`);
            const message = await this.readJson(file);
            const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === agent && item.status === 'open');
            if (!checkpoint)
                throw new Error(`work #${workId} has no open recovery checkpoint for ${agent}`);
            if (!checkpoint.actionReceipts.includes(actionId))
                checkpoint.actionReceipts.push(actionId);
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
    async recordEvidence(input) {
        this.assertAgent(input.agent, 'evidence recorder');
        const subject = input.subject.trim();
        const statement = input.statement.trim();
        if (!subject)
            throw new Error('evidence subject must not be empty');
        if (!statement)
            throw new Error('evidence statement must not be empty');
        if (subject.length > 500)
            throw new Error('evidence subject must be at most 500 characters');
        if (statement.length > 4_096)
            throw new Error('evidence statement must be at most 4096 characters');
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
    async promoteEvidence(input) {
        this.assertAgent(input.agent, 'evidence promoter');
        if (!input.id.trim())
            throw new Error('evidence id must not be empty');
        if (!(0, evidence_1.isVerifierKind)(input.kind)) {
            throw new evidence_1.EvidencePromotionError(`unknown verifier kind: ${String(input.kind)}`);
        }
        const record = await this.evidence.get(input.id);
        const verifier = await this.observeVerifier(record, input);
        return this.evidence.promote(record.id, verifier);
    }
    async listEvidence(workId) {
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
    async consolidateEvidence(workId, recordedBy, options = {}) {
        this.assertAgent(recordedBy, 'evidence recorder');
        return this.evidence.consolidate(workId, recordedBy, options);
    }
    async evidenceForWake(workIds) {
        return this.evidence.forWake(workIds);
    }
    async closeRecovery(agent, workId, reason) {
        const checkpoint = await this.withLock(async () => {
            const file = await this.findMessagePathUnsafe(workId);
            if (!file)
                return undefined;
            const message = await this.readJson(file);
            const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === agent && item.status === 'open');
            if (!checkpoint)
                return undefined;
            const at = nowIso();
            checkpoint.status = 'closed';
            checkpoint.closedAt = at;
            checkpoint.updatedAt = at;
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
            }
            catch {
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
    async recallAssignment(seat, workId) {
        const file = await this.findMessagePathUnsafe(workId);
        if (!file)
            return undefined;
        const message = await this.readJson(file);
        // A retracted instruction is not recalled. Supersession is the revocation path.
        if (message.supersededBy !== undefined)
            return undefined;
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
        const holdsOpenCheckpoint = (message.recoveryCheckpoints ?? []).some((item) => item.seat === seat && item.status === 'open');
        if (!holdsOpenCheckpoint)
            return undefined;
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
    async operatorCloseRecovery(seat, workId, operatorReason) {
        if (typeof operatorReason !== 'string' || operatorReason.trim().length === 0) {
            throw new Error('Operator close refused: a reason is required. Nothing was closed.');
        }
        const checkpoint = await this.withLock(async () => {
            const file = await this.findMessagePathUnsafe(workId);
            if (!file)
                return undefined;
            const message = await this.readJson(file);
            const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === seat && item.status === 'open');
            if (!checkpoint)
                return undefined;
            const at = nowIso();
            checkpoint.status = 'closed';
            checkpoint.closedAt = at;
            checkpoint.updatedAt = at;
            checkpoint.closeReason = `operator-closed: ${operatorReason.trim()}`;
            await this.atomicJson(file, message);
            return checkpoint;
        });
        if (checkpoint) {
            try { await this.evidence.consolidate(workId, seat); }
            catch { /* best-effort; the close is the fact */ }
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
    async inheritOpenRecoveryUnsafe(from, to, reason) {
        const messages = await this.allMessagesUnsafe();
        const source = messages.find((message) => (message.recoveryCheckpoints ?? []).some((item) => item.seat === from && item.status === 'open'));
        const checkpoint = source?.recoveryCheckpoints?.find((item) => item.seat === from && item.status === 'open');
        if (!source || !checkpoint)
            return null;
        const at = nowIso();
        for (const message of messages) {
            if (message.seq === source.seq)
                continue;
            if (this.closeCheckpoints(message, to, `superseded by inherited work #${source.seq}`, at)) {
                const file = await this.findMessagePathUnsafe(message.seq);
                if (file)
                    await this.atomicJson(file, message);
            }
        }
        checkpoint.status = 'closed';
        checkpoint.closedAt = at;
        checkpoint.updatedAt = at;
        checkpoint.closeReason = `reassigned to ${to}: ${reason}`;
        this.closeCheckpoints(source, to, `superseded by inherited work #${source.seq}`, at);
        source.recoveryCheckpoints ??= [];
        source.recoveryCheckpoints.push({
            id: (0, node_crypto_1.randomUUID)(),
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
        if (!file)
            throw new Error(`message #${source.seq} disappeared during reassignment`);
        await this.atomicJson(file, source);
        return source.seq;
    }
    closeCheckpoints(message, agent, reason, at = nowIso()) {
        let changed = false;
        for (const checkpoint of message.recoveryCheckpoints ?? []) {
            if (checkpoint.seat !== agent || checkpoint.status !== 'open')
                continue;
            checkpoint.status = 'closed';
            checkpoint.closedAt = at;
            checkpoint.updatedAt = at;
            checkpoint.closeReason = reason;
            changed = true;
        }
        return changed;
    }
    async waitFor(agent, timeoutMs = 600_000, intervalMs = 500, afterSeq = 0, signal) {
        this.assertAgent(agent, 'agent');
        if (timeoutMs < 0 || intervalMs < 25) {
            throw new Error('Timeout must be non-negative and poll interval must be at least 25 ms.');
        }
        const deadline = Date.now() + timeoutMs;
        do {
            if (signal?.aborted)
                return 'server_stopping';
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
    async claim(input) {
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
            const missing = [];
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
            const rootRealPaths = [];
            for (const rootPath of claimRoots) {
                try {
                    rootRealPaths.push(this.canonicalComparablePath(await fs.realpath(rootPath)));
                }
                catch {
                    throw new Error(`claim root does not exist: ${rootPath}. Refusing every claim rather than checking against a root that is not there.`);
                }
            }
            // `real` is the resolved destination, junctions and symlinks followed. The lexical path
            // says what was asked for; only this says where it actually lands.
            const resolved = [];
            for (const requestedPath of requested) {
                let match;
                for (const root of claimRoots) {
                    const candidate = path.resolve(root, requestedPath);
                    if (!(await this.exists(candidate)))
                        continue;
                    try {
                        const identity = await fs.stat(candidate, { bigint: true });
                        match = {
                            path: requestedPath,
                            root: this.canonicalComparablePath(await fs.realpath(root)),
                            identity: (0, workspace_key_1.filesystemIdentityMaterial)(identity.dev, identity.ino),
                            real: this.canonicalComparablePath(await fs.realpath(candidate))
                        };
                    }
                    catch {
                        // The path can disappear between exists() and identity discovery. Treat that as
                        // missing rather than crashing or recording an identity we did not observe.
                        continue;
                    }
                    break;
                }
                if (!match) {
                    missing.push(requestedPath);
                }
                else {
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
                (rootReal) => candidate.real !== rootReal && candidate.real.startsWith(`${rootReal}/`));
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
                await this.appendLineUnsafe(`\n- **claim** \`${input.agent}\` -> ${requested.join(', ')} (${input.why?.trim() || ''})\n`);
            }
            return held;
        });
    }
    async release(agent, paths, repoRoot) {
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
                    if (repoRoot && only?.root && only.root !== requestedRoot)
                        return undefined;
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
            const released = new Set(selected.map((claim) => `${claim.root ?? ''}\0${claim.path}`));
            const remaining = held.filter((claim) => !released.has(`${claim.root ?? ''}\0${claim.path}`));
            if (remaining.length > 0) {
                state.claims[agent] = remaining;
            }
            else {
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
    async halt(reason, options = {}) {
        if (!options.force) {
            const current = await this.loadState();
            const holder = current.baton?.holder;
            if (holder && holder !== options.by) {
                const unread = (await this.inbox(holder)).length;
                if (unread > 0) {
                    throw new Error(`Refusing to halt: ${holder} holds the baton with ${unread} unread message(s) and ` +
                        `would be trapped - able to read but not reply. Let them act, or pass --force if ` +
                        `you know they are gone.`);
                }
            }
        }
        return this.haltUnchecked(reason);
    }
    async haltUnchecked(reason) {
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
    async setGoal(goal) {
        if (!goal.statement?.trim())
            throw new Error('goal statement is required.');
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
            const event = {
                id: (0, node_crypto_1.randomUUID)(),
                kind: previous ? 'goal-replaced' : 'goal-set',
                at,
                previousIdentity: previous?.setAt ?? null,
                nextIdentity: at
            };
            state.lifecycleEvents.push(event);
            state.lifecycleEvents = state.lifecycleEvents.slice(-100);
            await this.writeStateUnsafe(state);
            await this.appendLineUnsafe(`\n---\n\n## GOAL\n\n${state.goal.statement}\n\n**Done when:** ${state.goal.doneWhen}\n\n---\n`);
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
    async assignGoal(seat, responsibility) {
        return this.withLock(async () => {
            const state = await this.loadStateUnsafe();
            if (!state.goal)
                throw new Error('No goal set. Run: mailbox goal --statement ... --done-when ...');
            if (!state.agents.includes(seat))
                throw new Error(`Unknown seat: ${seat}`);
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
    async reassignBaton(input) {
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
    async stallCheck(staleAfterSeconds = 300) {
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
    async configureHalting(policy) {
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
            await this.appendLineUnsafe(`\n**HALT POLICY** step=${state.haltPolicy.onStepCompletion} goal=${state.haltPolicy.onGoalCompletion} ` +
                `at=${state.haltPolicy.atRounds.join(',') || 'none'} every=${state.haltPolicy.everyRounds ?? 'off'}\n`);
            return state;
        });
    }
    async complete(input) {
        this.assertAgent(input.actor, 'completion actor');
        if (input.scope !== 'step' && input.scope !== 'goal')
            throw new Error('Completion scope must be step or goal.');
        const summary = input.summary.trim();
        if (!summary || summary.length > 10_000)
            throw new Error('Completion summary must be 1..10000 characters.');
        const evidence = Array.from(new Set(input.evidence ?? []));
        if (evidence.length > 32 || evidence.some((item) => typeof item !== 'string' || !item.trim() || item.length > 4_096)) {
            throw new Error('Completion evidence must contain at most 32 non-empty strings up to 4096 characters each.');
        }
        return this.withLock(async () => {
            const state = await this.loadStateUnsafe();
            if (state.halted)
                throw new BusHaltedError(state.stopReason ?? 'bus halted');
            const shouldHalt = input.scope === 'step' ? state.haltPolicy.onStepCompletion : state.haltPolicy.onGoalCompletion;
            const event = {
                id: (0, node_crypto_1.randomUUID)(),
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
            await this.appendLineUnsafe(`\n**${input.scope.toUpperCase()} COMPLETED** by \`${input.actor}\`${shouldHalt ? ' - BUS HALTED' : ''}\n\n${summary}\n` +
                (event.evidence.length > 0 ? `\nEvidence: ${event.evidence.join(', ')}\n` : ''));
            return event;
        });
    }
    async resume(addRounds = 0) {
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
    async status() {
        const [state, messages, workspaceCommit] = await Promise.all([
            this.loadState(),
            this.allMessages(),
            this.gitStamp()
        ]);
        const unread = {};
        for (const agent of state.agents) {
            unread[agent] = messages.filter((message) => message.to === agent && !message.read && message.supersededBy === undefined).length;
        }
        const remaining = state.maxRounds - state.round;
        const warningAt = Math.max(10, Math.ceil(state.maxRounds * 0.1));
        const roundWarning = !state.halted && remaining > 0 && remaining <= warningAt
            ? `${remaining} rounds remain before the round guard (${state.round}/${state.maxRounds}); raise the cap or finish the goal before mutating tools fail closed.`
            : undefined;
        return { ...state, unread, workspaceCommit, ...(roundWarning ? { roundWarning } : {}) };
    }
    async claims() {
        return (await this.loadState()).claims;
    }
    async epoch() {
        return (await this.loadState()).createdAt;
    }
    async doctor() {
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
            const problems = [];
            const warnings = [];
            let state;
            let messages = [];
            try {
                state = await this.loadState();
                if (state.schema !== SCHEMA) {
                    problems.push(`state schema is ${state.schema}; expected ${SCHEMA}`);
                }
                else if (await this.migrateClaimIdentities(state)) {
                    await this.writeStateUnsafe(state);
                }
            }
            catch (error) {
                problems.push(`state.json cannot be read: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                messages = await this.allMessagesUnsafe();
            }
            catch (error) {
                problems.push(`inbox cannot be read: ${error instanceof Error ? error.message : String(error)}`);
            }
            const sequences = new Set();
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
                            warnings.push(`${owner}:${claim.path} uses weaker ${shape} claim identity; `
                                + 'filesystem alias overlap cannot be verified until the path is reachable');
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
                                    problems.push(`claims overlap: ${leftOwner}:${leftClaim.path} and ${rightOwner}:${rightClaim.path}`);
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
    async lockObstruction() {
        const describe = async (lockPath, label) => {
            if (!(await this.exists(lockPath)))
                return undefined;
            const owner = await fs.readFile(lockPath, 'utf8')
                .then((text) => JSON.parse(text))
                .catch(() => undefined);
            if (!owner || typeof owner.id !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid < 1) {
                return `${label} is malformed and blocks safe automatic recovery: ${lockPath}`;
            }
            return processAlive(owner.pid)
                ? `${label} is held by live PID ${owner.pid}: ${lockPath}`
                : `${label} was left by dead PID ${owner.pid} and blocks safe automatic recovery: ${lockPath}`;
        };
        const recovery = await describe(this.paths.recoveryLockPath, 'mailbox recovery lock');
        if (recovery)
            return recovery;
        const primary = await describe(this.paths.lockPath, 'mailbox lock');
        if (primary?.includes('malformed') || primary?.includes('held by live'))
            return primary;
        return undefined;
    }
    defaultState() {
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
    async loadState() {
        if (!(await this.exists(this.paths.statePath))) {
            const [transcriptExists, inboxEntries] = await Promise.all([
                this.exists(this.paths.transcriptPath),
                fs.readdir(this.paths.inboxDir).catch((error) => {
                    if (error.code === 'ENOENT')
                        return [];
                    throw error;
                })
            ]);
            if (transcriptExists || inboxEntries.some((name) => name.endsWith('.json'))) {
                throw new Error(`Mailbox state is missing while durable artifacts remain: ${this.paths.statePath}`);
            }
            return this.defaultState();
        }
        const state = await this.readJson(this.paths.statePath);
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
    async loadStateUnsafe() {
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
    async writeStateUnsafe(state) {
        await this.atomicJson(this.paths.statePath, state);
    }
    async allMessages() {
        if (!(await this.exists(this.paths.inboxDir))) {
            return [];
        }
        return this.allMessagesUnsafe();
    }
    async allMessagesUnsafe() {
        await fs.mkdir(this.paths.inboxDir, { recursive: true });
        const names = (await fs.readdir(this.paths.inboxDir))
            .filter((name) => name.endsWith('.json'))
            .sort();
        const messages = await Promise.all(names.map((name) => this.readJson(path.join(this.paths.inboxDir, name))));
        return messages.sort((left, right) => left.seq - right.seq);
    }
    async maxMessageSequenceUnsafe() {
        if (!(await this.exists(this.paths.inboxDir))) {
            return 0;
        }
        const names = await fs.readdir(this.paths.inboxDir);
        return names.reduce((maximum, name) => {
            const parsed = Number.parseInt(name.slice(0, 6), 10);
            return Number.isFinite(parsed) ? Math.max(maximum, parsed) : maximum;
        }, 0);
    }
    async findMessagePathUnsafe(seq) {
        const prefix = `${String(seq).padStart(6, '0')}-`;
        const name = (await fs.readdir(this.paths.inboxDir)).find((item) => item.startsWith(prefix));
        return name ? path.join(this.paths.inboxDir, name) : undefined;
    }
    async appendTranscriptUnsafe(message) {
        const commit = message.workspaceCommit
            ? `${message.workspaceCommit.sha.slice(0, 12)}${message.workspaceCommit.dirty ? ' (dirty)' : ''}`
            : '<not a git repo>';
        await this.appendLineUnsafe([
            '',
            `## ${message.seq}. ${message.from} -> ${message.to} [${message.kind}] ${message.subject}`,
            '',
            `- round: ${message.round}`,
            `- commit: \`${commit}\``,
            `- time: ${message.createdAt}`,
            '',
            message.body.trim(),
            ''
        ].join('\n'));
    }
    async appendLineUnsafe(content) {
        await fs.mkdir(path.dirname(this.paths.transcriptPath), { recursive: true });
        await fs.appendFile(this.paths.transcriptPath, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
    }
    async resolveEvidenceWorkId(agent, workId) {
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
        if (open)
            return open.workId;
        throw new Error('record requires workId; no open recovery exists for this seat');
    }
    async observeVerifier(record, input) {
        if (input.kind === 'commit-diff')
            return (0, evidence_1.observeCommitDiff)(this.paths.root, record.subject, record.createdAt);
        if (input.kind === 'runner-result') {
            return (0, evidence_1.observeRunnerResult)(this.paths.root, record.subject, input.invocation, record.createdAt);
        }
        return (0, evidence_1.observeLifecycle)(this.paths.root, record.subject, input.transition, record.createdAt);
    }
    async gitStamp() {
        // Most mailbox roots are runtime directories, not source checkouts. Spawning Git anyway
        // was not merely wasted work on Windows: every status/send created two short-lived console
        // processes, and mailbox/extension polling turned those into visible flashes. Check for Git
        // metadata in-process before launching anything. Walking upward preserves support for a bus
        // rooted in a subdirectory of a repository, including worktrees where `.git` is a file.
        let candidate = path.resolve(this.paths.root);
        while (!(await this.exists(path.join(candidate, '.git')))) {
            const parent = path.dirname(candidate);
            if (parent === candidate)
                return undefined;
            candidate = parent;
        }
        try {
            const [{ stdout: sha }, { stdout: dirty }] = await Promise.all([
                execFileAsync('git', ['-C', this.paths.root, 'rev-parse', 'HEAD'], { windowsHide: true }),
                execFileAsync('git', ['-C', this.paths.root, 'status', '--porcelain'], { windowsHide: true })
            ]);
            return { sha: sha.trim(), dirty: Boolean(dirty.trim()) };
        }
        catch {
            return undefined;
        }
    }
    normalizeClaimPath(value) {
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
    comparablePath(value) {
        return process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value;
    }
    canonicalComparablePath(value) {
        return this.comparablePath(path.resolve(value).replace(/\\/g, '/').replace(/\/$/, ''));
    }
    pathContains(parent, child) {
        const left = this.comparablePath(parent);
        const right = this.comparablePath(child);
        return left === right || left === '.' || right.startsWith(`${left}/`);
    }
    pathsOverlap(left, right) {
        return this.pathContains(left, right) || this.pathContains(right, left);
    }
    isFilesystemIdentity(identity) {
        return identity?.startsWith('filesystem-v1:') === true;
    }
    claimPathCandidates(claim, fallbackRoots) {
        const candidates = (claim.root ? [claim.root] : fallbackRoots)
            .map((root) => path.resolve(root, claim.path));
        if (claim.identity && !this.isFilesystemIdentity(claim.identity) && path.isAbsolute(claim.identity)) {
            candidates.push(claim.identity);
        }
        return Array.from(new Set(candidates.map((candidate) => path.resolve(candidate))));
    }
    observedFilesystemIdentity(candidate) {
        try {
            const observed = (0, node_fs_1.statSync)(candidate, { bigint: true });
            return (0, workspace_key_1.filesystemIdentityMaterial)(observed.dev, observed.ino);
        }
        catch {
            return undefined;
        }
    }
    claimIdentities(claim, fallbackRoots) {
        const identities = new Set();
        if (this.isFilesystemIdentity(claim.identity))
            identities.add(claim.identity);
        for (const candidate of this.claimPathCandidates(claim, fallbackRoots)) {
            const observed = this.observedFilesystemIdentity(candidate);
            if (observed)
                identities.add(observed);
            try {
                identities.add(this.canonicalComparablePath((0, node_fs_1.realpathSync)(candidate)));
            }
            catch {
                identities.add(this.canonicalComparablePath(candidate));
            }
        }
        return [...identities];
    }
    directoryContainsClaim(parent, child, fallbackRoots) {
        const targets = new Set(this.claimIdentities(child, fallbackRoots).filter((identity) => this.isFilesystemIdentity(identity)));
        if (targets.size === 0)
            return false;
        // Item 14: keep the walk (it joins a parent path to a child inode under a
        // third name) but stay under the claimed directory. Outbound junctions are
        // not descended; hardlinks of in-tree files still match by inode.
        for (const candidate of this.claimPathCandidates(parent, fallbackRoots)) {
            if ((0, claim_walk_1.directoryContainsIdentities)(candidate, targets, { stayUnderRoot: candidate })) {
                return true;
            }
        }
        return false;
    }
    claimsOverlap(left, right, fallbackRoots) {
        return this.claimIdentities(left, fallbackRoots).some((leftIdentity) => this.claimIdentities(right, fallbackRoots).some((rightIdentity) => this.pathsOverlap(leftIdentity, rightIdentity))) || this.directoryContainsClaim(left, right, fallbackRoots)
            || this.directoryContainsClaim(right, left, fallbackRoots);
    }
    claimContains(parent, child, fallbackRoots) {
        return this.claimIdentities(parent, fallbackRoots).some((parentIdentity) => this.claimIdentities(child, fallbackRoots).some((childIdentity) => this.pathContains(parentIdentity, childIdentity))) || this.directoryContainsClaim(parent, child, fallbackRoots);
    }
    async migrateClaimIdentities(state) {
        let changed = false;
        for (const claims of Object.values(state.claims)) {
            for (const claim of claims) {
                if (this.isFilesystemIdentity(claim.identity))
                    continue;
                const roots = claim.root ? [claim.root] : [this.paths.root];
                for (const root of roots) {
                    const candidate = path.resolve(root, claim.path);
                    try {
                        const observed = await fs.stat(candidate, { bigint: true });
                        claim.root = this.canonicalComparablePath(await fs.realpath(root));
                        claim.identity = (0, workspace_key_1.filesystemIdentityMaterial)(observed.dev, observed.ino);
                        changed = true;
                        break;
                    }
                    catch {
                        // Preserve the weaker row when its path cannot be observed. Doctor reports it.
                    }
                }
            }
        }
        return changed;
    }
    uniqueAgents(agents) {
        return Array.from(new Set(agents.map((agent) => agent.trim()).filter(Boolean))).sort();
    }
    assertAgent(agent, label) {
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
    assertSeated(state, agent, label) {
        this.assertAgent(agent, label);
        if (!state.agents.includes(agent)) {
            throw new Error(`${agent} is not a seat (${label}). Seated: ${state.agents.join(', ')}. `
                + 'Seats are declared by init, not created by acting.');
        }
    }
    async withLock(action) {
        await fs.mkdir(this.paths.mailboxDir, { recursive: true });
        const started = Date.now();
        const lockId = (0, node_crypto_1.randomUUID)();
        let ownsLock = false;
        while (!ownsLock) {
            if (await this.exists(this.paths.recoveryLockPath)) {
                if (Date.now() - started >= LOCK_TIMEOUT_MS)
                    throw new Error(`Timed out waiting for mailbox lock recovery: ${this.paths.recoveryLockPath}`);
                await delay(25);
                continue;
            }
            try {
                await this.publishExclusiveLock(this.paths.lockPath, { id: lockId, pid: process.pid, at: nowIso() });
                ownsLock = true;
            }
            catch (error) {
                if (errorCode(error) !== 'EEXIST') {
                    throw error;
                }
                const owner = await fs.readFile(this.paths.lockPath, 'utf8')
                    .then((text) => JSON.parse(text))
                    .catch(() => undefined);
                if (owner?.id && owner.pid && !processAlive(owner.pid) && await this.recoverMailboxLock(owner.id))
                    continue;
                if (Date.now() - started >= LOCK_TIMEOUT_MS) {
                    throw new Error(`Timed out waiting for mailbox lock: ${this.paths.lockPath}`);
                }
                await delay(25);
            }
        }
        try {
            return await action();
        }
        finally {
            try {
                const lock = JSON.parse(await fs.readFile(this.paths.lockPath, 'utf8'));
                if (lock.id === lockId) {
                    await fs.rm(this.paths.lockPath, { force: true });
                }
            }
            catch (error) {
                if (errorCode(error) !== 'ENOENT')
                    throw error;
            }
        }
    }
    async recoverMailboxLock(expectedId) {
        const recoveryId = (0, node_crypto_1.randomUUID)();
        try {
            await this.publishExclusiveLock(this.paths.recoveryLockPath, { id: recoveryId, pid: process.pid, at: nowIso() });
        }
        catch (error) {
            if (errorCode(error) === 'EEXIST')
                return false;
            throw error;
        }
        try {
            const current = await fs.readFile(this.paths.lockPath, 'utf8')
                .then((text) => JSON.parse(text))
                .catch(() => undefined);
            if (current?.id !== expectedId || !current.pid || processAlive(current.pid))
                return false;
            await fs.rm(this.paths.lockPath, { force: true });
            return true;
        }
        finally {
            const recovery = await fs.readFile(this.paths.recoveryLockPath, 'utf8')
                .then((text) => JSON.parse(text))
                .catch(() => undefined);
            if (recovery?.id === recoveryId)
                await fs.rm(this.paths.recoveryLockPath, { force: true });
        }
    }
    async publishExclusiveLock(destination, owner) {
        const candidate = `${destination}.${process.pid}.${(0, node_crypto_1.randomUUID)()}.candidate`;
        try {
            await fs.writeFile(candidate, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
            await fs.link(candidate, destination);
        }
        finally {
            await fs.rm(candidate, { force: true });
        }
    }
    async atomicJson(filePath, value) {
        await this.atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }
    async atomicWrite(filePath, content) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
        try {
            await fs.writeFile(temporary, content, 'utf8');
            await this.renameWithRetry(temporary, filePath);
        }
        finally {
            await fs.rm(temporary, { force: true });
        }
    }
    async renameWithRetry(source, destination) {
        const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
        for (let attempt = 0;; attempt += 1) {
            try {
                await this.renameFile(source, destination);
                return;
            }
            catch (error) {
                if (attempt >= 7 || !transient.has(errorCode(error) ?? ''))
                    throw error;
                // Antivirus/indexer handles on Windows commonly clear within one scheduler slice.
                // Keep the temporary file intact and retry the atomic publish; never delete the live
                // destination as a workaround because that would create a data-loss window.
                await delay(Math.min(100, 10 * (2 ** attempt)));
            }
        }
    }
    async readJson(filePath) {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    }
    async exists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.MailboxStore = MailboxStore;
class BusHaltedError extends Error {
    exitCode = 2;
    constructor(reason) {
        super(`BUS HALTED: ${reason}`);
        this.name = 'BusHaltedError';
    }
}
exports.BusHaltedError = BusHaltedError;
class ClaimConflictError extends Error {
    holder;
    claim;
    exitCode = 1;
    constructor(holder, claim) {
        super(`${holder} already holds ${claim.path} since ${claim.at}: ${claim.why}`);
        this.holder = holder;
        this.claim = claim;
        this.name = 'ClaimConflictError';
    }
}
exports.ClaimConflictError = ClaimConflictError;
/** Item 7. A claim with no reason is the row an operator cannot act on. */
class ClaimReasonRequiredError extends Error {
    exitCode = 1;
    constructor() {
        super('Claim refused: --why is required. Say what the claim is for; a seat that dies holding a '
            + 'path leaves this reason as the only explanation. No claim was recorded.');
        this.name = 'ClaimReasonRequiredError';
    }
}
exports.ClaimReasonRequiredError = ClaimReasonRequiredError;
/** Item 13. A claim that covers everything protects nothing and blocks everyone. */
class WholeRepositoryClaimError extends Error {
    requested;
    exitCode = 1;
    constructor(requested) {
        super(`Claim refused: "${requested}" is the whole repository. Ancestor claims below the root `
            + '(for example src/) are allowed; claiming the root locks every seat out of every file '
            + 'with no expiry. Claim the paths you are actually editing. No claim was recorded.');
        this.requested = requested;
        this.name = 'WholeRepositoryClaimError';
    }
}
exports.WholeRepositoryClaimError = WholeRepositoryClaimError;
class ClaimPathMissingError extends Error {
    paths;
    exitCode = 1;
    constructor(paths) {
        super(`Claim refused: path(s) do not exist in the workspace: ${paths.join(', ')}. `
            + 'No claim was recorded.');
        this.paths = paths;
        this.name = 'ClaimPathMissingError';
    }
}
exports.ClaimPathMissingError = ClaimPathMissingError;
function parseArgs(argv) {
    const args = { _: [] };
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
        }
        else {
            args[key] = next;
            index += 1;
        }
    }
    return args;
}
function stringArg(args, name, required = false) {
    const value = typeof args[name] === 'string' ? String(args[name]) : '';
    if (required && !value) {
        throw new Error(`Missing --${name}.`);
    }
    return value;
}
function intArg(args, name, fallback) {
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
function listArg(args, name) {
    return stringArg(args, name)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
}
function optionalBoolArg(args, name) {
    const raw = stringArg(args, name);
    if (!raw)
        return undefined;
    if (raw === 'true')
        return true;
    if (raw === 'false')
        return false;
    throw new Error(`--${name} must be true or false.`);
}
function optionalIntArg(args, name) {
    if (args[name] === undefined)
        return undefined;
    return intArg(args, name, 0);
}
function printMessages(messages, json) {
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
            console.log(`commit : ${message.workspaceCommit.sha.slice(0, 12)}${message.workspaceCommit.dirty ? ' (DIRTY)' : ''}`);
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
            const state = await store.ensureInitialized(listArg(args, 'agents'), intArg(args, 'max-rounds', DEFAULT_MAX_ROUNDS));
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
            if (message.superseded === true)
                line += ` superseding #${supersedes}`;
            else if (message.supersedeOutcome)
                line += ` (NOT superseded: ${message.supersedeOutcome})`;
            console.log(json ? JSON.stringify(message, null, 2) : line);
            return 0;
        }
        case 'supersede': {
            const message = await store.supersedeMessage(intArg(args, 'seq', 0), intArg(args, 'by', 0), stringArg(args, 'reason', true), stringArg(args, 'from', true));
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
            const message = await store.requeue(stringArg(args, 'for', true), intArg(args, 'seq', 0));
            console.log(json ? JSON.stringify(message, null, 2) : `requeued #${message.seq}`);
            return 0;
        }
        case 'wait': {
            const result = await store.waitFor(stringArg(args, 'for', true), intArg(args, 'timeout', 600) * 1000, intArg(args, 'interval-ms', 500));
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
            const claims = await store.release(stringArg(args, 'agent', true), paths.length > 0 ? paths : undefined, stringArg(args, 'repo') || undefined);
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
            const closed = await store.operatorCloseRecovery(stringArg(args, 'seat', true), Number(stringArg(args, 'work-id', true)), stringArg(args, 'reason', true));
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
                statement: stringArg(args, 'statement', true),
                doneWhen: stringArg(args, 'done-when', true),
                setBy: stringArg(args, 'by')
            });
            console.log(json ? JSON.stringify(state, null, 2) :
                `goal set: ${state.goal.statement}
  done when: ${state.goal.doneWhen}`);
            return 0;
        }
        case 'assign': {
            const state = await store.assignGoal(stringArg(args, 'seat', true), stringArg(args, 'responsibility', true));
            console.log(json ? JSON.stringify(state, null, 2) :
                Object.entries(state.goal.assignments).map(([seat, task]) => `${seat}: ${task}`).join('\n'));
            return 0;
        }
        case 'stall-check': {
            const report = await store.stallCheck(intArg(args, 'stale-after', 300));
            if (json) {
                console.log(JSON.stringify(report, null, 2));
            }
            else {
                console.log(report.stalled ? `STALLED: ${report.reason}` : `ok: ${report.reason}`);
                if (report.holder)
                    console.log(`  baton: ${report.holder} (${report.heldSeconds}s)`);
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
            if (!(0, evidence_1.isVerifierKind)(kind))
                throw new Error(`--kind must be one of ${['commit-diff', 'runner-result', 'lifecycle-transition'].join(', ')}`);
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
            const result = await store.consolidateEvidence(intArg(args, 'work-id', 0), stringArg(args, 'agent', true), { minEpisodes: optionalIntArg(args, 'min-episodes') ?? undefined });
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
            console.log(json ? JSON.stringify(state, null, 2) : `resumed: round ${state.round}/${state.maxRounds}`);
            return 0;
        }
        default:
            throw new Error('usage: mailbox <init|send|inbox|read|parked|requeue|supersede|wait|claim|release|claims|close-recovery|status|doctor|goal|assign|stall-check|reassign|record-evidence|promote-evidence|list-evidence|consolidate-evidence|configure-halting|complete-step|complete-goal|halt|resume> [options]');
    }
}
if (require.main === module) {
    runCli()
        .then((exitCode) => {
        process.exitCode = exitCode;
    })
        .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode =
            typeof error === 'object' && error !== null && 'exitCode' in error
                ? Number(error.exitCode)
                : 1;
    });
}
//# sourceMappingURL=mailbox.js.map