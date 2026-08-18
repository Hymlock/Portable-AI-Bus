#!/usr/bin/env node
'use strict';
/**
 * r19b — leftover on HEAD 1592382 after r19.
 * r19's scratch-substring case was refused by the SOURCE WALKER (absolute import).
 * That did not exercise classifyListedFiles' 
 *   comparable(real).includes(comparable(scratchRoot))
 * exemption. This one does: package.json "types" (walker skips node_modules)
 * pointing at a tsc-listed file whose path contains the scratch string.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
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
  return result.code === 1 && /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program/i.test(result.out);
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

async function seed() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'package.json' }] } })
  );
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return { dir, repo, busRoot };
}

async function main() {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r19b-tmp-'));
  const forcedScratch = path.join(tmpHome, 'claim-guard-index-FIXED');
  const leakDir = `${forcedScratch}x`;
  const preload = path.join(tmpHome, 'preload.cjs');
  await fsp.writeFile(preload, `
    const fs = require('node:fs');
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

  const fx = await seed();
  try {
    await fsp.mkdir(leakDir, { recursive: true });
    await fsp.writeFile(path.join(leakDir, 'index.d.ts'), 'export declare const n: number;\n');
    const typesAbs = path.join(leakDir, 'index.d.ts').replace(/\\/g, '/');
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
    const leaks = listedOutside(listed.out, leakDir);
    git(fx.repo, 'add', '-A');
    const result = runGuard(fx.repo, fx.busRoot, {
      NODE_OPTIONS: `--require ${JSON.stringify(preload)}`,
      TMP: tmpHome,
      TEMP: tmpHome,
      TMPDIR: tmpHome
    });
    rec('control-tsc', compiled.ok ? 'PASS' : 'NOTE', compiled.ok ? 'tsc compiled' : compiled.out);
    rec('control-listed', leaks.length ? 'PASS' : 'NOTE',
      `outside listed=${JSON.stringify(leaks)}\n${listed.out}`);
    if (!compiled.ok || !leaks.length) {
      rec('scratch-includes-via-types', 'NOTE', `not red-capable; code=${result.code}\n${result.out}`);
    } else if (compileOk(result)) {
      rec('scratch-includes-via-types', 'FAIL',
        `compile OK; listFilesOnly treated a substring-of-scratch leak as program\n${result.out}`);
    } else if (refused(result)) {
      rec('scratch-includes-via-types', 'PASS', result.out);
    } else {
      rec('scratch-includes-via-types', 'NOTE', `code=${result.code}\n${result.out}`);
    }
  } finally {
    await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
    await fsp.rm(tmpHome, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }

  const summary = {
    against: 'HEAD 1592382 classifyListedFiles includes(scratchRoot)',
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r19b-grok-out.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
