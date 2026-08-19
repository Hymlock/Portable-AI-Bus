const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { credentialWorkspaceKey, filesystemIdentityMaterial } = require('../dist/workspace-key.js');

test('credential workspace keys follow real directory identity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-workspace-key-'));
  const real = path.join(root, 'real');
  const alias = path.join(root, 'alias');
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  assert.equal(credentialWorkspaceKey(real), credentialWorkspaceKey(alias));
  if (process.platform === 'win32') {
    assert.equal(credentialWorkspaceKey(real), credentialWorkspaceKey(real.toUpperCase()));
  }
  const second = path.join(root, 'second');
  await fs.mkdir(second);
  assert.notEqual(credentialWorkspaceKey(real), credentialWorkspaceKey(second));
  const renamed = path.join(root, 'renamed');
  const beforeRename = credentialWorkspaceKey(real);
  await fs.rename(real, renamed);
  assert.equal(credentialWorkspaceKey(renamed), beforeRename);
});

test('credential workspace keys fail closed when the directory cannot be resolved', () => {
  assert.throws(() => credentialWorkspaceKey(path.join(os.tmpdir(), `missing-${Date.now()}`)), { code: 'ENOENT' });
  assert.throws(() => filesystemIdentityMaterial(1n, 0n), /stable directory identity/);
});
