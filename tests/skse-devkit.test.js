const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const test = require('node:test');
const { SkseDevkitAdapter } = require('../dist/adapters/skse-devkit.js');
const execFileAsync = promisify(execFile);

async function makeFakeDevkit(layout = 'real-kit') {
  // realpath the temp dir before building anything on it.
  //
  // The adapter canonicalises with fs.realpath (skse-devkit.ts resolveSourceDir), so it
  // returns long-form paths. os.tmpdir() on Windows can return the 8.3 SHORT form: on a
  // GitHub runner the user is `runneradmin`, whose short name is `RUNNER~1`, and the two
  // strings are not equal even though they are the same directory. Comparing a raw tmpdir
  // path against an adapter result therefore failed on CI while passing on any machine whose
  // username is short enough to escape 8.3 mangling - which is why this never fired locally.
  //
  // Found by the windows-latest matrix on its first run, 2026-08-07. The product is correct;
  // the assertion was.
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-skse-ws-'));
  const workspace = await fs.realpath(created).catch(() => created);
  const root =
    layout === 'workspace-local'
      ? path.join(workspace, '.ai-bus', 'toolchains', 'skse-devkit')
      : path.join(workspace, 'SKSEDevKit');

  await fs.mkdir(path.join(root, 'tools', 'cmake', 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'vcpkg', 'scripts', 'buildsystems'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'msvc', 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'bin', '10.0.fake', 'x64'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'Include', '10.0.fake', 'um'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'Include', '10.0.fake', 'shared'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'Include', '10.0.fake', 'ucrt'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'Lib', '10.0.fake', 'um', 'x64'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'windows-sdk', 'Lib', '10.0.fake', 'ucrt', 'x64'), { recursive: true });
  await fs.mkdir(path.join(root, 'libraries', 'CommonLibSSE-NG', 'include', 'RE'), { recursive: true });
  await fs.mkdir(path.join(root, 'vcpkg-triplets'), { recursive: true });
  await fs.mkdir(path.join(root, 'DragonbornLogbookNative', 'build', 'relwithdebinfo'), { recursive: true });

  // Root intentionally has NO CMakeLists.txt (matches real kit).
  await fs.writeFile(path.join(root, 'README.md'), 'fake kit\n', 'utf8');
  await fs.writeFile(path.join(root, 'tools', 'cmake', 'bin', 'cmake.exe'), Buffer.alloc(2048, 1));
  await fs.writeFile(path.join(root, 'tools', 'cmake', 'bin', 'ctest.exe'), Buffer.alloc(2048, 1));
  await fs.writeFile(path.join(root, 'tools', 'ninja.exe'), Buffer.alloc(2048, 2));
  await fs.writeFile(path.join(root, 'tools', 'vcpkg', 'vcpkg.exe'), Buffer.alloc(2048, 3));
  await fs.writeFile(path.join(root, 'tools', 'msvc', 'bin', 'cl.exe'), Buffer.alloc(2048, 4));
  await fs.writeFile(path.join(root, 'tools', 'windows-sdk', 'bin', 'rc.exe'), Buffer.alloc(2048, 5));
  await fs.writeFile(path.join(root, 'tools', 'windows-sdk', 'bin', 'mt.exe'), Buffer.alloc(2048, 6));
  await fs.writeFile(path.join(root, 'tools', 'windows-sdk', 'bin', '10.0.fake', 'x64', 'rc.exe'), Buffer.alloc(2048, 5));
  await fs.writeFile(path.join(root, 'tools', 'windows-sdk', 'bin', '10.0.fake', 'x64', 'mt.exe'), Buffer.alloc(2048, 6));
  await fs.writeFile(path.join(root, 'tools', 'windows-sdk', 'Include', '10.0.fake', 'um', 'windows.h'), '// fake\n');
  await fs.writeFile(path.join(root, 'tools', 'windows-sdk', 'Lib', '10.0.fake', 'um', 'x64', 'kernel32.lib'), Buffer.alloc(2048, 7));
  await fs.writeFile(
    path.join(root, 'tools', 'vcpkg', 'scripts', 'buildsystems', 'vcpkg.cmake'),
    '# toolchain\n',
    'utf8'
  );
  await fs.writeFile(path.join(root, 'vcpkg-triplets', 'x64-windows-static-md-skse.cmake'), '# triplet\n', 'utf8');
  await fs.writeFile(path.join(root, 'libraries', 'CommonLibSSE-NG', 'CMakeLists.txt'), 'project(CommonLibSSE-NG)\n', 'utf8');
  await fs.writeFile(
    path.join(root, 'libraries', 'CommonLibSSE-NG', 'include', 'RE', 'Actor.h'),
    '// class Actor\nnamespace RE { class Actor {}; }\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'DragonbornLogbookNative', 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.21)\nproject(DragonbornLogbookNative)\n',
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'DragonbornLogbookNative', 'CMakePresets.json'),
    JSON.stringify({
      version: 3,
      configurePresets: [{ name: 'relwithdebinfo', generator: 'Ninja' }]
    }),
    'utf8'
  );
  await fs.writeFile(
    path.join(root, 'DragonbornLogbookNative', 'build', 'relwithdebinfo', 'DragonbornLogbookNative.dll'),
    Buffer.alloc(4096, 7)
  );
  await fs.writeFile(
    path.join(root, 'DragonbornLogbookNative', 'build', 'relwithdebinfo', 'DragonbornLogbookNative.pdb'),
    Buffer.alloc(2048, 8)
  );

  return { workspace, root };
}

