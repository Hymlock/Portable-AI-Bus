/**
 * Durable stall counters: a stall is a timer with a duration and an outcome.
 *
 * Measured 2026-08-14: 37 `provider-stalled` events, 33 self-recovered (89%). The defect is
 * not that stalls fire — it is that at the moment one is logged, the 33 that will clear look
 * identical to the 4 that never will. A one-shot edge cannot carry that distinction.
 *
 * This ledger stores the pair:
 *   stall-start        the timer fired; a record is OPEN
 *   stall-resolution   the call ended; the record has a duration and an outcome
 *
 * An unresolved stall is therefore countable, including after a process restart. In-memory
 * maps reset to zero on wake; this file does not. That is the property item 5 exists for.
 *
 * This is not a cause classifier. Slow is a timer. Spent is a fallthrough across the
 * provider chain. The ledger never writes `chain-exhausted` and never infers quota,
 * prompt size, or transport from a duration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type StallSource = 'runner' | 'process-host';

/** How a started stall ended. Absent while the stall is still open. */
export type StallOutcome = 'returned' | 'threw' | 'timed-out' | 'exited' | 'abandoned';

export type OpenStall = {
  id: string;
  seat: string;
  source: StallSource;
  startedAt: string;
  startedAtMs: number;
  thresholdMs: number;
  wakeReason?: string;
  messages?: number;
};

export type ResolvedStall = OpenStall & {
  resolvedAt: string;
  durationMs: number;
  outcome: StallOutcome;
};

export type StallLedgerSnapshot = {
  version: 1;
  seat: string;
  started: number;
  resolved: number;
  open: OpenStall[];
  recent: ResolvedStall[];
};

export type StallStartInput = {
  seat: string;
  source: StallSource;
  thresholdMs: number;
  wakeReason?: string;
  messages?: number;
};

export type StallLedger = {
  /** Present when this handle persists. A spawn watchdog in another process needs the path. */
  filePath?: string;
  start(input: StallStartInput): OpenStall;
  resolve(id: string, outcome: StallOutcome, durationMs?: number, nowMs?: number): ResolvedStall | undefined;
  snapshot(): StallLedgerSnapshot;
};

export type StallLedgerOptions = {
  seat: string;
  /** When set, every mutation is written here so a restart sees the same open stalls. */
  filePath?: string;
  now?: () => number;
  randomId?: () => string;
};

const RECENT_LIMIT = 32;

export function createStallLedger(options: StallLedgerOptions): StallLedger {
  const now = options.now ?? Date.now;
  const randomId = options.randomId ?? randomUUID;
  const state = options.filePath
    ? loadOrReset(options.filePath, options.seat)
    : emptySnapshot(options.seat);

  const persist = () => {
    if (!options.filePath) return;
    writeSnapshot(options.filePath, state);
  };

  // A file that does not exist yet is not a zeroed counter — it is an absent record.
  // Creating the empty snapshot up front means a restart can read started=0 / open=[]
  // from disk instead of inferring it from ENOENT.
  if (options.filePath && !fs.existsSync(options.filePath)) persist();

  // Disk is the source of truth when a path is set. Reloading before each mutation lets
  // the runner and the process host share one file without one instance silently
  // overwriting the other's open set — two in-memory copies would reset counters on
  // the next write, which is the wake-boundary bug item 5 is removing.
  const refresh = () => {
    if (!options.filePath) return;
    replaceSnapshot(state, loadOrReset(options.filePath, options.seat));
  };

  return {
    filePath: options.filePath,
    start(input: StallStartInput): OpenStall {
      refresh();
      if (input.seat !== state.seat) {
        throw new Error(`stall ledger seat mismatch: ledger=${state.seat} start=${input.seat}`);
      }
      if (!Number.isFinite(input.thresholdMs) || input.thresholdMs < 0) {
        throw new Error('thresholdMs must be a non-negative number');
      }
      const startedAtMs = now();
      const record: OpenStall = {
        id: randomId(),
        seat: input.seat,
        source: input.source,
        startedAt: new Date(startedAtMs).toISOString(),
        startedAtMs,
        thresholdMs: input.thresholdMs,
        ...(input.wakeReason !== undefined ? { wakeReason: input.wakeReason } : {}),
        ...(input.messages !== undefined ? { messages: input.messages } : {})
      };
      state.open.push(record);
      state.started += 1;
      persist();
      return { ...record };
    },

    resolve(id: string, outcome: StallOutcome, durationMs?: number, nowMs?: number): ResolvedStall | undefined {
      refresh();
      const index = state.open.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const [open] = state.open.splice(index, 1);
      const resolvedAtMs = nowMs ?? now();
      const resolved: ResolvedStall = {
        ...open,
        resolvedAt: new Date(resolvedAtMs).toISOString(),
        durationMs: durationMs ?? Math.max(0, resolvedAtMs - open.startedAtMs),
        outcome
      };
      state.resolved += 1;
      state.recent.push(resolved);
      if (state.recent.length > RECENT_LIMIT) {
        state.recent.splice(0, state.recent.length - RECENT_LIMIT);
      }
      persist();
      return { ...resolved };
    },

    snapshot(): StallLedgerSnapshot {
      refresh();
      return cloneSnapshot(state);
    }
  };
}

