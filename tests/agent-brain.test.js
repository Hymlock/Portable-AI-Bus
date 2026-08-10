const assert = require('node:assert/strict');
const test = require('node:test');
const { chainProviders } = require('../dist/brain/chain.js');
const {
  createAgentBrain,
  buildWakePrompt,
  parsePlan,
  receiptPlan
} = require('../dist/brain/brains/agent.js');

const msg = (seq, from = 'claude') => ({
  seq,
  from,
  to: 'grok',
  kind: 'note',
  subject: `subject-${seq}`,
  body: `body-${seq}`
});

function tools() {
  const sent = [];
  return {
    sent,
    api: {
      async send(input) { sent.push(input); return { ok: true }; },
      async status() { return {}; },
      async claim() { return {}; },
      async release() { return {}; },
      async runCapability() { return {}; }
    }
  };
}

const okProvider = (kind, text) => ({
  kind,
  async ask() { return { text, isError: false }; },
  async probe() { return { ok: true, detail: kind }; }
});

const failProvider = (kind, detail) => ({
  kind,
  async ask() { return { text: detail, isError: true }; },
  async probe() { return { ok: false, detail }; }
});

const throwProvider = (kind, message) => ({
  kind,
  async ask() { throw new Error(message); },
  async probe() { return { ok: false, detail: message }; }
});

test('parsePlan accepts bare JSON and rejects fences-without-object as malformed', () => {
  const good = parsePlan('{"actions":[{"type":"done"}],"done":true}');
  assert.equal(good.malformed, false);
  assert.equal(good.plan.actions[0].type, 'done');

  const empty = parsePlan('   ');
  assert.equal(empty.malformed, true);

  const prose = parsePlan('Sure, I will help with that.');
  assert.equal(prose.malformed, true);
  assert.equal(prose.plan.note, 'no-json-object');
});

test('parsePlan unwraps provider answer envelopes at the final safety boundary', () => {
  const plan = JSON.stringify({
    actions: [{ type: 'send', to: 'codex', kind: 'ack', subject: 'received', body: 'working' }],
    done: false
  });
  const wrapped = JSON.stringify({ text: JSON.stringify({ response: plan }) });
  const parsed = parsePlan(wrapped);
  assert.equal(parsed.malformed, false);
  assert.equal(parsed.plan.done, false);
  assert.equal(parsed.plan.actions.length, 1);
  assert.equal(parsed.plan.actions[0].type, 'send');
});

test('parsePlan rejects type-only tool actions before they reach the Bus', () => {
  const missingId = parsePlan('{"actions":[{"type":"capability"}],"done":true}');
  assert.equal(missingId.malformed, true);
  assert.deepEqual(missingId.plan.actions, []);

  const emptyClaim = parsePlan('{"actions":[{"type":"claim","paths":[],"why":"work"}],"done":true}');
  assert.equal(emptyClaim.malformed, true);

  const valid = parsePlan('{"actions":[{"type":"capability","id":"bus.doctor","timeoutMs":60000}],"done":false}');
  assert.equal(valid.malformed, false);
  assert.equal(valid.plan.actions[0].id, 'bus.doctor');
});

test('one invalid sibling action does not discard valid work', () => {
  // Captured live from Grok: `claim` meant "I am taking this task", not a filesystem claim.
  // It must not reach the Bus, but the valid acknowledgement beside it should execute and the
  // done:false continuation should survive without a paid malformed-output repair.
  const mixed = parsePlan(JSON.stringify({
    actions: [
      { type: 'send', to: 'codex', kind: 'ack', subject: 'received', body: 'working' },
      { type: 'claim', id: '704', timeoutMs: 600000 }
    ],
    done: false
  }));
  assert.equal(mixed.malformed, false);
  assert.equal(mixed.plan.done, false);
  assert.deepEqual(mixed.plan.actions.map((action) => action.type), ['send']);
});

test('buildWakePrompt is vendor-neutral (no provider tooling names)', () => {
  const prompt = buildWakePrompt('grok', [msg(1)]);
  assert.match(prompt, /Seat: grok/);
  assert.match(prompt, /#1 from claude/);
  // Seat names may appear as mail participants; vendor product/tooling must not.
  assert.equal(/anthropic|openai|xai|api[_ ]?key|claude-code|output-format/i.test(prompt), false);
});

test('agent brain executes a model plan via tools (happy path)', async () => {
  const plan = JSON.stringify({
    actions: [
      { type: 'send', to: 'claude', kind: 'ack', subject: 'echo #1', body: 'got it', keepBaton: true }
    ],
    done: true,
    note: 'acked'
  });
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider: okProvider('api', plan) });
  const result = await brain.takeTurn({
    seat: 'grok',
    reason: 'mail',
    messages: [msg(1)],
    tools: api,
    budget: 10,
    log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'claude');
  assert.equal(sent[0].kind, 'ack');
  assert.equal(result.note, 'acked;servedBy=api', 'provider identity must survive a model-authored note');
});

test('ATTACK: mid-stream / first-link failure falls through; brain still answers', async () => {
  // First link throws mid-ask (ENOENT / killed); second returns a valid plan.
  const plan = JSON.stringify({
    actions: [{ type: 'send', to: 'claude', kind: 'ack', subject: 'ok', body: 'from-fallback' }],
    done: true
  });
  const chain = chainProviders([
    throwProvider('cli', 'ENOENT: claude not found'),
    okProvider('api', plan)
  ]);
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider: chain });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(7)], tools: api, budget: 10, log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body, 'from-fallback');
  assert.match(result.note || '', /servedBy=api/);
});

