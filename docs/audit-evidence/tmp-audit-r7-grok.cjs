#!/usr/bin/env node
'use strict';
/**
 * r7 — live re-measure of the six open holes on HEAD, plus the #1868 item 20
 * questions that previous wakes answered only by reading.
 * Does not edit src/ or tests/. Not a certification of a patch.
 */
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
    try { fs.symlinkSync(target, link, 'junction'); return true; } catch { return false; }
  }
}

function runGuard(repo, busRoot) {
  const env = { ...process.env };
  delete env.BUS_ALLOW_BROKEN_BUILD;
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe', env
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}

function compileOk(result) {
  return result.code === 0 && /compile OK \(staged index\)/i.test(result.out);
}

function liveOf(records) {
  return records.filter((item) => !item.supersededBy && !item.invalidateReason);
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'packages' }] } })
  );
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r7-'));
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
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  await writeBus(busRoot);
  return { dir, repo, busRoot };
}

async function plantOwnModules(repo) {
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  const ts = junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  const bin = junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return ts && bin;
}

async function plantLeakConfig(repo, includePath) {
  const pkg = path.join(repo, 'node_modules', 'leak-config');
  await fsp.mkdir(pkg, { recursive: true });
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'leak-config', version: '1.0.0' }));
  await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: [includePath.replace(/\\/g, '/')]
  }, null, 2));
}

async function item15() {
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'bare-extends-subpath', 'SKIP', 'no modules');
      else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json'
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-subpath',
          compileOk(result) ? 'FAIL' : (result.code === 1 ? 'PASS' : 'FAIL'),
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'include-nm-junction-to-worktree', 'SKIP', 'no modules');
      else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'include-nm-junction-to-worktree', 'SKIP', 'no junction');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['node_modules/leak-src']
          }, null, 2));
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'include-nm-junction-to-worktree',
            compileOk(result) ? 'FAIL' : (result.code === 1 ? 'PASS' : 'FAIL'),
            `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 400)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'triple-slash-outside-d.ts', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(hidden, 'declare type HiddenFix = number;\n');
        const ref = hidden.replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path="${ref}" />\nexport const broken: HiddenFix = 1;\n`);
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-outside-d.ts',
          compileOk(result) ? 'FAIL' : (result.code === 1 ? 'PASS' : 'FAIL'),
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'empty-files-solution-style', 'SKIP', 'no modules');
      else {
        await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'index.ts'), 'export const lib: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          include: ['index.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          files: [],
          references: [{ path: './packages/lib' }]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'empty-files-solution-style',
          compileOk(result) ? 'FAIL' : (result.code === 1 ? 'PASS' : 'FAIL'),
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }
}

