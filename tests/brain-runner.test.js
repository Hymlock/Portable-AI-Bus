const assert = require('node:assert/strict');
const test = require('node:test');
const { runBrain } = require('../dist/brain/runner.js');
const { createAgentBrain } = require('../dist/brain/brains/index.js');

function makeBus({ script = [] } = {}) {
  const queue = script.slice();
  const sent = [];
  const calls = { listen: 0, read: 0 };
  return {
    sent,
    calls,
    bus: {
      async listen() {
        calls.listen += 1;
        return queue.length ? 'mail' : 'timeout';
      },
      async read() {
        calls.read += 1;
        const batch = queue.shift();
        return batch ?? [];
      },
      tools() {
        return {
          async send(input) { sent.push(input); return { seq: sent.length }; },
          async status() { return { ok: true }; },
          async claim() { return {}; },
          async release() { return {}; },
          async runCapability() { return {}; }
        };
      }
    }
  };
}

const msg = (seq, subject) => ({ seq, from: 'grok', to: 'claude', kind: 'note', subject, body: 'x' });

test('a brain reporting done does NOT end the runner', async () => {
  // The regression this exists for. Running a seat as a chat session makes reporting and
  // stopping the same act. Here `done` must mean "this wake is finished" only - if it ever
  // ends the loop again, the loop-breaking bug is back and this test is the alarm.
  const { bus, sent } = makeBus({ script: [[msg(1, 'first')], [msg(2, 'second')]] });
  let turns = 0;
  const brain = {
    name: 'reporter',
    async takeTurn(ctx) {
      turns += 1;
      await ctx.tools.send({ to: 'grok', kind: 'note', subject: `report ${turns}`, body: 'done' });
      return { done: true };
    }
  };
  // `thinkWhenIdle` is ON here deliberately. The third wake carries no mail, and idle wakes no
  // longer reach the brain by default - a seat that thinks about an empty inbox costs a model
  // call per listen window forever. That optimisation is orthogonal to what this test guards,
  // so it is switched off rather than allowed to weaken the assertion: the alarm must still
  // ring on three brain invocations, not on two.
  const summary = await runBrain({ seat: 'claude', brain, bus, maxWakes: 3, thinkWhenIdle: true });
  assert.equal(summary.stoppedBy, 'maxWakes', 'runner must survive done:true');
  assert.equal(turns, 3, 'brain should have been woken three times despite reporting done');
  assert.equal(sent.length, 3, 'each wake reported without ending the process');
});

test('mail is drained before listening, so the loop cannot spin', async () => {
  // `listen` returns instantly while mail is unread and only holds a lease while blocked. A
  // loop that listens without draining spins, exits, and leaves the seat unattended while
  // reporting success - the exact failure that took this project down twice.
  const { bus, calls } = makeBus({ script: [[msg(1, 'waiting')]] });
  const brain = { name: 'drainer', async takeTurn() { return { done: true }; } };
  await runBrain({ seat: 'claude', brain, bus, maxWakes: 1 });
  assert.equal(calls.read >= 1, true, 'must read before deciding to wait');
  assert.equal(calls.listen, 0, 'must not listen while mail is already unread');
});

test('a throwing brain does not kill the process', async () => {
  const { bus } = makeBus({ script: [[msg(1, 'boom')], [msg(2, 'fine')]] });
  let turns = 0;
  const brain = {
    name: 'flaky',
    async takeTurn() {
      turns += 1;
      if (turns === 1) throw new Error('bad message');
      return { done: true };
    }
  };
  const summary = await runBrain({ seat: 'claude', brain, bus, maxWakes: 2 });
  assert.equal(summary.errors, 1);
  assert.equal(turns, 2, 'the seat stays attended and the next wake gets a fresh chance');
});

test('DELTA H: an exhausted listener escapes the runner so the process exits nonzero', async () => {
  const { bus } = makeBus();
  bus.listen = async () => { throw new Error('listen recovery exhausted'); };
  const brain = { name: 'idle', async takeTurn() { return { done: true }; } };

  await assert.rejects(
    runBrain({ seat: 'claude', brain, bus, maxWakes: 2 }),
    /listen recovery exhausted/,
    'the runner must not translate deafness into an ordinary timeout or successful exit'
  );
});

