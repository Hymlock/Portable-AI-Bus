#!/usr/bin/env node
'use strict';
// Stage the built bus binaries into a workspace's .ai-bus/bin, the same file map as
// BusManager.stageBundle (src/bus.ts), and write bin-manifest.json with sha256 hashes so a
// copy can be checked later instead of hand-edited.
//
//   node scripts/install-bin.js --to <workspace>/.ai-bus [--with-brain] [--dry-run] [--allow-dirty]
//
// It only copies files built from this checkout (run `npm run compile` first). It never
// touches the mailbox, state.json, or runtime/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repo = path.resolve(__dirname, '..');
const BASE = 'd5b7d54';
const FILES = [
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

function parse(argv) {
  const args = { dryRun: false, withBrain: false, allowDirty: false, to: '' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--allow-dirty') args.allowDirty = true;
    else if (argv[i] === '--with-brain') args.withBrain = true;
    else if (argv[i] === '--to') args.to = argv[++i] || '';
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.to) throw new Error('--to <workspace>/.ai-bus is required');
  return args;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function main() {
  const args = parse(process.argv.slice(2));
  const busDir = path.resolve(args.to);
  if (path.basename(busDir) !== '.ai-bus') throw new Error(`--to must name a .ai-bus directory, got ${busDir}`);
  const binDir = path.join(busDir, 'bin');
  const plan = FILES.map(([from, to]) => ({ from: path.join(repo, from), to: path.join(binDir, to), rel: to }));
  const withBrain = args.withBrain || fs.existsSync(path.join(binDir, 'brain'));
  if (withBrain) {
    const brainSrc = path.join(repo, 'dist', 'brain');
    for (const rel of walk(brainSrc)) {
      plan.push({ from: path.join(brainSrc, rel), to: path.join(binDir, 'brain', rel), rel: path.posix.join('brain', rel.split(path.sep).join('/')) });
    }
  }
  const missing = plan.filter((entry) => !fs.existsSync(entry.from)).map((entry) => entry.from);
  if (missing.length) throw new Error(`build output missing (run npm run compile): ${missing.join(', ')}`);
  const srcMailbox = path.join(repo, 'src', 'mailbox.ts');
  if (fs.statSync(srcMailbox).mtimeMs > fs.statSync(plan[0].from).mtimeMs) {
    throw new Error('dist/mailbox.js is older than src/mailbox.ts; run npm run compile');
  }
  // This is the same subset of BusManager.stageBundle (src/bus.ts) named above.
  // Provenance is fail-closed: --allow-dirty permits a known dirty tree, never unknown Git state.
  const commit = gitHead();
  const dirty = gitDirty();
  if (dirty.length > 0 && !args.allowDirty && !args.dryRun) {
    throw new Error(`source worktree is dirty (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', ...' : ''}); commit first or pass --allow-dirty`);
  }
  const manifest = { source: repo, base: BASE, commit, dirty: dirty.length > 0, installedAt: new Date().toISOString(), files: {} };
  for (const entry of plan) {
    manifest.files[entry.rel] = sha256(entry.from);
    if (!args.dryRun) {
      fs.mkdirSync(path.dirname(entry.to), { recursive: true });
      const tmp = `${entry.to}.tmp-${process.pid}`;
      fs.copyFileSync(entry.from, tmp);
      fs.renameSync(tmp, entry.to);
    }
  }
  if (!args.dryRun) fs.writeFileSync(path.join(binDir, 'bin-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ dryRun: args.dryRun, binDir, commit: manifest.commit, files: Object.keys(manifest.files).length }, null, 2));
}

function gitDirty() {
  const args = ['-C', repo, 'status', '--porcelain', '--', 'src', 'scripts', 'bin', 'templates', 'brains', 'providers', 'package.json', 'package-lock.json', 'tsconfig.json'];
  let out;
  try {
    out = require('child_process').execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`cannot verify source provenance: git status failed (${error.status ?? error.code ?? 'error'}); refusing to install`);
  }
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

function gitHead() {
  try {
    const head = require('child_process').execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!head) throw new Error('empty HEAD');
    return head;
  } catch (error) {
    throw new Error(`cannot verify source provenance: git rev-parse HEAD failed (${error.status ?? error.code ?? 'error'}); refusing to install`);
  }
}

try {
  main();
} catch (error) {
  console.error(`install-bin: ${error.message}`);
  process.exit(1);
}
