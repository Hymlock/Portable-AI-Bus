const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function optionFromCommandLine(commandLine, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(commandLine || '').match(new RegExp(`(?:^|\\s)${escaped}\\s+(?:"([^"]*)"|(\\S+))`, 'i'));
  return match ? (match[1] ?? match[2]) : undefined;
}

function samePath(left, right) {
  if (!left || !right) return false;
  const normalize = (value) => {
    const resolved = path.resolve(value);
    const canonical = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved;
    const cleaned = canonical.replace(/[\\/]+$/, '').normalize('NFC');
    return process.platform === 'win32' ? cleaned.toLowerCase() : cleaned;
  };
  return normalize(left) === normalize(right);
}

function identifyNodeProcess(processInfo) {
  const commandLine = String(processInfo.commandLine || processInfo.CommandLine || '');
  const pid = Number(processInfo.pid ?? processInfo.ProcessId);
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  const root = optionFromCommandLine(commandLine, '--root');
  const workdir = optionFromCommandLine(commandLine, '--workdir') ?? root;
  if (/harness\.js(?:"|\s).*\bserve\b/i.test(commandLine)) {
    return { type: 'harness', pid, root, workdir, commandLine };
  }
  if (/brain[\\/]cli\.js(?:"|\s)/i.test(commandLine)) {
    return {
      type: 'brain', pid, root, workdir,
      seat: optionFromCommandLine(commandLine, '--seat'),
      brain: optionFromCommandLine(commandLine, '--brain'),
      commandLine
    };
  }
  if (/bus-supervise\.js(?:"|\s)/i.test(commandLine)) {
    return {
      type: 'supervisor', pid, root, workdir,
      seats: String(optionFromCommandLine(commandLine, '--seats') || '')
        .split(',').map((seat) => seat.trim()).filter(Boolean),
      brain: optionFromCommandLine(commandLine, '--brain'),
      commandLine
    };
  }
  return undefined;
}

/**
 * ITEM 28: the process query had NO TIMEOUT, on the operator wake path.
 *
 * `spawnSync` without `timeout` waits forever. `bus-tick` calls this every interval to fill
 * the `brains:` field, so a wedged `powershell` or `ps` does not degrade the heartbeat - it
 * STOPS it. The tick is the thing that wakes a human operator, so the failure mode is: the
 * bus goes quiet, and the silence looks exactly like a quiet bus.
 *
 * Measured on 2026-08-19, on the coordinator's own watchdog rather than in a test. A monitor
 * doing this same query every two minutes stalled mid-run: the process stayed alive, the loop
 * never advanced, and no heartbeat fired for the better part of an hour while work continued.
 * Hymlock noticed the silence before I did, which is the whole problem with a stalled watchdog.
 *
 * It is also the same defect recorded upstream in the Mantella notes - a blocking
 * `requests.get` under a comment claiming a two-second timeout. A comment is not a timeout.
 *
 * On expiry `spawnSync` returns with `error` set and a null status, which the existing
 * status check already turns into a throw; every caller here treats a throw as "cannot see
 * the process list" and degrades rather than dying. The failure was never the error path - it
 * was that there was no error to take.
 */
const PROCESS_QUERY_TIMEOUT_MS = 10_000;

function listNodeProcesses() {
  if (process.platform === 'win32') {
    const command = [
      "$ErrorActionPreference='Stop'",
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"
    ].join('; ');
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true, timeout: PROCESS_QUERY_TIMEOUT_MS
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Cannot inspect Node processes safely: ${(result.error?.message || result.stderr || result.stdout || 'process query failed').toString().trim()}`);
    }
    const parsed = JSON.parse((result.stdout || '[]').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(identifyNodeProcess).filter(Boolean);
  }

  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: PROCESS_QUERY_TIMEOUT_MS });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot inspect Node processes safely: ${(result.error?.message || result.stderr || '').toString().trim()}`);
  }
  return (result.stdout || '').split(/\r?\n/).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    return match ? identifyNodeProcess({ pid: Number(match[1]), commandLine: match[2] }) : undefined;
  }).filter(Boolean);
}

function processesForRoot(processes, root) {
  return processes.filter((item) => samePath(item.root, root));
}

