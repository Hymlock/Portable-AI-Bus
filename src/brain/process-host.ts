import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProcessResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  windowsHide?: boolean;
};

type PtyProcess = {
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
    return runConPty(command, args, options, dependencies.loadPty ?? loadNodePty);
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
  loadPty: () => PtyModule
): Promise<ProcessResult> {
  let pty: PtyModule;
  try {
    pty = loadPty();
  } catch (error) {
    return { code: -1, stdout: '', stderr: `ConPTY unavailable: ${errorMessage(error)}` };
  }

  const executable = resolveWindowsExecutable(command, options.env ?? process.env, options.cwd);
  if (!executable) {
    return { code: -1, stdout: '', stderr: `Command not found: ${command}` };
  }

  let captureDir: string;
  try {
    captureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-process-'));
    fs.writeFileSync(
      path.join(captureDir, 'request.json'),
      JSON.stringify({ command: executable, args }),
      'utf8'
    );
  } catch (error) {
    return { code: -1, stdout: '', stderr: `ConPTY capture setup failed: ${errorMessage(error)}` };
  }

  const requestPath = path.join(captureDir, 'request.json');
  const outputPath = path.join(captureDir, 'output.bin');

  return new Promise((resolve) => {
    let child: PtyProcess;
    try {
      // Keep the provider in the headless pseudoconsole process tree, but redirect its data stream
      // to a file. ConPTY mutates long output after its visible viewport scrolls, so it must not be
      // used as a byte transport. The short wrapper's PTY output is reserved for launch diagnostics.
      child = pty.spawn(process.execPath, ['-e', conPtyCaptureWrapper, requestPath, outputPath], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        useConpty: true
      });
    } catch (error) {
      removeCaptureDir(captureDir);
      resolve({ code: -1, stdout: '', stderr: `ConPTY spawn failed: ${errorMessage(error)}` });
      return;
    }

    let diagnostic = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      removeCaptureDir(captureDir);
      resolve(result);
    };
    child.onData((data) => { diagnostic += data; });
    child.onExit(({ exitCode }) => {
      let output = '';
      try {
        output = fs.readFileSync(outputPath, 'utf8');
      } catch (error) {
        finish({
          code: exitCode || -1,
          stdout: '',
          stderr: stripAnsi(diagnostic) || `ConPTY capture read failed: ${errorMessage(error)}`
        });
        return;
      }
      finish({ code: exitCode, stdout: stripAnsi(output), stderr: stripAnsi(diagnostic) });
    });
    timer = setTimeout(() => {
      let output = '';
      try { output = fs.readFileSync(outputPath, 'utf8'); } catch { /* no output yet */ }
      finish({ code: 124, stdout: stripAnsi(output), stderr: 'Process timed out.' });
      try { child.kill(); } catch { /* already exited */ }
    }, options.timeoutMs);
  });
}

const conPtyCaptureWrapper = String.raw`
const childProcess = require('node:child_process');
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const output = fs.openSync(process.argv[2], 'w');
let child;
let finished = false;
function finish(code, error) {
  if (finished) return;
  finished = true;
  try { fs.closeSync(output); } catch {}
  if (error) process.stderr.write(String(error && error.message || error));
  process.exit(Number.isInteger(code) ? code : 255);
}
try {
  child = childProcess.spawn(request.command, request.args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
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

function removeCaptureDir(directory: string): void {
  try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
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
    : (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
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
      resolve({ code: -1, stdout: '', stderr: errorMessage(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ code: -1, stdout, stderr: errorMessage(error) }));
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
