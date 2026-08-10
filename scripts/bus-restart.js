#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listNodeProcesses, processesForRoot, samePath, stopExactProcesses } = require('./bus-processes');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

async function main() {
  const repo = path.resolve(__dirname, '..');
  const root = path.resolve(option('--root', process.cwd()));
  const workdir = path.resolve(option('--workdir', root));
  const consoleSeat = option('--console', 'codex');
  const brains = option('--brains', 'claude,codex,grok').split(',').map((item) => item.trim()).filter(Boolean);
  const brainFile = path.resolve(option('--brain', path.join(repo, 'brains', 'agent-seat.js')));
  const leaseTimeoutMs = Math.max(1, Number(option('--lease-timeout-s', '120'))) * 1000;
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--root is not a directory: ${root}`);
  if (!fs.statSync(workdir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--workdir is not a directory: ${workdir}`);

  const exact = processesForRoot(listNodeProcesses(), root);
  const owned = exact.filter((item) => item.type === 'harness' || item.type === 'brain');
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
  const missing = brains.filter((seat) => !after.some(
    (item) => item.type === 'brain' && item.seat === seat && samePath(item.workdir, workdir) && samePath(item.brain, brainFile)
  ));
  if (harnesses.length !== 1 || missing.length) {
    throw new Error(`Restart verification failed: harnesses=${harnesses.length}; missing brains=${missing.join(',') || 'none'}`);
  }
  process.stdout.write(`restart      verified exact root/workdir; harness ${harnesses[0].pid}; brains ${brains.join(',')}\n`);

  const endpointPath = path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json');
  const leasesPath = path.join(root, '.ai-bus', 'runtime', 'harness', 'leases.json');
  const deadline = Date.now() + leaseTimeoutMs;
  let missingLeases = [...brains];
  while (Date.now() < deadline) {
    const endpoint = JSON.parse(fs.readFileSync(endpointPath, 'utf8'));
    const state = JSON.parse(fs.readFileSync(leasesPath, 'utf8'));
    const now = Date.now();
    missingLeases = brains.filter((seat) => !(state.leases || []).some((lease) => {
      const lastSeen = Date.parse(lease.lastHeartbeatAt || lease.lastWakeAt || lease.firstSeenAt || '');
      return lease.seat === seat && lease.instanceId === endpoint.instanceId && Number.isFinite(lastSeen) && now - lastSeen < 60_000;
    }));
    if (missingLeases.length === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  if (missingLeases.length) throw new Error(`Fresh lease verification timed out for: ${missingLeases.join(', ')}`);
  process.stdout.write(`leases       fresh and instance-bound: ${brains.join(',')}\n`);
}

main().catch((error) => {
  process.stderr.write(`bus-restart FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