test('the per-wake budget caps a runaway brain without ending it', async () => {
  const { bus, sent } = makeBus({ script: [[msg(1, 'go')], [msg(2, 'go again')]] });
  const brain = {
    name: 'runaway',
    async takeTurn(ctx) {
      for (let i = 0; i < 100; i += 1) {
        await ctx.tools.send({ to: 'grok', kind: 'note', subject: `spam ${i}`, body: '' });
      }
      return { done: true };
    }
  };
  const summary = await runBrain({ seat: 'claude', brain, bus, budgetPerWake: 5, maxWakes: 2 });
  assert.equal(summary.cappedWakes, 2, 'both wakes should cap');
  assert.equal(sent.length, 10, 'exactly the budget per wake, no more');
  assert.equal(summary.stoppedBy, 'maxWakes', 'capping must not end the runner');
});

test('a stop signal ends the runner gracefully and calls stop()', async () => {
  const { bus } = makeBus({ script: [[msg(1, 'one')]] });
  let stopCalled = false;
  let resolveStop;
  const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
  const brain = {
    name: 'stoppable',
    async takeTurn() { resolveStop(); await new Promise((r) => setTimeout(r, 5)); return { done: true }; },
    async stop() { stopCalled = true; }
  };
  const summary = await runBrain({ seat: 'claude', brain, bus, stopSignal });
  assert.equal(summary.stoppedBy, 'signal');
  assert.equal(stopCalled, true, 'brains get a chance to clean up');
});

test('a spent chain hands the baton off instead of going quiet', async () => {
  // The endgame Hymlock asked about: the orchestrating seat runs out of tokens. The runner
  // cannot fix that - no provider left means no thinking - but it must make the failure LOUD
  // and hand off, rather than going silent and looking like it is working. Silence is the one
  // outcome we can never distinguish from progress.
  const { bus } = makeBus({ script: [[msg(1, 'do work')], [msg(2, 'more work')]] });
  const handoffs = [];
  const brain = {
    name: 'broke',
    async takeTurn() {
      return { done: true, exhausted: true, note: 'cli: quota, api: quota, exec: unavailable' };
    }
  };
  const summary = await runBrain({
    seat: 'claude',
    brain,
    bus,
    maxWakes: 2,
    onExhausted: async (info) => { handoffs.push(info); }
  });

  assert.equal(handoffs.length, 2, 'every exhausted wake must announce itself');
  assert.equal(handoffs[0].seat, 'claude');
  assert.match(handoffs[0].detail, /quota/, 'the handoff must carry WHY, not just that it failed');
  assert.equal(summary.stoppedBy, 'maxWakes', 'exhaustion must not kill the runner - credit may return');
});

test('ITEM 11: a broken chain does not hand the baton as spent', async () => {
  const { bus } = makeBus({ script: [[msg(1, 'do work')]] });
  const handoffs = [];
  const events = [];
  const brain = {
    name: 'broken-transport',
    async takeTurn() {
      return {
        done: true,
        exhausted: false,
        broken: true,
        note: "BROKEN:ConPTY unavailable: Cannot find module 'node-pty'"
      };
    }
  };
  await runBrain({
    seat: 'claude',
    brain,
    bus,
    maxWakes: 1,
    log: (event, data) => events.push({ event, data }),
    onExhausted: async (info) => { handoffs.push(info); }
  });

  assert.equal(handoffs.length, 0, 'BROKEN must not invoke the spent-handoff');
  const broken = events.find((entry) => entry.event === 'chain-broken');
  assert.ok(broken);
  assert.match(broken.data.error, /Cannot find module 'node-pty'/);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);
});

test('a failing handoff handler does not take the runner with it', async () => {
  const { bus } = makeBus({ script: [[msg(1, 'go')]] });
  const brain = { name: 'broke', async takeTurn() { return { done: true, exhausted: true }; } };
  const summary = await runBrain({
    seat: 'claude', brain, bus, maxWakes: 1,
    onExhausted: async () => { throw new Error('mailbox unreachable'); }
  });
  assert.equal(summary.stoppedBy, 'maxWakes', 'a broken handoff is not a reason to die');
});

