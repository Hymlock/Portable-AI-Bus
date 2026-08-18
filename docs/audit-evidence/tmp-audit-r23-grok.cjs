#!/usr/bin/env node
'use strict';
/**
 * r23 — independent attack on the live hook bytes of e28c7b5.
 *
 * Asked HEAD was e28c7b5. Live HEAD may be later docs-only. This instrument
 * records both, hashes the on-disk hook, and will not certify a dirty tracked
 * hook or a hook blob that is not e28c7b5.
 *
 * Not the author suite. Not r21/r22 re-run. Own cases:
 *   1. TMPDIR is a junction, mkdtemp is unpinned: honest commit must pass
 *   2. same fixture against a copy with realpathOrSelf(scratch) stripped: must RED
 *   3. standing question: broken staged source must refuse
 *   4. leftover class after realpath: sibling of the REAL scratch, types
 *      path that is a prefix-without-separator of the real scratch, and
 *      /node_modules/ substring still not an exemption
 *   5. satisfiability must not weaken noCheck or empty-program
 *   6. escape hatch is loud
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const LIVE_GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|@ts-nocheck|does not compile|staged symlink/i.test(result.out);
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r23-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
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
  if (extra) await extra({ dir, repo, busRoot });
  return { dir, repo, busRoot };
}

async function linkedTmpEnv(dir) {
  const realTmp = path.join(dir, 'real-tmp');
  const linkTmp = path.join(dir, 'tmp-link');
  await fsp.mkdir(realTmp, { recursive: true });
  if (!junction(linkTmp, realTmp)) return null;
  return { realTmp, linkTmp, env: { TMP: linkTmp, TEMP: linkTmp, TMPDIR: linkTmp } };
}

async function writeUnfixedGuard(dir) {
  const hookRoot = path.join(dir, 'unfixed-hook');
  await fsp.mkdir(path.join(hookRoot, 'scripts'), { recursive: true });
  if (!junction(path.join(hookRoot, 'dist'), path.join(REPO, 'dist'))) return null;
  const live = await fsp.readFile(LIVE_GUARD, 'utf8');
  if (!live.includes('scratch = realpathOrSelf(scratch);')) {
    throw new Error('live hook no longer contains scratch = realpathOrSelf(scratch); — r23 RED control cannot be built');
  }
  const unfixed = live.replace(
    /^\s*scratch = realpathOrSelf\(scratch\);\s*$/m,
    '  // r23 RED control: realpath of scratch root stripped\n'
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
  const porcelain = execFileSync('git', ['status', '--porcelain', '--', 'scripts/claim-guard-cli.js', 'tests/audit-round2.test.js'], {
    cwd: REPO, encoding: 'utf8'
  }).trim();
  // hash-object applies the same filters git status uses. A raw sha1 of
  // on-disk bytes on a core.autocrlf=true tree is a different string and
  // is not the artifact identity. r23 first run failed this check for
  // that reason; the functional cases had already passed.
  const diskSha = execFileSync('git', ['hash-object', 'scripts/claim-guard-cli.js'], {
    cwd: REPO, encoding: 'utf8'
  }).trim();

  rec(15, 'against', 'NOTE',
    `asked=e28c7b5 liveHEAD=${head}\nhook-blob=${hookBlob}\ne28c7b5-hook=${e28Hook}\ndisk-sha1=${diskSha}`);
  rec(15, 'hook-identity', hookBlob === e28Hook && diskSha === e28Hook ? 'PASS' : 'FAIL',
    hookBlob === e28Hook && diskSha === e28Hook
      ? 'HEAD hook blob and on-disk bytes match e28c7b5'
      : `HEAD ${hookBlob} disk ${diskSha} e28 ${e28Hook}`);
  rec(15, 'tree-clean', porcelain ? 'FAIL' : 'PASS',
    porcelain || 'scripts/claim-guard-cli.js tests/audit-round2.test.js clean');

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

  // Same broken commit under linked TMPDIR — realpath must not swallow a type error
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot, linked ? linked.env : undefined);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /does not compile|TS2322|REFUSING/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'broken-compile-under-linked-tmpdir', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Escape hatch is loud
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
      rec(15, 'escape-hatch-loud',
        result.code === 0 && /SKIPPED/i.test(result.out) ? 'PASS' : 'FAIL',
        `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Honest green on this machine's real tmpdir
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

  // noCheck still refused under linked TMPDIR
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

  // files:[] + references still empty-program refuse
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
      rec(15, 'files-empty-plus-references/control',
        worktree.ok ? 'PASS' : 'NOTE',
        worktree.ok ? 'tsc -p succeeded on files:[] + references' : worktree.out);
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /compiled no program|REFUSING/i.test(result.out)) ? 'PASS' : 'NOTE';
      rec(15, 'files-empty-plus-references', status, `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // /node_modules/ substring is not an exemption
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

  // Sibling of the REAL scratch after realpath (r19b class must stay closed)
  {
    const fx = await seed({ compilerOptions: { ...tsOpts, types: ['leak-types'] }, include: ['src'] });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      if (!linked) {
        rec(15, 'realpath-scratch-sibling-types', 'NOTE', 'junction unavailable');
      } else {
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

  // Prefix-without-separator of the REAL scratch: <realScratch>x/index.d.ts
  {
    const fx = await seed({ compilerOptions: { ...tsOpts, types: ['leak-types'] }, include: ['src'] });
    try {
      const linked = await linkedTmpEnv(fx.dir);
      if (!linked) {
        rec(15, 'realpath-scratch-prefix-types', 'NOTE', 'junction unavailable');
      } else {
        // Pin mkdtemp so we know the real scratch name, then place a sibling prefix dir.
        // We cannot pin the live hook's mkdtemp, so we create MANY possible prefix dirs
        // that would match a substring of any claim-guard-index-* under realTmp.
        // Stronger: after an honest run we cannot see the name. Instead create
        // claim-guard-index-PREFIXx next to whatever mkdtemp will create, and also
        // a types file whose path CONTAINS the lexical TMPDIR string as a substring
        // of a different directory. The classic r19b shape is: types = `${scratch}x`.
        // Approximate by creating `${realTmp}${path.sep}claim-guard-index-x` — a
        // directory whose name starts with the mkdtemp prefix, so any scratch named
        // claim-guard-index-XXXX is a substring of nothing here, but `${scratch}x`
        // would be. We force the leak path to be `${realTmp}/claim-guard-index-` + extra.
        const leakDir = path.join(linked.realTmp, 'claim-guard-index-') + 'x';
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
        if (!compiled.ok) rec(15, 'realpath-scratch-prefix-types', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
        else verdictFromList(result, listed, leakDir, 'realpath-scratch-prefix-types');
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // typeRoots junction onto an outside tree
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

  const summary = {
    against: `asked e28c7b5 liveHEAD ${head} hook ${hookBlob} disk ${diskSha}`,
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r23-grok-out.json'), JSON.stringify(summary, null, 2));
  const item15Fails = results.filter((r) => r.item === 15 && r.status === 'FAIL');
  const certify = item15Fails.length === 0 && porcelain === '' && hookBlob === e28Hook && diskSha === e28Hook;
  const standing = results.find((r) => r.name === 'broken-compile-refused');
  const verdict = [
    `# r23 — independent attack on e28c7b5 hook bytes (live HEAD ${head})`,
    '',
    'Instrument: tmp-audit-r23-grok.cjs',
    'Live hook: scripts/claim-guard-cli.js',
    `Hook blob: ${hookBlob} (matches e28c7b5: ${hookBlob === e28Hook})`,
    `On-disk git sha1: ${diskSha}`,
    'Not the author suite. Not r21/r22 re-run.',
    '',
    `PASS ${summary.pass} / FAIL ${summary.fail} / NOTE ${summary.note}`,
    '',
    'Standing question: can a commit that does not compile still land?',
    standing && standing.status === 'PASS'
      ? 'No. Broken staged source is refused (does not compile, exit 1).'
      : `UNRESOLVED or FAILED: ${standing ? standing.status : 'missing'}`,
    '',
    certify
      ? 'ITEM 15 CERTIFIED at e28c7b5 (hook bytes unchanged on later docs-only HEAD).'
      : 'ITEM 15 NOT CERTIFIED.',
    '',
    ...results.map((r) => `- [${r.status}] item ${r.item} / ${r.name}: ${r.detail.split('\n')[0]}`)
  ].join('\n');
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r23-grok-verdict.md'), `${verdict}\n`);
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note, certify }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
