const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { parsePlan, executePlan } = require('../dist/brain/brains/index.js');

/**
 * Models reach for synonyms. Dropping the action instead of accepting the word costs real money.
 *
 * Live failure: the codex seat emitted
 *   {"type":"claim","paths":["src/bus.ts"],"reason":"Align bootstrap staging with full initialize"}
 * The prompt specifies `why`. The validator required `why`, dropped the action, marked the plan
 * malformed, and the seat looped through TEN repair rounds producing nothing - every round a
 * paid model call, on a claim that was entirely sensible.
 */

test('a claim using "reason" instead of "why" is accepted, not dropped', () => {
  const { plan, malformed } = parsePlan(JSON.stringify({
    actions: [{ type: 'claim', paths: ['src/bus.ts'], reason: 'Align bootstrap staging' }],
    done: false
  }));
  assert.equal(malformed, false, 'a synonym must not make a whole plan malformed');
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].why, 'Align bootstrap staging',
    'and the normalised field must survive into the action');
});

test('the NORMALISED action reaches the tools, not the original', async () => {
  // The subtle half of this bug. `isAction` is a type guard, so filtering alone returns the
  // ORIGINAL objects: validation would accept `reason` and execution would then read `why` as
  // undefined - an action that passes every check and silently does nothing, which is worse
  // than the failure it replaced.
  const seen = [];
  const tools = {
    async send() { return {}; },
    async status() { return {}; },
    async claim(paths, why) { seen.push({ paths, why }); return {}; },
    async release() { return {}; },
    async runCapability() { return {}; }
  };
  const { plan } = parsePlan(JSON.stringify({
    actions: [{ type: 'claim', paths: ['a.ts'], reason: 'because' }], done: true
  }));
  await executePlan(tools, plan);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].why, 'because', 'the tool must receive the reason, not undefined');
});

test('the other near-misses models actually produce', () => {
  const cases = [
    [{ type: 'send', recipient: 'hymlock', subject: 's', body: 'b' }, (a) => a.to === 'hymlock'],
    [{ type: 'send', to: 'hymlock', title: 's', message: 'b' }, (a) => a.subject === 's' && a.body === 'b'],
    [{ type: 'claim', path: 'one.ts', why: 'w' }, (a) => Array.isArray(a.paths) && a.paths[0] === 'one.ts'],
    [{ type: 'capability', name: 'bus.doctor' }, (a) => a.id === 'bus.doctor']
  ];
  for (const [raw, check] of cases) {
    const { plan } = parsePlan(JSON.stringify({ actions: [raw], done: true }));
    assert.equal(plan.actions.length, 1, `dropped: ${JSON.stringify(raw)}`);
    assert.ok(check(plan.actions[0]), `not normalised: ${JSON.stringify(plan.actions[0])}`);
  }
});

test('leniency stops at meaning - a genuinely invalid action is still refused', () => {
  // The line matters. Accepting a synonym for the same concept is kindness; accepting an
  // invented ACTION TYPE would let a seat run a shell it is not allowed to run.
  const { plan, malformed } = parsePlan(JSON.stringify({
    actions: [{ type: 'shell', command: 'git rev-parse HEAD' }], done: false
  }));
  assert.equal(plan.actions.length, 0, 'an invented action type must never reach the tools');
  assert.equal(malformed, true);
});
