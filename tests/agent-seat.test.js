const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { providerConfigs, providerHostOptions } = require('../brains/agent-seat.js');

test('each named brain spends only its own vendor credits', () => {
  assert.deepEqual(providerConfigs({}, 'claude').map((provider) => provider.kind),
    ['cli', 'oauth', 'api']);
  assert.deepEqual(providerConfigs({}, 'codex').map((provider) => provider.kind), ['codex']);
  assert.deepEqual(providerConfigs({}, 'grok').map((provider) => provider.kind), ['grok']);
});

test('cross-vendor overrides are illegal for named brains', () => {
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'grok,codex' }, 'grok'),
    /Seat grok is bound to xAI.*codex=OpenAI/
  );
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'codex,cli' }, 'codex'),
    /Seat codex is bound to OpenAI.*cli=Anthropic/
  );
  assert.throws(
    () => providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'cli,grok' }, 'claude'),
    /Seat claude is bound to Anthropic.*grok=xAI/
  );
});

test('same-vendor authentication fallbacks remain valid', () => {
  assert.deepEqual(
    providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'oauth,api,cli' }, 'claude'),
    [{ kind: 'oauth' }, { kind: 'api' }, { kind: 'cli' }]
  );
});

test('unknown seat identities fail closed', () => {
  assert.throws(() => providerConfigs({}, 'worker'), /Unknown funded seat: worker/);
});

test('model-backed providers receive the explicit repository workdir', () => {
  assert.deepEqual(
    providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'grok' }, 'grok', 'C:\\repo'),
    [{ kind: 'grok', grok: { cwd: 'C:\\repo' } }]
  );
});

test('the Grok extractor diagnostic is wired to the brain log', () => {
  const log = () => {};
  assert.deepEqual(
    providerConfigs({ PORTABLE_AI_BUS_PROVIDER_CHAIN: 'grok' }, 'grok', 'C:\\repo', log),
    [{ kind: 'grok', grok: { cwd: 'C:\\repo', log } }]
  );
});

test('ITEM 12: agent-seat resolveChain receives a stall ledger for the seat', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-seat-stall-'));
  try {
    const log = () => {};
    const options = providerHostOptions('grok', root, log);
    assert.equal(options.stallSeat, 'grok');
    assert.equal(options.log, log);
    const snap = options.stallLedger.snapshot();
    assert.equal(snap.seat, 'grok');
    assert.equal(snap.started, 0);
    const expected = path.join(root, '.ai-bus', 'runtime', 'stalls', 'grok.json');
    assert.equal(fs.existsSync(expected), true, 'ledger file must exist so a restart can read open=0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
