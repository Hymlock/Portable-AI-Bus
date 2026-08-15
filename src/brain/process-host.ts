import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StallLedger } from './stall-ledger';

export type ProcessFailureKind = 'broken';

export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * Transport or dependency failure. Distinct from a provider that answered "no credits".
   * Callers must surface this as BROKEN, not as chain-exhausted / out of providers.
   */
  failureKind?: ProcessFailureKind;
};

export type ProcessOutcome = 'returned' | 'timed-out' | 'exited';

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  windowsHide?: boolean;
  /**
   * Emit stall-start if the child is still running after this many milliseconds.
   * Absent means no stall watch — a timeout is still a timeout. 0 fires immediately
   * (tests). This is a timer, not a spent-chain signal.
   */
  stallMs?: number;
  log?: (event: string, data?: unknown) => void;
  onStall?: (info: { elapsedMs: number; stallId: string }) => void;
  /**
   * Optional durable pair. When set with stallSeat, an unresolved process-host
   * stall remains in the same file the runner uses. Absent means log edges only.
   */
  stallLedger?: StallLedger;
  stallSeat?: string;
  /**
   * Deadline for pty.spawn itself. The post-spawn stall timer cannot fire while
   * node-pty is blocked in ConnectNamedPipe. A sibling process writes the ledger
   * if spawn has not returned by this time. 0 / absent means no spawn watchdog.
   */
  spawnStallMs?: number;
};

export function processOutcome(code: number): ProcessOutcome {
  if (code === 124) return 'timed-out';
  if (code === 0) return 'returned';
  return 'exited';
}

type PtyProcess = {
  pid?: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  kill(signal?: string): void;
};

type PtyModule = {
  spawn(command: string, args: string[], options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: NodeJS.ProcessEnv;
    useConpty: boolean;
  }): PtyProcess;
};

type SpawnedProcess = {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    shell: false;
    cwd?: string;
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  }
) => SpawnedProcess;

export type ProcessHostDependencies = {
  platform?: NodeJS.Platform;
  loadPty?: () => PtyModule;
  spawn?: SpawnProcess;
  isProcessAlive?: (pid: number) => boolean;
};

/** Check command reachability without spawning a short-lived console process. */
export function processAvailable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') return Boolean(resolveWindowsExecutable(command, env, cwd));
  const hasDirectory = path.isAbsolute(command) || command.includes('/');
  const candidates = hasDirectory
    ? [path.resolve(cwd, command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map((root) => path.join(root, command));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Remove terminal control sequences emitted because Windows commands are hosted in ConPTY. */
export function stripAnsi(value: string): string {
  return value
    // OSC commands, including the window-title command emitted by Claude Code.
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    // CSI commands such as cursor movement, erase, colour, and private-mode toggles.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // Remaining two-byte escape commands.
    .replace(/\u001b[@-_]/g, '');
}

/**
 * Run a CLI without allowing its console-subsystem descendants to create visible windows.
 *
 * On Windows, a headless ConPTY is intentional: `windowsHide` only controls the direct child,
 * while the provider CLIs launch their own git/reg/where processes. Those grandchildren inherit
 * the pseudoconsole, so their conhost processes never create a top-level ConsoleWindowClass.
 * A PTY combines stdout and stderr; the combined, ANSI-cleaned stream is returned as `stdout`.
 *
 * On other platforms there is no Windows console-window problem, so ordinary pipe-based spawn
 * preserves stdout and stderr separately. A missing/broken node-pty fails closed on Windows
 * instead of silently reverting to the flashing path; a provider chain can then try its next link.
 */
export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions,
  dependencies: ProcessHostDependencies = {}
): Promise<ProcessResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'win32') {
    return runConPty(
      command,
      args,
      options,
      dependencies.loadPty ?? loadNodePty,
      dependencies.isProcessAlive ?? processIsAlive
    );
  }
  return runSpawn(command, args, options, dependencies.spawn ?? (nodeSpawn as unknown as SpawnProcess));
}

function loadNodePty(): PtyModule {
  // Loaded only on Windows. Keeping this dynamic lets non-Windows installs avoid loading a native
  // addon they do not use and gives callers an ordinary failed result if the addon cannot load.
  return require('node-pty') as PtyModule;
}

