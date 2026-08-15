const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HarnessServer } = require('../dist/harness.js');
const { callSeatTool, waitForMailbox, watchMailbox, seatToolInvocation } = require('../dist/worker-client.js');

test('worker-client supersede verb maps exact message identities and reason', () => {
  assert.deepEqual(
    seatToolInvocation('supersede', ['--seq', '12', '--by', '14', '--reason', 'corrected'], 'worker'),
    { name: 'mailbox_supersede', input: { agent: 'worker', seq: 12, by: 14, reason: 'corrected' } }
  );
});

const TOKEN_A = `pab1.worker.${'a'.repeat(48)}`;
const TOKEN_B = `pab1.worker.${'b'.repeat(48)}`;

test('seat tool calls authenticate, bind request identity, and validate the harness instance', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const calls = [];
  const result = await callSeatTool({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir
  }, 'mailbox_send', {
    from: 'worker', to: 'reviewer', subject: 'ready', body: 'please audit'
  }, 'stable-request-id', { fetch: scriptedFetch(calls, [
    json({ ok: true, instanceId: 'instance-a', requestId: 'stable-request-id', result: { seq: 4 } })
  ]) });

  assert.deepEqual(result, { instanceId: 'instance-a', requestId: 'stable-request-id', result: { seq: 4 } });
  assert.equal(calls[0].pathname, '/v1/tool');
  assert.equal(calls[0].authorization, `Bearer ${TOKEN_A}`);
  assert.deepEqual(calls[0].body, {
    requestId: 'stable-request-id',
    name: 'mailbox_send',
    input: { from: 'worker', to: 'reviewer', subject: 'ready', body: 'please audit' }
  });
});

test('seat tool calls reject mismatched harness and request identities', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  await assert.rejects(callSeatTool({
    root: fixture.root, seat: 'worker', credentialsDir: fixture.credentialsDir
  }, 'mailbox_status', {}, 'expected-id', { fetch: scriptedFetch([], [
    json({ ok: true, instanceId: 'instance-b', requestId: 'expected-id', result: {} })
  ]) }), /instanceId/);
  await assert.rejects(callSeatTool({
    root: fixture.root, seat: 'worker', credentialsDir: fixture.credentialsDir
  }, 'mailbox_status', {}, 'expected-id', { fetch: scriptedFetch([], [
    json({ ok: true, instanceId: 'instance-a', requestId: 'other-id', result: {} })
  ]) }), /requestId/);
});

test('one-shot wait acquires, polls with its lease, and releases', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const calls = [];
  const result = await waitForMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'test-client',
    timeoutMs: 123
  }, { fetch: scriptedFetch(calls, [
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 2, staleAfterMs: 1000 }),
    json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 7, subject: 'work' }] }),
    json({ ok: true, instanceId: 'instance-a', released: true })
  ]) });

  assert.equal(result.wake, 'message');
  assert.equal(result.afterSeq, 7);
  assert.equal(result.instanceId, 'instance-a');
  assert.deepEqual(calls.map((call) => call.pathname), ['/v1/heartbeat', '/v1/wake', '/v1/workers/release']);
  assert.equal(calls[0].body.agent, 'worker');
  assert.equal(calls[0].body.clientId, 'test-client');
  assert.match(calls[0].body.acquisitionId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(calls[2].body, {
    agent: 'worker', clientId: 'test-client', leaseId: 'lease-a', generation: 2
  });
  assert.equal(calls[1].query.get('leaseId'), 'lease-a');
  assert.equal(calls[1].query.get('generation'), '2');
  assert.equal(calls[1].query.get('afterSeq'), '0');
  assert.equal(calls[1].query.get('timeoutMs'), '123');
});

test('one-shot wait can listen strictly after an already-presented batch', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const calls = [];
  await waitForMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'in-flight-listener',
    timeoutMs: 123,
    afterSeq: 41
  }, { fetch: scriptedFetch(calls, [
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 2, staleAfterMs: 1000 }),
    json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 42, subject: 'late' }] }),
    json({ ok: true, instanceId: 'instance-a', released: true })
  ]) });

  assert.equal(calls.find((call) => call.pathname === '/v1/wake').query.get('afterSeq'), '41');
});