function transactionalBus(message, injectOnAcknowledge, toolOverrides = {}) {
  let unread = Array.isArray(message) ? message.slice() : message ? [message] : [];
  const parked = [];
  let acknowledgements = 0;
  return {
    get unread() { return unread.slice(); },
    enqueue(message) { unread.push(message); },
    get parked() { return parked.slice(); },
    get acknowledgements() { return acknowledgements; },
    client: {
      async listen() { return unread.length ? 'mail' : 'timeout'; },
      async peek() { return unread.slice(); },
      async acknowledge(_seat, count) {
        acknowledgements += 1;
        if (injectOnAcknowledge) unread.push(injectOnAcknowledge);
        const batch = unread.slice(0, count);
        unread = unread.slice(count);
        return batch;
      },
      async park(_seat, seq, reason) {
        const index = unread.findIndex((message) => message.seq === seq);
        if (index < 0) throw new Error(`message #${seq} is not unread`);
        const [message] = unread.splice(index, 1);
        const record = { ...message, parkedReason: reason };
        parked.push(record);
        return record;
      },
      async read() { throw new Error('transactional runner must not destructively read before the turn'); },
      tools() {
        return {
          async send() { return { ok: true }; },
          async status() { return { agents: ['claude', 'codex', 'grok'] }; },
          async claim() { return {}; },
          async release() { return {}; },
          async runCapability() { return {}; },
          async listCapabilities() { return []; },
          ...toolOverrides
        };
      }
    }
  };
}

function oneReply(text) {
  return {
    kind: 'test',
    async ask() { return { text, isError: false }; }
  };
}

test('mail retained while a brain is down is presented on its first restarted wake without a trigger', async () => {
  const retained = {
    seq: 89, from: 'claude', to: 'codex', kind: 'task',
    subject: 'arrived while down', body: 'drain me on restart'
  };
  const fixture = transactionalBus(retained);
  const presented = [];
  const restartedBrain = {
    name: 'restarted',
    async takeTurn(context) {
      presented.push(...context.messages);
      return { done: true, note: 'retained mail processed' };
    }
  };

  // No enqueue and no synthetic listen result occurs after runBrain starts. The only wake source
  // is the unread record that predates this runner process.
  await runBrain({ seat: 'codex', brain: restartedBrain, bus: fixture.client, maxWakes: 1 });

  assert.deepEqual(presented.map((message) => message.seq), [89],
    'startup must reconcile the durable unread inbox before waiting for a new arrival');
  assert.equal(fixture.unread.length, 0);
  assert.equal(fixture.acknowledgements, 1);
});

test('a committed message is not presented again after the brain restarts', async () => {
  const task = {
    seq: 90, from: 'claude', to: 'codex', kind: 'task',
    subject: 'consume once', body: 'do not replay me'
  };
  const fixture = transactionalBus(task);
  const firstWake = [];
  await runBrain({
    seat: 'codex', bus: fixture.client, maxWakes: 1,
    brain: {
      name: 'first-process',
      async takeTurn(context) {
        firstWake.push(...context.messages);
        return { done: true, note: 'committed' };
      }
    }
  });

  const restartedWake = [];
  await runBrain({
    seat: 'codex', bus: fixture.client, maxWakes: 1,
    brain: {
      name: 'restarted-process',
      async takeTurn(context) {
        restartedWake.push(...context.messages);
        return { done: true };
      }
    }
  });

  assert.deepEqual(firstWake.map((message) => message.seq), [90]);
  assert.deepEqual(restartedWake, [],
    'restart reconciliation must use unread state, not indiscriminately replay mailbox history');
  assert.equal(fixture.acknowledgements, 1,
    'only the process that was actually presented the message may commit it');
});

test('a malformed model wake leaves its input unread, while a usable plan consumes it', async () => {
  const task = { seq: 91, from: 'claude', to: 'codex', kind: 'task', subject: 'audit', body: 'inspect it' };

  const malformedBus = transactionalBus(task);
  const malformedBrain = createAgentBrain({
    seat: 'codex', provider: oneReply('this is not a JSON plan'), maxRounds: 1
  });
  await runBrain({ seat: 'codex', brain: malformedBrain, bus: malformedBus.client, maxWakes: 1 });
  assert.equal(malformedBus.unread.length, 1,
    'parse failure must cost a retry, not destroy the task that paid for the wake');
  assert.equal(malformedBus.acknowledgements, 0);

  const goodBus = transactionalBus(task);
  const goodBrain = createAgentBrain({
    seat: 'codex',
    provider: oneReply(JSON.stringify({
      actions: [{ type: 'send', to: 'claude', kind: 'report', subject: 'result', body: 'verified' }],
      done: true
    })),
    maxRounds: 1
  });
  await runBrain({ seat: 'codex', brain: goodBrain, bus: goodBus.client, maxWakes: 1 });
  assert.equal(goodBus.unread.length, 0, 'a usable plan must commit the read');
  assert.equal(goodBus.acknowledgements, 1,
    'the inverse prevents a vacuous implementation that never consumes mail');

  const late = { ...task, seq: 92, subject: 'arrived during model call' };
  const racingBus = transactionalBus(task, late);
  await runBrain({ seat: 'codex', brain: goodBrain, bus: racingBus.client, maxWakes: 1 });
  assert.deepEqual(racingBus.unread.map((item) => item.seq), [92],
    'committing the presented batch must not consume mail that arrived during the model call');
});

