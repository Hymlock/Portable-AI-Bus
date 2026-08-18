#!/usr/bin/env node
'use strict';
/**
 * r21 — first attack on the e28c7b5 hook bytes (scratch root is realpath'd).
 *
 * Current HEAD may be a later docs-only commit. This instrument records both
 * HEAD and the scripts/claim-guard-cli.js blob, and refuses to treat a dirty
 * tracked hook as the certified artifact.
 *
 * Not the author's suite. Not r20 re-run. The new class is: os.tmpdir() itself
 * is a junction, mkdtempSync is NOT pinned, and an honest commit must still
 * pass. The RED control is the same fixture against a copy of the hook with
 * `scratch = realpathOrSelf(scratch)` deleted.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const LIVE_GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
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

function runGuard(guard, repo, busRoot, extraEnv) {
  const env = { ...process.env, ...(extraEnv || {}) };
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r21-'));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r21-ev-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    try { await fsp.chmod(lockPath(dir), 0o666); } catch { /* ignore */ }
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function linkedTmpEnv(dir) {
  const realTmp = path.join(dir, 'real-tmp');
  const linkTmp = path.join(dir, 'tmp-link');
  await fsp.mkdir(realTmp, { recursive: true });
  if (!junction(linkTmp, realTmp)) return null;
  return {
    realTmp,
    linkTmp,
    env: { TMP: linkTmp, TEMP: linkTmp, TMPDIR: linkTmp }
  };
}

