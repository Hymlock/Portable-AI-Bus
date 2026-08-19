const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { LmWorkerError, runLmWorker } = require('../dist/lm-worker.js');

const active = { isCancellationRequested: false };

function stream(parts) {
  return (async function* () { for (const part of parts) yield part; })();
}

function fixture(responses, identity = { vendor: 'opaque-vendor', id: 'opaque-model' }) {
  const requests = [];
  let selections = 0;
  const model = {
    ...identity,
    sendRequest(request) {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error('unexpected request');
      return stream(response);
    }
  };
  return {
    requests,
    get selections() { return selections; },
    selector: {
      async select(query) {
        selections += 1;
        assert.deepEqual(query, identity);
        return [model];
      }
    },
    identity
  };
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (error) => error instanceof LmWorkerError && error.code === code);
}

test('returns a text-only completion from an exact one-time model selection', async () => {
  const f = fixture([[{ type: 'text', text: 'done' }]]);
  const result = await runLmWorker({
    identity: f.identity, prompt: 'act once', selector: f.selector, tools: [], allowedTools: [], cancellation: active
  });
  assert.equal(result.text, 'done');
  assert.equal(result.turns, 1);
  assert.equal(f.selections, 1);
  assert.equal(f.requests.length, 1);
});

test('orders assistant tool calls before user tool results and preserves call order', async () => {
  const f = fixture([
    [
      { type: 'text', text: 'checking' },
      { type: 'tool_call', callId: 'one', name: 'lookup', input: { key: 'a' } },
      { type: 'tool_call', callId: 'two', name: 'lookup', input: { key: 'b' } }
    ],
    [{ type: 'text', text: 'complete' }]
  ]);
  const invoked = [];
  const result = await runLmWorker({
    identity: f.identity,
    prompt: 'work',
    selector: f.selector,
    tools: [{ name: 'lookup', execute(input) { invoked.push(input.key); return { found: input.key }; } }],
    allowedTools: ['lookup'],
    cancellation: active
  });
  assert.deepEqual(invoked, ['a', 'b']);
  assert.deepEqual(f.requests[1].messages.map((message) => message.role), ['user', 'assistant', 'user']);
  assert.deepEqual(f.requests[1].messages[1].parts.map((part) => part.type), ['text', 'tool_call', 'tool_call']);
  assert.deepEqual(f.requests[1].messages[2].parts.map((part) => part.callId), ['one', 'two']);
  assert.equal(result.text, 'complete');
  assert.equal(result.toolCalls, 2);
});

test('does not fall back after missing, ambiguous, or mismatched exact selection', async () => {
  for (const [models, code] of [
    [[], 'model_selection_failed'],
    [[{ vendor: 'v', id: 'i', sendRequest() {} }, { vendor: 'v', id: 'i', sendRequest() {} }], 'model_selection_failed'],
    [[{ vendor: 'V', id: 'i', sendRequest() {} }], 'model_identity_mismatch']
  ]) {
    let calls = 0;
    await rejectsCode(() => runLmWorker({
      identity: { vendor: 'v', id: 'i' },
      prompt: 'x',
      selector: { async select() { calls += 1; return models; } },
      tools: [], allowedTools: [], cancellation: active
    }), code);
    assert.equal(calls, 1);
  }
});

test('fails closed on unallowed, unknown, and malformed tool calls', async () => {
  const cases = [
    [{ type: 'tool_call', callId: '1', name: 'write', input: {} }, 'tool_not_allowed'],
    [{ type: 'tool_call', callId: '', name: 'read', input: {} }, 'malformed_tool_call'],
    [{ type: 'tool_call', callId: '1', name: 'read', input: [] }, 'malformed_tool_input'],
    [{ type: 'mystery', value: 1 }, 'malformed_response']
  ];
  for (const [part, code] of cases) {
    const f = fixture([[part]]);
    await rejectsCode(() => runLmWorker({
      identity: f.identity,
      prompt: 'x',
      selector: f.selector,
      tools: [{ name: 'read', execute() { return null; } }, { name: 'write', execute() { return null; } }],
      allowedTools: ['read'],
      cancellation: active
    }), code);
  }
});

