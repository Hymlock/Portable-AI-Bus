#!/usr/bin/env node
'use strict';
/**
 * r10 — leftover resolution surfaces against the r9-updated r6 PATCH, not HEAD.
 * Own instrument. A case that cannot go red is NOTE, not PASS.
 *
 * Question: can tsc load a file outside scratch and outside repo node_modules
 * while the walker still prints compile OK? The r9 walker never reads
 * package.json types/exports/imports or jsxImportSource, and listFilesOnly
 * is only used to reject an empty program.
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
  return result.code === 1 && /OUTSIDE the staged tree|staged symlink|reference path|noCheck|empty success|compiled no program|compiled files outside/i.test(result.out);
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

function tscList(repo) {
  const tsc = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  try {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', tsc, '-p', repo, '--listFilesOnly'], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe'
    });
  } catch (error) {
    return `${error.stdout || ''}${error.stderr || ''}`;
  }
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'package.json' }] } })
  );
}

async function seedRepo(tsconfig) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r10-'));
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

async function writeOutsideDts(dir, name, body) {
  const outside = path.join(dir, name);
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(outside, 'index.d.ts'), body || 'export declare const n: number;\ndeclare type HiddenFix = number;\n');
  await fsp.writeFile(path.join(outside, 'index.ts'), 'export const n: number = 1;\n');
  return outside;
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
    await fsp.writeFile(path.join(fx.repo, 'src', opts.sourceName || 'index.ts'), opts.source(fx));
    const control = tscWorktree(fx.repo);
    const listed = control.ok ? tscList(fx.repo) : '';
    git(fx.repo, 'add', '-A');
    const result = runGuard(fx.repo, fx.busRoot);
    if (!control.ok) {
      rec(`${name}/control`, 'NOTE', `worktree tsc does not compile this spelling: ${control.out}`);
      rec(name, 'NOTE', `no red-capable control; guard code=${result.code} ${result.out}`);
      return;
    }
    rec(`${name}/control`, 'PASS', `worktree tsc compiles via the leak; list has ${listed.split(/\r?\n/).filter(Boolean).length} files`);
    const status = compileOk(result) ? 'FAIL' : walkerRefused(result) ? 'PASS' : 'NOTE';
    rec(name, status, `code=${result.code}\n${result.out}`);
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  const closedTypes = {
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  };

  await casePair('pkgjson-types-absolute', {
    tsconfig: closedTypes,
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-fix-pkg');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-types',
        version: '1.0.0',
        types: path.join(fx.outside, 'index.d.ts').replace(/\\/g, '/')
      }));
      return true;
    },
    source: () => 'import "leak-types";\nexport const broken: HiddenFix = 1;\n'
  });

  await casePair('pkgjson-exports-types-absolute', {
    tsconfig: {
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'nodenext', moduleResolution: 'nodenext'
      },
      include: ['src']
    },
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-exports-pkg');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-exports');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-exports',
        version: '1.0.0',
        exports: {
          '.': {
            types: path.join(fx.outside, 'index.d.ts').replace(/\\/g, '/'),
            default: path.join(fx.outside, 'index.d.ts').replace(/\\/g, '/')
          }
        }
      }));
      return true;
    },
    source: () => 'import { n } from "leak-exports";\nexport const broken: number = n;\n'
  });

  await casePair('pkgjson-imports-hash', {
    tsconfig: {
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'nodenext', moduleResolution: 'nodenext'
      },
      include: ['src']
    },
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-imports-pkg');
      const abs = path.join(fx.outside, 'index.d.ts').replace(/\\/g, '/');
      await fsp.writeFile(path.join(fx.repo, 'package.json'), JSON.stringify({
        name: 'fixture',
        type: 'module',
        imports: {
          '#hidden': {
            types: abs,
            default: abs
          }
        }
      }));
      return true;
    },
    source: () => 'import { n } from "#hidden";\nexport const broken: number = n;\n'
  });

  await casePair('jsx-import-source', {
    tsconfig: {
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        jsx: 'react-jsx',
        jsxImportSource: 'leak-jsx'
      },
      include: ['src']
    },
    setup: async (fx) => {
      const jsx = path.join(fx.repo, 'node_modules', 'leak-jsx');
      await fsp.mkdir(jsx, { recursive: true });
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-jsx', [
        'export namespace JSX { export interface Element { k: number } export interface IntrinsicElements { div: {} } }',
        'export function jsx(type: unknown, props: unknown): { k: number };',
        'export function jsxs(type: unknown, props: unknown): { k: number };',
        'export function jsxDEV(type: unknown, props: unknown): { k: number };',
        'declare type HiddenFix = number;',
        ''
      ].join('\n'));
      await fsp.writeFile(path.join(jsx, 'package.json'), JSON.stringify({
        name: 'leak-jsx',
        version: '1.0.0',
        types: path.join(fx.outside, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(path.join(jsx, 'jsx-runtime.d.ts'), [
        'export namespace JSX { export interface Element { k: number } export interface IntrinsicElements { div: {} } }',
        'export function jsx(type: unknown, props: unknown): { k: number };',
        'export function jsxs(type: unknown, props: unknown): { k: number };',
        'declare type HiddenFix = number;',
        ''
      ].join('\n'));
      await fsp.writeFile(path.join(jsx, 'jsx-runtime.js'), 'module.exports = {};\n');
      return true;
    },
    sourceName: 'index.tsx',
    source: () => 'export const el = <div />;\nexport const broken: HiddenFix = 1;\n'
  });

  await casePair('allowjs-absolute-import', {
    tsconfig: {
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        allowJs: true, checkJs: true, maxNodeModuleJsDepth: 0
      },
      include: ['src']
    },
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-js-pkg');
      return true;
    },
    sourceName: 'index.js',
    source: (fx) => {
      const spec = path.join(fx.outside, 'index.ts').replace(/\\/g, '/');
      return `import { n } from "${spec}";\nexport const broken = n;\n`;
    }
  });

  await casePair('amd-dependency', {
    tsconfig: closedTypes,
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-amd');
      return true;
    },
    source: (fx) => {
      const spec = path.join(fx.outside, 'index.d.ts').replace(/\\/g, '/');
      return `/// <amd-dependency path="${spec}" />\nexport const broken: HiddenFix = 1;\n`;
    }
  });

  await casePair('export-star-absolute', {
    tsconfig: closedTypes,
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-star');
      return true;
    },
    source: (fx) => {
      const spec = path.join(fx.outside).replace(/\\/g, '/');
      return `export * from "${spec}";\nexport const broken: number = 1;\n`;
    }
  });

  await casePair('paths-alias-outside', {
    tsconfig: {
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        baseUrl: '.',
        paths: { '@hidden': ['PLACEHOLDER'] }
      },
      include: ['src']
    },
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-paths');
      const cfg = {
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          baseUrl: '.',
          paths: { '@hidden': [path.join(fx.outside).replace(/\\/g, '/')] }
        },
        include: ['src']
      };
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify(cfg, null, 2));
      return true;
    },
    source: () => 'import { n } from "@hidden";\nexport const broken: number = n;\n'
  });

  await casePair('baseUrl-outside', {
    tsconfig: closedTypes,
    setup: async (fx) => {
      fx.outside = await writeOutsideDts(fx.dir, 'hidden-base');
      const cfg = {
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          baseUrl: path.join(fx.outside).replace(/\\/g, '/')
        },
        include: ['src']
      };
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify(cfg, null, 2));
      return true;
    },
    source: () => 'export const broken: HiddenFix = 1;\n'
  });

  // Honest green must stay green.
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

  const outPath = path.join(REPO, 'tmp-audit-r10-grok-out.json');
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
