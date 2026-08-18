'use strict';
/**
 * Independent AUDIT instrument (grok), round 4.
 * Brief #1867: 8b5ae78 (item 15), 8312282 (item 2), and item 20 if room.
 * HEAD is reported at runtime. Attacks dist/ + scripts/claim-guard-cli.js.
 * Does not edit src/ or tests/. This is not a re-run of the author's suite.
 */
const { execFileSync, execFile, spawn } = require('node:child_process');
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
    return false;
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
  await fsp.writeFile(path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'packages' }] } }));
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-'));
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
  await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
    name: packageName,
    version: '1.0.0'
  }));
  await fsp.writeFile(path.join(pkg, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: [includePath.replace(/\\/g, '/')]
  }, null, 2));
}

function liveOf(records) {
  return records.filter((item) => !item.supersededBy && !item.invalidateReason);
}

async function attack15() {
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'honest-green', 'SKIP', 'could not link node_modules');
      } else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green', result.code === 0 && /compile OK \(staged index\)/.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim()}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'staged-type-error-red', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
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
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'absolute-include-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'absolute-include-refused',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'untracked-extends-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.worktree-only.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/ok.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: path.join(fx.repo, 'tsconfig.worktree-only.json').replace(/\\/g, '/')
        }, null, 2));
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'untracked-extends-refused',
          result.code === 1 && /OUTSIDE the staged tree|extends/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'hatch-is-loud', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot, { BUS_ALLOW_BROKEN_BUILD: '1' });
        rec(15, 'hatch-is-loud',
          result.code === 0 && /SKIPPED/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 400)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'paths-absolute-worktree-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [],
            baseUrl: '.',
            paths: { '@src/*': [path.join(fx.repo, 'src', '*').replace(/\\/g, '/')] }
          },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'paths-absolute-worktree-refused',
          result.code === 1 && /OUTSIDE the staged tree|paths/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'references-absolute-worktree-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
          files: [],
          references: [{ path: path.join(fx.repo, 'src').replace(/\\/g, '/') }]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'references-absolute-worktree-refused',
          result.code === 1 && /OUTSIDE the staged tree|references/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'rootDirs-absolute-worktree-refused', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [],
            rootDirs: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
          },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'rootDirs-absolute-worktree-refused',
          result.code === 1 && /OUTSIDE the staged tree|rootDirs/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 500)}`);
      }
    } finally { await rm(fx.dir); }
  }

  async function bareExtends(name, extendsValue, restoreWorktree) {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, name, 'SKIP', 'could not plant own node_modules');
        return;
      }
      await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: extendsValue
      }, null, 2));
      git(fx.repo, 'add', '-A');
      if (restoreWorktree) {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      }
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, name,
        result.code === 1 ? 'PASS' : 'FAIL',
        `code=${result.code} out=${result.out.trim().slice(0, 800)}`);
    } finally { await rm(fx.dir); }
  }

  await bareExtends('bare-extends-package-file', 'leak-config/tsconfig.json', true);
  await bareExtends('bare-extends-array', ['leak-config/tsconfig.json'], true);
  await bareExtends('bare-extends-package-name', 'leak-config', true);
  await bareExtends('bare-extends-control-worktree-also-broken', 'leak-config/tsconfig.json', false);

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, 'relative-extends-same-package', 'SKIP', 'could not plant own node_modules');
      } else {
        await plantLeakConfig(fx.repo, path.join(fx.repo, 'src'));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          extends: './node_modules/leak-config/tsconfig.json'
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-extends-same-package',
          result.code === 1 && /OUTSIDE the staged tree|include/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await plantOwnModules(fx.repo)) {
        rec(15, 'node-modules-junction-include', 'SKIP', 'could not plant own node_modules');
      } else {
        const leakSrc = path.join(fx.repo, 'node_modules', 'leak-src');
        if (!junction(leakSrc, path.join(fx.repo, 'src'))) {
          rec(15, 'node-modules-junction-include', 'SKIP', 'could not junction leak-src');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['node_modules/leak-src']
          }, null, 2));
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'node-modules-junction-include',
            result.code === 1 ? 'PASS' : 'FAIL',
            `code=${result.code} out=${result.out.trim().slice(0, 700)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'source-import-absolute-worktree', 'SKIP', 'could not link node_modules');
      } else {
        const helper = path.join(fx.repo, 'outside-helper.ts');
        await fsp.writeFile(helper, 'export const n: number = 1;\n');
        const importPath = helper.replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `import { n } from ${JSON.stringify(importPath)};\nexport const x: number = n;\n`);
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'source-import-absolute-worktree',
          result.code === 1 ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 700)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'triple-slash-absolute-worktree', 'SKIP', 'could not link node_modules');
      } else {
        const helper = path.join(fx.repo, 'outside-ref.d.ts');
        await fsp.writeFile(helper, 'export {};\n');
        const refPath = helper.replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path=${JSON.stringify(refPath)} />\nexport const good: number = 1;\n`);
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-absolute-worktree',
          result.code === 1 ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 700)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'staged-symlink-file-pointing-out', 'SKIP', 'could not link node_modules');
      } else {
        const outside = path.join(fx.dir, 'honest-outside.ts');
        await fsp.writeFile(outside, 'export const good: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        await fsp.unlink(path.join(fx.repo, 'src', 'index.ts'));
        if (!fileSymlink(path.join(fx.repo, 'src', 'index.ts'), outside)) {
          rec(15, 'staged-symlink-file-pointing-out', 'SKIP', 'could not create file symlink');
        } else {
          git(fx.repo, 'add', '-A');
          const result = runGuard(fx.repo, fx.busRoot);
          rec(15, 'staged-symlink-file-pointing-out',
            result.code === 1 ? 'PASS' : 'FAIL',
            `code=${result.code} out=${result.out.trim().slice(0, 700)}`);
        }
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'subdir-tsconfig-not-auto-picked', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.mkdir(path.join(fx.repo, 'packages', 'foo'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'packages', 'foo', 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [path.join(fx.repo, 'src').replace(/\\/g, '/')]
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'subdir-tsconfig-not-auto-picked',
          result.code === 1 && /TS2322|does not compile/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 600)} (root include still typechecks staged src; subdir config must not hide it)`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'staged-node-modules-fail-closed', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.mkdir(path.join(fx.repo, 'dummy-nm', 'pkg'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'dummy-nm', 'pkg', 'package.json'), '{"name":"pkg"}\n');
        git(fx.repo, 'add', '-A');
        git(fx.repo, 'add', '-f', 'dummy-nm');
        // Force a staged top-level node_modules directory into the index.
        const stagedNm = path.join(fx.repo, 'node_modules_staged');
        await fsp.mkdir(path.join(stagedNm, 'pkg'), { recursive: true });
        await fsp.writeFile(path.join(stagedNm, 'pkg', 'index.js'), 'module.exports = 1;\n');
        execFileSync('git', ['add', '-f', '--', 'node_modules_staged'], { cwd: fx.repo, stdio: 'pipe' });
        // Rename in the index via a second tree: stage a real node_modules file after unlinking the junction.
        try {
          fs.rmSync(path.join(fx.repo, 'node_modules'), { recursive: true, force: true });
        } catch { /* junction may refuse rm; try rmdir */ }
        try { fs.unlinkSync(path.join(fx.repo, 'node_modules')); } catch { /* */ }
        await fsp.mkdir(path.join(fx.repo, 'node_modules', 'pkg'), { recursive: true });
        await fsp.writeFile(path.join(fx.repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
        execFileSync('git', ['add', '-f', '--', 'node_modules/pkg/index.js'], { cwd: fx.repo, stdio: 'pipe' });
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'staged-node-modules-fail-closed',
          result.code === 1 ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 700)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'nocheck-lands-type-error', 'SKIP', 'could not link node_modules');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'nocheck-lands-type-error',
          result.code === 0 && /noCheck/i.test(result.out) ? 'NOTE' : (result.code === 1 ? 'PASS' : 'FAIL'),
          `code=${result.code} out=${result.out.trim().slice(0, 500)} (declared consequence if green+logged)`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'tsBuildInfoFile-outside', 'SKIP', 'could not link node_modules');
      } else {
        const outsideInfo = path.join(fx.dir, 'leak.tsbuildinfo').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [],
            incremental: true,
            tsBuildInfoFile: outsideInfo
          },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        const leaked = fs.existsSync(path.join(fx.dir, 'leak.tsbuildinfo'));
        rec(15, 'tsBuildInfoFile-outside',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : (leaked ? 'FAIL' : 'NOTE'),
          `code=${result.code} leakedTsbuildinfo=${leaked} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }
}

async function attack2() {
  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2-'));
    try {
      const store = new EvidenceStore(root);
      for (let i = 0; i < 3; i += 1) {
        await store.record({ workId: 42, subject: `step-${i}`, statement: `did ${i}`, recordedBy: 'grok' });
      }
      const { summary, absorbed } = await store.consolidate(42, 'grok');
      await store.invalidate(summary.id, 'the rollup mangled the wording');
      const live = liveOf(await store.list(42));
      rec(2, 'invalidate-restores-episodes',
        absorbed === 3 && live.length === 3 && live.every((item) => /^step-/.test(item.subject)) ? 'PASS' : 'FAIL',
        `absorbed=${absorbed} live=${live.map((i) => i.subject).join(',')}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2b-'));
    try {
      const store = new EvidenceStore(root);
      for (let i = 0; i < 3; i += 1) {
        await store.record({ workId: 42, subject: `a-${i}`, statement: `A${i}`, recordedBy: 'grok' });
      }
      const s1 = await store.consolidate(42, 'grok');
      for (let i = 0; i < 3; i += 1) {
        await store.record({ workId: 42, subject: `b-${i}`, statement: `B${i}`, recordedBy: 'grok' });
      }
      const s2 = await store.consolidate(42, 'grok');
      await store.invalidate(s2.summary.id, 'second rollup bad');
      const afterS2 = liveOf(await store.list(42));
      const afterS2Subjects = afterS2.map((i) => i.subject).sort();
      const s2RestoredOnlyB = afterS2Subjects.includes('b-0') && afterS2Subjects.includes('consolidated: work #42')
        && !afterS2Subjects.includes('a-0');
      await store.invalidate(s1.summary.id, 'first rollup bad');
      const afterS1 = liveOf(await store.list(42));
      const afterS1Subjects = afterS1.map((i) => i.subject).sort();
      const bothRestored = ['a-0', 'a-1', 'a-2', 'b-0', 'b-1', 'b-2'].every((s) => afterS1Subjects.includes(s))
        && !afterS1.some((i) => i.consolidatedFrom);
      rec(2, 'two-summaries-over-time',
        s2RestoredOnlyB && bothRestored ? 'PASS' : 'FAIL',
        `afterS2=${afterS2Subjects.join(',')} afterS1=${afterS1Subjects.join(',')}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2c-'));
    try {
      const store = new EvidenceStore(root);
      const a1 = await store.record({ workId: 7, subject: 'fact', statement: 'old', recordedBy: 'grok' });
      const a2 = await store.record({ workId: 7, subject: 'fact', statement: 'new', recordedBy: 'grok' });
      const b = await store.record({ workId: 7, subject: 'other', statement: 'b', recordedBy: 'grok' });
      const c = await store.record({ workId: 7, subject: 'third', statement: 'c', recordedBy: 'grok' });
      // Hand-supersede a1 by a2 before absorption (promote needs a minted observation).
      const filePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
      const file = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      const recA1 = file.records.find((item) => item.id === a1.id);
      recA1.supersededBy = a2.id;
      recA1.updatedAt = new Date().toISOString();
      await fsp.writeFile(filePath, JSON.stringify(file, null, 2));
      const { summary } = await store.consolidate(7, 'grok');
      const absorbedIds = new Set(summary.consolidatedFrom);
      await store.invalidate(summary.id, 'bad');
      const all = await store.list(7);
      const a1After = all.find((item) => item.id === a1.id);
      const live = liveOf(all);
      const liveIds = new Set(live.map((item) => item.id));
      rec(2, 'already-superseded-before-absorption',
        !absorbedIds.has(a1.id) && a1After.supersededBy === a2.id && liveIds.has(a2.id)
          && liveIds.has(b.id) && liveIds.has(c.id) && !liveIds.has(a1.id) ? 'PASS' : 'FAIL',
        `absorbedA1=${absorbedIds.has(a1.id)} a1.supersededBy=${a1After.supersededBy} live=${live.map((i) => i.subject).join(',')}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2d-'));
    try {
      const store = new EvidenceStore(root);
      const filePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
      const now = new Date().toISOString();
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      const verified = {
        id: 'v1', workId: 3, subject: 'verified-fact', statement: 'seen',
        trust: 'verified', recordedBy: 'grok', sourceEventId: 1, createdAt: now, updatedAt: now
      };
      const untrusted = {
        id: 'u1', workId: 3, subject: 'claim', statement: 'maybe',
        trust: 'untrusted', recordedBy: 'grok', sourceEventId: 2, createdAt: now, updatedAt: now
      };
      const extra = {
        id: 'u2', workId: 3, subject: 'claim-2', statement: 'also',
        trust: 'untrusted', recordedBy: 'grok', sourceEventId: 3, createdAt: now, updatedAt: now
      };
      await fsp.writeFile(filePath, JSON.stringify({ schema: 1, nextEventId: 4, records: [verified, untrusted, extra] }, null, 2));
      const { summary } = await store.consolidate(3, 'grok');
      const summaryTrust = summary.trust;
      await store.invalidate(summary.id, 'bad rollup');
      const all = await store.list(3);
      const v = all.find((item) => item.id === 'v1');
      const u = all.find((item) => item.id === 'u1');
      rec(2, 'restore-keeps-own-trust-and-does-not-launder',
        summaryTrust === 'untrusted' && v.trust === 'verified' && u.trust === 'untrusted'
          && !v.supersededBy && !u.supersededBy ? 'PASS' : 'FAIL',
        `summary.trust=${summaryTrust} v.trust=${v.trust} u.trust=${u.trust}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2e-'));
    try {
      const store = new EvidenceStore(root);
      for (let i = 0; i < 3; i += 1) {
        await store.record({ workId: 1, subject: `s${i}`, statement: 'x', recordedBy: 'grok' });
      }
      const s1 = await store.consolidate(1, 'grok');
      await store.invalidate(s1.summary.id, 'first reject');
      const s2 = await store.consolidate(1, 'grok');
      await store.invalidate(s1.summary.id, 'second reject of old summary');
      const all = await store.list(1);
      const live = liveOf(all);
      const stolen = live.filter((item) => item.consolidatedFrom === undefined).length === 3
        && live.some((item) => item.id === s2.summary.id) === false;
      // After re-absorption, S2 should still hold them. Re-invalidating S1 must not steal.
      const s2StillHolds = live.length === 1 && live[0].id === s2.summary.id;
      rec(2, 'reinvalidate-old-summary-does-not-steal',
        s2StillHolds && !stolen ? 'PASS' : 'FAIL',
        `live=${live.map((i) => `${i.subject}:${i.id.slice(0, 8)}`).join(',')} stolen=${stolen}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2lock-'));
    try {
      const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      const child = spawn(process.execPath, ['-e', `
        const fs = require('fs');
        const lock = ${JSON.stringify(lockPath)};
        fs.mkdirSync(require('path').dirname(lock), { recursive: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        fs.writeSync(1, 'READY\\n');
        setInterval(() => {}, 1e9);
      `], { stdio: ['ignore', 'pipe', 'pipe'] });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('child never said READY')), 5000);
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('READY')) { clearTimeout(t); resolve(); }
        });
        child.on('error', reject);
      });
      const deadPid = child.pid;
      child.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
      const store = new EvidenceStore(root);
      const started = Date.now();
      const record = await store.record({ workId: 9, subject: 'after-kill', statement: 'ok', recordedBy: 'grok' });
      const elapsed = Date.now() - started;
      rec(2, 'dead-owner-lock-recovers',
        record && elapsed < 3000 ? 'PASS' : 'FAIL',
        `elapsedMs=${elapsed} pidWas=${deadPid} id=${record.id}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2empty-'));
    try {
      const lockPath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
      await fsp.mkdir(path.dirname(lockPath), { recursive: true });
      await fsp.writeFile(lockPath, '');
      const store = new EvidenceStore(root);
      const started = Date.now();
      let error = null;
      try {
        await store.record({ workId: 9, subject: 'empty-lock', statement: 'x', recordedBy: 'grok' });
      } catch (e) {
        error = e;
      }
      const elapsed = Date.now() - started;
      const recoveredFast = !error && elapsed < 3000;
      const timedOut = error && /Timed out waiting for the evidence lock/i.test(error.message) && elapsed >= 9000;
      rec(2, 'empty-lock-file-recovery',
        recoveredFast ? 'PASS' : (timedOut ? 'FAIL' : 'FAIL'),
        `elapsedMs=${elapsed} error=${error ? error.message : 'none'} (empty lock has no owner; treating it as live waits the full timeout)`);
    } finally { await rm(root); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2close-'));
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
      const summary = records.find((item) => item.consolidatedFrom !== undefined);
      const open = await store.openRecoveryFor('grok');
      rec(2, 'closeRecovery-compacts',
        summary && summary.consolidatedFrom.length === 3 && !open ? 'PASS' : 'FAIL',
        `summary=${summary ? summary.id : 'none'} stillOpen=${Boolean(open)}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2throw-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      const evidencePath = path.join(dir, '.ai-bus', 'runtime', 'mailbox', 'evidence.json');
      await fsp.writeFile(evidencePath, 'NOT-JSON');
      const closed = await store.closeRecovery('grok', source.seq, 'done even if compact throws');
      const still = await store.openRecoveryFor('grok');
      rec(2, 'closeRecovery-survives-consolidate-throw',
        closed && closed.status === 'closed' && !still ? 'PASS' : 'FAIL',
        `closed=${closed && closed.status} stillOpen=${Boolean(still)}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2op-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      await store.operatorCloseRecovery('grok', source.seq, 'seat died');
      const records = await store.listEvidence(source.seq);
      const summary = records.find((item) => item.consolidatedFrom !== undefined);
      const live = liveOf(records);
      rec(2, 'operatorClose-does-not-consolidate',
        !summary && live.length === 3 ? 'FAIL' : (summary ? 'PASS' : 'FAIL'),
        `summaries=${summary ? 1 : 0} live=${live.length} (assignment ended via operator close; item 2 said compact on CLOSE)`);
    } finally { await rm(dir); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2proc-'));
    try {
      const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'evidence.json'),
        JSON.stringify({ schema: 1, nextEventId: 1, records: [] }, null, 2));
      const startAt = Date.now() + 1500;
      const script = (seat, n) => `
        const { EvidenceStore } = require(${JSON.stringify(path.join(REPO, 'dist', 'evidence.js'))});
        while (Date.now() < ${startAt}) {}
        new EvidenceStore(${JSON.stringify(root)}).record({
          workId: 5, subject: ${JSON.stringify(`p-${seat}`)}, statement: ${JSON.stringify(`from ${seat} ${n}`)}, recordedBy: ${JSON.stringify(seat)}
        }).then((r) => { console.log(JSON.stringify({ ok: true, id: r.id, sourceEventId: r.sourceEventId, subject: r.subject })); })
          .catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); });
      `;
      const run = (seat, n) => new Promise((resolve) => {
        execFile(process.execPath, ['-e', script(seat, n)], { encoding: 'utf8' },
          (error, stdout) => resolve({ error, stdout: stdout.trim() }));
      });
      const seats = ['grok', 'codex', 'claude', 'worker'];
      const results4 = await Promise.all(seats.map((s, i) => run(s, i)));
      const parsed = results4.map((r) => {
        try { return JSON.parse(r.stdout); } catch { return { ok: false, error: r.stdout || r.error?.message }; }
      });
      const store = new EvidenceStore(root);
      const all = await store.list(5);
      const ids = new Set(all.map((r) => r.sourceEventId));
      const subjects = all.map((r) => r.subject).sort();
      rec(2, 'four-process-concurrent-record',
        parsed.every((p) => p.ok) && all.length === 4 && ids.size === 4 ? 'PASS' : 'FAIL',
        `childOk=${parsed.map((p) => p.ok).join(',')} n=${all.length} eventIds=${[...ids].sort((a, b) => a - b).join(',')} subjects=${subjects.join(',')}`);
    } finally { await rm(root); }
  }

  {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i2cons-'));
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
          .then((r) => { console.log(JSON.stringify({ ok: true, absorbed: r.absorbed, reason: r.reason || null, id: r.summary && r.summary.id })); })
          .catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); });
      `;
      const run = (seat) => new Promise((resolve) => {
        execFile(process.execPath, ['-e', script(seat)], { encoding: 'utf8' },
          (error, stdout) => resolve({ error, stdout: stdout.trim() }));
      });
      const childResults = await Promise.all(['grok', 'codex', 'claude', 'worker'].map(run));
      const parsed = childResults.map((r) => {
        try { return JSON.parse(r.stdout); } catch { return { ok: false, error: r.stdout || r.error?.message }; }
      });
      const store = new EvidenceStore(root);
      const all = await store.list(42);
      const summaries = all.filter((item) => item.consolidatedFrom !== undefined);
      const live = liveOf(all);
      const crashed = parsed.some((p) => !p.ok);
      const absorbedCounts = parsed.map((p) => p.absorbed);
      rec(2, 'four-process-concurrent-consolidate',
        !crashed && summaries.length === 1 && live.length === 1 && summaries[0].consolidatedFrom.length === 300 ? 'PASS' : 'FAIL',
        `crashed=${crashed} absorbed=${absorbedCounts.join(',')} summaries=${summaries.length} live=${live.length} NOTE: last-write-wins without a lock also yields 1 summary of 300; this gate cannot go red on a silent lost update.`);
    } finally { await rm(root); }
  }

  rec(2, 'author-consolidate-gate-cannot-see-lost-update', 'NOTE',
    'tests/audit-round2.test.js four-process consolidate asserts: no crash, exactly 1 summary, 300 absorbed, 1 live. Last writer winning on unlocked code produces the same shape. The EPERM crash is the only red it can show. Concurrent RECORD (above) is the lost-update instrument.');
}

