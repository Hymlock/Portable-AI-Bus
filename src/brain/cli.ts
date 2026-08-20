/**
 * `brain` entry point — run a seat as a long-lived process.
 *
 *   node dist/brain/cli.js --root <bus root> --seat grok --brain ./my-brain.js
 *
 * The process stays up until it is signalled. It does not stop when the brain finishes a
 * report, which is the whole reason this exists (`docs/LOOP_ARCHITECTURE.md`).
 */

import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { Brain, BrainFactory } from './contract';
import { cliBusClient } from './bus-client';
import { MailboxStore } from '../mailbox';
import { runBrain } from './runner';
import { createStallLedger, stallLedgerPath } from './stall-ledger';

export type ExhaustionHandlerOptions = {
  seat: string;
  root: string;
  log?: (event: string, data?: unknown) => void;
};

/** `spent-seats.json` — the durable record that a seat cannot currently act. */
export function spentSeatNoticePath(root: string): string {
  return path.join(root, '.ai-bus', 'runtime', 'spent-seats.json');
}

export function readSpentSeatNotices(root: string): { seats: { seat: string; detail: string; since: string }[] } {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(spentSeatNoticePath(root), 'utf8'));
    return Array.isArray(parsed?.seats) ? parsed : { seats: [] };
  } catch {
    return { seats: [] };
  }
}

/**
 * Record or clear "this seat is out of providers" as SHARED state.
 *
 * Exhaustion used to exist only in the exhausted seat's own log. Nobody else could see it, so
 * on 2026-08-20 one seat spent an afternoon sending audit requests to a seat that had been out
 * of providers for hours, acking them and actioning none. The sender was never told, and the
 * human was never told; the work simply stopped while the bus looked busy.
 *
 * Written BEFORE any baton logic on purpose. The handoff path below returns early when this
 * seat is not the baton holder, which meant a non-holder's exhaustion was invisible - the
 * commonest case, since a seat that cannot think rarely holds the baton for long.
 */
export function recordSpentSeat(root: string, seat: string, detail: string | null,
                                now: () => string = () => new Date().toISOString()): void {
  try {
    const current = readSpentSeatNotices(root).seats.filter((item) => item.seat !== seat);
    const next = detail === null
      ? current
      : [...current, { seat, detail, since: now() }].sort((a, b) => a.seat.localeCompare(b.seat));
    const file = spentSeatNoticePath(root);
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, `${JSON.stringify({ seats: next }, null, 2)}\n`, 'utf8');
  } catch {
    // A notice is a convenience for humans and other seats. Failing to write one must never
    // take down the brain that is already having a bad day.
  }
}

/**
 * Build the whole-chain exhaustion handler once per brain process.
 *
 * The compare-and-move guard prevents a non-holder (or a stale status read) from stealing an
 * active baton. The cooldown prevents three exhausted seats from endlessly handing the same
 * baton around while allowing a later, genuinely separate exhaustion episode to recover.
 */
