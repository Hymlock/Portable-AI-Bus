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
  return undefined;
}

function listNodeProcesses() {
  if (process.platform === 'win32') {
    const command = [
      "$ErrorActionPreference='Stop'",
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress"
    ].join('; ');
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', windowsHide: true
    });
    if (result.status !== 0) {
      throw new Error(`Cannot inspect Node processes safely: ${(result.stderr || result.stdout || 'process query failed').trim()}`);
    }
    const parsed = JSON.parse((result.stdout || '[]').trim() || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(identifyNodeProcess).filter(Boolean);
  }

  const result = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect Node processes safely: ${(result.stderr || '').trim()}`);
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
  const sources = [
    [capabilitySource, capabilityDestination],
    [path.join(repo, 'dist', 'mailbox.js'), path.join(busDir, 'bin', 'mailbox.js')],
    [path.join(repo, 'dist', 'capabilities.js'), path.join(busDir, 'bin', 'capabilities.js')],
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
