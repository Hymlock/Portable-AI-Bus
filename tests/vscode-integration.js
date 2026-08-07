const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const net = require('node:net');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

async function run() {
  const fixtureRoot = process.env.PAB_VSCODE_FIXTURE_ROOT;
  assert.ok(fixtureRoot, 'PAB_VSCODE_FIXTURE_ROOT is required.');
  const first = path.join(fixtureRoot, 'first');
  const second = path.join(fixtureRoot, 'second');
  const shutdownState = process.env.PAB_VSCODE_SHUTDOWN_STATE;
  assert.ok(shutdownState, 'PAB_VSCODE_SHUTDOWN_STATE is required.');
  if (process.env.PAB_EXPECT_INSTALLED === '1') await assertInstalledExtension();
  await waitFor(() => vscode.workspace.workspaceFolders?.length === 2, 'two workspace folders');
  const config = vscode.workspace.getConfiguration('portableAiBus');
  await Promise.all([
    config.update('harness.autoStart', false, vscode.ConfigurationTarget.Workspace),
    config.update('reminders.notifyUnread', false, vscode.ConfigurationTarget.Workspace),
    config.update('reminders.notifyStaleWorkers', false, vscode.ConfigurationTarget.Workspace)
  ]);

  await vscode.commands.executeCommand('portableAiBus.initializeWorkspace');
  for (const relative of [
    '.ai-bus/bin/mailbox.js', '.ai-bus/bin/harness.js', '.ai-bus/bin/worker-client.js',
    '.ai-bus/bin/workspace-key.js',
    '.ai-bus/HUMAN_GUIDE.md', '.ai-bus/OPERATOR.md', '.ai-bus/TESTING.md'
  ]) {
    await fs.access(path.join(first, relative));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(first, '.ai-bus', 'install-state.json'), 'utf8'));
  for (const relative of manifest.installedFiles) await fs.access(path.join(first, relative));
  const nodeExecutable = process.env.PAB_NODE_EXECUTABLE;
  assert.ok(nodeExecutable, 'PAB_NODE_EXECUTABLE is required.');
  await execFileAsync(nodeExecutable, [
    '-e', 'require(process.argv[1]); require(process.argv[2]); require(process.argv[3]);',
    path.join(first, '.ai-bus', 'bin', 'harness.js'),
    path.join(first, '.ai-bus', 'bin', 'worker-client.js'),
    path.join(first, '.ai-bus', 'bin', 'skse-devkit.js')
  ], { windowsHide: true });
  await execFileAsync(nodeExecutable, [path.join(first, '.ai-bus', 'bin', 'ai_bus.js'), 'validate'], { cwd: first, windowsHide: true });
  await execFileAsync(nodeExecutable, [path.join(first, '.ai-bus', 'bin', 'validate_ai_bus.js')], { cwd: first, windowsHide: true });

  await vscode.commands.executeCommand('portableAiBus.startHarness');
  let endpoint = await readEndpoint(first);
  let status = await authenticatedStatus(first, endpoint);
  assert.equal(status.ok, true);
  assert.equal(status.workerLeases.instanceId, endpoint.instanceId);
  let credentialDir = await credentialDirectory(first, endpoint.instanceId);

  await vscode.commands.executeCommand('portableAiBus.stopHarness');
  await assertHarnessStopped(first, endpoint.port, credentialDir, 'explicit stop');

  await vscode.commands.executeCommand('portableAiBus.startHarness');
  endpoint = await readEndpoint(first);
  credentialDir = await credentialDirectory(first, endpoint.instanceId);

  await vscode.commands.executeCommand('portableAiBus.suspend');
  await assertHarnessStopped(first, endpoint.port, credentialDir, 'suspend');
  await fs.access(path.join(first, '.ai-bus', 'runtime', 'suspended.json'));
  const suspendedExample = manifest.installedFiles[0];
  await waitForMissing(path.join(first, suspendedExample), 'installed overlay after suspend');
  await fs.access(path.join(first, '.ai-bus', 'runtime', 'suspended-overlay', suspendedExample));
  await vscode.commands.executeCommand('portableAiBus.resume');
  await waitForMissing(path.join(first, '.ai-bus', 'runtime', 'suspended.json'), 'suspend marker after resume');
  await fs.access(path.join(first, suspendedExample));

  await vscode.commands.executeCommand('portableAiBus.startHarness');
  endpoint = await readEndpoint(first);
  credentialDir = await credentialDirectory(first, endpoint.instanceId);
  assert.equal(vscode.workspace.updateWorkspaceFolders(0, 1), true);
  await assertHarnessStopped(first, endpoint.port, credentialDir, 'workspace-folder removal');

  assert.equal(normalizePath(vscode.workspace.workspaceFolders?.[0].uri.fsPath), normalizePath(second));
  await vscode.commands.executeCommand('portableAiBus.initializeWorkspace');
  await vscode.commands.executeCommand('portableAiBus.startHarness');
  endpoint = await readEndpoint(second);
  status = await authenticatedStatus(second, endpoint);
  assert.equal(status.ok, true);
  assert.equal(status.workerLeases.instanceId, endpoint.instanceId);
  credentialDir = await credentialDirectory(second, endpoint.instanceId);
  await fs.writeFile(shutdownState, `${JSON.stringify({
    endpointPath: endpointPath(second),
    lockPath: path.join(second, '.ai-bus', 'runtime', 'harness', 'server.lock'),
    credentialDir,
    port: endpoint.port
  }, null, 2)}\n`, 'utf8');
  console.log('Portable AI Bus VS Code integration smoke passed.');
}

