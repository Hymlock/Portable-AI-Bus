const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { HarnessServer } = require('../dist/harness.js');

async function setup(agents = [], maxRounds = 20, serverOptions = {}) {
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
    credentialsDir: path.join(root, '.credentials'),
    ...serverOptions
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
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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

test('harness stop aborts active long-polls promptly', async (t) => {
  const { root, server, request } = await setup(['codex']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const waiting = request('/v1/wake?agent=codex&timeoutMs=30000');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = Date.now();
  await server.stop();
  const result = await waiting;
  assert.equal(result.body.wake, 'server_stopping');
  assert.ok(Date.now() - started < 2000);
});

test('harness stop cancels an active capability instead of hanging shutdown', async (t) => {
  const { root, server, request } = await setup();
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({
    version: 1,
    capabilities: [{ id: 'long-run', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30000 }]
  }), 'utf8');
  const running = request('/v1/tool', {
    method: 'POST', body: JSON.stringify({ requestId: 'long-run-stop', name: 'capability_run', input: { id: 'long-run' } })
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const started = Date.now();
  await server.stop();
  const result = await running;
  assert.equal(result.body.result.status, 'cancelled');
  assert.ok(Date.now() - started < 2000);
});

test('wake cursor ignores unchanged unread mail and emits only later sequences', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const first = await server.mailbox.send({ from: 'codex', to: 'grok', subject: 'first', body: 'remains unread' });
  // This one INTENTIONALLY expects a timeout - there is no newer mail - so it must stay
  // short or the test sleeps for real. 300ms is enough headroom for a loaded runner to reach
  // the poll while still expiring quickly.
  const unchanged = await request(`/v1/wake?agent=grok&afterSeq=${first.seq}&timeoutMs=300`);
  assert.equal(unchanged.body.wake, 'timeout');
  assert.deepEqual(unchanged.body.messages, []);
  const second = await server.mailbox.send({ from: 'codex', to: 'grok', subject: 'second', body: 'new wake' });
  // This one expects a MESSAGE, which already exists, so the timeout only bounds how long it
  // waits for mail that is already there. Long is free.
  const later = await request(`/v1/wake?agent=grok&afterSeq=${first.seq}&timeoutMs=2000`);
  assert.equal(later.body.wake, 'message');
  assert.deepEqual(later.body.messages.map((message) => message.seq), [second.seq]);
  assert.equal((await server.mailbox.status()).unread.grok, 2);
});

test('wake responses page unread mail without acknowledging or skipping it', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok'], 20, { maxWakeMessages: 1 });
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const first = await server.mailbox.send({ from: 'codex', to: 'grok', subject: 'first', body: 'one' });
  const second = await server.mailbox.send({ from: 'codex', to: 'grok', subject: 'second', body: 'two' });
  // 2000ms, not 10ms. Both messages already exist, so the wake returns as soon as it looks -
  // the timeout only bounds how long it waits for mail that is already there. At 10ms a loaded
  // runner timed out BEFORE reading the mailbox and returned an empty page, failing on
  // windows-latest. Raising it costs nothing in the passing case and removes the race.
  const pageOne = await request('/v1/wake?agent=grok&afterSeq=0&timeoutMs=2000');
  assert.deepEqual(pageOne.body.messages.map((message) => message.seq), [first.seq]);
  assert.equal(pageOne.body.hasMore, true);
  const pageTwo = await request(`/v1/wake?agent=grok&afterSeq=${first.seq}&timeoutMs=2000`);
  assert.deepEqual(pageTwo.body.messages.map((message) => message.seq), [second.seq]);
  assert.equal(pageTwo.body.hasMore, false);
  assert.equal((await server.mailbox.status()).unread.grok, 2);
});

test('mailbox inbox tool pages with afterSeq without acknowledging messages', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const sent = [];
  for (let index = 0; index < 6; index += 1) {
    sent.push(await server.mailbox.send({ from: 'codex', to: 'grok', subject: `message-${index}`, body: 'one' }));
  }
  const tool = async (requestId, afterSeq) => request('/v1/tool', {
    method: 'POST', body: JSON.stringify({ requestId, name: 'mailbox_inbox', input: { agent: 'grok', all: true, afterSeq } })
  });
  const first = await tool('inbox-page-one', 0);
  const second = await tool('inbox-page-two', first.body.result.at(-1).seq);
  assert.deepEqual(first.body.result.map((message) => message.seq), sent.slice(0, 4).map((message) => message.seq));
  assert.deepEqual(second.body.result.map((message) => message.seq), sent.slice(4).map((message) => message.seq));
  assert.equal((await server.mailbox.status()).unread.grok, 6);
});