test('enforces turn, tool-call, and cumulative result-byte limits', async () => {
  const turns = fixture([
    [{ type: 'tool_call', callId: '1', name: 't', input: {} }],
    [{ type: 'tool_call', callId: '2', name: 't', input: {} }]
  ]);
  await rejectsCode(() => runLmWorker({
    identity: turns.identity, prompt: 'x', selector: turns.selector,
    tools: [{ name: 't', execute() { return null; } }], allowedTools: ['t'], cancellation: active,
    limits: { maxTurns: 2, maxToolCalls: 3, maxResultBytes: 100 }
  }), 'turn_limit');

  const calls = fixture([[{ type: 'tool_call', callId: '1', name: 't', input: {} }, { type: 'tool_call', callId: '2', name: 't', input: {} }]]);
  await rejectsCode(() => runLmWorker({
    identity: calls.identity, prompt: 'x', selector: calls.selector,
    tools: [{ name: 't', execute() { return null; } }], allowedTools: ['t'], cancellation: active,
    limits: { maxTurns: 2, maxToolCalls: 1, maxResultBytes: 100 }
  }), 'tool_call_limit');

  const bytes = fixture([[{ type: 'tool_call', callId: '1', name: 't', input: {} }]]);
  await rejectsCode(() => runLmWorker({
    identity: bytes.identity, prompt: 'x', selector: bytes.selector,
    tools: [{ name: 't', execute() { return '12345'; } }], allowedTools: ['t'], cancellation: active,
    limits: { maxTurns: 2, maxToolCalls: 1, maxResultBytes: 3 }
  }), 'tool_result_limit');
});

test('checks cancellation before selection, during streaming, and after tools', async () => {
  const before = { isCancellationRequested: true };
  let selected = false;
  await rejectsCode(() => runLmWorker({
    identity: { vendor: 'v', id: 'i' }, prompt: 'x',
    selector: { async select() { selected = true; return []; } },
    tools: [], allowedTools: [], cancellation: before
  }), 'cancelled');
  assert.equal(selected, false);

  const state = { isCancellationRequested: false };
  const f = fixture([[{ type: 'tool_call', callId: '1', name: 't', input: {} }]]);
  await rejectsCode(() => runLmWorker({
    identity: f.identity, prompt: 'x', selector: f.selector,
    tools: [{ name: 't', execute() { state.isCancellationRequested = true; return null; } }],
    allowedTools: ['t'], cancellation: state
  }), 'cancelled');
});

test('rejects duplicate call ids and non-JSON tool results', async () => {
  const duplicate = fixture([
    [{ type: 'tool_call', callId: 'same', name: 't', input: {} }],
    [{ type: 'tool_call', callId: 'same', name: 't', input: {} }]
  ]);
  await rejectsCode(() => runLmWorker({
    identity: duplicate.identity, prompt: 'x', selector: duplicate.selector,
    tools: [{ name: 't', execute() { return null; } }], allowedTools: ['t'], cancellation: active
  }), 'duplicate_call_id');

  const malformed = fixture([[{ type: 'tool_call', callId: '1', name: 't', input: {} }]]);
  await rejectsCode(() => runLmWorker({
    identity: malformed.identity, prompt: 'x', selector: malformed.selector,
    tools: [{ name: 't', execute() { return undefined; } }], allowedTools: ['t'], cancellation: active
  }), 'malformed_json');
});

test('prevalidates every tool call before allowing any side effect', async () => {
  for (const invalid of [
    { type: 'tool_call', callId: 'two', name: 'blocked', input: {} },
    { type: 'tool_call', callId: 'one', name: 'safe', input: {} }
  ]) {
    let effects = 0;
    const f = fixture([[
      { type: 'tool_call', callId: 'one', name: 'safe', input: {} },
      invalid
    ]]);
    await assert.rejects(() => runLmWorker({
      identity: f.identity, prompt: 'x', selector: f.selector,
      tools: [{ name: 'safe', execute() { effects += 1; return null; } }, { name: 'blocked', execute() { return null; } }],
      allowedTools: ['safe'], cancellation: active
    }), (error) => error instanceof LmWorkerError && ['tool_not_allowed', 'duplicate_call_id'].includes(error.code));
    assert.equal(effects, 0);
  }
});

