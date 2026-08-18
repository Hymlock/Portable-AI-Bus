#!/usr/bin/env node
'use strict';
/**
 * r18 — leftover hunt after r17c. Not HEAD. Not a re-run of r7/r15/r16/r17.
 *
 * Item 15 classes not yet attacked against the patch:
 *   type-position import("C:/hidden/mod")
 *   JSDoc @type {import("C:/hidden/mod").T} with allowJs/checkJs
 *   file:// URL import
 *   UNC / \\?\ absolute import
 *   /// <amd-dependency path="C:/hidden/mod.ts" />
 *   compilerOptions.out (deprecated alias of outFile) outside
 *   compilerOptions.mapRoot / sourceRoot / outFile outside
 *   include with file:// URL
 *   /// <reference path="file:///C:/hidden/x.d.ts" />
 *
 * Item 2 classes not yet attacked after r17:
 *   UTF-8 BOM + live pid (must NOT treat a live owner as debris)
 *   UTF-8 BOM + missing pid (debris; recover)
 *   pid as 2147483647 (dead; recover)
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
const { EvidenceStore } = require(path.join(REPO, 'tmp-audit-r6-patches', 'dist-patched', 'evidence.js'));
const results = [];

function rec(name, status, detail) {
  const row = { name, status, detail: String(detail).slice(0, 8000) };
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

function runGuard(guard, repo, busRoot) {
  const env = { ...process.env };
  delete env.BUS_ALLOW_BROKEN_BUILD;
  try {
    const stdout = execFileSync(process.execPath, [guard, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|@ts-nocheck|noResolve|jsxImportSource|staged symlink/i.test(result.out);
}

function tsc(repo, args) {
  const bin = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  try {
    return {
      ok: true,
      out: execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', bin, ...args], {
        cwd: repo, encoding: 'utf8', stdio: 'pipe'
      })
    };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}${error.message}` };
  }
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({
      claims: {
        claude: [
          { path: 'src' },
          { path: 'tsconfig.json' },
          { path: 'package.json' }
        ]
      }
    })
  );
}

async function seed(tsconfig, extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r18-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  const hidden = path.join(dir, 'hidden');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  await fsp.mkdir(hidden, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  if (tsconfig !== null) {
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  }
  await writeBus(busRoot);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  if (extra) await extra({ dir, repo, busRoot, hidden });
  return { dir, repo, busRoot, hidden };
}

function posix(p) {
  return String(p).replace(/\\/g, '/');
}

function fileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, '/');
  return abs.startsWith('/') ? `file://${abs}` : `file:///${abs}`;
}

function listedOutside(listed, hidden) {
  const text = String(listed.out || listed).replace(/\\/g, '/').toLowerCase();
  const needle = String(hidden).replace(/\\/g, '/').toLowerCase();
  return text.includes(needle) || /\bhidden\b/.test(text);
}

function judgeOutsideLeak(name, worktree, listed, result, hidden) {
  const listedHidden = listedOutside(listed, hidden);
  if (!worktree.ok) rec(name, 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
  else if (!listedHidden) rec(name, 'NOTE', `tsc compiled but did not list the outside path\n${listed.out}`);
  else if (compileOk(result)) rec(name, 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
  else if (refused(result)) rec(name, 'PASS', result.out);
  else rec(name, 'NOTE', `code=${result.code}\n${result.out}`);
}

function judgeWriteKey(name, worktree, result) {
  if (!worktree.ok) rec(name, 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
  else if (refused(result)) rec(name, 'PASS', result.out);
  else if (compileOk(result)) rec(name, 'NOTE', `compile OK; write-side key not refused (noEmit so nothing written)\n${result.out}`);
  else rec(name, 'NOTE', `code=${result.code}\n${result.out}`);
}

function lockPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
}

async function withEvidenceRoot(name, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r18-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    try { await fsp.chmod(lockPath(dir), 0o666); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function recoverMs(store) {
  const t0 = Date.now();
  await store.record({ workId: 18, subject: 'r18', statement: 'probe', recordedBy: 'grok' });
  return Date.now() - t0;
}

async function main() {
  const green = 'export const n: number = 1;\n';
  const tsOpts = { strict: true, noEmit: true, skipLibCheck: true, types: [] };

  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      const spec = posix(hidden);
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `type H = import("${spec}").HiddenFix;\nexport const x: H = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('type-position-import', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, allowJs: true, checkJs: true },
      include: ['src/index.js']
    });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      const spec = posix(hidden);
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.js'),
        `/** @type {import("${spec}").HiddenFix} */\nexport const x = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.js');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('jsdoc-import-type', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      const spec = fileUrl(hidden);
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import type { HiddenFix } from "${spec}";\nexport const x: HiddenFix = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('file-url-import', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      const abs = path.resolve(hidden);
      const unc = abs.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '//localhost/$1$');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import type { HiddenFix } from "${unc}";\nexport const x: HiddenFix = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('unc-import', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `/// <amd-dependency path="${posix(hidden)}" />\nexport const x: number = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('amd-dependency-path', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const hidden = path.join(fx.hidden, 'fix.d.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `/// <reference path="${fileUrl(hidden)}" />\nexport const x: HiddenFix = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('file-url-triple-slash', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, out: '../hidden/bundle.js' },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeWriteKey('compilerOptions.out-outside', worktree, result);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, outFile: '../hidden/bundle.js' },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeWriteKey('compilerOptions.outFile-outside', worktree, result);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, sourceMap: true, mapRoot: '../hidden/maps', sourceRoot: '../hidden/src' },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeWriteKey('mapRoot-sourceRoot-outside', worktree, result);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: tsOpts,
      include: [fileUrl(path.join('unused'))]
    });
    try {
      const hidden = path.join(fx.hidden, 'x.ts');
      await fsp.writeFile(hidden, green);
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: tsOpts,
          include: [fileUrl(hidden)]
        }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('include-file-url', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (compileOk(result)) rec('honest-green', 'PASS', result.out);
      else rec('honest-green', 'FAIL', `honest green was refused\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  await withEvidenceRoot('bom-live-pid', async (dir, store) => {
    const body = `\uFEFF${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}`;
    await fsp.writeFile(lockPath(dir), body, 'utf8');
    const t0 = Date.now();
    let stolen = false;
    let err = '';
    try {
      await Promise.race([
        store.record({ workId: 18, subject: 'r18-live', statement: 'must wait', recordedBy: 'grok' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-waiting')), 400))
      ]);
      stolen = true;
    } catch (error) {
      err = String(error && error.message ? error.message : error);
    }
    const waited = Date.now() - t0;
    const stillThere = fs.existsSync(lockPath(dir));
    if (stolen) rec('item2-bom-live-pid', 'FAIL', `BOM+live pid treated as debris and stolen in ${waited}ms`);
    else if (!stillThere) rec('item2-bom-live-pid', 'FAIL', `BOM+live pid lock was removed while waiting (${err})`);
    else rec('item2-bom-live-pid', 'PASS', `waited ${waited}ms; live BOM lock kept (${err})`);
  });

  await withEvidenceRoot('bom-missing-pid', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), `\uFEFF${JSON.stringify({ at: new Date().toISOString() })}`, 'utf8');
    const ms = await recoverMs(store);
    if (ms < 200) rec('item2-bom-missing-pid', 'PASS', `recovered in ${ms}ms`);
    else rec('item2-bom-missing-pid', 'FAIL', `BOM+missing pid took ${ms}ms`);
  });

  await withEvidenceRoot('pid-int32max', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: 2147483647, at: new Date().toISOString() }), 'utf8');
    const ms = await recoverMs(store);
    if (ms < 200) rec('item2-pid-2147483647', 'PASS', `recovered in ${ms}ms`);
    else rec('item2-pid-2147483647', 'NOTE', `pid 2147483647 took ${ms}ms (maybe live?)`);
  });

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r18-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
