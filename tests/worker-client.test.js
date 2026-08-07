const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HarnessServer } = require('../dist/harness.js');
const { waitForMailbox } = require('../dist/worker-client.js');

test('provider-neutral worker client heartbeats and wakes on durable mail', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-worker-client-'));
  const credentialsDir = path.join(root, '.test-credentials');
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  const server = new HarnessServer(root, { credentialsDir });
  await server.mailbox.ensureInitialized(['sender', 'worker']);
  await server.start(0);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });

  const waiting = waitForMailbox({ root, seat: 'worker', timeoutMs: 3000, credentialsDir });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await server.mailbox.send({ from: 'sender', to: 'worker', subject: 'wake', body: 'check your mailbox' });
  const result = await waiting;
  assert.equal(result.wake, 'message');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].subject, 'wake');
  assert.equal((await server.mailbox.status()).unread.worker, 1);
});

test('worker client timeout does not acknowledge mail or mutate rounds', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-worker-timeout-'));
  const credentialsDir = path.join(root, '.test-credentials');
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  const server = new HarnessServer(root, { credentialsDir });
  await server.mailbox.ensureInitialized(['worker']);
  await server.start(0);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const result = await waitForMailbox({ root, seat: 'worker', timeoutMs: 50, credentialsDir });
  assert.equal(result.wake, 'timeout');
  assert.deepEqual(result.messages, []);
  assert.equal((await server.mailbox.status()).round, 0);
});
