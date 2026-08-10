const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const packageVersion = require('../package.json').version;

test('distribution dry-run inventories a Dev Kit without writing or copying it', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-distribution-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const kit = path.join(fixture, 'kit');
  const out = path.join(fixture, 'release');
  await fs.mkdir(path.join(kit, 'tools'), { recursive: true });
  await fs.writeFile(path.join(kit, 'tools', 'compiler.exe'), 'fixture');

  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve(__dirname, '..', 'scripts', 'build-distribution.js'),
    '--devkit-root', kit, '--out', out, '--dry-run'
  ], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.dryRun, true);
  assert.equal(result.devkit.files, 1);
  assert.equal(result.devkit.bytes, 7);
  await assert.rejects(fs.access(out), { code: 'ENOENT' });
});

test('distribution build copies a supplied kit and hashes VSIX plus payload', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-distribution-build-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const kit = path.join(fixture, 'kit');
  const out = path.join(fixture, 'release');
  const vsix = path.join(fixture, 'verified.vsix');
  await fs.mkdir(path.join(kit, 'tools'), { recursive: true });
  await fs.writeFile(path.join(kit, 'tools', 'ninja.exe'), 'tool');
  await fs.writeFile(vsix, 'vsix');

  await execFileAsync(process.execPath, [
    path.resolve(__dirname, '..', 'scripts', 'build-distribution.js'),
    '--devkit-root', kit, '--out', out, '--vsix', vsix
  ], { windowsHide: true });
  assert.equal(await fs.readFile(path.join(out, 'devkit', 'tools', 'ninja.exe'), 'utf8'), 'tool');
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map((file) => file.path), [
    `portable-ai-bus-${packageVersion}.vsix`, 'devkit/tools/ninja.exe'
  ]);
  assert.ok(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)));
});

test('distribution dereferences an internal Dev Kit directory link', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-distribution-link-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const kit = path.join(fixture, 'kit');
  const dependencies = path.join(kit, 'dependencies');
  const link = path.join(kit, 'subprojects');
  await fs.mkdir(dependencies, { recursive: true });
  await fs.writeFile(path.join(dependencies, 'zydis.txt'), 'inside');
  try {
    await fs.symlink(dependencies, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('directory links unavailable');
    throw error;
  }
  const out = path.join(fixture, 'release');
  const vsix = path.join(fixture, 'verified.vsix');
  await fs.writeFile(vsix, 'vsix');
  await execFileAsync(process.execPath, [
    path.resolve(__dirname, '..', 'scripts', 'build-distribution.js'),
    '--devkit-root', kit, '--out', out, '--vsix', vsix
  ], { windowsHide: true });
  assert.equal(await fs.readFile(path.join(out, 'devkit', 'subprojects', 'zydis.txt'), 'utf8'), 'inside');
  const copied = await fs.lstat(path.join(out, 'devkit', 'subprojects'));
  assert.equal(copied.isSymbolicLink(), false);
});

test('distribution rejects a Dev Kit link that escapes its root', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-distribution-escape-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const kit = path.join(fixture, 'kit');
  const outside = path.join(fixture, 'outside');
  await Promise.all([fs.mkdir(kit), fs.mkdir(outside)]);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  try {
    await fs.symlink(outside, path.join(kit, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('directory links unavailable');
    throw error;
  }
  await assert.rejects(execFileAsync(process.execPath, [
    path.resolve(__dirname, '..', 'scripts', 'build-distribution.js'),
    '--devkit-root', kit, '--out', path.join(fixture, 'release'), '--dry-run'
  ], { windowsHide: true }), /escapes its root/);
});
