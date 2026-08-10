const assert = require('node:assert/strict');
const test = require('node:test');
const { cliBusClient } = require('../dist/brain/bus-client.js');

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

test('a FAILING listen backs off instead of spinning', async () => {
  // The bug exactly. A listen that fails must cost real time before it can be retried,
  // otherwise a broken bus is indistinguishable from a busy one and the seat burns a model
  // call per iteration. This test spins forever without the backoff.
  let calls = 0;
  const slept = [];
  const client = cliBusClient({
    root: 'C:/nowhere',
    waitForMailbox: async () => { calls += 1; throw new Error('timeoutMs must be 0..30000.'); },
    sleep: async (ms) => { slept.push(ms); }
  });

  const result = await client.listen('worker', 2);
  assert.equal(result, 'timeout', 'a broken bus is a quiet bus, not a dead agent');
  assert.ok(slept.length > 0, 'it must wait between failures');
  assert.equal(slept.length, calls, 'every failure waits - no failure is free');
  // Including the LAST one. Clamping the final backoff to the remaining deadline left one
  // free failure per wake, which is all a hot loop needs.
  for (const ms of slept) assert.ok(ms >= 1000, `a backoff must be real, got ${ms}`);
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
