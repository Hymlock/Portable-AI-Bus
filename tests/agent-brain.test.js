const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
require('./helpers/require-fresh-dist')();
const { chainProviders } = require('../dist/brain/chain.js');
const {
  createAgentBrain,
  buildWakePrompt,
  parsePlan,
  receiptPlan,
  executePlan,
  WAKE_FIELD_LIMIT_BYTES
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
      async supersede() { return {}; },
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

test('BrainAction parses and executes a sender-authorized supersede request', async () => {
  const parsed = parsePlan(JSON.stringify({
    actions: [{ type: 'supersede', seq: 12, by: 14, reason: 'corrected instruction' }],
    done: true
  }));
  assert.equal(parsed.malformed, false);

  const calls = [];
  const api = {
    ...tools().api,
    async supersede(input) { calls.push(input); return {}; }
  };
  assert.deepEqual(await executePlan(api, parsed.plan), []);
  assert.deepEqual(calls, [{ seq: 12, by: 14, reason: 'corrected instruction' }]);
});

test('BrainAction rejects malformed supersede identities before reaching the bus', () => {
  for (const action of [
    { type: 'supersede', seq: 0, by: 2, reason: 'bad original' },
    { type: 'supersede', seq: 1, by: 1.5, reason: 'bad replacement' },
    { type: 'supersede', seq: 1, by: 2, reason: '' }
  ]) {
    const parsed = parsePlan(JSON.stringify({ actions: [action], done: true }));
    assert.equal(parsed.malformed, true);
    assert.deepEqual(parsed.plan.actions, []);
  }
});

test('DELTA I: malformed-plan logging retains a reparsable payload', async () => {
  const malformed = `prefix ${'x'.repeat(200)} {not-json}`;
  const events = [];
  const brain = createAgentBrain({
    seat: 'codex', maxRounds: 1,
    provider: { kind: 'test', async ask() { return { text: malformed, isError: false }; } },
    log: (event, data) => events.push({ event, data })
  });
  await brain.takeTurn({
    seat: 'codex', reason: 'mail', messages: [{ ...msg(8), to: 'codex', kind: 'task' }],
    tools: { ...tools().api, async listCapabilities() { return []; } }, budget: 10, log: () => {}
  });

  const event = events.find((entry) => entry.event === 'malformed-plan');
  assert.equal(event.data.payload, malformed);
  assert.equal(event.data.truncated, false);
});

test('DELTA G: persistent claim conflict is blocked, bounded, and fail-fast', async () => {
  let claims = 0;
  let sends = 0;
  const failures = await executePlan({
    async claim() {
      claims += 1;
      return {
        error: 'grok already holds src/brain since now: audit',
        status: 409,
        code: 'claim_conflict',
        retriable: true
      };
    },
    async send() { sends += 1; return {}; },
    async status() { return {}; },
    async release() { return {}; },
    async runCapability() { return {}; }
  }, {
    actions: [
      { type: 'claim', paths: ['src/brain'], why: 'change it' },
      { type: 'send', to: 'claude', subject: 'must not run', body: 'dependent' }
    ],
    done: true
  }, {}, { claimRetryDelaysMs: [1, 2], sleep: async () => {} });

  assert.equal(claims, 3, 'one attempt plus bounded retries');
  assert.equal(sends, 0, 'later actions must not execute after a refused claim');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, 'claim_conflict');
  assert.equal(failures[0].status, 409);
  assert.equal(failures[0].retriable, true);
});

test('DELTA G: transient claim conflict retries then executes following action exactly once', async () => {
  let claims = 0;
  let sends = 0;
  const failures = await executePlan({
    async claim() {
      claims += 1;
      return claims === 1
        ? { error: 'grok already holds src/brain', status: 409, code: 'claim_conflict', retriable: true }
        : {};
    },
    async send() { sends += 1; return {}; },
    async status() { return {}; },
    async release() { return {}; },
    async runCapability() { return {}; }
  }, {
    actions: [
      { type: 'claim', paths: ['src/brain'], why: 'change it' },
      { type: 'send', to: 'claude', kind: 'report', subject: 'done', body: 'fixed' }
    ],
    done: true
  }, {}, { claimRetryDelaysMs: [1], sleep: async () => {} });

  assert.deepEqual(failures, []);
  assert.equal(claims, 2);
  assert.equal(sends, 1);
});