async function writeUnfixedGuard(dir) {
  const hookRoot = path.join(dir, 'unfixed-hook');
  await fsp.mkdir(path.join(hookRoot, 'scripts'), { recursive: true });
  if (!junction(path.join(hookRoot, 'dist'), path.join(REPO, 'dist'))) return null;
  const live = await fsp.readFile(LIVE_GUARD, 'utf8');
  if (!live.includes('scratch = realpathOrSelf(scratch);')) {
    throw new Error('live hook no longer contains scratch = realpathOrSelf(scratch); — r21 RED control cannot be built');
  }
  const unfixed = live.replace(
    /^\s*scratch = realpathOrSelf\(scratch\);\s*$/m,
    '  // r21 RED control: realpath of scratch root stripped\n'
  );
  if (unfixed === live || unfixed.includes('scratch = realpathOrSelf(scratch);')) {
    throw new Error('failed to strip realpathOrSelf(scratch) from the unfixed copy');
  }
  const dest = path.join(hookRoot, 'scripts', 'claim-guard-cli.js');
  await fsp.writeFile(dest, unfixed);
  return dest;
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
  const hookBlob = execFileSync('git', ['rev-parse', 'HEAD:scripts/claim-guard-cli.js'], { cwd: REPO, encoding: 'utf8' }).trim();
  const e28Hook = execFileSync('git', ['rev-parse', 'e28c7b5:scripts/claim-guard-cli.js'], { cwd: REPO, encoding: 'utf8' }).trim();
  const porcelain = execFileSync('git', ['status', '--porcelain', '--', 'scripts/claim-guard-cli.js', 'src/evidence.ts', 'src/mailbox.ts', 'tests/audit-round2.test.js'], {
    cwd: REPO, encoding: 'utf8'
  }).trim();

  rec(15, 'against', 'NOTE', `HEAD=${head}\nhook-blob=${hookBlob}\ne28c7b5-hook=${e28Hook}\nlive ${LIVE_GUARD}`);
  if (hookBlob !== e28Hook) {
    rec(15, 'hook-identity', 'FAIL', `HEAD hook ${hookBlob} is not the e28c7b5 hook ${e28Hook}; this is a different artifact`);
  } else {
    rec(15, 'hook-identity', 'PASS', 'HEAD hook blob matches e28c7b5');
  }
  if (porcelain) {
    rec(15, 'tree-clean', 'FAIL', `tracked repair paths are dirty; will not certify a moving tree\n${porcelain}`);
  } else {
    rec(15, 'tree-clean', 'PASS', 'scripts/claim-guard-cli.js src/evidence.ts src/mailbox.ts tests/audit-round2.test.js clean');
  }

  // ---- e28c7b5 class: TMPDIR is a junction; mkdtemp is not pinned ----
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      if (!linked) {
        rec(15, 'linked-tmpdir-honest-green', 'NOTE', 'directory junctions unavailable');
        rec(15, 'linked-tmpdir-unfixed-red', 'NOTE', 'skipped: no junction');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');

        const live = runGuard(LIVE_GUARD, fx.repo, fx.busRoot, linked.env);
        rec(15, 'linked-tmpdir-honest-green', compileOk(live) ? 'PASS' : 'FAIL',
          `code=${live.code}\nTMPDIR=${linked.linkTmp} -> ${linked.realTmp}\n${live.out}`);

        const unfixed = await writeUnfixedGuard(fx.dir);
        if (!unfixed) {
          rec(15, 'linked-tmpdir-unfixed-red', 'NOTE', 'could not junction dist for the unfixed hook copy');
        } else {
          const broken = runGuard(unfixed, fx.repo, fx.busRoot, linked.env);
          const wentRed = broken.code === 1 && !compileOk(broken);
          rec(15, 'linked-tmpdir-unfixed-red', wentRed ? 'PASS' : 'FAIL',
            `unfixed hook must refuse an honest commit when TMPDIR is a link; code=${broken.code}\n${broken.out}`);
        }
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Leak must still refuse when TMPDIR is a junction (realpath must not over-exempt).
  {
    const fx = await seed({ compilerOptions: { ...tsOpts, types: ['leak-types'] }, include: ['src'] });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      if (!linked) {
        rec(15, 'linked-tmpdir-outside-types', 'NOTE', 'directory junctions unavailable');
      } else {
        const leakDir = path.join(fx.dir, 'hidden-fix');
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
        const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot, linked.env);
        if (!compiled.ok) rec(15, 'linked-tmpdir-outside-types', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
        else verdictFromList(result, listed, leakDir, 'linked-tmpdir-outside-types');
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Satisfiability fix must not weaken noCheck.
  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, noCheck: true },
      include: ['src/index.ts']
    });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot, linked ? linked.env : undefined);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /noCheck/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'linked-tmpdir-nocheck', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Standing: honest green on this machine's real tmpdir
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      rec(15, 'honest-green', compileOk(result) ? 'PASS' : 'FAIL', `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Standing: noCheck on real tmpdir
  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, noCheck: true },
      include: ['src/index.ts']
    });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /noCheck/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'nocheck-true', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Standing: files:[] + references (hole 4)
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
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
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

  // Standing: /node_modules/ substring is not an exemption
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src'] });
    try {
      const outsideDir = path.join(fx.dir, 'smuggle', 'node_modules', 'hidden-fix');
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'leak-types');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'leak-types', version: '1.0.0', types: path.join(outsideDir, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "leak-types";\nexport const broken: number = n;\n'
      );
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', '-A');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      if (!compiled.ok) rec(15, 'nm-substring-types', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      else verdictFromList(result, listed, 'hidden-fix', 'nm-substring-types');
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Standing question: can a commit that does not compile still land?
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /does not compile|TS2322|REFUSING/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'broken-compile-refused', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Escape hatch still works and is loud (item 6: an unsatisfiable guard gets bypassed)
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const env = { ...process.env, BUS_ALLOW_BROKEN_BUILD: '1' };
      let result;
      try {
        const out = execFileSync(process.execPath, [LIVE_GUARD, '--repo', fx.repo, '--seat', 'claude', '--root', fx.busRoot], {
          cwd: fx.repo, encoding: 'utf8', stdio: 'pipe', env
        });
        result = { code: 0, out };
      } catch (error) {
        result = { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
      }
      const status = result.code === 0 && /SKIPPED/i.test(result.out) ? 'PASS' : 'FAIL';
      rec(15, 'escape-hatch-loud', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // NEW leftover hunt: rootDir is a junction onto an outside tree
  {
    const fx = await seed(null);
    try {
      const leakDir = path.join(fx.dir, 'outside-root');
      await fsp.mkdir(path.join(leakDir, 'src'), { recursive: true });
      await fsp.writeFile(path.join(leakDir, 'src', 'index.ts'), green);
      const rootLink = path.join(fx.repo, 'rooted');
      if (!junction(rootLink, leakDir)) {
        rec(15, 'rootDir-junction-outside', 'NOTE', 'junction unavailable');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { ...tsOpts, rootDir: 'rooted' },
          include: ['rooted/src/index.ts']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
        if (!compiled.ok) rec(15, 'rootDir-junction-outside', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
        else verdictFromList(result, listed, leakDir, 'rootDir-junction-outside');
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // NEW leftover hunt: typeRoots package is a junction onto an outside tree
  {
    const fx = await seed({
      compilerOptions: { ...tsOpts, typeRoots: ['./node_modules/@types'], types: ['hidden-fix'] },
      include: ['src/index.ts']
    });
    try {
      const leakDir = path.join(fx.dir, 'hidden-typings');
      await fsp.mkdir(leakDir, { recursive: true });
      await fsp.writeFile(path.join(leakDir, 'index.d.ts'), 'declare const leaked: number;\n');
      const atTypes = path.join(fx.repo, 'node_modules', '@types');
      await fsp.mkdir(atTypes, { recursive: true });
      if (!junction(path.join(atTypes, 'hidden-fix'), leakDir)) {
        rec(15, 'typeroots-junction-outside', 'NOTE', 'junction unavailable');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = leaked;\n');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
        if (!compiled.ok) rec(15, 'typeroots-junction-outside', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
        else verdictFromList(result, listed, leakDir, 'typeroots-junction-outside');
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // NEW leftover hunt: extends a file whose realpath is outside scratch
  {
    const fx = await seed(null);
    try {
      await fsp.writeFile(path.join(fx.hidden, 'base.json'), JSON.stringify({
        compilerOptions: tsOpts
      }, null, 2));
      const extLink = path.join(fx.repo, 'base.json');
      try { fs.symlinkSync(path.join(fx.hidden, 'base.json'), extLink); } catch { /* ignore */ }
      await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
        extends: './base.json',
        compilerOptions: { types: [] },
        include: ['src/index.ts']
      }, null, 2));
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      // If the symlink staged as 120000, the hook should refuse staged symlink.
      // If git followed the bytes, this is not a leak (index stores the file).
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const staged = git(fx.repo, 'ls-files', '-s', 'base.json');
      if (/^120000\s/.test(staged)) {
        const status = compileOk(result) ? 'FAIL' : (refused(result) ? 'PASS' : 'NOTE');
        rec(15, 'extends-symlink-outside', status, `staged=${staged.trim()} code=${result.code}\n${result.out}`);
      } else {
        rec(15, 'extends-symlink-outside', 'NOTE', `git stored bytes not a symlink; not red-capable\n${staged}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // NEW leftover hunt: sibling of the realpath'd scratch (r19b class still closed after realpath)
  {
    const fx = await seed({ compilerOptions: { ...tsOpts, types: ['leak-types'] }, include: ['src'] });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      if (!linked) {
        rec(15, 'realpath-scratch-sibling-types', 'NOTE', 'junction unavailable');
      } else {
        // After realpath, scratch lives under realTmp. A sibling of that real directory
        // must still be outside.
        const leakDir = path.join(linked.realTmp, 'claim-guard-index-SIBLING');
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
        const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot, linked.env);
        if (!compiled.ok) rec(15, 'realpath-scratch-sibling-types', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
        else verdictFromList(result, listed, leakDir, 'realpath-scratch-sibling-types');
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ---- item 2: e28c7b5 did not touch these files; stale dist would still be a hole ----
  for (const [name, body] of [
    ['empty-bytes', ''],
    ['unparseable', '{not-json'],
    ['missing-pid', JSON.stringify({ at: 'now' })]
  ]) {
    await withEvidenceRoot(name, async (dir, store) => {
      await fsp.writeFile(lockPath(dir), body);
      const t0 = Date.now();
      try {
        await store.record({ workId: 21, subject: name, statement: 'probe', recordedBy: 'grok' });
        const ms = Date.now() - t0;
        rec(2, `debris-${name}`, ms < 2000 ? 'PASS' : 'FAIL', `recovered in ${ms}ms`);
      } catch (error) {
        rec(2, `debris-${name}`, 'FAIL', error.message);
      }
    });
  }

  await withEvidenceRoot('live-pid', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const t0 = Date.now();
    let threw = null;
    try {
      await store.record({ workId: 21, subject: 'live-pid', statement: 'probe', recordedBy: 'grok' });
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
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r21-op-'));
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

  const summary = {
    against: `HEAD ${head} hook ${hookBlob} (e28c7b5=${e28Hook})`,
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r21-grok-out.json'), JSON.stringify(summary, null, 2));
  const failRows = results.filter((r) => r.status === 'FAIL');
  const item15Fails = failRows.filter((r) => r.item === 15);
  const certify = item15Fails.length === 0 && porcelain === '' && hookBlob === e28Hook;
  const verdict = [
    `# r21 — attack on e28c7b5 hook bytes (HEAD ${head})`,
    '',
    'Instrument: tmp-audit-r21-grok.cjs',
    'Live hook: scripts/claim-guard-cli.js',
    `Hook blob: ${hookBlob} (matches e28c7b5: ${hookBlob === e28Hook})`,
    'Live dist: dist/evidence.js + dist/mailbox.js (item 2 spot-check only)',
    '',
    `PASS ${summary.pass} / FAIL ${summary.fail} / NOTE ${summary.note}`,
    '',
    certify
      ? 'ITEM 15 CERTIFIED at e28c7b5 (hook bytes unchanged on later docs-only HEAD).'
      : 'ITEM 15 NOT CERTIFIED.',
    'Item 2 remains certified at 1592382; this wake only spot-checked live dist.',
    '',
    ...results.map((r) => `- [${r.status}] item ${r.item} / ${r.name}: ${r.detail.split('\n')[0]}`)
  ].join('\n');
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r21-grok-verdict.md'), `${verdict}\n`);
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note, certify }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