async function runConPty(
  command: string,
  args: string[],
  options: RunProcessOptions,
  loadPty: () => PtyModule,
  isProcessAlive: (pid: number) => boolean
): Promise<ProcessResult> {
  let pty: PtyModule;
  try {
    pty = loadPty();
  } catch (error) {
    return {
      code: -1,
      stdout: '',
      stderr: `ConPTY unavailable: ${errorMessage(error)}`,
      failureKind: 'broken'
    };
  }

  const executable = resolveWindowsExecutable(command, options.env ?? process.env, options.cwd);
  if (!executable) {
    return {
      code: -1,
      stdout: '',
      stderr: `Command not found: ${command}`,
      failureKind: 'broken'
    };
  }

  let captureDir: string;
  try {
    captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-process-'));
    fs.writeFileSync(
      path.join(captureDir, 'request.json'),
      JSON.stringify({ command: executable, args }),
      'utf8'
    );
    fs.writeFileSync(path.join(captureDir, 'launch-script.ps1'), powerShellScriptLauncher, 'utf8');
  } catch (error) {
    return {
      code: -1,
      stdout: '',
      stderr: `ConPTY capture setup failed: ${errorMessage(error)}`,
      failureKind: 'broken'
    };
  }

  const requestPath = path.join(captureDir, 'request.json');
  const outputPath = path.join(captureDir, 'output.bin');
  const completionPath = path.join(captureDir, 'completion.json');
  const scriptLauncherPath = path.join(captureDir, 'launch-script.ps1');

  return new Promise((resolve) => {
    const spawnWatch = armSpawnWatchdog(options, captureDir);
    let child: PtyProcess;
    try {
      // Keep the provider in the headless pseudoconsole process tree, but redirect its data stream
      // to a file. ConPTY mutates long output after its visible viewport scrolls, so it must not be
      // used as a byte transport. The short wrapper's PTY output is reserved for launch diagnostics.
      child = pty.spawn(
        process.execPath,
        ['-e', conPtyCaptureWrapper, requestPath, outputPath, completionPath, scriptLauncherPath],
        {
          name: 'xterm-256color',
          cols: 120,
          rows: 40,
          cwd: options.cwd ?? process.cwd(),
          env: options.env ?? process.env,
          useConpty: true
        }
      );
    } catch (error) {
      spawnWatch.returned('threw');
      removeCaptureDir(captureDir);
      resolve({
        code: -1,
        stdout: '',
        stderr: `ConPTY spawn failed: ${errorMessage(error)}`,
        failureKind: 'broken'
      });
      return;
    }
    spawnWatch.returned('returned');

    let diagnostic = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let monitor: NodeJS.Timeout | undefined;
    const stall = watchProcessStall(options);
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (monitor) clearInterval(monitor);
      stall.finish(result);
      // PtyKill is the only node-pty path that calls ClosePseudoConsole. The success
      // path used to skip it and leak a headless conhost per wake.
      try { child.kill(); } catch { /* already gone; still the only close we can invoke */ }
      removeCaptureDir(captureDir);
      resolve(result);
    };
    const readOutput = () => {
      try { return fs.readFileSync(outputPath, 'utf8'); } catch { return ''; }
    };
    const finishFromCompletion = (): boolean => {
      let exitCode: number;
      try {
        const completion = JSON.parse(fs.readFileSync(completionPath, 'utf8')) as { code?: unknown };
        if (!Number.isInteger(completion.code)) return false;
        exitCode = completion.code as number;
      } catch {
        return false;
      }
      const output = stripAnsi(readOutput());
      const launchDiagnostic = stripAnsi(diagnostic);
      finish({
        code: exitCode,
        stdout: output,
        stderr: launchDiagnostic || (!output && exitCode !== 0
          ? `Provider process exited with code ${exitCode}.`
          : '')
      });
      return true;
    };
    child.onData((data) => { diagnostic += data; });
    child.onExit(({ exitCode }) => {
      if (finishFromCompletion()) return;
      const output = stripAnsi(readOutput());
      finish({
        code: exitCode,
        stdout: output,
        stderr: stripAnsi(diagnostic) || (!output && exitCode !== 0
          ? `ConPTY host exited with code ${exitCode} before reporting provider exit.`
          : '')
      });
    });
    // node-pty's ConPTY exit event depends on its console-list helper. If that helper dies after
    // the provider has already exited, the event can be lost forever. The wrapper therefore
    // records provider completion out of band, and this monitor observes both that record and a
    // wrapper which died before it could write one.
    monitor = setInterval(() => {
      if (finishFromCompletion()) return;
      if (Number.isInteger(child.pid) && !isProcessAlive(child.pid as number)) {
        finish({
          code: -1,
          stdout: stripAnsi(readOutput()),
          stderr: stripAnsi(diagnostic) || 'ConPTY host died before reporting provider exit.'
        });
      }
    }, 50);
    timer = setTimeout(() => {
      finish({
        code: 124,
        stdout: stripAnsi(readOutput()),
        stderr: 'Process timed out while the child was still running.'
      });
      try { child.kill(); } catch { /* already exited */ }
    }, options.timeoutMs);
  });
}

