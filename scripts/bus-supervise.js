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
  for (const seat of seats) {
    const running = live.get(seat);
    if (running) {
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
  syncStaleCodeNotices
};
