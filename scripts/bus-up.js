#!/usr/bin/env node
/**
 * `bus-up` — one command that brings the whole bus into a working state.
 *
 *   node scripts/bus-up.js --root "<bus root>" [--console <seat>] [--brains a,b,c]
 *
 * What it does, in order, and each step is idempotent so it is safe to re-run:
 *
 *   1. start the harness if it is not already serving
 *   2. register every seat that does not exist yet
 *   3. give the baton to the console seat ONLY IF nobody is holding it, or the holder has
 *      gone stale - never take it from an agent that is actively working
 *   4. start a detached brain for each working seat, skipping any that already has one
 *   5. print the truth: who is attended, who holds the baton, what the goal is
 *
 * Written because "initiate the bus" was five commands nobody could remember in order, and a
 * half-initiated bus looks identical to a working one until something needs to move.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const root = option('--root', path.resolve(REPO, '..', 'ai-bus'));
const consoleSeat = option('--console', 'claude');
const brainSeats = option('--brains', '').split(',').map((s) => s.trim()).filter(Boolean);
const allSeats = [...new Set([consoleSeat, ...brainSeats])];

const log = (line) => console.log(line);

/**
 * Start a long-lived background process with no visible window, which outlives this script.
 *
 * `detached: true` + `windowsHide: true` + stdio to a file is the combination that satisfies
 * both halves, and it is measured rather than assumed — a probe launched sleepers under each
 * variant, then checked from a SEPARATE shell:
 *
 *   detached + windowsHide   no window, survived the launching shell   <- this
 *   windowsHide alone        no window, DIED with the launching shell (job object)
 *   Start-Process -Hidden    SURVIVED, but opened a Windows Terminal window every time
 *
 * The middle row is why detaching is not optional: the shell that runs this script belongs to
 * a job object that kills its tree on exit, so a merely-hidden child dies seconds after start
 * while the log still reads "started".
 *
 * The last row is a real dead end, not a tuning problem. A console application started by
 * `Start-Process -WindowStyle Hidden` still gets a console, and under Windows 11 that console
 * is handed to Windows Terminal — a separate process whose window the flag cannot reach.
 * Terminal then keeps the window after the shell exits, so they accumulate.
 */