async function assertInstalledExtension() {
  const extension = vscode.extensions.getExtension('local-dev.portable-ai-bus');
  assert.ok(extension, 'installed Portable AI Bus extension must be discoverable');
  const extensionsDir = process.env.PAB_EXPECT_EXTENSIONS_DIR;
  const sourceRoot = process.env.PAB_SOURCE_ROOT;
  assert.ok(extensionsDir && sourceRoot, 'installed smoke requires expected path variables');
  assert.equal(await isPathInside(extensionsDir, extension.extensionPath), true, 'extension must load from isolated extensions directory');
  assert.notEqual(normalizePath(extension.extensionPath), normalizePath(sourceRoot), 'installed smoke must not load the source checkout');
  for (const relative of [
    'dist/extension.js', 'dist/harness.js', 'dist/mailbox.js', 'dist/worker-client.js',
    'dist/workspace-key.js', 'bin/validate_ai_bus.js', 'providers/providers.json',
    'templates/capabilities.json', 'templates/providers/claude/CLAUDE.md',
    'templates/providers/codex/AGENTS.md', 'templates/providers/grok/GROK.md'
  ]) {
    await fs.access(path.join(extension.extensionPath, relative));
  }
  await extension.activate();
}

async function isPathInside(parent, child) {
  const canonicalParent = normalizePath(await fs.realpath(parent));
  const canonicalChild = normalizePath(await fs.realpath(child));
  return canonicalChild.startsWith(`${canonicalParent}${path.sep}`);
}

function endpointPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json');
}

async function readEndpoint(root) {
  let endpoint;
  await waitFor(async () => {
    endpoint = await fs.readFile(endpointPath(root), 'utf8').then(JSON.parse).catch(() => undefined);
    return Boolean(endpoint);
  }, `harness endpoint under ${root}`);
  return endpoint;
}

async function authenticatedStatus(root, endpoint) {
  const credentialDir = await credentialDirectory(root, endpoint.instanceId);
  const tokenPath = path.join(credentialDir, 'operator.token');
  const token = (await fs.readFile(tokenPath, 'utf8')).trim();
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/status`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return response.json();
}

async function credentialDirectory(root, instanceId) {
  const canonical = await fs.realpath(root);
  const identity = await fs.stat(canonical, { bigint: true });
  assert.notEqual(identity.ino, 0n, 'workspace filesystem must expose a stable directory identity');
  const material = `filesystem-v1:${identity.dev}:${identity.ino}`;
  const workspaceKey = createHash('sha256').update(material).digest('hex').slice(0, 24);
  const directory = path.join(os.homedir(), '.portable-ai-bus', 'credentials', workspaceKey, instanceId);
  const ledger = process.env.PAB_VSCODE_CREDENTIAL_LEDGER;
  if (ledger) await fs.appendFile(ledger, `${JSON.stringify({ directory })}\n`, 'utf8');
  return directory;
}

async function assertHarnessStopped(root, port, credentialDir, label) {
  await Promise.all([
    waitForMissing(endpointPath(root), `endpoint after ${label}`),
    waitForMissing(path.join(root, '.ai-bus', 'runtime', 'harness', 'server.lock'), `lock after ${label}`),
    waitForMissing(credentialDir, `credentials after ${label}`),
    waitFor(async () => !(await canConnect(port)), `connection refusal after ${label}`)
  ]);
}

async function waitForMissing(candidate, label) {
  await waitFor(() => fs.access(candidate).then(() => false, () => true), label);
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

module.exports = { run };

function normalizePath(value) {
  const resolved = path.resolve(value || '');
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}
