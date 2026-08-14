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
 * It gives up after `--max-restarts` per seat (default 5). A brain that dies immediately and
 * repeatedly has a real problem, and an infinite restart loop turns that into a token fire while
 * looking, from outside, exactly like a healthy bus.
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
const stamp = () => new Date().toISOString().slice(11, 19);

/** Seats with the exact live brain process this supervisor owns. */
function liveSeats() {
  try {
    return new Set(processesForRoot(listNodeProcesses(), root)
      .filter((item) => item.type === 'brain'
        && samePath(item.workdir, workdir)
        && samePath(item.brain, brainFile))
      .map((item) => item.seat)
      .filter(Boolean));
  } catch {
    // Fail CLOSED: an unreadable process list must not be read as "everything died", or the
    // supervisor becomes the outage it exists to prevent.
    console.log(`tick ${stamp()} process list unreadable - assuming all seats live`);
    return new Set(seats);
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
  const live = liveSeats();
  for (const seat of seats) {
    if (live.has(seat)) continue;
    const count = restarts.get(seat) ?? 0;
    if (count >= maxRestarts) {
      // Said once per sweep on purpose. A seat that cannot stay up is a problem for a human,
      // and the supervisor must not quietly paper over it.
      console.log(`tick ${stamp()} ${seat} DEAD and past ${maxRestarts} restarts - NOT restarting. Needs a human.`);
      continue;
    }
    const pid = startBrain(seat);
    restarts.set(seat, count + 1);
    console.log(`tick ${stamp()} ${seat} was dead - restarted pid ${pid} (${count + 1}/${maxRestarts})`);
  }
}

console.log(`supervising ${seats.join(', ')} every ${intervalMs / 1000}s (max ${maxRestarts} restarts each)`);
console.log(`root ${root}`);
console.log(`workdir ${workdir}`);
sweep();
setInterval(sweep, intervalMs);
