#!/usr/bin/env node
'use strict';
/**
 * r17 — leftover hunt after r16c. Not HEAD. Not a re-run of r7/r15/r16.
 *
 * Item 15 classes not yet attacked against the patch:
 *   UTF-8 BOM + noCheck:true (readConfig JSON.parse fails on BOM)
 *   UTF-8 BOM + files listing an outside path
 *   ${configDir} interpolation in baseUrl via a node_modules junction
 *   package.json "tsconfig" field as an absolute outside path
 *   extends array: ["./ok.json", "leak-config"] with noCheck in the package
 *   generateCpuProfile / generateTrace pointing outside
 *   erasableSyntaxOnly + a type error
 *   allowImportingTsExtensions + absolute .ts import
 *   compilerOptions.paths "" → ../hidden
 *   disableSourceOfProjectReferenceRedirect + good .d.ts / broken .ts
 *   hardlink of an outside .ts into src then git add
 *
 * Item 2 classes not yet attacked after r16:
 *   pid: 1e308 (not a safe integer)
 *   read-only debris lock (Windows +R / chmod 444)
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
          { path: 'tsconfig.ok.json' },
          { path: 'package.json' },
          { path: 'packages' }
        ]
      }
    })
  );
}

async function seed(tsconfig, extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r17-'));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r17-ev-${name}-`));
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
  await store.record({ workId: 17, subject: 'r17', statement: 'probe', recordedBy: 'grok' });
  return Date.now() - t0;
}

async function makeReadOnly(filePath) {
  await fsp.chmod(filePath, 0o444);
  if (process.platform === 'win32') {
    try { execFileSync('cmd.exe', ['/c', 'attrib', '+R', filePath], { stdio: 'pipe' }); } catch { /* ignore */ }
  }
}