test('mail arriving during a stalled provider is received but remains unread after the presented wake commits', async () => {
  const first = { seq: 201, from: 'claude', to: 'codex', kind: 'task', subject: 'presented', body: 'work' };
  const late = { seq: 202, from: 'claude', to: 'codex', kind: 'task', subject: 'late', body: 'more work' };
  const fixture = transactionalBus(first);
  const events = [];
  let releaseProvider;
  let listenerRan;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  const listenerGate = new Promise((resolve) => { listenerRan = resolve; });
  let providerCalls = 0;
  let activeProviders = 0;
  let maxActiveProviders = 0;
  const originalListen = fixture.client.listen;
  let listeningCalls = 0;
  fixture.client.listen = async (_seat, _seconds, afterSeq, signal) => {
    listeningCalls += 1;
    if (listeningCalls === 1) {
      assert.equal(afterSeq, 201, 'the concurrent listener must skip the presented batch');
      fixture.enqueue(late);
      listenerRan();
      return 'mail';
    }
    assert.equal(afterSeq, 202, 'the listener cursor advances without acknowledging late mail');
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    return 'timeout';
  };
  const brain = {
    name: 'stalled',
    async takeTurn() {
      providerCalls += 1;
      activeProviders += 1;
      maxActiveProviders = Math.max(maxActiveProviders, activeProviders);
      await providerGate;
      activeProviders -= 1;
      return { done: true, note: 'presented batch consumed' };
    }
  };

  const running = runBrain({
    seat: 'codex', brain, bus: fixture.client, maxWakes: 1, providerStallMs: 0,
    log: (event, data) => events.push({ event, data })
  });
  await listenerGate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.unread.map((message) => message.seq), [201, 202],
    'concurrent reception must be durable and non-destructive');
  releaseProvider();
  await running;

  assert.equal(providerCalls, 1);
  assert.equal(maxActiveProviders, 1, 'reception must never start another provider call');
  assert.equal(fixture.acknowledgements, 1, 'the presented wake commits exactly once');
  assert.deepEqual(fixture.unread.map((message) => message.seq), [202],
    'mail received during the call belongs to the next transactional wake');
  for (const event of ['provider-thinking', 'provider-stalled', 'stall-start', 'stall-resolution', 'provider-exited', 'seat-listening']) {
    assert.equal(events.some((entry) => entry.event === event), true, `${event} must be explicit in logs`);
  }
  const resolution = events.find((entry) => entry.event === 'stall-resolution');
  assert.equal(resolution.data.outcome, 'returned');
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false,
    'a stall that resolves is not exhaustion');
  fixture.client.listen = originalListen;
});

test('every provider exit without a usable plan retains the presented batch', async () => {
  const task = { seq: 101, from: 'claude', to: 'codex', kind: 'task', subject: 'retain me', body: 'work' };
  const providers = [
    { name: 'provider throw', provider: { kind: 'test', async ask() { throw new Error('transport died'); } } },
    { name: 'error reply', provider: { kind: 'test', async ask() { return { text: 'failed', isError: true }; } } },
    { name: 'empty reply', provider: { kind: 'test', async ask() { return { text: '', isError: false }; } } }
  ];

  for (const sample of providers) {
    const fixture = transactionalBus(task);
    const brain = createAgentBrain({ seat: 'codex', provider: sample.provider, maxRounds: 1 });
    await runBrain({ seat: 'codex', brain, bus: fixture.client, maxWakes: 1 });
    assert.deepEqual(fixture.unread.map((message) => message.seq), [101], sample.name);
    assert.equal(fixture.acknowledgements, 0, sample.name);
  }
});

