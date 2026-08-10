const assert = require('node:assert/strict');
const test = require('node:test');
const { sdkProvider } = require('../dist/brain/providers.js');

test('SDK provider bounds a non-responsive request and preserves timeout evidence', async () => {
  let signal;
  const provider = sdkProvider('oauth', {
    clientFactory: async () => ({
      messages: {
        create(_input, request) {
          signal = request.signal;
          return new Promise(() => {});
        }
      }
    })
  });
  const started = Date.now();
  const reply = await provider.ask('hello', { timeoutMs: 20 });
  assert.equal(reply.isError, true);
  assert.match(reply.text, /timed out/i);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test('SDK provider returns quota/auth failure text to the chain', async () => {
  const provider = sdkProvider('oauth', {
    clientFactory: async () => ({ messages: { async create() { throw new Error('insufficient_quota: credits exhausted'); } } })
  });
  const reply = await provider.ask('hello', { timeoutMs: 100 });
  assert.equal(reply.isError, true);
  assert.match(reply.text, /insufficient_quota/);
});
