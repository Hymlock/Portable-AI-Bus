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

test('generic agent seat rejects every single-vendor chain, not merely duplicate kinds', () => {
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'codex' }, 'claude'),
    /at least two distinct vendors.*OpenAI/
  );
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'oauth,api' }, 'claude'),
    /at least two distinct vendors.*Anthropic/
  );
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'cli,oauth,api' }, 'grok'),
    /at least two distinct vendors.*Anthropic/
  );
});

test('an override with two vendor families remains valid', () => {
  assert.deepEqual(
    providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'oauth,codex' }, 'claude'),
    [{ kind: 'oauth' }, { kind: 'codex' }]
  );
});

test('model-backed providers receive the explicit repository workdir', () => {
  assert.deepEqual(
    providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'grok,codex,oauth' }, 'grok', 'C:\\repo'),
    [
      { kind: 'grok', grok: { cwd: 'C:\\repo' } },
      { kind: 'codex', codex: { cwd: 'C:\\repo' } },
      { kind: 'oauth' }
    ]
  );
});