test('a poison message is parked after its own bounded retry budget', async () => {
  const poison = { seq: 111, from: 'claude', to: 'codex', kind: 'task', subject: 'poison', body: 'cannot parse' };
  const fixture = transactionalBus(poison);
  const events = [];
  const brain = { name: 'broken', async takeTurn() { return { done: true, retainMessages: true, note: 'invalid plan' }; } };

  await runBrain({
    seat: 'codex', brain, bus: fixture.client, maxWakes: 4, maxMessageAttempts: 3,
    log: (event, data) => events.push({ event, data })
  });

  assert.equal(fixture.unread.length, 0, 'the poison message must stop blocking the seat');
  assert.equal(fixture.acknowledgements, 0, 'parking uses the explicit durable path, not ordinary acknowledgement');
  assert.deepEqual(fixture.parked.map((message) => message.seq), [111]);
  const parked = events.find((entry) => entry.event === 'message-parked');
  assert.equal(parked.data.seq, 111);
  assert.equal(parked.data.attempts, 3);
  assert.match(parked.data.reason, /invalid plan/);
});

test('DELTA G: blocked work retains mail without spending poison attempts and carries openWork', async () => {
  const task = { seq: 115, from: 'claude', to: 'codex', kind: 'task', subject: 'blocked', body: 'work' };
  const fixture = transactionalBus(task);
  const events = [];
  const contexts = [];
  const brain = {
    name: 'blocked',
    async takeTurn(context) {
      contexts.push(context);
      return {
        done: false,
        retainMessages: true,
        blocked: true,
        note: 'claim blocked: grok holds src/brain'
      };
    }
  };

  await runBrain({
    seat: 'codex', brain, bus: fixture.client, maxWakes: 2, maxMessageAttempts: 1,
    blockedBackoffMs: 1, sleep: async () => {},
    log: (event, data) => events.push({ event, data })
  });

  assert.deepEqual(fixture.unread.map((message) => message.seq), [115]);
  assert.equal(fixture.parked.length, 0, 'a busy claim is not poison input');
  assert.equal(events.some((entry) => entry.event === 'message-retry'), false);
  assert.equal(events.some((entry) => entry.event === 'message-parked'), false);
  assert.equal(events.some((entry) => entry.event === 'wake-blocked-backoff'), true);
  assert.equal(contexts[1].openWork, 'claim blocked: grok holds src/brain');
});

test('DELTA I: blocked work escalates after its separate bounded retry budget', async () => {
  const task = { seq: 117, from: 'claude', to: 'codex', kind: 'task', subject: 'blocked forever', body: 'work' };
  const fixture = transactionalBus(task);
  const events = [];
  const backoffs = [];
  let providerCalls = 0;
  const brain = {
    name: 'blocked',
    async takeTurn() {
      providerCalls += 1;
      return { done: false, retainMessages: true, blocked: true, note: 'claim blocked: grok holds src/brain' };
    }
  };

  await runBrain({
    seat: 'codex', brain, bus: fixture.client, maxWakes: 5, maxBlockedAttempts: 3,
    blockedBackoffMs: 30_000, sleep: async (milliseconds) => { backoffs.push(milliseconds); },
    log: (event, data) => events.push({ event, data })
  });

  assert.equal(providerCalls, 3, 'parking must terminate paid blocked retries');
  assert.deepEqual(backoffs, [30_000, 30_000]);
  assert.equal(fixture.unread.length, 0);
  assert.deepEqual(fixture.parked.map((message) => message.seq), [117]);
  assert.match(fixture.parked[0].parkedReason, /blocked after 3 cycles/);
  assert.equal(events.filter((entry) => entry.event === 'message-blocked-escalated').length, 1);
  assert.equal(events.some((entry) => entry.event === 'message-retry'), false,
    'blocked cycles remain separate from poison-input attempts');
});