test('bounds streamed parts, text bytes, and total response bytes', async () => {
  const endless = {
    ...fixture([]),
    selector: {
      async select() {
        return [{ vendor: 'opaque-vendor', id: 'opaque-model', sendRequest() {
          return (async function* () { while (true) yield { type: 'text', text: 'x' }; })();
        } }];
      }
    }
  };
  await rejectsCode(() => runLmWorker({
    identity: endless.identity, prompt: 'x', selector: endless.selector, tools: [], allowedTools: [], cancellation: active,
    limits: { maxResponseParts: 3 }
  }), 'response_part_limit');

  const hugeText = fixture([[{ type: 'text', text: 'abcdefgh' }]]);
  await rejectsCode(() => runLmWorker({
    identity: hugeText.identity, prompt: 'x', selector: hugeText.selector, tools: [], allowedTools: [], cancellation: active,
    limits: { maxResponseTextBytes: 4 }
  }), 'response_text_limit');

  const bytes = fixture([[{ type: 'tool_call', callId: 'id', name: 't', input: { value: 'abcdefgh' } }]]);
  await rejectsCode(() => runLmWorker({
    identity: bytes.identity, prompt: 'x', selector: bytes.selector,
    tools: [{ name: 't', execute() { return null; } }], allowedTools: ['t'], cancellation: active,
    limits: { maxResponseBytes: 8 }
  }), 'response_byte_limit');
});

test('rejects deeply nested JSON iteratively before tool execution', async () => {
  let input = {};
  for (let index = 0; index < 20_000; index += 1) input = { child: input };
  let effects = 0;
  const f = fixture([[{ type: 'tool_call', callId: 'one', name: 't', input }]]);
  await rejectsCode(() => runLmWorker({
    identity: f.identity, prompt: 'x', selector: f.selector,
    tools: [{ name: 't', execute() { effects += 1; return null; } }], allowedTools: ['t'], cancellation: active,
    limits: { maxJsonDepth: 8 }
  }), 'json_depth_limit');
  assert.equal(effects, 0);
});

test('runs beforeTurn before every request and can stop a later turn', async () => {
  const f = fixture([
    [{ type: 'tool_call', callId: 'one', name: 't', input: {} }],
    [{ type: 'text', text: 'must not run' }]
  ]);
  const turns = [];
  await assert.rejects(() => runLmWorker({
    identity: f.identity, prompt: 'x', selector: f.selector,
    tools: [{ name: 't', execute() { return null; } }], allowedTools: ['t'], cancellation: active,
    beforeTurn(context) {
      turns.push(context.turn);
      if (context.turn === 2) throw new Error('halted externally');
    }
  }), /halted externally/);
  assert.deepEqual(turns, [1, 2]);
  assert.equal(f.requests.length, 1);
});

test('enforces the wall deadline and per-tool timeout with cooperative cancellation', async () => {
  await rejectsCode(() => runLmWorker({
    identity: { vendor: 'v', id: 'i' }, prompt: 'x',
    selector: { select() { return new Promise(() => {}); } },
    tools: [], allowedTools: [], cancellation: active, limits: { maxRunMs: 20 }
  }), 'deadline_exceeded');

  let observedCancellation;
  const f = fixture([[{ type: 'tool_call', callId: 'one', name: 'slow', input: {} }]]);
  await rejectsCode(() => runLmWorker({
    identity: f.identity, prompt: 'x', selector: f.selector,
    tools: [{ name: 'slow', execute(_input, cancellation) {
      return new Promise((resolve) => setTimeout(() => {
        observedCancellation = cancellation.isCancellationRequested;
        resolve(null);
      }, 40));
    } }],
    allowedTools: ['slow'], cancellation: active, limits: { maxToolMs: 10, maxRunMs: 1_000 }
  }), 'tool_timeout');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(observedCancellation, true);
});
