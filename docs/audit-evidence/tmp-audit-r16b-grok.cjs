#!/usr/bin/env node
'use strict';
/**
 * r16b — corrected leftover hunt. r16 item 2 FAILs were store.claim
 * (API is store.record). src-vendor-junction did not stage the junction.
 * export-star used a .ts suffix (TS5097). Not a re-run of r16 PASSes.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
const { EvidenceStore } = require(path.join(REPO, 'tmp-audit-r6-patches', 'dist-patched', 'evidence.js'));
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|@ts-nocheck|staged symlink/i.test(result.out);
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
      claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'package.json' }] }
    })
  );
}

async function seed(tsconfig) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r16b-'));
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

function lockPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
}

async function withEvidenceRoot(name, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r16b-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src']
    });
    try {
      const vendor = path.join(fx.repo, 'src', 'vendor');
      await fsp.writeFile(path.join(fx.hidden, 'leak.ts'), 'export const n: number = 1;\n');
      if (!junction(vendor, fx.hidden)) {
        rec('src-vendor-junction-staged', 'NOTE', 'could not create junction');
      } else {
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          'import { n } from "./vendor/leak";\nexport const x: number = n;\n'
        );
        try { git(fx.repo, 'add', '-A'); } catch (error) {
          rec('src-vendor-junction-staged', 'NOTE', `git add failed: ${error.message}`);
        }
        const staged = git(fx.repo, 'diff', '--cached', '--name-only', '--', 'src');
        const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
        const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
        const result = runGuard(PATCH, fx.repo, fx.busRoot);
        const detail = `staged:\n${staged}\nlisted:\n${listed.out}\nguard:\n${result.out}`;
        if (!worktree.ok) rec('src-vendor-junction-staged', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}\n${detail}`);
        else if (compileOk(result)) rec('src-vendor-junction-staged', 'FAIL', `compile OK through staged junction\n${detail}`);
        else if (refused(result)) rec('src-vendor-junction-staged', 'PASS', result.out);
        else rec('src-vendor-junction-staged', 'NOTE', `code=${result.code}\n${detail}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const fx = await seed({
      compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/index.ts']
    });
    try {
      const hidden = path.join(fx.hidden, 'mod');
      await fsp.mkdir(hidden, { recursive: true });
      await fsp.writeFile(path.join(hidden, 'index.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `export * from ${JSON.stringify(hidden.replace(/\\/g, '/'))};\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const result = runGuard(PATCH, fx.repo, fx.busRoot);
      const listedHidden = String(listed.out).toLowerCase().includes('hidden');
      if (!worktree.ok) rec('export-star-abs-nosuffix', 'NOTE', `worktree tsc failed; not red-capable\n${worktree.out}`);
      else if (!listedHidden) rec('export-star-abs-nosuffix', 'NOTE', `tsc compiled but did not list hidden\n${listed.out}`);
      else if (compileOk(result)) rec('export-star-abs-nosuffix', 'FAIL', `compile OK; tsc listed outside\n${listed.out}\n${result.out}`);
      else if (refused(result)) rec('export-star-abs-nosuffix', 'PASS', result.out);
      else rec('export-star-abs-nosuffix', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const debrisCases = [
    ['pid-float', JSON.stringify({ pid: 1.5, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-true', JSON.stringify({ pid: true, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-object', JSON.stringify({ pid: { nested: 1 }, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-negative', JSON.stringify({ pid: -5, at: '2020-01-01T00:00:00.000Z' })],
    ['pid-string', JSON.stringify({ pid: '1234', at: '2020-01-01T00:00:00.000Z' })],
    ['bom-missing-pid', `\uFEFF${JSON.stringify({ at: '2020-01-01T00:00:00.000Z' })}`],
    ['json-trailing-junk', `${JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00.000Z' })}garbage`]
  ];

  for (const [name, bytes] of debrisCases) {
    await withEvidenceRoot(name, async (root, store) => {
      await fsp.writeFile(lockPath(root), bytes, 'utf8');
      try {
        const t0 = Date.now();
        await Promise.race([
          store.record({ workId: 7, subject: name, statement: 'x', recordedBy: 'grok' }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-800ms')), 800))
        ]);
        rec(`item2-${name}`, 'PASS', `recovered in ${Date.now() - t0}ms`);
      } catch (error) {
        rec(`item2-${name}`, 'FAIL', String(error.message || error));
      }
    });
  }

  await withEvidenceRoot('utf16be', async (root, store) => {
    const text = JSON.stringify({ pid: 999999, at: '2020-01-01T00:00:00.000Z' });
    const be = Buffer.alloc(2 + text.length * 2);
    be[0] = 0xfe;
    be[1] = 0xff;
    for (let i = 0; i < text.length; i += 1) {
      be[2 + i * 2] = 0;
      be[3 + i * 2] = text.charCodeAt(i);
    }
    await fsp.writeFile(lockPath(root), be);
    try {
      const t0 = Date.now();
      await Promise.race([
        store.record({ workId: 7, subject: 'utf16be', statement: 'x', recordedBy: 'grok' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout-800ms')), 800))
      ]);
      rec('item2-utf16be', 'PASS', `recovered in ${Date.now() - t0}ms`);
    } catch (error) {
      rec('item2-utf16be', 'FAIL', String(error.message || error));
    }
  });

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  const outPath = path.join(REPO, 'tmp-audit-r16b-grok-out.json');
  await fsp.writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nSUMMARY ${summary.pass} PASS / ${summary.fail} FAIL / ${summary.note} NOTE`);
  console.log(`wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
