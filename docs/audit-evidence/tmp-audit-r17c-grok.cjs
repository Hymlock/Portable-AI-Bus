#!/usr/bin/env node
'use strict';
/**
 * r17c — close the r17b UTF-16 + noCheck leftover on the untracked patch.
 * Not a re-run of r17/r17b. Not HEAD.
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
  const row = { name, status, detail: String(detail).slice(0, 4000) };
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

function utf16le(text, bom) {
  const body = Buffer.from(text, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function utf16be(text, bom) {
  const be = Buffer.alloc((bom ? 2 : 0) + text.length * 2);
  let o = 0;
  if (bom) {
    be[0] = 0xfe;
    be[1] = 0xff;
    o = 2;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    be[o + i * 2] = (code >> 8) & 0xff;
    be[o + i * 2 + 1] = code & 0xff;
  }
  return be;
}

const NOCHECK = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
  include: ['src/index.ts']
}, null, 2);

const GREEN = JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
  include: ['src/index.ts']
}, null, 2);

async function seed() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r17c-'));
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
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
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

async function attackBytes(name, bytes, source) {
  const fx = await seed();
  try {
    await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), bytes);
    await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), source);
    git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
    const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
    const result = runGuard(fx.repo, fx.busRoot);
    return { worktree, result };
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  const broken = 'export const n: number = "this does not compile";\n';
  const good = 'export const n: number = 1;\n';

  {
    const { worktree, result } = await attackBytes('utf8-bom-nocheck', Buffer.from(`\uFEFF${NOCHECK}`, 'utf8'), broken);
    if (worktree.ok) judgeShouldRefuse('utf8-bom-nocheck', worktree, result, 'UTF-8 BOM + noCheck still compile OK');
    else rec('utf8-bom-nocheck', 'NOTE', `tsc did not honour UTF-8 BOM+noCheck\n${worktree.out}`);
  }

  {
    const { worktree, result } = await attackBytes('utf16le-bom-nocheck', utf16le(NOCHECK, true), broken);
    if (worktree.ok) judgeShouldRefuse('utf16le-bom-nocheck', worktree, result, 'UTF-16 LE BOM + noCheck still compile OK');
    else rec('utf16le-bom-nocheck', 'NOTE', `tsc did not honour UTF-16 LE BOM\n${worktree.out}`);
  }

  {
    const { worktree, result } = await attackBytes('utf16be-bom-nocheck', utf16be(NOCHECK, true), broken);
    if (worktree.ok) judgeShouldRefuse('utf16be-bom-nocheck', worktree, result, 'UTF-16 BE BOM + noCheck still compile OK');
    else rec('utf16be-bom-nocheck', 'NOTE', `tsc did not honour UTF-16 BE BOM\n${worktree.out}`);
  }

  {
    const { worktree, result } = await attackBytes('utf16le-nobom-nocheck', utf16le(NOCHECK, false), broken);
    if (worktree.ok) judgeShouldRefuse('utf16le-nobom-nocheck', worktree, result, 'UTF-16 LE no BOM + noCheck compiled a type error');
    else rec('utf16le-nobom-nocheck', 'NOTE', `tsc did not honour UTF-16 LE without BOM\n${worktree.out}`);
  }

  {
    const { worktree, result } = await attackBytes('utf16be-nobom-nocheck', utf16be(NOCHECK, false), broken);
    if (worktree.ok) judgeShouldRefuse('utf16be-nobom-nocheck', worktree, result, 'UTF-16 BE no BOM + noCheck compiled a type error');
    else rec('utf16be-nobom-nocheck', 'NOTE', `tsc did not honour UTF-16 BE without BOM\n${worktree.out}`);
  }

  {
    const { result } = await attackBytes('honest-green-utf16le', utf16le(GREEN, true), good);
    if (compileOk(result)) rec('honest-green-utf16le', 'PASS', result.out);
    else rec('honest-green-utf16le', 'FAIL', `honest UTF-16 LE green was refused\n${result.out}`);
  }

  {
    const { result } = await attackBytes('honest-green-utf8-bom', Buffer.from(`\uFEFF${GREEN}`, 'utf8'), good);
    if (compileOk(result)) rec('honest-green-utf8-bom', 'PASS', result.out);
    else rec('honest-green-utf8-bom', 'FAIL', `honest UTF-8 BOM green was refused\n${result.out}`);
  }

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r17c-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
