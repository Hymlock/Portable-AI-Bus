'use strict';
/**
 * AUDIT round 4g — grok, this wake. Own instrument against dist/ + scripts/claim-guard-cli.js.
 * Does not edit src/ or tests/. Does not run the author's suite as the verdict.
 * Stopping rule (adopted): VARIANT = new spelling of something the stated rule already decides.
 *                          HOLE    = the rule does not decide it, or decides it wrongly.
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

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-'));
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

function namesWorktreeFile(result, repo) {
  const abs = path.join(repo, 'src', 'index.ts');
  const posix = abs.replace(/\\/g, '/');
  const rel = path.relative(os.tmpdir(), abs).replace(/\\/g, '/');
  const out = result.out.replace(/\\/g, '/');
  return out.includes(posix) || out.includes(abs.replace(/\\/g, '/')) || out.includes(rel)
    || /src\/index\.ts/.test(out);
}

async function item15() {
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'honest-green', 'SKIP', 'no node_modules junction');
      else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green', compileOk(result) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'staged-type-error-red', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-type-error-red',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

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
        rec(15, name,
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

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
        const result = runGuard(fx.repo, fx.busRoot);
        const named = namesWorktreeFile(result, fx.repo);
        rec(15, 'bare-extends-control-worktree-broken',
          result.code === 1 && named ? 'PASS' : (result.code === 1 ? 'NOTE' : 'FAIL'),
          `code=${result.code} namesWorktree=${named} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'bare-extends-pkg-tsconfig-field', 'SKIP', 'no modules');
      else {
        const pkg = path.join(fx.repo, 'node_modules', 'leak-via-field');
        await fsp.mkdir(pkg, { recursive: true });
        await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
          name: 'leak-via-field',
          version: '1.0.0',
          tsconfig: './hidden.json'
        }));
        await fsp.writeFile(path.join(pkg, 'hidden.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: 'leak-via-field'
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'bare-extends-pkg-tsconfig-field',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
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

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) rec(15, 'paths-alias-nm-junction', 'SKIP', 'no modules');
      else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'paths-alias-nm-junction', 'SKIP', 'no junction');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: {
              strict: true, noEmit: true, skipLibCheck: true, types: [],
              baseUrl: '.',
              paths: { '@leak/*': ['node_modules/leak-src/*'] }
            },
            include: ['src']
          }, null, 2));
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
            'import { good as leaked } from "@leak/index";\nexport const broken: number = leaked;\n');
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'paths-alias-nm-junction',
            compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
            `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

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
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], typeRoots: ['node_modules/leak-types'] },
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

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'source-import-outside', 'SKIP', 'no node_modules');
      else {
        const hidden = path.join(fx.dir, 'hidden-mod.ts');
        await fsp.writeFile(hidden, 'export const hidden: number = 1;\n');
        const rel = path.relative(path.join(fx.repo, 'src'), hidden).replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `import { hidden } from "${rel}";\nexport const broken: number = hidden;\n`);
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'source-import-outside',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} import=${rel} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

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

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'empty-files-solution-style', 'SKIP', 'no node_modules');
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
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'empty-include-array', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: []
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'empty-include-array',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'FAIL',
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'include-as-string', 'SKIP', 'no node_modules');
      else {
        const abs = path.join(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: abs
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'include-as-string',
          compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE',
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

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

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) rec(15, 'tsBuildInfoFile-outside', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [], incremental: true,
            tsBuildInfoFile: path.join(os.tmpdir(), `pab-r4g-leak-${process.pid}.tsbuildinfo`).replace(/\\/g, '/')
          },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'tsBuildInfoFile-outside',
          compileOk(result) ? 'NOTE' : (refused(result) ? 'PASS' : 'FAIL'),
          `code=${result.code} compileOk=${compileOk(result)} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

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
}

async function item2() {
  async function withRoot(fn) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-e-'));
    try {
      return await fn(new EvidenceStore(root), root);
    } finally {
      await rm(root);
    }
  }

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

  await withRoot(async (store, root) => {
    const retired = await store.record({ workId: 3, subject: 'retired', statement: 'old', recordedBy: 'grok' });
    const newer = await store.record({ workId: 3, subject: 'retired', statement: 'new', recordedBy: 'grok' });
    for (const subject of ['x', 'y', 'z']) await store.record({ workId: 3, subject, statement: subject, recordedBy: 'grok' });
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

  await withRoot(async (store, root) => {
    const a = await store.record({ workId: 4, subject: 'untrusted-a', statement: 'a', recordedBy: 'grok' });
    const b = await store.record({ workId: 4, subject: 'untrusted-b', statement: 'b', recordedBy: 'grok' });
    await store.record({ workId: 4, subject: 'untrusted-c', statement: 'c', recordedBy: 'grok' });
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

  await withRoot(async (store, root) => {
    const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
    await fsp.mkdir(path.dirname(lockPath), { recursive: true });
    await fsp.writeFile(lockPath, JSON.stringify({ pid: 0, at: new Date().toISOString() }));
    const t0 = Date.now();
    let err = null;
    try {
      await store.record({ workId: 8, subject: 'pid-zero', statement: 'x', recordedBy: 'grok' });
    } catch (error) {
      err = error;
    }
    const dt = Date.now() - t0;
    rec(2, 'pid-zero-lock-recovers',
      !err && dt < 2000 ? 'PASS' : 'FAIL',
      `dtMs=${dt} error=${err && err.message}`);
  });

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-mb-'));
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

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-mb2-'));
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

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-mb3-'));
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

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-mb4-'));
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

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-rec-'));
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

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-con-'));
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
}

async function item20() {
  async function walkJson(dir) {
    const files = [];
    async function walk(p) {
      const entries = await fsp.readdir(p, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(p, e.name);
        if (e.isDirectory()) await walk(full);
        else files.push(full);
      }
    }
    await walk(dir);
    return files;
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20a-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const stolen = await store.closeRecovery('claude', source.seq, 'done');
      const files = await walkJson(path.join(dir, '.ai-bus', 'runtime', 'mailbox'));
      const msgFile = files.find((f) => f.endsWith('.json') && !f.endsWith('state.json') && !f.endsWith('evidence.json'));
      const msg = JSON.parse(await fsp.readFile(msgFile, 'utf8'));
      const stillOpen = (msg.recoveryCheckpoints || []).some((c) => c.seat === 'grok' && c.status === 'open');
      rec(20, 'seat-cannot-close-foreign-row',
        stolen === undefined && stillOpen ? 'PASS' : 'FAIL',
        `stolen=${stolen && stolen.status} stillOpen=${stillOpen}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20b-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'brain died');
      rec(20, 'operator-closes-stranded-row',
        closed && closed.status === 'closed' && /operator-closed: brain died/.test(closed.closeReason) ? 'PASS' : 'FAIL',
        `status=${closed && closed.status} reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      let err = null;
      try {
        await store.operatorCloseRecovery('grok', source.seq, '   ');
      } catch (error) {
        err = error;
      }
      const files = await walkJson(path.join(dir, '.ai-bus', 'runtime', 'mailbox'));
      const msgFile = files.find((f) => f.endsWith('.json') && !f.endsWith('state.json') && !f.endsWith('evidence.json'));
      const msg = JSON.parse(await fsp.readFile(msgFile, 'utf8'));
      const stillOpen = (msg.recoveryCheckpoints || []).some((c) => c.seat === 'grok' && c.status === 'open');
      rec(20, 'empty-reason-refused',
        err && stillOpen ? 'PASS' : 'FAIL',
        `error=${err && err.message} stillOpen=${stillOpen}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20d-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const first = await store.operatorCloseRecovery('grok', source.seq, 'once');
      const second = await store.operatorCloseRecovery('grok', source.seq, 'twice');
      rec(20, 'operator-close-already-closed-is-noop',
        first && first.status === 'closed' && second === undefined ? 'PASS' : 'FAIL',
        `first=${first && first.status} second=${second && second.status}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20e-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      const closed = await store.closeRecovery('grok', source.seq, 'settled');
      rec(20, 'ordinary-closeRecovery-still-closes',
        closed && closed.status === 'closed' ? 'PASS' : 'FAIL',
        `status=${closed && closed.status} reason=${closed && closed.closeReason}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20f-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      await store.operatorCloseRecovery('grok', source.seq, 'stranded');
      const grok = await store.recallAssignment('grok', source.seq);
      const claude = await store.recallAssignment('claude', source.seq);
      rec(20, 'recall-undefined-after-operator-close',
        grok === undefined && claude === undefined ? 'PASS' : 'FAIL',
        `grok=${grok === undefined ? 'undef' : 'SET'} claude=${claude === undefined ? 'undef' : 'SET'}`);
    } finally { await rm(dir); }
  }

  {
    const harness = await fsp.readFile(path.join(REPO, 'src', 'harness.ts'), 'utf8');
    const hasVerb = /operatorClose|close-recovery|closeRecovery/.test(harness);
    rec(20, 'harness-has-no-operator-close-verb',
      !hasVerb ? 'PASS' : 'FAIL',
      hasVerb ? 'harness.ts mentions a close-recovery verb' : 'no operator-close / close-recovery in src/harness.ts');
  }

  {
    const contract = await fsp.readFile(path.join(REPO, 'src', 'brain', 'contract.ts'), 'utf8');
    const hasVerb = /operatorClose|close-recovery/.test(contract);
    rec(20, 'brain-contract-has-no-operator-close',
      !hasVerb ? 'PASS' : 'FAIL',
      hasVerb ? 'contract.ts exposes operator close' : 'no operator-close in brain contract');
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4g-20cli-'));
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
          '--work-id', String(source.seq),
          '--reason', 'cli-stranded'
        ], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        code = error.status ?? 1;
        out = `${error.stdout || ''}${error.stderr || ''}`;
      }
      rec(20, 'cli-close-recovery-reaches-operator-path',
        code === 0 && /operator-closed: cli-stranded|closed 1/i.test(out) ? 'PASS' : 'FAIL',
        `code=${code} out=${String(out).trim().slice(0, 400)}`);
    } finally { await rm(dir); }
  }
}

(async () => {
  console.log(`HEAD=${HEAD}`);
  await item15();
  await item2();
  await item20();
  const summary = {};
  for (const row of results) {
    summary[row.item] ??= { PASS: 0, FAIL: 0, NOTE: 0, SKIP: 0 };
    summary[row.item][row.status] = (summary[row.item][row.status] || 0) + 1;
  }
  const out = { head: HEAD, summary, results };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4g-grok-out.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(summary, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
