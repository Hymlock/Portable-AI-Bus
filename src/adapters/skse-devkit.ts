import { spawn, ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type SkseDevkitResolveOptions = {
  workspaceRoot: string;
  explicitRoot?: string;
  env?: NodeJS.ProcessEnv;
};

export type ToolPresence = {
  name: string;
  path: string | null;
  present: boolean;
};

export type SkseDevkitInventory = {
  schemaVersion: 1;
  root: string;
  rootExists: boolean;
  tools: ToolPresence[];
  commonLib: {
    root: string | null;
    cmakeLists: string | null;
    headersSample: string[];
  };
  vcpkg: {
    root: string | null;
    tripletHint: string | null;
    toolchainFile: string | null;
    overlayTriplets: string | null;
  };
  samples: string[];
  visualStudio: { hints: string[] };
  windowsSdk: { hints: string[] };
  notes: string[];
};

export type SkseCommandReceipt = {
  schemaVersion: 1;
  runId: string;
  action: 'configure' | 'build' | 'test' | 'doctor';
  root: string;
  sourceDir: string | null;
  buildDir: string | null;
  executable: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'timed_out' | 'launch_error' | 'skipped';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  stdoutSha256: string;
  stderrSha256: string;
};

export type PluginArtifactReport = {
  schemaVersion: 1;
  dll: ArtifactFile | null;
  pdb: ArtifactFile | null;
  ok: boolean;
  notes: string[];
};

export type ArtifactFile = {
  path: string;
  bytes: number;
  sha256: string;
  exists: boolean;
};

export type CommonLibHit = {
  path: string;
  line: number;
  preview: string;
};

export type ProjectOptions = {
  sourceDir?: string;
  buildDir?: string;
  preset?: string;
  target?: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_WALK_FILES = 5_000;

const SCRUB_ALLOW = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'WINDIR',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'PROGRAMFILES(X86)',
  'ProgramFiles(x86)',
  'PROGRAMDATA',
  'ProgramData',
  'COMSPEC',
  'ComSpec',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'TERM',
  'VSINSTALLDIR',
  'VCINSTALLDIR',
  'WindowsSdkDir',
  'WindowsSDKVersion',
  'VSCMD_ARG_TGT_ARCH',
  'VSCMD_VER',
  'INCLUDE',
  'LIB',
  'LIBPATH',
  'EXTERNAL_INCLUDE',
  'SKSE_DEVKIT_ROOT',
  'VCPKG_ROOT',
  'VCPKG_DEFAULT_TRIPLET'
]);

export class SkseDevkitAdapter {
  readonly workspaceRoot: string;
  readonly root: string;

  constructor(options: SkseDevkitResolveOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.root = resolveDevkitRoot(options);
  }

  static resolveRoot(options: SkseDevkitResolveOptions): string {
    return resolveDevkitRoot(options);
  }

