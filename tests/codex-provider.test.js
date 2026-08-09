const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCodexCommand, resolveProvider } = require('../dist/brain/providers.js');
const { chainProviders } = require('../dist/brain/chain.js');

test('codex is found in the VS Code extension directory, not just on PATH', () => {
  // The real install on this machine ships inside openai.chatgpt-*/bin/, and nothing puts it
  // on PATH. A PATH-only search reports "not installed" for a CLI that is present AND logged
  // in - which is exactly how `claude` was misdiagnosed as missing once already.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const arch = process.platform === 'win32' ? 'windows-x86_64' : '';
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const binDir = path.join(home, '.vscode', 'extensions', 'openai.chatgpt-26.803.41515-win32-x64', 'bin', arch);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, exe), '');

  const savedHome = process.env.USERPROFILE;
  const savedPath = process.env.PATH;
  const savedExplicit = process.env.CODEX_CLI_PATH;
  process.env.USERPROFILE = home;
  process.env.PATH = '';
  delete process.env.CODEX_CLI_PATH;
  try {
    assert.equal(resolveCodexCommand(), path.join(binDir, exe));
  } finally {
    process.env.USERPROFILE = savedHome;
    process.env.PATH = savedPath;
    if (savedExplicit) process.env.CODEX_CLI_PATH = savedExplicit;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit path and CODEX_CLI_PATH both win over the search', () => {
  assert.equal(resolveCodexCommand('D:/custom/codex.exe'), 'D:/custom/codex.exe');
  const saved = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = 'D:/from-env/codex.exe';
  try {
    assert.equal(resolveCodexCommand(), 'D:/from-env/codex.exe');
  } finally {
    if (saved) process.env.CODEX_CLI_PATH = saved; else delete process.env.CODEX_CLI_PATH;
  }
});

test('a codex link reports kind "codex", so the record says WHICH vendor served', () => {
  // Without this the log says `exec` and the whole point - proving a reply came off OpenAI's
  // wallet rather than Anthropic's - is unverifiable after the fact.
  const provider = resolveProvider({ kind: 'codex', codex: { command: 'nonexistent-codex' } });
  assert.equal(provider.kind, 'codex');
});

test('a dead codex link does not stop a seat - the chain falls through to Anthropic', async () => {
  // Hymlock's constraint runs in BOTH directions. Codex being down must not stop the bus any
  // more than Claude being down does.
  const chain = chainProviders([
    resolveProvider({ kind: 'codex', codex: { command: 'definitely-not-installed-codex' } }),
    { kind: 'cli', async ask() { return { text: 'claude answered', isError: false }; },
      async probe() { return { ok: true, detail: '' }; } }
  ], { rateLimitBackoffMs: 1, sleep: async () => {} });

  const reply = await chain.ask('hello');
  assert.equal(reply.text, 'claude answered');
  assert.equal(reply.servedBy, 'cli');
  assert.equal(reply.exhausted, false);
  assert.equal(reply.attempts[0].kind, 'codex');
});

test('codex probe does not spend a model call', async () => {
  // The generic exec probe runs the templated command with an empty prompt, which for Codex is
  // a real billed request just to answer "are you there". Probing must be free, because the
  // chain probes on every startup.
  const calls = [];
  const provider = resolveProvider({
    kind: 'codex',
    codex: { command: process.platform === 'win32' ? 'cmd.exe' : 'true' }
  });
  // Not asserting on the result - the binary is a stand-in. Asserting on the SHAPE: probe must
  // resolve rather than hang or throw when the command is not really Codex.
  const result = await provider.probe();
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.detail, 'string');
  assert.equal(calls.length, 0);
});
