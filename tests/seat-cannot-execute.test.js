const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentBrain, parsePlan } = require('../dist/brain/brains/index.js');

/**
 * The default system prompt must tell a seat it cannot execute anything directly.
 *
 * This is not style. An agentic vendor CLI, handed a task that needs machine facts, reaches for
 * a shell it does not have and ABORTS the entire reply. Measured on the same inspection task,
 * changing only the system prompt:
 *
 *   plain    6s  stopReason=cancelled  {"actions":[{"type":"capability","name":"shell"...}]}
 *   no-exec 19s  stopReason=end_turn   {"actions":[{"type":"send","to":"hymlock"...}]}
 *
 * The grok seat produced nothing for two days because of the missing sentence.
 */
test('the default system prompt forbids direct execution and offers the bus route', async () => {
  let seenSystem = '';
  const provider = {
    kind: 'cli',
    async probe() { return { ok: true, detail: '' }; },
    async ask(_prompt, options) {
      seenSystem = options?.systemPrompt ?? '';
      return { text: JSON.stringify({ actions: [], done: true }), isError: false };
    }
  };

  const brain = createAgentBrain({ seat: 'grok', provider });
  await brain.takeTurn({
    seat: 'grok', reason: 'timeout', messages: [], budget: 30, log: () => {},
    tools: {
      async send() { return {}; }, async status() { return { agents: ['grok', 'hymlock'] }; },
      async claim() { return {}; }, async release() { return {}; }, async runCapability() { return {}; }
    }
  });

  assert.match(seenSystem, /cannot run shell commands/i,
    'a seat must be told it cannot execute directly, or it will try and abort mid-reply');
  assert.match(seenSystem, /capability/,
    'and must be given the legitimate route, or it has no way to act at all');
  assert.match(seenSystem, /report saying exactly what is missing/i,
    'a seat lacking information must report the gap rather than reach for a shell');
});

test('an invented action type is rejected rather than executed', async () => {
  // What the failing seat actually emitted: {"type":"capability","name":"shell"} and
  // {"type":"shell","command":"..."}. Neither is a bus action. The parser must drop them and
  // flag the plan malformed, so the repair path runs instead of a silent no-op.
  const invented = JSON.stringify({
    actions: [{ type: 'shell', command: 'git rev-parse HEAD' }],
    done: false
  });
  const { plan, malformed } = parsePlan(invented);
  assert.equal(plan.actions.length, 0, 'an invented action must never reach the tools');
  assert.equal(malformed, true, 'and must be visible as malformed, not swallowed as an empty plan');
});
