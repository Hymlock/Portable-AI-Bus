#!/usr/bin/env node
'use strict';
/**
 * r17b — close the r17 BOM+noCheck leftover on the untracked patch.
 * Not a re-run of r17. Not HEAD.
 *
 * After stripping UTF-8 BOM in readConfig, also try the same class as
 * UTF-16 LE / BE tsconfig + noCheck (tsc may or may not honour those).
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

function runGuard(repo, busRoot) {
  const env = { ...process.env };
  delete env.BUS_ALLOW_BROKEN_BUILD;
  try {
    const stdout = execFileSync(process.execPath, [PATCH, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
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
  return result.code === 1 && /REFUSING|noCheck/i.test(result.out);
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

function utf16le(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

function utf16be(text) {
  const be = Buffer.alloc(2 + text.length * 2);
  be[0] = 0xfe;
  be[1] = 0xff;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    be[2 + i * 2] = (code >> 8) & 0xff;
    be[3 + i * 2] = code & 0xff;
  }
  return be;
}

async function seed() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r17b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'tsconfig.base.json' }] } })
  );
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return { dir, repo, busRoot };
}

function judgeShouldRefuse(name, worktree, result, why) {
  if (!worktree.ok) rec(name, 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
  else if (compileOk(result)) rec(name, 'FAIL', `${why}\n${result.out}`);
  else if (refused(result)) rec(name, 'PASS', result.out);
  else rec(name, 'NOTE', `code=${result.code}\n${result.out}`);
}

async function main() {
  {
    const fx = await seed();
    try {
      const body = JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
        include: ['src/index.ts']
      }, null, 2);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), `\uFEFF${body}`);
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('bom-nocheck', worktree, result, 'BOM+noCheck still compile OK after the strip');
      else rec('bom-nocheck', 'NOTE', `tsc did not honour BOM+noCheck\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed();
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.base.json'),
        `\uFEFF${JSON.stringify({ compilerOptions: { noCheck: true } }, null, 2)}`
      );
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        JSON.stringify({
          extends: './tsconfig.base.json',
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/index.ts']
        }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'tsconfig.base.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('bom-nocheck-via-extends', worktree, result, 'BOM+noCheck in extended config still compile OK');
      else rec('bom-nocheck-via-extends', 'NOTE', `tsc did not honour BOM+extended noCheck\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed();
    try {
      const body = JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
        include: ['src/index.ts']
      }, null, 2);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), utf16le(body));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('utf16le-nocheck', worktree, result, 'UTF-16 LE + noCheck compiled a type error');
      else rec('utf16le-nocheck', 'NOTE', `tsc did not honour UTF-16 LE tsconfig\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed();
    try {
      const body = JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
        include: ['src/index.ts']
      }, null, 2);
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), utf16be(body));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(fx.repo, fx.busRoot);
      if (worktree.ok) judgeShouldRefuse('utf16be-nocheck', worktree, result, 'UTF-16 BE + noCheck compiled a type error');
      else rec('utf16be-nocheck', 'NOTE', `tsc did not honour UTF-16 BE tsconfig\n${worktree.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed();
    try {
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        `\uFEFF${JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src/index.ts']
        }, null, 2)}`
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot);
      if (compileOk(result)) rec('honest-green-bom', 'PASS', result.out);
      else rec('honest-green-bom', 'FAIL', `honest BOM green was refused\n${result.out}`);
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
  const outPath = path.join(REPO, 'tmp-audit-r17b-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