test('seat credentials cannot impersonate or acknowledge another seat', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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
  t.after(async () => { await restarted.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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
  t.after(async () => { await server.stop(); await second.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await assert.rejects(() => second.start(0), /already owns this workspace/);
  assert.equal(await fs.readFile(server.tokenPath, 'utf8'), 'test-token\n');
});

test('concurrent stale-lock recovery elects exactly one harness owner', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-harness-recovery-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await fs.mkdir(path.join(root, '.ai-bus', 'runtime', 'harness'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }), 'utf8');
  const seed = new HarnessServer(root, { credentialsDir: path.join(root, '.credentials') });
  await seed.mailbox.ensureInitialized(['codex']);
  await fs.writeFile(seed.lockPath, `${JSON.stringify({ instanceId: 'dead-owner', pid: 2147483647 })}\n`, 'utf8');
  const contenders = Array.from({ length: 12 }, () => new HarnessServer(root, { credentialsDir: path.join(root, '.credentials') }));
  const results = await Promise.allSettled(contenders.map((server) => server.start(0)));
  const winners = results.map((result, index) => ({ result, server: contenders[index] })).filter(({ result }) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  const endpoint = JSON.parse(await fs.readFile(winners[0].server.endpointPath, 'utf8'));
  assert.equal(endpoint.instanceId, winners[0].server.instanceId);
  await Promise.all(contenders.map((server) => server.stop()));
  await assert.rejects(fs.access(seed.lockPath));
  await assert.rejects(fs.access(seed.recoveryLockPath));
});

test('a stranded harness recovery lock fails closed with an actionable diagnostic', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-harness-stranded-recovery-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await fs.mkdir(path.join(root, '.ai-bus', 'runtime', 'harness'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }), 'utf8');
  const server = new HarnessServer(root, { credentialsDir: path.join(root, '.credentials') });
  await server.mailbox.ensureInitialized(['codex']);
  await fs.writeFile(server.recoveryLockPath, `${JSON.stringify({ instanceId: 'dead-recoverer', pid: 2147483647 })}\n`, 'utf8');
  await assert.rejects(server.start(0), /dead process.*left the harness recovery lock/i);
  await server.stop();
});

test('halt blocks claim and release mutations', async (t) => {
  const { root, server, request } = await setup(['codex']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
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

test('round cap halts immediately after durably writing the cap message', async (t) => {
  const { root, server, request } = await setup(['codex', 'grok'], 1);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await server.mailbox.send({ from: 'codex', to: 'grok', subject: 'one', body: 'reaches cap' });
  assert.equal((await server.mailbox.status()).halted, true);
  const claim = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'capped-claim', name: 'mailbox_claim', input: { agent: 'codex', paths: ['src/new.ts'] } })
  });
  assert.equal(claim.status, 423);
  assert.deepEqual(await server.mailbox.claims(), {});
});

test('authenticated heartbeats persist leases and transition to stale without granting authority', async (t) => {
  // 1000ms, not 100ms. At 100 the test raced the machine: between a heartbeat and the
  // /v1/status call that asserts `live`, several awaits and an HTTP round trip elapse, and on
  // a loaded CI runner that exceeds 100ms - so the lease had legitimately gone stale and the
  // assertion failed with 'stale' !== 'live'. The product was correct; the test was measuring
  // runner speed. Caught on windows-latest, 2026-08-07.
  //
  // The sweep stays well below the TTL so the stale transition is still observed promptly,
  // and the wait below is comfortably past TTL + sweep. The cost is ~1.2s of wall clock,
  // which is the right trade for a test that otherwise fails at random and teaches everyone
  // to re-run CI until it goes green.
  const { root, server, request } = await setup(['codex', 'grok'], 20, { leaseStaleMs: 1000, leaseSweepMs: 100 });
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const heartbeat = await fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-grok-token', 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'monitor:one', acquisitionId: '11111111-1111-4111-8111-111111111111' })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(typeof (await heartbeat.clone().json()).mailboxEpoch, 'string');
  const live = await request('/v1/status');
  assert.equal(live.body.workerLeases.seats.find((item) => item.seat === 'grok').state, 'live');
  assert.equal(live.body.workerLeases.seats.find((item) => item.seat === 'codex').state, 'never_seen');
  const durable = JSON.parse(await fs.readFile(server.leasesPath, 'utf8'));
  assert.equal(durable.instanceId, server.instanceId);
  assert.equal(durable.leases[0].clientId, 'monitor:one');

  // Past TTL (1000) + sweep (100), with headroom for a slow runner.
  await new Promise((resolve) => setTimeout(resolve, 1400));
  const stale = await request('/v1/status');
  assert.equal(stale.body.workerLeases.seats.find((item) => item.seat === 'grok').state, 'stale');
  assert.match(await fs.readFile(server.auditPath, 'utf8'), /worker_lease_stale/);
  const recoveredResponse = await fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-grok-token', 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'monitor:one', acquisitionId: '11111111-1111-4111-8111-111111111111' })
  });
  assert.equal(recoveredResponse.status, 200);
  assert.equal((await request('/v1/status')).body.workerLeases.seats.find((item) => item.seat === 'grok').state, 'live');
  assert.match(await fs.readFile(server.auditPath, 'utf8'), /worker_lease_recovered/);
});

