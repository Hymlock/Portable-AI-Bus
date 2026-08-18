'use strict';
/**
 * Round 4 live re-verification. Own instrument. Attacks dist/ + claim-guard-cli.js.
 * Does not edit src/ or tests/. Confirms the holes named in r4/r4b still land on HEAD.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('path');
const { MailboxStore } = require('./dist/mailbox.js');
const { EvidenceStore } = require('./dist/evidence.js');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
const results = [];

function rec(item, name, status, detail) {
  const row = { item, name, status, detail: String(detail).slice(0, 4000) };
  results.push(row);
  console.log(`[${status}] item ${item} / ${name}: ${row.detail.split('\n')[0]}`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function junction(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function fileSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link, 'file');
      return true;
    } catch {
      return false;
    }
  }
}

function runGuard(repo, busRoot, env = {}) {
  const merged = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, 'BUS_ALLOW_BROKEN_BUILD')) {
    delete merged.BUS_ALLOW_BROKEN_BUILD;
  }
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo,
      encoding: 'utf8',
      stdio: 'pipe',
      env: merged
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'packages' }] } }));
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const fine: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  await writeBus(busRoot);
  return { dir, repo, busRoot };
}

async function linkWholeModules(repo) {
  return junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));
}

async function plantOwnModules(repo) {
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  const ts = junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  const bin = junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return ts && bin;
}

async function plantLeakConfig(repo, includePath, packageName = 'leak-config') {
  const pkg = path.join(repo, 'node_modules', packageName);
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }));
  await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: [includePath.replace(/\\/g, '/')]
  }, null, 2));
}

function liveOf(records) {
  return records.filter((item) => !item.supersededBy && !item.invalidateReason);
}

async function main() {
  console.log(`HEAD ${HEAD}`);

  // Control: staged type error is red.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'staged-type-error-red', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-type-error-red',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Control: absolute include refused.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'absolute-include-refused', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'absolute-include-refused',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  async function bareExtends(name, extendsValue, restoreWorktree) {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, name, 'SKIP', 'could not plant own node_modules');
        return;
      }
      await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({ extends: extendsValue }, null, 2));
      git(fx.repo, 'add', '-A');
      if (restoreWorktree) {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      }
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, name, result.code === 1 ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.trim().slice(0, 800)}`);
    } finally { await rm(fx.dir); }
  }

  await bareExtends('bare-extends-package-file', 'leak-config/tsconfig.json', true);
  await bareExtends('bare-extends-array', ['leak-config/tsconfig.json'], true);
  await bareExtends('bare-extends-package-name', 'leak-config', true);
  await bareExtends('bare-extends-control-worktree-also-broken', 'leak-config/tsconfig.json', false);

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'relative-extends-same-package', 'SKIP', 'no modules');
      else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: './node_modules/leak-config/tsconfig.json'
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-extends-same-package',
          result.code === 1 && /OUTSIDE the staged tree|include/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'node-modules-junction-include', 'SKIP', 'no modules');
      else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'node-modules-junction-include', 'SKIP', 'could not junction leak-src');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['node_modules/leak-src']
          }, null, 2));
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'node-modules-junction-include',
            result.code === 1 ? 'PASS' : 'FAIL',
            `code=${result.code} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'triple-slash-hides-type-error', 'SKIP', 'no modules');
      else {
        const helper = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(helper, 'declare type HiddenFix = number;\n');
        const refPath = helper.replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path=${JSON.stringify(refPath)} />\nexport const broken: HiddenFix = 1;\n`);
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-hides-type-error',
          result.code === 1 ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'staged-symlink-file-pointing-out', 'SKIP', 'no modules');
      else {
        const outside = path.join(fx.dir, 'honest-outside.ts');
        await fsp.writeFile(outside, 'export const good: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.unlink(path.join(fx.repo, 'src', 'index.ts'));
        if (!fileSymlink(path.join(fx.repo, 'src', 'index.ts'), outside)) {
          rec(15, 'staged-symlink-file-pointing-out', 'SKIP', 'could not create file symlink');
        } else {
          git(fx.repo, 'add', '-A');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'staged-symlink-file-pointing-out',
            result.code === 1 ? 'PASS' : 'FAIL',
            `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'nocheck-lands-type-error', 'SKIP', 'no modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'nocheck-lands-type-error',
          result.code === 0 && /noCheck/i.test(result.out) ? 'NOTE' : (result.code === 1 ? 'PASS' : 'FAIL'),
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'relative-dotdot-include-refused', 'SKIP', 'no modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['../repo/src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-dotdot-include-refused',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Item 2
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i2-'));
    try {
      const store = new EvidenceStore(root);
      for (let i = 0; i < 3; i += 1) {
        await store.record({ workId: 42, subject: `a-${i}`, statement: `A${i}`, recordedBy: 'grok' });
      }
      const s1 = await store.consolidate(42, 'grok');
      for (let i = 0; i < 3; i += 1) {
        await store.record({ workId: 42, subject: `b-${i}`, statement: `B${i}`, recordedBy: 'grok' });
      }
      const s2 = await store.consolidate(42, 'grok');
      await store.invalidate(s2.summary.id, 'second rollup bad');
      const afterS2 = liveOf(await store.list(42)).map((i) => i.subject).sort();
      await store.invalidate(s1.summary.id, 'first rollup bad');
      const afterS1 = liveOf(await store.list(42)).map((i) => i.subject).sort();
      const ok = afterS2.includes('b-0') && afterS2.includes('consolidated: work #42') && !afterS2.includes('a-0')
        && ['a-0', 'a-1', 'a-2', 'b-0', 'b-1', 'b-2'].every((s) => afterS1.includes(s));
      rec(2, 'two-summaries-over-time', ok ? 'PASS' : 'FAIL', `afterS2=${afterS2.join(',')} afterS1=${afterS1.join(',')}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i2empty-'));
    try {
      const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      await fsp.writeFile(lockPath, '');
      const store = new EvidenceStore(root);
      const started = Date.now();
      let error = null;
      try {
        await store.record({ workId: 9, subject: 'empty-lock', statement: 'x', recordedBy: 'grok' });
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - started;
      rec(2, 'empty-lock-file-recovery',
        !error && elapsed < 3000 ? 'PASS' : 'FAIL',
        `elapsedMs=${elapsed} error=${error ? error.message : 'none'}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i2mal-'));
    try {
      const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      await fsp.writeFile(lockPath, '{not-json');
      const store = new EvidenceStore(root);
      const started = Date.now();
      let error = null;
      try {
        await store.record({ workId: 9, subject: 'malformed-lock', statement: 'x', recordedBy: 'grok' });
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - started;
      rec(2, 'malformed-lock-file-recovery',
        !error && elapsed < 3000 ? 'PASS' : 'FAIL',
        `elapsedMs=${elapsed} error=${error ? error.message : 'none'}`);
    } finally { await rm(root); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i2close-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      await store.closeRecovery('grok', source.seq, 'done');
      const records = await store.listEvidence(source.seq);
      const summary = records.find((item) => item.consolidatedFrom !== undefined);
      rec(2, 'closeRecovery-compacts',
        summary && summary.consolidatedFrom.length === 3 ? 'PASS' : 'FAIL',
        `summary=${summary ? summary.id : 'none'}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i2throw-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const evidencePath = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
      await fsp.writeFile(evidencePath, 'NOT-JSON');
      const closed = await store.closeRecovery('grok', source.seq, 'done even if compact throws');
      const still = await store.openRecoveryFor('grok');
      rec(2, 'closeRecovery-survives-consolidate-throw',
        closed && closed.status === 'closed' && !still ? 'PASS' : 'FAIL',
        `closed=${closed && closed.status} stillOpen=${Boolean(still)}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i2op-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      await store.operatorCloseRecovery('grok', source.seq, 'seat died');
      const records = await store.listEvidence(source.seq);
      const summary = records.find((item) => item.consolidatedFrom !== undefined);
      const live = liveOf(records);
      rec(2, 'operatorClose-does-not-consolidate',
        !summary && live.length === 3 ? 'FAIL' : (summary ? 'PASS' : 'FAIL'),
        `summaries=${summary ? 1 : 0} live=${live.length}`);
    } finally { await rm(dir); }
  }

  // Item 20
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i20-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'implement item 9', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'ONE ACTION: implement item 9');
      const stolen = await store.closeRecovery('codex', source.seq, 'not mine');
      const still = await store.openRecoveryFor('grok');
      rec(20, 'seat-cannot-close-anothers',
        stolen === undefined && still && still.status === 'open' ? 'PASS' : 'FAIL',
        `stolen=${stolen && stolen.status} still=${still && still.status}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i20b-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'implement item 9', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'ONE ACTION: implement item 9');
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'item 9 certified hours ago');
      const still = await store.openRecoveryFor('grok');
      const recallGrok = await store.recallAssignment('grok', source.seq);
      const recallCodex = await store.recallAssignment('codex', source.seq);
      rec(20, 'operator-closes-and-revokes-recall',
        closed && closed.status === 'closed' && /^operator-closed: /.test(closed.closeReason)
          && !still && recallGrok === undefined && recallCodex === undefined ? 'PASS' : 'FAIL',
        `status=${closed && closed.status} reason=${closed && closed.closeReason} still=${Boolean(still)} recallGrok=${recallGrok ? 'yes' : 'no'} recallCodex=${recallCodex ? 'yes' : 'no'}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4c-i20c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'half done');
      let refused = false;
      try { await store.operatorCloseRecovery('grok', source.seq, '  '); } catch (error) {
        refused = /reason is required/i.test(error.message);
      }
      const still = await store.openRecoveryFor('grok');
      rec(20, 'operator-empty-reason-refused',
        refused && still && still.status === 'open' ? 'PASS' : 'FAIL',
        `refused=${refused} still=${still && still.status}`);
    } finally { await rm(dir); }
  }

  {
    const harness = await fsp.readFile(path.join(REPO, 'src', 'harness.ts'), 'utf8');
    const mentions = /operatorClose|operator-close|close-recovery|closeRecovery/.test(harness);
    rec(20, 'harness-has-no-operator-close-verb',
      !mentions ? 'PASS' : 'FAIL',
      `seat-facing harness mentions operator close? ${mentions}`);
  }

  const summary = {
    head: HEAD,
    counts: {
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
      note: results.filter((r) => r.status === 'NOTE').length,
      skip: results.filter((r) => r.status === 'SKIP').length
    },
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4c-grok-out.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [
    `AUDIT r4c live re-verify HEAD ${HEAD}`,
    `PASS=${summary.counts.pass} FAIL=${summary.counts.fail} NOTE=${summary.counts.note} SKIP=${summary.counts.skip}`,
    ...results.map((r) => `[${r.status}] ${r.item}/${r.name}: ${r.detail.split('\n')[0]}`)
  ];
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4c-grok-report.txt'), `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