  async doctor(): Promise<{ inventory: SkseDevkitInventory; receipt: SkseCommandReceipt }> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const inventory = await this.inventory();
    const finished = Date.now();
    const receipt = baseReceipt({
      action: 'doctor',
      root: this.root,
      sourceDir: null,
      buildDir: null,
      executable: '(inventory)',
      args: [],
      cwd: this.root,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      status: inventory.rootExists ? 'passed' : 'failed',
      exitCode: inventory.rootExists ? 0 : 1,
      signal: null,
      timedOut: false,
      stdoutTail: JSON.stringify(inventory, null, 2).slice(0, 4_000),
      stderrTail: '',
      stdoutSha256: sha256Text(JSON.stringify(inventory)),
      stderrSha256: sha256Text('')
    });
    return { inventory, receipt };
  }

  async inventory(): Promise<SkseDevkitInventory> {
    const rootExists = await exists(this.root);
    const notes: string[] = [];
    if (!rootExists) {
      notes.push(`Devkit root does not exist: ${this.root}`);
    }
    if (!(await exists(path.join(this.root, 'CMakeLists.txt')))) {
      notes.push('Devkit root has no CMakeLists.txt (expected). Use a project sourceDir for configure/build.');
    }

    const toolSpecs: Array<{ name: string; relatives: string[]; bare: string }> = [
      {
        name: 'cmake',
        relatives: ['tools/cmake/bin/cmake.exe', 'tools/cmake/bin/cmake', 'bin/cmake.exe', 'cmake/bin/cmake.exe'],
        bare: process.platform === 'win32' ? 'cmake.exe' : 'cmake'
      },
      {
        name: 'ninja',
        relatives: ['tools/ninja.exe', 'tools/ninja', 'bin/ninja.exe', 'ninja.exe'],
        bare: process.platform === 'win32' ? 'ninja.exe' : 'ninja'
      },
      {
        name: 'vcpkg',
        relatives: ['tools/vcpkg/vcpkg.exe', 'tools/vcpkg/vcpkg', 'vcpkg/vcpkg.exe', 'vcpkg.exe'],
        bare: process.platform === 'win32' ? 'vcpkg.exe' : 'vcpkg'
      },
      {
        name: 'ctest',
        relatives: ['tools/cmake/bin/ctest.exe', 'tools/cmake/bin/ctest', 'bin/ctest.exe'],
        bare: process.platform === 'win32' ? 'ctest.exe' : 'ctest'
      },
      { name: 'git', relatives: ['tools/git/cmd/git.exe'], bare: process.platform === 'win32' ? 'git.exe' : 'git' },
      { name: 'cl', relatives: [], bare: process.platform === 'win32' ? 'cl.exe' : 'cl' }
    ];

    const tools: ToolPresence[] = [];
    for (const spec of toolSpecs) {
      const found = await findTool(this.root, spec.relatives, spec.bare);
      tools.push({ name: spec.name, path: found, present: Boolean(found) });
    }

    const commonLibRoot = await firstExisting([
      path.join(this.root, 'libraries', 'CommonLibSSE-NG'),
      path.join(this.root, 'libraries', 'commonlibsse-ng'),
      path.join(this.root, 'CommonLibSSE-NG'),
      path.join(this.root, 'external', 'CommonLibSSE-NG'),
      path.join(this.root, 'lib', 'CommonLibSSE-NG'),
      path.join(this.root, 'deps', 'CommonLibSSE-NG')
    ]);
    const commonLibCmake = commonLibRoot ? await firstExisting([path.join(commonLibRoot, 'CMakeLists.txt')]) : null;
    const headersSample = commonLibRoot ? await sampleHeaders(commonLibRoot, 8) : [];

    const vcpkgRoot = await firstExisting([
      path.join(this.root, 'tools', 'vcpkg'),
      path.join(this.root, 'vcpkg'),
      process.env.VCPKG_ROOT ?? ''
    ]);
    const toolchainFile = vcpkgRoot
      ? await firstExisting([path.join(vcpkgRoot, 'scripts', 'buildsystems', 'vcpkg.cmake')])
      : null;
    const overlayTriplets = await firstExisting([path.join(this.root, 'vcpkg-triplets')]);
    const tripletHint =
      (await readTextIfExists(path.join(this.root, 'triplet.txt')))?.trim() ||
      (overlayTriplets ? await detectOverlayTriplet(overlayTriplets) : null) ||
      (await detectTripletHint(this.root)) ||
      process.env.VCPKG_DEFAULT_TRIPLET ||
      null;

    const samples = await listSampleProjects(this.root);

    return {
      schemaVersion: 1,
      root: this.root,
      rootExists,
      tools,
      commonLib: { root: commonLibRoot, cmakeLists: commonLibCmake, headersSample },
      vcpkg: { root: vcpkgRoot, tripletHint, toolchainFile, overlayTriplets },
      samples,
      visualStudio: { hints: await collectHints(this.root, ['vs_path.txt', 'visualstudio.txt', path.join('docs', 'vs.txt')], process.env.VSINSTALLDIR) },
      windowsSdk: { hints: await collectHints(this.root, ['winsdk.txt', 'sdk.txt', path.join('docs', 'sdk.txt')], process.env.WindowsSdkDir) },
      notes
    };
  }

  async resolveSourceDir(sourceDir?: string): Promise<string> {
    if (sourceDir?.trim()) {
      return this.assertPathInJail(path.resolve(sourceDir.trim()), 'sourceDir');
    }
    const workspaceCmake = path.join(this.workspaceRoot, 'CMakeLists.txt');
    if (await exists(workspaceCmake)) {
      return this.assertPathInJail(this.workspaceRoot, 'sourceDir');
    }
    const samples = await listSampleProjects(this.root);
    if (samples.length > 0) {
      return this.assertPathInJail(path.join(this.root, samples[0]), 'sourceDir');
    }
    throw new Error(
      'No CMake project found. Pass sourceDir to a project with CMakeLists.txt (workspace root or a kit sample such as DragonbornLogbookNative).'
    );
  }

  async configure(options: ProjectOptions = {}): Promise<SkseCommandReceipt> {
    const sourceDir = await this.resolveSourceDir(options.sourceDir);
    const buildDir = await this.resolveBuildDir(sourceDir, options.buildDir, options.preset);
    await fs.mkdir(buildDir, { recursive: true });
    const inv = await this.inventory();
    const cmake = inv.tools.find((tool) => tool.name === 'cmake' && tool.present)?.path ?? 'cmake';

    if (options.preset) {
      assertSafeToken(options.preset, 'preset');
      return this.runFixed({
        action: 'configure',
        executable: cmake,
        args: ['--preset', options.preset],
        cwd: sourceDir,
        sourceDir,
        buildDir,
        timeoutMs: options.timeoutMs
      });
    }

    const args = ['-S', sourceDir, '-B', buildDir, '-G', 'Ninja'];
    const ninja = inv.tools.find((tool) => tool.name === 'ninja' && tool.present)?.path;
    if (ninja) {
      args.push(`-DCMAKE_MAKE_PROGRAM=${ninja}`);
    }
    if (inv.vcpkg.toolchainFile) {
      args.push(`-DCMAKE_TOOLCHAIN_FILE=${inv.vcpkg.toolchainFile}`);
    }
    if (inv.vcpkg.tripletHint) {
      args.push(`-DVCPKG_TARGET_TRIPLET=${inv.vcpkg.tripletHint}`);
      args.push(`-DVCPKG_HOST_TRIPLET=${inv.vcpkg.tripletHint}`);
    }
    if (inv.vcpkg.overlayTriplets) {
      args.push(`-DVCPKG_OVERLAY_TRIPLETS=${inv.vcpkg.overlayTriplets}`);
    }
    return this.runFixed({
      action: 'configure',
      executable: cmake,
      args,
      cwd: sourceDir,
      sourceDir,
      buildDir,
      timeoutMs: options.timeoutMs
    });
  }

  async build(options: ProjectOptions = {}): Promise<SkseCommandReceipt> {
    const sourceDir = await this.resolveSourceDir(options.sourceDir);
    const buildDir = await this.resolveBuildDir(sourceDir, options.buildDir, options.preset);
    const inv = await this.inventory();
    const cmake = inv.tools.find((tool) => tool.name === 'cmake' && tool.present)?.path ?? 'cmake';
    const args = ['--build', buildDir];
    if (options.target) {
      assertSafeToken(options.target, 'target');
      args.push('--target', options.target);
    }
    return this.runFixed({
      action: 'build',
      executable: cmake,
      args,
      cwd: sourceDir,
      sourceDir,
      buildDir,
      timeoutMs: options.timeoutMs
    });
  }

  async test(options: ProjectOptions = {}): Promise<SkseCommandReceipt> {
    const sourceDir = await this.resolveSourceDir(options.sourceDir);
    const buildDir = await this.resolveBuildDir(sourceDir, options.buildDir, options.preset);
    const inv = await this.inventory();
    const ctest = inv.tools.find((tool) => tool.name === 'ctest' && tool.present)?.path ?? 'ctest';
    return this.runFixed({
      action: 'test',
      executable: ctest,
      args: ['--test-dir', buildDir, '--output-on-failure'],
      cwd: sourceDir,
      sourceDir,
      buildDir,
      timeoutMs: options.timeoutMs
    });
  }

  async searchCommonLib(query: string, options: { maxHits?: number; extensions?: string[] } = {}): Promise<CommonLibHit[]> {
    if (!query || query.length > 200 || query.includes('\0')) {
      throw new Error('Invalid search query.');
    }
    const inv = await this.inventory();
    if (!inv.commonLib.root) {
      return [];
    }
    const extensions = new Set(
      (options.extensions ?? ['.h', '.hpp', '.cpp', '.cxx', '.cc', '.cmake', '.txt']).map((item) => item.toLowerCase())
    );
    const maxHits = Math.min(Math.max(options.maxHits ?? 50, 1), 500);
    const hits: CommonLibHit[] = [];
    await walkFiles(inv.commonLib.root, async (filePath) => {
      if (hits.length >= maxHits) {
        return false;
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!extensions.has(ext) && path.basename(filePath) !== 'CMakeLists.txt') {
        return true;
      }
      const text = await readTextIfExists(filePath);
      if (!text) {
        return true;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (hits.length >= maxHits) {
          break;
        }
        const line = lines[index];
        if (line.toLowerCase().includes(query.toLowerCase())) {
          hits.push({
            path: path.relative(this.root, filePath).replace(/\\/g, '/'),
            line: index + 1,
            preview: line.trim().slice(0, 240)
          });
        }
      }
      return true;
    });
    return hits;
  }

  async validatePluginArtifacts(options: {
    dllPath?: string;
    pdbPath?: string;
    searchDir?: string;
    sourceDir?: string;
    preset?: string;
  } = {}): Promise<PluginArtifactReport> {
    const notes: string[] = [];
    let dllPath = options.dllPath ? await this.assertPathInJail(path.resolve(options.dllPath), 'dllPath') : null;
    let pdbPath = options.pdbPath ? await this.assertPathInJail(path.resolve(options.pdbPath), 'pdbPath') : null;
    let searchDir = options.searchDir ? await this.assertPathInJail(path.resolve(options.searchDir), 'searchDir') : null;
    if (!searchDir && !dllPath) {
      try {
        const sourceDir = await this.resolveSourceDir(options.sourceDir);
        searchDir = await this.resolveBuildDir(sourceDir, undefined, options.preset);
      } catch {
        searchDir = path.join(this.root, 'build');
      }
    }

    if (!dllPath && searchDir && (await exists(searchDir))) {
      dllPath = await findFirstByExtension(searchDir, '.dll');
    }
    if (!pdbPath && searchDir && (await exists(searchDir))) {
      pdbPath = await findFirstByExtension(searchDir, '.pdb');
    }

    const dll = dllPath ? await hashFile(dllPath) : null;
    const pdb = pdbPath ? await hashFile(pdbPath) : null;
    if (!dll?.exists) {
      notes.push('Plugin DLL not found.');
    } else if (dll.bytes < 1_024) {
      notes.push('DLL is suspiciously small.');
    }
    if (!pdb?.exists) {
      notes.push('PDB not found (optional for release, required for debuggable spikes).');
    }
    return { schemaVersion: 1, dll, pdb, ok: Boolean(dll?.exists && dll.bytes >= 1_024), notes };
  }

  private async resolveBuildDir(sourceDir: string, buildDir?: string, preset?: string): Promise<string> {
    if (buildDir?.trim()) {
      return this.assertPathInJail(path.resolve(buildDir.trim()), 'buildDir');
    }
    if (preset) {
      assertSafeToken(preset, 'preset');
      return this.assertPathInJail(path.join(sourceDir, 'build', preset), 'buildDir');
    }
    return this.assertPathInJail(path.join(sourceDir, 'build'), 'buildDir');
  }

  private async assertPathInJail(candidate: string, label: string): Promise<string> {
    const resolved = path.resolve(candidate);
    const realRoot = await fs.realpath(this.root).catch(() => path.resolve(this.root));
    const realWorkspace = await fs.realpath(this.workspaceRoot).catch(() => path.resolve(this.workspaceRoot));
    let realCandidate = resolved;
    try {
      realCandidate = await fs.realpath(resolved);
    } catch {
      // path may not exist yet (build dir); jail the parent
      const parent = path.dirname(resolved);
      const realParent = await fs.realpath(parent).catch(() => parent);
      if (!isInside(realParent, realRoot) && !isInside(realParent, realWorkspace)) {
        throw new Error(`${label} escapes devkit/workspace jail: ${candidate}`);
      }
      return resolved;
    }
    if (!isInside(realCandidate, realRoot) && !isInside(realCandidate, realWorkspace)) {
      throw new Error(`${label} escapes devkit/workspace jail: ${candidate}`);
    }
    return realCandidate;
  }

  private async runFixed(input: {
    action: SkseCommandReceipt['action'];
    executable: string;
    args: string[];
    cwd: string;
    sourceDir: string | null;
    buildDir: string | null;
    timeoutMs?: number;
  }): Promise<SkseCommandReceipt> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const timeoutMs = Math.max(100, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const stdout = new OutputBucket(MAX_OUTPUT_BYTES);
    const stderr = new OutputBucket(MAX_OUTPUT_BYTES);
    let timedOut = false;
    let launchError: Error | undefined;
    let child: ChildProcess | undefined;

    const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      let settled = false;
      let exitFallback: NodeJS.Timeout | undefined;
      let finalWatchdog: NodeJS.Timeout | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        if (exitFallback) {
          clearTimeout(exitFallback);
        }
        if (finalWatchdog) {
          clearTimeout(finalWatchdog);
        }
        resolve({ exitCode, signal });
      };

      try {
        child = spawn(input.executable, input.args, {
          cwd: input.cwd,
          env: scrubEnv(process.env),
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32'
        });
      } catch (error) {
        launchError = error instanceof Error ? error : new Error(String(error));
        finish(null, null);
        return;
      }

      child.stdout?.on('data', (chunk) => stdout.append(chunk));
      child.stderr?.on('data', (chunk) => stderr.append(chunk));
      child.once('error', (error) => {
        launchError = error;
        finish(null, null);
      });
      child.once('close', (exitCode, signal) => finish(exitCode, signal));
      child.once('exit', (exitCode, signal) => {
        exitFallback = setTimeout(() => {
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          finish(exitCode, signal);
        }, 500);
        exitFallback.unref();
      });

      timer = setTimeout(() => {
        timedOut = true;
        if (child) {
          void terminateProcessTree(child);
        }
        finalWatchdog = setTimeout(() => {
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          finish(child?.exitCode ?? null, child?.signalCode ?? null);
        }, 5_000);
        finalWatchdog.unref();
      }, timeoutMs);
      timer.unref();
    });

    const finished = Date.now();
    const out = stdout.finish();
    const err = launchError ? OutputBucket.fromText(launchError.message, MAX_OUTPUT_BYTES).finish() : stderr.finish();
    return baseReceipt({
      action: input.action,
      root: this.root,
      sourceDir: input.sourceDir,
      buildDir: input.buildDir,
      executable: input.executable,
      args: input.args,
      cwd: input.cwd,
      startedAt,
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      status: launchError ? 'launch_error' : timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed',
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut,
      stdoutTail: out.tail,
      stderrTail: err.tail,
      stdoutSha256: out.sha256,
      stderrSha256: err.sha256
    });
  }
}

