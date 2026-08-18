#!/usr/bin/env node
'use strict';
/**
 * r11 — new attacks against the r10-updated untracked patch.
 * Not HEAD. Not a re-run of r10c.
 *
 * Target: classifyListedFiles exempts any realpath containing '/node_modules/',
 * plus typings, empty compile, noCheck, exports.types, and honest-green.
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|jsxImportSource/i.test(result.out);
}

function tsc(repo, args) {
  const bin = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  try {
    return { ok: true, out: execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', bin, ...args], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe'
    }) };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}${error.message}` };
  }
}

function listedOutside(listText, needle) {
  const n = String(needle).replace(/\\/g, '/').toLowerCase();
  return String(listText).split(/\r?\n/).map((s) => s.trim()).filter((f) => f.replace(/\\/g, '/').toLowerCase().includes(n));
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'package.json' }] } })
  );
}

async function seed(tsconfig) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r11-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
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
  return { dir, repo, busRoot };
}

async function attackPkgTypes(name, typesPathBuilder) {
  const fx = await seed({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  });
  try {
    const outsideDir = typesPathBuilder(fx.dir);
    await fsp.mkdir(outsideDir, { recursive: true });
    await fsp.writeFile(path.join(outsideDir, 'index.d.ts'), 'export declare const n: number;\n');
    const typesAbs = path.join(outsideDir, 'index.d.ts').replace(/\\/g, '/');
    const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
    await fsp.mkdir(pkg, { recursive: true });
    await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
      name: 'leak-types', version: '1.0.0', types: typesAbs
    }));
    await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
      'import { n } from "leak-types";\nexport const broken: number = n;\n');
    const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
    const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
    const leaks = listedOutside(listed.out, path.basename(outsideDir));
    git(fx.repo, 'add', '-A');
    const result = runGuard(fx.repo, fx.busRoot);
    if (!compiled.ok) {
      rec(`${name}/control`, 'NOTE', compiled.out);
      rec(name, 'NOTE', `not red-capable; guard code=${result.code}\n${result.out}`);
      return;
    }
    rec(`${name}/control`, leaks.length ? 'PASS' : 'NOTE',
      `tsc ok; outside listed=${JSON.stringify(leaks)}`);
    const status = !leaks.length ? 'NOTE'
      : compileOk(result) ? 'FAIL'
      : refused(result) ? 'PASS' : 'NOTE';
    rec(name, status, `code=${result.code}\n${result.out}`);
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  // 1. package.json types -> outside path that CONTAINS /node_modules/
  //    classifyListedFiles skips any realpath with that substring.
  await attackPkgTypes('nm-substring-types', (dir) => path.join(dir, 'smuggle', 'node_modules', 'hidden-fix'));

  // 2. package.json "typings" (legacy alias of types) -> ordinary outside path
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-typings-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-typings');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-typings', version: '1.0.0',
        typings: path.join(outside, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-typings";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-typings-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) rec('pkgjson-typings/control', 'NOTE', compiled.out);
      else {
        rec('pkgjson-typings/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE';
        rec('pkgjson-typings', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 3. empty compile: files [] with a type-error sitting in src (not included)
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: []
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const result = runGuard(fx.repo, fx.busRoot);
      rec('empty-files/control', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc succeeded on files:[]' : compiled.out);
      const status = compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE';
      rec('empty-files', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 4. staged noCheck must refuse (should-refuse)
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
      include: ['src']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /noCheck/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec('nocheck-refuse', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 5. exports.types under nodenext
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'nodenext', moduleResolution: 'nodenext'
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-exports-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-exports');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-exports', version: '1.0.0',
        exports: { '.': { types: path.join(outside, 'index.d.ts').replace(/\\/g, '/'), default: './index.js' } }
      }));
      await fsp.writeFile(path.join(pkg, 'index.js'), 'module.exports = { n: 1 };\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-exports";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-exports-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) rec('exports-types/control', 'NOTE', compiled.out);
      else {
        rec('exports-types/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('exports-types', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 6. /// <reference path> to a file whose ABSOLUTE path contains /node_modules/
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'ref-smuggle', 'node_modules', 'hidden-ref');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'declare type HiddenFix = number;\n');
      const spec = path.join(outside, 'index.d.ts').replace(/\\/g, '/');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        `/// <reference path="${spec}" />\nexport const broken: HiddenFix = 1;\n`);
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-ref');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) rec('refpath-nm-substring/control', 'NOTE', compiled.out);
      else {
        rec('refpath-nm-substring/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        // Walker should catch the absolute path= before listFilesOnly.
        // If walker misses and listFilesOnly exempts /node_modules/, this is FAIL.
        const status = compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE';
        rec('refpath-nm-substring', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 7. honest green
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      rec('honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const outPath = path.join(REPO, 'tmp-audit-r11-grok-out.json');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE' || r.status === 'SKIP');
  await fsp.writeFile(outPath, JSON.stringify({
    against: 'tmp-audit-r6-patches/claim-guard-cli.js (r10-updated)',
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
