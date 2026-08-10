const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentBrain } = require('../dist/brain/brains/index.js');

function stubTools(sent) {
  return {
    async send(input) { sent.push(input); return { ok: true }; },
    async status() { return { agents: ['claude', 'codex', 'grok', 'hymlock', 'worker'] }; },
    async claim() { return {}; },
    async release() { return {}; },
    async runCapability() { return {}; }
  };
}

/** A provider that replies with a scripted sequence of plans. */
function scriptedProvider(replies) {
  let i = 0;
  return {
    kind: 'cli',
    async probe() { return { ok: true, detail: '' }; },
    async ask() {
      const text = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return { text, isError: false };
    },
    get calls() { return i; }
  };
}

const taskMail = [{ seq: 1, from: 'hymlock', to: 'grok', kind: 'task', subject: 'audit', body: 'read the docs' }];

test('a seat cannot mark a TASK done without sending anything', async () => {
  // Every system-level cause of the stalled audits was fixed - continuation across turns, the
  // seat roster, refused actions surfaced - and the seats STILL acknowledged a multi-step audit
  // and reported done, having sent nothing back. The prompt asked them not to. Asking is not a
  // mechanism.
  const sent = [];
  const provider = scriptedProvider([
    JSON.stringify({ actions: [], done: true, note: 'looks fine' }),
    JSON.stringify({ actions: [], done: true, note: 'still fine' }),
    JSON.stringify({
      actions: [{ type: 'send', to: 'hymlock', kind: 'report', subject: 'findings', body: 'three false claims' }],
      done: true, note: 'reported'
    })
  ]);

  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 6 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: taskMail, tools: stubTools(sent), budget: 30, log: () => {}
  });

  assert.equal(sent.length, 1, 'the seat must not escape the wake without reporting');
  assert.equal(sent[0].to, 'hymlock');
  assert.equal(result.done, true, 'and once it HAS reported, done is honoured');
});

test('an ACK does not count as answering a task', async () => {
  // The loophole the seats found within minutes. The rule first asked only for "a send", so
  // eight acknowledgements arrived against a claim-by-claim audit and not one finding. An ack
  // says "I heard you"; the task asked for verdicts.
  const sent = [];
  const provider = scriptedProvider([
    JSON.stringify({
      actions: [{ type: 'send', to: 'hymlock', kind: 'ack', subject: 'ACK: audit', body: 'received' }],
      done: true, note: 'acknowledged'
    }),
    JSON.stringify({
      actions: [{ type: 'send', to: 'hymlock', kind: 'report', subject: 'findings', body: 'two false claims' }],
      done: true, note: 'reported'
    })
  ]);

  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 5 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: taskMail, tools: stubTools(sent), budget: 30, log: () => {}
  });

  assert.equal(result.done, true);
  assert.equal(sent.length, 2, 'the ack still goes out - echo on receipt is still the rule');
  assert.equal(sent[1].kind, 'report', 'but the wake only closes on a real answer');
});

test('continuation rounds suppress duplicate acknowledgements for the same task', async () => {
  const sent = [];
  const ack = JSON.stringify({
    actions: [{ type: 'send', to: 'hymlock', kind: 'ack', subject: 'ACK: audit', body: 'received' }],
    done: true
  });
  const provider = scriptedProvider([
    ack,
    ack,
    JSON.stringify({
      actions: [{ type: 'send', to: 'hymlock', kind: 'report', subject: 'result', body: 'finished' }],
      done: true
    })
  ]);
  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 4 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: taskMail, tools: stubTools(sent), budget: 30, log: () => {}
  });
  assert.equal(result.done, true);
  assert.deepEqual(sent.map((item) => item.kind), ['ack', 'report']);
});

test('an unanswered task keeps the wake open when rounds run out', async () => {
  const sent = [];
  const provider = scriptedProvider([JSON.stringify({ actions: [], done: true, note: 'nothing to do' })]);

  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 2 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: taskMail, tools: stubTools(sent), budget: 30, log: () => {}
  });

  assert.equal(result.done, false, 'unfinished, so the runner schedules another turn');
  assert.match(String(result.note), /without a report/);
});

test('a wake with NO task may finish silently', async () => {
  // The rule must be narrow. A seat woken by a note, or by nothing at all, is entitled to decide
  // there is nothing to do - otherwise every quiet wake becomes an argument with the model.
  const sent = [];
  const provider = scriptedProvider([JSON.stringify({ actions: [], done: true, note: 'idle' })]);
  const note = [{ seq: 2, from: 'claude', to: 'grok', kind: 'note', subject: 'fyi', body: 'no action needed' }];

  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 4 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: note, tools: stubTools(sent), budget: 30, log: () => {}
  });

  assert.equal(result.done, true, 'a non-task wake is allowed to be quiet');
  assert.equal(sent.length, 0, 'and must not be forced to invent a report');
});