const conPtyCaptureWrapper = String.raw`
const childProcess = require('node:child_process');
const fs = require('node:fs');
const requestPath = process.argv[1];
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const output = fs.openSync(process.argv[2], 'w');
const completionPath = process.argv[3];
const scriptLauncherPath = process.argv[4];
let child;
let finished = false;
function quoteCmdArgument(value) {
  return '"' + String(value).replace(/"/g, '\\"') + '"';
}
function finish(code, error) {
  if (finished) return;
  finished = true;
  try { fs.closeSync(output); } catch {}
  if (error) process.stderr.write(String(error && error.message || error));
  try {
    const temporary = completionPath + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ code: Number.isInteger(code) ? code : 255 }));
    fs.renameSync(temporary, completionPath);
  } catch (completionError) {
    process.stderr.write('Completion record failed: ' + String(completionError && completionError.message || completionError));
  }
  process.exit(Number.isInteger(code) ? code : 255);
}
try {
  const isCommandScript = /\.(?:bat|cmd)$/i.test(request.command);
  const isPowerShellScript = /\.ps1$/i.test(request.command);
  const command = isCommandScript
    ? (process.env.ComSpec || (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\cmd.exe')
    : isPowerShellScript
      ? (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      : request.command;
  const args = isCommandScript
    ? ['/d', '/s', '/c', '"' + [request.command, ...request.args].map(quoteCmdArgument).join(' ') + '"']
    : isPowerShellScript
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
         '-File', scriptLauncherPath, requestPath]
      : request.args;
  child = childProcess.spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    windowsVerbatimArguments: isCommandScript,
    stdio: ['ignore', output, output]
  });
} catch (error) {
  finish(255, error);
}
if (child) {
  child.once('error', (error) => finish(255, error));
  child.once('exit', (code) => finish(code));
}
`;

const powerShellScriptLauncher = String.raw`
param([Parameter(Mandatory=$true)][string]$RequestPath)
$request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$command = [string]$request.command
$arguments = @($request.args | ForEach-Object { [string]$_ })
& $command @arguments
$invocationSucceeded = $?
$exitCode = $LASTEXITCODE
if ($null -ne $exitCode) { exit $exitCode }
if (-not $invocationSucceeded) { exit 1 }
exit 0
`;

function removeCaptureDir(directory: string): void {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveWindowsExecutable(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd()
): string | undefined {
  const hasDirectory = path.isAbsolute(command) || /[\\/]/.test(command);
  const roots = hasDirectory
    ? ['']
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const base = hasDirectory ? path.resolve(cwd, command) : command;
  const hasExtension = Boolean(path.extname(base));
  const extensions = hasExtension
    ? ['']
    : [...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean), '.PS1']
      .filter((extension, index, all) => all.findIndex(
        (other) => other.toLowerCase() === extension.toLowerCase()
      ) === index);
  for (const root of roots) {
    for (const extension of extensions) {
      const candidate = root ? path.join(root, base + extension) : base + extension;
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* keep searching */ }
    }
  }
  return undefined;
}