function resolveDevkitRoot(options: SkseDevkitResolveOptions): string {
  const env = options.env ?? process.env;
  if (options.explicitRoot?.trim()) {
    return path.resolve(options.explicitRoot.trim());
  }
  if (env.SKSE_DEVKIT_ROOT?.trim()) {
    return path.resolve(env.SKSE_DEVKIT_ROOT.trim());
  }
  return path.resolve(options.workspaceRoot, '.ai-bus', 'toolchains', 'skse-devkit');
}

function scrubEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (
      SCRUB_ALLOW.has(key) ||
      key.startsWith('VSCMD_') ||
      key.startsWith('VCTools') ||
      key.startsWith('WindowsSDK') ||
      key.startsWith('SKSE_')
    ) {
      next[key] = value;
    }
  }
  next.AI_BUS_SCRUBBED = '1';
  return next;
}

async function terminateProcessTree(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('close', () => resolve());
      killer.once('error', () => resolve());
      setTimeout(() => resolve(), 3_000).unref();
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 2_000).unref();
}

async function findTool(root: string, relatives: string[], bareName: string): Promise<string | null> {
  for (const relative of relatives) {
    const candidate = path.join(root, ...relative.split('/'));
    if (await exists(candidate)) {
      return candidate;
    }
  }
  const pathEnv = process.env.PATH ?? process.env.Path ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, bareName);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function firstExisting(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function listSampleProjects(root: string): Promise<string[]> {
  const samples: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return samples;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === 'tools' || entry.name === 'libraries' || entry.name === 'vcpkg-triplets' || entry.name.startsWith('.')) {
      continue;
    }
    if (await exists(path.join(root, entry.name, 'CMakeLists.txt'))) {
      samples.push(entry.name);
    }
  }
  return samples.sort();
}

