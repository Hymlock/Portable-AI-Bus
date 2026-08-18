'use strict';
/**
 * AUDIT round 4d — grok's own instrument.
 * Attacks compiled dist/ + scripts/claim-guard-cli.js. Does not edit src/ or tests/.
 * Stopping rule: VARIANT = new spelling of something the stated rule already decides.
 *               HOLE    = the rule does not decide it, or decides it wrongly.
 */
const { execFileSync, execFile } = require('node:child_process');
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
  const row = { item, name, status, detail: String(detail).slice(0, 6000) };
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
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'packages' }] } })
  );
}

function baseTsconfig(extra = {}) {
  return JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src'],
    ...extra
  }, null, 2);
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), baseTsconfig());
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

function compileOk(result) {
  return result.code === 0 && /compile OK \(staged index\)/i.test(result.out);
}

function refused(result) {
  return result.code === 1;
}

async function item15() {
  // Control: staged type error is red.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'staged-type-error-red', 'SKIP', 'no node_modules junction');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-type-error-red',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Control: honest green still lands.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'honest-green', 'SKIP', 'no node_modules');
      else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green', compileOk(result) ? 'PASS' : 'FAIL',
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
        const abs = path.join(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [abs]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'absolute-include-refused',
          refused(result) && /OUTSIDE the staged tree|include:/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Control: relative ../ include refused.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'relative-dotdot-include-refused', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['../repo/src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-dotdot-include-refused',
          refused(result) && /OUTSIDE the staged tree|include:/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Control: untracked extends refused.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'untracked-extends-refused', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.base.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: './tsconfig.base.json'
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json', 'src');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'untracked-extends-refused',
          refused(result) && /extends \(missing from the index\)/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Hatch is loud.
  {
    const fx = await seedRepo();
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
      rec(15, 'hatch-loud',
        result.code === 0 && /BUS_ALLOW_BROKEN_BUILD=1/i.test(result.out) && /SKIPPED/i.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
    } finally { await rm(fx.dir); }
  }

  // Missing mailbox still compiles (claim skip must not skip COMPILE).
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'missing-mailbox-still-compiles', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, path.join(fx.dir, 'no-such-bus'));
        rec(15, 'missing-mailbox-still-compiles',
          result.code === 1 && /does not compile|TS2322/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Same-package leak via RELATIVE extends into node_modules: should refuse.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'relative-nm-extends-refused', 'SKIP', 'no modules');
      else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: './node_modules/leak-config/tsconfig.json'
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-nm-extends-refused',
          refused(result) && /OUTSIDE the staged tree|include:/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // HOLE candidate: bare extends spellings.
  for (const [name, extendsValue] of [
    ['bare-extends-subpath', 'leak-config/tsconfig.json'],
    ['bare-extends-array', ['leak-config/tsconfig.json']],
    ['bare-extends-package', 'leak-config']
  ]) {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, name, 'SKIP', 'no modules');
      else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: extendsValue
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        const tscNamedWorktree = result.out.includes(fx.repo.replace(/\\/g, '/'))
          || result.out.includes(fx.repo)
          || /[\\/]repo[\\/]src[\\/]index\.ts/.test(result.out);
        // Control path: if green, tsc compiled the restored (good) worktree. That is the hole.
        rec(15, name,
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} tscNamedWorktree=${tscNamedWorktree} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Control for bare extends: worktree left BROKEN must go red AND name the worktree file.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'bare-extends-control-worktree-broken', 'SKIP', 'no modules');
      else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-config/tsconfig.json'
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        // leave worktree broken
        const result = runGuard(fx.repo, fx.busRoot);
        const namesWorktree = result.out.includes(path.join(fx.repo, 'src', 'index.ts'))
          || result.out.replace(/\\/g, '/').includes(path.join(fx.repo, 'src', 'index.ts').replace(/\\/g, '/'));
        rec(15, 'bare-extends-control-worktree-broken',
          result.code === 1 && namesWorktree ? 'PASS' : (compileOk(result) ? 'NOTE' : 'FAIL'),
          `code=${result.code} namesWorktree=${namesWorktree} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // HOLE candidate: include of a node_modules junction onto the worktree src.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'include-nm-junction-to-worktree', 'SKIP', 'no modules');
      else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'include-nm-junction-to-worktree', 'SKIP', 'could not create leak-src junction');
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
            compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
            `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  // files[] of a junctioned path (explicit files often bypass exclude).
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'files-nm-junction-to-worktree', 'SKIP', 'no modules');
      else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'files-nm-junction-to-worktree', 'SKIP', 'no junction');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            files: ['node_modules/leak-src/index.ts']
          }, null, 2));
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'files-nm-junction-to-worktree',
            compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
            `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  // Triple-slash reference path to an outside .d.ts that hides a type error.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'triple-slash-outside-d.ts', 'SKIP', 'no node_modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(hidden, 'declare type HiddenFix = number;\n');
        const ref = hidden.replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path="${ref}" />\nexport const broken: HiddenFix = 1;\n`);
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-outside-d.ts',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Staged file symlink pointing at an outside good file (index is a type error).
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'staged-symlink-to-outside', 'SKIP', 'no node_modules');
      else {
        const outside = path.join(fx.dir, 'good-outside.ts');
        await fsp.writeFile(outside, 'export const good: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.unlink(path.join(fx.repo, 'src', 'index.ts'));
        if (!fileSymlink(path.join(fx.repo, 'src', 'index.ts'), outside)) {
          rec(15, 'staged-symlink-to-outside', 'SKIP', 'could not create file symlink');
        } else {
          git(fx.repo, 'add', '-A');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'staged-symlink-to-outside',
            compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
            `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  // noCheck: true hides a type error (declared consequence; classify).
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'nocheck-hides-type-error', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'nocheck-hides-type-error',
          compileOk(result) && /noCheck/i.test(result.out) ? 'NOTE' : (refused(result) ? 'PASS' : 'FAIL'),
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // VARIANT: write-side keys omitted from the walker.
  for (const [name, options] of [
    ['tsBuildInfoFile-outside', { incremental: true, tsBuildInfoFile: path.join(os.tmpdir(), `pab-r4d-leak-${process.pid}.tsbuildinfo`).replace(/\\/g, '/') }],
    ['outFile-outside', { outFile: path.join(os.tmpdir(), `pab-r4d-out-${process.pid}.js`).replace(/\\/g, '/'), module: 'amd' }],
    ['mapRoot-outside', { sourceMap: true, mapRoot: path.join(os.tmpdir(), 'pab-r4d-maps').replace(/\\/g, '/') }]
  ]) {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, name, 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], ...options },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, name,
          compileOk(result) ? 'NOTE' : (refused(result) ? 'PASS' : 'FAIL'),
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Subdir tsconfig is not auto-picked by tsc -p scratch.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'subdir-tsconfig-not-autopicked', 'SKIP', 'no node_modules');
      else {
        await fsp.mkdir(path.join(fx.repo, 'packages', 'app'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'packages', 'app', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'packages', 'app', 'ok.ts'), 'export const x: number = 1;\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'subdir-tsconfig-not-autopicked',
          compileOk(result) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // Project references path is checked lexically; tsc -p does not follow them without -b.
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'project-references-not-followed-by-tsc-p', 'SKIP', 'no node_modules');
      else {
        await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          include: ['src'],
          references: [{ path: './packages/lib' }]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'project-references-not-followed-by-tsc-p',
          compileOk(result) ? 'PASS' : (refused(result) && /references/i.test(result.out) ? 'NOTE' : 'FAIL'),
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  // typeRoots via node_modules junction to an outside .d.ts that hides an error.
  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'typeroots-nm-junction', 'SKIP', 'no modules');
      else {
        const leakTypes = path.join(fx.repo, 'node_modules', 'leak-types');
        const outsideTypes = path.join(fx.dir, 'outside-types');
        await fsp.mkdir(path.join(outsideTypes, 'leak-types'), { recursive: true });
        await fsp.writeFile(path.join(outsideTypes, 'leak-types', 'index.d.ts'), 'declare type HiddenFix = number;\n');
        if (!junction(leakTypes, outsideTypes)) {
          rec(15, 'typeroots-nm-junction', 'SKIP', 'no junction');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, typeRoots: ['node_modules/leak-types'] },
            include: ['src']
          }, null, 2));
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: HiddenFix = 1;\n');
          git(fx.repo, 'add', '-A');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'typeroots-nm-junction',
            compileOk(result) ? 'FAIL' : (refused(result) ? 'PASS' : 'FAIL'),
            `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  // Staged node_modules directory should fail closed (symlink onto existing dir).
  {
    const fx = await seedRepo();
    try {
      await fsp.mkdir(path.join(fx.repo, 'node_modules', 'x'), { recursive: true });
      await fsp.writeFile(path.join(fx.repo, 'node_modules', 'x', 'index.js'), 'module.exports = 1;\n');
      await fsp.writeFile(path.join(fx.repo, '.gitignore'), '');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'staged-node-modules-fail-closed',
        refused(result) ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
    } finally { await rm(fx.dir); }
  }
}

async function item2() {
  const { EvidenceStore: ES } = require('./dist/evidence.js');

  async function withRoot(fn) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-e-'));
    try {
      return await fn(new ES(root), root);
    } finally {
      await rm(root);
    }
  }

  // Invalidate restores absorbed episodes.
  await withRoot(async (store) => {
    const made = [];
    for (const subject of ['a', 'b', 'c']) {
      made.push(await store.record({ workId: 1, subject, statement: `${subject} happened`, recordedBy: 'grok' }));
    }
    const { summary, absorbed } = await store.consolidate(1, 'grok');
    await store.invalidate(summary.id, 'bad rollup');
    const live = liveOf(await store.list(1));
    rec(2, 'invalidate-restores-absorbed',
      absorbed === 3 && live.length === 3 && live.every((r) => made.some((m) => m.id === r.id)) ? 'PASS' : 'FAIL',
      `absorbed=${absorbed} live=${live.map((r) => r.subject).join(',')} summaryInvalid=${!!(await store.get(summary.id)).invalidateReason}`);
  });

  // Two summaries over time.
  await withRoot(async (store) => {
    const a = [];
    for (const subject of ['a1', 'a2', 'a3']) a.push(await store.record({ workId: 2, subject, statement: subject, recordedBy: 'grok' }));
    const s1 = (await store.consolidate(2, 'grok')).summary;
    const b = [];
    for (const subject of ['b1', 'b2', 'b3']) b.push(await store.record({ workId: 2, subject, statement: subject, recordedBy: 'grok' }));
    const s2 = (await store.consolidate(2, 'grok')).summary;
    await store.invalidate(s2.id, 's2 bad');
    const afterS2 = liveOf(await store.list(2));
    const afterS2Ids = new Set(afterS2.map((r) => r.id));
    const s2restoredB = b.every((r) => afterS2Ids.has(r.id));
    const s1stillLive = afterS2Ids.has(s1.id);
    const aStillAbsorbed = a.every((r) => !afterS2Ids.has(r.id));
    await store.invalidate(s1.id, 's1 bad');
    const afterS1 = liveOf(await store.list(2));
    const afterS1Ids = new Set(afterS1.map((r) => r.id));
    const aRestored = a.every((r) => afterS1Ids.has(r.id));
    rec(2, 'two-summaries-over-time',
      s2restoredB && s1stillLive && aStillAbsorbed && aRestored ? 'PASS' : 'FAIL',
      `afterS2=${afterS2.map((r) => r.subject).join(',')} afterS1=${afterS1.map((r) => r.subject).join(',')}`);
  });

  // Already-superseded-before-absorption stays pointing at the pre-absorption successor.
  await withRoot(async (store, root) => {
    const retired = await store.record({ workId: 3, subject: 'retired', statement: 'old', recordedBy: 'grok' });
    const newer = await store.record({ workId: 3, subject: 'retired', statement: 'new', recordedBy: 'grok' });
    const extras = [];
    for (const subject of ['x', 'y', 'z']) extras.push(await store.record({ workId: 3, subject, statement: subject, recordedBy: 'grok' }));
    const filePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    raw.records.find((r) => r.id === retired.id).supersededBy = newer.id;
    await fsp.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
    const { summary } = await store.consolidate(3, 'grok');
    await store.invalidate(summary.id, 'undo');
    const retiredAfter = (await store.list(3)).find((r) => r.id === retired.id);
    rec(2, 'superseded-before-absorption-untouched',
      retiredAfter.supersededBy === newer.id ? 'PASS' : 'FAIL',
      `supersededBy=${retiredAfter.supersededBy} expected=${newer.id}`);
  });

  // Restore keeps each episode's own trust.
  await withRoot(async (store, root) => {
    const a = await store.record({ workId: 4, subject: 'untrusted-a', statement: 'a', recordedBy: 'grok' });
    const b = await store.record({ workId: 4, subject: 'untrusted-b', statement: 'b', recordedBy: 'grok' });
    const c = await store.record({ workId: 4, subject: 'untrusted-c', statement: 'c', recordedBy: 'grok' });
    const filePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
    const raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    raw.records.find((r) => r.id === a.id).trust = 'verified';
    await fsp.writeFile(filePath, `${JSON.stringify(raw, null, 2)}\n`);
    const { summary } = await store.consolidate(4, 'grok');
    const summaryTrust = summary.trust;
    await store.invalidate(summary.id, 'undo');
    const all = await store.list(4);
    const a2 = all.find((r) => r.id === a.id);
    const b2 = all.find((r) => r.id === b.id);
    rec(2, 'restore-keeps-own-trust',
      a2.trust === 'verified' && b2.trust === 'untrusted' && summaryTrust === 'untrusted' ? 'PASS' : 'FAIL',
      `a=${a2.trust} b=${b2.trust} summaryWas=${summaryTrust}`);
  });

  // Re-invalidating an old summary does not steal episodes now held by a newer one.
  await withRoot(async (store) => {
    for (const subject of ['p', 'q', 'r']) await store.record({ workId: 5, subject, statement: subject, recordedBy: 'grok' });
    const s1 = (await store.consolidate(5, 'grok')).summary;
    await store.invalidate(s1.id, 'first undo');
    const s2 = (await store.consolidate(5, 'grok')).summary;
    await store.invalidate(s1.id, 'stale undo');
    const live = liveOf(await store.list(5));
    rec(2, 'old-summary-invalidate-does-not-steal',
      live.length === 1 && live[0].id === s2.id ? 'PASS' : 'FAIL',
      `live=${live.map((r) => `${r.subject}:${r.id === s2.id ? 's2' : r.id}`).join(',')}`);
  });

  // Dead-owner lock recovers quickly.
  await withRoot(async (store, root) => {
    const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    const child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const pid = child.pid;
    await new Promise((r) => setTimeout(r, 80));
    await fsp.writeFile(lockPath, JSON.stringify({ pid, at: new Date().toISOString() }));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 80));
    const t0 = Date.now();
    const row = await store.record({ workId: 6, subject: 'after-dead-lock', statement: 'x', recordedBy: 'grok' });
    const dt = Date.now() - t0;
    rec(2, 'dead-owner-lock-recovers',
      row && dt < 2000 ? 'PASS' : 'FAIL',
      `dtMs=${dt} id=${row && row.id}`);
  });

  // Empty lock treated as live owner (HOLE candidate).
  await withRoot(async (store, root) => {
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
  });

  // Malformed JSON lock (same class).
  await withRoot(async (store, root) => {
    const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, '{not-json');
    const t0 = Date.now();
    let err = null;
    try {
      await store.record({ workId: 8, subject: 'bad-lock', statement: 'x', recordedBy: 'grok' });
    } catch (error) {
      err = error;
    }
    const dt = Date.now() - t0;
    rec(2, 'malformed-lock-is-debris',
      err && /Timed out waiting for the evidence lock/i.test(err.message) && dt >= 9000 ? 'FAIL'
        : (!err && dt < 2000 ? 'PASS' : 'FAIL'),
      `dtMs=${dt} error=${err && err.message}`);
  });

  // Missing pid object is the same class.
  await withRoot(async (store, root) => {
    const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, JSON.stringify({ at: new Date().toISOString() }));
    const t0 = Date.now();
    let err = null;
    try {
      await store.record({ workId: 9, subject: 'nopid-lock', statement: 'x', recordedBy: 'grok' });
    } catch (error) {
      err = error;
    }
    const dt = Date.now() - t0;
    rec(2, 'missing-pid-lock-is-debris',
      err && /Timed out waiting for the evidence lock/i.test(err.message) && dt >= 9000 ? 'FAIL'
        : (!err && dt < 2000 ? 'PASS' : 'FAIL'),
      `dtMs=${dt} error=${err && err.message}`);
  });

  // closeRecovery still closes when consolidate throws.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-mb-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      const evPath = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
      await fsp.writeFile(evPath, 'NOT-JSON');
      const closed = await store.closeRecovery('grok', source.seq, 'done');
      rec(2, 'closeRecovery-survives-consolidate-throw',
        closed && closed.status === 'closed' ? 'PASS' : 'FAIL',
        `closed=${closed && closed.status} reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  // closeRecovery does compact.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-mb2-'));
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
      const summaries = records.filter((r) => r.consolidatedFrom !== undefined);
      rec(2, 'closeRecovery-compacts',
        summaries.length === 1 && summaries[0].consolidatedFrom.length === 3 ? 'PASS' : 'FAIL',
        `summaries=${summaries.length} absorbed=${summaries[0] && summaries[0].consolidatedFrom.length} live=${liveOf(records).length}`);
    } finally { await rm(dir); }
  }

  // operatorCloseRecovery does NOT compact (HOLE candidate if we classify operator close as a close).
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-mb3-'));
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

  // Inherit close must NOT compact (assignment continues). Control, not a hole if it doesn't.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-mb4-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      await store.reassignBaton({ to: 'codex', reason: 'provider loss', force: true });
      const records = await store.listEvidence(source.seq);
      const summaries = records.filter((r) => r.consolidatedFrom !== undefined);
      rec(2, 'inherit-must-not-compact',
        summaries.length === 0 && liveOf(records).length === 3 ? 'PASS' : 'FAIL',
        `summaries=${summaries.length} live=${liveOf(records).length}`);
    } finally { await rm(dir); }
  }

  // Four real processes recording through a barrier: unique sourceEventId.
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-rec-'));
    try {
      const startAt = Date.now() + 1500;
      const script = (i) => `
        const { EvidenceStore } = require(${JSON.stringify(path.join(REPO, 'dist', 'evidence.js'))});
        while (Date.now() < ${startAt}) {}
        new EvidenceStore(${JSON.stringify(root)}).record({ workId: 10, subject: 'r${i}', statement: 'x', recordedBy: 'grok' })
          .then((r) => console.log(JSON.stringify({ ok: true, id: r.sourceEventId, subject: r.subject })))
          .catch((e) => console.log(JSON.stringify({ ok: false, error: e.message })));
      `;
      const run = (i) => new Promise((resolve) => {
        execFile(process.execPath, ['-e', script(i)], { encoding: 'utf8' }, (error, stdout) => {
          resolve({ error, stdout: String(stdout).trim() });
        });
      });
      const outs = await Promise.all([0, 1, 2, 3].map(run));
      const parsed = outs.map((o) => {
        try { return JSON.parse(o.stdout); } catch { return { ok: false, error: o.stdout || o.error?.message }; }
      });
      const ids = parsed.filter((p) => p.ok).map((p) => p.id);
      rec(2, 'four-process-record-unique-event-ids',
        parsed.every((p) => p.ok) && new Set(ids).size === 4 ? 'PASS' : 'FAIL',
        `parsed=${JSON.stringify(parsed)}`);
    } finally { await rm(root); }
  }

  // Four real processes consolidating WITH the lock.
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-con-'));
    try {
      const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox');
      await fsp.mkdir(dir, { recursive: true });
      const filler = 'x'.repeat(2048);
      const records = Array.from({ length: 300 }, (_, i) => ({
        id: `record-${i}`, workId: 42, subject: `step-${i}`, statement: `${filler} ${i}`,
        trust: 'untrusted', recordedBy: 'grok', sourceEventId: i + 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }));
      await fsp.writeFile(path.join(dir, 'evidence.json'),
        JSON.stringify({ schema: 1, nextEventId: 301, records }, null, 2));
      const startAt = Date.now() + 1500;
      const script = (seat) => `
        const { EvidenceStore } = require(${JSON.stringify(path.join(REPO, 'dist', 'evidence.js'))});
        while (Date.now() < ${startAt}) {}
        new EvidenceStore(${JSON.stringify(root)}).consolidate(42, ${JSON.stringify(seat)})
          .then((r) => console.log(JSON.stringify({ ok: true, absorbed: r.absorbed })))
          .catch((e) => console.log(JSON.stringify({ ok: false, error: e.message })));
      `;
      const run = (seat) => new Promise((resolve) => {
        execFile(process.execPath, ['-e', script(seat)], { encoding: 'utf8' }, (error, stdout) => {
          resolve({ error, stdout: String(stdout).trim() });
        });
      });
      const outs = await Promise.all(['grok', 'codex', 'claude', 'worker'].map(run));
      const parsed = outs.map((o) => {
        try { return JSON.parse(o.stdout); } catch { return { ok: false, error: o.stdout || o.error?.message }; }
      });
      const store = new EvidenceStore(root);
      const all = await store.list(42);
      const summaries = all.filter((item) => item.consolidatedFrom !== undefined);
      const live = liveOf(all);
      rec(2, 'four-process-consolidate-locked',
        parsed.every((p) => p.ok) && summaries.length === 1 && live.length === 1 && summaries[0].consolidatedFrom.length === 300 ? 'PASS' : 'FAIL',
        `children=${JSON.stringify(parsed)} summaries=${summaries.length} live=${live.length} absorbed=${summaries[0] && summaries[0].consolidatedFrom.length}`);
    } finally { await rm(root); }
  }

  // Unlocked four-process copy: can the crash half go red? leftover shape?
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-ul-'));
    try {
      const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox');
      await fsp.mkdir(dir, { recursive: true });
      const filler = 'x'.repeat(2048);
      const records = Array.from({ length: 300 }, (_, i) => ({
        id: `record-${i}`, workId: 42, subject: `step-${i}`, statement: `${filler} ${i}`,
        trust: 'untrusted', recordedBy: 'grok', sourceEventId: i + 1,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      }));
      const filePath = path.join(dir, 'evidence.json');
      await fsp.writeFile(filePath, JSON.stringify({ schema: 1, nextEventId: 301, records }, null, 2));
      const startAt = Date.now() + 1500;
      const unlocked = `
        const fs = require('node:fs/promises');
        const path = require('node:path');
        const { randomUUID } = require('node:crypto');
        const filePath = ${JSON.stringify(filePath)};
        async function load() { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
        async function save(file) {
          const temporary = filePath + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
          try {
            await fs.writeFile(temporary, JSON.stringify(file, null, 2) + '\\n', 'utf8');
            await fs.rename(temporary, filePath);
          } finally {
            await fs.rm(temporary, { force: true });
          }
        }
        async function consolidate() {
          const file = await load();
          const live = file.records.filter((item) => item.workId === 42 && !item.supersededBy && !item.invalidateReason);
          const episodes = live.filter((item) => item.consolidatedFrom === undefined);
          if (episodes.length < 3) return { absorbed: 0 };
          const at = new Date().toISOString();
          const sourceEventId = file.nextEventId;
          file.nextEventId += 1;
          const summary = {
            id: randomUUID(), workId: 42, subject: 'consolidated: work #42',
            statement: episodes.map((item) => item.subject).join(','),
            trust: 'untrusted', recordedBy: 'unlocked', sourceEventId, createdAt: at, updatedAt: at,
            consolidatedFrom: episodes.map((item) => item.id).sort()
          };
          for (const episode of episodes) { episode.supersededBy = summary.id; episode.updatedAt = at; }
          file.records.push(summary);
          await save(file);
          return { absorbed: episodes.length, summaryId: summary.id };
        }
        while (Date.now() < ${startAt}) {}
        consolidate()
          .then((r) => console.log(JSON.stringify({ ok: true, absorbed: r.absorbed })))
          .catch((e) => console.log(JSON.stringify({ ok: false, error: e.message })));
      `;
      const run = () => new Promise((resolve) => {
        execFile(process.execPath, ['-e', unlocked], { encoding: 'utf8' }, (error, stdout) => {
          resolve({ error, stdout: String(stdout).trim() });
        });
      });
      const outs = await Promise.all([0, 1, 2, 3].map(run));
      const parsed = outs.map((o) => {
        try { return JSON.parse(o.stdout); } catch { return { ok: false, error: o.stdout || o.error?.message }; }
      });
      let leftover = { summaries: -1, live: -1, absorbed: -1 };
      try {
        const file = JSON.parse(await fsp.readFile(filePath, 'utf8'));
        const summaries = file.records.filter((item) => item.consolidatedFrom !== undefined);
        const live = file.records.filter((item) => !item.supersededBy && !item.invalidateReason);
        leftover = {
          summaries: summaries.length,
          live: live.length,
          absorbed: summaries[0] ? summaries[0].consolidatedFrom.length : 0
        };
      } catch (error) {
        leftover = { summaries: -1, live: -1, absorbed: -1, readError: error.message };
      }
      const anyCrash = parsed.some((p) => !p.ok);
      rec(2, 'unlocked-four-process-can-go-red',
        anyCrash ? 'PASS' : 'NOTE',
        `crashHalf=${anyCrash} children=${JSON.stringify(parsed)} leftover=${JSON.stringify(leftover)}`);
      rec(2, 'unlocked-leftover-is-lww-shape',
        leftover.summaries === 1 && leftover.live === 1 && leftover.absorbed === 300 ? 'NOTE' : 'PASS',
        `leftover=${JSON.stringify(leftover)} — if this is 1/1/300, author's lost-update assertions are the LWW shape and cannot go red`);
    } finally { await rm(root); }
  }
}

