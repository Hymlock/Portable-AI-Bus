// S4 installer provenance tests. Every install target and source repository is disposable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const installerSource = path.resolve(__dirname, '..', 'scripts', 'install-bin.js');
const realGit = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' })
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-install-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(installerSource, path.join(root, 'scripts', 'install-bin.js'));
  fs.chmodSync(path.join(root, 'scripts', 'install-bin.js'), 0o755);
  const files = [
    ['bin/tool-catalog.js', 'tool-catalog.js'],
    ['templates/tool-catalog.json', 'tool-catalog.defaults.json'],
    ['dist/mailbox.js', 'mailbox.js'],
    ['dist/evidence.js', 'evidence.js'],
    ['dist/claim-walk.js', 'claim-walk.js'],
    ['dist/capabilities.js', 'capabilities.js'],
    ['dist/harness.js', 'harness.js'],
    ['dist/worker-client.js', 'worker-client.js'],
    ['dist/workspace-key.js', 'workspace-key.js'],
    ['dist/adapters/skse-devkit.js', 'skse-devkit.js']
  ];
  for (const [from] of files) {
    const target = path.join(root, from);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '..', from), target);
  }
  fs.copyFileSync(path.resolve(__dirname, '..', 'src', 'mailbox.ts'), path.join(root, 'src', 'mailbox.ts'));
  // Copying can otherwise make the source appear newer than the built output.
  fs.utimesSync(path.join(root, 'src', 'mailbox.ts'), new Date(0), new Date(0));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) {
    fs.copyFileSync(path.resolve(__dirname, '..', name), path.join(root, name));
  }
  const git = (args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  git(['config', 'user.email', 's4-test@example.invalid']);
  git(['config', 'user.name', 'S4 Test']);
  git(['add', '.']);
  git(['commit', '--quiet', '-m', 'S4 fixture']);
  return { root, installer: path.join(root, 'scripts', 'install-bin.js'), target: path.join(root, 'target', '.ai-bus'), head: git(['rev-parse', 'HEAD']).trim() };
}

function install(f, extra = [], env = {}) {
  return spawnSync(process.execPath, [f.installer, '--to', f.target, ...extra], {
    cwd: f.root,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function failingGit(t, mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-install-git-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const script = path.join(dir, 'git-failure.js');
  const operation = mode === 'rev-parse' ? 'rev-parse' : 'status';
  fs.writeFileSync(script, `const childProcess = require('node:child_process');
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, args, ...rest) => {
  if (file === 'git' && Array.isArray(args) && args.includes(${JSON.stringify(operation)})) {
    const error = new Error('injected git ${operation} failure');
    error.status = 128;
    throw error;
  }
  return realExecFileSync.call(childProcess, file, args, ...rest);
};
`);
  return { NODE_OPTIONS: `--require=${script}` };
}

function assertRefusedWithoutWrites(result, f, operation) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, new RegExp(`cannot verify source provenance: git ${operation} failed`));
  assert.equal(fs.existsSync(f.target), false, 'provenance failure must happen before any target write');
}

test('S4 git status failure refuses install even with --allow-dirty', (t) => {
  const f = fixture(t);
  const result = install(f, ['--allow-dirty'], failingGit(t, 'status'));
  assertRefusedWithoutWrites(result, f, 'status');
});

test('S4 git HEAD failure refuses install before writing', (t) => {
  const f = fixture(t);
  const result = install(f, [], failingGit(t, 'rev-parse'));
  assertRefusedWithoutWrites(result, f, 'rev-parse HEAD');
});

test('S4 dirty source refuses install before writing; --allow-dirty records dirty', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, 'package.json'), '\n');
  const refused = install(f);
  assert.notEqual(refused.status, 0, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /source worktree is dirty/);
  assert.equal(fs.existsSync(f.target), false);

  const allowed = install(f, ['--allow-dirty']);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.target, 'bin', 'bin-manifest.json'), 'utf8'));
  assert.equal(manifest.dirty, true);
  assert.equal(manifest.commit, f.head);
});

test('S4 clean install manifest records base and current commit', (t) => {
  const f = fixture(t);
  const result = install(f);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.target, 'bin', 'bin-manifest.json'), 'utf8'));
  assert.equal(manifest.base, 'd5b7d54');
  assert.equal(manifest.commit, f.head);
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.equal(manifest.dirty, false);
  assert.equal(Object.keys(manifest.files).length, 10);
});

for (const relative of ['bin/tool-catalog.js', 'templates/tool-catalog.json']) {
  test(`S4 changed catalog asset refuses a supposedly clean installation: ${relative}`, (t) => {
    const f = fixture(t);
    fs.appendFileSync(path.join(f.root, relative), '\n ');
    const result = install(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /source worktree is dirty/);
    assert.equal(fs.existsSync(path.join(f.target, 'bin', 'bin-manifest.json')), false);
  });
}
