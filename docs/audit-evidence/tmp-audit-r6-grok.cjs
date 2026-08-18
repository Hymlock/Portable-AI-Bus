'use strict';
/**
 * Round-6 instrument: attack the DROP-IN PATCH, not HEAD.
 * Claude still holds the live files. This is not a certification of HEAD.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches');
const GUARD = path.join(PATCH, 'claim-guard-cli.js');
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
    try {
      fs.symlinkSync(target, link, 'junction');
      return true;
    } catch {
      return false;
    }
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
      cwd: repo, encoding: 'utf8', stdio: 'pipe', env: merged
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r6-'));
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

function compileOk(result) {
  return result.code === 0 && /compile OK \(staged index\)/i.test(result.out);
}

function refused(result) {
  return result.code === 1;
}

async function stageBrokenRestoreGood(fx, tsconfig) {
  await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  if (tsconfig) await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
  await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
}

function loadPatchedStores() {
  const dest = path.join(PATCH, 'dist-patched');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['mailbox.js', 'evidence.js', 'claim-walk.js', 'workspace-key.js']) {
    fs.copyFileSync(path.join(REPO, 'dist', name), path.join(dest, name));
  }
  let evidence = fs.readFileSync(path.join(dest, 'evidence.js'), 'utf8');
  const oldLock = `                const owner = await fs.readFile(lockPath, 'utf8')
                    .then((text) => JSON.parse(text))
                    .catch(() => undefined);
                // A lock whose owner is gone is debris, not a claim.
                if (owner?.pid !== undefined && !evidenceProcessAlive(owner.pid)) {
                    await fs.rm(lockPath, { force: true });
                    continue;
                }`;
  const newLock = `                const raw = await fs.readFile(lockPath, 'utf8').catch(() => '');
                let owner;
                try { owner = raw.trim() ? JSON.parse(raw) : undefined; }
                catch { owner = undefined; }
                const pid = owner?.pid;
                const liveOwner = typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 && evidenceProcessAlive(pid);
                if (!liveOwner) {
                    await fs.rm(lockPath, { force: true });
                    continue;
                }`;
  if (!evidence.includes(oldLock)) throw new Error('evidence.js lock block not found for patch');
  fs.writeFileSync(path.join(dest, 'evidence.js'), evidence.replace(oldLock, newLock));

  let mailbox = fs.readFileSync(path.join(dest, 'mailbox.js'), 'utf8');
  const oldClose = `        return this.withLock(async () => {
            const file = await this.findMessagePathUnsafe(workId);
            if (!file)
                return undefined;
            const message = await this.readJson(file);
            const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === seat && item.status === 'open');
            if (!checkpoint)
                return undefined;
            const at = nowIso();
            checkpoint.status = 'closed';
            checkpoint.closedAt = at;
            checkpoint.updatedAt = at;
            // Marked as an operator action, not a seat outcome, so it never reads as completed work.
            checkpoint.closeReason = \`operator-closed: \${operatorReason.trim()}\`;
            await this.atomicJson(file, message);
            return checkpoint;
        });`;
  const newClose = `        const checkpoint = await this.withLock(async () => {
            const file = await this.findMessagePathUnsafe(workId);
            if (!file)
                return undefined;
            const message = await this.readJson(file);
            const checkpoint = message.recoveryCheckpoints?.find((item) => item.seat === seat && item.status === 'open');
            if (!checkpoint)
                return undefined;
            const at = nowIso();
            checkpoint.status = 'closed';
            checkpoint.closedAt = at;
            checkpoint.updatedAt = at;
            checkpoint.closeReason = \`operator-closed: \${operatorReason.trim()}\`;
            await this.atomicJson(file, message);
            return checkpoint;
        });
        if (checkpoint) {
            try { await this.evidence.consolidate(workId, seat); }
            catch { /* best-effort; the close is the fact */ }
        }
        return checkpoint;`;
  if (!mailbox.includes(oldClose)) throw new Error('mailbox.js operatorCloseRecovery block not found for patch');
  fs.writeFileSync(path.join(dest, 'mailbox.js'), mailbox.replace(oldClose, newClose));
  const { MailboxStore } = require(path.join(dest, 'mailbox.js'));
  const { EvidenceStore } = require(path.join(dest, 'evidence.js'));
  return { MailboxStore, EvidenceStore };
}

async function main() {
  // ---- item 15 against the patched guard ----
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'honest-green', 'SKIP', 'no modules');
      else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  for (const [name, extendsValue] of [
    ['bare-extends-subpath', 'leak-config/tsconfig.json'],
    ['bare-extends-array', ['leak-config/tsconfig.json']],
    ['bare-extends-package', 'leak-config']
  ]) {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) { rec(15, name, 'SKIP', 'no modules'); continue; }
      await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
      await stageBrokenRestoreGood(fx, {
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        extends: extendsValue
      });
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, name, refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'relative-extends-still-refused', 'SKIP', 'no modules');
      else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await stageBrokenRestoreGood(fx, {
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          extends: './node_modules/leak-config/tsconfig.json'
        });
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-extends-still-refused', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'junction-include-worktree', 'SKIP', 'no modules');
      else {
        const leak = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leak, path.join(fx.repo, 'src'))) rec(15, 'junction-include-worktree', 'SKIP', 'no junction');
        else {
          await stageBrokenRestoreGood(fx, {
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['node_modules/leak-src']
          });
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'junction-include-worktree', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'triple-slash-outside', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(hidden, 'export type HiddenFix = number;\n');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path="${hidden.replace(/\\/g, '/')}" />\nexport const broken: HiddenFix = 1;\n`);
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-outside', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'staged-symlink-outside', 'SKIP', 'no modules');
      else {
        const outside = path.join(fx.dir, 'good-outside.ts');
        await fsp.writeFile(outside, 'export const good: number = 1;\n');
        await fsp.rm(path.join(fx.repo, 'src', 'index.ts'));
        if (!fileSymlink(path.join(fx.repo, 'src', 'index.ts'), outside)) {
          rec(15, 'staged-symlink-outside', 'SKIP', 'no file symlink');
        } else {
          git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'staged-symlink-outside', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'empty-compile-not-verified', 'SKIP', 'no modules');
      else {
        await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src']
        }, null, 2));
        await fsp.mkdir(path.join(fx.repo, 'packages', 'lib', 'src'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'src', 'index.ts'), 'export const x: number = 1;\n');
        await stageBrokenRestoreGood(fx, {
          files: [],
          references: [{ path: './packages/lib' }]
        });
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'empty-compile-not-verified', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'nocheck-refused', 'SKIP', 'no modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'nocheck-refused', refused(result) && /noCheck/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'exclude-note-still-green', 'SKIP', 'no modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src'],
          exclude: ['src/nothing.ts']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'exclude-note-still-green',
          compileOk(result) && /excludes 1 pattern/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'absolute-include-still-refused', 'SKIP', 'no modules');
      else {
        await stageBrokenRestoreGood(fx, {
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        });
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'absolute-include-still-refused', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'type-error-still-red', 'SKIP', 'no modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'type-error-still-red', refused(result) ? 'PASS' : 'FAIL', `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // ---- item 2 against patched dist copies ----
  let stores;
  try {
    stores = loadPatchedStores();
  } catch (error) {
    rec(2, 'patch-apply', 'FAIL', error.message);
    stores = null;
  }

  if (stores) {
    const { EvidenceStore, MailboxStore } = stores;

    {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r6-lock-'));
      try {
        const store = new EvidenceStore(dir);
        await fsp.writeFile(path.join(dir, 'evidence.json.lock'), '');
        const started = Date.now();
        await store.record({ workId: 7, subject: 'empty-lock', statement: 'x', recordedBy: 'grok' });
        const ms = Date.now() - started;
        rec(2, 'empty-lock-is-debris', ms < 2000 ? 'PASS' : 'FAIL', `recovered in ${ms}ms`);
      } catch (error) {
        rec(2, 'empty-lock-is-debris', 'FAIL', error.message);
      } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
    }

    {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r6-lockb-'));
      try {
        const store = new EvidenceStore(dir);
        await fsp.writeFile(path.join(dir, 'evidence.json.lock'), '{not-json');
        const started = Date.now();
        await store.record({ workId: 7, subject: 'bad-json', statement: 'x', recordedBy: 'grok' });
        rec(2, 'unparseable-lock-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
      } catch (error) {
        rec(2, 'unparseable-lock-is-debris', 'FAIL', error.message);
      } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
    }

    {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r6-lockc-'));
      try {
        const store = new EvidenceStore(dir);
        await fsp.writeFile(path.join(dir, 'evidence.json.lock'), JSON.stringify({ at: 'now' }));
        const started = Date.now();
        await store.record({ workId: 7, subject: 'no-pid', statement: 'x', recordedBy: 'grok' });
        rec(2, 'missing-pid-lock-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
      } catch (error) {
        rec(2, 'missing-pid-lock-is-debris', 'FAIL', error.message);
      } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
    }

    {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r6-op-'));
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
        const summary = records.find((item) => item.consolidatedFrom !== undefined);
        const live = records.filter((item) => !item.supersededBy && !item.invalidateReason);
        rec(2, 'operatorCloseRecovery-compacts',
          closed && summary && summary.consolidatedFrom.length === 3 && live.length === 1 ? 'PASS' : 'FAIL',
          `closed=${Boolean(closed)} summary=${summary && summary.consolidatedFrom.length} live=${live.length}`);
      } catch (error) {
        rec(2, 'operatorCloseRecovery-compacts', 'FAIL', error.message);
      } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
    }

    {
      const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r6-inherit-'));
      try {
        const store = new MailboxStore(dir);
        await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
        const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
        await store.openRecovery('grok', source.seq, 'started');
        for (let i = 0; i < 3; i += 1) {
          await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
        }
        await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
        const records = await store.listEvidence(source.seq);
        const summary = records.find((item) => item.consolidatedFrom !== undefined);
        const live = records.filter((item) => !item.supersededBy && !item.invalidateReason);
        rec(2, 'inherit-does-not-compact',
          !summary && live.length === 3 ? 'PASS' : 'FAIL',
          `summary=${Boolean(summary)} live=${live.length}`);
      } catch (error) {
        rec(2, 'inherit-does-not-compact', 'FAIL', error.message);
      } finally { await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
    }
  }

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    skip: results.filter((r) => r.status === 'SKIP').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r6-grok-out.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, skip: summary.skip }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
