const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { CapabilityRunner } = require('../dist/capabilities.js');

async function workspace(capabilities) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-cap-'));
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.ai-bus', 'capabilities.json'),
    JSON.stringify({ version: 1, capabilities }),
    'utf8'
  );
  return root;
}

test('capability runner uses argv without shell interpretation and writes a receipt', async (t) => {
  const root = await workspace([
    {
      id: 'literal',
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv[1])', 'hello; echo INJECTED'],
      timeoutMs: 5000
    }
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await new CapabilityRunner(root).run('literal');
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.stdout.tail, 'hello; echo INJECTED');
  assert.equal(receipt.command.executable, process.execPath);
  assert.equal(receipt.command.args[2], 'hello; echo INJECTED');
  const latest = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'receipts', 'latest.json'), 'utf8'));
  assert.equal(latest.runId, receipt.runId);
});

test('central config and receipts can be separated from the capability worktree', async (t) => {
  const coordinationRoot = await workspace([{
    id: 'where',
    command: process.execPath,
    args: ['-e', 'process.stdout.write(process.cwd())'],
    cwd: '${workspace}',
    timeoutMs: 5000
  }]);
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-workdir-'));
  const script = path.join(coordinationRoot, 'where.cjs');
  await fs.writeFile(script, 'process.stdout.write(process.cwd())', 'utf8');
  await fs.writeFile(path.join(coordinationRoot, '.ai-bus', 'capabilities.json'), JSON.stringify({
    version: 1,
    capabilities: [{ id: 'where', command: process.execPath, args: ['${bus}/where.cjs'], cwd: '${workspace}', timeoutMs: 5000 }]
  }), 'utf8');
  t.after(async () => {
    await fs.rm(coordinationRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await fs.rm(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const runner = new CapabilityRunner(workdir, { configRoot: coordinationRoot });
  const receipt = await runner.run('where');
  assert.equal(path.resolve(receipt.stdout.tail), path.resolve(workdir));
  assert.equal(receipt.command.args[0], '${bus}/where.cjs');
  await fs.access(path.join(coordinationRoot, '.ai-bus', 'runtime', 'receipts', 'latest.json'));
  await assert.rejects(fs.access(path.join(workdir, '.ai-bus', 'runtime', 'receipts', 'latest.json')));
});

test('capability output and command metadata redact common secrets', async (t) => {
  const root = await workspace([
    {
      id: 'redact',
      command: process.execPath,
      args: ['-e', 'process.stdout.write("Bearer abc.def password=hunter2")'],
      timeoutMs: 5000
    }
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await new CapabilityRunner(root).run('redact');
  assert.equal(receipt.stdout.tail, 'Bearer [REDACTED] password=[REDACTED]');
});

test('capability working directory cannot escape unless explicitly allowed', async (t) => {
  const root = await workspace([{ id: 'escape', command: process.execPath, args: ['--version'], cwd: '..' }]);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await assert.rejects(() => new CapabilityRunner(root).run('escape'), /escapes the workspace/);
});

test('capability receipts cannot be redirected through a symbolic link', async (t) => {
  const root = await workspace([{ id: 'safe-receipt', command: process.execPath, args: ['--version'] }]);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-receipts-outside-'));
  await fs.mkdir(path.join(root, '.ai-bus', 'runtime'), { recursive: true });
  await fs.symlink(outside, path.join(root, '.ai-bus', 'runtime', 'receipts'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await assert.rejects(() => new CapabilityRunner(root).run('safe-receipt'), /symbolic link or junction/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('capability timeout is recorded and returned as failure evidence', async (t) => {
  const root = await workspace([
    { id: 'slow', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 }
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await new CapabilityRunner(root).run('slow');
  assert.equal(receipt.status, 'timed_out');
  assert.equal(receipt.timedOut, true);
});

test('capability cancellation terminates the owned process and records cancellation', async (t) => {
  const root = await workspace([
    { id: 'cancel', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5000 }
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const receipt = await new CapabilityRunner(root).run('cancel', { signal: controller.signal });
  assert.equal(receipt.status, 'cancelled');
  assert.equal(receipt.cancelled, true);
  assert.equal(receipt.timedOut, false);
  assert.ok(receipt.durationMs < 3000);
});

test('capability child receives a minimal environment unless names are explicitly inherited', async (t) => {
  const secretName = 'PORTABLE_AI_BUS_TEST_SECRET';
  process.env[secretName] = 'must-not-leak';
  const root = await workspace([
    { id: 'env', command: process.execPath, args: ['-e', `process.stdout.write(process.env.${secretName} || "absent")`], timeoutMs: 5000 }
  ]);
  t.after(async () => { delete process.env[secretName]; await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const receipt = await new CapabilityRunner(root).run('env');
  assert.equal(receipt.stdout.tail, 'absent');
});

test('capability child receives an explicitly inherited dev-kit root without leaking unrelated values', async (t) => {
  const kitName = 'SKSE_DEVKIT_ROOT';
  const secretName = 'PORTABLE_AI_BUS_UNRELATED_SECRET';
  process.env[kitName] = path.join(os.tmpdir(), 'configured-skse-kit');
  process.env[secretName] = 'must-not-leak';
  const root = await workspace([{
    id: 'devkit-env',
    command: process.execPath,
    args: ['-e', `process.stdout.write(JSON.stringify({ kit: process.env.${kitName}, secret: process.env.${secretName} || null }))`],
    inheritEnv: [kitName],
    timeoutMs: 5000
  }]);
  t.after(async () => {
    delete process.env[kitName];
    delete process.env[secretName];
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const receipt = await new CapabilityRunner(root).run('devkit-env');
  assert.deepEqual(JSON.parse(receipt.stdout.tail), { kit: process.env[kitName], secret: null });
});

test('shipped capability template exposes a fixed safe Dev Kit workflow to every registered seat', async () => {
  const template = JSON.parse(await fs.readFile(path.resolve(__dirname, '..', 'templates', 'capabilities.json'), 'utf8'));
  const byId = new Map(template.capabilities.map((item) => [item.id, item]));
  for (const id of [
    'skse.doctor', 'skse.configure', 'skse.build', 'skse.test',
    'skse.validate-artifacts', 'skse.search.plugin-entrypoint'
  ]) {
    const capability = byId.get(id);
    assert.ok(capability, `missing ${id}`);
    assert.deepEqual(capability.allowedSeats, ['*']);
    assert.equal(capability.command, 'node');
    assert.ok(capability.args.includes('${bus}/.ai-bus/bin/skse-devkit.js'));
  }
  assert.deepEqual(byId.get('bus.doctor').args.slice(-2), ['--root', '${bus}']);
  for (const id of ['skse.doctor', 'skse.configure', 'skse.build', 'skse.test']) {
    assert.ok(byId.get(id).inheritEnv.includes('SKSE_DEVKIT_ROOT'));
    assert.ok(byId.get(id).inheritEnv.includes('VCPKG_ROOT'));
    assert.ok(byId.get(id).inheritEnv.includes('INCLUDE'));
    assert.ok(byId.get(id).inheritEnv.includes('LIB'));
  }
});

test('timeout terminates descendants in the owned process tree', async (t) => {
  const root = await workspace([]);
  const marker = path.join(root, 'grandchild-survived.txt');
  const childCode = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad'), 900)`;
  const parentCode = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
  await fs.writeFile(
    path.join(root, '.ai-bus', 'capabilities.json'),
    JSON.stringify({ version: 1, capabilities: [{ id: 'tree', command: process.execPath, args: ['-e', parentCode], timeoutMs: 150 }] }),
    'utf8'
  );
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const receipt = await new CapabilityRunner(root).run('tree');
  assert.equal(receipt.status, 'timed_out');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(() => fs.access(marker));
});
