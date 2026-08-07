'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const sourceRoot = path.resolve(__dirname, '..');
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-vsix-'));
  const first = path.join(fixtureRoot, 'first');
  const second = path.join(fixtureRoot, 'second');
  const workspace = path.join(fixtureRoot, 'integration.code-workspace');
  const shutdownState = path.join(fixtureRoot, 'shutdown-state.json');
  const userDataDir = path.join(fixtureRoot, 'user-data');
  const extensionsDir = path.join(fixtureRoot, 'extensions');
  const vsixPath = path.join(fixtureRoot, 'portable-ai-bus.vsix');
  const vscodeExecutablePath = resolveVSCodeExecutable();
  let failure;
  let leakedCredentialDirs = [];

  try {
    await Promise.all([fs.mkdir(first), fs.mkdir(second), fs.mkdir(userDataDir), fs.mkdir(extensionsDir)]);
    await fs.writeFile(workspace, `${JSON.stringify({ folders: [{ path: first }, { path: second }] }, null, 2)}\n`, 'utf8');
    await publishWatchdogManifest(fixtureRoot, [first, second], sourceRoot);
    const vscePath = path.join(sourceRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
    await runCommand(process.execPath, [vscePath, 'package', '--out', vsixPath], { cwd: sourceRoot });

    const cliScript = await resolveDirectCliScript(vscodeExecutablePath);
    const cliPrefix = [cliScript];
    const profileArgs = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${userDataDir}`];
    await runCommand(vscodeExecutablePath, [...cliPrefix, '--install-extension', vsixPath, '--force', ...profileArgs], {
      cwd: fixtureRoot,
      env: cliEnvironment()
    });
    const inventory = await runCommand(vscodeExecutablePath, [...cliPrefix, '--list-extensions', '--show-versions', ...profileArgs], {
      cwd: fixtureRoot,
      env: cliEnvironment()
    });
    const manifest = require(path.join(sourceRoot, 'package.json'));
    const expectedInventory = `${manifest.publisher}.${manifest.name}@${manifest.version}`.toLowerCase();
    const installed = inventory.stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
    assert.deepEqual(installed, [expectedInventory], 'isolated VS Code profile must contain exactly the packaged bus');

    const code = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: path.join(sourceRoot, 'tests', 'vscode-driver'),
      extensionTestsPath: path.join(sourceRoot, 'tests', 'vscode-integration.js'),
      launchArgs: [workspace, ...profileArgs, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
      extensionTestsEnv: {
        PAB_VSCODE_FIXTURE_ROOT: fixtureRoot,
        PAB_VSCODE_SHUTDOWN_STATE: shutdownState,
        PAB_NODE_EXECUTABLE: process.execPath,
        PAB_EXPECT_INSTALLED: '1',
        PAB_EXPECT_EXTENSIONS_DIR: extensionsDir,
        PAB_SOURCE_ROOT: sourceRoot,
        ELECTRON_RUN_AS_NODE: undefined,
        VSCODE_DEV: undefined
      }
    });
    if (code !== 0) throw new Error(`VS Code integration process exited ${code}.`);
    const state = JSON.parse(await fs.readFile(shutdownState, 'utf8'));
    await Promise.all([assertMissing(state.endpointPath), assertMissing(state.lockPath), assertMissing(state.credentialDir)]);
    assert.equal(await canConnect(state.port), false, 'deactivated installed harness port must refuse connections');
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    try {
      leakedCredentialDirs = await cleanFixtureCredentialParents([first, second], sourceRoot);
    } catch (error) {
      failure = combineFailures(failure, error, 'credential cleanup failed');
    } finally {
      try {
        await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      } catch (error) {
        failure = combineFailures(failure, error, 'fixture cleanup failed');
      }
    }
  }

  if (leakedCredentialDirs.length > 0 && !failure) {
    failure = new Error(`Installed VSIX leaked harness credentials: ${leakedCredentialDirs.join(', ')}`);
  }
  if (failure) {
    if (leakedCredentialDirs.length > 0) failure.message += `\nEmergency cleanup removed: ${leakedCredentialDirs.join(', ')}`;
    throw failure;
  }
}

async function publishWatchdogManifest(fixtureRoot, roots, sourceRoot) {
  const destination = process.env.PAB_WATCHDOG_CLEANUP_MANIFEST;
  if (!destination) return;
  let credentialParents = [];
  if (roots.length > 0) {
    const { credentialWorkspaceKey } = require(path.join(sourceRoot, 'dist', 'workspace-key.js'));
    const credentialsBase = path.resolve(os.homedir(), '.portable-ai-bus', 'credentials');
    credentialParents = roots.map((root) => path.join(credentialsBase, credentialWorkspaceKey(root)));
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ fixtureRoot, credentialParents }, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, destination);
}

async function resolveDirectCliScript(vscodeExecutablePath) {
  const installRoot = path.dirname(vscodeExecutablePath);
  const candidates = [
    path.join(installRoot, 'resources', 'app', 'out', 'cli.js'),
    path.resolve(installRoot, '..', 'Resources', 'app', 'out', 'cli.js')
  ];
  for (const entry of await fs.readdir(installRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.push(path.join(installRoot, entry.name, 'resources', 'app', 'out', 'cli.js'));
  }
  for (const candidate of candidates) {
    if (await fs.access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error(`Could not locate VS Code cli.js beneath ${installRoot}.`);
}

function resolveVSCodeExecutable() {
  const executable = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')
    : undefined);
  if (!executable) throw new Error('Set VSCODE_EXECUTABLE_PATH to an installed VS Code executable.');
  return executable;
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanElectronEnvironment(),
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr}\n${stdout}`));
    });
  });
}

function cleanElectronEnvironment() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_DEV;
  return env;
}

function cliEnvironment() {
  return { ...cleanElectronEnvironment(), ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' };
}

async function cleanFixtureCredentialParents(roots, sourceRoot) {
  const { credentialWorkspaceKey } = require(path.join(sourceRoot, 'dist', 'workspace-key.js'));
  const credentialsBase = path.resolve(os.homedir(), '.portable-ai-bus', 'credentials');
  const removed = [];
  for (const root of roots) {
    const parent = path.resolve(credentialsBase, credentialWorkspaceKey(root));
    if (path.dirname(parent) !== credentialsBase) throw new Error(`Unsafe credential cleanup target: ${parent}`);
    const entries = await fs.readdir(parent).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    if (entries.length > 0) removed.push(parent);
    await fs.rm(parent, { recursive: true, force: true });
  }
  return removed;
}

function combineFailures(existing, next, label) {
  const normalized = next instanceof Error ? next : new Error(String(next));
  return existing ? new AggregateError([existing, normalized], label) : normalized;
}

async function assertMissing(candidate) {
  await assert.rejects(fs.access(candidate), { code: 'ENOENT' });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
