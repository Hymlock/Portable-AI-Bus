const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const tickCli = path.resolve(__dirname, '..', 'scripts', 'bus-tick.js');

test('tick derives unread counts from durable inbox messages', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-tick-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mailbox = path.join(root, '.ai-bus', 'runtime', 'mailbox');
  const inbox = path.join(mailbox, 'inbox');
  await fs.mkdir(inbox, { recursive: true });
  await fs.writeFile(path.join(mailbox, 'state.json'), JSON.stringify({
    round: 7,
    maxRounds: 20,
    halted: false,
    baton: { holder: 'codex', since: new Date().toISOString() }
  }));
  const messages = [
    { seq: 1, to: 'codex', read: false },
    { seq: 2, to: 'claude', read: false },
    { seq: 3, to: 'codex', read: false },
    { seq: 4, to: 'grok', read: true }
  ];
  await Promise.all(messages.map((message) => fs.writeFile(
    path.join(inbox, `${String(message.seq).padStart(6, '0')}.json`),
    JSON.stringify(message)
  )));

  const { stdout } = await execFileAsync(process.execPath, [
    tickCli, '--root', root, '--seat', 'hymlock', '--once'
  ], { windowsHide: true });
  assert.match(stdout, /pilot:hymlock/);
  assert.match(stdout, /baton:codex/);
  assert.match(stdout, /round:7\/20/);
  assert.match(stdout, /unread:claude:1 codex:2/);
  assert.doesNotMatch(stdout, /grok:1/);
  assert.doesNotMatch(stdout, /STALE-CODE/,
    'matching / absent stale-code notices must not add noise to the operator tick');
});

test('tick surfaces a persisted stale-code notice on the operator wake line', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-tick-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mailbox = path.join(root, '.ai-bus', 'runtime', 'mailbox');
  await fs.mkdir(path.join(mailbox, 'inbox'), { recursive: true });
  await fs.writeFile(path.join(mailbox, 'state.json'), JSON.stringify({
    round: 3,
    maxRounds: 20,
    halted: false,
    baton: { holder: 'grok', since: new Date().toISOString() }
  }));
  await fs.writeFile(path.join(root, '.ai-bus', 'runtime', 'stale-code.json'), JSON.stringify({
    version: 1,
    autoRestart: false,
    seats: [
      { seat: 'codex', warning: 'codex stale-code: dist changed after pid 9 loaded it' },
      { seat: 'grok', warning: 'grok stale-code: dist changed after pid 8 loaded it' }
    ]
  }));

  const { stdout } = await execFileAsync(process.execPath, [
    tickCli, '--root', root, '--seat', 'hymlock', '--once'
  ], { windowsHide: true });
  assert.match(stdout, /STALE-CODE codex,grok/);
  assert.match(stdout, /bus-restart/);
  assert.doesNotMatch(stdout, /auto-restart|restarting brains/i);
});

test('tick still emits a wake signal when the mailbox is unreadable', async () => {
  const missing = path.join(os.tmpdir(), `portable-ai-bus-missing-${process.pid}-${Date.now()}`);
  const { stdout } = await execFileAsync(process.execPath, [tickCli, '--root', missing, '--once'], {
    windowsHide: true
  });
  assert.match(stdout, /^tick .* MAILBOX UNREADABLE:/);
});
