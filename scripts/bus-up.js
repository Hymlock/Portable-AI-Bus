#!/usr/bin/env node
/**
 * `bus-up` — one command that brings the whole bus into a working state.
 *
 *   node scripts/bus-up.js --root "<bus root>" [--workdir "<repo>"] [--console <seat>] [--brains a,b,c]
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
const {
  bootstrapCoordinationRoot,
  listNodeProcesses,
  processesForRoot,
  samePath
} = require('./bus-processes');

const REPO = path.resolve(__dirname, '..');
const DIST = fs.existsSync(path.join(REPO, 'dist', 'harness.js'))
  ? path.join(REPO, 'dist')
  : path.join(REPO, 'bin');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const defaultRoot = path.basename(REPO) === '.ai-bus' ? path.dirname(REPO) : process.cwd();
const root = path.resolve(option('--root', defaultRoot));
const workdir = path.resolve(option('--workdir', root));
const consoleSeat = option('--console', 'codex');
const brainSeats = option('--brains', 'claude,codex,grok').split(',').map((s) => s.trim()).filter(Boolean);
const brainFile = path.resolve(option('--brain', path.join(REPO, 'brains', 'agent-seat.js')));
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

function mailbox(args) {
  const result = spawnSync(process.execPath, [path.join(DIST, 'mailbox.js'), ...args, '--root', root], {
    encoding: 'utf8', windowsHide: true
  });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `mailbox exited ${result.status}`).trim());
  return (result.stdout || '') + (result.stderr || '');
}

// --- 1. runtime kit and seats ----------------------------------------------------

const stagedRepo = path.basename(REPO).toLowerCase() === '.ai-bus';
const created = stagedRepo ? [] : bootstrapCoordinationRoot(REPO, root);
if (created.length) log(`bootstrap    installed ${created.length} missing coordination asset(s)`);
mailbox(['init', '--agents', allSeats.join(','), '--max-rounds', '550']);
log(`seats        ${allSeats.join(', ')}`);
log(`workdir      ${workdir}`);

// --- 2. harness -----------------------------------------------------------------

function harnessAlive() {
  const endpoint = path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json');
  if (!fs.existsSync(endpoint)) return false;
  let pid;
  try {
    ({ pid } = JSON.parse(fs.readFileSync(endpoint, 'utf8')));
    // The endpoint file OUTLIVES the process - a power cut leaves it pointing at a dead port,
    // and trusting it cost this project a stall. Check the pid, not the file.
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // Process enumeration failure is not evidence that the endpoint owner is dead. Fail closed;
  // otherwise an access-denied query makes ensure-up launch a competing harness.
  const processInfo = processesForRoot(listNodeProcesses(), root)
    .find((item) => item.type === 'harness' && item.pid === pid);
  if (!processInfo) return false;
  if (!samePath(processInfo.workdir, workdir)) {
    throw new Error(`Harness ${pid} uses --workdir ${processInfo.workdir}; requested ${workdir}. Run bus-restart.`);
  }
  return true;
}

if (harnessAlive()) {
  log('harness      already serving');
} else {
  launchHidden(
    process.execPath,
    [path.join(DIST, 'harness.js'), 'serve', '--root', root, '--workdir', workdir, '--port', '0'],
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

const harnessStatus = spawnSync(process.execPath, [
  path.join(DIST, 'worker-client.js'), 'status', '--root', root, '--seat', consoleSeat
], { encoding: 'utf8', windowsHide: true });
if (harnessStatus.status !== 0) {
  throw new Error(`Harness is not healthy: ${(harnessStatus.stderr || harnessStatus.stdout || 'status failed').trim()}`);
}

// --- 3. baton -------------------------------------------------------------------

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
  const matches = processesForRoot(listNodeProcesses(), root)
    .filter((item) => item.type === 'brain' && item.seat === seat);
  if (matches.length === 0) return false;
  const exact = matches.filter((item) => samePath(item.workdir, workdir) && samePath(item.brain, brainFile));
  if (exact.length === 1 && matches.length === 1) return true;
  throw new Error(
    `brain:${seat} has ${matches.length} process(es) for this root but not exactly one matching ` +
    `--workdir ${workdir} and --brain ${brainFile}. Run bus-restart.`
  );
}

for (const seat of brainSeats) {
  if (brainRunning(seat)) {
    log(`brain:${seat.padEnd(7)} already running`);
    continue;
  }
  const logFile = path.join(root, '.ai-bus', 'runtime', `brain-${seat}.log`);
  const pid = launchHidden(process.execPath, [
    path.join(DIST, 'brain', 'cli.js'),
    '--root', root, '--workdir', workdir, '--seat', seat,
    '--brain', brainFile
  ], logFile);
  log(`brain:${seat.padEnd(7)} started pid ${pid ?? '?'} -> ${logFile}`);
}

log('policy       brains remain active after each wake; clarification keeps the goal open');

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
