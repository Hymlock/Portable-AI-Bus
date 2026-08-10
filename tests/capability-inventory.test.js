const assert = require('node:assert/strict');
const test = require('node:test');
const { createAgentBrain } = require('../dist/brain/brains/index.js');

/**
 * A model given no inventory invents one, and the invention costs money.
 *
 * Three seats spent whole wakes calling capabilities that do not exist - `shell`,
 * `workspace_runner`, `read_write_test` - because nothing had ever told them what does. Each
 * failure earned a repair round; each repair round was a paid call producing a fresh guess.
 * Exactly the same shape as the seat roster, which was fixed hours earlier and this was not.
 */

function toolsWith(capabilities, sent = []) {
  return {
    async send(input) { sent.push(input); return {}; },
    async status() { return { agents: ['grok', 'hymlock'] }; },
    async claim() { return {}; },
    async release() { return {}; },
    async runCapability() { return {}; },
    async listCapabilities() { return capabilities; }
  };
}

function capturingProvider(seen) {
  return {
    kind: 'cli',
    async probe() { return { ok: true, detail: '' }; },
    async ask(prompt) {
      seen.push(prompt);
      return { text: JSON.stringify({ actions: [], done: true }), isError: false };
    }
  };
}

test('the prompt states the real capability allowlist', async () => {
  const seen = [];
  const brain = createAgentBrain({ seat: 'grok', provider: capturingProvider(seen) });
  await brain.takeTurn({
    seat: 'grok', reason: 'timeout', messages: [], budget: 30, log: () => {},
    tools: toolsWith(['bus.doctor', 'git.status', 'skse.build'])
  });

  assert.match(seen[0], /bus\.doctor, git\.status, skse\.build/,
    'the seat must be told what it may run, or it guesses');
  assert.match(seen[0], /no capability writes files/i,
    'and told what none of them can do, or it keeps looking for a shell');
});

test('an empty allowlist says so plainly rather than staying silent', async () => {
  const seen = [];
  const brain = createAgentBrain({ seat: 'grok', provider: capturingProvider(seen) });
  await brain.takeTurn({
    seat: 'grok', reason: 'timeout', messages: [], budget: 30, log: () => {},
    tools: toolsWith([])
  });

  assert.match(seen[0], /No capabilities are available to you/,
    'silence is what produced the guessing; "none" must be stated');
});

test('a wake survives a tool set that cannot list capabilities', async () => {
  // Older callers and test stubs predate this tool. Losing a whole wake to an inventory lookup
  // would be a far worse failure than not knowing the inventory.
  const seen = [];
  const legacy = toolsWith([]);
  delete legacy.listCapabilities;

  const brain = createAgentBrain({ seat: 'grok', provider: capturingProvider(seen) });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'timeout', messages: [], budget: 30, log: () => {}, tools: legacy
  });

  assert.equal(result.done, true, 'the wake must complete without the inventory');
  assert.ok(seen.length > 0, 'and the model must still be asked');
});

test('a throwing listCapabilities does not fail the wake either', async () => {
  const seen = [];
  const hostile = toolsWith([]);
  hostile.listCapabilities = async () => { throw new Error('harness down'); };

  const brain = createAgentBrain({ seat: 'grok', provider: capturingProvider(seen) });
  const result = await brain.takeTurn({
    seat: 'grok', reason: 'timeout', messages: [], budget: 30, log: () => {}, tools: hostile
  });

  assert.equal(result.done, true, 'not knowing is survivable; failing the wake over it is not');
});