test('resolves workspace-local toolchain path by default', async (t) => {
  const { workspace, root } = await makeFakeDevkit('workspace-local');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace });
  assert.equal(path.resolve(adapter.root), path.resolve(root));
});

test('explicit root and SKSE_DEVKIT_ROOT win over default', async (t) => {
  const { workspace } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-skse-other-'));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  assert.equal(
    path.resolve(SkseDevkitAdapter.resolveRoot({ workspaceRoot: workspace, explicitRoot: other })),
    path.resolve(other)
  );
  assert.equal(
    path.resolve(
      SkseDevkitAdapter.resolveRoot({
        workspaceRoot: workspace,
        env: { ...process.env, SKSE_DEVKIT_ROOT: other }
      })
    ),
    path.resolve(other)
  );
});

test('doctor finds nested real-kit tool and CommonLib paths', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { inventory, receipt } = await new SkseDevkitAdapter({
    workspaceRoot: workspace,
    explicitRoot: root
  }).doctor();
  assert.equal(inventory.rootExists, true);
  assert.ok(inventory.tools.find((tool) => tool.name === 'cmake' && tool.present)?.path.includes(`${path.sep}tools${path.sep}cmake${path.sep}bin`));
  assert.ok(inventory.tools.find((tool) => tool.name === 'vcpkg' && tool.present)?.path.includes(`${path.sep}tools${path.sep}vcpkg`));
  assert.ok(inventory.tools.find((tool) => tool.name === 'ninja' && tool.present));
  assert.ok(inventory.commonLib.root?.includes(`${path.sep}libraries${path.sep}CommonLibSSE-NG`));
  assert.equal(inventory.vcpkg.tripletHint, 'x64-windows-static-md-skse');
  assert.ok(inventory.vcpkg.toolchainFile);
  assert.ok(inventory.samples.includes('DragonbornLogbookNative'));
  assert.ok(inventory.notes.some((note) => /no CMakeLists/i.test(note)));
  assert.equal(inventory.ready, true);
  assert.equal(receipt.status, 'passed');
});

test('doctor fails loudly when a required tool makes the kit non-self-contained', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.rm(path.join(root, 'tools', 'cmake', 'bin', 'cmake.exe'));
  const { inventory, receipt } = await new SkseDevkitAdapter({
    workspaceRoot: workspace,
    explicitRoot: root,
    env: { PATH: '' }
  }).doctor();
  assert.equal(inventory.ready, false);
  assert.equal(receipt.status, 'failed');
  assert.match(inventory.notes.join('\n'), /missing required tools:.*cmake/i);
});

test('ordinary Windows shell can inject a captured trusted MSVC environment', { skip: process.platform !== 'win32' }, async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.rm(path.join(root, 'tools', 'msvc'), { recursive: true, force: true });
  const externalBin = path.join(root, 'fixture-vs', 'bin');
  await fs.mkdir(externalBin, { recursive: true });
  await fs.writeFile(path.join(externalBin, 'cl.exe'), Buffer.alloc(2048, 9));
  let calls = 0;
  const { inventory } = await new SkseDevkitAdapter({
    workspaceRoot: workspace,
    explicitRoot: root,
    env: { PATH: '' },
    async toolchainBootstrap(env) {
      calls += 1;
      return { ...env, PATH: externalBin, VSINSTALLDIR: path.join(root, 'fixture-vs') };
    }
  }).doctor();
  assert.equal(calls, 1);
  assert.equal(inventory.ready, true);
  assert.match(inventory.tools.find((tool) => tool.name === 'cl').path, /fixture-vs/);
});

