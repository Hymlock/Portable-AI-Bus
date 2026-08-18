#!/usr/bin/env node
'use strict';
/**
 * r8 — leftover attacks against the r6 PATCH, not HEAD.
 * Claude still holds the live files. This is not a certification of HEAD
 * and not a self-certification of the patch.
 *
 * Question: does the stated rule still decide wrongly after APPLY.md?
 * VARIANT = new spelling of something the patch already refuses.
 * HOLE = the rule does not decide it, or the patch decides it wrongly.
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

function refused(result) {
  return result.code === 1;
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r8-'));
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

async function main() {
  // 1. Directory symlink under src onto an outside tree that supplies HiddenFix.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('dir-symlink-hides-type-error', 'SKIP', 'no modules');
      else {
        const outside = path.join(fx.dir, 'outside-types');
        await fsp.mkdir(outside, { recursive: true });
        await fsp.writeFile(path.join(outside, 'hidden-fix.d.ts'), 'export {}; declare type HiddenFix = number;\n');
        const link = path.join(fx.repo, 'src', 'alias');
        if (!dirSymlink(link, outside) && !junction(link, outside)) {
          rec('dir-symlink-hides-type-error', 'SKIP', 'no dir symlink/junction');
        } else {
          await fsp.writeFile(
            path.join(fx.repo, 'src', 'index.ts'),
            'export const broken: HiddenFix = 1;\n'
          );
          git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(
            'dir-symlink-hides-type-error',
            compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
            `code=${result.code} ${result.out}`
          );
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // 2. Triple-slash with attributes before path (regex requires path first).
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('triple-slash-attr-order', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(hidden, 'export {}; declare type HiddenFix = number;\n');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference lib="es2020" path="${hidden.replace(/\\/g, '/')}" />\nexport const broken: HiddenFix = 1;\n`
        );
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(
          'triple-slash-attr-order',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} ${result.out}`
        );
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // 3. Relative import that walks out of scratch after checkout-index.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('relative-import-escape', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-mod.ts');
        await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
        // After checkout-index, scratch is a sibling-ish temp dir; we cannot know its
        // depth. Instead stage an import of an absolute path via a relative climb
        // that only works if tsc reads the WORKTREE file... no.
        // Better: put the hidden file as a sibling of the repo, and import via
        // a relative path from src that escapes the repo (and therefore scratch).
        const rel = path.relative(path.join(fx.repo, 'src'), hidden).replace(/\\/g, '/');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `import { n } from '${rel}';\nexport const broken: number = n;\n`
        );
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(
          'relative-import-escape',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} import=${rel} ${result.out}`
        );
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // 4. Absolute import of an outside .ts (control: r4 said this failed on its own).
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('absolute-import-control', 'SKIP', 'no modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-mod.ts');
        await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `import { n } from '${hidden.replace(/\\/g, '/')}';\nexport const broken: number = n;\n`
        );
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(
          'absolute-import-control',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE',
          `code=${result.code} ${result.out}`
        );
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // 5. Triple-slash types= (package name, not a path) — should stay a variant.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('triple-slash-types-package', 'SKIP', 'no modules');
      else {
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          '/// <reference types="node" />\nexport const good: number = 1;\n'
        );
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(
          'triple-slash-types-package',
          compileOk(result) ? 'PASS' : refused(result) ? 'NOTE' : 'FAIL',
          `code=${result.code} ${result.out}`
        );
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // 6. files: ["node_modules/leak-src/index.ts"] junction onto worktree src (sibling of include hole).
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('junction-files-worktree', 'SKIP', 'no modules');
      else {
        const leak = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leak, path.join(fx.repo, 'src'))) rec('junction-files-worktree', 'SKIP', 'no junction');
        else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            files: ['node_modules/leak-src/index.ts']
          }, null, 2));
          git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(
            'junction-files-worktree',
            compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
            `code=${result.code} ${result.out}`
          );
        }
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  // 7. noCheck set only in a bare-extends base.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec('nocheck-via-bare-extends', 'SKIP', 'no modules');
      else {
        const pkg = path.join(fx.repo, 'node_modules', 'base-config');
        await fsp.mkdir(pkg, { recursive: true });
        await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'base-config', version: '1.0.0' }));
        await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true }
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'base-config/tsconfig.json',
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(
          'nocheck-via-bare-extends',
          refused(result) && /noCheck/i.test(result.out) ? 'PASS' : compileOk(result) ? 'FAIL' : 'FAIL',
          `code=${result.code} ${result.out}`
        );
      }
    } finally { await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {}); }
  }

  const outPath = path.join(REPO, 'tmp-audit-r8-grok-out.json');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const skip = results.filter((r) => r.status === 'SKIP' || r.status === 'NOTE');
  const summary = {
    against: 'tmp-audit-r6-patches/claim-guard-cli.js',
    notHead: true,
    pass: pass.length,
    fail: fail.length,
    skipOrNote: skip.length,
    results
  };
  await fsp.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nSUMMARY ${pass.length}P / ${fail.length}F / ${skip.length}S-or-N -> ${outPath}`);
  process.exit(fail.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