test('one-shot wait still releases when polling fails', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const calls = [];
  await assert.rejects(waitForMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'test-client'
  }, { fetch: scriptedFetch(calls, [
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 1 }),
    json({ ok: false, error: { code: 'closed', message: 'closing' } }, 503),
    json({ ok: true, instanceId: 'instance-a', released: true })
  ]) }), /closing/);
  assert.equal(calls.at(-1).pathname, '/v1/workers/release');
});

test('watch sends a monotonic afterSeq and suppresses unchanged unread mail', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const controller = new AbortController();
  const calls = [];
  const emitted = [];
  const sleeps = [];
  await watchMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'watcher',
    signal: controller.signal
  }, (event) => emitted.push(event), {
    fetch: scriptedFetch(calls, [
      json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 1, staleAfterMs: 60_000 }),
      json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 4, subject: 'once' }] }),
      json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 4, subject: 'once' }] }),
      json({ ok: true, instanceId: 'instance-a', released: true })
    ]),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      controller.abort();
    }
  });

  const wakes = calls.filter((call) => call.pathname === '/v1/wake');
  assert.deepEqual(wakes.map((call) => call.query.get('afterSeq')), ['0', '4']);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].messages[0].subject, 'once');
  assert.deepEqual(sleeps, [100]);
  assert.equal(calls.at(-1).pathname, '/v1/workers/release');
});

test('watch renews the same lease before polling beyond its renewal deadline', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const controller = new AbortController();
  const calls = [];
  let clock = 0;
  const responses = [
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 3, renewAfterMs: 5 }),
    () => {
      clock = 5;
      return json({ ok: true, instanceId: 'instance-a', wake: 'timeout', messages: [] });
    },
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 3, renewAfterMs: 5 }),
    () => {
      controller.abort();
      return Promise.reject(abortError());
    },
    json({ ok: true, instanceId: 'instance-a', released: true })
  ];
  await watchMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'watcher',
    signal: controller.signal,
    timeoutMs: 30_000,
    renewalIntervalMs: 20_000
  }, () => undefined, { fetch: scriptedFetch(calls, responses), now: () => clock });

  const heartbeats = calls.filter((call) => call.pathname === '/v1/heartbeat');
  assert.equal(heartbeats.length, 2);
  assert.deepEqual(heartbeats[1].body, {
    agent: 'worker', clientId: 'watcher', leaseId: 'lease-a', generation: 3
  });
  assert.equal(calls.find((call) => call.pathname === '/v1/wake').query.get('timeoutMs'), '5');
});

test('watch re-discovers a rotated endpoint and credential with jittered backoff', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const controller = new AbortController();
  const calls = [];
  const sleeps = [];
  const transitions = [];
  let failuresRemaining = 2;
  const fakeFetch = async (url, init) => {
    const call = recordCall(url, init);
    calls.push(call);
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error('connection reset');
    }
    if (call.pathname === '/v1/heartbeat') {
      return json({ ok: true, instanceId: 'instance-b', leaseId: 'lease-b', generation: 1, staleAfterMs: 60_000 });
    }
    if (call.pathname === '/v1/wake') {
      return json({ ok: true, instanceId: 'instance-b', wake: 'message', messages: [{ seq: 9 }] });
    }
    return json({ ok: true, instanceId: 'instance-b', released: true });
  };

  await watchMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'watcher',
    signal: controller.signal,
    reconnectMinMs: 20,
    reconnectMaxMs: 100
  }, () => controller.abort(), {
    fetch: fakeFetch,
    random: () => 0.5,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (sleeps.length === 2) await fixture.rotate('instance-b', TOKEN_B);
    },
    transition: (transition) => transitions.push(transition)
  });

  assert.deepEqual(sleeps, [20, 40]);
  assert.deepEqual(transitions.map((transition) => transition.event), ['disconnected', 'connected']);
  assert.equal(calls[0].authorization, `Bearer ${TOKEN_A}`);
  assert.equal(calls[1].authorization, `Bearer ${TOKEN_A}`);
  assert.equal(calls[2].authorization, `Bearer ${TOKEN_B}`);
  assert.equal(calls[2].origin, 'http://127.0.0.1:47832');
  assert.equal(calls.at(-1).pathname, '/v1/workers/release');
});

