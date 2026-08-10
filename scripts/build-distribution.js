#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const sourceRoot = path.resolve(__dirname, '..');
const packageManifest = require(path.join(sourceRoot, 'package.json'));

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function usage() {
  return 'usage: build-distribution --devkit-root PATH [--out PATH] [--vsix PATH] [--dry-run]';
}

async function inventory(root, includeHashes) {
  const files = [];
  const canonicalRoot = await fsp.realpath(root);

  function assertInside(candidate, displayPath) {
    const relative = path.relative(canonicalRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Dev Kit link escapes its root: ${displayPath} -> ${candidate}`);
    }
  }

  async function visit(directory, ancestors = new Set()) {
    const canonicalDirectory = await fsp.realpath(directory);
    assertInside(canonicalDirectory, directory);
    if (ancestors.has(canonicalDirectory)) {
      throw new Error(`Dev Kit contains a cyclic directory link: ${directory}`);
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(canonicalDirectory);
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const canonical = await fsp.realpath(absolute);
      assertInside(canonical, absolute);
      const stat = await fsp.stat(absolute);
      if (stat.isDirectory()) {
        await visit(absolute, nextAncestors);
      } else if (stat.isFile()) {
        const record = { path: path.relative(root, absolute).split(path.sep).join('/'), bytes: stat.size };
        if (includeHashes) record.sha256 = await hashFile(absolute);
        files.push(record);
      } else {
        throw new Error(`Dev Kit contains an unsupported link or special file: ${absolute}`);
      }
    }
  }
  await visit(root);
  return files;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).once('error', reject)
      .once('end', () => resolve(hash.digest('hex')));
  });
}

function assertSeparate(source, destination) {
  const relative = path.relative(source, destination);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Distribution output must not be inside the Dev Kit source.');
  }
}

async function main(argv = process.argv.slice(2)) {
  const devkitRoot = path.resolve(option(argv, '--devkit-root') || '');
  if (!option(argv, '--devkit-root')) throw new Error(usage());
  const out = path.resolve(option(argv, '--out') || path.join(sourceRoot, 'release', `portable-ai-bus-${packageManifest.version}`));
  const dryRun = argv.includes('--dry-run');
  const suppliedVsix = option(argv, '--vsix');
  const stat = await fsp.stat(devkitRoot).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Dev Kit root is not a directory: ${devkitRoot}`);
  assertSeparate(devkitRoot, out);

  const sourceFiles = await inventory(devkitRoot, false);
  const plan = {
    dryRun,
    output: out,
    vsix: suppliedVsix ? path.resolve(suppliedVsix) : 'build from current source',
    devkit: { directory: 'devkit', files: sourceFiles.length, bytes: sourceFiles.reduce((sum, file) => sum + file.bytes, 0) }
  };
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }

  if (await fsp.access(out).then(() => true, () => false)) {
    const entries = await fsp.readdir(out);
    if (entries.length > 0) throw new Error(`Distribution output is not empty: ${out}`);
  }
  await fsp.mkdir(out, { recursive: true });
  const payload = path.join(out, 'devkit');
  await fsp.cp(devkitRoot, payload, {
    recursive: true, dereference: true, errorOnExist: true, force: false
  });

  const vsixName = `portable-ai-bus-${packageManifest.version}.vsix`;
  const vsixPath = path.join(out, vsixName);
  if (suppliedVsix) {
    await fsp.copyFile(path.resolve(suppliedVsix), vsixPath, fs.constants.COPYFILE_EXCL);
  } else {
    const vsce = path.join(sourceRoot, 'node_modules', '@vscode', 'vsce', 'vsce');
    const result = spawnSync(process.execPath, [vsce, 'package', '--out', vsixPath], {
      cwd: sourceRoot, stdio: 'inherit', windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`VSIX packaging failed with exit code ${result.status}.`);
  }

  const payloadFiles = await inventory(payload, true);
  const manifest = {
    schemaVersion: 1,
    product: packageManifest.name,
    version: packageManifest.version,
    generatedAt: new Date().toISOString(),
    files: [
      { path: vsixName, bytes: (await fsp.stat(vsixPath)).size, sha256: await hashFile(vsixPath) },
      ...payloadFiles.map((file) => ({ ...file, path: `devkit/${file.path}` }))
    ]
  };
  await fsp.writeFile(path.join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...plan, dryRun: false, manifest: path.join(out, 'manifest.json') }, null, 2)}\n`);
  return manifest;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = { main, inventory, hashFile };