function bootstrapCoordinationRoot(repo, root) {
  const busDir = path.join(root, '.ai-bus');
  const created = [];
  fs.mkdirSync(path.join(busDir, 'bin'), { recursive: true });
  const capabilitySource = path.join(repo, 'templates', 'capabilities.json');
  const capabilityDestination = path.join(busDir, 'capabilities.json');
  // The core coordination binaries, and they must travel TOGETHER. `harness.js` requires
  // ./capabilities, ./mailbox and ./workspace-key; `worker-client.js` requires ./workspace-key.
  // Staging a partial set leaves imports that resolve to nothing, which is how a bootstrapped
  // root ended up with a working `mailbox.js` while every documented `worker-client.js` and
  // `harness.js` command failed with MODULE_NOT_FOUND.
  //
  // Deliberately NOT staged here, and this stays a lightweight bootstrap rather than drifting
  // into full `stageBundle()` parity: `bin/` legacy utilities; `dist/brain`, `brains/` and the
  // dependency trees, because source-checkout `bus-up` runs brains from the REPO and copying
  // them would drag native modules along; `scripts/`, already being executed from source; and
  // providers, templates, docs and guides, which are installation assets rather than runtime.
  const sources = [
    [capabilitySource, capabilityDestination],
    [path.join(repo, 'dist', 'mailbox.js'), path.join(busDir, 'bin', 'mailbox.js')],
    [path.join(repo, 'dist', 'capabilities.js'), path.join(busDir, 'bin', 'capabilities.js')],
    [path.join(repo, 'dist', 'harness.js'), path.join(busDir, 'bin', 'harness.js')],
    [path.join(repo, 'dist', 'worker-client.js'), path.join(busDir, 'bin', 'worker-client.js')],
    [path.join(repo, 'dist', 'workspace-key.js'), path.join(busDir, 'bin', 'workspace-key.js')],
    [path.join(repo, 'dist', 'adapters', 'skse-devkit.js'), path.join(busDir, 'bin', 'skse-devkit.js')]
  ];
  for (const [source, destination] of sources) {
    if (!fs.existsSync(source)) throw new Error(`Cannot bootstrap coordination root; missing distribution asset: ${source}`);
    if (fs.existsSync(destination)) {
      // Upgrade only the exact previously shipped default. Arbitrary/operator capability files
      // remain untouched; equality with the generated legacy default is the ownership proof.
      if (destination === capabilityDestination) {
        const currentDefault = fs.readFileSync(source, 'utf8');
        const legacyDefault = currentDefault.replace(/\$\{bus\}\/\.ai-bus\/bin/g, '${workspace}/.ai-bus/bin')
          .replace(', "--root", "${bus}"', '');
        const normalizeNewlines = (value) => value.replace(/\r\n/g, '\n');
        if (normalizeNewlines(fs.readFileSync(destination, 'utf8')) === normalizeNewlines(legacyDefault)) {
          fs.copyFileSync(source, destination);
          created.push(destination);
        }
      }
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    created.push(destination);
  }
  return created;
}

async function stopExactProcesses(processes, timeoutMs = 15_000) {
  const owned = processes.filter((item) => item.pid !== process.pid);
  for (const item of owned) {
    if (process.platform === 'win32') {
      const stopped = spawnSync('taskkill', ['/PID', String(item.pid), '/T', '/F'], {
        encoding: 'utf8', windowsHide: true
      });
      if (stopped.status !== 0 && !/not found|no running instance/i.test(`${stopped.stdout}\n${stopped.stderr}`)) {
        throw new Error(`Failed to stop exact Bus process tree ${item.pid}: ${(stopped.stderr || stopped.stdout).trim()}`);
      }
    } else {
      try { process.kill(-item.pid, 'SIGTERM'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = owned.filter((item) => {
      try { process.kill(item.pid, 0); return true; } catch { return false; }
    });
    if (live.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out stopping exact Bus process(es): ${owned.map((item) => item.pid).join(', ')}`);
}

module.exports = {
  bootstrapCoordinationRoot,
  identifyNodeProcess,
  listNodeProcesses,
  optionFromCommandLine,
  processesForRoot,
  samePath,
  stopExactProcesses
};
