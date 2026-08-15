const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { cliBusClient } = require('../dist/brain/bus-client.js');
const { HarnessServer } = require('../dist/harness.js');
const { callSeatTool } = require('../dist/worker-client.js');

test('a long deadline is chunked into polls the harness will accept', async () => {
  // The harness caps one poll at 30s. Passing a 300s brain deadline straight through made every
  // listen throw "timeoutMs must be 0..30000" - reported as a clean timeout, so the runner woke
  // again immediately and spawned a model process each time.
  const asked = [];
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async ({ timeoutMs }) => {
      asked.push(timeoutMs);
      return asked.length >= 3
        ? { wake: 'message', messages: [], instanceId: 'i', afterSeq: 0 }
        : { wake: 'timeout', messages: [], instanceId: 'i', afterSeq: 0 };
    }
  });

  const result = await client.listen('worker', 300);
  assert.equal(result, 'mail');
  assert.ok(asked.length >= 3, 'one brain deadline becomes several polls');
  for (const ms of asked) {
    assert.ok(ms <= 30_000, `every poll must be within the harness cap, got ${ms}`);
    assert.ok(ms > 0, 'and a poll must actually wait');
  }
});

test('DELTA H: lease-held listen retries past lease expiry and then succeeds', async () => {
  // The bug exactly. A listen that fails must cost real time before it can be retried,
  // otherwise a broken bus is indistinguishable from a busy one and the seat burns a model
  // call per iteration. This test spins forever without the backoff.
  let calls = 0;
  let clock = 0;
  const slept = [];
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async () => {
      calls += 1;
      if (clock > 60) return { wake: 'message', messages: [], instanceId: 'i', afterSeq: 0 };
      const error = new Error('another worker owns this seat');
      error.status = 409;
      error.code = 'lease_held';
      error.retriable = true;
      throw error;
    },
    now: () => clock,
    leaseStaleMs: 60,
    listenErrorBackoffMs: 5,
    sleep: async (ms) => { slept.push(ms); clock += ms; }
  });

  const result = await client.listen('worker', 0.01);
  assert.equal(result, 'mail');
  assert.ok(calls > 3, 'it must not retain the old three-attempt ceiling');
  assert.ok(clock > 60, 'it must attempt acquisition after the lease-stale boundary');
  assert.ok(slept.length > 0, 'it must wait between failures');
  assert.equal(slept.length, calls - 1, 'every failure waits - no failure is free');
  // Including the LAST one. Clamping the final backoff to the remaining deadline left one
  // free failure per wake, which is all a hot loop needs.
  for (const ms of slept) assert.equal(ms, 5);
});

test('DELTA H: a non-retriable listen failure exits promptly', async () => {
  let calls = 0;
  let sleeps = 0;
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async () => {
      calls += 1;
      const error = new Error('seat token is invalid');
      error.status = 401;
      error.code = 'unauthorized';
      error.retriable = false;
      throw error;
    },
    sleep: async () => { sleeps += 1; }
  });

  await assert.rejects(client.listen('worker', 300), /non-retriable unauthorized/);
  assert.equal(calls, 1);
  assert.equal(sleeps, 0, 'terminal errors do not spend the lease retry window');
});

test('mail on the first poll returns immediately', async () => {
  let calls = 0;
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async () => {
      calls += 1;
      return { wake: 'message', messages: [], instanceId: 'i', afterSeq: 0 };
    }
  });
  assert.equal(await client.listen('worker', 600), 'mail');
  assert.equal(calls, 1, 'chunking must not delay a wake that is already available');
});

test('an in-flight listener ignores the presented sequence and is abortable', async () => {
  const asked = [];
  const controller = new AbortController();
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async (options) => {
      asked.push(options);
      controller.abort();
      return { wake: 'timeout', messages: [], instanceId: 'i', afterSeq: options.afterSeq };
    }
  });

  assert.equal(await client.listen('worker', 600, 17, controller.signal), 'timeout');
  assert.equal(asked[0].afterSeq, 17);
});

test('an exhausted deadline reports timeout without a further poll', async () => {
  let calls = 0;
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async () => { calls += 1; return { wake: 'timeout', messages: [], instanceId: 'i', afterSeq: 0 }; }
  });
  assert.equal(await client.listen('worker', 0), 'timeout');
  assert.equal(calls, 0, 'a deadline already past must not poll at all');
});

