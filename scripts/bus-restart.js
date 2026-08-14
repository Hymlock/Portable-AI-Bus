#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listNodeProcesses, processesForRoot, samePath, stopExactProcesses } = require('./bus-processes');
const { staleCodeWarning } = require('./bus-supervise');

const REPO = path.resolve(__dirname, '..');
const DIST = fs.existsSync(path.join(REPO, 'dist', 'brain', 'cli.js'))
  ? path.join(REPO, 'dist')
  : path.join(REPO, 'bin');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

/**
 * A lease proves that a seat is currently between receiving and completing a wake, not that its
 * brain is alive. Verify the long-lived process and the code marker it writes after loading
 * instead, so a busy seat and a genuinely dead seat cannot be confused.
 */
function unreadyBrainCodeMarkers({ root, brains, processes, distRoot = DIST }) {
  return brains.filter((seat) => {
    const running = processes.find((item) => item.seat === seat);
    return !running || Boolean(staleCodeWarning({
      coordinationRoot: root,
      seat,
      pid: running.pid,
      distRoot
    }));
  });
}

async function main() {
  const repo = REPO;
  const root = path.resolve(option('--root', process.cwd()));
  const workdir = path.resolve(option('--workdir', root));
  // Same rule as bus-up: any funded vendor can pilot the chat interface, and the OTHER TWO spin
  // up as brains. Derived, not hardcoded - a fixed pair would only be right while one particular
  // seat happens to be piloting. bus-up enforces the ceiling; this must not disagree with it.
  const FUNDED_SEATS = ['claude', 'codex', 'grok'];
  const consoleSeat = option('--console', 'claude');
  const brains = option('--brains', FUNDED_SEATS.filter((seat) => seat !== consoleSeat).join(','))
    .split(',').map((item) => item.trim()).filter(Boolean);
  const brainFile = path.resolve(option('--brain', path.join(repo, 'brains', 'agent-seat.js')));
  const leaseTimeoutMs = Math.max(1, Number(option('--lease-timeout-s', '120'))) * 1000;
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--root is not a directory: ${root}`);
  if (!fs.statSync(workdir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--workdir is not a directory: ${workdir}`);

  const exact = processesForRoot(listNodeProcesses(), root);
  const owned = exact.filter((item) =>
    item.type === 'harness' || item.type === 'brain' || item.type === 'supervisor');
  process.stdout.write(`stopping     ${owned.length} exact-root process(es): ${owned.map((item) => item.pid).join(', ') || 'none'}\n`);
  await stopExactProcesses(owned);

  const result = spawnSync(process.execPath, [
    path.join(repo, 'scripts', 'bus-up.js'), '--root', root, '--workdir', workdir,
    '--console', consoleSeat, '--brains', brains.join(','), '--brain', brainFile
  ], { cwd: repo, encoding: 'utf8', windowsHide: true });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status !== 0) throw new Error(`bus-up failed with exit ${result.status}`);

  const after = processesForRoot(listNodeProcesses(), root);
  const harnesses = after.filter((item) => item.type === 'harness' && samePath(item.workdir, workdir));
  const supervisors = after.filter((item) => item.type === 'supervisor'
    && samePath(item.workdir, workdir)
    && samePath(item.brain, brainFile)
    && [...item.seats].sort().join(',') === [...brains].sort().join(','));
  const missing = brains.filter((seat) => !after.some(
    (item) => item.type === 'brain' && item.seat === seat && samePath(item.workdir, workdir) && samePath(item.brain, brainFile)
  ));
  if (harnesses.length !== 1 || supervisors.length !== 1 || missing.length) {
    throw new Error(
      `Restart verification failed: harnesses=${harnesses.length}; supervisors=${supervisors.length}; `
      + `missing brains=${missing.join(',') || 'none'}`
    );
  }
  process.stdout.write(
    `restart      verified exact root/workdir; harness ${harnesses[0].pid}; `
    + `supervisor ${supervisors[0].pid}; brains ${brains.join(',')}\n`
  );

  const deadline = Date.now() + leaseTimeoutMs;
  let unreadyBrains = [...brains];
  while (Date.now() < deadline) {
    const current = processesForRoot(listNodeProcesses(), root)
      .filter((item) => item.type === 'brain'
        && samePath(item.workdir, workdir)
        && samePath(item.brain, brainFile));
    unreadyBrains = unreadyBrainCodeMarkers({ root, brains, processes: current });
    if (unreadyBrains.length === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (unreadyBrains.length) {
    throw new Error(`Brain/code verification timed out for: ${unreadyBrains.join(', ')}`);
  }
  process.stdout.write(`brains       live with matching loaded-code markers: ${brains.join(',')}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`bus-restart FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { unreadyBrainCodeMarkers };
