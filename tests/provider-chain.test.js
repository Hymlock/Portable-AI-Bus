const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { chainProviders, classifyFailure, classifyGiveUp } = require('../dist/brain/chain.js');

const ok = (kind, text) => ({
  kind,
  async ask() { return { text, isError: false }; },
  async probe() { return { ok: true, detail: `${kind} ready` }; }
});

const fails = (kind, detail) => ({
  kind,
  async ask() { return { text: detail, isError: true }; },
  async probe() { return { ok: false, detail }; }
});

const throws = (kind, message) => ({
  kind,
  async ask() { throw new Error(message); },
  async probe() { return { ok: false, detail: message }; }
});

test('a seat survives its first provider running out of tokens', async () => {
  // Hymlock's constraint, stated as a test: "if we run out of tokens on Codex our bus has
  // stopped" must become false. Exhaustion of one link demotes the seat; it does not stop it.
  const chain = chainProviders([
    fails('cli', 'Error: insufficient_quota - you have run out of credits'),
    ok('api', 'answered by the fallback')
  ]);
  const reply = await chain.ask('hello');

  assert.equal(reply.isError, false);
  assert.equal(reply.text, 'answered by the fallback');
  assert.equal(reply.servedBy, 'api', 'the reply must record WHICH link served it');
  assert.equal(reply.exhausted, false);
  assert.equal(reply.attempts[0].reason, 'quota', 'and why the first was skipped');
});

test('a chain survives two dead links and answers from the third', async () => {
  const chain = chainProviders([
    throws('cli', 'ENOENT: command not found'),
    fails('api', '401 unauthorized: no api key'),
    ok('exec', 'third time lucky')
  ]);
  const reply = await chain.ask('hello');
  assert.equal(reply.text, 'third time lucky');
  assert.equal(reply.servedBy, 'exec');
  assert.deepEqual(reply.attempts.map((a) => a.reason), ['unavailable', 'auth', undefined]);
});

test('every link exhausted is reported DISTINCTLY from a bad answer', async () => {
  // This is the signal that should move the baton. If it were indistinguishable from "the model
  // replied badly", a seat with no providers left would look like a seat having a bad day, and
  // nothing would ever hand off.
  const chain = chainProviders([
    fails('cli', 'out of tokens'),
    fails('api', 'insufficient_quota')
  ]);
  const reply = await chain.ask('hello');

  assert.equal(reply.exhausted, true, 'exhausted must be its own signal');
  assert.equal(reply.isError, true);
  assert.equal(reply.servedBy, undefined, 'nobody served it');
  assert.equal(reply.attempts.length, 2, 'and every attempt is on the record');
});

test('an empty answer counts as failure and falls through', async () => {
  // A silent success and a broken provider are indistinguishable downstream, and misreading
  // silence is the failure this whole project keeps repeating.
  const chain = chainProviders([ok('cli', '   '), ok('api', 'real answer')]);
  const reply = await chain.ask('hello');
  assert.equal(reply.text, 'real answer');
  assert.equal(reply.servedBy, 'api');
});

test('the first healthy link short-circuits the rest', async () => {
  let secondCalled = false;
  const chain = chainProviders([
    ok('cli', 'first'),
    { kind: 'api', async ask() { secondCalled = true; return { text: 'second', isError: false }; },
      async probe() { return { ok: true, detail: '' }; } }
  ]);
  const reply = await chain.ask('hello');
  assert.equal(reply.text, 'first');
  assert.equal(secondCalled, false, 'a chain must not spend money it does not need to');
});

test('probe reports the whole chain, not just the head', async () => {
  const chain = chainProviders([fails('cli', 'not installed'), ok('api', 'x')]);
  const result = await chain.probe();
  assert.equal(result.ok, true, 'usable if ANY link is usable');
  assert.match(result.detail, /1\/2/);

  const dead = chainProviders([fails('cli', 'not installed'), fails('api', 'no key')]);
  const deadResult = await dead.probe();
  assert.equal(deadResult.ok, false);
  assert.match(deadResult.detail, /NO usable provider/);
});