test('brain send preserves explicit keepBaton false', async () => {
  const calls = [];
  const client = cliBusClient({
    root: 'C:/nowhere',
    callSeatTool: async (_options, name, input) => {
      calls.push({ name, input });
      return { result: { ok: true } };
    }
  });
  await client.tools('grok').send({
    to: 'codex', kind: 'ack', subject: 'handoff', body: 'your turn', keepBaton: false
  });
  assert.equal(calls[0].input.keepBaton, false);
});

test('DELTA G: cli bus tool preserves structured harness claim-conflict classification', async () => {
  const client = cliBusClient({
    root: 'C:/nowhere',
    callSeatTool: async () => {
      const error = new Error('Harness request failed (409 claim_conflict): grok already holds src/brain');
      error.status = 409;
      error.code = 'claim_conflict';
      error.retriable = true;
      throw error;
    }
  });

  const result = await client.tools('codex').claim(['src/brain'], 'change it');
  assert.equal(result.status, 409);
  assert.equal(result.code, 'claim_conflict');
  assert.equal(result.retriable, true);
  assert.match(result.error, /grok.*src\/brain/);
});

test('real harness peek is non-destructive and acknowledgement commits only its complete page set', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-client-harness-'));
  const credentialsDir = path.join(root, '.credentials');
  await fs.mkdir(path.join(root, '.ai-bus'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.ai-bus', 'capabilities.json'),
    JSON.stringify({ version: 1, capabilities: [] })
  );
  await fs.mkdir(path.join(root, 'src', 'brain'), { recursive: true });
  const server = new HarnessServer(root, { credentialsDir });
  await server.mailbox.ensureInitialized(['sender', 'worker'], 50);
  await server.start(0);
  t.after(async () => {
    await server.stop();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  for (let index = 1; index <= 6; index += 1) {
    await server.mailbox.send({
      from: 'sender', to: 'worker', subject: `message ${index}`, body: `body ${index}`
    });
  }
  const client = cliBusClient({
    root,
    callSeatTool: (options, name, input) => callSeatTool({ ...options, credentialsDir }, name, input)
  });

  await server.mailbox.claim({ agent: 'sender', paths: ['src/brain'], why: 'active edit' });
  const conflict = await client.tools('worker').claim(['src/brain'], 'competing edit');
  assert.equal(conflict.status, 409, 'HTTP status survives harness -> worker client -> brain client');
  assert.equal(conflict.code, 'claim_conflict');
  assert.equal(conflict.retriable, true);
  assert.match(conflict.error, /sender.*src\/brain/);

  const presented = await client.peek('worker');
  assert.equal(presented.length, 6,
    'status unread count must drive through the harness four-message truncation boundary');
  assert.equal((await server.mailbox.inbox('worker')).length, 6, 'peek must not acknowledge');

  const late = await server.mailbox.send({
    from: 'sender', to: 'worker', subject: 'late arrival', body: 'after the model batch was presented'
  });
  const acknowledged = await client.acknowledge('worker', presented.map((message) => message.seq));
  assert.deepEqual(acknowledged.map((message) => message.seq), presented.map((message) => message.seq));
  assert.deepEqual((await server.mailbox.inbox('worker')).map((message) => message.seq), [late.seq],
    'mail arriving mid-turn must remain unread');

  const correction = await server.mailbox.send({
    from: 'sender', to: 'worker', subject: 'correction', body: 'must not be consumed by a stale commit'
  });
  await assert.rejects(
    client.acknowledge('worker', [presented[0].seq]),
    /no longer current unread mail/,
    'a stale presented sequence must be refused, never replaced with the current queue head'
  );
  assert.deepEqual((await server.mailbox.inbox('worker')).map((message) => message.seq), [late.seq, correction.seq]);
  assert.deepEqual((await client.acknowledge('worker', [correction.seq])).map((message) => message.seq), [correction.seq]);

  await client.park('worker', late.seq, 'bounded poison retry exhausted');
  assert.deepEqual((await server.mailbox.inbox('worker')).map((message) => message.seq), []);
  const parked = await server.mailbox.parked('worker');
  assert.deepEqual(parked.map((message) => message.seq), [late.seq]);
  assert.equal(parked[0].parkedReason, 'bounded poison retry exhausted');
  await server.mailbox.requeue('worker', late.seq);
  assert.deepEqual((await server.mailbox.inbox('worker')).map((message) => message.seq), [late.seq]);
});
