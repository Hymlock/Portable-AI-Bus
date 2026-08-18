#!/usr/bin/env node
'use strict';
/**
 * r20 — first attack on committed HEAD ebd70ec (Claude's transcription of the r19b leftover).
 * Live hook: scripts/claim-guard-cli.js
 * Live dist: dist/evidence.js, dist/mailbox.js
 * Not the author's suite. Not r19/r19b re-run as the only instrument.
 *
 * ebd70ec claims: classifyListedFiles no longer uses includes(scratchRoot).
 * Item 2 was certified at 1592382 and this commit did not touch src/evidence.ts
 * or src/mailbox.ts. Re-checked here because a stale dist would be a different
 * artifact than the one r19 attacked.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
const { EvidenceStore } = require(path.join(REPO, 'dist', 'evidence.js'));
const { MailboxStore } = require(path.join(REPO, 'dist', 'mailbox.js'));
const results = [];

function rec(item, name, status, detail) {
  const row = { item, name, status, detail: String(detail).slice(0, 8000) };
  results.push(row);
  console.log(`[${status}] item ${item} / ${name}: ${row.detail.split('\n')[0]}`);
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

function runGuard(repo, busRoot, extraEnv, extraArgs) {
  const env = { ...process.env, ...(extraEnv || {}) };
  delete env.BUS_ALLOW_BROKEN_BUILD;
  const args = [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot, ...(extraArgs || [])];
  try {
    const stdout = execFileSync(process.execPath, args, {
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

function listedOutside(listText, needle) {
  const n = String(needle).replace(/\\/g, '/').toLowerCase();
  return String(listText).split(/\r?\n/).map((s) => s.trim()).filter((f) => f.replace(/\\/g, '/').toLowerCase().includes(n));
}

async function writeBus(busRoot) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({
      claims: {
        claude: [
          { path: 'src' },
          { path: 'tsconfig.json' },
          { path: 'package.json' },
          { path: 'packages' }
        ]
      }
    })
  );
}

async function seed(tsconfig, extra) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-'));
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
  if (tsconfig !== null) {
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  }
  await writeBus(busRoot);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  if (extra) await extra({ dir, repo, busRoot, hidden });
  return { dir, repo, busRoot, hidden };
}

function lockPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
}

async function withEvidenceRoot(name, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r20-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    try { await fsp.chmod(lockPath(dir), 0o666); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function pinScratch(tmpHome, forcedScratch) {
  const preload = path.join(tmpHome, 'preload.cjs');
  await fsp.writeFile(preload, `
    const fs = require('node:fs');
    const forced = ${JSON.stringify(forcedScratch)};
    const orig = fs.mkdtempSync;
    let used = false;
    fs.mkdtempSync = function(prefix, options) {
      if (!used && String(prefix).includes('claim-guard-index-')) {
        used = true;
        fs.mkdirSync(forced, { recursive: true });
        return forced;
      }
      return orig.call(this, prefix, options);
    };
  `);
  return {
    preload,
    env: {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      TMP: tmpHome,
      TEMP: tmpHome,
      TMPDIR: tmpHome
    }
  };
}

function verdictFromList(result, listed, leakDir, name) {
  const leaks = listedOutside(listed.out, leakDir);
  if (!leaks.length) {
    rec(15, name, 'NOTE', `tsc did not list the outside path; not red-capable\n${listed.out}`);
    return;
  }
  if (compileOk(result)) rec(15, name, 'FAIL', `compile OK; listed ${JSON.stringify(leaks)}\n${result.out}`);
  else if (refused(result)) rec(15, name, 'PASS', result.out);
  else rec(15, name, 'NOTE', `code=${result.code}\n${result.out}`);
}

const tsOpts = { strict: true, noEmit: true, skipLibCheck: true, types: [] };
const green = 'export const n: number = 1;\n';

async function main() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  rec(15, 'against', 'NOTE', `HEAD=${head}\nlive hook ${GUARD}`);

  // 1. honest green
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 2. noCheck
  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, noCheck: true },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /noCheck/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'nocheck-true', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 3. files:[] + references (hole 4 last live spelling)
  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, composite: true },
      files: [],
      references: [{ path: './packages/lib' }]
    });
    try {
      await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { ...tsOpts, composite: true }, include: ['index.ts'] }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'index.ts'), 'export const broken: number = "no";\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', '-A');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(fx.repo, fx.busRoot);
      rec(15, 'files-empty-plus-references/control',
        worktree.ok ? 'PASS' : 'NOTE',
        worktree.ok ? 'tsc -p succeeded on files:[] + references' : worktree.out);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /compiled no program|REFUSING/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'files-empty-plus-references', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 4. /node_modules/ substring elsewhere must refuse (r11, Claude's transcription risk 1)
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src'] });
    try {
      const outsideDir = path.join(fx.dir, 'smuggle', 'node_modules', 'hidden-fix');
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, 'index.d.ts'), 'export declare const n: number;\n');
      const typesAbs = path.join(outsideDir, 'index.d.ts').replace(/\\/g, '/');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-types', version: '1.0.0', types: typesAbs
      }));
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-types";\nexport const broken: number = n;\n'
      );
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) {
        rec(15, 'nm-substring-types', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      } else {
        verdictFromList(result, listed, 'hidden-fix', 'nm-substring-types');
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 5. r19b leftover on 1592382: package.json types -> sibling of scratch
  {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-tmp-'));
    const forcedScratch = path.join(tmpHome, 'claim-guard-index-FIXED');
    const leakDir = `${forcedScratch}x`;
    const pin = await pinScratch(tmpHome, forcedScratch);
    const fx = await seed({ compilerOptions: { ...tsOpts, types: ['leak-types'] }, include: ['src'] });
    try {
      await fsp.mkdir(leakDir, { recursive: true });
      await fsp.writeFile(path.join(leakDir, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-types', version: '1.0.0', types: path.join(leakDir, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), "import 'leak-types';\nexport const good: number = 1;\n");
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
      const result = runGuard(fx.repo, fx.busRoot, pin.env);
      rec(15, 'scratch-sibling-types/control', compiled.ok ? 'PASS' : 'NOTE',
        compiled.ok ? 'tsc compiled the types leak' : compiled.out);
      verdictFromList(result, listed, leakDir, 'scratch-sibling-types');
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 6. NEW leftover hunt: typeRoots pointing at a scratch sibling
  {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-tr-'));
    const forcedScratch = path.join(tmpHome, 'claim-guard-index-TYPEROOT');
    const leakDir = `${forcedScratch}x`;
    const pin = await pinScratch(tmpHome, forcedScratch);
    const fx = await seed({
      compilerOptions: { ...tsOpts, typeRoots: [path.join(leakDir, '@types').replace(/\\/g, '/')], types: ['hidden-fix'] },
      include: ['src/index.ts']
    });
    try {
      await fsp.mkdir(path.join(leakDir, '@types', 'hidden-fix'), { recursive: true });
      await fsp.writeFile(path.join(leakDir, '@types', 'hidden-fix', 'index.d.ts'), 'declare const leaked: number;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = leaked;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot, pin.env);
      if (!compiled.ok) rec(15, 'scratch-sibling-typeRoots', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      else verdictFromList(result, listed, leakDir, 'scratch-sibling-typeRoots');
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 7. NEW leftover hunt: sibling of the declared repo node_modules
  {
    const fx = await seed({ compilerOptions: { ...tsOpts, types: ['leak-types'] }, include: ['src'] });
    try {
      const leakDir = `${path.join(fx.repo, 'node_modules')}x`;
      await fsp.mkdir(leakDir, { recursive: true });
      await fsp.writeFile(path.join(leakDir, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-types', version: '1.0.0', types: path.join(leakDir, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), "import 'leak-types';\nexport const good: number = 1;\n");
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) rec(15, 'nm-sibling-types', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      else verdictFromList(result, listed, leakDir, 'nm-sibling-types');
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 8. NEW leftover hunt: paths remap to scratch sibling (walker may catch first)
  {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-paths-'));
    const forcedScratch = path.join(tmpHome, 'claim-guard-index-PATHS');
    const leakDir = `${forcedScratch}x`;
    const pin = await pinScratch(tmpHome, forcedScratch);
    const fx = await seed({
      compilerOptions: {
        ...tsOpts,
        baseUrl: '.',
        paths: { '@hidden/*': [path.join(leakDir, '*').replace(/\\/g, '/')] }
      },
      include: ['src/index.ts']
    });
    try {
      await fsp.mkdir(leakDir, { recursive: true });
      await fsp.writeFile(path.join(leakDir, 'mod.ts'), 'export const n: number = 1;\n');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'import { n } from "@hidden/mod";\nexport const x: number = n;\n');
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot, pin.env);
      if (!compiled.ok) rec(15, 'scratch-sibling-paths', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      else verdictFromList(result, listed, leakDir, 'scratch-sibling-paths');
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 9. Can a commit that does not compile still land? (without the escape hatch)
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /does not compile|TS2322|REFUSING/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'broken-compile-refused', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 10. pinning scratch alone must not break honest green (control for 5)
  {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-pin-'));
    const forcedScratch = path.join(tmpHome, 'claim-guard-index-PINOK');
    const pin = await pinScratch(tmpHome, forcedScratch);
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot, pin.env);
      rec(15, 'pin-scratch-honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ---- item 2 on live dist (ebd70ec did not touch these files; stale dist would be a hole) ----
  const debris = [
    ['empty-bytes', ''],
    ['unparseable', '{not-json'],
    ['missing-pid', JSON.stringify({ at: 'now' })],
    ['string-pid', JSON.stringify({ pid: String(process.pid) })],
    ['float-pid', JSON.stringify({ pid: 1.5 })],
    ['unsafe-int', JSON.stringify({ pid: 1e308 })]
  ];
  for (const [name, body] of debris) {
    await withEvidenceRoot(name, async (dir, store) => {
      await fsp.writeFile(lockPath(dir), body);
      const t0 = Date.now();
      try {
        await store.record({ workId: 20, subject: name, statement: 'probe', recordedBy: 'grok' });
        const ms = Date.now() - t0;
        rec(2, `debris-${name}`, ms < 2000 ? 'PASS' : 'FAIL', `recovered in ${ms}ms`);
      } catch (error) {
        rec(2, `debris-${name}`, 'FAIL', error.message);
      }
    });
  }

  await withEvidenceRoot('lock-dir', async (dir, store) => {
    await fsp.mkdir(lockPath(dir), { recursive: true });
    const t0 = Date.now();
    try {
      await store.record({ workId: 20, subject: 'lock-dir', statement: 'probe', recordedBy: 'grok' });
      const ms = Date.now() - t0;
      rec(2, 'debris-lock-is-directory', ms < 2000 ? 'PASS' : 'FAIL', `recovered in ${ms}ms`);
    } catch (error) {
      rec(2, 'debris-lock-is-directory', 'FAIL', error.message);
    }
  });

  await withEvidenceRoot('live-pid', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const t0 = Date.now();
    let threw = null;
    try {
      await store.record({ workId: 20, subject: 'live-pid', statement: 'probe', recordedBy: 'grok' });
    } catch (error) {
      threw = error;
    }
    const ms = Date.now() - t0;
    if (threw && /Timed out waiting for the evidence lock/i.test(threw.message) && ms >= 2000) {
      rec(2, 'live-pid-not-stolen', 'PASS', `treated as live owner, timed out in ${ms}ms`);
    } else if (!threw && ms < 2000) {
      rec(2, 'live-pid-not-stolen', 'FAIL', `stole a live-pid lock in ${ms}ms`);
    } else {
      rec(2, 'live-pid-not-stolen', 'FAIL', threw ? `${ms}ms ${threw.message}` : `unexpected success in ${ms}ms`);
    }
  });

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-op-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      const closed = await store.operatorCloseRecovery('grok', source.seq, 'stranded');
      const records = await store.listEvidence(source.seq);
      const summary = records.find((item) => item.consolidatedFrom !== undefined);
      const live = records.filter((item) => !item.supersededBy && !item.invalidateReason);
      rec(2, 'operatorCloseRecovery-compacts',
        closed && summary && summary.consolidatedFrom.length === 3 && live.length === 1 ? 'PASS' : 'FAIL',
        `closed=${Boolean(closed)} summary=${summary && summary.consolidatedFrom.length} live=${live.length}`);
    } catch (error) {
      rec(2, 'operatorCloseRecovery-compacts', 'FAIL', error.message);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r20-inherit-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      for (let i = 0; i < 3; i += 1) {
        await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
      }
      await store.reassignBaton({ to: 'codex', reason: 'grok went dark', force: true });
      const records = await store.listEvidence(source.seq);
      const summary = records.find((item) => item.consolidatedFrom !== undefined);
      const live = records.filter((item) => !item.supersededBy && !item.invalidateReason);
      rec(2, 'inherit-does-not-compact',
        !summary && live.length === 3 ? 'PASS' : 'FAIL',
        `summary=${Boolean(summary)} live=${live.length}`);
    } catch (error) {
      rec(2, 'inherit-does-not-compact', 'FAIL', error.message);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const summary = {
    against: `HEAD ${head} live scripts/claim-guard-cli.js + dist/`,
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r20-grok-out.json'), JSON.stringify(summary, null, 2));
  const verdict = [
    `# r20 — first attack on committed HEAD ${head}`,
    '',
    `Instrument: tmp-audit-r20-grok.cjs`,
    `Live hook: scripts/claim-guard-cli.js`,
    `Live dist: dist/evidence.js + dist/mailbox.js`,
    '',
    `PASS ${summary.pass} / FAIL ${summary.fail} / NOTE ${summary.note}`,
    '',
    ...results.map((r) => `- [${r.status}] item ${r.item} / ${r.name}: ${r.detail.split('\n')[0]}`)
  ].join('\n');
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r20-grok-verdict.md'), `${verdict}\n`);
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
