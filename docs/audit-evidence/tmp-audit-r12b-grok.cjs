#!/usr/bin/env node
'use strict';
/**
 * r12b — hole 4 solution-style spelling, plus one more empty-success hunt.
 * HEAD live hook vs r11-updated patch. Not a re-run of r12.
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck/i.test(result.out);
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

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({
      claims: {
        claude: [
          { path: 'src' }, { path: 'tsconfig.json' }, { path: 'package.json' },
          { path: 'packages' }
        ]
      }
    })
  );
}

async function seedSolution() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r12b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'packages', 'lib', 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    files: [],
    references: [{ path: './packages/lib' }]
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'packages', 'lib', 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], composite: true },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'packages', 'lib', 'src', 'index.ts'),
    'export const broken: number = "no";\n');
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  await writeBus(busRoot);
  return { dir, repo, busRoot };
}

async function seedBare(tsconfig, extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r12b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  await writeBus(busRoot);
  if (extra) await extra(repo);
  return { dir, repo, busRoot };
}

async function main() {
  {
    const fx = await seedSolution();
    try {
      git(fx.repo, 'add', '-A');
      const compiledP = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const compiledB = tsc(fx.repo, ['-b', fx.repo, '--pretty', 'false']);
      rec('solution/tsc-p', compiledP.ok ? 'PASS' : 'NOTE',
        compiledP.ok ? 'tsc -p succeeds on files:[] + references' : compiledP.out);
      rec('solution/tsc-b', compiledB.ok ? 'NOTE' : 'PASS',
        compiledB.ok ? 'tsc -b unexpectedly compiled the broken ref' : compiledB.out);
      const head = runGuard(HEAD_GUARD, fx.repo, fx.busRoot);
      rec('solution/head', compileOk(head) ? 'FAIL' : refused(head) ? 'PASS' : 'NOTE',
        `code=${head.code}\n${head.out}`);
      const patch = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('solution/patch', compileOk(patch) ? 'FAIL' : refused(patch) ? 'PASS' : 'NOTE',
        `code=${patch.code}\n${patch.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Default include of everything, but only a .md is present — empty program?
  {
    const fx = await seedBare({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }
    }, async (repo) => {
      await fsp.writeFile(path.join(repo, 'README.md'), '# no ts\n');
    });
    try {
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      rec('default-no-ts/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc succeeds with no .ts files' : compiled.out);
      const head = runGuard(HEAD_GUARD, fx.repo, fx.busRoot);
      rec('default-no-ts/head', compileOk(head) ? 'FAIL' : refused(head) ? 'PASS' : 'NOTE',
        `code=${head.code}\n${head.out}`);
      const patch = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('default-no-ts/patch', compileOk(patch) ? 'FAIL' : refused(patch) ? 'PASS' : 'NOTE',
        `code=${patch.code}\n${patch.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // files: [comment-only.ts] — not empty, control that a tiny program is green
  {
    const fx = await seedBare({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      files: ['src/index.ts']
    }, async (repo) => {
      await fsp.writeFile(path.join(repo, 'src', 'index.ts'), '// empty\n');
      await fsp.writeFile(path.join(repo, 'src', 'hidden.ts'), 'export const broken: number = "no";\n');
    });
    try {
      git(fx.repo, 'add', '-A');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      rec('comment-only/tsc', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc succeeds on comment-only included file' : compiled.out);
      const head = runGuard(HEAD_GUARD, fx.repo, fx.busRoot);
      rec('comment-only/head', compileOk(head) ? 'NOTE' : 'NOTE',
        `narrowing files is accepted leftover on HEAD; code=${head.code}\n${head.out}`);
      const patch = runGuard(PATCH, fx.repo, fx.busRoot);
      rec('comment-only/patch', compileOk(patch) ? 'PASS' : 'NOTE',
        `code=${patch.code}\n${patch.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const outPath = path.join(REPO, 'tmp-audit-r12b-grok-out.json');
  const fail = results.filter((r) => r.status === 'FAIL');
  const pass = results.filter((r) => r.status === 'PASS');
  const note = results.filter((r) => r.status === 'NOTE' || r.status === 'SKIP');
  await fsp.writeFile(outPath, JSON.stringify({
    against: 'HEAD live hook + r11-updated patch; hole 4 solution-style',
    head: '373e176',
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
