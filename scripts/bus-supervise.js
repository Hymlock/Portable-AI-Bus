#!/usr/bin/env node
/**
 * Restart brains that die. The gap the architecture has admitted since day one.
 *
 *   node scripts/bus-supervise.js --root "<bus root>" [--workdir "<repo>"] [--seats a,b,c]
 *
 * ## Why
 *
 * `docs/LOOP_ARCHITECTURE.md`, under "Still owed": *"A crashed process is still a dead seat,
 * and the reachability gap stands: an agent that dies is unreachable by any route the bus
 * provides, because the route runs through the dead thing."*
 *
 * The runner survives a brain that throws. It cannot survive its own process being killed — and
 * when that happens nothing notices, because a dead seat and a quiet seat look identical from
 * the mailbox. This closes that specific hole and nothing more.
 *
 * ## What it will not do
 *
 * It does not restart a brain that is *failing* — only one that is **gone**. A seat whose model
 * is exhausted, whose plans are malformed, or which is merely idle is left alone; restarting it
 * would burn tokens and hide the fault. Liveness is the one condition a supervisor can judge
 * without guessing.
 *
 * It pauses after `--max-restarts` per seat (default 5) for one harness lease-stale interval,
 * then opens a fresh bounded burst. A brain that dies immediately and repeatedly has a real
 * problem, but permanent give-up is itself an unattended dead seat; the cooldown prevents both
 * a hot token-burning loop and permanent silence.
 *
 * ## Run it detached, not inside a job
 *
 * Restarted brains are spawned `detached` and unref'd, but Windows job objects kill the whole
 * tree regardless. Proved the hard way: supervising from inside a PowerShell `Start-Job`
 * correctly detected a dead seat and restarted it — then killed that restart when the job was
 * stopped, leaving the seat dead and the log reading "restarted pid 31768". A supervisor whose
 * own death takes its children with it is a supervisor that quietly does nothing.
 *
 *   ok    node scripts/bus-supervise.js --root … &        (a shell you leave running)
 *   ok    a service, scheduled task, or terminal of its own
 *   NOT   inside PowerShell Start-Job, or any harness that reaps its process tree
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { listNodeProcesses, processesForRoot, samePath } = require('./bus-processes');
const { DEFAULT_LEASE_STALE_MS } = require('../dist/harness');

const REPO = path.resolve(__dirname, '..');
const DIST = fs.existsSync(path.join(REPO, 'dist', 'brain', 'cli.js'))
  ? path.join(REPO, 'dist')
  : path.join(REPO, 'bin');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const root = path.resolve(option('--root', path.resolve(REPO, '..', 'ai-bus')));
const workdir = path.resolve(option('--workdir', root));
const seats = option('--seats', 'claude,codex,grok,worker').split(',').map((s) => s.trim()).filter(Boolean);
const intervalMs = Math.max(15, Number(option('--interval-s', '30'))) * 1000;
const maxRestarts = Number(option('--max-restarts', '5'));
const brainFile = path.resolve(option('--brain', path.join(REPO, 'brains', 'agent-seat.js')));

const restarts = new Map(seats.map((s) => [s, 0]));
const healthySince = new Map();
const budgetExhaustedAt = new Map();
const staleWarnings = new Map();
const stamp = () => new Date().toISOString().slice(11, 19);

function latestTreeMtimeMs(directory) {
  let latest = 0;
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) latest = Math.max(latest, latestTreeMtimeMs(item));
    else if (entry.isFile()) {
      try { latest = Math.max(latest, fs.statSync(item).mtimeMs); } catch { /* changed mid-sweep */ }
    }
  }
  return latest;
}