test('DELTA G: agent classifies a persistent 409 as blocked without provider repair', async () => {
  let providerCalls = 0;
  const events = [];
  const plan = JSON.stringify({
    actions: [
      { type: 'claim', paths: ['src/brain'], why: 'change it' },
      { type: 'send', to: 'claude', kind: 'report', subject: 'must not run', body: 'dependent' }
    ],
    done: true
  });
  const provider = {
    kind: 'test',
    async ask() { providerCalls += 1; return { text: plan, isError: false }; },
    async probe() { return { ok: true, detail: 'test' }; }
  };
  const api = {
    async status() { return { agents: ['claude', 'codex', 'grok'] }; },
    async claim() {
      return { error: 'grok already holds src/brain since now: audit', status: 409, code: 'claim_conflict', retriable: true };
    },
    async send() { throw new Error('dependent action must not execute'); },
    async release() { return {}; },
    async runCapability() { return {}; },
    async listCapabilities() { return []; }
  };
  const brain = createAgentBrain({
    seat: 'codex', provider,
    executePlanOptions: { claimRetryDelaysMs: [1], sleep: async () => {} },
    log: (event, data) => events.push({ event, data })
  });

  const result = await brain.takeTurn({
    seat: 'codex', reason: 'mail',
    messages: [{ ...msg(9), to: 'codex', kind: 'task' }],
    tools: api, budget: 10, log: () => {}
  });

  assert.equal(providerCalls, 1, 'a valid plan is not sent back to the provider for repair');
  assert.equal(result.done, false);
  assert.equal(result.retainMessages, true);
  assert.equal(result.blocked, true);
  assert.match(result.note, /grok holds src\/brain/);
  assert.equal(events.some((entry) => entry.event === 'plan-action-blocked'), true);
  assert.equal(events.some((entry) => entry.event === 'plan-actions-failed'), false);
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

test('parsePlan directly peels pretty Grok envelopes with compact and spaced plans', () => {
  const compact = JSON.stringify({
    actions: [{ type: 'send', to: 'claude', kind: 'report', subject: 'compact', body: 'verified' }],
    done: true
  });
  const spaced = '{ "actions": [ { "type": "send", "to": "claude", "kind": "report", ' +
    '"subject": "spaced", "body": "verified" } ], "done": true }';

  for (const inner of [compact, spaced]) {
    const document = JSON.stringify({ text: inner, stopReason: 'end_turn' }, null, 2);
    const parsed = parsePlan(document);
    assert.equal(parsed.malformed, false);
    assert.equal(parsed.plan.actions.length, 1);
    assert.equal(parsed.plan.actions[0].kind, 'report');
  }
});

test('parsePlan directly reverses live 123-byte terminal wraps in a prefixed pretty envelope', () => {
  const plan = JSON.stringify({
    actions: [{
      type: 'send', to: 'claude', kind: 'report', subject: 'wrapped',
      body: 'The exact provider payload remains intact. '.repeat(40)
    }],
    done: true
  });
  const encoded = JSON.stringify(plan);
  const wrapped = encoded.match(/.{1,123}/gs).join('\r\n');
  const document = [
    'WARN auto-worktree cleanup failed',
    '{',
    `  "text": ${wrapped},`,
    '  "stopReason": "end_turn"',
    '}'
  ].join('\r\n');

  const parsed = parsePlan(document);
  assert.equal(parsed.malformed, false);
  assert.deepEqual(parsed.plan.actions, JSON.parse(plan).actions);
});

test('historical ConPTY-corrupted Grok documents remain rejected, not speculatively healed', () => {
  for (const name of [
    'grok-conpty-corrupted-event-99.txt',
    'grok-conpty-corrupted-event-100.txt'
  ]) {
    const document = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
    const parsed = parsePlan(document);
    assert.equal(parsed.malformed, true, `${name} must remain malformed`);
    assert.equal(parsed.plan.note, 'no-json-object');
  }
});

test('parsePlan takes the last valid plan from concatenated provider envelopes', () => {
  const progress = JSON.stringify({
    actions: [{ type: 'send', to: 'codex', kind: 'progress', subject: 'working', body: 'still auditing' }],
    done: false
  });
  const report = JSON.stringify({
    actions: [{ type: 'send', to: 'codex', kind: 'report', subject: 'audit', body: 'PASS' }],
    done: true
  });
  const leakedStream = `${JSON.stringify({ text: progress })}\r\n${JSON.stringify({ text: report })}`;

  const parsed = parsePlan(leakedStream);

  assert.equal(parsed.malformed, false);
  assert.equal(parsed.plan.done, true);
  assert.equal(parsed.plan.actions.length, 1);
  assert.equal(parsed.plan.actions[0].kind, 'report');
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

test('buildWakePrompt presents durable continuation context without inventing it on idle wakes', () => {
  const continuation = buildWakePrompt('grok', [], 'investigate DELTA D continuation memory');
  assert.match(continuation, /Open work from your previous wake:/);
  assert.match(continuation, /investigate DELTA D continuation memory/);

  const idle = buildWakePrompt('grok', []);
  assert.doesNotMatch(idle, /Open work from your previous wake:/);
  assert.doesNotMatch(idle, /investigate DELTA D continuation memory/);
});

test('buildWakePrompt marks an oversized message with its sequence and exact omitted byte count', () => {
  // Bind to the REAL limit. This test used to hardcode 32 KiB and assert "8 UTF-8 bytes omitted";
  // once the limit dropped to 12 KiB the true count was 20488, which still contains that substring,
  // so it kept passing for the wrong reason. Deriving the expectation makes it fail when the
  // arithmetic is wrong rather than when a digit happens not to line up.
  const body = `${'a'.repeat(WAKE_FIELD_LIMIT_BYTES)}\u{1F642}tail`;
  const omitted = Buffer.byteLength(body, 'utf8') - WAKE_FIELD_LIMIT_BYTES;
  const prompt = buildWakePrompt('grok', [{ ...msg(42), body }]);

  assert.match(prompt, /TRUNCATED MESSAGE #42/);
  assert.match(prompt, new RegExp(`\\b${omitted} UTF-8 bytes omitted\\b`));
  assert.match(prompt, /\.ai-bus\/runtime\/mailbox\/inbox\/000042-claude-to-grok\.json/);
  assert.equal(prompt.includes(body), false);
});

test('buildWakePrompt passes a message below the limit through byte-for-byte without a marker', () => {
  const body = 'short unicode brief \u{1F642}\nwith its original newline';
  const prompt = buildWakePrompt('grok', [{ ...msg(43), body }]);

  assert.equal(prompt.includes(body), true);
  assert.doesNotMatch(prompt, /TRUNCATED MESSAGE|bytes omitted/);
});

// The wake field limit is bounded by the WINDOWS COMMAND LINE, not by model context: providers
// pass the assembled prompt as an argv element and CreateProcess caps the whole command line at
// 32,767 characters. Measured against the real codex CLI: 31,000-character prompts answer normally,
// 40,000 returns code 255 with no output.
//
// The other truncation tests here use bodies larger than every candidate limit, so they pass at any
// setting and cannot catch a limit raised past the budget. This one can: it fails if a maximum-size
// wake prompt no longer leaves room for the system prompt, action schema and flags wrapped around
// it. Raising the ceiling requires moving prompts off argv - stdin or a file - not a bigger number.
test('a maximum-size wake prompt still fits inside the Windows command-line budget', () => {
  const WINDOWS_COMMAND_LINE_MAX = 32767;
  const RESERVED_FOR_SYSTEM_PROMPT_AND_FLAGS = 8 * 1024;
  const budget = WINDOWS_COMMAND_LINE_MAX - RESERVED_FOR_SYSTEM_PROMPT_AND_FLAGS;

  const oversized = 'x'.repeat(64 * 1024);
  const prompt = buildWakePrompt('grok', [{ ...msg(44), body: oversized }], oversized);
  const bytes = Buffer.byteLength(prompt, 'utf8');

  assert.ok(
    bytes <= budget,
    `a fully saturated wake prompt is ${bytes} bytes, over the ${budget}-byte argv budget; ` +
    'lower WAKE_FIELD_LIMIT_BYTES or move prompts off the command line'
  );
});

test('buildWakePrompt marks oversized open work and leaves short open work unchanged', () => {
  const limit = WAKE_FIELD_LIMIT_BYTES;
  const longOpenWork = `${'b'.repeat(limit)}\u{1F642}tail`;
  const truncated = buildWakePrompt('codex', [], longOpenWork);
  assert.match(truncated, /TRUNCATED OPEN WORK/);
  assert.match(truncated, /8 UTF-8 bytes omitted/);

  const shortOpenWork = 'continue the exact remaining audit';
  const complete = buildWakePrompt('codex', [], shortOpenWork);
  assert.equal(complete.includes(shortOpenWork), true);
  assert.doesNotMatch(complete, /TRUNCATED OPEN WORK|bytes omitted/);
});

test('the copyable system-prompt example sends only to an addressable live seat', async () => {
  const { api, sent } = tools();
  api.status = async () => ({ agents: ['claude', 'codex', 'grok'] });
  let exampleRecipient;
  const provider = {
    kind: 'test',
    async ask(_prompt, options) {
      const start = options.systemPrompt.indexOf('{"actions":[');
      const end = options.systemPrompt.indexOf(' Action field requirements', start);
      assert.ok(start >= 0 && end > start, 'system prompt must contain a copyable JSON plan example');
      const example = options.systemPrompt.slice(start, end);
      const plan = JSON.parse(example);
      exampleRecipient = plan.actions[0].to;
      return { text: example, isError: false };
    },
    async probe() { return { ok: true, detail: 'test' }; }
  };
  const brain = createAgentBrain({ seat: 'codex', provider });

  const result = await brain.takeTurn({
    seat: 'codex', reason: 'mail', messages: [msg(2)], tools: api, budget: 10, log: () => {}
  });

  assert.equal(result.done, true);
  assert.ok(['claude', 'codex', 'grok'].includes(exampleRecipient),
    'the authored example recipient must come from the live roster, before routing repair');
  assert.equal(sent.length, 1);
  assert.ok(['claude', 'codex', 'grok'].includes(sent[0].to));
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

test('an empty cancelled provider reply is a provider error and never enters malformed repair', async () => {
  const { api, sent } = tools();
  const events = [];
  let calls = 0;
  const brain = createAgentBrain({
    seat: 'grok',
    maxRounds: 2,
    provider: {
      kind: 'grok',
      async ask() {
        calls += 1;
        return { text: 'cancelled', isError: true };
      }
    },
    log: (event, data) => events.push({ event, data })
  });

  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(20)], tools: api, budget: 10, log: () => {}
  });

  assert.equal(calls, 1, 'provider errors must not buy a malformed-plan repair call');
  assert.equal(result.note, 'provider-error-reply');
  assert.equal(result.retainMessages, true);
  assert.equal(events.some(({ event }) => event === 'provider-error-reply'), true);
  assert.equal(events.some(({ event }) => event === 'malformed-plan'), false);
  assert.equal(sent.length, 1, 'the durable receipt still records that the task was heard');
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
    failProvider('api', '401 unauthorized')
  ]);
  const { api, sent } = tools();
  const brain = createAgentBrain({ seat: 'grok', provider: chain });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(11), msg(12)], tools: api, budget: 10, log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(result.exhausted, true, 'runner onExhausted / reassignBaton signal');
  assert.equal(result.broken, undefined);
  assert.match(result.note || '', /chain-exhausted/);
  assert.match(result.note || '', /insufficient_quota/,
    'the durable exhaustion note must preserve enough detail to diagnose the failure');
  assert.equal(sent.length, 2, 'one receipt per message even when the chain is dead');
  assert.equal(sent.every((s) => s.kind === 'ack'), true);
});

test('ITEM 11: missing node-pty is BROKEN and must not reassign as spent', async () => {
  const chain = chainProviders([
    failProvider('grok', "ConPTY unavailable: Cannot find module 'node-pty'")
  ]);
  const { api, sent } = tools();
  const events = [];
  const brain = createAgentBrain({
    seat: 'grok',
    provider: chain,
    log: (event, data) => events.push({ event, data })
  });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'mail', messages: [msg(31)], tools: api, budget: 10, log: () => {}
  });
  assert.equal(result.done, true);
  assert.equal(result.broken, true);
  assert.equal(result.exhausted, false, 'BROKEN must not trip the spent-handoff');
  assert.match(result.note || '', /^BROKEN:/);
  assert.match(result.note || '', /Cannot find module 'node-pty'/);
  assert.equal(events.some((entry) => entry.event === 'chain-broken'), true);
  assert.equal(events.some((entry) => entry.event === 'provider-exhausted'), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'ack');
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
