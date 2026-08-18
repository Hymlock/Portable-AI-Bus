#!/usr/bin/env node
'use strict';
/**
 * r10b — confirm r10 FAILs are real leaks (tsc lists a file outside scratch
 * and outside repo node_modules) and retry package.json types as an import
 * of an exported symbol. Own instrument. Not HEAD.
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

function walkerRefused(result) {
  return result.code === 1 && /OUTSIDE the staged tree|staged symlink|compiled files outside|compiled no program|noCheck/i.test(result.out);
}

function tsc(repo, args) {
  const bin = path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  try {
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/c', bin, ...args], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe'
    });
    return { ok: true, out };
  } catch (error) {
    return { ok: false, out: `${error.stdout || ''}${error.stderr || ''}${error.message}` };
  }
}

function outsideListed(listText, markers) {
  const files = String(listText).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return files.filter((f) => markers.some((m) => f.toLowerCase().includes(String(m).toLowerCase())));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r10b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  await writeBus(busRoot);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return { dir, repo, busRoot };
}

async function main() {
  // 1. allowJs absolute import — confirm tsc lists the outside file
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        allowJs: true, checkJs: true
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-js-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.ts'), 'export const n: number = 1;\n');
      const spec = path.join(outside, 'index.ts').replace(/\\/g, '/');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.js'), `import { n } from "${spec}";\nexport const broken = n;\n`);
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = outsideListed(listed.out, [fx.dir.replace(/\\/g, '/'), 'hidden-js-pkg']);
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) {
        rec('allowjs-absolute/control', 'NOTE', compiled.out);
      } else {
        rec('allowjs-absolute/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside files listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : walkerRefused(result) ? 'PASS' : 'NOTE';
        rec('allowjs-absolute', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 2. jsxImportSource — HiddenFix ONLY in outside types, not in local jsx-runtime
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        jsx: 'react-jsx',
        jsxImportSource: 'leak-jsx'
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-jsx');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\ndeclare type HiddenFix = number;\n');
      const jsx = path.join(fx.repo, 'node_modules', 'leak-jsx');
      await fsp.mkdir(jsx, { recursive: true });
      await fsp.writeFile(path.join(jsx, 'package.json'), JSON.stringify({
        name: 'leak-jsx', version: '1.0.0',
        types: path.join(outside, 'index.d.ts').replace(/\\/g, '/')
      }));
      // Local runtime supplies JSX only. No HiddenFix here.
      await fsp.writeFile(path.join(jsx, 'jsx-runtime.d.ts'), [
        'export namespace JSX { export interface Element { k: number } export interface IntrinsicElements { div: {} } }',
        'export function jsx(type: unknown, props: unknown): { k: number };',
        'export function jsxs(type: unknown, props: unknown): { k: number };',
        ''
      ].join('\n'));
      await fsp.writeFile(path.join(jsx, 'jsx-runtime.js'), 'module.exports = {};\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.tsx'),
        'export const el = <div />;\nexport const broken: HiddenFix = 1;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = outsideListed(listed.out, [fx.dir.replace(/\\/g, '/'), 'hidden-jsx']);
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) {
        rec('jsx-import-source-outside-types/control', 'NOTE', `tsc does not see HiddenFix via package types: ${compiled.out}`);
        rec('jsx-import-source-outside-types', 'NOTE', `not red-capable; guard code=${result.code}`);
      } else {
        rec('jsx-import-source-outside-types/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside files listed=${JSON.stringify(leaks)}`);
        const status = compileOk(result) ? 'FAIL' : walkerRefused(result) ? 'PASS' : 'NOTE';
        rec('jsx-import-source-outside-types', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 3. jsxImportSource package dir is a junction onto outside tree that supplies JSX + HiddenFix
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        jsx: 'react-jsx',
        jsxImportSource: 'leak-jsx'
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'leak-jsx-real');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'package.json'), JSON.stringify({ name: 'leak-jsx', version: '1.0.0' }));
      await fsp.writeFile(path.join(outside, 'jsx-runtime.d.ts'), [
        'export namespace JSX { export interface Element { k: number } export interface IntrinsicElements { div: {} } }',
        'export function jsx(type: unknown, props: unknown): { k: number };',
        'export function jsxs(type: unknown, props: unknown): { k: number };',
        'declare type HiddenFix = number;',
        ''
      ].join('\n'));
      await fsp.writeFile(path.join(outside, 'jsx-runtime.js'), 'module.exports = {};\n');
      if (!junction(path.join(fx.repo, 'node_modules', 'leak-jsx'), outside)) {
        rec('jsx-import-source-junction', 'SKIP', 'junction failed');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.tsx'),
          'export const el = <div />;\nexport const broken: HiddenFix = 1;\n');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        const leaks = outsideListed(listed.out, [fx.dir.replace(/\\/g, '/'), 'leak-jsx-real']);
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        if (!compiled.ok) {
          rec('jsx-import-source-junction/control', 'NOTE', compiled.out);
        } else {
          rec('jsx-import-source-junction/control', leaks.length ? 'PASS' : 'NOTE',
            `tsc ok; outside files listed=${JSON.stringify(leaks)}`);
          const status = !leaks.length ? 'NOTE'
            : compileOk(result) ? 'FAIL'
            : walkerRefused(result) ? 'PASS' : 'NOTE';
          rec('jsx-import-source-junction', status, `code=${result.code}\n${result.out}`);
        }
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 4. package.json types field: import exported n from outside d.ts
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-fix-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-types', version: '1.0.0',
        types: path.join(outside, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-types";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = outsideListed(listed.out, [fx.dir.replace(/\\/g, '/'), 'hidden-fix-pkg']);
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) {
        rec('pkgjson-types-import/control', 'NOTE', compiled.out);
      } else {
        rec('pkgjson-types-import/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside files listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : walkerRefused(result) ? 'PASS' : 'NOTE';
        rec('pkgjson-types-import', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const outPath = path.join(REPO, 'tmp-audit-r10b-grok-out.json');
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