function staleCodeWarning({ coordinationRoot, seat, pid, distRoot = DIST }) {
  const markerFile = path.join(coordinationRoot, '.ai-bus', 'runtime', `brain-${seat}.code.json`);
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerFile, 'utf8')); } catch {
    return `${seat} stale-code: running brain has no readable loaded-code marker`;
  }
  if (marker.pid !== pid) {
    return `${seat} stale-code: loaded-code marker belongs to pid ${marker.pid ?? 'unknown'}, running pid is ${pid}`;
  }
  if (!samePath(marker.distRoot, distRoot)) {
    return `${seat} stale-code: loaded dist ${marker.distRoot ?? 'unknown'}, expected ${distRoot}`;
  }
  const currentDistMtimeMs = latestTreeMtimeMs(distRoot);
  if (!Number.isFinite(marker.loadedDistMtimeMs) || currentDistMtimeMs > marker.loadedDistMtimeMs) {
    return `${seat} stale-code: dist changed after pid ${pid} loaded it ` +
      `(loaded=${marker.loadedDistMtimeMs ?? 'unknown'}, current=${currentDistMtimeMs})`;
  }
  return undefined;
}

/**
 * Item 9: the detector already existed. Its only sink was bus-supervise.log, which nobody
 * reads. Persist the current stale set next to the other runtime signals so bus-tick (the
 * operator wake line) and anything else watching disk can see it.
 *
 * This is deliberately not a mailbox send. send() always moves or steals the baton except
 * on a delayed ack, and delayed acks are skipped by the runner. Mailing "you are stale"
 * would either look like progress (item 8) or seize leadership. A file plus the tick line
 * is the sink an operator actually receives.
 */
function staleCodeNoticePath(coordinationRoot) {
  return path.join(coordinationRoot, '.ai-bus', 'runtime', 'stale-code.json');
}

function emptyStaleCodeNotices() {
  return { version: 1, autoRestart: false, seats: [] };
}

function readStaleCodeNotices(coordinationRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(staleCodeNoticePath(coordinationRoot), 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.seats)) return emptyStaleCodeNotices();
    return {
      version: 1,
      autoRestart: false,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      seats: parsed.seats.filter((item) => item && typeof item.seat === 'string' && typeof item.warning === 'string')
    };
  } catch {
    return emptyStaleCodeNotices();
  }
}

function writeStaleCodeNotices(coordinationRoot, seats, now = () => new Date().toISOString()) {
  const file = staleCodeNoticePath(coordinationRoot);
  if (!Array.isArray(seats) || seats.length === 0) {
    try { fs.unlinkSync(file); } catch { /* absent is the green case */ }
    return undefined;
  }
  const snapshot = {
    version: 1,
    autoRestart: false,
    updatedAt: now(),
    seats: [...seats].sort((left, right) => left.seat.localeCompare(right.seat))
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

/**
 * ITEM 22: AN ABSENT SEAT IS NOT NOTICED.
 *
 * Measured 2026-08-19. grok's brain died on every wake for hours. This supervisor was running
 * the whole time and behaved exactly as designed: it restarted the seat, hit the restart
 * budget, and settled into cool-down-and-retry. Its only sink for that was `console.log`.
 *
 * Nobody was reading the console. The seat stayed absent, and the operator-visible signals -
 * mailbox state, baton, `status` - all looked normal, because a seat with no brain still has a
 * mailbox and can still hold the baton. The coordinator misdiagnosed it twice, first as "out
 * of credits" and then as "working", before running `bus-restart` by hand and being told
 * `missing brains=grok` in one line.
 *
 * This is item 9 again - a detector whose only sink is a log - in a path item 9 never covered.
 * The stale-code notice above is the shape the project already settled on for exactly this,
 * so a dead seat gets the same durable treatment rather than a second invented mechanism.
 *
 * The notice is written when the restart budget is EXHAUSTED, not on the first death: a seat
 * that dies once and comes back is the supervisor working, and crying about it is how a
 * signal becomes noise. It clears the moment the seat is live again, because a stale alarm
 * about a recovered seat is worse than none - it teaches people to ignore the file.
 */
/**
 * ITEM 25: only an OBSERVATION clears a liveness alarm. An assumption never does.
 *
 * Stated as a predicate rather than an inline `!running.assumedLive` so the rule is nameable
 * and testable, and so the next person adding a signal to this sweep has something to reuse
 * instead of re-deriving it. I derived it wrong once already.
 */
function clearsDeadSeatAlarm(running) {
  return Boolean(running) && running.assumedLive !== true;
}

function deadSeatNoticePath(coordinationRoot) {
  return path.join(coordinationRoot, '.ai-bus', 'runtime', 'dead-seats.json');
}

function readDeadSeatNotices(coordinationRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(deadSeatNoticePath(coordinationRoot), 'utf8'));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.seats)) return { version: 1, seats: [] };
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
      seats: parsed.seats.filter((item) => item && typeof item.seat === 'string')
    };
  } catch {
    return { version: 1, seats: [] };
  }
}

