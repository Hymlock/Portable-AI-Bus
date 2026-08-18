#!/usr/bin/env node
'use strict';
/**
 * r19 — first attack on committed HEAD 1592382.
 * Live hook: scripts/claim-guard-cli.js
 * Live dist: dist/evidence.js, dist/mailbox.js
 * Not the untracked r6 patch. Not the author's suite.
 *
 * Claude's three transcription risks:
 *   1. listFilesOnly exemptions — /node_modules/ substring elsewhere must refuse
 *   2. empty-program refuse — files:[] + references; honest green must still pass
 *   3. lock — six debris shapes clear in ms; LIVE pid is waited on, not stolen
 *
 * Plus the four holes this HEAD claims to close, and two leftover classes
 * this artifact introduced (scratch-path substring in classifyListedFiles;
 * UTF-8 BOM + noCheck on the committed hook).
 */

const { execFileSync, spawnSync } = require('node:child_process');
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

function runGuard(repo, busRoot, extraEnv) {
  const env = { ...process.env, ...(extraEnv || {}) };
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19-'));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r19-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    try { await fsp.chmod(lockPath(dir), 0o666); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

const tsOpts = { strict: true, noEmit: true, skipLibCheck: true, types: [] };
const green = 'export const n: number = 1;\n';

async function main() {
  rec(15, 'against', 'NOTE', `HEAD guard ${GUARD}\nHEAD=${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()}`);

  // 1. honest green — empty-program refuse must not catch a real small project
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

  // 2. noCheck:true must refuse (hole that HEAD claims to close)
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

  // 3. UTF-8 BOM + noCheck (r17 leftover; transcription onto HEAD)
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const body = `\uFEFF${JSON.stringify({
        compilerOptions: { ...tsOpts, noCheck: true },
        include: ['src/index.ts']
      }, null, 2)}`;
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), body, 'utf8');
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /noCheck/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'bom-nocheck', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 4. bare extends that escape scratch (original hole at claim-guard-cli.js:255)
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const outsideCfg = path.join(fx.hidden, 'tsconfig.json');
      await fsp.writeFile(outsideCfg, JSON.stringify({
        compilerOptions: { ...tsOpts, noCheck: true }
      }, null, 2));
      await fsp.writeFile(
        path.join(fx.repo, 'tsconfig.json'),
        JSON.stringify({ extends: path.resolve(outsideCfg).replace(/\\/g, '/'), include: ['src/index.ts'] }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL' : refused(result) ? 'PASS' : 'NOTE';
      rec(15, 'bare-extends-outside', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 5. files:[] + references (hole 4 last live spelling)
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
        JSON.stringify({
          compilerOptions: { ...tsOpts, composite: true },
          include: ['index.ts']
        }, null, 2)
      );
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'index.ts'),
        'export const broken: number = "no";\n'
      );
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

  // 6. package.json types -> outside path containing /node_modules/ (r11)
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
      const leaks = listedOutside(listed.out, 'hidden-fix');
      git(fx.repo, 'add', '-A');
      const result = runGuard(fx.repo, fx.busRoot);
      if (!compiled.ok) {
        rec(15, 'nm-substring-types/control', 'NOTE', compiled.out);
        rec(15, 'nm-substring-types', 'NOTE', `not red-capable; guard code=${result.code}\n${result.out}`);
      } else {
        rec(15, 'nm-substring-types/control', leaks.length ? 'PASS' : 'NOTE',
          `tsc ok; outside listed=${JSON.stringify(leaks)}`);
        const status = !leaks.length ? 'NOTE'
          : compileOk(result) ? 'FAIL'
          : refused(result) ? 'PASS' : 'NOTE';
        rec(15, 'nm-substring-types', status, `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 7. type-position import of an absolute outside path (hole 3 spelling)
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const hidden = path.join(fx.hidden, 'mod.ts');
      await fsp.writeFile(hidden, 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      const spec = hidden.replace(/\\/g, '/');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `type H = import("${spec}").HiddenFix;\nexport const x: H = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const leaks = listedOutside(listed.out, fx.hidden);
      const result = runGuard(fx.repo, fx.busRoot);
      if (!worktree.ok) rec(15, 'type-position-import', 'NOTE', `worktree tsc failed\n${worktree.out}`);
      else if (!leaks.length) rec(15, 'type-position-import', 'NOTE', 'tsc compiled but did not list the outside path');
      else if (compileOk(result)) rec(15, 'type-position-import', 'FAIL', `compile OK; tsc listed outside\n${result.out}`);
      else if (refused(result)) rec(15, 'type-position-import', 'PASS', result.out);
      else rec(15, 'type-position-import', 'NOTE', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // 8. scratch-path substring in classifyListedFiles (HEAD-introduced)
  //    comparable(real).includes(comparable(scratchRoot)) treats a leak whose
  //    path merely contains the scratch string as program. We force a predictable
  //    TMP so a sibling path scratchRoot+"x" is a substring hit.
  {
    const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19-tmp-'));
    const forcedScratch = path.join(tmpHome, 'claim-guard-index-FIXED');
    const leakDir = `${forcedScratch}x`;
    const preload = path.join(tmpHome, 'preload.cjs');
    await fsp.writeFile(preload, `
      const fs = require('node:fs');
      const path = require('node:path');
      const forced = ${JSON.stringify(forcedScratch)};
      const orig = fs.mkdtempSync;
      fs.mkdtempSync = function(prefix, options) {
        if (String(prefix).includes('claim-guard-index-')) {
          fs.mkdirSync(forced, { recursive: true });
          return forced;
        }
        return orig.call(this, prefix, options);
      };
    `);
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.mkdir(leakDir, { recursive: true });
      await fsp.writeFile(path.join(leakDir, 'mod.ts'), 'export type HiddenFix = number;\nexport const n: HiddenFix = 1;\n');
      const spec = path.join(leakDir, 'mod.ts').replace(/\\/g, '/');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        `type H = import("${spec}").HiddenFix;\nexport const x: H = 1;\n`
      );
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const listed = tsc(fx.repo, ['-p', '.', '--listFilesOnly']);
      const leaks = listedOutside(listed.out, leakDir);
      const result = runGuard(fx.repo, fx.busRoot, {
        NODE_OPTIONS: `--require ${preload.replace(/\\/g, '/')}`,
        TMP: tmpHome,
        TEMP: tmpHome,
        TMPDIR: tmpHome
      });
      // Preload is a measurement aid (predictable scratch name). The leak path
      // is a real tsc-listed file outside scratch whose string contains scratch.
      if (!leaks.length) {
        rec(15, 'scratch-substring-includes', 'NOTE', `tsc did not list the sibling leak\n${listed.out}`);
      } else if (compileOk(result)) {
        rec(15, 'scratch-substring-includes', 'FAIL',
          `compile OK; listed leak path contains scratch as substring\nleaks=${JSON.stringify(leaks)}\n${result.out}`);
      } else if (refused(result)) {
        rec(15, 'scratch-substring-includes', 'PASS', result.out);
      } else {
        rec(15, 'scratch-substring-includes', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ---- item 2 on HEAD dist ----
  const debris = [
    ['empty-bytes', ''],
    ['unparseable', '{not-json'],
    ['missing-pid', JSON.stringify({ at: 'now' })],
    ['string-pid', JSON.stringify({ pid: String(process.pid), at: new Date().toISOString() })],
    ['float-pid', JSON.stringify({ pid: 1.5, at: new Date().toISOString() })],
    ['unsafe-int', JSON.stringify({ pid: 1e308, at: new Date().toISOString() })]
  ];
  for (const [name, body] of debris) {
    await withEvidenceRoot(name, async (dir, store) => {
      await fsp.writeFile(lockPath(dir), body);
      const t0 = Date.now();
      try {
        await store.record({ workId: 19, subject: name, statement: 'probe', recordedBy: 'grok' });
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
      await store.record({ workId: 19, subject: 'lock-dir', statement: 'probe', recordedBy: 'grok' });
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
      await store.record({ workId: 19, subject: 'live-pid', statement: 'probe', recordedBy: 'grok' });
    } catch (error) {
      threw = error;
    }
    const ms = Date.now() - t0;
    if (threw && /Timed out waiting for the evidence lock/i.test(threw.message) && ms >= 2000) {
      rec(2, 'live-pid-not-stolen', 'PASS', `treated as live owner, timed out in ${ms}ms`);
    } else if (!threw && ms < 2000) {
      rec(2, 'live-pid-not-stolen', 'FAIL', `stole a live-pid lock in ${ms}ms`);
    } else {
      rec(2, 'live-pid-not-stolen', 'FAIL',
        threw ? `${ms}ms ${threw.message}` : `unexpected success in ${ms}ms`);
    }
  });

  await withEvidenceRoot('bom-live-pid', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), `\uFEFF${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}`);
    const t0 = Date.now();
    let threw = null;
    try {
      await store.record({ workId: 19, subject: 'bom-live', statement: 'probe', recordedBy: 'grok' });
    } catch (error) {
      threw = error;
    }
    const ms = Date.now() - t0;
    if (threw && /Timed out waiting for the evidence lock/i.test(threw.message) && ms >= 2000) {
      rec(2, 'bom-live-pid-not-debris', 'PASS', `treated as live owner, timed out in ${ms}ms`);
    } else if (!threw && ms < 2000) {
      rec(2, 'bom-live-pid-not-debris', 'FAIL', `stole a BOM+live-pid lock in ${ms}ms`);
    } else {
      rec(2, 'bom-live-pid-not-debris', 'FAIL',
        threw ? `${ms}ms ${threw.message}` : `unexpected success in ${ms}ms`);
    }
  });

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19-op-'));
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
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19-inherit-'));
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

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19-opthrow-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'started');
      await store.recordEvidence({ agent: 'grok', subject: 'step-0', statement: 'did 0', workId: source.seq });
      const original = store.evidence.consolidate.bind(store.evidence);
      store.evidence.consolidate = async () => {
        throw new Error('forced consolidate failure');
      };
      let closed;
      let closeErr = null;
      try {
        closed = await store.operatorCloseRecovery('grok', source.seq, 'stranded');
      } catch (error) {
        closeErr = error;
      }
      store.evidence.consolidate = original;
      rec(2, 'operatorClose-survives-consolidate-throw',
        !closeErr && closed && closed.status === 'closed' ? 'PASS' : 'FAIL',
        closeErr ? closeErr.message : `closed=${Boolean(closed)} status=${closed && closed.status}`);
    } catch (error) {
      rec(2, 'operatorClose-survives-consolidate-throw', 'FAIL', error.message);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const summary = {
    against: 'HEAD 1592382 live scripts/claim-guard-cli.js + dist/',
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r19-grok-out.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
