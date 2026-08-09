const assert = require('node:assert/strict');
const test = require('node:test');
const { runBrain } = require('../dist/brain/runner.js');

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
  const summary = await runBrain({ seat: 'claude', brain, bus, maxWakes: 3 });
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