test('DELTA I: real agent retains failed mail and does not replay a committed send across wakes', async () => {
  const task = { seq: 116, from: 'claude', to: 'codex', kind: 'task', subject: 'failure', body: 'work' };
  let sends = 0;
  let claims = 0;
  const fixture = transactionalBus(task, undefined, {
    async send() { sends += 1; return { ok: true }; },
    async claim() {
      claims += 1;
      return { error: 'claim service failed', status: 500, code: 'internal_error', retriable: false };
    }
  });
  const plan = JSON.stringify({
    actions: [
      { type: 'send', to: 'claude', kind: 'report', subject: 'partial result', body: 'evidence landed' },
      { type: 'claim', paths: ['src/brain'], why: 'continue work' }
    ],
    done: false
  });
  let providerCalls = 0;
  const brain = createAgentBrain({
    seat: 'codex', maxRounds: 1,
    provider: { kind: 'test', async ask() { providerCalls += 1; return { text: plan, isError: false }; } },
    executePlanOptions: { claimRetryDelaysMs: [], sleep: async () => {} }
  });

  await runBrain({ seat: 'codex', brain, bus: fixture.client, maxWakes: 2, maxMessageAttempts: 2 });

  assert.equal(providerCalls, 2);
  assert.equal(sends, 1, 'the send accepted in wake one must be skipped when the plan is replayed');
  assert.equal(claims, 2, 'the refused action itself remains retryable');
  assert.equal(fixture.unread.length, 0);
  assert.deepEqual(fixture.parked.map((message) => message.seq), [116]);
});

test('a message that fails then succeeds is not parked and its attempt counter resets', async () => {
  const transient = { seq: 112, from: 'claude', to: 'codex', kind: 'task', subject: 'transient', body: 'provider blip' };
  const fixture = transactionalBus(transient);
  const events = [];
  let turns = 0;
  const brain = {
    name: 'recovers',
    async takeTurn() {
      turns += 1;
      return turns === 1
        ? { done: true, retainMessages: true, note: 'temporary provider error' }
        : { done: true, note: 'processed' };
    }
  };

  await runBrain({
    seat: 'codex', brain, bus: fixture.client, maxWakes: 2, maxMessageAttempts: 3,
    log: (event, data) => events.push({ event, data })
  });

  assert.equal(fixture.unread.length, 0);
  assert.equal(events.some((entry) => entry.event === 'message-parked'), false);
  const completed = events.find((entry) => entry.event === 'message-retry-cleared');
  assert.deepEqual(completed.data, { seat: 'codex', seq: 112, attempts: 1 });
});

test('one poison message cannot spend a later message retry budget', async () => {
  const poison = { seq: 113, from: 'claude', to: 'codex', kind: 'task', subject: 'poison', body: 'bad' };
  const healthy = { seq: 114, from: 'claude', to: 'codex', kind: 'task', subject: 'healthy', body: 'good' };
  const fixture = transactionalBus([poison, healthy]);
  const seen = [];
  const events = [];
  const brain = {
    name: 'selective',
    async takeTurn({ messages }) {
      seen.push(messages[0].seq);
      return messages[0].seq === poison.seq
        ? { done: true, retainMessages: true, note: 'poison input' }
        : { done: true, note: 'processed healthy input' };
    }
  };

  await runBrain({
    seat: 'codex', brain, bus: fixture.client, maxWakes: 4, maxMessageAttempts: 3,
    log: (event, data) => events.push({ event, data })
  });

  assert.deepEqual(seen, [113, 113, 113, 114]);
  assert.deepEqual(events.filter((entry) => entry.event === 'message-parked').map((entry) => entry.data.seq), [113]);
  assert.equal(fixture.unread.length, 0, 'the healthy message proceeds with an untouched budget');
});

test('a thrown takeTurn retains mail; a returned usable turn commits it', async () => {
  const task = { seq: 102, from: 'claude', to: 'codex', kind: 'task', subject: 'transaction', body: 'work' };
  const thrown = transactionalBus(task);
  await runBrain({
    seat: 'codex',
    brain: { name: 'thrower', async takeTurn() { throw new Error('brain crashed'); } },
    bus: thrown.client,
    maxWakes: 1
  });
  assert.deepEqual(thrown.unread.map((message) => message.seq), [102]);
  assert.equal(thrown.acknowledgements, 0);

  const usable = transactionalBus(task);
  await runBrain({
    seat: 'codex',
    brain: { name: 'usable', async takeTurn() { return { done: true }; } },
    bus: usable.client,
    maxWakes: 1
  });
  assert.equal(usable.unread.length, 0);
  assert.equal(usable.acknowledgements, 1);
});
