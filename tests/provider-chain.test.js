const assert = require('node:assert/strict');
const test = require('node:test');
const { chainProviders, classifyFailure } = require('../dist/brain/chain.js');

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
  // A subscription says this, not "insufficient_quota". Missing it classified a real
  // exhaustion as a generic error during the first live multi-brain run.
  assert.equal(classifyFailure("You've hit your session limit · resets 2:50pm"), 'quota');
  assert.equal(classifyFailure('You have reached your limit'), 'quota');
  assert.equal(classifyFailure('You have run out of credits'), 'quota');
  assert.equal(classifyFailure('429 Too Many Requests'), 'rate-limit');
  assert.equal(classifyFailure('401 Unauthorized'), 'auth');
  assert.equal(classifyFailure('ENOENT'), 'unavailable');
  assert.equal(classifyFailure('something nobody predicted'), 'error',
    'an unknown failure must still classify, and still fall through');
});

test('an empty chain is refused at construction', () => {
  assert.throws(() => chainProviders([]), /at least one link/);
});
