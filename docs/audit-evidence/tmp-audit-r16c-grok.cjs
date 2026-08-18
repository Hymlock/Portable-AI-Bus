#!/usr/bin/env node
'use strict';
/**
 * r16c — r16b's src-vendor-junction FAIL staged leak.ts as a regular
 * file (git followed the junction). This wake stages git mode 120000
 * and also tries mklink /D. Not a re-run of r16b item 2.
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

function dirSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/D', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try { fs.symlinkSync(target, link, 'dir'); return true; } catch { return false; }
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|staged symlink/i.test(result.out);
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
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
  );
}

async function seed() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r16c-'));
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
  await fsp.writeFile(
    path.join(repo, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    }, null, 2)
  );
  await writeBus(busRoot);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return { dir, repo, busRoot, hidden };
}

function stageGitSymlink(repo, linkPath, target) {
  const blob = git(repo, 'hash-object', '-w', '--stdin', { input: target.replace(/\\/g, '/') });
  // hash-object via execFileSync can't take stdin that way with my helper.
}

function stageGitSymlink2(repo, linkPath, target) {
  const tmp = path.join(repo, '.symlink-blob');
  fs.writeFileSync(tmp, target.replace(/\\/g, '/'));
  const hash = git(repo, 'hash-object', '-w', tmp).trim();
  fs.rmSync(tmp, { force: true });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${hash},${linkPath}`], {
    cwd: repo, encoding: 'utf8', stdio: 'pipe'
  });
}

async function main() {
  {
    const fx = await seed();
    try {
      await fsp.writeFile(path.join(fx.hidden, 'leak.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "./vendor/leak";\nexport const x: number = n;\n'
      );
      stageGitSymlink2(fx.repo, 'src/vendor', fx.hidden);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const ls = git(fx.repo, 'ls-files', '-s');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const detail = `ls-files:\n${ls}\nworktreeOk=${worktree.ok}\nlisted:\n${listed.out}\nguard:\n${result.out}`;
      if (!/120000/.test(ls)) rec('git-120000-dirlink', 'NOTE', `did not stage 120000\n${detail}`);
      else if (compileOk(result)) rec('git-120000-dirlink', 'FAIL', `compile OK on staged 120000\n${detail}`);
      else if (refused(result)) rec('git-120000-dirlink', 'PASS', `${result.out}\n${detail}`);
      else rec('git-120000-dirlink', 'NOTE', `code=${result.code}\n${detail}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed();
    try {
      await fsp.writeFile(path.join(fx.hidden, 'leak.ts'), 'export const n: number = 1;\n');
      const vendor = path.join(fx.repo, 'src', 'vendor');
      if (!dirSymlink(vendor, fx.hidden)) {
        rec('mklink-D-staged', 'NOTE', 'could not create directory symlink');
      } else {
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          'import { n } from "./vendor/leak";\nexport const x: number = n;\n'
        );
        try { git(fx.repo, 'add', '-A'); } catch (error) {
          rec('mklink-D-staged', 'NOTE', `git add failed: ${error.message}`);
        }
        const ls = git(fx.repo, 'ls-files', '-s');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        const detail = `ls-files:\n${ls}\nworktreeOk=${worktree.ok}\nlisted:\n${listed.out}\nguard:\n${result.out}`;
        if (compileOk(result) && /120000/.test(ls)) rec('mklink-D-staged', 'FAIL', `compile OK on staged /D symlink\n${detail}`);
        else if (compileOk(result) && !/120000/.test(ls)) rec('mklink-D-staged', 'NOTE', `git followed /D and stored file contents; not red-capable\n${detail}`);
        else if (refused(result)) rec('mklink-D-staged', 'PASS', result.out);
        else rec('mklink-D-staged', 'NOTE', `code=${result.code}\n${detail}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed();
    try {
      await fsp.writeFile(path.join(fx.hidden, 'leak.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "./vendor/leak";\nexport const x: number = n;\n'
      );
      stageGitSymlink2(fx.repo, 'src/vendor/leak.ts', path.join(fx.hidden, 'leak.ts'));
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const ls = git(fx.repo, 'ls-files', '-s');
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const detail = `ls-files:\n${ls}\nguard:\n${result.out}`;
      if (!/120000/.test(ls)) rec('git-120000-filelink', 'NOTE', `did not stage 120000\n${detail}`);
      else if (compileOk(result)) rec('git-120000-filelink', 'FAIL', `compile OK on staged file 120000\n${detail}`);
      else if (refused(result)) rec('git-120000-filelink', 'PASS', result.out);
      else rec('git-120000-filelink', 'NOTE', `code=${result.code}\n${detail}`);
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
  const outPath = path.join(REPO, 'tmp-audit-r16c-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
