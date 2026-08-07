const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HarnessServer } = require('../dist/harness.js');

async function setup(agents = [], maxRounds = 20) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-harness-'));
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.ai-bus', 'capabilities.json'),
    JSON.stringify({ version: 1, capabilities: [] }),
    'utf8'
  );
  const server = new HarnessServer(root, {
    token: 'test-token',
    seatTokens: Object.fromEntries(agents.map((agent) => [agent, `test-${agent}-token`])),
    credentialsDir: path.join(root, '.credentials')
  });
  await server.mailbox.ensureInitialized(agents, maxRounds);
  const endpoint = await server.start(0);
  const request = async (pathname, init = {}) => {
    const response = await fetch(`http://${endpoint.host}:${endpoint.port}${pathname}`, {
      ...init,
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json', ...(init.headers || {}) }
    });
    return { status: response.status, body: await response.json() };
  };
  return { root, server, request };
}

test('harness rejects unauthenticated clients and exposes provider-neutral tools', async (t) => {
  const { root, server, request } = await setup();
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const denied = await fetch(`http://127.0.0.1:${endpoint.port}/v1/tools`);
  assert.equal(denied.status, 401);
  const tools = await request('/v1/tools');
  assert.equal(tools.status, 200);
  assert.ok(tools.body.tools.some((item) => item.name === 'capability_run'));
  assert.ok(tools.body.tools.some((item) => item.name === 'mailbox_send'));
});

test('harness request ids make repeated send requests idempotent', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const payload = {
    requestId: 'same-request',
    name: 'mailbox_send',
    input: { from: 'codex', to: 'grok', kind: 'note', subject: 'hello', body: 'one durable message' }
  };
  const first = await request('/v1/tool', { method: 'POST', body: JSON.stringify(payload) });
  const second = await request('/v1/tool', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.body.result.seq, second.body.result.seq);
  const inbox = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'peek', name: 'mailbox_inbox', input: { agent: 'grok', all: true } })
  });
  assert.equal(inbox.body.result.length, 1);
});

test('concurrent duplicate request ids execute only once', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const payload = {
    requestId: 'concurrent-same-request',
    name: 'mailbox_send',
    input: { from: 'codex', to: 'grok', subject: 'race', body: 'exactly once' }
  };
  const results = await Promise.all(
    Array.from({ length: 12 }, () => request('/v1/tool', { method: 'POST', body: JSON.stringify(payload) }))
  );
  assert.ok(results.every((result) => result.status === 200));
  assert.equal(new Set(results.map((result) => result.body.result.seq)).size, 1);
  assert.equal((await server.mailbox.inbox('grok')).length, 1);
});

test('harness wake long-poll returns an addressed message without acknowledging it', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const waiting = request('/v1/wake?agent=grok&timeoutMs=3000');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({
      requestId: 'wake-send',
      name: 'mailbox_send',
      input: { from: 'codex', to: 'grok', subject: 'wake', body: 'work waiting' }
    })
  });
  const result = await waiting;
  assert.equal(result.body.wake, 'message');
  assert.equal(result.body.messages.length, 1);
  const status = await request('/v1/status');
  assert.equal(status.body.mailbox.unread.grok, 1);
});

test('seat credentials cannot impersonate or acknowledge another seat', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const asCodex = async (pathname, body) => {
    const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
    const response = await fetch(`http://127.0.0.1:${endpoint.port}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: 'Bearer test-codex-token', 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  const forged = await asCodex('/v1/tool', {
    requestId: 'forged-send',
    name: 'mailbox_send',
    input: { from: 'grok', to: 'codex', subject: 'forged', body: 'no' }
  });
  assert.equal(forged.status, 403);
  const crossRead = await asCodex('/v1/tool', {
    requestId: 'cross-read',
    name: 'mailbox_read',
    input: { agent: 'grok', all: true }
  });
  assert.equal(crossRead.status, 403);
  const ownSend = await asCodex('/v1/tool', {
    requestId: 'own-send',
    name: 'mailbox_send',
    input: { from: 'codex', to: 'grok', subject: 'valid', body: 'yes' }
  });
  assert.equal(ownSend.status, 200);
});

test('request id reuse with different input is rejected and completed requests survive restart', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  const payload = {
    requestId: 'durable-id',
    name: 'mailbox_send',
    input: { from: 'codex', to: 'grok', subject: 'once', body: 'durable' }
  };
  const first = await request('/v1/tool', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(first.status, 200);
  const mismatch = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ ...payload, name: 'mailbox_status', input: {} })
  });
  assert.equal(mismatch.status, 409);
  await server.stop();

  const restarted = new HarnessServer(root, { token: 'new-token', credentialsDir: path.join(root, '.credentials') });
  const endpoint = await restarted.start(0);
  t.after(async () => { await restarted.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const response = await fetch(`http://${endpoint.host}:${endpoint.port}/v1/tool`, {
    method: 'POST',
    headers: { authorization: 'Bearer new-token', 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const replay = await response.json();
  assert.equal(response.status, 200);
  assert.equal(replay.result.seq, first.body.result.seq);
  assert.equal((await restarted.mailbox.inbox('grok')).length, 1);
});

test('workspace singleton lock prevents a second server from replacing live credentials', async (t) => {
  const { root, server } = await setup();
  const second = new HarnessServer(root, { token: 'second-token', credentialsDir: path.join(root, '.credentials') });
  t.after(async () => { await server.stop(); await second.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await assert.rejects(() => second.start(0), /already owns this workspace/);
  assert.equal(await fs.readFile(server.tokenPath, 'utf8'), 'test-token\n');
});

test('halt blocks claim and release mutations', async (t) => {
  const { root, server, request } = await setup(['codex']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await server.mailbox.claim({ agent: 'codex', paths: ['src/held.ts'] });
  await server.mailbox.halt('test guard');

  const claim = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'halted-claim', name: 'mailbox_claim', input: { agent: 'codex', paths: ['src/new.ts'] } })
  });
  const release = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'halted-release', name: 'mailbox_release', input: { agent: 'codex', paths: ['src/held.ts'] } })
  });
  assert.equal(claim.status, 423);
  assert.equal(release.status, 423);
  assert.deepEqual((await server.mailbox.claims()).codex.map((item) => item.path), ['src/held.ts']);
});

test('round cap blocks mutations before a second send flips halted state', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok'], 1);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  await server.mailbox.send({ from: 'codex', to: 'grok', subject: 'one', body: 'reaches cap' });
  assert.equal((await server.mailbox.status()).halted, false);
  const claim = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'capped-claim', name: 'mailbox_claim', input: { agent: 'codex', paths: ['src/new.ts'] } })
  });
  assert.equal(claim.status, 423);
  assert.deepEqual(await server.mailbox.claims(), {});
});