test('sourceDir defaults to kit sample when workspace has no CMake project', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root });
  const sourceDir = await adapter.resolveSourceDir();
  assert.equal(path.resolve(sourceDir), path.resolve(root, 'DragonbornLogbookNative'));
});

test('sourceDir prefers workspace CMakeLists when present', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'CMakeLists.txt'), 'project(Plugin)\n', 'utf8');
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root });
  const sourceDir = await adapter.resolveSourceDir();
  assert.equal(path.resolve(sourceDir), path.resolve(workspace));
});

test('configure uses project sourceDir not devkit root', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root });
  const receipt = await adapter.configure({ timeoutMs: 2_000 });
  assert.equal(receipt.action, 'configure');
  assert.ok(receipt.sourceDir?.endsWith('DragonbornLogbookNative'));
  assert.notEqual(path.resolve(receipt.sourceDir), path.resolve(root));
  assert.equal(receipt.args[0], '-S');
  assert.ok(receipt.args.includes(path.resolve(root, 'DragonbornLogbookNative')) || receipt.args.includes(receipt.sourceDir));
  assert.ok(receipt.args.includes('-B'));
  assert.ok(receipt.args.includes('-G'));
  assert.ok(receipt.args.includes('Ninja'));
  assert.ok(receipt.args.some((item) => String(item).includes('CMAKE_TOOLCHAIN_FILE')));
  assert.ok(receipt.args.some((item) => String(item).includes('VCPKG_TARGET_TRIPLET=x64-windows-static-md-skse')));
  assert.ok(['passed', 'failed', 'launch_error', 'timed_out'].includes(receipt.status));
});

test('configure --preset uses fixed argv and jailed build dir', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root });
  const receipt = await adapter.configure({ preset: 'relwithdebinfo', timeoutMs: 2_000 });
  assert.deepEqual(receipt.args.slice(0, 2), ['--preset', 'relwithdebinfo']);
  assert.ok(receipt.buildDir?.replace(/\\/g, '/').endsWith('DragonbornLogbookNative/build/relwithdebinfo'));
});

test('path jail rejects sourceDir outside workspace and devkit', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-skse-out-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'CMakeLists.txt'), 'project(X)\n', 'utf8');
  const adapter = new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root });
  await assert.rejects(() => adapter.configure({ sourceDir: outside, timeoutMs: 500 }), /jail/i);
});

test('CommonLib search hits libraries/ tree', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const hits = await new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root }).searchCommonLib('class Actor');
  assert.ok(hits.length >= 1);
  assert.match(hits[0].path.replace(/\\/g, '/'), /libraries\/CommonLibSSE-NG\/include\/RE\/Actor\.h$/);
});

test('validatePluginArtifacts finds sample preset output', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const report = await new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root }).validatePluginArtifacts({
    sourceDir: path.join(root, 'DragonbornLogbookNative'),
    preset: 'relwithdebinfo'
  });
  assert.equal(report.ok, true);
  assert.equal(report.dll.bytes, 4096);
  assert.equal(report.dll.sha256.length, 64);
  assert.equal(report.pdb.exists, true);
});

test('CTest treats an empty suite as an error instead of false validation', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const receipt = await new SkseDevkitAdapter({ workspaceRoot: workspace, explicitRoot: root }).test({ timeoutMs: 2_000 });
  assert.ok(receipt.args.includes('--no-tests=error'));
});

test('CLI returns failure when a build receipt fails instead of reporting false success', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const cli = path.resolve(__dirname, '..', 'dist', 'adapters', 'skse-devkit.js');
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'build', '--workspace', workspace, '--root', root, '--timeout-ms', '1000']),
    (error) => error.code !== 0 && /"status":\s*"(?:failed|launch_error|timed_out)"/.test(error.stdout)
  );
});

test('CLI artifact validation exits nonzero when the plugin DLL is missing', async (t) => {
  const { workspace, root } = await makeFakeDevkit();
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const empty = path.join(root, 'empty-build');
  await fs.mkdir(empty);
  const cli = path.resolve(__dirname, '..', 'dist', 'adapters', 'skse-devkit.js');
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'validate-artifacts', '--workspace', workspace, '--root', root, '--search-dir', empty]),
    (error) => error.code === 1 && /"ok":\s*false/.test(error.stdout)
  );
});