async function item20() {
  // Seat cannot close another seat's open row via closeRecovery.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20a-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const stolen = await store.closeRecovery('claude', source.seq, 'done');
      const messagePath = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'messages', `${String(source.seq).padStart(4, '0')}.json`);
      // find the file
      const files = [];
      async function walk(p) {
        const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          const full = path.join(p, e.name);
          if (e.isDirectory()) await walk(full);
          else files.push(full);
        }
      }
      await walk(path.join(dir, '.ai-bus', 'runtime', 'mailbox'));
      const msgFile = files.find((f) => f.endsWith('.json') && !f.endsWith('state.json') && !f.endsWith('evidence.json'));
      const msg = JSON.parse(await fsp.readFile(msgFile, 'utf8'));
      const stillOpen = (msg.recoveryCheckpoints || []).some((c) => c.seat === 'grok' && c.status === 'open');
      rec(20, 'seat-cannot-close-foreign-row',
        stolen === undefined && stillOpen ? 'PASS' : 'FAIL',
        `stolen=${stolen && stolen.status} stillOpen=${stillOpen}`);
    } finally { await rm(dir); }
  }

  // Operator closes a stranded row; reason logged.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20b-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'node-pty vanished');
      rec(20, 'operator-close-logs-reason',
        closed && closed.status === 'closed' && /^operator-closed:/.test(closed.closeReason) && /node-pty vanished/.test(closed.closeReason) ? 'PASS' : 'FAIL',
        `reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  // Empty / whitespace reason refused; row stays open.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      let err = null;
      try { await store.operatorCloseRecovery('grok', source.seq, '   '); }
      catch (error) { err = error; }
      const recall = await store.recallAssignment('grok', source.seq);
      rec(20, 'empty-reason-refused',
        err && /reason is required/i.test(err.message) && typeof recall === 'string' ? 'PASS' : 'FAIL',
        `error=${err && err.message} recallKept=${typeof recall}`);
    } finally { await rm(dir); }
  }

  // Operator-close of an already-closed row is a no-op.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20d-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const first = await store.operatorCloseRecovery('grok', source.seq, 'first');
      const second = await store.operatorCloseRecovery('grok', source.seq, 'second');
      rec(20, 'operator-close-already-closed-noop',
        first && first.status === 'closed' && second === undefined ? 'PASS' : 'FAIL',
        `first=${first && first.closeReason} second=${second && second.closeReason}`);
    } finally { await rm(dir); }
  }

  // Ordinary runner closeRecovery still closes.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20e-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const closed = await store.closeRecovery('grok', source.seq, 'done');
      rec(20, 'runner-closeRecovery-still-closes',
        closed && closed.status === 'closed' && closed.closeReason === 'done' ? 'PASS' : 'FAIL',
        `reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  // After operator close, recallAssignment is undefined for every seat.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20f-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      await store.operatorCloseRecovery('grok', source.seq, 'stranded');
      const recalls = {};
      for (const seat of ['claude', 'grok', 'codex']) recalls[seat] = await store.recallAssignment(seat, source.seq);
      rec(20, 'recall-gone-after-operator-close',
        Object.values(recalls).every((v) => v === undefined) ? 'PASS' : 'FAIL',
        `recalls=${JSON.stringify(recalls)}`);
    } finally { await rm(dir); }
  }

  // CLI mailbox close-recovery reaches the operator path.
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-20g-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const cli = path.join(REPO, 'dist', 'mailbox.js');
      let out = '';
      let code = 0;
      try {
        out = execFileSync(process.execPath, [cli, '--root', dir, 'close-recovery', '--seat', 'grok', '--work-id', String(source.seq), '--reason', 'cli-stranded'], {
          encoding: 'utf8', stdio: 'pipe'
        });
      } catch (error) {
        code = error.status ?? 1;
        out = `${error.stdout || ''}${error.stderr || ''}`;
      }
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'should-be-already-closed');
      rec(20, 'cli-close-recovery-reaches-operator',
        code === 0 && /operator-closed: cli-stranded/.test(out) && closed === undefined ? 'PASS' : 'FAIL',
        `code=${code} out=${out.trim().slice(0, 300)} second=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  // harness.ts has no operator-close / close-recovery verb.
  {
    const harness = await fsp.readFile(path.join(REPO, 'src', 'harness.ts'), 'utf8');
    const hasVerb = /close-recovery|closeRecovery|operatorCloseRecovery|mailbox_close/.test(harness);
    rec(20, 'harness-has-no-close-recovery-verb',
      !hasVerb ? 'PASS' : 'FAIL',
      `hasVerb=${hasVerb}`);
  }
}

async function main() {
  console.log(`HEAD ${HEAD}`);
  console.log('--- item 15 ---');
  await item15();
  console.log('--- item 2 ---');
  await item2();
  console.log('--- item 20 ---');
  await item20();

  const summary = { HEAD, at: new Date().toISOString(), counts: {}, results };
  for (const row of results) {
    summary.counts[row.item] ??= { PASS: 0, FAIL: 0, NOTE: 0, SKIP: 0 };
    summary.counts[row.item][row.status] = (summary.counts[row.item][row.status] || 0) + 1;
  }
  const outPath = path.join(REPO, 'tmp-audit-r4d-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log('--- counts ---');
  console.log(JSON.stringify(summary.counts, null, 2));
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
