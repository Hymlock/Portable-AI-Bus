#!/usr/bin/env node
'use strict';
/**
 * r22 — new instrument against the live committed hook + dist.
 *
 * Not r21 re-run. Not the author's tests/audit-round2.test.js.
 * Asked against 1592382; live HEAD is recorded and compared before any verdict.
 *
 * Claude's three transcription risks, plus the standing compile question:
 *   1. listFilesOnly exemptions: only real repo node_modules and the realpath of
 *      node_modules/typescript. A /node_modules/ substring elsewhere still refuses.
 *   2. empty-program refuse: files:[] + references still refuses; an honest small
 *      project is not caught by it.
 *   3. lock: six debris shapes clear in milliseconds; a LIVE pid is waited on.
 *      If live-owner can pass while debris also passes by being the same gate,
 *      the control is not a control.
 *   Standing: can a commit that does not compile still land?
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|@ts-nocheck|staged symlink|does not compile/i.test(result.out);
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r22-'));
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
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r22-ev-${name}-`));
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

function listedContains(listText, needle) {
  const n = String(needle).replace(/\\/g, '/').toLowerCase();
  return String(listText).split(/\r?\n/).some((line) => line.replace(/\\/g, '/').toLowerCase().includes(n));
}

async function main() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const asked = '1592382c0a326a18a1975ce2aaf283f8069a3a20';
  const askedShort = execFileSync('git', ['rev-parse', '--short', asked], { cwd: REPO, encoding: 'utf8' }).trim();
  const hookBlob = execFileSync('git', ['rev-parse', 'HEAD:scripts/claim-guard-cli.js'], { cwd: REPO, encoding: 'utf8' }).trim();
  const e28Hook = execFileSync('git', ['rev-parse', 'e28c7b5:scripts/claim-guard-cli.js'], { cwd: REPO, encoding: 'utf8' }).trim();
  const askedHook = execFileSync('git', ['rev-parse', `${asked}:scripts/claim-guard-cli.js`], { cwd: REPO, encoding: 'utf8' }).trim();
  const porcelain = execFileSync('git', [
    'status', '--porcelain', '--',
    'scripts/claim-guard-cli.js', 'src/evidence.ts', 'src/mailbox.ts',
    'tests/audit-round2.test.js', 'dist/evidence.js', 'dist/mailbox.js'
  ], { cwd: REPO, encoding: 'utf8' }).trim();
  const distEvidence = fs.readFileSync(path.join(REPO, 'dist', 'evidence.js'), 'utf8');
  const distHasPositivePid = /Number\.isSafeInteger\(pid\)/.test(distEvidence)
    && /evidenceProcessAlive\(pid\)/.test(distEvidence);

  rec(15, 'against', 'NOTE',
    `asked=${asked}\nliveHEAD=${head}\nasked-short=${askedShort}\n` +
    `HEAD-hook=${hookBlob}\ne28c7b5-hook=${e28Hook}\n1592382-hook=${askedHook}\n` +
    `HEAD-equals-asked=${head.startsWith(asked.slice(0, 7))}`);

  rec(15, 'hook-identity', hookBlob === e28Hook ? 'PASS' : 'FAIL',
    hookBlob === e28Hook
      ? 'live hook blob matches e28c7b5 (later than 1592382)'
      : `live hook ${hookBlob} != e28c7b5 ${e28Hook}`);

  rec(15, 'hook-vs-1592382', hookBlob === askedHook ? 'NOTE' : 'NOTE',
    hookBlob === askedHook
      ? 'live hook bytes are still 1592382'
      : `live hook is NOT 1592382 (${askedHook}); later item-15 commits changed the hook`);

  rec(15, 'tree-clean', porcelain ? 'FAIL' : 'PASS',
    porcelain || 'tracked hook/src/dist/test paths are clean');

  rec(2, 'dist-matches-positive-pid-rule', distHasPositivePid ? 'PASS' : 'FAIL',
    distHasPositivePid
      ? 'dist/evidence.js contains Number.isSafeInteger(pid) + evidenceProcessAlive(pid)'
      : 'compiled dist does not contain the committed positive-integer live-owner rule');

  // ------------------------------------------------------------------
  // ITEM 15 / Claude 1 — listFilesOnly exemptions
  // New channel: package.json "typings" (not "types") pointing at a path
  // that contains /node_modules/ but is not the repo node_modules.
  // ------------------------------------------------------------------
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src'] });
    try {
      const outsideDir = path.join(fx.hidden, 'vendor', 'node_modules', 'r22-typings-leak');
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'r22-typings');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'r22-typings',
        version: '0.0.1',
        typings: path.join(outsideDir, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "r22-typings";\nexport const ok: number = n;\n'
      );
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const listedLeak = listed.ok && listedContains(listed.out, 'r22-typings-leak');
      if (!compiled.ok) {
        rec(15, 'typings-nm-substring', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      } else if (!listedLeak) {
        rec(15, 'typings-nm-substring', 'NOTE',
          `tsc compiled but did not list the outside /node_modules/ path (typings field unused?)\n${listed.out.slice(0, 500)}`);
      } else if (compileOk(result)) {
        rec(15, 'typings-nm-substring', 'FAIL',
          `compile OK while listFilesOnly saw ${outsideDir}\n${result.out}`);
      } else if (refused(result)) {
        rec(15, 'typings-nm-substring', 'PASS',
          `refused a listed /node_modules/ path that is not the repo node_modules\n${result.out}`);
      } else {
        rec(15, 'typings-nm-substring', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Same property, new spelling: exports["."].types onto /node_modules/ outside.
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src'] });
    try {
      const outsideDir = path.join(fx.hidden, 'pkgs', 'node_modules', 'r22-exports-leak');
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'r22-exports');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'r22-exports',
        version: '0.0.1',
        exports: { '.': { types: path.join(outsideDir, 'index.d.ts').replace(/\\/g, '/'), default: './index.js' } }
      }));
      await fsp.writeFile(path.join(pkg, 'index.js'), 'module.exports = { n: 1 };\n');
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "r22-exports";\nexport const ok: number = n;\n'
      );
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const listedLeak = listed.ok && listedContains(listed.out, 'r22-exports-leak');
      if (!compiled.ok) {
        rec(15, 'exports-types-nm-substring', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      } else if (!listedLeak) {
        rec(15, 'exports-types-nm-substring', 'NOTE',
          `tsc compiled but did not list the outside exports types path\n${listed.out.slice(0, 500)}`);
      } else if (compileOk(result)) {
        rec(15, 'exports-types-nm-substring', 'FAIL',
          `compile OK while listFilesOnly saw ${outsideDir}\n${result.out}`);
      } else if (refused(result)) {
        rec(15, 'exports-types-nm-substring', 'PASS',
          `refused listed exports.types under an outside /node_modules/\n${result.out}`);
      } else {
        rec(15, 'exports-types-nm-substring', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Substring without path separators: foo_node_modules_bar is not the repo node_modules.
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src'] });
    try {
      const outsideDir = path.join(fx.hidden, 'foo_node_modules_bar');
      await fsp.mkdir(outsideDir, { recursive: true });
      await fsp.writeFile(path.join(outsideDir, 'index.d.ts'), 'export declare const n: number;\n');
      const pkg = path.join(fx.repo, 'node_modules', 'r22-substr');
      await fsp.mkdir(pkg, { recursive: true });
      await fsp.writeFile(path.join(pkg, 'package.json'), JSON.stringify({
        name: 'r22-substr',
        version: '0.0.1',
        types: path.join(outsideDir, 'index.d.ts').replace(/\\/g, '/')
      }));
      await fsp.writeFile(
        path.join(fx.repo, 'src', 'index.ts'),
        'import { n } from "r22-substr";\nexport const ok: number = n;\n'
      );
      const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      const listedLeak = listed.ok && listedContains(listed.out, 'foo_node_modules_bar');
      if (!compiled.ok) {
        rec(15, 'bare-node_modules-substring', 'NOTE', `not red-capable; tsc failed\n${compiled.out}`);
      } else if (!listedLeak) {
        rec(15, 'bare-node_modules-substring', 'NOTE',
          `tsc compiled but did not list foo_node_modules_bar\n${listed.out.slice(0, 500)}`);
      } else if (compileOk(result)) {
        rec(15, 'bare-node_modules-substring', 'FAIL',
          `compile OK; a node_modules substring without separators was treated as exempt\n${result.out}`);
      } else if (refused(result)) {
        rec(15, 'bare-node_modules-substring', 'PASS',
          `refused listed path whose name only contains the letters node_modules\n${result.out}`);
      } else {
        rec(15, 'bare-node_modules-substring', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Green control for exemptions: honest project lists typescript lib files
  // (realpath of node_modules/typescript) and still compiles.
  {
    const fx = await seed({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: false }, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
      const tsLib = path.join(REPO, 'node_modules', 'typescript', 'lib');
      const listedTs = listed.ok && listedContains(listed.out, path.join('typescript', 'lib'));
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      if (!listed.ok) {
        rec(15, 'typescript-pkg-exempt/control', 'NOTE', `listFilesOnly failed\n${listed.out}`);
      } else {
        rec(15, 'typescript-pkg-exempt/control', listedTs ? 'PASS' : 'NOTE',
          listedTs
            ? `tsc listed files under ${tsLib} (the invoked typescript package)`
            : `tsc did not list typescript/lib; exemption not exercised\n${listed.out.slice(0, 400)}`);
      }
      rec(15, 'typescript-pkg-exempt', compileOk(result) ? 'PASS' : 'FAIL',
        `honest project that loads typescript lib: code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // ITEM 15 / Claude 2 — empty-program refuse, plus honest not-caught
  // ------------------------------------------------------------------
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
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'index.ts'),
        'export const broken: number = "no";\n'
      );
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', '-A');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      rec(15, 'empty-program/tsc-succeeds', worktree.ok ? 'PASS' : 'NOTE',
        worktree.ok
          ? 'tsc -p succeeded on files:[] + references (hole 4 control still live)'
          : worktree.out);
      const status = compileOk(result) ? 'FAIL'
        : (result.code === 1 && /compiled no program/i.test(result.out)) ? 'PASS'
          : refused(result) ? 'PASS'
            : 'NOTE';
      rec(15, 'empty-program-files-empty-plus-references', status,
        `code=${result.code}\n${result.out}`);
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Honest small project must NOT be caught by the empty-program refuse.
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      if (compileOk(result)) {
        rec(15, 'empty-program-does-not-catch-honest', 'PASS',
          'honest small project printed compile OK');
      } else if (/compiled no program/i.test(result.out)) {
        rec(15, 'empty-program-does-not-catch-honest', 'FAIL',
          `empty-program refuse ate an honest project\n${result.out}`);
      } else {
        rec(15, 'empty-program-does-not-catch-honest', 'FAIL',
          `honest project did not compile OK: code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // New green: files listing the source + a real referenced project must pass.
  // If the empty-program rule is "any references key", this goes red.
  // Composite projects cannot set noEmit (TS6310); first-run fixture was
  // instrument error, not an empty-program hole.
  {
    const compositeOpts = { strict: true, composite: true, skipLibCheck: true, types: [] };
    const fx = await seed({
      compilerOptions: compositeOpts,
      files: ['src/index.ts'],
      references: [{ path: './packages/lib' }]
    });
    try {
      await fsp.mkdir(path.join(fx.repo, 'packages', 'lib'), { recursive: true });
      await fsp.writeFile(
        path.join(fx.repo, 'packages', 'lib', 'tsconfig.json'),
        JSON.stringify({ compilerOptions: compositeOpts, files: ['index.ts'] }, null, 2)
      );
      await fsp.writeFile(path.join(fx.repo, 'packages', 'lib', 'index.ts'), green);
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), green);
      git(fx.repo, 'add', '-A');
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      if (compileOk(result)) {
        rec(15, 'honest-composite-files-plus-references', 'PASS',
          'files:["src/index.ts"] + references is not treated as empty');
      } else if (/compiled no program/i.test(result.out)) {
        rec(15, 'honest-composite-files-plus-references', 'FAIL',
          `empty-program refuse caught an honest composite\n${result.out}`);
      } else {
        rec(15, 'honest-composite-files-plus-references', 'NOTE',
          `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // Standing: can a commit that does not compile still land?
  // ------------------------------------------------------------------
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const worktree = tsc(fx.repo, ['-p', '.', '--noEmit']);
      const result = runGuard(LIVE_GUARD, fx.repo, fx.busRoot);
      rec(15, 'broken-compile/tsc-fails', worktree.ok ? 'FAIL' : 'PASS',
        worktree.ok ? 'fixture did not actually fail tsc' : 'worktree tsc failed as expected');
      if (compileOk(result)) {
        rec(15, 'broken-compile-refused', 'FAIL',
          `a type error printed compile OK; a non-compiling commit can land\n${result.out}`);
      } else if (result.code === 1 && /does not compile|REFUSING/i.test(result.out)) {
        rec(15, 'broken-compile-refused', 'PASS', `code=1\n${result.out}`);
      } else {
        rec(15, 'broken-compile-refused', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // Escape hatch is explicit, not silent: env var must be named in output.
  {
    const fx = await seed({ compilerOptions: tsOpts, include: ['src/index.ts'] });
    try {
      await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const n: number = "this does not compile";\n');
      git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
      const env = { ...process.env, BUS_ALLOW_BROKEN_BUILD: '1' };
      let result;
      try {
        const stdout = execFileSync(process.execPath, [LIVE_GUARD, '--repo', fx.repo, '--seat', 'claude', '--root', fx.busRoot], {
          cwd: fx.repo, encoding: 'utf8', stdio: 'pipe', env
        });
        result = { code: 0, out: stdout };
      } catch (error) {
        result = { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
      }
      const loud = /BUS_ALLOW_BROKEN_BUILD|allow broken|escape/i.test(result.out);
      if (result.code === 0 && loud) {
        rec(15, 'escape-hatch-loud', 'PASS', `code=0 and names the hatch\n${result.out}`);
      } else if (result.code === 0 && !loud) {
        rec(15, 'escape-hatch-loud', 'FAIL', `silent success; hatch is not recorded\n${result.out}`);
      } else {
        rec(15, 'escape-hatch-loud', 'NOTE', `code=${result.code}\n${result.out}`);
      }
    } finally {
      await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // ITEM 2 / Claude 3 — six debris shapes vs LIVE pid
  // ------------------------------------------------------------------
  const debrisTimings = [];
  const debrisShapes = [
    ['empty-bytes', ''],
    ['unparseable', '{not-json'],
    ['missing-pid', JSON.stringify({ at: new Date().toISOString() })],
    ['string-pid', JSON.stringify({ pid: 'seventeen' })],
    ['float-pid', JSON.stringify({ pid: 1.5 })],
    ['negative-pid', JSON.stringify({ pid: -5 })]
  ];

  for (const [name, contents] of debrisShapes) {
    await withEvidenceRoot(name, async (dir, store) => {
      const lp = lockPath(dir);
      await fsp.writeFile(lp, contents);
      const started = Date.now();
      try {
        await store.record({ workId: 22, subject: name, statement: 'debris', recordedBy: 'grok' });
        const ms = Date.now() - started;
        debrisTimings.push(ms);
        let stillThere = false;
        try { await fsp.access(lp); stillThere = true; } catch { stillThere = false; }
        if (ms >= 2000) {
          rec(2, `debris-${name}`, 'FAIL', `blocked for ${ms}ms — debris must not hold the lock`);
        } else if (stillThere) {
          rec(2, `debris-${name}`, 'FAIL', `recovered in ${ms}ms but lock path still exists`);
        } else {
          rec(2, `debris-${name}`, 'PASS', `recovered in ${ms}ms; lock cleared`);
        }
      } catch (error) {
        rec(2, `debris-${name}`, 'FAIL', `${Date.now() - started}ms ${error.message}`);
      }
    });
  }

  let liveMs = null;
  let liveLockRemained = null;
  await withEvidenceRoot('live-pid', async (dir, store) => {
    const lp = lockPath(dir);
    await fsp.writeFile(lp, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const started = Date.now();
    let threw = null;
    try {
      await store.record({ workId: 22, subject: 'live-pid', statement: 'probe', recordedBy: 'grok' });
    } catch (error) {
      threw = error;
    }
    liveMs = Date.now() - started;
    try { await fsp.access(lp); liveLockRemained = true; } catch { liveLockRemained = false; }
    const timedOut = threw && /Timed out waiting for the evidence lock/i.test(threw.message);
    if (timedOut && liveMs >= 9000 && liveLockRemained) {
      rec(2, 'live-pid-not-stolen', 'PASS',
        `treated as live owner, timed out in ${liveMs}ms, lock file still present`);
    } else if (timedOut && liveMs >= 9000 && !liveLockRemained) {
      rec(2, 'live-pid-not-stolen', 'FAIL',
        `timed out in ${liveMs}ms but lock file was removed — the wait stole the lock`);
    } else if (!threw) {
      rec(2, 'live-pid-not-stolen', 'FAIL', `stole a live-pid lock in ${liveMs}ms`);
    } else {
      rec(2, 'live-pid-not-stolen', 'FAIL', `${liveMs}ms ${threw.message}; lockRemained=${liveLockRemained}`);
    }
  });

  // The two gates must be distinguishable. If live also clears in debris time,
  // they are the same "delete everything" gate.
  if (liveMs != null && debrisTimings.length === 6) {
    const slowestDebris = Math.max(...debrisTimings);
    const split = liveMs >= 9000 && slowestDebris < 2000;
    rec(2, 'debris-vs-live-are-different-gates', split ? 'PASS' : 'FAIL',
      `slowest debris ${slowestDebris}ms; live ${liveMs}ms; lockRemained=${liveLockRemained}`);
  }

  // New class: a STRING of this process's live pid is not a live owner.
  // The rule is "names a live POSITIVE INTEGER pid". Coercing strings would
  // make the string-pid debris case and the live-owner case the same gate.
  await withEvidenceRoot('stringified-live-pid', async (dir, store) => {
    const lp = lockPath(dir);
    await fsp.writeFile(lp, JSON.stringify({ pid: String(process.pid), at: new Date().toISOString() }));
    const started = Date.now();
    try {
      await store.record({ workId: 22, subject: 'stringified-live', statement: 'x', recordedBy: 'grok' });
      const ms = Date.now() - started;
      if (ms < 2000) {
        rec(2, 'stringified-live-pid-is-debris', 'PASS',
          `pid:"${process.pid}" recovered in ${ms}ms — string is not a live integer owner`);
      } else {
        rec(2, 'stringified-live-pid-is-debris', 'FAIL',
          `pid as string of a live process blocked ${ms}ms; coercion widened the live-owner rule`);
      }
    } catch (error) {
      const ms = Date.now() - started;
      rec(2, 'stringified-live-pid-is-debris', 'FAIL',
        `treated stringified live pid as an owner (${ms}ms): ${error.message}`);
    }
  });

  // operatorCloseRecovery still compact (transcription of the r14 mailbox patch).
  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r22-mb-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok'], 500);
      const sent = await store.send({
        from: 'claude',
        to: 'grok',
        kind: 'task',
        subject: 'r22 operator close',
        body: 'three episodes then operator close'
      });
      await store.openRecovery('grok', sent.seq, 'started');
      for (const [subject, statement] of [['ep-a', 'alpha'], ['ep-b', 'beta'], ['ep-c', 'gamma']]) {
        await store.recordEvidence({ agent: 'grok', subject, statement, workId: sent.seq });
      }
      const closed = await store.operatorCloseRecovery('grok', sent.seq, 'r22 audit close');
      const rows = await store.listEvidence(sent.seq);
      const live = rows.filter((r) => !r.supersededBy && !r.invalidateReason);
      const summary = rows.find((r) => Array.isArray(r.consolidatedFrom));
      if (closed && closed.status === 'closed' && summary && summary.consolidatedFrom.length === 3 && live.length === 1) {
        rec(2, 'operatorCloseRecovery-compacts', 'PASS',
          `closed=${closed.status === 'closed'} summary=${summary.consolidatedFrom.length} live=${live.length}`);
      } else {
        rec(2, 'operatorCloseRecovery-compacts', 'FAIL',
          `closed=${closed && closed.status} live=${live.length} summary=${summary && summary.consolidatedFrom}`);
      }
    } catch (error) {
      rec(2, 'operatorCloseRecovery-compacts', 'FAIL', error.message);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    }
  }

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const note = results.filter((r) => r.status === 'NOTE').length;
  const item15Fail = results.filter((r) => r.item === 15 && r.status === 'FAIL').length;
  const item2Fail = results.filter((r) => r.item === 2 && r.status === 'FAIL').length;

  const summary = {
    askedHead: asked,
    liveHead: head,
    hookBlob,
    e28Hook,
    askedHook,
    pass,
    fail,
    note,
    item15Fail,
    item2Fail,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r22-grok-out.json'), `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [
    '# r22 — new instrument against live committed hook + dist',
    '',
    `Asked HEAD: ${asked}`,
    `Live HEAD:  ${head}`,
    `Hook blob:  ${hookBlob} (e28c7b5=${e28Hook}; 1592382=${askedHook})`,
    '',
    `PASS ${pass} / FAIL ${fail} / NOTE ${note}`,
    `Item 15 FAILs: ${item15Fail}`,
    `Item 2 FAILs:  ${item2Fail}`,
    '',
    'Not the author suite. Not r21 re-run.',
    ''
  ];
  for (const row of results) {
    lines.push(`- [${row.status}] item ${row.item} / ${row.name}: ${row.detail.split('\n')[0]}`);
  }
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r22-grok-verdict.md'), `${lines.join('\n')}\n`);
  console.log(`\nPASS ${pass} / FAIL ${fail} / NOTE ${note}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
