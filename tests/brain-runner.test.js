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

test('a failing handoff handler does not take the runner with it', async () => {
  const { bus } = makeBus({ script: [[msg(1, 'go')]] });
  const brain = { name: 'broke', async takeTurn() { return { done: true, exhausted: true }; } };
  const summary = await runBrain({
    seat: 'claude', brain, bus, maxWakes: 1,
    onExhausted: async () => { throw new Error('mailbox unreachable'); }
  });
  assert.equal(summary.stoppedBy, 'maxWakes', 'a broken handoff is not a reason to die');
});

function transactionalBus(message, injectOnAcknowledge) {
  let unread = message ? [message] : [];
  let acknowledgements = 0;
  return {
    get unread() { return unread.slice(); },
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
      async read() { throw new Error('transactional runner must not destructively read before the turn'); },
      tools() {
        return {
          async send() { return { ok: true }; },
          async status() { return { agents: ['claude', 'codex', 'grok'] }; },
          async claim() { return {}; },
          async release() { return {}; },
          async runCapability() { return {}; },
          async listCapabilities() { return []; }
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
