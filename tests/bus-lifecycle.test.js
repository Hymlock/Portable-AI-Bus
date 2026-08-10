const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  bootstrapCoordinationRoot,
  identifyNodeProcess,
  optionFromCommandLine,
  processesForRoot,
  samePath
} = require('../scripts/bus-processes.js');

test('process identity parser keeps root, workdir, seat, and brain distinct', () => {
  const command = 'node "C:\\kit path\\dist\\brain\\cli.js" --root "C:\\bus root" --workdir "D:\\repo path" --seat grok --brain "C:\\kit path\\brains\\agent-seat.js"';
  assert.equal(optionFromCommandLine(command, '--root'), 'C:\\bus root');
  const identity = identifyNodeProcess({ pid: 42, commandLine: command });
  assert.equal(identity.type, 'brain');
  assert.equal(identity.seat, 'grok');
  assert.equal(identity.root, 'C:\\bus root');
  assert.equal(identity.workdir, 'D:\\repo path');
});

test('exact-root selection never captures a same-seat process from another Bus', () => {
  const first = identifyNodeProcess({
    pid: 10,
    commandLine: 'node C:\\kit\\dist\\brain\\cli.js --root C:\\bus-a --workdir C:\\repo-a --seat codex --brain C:\\kit\\brains\\agent-seat.js'
  });
  const second = identifyNodeProcess({
    pid: 11,
    commandLine: 'node C:\\kit\\dist\\brain\\cli.js --root C:\\bus-b --workdir C:\\repo-b --seat codex --brain C:\\kit\\brains\\agent-seat.js'
  });
  assert.deepEqual(processesForRoot([first, second], 'C:\\bus-a').map((item) => item.pid), [10]);
  assert.equal(samePath(first.workdir, 'C:\\repo-a'), true);
  assert.equal(samePath(first.workdir, second.workdir), false);
});

test('canonical path equality resolves trailing separators and directory links', async (t) => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-canonical-'));
  const target = path.join(fixture, 'target');
  const alias = path.join(fixture, 'alias');
  await fsp.mkdir(target);
  await fsp.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fsp.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  assert.equal(samePath(`${target}${path.sep}`, alias), true);
});

test('coordination bootstrap installs missing config and bins without overwriting operator config', async (t) => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-lifecycle-'));
  const repo = path.join(fixture, 'repo');
  const root = path.join(fixture, 'root');
  for (const relative of ['templates', 'dist', 'dist/adapters']) {
    await fsp.mkdir(path.join(repo, relative), { recursive: true });
  }
  await fsp.mkdir(root);
  await fsp.writeFile(path.join(repo, 'templates', 'capabilities.json'), '{"version":1,"capabilities":[]}');
  await fsp.writeFile(path.join(repo, 'dist', 'mailbox.js'), 'mailbox');
  await fsp.writeFile(path.join(repo, 'dist', 'capabilities.js'), 'capabilities');
  await fsp.writeFile(path.join(repo, 'dist', 'harness.js'), 'harness');
  await fsp.writeFile(path.join(repo, 'dist', 'worker-client.js'), 'worker-client');
  await fsp.writeFile(path.join(repo, 'dist', 'workspace-key.js'), 'workspace-key');
  await fsp.writeFile(path.join(repo, 'dist', 'adapters', 'skse-devkit.js'), 'adapter');
  t.after(() => fsp.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  // Assert the exact SET, not a count. `created.length === 4` passed while `harness.js`,
  // `worker-client.js` and `workspace-key.js` were missing, so every documented
  // `.ai-bus/bin/worker-client.js` command failed with MODULE_NOT_FOUND in a bootstrapped root
  // while the docs and the test both looked satisfied. A count cannot notice a wrong mapping.
  const created = bootstrapCoordinationRoot(repo, root);
  const relative = created.map((p) => path.relative(root, p).split(path.sep).join('/')).sort();
  assert.deepEqual(relative, [
    '.ai-bus/bin/capabilities.js',
    '.ai-bus/bin/harness.js',
    '.ai-bus/bin/mailbox.js',
    '.ai-bus/bin/skse-devkit.js',
    '.ai-bus/bin/worker-client.js',
    '.ai-bus/bin/workspace-key.js',
    '.ai-bus/capabilities.json'
  ]);
  // Contents too: a count-preserving wrong mapping would otherwise pass.
  for (const [file, expected] of [['harness.js', 'harness'], ['worker-client.js', 'worker-client'],
                                  ['workspace-key.js', 'workspace-key']]) {
    assert.equal(fs.readFileSync(path.join(root, '.ai-bus', 'bin', file), 'utf8'), expected,
      `${file} staged from the wrong source`);
  }
  const config = path.join(root, '.ai-bus', 'capabilities.json');
  await fsp.writeFile(config, 'operator-owned');
  assert.deepEqual(bootstrapCoordinationRoot(repo, root), []);
  assert.equal(fs.readFileSync(config, 'utf8'), 'operator-owned');
});

test('coordination bootstrap upgrades only the exact legacy default capability template', async (t) => {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-upgrade-'));
  const repo = path.resolve(__dirname, '..');
  const root = path.join(fixture, 'root');
  await fsp.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  const current = await fsp.readFile(path.join(repo, 'templates', 'capabilities.json'), 'utf8');
  const legacy = current.replace(/\$\{bus\}\/\.ai-bus\/bin/g, '${workspace}/.ai-bus/bin')
    .replace(', "--root", "${bus}"', '');
  await fsp.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), legacy.replace(/\r?\n/g, '\r\n'));
  t.after(() => fsp.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  bootstrapCoordinationRoot(repo, root);
  assert.equal(await fsp.readFile(path.join(root, '.ai-bus', 'capabilities.json'), 'utf8'), current);
});