test('ATTACK: malformed model output yields receipt-only, not a throw', async () => {
  const { api, sent } = tools();
  const brain = createAgentBrain({
    seat: 'grok',
    provider: okProvider('api', 'Here is my plan:\n1. Do the thing\n2. Profit'),
    maxRounds: 2
  });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(3)], tools: api, budget: 10, log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(result.note, 'malformed-output');
  assert.equal(sent.length, 1, 'echo receipt must still fire');
  assert.equal(sent[0].kind, 'ack');
  assert.match(sent[0].subject, /#3/);
});

test('ATTACK: slow-but-successful first link is not abandoned', async () => {
  let secondCalled = false;
  const plan = JSON.stringify({
    actions: [{ type: 'send', to: 'claude', kind: 'note', subject: 'slow', body: 'patient' }],
    done: true
  });
  const slow = {
    kind: 'cli',
    async ask() {
      await new Promise((r) => setTimeout(r, 40));
      return { text: plan, isError: false };
    },
    async probe() { return { ok: true, detail: 'slow' }; }
  };
  const chain = chainProviders([
    slow,
    {
      kind: 'api',
      async ask() { secondCalled = true; return { text: 'nope', isError: false }; },
      async probe() { return { ok: true, detail: 'fast' }; }
    }
  ]);
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider: chain });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(9)], tools: api, budget: 10, log: () => {}
  });
  assert.equal(secondCalled, false, 'slow success must short-circuit the chain');
  assert.equal(sent[0].body, 'patient');
  assert.equal(result.done, true);
});

test('ATTACK: every provider exhausted — receipt + chain-exhausted note for baton move', async () => {
  const chain = chainProviders([
    failProvider('cli', 'insufficient_quota'),
    failProvider('api', '401 unauthorized'),
    throwProvider('exec', 'ENOENT vendor-cli')
  ]);
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider: chain });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(11), msg(12)], tools: api, budget: 10, log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(result.exhausted, true, 'runner onExhausted / reassignBaton signal');
  assert.match(result.note || '', /chain-exhausted/);
  assert.equal(sent.length, 2, 'one receipt per message even when the chain is dead');
  assert.equal(sent.every((s) => s.kind === 'ack'), true);
});

test('receiptPlan never invents vendor-specific content', () => {
  const plan = receiptPlan('grok', [msg(1)]);
  const body = plan.actions[0].body;
  assert.equal(/anthropic|openai|api key|claude code/i.test(body), false);
});

test('provider throw path also receipts without killing the turn', async () => {
  const { api, sent } = tools();
  const brain = createAgentBrain({
    seat: 'grok',
    provider: throwProvider('api', 'ECONNRESET mid body')
  });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(4)], tools: api, budget: 5, log: () => {}
  });
  assert.equal(result.done, true);
  assert.match(result.note || '', /provider-threw/);
  assert.equal(sent.length, 1);
});

test('repair-call exhaustion still receipts and signals baton failover', async () => {
  let calls = 0;
  const provider = {
    kind: 'cli',
    async ask() {
      calls += 1;
      if (calls === 1) return { text: 'not json', isError: false, servedBy: 'cli', attempts: [], exhausted: false };
      return {
        text: '', isError: true, exhausted: true,
        attempts: [{ kind: 'cli', ok: false, reason: 'quota' }]
      };
    },
    async probe() { return { ok: true, detail: '' }; }
  };
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 2 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(21)], tools: api, budget: 5, log: () => {}
  });
  assert.equal(result.exhausted, true);
  assert.match(result.note, /chain-exhausted:attempts=cli:quota/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'ack');
});

test('repair-call throw still sends a receipt instead of escaping the wake', async () => {
  let calls = 0;
  const provider = {
    kind: 'cli',
    async ask() {
      calls += 1;
      if (calls === 1) return { text: 'not json', isError: false };
      throw new Error('connection vanished during repair');
    },
    async probe() { return { ok: true, detail: '' }; }
  };
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider, maxRounds: 2 });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(22)], tools: api, budget: 5, log: () => {}
  });
  assert.match(result.note, /provider-threw/);
  assert.equal(sent.length, 1);
});

test('a repaired refused action cannot finish a task with only an acknowledgement', async () => {
  const replies = [
    { actions: [{ type: 'capability' }], done: true },
    { actions: [{ type: 'send', to: 'claude', kind: 'ack', subject: 'heard', body: 'working' }], done: true },
    { actions: [{ type: 'send', to: 'claude', kind: 'report', subject: 'result', body: 'actual finding' }], done: true }
  ];
  let calls = 0;
  const provider = {
    kind: 'codex',
    async ask() { return { text: JSON.stringify(replies[calls++]), isError: false }; },
    async probe() { return { ok: true, detail: 'ok' }; }
  };
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'worker', provider, maxRounds: 3 });
  const result = await brain.takeTurn({
    seat: 'worker', reason: 'mail', messages: [{ ...msg(23), kind: 'task' }], tools: api, budget: 10, log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(calls, 3);
  assert.deepEqual(sent.map((item) => item.kind), ['ack', 'report']);
  assert.equal(sent[1].body, 'actual finding');
});