function launchHidden(exe, args, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(exe, args, { detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  return child.pid ?? null;
}

// --- 1. harness -----------------------------------------------------------------

function harnessAlive() {
  const endpoint = path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json');
  if (!fs.existsSync(endpoint)) return false;
  try {
    const { pid } = JSON.parse(fs.readFileSync(endpoint, 'utf8'));
    // The endpoint file OUTLIVES the process - a power cut leaves it pointing at a dead port,
    // and trusting it cost this project a stall. Check the pid, not the file.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

if (harnessAlive()) {
  log('harness      already serving');
} else {
  launchHidden(
    process.execPath,
    [path.join(DIST, 'harness.js'), 'serve', '--root', root, '--port', '0'],
    path.join(root, '.ai-bus', 'runtime', 'harness-serve.log')
  );
  const deadline = Date.now() + 15000;
  while (!harnessAlive() && Date.now() < deadline) {
    // This is synchronous startup code, but sleeping must not mean spawning up to fifty Node
    // console processes. Those short-lived children were a separate source of Windows flashes.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  }
  log(harnessAlive() ? 'harness      started' : 'harness      FAILED to start');
}

// --- 2..3. seats and baton ------------------------------------------------------

function mailbox(args) {
  const result = spawnSync(process.execPath, [path.join(DIST, 'mailbox.js'), ...args, '--root', root], {
    encoding: 'utf8', windowsHide: true
  });
  return (result.stdout || '') + (result.stderr || '');
}

mailbox(['init', '--agents', allSeats.join(','), '--max-rounds', '550']);
log(`seats        ${allSeats.join(', ')}`);

const statusRaw = mailbox(['status', '--json']);
let state = {};
try {
  state = JSON.parse(statusRaw.slice(statusRaw.indexOf('{')));
} catch {
  // status printing changes shape between versions; the baton step degrades rather than dies
}

const holder = state?.baton?.holder ?? null;
const heldSeconds = state?.baton?.since ? (Date.now() - Date.parse(state.baton.since)) / 1000 : Infinity;

if (!holder) {
  mailbox(['send', '--from', consoleSeat, '--to', consoleSeat, '--kind', 'note',
           '--subject', 'bus-up: taking the baton', '--body', 'no holder', '--keep-baton']);
  log(`baton        taken by ${consoleSeat} (was unheld)`);
} else if (holder === consoleSeat) {
  log(`baton        already ${consoleSeat}`);
} else if (heldSeconds > 900) {
  log(`baton        ${holder} has held it ${Math.round(heldSeconds)}s - stale, reassigning`);
  mailbox(['stall-check']);
  log(`             run: node dist/mailbox.js reassign --to ${consoleSeat} --force --root "${root}"`);
} else {
  // The rule Hymlock asked for: do not take it if someone else is genuinely using it.
  log(`baton        held by ${holder} (${Math.round(heldSeconds)}s) - LEAVING IT. Another agent is working.`);
}

// --- 4. brains ------------------------------------------------------------------

/**
 * Is a brain for this seat already running?
 *
 * Matched with a regex that accepts EITHER path separator. The first version tested
 * `-like '*brain/cli*'` against a Windows command line that reads `dist\brain\cli.js`, so it
 * never matched — every run of this script started ANOTHER brain for a seat that already had
 * one, silently.
 *
 * That single wrong slash produced most of one evening's damage. Duplicate brains fight over
 * the seat lease: one wins, the loser gets 409 lease_held on every listen, and a failing listen
 * churns. It is invisible in the log, because each brain's own log looks like a healthy seat.
 *
 * Fails CLOSED on any error: an unreadable process list returns "already running", so the
 * failure mode is a brain that does not start rather than an unbounded pile of them.
 */
function brainRunning(seat) {
  if (process.platform !== 'win32') return false;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'brain[\\\\/]cli\\.js' -and $_.CommandLine -match '--seat ${seat}(\\s|$)' } | Measure-Object).Count`
  ], { encoding: 'utf8', windowsHide: true });
  if (out.status !== 0) {
    log(`brain:${seat.padEnd(7)} could not check for a running brain - assuming one exists`);
    return true;
  }
  return Number((out.stdout || '0').trim()) > 0;
}

for (const seat of brainSeats) {
  if (brainRunning(seat)) {
    log(`brain:${seat.padEnd(7)} already running`);
    continue;
  }
  const logFile = path.join(root, '.ai-bus', 'runtime', `brain-${seat}.log`);
  const pid = launchHidden(process.execPath, [
    path.join(DIST, 'brain', 'cli.js'),
    '--root', root, '--seat', seat,
    '--brain', path.join(REPO, 'brains', 'ensouled-seat.js')
  ], logFile);
  log(`brain:${seat.padEnd(7)} started pid ${pid ?? '?'} -> ${logFile}`);
}

// --- 5. the truth ---------------------------------------------------------------

setTimeout(() => {
  log('');
  log(mailbox(['status']).trim());
  const leases = path.join(root, '.ai-bus', 'runtime', 'harness', 'leases.json');
  if (fs.existsSync(leases)) {
    const parsed = JSON.parse(fs.readFileSync(leases, 'utf8'));
    const now = Date.now();
    log('');
    log('attended seats:');
    for (const lease of parsed.leases ?? []) {
      log(`  ${lease.seat.padEnd(8)} ${Math.round((now - Date.parse(lease.lastHeartbeatAt)) / 1000)}s ago`);
    }
    if (!(parsed.leases ?? []).length) log('  NONE - nobody is listening');
  }
}, 3000);