async function sampleHeaders(root: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  await walkFiles(root, async (filePath) => {
    if (found.length >= limit) {
      return false;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.h' || ext === '.hpp') {
      found.push(path.relative(root, filePath).replace(/\\/g, '/'));
    }
    return true;
  });
  return found;
}

async function detectOverlayTriplet(overlayDir: string): Promise<string | null> {
  try {
    const names = await fs.readdir(overlayDir);
    const match = names.find((name) => name.endsWith('.cmake'));
    return match ? match.replace(/\.cmake$/i, '') : null;
  } catch {
    return null;
  }
}

async function detectTripletHint(root: string): Promise<string | null> {
  for (const rel of ['CMakePresets.json', path.join('DragonbornLogbookNative', 'CMakePresets.json')]) {
    const text = await readTextIfExists(path.join(root, rel));
    if (!text) {
      continue;
    }
    const match = text.match(/x64-windows-static-md-skse|x64-windows-static-md|x64-windows-static|x64-windows/i);
    if (match) {
      return match[0];
    }
  }
  return null;
}

async function collectHints(root: string, relatives: string[], envHint?: string): Promise<string[]> {
  const hints: string[] = [];
  for (const rel of relatives) {
    const text = await readTextIfExists(path.join(root, rel));
    if (text?.trim()) {
      hints.push(text.trim().split(/\r?\n/)[0].slice(0, 260));
    }
  }
  if (envHint) {
    hints.push(envHint);
  }
  return Array.from(new Set(hints));
}

