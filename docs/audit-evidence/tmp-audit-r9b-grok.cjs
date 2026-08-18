#!/usr/bin/env node
'use strict';
/**
 * r9b — re-attack the r9 leftovers after the untracked patch update,
 * plus the r9 NOTE cases with instruments that can actually go red.
 * Against tmp-audit-r6-patches/claim-guard-cli.js, not HEAD.
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
  const row = { name, status, detail: String(detail).slice(0, 5000) };
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
  return result.code === 1 && /OUTSIDE the staged tree|staged symlink|reference (path|types)|typeRoots|compilerOptions\.types|import /i.test(result.out);
}

function tscWorktree(repo) {
  const tsc = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  try {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', tsc, '-p', repo, '--noEmit'], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe'
    });
    return { ok: true, out: 'compile-clean' };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}${error.message}` };
  }
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
  );
}

async function seedRepo(tsconfig) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r9b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(
    path.join(repo, 'tsconfig.json'),
    JSON.stringify(tsconfig || {
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    }, null, 2)
  );
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

async function plantHiddenTypes(repo, dir) {
  const outside = path.join(dir, 'hidden-fix-pkg');
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'index.d.ts'), 'declare type HiddenFix = number;\n');
  await fsp.writeFile(path.join(outside, 'package.json'), JSON.stringify({
    name: '@types/hidden-fix',
    version: '1.0.0',
    types: 'index.d.ts'
  }));
  const atTypes = path.join(repo, 'node_modules', '@types');
  await fsp.mkdir(atTypes, { recursive: true });
  return junction(path.join(atTypes, 'hidden-fix'), outside) ? outside : null;
}

async function casePair(name, opts) {
  const fx = await seedRepo(opts.tsconfig);
  try {
    if (!await plantOwnModules(fx.repo)) {
      rec(name, 'SKIP', 'no modules');
      return;
    }
    const ready = opts.setup ? await opts.setup(fx) : true;
    if (ready === false) {
      rec(name, 'SKIP', 'setup failed');
      return;
    }
    await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), opts.source(fx));
    const control = tscWorktree(fx.repo);
    git(fx.repo, 'add', '-A');
    const result = runGuard(fx.repo, fx.busRoot);
    if (!control.ok) {
      rec(`${name}/control`, 'NOTE', `worktree tsc does not compile this spelling: ${control.out}`);
      rec(name, 'NOTE', `no red-capable control; guard code=${result.code} ${result.out}`);
      return;
    }
    rec(`${name}/control`, 'PASS', 'worktree tsc compiles via the leak');
    const status = compileOk(result) ? 'FAIL' : walkerRefused(result) ? 'PASS' : 'NOTE';
    rec(name, status, `code=${result.code}\n${result.out}`);
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  const openTypes = {
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    include: ['src']
  };
  const closedTypes = {
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  };
  const closedLib = {
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], lib: ['es2020'] },
    include: ['src']
  };

  await casePair('implicit-atypes-junction', {
    tsconfig: openTypes,
    setup: async (fx) => Boolean(await plantHiddenTypes(fx.repo, fx.dir)),
    source: () => 'export const broken: HiddenFix = 1;\n'
  });

  await casePair('compilerOptions-types-junction', {
    tsconfig: {
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: ['hidden-fix'] },
      include: ['src']
    },
    setup: async (fx) => Boolean(await plantHiddenTypes(fx.repo, fx.dir)),
    source: () => 'export const broken: HiddenFix = 1;\n'
  });

  await casePair('triple-slash-types', {
    tsconfig: closedTypes,
    setup: async (fx) => Boolean(await plantHiddenTypes(fx.repo, fx.dir)),
    source: () => '/// <reference types="hidden-fix" />\nexport const broken: HiddenFix = 1;\n'
  });

  await casePair('bare-package-junction-to-worktree', {
    tsconfig: closedTypes,
    setup: async (fx) => {
      const pkg = path.join(fx.repo, 'node_modules', 'leak-pkg');
      if (!junction(pkg, path.join(fx.repo, 'src'))) return false;
      await fsp.writeFile(path.join(fx.repo, 'src', 'good.ts'), 'export const n: number = 1;\n');
      try {
        await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
          name: 'leak-pkg', version: '1.0.0', main: 'good.ts', types: 'good.ts'
        }));
      } catch { /* junction may already expose src/package.json; fine */ }
      return true;
    },
    source: () => 'export { n as broken } from "leak-pkg";\n'
  });

  await casePair('dynamic-import-absolute', {
    tsconfig: closedLib,
    setup: async (fx) => {
      fx.hiddenDir = path.join(fx.dir, 'hidden-pkg');
      await fsp.mkdir(fx.hiddenDir, { recursive: true });
      await fsp.writeFile(path.join(fx.hiddenDir, 'index.ts'), 'export const n: number = 1;\n');
      return true;
    },
    source: (fx) => `export const broken: Promise<number> = import('${fx.hiddenDir.replace(/\\/g, '/')}').then((m) => m.n);\n`
  });

  await casePair('import-equals-require-absolute', {
    tsconfig: closedTypes,
    setup: async (fx) => {
      fx.hiddenDir = path.join(fx.dir, 'hidden-pkg');
      await fsp.mkdir(fx.hiddenDir, { recursive: true });
      await fsp.writeFile(path.join(fx.hiddenDir, 'index.ts'), 'export const n: number = 1;\n');
      return true;
    },
    source: (fx) => `import hidden = require('${fx.hiddenDir.replace(/\\/g, '/')}');\nexport const broken: number = hidden.n;\n`
  });

  // Honest green must stay green: ordinary src, declared typescript junction only.
  {
    const fx = await seedRepo(closedTypes);
    try {
      if (!await plantOwnModules(fx.repo)) rec('honest-green', 'SKIP', 'no modules');
      else {
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec('honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const outPath = path.join(REPO, 'tmp-audit-r9b-grok-out.json');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE' || r.status === 'SKIP');
  await fsp.writeFile(outPath, JSON.stringify({
    against: 'tmp-audit-r6-patches/claim-guard-cli.js (r9-updated)',
    head: '373e176',
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
