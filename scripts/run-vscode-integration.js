const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { runTests, downloadAndUnzipVSCode } = require('@vscode/test-electron');
// `@vscode/test-electron` can download a matching VS Code itself. The scripts previously
// REQUIRED an already-installed editor and, off Windows, had no fallback at all - so
// `npm run test:vscode` threw "Set VSCODE_EXECUTABLE_PATH..." on any Linux or macOS machine,
// including CI. The first dispatch of the VS Code job failed exactly this way.
//
// Honouring the env var first keeps the fast path for anyone who already has an editor and
// does not want a second copy downloaded; falling back to the download makes the tier
// self-contained everywhere else. Found by the distribution sweep, 2026-08-07.
async function resolveOrDownloadVSCode() {
  const explicit = process.env.VSCODE_EXECUTABLE_PATH || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe')
    : undefined);
  if (explicit && existsSync(explicit)) return explicit;
  return downloadAndUnzipVSCode();
}


async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-vscode-'));
  const first = path.join(fixtureRoot, 'first');
  const second = path.join(fixtureRoot, 'second');
  const workspace = path.join(fixtureRoot, 'integration.code-workspace');
  const shutdownState = path.join(fixtureRoot, 'shutdown-state.json');
  const userDataDir = path.join(fixtureRoot, 'user-data');
  const extensionsDir = path.join(fixtureRoot, 'extensions');
  const originalCwd = process.cwd();
  let changedDirectory = false;
  let failure;
  let leakedCredentialDirs = [];
  try {
    await Promise.all([fs.mkdir(first), fs.mkdir(second)]);
    await fs.writeFile(workspace, `${JSON.stringify({ folders: [{ path: first }, { path: second }] }, null, 2)}\n`, 'utf8');
    await publishWatchdogManifest(fixtureRoot, [first, second], extensionDevelopmentPath);
    const vscodeExecutablePath = await resolveOrDownloadVSCode();
    process.chdir(fixtureRoot);
    changedDirectory = true;
    const code = await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath: path.join(extensionDevelopmentPath, 'tests', 'vscode-integration.js'),
      launchArgs: [workspace, `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
      extensionTestsEnv: {
        PAB_VSCODE_FIXTURE_ROOT: fixtureRoot,
        PAB_VSCODE_SHUTDOWN_STATE: shutdownState,
        PAB_NODE_EXECUTABLE: process.execPath,
        ELECTRON_RUN_AS_NODE: undefined,
        VSCODE_DEV: undefined
      }
    });
    if (code !== 0) throw new Error(`VS Code integration process exited ${code}.`);
    const state = JSON.parse(await fs.readFile(shutdownState, 'utf8'));
    await Promise.all([
      assertMissing(state.endpointPath),
      assertMissing(state.lockPath),
      assertMissing(state.credentialDir)
    ]);
    assert.equal(await canConnect(state.port), false, 'deactivated harness port must refuse connections');
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (changedDirectory) process.chdir(originalCwd);
    try {
      leakedCredentialDirs = await cleanFixtureCredentialParents([first, second], extensionDevelopmentPath);
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
    failure = new Error(`Source smoke leaked harness credentials: ${leakedCredentialDirs.join(', ')}`);
  }
  if (failure) {
    if (leakedCredentialDirs.length > 0) failure.message += `\nEmergency cleanup removed: ${leakedCredentialDirs.join(', ')}`;
    throw failure;
  }
}

async function publishWatchdogManifest(fixtureRoot, roots, sourceRoot) {
  const destination = process.env.PAB_WATCHDOG_CLEANUP_MANIFEST;
  if (!destination) return;
  const { credentialWorkspaceKey } = require(path.join(sourceRoot, 'dist', 'workspace-key.js'));
  const credentialsBase = path.resolve(os.homedir(), '.portable-ai-bus', 'credentials');
  const credentialParents = roots.map((root) => path.join(credentialsBase, credentialWorkspaceKey(root)));
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify({ fixtureRoot, credentialParents }, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, destination);
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
