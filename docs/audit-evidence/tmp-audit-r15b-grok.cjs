#!/usr/bin/env node
'use strict';
/**
 * r15b — corrected leftover hunt. r15 NOTES were mostly fixtures that
 * tsc itself refused. Not a re-run of r15's passing cases.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck/i.test(result.out);
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
      claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'package.json' }, { path: 'packages' }] }
    })
  );
}

async function seed(tsconfig) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r15b-'));
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
  return { dir, repo, busRoot, hidden };
}

function listedOutside(listText, needle) {
  const n = String(needle).replace(/\\/g, '/').toLowerCase();
  return String(listText).split(/\r?\n/).some((line) => line.replace(/\\/g, '/').toLowerCase().includes(n));
}

async function main() {
  // import = require without a .ts suffix (r15 hit TS5097)
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      const hiddenBase = path.join(fx.hidden, 'hidden');
      await fsp.writeFile(`${hiddenBase}.d.ts`, 'export declare const n: number;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `import n = require(${JSON.stringify(hiddenBase.replace(/\\/g, '/'))});\nexport const x: number = n.n;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const leak = listedOutside(listed.out, 'hidden.d.ts');
      if (!worktree.ok) rec('import-equals-require-abs', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!leak) rec('import-equals-require-abs', 'NOTE', `tsc compiled but did not list hidden.d.ts\n${listed.out}`);
      else if (compileOk(result)) rec('import-equals-require-abs', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('import-equals-require-abs', 'PASS', result.out);
      else rec('import-equals-require-abs', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // node16 #imports via a relative junction inside the package (r15 absolute #hidden was TS2307)
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: true, types: [],
        module: 'node16', moduleResolution: 'node16'
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.mkdir(path.join(fx.repo, 'src'), { recursive: true });
      const aliasDir = path.join(fx.repo, 'alias');
      await fsp.mkdir(aliasDir, { recursive: true });
      await fsp.writeFile(path.join(fx.hidden, 'index.d.ts'), 'export declare const n: number;\n');
      await fsp.writeFile(path.join(fx.hidden, 'package.json'), JSON.stringify({ name: 'hidden', types: 'index.d.ts' }));
      if (!junction(path.join(fx.repo, 'alias', 'hidden'), fx.hidden)) {
        rec('node16-package-imports-junction', 'NOTE', 'could not create junction');
      } else {
        await fsp.writeFile(
          path.join(fx.repo, 'package.json'),
          JSON.stringify({ type: 'module', imports: { '#hidden': './alias/hidden/index.d.ts' } }, null, 2)
        );
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          'import { n } from "#hidden";\nexport const x: number = n;\n'
        );
        git(fx.repo, 'add', 'tsconfig.json', 'package.json', 'src/index.ts');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        const leak = listedOutside(listed.out, fx.hidden);
        if (!worktree.ok) rec('node16-package-imports-junction', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
        else if (!leak) rec('node16-package-imports-junction', 'NOTE', `tsc compiled but did not list hidden realpath\n${listed.out}`);
        else if (compileOk(result)) rec('node16-package-imports-junction', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
        else if (refused(result)) rec('node16-package-imports-junction', 'PASS', result.out);
        else rec('node16-package-imports-junction', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // moduleSuffixes: real file in package is a file symlink onto an outside .ts
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
      await fsp.writeFile(path.join(fx.hidden, 'index.real.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(leakDir, 'package.json'), JSON.stringify({ name: 'leak-suffix', main: 'index.js' }));
      if (!fileSymlink(path.join(leakDir, 'index.real.ts'), path.join(fx.hidden, 'index.real.ts'))) {
        rec('moduleSuffixes-filesymlink', 'NOTE', 'could not create file symlink');
      } else {
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          'import { n } from "leak-suffix";\nexport const x: number = n;\n'
        );
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        const leak = listedOutside(listed.out, fx.hidden);
        if (!worktree.ok) rec('moduleSuffixes-filesymlink', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
        else if (!leak) rec('moduleSuffixes-filesymlink', 'NOTE', `tsc compiled but did not list hidden realpath\n${listed.out}`);
        else if (compileOk(result)) rec('moduleSuffixes-filesymlink', 'FAIL', `compile OK; tsc listed outside file\n${listed.out}\n${result.out}`);
        else if (refused(result)) rec('moduleSuffixes-filesymlink', 'PASS', result.out);
        else rec('moduleSuffixes-filesymlink', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // rootDirs junction — stage only, do not commit (r15 instrument error)
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
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        if (!worktree.ok) rec('rootDirs-worktree-junction', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
        else if (compileOk(result)) rec('rootDirs-worktree-junction', 'NOTE', `compile OK — rootDirs did not list an outside file. listed:\n${listed.out}\n${result.out}`);
        else if (refused(result)) rec('rootDirs-worktree-junction', 'PASS', result.out);
        else rec('rootDirs-worktree-junction', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // composite project reference with emit enabled (r15 hit TS6310)
  {
    const fx = await seed({
      compilerOptions: {
        strict: true, skipLibCheck: true, types: [],
        disableSourceOfProjectReferenceRedirect: true
      },
      files: ['src/index.ts'],
      references: [{ path: './packages/lib' }]
    });
    try {
      await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true, skipLibCheck: true, types: [],
            composite: true, declaration: true, emitDeclarationOnly: true, outDir: 'dist'
          },
          files: ['index.ts']
        }, null, 2)
      );
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'index.ts'),
        'export const n: number = "this does not compile";\n'
      );
      await fsp.mkdir(path.join(fx.repo, 'packages', 'lib', 'dist'), { recursive: true });
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'dist', 'index.d.ts'),
        'export declare const n: number;\n'
      );
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "../packages/lib/dist/index.js";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts', 'packages');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      if (!worktree.ok) rec('project-ref-dts-mask', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (compileOk(result)) rec('project-ref-dts-mask', 'NOTE', `compile OK — tsc -p does not type-check the referenced .ts (already classified). listed:\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('project-ref-dts-mask', 'PASS', result.out);
      else rec('project-ref-dts-mask', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // noResolve is not red-capable alone (r15: TS2307). Combined with skipLibCheck
  // it still failed. Record that classification, do not retry the same spelling.

  // classifyListedFiles substring: can we name an outside file whose path
  // contains the scratch prefix? We cannot predict scratch. Instead, confirm
  // that a path which merely CONTAINS the repo path as a substring is not
  // treated as in-scratch by creating an outside dir named after a staged
  // file path fragment. This is the r11 class applied to scratchRoot.
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      const smuggle = path.join(fx.dir, 'smuggle');
      await fsp.mkdir(smuggle, { recursive: true });
      const decoy = path.join(smuggle, 'src', 'index.ts');
      await fsp.mkdir(path.dirname(decoy), { recursive: true });
      await fsp.writeFile(decoy, 'export const n: number = 1;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'decoy-pkg');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(
        path.join(pkg, 'package.json'),
        JSON.stringify({ name: 'decoy-pkg', types: decoy.replace(/\\/g, '/') })
      );
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "decoy-pkg";\nexport const x: number = n;\n'
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const leak = listedOutside(listed.out, smuggle);
      if (!worktree.ok) rec('types-outside-src-index-name', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!leak) rec('types-outside-src-index-name', 'NOTE', `tsc compiled but did not list smuggle\n${listed.out}`);
      else if (compileOk(result)) rec('types-outside-src-index-name', 'FAIL', `compile OK; tsc listed outside file whose path contains src/index.ts\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('types-outside-src-index-name', 'PASS', result.out);
      else rec('types-outside-src-index-name', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r15b-grok-out.json');
  await fsp.writeFile(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nr15b: ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
  process.exit(summary.fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