test('fallThroughOn can narrow what justifies trying the next link', async () => {
  const chain = chainProviders(
    [fails('cli', 'malformed request'), ok('api', 'never reached')],
    { fallThroughOn: ['quota', 'rate-limit'] }
  );
  const reply = await chain.ask('hello');
  assert.equal(reply.exhausted, true, 'a plain error stops the chain when configured to');
});

test('failure classification covers the shapes providers actually emit', () => {
  assert.equal(classifyFailure('insufficient_quota'), 'quota');
  // A SUBSCRIPTION says "session limit", and it means CONCURRENCY, not an empty wallet -
  // verified against the account, which was at 30% session and 51% weekly when this fired.
  // It must classify as rate-limit so the chain retries the same link rather than abandoning
  // a healthy provider.
  assert.equal(classifyFailure("You've hit your session limit · resets 2:50pm"), 'rate-limit');
  assert.equal(classifyFailure('too many concurrent sessions'), 'rate-limit');
  assert.equal(classifyFailure('You have run out of credits'), 'quota');
  assert.equal(classifyFailure('402 Payment Required'), 'quota',
    'bare HTTP 402 must stay SPENT, not collapse into BROKEN or mixed');
  assert.equal(classifyFailure('429 Too Many Requests'), 'rate-limit');
  assert.equal(classifyFailure('401 Unauthorized'), 'auth');
  assert.equal(classifyFailure('ENOENT'), 'unavailable');
  assert.equal(classifyFailure("ConPTY unavailable: Cannot find module 'node-pty'"), 'unavailable',
    'the measured 2026-08-15 outage string must not collapse to generic error');
  assert.equal(classifyFailure("Cannot find module 'node-pty'"), 'unavailable');
  assert.equal(classifyFailure('something nobody predicted'), 'error',
    'an unknown failure must still classify, and still fall through');
});

test('ITEM 11 RED-then-green: a missing node-pty reports BROKEN, not SPENT', async () => {
  const measured = "ConPTY unavailable: Cannot find module 'node-pty'";
  const events = [];
  const reply = await chainProviders([
    fails('grok', measured)
  ], { log: (event, data) => events.push({ event, data }) }).ask('ping');

  assert.equal(classifyGiveUp(reply.attempts), 'broken');
  assert.equal(reply.giveUp, 'broken');
  assert.equal(reply.broken, true);
  assert.equal(reply.exhausted, true, 'nobody served; exhausted still means the chain gave up');
  const broken = events.find((entry) => entry.event === 'chain-broken');
  assert.ok(broken, 'operator-visible event must be chain-broken');
  assert.match(broken.data.error, /Cannot find module 'node-pty'/);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false,
    'must not announce SPENT / out of providers for a transport failure');
});

test('ITEM 11 regression: a genuine 402 still reports SPENT', async () => {
  for (const detail of [
    '402 insufficient_quota - you have run out of credits',
    '402 Payment Required'
  ]) {
    const events = [];
    const reply = await chainProviders([
      fails('cli', detail)
    ], { log: (event, data) => events.push({ event, data }) }).ask('ping');

    assert.equal(reply.giveUp, 'spent', detail);
    assert.equal(reply.broken, false, detail);
    assert.equal(reply.exhausted, true, detail);
    assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), true, detail);
    assert.equal(events.some((entry) => entry.event === 'chain-broken'), false, detail);
  }
});

test('ITEM 11 mixed reasons do not collapse to out of providers', async () => {
  const events = [];
  const reply = await chainProviders([
    fails('cli', 'insufficient_quota'),
    fails('grok', "ConPTY unavailable: Cannot find module 'node-pty'")
  ], { log: (event, data) => events.push({ event, data }) }).ask('ping');

  assert.equal(reply.giveUp, 'mixed');
  assert.equal(reply.broken, false);
  assert.equal(events.some((entry) => entry.event === 'chain-mixed'), true);
  assert.equal(events.some((entry) => entry.event === 'chain-exhausted'), false);
});

test('an empty chain is refused at construction', () => {
  assert.throws(() => chainProviders([]), /at least one link/);
});