test('operator credentials cannot forge worker liveness', async (t) => {
  const { root, server, request } = await setup(['grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const heartbeat = await request('/v1/heartbeat', {
    method: 'POST', body: JSON.stringify({ agent: 'grok', clientId: 'forged' })
  });
  assert.equal(heartbeat.status, 403);
  assert.equal(heartbeat.body.error.code, 'seat_required');
  assert.equal((await request('/v1/status')).body.workerLeases.seats.find((item) => item.seat === 'grok').state, 'never_seen');
});

test('seat lease requests require an explicit process-unique client id and return validation errors', async (t) => {
  const { root, server } = await setup(['grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST', headers: { authorization: 'Bearer test-grok-token', 'content-type': 'application/json' }, body: '{}'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'invalid_request');
});

test('concurrent seat heartbeats retain every lease record', async (t) => {
  const { root, server } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  await Promise.all([
    ['codex', 'test-codex-token'],
    ['grok', 'test-grok-token']
  ].map(([clientId, token], index) => fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, acquisitionId: `${index + 1}`.repeat(8) + '-1111-4111-8111-111111111111' })
  })));
  const durable = JSON.parse(await fs.readFile(server.leasesPath, 'utf8'));
  assert.deepEqual(durable.leases.map((item) => item.seat).sort(), ['codex', 'grok']);
});

test('one live worker lease per seat and stale generations cannot reclaim authority', async (t) => {
  const { root, server } = await setup(['grok'], 20, { leaseStaleMs: 100, leaseSweepMs: 50 });
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const beat = (body) => fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST', headers: { authorization: 'Bearer test-grok-token', 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const [left, right] = await Promise.all([
    beat({ clientId: 'worker:left', acquisitionId: '11111111-1111-4111-8111-111111111111' }),
    beat({ clientId: 'worker:right', acquisitionId: '22222222-2222-4222-8222-222222222222' })
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 409]);
  const winnerResponse = left.status === 200 ? left : right;
  const winnerId = left.status === 200 ? 'worker:left' : 'worker:right';
  const firstLease = await winnerResponse.json();
  await new Promise((resolve) => setTimeout(resolve, 140));
  const next = await beat({ clientId: 'worker:next', acquisitionId: '33333333-3333-4333-8333-333333333333' });
  assert.equal(next.status, 200);
  const nextLease = await next.json();
  assert.equal(nextLease.generation, firstLease.generation + 1);
  const late = await beat({ clientId: winnerId, leaseId: firstLease.leaseId, generation: firstLease.generation });
  assert.equal(late.status, 409);
  assert.equal((await late.json()).error.code, 'lease_lost');
});

test('acquisition nonces fence duplicate processes while preserving lost-response retries', async (t) => {
  const { root, server } = await setup(['grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const beat = (acquisitionId) => fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST', headers: { authorization: 'Bearer test-grok-token', 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'stable-worker', acquisitionId })
  });
  const first = await beat('11111111-1111-4111-8111-111111111111');
  const firstLease = await first.json();
  const retry = await beat('11111111-1111-4111-8111-111111111111');
  const competing = await beat('22222222-2222-4222-8222-222222222222');
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).leaseId, firstLease.leaseId);
  assert.equal(competing.status, 409);
  assert.equal((await competing.json()).error.code, 'lease_held');
});

test('harness enforces separate step and goal completion halt authority', async (t) => {
  const { root, server, request } = await setup(['codex']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const configured = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'halt-policy', name: 'mailbox_configure_halting', input: { onStepCompletion: true, onGoalCompletion: false } })
  });
  assert.equal(configured.status, 200);
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const asSeat = (payload) => fetch(`http://127.0.0.1:${endpoint.port}/v1/tool`, {
    method: 'POST', headers: { authorization: 'Bearer test-codex-token', 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const step = await asSeat({ requestId: 'complete-step', name: 'mailbox_complete_step', input: { agent: 'codex', summary: 'step evidence ready', evidence: ['test:green'] } });
  assert.equal(step.status, 200);
  assert.equal((await server.mailbox.status()).halted, true);
  await server.mailbox.resume();
  const forbiddenGoal = await asSeat({ requestId: 'forged-goal', name: 'mailbox_complete_goal', input: { agent: 'codex', summary: 'not authoritative' } });
  assert.equal(forbiddenGoal.status, 403);
  const goal = await request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId: 'complete-goal', name: 'mailbox_complete_goal', input: { agent: 'operator', summary: 'operator accepted evidence' } })
  });
  assert.equal(goal.status, 200);
  assert.equal((await server.mailbox.status()).halted, false);
});

