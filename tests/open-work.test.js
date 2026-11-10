const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { runBrain } = require('../dist/brain/runner.js');

/** A bus that delivers one task and then goes quiet forever, like a real one. */
function quietBus(firstMessages) {
  let delivered = false;
  const calls = { listen: 0, read: 0 };
  return {
    calls,
    client: {
      async listen() { calls.listen += 1; return 'timeout'; },
      async read() {
        calls.read += 1;
        if (delivered) return [];
        delivered = true;
        return firstMessages;
      },
      tools() {
        return {
          async send() { return {}; }, async status() { return {}; },
          async claim() { return {}; }, async release() { return {}; }, async runCapability() { return {}; }
        };
      }
    }
  };
}

const task = [{ seq: 1, from: 'hymlock', to: 'grok', kind: 'task', subject: 'audit', body: 'multi-step work' }];

test('a seat that says done:false gets another turn without waiting for mail', async () => {
  // The live failure. Two seats were given multi-step audits, acknowledged them, and stopped:
  // grok logged `messages:1, calls:0` and worker's own note read "Audit remains open". Nothing
  // was broken and nothing was progressing - no mail meant no wake, no wake meant no thinking,
  // so open work could never resume. Silence looked exactly like progress, again.
  const bus = quietBus(task);
  let turns = 0;
  const brain = {
    async takeTurn() {
      turns += 1;
      return { done: turns >= 3, note: `step ${turns}` };   // finishes on the third turn
    }
  };

  // Bounded to exactly the three turns the work needs, so every listen counted here would be
  // one taken BETWEEN the seat's own steps. Allowing extra wakes would also count the ordinary
  // listens a finished seat makes while waiting for new mail, which are correct.
  await runBrain({ seat: 'grok', brain, bus: bus.client, maxWakes: 3, listenSeconds: 300 });

  assert.equal(turns, 3, 'the brain must be able to finish work that spans several turns');
  assert.equal(bus.calls.listen, 0,
    'and must NOT block on a 300s listen between its own steps - that reads as a stall');
});

test('a continuation wake receives the note that described its open work', async () => {
  const bus = quietBus(task);
  const contexts = [];
  const brain = {
    async takeTurn(context) {
      contexts.push(context);
      return contexts.length === 1
        ? { done: false, note: 'investigate DELTA D continuation memory' }
        : { done: true, note: 'finished' };
    }
  };

  await runBrain({ seat: 'grok', brain, bus: bus.client, maxWakes: 2, listenSeconds: 300 });

  assert.equal(contexts[1].openWork, 'investigate DELTA D continuation memory');
});

test('completed work is not attached to a later unrelated wake', async () => {
  const laterTask = [{ seq: 2, from: 'claude', to: 'grok', kind: 'task', subject: 'later', body: 'unrelated work' }];
  const batches = [task, [], laterTask];
  const contexts = [];
  const bus = {
    async listen() { return 'timeout'; },
    async read() { return batches.shift() ?? []; },
    tools() {
      return {
        async send() { return {}; }, async status() { return {}; },
        async claim() { return {}; }, async release() { return {}; }, async runCapability() { return {}; }
      };
    }
  };
  const brain = {
    async takeTurn(context) {
      contexts.push(context);
      return contexts.length === 1
        ? { done: false, note: 'old task detail' }
        : { done: true, note: 'finished' };
    }
  };

  await runBrain({ seat: 'grok', brain, bus, maxWakes: 3, listenSeconds: 300 });

  assert.equal(contexts[1].openWork, 'old task detail');
  assert.equal(contexts[2].messages[0].subject, 'later');
  assert.equal(contexts[2].openWork, undefined, 'a completed task must clear continuation context');
});

test('CONTROL: without done:false the same seat stops after one turn', async () => {
  // Proves the test detects the bug rather than passing by construction. A brain that always
  // reports finished must idle-skip, which is the behaviour that keeps a quiet bus cheap.
  const bus = quietBus(task);
  let turns = 0;
  const brain = { async takeTurn() { turns += 1; return { done: true }; } };

  await runBrain({ seat: 'grok', brain, bus: bus.client, maxWakes: 8, listenSeconds: 300 });

  assert.equal(turns, 1, 'a finished seat must not keep thinking - that is what costs money');
});

test('open work does NOT survive an exhausted chain', async () => {
  // A seat with no provider left cannot continue by trying harder. Carrying "unfinished" past
  // exhaustion would spin at full speed on a problem no amount of turns can solve.
  const bus = quietBus(task);
  let turns = 0;
  const brain = {
    async takeTurn() { turns += 1; return { done: false, exhausted: true, note: 'no providers' }; }
  };

  await runBrain({ seat: 'grok', brain, bus: bus.client, maxWakes: 6, listenSeconds: 300, onExhausted: async () => {} });

  assert.equal(turns, 1, 'exhaustion ends the continuation, whatever `done` says');
});

test('a RUNNER budget breach does not earn another turn', async () => {
  // A brain that burned its entire per-wake tool budget is the last thing to hand another turn
  // to immediately. The runner's own cap sets done:true, which is what stops it.
  const bus = quietBus(task);
  let turns = 0;
  const brain = {
    async takeTurn({ tools }) {
      turns += 1;
      for (let i = 0; i < 50; i += 1) await tools.status();   // blow the budget
      return { done: false };
    }
  };

  await runBrain({ seat: 'grok', brain, bus: bus.client, maxWakes: 6, listenSeconds: 300, budgetPerWake: 3 });

  assert.equal(turns, 1, 'a budget breach must not immediately earn another wake');
});

test('a BRAIN that ran out of its own rounds DOES continue', async () => {
  // The distinction that cost an audit. Two caps look alike in the log and mean opposite things.
  // A brain reporting `done:false, capped:true` has honest unfinished work - the worker seat's
  // own note read "Audit is open" - and refusing to continue it stranded the seat entirely.
  const bus = quietBus(task);
  let turns = 0;
  const brain = {
    async takeTurn() {
      turns += 1;
      return turns < 3
        ? { done: false, capped: true, note: 'max-rounds' }
        : { done: true, note: 'finished' };
    }
  };

  await runBrain({ seat: 'worker', brain, bus: bus.client, maxWakes: 3, listenSeconds: 300 });

  assert.equal(turns, 3, 'running out of rounds bounds a WAKE, not the work');
  assert.equal(bus.calls.listen, 0, 'and it must not wait for mail to resume');
});

test('the log says whether a seat is continuing, so a watcher can tell work from a stall', async () => {
  const bus = quietBus(task);
  const events = [];
  let turns = 0;
  const brain = { async takeTurn() { turns += 1; return { done: turns >= 2 }; } };

  await runBrain({
    seat: 'grok', brain, bus: bus.client, maxWakes: 6, listenSeconds: 300,
    log: (event, data) => events.push({ event, data })
  });

  const completions = events.filter((e) => e.event === 'wake-complete');
  assert.equal(completions[0].data.continuing, true, 'first turn left work open');
  assert.equal(completions[1].data.continuing, false, 'second turn finished it');
});