/**
 * `dead` is a Map of seat -> reason (or undefined to clear). Seats absent from the map keep
 * whatever was recorded, for the same reason syncStaleCodeNotices does: inventing a clear for
 * a seat nobody looked at hides a real condition.
 */
function syncDeadSeatNotices(coordinationRoot, dead, now = () => new Date().toISOString()) {
  const current = new Map(readDeadSeatNotices(coordinationRoot).seats.map((item) => [item.seat, item]));
  for (const [seat, reason] of dead) {
    if (reason) current.set(seat, { seat, reason, at: current.get(seat)?.at ?? now() });
    else current.delete(seat);
  }
  const file = deadSeatNoticePath(coordinationRoot);
  if (current.size === 0) {
    try { fs.unlinkSync(file); } catch { /* absent is the green case */ }
    return { version: 1, seats: [] };
  }
  const snapshot = {
    version: 1,
    updatedAt: now(),
    seats: [...current.values()].sort((left, right) => left.seat.localeCompare(right.seat))
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

/**
 * Merge just-checked seats into the durable notice. Seats we did not inspect (assumedLive)
 * keep whatever was already recorded; inventing a clear would hide a real stale condition.
 */
function syncStaleCodeNotices(coordinationRoot, checked, now = () => new Date().toISOString()) {
  const current = new Map(readStaleCodeNotices(coordinationRoot).seats.map((item) => [item.seat, item]));
  for (const [seat, warning] of checked) {
    if (warning) current.set(seat, { seat, warning, at: now() });
    else current.delete(seat);
  }
  return writeStaleCodeNotices(coordinationRoot, [...current.values()], now);
}

/** Seats with the exact live brain process this supervisor owns. */
function liveBrains() {
  try {
    return new Map(processesForRoot(listNodeProcesses(), root)
      .filter((item) => item.type === 'brain'
        && samePath(item.workdir, workdir)
        && samePath(item.brain, brainFile))
      .filter((item) => item.seat)
      .map((item) => [item.seat, item]));
  } catch {
    // Fail CLOSED: an unreadable process list must not be read as "everything died", or the
    // supervisor becomes the outage it exists to prevent.
    console.log(`tick ${stamp()} process list unreadable - assuming all seats live`);
    return new Map(seats.map((seat) => [seat, { seat, assumedLive: true }]));
  }
}

function startBrain(seat) {
  const logFile = path.join(root, '.ai-bus', 'runtime', `brain-${seat}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [
    path.join(DIST, 'brain', 'cli.js'),
    '--root', root, '--seat', seat, '--brain', brainFile, '--workdir', workdir
  ], { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  return child.pid ?? null;
}

function sweep() {
  const live = liveBrains();
  const checkedStale = new Map();
  // Item 22: what this sweep learned about ABSENCE, written durably at the end of the tick.
  const checkedDead = new Map();
  for (const seat of seats) {
    const running = live.get(seat);
    if (running) {
      /**
       * ITEM 25. This was `checkedDead.set(seat, undefined)` unconditionally, and grok found
       * it in r29(d): when the process list is unreadable, liveBrains() returns EVERY seat as
       * `{ assumedLive: true }` - deliberately failing CLOSED so the supervisor does not read
       * "I cannot see" as "everything died" and restart the world.
       *
       * My line then read that assumption as observation and CLEARED the durable alarm. So
       * restarts failed closed while the notice failed OPEN, in the same tick, on the same
       * data: a seat that really was dead had its DEAD-SEAT notice erased by a process list
       * the supervisor could not even read.
       *
       * The guard immediately below already does this correctly for stale-code, and I walked
       * straight past it. `assumedLive` means WE DO NOT KNOW, and "we do not know" must never
       * clear an alarm - it can only decline to raise one.
       */
      if (clearsDeadSeatAlarm(running)) checkedDead.set(seat, undefined);
      const firstHealthyAt = healthySince.get(seat) ?? Date.now();
      healthySince.set(seat, firstHealthyAt);
      if ((restarts.get(seat) ?? 0) > 0 && Date.now() - firstHealthyAt >= DEFAULT_LEASE_STALE_MS) {
        restarts.set(seat, 0);
        budgetExhaustedAt.delete(seat);
        console.log(`tick ${stamp()} ${seat} stayed live through one lease-stale window - restart budget reset.`);
      }
      if (!running.assumedLive) {
        const warning = staleCodeWarning({ coordinationRoot: root, seat, pid: running.pid });
        if (warning && staleWarnings.get(seat) !== warning) console.log(`tick ${stamp()} ${warning} - NOT restarting.`);
        if (warning) staleWarnings.set(seat, warning);
        else staleWarnings.delete(seat);
        checkedStale.set(seat, warning);
      }
      continue;
    }
    healthySince.delete(seat);
    // A dead seat is not running stale code; it is not running. Drop its notice so a corpse
    // cannot keep the operator-facing tick red after the process is gone.
    checkedStale.set(seat, undefined);
    const count = restarts.get(seat) ?? 0;
    if (count >= maxRestarts) {
      const exhaustedAt = budgetExhaustedAt.get(seat) ?? Date.now();
      budgetExhaustedAt.set(seat, exhaustedAt);
      if (Date.now() - exhaustedAt < DEFAULT_LEASE_STALE_MS) {
        console.log(`tick ${stamp()} ${seat} DEAD after ${maxRestarts} restarts - cooling down, then retrying.`);
        // Item 22: the durable sink. Until this, that console line was the ONLY record that a
        // seat was gone, and nobody was reading it.
        checkedDead.set(seat, `no brain process; ${maxRestarts} restarts failed, cooling down and retrying`);
        continue;
      }
      // Permanent give-up is another silent dead seat. Open a fresh bounded burst after one
      // harness lease-stale interval, avoiding both a hot restart loop and permanent deafness.
      restarts.set(seat, 0);
      budgetExhaustedAt.delete(seat);
      console.log(`tick ${stamp()} ${seat} restart cooldown elapsed - opening a fresh budget.`);
    }
    const pid = startBrain(seat);
    const nextCount = (restarts.get(seat) ?? 0) + 1;
    restarts.set(seat, nextCount);
    console.log(`tick ${stamp()} ${seat} was dead - restarted pid ${pid} (${nextCount}/${maxRestarts})`);
  }
  syncStaleCodeNotices(root, checkedStale);
  syncDeadSeatNotices(root, checkedDead);
}

if (require.main === module) {
  console.log(`supervising ${seats.join(', ')} every ${intervalMs / 1000}s (max ${maxRestarts} restarts each)`);
  console.log(`root ${root}`);
  console.log(`workdir ${workdir}`);
  sweep();
  setInterval(sweep, intervalMs);
}

module.exports = {
  latestTreeMtimeMs,
  staleCodeWarning,
  staleCodeNoticePath,
  readStaleCodeNotices,
  writeStaleCodeNotices,
  syncStaleCodeNotices,
  deadSeatNoticePath,
  readDeadSeatNotices,
  syncDeadSeatNotices,
  clearsDeadSeatAlarm
};
