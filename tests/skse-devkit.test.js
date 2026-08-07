const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SkseDevkitAdapter } = require('../dist/adapters/skse-devkit.js');

async function makeFakeDevkit(layout = 'real-kit') {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-skse-ws-'));
  const root =
    layout === 'workspace-local'
      ? path.join(workspace, '.ai-bus', 'toolchains', 'skse-devkit')
      : path.join(workspace, 'SKSEDevKit');

  await fs.mkdir(path.join(root, 'tools', 'cmake', 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, 'tools', 'vcpkg', 'scripts', 'buildsystems'), { recursive: true });
  await fs.mkdir(path.join(root, 'libraries', 'CommonLibSSE-NG', 'include', 'RE'), { recursive: true });
  await fs.mkdir(path.join(root, 'vcpkg-triplets'), { recursive: true });
  await fs.mkdir(path.join(root, 'DragonbornLogbookNative', 'build', 'relwithdebinfo'), { recursive: true });

  // Root intentionally has NO CMakeLists.txt (matches real kit).
  await fs.writeFile(path.join(root, 'README.md'), 'fake kit\n', 'utf8');
  await fs.writeFile(path.join(root, 'tools', 'cmake', 'bin', 'cmake.exe'), Buffer.alloc(2048, 1));
  await fs.writeFile(path.join(root, 'tools', 'cmake', 'bin', 'ctest.exe'), Buffer.alloc(2048, 1));
  await fs.writeFile(path.join(root, 'tools', 'ninja.exe'), Buffer.alloc(2048, 2));
  await fs.writeFile(path.join(root, 'tools', 'vcpkg', 'vcpkg.exe'), Buffer.alloc(2048, 3));
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
  assert.equal(receipt.status, 'passed');
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