async function walkFiles(root: string, visit: (filePath: string) => Promise<boolean | void>) {
  let seen = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'build' || entry.name === 'node_modules') {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      seen += 1;
      if (seen > MAX_WALK_FILES) {
        return;
      }
      const keepGoing = await visit(full);
      if (keepGoing === false) {
        return;
      }
    }
  }
}

async function findFirstByExtension(root: string, extension: string): Promise<string | null> {
  let found: string | null = null;
  await walkFiles(root, async (filePath) => {
    if (path.extname(filePath).toLowerCase() === extension.toLowerCase()) {
      found = filePath;
      return false;
    }
    return true;
  });
  return found;
}

async function hashFile(filePath: string): Promise<ArtifactFile> {
  try {
    const data = await fs.readFile(filePath);
    return {
      path: filePath,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
      exists: true
    };
  } catch {
    return { path: filePath, bytes: 0, sha256: '', exists: false };
  }
}

function isInside(child: string, parent: string) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertSafeToken(value: string, label: string) {
  if (!/^[a-zA-Z0-9_.:-]+$/.test(value)) {
    throw new Error(`${label} contains disallowed characters.`);
  }
}

function baseReceipt(
  value: Omit<SkseCommandReceipt, 'schemaVersion' | 'runId'> & { startedAt: string }
): SkseCommandReceipt {
  return {
    schemaVersion: 1,
    runId: `${value.startedAt.replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`,
    ...value
  };
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function sha256Text(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

class OutputBucket {
  private readonly hash = createHash('sha256');
  private readonly chunks: Buffer[] = [];
  private retained = 0;
  private total = 0;

  constructor(private readonly maxBytes: number) {}

  append(value: Buffer | string) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    this.hash.update(chunk);
    this.total += chunk.length;
    this.chunks.push(chunk);
    this.retained += chunk.length;
    while (this.retained > this.maxBytes && this.chunks.length > 0) {
      const overflow = this.retained - this.maxBytes;
      const first = this.chunks[0];
      if (first.length <= overflow) {
        this.chunks.shift();
        this.retained -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.retained -= overflow;
      }
    }
  }

  finish() {
    return {
      sha256: this.hash.digest('hex'),
      tail: Buffer.concat(this.chunks).toString('utf8'),
      bytes: this.total,
      truncated: this.total > this.retained
    };
  }

  static fromText(value: string, maxBytes: number) {
    const bucket = new OutputBucket(maxBytes);
    bucket.append(value);
    return bucket;
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const workspace = option(argv, '--workspace') ?? path.resolve(process.cwd());
  const root = option(argv, '--root');
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root });
  const common: ProjectOptions = {
    sourceDir: option(argv, '--source-dir'),
    buildDir: option(argv, '--build-dir'),
    preset: option(argv, '--preset'),
    target: option(argv, '--target'),
    timeoutMs: intOption(argv, '--timeout-ms')
  };

  if (command === 'doctor') {
    const result = await adapter.doctor();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.receipt.status === 'passed' ? 0 : 1;
    return;
  }
  if (command === 'configure') {
    process.stdout.write(`${JSON.stringify(await adapter.configure(common), null, 2)}\n`);
    return;
  }
  if (command === 'build') {
    process.stdout.write(`${JSON.stringify(await adapter.build(common), null, 2)}\n`);
    return;
  }
  if (command === 'test') {
    process.stdout.write(`${JSON.stringify(await adapter.test(common), null, 2)}\n`);
    return;
  }
  if (command === 'search') {
    const query = option(argv, '--query') ?? argv[1];
    if (!query) {
      throw new Error('search requires --query TEXT');
    }
    process.stdout.write(`${JSON.stringify(await adapter.searchCommonLib(query), null, 2)}\n`);
    return;
  }
  if (command === 'validate-artifacts') {
    process.stdout.write(
      `${JSON.stringify(
        await adapter.validatePluginArtifacts({
          dllPath: option(argv, '--dll'),
          pdbPath: option(argv, '--pdb'),
          searchDir: option(argv, '--search-dir'),
          sourceDir: common.sourceDir,
          preset: common.preset
        }),
        null,
        2
      )}\n`
    );
    return;
  }
  throw new Error(
    'Usage: skse-devkit <doctor|configure|build|test|search|validate-artifacts> [--workspace PATH] [--root PATH] [--source-dir PATH] [--build-dir PATH] [--preset NAME]'
  );
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function intOption(argv: string[], name: string) {
  const raw = option(argv, name);
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return value;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