export function stallLedgerPath(root: string, seat: string): string {
  return path.join(root, '.ai-bus', 'runtime', 'stalls', `${seat}.json`);
}

function emptySnapshot(seat: string): StallLedgerSnapshot {
  return { version: 1, seat, started: 0, resolved: 0, open: [], recent: [] };
}

function cloneSnapshot(state: StallLedgerSnapshot): StallLedgerSnapshot {
  return {
    version: 1,
    seat: state.seat,
    started: state.started,
    resolved: state.resolved,
    open: state.open.map((item) => ({ ...item })),
    recent: state.recent.map((item) => ({ ...item }))
  };
}

function replaceSnapshot(target: StallLedgerSnapshot, source: StallLedgerSnapshot): void {
  target.version = 1;
  target.seat = source.seat;
  target.started = source.started;
  target.resolved = source.resolved;
  target.open = source.open;
  target.recent = source.recent;
}

function loadOrReset(filePath: string, seat: string): StallLedgerSnapshot {
  if (!fs.existsSync(filePath)) return emptySnapshot(seat);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StallLedgerSnapshot>;
    if (parsed.version !== 1 || parsed.seat !== seat || !Array.isArray(parsed.open)) {
      throw new Error('stall ledger shape is not version 1');
    }
    return {
      version: 1,
      seat,
      started: asCount(parsed.started),
      resolved: asCount(parsed.resolved),
      open: parsed.open.map(cloneOpen),
      recent: Array.isArray(parsed.recent) ? parsed.recent.map(cloneResolved) : []
    };
  } catch (error) {
    // Keep the unreadable bytes so a restart cannot silently zero the counters. The next
    // start() writes a fresh file; the previous record remains next to it.
    try { fs.renameSync(filePath, `${filePath}.corrupt`); } catch { /* keep going */ }
    return emptySnapshot(seat);
  }
}

function writeSnapshot(filePath: string, state: StallLedgerSnapshot): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cloneSnapshot(state), null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(temporary, filePath);
  } catch {
    fs.copyFileSync(temporary, filePath);
    try { fs.unlinkSync(temporary); } catch { /* leftover tmp is harmless */ }
  }
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function cloneOpen(value: OpenStall): OpenStall {
  if (!value || typeof value !== 'object') throw new Error('open stall is malformed');
  if (typeof value.id !== 'string' || !value.id) throw new Error('open stall id is missing');
  if (typeof value.seat !== 'string' || !value.seat) throw new Error('open stall seat is missing');
  if (value.source !== 'runner' && value.source !== 'process-host') {
    throw new Error('open stall source is not a known layer');
  }
  if (!Number.isFinite(value.startedAtMs) || !Number.isFinite(value.thresholdMs)) {
    throw new Error('open stall timestamps are not numbers');
  }
  return { ...value };
}

function cloneResolved(value: ResolvedStall): ResolvedStall {
  const open = cloneOpen(value);
  if (typeof value.resolvedAt !== 'string' || !Number.isFinite(value.durationMs)) {
    throw new Error('resolved stall is malformed');
  }
  if (
    value.outcome !== 'returned' &&
    value.outcome !== 'threw' &&
    value.outcome !== 'timed-out' &&
    value.outcome !== 'exited' &&
    value.outcome !== 'abandoned'
  ) {
    throw new Error('resolved stall outcome is not a known result');
  }
  return { ...open, resolvedAt: value.resolvedAt, durationMs: value.durationMs, outcome: value.outcome };
}