async function attack20() {
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i20-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'implement item 9', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'ONE ACTION: implement item 9');
      const stolen = await store.closeRecovery('codex', source.seq, 'not mine');
      const still = await store.openRecoveryFor('grok');
      rec(20, 'seat-cannot-close-anothers',
        stolen === undefined && still && still.status === 'open' ? 'PASS' : 'FAIL',
        `stolen=${stolen && stolen.status} still=${still && still.status}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i20b-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'implement item 9', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'ONE ACTION: implement item 9');
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'item 9 certified hours ago');
      const still = await store.openRecoveryFor('grok');
      const recall = await store.recallAssignment('grok', source.seq);
      rec(20, 'operator-closes-stranded',
        closed && closed.status === 'closed' && /^operator-closed: /.test(closed.closeReason)
          && !still && recall === undefined ? 'PASS' : 'FAIL',
        `status=${closed && closed.status} reason=${closed && closed.closeReason} still=${Boolean(still)} recall=${recall ? 'yes' : 'no'}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i20c-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'half done');
      let refused = false;
      try {
        await store.operatorCloseRecovery('grok', source.seq, '  ');
      } catch (error) {
        refused = /reason is required/i.test(error.message);
      }
      const still = await store.openRecoveryFor('grok');
      rec(20, 'operator-empty-reason-refused',
        refused && still && still.status === 'open' ? 'PASS' : 'FAIL',
        `refused=${refused} still=${still && still.status}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i20d-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      await store.closeRecovery('grok', source.seq, 'finished by runner');
      const again = await store.operatorCloseRecovery('grok', source.seq, 'operator late');
      rec(20, 'operator-close-already-closed-is-noop',
        again === undefined ? 'PASS' : 'FAIL',
        `again=${again && again.status}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i20e-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      await store.closeRecovery('grok', source.seq, 'ordinary runner close');
      const still = await store.openRecoveryFor('grok');
      rec(20, 'ordinary-runner-close-unchanged',
        !still ? 'PASS' : 'FAIL',
        `stillOpen=${Boolean(still)}`);
    } finally { await rm(dir); }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4-i20cli-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'stranded');
      const cli = path.join(REPO, 'dist', 'mailbox.js');
      let out = '';
      let code = 0;
      try {
        out = execFileSync(process.execPath, [cli, 'close-recovery', '--root', dir, '--seat', 'grok',
          '--work-id', String(source.seq), '--reason', 'operator from CLI'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        code = error.status ?? 1;
        out = `${error.stdout || ''}${error.stderr || ''}`;
      }
      const still = await store.openRecoveryFor('grok');
      rec(20, 'cli-close-recovery-reaches-operator-path',
        code === 0 && /operator-closed:/.test(out) && !still ? 'PASS' : 'FAIL',
        `code=${code} still=${Boolean(still)} out=${out.trim().slice(0, 400)}`);
    } finally { await rm(dir); }
  }
}

