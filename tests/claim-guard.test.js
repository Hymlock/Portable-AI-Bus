const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { guardStagedPaths, coveredBy, formatGuardResult } = require('../dist/claim-guard.js');

const claims = {
  claude: [{ path: 'src/brain/providers.ts' }, { path: 'src/brain/chain.ts' }],
  grok: [{ path: 'src/brain/brains' }, { path: 'tests' }],
  codex: [{ path: 'src/brain/auth' }]
};

test('reproduces the real incident: claude staging grok files is refused', () => {
  // Verbatim from commit 5af3b1c, which swept grok's work into a claude commit about baton
  // handoff. `git add -A` in a shared worktree stages everyone, and the agent running it cannot
  // tell, because a staged file looks identical whoever wrote it.
  const result = guardStagedPaths('claude', [
    'src/brain/runner.ts',
    'src/brain/brains/agent.ts',
    'src/brain/brains/index.ts',
    'tests/agent-brain.test.js'
  ], claims);

  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 4, 'runner.ts is unclaimed by claude too');
  const brains = result.violations.find((v) => v.path === 'src/brain/brains/agent.ts');
  assert.match(brains.reason, /claimed by grok/, 'must name the OTHER owner, not just refuse');
});

test('staging only your own claimed paths passes', () => {
  const result = guardStagedPaths('claude',
    ['src/brain/providers.ts', 'src/brain/chain.ts'], claims);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 2);
});

test('a claim covers everything beneath it', () => {
  assert.equal(coveredBy('src/brain/auth/anthropic.ts', 'src/brain/auth'), true);
  assert.equal(coveredBy('src/brain/auth', 'src/brain/auth'), true);
  assert.equal(coveredBy('src/brain/authority.ts', 'src/brain/auth'), false,
    'a prefix match must not leak across a name boundary');
});

test('shared paths are allowed without a claim', () => {
  // Without this the guard blocks routine work - lockfiles, build output - and gets switched
  // off, which is worse than no guard at all.
  const result = guardStagedPaths('claude',
    ['package-lock.json', 'dist/brain/chain.js', '.gitignore'], claims);
  assert.equal(result.ok, true);
});

test('an unclaimed path nobody owns is still refused, with different advice', () => {
  const result = guardStagedPaths('claude', ['src/something-new.ts'], claims);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].reason, /claim it first/);
  assert.doesNotMatch(result.violations[0].reason, /claimed by/,
    'do not invent an owner for a path nobody claimed');
});

test('windows path separators are handled', () => {
  const result = guardStagedPaths('grok', ['src\\brain\\brains\\agent.ts'], claims);
  assert.equal(result.ok, true, 'backslashes must not defeat the check');
});

test('the refusal message says what to do instead', () => {
  const result = guardStagedPaths('claude', ['src/brain/brains/agent.ts'], claims);
  const text = formatGuardResult('claude', result);
  assert.match(text, /REFUSING/);
  assert.match(text, /git add -A/, 'name the practice that caused it');
  assert.match(text, /Stage your own paths by name/);
});

test('a seat with no claims can commit nothing but shared paths', () => {
  const result = guardStagedPaths('hymlock', ['src/brain/chain.ts'], claims);
  assert.equal(result.ok, false, 'no claims means no ownership, not blanket permission');
});

test('installed hook refuses to guess the active seat assignment', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-bus-claim-hook-'));
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'claim-guard-cli.js'),
    '--root', repo, '--repo', repo, '--seat', 'codex', '--install-hook'
  ]);
  const hook = fs.readFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.match(hook, /BUS_SEAT names the assignment/);
  assert.doesNotMatch(hook, /BUS_SEAT=/,
    'install-time seat must not become a default identity for future commits');
});