// Lease capacity. Before 2026-08-07 the harness evicted the OLDEST-SEEN lease at capacity
// whether or not it was live, so a working seat could lose its lease under pressure and read
// the loss as a network flake - the hardest fault to diagnose, because nothing recorded that
// it was deliberate. It now prunes only stale leases and refuses with 429 when all are live.
// maxWorkerLeases is injectable purely so this is provable without opening 256 leases.

test('lease capacity refuses with 429 rather than evicting a live lease', async (t) => {
  const { root, server } = await setup(['codex', 'grok'], 20, { maxWorkerLeases: 1, leaseStaleMs: 60_000 });
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const beat = (seat, clientId) => fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer test-${seat}-token`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, acquisitionId: randomUUID() })
  });

  const first = await beat('codex', 'worker:codex');
  assert.equal(first.status, 200);

  // grok's lease cannot be granted without evicting codex's, which is LIVE.
  const second = await beat('grok', 'worker:grok');
  assert.equal(second.status, 429);
  const body = await second.json();
  assert.equal(body.error.code, 'lease_capacity');
  assert.equal(body.error.retriable, true);

  // codex must still hold its lease - the whole point is that it was not sacrificed.
  const status = await fetch(`http://127.0.0.1:${endpoint.port}/v1/status`, {
    headers: { authorization: 'Bearer test-token' }
  }).then((response) => response.json());
  assert.equal(status.workerLeases.seats.find((item) => item.seat === 'codex').state, 'live');
});

test('lease capacity prunes a stale lease instead of refusing', async (t) => {
  // Same capacity, but codex's lease is allowed to go stale first. Then evicting it is correct
  // and grok should be admitted - refusing here would be the opposite failure.
  const { root, server } = await setup(['codex', 'grok'], 20, { maxWorkerLeases: 1, leaseStaleMs: 150, leaseSweepMs: 50 });
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const endpoint = JSON.parse(await fs.readFile(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'), 'utf8'));
  const beat = (seat, clientId) => fetch(`http://127.0.0.1:${endpoint.port}/v1/heartbeat`, {
    method: 'POST',
    headers: { authorization: `Bearer test-${seat}-token`, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, acquisitionId: randomUUID() })
  });

  assert.equal((await beat('codex', 'worker:codex')).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal((await beat('grok', 'worker:grok')).status, 200);
});

test('keepBaton survives the HTTP tool path', async (t) => {
  // The regression this locks: `keepBaton` was honoured by the direct CLI but absent from
  // mailbox_send's inputSchema AND dropped by its handler, so `--keep-baton` was silently
  // discarded on the HTTP path - the only path agents actually use. It failed silently: the
  // sender believed it still held the baton while the baton had moved to an idle seat, which
  // is indistinguishable from the other agent having gone quiet. Every stall we investigated
  // had this available as a cause and nobody could see it.
  const { root, server, request } = await setup(['codex', 'grok']);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  const send = (input, requestId) => request('/v1/tool', {
    method: 'POST',
    body: JSON.stringify({ requestId, name: 'mailbox_send', input })
  });
  const holder = async () => (await request('/v1/status')).body.mailbox.baton.holder;

  const base = { from: 'codex', to: 'grok', subject: 'progress', body: 'still working' };

  // keepBaton: true - the sender is reporting progress, not handing over.
  await send({ ...base, kind: 'fix-report', keepBaton: true }, 'keep-1');
  assert.equal(await holder(), 'codex', 'keepBaton:true must leave the baton with the sender');

  // Omitted - the store's own default decides. A non-ack passes the baton.
  await send({ ...base, kind: 'fix-report' }, 'default-1');
  assert.equal(await holder(), 'grok', 'a non-ack with no keepBaton still passes the baton');

  // Omitted on an ack - the store's "an ack keeps the baton" rule must still apply, which is
  // why the handler forwards `undefined` rather than coercing it to false.
  await send({ from: 'grok', to: 'codex', kind: 'ack', subject: 'ack', body: 'taken' }, 'ack-1');
  assert.equal(await holder(), 'grok', 'an ack must keep the baton even with keepBaton absent');

  // keepBaton: false - an explicit hand-off, overriding the ack default.
  await send({ from: 'grok', to: 'codex', kind: 'ack', subject: 'over', body: 'yours' , keepBaton: false }, 'ack-2');
  assert.equal(await holder(), 'codex', 'keepBaton:false must override the ack default');

  const bad = await send({ ...base, keepBaton: 'yes' }, 'bad-1');
  assert.equal(bad.status, 400, 'a non-boolean keepBaton must be rejected, not coerced');
});