async function runSpawn(
  command: string,
  args: string[],
  options: RunProcessOptions,
  spawn: SpawnProcess
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: SpawnedProcess;
    try {
      child = spawn(command, args, {
        shell: false,
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: options.windowsHide ?? true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({
        code: -1,
        stdout: '',
        stderr: errorMessage(error),
        failureKind: 'broken'
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const stall = watchProcessStall(options);
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stall.finish(result);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({
      code: -1,
      stdout,
      stderr: errorMessage(error),
      failureKind: 'broken'
    }));
    child.once('close', (code) => finish({ code: code ?? -1, stdout, stderr }));
    timer = setTimeout(() => {
      finish({ code: 124, stdout, stderr: stderr || 'Process timed out.' });
      try { child.kill(); } catch { /* already exited */ }
    }, options.timeoutMs);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function spawnWatchdogBudgetMs(options: RunProcessOptions): number | undefined {
  if (typeof options.spawnStallMs === 'number' && options.spawnStallMs > 0) {
    return options.spawnStallMs;
  }
  if (typeof options.stallMs === 'number' && options.stallMs >= 100) {
    return options.stallMs;
  }
  return undefined;
}

/**
 * A sibling Node process, not a timer on this loop. pty.spawn on Windows is a
 * synchronous native call; if it blocks, setTimeout here never runs.
 */
function armSpawnWatchdog(options: RunProcessOptions, captureDir: string): {
  returned(outcome: 'returned' | 'threw'): void;
} {
  const budgetMs = spawnWatchdogBudgetMs(options);
  const filePath = options.stallLedger?.filePath;
  const seat = options.stallSeat;
  if (!budgetMs || !filePath || !seat || !options.stallLedger) {
    return { returned() { /* no durable pair, nothing to watch */ } };
  }

  const markerPath = path.join(captureDir, 'spawn-returned');
  const ledgerModule = path.join(__dirname, 'stall-ledger.js');
  const script = `
    const fs = require('node:fs');
    const { createStallLedger } = require(${JSON.stringify(ledgerModule)});
    const markerPath = process.argv[1];
    const filePath = process.argv[2];
    const seat = process.argv[3];
    const thresholdMs = Number(process.argv[4]);
    setTimeout(() => {
      try {
        if (fs.existsSync(markerPath)) return;
        const ledger = createStallLedger({ seat, filePath });
        ledger.start({ seat, source: 'process-host', thresholdMs });
      } catch { /* visibility must not take the parent */ }
    }, thresholdMs);
  `;
  let watchdog: ReturnType<typeof nodeSpawn> | undefined;
  try {
    watchdog = nodeSpawn(process.execPath, ['-e', script, markerPath, filePath, seat, String(budgetMs)], {
      stdio: 'ignore',
      windowsHide: true
    });
    watchdog.unref();
  } catch {
    watchdog = undefined;
  }

  const armedAtMs = Date.now();
  return {
    returned(outcome) {
      try { fs.writeFileSync(markerPath, '1'); } catch { /* marker is best-effort */ }
      try { watchdog?.kill(); } catch { /* already exited */ }
      try {
        const snap = options.stallLedger?.snapshot();
        for (const open of snap?.open ?? []) {
          if (open.source !== 'process-host') continue;
          if (open.startedAtMs + 5 < armedAtMs) continue;
          options.stallLedger?.resolve(open.id, outcome);
        }
      } catch { /* resolving a race write must not take the child */ }
    }
  };
}

function watchProcessStall(options: RunProcessOptions) {
  const startedAt = Date.now();
  const log = options.log ?? (() => {});
  let fired = false;
  let stallId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    if (fired) return;
    fired = true;
    const elapsedMs = Date.now() - startedAt;
    const thresholdMs = typeof options.stallMs === 'number' ? options.stallMs : 0;
    try {
      if (options.stallLedger && options.stallSeat) {
        stallId = options.stallLedger.start({
          seat: options.stallSeat,
          source: 'process-host',
          thresholdMs
        }).id;
      }
    } catch { /* ledger failure must not take the child */ }
    if (!stallId) stallId = randomUUID();
    log('stall-start', {
      stallId,
      source: 'process-host',
      milliseconds: options.stallMs,
      elapsedMs
    });
    try { options.onStall?.({ elapsedMs, stallId }); } catch { /* stall observation must not take the child */ }
  };
  if (options.stallMs === 0) fire();
  else if (typeof options.stallMs === 'number' && options.stallMs > 0) {
    timer = setTimeout(fire, options.stallMs);
  }
  return {
    finish(result: ProcessResult) {
      if (timer) clearTimeout(timer);
      if (!fired) return;
      const durationMs = Date.now() - startedAt;
      const outcome = processOutcome(result.code);
      try {
        if (stallId) options.stallLedger?.resolve(stallId, outcome, durationMs);
      } catch { /* ledger failure must not take the child */ }
      log('stall-resolution', {
        stallId,
        source: 'process-host',
        durationMs,
        thresholdMs: options.stallMs,
        outcome,
        code: result.code
      });
    }
  };
}
