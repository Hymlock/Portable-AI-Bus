const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveGrokCommand, resolveProvider, extractGrokAnswer } = require('../dist/brain/providers.js');
const { chainProviders, classifyFailure } = require('../dist/brain/chain.js');

test('the REAL binary is resolved, not the unspawnable npm trampoline', () => {
  // %APPDATA%\npm\grok.cmd cannot be spawned by Node 24 at all. The real binary is unpacked to
  // ~/.grok/bin by postinstall. Resolving the shim looks like a successful resolution and then
  // fails as if the CLI were missing - the exact trap `claude` set earlier.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
  const exe = process.platform === 'win32' ? 'grok.exe' : 'grok';
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, 'bin', exe), '');

  const saved = { home: process.env.GROK_HOME, explicit: process.env.GROK_CLI_PATH };
  process.env.GROK_HOME = home;
  delete process.env.GROK_CLI_PATH;
  try {
    assert.equal(resolveGrokCommand(), path.join(home, 'bin', exe));
  } finally {
    if (saved.home) process.env.GROK_HOME = saved.home; else delete process.env.GROK_HOME;
    if (saved.explicit) process.env.GROK_CLI_PATH = saved.explicit;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('"Not signed in" classifies as auth, not as a generic error', () => {
  // xAI's wording matched none of the auth patterns. It fell through either way, but reported a
  // reason nobody could act on.
  assert.equal(classifyFailure('Not signed in. To authenticate without a browser, run: grok login'), 'auth');
  assert.equal(classifyFailure('Please sign in to continue'), 'auth');
});

test('a grok link reports kind "grok", so the record names the vendor', () => {
  const provider = resolveProvider({ kind: 'grok', codex: {}, grok: { command: 'nonexistent-grok' } });
  assert.equal(provider.kind, 'grok');
});

test('a signed-out grok does not stop a seat', async () => {
  const chain = chainProviders([
    { kind: 'grok',
      async ask() { return { text: 'Not signed in. Run grok login', isError: true }; },
      async probe() { return { ok: true, detail: '' }; } },
    { kind: 'codex',
      async ask() { return { text: 'codex covered it', isError: false }; },
      async probe() { return { ok: true, detail: '' }; } }
  ], { sleep: async () => {} });

  const reply = await chain.ask('hello');
  assert.equal(reply.text, 'codex covered it');
  assert.equal(reply.servedBy, 'codex');
  assert.equal(reply.attempts[0].reason, 'auth', 'and the log says WHY grok was skipped');
});

test('a pretty-printed JSON answer is extracted, not returned whole', () => {
  // The live bug, captured verbatim. `--output-format json` pretty-prints ONE object across many
  // lines, so a line-by-line parser failed on every line and fell back to returning the whole
  // envelope - which reads downstream exactly like a model that answered in JSON.
  const real = JSON.stringify({ text: 'pong', stopReason: 'end_turn', sessionId: '019fe8c9' }, null, 2);
  assert.deepEqual(extractGrokAnswer(real), { text: 'pong' });
});

test('a schema-constrained reply is unwrapped, not mistaken for prose', () => {
  // Live shape from `grok -p ... --json-schema`. The answer is itself JSON, wrapped in the
  // CLI's usual envelope. Slicing from the first brace to the END of the document lands
  // mid-structure and fails, dropping the reply to the raw-text fallback - which downstream
  // reads as "the model returned prose" when it had in fact complied exactly.
  const plan = '{"actions":[{"type":"send","to":"hymlock","kind":"report","subject":"x","body":"y"}],"done":true}';
  const envelope = JSON.stringify({ text: plan, stopReason: 'end_turn', sessionId: '019f' }, null, 2);

  const out = extractGrokAnswer(envelope);
  assert.equal(out.error, undefined);
  assert.deepEqual(JSON.parse(out.text), JSON.parse(plan),
    'the inner PLAN must survive, not the envelope around it');
});

test('multiple JSON documents: the ANSWER is taken, not the tool events', () => {
  // What the CLI emits once tool execution is enabled: event objects, then the answer. Two
  // earlier parsers spanned across documents and failed, dropping a compliant reply to the
  // raw-text fallback - which downstream reads as "the model returned prose".
  const plan = '{"actions":[{"type":"send","to":"hymlock","kind":"report","subject":"x","body":"y"}],"done":true}';
  const stream = [
    JSON.stringify({ type: 'tool_use', name: 'read_file', status: 'running' }),
    JSON.stringify({ type: 'tool_result', ok: true }),
    JSON.stringify({ text: plan, stopReason: 'end_turn' })
  ].join('\r\n');

  const out = extractGrokAnswer(stream);
  assert.equal(out.error, undefined);
  assert.deepEqual(JSON.parse(out.text), JSON.parse(plan));
});

test('a doubly-wrapped answer is unwrapped to the plan', () => {
  // Observed live: the answer arrives inside an envelope that is itself inside an envelope. A
  // single unwrap returns another envelope, which then fails to parse as a plan and is logged
  // as "malformed output" from a model that had complied exactly.
  const plan = '{"actions":[{"type":"send","to":"hymlock","kind":"report","subject":"x","body":"y"}],"done":true}';
  const once = JSON.stringify({ text: plan, stopReason: 'end_turn' });
  const twice = JSON.stringify({ text: once, stopReason: 'end_turn' });

  assert.deepEqual(JSON.parse(extractGrokAnswer(twice).text), JSON.parse(plan));
  // and unwrapping must stop at the plan rather than chewing into it
  assert.deepEqual(JSON.parse(extractGrokAnswer(once).text), JSON.parse(plan));
  assert.deepEqual(JSON.parse(extractGrokAnswer(plan).text), JSON.parse(plan));
});

test('a deeply wrapped structured reply reaches the plan instead of spending repair calls', () => {
  // Live 2026-08-10 failure: after three unwrappings the Grok brain still received a pretty
  // printed { text: "{\"actions\":...}" } envelope. The old raw substring check was not a
  // reliable plan boundary because an escaped plan may appear inside another envelope.
  const plan = '{"actions":[{"type":"send","to":"codex","kind":"report","subject":"x","body":"y"}],"done":true}';
  let wrapped = plan;
  for (let depth = 0; depth < 7; depth += 1) {
    wrapped = JSON.stringify({ text: wrapped, stopReason: 'end_turn' }, null, 2);
  }

  assert.deepEqual(JSON.parse(extractGrokAnswer(wrapped).text), JSON.parse(plan));
});

test('ConPTY visual wraps inside a long Grok JSON string are reversed', () => {
  // Captured live: the outer envelope's `text` value was long enough for ConPTY to insert raw
  // CRLF pairs inside the quoted JSON. JSON.parse must reject that stream until those terminal
  // presentation breaks—not model-authored escaped newlines—are removed.
  const plan = JSON.stringify({
    actions: [{ type: 'send', to: 'codex', kind: 'report', subject: 'probe', body: 'X'.repeat(500) }],
    done: true
  });
  const encodedPlan = JSON.stringify(plan);
  let visuallyWrapped = '';
  for (let index = 0; index < encodedPlan.length; index += 67) {
    visuallyWrapped += encodedPlan.slice(index, index + 67);
    if (index + 67 < encodedPlan.length) visuallyWrapped += '\r\n';
  }
  const stream = [
    '2026-08-10T23:24:00Z WARN auto worktree gc failed',
    '{',
    `  "text": ${visuallyWrapped},`,
    '  "stopReason": "end_turn"',
    '}'
  ].join('\r\n');

  assert.deepEqual(JSON.parse(extractGrokAnswer(stream).text), JSON.parse(plan));
});

test('a direct structured plan is retained after ConPTY wraps its body string', () => {
  // The CLI also emits the schema result directly, with no outer `text` field. Previously the
  // scanner cleaned this object, failed to recognise it as an answer, then returned the dirty
  // original stream from the fallback path.
  const plan = JSON.stringify({
    actions: [{ type: 'send', to: 'codex', kind: 'report', subject: 'probe', body: 'Y'.repeat(400) }],
    done: true
  });
  const bodyStart = plan.indexOf('Y'.repeat(400));
  const wrapped = `${plan.slice(0, bodyStart + 90)}\r\n${plan.slice(bodyStart + 90)}`;

  assert.deepEqual(JSON.parse(extractGrokAnswer(wrapped).text), JSON.parse(plan));
});

test('an error object anywhere in the stream wins over a later answer', () => {
  // "Not signed in" must never be masked by a trailing object, or the chain keeps a dead link.
  const stream = [
    JSON.stringify({ type: 'error', message: 'Not signed in.' }),
    JSON.stringify({ text: '{"actions":[],"done":true}' })
  ].join('\n');
  const out = extractGrokAnswer(stream);
  assert.equal(out.error, 'Not signed in.');
});

test('braces inside strings do not break the scan', () => {
  // A body containing JSON-looking text would fool naive brace counting.
  const plan = JSON.stringify({
    actions: [{ type: 'send', to: 'hymlock', kind: 'report', subject: 's', body: 'saw {"a":1} in the log' }],
    done: true
  });
  const out = extractGrokAnswer(JSON.stringify({ text: plan, stopReason: 'end_turn' }));
  assert.deepEqual(JSON.parse(out.text), JSON.parse(plan));
});

test('the parser handles the other shapes the CLI can emit', () => {
  assert.equal(extractGrokAnswer('{"text":"one line"}').text, 'one line');
  assert.equal(extractGrokAnswer('plain text answer').text, 'plain text answer');
  assert.equal(extractGrokAnswer('').text, '');

  // JSONL: the LAST object carrying text wins, because earlier ones are deltas.
  const jsonl = ['{"type":"delta","text":"po"}', '{"type":"message","text":"pong"}'].join('\n');
  assert.equal(extractGrokAnswer(jsonl).text, 'pong');

  // An error must come back as an ERROR, never as an answer - `classifyFailure` reads it.
  const failed = extractGrokAnswer('{"type":"error","message":"Not signed in."}');
  assert.equal(failed.text, '');
  assert.equal(failed.error, 'Not signed in.');
});