test('watch fences a lost lease and reacquires with a new generation', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const controller = new AbortController();
  const calls = [];
  await watchMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'watcher',
    signal: controller.signal,
    reconnectMinMs: 1,
    reconnectMaxMs: 1
  }, () => controller.abort(), {
    fetch: scriptedFetch(calls, [
      json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-old', generation: 1, renewAfterMs: 20_000 }),
      json({ ok: false, error: { code: 'lease_lost', message: 'lease expired' } }, 409),
      json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-new', generation: 2, renewAfterMs: 20_000 }),
      json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 1 }] }),
      json({ ok: true, instanceId: 'instance-a', released: true })
    ]),
    random: () => 0.5,
    sleep: async () => undefined
  });

  const heartbeats = calls.filter((call) => call.pathname === '/v1/heartbeat');
  assert.equal(heartbeats.length, 2);
  assert.equal(heartbeats[0].body.agent, 'worker');
  assert.equal(heartbeats[0].body.clientId, 'watcher');
  assert.equal(heartbeats[1].body.acquisitionId, heartbeats[0].body.acquisitionId);
  assert.equal(calls.at(-1).body.leaseId, 'lease-new');
  assert.equal(calls.at(-1).body.generation, 2);
});

test('abort cancels an active long poll promptly and releases best-effort', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const controller = new AbortController();
  const calls = [];
  let pollStarted;
  const started = new Promise((resolve) => { pollStarted = resolve; });
  const fakeFetch = async (url, init) => {
    const call = recordCall(url, init);
    calls.push(call);
    if (call.pathname === '/v1/heartbeat') {
      return json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 1, staleAfterMs: 60_000 });
    }
    if (call.pathname === '/v1/wake') {
      pollStarted();
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(abortError()), { once: true });
      });
    }
    return json({ ok: true, instanceId: 'instance-a', released: true });
  };
  const watching = watchMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'watcher',
    signal: controller.signal
  }, () => undefined, { fetch: fakeFetch });
  await started;
  controller.abort();
  await Promise.race([
    watching,
    new Promise((_, reject) => setTimeout(() => reject(new Error('watch did not stop promptly')), 200))
  ]);
  assert.equal(calls.at(-1).pathname, '/v1/workers/release');
});

test('client rejects a response from a different harness instance', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  await assert.rejects(waitForMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'test-client'
  }, { fetch: async () => json({
    ok: true, instanceId: 'instance-b', leaseId: 'lease-a', generation: 1
  }) }), /instanceId/);
});

test('client bounds harness response bodies before JSON parsing', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  await assert.rejects(waitForMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'test-client'
  }, { fetch: async () => json({ ok: true, padding: 'x'.repeat(4 * 1024 * 1024) }) }), /response exceeds 4194304 bytes/);
});

test('watch resets its sequence cursor only when the durable mailbox epoch changes', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const controller = new AbortController();
  const calls = [];
  let deliveries = 0;
  await watchMailbox({
    root: fixture.root,
    seat: 'worker',
    credentialsDir: fixture.credentialsDir,
    clientId: 'watcher',
    signal: controller.signal,
    reconnectMinMs: 1,
    reconnectMaxMs: 1
  }, () => {
    deliveries += 1;
    if (deliveries === 2) controller.abort();
  }, {
    fetch: scriptedFetch(calls, [
      json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 1, mailboxEpoch: '2026-01-01T00:00:00.000Z' }),
      json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 5 }] }),
      json({ ok: false, error: { code: 'lease_lost', message: 'mailbox replaced' } }, 409),
      json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-b', generation: 2, mailboxEpoch: '2026-01-02T00:00:00.000Z' }),
      json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 1 }] }),
      json({ ok: true, instanceId: 'instance-a', released: true })
    ]),
    sleep: async () => undefined
  });
  assert.deepEqual(calls.filter((call) => call.pathname === '/v1/wake').map((call) => call.query.get('afterSeq')), ['0', '5', '0']);
});

