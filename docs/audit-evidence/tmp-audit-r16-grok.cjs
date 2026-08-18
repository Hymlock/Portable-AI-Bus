#!/usr/bin/env node
'use strict';
/**
 * r16 — leftover hunt after r15/r15b. Not HEAD. Not a re-run of r15.
 *
 * Item 15 classes not yet attacked:
 *   noCheck spelled as 1 / "true" (guard only tests === true)
 *   ${configDir} interpolation in include / paths
 *   paths "*" / "@h/*" remapping to ../hidden
 *   rootDirs containing ../hidden
 *   files listing ../hidden/x.ts
 *   noCheck only in an extended config
 *   @ts-nocheck on every own source
 *   disableReferencedProjectLoad + relative import of referenced .ts
 *   import type / export * from an absolute outside path
 *   compilerOptions.lib as a path
 *   incremental + tsBuildInfoFile outside
 *   include src + junction src/vendor onto outside
 *   root package.json "types" pointing outside
 *   noCheck only in a referenced project
 *
 * Item 2 classes not yet attacked after r15:
 *   pid float / boolean / object / negative / string
 *   BOM + missing pid
 *   UTF-16 BE
 *   JSON + trailing junk
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|@ts-nocheck|noResolve|jsxImportSource/i.test(result.out);
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
          { path: 'package.json' },
          { path: 'packages' },
          { path: 'tsconfig.base.json' }
        ]
      }
    })
  );
}

async function seed(tsconfig, extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r16-'));
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
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  await writeBus(busRoot);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  if (extra) await extra({ dir, repo, busRoot, hidden });
  return { dir, repo, busRoot, hidden };
}

function listedOutside(listed, hidden) {
  const text = String(listed.out || listed).replace(/\\/g, '/').toLowerCase();
  const needle = String(hidden).replace(/\\/g, '/').toLowerCase();
  return text.includes(needle) || text.includes('hidden');
}

function judgeOutsideLeak(name, worktree, listed, result, hidden) {
  const listedHidden = listedOutside(listed, hidden);
  if (!worktree.ok) rec(name, 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
  else if (!listedHidden) rec(name, 'NOTE', `tsc compiled but did not list the outside path\n${listed.out}`);
  else if (compileOk(result)) rec(name, 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
  else if (refused(result)) rec(name, 'PASS', result.out);
  else rec(name, 'NOTE', `code=${result.code}\n${result.out}`);
}

function judgeShouldRefuse(name, worktree, result, why) {
  if (!worktree.ok) rec(name, 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
  else if (compileOk(result)) rec(name, 'FAIL', `${why}\n${result.out}`);
  else if (refused(result)) rec(name, 'PASS', result.out);
  else rec(name, 'NOTE', `code=${result.code}\n${result.out}`);
}

function lockPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
}

async function withEvidenceRoot(name, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r16-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function recoverMs(store, started) {
  const t0 = Date.now();
  await store.claim(1, 'claude', 'probe', 'r16');
  return Date.now() - t0;
}

async function main() {
  // --- item 15 leftover hunt against the r14/r15 patch ---

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: 1 },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('nocheck-number-1', worktree, result, 'noCheck:1 compiled a type error');
      else rec('nocheck-number-1', 'NOTE', `tsc did not honour noCheck:1\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: 'true' },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('nocheck-string-true', worktree, result, 'noCheck:"true" compiled a type error');
      else rec('nocheck-string-true', 'NOTE', `tsc did not honour noCheck:"true"\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['${configDir}/../hidden/**/*.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.hidden, 'leak.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('configDir-include-escape', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: '.',
        paths: { '@h/*': ['../hidden/*'] }
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.hidden, 'mod.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'import { n } from "@h/mod";\nexport const x: number = n;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('paths-alias-to-hidden', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: '.',
        paths: { '*': ['../hidden/*', '*'] }
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.hidden, 'star.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'import { n } from "star";\nexport const x: number = n;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('paths-star-to-hidden', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        rootDirs: ['src', '../hidden']
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.hidden, 'ghost.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'import { n } from "./ghost";\nexport const x: number = n;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('rootDirs-hidden', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const hiddenFile = 'placeholder';
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: ['src/index.ts']
    });
    try {
      const outside = path.join(fx.hidden, 'x.ts');
      await fsp.writeFile(outside, 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          files: ['src/index.ts', path.relative(fx.repo, outside).replace(/\\/g, '/')]
        }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('files-lists-hidden', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      extends: './tsconfig.base.json',
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    }, async ({ repo }) => {
      await fsp.writeFile(
        path.join(repo, 'tsconfig.base.json'),
        JSON.stringify({ compilerOptions: { noCheck: true } }, null, 2)
      );
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'tsconfig.base.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('nocheck-via-extends', worktree, result, 'extended noCheck compiled a type error');
      else rec('nocheck-via-extends', 'NOTE', `tsc did not honour extended noCheck\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        '// @ts-nocheck\nexport const n: number = "this does not compile";\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('ts-nocheck-every-source', worktree, result, '@ts-nocheck on the only source compiled a type error');
      else rec('ts-nocheck-every-source', 'NOTE', `tsc did not honour @ts-nocheck\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        composite: true, disableReferencedProjectLoad: true
      },
      files: ['src/index.ts'],
      references: [{ path: './packages/lib' }]
    }, async ({ repo }) => {
      await fsp.mkdir(path.join(repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, composite: true, noEmit: false, skipLibCheck: true, types: [], declaration: true, outDir: 'dist' },
          files: ['index.ts']
        }, null, 2)
      );
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'index.ts'),
        'export const n: number = "this does not compile";\n'
      );
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "../packages/lib/index";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts', 'packages/lib/tsconfig.json', 'packages/lib/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('disableReferencedProjectLoad-relimport', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('disableReferencedProjectLoad-relimport', 'NOTE', `tsc -p compiled; listed:\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('disableReferencedProjectLoad-relimport', 'PASS', result.out);
      else rec('disableReferencedProjectLoad-relimport', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import type { n as N } from ${JSON.stringify(hidden.replace(/\\/g, '/'))};\nexport type X = typeof N;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('import-type-absolute', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `export * from ${JSON.stringify(hidden.replace(/\\/g, '/'))};\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('export-star-absolute', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        lib: ['../hidden/lib']
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(
        path.join(fx.hidden, 'lib.d.ts'),
        'interface HiddenFix { n: number }\n'
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('lib-as-path', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (listedOutside(listed, fx.hidden)) {
        if (compileOk(result)) rec('lib-as-path', 'FAIL', `compile OK; tsc listed outside lib\n${listed.out}\n${result.out}`);
        else if (refused(result)) rec('lib-as-path', 'PASS', result.out);
        else rec('lib-as-path', 'NOTE', `code=${result.code}\n${result.out}`);
      } else rec('lib-as-path', 'NOTE', `tsc compiled but did not list outside lib\n${listed.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        incremental: true,
        tsBuildInfoFile: '../hidden/.tsbuildinfo'
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const wroteOutside = fs.existsSync(path.join(fx.hidden, '.tsbuildinfo'));
      if (!worktree.ok) rec('tsBuildInfoFile-outside', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result) && wroteOutside) rec('tsBuildInfoFile-outside', 'FAIL', `compile OK and wrote outside tsbuildinfo\n${result.out}`);
      else if (refused(result)) rec('tsBuildInfoFile-outside', 'PASS', result.out);
      else rec('tsBuildInfoFile-outside', 'NOTE', `wroteOutside=${wroteOutside} code=${result.code}\n${result.out}`);
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
      const vendor = path.join(fx.repo, 'src', 'vendor');
      await fsp.writeFile(path.join(fx.hidden, 'leak.ts'), 'export const n: number = 1;\n');
      if (!junction(vendor, fx.hidden)) {
        rec('src-vendor-junction', 'NOTE', 'could not create junction');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'import { n } from "./vendor/leak";\nexport const x: number = n;\n');
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        judgeOutsideLeak('src-vendor-junction', worktree, listed, result, fx.hidden);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      const hidden = path.join(fx.hidden, 'index.d.ts');
      await fsp.writeFile(hidden, 'export declare const n: number;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'package.json'),
        JSON.stringify({ name: 'scratch', types: hidden.replace(/\\/g, '/') }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'package.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('root-package-types-outside', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!listedOutside(listed, fx.hidden)) rec('root-package-types-outside', 'NOTE', `tsc compiled but did not list outside types\n${listed.out}`);
      else if (compileOk(result)) rec('root-package-types-outside', 'FAIL', `compile OK; tsc listed outside types\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('root-package-types-outside', 'PASS', result.out);
      else rec('root-package-types-outside', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
      files: ['src/index.ts'],
      references: [{ path: './packages/lib' }]
    }, async ({ repo }) => {
      await fsp.mkdir(path.join(repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, composite: true, noCheck: true, skipLibCheck: true, types: [], declaration: true, outDir: 'dist' },
          files: ['index.ts']
        }, null, 2)
      );
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'index.ts'),
        'export const n: number = "this does not compile";\n'
      );
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts', 'packages/lib/tsconfig.json', 'packages/lib/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('nocheck-in-referenced-only', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('nocheck-in-referenced-only', 'NOTE', `tsc -p does not load referenced noCheck; classified with hole 4\n${result.out}`);
      else if (refused(result)) rec('nocheck-in-referenced-only', 'PASS', result.out);
      else rec('nocheck-in-referenced-only', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: '.',
        paths: { '@h/*': ['${configDir}/../hidden/*'] }
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.hidden, 'mod.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'import { n } from "@h/mod";\nexport const x: number = n;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('configDir-paths-escape', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // honest-green control
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('honest-green', 'NOTE', `worktree tsc failed\n${worktree.out}`);
      else if (compileOk(result)) rec('honest-green', 'PASS', result.out);
      else rec('honest-green', 'FAIL', `honest green was refused\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // --- item 2 leftover hunt against the r14 patched dist ---

  const debrisCases = [
    ['pid-float', JSON.stringify({ pid: 1.5, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-true', JSON.stringify({ pid: true, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-object', JSON.stringify({ pid: { nested: 1 }, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-negative', JSON.stringify({ pid: -5, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-string', JSON.stringify({ pid: '1234', at: '2020-01-01T00:00:00.000Z' })],
    ['bom-missing-pid', `\uFEFF${JSON.stringify({ at: '2020-01-01T00:00:00.000Z' })}`],
    ['json-trailing-junk', `${JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00.000Z' })}garbage`]
  ];

  for (const [name, bytes] of debrisCases) {
    await withEvidenceRoot(name, async (root, store) => {
      await fsp.writeFile(lockPath(root), bytes, 'utf8');
      try {
        const ms = await Promise.race([
          recoverMs(store),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-800ms')), 800))
        ]);
        rec(`item2-${name}`, 'PASS', `recovered in ${ms}ms`);
      } catch (error) {
        rec(`item2-${name}`, 'FAIL', String(error.message || error));
      }
    });
  }

  await withEvidenceRoot('utf16be', async (root, store) => {
    const text = JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00.000Z' });
    const be = Buffer.alloc(2 + text.length * 2);
    be[0] = 0xfe;
    be[1] = 0xff;
    for (let i = 0; i < text.length; i += 1) {
      be[2 + i * 2] = 0;
      be[3 + i * 2] = text.charCodeAt(i);
    }
    await fsp.writeFile(lockPath(root), be);
    try {
      const ms = await Promise.race([
        recoverMs(store),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-800ms')), 800))
      ]);
      rec('item2-utf16be', 'PASS', `recovered in ${ms}ms`);
    } catch (error) {
      rec('item2-utf16be', 'FAIL', String(error.message || error));
    }
  });

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r16-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
