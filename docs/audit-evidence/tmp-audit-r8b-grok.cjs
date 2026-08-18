#!/usr/bin/env node
'use strict';
/**
 * r8b — leftover attacks against the r6 PATCH, instrument corrected.
 * r8 PASSed three cases because tsc never saw the leak (module-scoped
 * HiddenFix; .ts import extension). Those were not walker victories.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
const results = [];

function rec(name, status, detail) {
  const row = { name, status, detail: String(detail).slice(0, 4000) };
  results.push(row);
  console.log(`[${status}] ${name}: ${row.detail.split('\n')[0]}`);
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

function dirSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/D', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try { fs.symlinkSync(target, link, 'dir'); return true; } catch { return false; }
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

function compileOk(result) {
  return result.code === 0 && /compile OK \(staged index\)/i.test(result.out);
}

function walkerRefused(result) {
  return result.code === 1 && /OUTSIDE the staged tree|staged symlink|reference path/i.test(result.out);
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
  );
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r8b-'));
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

function lsIndex(repo) {
  try { return git(repo, 'ls-files', '-s'); } catch { return ''; }
}

async function main() {
  // CONTROL: tsc in the WORKTREE sees HiddenFix through the dir symlink.
  // If this is not compile-clean, the attack cannot go red.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('control-worktree-dir-symlink-compiles', 'SKIP', 'no modules');
      else {
        const outside = path.join(fx.dir, 'outside-types');
        await fsp.mkdir(outside, { recursive: true });
        await fsp.writeFile(path.join(outside, 'hidden-fix.d.ts'), 'declare type HiddenFix = number;\n');
        const link = path.join(fx.repo, 'src', 'alias');
        if (!dirSymlink(link, outside) && !junction(link, outside)) {
          rec('control-worktree-dir-symlink-compiles', 'SKIP', 'no dir symlink');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: HiddenFix = 1;\n');
          const tsc = path.join(fx.repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
          try {
            execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', tsc, '-p', fx.repo, '--noEmit'], {
              cwd: fx.repo, encoding: 'utf8', stdio: 'pipe'
            });
            rec('control-worktree-dir-symlink-compiles', 'PASS', 'tsc in worktree sees HiddenFix through dir symlink');
          } catch (error) {
            rec('control-worktree-dir-symlink-compiles', 'FAIL',
              `worktree tsc did not see the leak: ${error.stdout || ''} ${error.stderr || ''} ${error.message}`);
          }
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // Attack: same tree, staged, patched guard.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('dir-symlink-hides-type-error', 'SKIP', 'no modules');
      else {
        const outside = path.join(fx.dir, 'outside-types');
        await fsp.mkdir(outside, { recursive: true });
        await fsp.writeFile(path.join(outside, 'hidden-fix.d.ts'), 'declare type HiddenFix = number;\n');
        const link = path.join(fx.repo, 'src', 'alias');
        if (!dirSymlink(link, outside) && !junction(link, outside)) {
          rec('dir-symlink-hides-type-error', 'SKIP', 'no dir symlink');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: HiddenFix = 1;\n');
          git(fx.repo, 'add', '-A');
          const index = lsIndex(fx.repo);
          const result = runGuard(fx.repo, fx.busRoot);
          const status = compileOk(result) ? 'FAIL'
            : walkerRefused(result) ? 'PASS'
            : 'NOTE';
          rec('dir-symlink-hides-type-error', status,
            `code=${result.code}\nINDEX:\n${index}\nOUT:\n${result.out}`);
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // CONTROL: tsc accepts reference with lib before path.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('control-attr-order-tsc', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(hidden, 'declare type HiddenFix = number;\n');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference lib="es2020" path="${hidden.replace(/\\/g, '/')}" />\nexport const broken: HiddenFix = 1;\n`
        );
        const tsc = path.join(fx.repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
        try {
          execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', tsc, '-p', fx.repo, '--noEmit'], {
            cwd: fx.repo, encoding: 'utf8', stdio: 'pipe'
          });
          rec('control-attr-order-tsc', 'PASS', 'tsc accepts lib-before-path and sees HiddenFix');
        } catch (error) {
          rec('control-attr-order-tsc', 'NOTE',
            `tsc does not honour this spelling (not a hole): ${error.stdout || ''} ${error.stderr || ''}`);
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('triple-slash-attr-order', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(hidden, 'declare type HiddenFix = number;\n');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference lib="es2020" path="${hidden.replace(/\\/g, '/')}" />\nexport const broken: HiddenFix = 1;\n`
        );
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        const status = compileOk(result) ? 'FAIL'
          : walkerRefused(result) ? 'PASS'
          : 'NOTE';
        rec('triple-slash-attr-order', status, `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // Absolute import without .ts extension.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('absolute-import-noext', 'SKIP', 'no modules');
      else {
        const hiddenDir = path.join(fx.dir, 'hidden-pkg');
        await fsp.mkdir(hiddenDir, { recursive: true });
        await fsp.writeFile(path.join(hiddenDir, 'index.ts'), 'export const n: number = 1;\n');
        const spec = hiddenDir.replace(/\\/g, '/');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `import { n } from '${spec}';\nexport const broken: number = n;\n`
        );
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        const status = compileOk(result) ? 'FAIL'
          : walkerRefused(result) ? 'PASS'
          : 'NOTE';
        rec('absolute-import-noext', status, `code=${result.code} ${result.out}`);
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // CONTROL: worktree tsc compiles the absolute import.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('control-absolute-import', 'SKIP', 'no modules');
      else {
        const hiddenDir = path.join(fx.dir, 'hidden-pkg');
        await fsp.mkdir(hiddenDir, { recursive: true });
        await fsp.writeFile(path.join(hiddenDir, 'index.ts'), 'export const n: number = 1;\n');
        const spec = hiddenDir.replace(/\\/g, '/');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `import { n } from '${spec}';\nexport const broken: number = n;\n`
        );
        const tsc = path.join(fx.repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
        try {
          execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', tsc, '-p', fx.repo, '--noEmit'], {
            cwd: fx.repo, encoding: 'utf8', stdio: 'pipe'
          });
          rec('control-absolute-import', 'PASS', 'worktree tsc accepts absolute import');
        } catch (error) {
          rec('control-absolute-import', 'NOTE',
            `worktree tsc refuses absolute import: ${error.stdout || ''} ${error.stderr || ''}`);
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  const outPath = path.join(REPO, 'tmp-audit-r8b-grok-out.json');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE' || r.status === 'SKIP');
  await fsp.writeFile(outPath, JSON.stringify({
    against: 'tmp-audit-r6-patches/claim-guard-cli.js',
    notHead: true,
    pass: pass.length,
    fail: fail.length,
    noteOrSkip: note.length,
    results
  }, null, 2));
  console.log(`\nSUMMARY ${pass.length}P / ${fail.length}F / ${note.length}N -> ${outPath}`);
  process.exit(fail.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
