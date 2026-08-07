const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
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
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipt = await new CapabilityRunner(root).run('literal');
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.stdout.tail, 'hello; echo INJECTED');
  assert.equal(receipt.command.executable, process.execPath);
  assert.equal(receipt.command.args[2], 'hello; echo INJECTED');
  const latest = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'receipts', 'latest.json'), 'utf8'));
  assert.equal(latest.runId, receipt.runId);
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
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipt = await new CapabilityRunner(root).run('redact');
  assert.equal(receipt.stdout.tail, 'Bearer [REDACTED] password=[REDACTED]');
});

test('capability working directory cannot escape unless explicitly allowed', async (t) => {
  const root = await workspace([{ id: 'escape', command: process.execPath, args: ['--version'], cwd: '..' }]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(() => new CapabilityRunner(root).run('escape'), /escapes the workspace/);
});

test('capability receipts cannot be redirected through a symbolic link', async (t) => {
  const root = await workspace([{ id: 'safe-receipt', command: process.execPath, args: ['--version'] }]);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-receipts-outside-'));
  await fs.mkdir(path.join(root, '.ai-bus', 'runtime'), { recursive: true });
  await fs.symlink(outside, path.join(root, '.ai-bus', 'runtime', 'receipts'), process.platform === 'win32' ? 'junction' : 'dir');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await assert.rejects(() => new CapabilityRunner(root).run('safe-receipt'), /symbolic link or junction/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('capability timeout is recorded and returned as failure evidence', async (t) => {
  const root = await workspace([
    { id: 'slow', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 150 }
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipt = await new CapabilityRunner(root).run('slow');
  assert.equal(receipt.status, 'timed_out');
  assert.equal(receipt.timedOut, true);
});

test('capability cancellation terminates the owned process and records cancellation', async (t) => {
  const root = await workspace([
    { id: 'cancel', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 5000 }
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  t.after(async () => { delete process.env[secretName]; await fs.rm(root, { recursive: true, force: true }); });
  const receipt = await new CapabilityRunner(root).run('env');
  assert.equal(receipt.stdout.tail, 'absent');
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
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipt = await new CapabilityRunner(root).run('tree');
  assert.equal(receipt.status, 'timed_out');
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(() => fs.access(marker));
});