export function createExhaustionHandler(options: ExhaustionHandlerOptions) {
  const { seat, root, log = () => {} } = options;
  let lastHandoffAt = 0;
  const handoffCooldownMs = 5 * 60_000;
  return async ({ detail }: { seat: string; detail: string }) => {
    // Defense: a caller that still routes BROKEN through this handler must not
    // announce "out of providers". The runner should not invoke us for broken
    // wakes; if it does, refuse the spent-handoff and surface the error.
    if (/^(BROKEN\b|chain-broken\b)/i.test(detail.trim())) {
      log('chain-broken', { seat, error: detail });
      return;
    }
    // Record the fact FIRST, before any early return below can hide it.
    recordSpentSeat(root, seat, detail);
    log('spent-seat-recorded', { seat, detail });

    if (Date.now() - lastHandoffAt < handoffCooldownMs) {
      log('exhausted-handoff-suppressed', { seat, detail });
      return;
    }
    const mailbox = new MailboxStore(root);
    const state = await mailbox.status();
    if (state.baton?.holder !== seat) {
      log('exhausted-not-holder', { seat, holder: state.baton?.holder ?? null, detail });
      return;
    }
    // Hand off to a seat that can actually WORK, not merely to the next one in the list.
    //
    // The old selection was `ordered[(ownIndex + 1) % ordered.length]` - pure round-robin. With
    // two seats spent out of three that hands the baton to another seat which cannot act, and
    // the cooldown then suppresses the correction for five minutes. The baton keeps moving and
    // nothing keeps working, which looks healthier from the outside than a stall while being
    // exactly as stuck.
    //
    // spent-seats.json makes this answerable now: skip seats already recorded as spent.
    const ordered = state.agents;
    const ownIndex = ordered.indexOf(seat);
    const spentNow = new Set(readSpentSeatNotices(root).seats.map((item) => item.seat));
    const rotation = ordered
      .map((_, offset) => ordered[(ownIndex + 1 + offset) % ordered.length])
      .filter((candidate) => candidate !== seat);
    const successor = rotation.find((candidate) => !spentNow.has(candidate));

    if (!successor) {
      // Every other seat is spent, or there is no other seat. Handing the baton on would be
      // theatre. Say so once, loudly, and keep it: a held baton with a recorded reason is a
      // state a human can act on, whereas a baton circulating among seats that cannot think
      // is a stall wearing motion.
      const others = rotation.length;
      log('exhausted-no-usable-successor', {
        seat,
        detail,
        otherSeats: others,
        allSpent: others > 0,
        note: others === 0
          ? 'solo seat: nobody to hand to. Baton retained; top this seat up to resume.'
          : 'every other seat is out of providers. Baton retained; see spent-seats.json.'
      });
      return;
    }
    const result = await mailbox.reassignBaton({
      to: successor,
      reason: `${seat} exhausted every provider (${detail})`,
      expectedFrom: seat,
      force: true
    });
    if (!result.moved) {
      log('exhausted-handoff-refused', result);
      return;
    }
    lastHandoffAt = Date.now();
    log('baton-handed-off', result);
    await mailbox.send({
      from: seat,
      to: successor,
      kind: 'handoff',
      subject: `${seat} is out of providers - baton is yours`,
      body: `Every provider in my chain is spent: ${detail}\n\n` +
            'I am still listening and will pick work back up when credit returns. ' +
            'Taking the baton because a holder that cannot act is a stall.',
      keepBaton: false
    });
  };
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function integerOption(argv: string[], name: string, fallback: number): number {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Newest file timestamp is the version a long-lived brain actually loaded at startup. */
export async function latestTreeMtimeMs(directory: string): Promise<number> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  let latest = 0;
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await latestTreeMtimeMs(item));
    } else if (entry.isFile()) {
      const stat = await fs.stat(item).catch(() => undefined);
      latest = Math.max(latest, stat?.mtimeMs ?? 0);
    }
  }
  return latest;
}

export async function recordLoadedCode(root: string, seat: string, distRoot = path.resolve(__dirname, '..')) {
  const marker = {
    pid: process.pid,
    distRoot,
    loadedDistMtimeMs: await latestTreeMtimeMs(distRoot),
    recordedAt: new Date().toISOString()
  };
  const runtimeDir = path.join(root, '.ai-bus', 'runtime');
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, `brain-${seat}.code.json`), JSON.stringify(marker));
  return marker;
}

/** An echo brain: acknowledges every message and reports nothing else. */
export const echoBrain: BrainFactory = ({ seat }) => ({
  name: 'echo',
  async takeTurn(context) {
    // Echo-on-receipt is standing policy (OPERATOR.md). Doing it in the default brain means a
    // seat is never silent by accident, which is what made silence ambiguous before: working,
    // never delivered, and dead all looked identical from outside.
    for (const message of context.messages) {
      await context.tools.send({
        to: message.from,
        kind: 'ack',
        subject: `echo #${message.seq}: ${message.subject}`.slice(0, 200),
        body: `${seat} received #${message.seq}. No brain attached yet, so this is receipt only.`,
        keepBaton: true
      });
    }
    return { done: true, note: `echoed ${context.messages.length}` };
  }
});

