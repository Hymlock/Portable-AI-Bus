#!/usr/bin/env node
'use strict';
/**
 * r15 — leftover hunt after r14.
 * Not HEAD. Not a re-run of r7 / r12 / r14.
 *
 * Item 15 classes not yet attacked after r12:
 *   noResolve hiding an imported type error
 *   import = require of an absolute path
 *   node16 package.json imports remap
 *   moduleSuffixes
 *   rootDirs junction onto worktree src
 *   importHelpers + tslib types pointing outside
 *   allowArbitraryExtensions
 *   disableSourceOfProjectReferenceRedirect + composite .d.ts mask
 *   noUncheckedSideEffectImports
 *
 * Item 2 classes not yet attacked after r14:
 *   lock path is a junction onto a tree with a canary (rm must not delete the target)
 *   UTF-16 LE lock text
 *   JSON null / array / string
 *   lock is a file symlink to a live-pid JSON
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

function fileSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try { fs.symlinkSync(target, link, 'file'); return true; } catch { return false; }
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|noResolve|jsxImportSource/i.test(result.out);
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

async function writeBus(busRoot, extraClaims = []) {
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
          ...extraClaims
        ]
      }
    })
  );
}

async function seed(tsconfig, extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r15-'));
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

async function stageBrokenPlus(fx, files) {
  await fsp.writeFile(
    path.join(fx.repo, 'src', 'index.ts'),
    'export const broken: number = "this does not compile";\n'
  );
  await fsp.writeFile(path.join(fx.repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
  git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts', 'src/ok.ts', ...files);
  git(fx.repo, 'commit', '-q', '-m', 'seed');
  await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
}

function lockPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
}

async function withEvidenceRoot(name, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r15-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  // --- item 15 leftover hunt against the r14 patch ---

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noResolve: true },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "./broken";\nexport const x: number = n;\n'
      );
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'broken.ts'),
        'export const n: number = "this does not compile";\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts', 'src/broken.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('noResolve-hides-import', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('noResolve-hides-import', 'FAIL', `compile OK while broken.ts is staged\ntsc listed:\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('noResolve-hides-import', 'PASS', result.out);
      else rec('noResolve-hides-import', 'NOTE', `code=${result.code}\n${result.out}`);
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
      const hidden = path.join(fx.hidden, 'hidden.ts');
      await fsp.writeFile(hidden, 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import n = require(${JSON.stringify(hidden.replace(/\\/g, '/'))});\nexport const x: number = n.n;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const listedHidden = String(listed.out).toLowerCase().includes('hidden.ts');
      if (!worktree.ok) rec('import-equals-require-abs', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!listedHidden) rec('import-equals-require-abs', 'NOTE', `tsc compiled but did not list hidden.ts\n${listed.out}`);
      else if (compileOk(result)) rec('import-equals-require-abs', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('import-equals-require-abs', 'PASS', result.out);
      else rec('import-equals-require-abs', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'node16', moduleResolution: 'node16'
      },
      include: ['src/index.ts']
    });
    try {
      const hidden = path.join(fx.hidden, 'hidden.d.ts');
      await fsp.writeFile(hidden, 'export declare const n: number;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'package.json'),
        JSON.stringify({ type: 'module', imports: { '#hidden': hidden.replace(/\\/g, '/') } }, null, 2)
      );
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "#hidden";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'package.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const listedHidden = String(listed.out).toLowerCase().includes('hidden.d.ts');
      if (!worktree.ok) rec('node16-package-imports', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!listedHidden) rec('node16-package-imports', 'NOTE', `tsc compiled but did not list hidden.d.ts\n${listed.out}`);
      else if (compileOk(result)) rec('node16-package-imports', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('node16-package-imports', 'PASS', result.out);
      else rec('node16-package-imports', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        moduleSuffixes: ['.real', '']
      },
      include: ['src/index.ts']
    });
    try {
      const leakDir = path.join(fx.repo, 'node_modules', 'leak-suffix');
      await fsp.mkdir(leakDir, { recursive: true });
      if (!junction(path.join(leakDir, 'index.real.ts'), fx.hidden)) {
        rec('moduleSuffixes-junction', 'NOTE', 'could not create junction');
      } else {
        await fsp.writeFile(path.join(fx.hidden, 'index.real.ts'), 'export const n: number = 1;\n');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          'import { n } from "leak-suffix";\nexport const x: number = n;\n'
        );
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        const listedHidden = String(listed.out).toLowerCase().includes(fx.hidden.replace(/\\/g, '/').toLowerCase());
        if (!worktree.ok) rec('moduleSuffixes-junction', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
        else if (!listedHidden) rec('moduleSuffixes-junction', 'NOTE', `tsc compiled but did not list hidden realpath\n${listed.out}`);
        else if (compileOk(result)) rec('moduleSuffixes-junction', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
        else if (refused(result)) rec('moduleSuffixes-junction', 'PASS', result.out);
        else rec('moduleSuffixes-junction', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        rootDirs: ['src', 'node_modules/leak-root']
      },
      include: ['src/**/*.ts']
    });
    try {
      await fsp.mkdir(path.join(fx.repo, 'node_modules', 'leak-root'), { recursive: true });
      if (!junction(path.join(fx.repo, 'node_modules', 'leak-root', 'src'), path.join(fx.repo, 'src'))) {
        rec('rootDirs-worktree-junction', 'NOTE', 'could not create junction');
      } else {
        await stageBrokenPlus(fx, []);
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        if (compileOk(result) && worktree.ok) rec('rootDirs-worktree-junction', 'FAIL', `compile OK\nlisted:\n${listed.out}\n${result.out}`);
        else if (refused(result)) rec('rootDirs-worktree-junction', 'PASS', result.out);
        else rec('rootDirs-worktree-junction', 'NOTE', `tsc.ok=${worktree.ok} code=${result.code}\n${worktree.out}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        importHelpers: true
      },
      include: ['src/index.ts']
    });
    try {
      const tslibDir = path.join(fx.repo, 'node_modules', 'tslib');
      await fsp.mkdir(tslibDir, { recursive: true });
      const hidden = path.join(fx.hidden, 'tslib.d.ts');
      await fsp.writeFile(hidden, 'export declare function __assign(...args: any[]): any;\n');
      await fsp.writeFile(
        path.join(tslibDir, 'package.json'),
        JSON.stringify({ name: 'tslib', types: hidden.replace(/\\/g, '/') }, null, 2)
      );
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'export const x = { ...{ n: 1 } };\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const listedHidden = String(listed.out).toLowerCase().includes('tslib.d.ts');
      if (!worktree.ok) rec('importHelpers-tslib-types', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!listedHidden) rec('importHelpers-tslib-types', 'NOTE', `tsc compiled but did not list hidden tslib.d.ts\n${listed.out}`);
      else if (compileOk(result)) rec('importHelpers-tslib-types', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('importHelpers-tslib-types', 'PASS', result.out);
      else rec('importHelpers-tslib-types', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        allowArbitraryExtensions: true
      },
      include: ['src/index.ts']
    });
    try {
      const css = path.join(fx.hidden, 'theme.css.d.ts');
      await fsp.writeFile(css, 'export declare const n: number;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import { n } from ${JSON.stringify(path.join(fx.hidden, 'theme.css').replace(/\\/g, '/'))};\nexport const x: number = n;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const listedHidden = String(listed.out).toLowerCase().includes('theme.css');
      if (!worktree.ok) rec('allowArbitraryExtensions', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!listedHidden) rec('allowArbitraryExtensions', 'NOTE', `tsc compiled but did not list hidden css types\n${listed.out}`);
      else if (compileOk(result)) rec('allowArbitraryExtensions', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('allowArbitraryExtensions', 'PASS', result.out);
      else rec('allowArbitraryExtensions', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
      files: ['src/index.ts'],
      references: [{ path: './packages/lib' }]
    });
    try {
      await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true, declaration: true },
          files: ['index.ts']
        }, null, 2)
      );
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'index.ts'),
        'export const n: number = "this does not compile";\n'
      );
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'index.d.ts'),
        'export declare const n: number;\n'
      );
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "../packages/lib";\nexport const x: number = n;\n'
      );
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [],
            disableSourceOfProjectReferenceRedirect: true
          },
          files: ['src/index.ts'],
          references: [{ path: './packages/lib' }]
        }, null, 2)
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts', 'packages');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('project-ref-dts-mask', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('project-ref-dts-mask', 'NOTE', `compile OK — tsc -p does not compile references (already classified). listed:\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('project-ref-dts-mask', 'PASS', result.out);
      else rec('project-ref-dts-mask', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        noUncheckedSideEffectImports: true
      },
      include: ['src/index.ts']
    });
    try {
      const hidden = path.join(fx.hidden, 'side.css');
      await fsp.writeFile(hidden, '.x{color:red}\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import ${JSON.stringify(hidden.replace(/\\/g, '/'))};\nexport const n: number = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('noUncheckedSideEffectImports', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('noUncheckedSideEffectImports', 'NOTE', `compile OK; listed:\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('noUncheckedSideEffectImports', 'PASS', result.out);
      else rec('noUncheckedSideEffectImports', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // honest green control
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/**/*.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (compileOk(result)) rec('honest-green', 'PASS', result.out);
      else rec('honest-green', 'FAIL', `expected compile OK\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // --- item 2 leftover hunt against the r14 patched dist ---

  await withEvidenceRoot('junction', async (dir, store) => {
    const target = path.join(dir, 'do-not-delete');
    const canary = path.join(target, 'canary.txt');
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(canary, 'keep me');
    if (!junction(lockPath(dir), target)) {
      rec('lock-junction-does-not-rm-target', 'NOTE', 'could not create junction at lock path');
      return;
    }
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'junction-lock', statement: 'x', recordedBy: 'grok' });
      const elapsed = Date.now() - started;
      const canaryLeft = fs.existsSync(canary);
      const lockLeft = fs.existsSync(lockPath(dir));
      if (!canaryLeft) rec('lock-junction-does-not-rm-target', 'FAIL', `recovered in ${elapsed}ms but deleted the junction TARGET`);
      else if (elapsed >= 2000) rec('lock-junction-does-not-rm-target', 'FAIL', `canary survived but recovery took ${elapsed}ms`);
      else rec('lock-junction-does-not-rm-target', 'PASS', `recovered in ${elapsed}ms; canary survived; lockLeft=${lockLeft}`);
    } catch (error) {
      const canaryLeft = fs.existsSync(canary);
      rec('lock-junction-does-not-rm-target', canaryLeft ? 'FAIL' : 'FAIL', `${Date.now() - started}ms canary=${canaryLeft} ${error.message}`);
    }
  });

  await withEvidenceRoot('utf16', async (dir, store) => {
    const text = JSON.stringify({ pid: 999999, at: 'now' });
    await fsp.writeFile(lockPath(dir), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'utf16-lock', statement: 'x', recordedBy: 'grok' });
      rec('utf16-lock-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('utf16-lock-is-debris', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  for (const [name, body] of [
    ['json-null', 'null'],
    ['json-array', '[]'],
    ['json-string', '"1234"']
  ]) {
    await withEvidenceRoot(name, async (dir, store) => {
      await fsp.writeFile(lockPath(dir), body);
      const started = Date.now();
      try {
        await store.record({ workId: 7, subject: name, statement: 'x', recordedBy: 'grok' });
        rec(`${name}-lock-is-debris`, Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
      } catch (error) {
        rec(`${name}-lock-is-debris`, 'FAIL', `${Date.now() - started}ms ${error.message}`);
      }
    });
  }

  await withEvidenceRoot('symlink-live', async (dir, store) => {
    const real = path.join(dir, 'live-owner.json');
    await fsp.writeFile(real, JSON.stringify({ pid: process.pid, at: 'now' }));
    if (!fileSymlink(lockPath(dir), real)) {
      rec('symlink-to-live-pid-waits', 'NOTE', 'could not create file symlink at lock path');
      return;
    }
    const started = Date.now();
    try {
      await Promise.race([
        store.record({ workId: 7, subject: 'symlink-live', statement: 'x', recordedBy: 'grok' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('probe-timeout-800')), 800))
      ]);
      rec('symlink-to-live-pid-waits', 'FAIL', `recovered in ${Date.now() - started}ms — treated a live-pid symlink as debris`);
    } catch (error) {
      const elapsed = Date.now() - started;
      if (/probe-timeout-800|Timed out waiting/.test(error.message)) {
        rec('symlink-to-live-pid-waits', 'PASS', `still waiting after ${elapsed}ms (live owner)`);
      } else {
        rec('symlink-to-live-pid-waits', 'NOTE', `${elapsed}ms ${error.message}`);
      }
    }
  });

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r15-grok-out.json');
  await fsp.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nr15: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
