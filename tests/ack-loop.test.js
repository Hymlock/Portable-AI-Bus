const assert = require('node:assert/strict');
const test = require('node:test');
const { runBrain } = require('../dist/brain/runner.js');

/** A bus whose seats deliver to each other, so an ack really does wake the other side. */
function twoSeatBus() {
  const inboxes = { a: [], b: [] };
  let seq = 0;
  return {
    inboxes,
    sent: [],
    client(sent) {
      return {
        async listen(seat) { return inboxes[seat].length > 0 ? 'mail' : 'timeout'; },
        async read(seat) { const m = inboxes[seat]; inboxes[seat] = []; return m; },
        tools(seat) {
          return {
            async send(input) {
              seq += 1;
              sent.push({ from: seat, ...input });
              const target = inboxes[input.to];
              if (target) target.push({ seq, from: seat, to: input.to, kind: input.kind, subject: input.subject, body: input.body });
              return { ok: true };
            },
            async status() { return {}; },
            async claim() { return {}; },
            async release() { return {}; },
            async runCapability() { return {}; }
          };
        }
      };
    }
  };
}

/** A brain that does what the prompt tells every seat to do: acknowledge everything. */
const politeBrain = (partner) => ({
  async takeTurn({ messages, tools }) {
    for (const _ of messages) {
      await tools.send({ to: partner, kind: 'ack', subject: 're: your message', body: 'received' });
    }
    return { done: true };
  }
});

test('two polite brains do not acknowledge each other forever', async () => {
  // The live failure. A relay test between the codex and grok seats completed correctly, and
  // then the RECEIPTS kept both seats calling the model - each ack waking the other, each wake
  // spawning a process - until they were killed by hand. Both brains were obeying the prompt.
  const bus = twoSeatBus();
  const sent = [];
  const client = bus.client(sent);

  // Seed one real task, which legitimately earns one ack.
  bus.inboxes.a.push({ seq: 0, from: 'operator', to: 'a', kind: 'task', subject: 'go', body: 'do a thing' });

  await Promise.all([
    runBrain({ seat: 'a', brain: politeBrain('b'), bus: client, maxWakes: 20, listenSeconds: 0 }),
    runBrain({ seat: 'b', brain: politeBrain('a'), bus: client, maxWakes: 20, listenSeconds: 0 })
  ]);

  const acks = sent.filter((m) => m.kind === 'ack');
  assert.ok(acks.length <= 2,
    `an ack must not earn an ack; got ${acks.length} acks: ${JSON.stringify(acks.map((a) => `${a.from}->${a.to}`))}`);
});

test('CONTROL: with the cut disabled, the same setup runs away', async () => {
  // Without this, the test above proves nothing - it would pass on a build where the guard was
  // deleted, because two polite brains might simply have run out of wakes. Disabling ackKinds
  // reproduces the live failure exactly, which is how we know the assertion has teeth.
  const bus = twoSeatBus();
  const sent = [];
  const client = bus.client(sent);
  bus.inboxes.a.push({ seq: 0, from: 'operator', to: 'a', kind: 'task', subject: 'go', body: 'do a thing' });

  await Promise.all([
    runBrain({ seat: 'a', brain: politeBrain('b'), bus: client, maxWakes: 20, listenSeconds: 0, ackKinds: [] }),
    runBrain({ seat: 'b', brain: politeBrain('a'), bus: client, maxWakes: 20, listenSeconds: 0, ackKinds: [] })
  ]);

  const acks = sent.filter((m) => m.kind === 'ack');
  assert.ok(acks.length > 2,
    `the runaway must be reproducible, otherwise the guard is untested; got ${acks.length}`);
});

test('an ack-only wake costs no model call', async () => {
  // Counts only turns that CARRY messages. An empty timeout wake reaching the brain is by
  // design - that is how a seat acts without being prompted - so counting every turn would
  // measure the wrong thing.
  let turns = 0;
  const inbox = [{ seq: 1, from: 'b', to: 'a', kind: 'ack', subject: 're:', body: 'received' }];
  const client = {
    async listen() { return 'timeout'; },
    async read() { const m = inbox.splice(0); return m; },
    tools() {
      return {
        async send() { return {}; }, async status() { return {}; },
        async claim() { return {}; }, async release() { return {}; }, async runCapability() { return {}; }
      };
    }
  };

  const summary = await runBrain({
    seat: 'a',
    brain: { async takeTurn({ messages }) { if (messages.length) turns += 1; return { done: true }; } },
    bus: client, maxWakes: 3, listenSeconds: 0
  });

  assert.equal(turns, 0, 'the brain must never be asked to think about a bare receipt');
  assert.ok(summary.wakes > 0, 'the wake still HAPPENED and is still on the record');
});

test('a wake mixing a task with an ack still reaches the brain', async () => {
  // The cut must be narrow. Dropping a wake because it happens to contain a receipt would lose
  // real work, which is a worse failure than the loop it prevents.
  let seen = null;
  const inbox = [
    { seq: 1, from: 'b', to: 'a', kind: 'ack', subject: 're:', body: 'received' },
    { seq: 2, from: 'b', to: 'a', kind: 'task', subject: 'real work', body: 'please do this' }
  ];
  const client = {
    async listen() { return 'timeout'; },
    async read() { return inbox.splice(0); },
    tools() {
      return {
        async send() { return {}; }, async status() { return {}; },
        async claim() { return {}; }, async release() { return {}; }, async runCapability() { return {}; }
      };
    }
  };

  await runBrain({
    seat: 'a',
    // Records the first wake that CARRIES mail; a later empty timeout wake would otherwise
    // overwrite it and hide the answer.
    brain: { async takeTurn({ messages }) { if (messages.length && !seen) seen = messages; return { done: true }; } },
    bus: client, maxWakes: 2, listenSeconds: 0
  });

  assert.ok(seen, 'the brain must be woken');
  assert.equal(seen.length, 2, 'and must see the receipt too, for context');
});

test('ackKinds is configurable and matched case-insensitively', async () => {
  let turns = 0;
  const inbox = [{ seq: 1, from: 'b', to: 'a', kind: 'ACK', subject: 're:', body: 'received' }];
  const client = {
    async listen() { return 'timeout'; },
    async read() { return inbox.splice(0); },
    tools() {
      return {
        async send() { return {}; }, async status() { return {}; },
        async claim() { return {}; }, async release() { return {}; }, async runCapability() { return {}; }
      };
    }
  };
  await runBrain({
    seat: 'a',
    brain: { async takeTurn({ messages }) { if (messages.length) turns += 1; return { done: true }; } },
    bus: client, maxWakes: 2, listenSeconds: 0
  });
  assert.equal(turns, 0, 'a seat shouting ACK is still sending an ack');
});