export async function loadBrain(
  spec: string | undefined,
  seat: string,
  root: string,
  workdir: string
): Promise<Brain> {
  const log = (event: string, data?: unknown) => console.log(JSON.stringify({ event, ...(data as object) }));
  if (!spec || spec === 'echo') {
    return echoBrain({ seat, root, workdir, log }) as Brain;
  }
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
  // `require`, not `import()`. This file compiles to CommonJS and TypeScript downlevels a
  // dynamic import into require - so a file:// URL arrives at require() verbatim and fails
  // with "Cannot find module 'file://...'". The brain died on startup and the runner's log
  // was the only evidence, which is exactly why it writes one.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const loaded = require(resolved) as
    { default?: BrainFactory; createBrain?: BrainFactory } | BrainFactory;
  // A brain file may export a factory directly (module.exports = fn), as `default`, or as
  // `createBrain`. Accepting all three costs three lines and removes a class of "why is my
  // brain not loading" that the log alone would not explain.
  const factory = typeof loaded === 'function'
    ? loaded
    : (loaded.default ?? loaded.createBrain);
  if (typeof factory !== 'function') {
    throw new Error(`${spec} must export a default BrainFactory or a createBrain function`);
  }
  return factory({ seat, root, workdir, log });
}

export async function main(argv: string[]): Promise<number> {
  const root = option(argv, '--root');
  const seat = option(argv, '--seat');
  if (!root || !seat) {
    console.error('usage: brain --root PATH --seat AGENT [--workdir REPO] [--brain MODULE] [--budget N] [--listen-s N]');
    return 2;
  }

  const resolvedRoot = path.resolve(root);
  const workdir = path.resolve(option(argv, '--workdir') ?? resolvedRoot);
  const workdirStat = await fs.stat(workdir).catch(() => undefined);
  if (!workdirStat?.isDirectory()) {
    throw new Error(`--workdir must name an existing directory: ${workdir}`);
  }

  const log = (event: string, data?: unknown) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), seat, event, ...(data as object) }));

  const brain = await loadBrain(option(argv, '--brain'), seat, resolvedRoot, workdir);
  log('brain-loaded', { brain: brain.name, workdir });
  try {
    const marker = await recordLoadedCode(resolvedRoot, seat);
    log('code-version-recorded', marker);
  } catch (error) {
    // Detection failure is visible but does not take a working brain off the bus.
    log('code-version-marker-failed', { detail: (error as Error)?.message ?? String(error) });
  }

  const stopSignal = new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  // A brain that is starting has, by definition, not exhausted its chain yet. Clearing on
  // startup is what stops the notice going stale: a seat topped up and restarted would
  // otherwise stay marked spent forever, and a notice nobody can trust is worse than none -
  // readers learn to skip it, exactly like a denylist of generic phrases.
  recordSpentSeat(resolvedRoot, seat, null);
  const onExhausted = createExhaustionHandler({ seat, root: resolvedRoot, log });
  let stallLedger;
  try {
    stallLedger = createStallLedger({ seat, filePath: stallLedgerPath(resolvedRoot, seat) });
  } catch (error) {
    log('stall-ledger-unreadable', { seat, error: (error as Error)?.message ?? String(error) });
    stallLedger = createStallLedger({ seat });
  }

  const summary = await runBrain({
    seat,
    brain,
    bus: cliBusClient({ root: resolvedRoot, log }),
    // The endgame: this seat has spent every provider in its chain. It cannot think, so it
    // must not keep the baton - a holder that cannot act is the stall we spent this project
    // diagnosing. Hand off to any other registered seat and say why.
    onExhausted,
    stallLedger,
    budgetPerWake: integerOption(argv, '--budget', 30),
    listenSeconds: integerOption(argv, '--listen-s', 300),
    log,
    stopSignal
  });

  log('exit', summary);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(JSON.stringify({ event: 'fatal', message: (error as Error).message }));
      process.exitCode = 1;
    });
}