test('a rate limit RETRIES the same link instead of abandoning it', async () => {
  // The live failure this exists for. A run reported "You've hit your session limit" and the
  // chain treated it as exhaustion - abandoning a working provider and moving the baton. The
  // account was at 30% session, 51% weekly. The real cause was four sessions in parallel
  // against one shared limit: a concurrency ceiling that clears in moments.
  //
  // Treating a transient throttle as exhaustion is worse than the reverse: it burns a healthy
  // provider for nothing.
  let calls = 0;
  const flaky = {
    kind: 'cli',
    async ask() {
      calls += 1;
      if (calls === 1) return { text: "You've hit your session limit", isError: true };
      return { text: 'served after backoff', isError: false };
    },
    async probe() { return { ok: true, detail: '' }; }
  };
  const waits = [];
  const chain = chainProviders([flaky, ok('api', 'fallback never needed')], {
    rateLimitRetries: 2, rateLimitBackoffMs: 10, sleep: async (ms) => { waits.push(ms); }
  });
  const reply = await chain.ask('hello');

  assert.equal(reply.text, 'served after backoff');
  assert.equal(reply.servedBy, 'cli', 'the SAME link must serve it, not the fallback');
  assert.equal(calls, 2, 'retried once');
  assert.deepEqual(waits, [10], 'and waited before retrying');
});

test('backoff doubles, then falls through once retries are spent', async () => {
  const waits = [];
  const chain = chainProviders([
    fails('cli', '429 too many requests'),
    ok('api', 'fallback')
  ], { rateLimitRetries: 3, rateLimitBackoffMs: 100, sleep: async (ms) => { waits.push(ms); } });
  const reply = await chain.ask('hello');

  assert.deepEqual(waits, [100, 200, 400], 'exponential, not flat');
  assert.equal(reply.servedBy, 'api', 'only after exhausting retries does it move on');
});

test('a quota failure does NOT retry - the wallet will not refill in 15 seconds', async () => {
  let calls = 0;
  const broke = {
    kind: 'cli',
    async ask() { calls += 1; return { text: 'insufficient_quota', isError: true }; },
    async probe() { return { ok: true, detail: '' }; }
  };
  const chain = chainProviders([broke, ok('api', 'fallback')], {
    rateLimitRetries: 3, sleep: async () => {}
  });
  const reply = await chain.ask('hello');
  assert.equal(calls, 1, 'quota is not retryable; retrying wastes time on a certainty');
  assert.equal(reply.servedBy, 'api');
});

test('a single-link chain retries one generic throw and can recover', async () => {
  let calls = 0;
  const flaky = {
    kind: 'cli',
    async ask() {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET transient socket blip');
      return { text: 'answered on the bounded retry', isError: false };
    },
    async probe() { return { ok: true, detail: '' }; }
  };
  const reply = await chainProviders([flaky]).ask('hello');

  assert.equal(reply.text, 'answered on the bounded retry');
  assert.equal(calls, 2);
  assert.equal(reply.exhausted, false);
});

test('a single-link chain gives up after the bounded generic retry', async () => {
  let calls = 0;
  const broken = {
    kind: 'cli',
    async ask() { calls += 1; throw new Error('socket stays broken'); },
    async probe() { return { ok: false, detail: '' }; }
  };
  const reply = await chainProviders([broken]).ask('hello');

  assert.equal(calls, 2, 'the default is one retry, not an infinite loop');
  assert.equal(reply.exhausted, true);
  assert.equal(reply.attempts[0].detail, 'socket stays broken');
});

test('single-link auth, quota, and unavailable failures are not retried', async () => {
  for (const detail of ['401 unauthorized', 'insufficient_quota', 'ENOENT command not found']) {
    let calls = 0;
    const provider = {
      kind: 'cli',
      async ask() { calls += 1; return { text: detail, isError: true }; },
      async probe() { return { ok: false, detail }; }
    };
    const reply = await chainProviders([provider]).ask('hello');
    assert.equal(calls, 1, `${detail} is an answer, not a transient generic blip`);
    assert.equal(reply.exhausted, true);
  }
});