function classify() {
  const byItem = (n) => results.filter((r) => r.item === n);
  const fails = (n) => byItem(n).filter((r) => r.status === 'FAIL');
  const passes = (n) => byItem(n).filter((r) => r.status === 'PASS');
  const notes = (n) => byItem(n).filter((r) => r.status === 'NOTE');
  return { byItem, fails, passes, notes };
}

function renderReport() {
  const { fails, passes, notes } = classify();
  const lines = [];
  lines.push(`AUDIT round 4. Brief named 8b5ae78 (item 15) and 8312282 (item 2); item 20 taken because there was room.`);
  lines.push(`HEAD here is ${HEAD}.`);
  lines.push(`I read src/ and attacked dist/ + scripts/claim-guard-cli.js.`);
  lines.push(`I did not edit src/ or tests/.`);
  lines.push(`Instrument: tmp-audit-r4-grok.cjs (this session, own, not the author's suite).`);
  lines.push('');
  lines.push(`Counts: 15 ${passes(15).length}P/${fails(15).length}F/${notes(15).length}N; 2 ${passes(2).length}P/${fails(2).length}F/${notes(2).length}N; 20 ${passes(20).length}P/${fails(20).length}F/${notes(20).length}N.`);
  lines.push('');

  const dump = (item) => {
    for (const row of results.filter((r) => r.item === item)) {
      lines.push(`  [${row.status}] ${row.name}: ${row.detail.split('\n')[0]}`);
    }
  };

  lines.push('============================================================');
  lines.push('ITEM 15');
  lines.push('============================================================');
  dump(15);
  lines.push('');
  lines.push('============================================================');
  lines.push('ITEM 2');
  lines.push('============================================================');
  dump(2);
  lines.push('');
  lines.push('============================================================');
  lines.push('ITEM 20');
  lines.push('============================================================');
  dump(20);
  return lines.join('\n');
}

async function main() {
  console.log(`HEAD ${HEAD}`);
  await attack15();
  await attack2();
  await attack20();
  const report = renderReport();
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4-grok-out.json'), JSON.stringify({ head: HEAD, results }, null, 2));
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4-grok-report.txt'), report);
  console.log('\n--- summary ---');
  console.log(report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
