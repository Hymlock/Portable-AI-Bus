#!/usr/bin/env node
'use strict';
/**
 * r13b — confirm the r13 leftover close on the updated untracked patch.
 * Not HEAD. Not a re-run of r13's non-red NOTES.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
const PATCHED_DIST = path.join(REPO, 'tmp-audit-r6-patches', 'dist-patched');
const results = [];

function rec(item, name, status, detail) {
  const row = { item, name, status, detail: String(detail).slice(0, 8000) };
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
    const stdout = execFileSync(process.execPath, [PATCH, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe', env
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function compileOk(result) {
  return result.code === 0 && /compile OK \(staged index\)/i.test(result.out);
}

function refused(result, extra) {
  const pat = extra
    ? new RegExp(`REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|${extra}`, 'i')
    : /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|@ts-nocheck/i;
  return result.code === 1 && pat.test(result.out);
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
  );
}

async function seed(tsconfig) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  await writeBus(busRoot);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return { dir, repo, busRoot };
}

async function main() {
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        '// @ts-nocheck\nexport const broken: number = "no";\n'
      );
      git(fx.repo, 'add', '-A');
      const guard = runGuard(fx.repo, fx.busRoot);
      rec(15, 'ts-nocheck-sole/guard',
        refused(guard, '@ts-nocheck') ? 'PASS' : compileOk(guard) ? 'FAIL' : 'NOTE',
        `code=${guard.code}\n${guard.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'nocheck.ts'),
        '// @ts-nocheck\nexport const broken: number = "no";\n'
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'ok.ts'), 'export const good: number = 1;\n');
      git(fx.repo, 'add', '-A');
      const guard = runGuard(fx.repo, fx.busRoot);
      rec(15, 'ts-nocheck-mixed/guard',
        compileOk(guard) && /@ts-nocheck/i.test(guard.out) ? 'PASS' : compileOk(guard) ? 'NOTE' : 'FAIL',
        `code=${guard.code}\n${guard.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        '// @ts-expect-error\nexport const broken: number = "no";\n'
      );
      git(fx.repo, 'add', '-A');
      const guard = runGuard(fx.repo, fx.busRoot);
      rec(15, 'ts-expect-error/guard', compileOk(guard) ? 'PASS' : 'FAIL',
        `code=${guard.code}\n${guard.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      git(fx.repo, 'add', '-A');
      const guard = runGuard(fx.repo, fx.busRoot);
      rec(15, 'honest-green/guard', compileOk(guard) ? 'PASS' : 'FAIL',
        `code=${guard.code}\n${guard.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const tmpHiddenName = `pab-r13b-${process.pid}-hidden-fix.d.ts`;
    const tmpHidden = path.join(os.tmpdir(), tmpHiddenName);
    await fsp.writeFile(tmpHidden, 'type HiddenFix = number;\n');
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: ['src/index.ts', `\${configDir}/../${tmpHiddenName}`]
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: HiddenFix = 1;\n');
      git(fx.repo, 'add', '-A');
      const guard = runGuard(fx.repo, fx.busRoot);
      rec(15, 'configDir-sibling/guard',
        refused(guard, 'compiled files outside') ? 'PASS' : compileOk(guard) ? 'FAIL' : 'NOTE',
        `code=${guard.code}\n${guard.out}`);
    } finally {
      await fsp.rm(tmpHidden, { force: true }).catch(() => {});
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const { EvidenceStore } = require(path.join(PATCHED_DIST, 'evidence.js'));

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13b-empty-'));
    try {
      const store = new EvidenceStore(dir);
      await fsp.writeFile(path.join(dir, 'evidence.json.lock'), '');
      const started = Date.now();
      await store.record({ workId: 7, subject: 'empty-lock', statement: 'x', recordedBy: 'grok' });
      rec(2, 'empty-lock-still-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL',
        `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec(2, 'empty-lock-still-debris', 'FAIL', error.message);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13b-bom-'));
    try {
      const store = new EvidenceStore(dir);
      await fsp.writeFile(
        path.join(dir, 'evidence.json.lock'),
        `\uFEFF${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}`
      );
      const started = Date.now();
      let threw = null;
      try {
        await store.record({ workId: 7, subject: 'bom-live', statement: 'x', recordedBy: 'grok' });
      } catch (error) {
        threw = error;
      }
      const ms = Date.now() - started;
      if (threw && /Timed out waiting for the evidence lock/i.test(threw.message) && ms >= 2000) {
        rec(2, 'bom-live-pid-not-debris', 'PASS', `treated as live owner, timed out in ${ms}ms`);
      } else if (!threw && ms < 2000) {
        rec(2, 'bom-live-pid-not-debris', 'FAIL', `stole a live-pid lock in ${ms}ms`);
      } else {
        rec(2, 'bom-live-pid-not-debris', 'NOTE', threw ? `${ms}ms ${threw.message}` : `recovered in ${ms}ms`);
      }
    } catch (error) {
      rec(2, 'bom-live-pid-not-debris', 'FAIL', error.message);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r13b-grok-out.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
