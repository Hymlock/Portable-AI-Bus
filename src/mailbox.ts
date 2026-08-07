import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCHEMA = 1;
const DEFAULT_MAX_ROUNDS = 32;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 60_000;

export type Claim = {
  path: string;
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
};

export type MailboxStatus = MailboxState & {
  unread: Record<string, number>;
  workspaceCommit?: CommitStamp;
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
};

type SendInput = {
  from: string;
  to: string;
  kind?: string;
  subject: string;
  body: string;
};

type ClaimInput = {
  agent: string;
  paths: string[];
  why?: string;
};

function nowIso() {
  return new Date().toISOString();
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function messageFileName(seq: number, from: string, to: string) {
  const safe = (value: string) => value.replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${String(seq).padStart(6, '0')}-${safe(from)}-to-${safe(to)}.json`;
}

export class MailboxStore {
  readonly paths: MailboxPaths;

  constructor(root: string) {
    const resolvedRoot = path.resolve(root);
    const mailboxDir = path.join(resolvedRoot, '.ai-bus', 'runtime', 'mailbox');
    this.paths = {
      root: resolvedRoot,
      mailboxDir,
      inboxDir: path.join(mailboxDir, 'inbox'),
      statePath: path.join(mailboxDir, 'state.json'),
      transcriptPath: path.join(mailboxDir, 'transcript.md'),
      lockPath: path.join(mailboxDir, '.lock')
    };
  }

  async ensureInitialized(agents: string[] = [], maxRounds = DEFAULT_MAX_ROUNDS): Promise<MailboxState> {
    return this.withLock(async () => {
      const alreadyInitialized = await this.exists(this.paths.statePath);
      const existing = await this.loadStateUnsafe();
      const normalizedAgents = this.uniqueAgents([...existing.agents, ...agents]);
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
      this.assertAgent(input.from, 'sender');
      this.assertAgent(input.to, 'recipient');
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

      const messagePath = path.join(this.paths.inboxDir, messageFileName(seq, message.from, message.to));
      await this.atomicJson(messagePath, message);
      state.seq = seq;
      state.round = round;
      state.agents = knownAgents;
      await this.writeStateUnsafe(state);
      await this.appendTranscriptUnsafe(message);
      return message;
    });
  }

  async inbox(agent: string): Promise<BusMessage[]> {
    this.assertAgent(agent, 'agent');
    return (await this.allMessages()).filter((message) => message.to === agent && !message.read);
  }

  async read(agent: string, all = false): Promise<BusMessage[]> {
    this.assertAgent(agent, 'agent');
    return this.withLock(async () => {
      const unread = (await this.allMessagesUnsafe()).filter(
        (message) => message.to === agent && !message.read
      );
      const selected = all ? unread : unread.slice(0, 1);
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

  async waitFor(agent: string, timeoutMs = 600_000, intervalMs = 500): Promise<'message' | 'timeout'> {
    this.assertAgent(agent, 'agent');
    if (timeoutMs < 0 || intervalMs < 25) {
      throw new Error('Timeout must be non-negative and poll interval must be at least 25 ms.');
    }
    const deadline = Date.now() + timeoutMs;
    do {
      const state = await this.loadState();
      if (state.halted) {
        throw new BusHaltedError(state.stopReason ?? 'bus halted');
      }
      if ((await this.inbox(agent)).length > 0) {
        return 'message';
      }
      if (Date.now() >= deadline) {
        break;
      }
      await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return 'timeout';
  }

  async claim(input: ClaimInput): Promise<Claim[]> {
    this.assertAgent(input.agent, 'agent');
    const requested = input.paths.map((item) => this.normalizeClaimPath(item));
    if (requested.length === 0) {
      throw new Error('At least one claim path is required.');
    }

    return this.withLock(async () => {
      const state = await this.loadStateUnsafe();
      for (const [other, claims] of Object.entries(state.claims)) {
        if (other === input.agent) {
          continue;
        }
        for (const requestedPath of requested) {
          const conflict = claims.find((claim) => this.pathsOverlap(requestedPath, claim.path));
          if (conflict) {
            throw new ClaimConflictError(other, conflict);
          }
        }
      }

      const held = [...(state.claims[input.agent] ?? [])];
      const timestamp = nowIso();
      for (const requestedPath of requested) {
        if (held.some((claim) => this.pathContains(claim.path, requestedPath))) {
          continue;
        }
        for (let index = held.length - 1; index >= 0; index -= 1) {
          if (this.pathContains(requestedPath, held[index].path)) {
            held.splice(index, 1);
          }
        }
        held.push({ path: requestedPath, why: input.why?.trim() || '', at: timestamp });
      }
      held.sort((left, right) => left.path.localeCompare(right.path));
      state.claims[input.agent] = held;
      state.agents = this.uniqueAgents([...state.agents, input.agent]);
      await this.writeStateUnsafe(state);
      await this.appendLineUnsafe(
        `\n- **claim** \`${input.agent}\` -> ${requested.join(', ')} (${input.why?.trim() || ''})\n`
      );
      return held;
    });
  }

  async release(agent: string, paths?: string[]): Promise<Claim[]> {
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
      const heldPaths = new Set(held.map((claim) => claim.path));
      const missing = requested.filter((item) => !heldPaths.has(item));
      if (missing.length > 0) {
        throw new Error(`${agent} does not hold exact claim(s): ${missing.join(', ')}`);
      }
      const released = new Set(requested);
      const remaining = held.filter((claim) => !released.has(claim.path));
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

  async halt(reason: string): Promise<MailboxState> {
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
      unread[agent] = messages.filter((message) => message.to === agent && !message.read).length;
    }
    return { ...state, unread, workspaceCommit };
  }

  async claims(): Promise<Record<string, Claim[]>> {
    return (await this.loadState()).claims;
  }

  async doctor(): Promise<DoctorReport> {
    return this.withLock(async () => {
      const problems: string[] = [];
      const warnings: string[] = [];
      let state: MailboxState | undefined;
      let messages: BusMessage[] = [];

      try {
        state = await this.loadState();
        if (state.schema !== SCHEMA) {
          problems.push(`state schema is ${state.schema}; expected ${SCHEMA}`);
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
        for (let leftIndex = 0; leftIndex < owners.length; leftIndex += 1) {
          const [leftOwner, leftClaims] = owners[leftIndex];
          for (let rightIndex = leftIndex + 1; rightIndex < owners.length; rightIndex += 1) {
            const [rightOwner, rightClaims] = owners[rightIndex];
            for (const leftClaim of leftClaims) {
              for (const rightClaim of rightClaims) {
                if (this.pathsOverlap(leftClaim.path, rightClaim.path)) {
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
      const temporaryFiles = mailboxNames.filter((name) => name.endsWith('.tmp'));
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
          unread: messages.filter((message) => !message.read).length,
          claims: state
            ? Object.values(state.claims).reduce((total, claims) => total + claims.length, 0)
            : 0,
          temporaryFiles: temporaryFiles.length
        }
      };
    });
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
      claims: {}
    };
  }

  private async loadState(): Promise<MailboxState> {
    if (!(await this.exists(this.paths.statePath))) {
      return this.defaultState();
    }
    return this.readJson<MailboxState>(this.paths.statePath);
  }

  private async loadStateUnsafe(): Promise<MailboxState> {
    await fs.mkdir(this.paths.inboxDir, { recursive: true });
    const state = await this.loadState();
    if (state.schema !== SCHEMA) {
      throw new Error(`Unsupported mailbox schema ${state.schema}. Expected ${SCHEMA}.`);
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

  private async gitStamp(): Promise<CommitStamp | undefined> {
    try {
      const [{ stdout: sha }, { stdout: dirty }] = await Promise.all([
        execFileAsync('git', ['-C', this.paths.root, 'rev-parse', 'HEAD']),
        execFileAsync('git', ['-C', this.paths.root, 'status', '--porcelain'])
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

  private pathContains(parent: string, child: string) {
    const left = this.comparablePath(parent);
    const right = this.comparablePath(child);
    return left === right || left === '.' || right.startsWith(`${left}/`);
  }

  private pathsOverlap(left: string, right: string) {
    return this.pathContains(left, right) || this.pathContains(right, left);
  }

  private uniqueAgents(agents: string[]) {
    return Array.from(new Set(agents.map((agent) => agent.trim()).filter(Boolean))).sort();
  }

  private assertAgent(agent: string, label: string) {
    if (!agent || !/^[a-zA-Z0-9_.-]+$/.test(agent)) {
      throw new Error(`Invalid ${label}: ${agent || '<empty>'}`);
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.paths.mailboxDir, { recursive: true });
    const started = Date.now();
    const lockId = randomUUID();
    let handle: fs.FileHandle | undefined;
    while (!handle) {
      try {
        handle = await fs.open(this.paths.lockPath, 'wx');
        await handle.writeFile(`${JSON.stringify({ id: lockId, pid: process.pid, at: nowIso() })}\n`, 'utf8');
      } catch (error) {
        if (!['EEXIST', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '')) {
          throw error;
        }
        try {
          const stat = await fs.stat(this.paths.lockPath);
          if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
            await fs.rm(this.paths.lockPath, { force: true });
            continue;
          }
        } catch (statError) {
          if (errorCode(statError) !== 'ENOENT') {
            throw statError;
          }
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for mailbox lock: ${this.paths.lockPath}`);
        }
        await delay(25);
      }
    }

    try {
      return await action();
    } finally {
      await handle.close();
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

  private async atomicJson(filePath: string, value: unknown) {
    await this.atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async atomicWrite(filePath: string, content: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true });
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
        from: stringArg(args, 'from', true),
        to: stringArg(args, 'to', true),
        kind: stringArg(args, 'kind') || 'note',
        subject: stringArg(args, 'subject', true),
        body
      });
      console.log(json ? JSON.stringify(message, null, 2) : `sent #${message.seq} [round ${message.round}]`);
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
      console.log('message waiting');
      return 0;
    }
    case 'claim': {
      const claims = await store.claim({
        agent: stringArg(args, 'agent', true),
        paths: listArg(args, 'paths'),
        why: stringArg(args, 'why')
      });
      console.log(json ? JSON.stringify(claims, null, 2) : `holds: ${claims.map((claim) => claim.path).join(', ')}`);
      return 0;
    }
    case 'release': {
      const paths = listArg(args, 'paths');
      const claims = await store.release(stringArg(args, 'agent', true), paths.length > 0 ? paths : undefined);
      console.log(json ? JSON.stringify(claims, null, 2) : `remaining: ${claims.map((claim) => claim.path).join(', ') || 'none'}`);
      return 0;
    }
    case 'claims': {
      const claims = await store.claims();
      console.log(JSON.stringify(claims, null, 2));
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
    case 'halt': {
      const state = await store.halt(stringArg(args, 'reason', true));
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
        'usage: mailbox <init|send|inbox|read|wait|claim|release|claims|status|doctor|halt|resume> [options]'
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