test('watch persists a successful delivery cursor across process sessions', async (t) => {
  const fixture = await clientFixture(t, 'instance-a', TOKEN_A);
  const firstController = new AbortController();
  const firstCalls = [];
  await watchMailbox({
    root: fixture.root, seat: 'worker', credentialsDir: fixture.credentialsDir,
    clientId: 'durable-worker', signal: firstController.signal
  }, () => firstController.abort(), { fetch: scriptedFetch(firstCalls, [
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-a', generation: 1, mailboxEpoch: '2026-01-01T00:00:00.000Z' }),
    json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 4 }] }),
    json({ ok: true, instanceId: 'instance-a', released: true })
  ]) });

  const secondController = new AbortController();
  const secondCalls = [];
  await watchMailbox({
    root: fixture.root, seat: 'worker', credentialsDir: fixture.credentialsDir,
    clientId: 'durable-worker', signal: secondController.signal
  }, () => secondController.abort(), { fetch: scriptedFetch(secondCalls, [
    json({ ok: true, instanceId: 'instance-a', leaseId: 'lease-b', generation: 2, mailboxEpoch: '2026-01-01T00:00:00.000Z' }),
    json({ ok: true, instanceId: 'instance-a', wake: 'message', messages: [{ seq: 5 }] }),
    json({ ok: true, instanceId: 'instance-a', released: true })
  ]) });
  assert.equal(secondCalls.find((call) => call.pathname === '/v1/wake').query.get('afterSeq'), '4');
});

test('provider-neutral worker client integrates with durable harness mail', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-worker-client-'));
  const credentialsDir = path.join(root, '.test-credentials');
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  const server = new HarnessServer(root, { credentialsDir });
  await server.mailbox.ensureInitialized(['sender', 'worker']);
  await server.start(0);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  const waiting = waitForMailbox({ root, seat: 'worker', timeoutMs: 3000, credentialsDir, clientId: 'integration' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await server.mailbox.send({ from: 'sender', to: 'worker', subject: 'wake', body: 'check your mailbox' });
  const result = await waiting;
  assert.equal(result.wake, 'message');
  assert.equal(result.messages[0].subject, 'wake');
  assert.equal((await server.mailbox.status()).unread.worker, 1);
});

test('seat credential principal binding handles dotted ids without prefix confusion', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-dotted-seat-'));
  const credentialsDir = path.join(root, '.test-credentials');
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [] }));
  const server = new HarnessServer(root, { credentialsDir });
  await server.mailbox.ensureInitialized(['review', 'review.bot']);
  await server.start(0);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

  const dotted = await callSeatTool({ root, seat: 'review.bot', credentialsDir }, 'mailbox_status');
  assert.equal(dotted.instanceId, server.instanceId);

  const seatDir = path.join(credentialsDir, server.instanceId, 'seats');
  await fs.copyFile(path.join(seatDir, 'review.bot.token'), path.join(seatDir, 'review.token'));
  await assert.rejects(
    callSeatTool({ root, seat: 'review', credentialsDir }, 'mailbox_status'),
    /principal does not match/
  );
});

async function clientFixture(t, instanceId, token) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-worker-unit-'));
  const credentialsDir = path.join(root, 'credentials');
  async function rotate(nextInstance, nextToken) {
    const harnessDir = path.join(root, '.ai-bus', 'runtime', 'harness');
    await fs.mkdir(harnessDir, { recursive: true });
    await fs.writeFile(path.join(harnessDir, 'endpoint.json'), JSON.stringify({
      schemaVersion: 1,
      instanceId: nextInstance,
      host: '127.0.0.1',
      port: nextInstance === 'instance-a' ? 47831 : 47832,
      seats: ['worker']
    }));
    const tokenDir = path.join(credentialsDir, nextInstance, 'seats');
    await fs.mkdir(tokenDir, { recursive: true });
    await fs.writeFile(path.join(tokenDir, 'worker.token'), `${nextToken}\n`);
  }
  await rotate(instanceId, token);
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, credentialsDir, rotate };
}

function scriptedFetch(calls, responses) {
  return async (url, init = {}) => {
    calls.push(recordCall(url, init));
    if (responses.length === 0) throw new Error('Unexpected fetch.');
    const response = responses.shift();
    return typeof response === 'function' ? response(url, init) : response;
  };
}

function recordCall(url, init = {}) {
  const parsed = new URL(url);
  const headers = new Headers(init.headers);
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    query: parsed.searchParams,
    authorization: headers.get('authorization'),
    body: init.body ? JSON.parse(init.body) : undefined
  };
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
