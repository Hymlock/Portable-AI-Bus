const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const net = require('node:net');
const { promisify } = require('node:util');
const { credentialWorkspaceKey } = require('../dist/workspace-key.js');
const { WorkspaceBus } = require('../dist/bus.js');

const execFileAsync = promisify(execFile);

async function run() {
  const fixtureRoot = process.env.PAB_VSCODE_FIXTURE_ROOT;
  assert.ok(fixtureRoot, 'PAB_VSCODE_FIXTURE_ROOT is required.');
  const first = path.join(fixtureRoot, 'first');
  const second = path.join(fixtureRoot, 'second');
  const shutdownState = process.env.PAB_VSCODE_SHUTDOWN_STATE;
  assert.ok(shutdownState, 'PAB_VSCODE_SHUTDOWN_STATE is required.');
  if (process.env.PAB_EXPECT_INSTALLED === '1') await assertInstalledExtension();
  await fs.mkdir(path.join(first, 'docs'), { recursive: true });
  await fs.mkdir(path.join(first, '.git', 'info'), { recursive: true });
  await fs.mkdir(path.join(second, '.git', 'info'), { recursive: true });
  await fs.mkdir(path.join(first, '.ai-bus'), { recursive: true });
  await fs.writeFile(path.join(first, 'CLAUDE.md'), 'project-owned claude instructions\n', 'utf8');
  await fs.writeFile(path.join(first, 'docs', 'ai-plan.md'), 'project-owned plan\n', 'utf8');
  await fs.writeFile(path.join(first, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }), 'utf8');
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
    '.ai-bus/bin/workspace-key.js', '.ai-bus/bin/brain/cli.js',
    '.ai-bus/bin/brain/process-host.js', '.ai-bus/brains/agent-seat.js',
    '.ai-bus/scripts/bus-up.js', '.ai-bus/scripts/bus-console.js', '.ai-bus/scripts/bus-tick.js',
    '.ai-bus/node_modules/node-pty/package.json',
    '.ai-bus/node_modules/@anthropic-ai/sdk/package.json',
    '.ai-bus/HUMAN_GUIDE.md', '.ai-bus/OPERATOR.md', '.ai-bus/TESTING.md',
    '.ai-bus/docs/AUTH.md', '.ai-bus/docs/DISTRIBUTION.md'
  ]) {
    await fs.access(path.join(first, relative));
  }
  let manifest = JSON.parse(await fs.readFile(path.join(first, '.ai-bus', 'install-state.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(await fs.readFile(path.join(first, 'CLAUDE.md'), 'utf8'), 'project-owned claude instructions\n');
  assert.equal(await fs.readFile(path.join(first, 'docs', 'ai-plan.md'), 'utf8'), 'project-owned plan\n');
  assert.equal(manifest.installedFiles.includes('CLAUDE.md'), false);
  assert.equal(manifest.installedFiles.includes('docs/ai-plan.md'), false);
  for (const relative of manifest.installedFiles) await fs.access(path.join(first, relative));
  const nodeExecutable = process.env.PAB_NODE_EXECUTABLE;
  assert.ok(nodeExecutable, 'PAB_NODE_EXECUTABLE is required.');
  await execFileAsync(nodeExecutable, [
    '-e', 'for (const file of process.argv.slice(1)) require(file);',
    path.join(first, '.ai-bus', 'bin', 'harness.js'),
    path.join(first, '.ai-bus', 'bin', 'worker-client.js'),
    path.join(first, '.ai-bus', 'bin', 'skse-devkit.js'),
    path.join(first, '.ai-bus', 'bin', 'brain', 'cli.js'),
    path.join(first, '.ai-bus', 'brains', 'agent-seat.js'),
    path.join(first, '.ai-bus', 'node_modules', 'node-pty'),
    path.join(first, '.ai-bus', 'node_modules', '@anthropic-ai', 'sdk')
  ], { windowsHide: true });
  await execFileAsync(nodeExecutable, [path.join(first, '.ai-bus', 'bin', 'ai_bus.js'), 'validate'], { cwd: first, windowsHide: true });
  await execFileAsync(nodeExecutable, [path.join(first, '.ai-bus', 'bin', 'validate_ai_bus.js')], { cwd: first, windowsHide: true });
  await fs.writeFile(path.join(first, 'AGENTS.md'), 'customized bus-created instructions\n', 'utf8');
  await vscode.commands.executeCommand('portableAiBus.initializeWorkspace');
  manifest = JSON.parse(await fs.readFile(path.join(first, '.ai-bus', 'install-state.json'), 'utf8'));
  assert.equal(await fs.readFile(path.join(first, 'AGENTS.md'), 'utf8'), 'customized bus-created instructions\n');
  assert.equal(manifest.installedFiles.includes('AGENTS.md'), true);
  const exclude = await fs.readFile(path.join(first, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /^\.ai-bus\/$/m);
  assert.match(exclude, /^AGENTS\.md$/m);
  assert.doesNotMatch(exclude, /^CLAUDE\.md$/m);
  assert.doesNotMatch(exclude, /^docs\/ai-plan\.md$/m);
  const forgedHash = createHash('sha256').update('project-owned claude instructions\n').digest('hex');
  await fs.writeFile(path.join(first, '.ai-bus', 'install-state.json'), JSON.stringify({
    ...manifest,
    installedFiles: [...manifest.installedFiles, 'CLAUDE.md', '../outside.txt'],
    managedFiles: { ...manifest.managedFiles, 'CLAUDE.md': forgedHash, '../outside.txt': forgedHash }
  }), 'utf8');
  const ownershipPath = path.join(os.homedir(), '.portable-ai-bus', 'ownership', `${credentialWorkspaceKey(first)}.json`);
  const ownershipKey = (await fs.readFile(path.join(os.homedir(), '.portable-ai-bus', 'ownership', 'ledger.key'), 'utf8')).trim();
  const pendingOwnership = JSON.parse(await fs.readFile(ownershipPath, 'utf8'));
  pendingOwnership.pendingInstall = { relativePath: '.vscode/tasks.json', nextHash: 'a'.repeat(64) };
  delete pendingOwnership.mac;
  pendingOwnership.mac = createHmac('sha256', Buffer.from(ownershipKey, 'hex')).update(stableJson(pendingOwnership)).digest('hex');
  await fs.writeFile(ownershipPath, JSON.stringify(pendingOwnership), 'utf8');
  await vscode.commands.executeCommand('portableAiBus.initializeWorkspace');
  assert.equal(JSON.parse(await fs.readFile(ownershipPath, 'utf8')).pendingInstall, undefined);
  const originalOwnership = await fs.readFile(ownershipPath, 'utf8');
  const forgedOwnership = JSON.parse(originalOwnership);
  forgedOwnership.managedFiles['CLAUDE.md'] = forgedHash;
  await fs.writeFile(ownershipPath, JSON.stringify(forgedOwnership), 'utf8');
  await assert.rejects(
    vscode.commands.executeCommand('portableAiBus.suspend'),
    /failed its integrity check/
  );
  assert.equal(await fs.readFile(path.join(first, 'CLAUDE.md'), 'utf8'), 'project-owned claude instructions\n');
  await fs.writeFile(ownershipPath, originalOwnership, 'utf8');
  await config.update('workflow.implementerSeat', 'builder.bot', vscode.ConfigurationTarget.Workspace);
  await waitFor(async () => {
    const workflow = await fs.readFile(path.join(first, '.ai-bus', 'workflow.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    const state = await fs.readFile(path.join(first, '.ai-bus', 'runtime', 'mailbox', 'state.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    return workflow?.roles?.implementer === 'builder.bot' && state?.agents?.includes('builder.bot');
  }, 'workflow role synchronization');
  const mailboxState = JSON.parse(await fs.readFile(path.join(first, '.ai-bus', 'runtime', 'mailbox', 'state.json'), 'utf8'));
  assert.ok(mailboxState.agents.includes('builder.bot'));

  await vscode.commands.executeCommand('portableAiBus.startHarness');
  let endpoint = await readEndpoint(first);
  assert.ok(endpoint.seats.includes('builder.bot'));
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
  await fs.access(path.join(first, 'CLAUDE.md'));
  await fs.access(path.join(first, 'docs', 'ai-plan.md'));
  await waitForMissing(path.join(first, 'AGENTS.md'), 'owned customized overlay after suspend');
  assert.equal(
    await fs.readFile(path.join(first, '.ai-bus', 'runtime', 'suspended-overlay', 'AGENTS.md'), 'utf8'),
    'customized bus-created instructions\n'
  );
  await fs.writeFile(path.join(first, 'AGENTS.md'), 'created while suspended\n', 'utf8');
  await assert.rejects(
    vscode.commands.executeCommand('portableAiBus.resume'),
    /Refusing to overwrite a file created while suspended/
  );
  assert.equal(await fs.readFile(path.join(first, 'AGENTS.md'), 'utf8'), 'created while suspended\n');
  await fs.rm(path.join(first, 'AGENTS.md'));
  await vscode.commands.executeCommand('portableAiBus.resume');
  await waitForMissing(path.join(first, '.ai-bus', 'runtime', 'suspended.json'), 'suspend marker after resume');
  assert.equal(await fs.readFile(path.join(first, 'AGENTS.md'), 'utf8'), 'customized bus-created instructions\n');

  await vscode.commands.executeCommand('portableAiBus.startHarness');
  endpoint = await readEndpoint(first);
  credentialDir = await credentialDirectory(first, endpoint.instanceId);
  assert.equal(vscode.workspace.updateWorkspaceFolders(0, 1), true);
  await assertHarnessStopped(first, endpoint.port, credentialDir, 'workspace-folder removal');

  assert.equal(normalizePath(vscode.workspace.workspaceFolders?.[0].uri.fsPath), normalizePath(second));
  const unsafe = path.join(fixtureRoot, 'unsafe');
  const outside = path.join(fixtureRoot, 'outside');
  await Promise.all([fs.mkdir(unsafe), fs.mkdir(outside)]);
  await fs.writeFile(path.join(outside, 'sentinel.txt'), 'outside must remain unchanged\n', 'utf8');
  await fs.mkdir(path.join(unsafe, '.ai-bus'));
  await fs.symlink(outside, path.join(unsafe, '.ai-bus', 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(outside, path.join(unsafe, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(unsafe) }), true);
  await waitFor(() => normalizePath(vscode.workspace.workspaceFolders?.[0].uri.fsPath) === normalizePath(unsafe), 'unsafe folder insertion');
  await assert.rejects(
    vscode.commands.executeCommand('portableAiBus.initializeWorkspace'),
    /ancestor outside its root/
  );
  assert.equal(await fs.readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'outside must remain unchanged\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(vscode.workspace.updateWorkspaceFolders(0, 1), true);
  await waitFor(() => normalizePath(vscode.workspace.workspaceFolders?.[0].uri.fsPath) === normalizePath(second), 'unsafe folder removal');
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

  await vscode.commands.executeCommand('portableAiBus.stopHarness');
  const devKitMarker = path.join(second, '.ai-bus', 'toolchains', 'skse-devkit', 'operator-owned.txt');
  await fs.mkdir(path.dirname(devKitMarker), { recursive: true });
  await fs.writeFile(devKitMarker, 'operator-owned Dev Kit payload\n', 'utf8');
  // Exercise WorkspaceBus.remove directly so the modal command cannot turn a cancelled
  // confirmation into a false-positive test. Removal does not use ExtensionContext.
  await new WorkspaceBus({}).remove(second);
  assert.equal(await fs.readFile(devKitMarker, 'utf8'), 'operator-owned Dev Kit payload\n');
  await assert.rejects(fs.access(path.join(second, '.ai-bus', 'bin')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(second, '.ai-bus', 'install-state.json')), { code: 'ENOENT' });
  const postRemoveExclude = await fs.readFile(path.join(second, '.git', 'info', 'exclude'), 'utf8');
  assert.match(postRemoveExclude, /^\.ai-bus\/toolchains\/$/m);
  assert.doesNotMatch(postRemoveExclude, /^\.ai-bus\/$/m);
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
    'dist/workspace-key.js', 'dist/brain/cli.js', 'dist/brain/process-host.js',
    'brains/agent-seat.js', 'scripts/bus-up.js', 'scripts/bus-console.js', 'scripts/bus-tick.js',
    'node_modules/node-pty/package.json', 'node_modules/@anthropic-ai/sdk/package.json',
    'bin/validate_ai_bus.js', 'providers/providers.json',
    'docs/AUTH.md', 'docs/DISTRIBUTION.md',
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
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
