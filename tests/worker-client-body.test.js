const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { seatToolInvocation } = require('../dist/worker-client.js');

// `--body` is shell-hostile and fails silently: a quoted argument containing backticks or
// $(...) is substituted before this process starts, so the message is delivered altered with
// nothing but a stray shell error to hint at it. `--body-file` never passes content through a
// shell. These lock the behaviour Grok rated Med on 2026-08-07.

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-body-'));
  const file = path.join(dir, 'body.md');
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

test('send accepts --body-file and passes the bytes through untouched', () => {
  // Exactly the content that breaks --body: backticks, a dollar-paren, and a non-cp1252 arrow.
  const body = 'Run `reap` then `release --paths x`.\nCost: $(nothing executed)\nA -> B → C\n';
  const file = tempFile(body);
  const invocation = seatToolInvocation(
    'send',
    ['--to', 'grok', '--subject', 'test', '--body-file', file],
    'claude'
  );
  assert.equal(invocation.name, 'mailbox_send');
  assert.equal(invocation.input.body, body);
  assert.equal(invocation.input.from, 'claude');
  assert.equal(invocation.input.to, 'grok');
});

test('send still accepts --body for short one-liners', () => {
  const invocation = seatToolInvocation(
    'send',
    ['--to', 'grok', '--subject', 'test', '--body', 'ack'],
    'claude'
  );
  assert.equal(invocation.input.body, 'ack');
});

test('send refuses both --body and --body-file rather than silently preferring one', () => {
  const file = tempFile('from file');
  assert.throws(
    () => seatToolInvocation(
      'send',
      ['--to', 'grok', '--subject', 'test', '--body', 'inline', '--body-file', file],
      'claude'
    ),
    /not both/i
  );
});

test('send reports the path when --body-file cannot be read', () => {
  const missing = path.join(os.tmpdir(), 'pab-does-not-exist', 'nope.md');
  assert.throws(
    () => seatToolInvocation(
      'send',
      ['--to', 'grok', '--subject', 'test', '--body-file', missing],
      'claude'
    ),
    /Could not read --body-file/
  );
});

test('send with neither body option names both alternatives', () => {
  assert.throws(
    () => seatToolInvocation('send', ['--to', 'grok', '--subject', 'test'], 'claude'),
    /--body-file/
  );
});