async function item2() {
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r7-lock-'));
    try {
      const store = new EvidenceStore(root);
      const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      await fsp.writeFile(lockPath, '');
      const t0 = Date.now();
      let err = null;
      try {
        await store.record({ workId: 7, subject: 'empty-lock', statement: 'x', recordedBy: 'grok' });
      } catch (error) {
        err = error;
      }
      const dt = Date.now() - t0;
      rec(2, 'empty-lock-is-debris',
        err && /Timed out waiting for the evidence lock/i.test(err.message) && dt >= 9000 ? 'FAIL'
          : (!err && dt < 2000 ? 'PASS' : 'FAIL'),
        `dtMs=${dt} error=${err && err.message}`);
    } finally { await rm(root); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r7-opclose-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'stranded');
      const records = await store.listEvidence(source.seq);
      const summaries = records.filter((r) => r.consolidatedFrom !== undefined);
      rec(2, 'operatorCloseRecovery-compacts',
        closed && closed.status === 'closed' && summaries.length === 1 ? 'PASS' : 'FAIL',
        `closed=${closed && closed.status} summaries=${summaries.length} live=${liveOf(records).length} reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }
}

async function item20() {
  {
    const surfaces = [
      'src/harness.ts',
      'src/brain/contract.ts',
      'src/brain/bus-client.ts',
      'src/brain/brains/agent.ts',
      'src/worker-client.ts',
      'src/vscode-lm-worker.ts',
      'src/extension.ts'
    ];
    const hits = [];
    for (const rel of surfaces) {
      const text = await fsp.readFile(path.join(REPO, rel), 'utf8');
      if (/operatorCloseRecovery|close-recovery|mailbox_close_recovery|mailbox_operator_close/.test(text)) {
        hits.push(rel);
      }
    }
    rec(20, 'seat-surfaces-do-not-expose',
      hits.length === 0 ? 'PASS' : 'FAIL',
      hits.length === 0 ? 'no harness/brain/worker/vscode surface exposes operatorCloseRecovery' : `exposed on ${hits.join(', ')}`);
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r7-i20cli-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const cli = path.join(REPO, 'dist', 'mailbox.js');
      let out = '';
      let code = 0;
      try {
        out = execFileSync(process.execPath, [
          cli, 'close-recovery',
          '--root', dir,
          '--seat', 'grok',
          '--work-id', 'abc',
          '--reason', 'typo work id'
        ], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        code = error.status ?? 1;
        out = `${error.stdout || ''}${error.stderr || ''}`;
      }
      const still = await store.openRecoveryFor('grok');
      rec(20, 'non-numeric-work-id',
        code === 1 && /no open checkpoint/i.test(out) && still && still.workId === source.seq && still.status === 'open' ? 'PASS' : 'FAIL',
        `code=${code} stillOpen=${still && still.status} workId=${still && still.workId} out=${String(out).trim().slice(0, 300)}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r7-i20who-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'stranded after pty died');
      const keys = closed ? Object.keys(closed).sort() : [];
      rec(20, 'no-operator-identity-on-row',
        closed && closed.closeReason === 'operator-closed: stranded after pty died'
          && !('operator' in closed) && !('closedBy' in closed) && !('actor' in closed) ? 'PASS' : 'FAIL',
        `keys=${keys.join(',')} reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r7-i20race-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const worker = path.join(dir, 'racer.js');
      await fsp.writeFile(worker, `
        const { MailboxStore } = require(${JSON.stringify(path.join(REPO, 'dist', 'mailbox.js'))});
        const store = new MailboxStore(${JSON.stringify(dir)});
        const which = process.argv[2];
        const workId = Number(process.argv[3]);
        const run = which === 'close'
          ? store.operatorCloseRecovery('grok', workId, 'race-close')
          : store.openRecovery('grok', workId, 'race-open');
        run.then((r) => {
          process.stdout.write(JSON.stringify({ which, status: r && r.status, closeReason: r && r.closeReason, id: r && r.id }));
        }).catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
      `);
      const run = (which) => new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [worker, which, String(source.seq)], { windowsHide: true });
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { err += c; });
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(`${which} exit ${code}: ${err}`));
          else resolve(JSON.parse(out || '{}'));
        });
      });
      const [closed, opened] = await Promise.all([run('close'), run('open')]);
      const leftover = await store.openRecoveryFor('grok');
      const recalled = await store.recallAssignment('grok', source.seq);
      rec(20, 'concurrent-close-vs-openRecovery',
        (closed.status === 'closed' || leftover) && closed.closeReason !== 'settled' ? 'PASS' : 'FAIL',
        `close=${JSON.stringify(closed)} open=${JSON.stringify(opened)} leftover=${leftover && leftover.status} leftoverReason=${leftover && leftover.closeReason} leftoverNote=${leftover && leftover.note} recalled=${recalled ? 'yes' : 'no'}`);
    } finally { await rm(dir); }
  }
}

async function main() {
  console.log(`r7 live re-measure HEAD=${HEAD}`);
  await item15();
  await item2();
  await item20();
  const report = {
    head: HEAD,
    auditor: 'grok',
    instrument: 'tmp-audit-r7-grok.cjs',
    results,
    fail: results.filter((r) => r.status === 'FAIL').length,
    pass: results.filter((r) => r.status === 'PASS').length,
    skip: results.filter((r) => r.status === 'SKIP').length
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r7-grok-out.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ fail: report.fail, pass: report.pass, skip: report.skip }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
