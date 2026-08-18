#!/usr/bin/env node
'use strict';
/**
 * r12 — leftover hunt against the r11-updated untracked patch.
 * Not HEAD. Not a re-run of r11.
 *
 * Classes not yet attacked after r11:
 *   empty-program spellings that are not files:[]
 *   exports.types / package.json imports under moduleResolution bundler
 *   typesVersions remap
 *   preserveSymlinks + worktree junction
 *   resolveJsonModule absolute json
 *   package.json main/module without types
 *   compilerOptions.plugins
 *   customConditions
 *   HEAD hole 4: is files:[] still a silent success on the live hook?
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
const HEAD_GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r12-'));
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

async function main() {
  // --- HEAD hole 4: is files:[] still a silent success on the LIVE hook? ---
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: []
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const head = runGuard(HEAD_GUARD, fx.repo, fx.busRoot);
      rec('head-files-empty/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'HEAD tsc still succeeds on files:[]' : compiled.out);
      rec('head-files-empty/guard', compileOk(head) ? 'FAIL' : refused(head) ? 'PASS' : 'NOTE',
        `code=${head.code}\n${head.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // HEAD empty-src include
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const head = runGuard(HEAD_GUARD, fx.repo, fx.busRoot);
      rec('head-empty-src/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'HEAD tsc succeeds on include:src with empty dir' : compiled.out);
      rec('head-empty-src/guard', compileOk(head) ? 'FAIL' : refused(head) ? 'PASS' : 'NOTE',
        `code=${head.code}\n${head.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // HEAD exclude-everything
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src'],
      exclude: ['**/*']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const head = runGuard(HEAD_GUARD, fx.repo, fx.busRoot);
      rec('head-exclude-all/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'HEAD tsc succeeds on exclude **/*' : compiled.out);
      rec('head-exclude-all/guard', compileOk(head) ? 'FAIL' : refused(head) ? 'PASS' : 'NOTE',
        `code=${head.code}\n${head.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // --- patch: empty-src include (hole 4 leftover spelling) ---
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('patch-empty-src/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc succeeds on empty include' : compiled.out);
      const status = !compiled.ok ? 'NOTE'
        : compileOk(result) ? 'FAIL'
        : refused(result) ? 'PASS' : 'NOTE';
      rec('patch-empty-src', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // patch: exclude everything
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src'],
      exclude: ['**/*']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('patch-exclude-all/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc succeeds on exclude **/*' : compiled.out);
      const status = !compiled.ok ? 'NOTE'
        : compileOk(result) ? 'FAIL'
        : refused(result) ? 'PASS' : 'NOTE';
      rec('patch-exclude-all', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // patch: include nomatch
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/*.nomatch']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('patch-include-nomatch/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc succeeds on include nomatch' : compiled.out);
      const status = !compiled.ok ? 'NOTE'
        : compileOk(result) ? 'FAIL'
        : refused(result) ? 'PASS' : 'NOTE';
      rec('patch-include-nomatch', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // exports.types under bundler
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'esnext', moduleResolution: 'bundler'
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-bundler-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-bundler');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-bundler', version: '1.0.0',
        exports: { '.': { types: path.join(outside, 'index.d.ts').replace(/\\/g, '/'), default: './index.js' } }
      }));
      await fsp.writeFile(path.join(pkg, 'index.js'), 'export const n = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-bundler";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-bundler-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!compiled.ok) rec('bundler-exports-types/control', 'NOTE', compiled.out);
      else {
        rec('bundler-exports-types/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('bundler-exports-types', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // package.json imports (#) under bundler
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'esnext', moduleResolution: 'bundler', resolvePackageJsonImports: true
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-hash-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      await fsp.writeFile(path.join(fx.repo, 'package.json'), JSON.stringify({
        name: 'fixture',
        type: 'module',
        imports: {
          '#hidden': {
            types: path.join(outside, 'index.d.ts').replace(/\\/g, '/'),
            default: './src/hidden.js'
          }
        }
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'hidden.js'), 'export const n = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "#hidden";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-hash-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!compiled.ok) rec('hash-imports/control', 'NOTE', compiled.out);
      else {
        rec('hash-imports/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('hash-imports', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // typesVersions remap to outside
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-tv-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-tv');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'index.d.ts'), 'export declare const n: string;\n');
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-tv', version: '1.0.0', types: './index.d.ts',
        typesVersions: { '*': { '*': [path.join(outside, 'index.d.ts').replace(/\\/g, '/')] } }
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-tv";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-tv-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!compiled.ok) rec('typesVersions/control', 'NOTE', compiled.out);
      else {
        rec('typesVersions/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('typesVersions', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // preserveSymlinks + node_modules junction onto worktree src
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        preserveSymlinks: true
      },
      include: ['src']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      const leak = path.join(fx.repo, 'node_modules', 'leak-src');
      if (!junction(leak, path.join(fx.repo, 'src'))) {
        rec('preserveSymlinks-junction', 'NOTE', 'could not create junction');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'via.ts'),
          'import { good } from "leak-src";\nexport const x: number = good;\n');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        git(fx.repo, 'add', '-A');
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        rec('preserveSymlinks-junction/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? `tsc ok; listed=${listed.out.slice(0, 400)}` : compiled.out);
        const status = compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE';
        rec('preserveSymlinks-junction', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // resolveJsonModule + absolute json import
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        resolveJsonModule: true, module: 'esnext', moduleResolution: 'bundler',
        esModuleInterop: true
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden.json');
      await fsp.writeFile(outside, JSON.stringify({ n: 1 }));
      const spec = outside.replace(/\\/g, '/');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        `import data from "${spec}";\nexport const broken: number = data.n;\n`);
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden.json');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!compiled.ok) rec('json-abs-import/control', 'NOTE', compiled.out);
      else {
        rec('json-abs-import/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('json-abs-import', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // package.json main/module to outside .d.ts, no types field
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-main-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-main');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-main', version: '1.0.0',
        main: path.join(outside, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-main";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-main-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!compiled.ok) rec('pkg-main-dts/control', 'NOTE', compiled.out);
      else {
        rec('pkg-main-dts/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('pkg-main-dts', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // compilerOptions.plugins — does tsc -p even load them?
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        plugins: [{ name: 'leak-plugin' }]
      },
      include: ['src']
    });
    try {
      const plugin = path.join(fx.repo, 'node_modules', 'leak-plugin');
      await fsp.mkdir(plugin, { recursive: true });
      await fsp.writeFile(path.join(plugin, 'package.json'), JSON.stringify({
        name: 'leak-plugin', version: '1.0.0', main: './index.js'
      }));
      await fsp.writeFile(path.join(plugin, 'index.js'),
        'throw new Error("plugin-executed");\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('plugins/control', compiled.ok ? 'NOTE' : 'PASS',
        compiled.ok ? 'tsc -p ignored plugins (not red-capable for tsc CLI)' : compiled.out);
      rec('plugins/guard', compileOk(result) ? 'NOTE' : refused(result) ? 'PASS' : 'NOTE',
        `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // customConditions + exports
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'esnext', moduleResolution: 'bundler',
        customConditions: ['types-leak']
      },
      include: ['src']
    });
    try {
      const outside = path.join(fx.dir, 'hidden-cond-pkg');
      await fsp.mkdir(outside, { recursive: true });
      await fsp.writeFile(path.join(outside, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-cond');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-cond', version: '1.0.0',
        exports: {
          '.': {
            'types-leak': path.join(outside, 'index.d.ts').replace(/\\/g, '/'),
            types: './index.d.ts',
            default: './index.js'
          }
        }
      }));
      await fsp.writeFile(path.join(pkg, 'index.d.ts'), 'export declare const n: number;\n');
      await fsp.writeFile(path.join(pkg, 'index.js'), 'export const n = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-cond";\nexport const broken: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const leaks = listedOutside(listed.out, 'hidden-cond-pkg');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!compiled.ok) rec('customConditions/control', 'NOTE', compiled.out);
      else {
        rec('customConditions/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec('customConditions', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // honest green on the patch
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
      git(fx.repo, 'add', '-A');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const outPath = path.join(REPO, 'tmp-audit-r12-grok-out.json');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE' || r.status === 'SKIP');
  await fsp.writeFile(outPath, JSON.stringify({
    against: 'tmp-audit-r6-patches/claim-guard-cli.js (r11-updated) + HEAD hole-4 spellings',
    head: '373e176',
    notHeadCertification: true,
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
