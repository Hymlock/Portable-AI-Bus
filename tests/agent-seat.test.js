const test = require('node:test');
const assert = require('node:assert/strict');

const { providerConfigs } = require('../brains/agent-seat.js');

test('each built-in seat leads with its provider and immediately crosses vendors', () => {
  assert.deepEqual(providerConfigs({}, 'claude').map((provider) => provider.kind).slice(0, 2),
    ['cli', 'codex']);
  assert.deepEqual(providerConfigs({}, 'codex').map((provider) => provider.kind).slice(0, 2),
    ['codex', 'grok']);
  assert.deepEqual(providerConfigs({}, 'grok').map((provider) => provider.kind).slice(0, 2),
    ['grok', 'codex']);
});

test('generic agent seat rejects a chain tied to one provider', () => {
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'codex' }, 'claude'),
    /at least two distinct providers/
  );
});