async function main() {
  // --- item 15 leftover hunt against the r14/r16 patch ---

  {
    const fx = await seed(null);
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        `\uFEFF${JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src/index.ts']
        }, null, 2)}`
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('bom-nocheck', worktree, result, 'BOM+noCheck compiled a type error');
      else rec('bom-nocheck', 'NOTE', `tsc did not honour BOM+noCheck\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed(null);
    try {
      const outside = path.join(fx.hidden, 'x.ts');
      await fsp.writeFile(outside, 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        `\uFEFF${JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          files: ['src/index.ts', outside.replace(/\\/g, '/')]
        }, null, 2)}`
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('bom-files-hidden', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: '${configDir}/node_modules/leak-src',
        paths: { '*': ['./*'] }
      },
      include: ['src/index.ts']
    }, async ({ repo, hidden }) => {
      await fsp.writeFile(path.join(hidden, 'mod.ts'), 'export const n: number = 1;\n');
      if (!junction(path.join(repo, 'node_modules', 'leak-src'), hidden)) {
        throw new Error('could not junction leak-src');
      }
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "mod";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('configDir-baseUrl-junction', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      extends: 'leak-via-field',
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    }, async ({ repo, hidden }) => {
      const pkg = path.join(repo, 'node_modules', 'leak-via-field');
      await fsp.mkdir(pkg, { recursive: true });
      const outsideCfg = path.join(hidden, 'tsconfig.json');
      await fsp.writeFile(outsideCfg, JSON.stringify({
        compilerOptions: { noCheck: true }
      }, null, 2));
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-via-field',
        tsconfig: outsideCfg.replace(/\\/g, '/')
      }, null, 2));
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('pkg-tsconfig-absolute', worktree, result, 'package.json tsconfig absolute+noCheck compiled a type error');
      else rec('pkg-tsconfig-absolute', 'NOTE', `tsc did not honour package.json tsconfig\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      extends: ['./tsconfig.ok.json', 'leak-config'],
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    }, async ({ repo }) => {
      await fsp.writeFile(
        path.join(repo, 'tsconfig.ok.json'),
        JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
      );
      const pkg = path.join(repo, 'node_modules', 'leak-config');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(
        path.join(pkg, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { noCheck: true } }, null, 2)
      );
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'tsconfig.ok.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('extends-array-pkg-nocheck', worktree, result, 'extends array package noCheck compiled a type error');
      else rec('extends-array-pkg-nocheck', 'NOTE', `tsc did not honour extends-array noCheck\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        generateCpuProfile: '../hidden/cpu.json'
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const wrote = fs.existsSync(path.join(fx.hidden, 'cpu.json'));
      if (!worktree.ok) rec('generateCpuProfile-outside', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result) && wrote) rec('generateCpuProfile-outside', 'NOTE', `compile OK and tsc wrote outside profile (write, not a see-leak)\n${result.out}`);
      else if (compileOk(result)) rec('generateCpuProfile-outside', 'NOTE', `compile OK; no outside profile written\n${result.out}`);
      else if (refused(result)) rec('generateCpuProfile-outside', 'PASS', result.out);
      else rec('generateCpuProfile-outside', 'NOTE', `code=${result.code} wrote=${wrote}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        generateTrace: '../hidden/trace'
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const wrote = fs.existsSync(path.join(fx.hidden, 'trace')) || fs.existsSync(path.join(fx.hidden, 'trace.json'));
      if (!worktree.ok) rec('generateTrace-outside', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result) && wrote) rec('generateTrace-outside', 'NOTE', `compile OK and tsc wrote outside trace (write, not a see-leak)\n${result.out}`);
      else if (compileOk(result)) rec('generateTrace-outside', 'NOTE', `compile OK; no outside trace written\n${result.out}`);
      else if (refused(result)) rec('generateTrace-outside', 'PASS', result.out);
      else rec('generateTrace-outside', 'NOTE', `code=${result.code} wrote=${wrote}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        erasableSyntaxOnly: true
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('erasableSyntaxOnly-type-error', worktree, result, 'erasableSyntaxOnly compiled a type error');
      else rec('erasableSyntaxOnly-type-error', 'NOTE', `tsc still type-checks under erasableSyntaxOnly (not red-capable)\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'esnext',
        moduleResolution: 'bundler',
        allowImportingTsExtensions: true,
        noEmit: true
      },
      include: ['src/index.ts']
    });
    try {
      const outside = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(outside, 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import { n } from ${JSON.stringify(outside.replace(/\\/g, '/'))};\nexport const x: number = n;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('allowImportingTsExtensions-abs', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: '.',
        paths: { '': ['../hidden'] }
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.hidden, 'mod.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "mod";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      judgeOutsideLeak('paths-empty-alias', worktree, listed, result, fx.hidden);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        composite: true,
        disableSourceOfProjectReferenceRedirect: true
      },
      files: ['src/index.ts'],
      references: [{ path: './packages/lib' }]
    }, async ({ repo }) => {
      await fsp.mkdir(path.join(repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true, composite: true, skipLibCheck: true, types: [],
            declaration: true, outDir: 'dist', rootDir: '.'
          },
          files: ['index.ts']
        }, null, 2)
      );
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'index.ts'),
        'export const n: number = "this does not compile";\n'
      );
      await fsp.mkdir(path.join(repo, 'packages', 'lib', 'dist'), { recursive: true });
      await fsp.writeFile(
        path.join(repo, 'packages', 'lib', 'dist', 'index.d.ts'),
        'export declare const n: number;\n'
      );
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "../packages/lib";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add',
        'tsconfig.json', 'src/index.ts',
        'packages/lib/tsconfig.json', 'packages/lib/index.ts',
        'packages/lib/dist/index.d.ts'
      );
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('disableSourceOfProjectReferenceRedirect', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('disableSourceOfProjectReferenceRedirect', 'NOTE', `tsc -p compiled via .d.ts mask; listed:\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('disableSourceOfProjectReferenceRedirect', 'PASS', result.out);
      else rec('disableSourceOfProjectReferenceRedirect', 'NOTE', `code=${result.code}\n${result.out}`);
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
      const outside = path.join(fx.hidden, 'good.ts');
      await fsp.writeFile(outside, 'export const n: number = 1;\n');
      const staged = path.join(fx.repo, 'src', 'index.ts');
      try {
        await fsp.link(outside, staged);
      } catch (error) {
        rec('hardlink-outside-into-src', 'NOTE', `could not hardlink: ${error.message}`);
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
        // fall through to remaining tests
      }
      if (fs.existsSync(staged)) {
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        if (!worktree.ok) rec('hardlink-outside-into-src', 'NOTE', `worktree tsc failed\n${worktree.out}`);
        else if (compileOk(result)) rec('hardlink-outside-into-src', 'NOTE', `compile OK; git stores the bytes (not a leak)\nlisted=${listed.out}`);
        else if (refused(result)) rec('hardlink-outside-into-src', 'PASS', result.out);
        else rec('hardlink-outside-into-src', 'NOTE', `code=${result.code}\n${result.out}`);
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
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (compileOk(result)) rec('honest-green', 'PASS', result.out);
      else rec('honest-green', 'FAIL', `honest green was refused\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // --- item 2 leftover hunt against the r14 patched dist ---

  await withEvidenceRoot('pid-1e308', async (root, store) => {
    await fsp.writeFile(lockPath(root), JSON.stringify({ pid: 1e308, at: '2020-01-01T00:00:00.000Z' }));
    try {
      const ms = await Promise.race([
        recoverMs(store),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-800ms')), 800))
      ]);
      rec('item2-pid-1e308', 'PASS', `recovered in ${ms}ms`);
    } catch (error) {
      rec('item2-pid-1e308', 'FAIL', String(error.message || error));
    }
  });

  await withEvidenceRoot('readonly-debris', async (root, store) => {
    const lp = lockPath(root);
    await fsp.writeFile(lp, JSON.stringify({ at: '2020-01-01T00:00:00.000Z' }));
    await makeReadOnly(lp);
    try {
      const ms = await Promise.race([
        recoverMs(store),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-800ms')), 800))
      ]);
      rec('item2-readonly-debris', 'PASS', `recovered in ${ms}ms`);
    } catch (error) {
      rec('item2-readonly-debris', 'FAIL', String(error.message || error));
    }
  });

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r17-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
