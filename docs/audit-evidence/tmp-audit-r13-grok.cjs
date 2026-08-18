#!/usr/bin/env node
'use strict';
/**
 * r13 — leftover hunt on the r11-updated untracked patch, plus item 2
 * leftover hunt on the patched dist. Not HEAD. Not a re-run of r7/r12.
 *
 * New classes / spellings not attacked after r12:
 *   ${configDir} walker/tsc disagreement
 *   // @ts-nocheck and // @ts-expect-error (noCheck in the source)
 *   package.json "imports" #alias
 *   libReplacement / @typescript/lib-*
 *   JSDoc import types
 *   moduleSuffixes
 *   allowArbitraryExtensions
 *   item 2: lock path is a directory; BOM+live pid; string pid; consolidate throw
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const PATCH = path.join(REPO, 'tmp-audit-r6-patches', 'claim-guard-cli.js');
const PATCHED_DIST = path.join(REPO, 'tmp-audit-r6-patches', 'dist-patched');
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

function refused(result, extra) {
  const pat = extra
    ? new RegExp(`REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck|${extra}`, 'i')
    : /REFUSING|OUTSIDE the staged tree|compiled files outside|compiled no program|noCheck/i;
  return result.code === 1 && pat.test(result.out);
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

async function writeBus(busRoot, extraPaths = []) {
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  const paths = ['src', 'tsconfig.json', 'package.json', ...extraPaths];
  await fsp.writeFile(
    path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: paths.map((p) => ({ path: p })) } })
  );
}

async function seed(tsconfig, extraBus = []) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  await writeBus(busRoot, extraBus);
  const nm = path.join(repo, 'node_modules');
  await fsp.mkdir(nm, { recursive: true });
  junction(path.join(nm, 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
  junction(path.join(nm, '.bin'), path.join(REPO, 'node_modules', '.bin'));
  return { dir, repo, busRoot };
}

async function main() {
  const hiddenDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13-hidden-'));
  const hiddenDts = path.join(hiddenDir, 'hidden-fix.d.ts');
  await fsp.writeFile(hiddenDts, 'export type HiddenFix = number;\nexport const n: number;\n');
  const tmpHiddenName = `pab-r13-${process.pid}-hidden-fix.d.ts`;
  const tmpHidden = path.join(os.tmpdir(), tmpHiddenName);
  await fsp.writeFile(tmpHidden, 'type HiddenFix = number;\n');

  try {
    // --- ${configDir}/../ sibling of scratch: walker/tsc disagree ---
    {
      const fx = await seed({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        files: ['src/index.ts', `\${configDir}/../${tmpHiddenName}`]
      });
      try {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: HiddenFix = 1;\n');
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        const outside = listedOutside(listed.out, tmpHiddenName);
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'configDir-sibling/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'worktree tsc compiled via ${configDir}/../' : compiled.out);
        rec(15, 'configDir-sibling/list', outside.length ? 'PASS' : 'NOTE',
          outside.length ? `listFilesOnly named ${outside[0]}` : listed.out.slice(0, 400));
        rec(15, 'configDir-sibling/guard', compileOk(guard) ? 'FAIL' : refused(guard) ? 'PASS' : 'NOTE',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- honest ${configDir}/src include: must stay green ---
    {
      const fx = await seed({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['${configDir}/src']
      });
      try {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'configDir-honest/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'honest ${configDir}/src compiles' : compiled.out);
        rec(15, 'configDir-honest/guard', compileOk(guard) ? 'PASS' : 'FAIL',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- // @ts-nocheck on the sole program source ---
    {
      const fx = await seed({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['src']
      });
      try {
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          '// @ts-nocheck\nexport const broken: number = "no";\n'
        );
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'ts-nocheck-sole/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'tsc succeeds on @ts-nocheck type error' : compiled.out);
        rec(15, 'ts-nocheck-sole/guard', compileOk(guard) ? 'FAIL' : refused(guard) ? 'PASS' : 'NOTE',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- // @ts-expect-error on the only error ---
    {
      const fx = await seed({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['src']
      });
      try {
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          '// @ts-expect-error\nexport const broken: number = "no";\n'
        );
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'ts-expect-error/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'tsc succeeds on @ts-expect-error' : compiled.out);
        rec(15, 'ts-expect-error/guard', compileOk(guard) ? 'NOTE' : refused(guard) ? 'PASS' : 'NOTE',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- package.json imports #hidden -> outside .d.ts ---
    {
      const fx = await seed({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          module: 'nodenext', moduleResolution: 'nodenext'
        },
        include: ['src']
      });
      try {
        await fsp.writeFile(path.join(fx.repo, 'package.json'), JSON.stringify({
          name: 'fixture',
          type: 'module',
          imports: { '#hidden': hiddenDts.replace(/\\/g, '/') }
        }, null, 2));
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          'import { n } from "#hidden";\nexport const broken: typeof n = 1;\n'
        );
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        const outside = listedOutside(listed.out, 'hidden-fix.d.ts');
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'pkg-imports-hash/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'nodenext #imports resolved outside' : compiled.out);
        rec(15, 'pkg-imports-hash/list', outside.length ? 'PASS' : 'NOTE',
          outside.length ? `listed ${outside[0]}` : listed.out.slice(0, 400));
        rec(15, 'pkg-imports-hash/guard',
          compiled.ok && compileOk(guard) ? 'FAIL' : !compiled.ok ? 'NOTE' : refused(guard) ? 'PASS' : 'NOTE',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- libReplacement: @typescript/lib-es5 junction onto outside HiddenFix ---
    {
      const fx = await seed({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          target: 'es5', libReplacement: true
        },
        include: ['src']
      });
      try {
        const libReal = path.join(hiddenDir, 'lib-es5');
        await fsp.mkdir(libReal, { recursive: true });
        await fsp.writeFile(path.join(libReal, 'index.d.ts'), 'type HiddenFix = number;\ndeclare var Math: Math;\ninterface Math { abs(x: number): number }\n');
        await fsp.writeFile(path.join(libReal, 'package.json'), JSON.stringify({
          name: '@typescript/lib-es5',
          types: 'index.d.ts'
        }));
        const scope = path.join(fx.repo, 'node_modules', '@typescript');
        await fsp.mkdir(scope, { recursive: true });
        if (!junction(path.join(scope, 'lib-es5'), libReal)) {
          rec(15, 'libReplacement/setup', 'NOTE', 'could not junction @typescript/lib-es5');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: HiddenFix = 1;\n');
          git(fx.repo, 'add', '-A');
          const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
          const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
          const outside = listedOutside(listed.out, path.basename(hiddenDir));
          const guard = runGuard(fx.repo, fx.busRoot);
          rec(15, 'libReplacement/tsc', compiled.ok ? 'PASS' : 'NOTE',
            compiled.ok ? 'libReplacement compiled via outside lib' : compiled.out);
          rec(15, 'libReplacement/list', outside.length ? 'PASS' : 'NOTE',
            outside.length ? `listed ${outside[0]}` : listed.out.slice(0, 400));
          rec(15, 'libReplacement/guard',
            compiled.ok && compileOk(guard) ? 'FAIL' : !compiled.ok ? 'NOTE' : refused(guard) ? 'PASS' : 'NOTE',
            `code=${guard.code}\n${guard.out}`);
        }
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- JSDoc import type of an absolute outside file ---
    {
      const fx = await seed({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['src']
      });
      try {
        const abs = hiddenDts.replace(/\\/g, '/');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `/** @type {import("${abs}").HiddenFix} */\nexport const broken = 1;\n`
        );
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        const outside = listedOutside(listed.out, 'hidden-fix.d.ts');
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'jsdoc-import/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'JSDoc import compiled' : compiled.out);
        rec(15, 'jsdoc-import/list', outside.length ? 'PASS' : 'NOTE',
          outside.length ? `listed ${outside[0]}` : listed.out.slice(0, 400));
        rec(15, 'jsdoc-import/guard',
          compiled.ok && outside.length && compileOk(guard) ? 'FAIL'
            : !compiled.ok || !outside.length ? 'NOTE'
              : refused(guard) ? 'PASS' : 'NOTE',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- moduleSuffixes: import "./lib" finds lib.ios.d.ts outside via junction ---
    {
      const fx = await seed({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          moduleSuffixes: ['.ios', '']
        },
        include: ['src']
      });
      try {
        const iosReal = path.join(hiddenDir, 'ios-pkg');
        await fsp.mkdir(iosReal, { recursive: true });
        await fsp.writeFile(path.join(iosReal, 'index.ios.d.ts'), 'export type HiddenFix = number;\nexport const n: number;\n');
        await fsp.writeFile(path.join(iosReal, 'index.d.ts'), 'export type HiddenFix = number;\nexport const n: number;\n');
        await fsp.writeFile(path.join(iosReal, 'package.json'), JSON.stringify({ name: 'leak-ios', types: 'index.d.ts' }));
        if (!junction(path.join(fx.repo, 'node_modules', 'leak-ios'), iosReal)) {
          rec(15, 'moduleSuffixes/setup', 'NOTE', 'could not junction leak-ios');
        } else {
          await fsp.writeFile(
            path.join(fx.repo, 'src', 'index.ts'),
            'import { n } from "leak-ios";\nexport const broken: typeof n = 1;\n'
          );
          git(fx.repo, 'add', '-A');
          const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
          const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
          const outside = listedOutside(listed.out, path.basename(hiddenDir));
          const guard = runGuard(fx.repo, fx.busRoot);
          rec(15, 'moduleSuffixes/tsc', compiled.ok ? 'PASS' : 'NOTE',
            compiled.ok ? 'moduleSuffixes compiled via outside pkg' : compiled.out);
          rec(15, 'moduleSuffixes/list', outside.length ? 'PASS' : 'NOTE',
            outside.length ? `listed ${outside[0]}` : listed.out.slice(0, 400));
          rec(15, 'moduleSuffixes/guard',
            compiled.ok && compileOk(guard) ? 'FAIL' : !compiled.ok ? 'NOTE' : refused(guard) ? 'PASS' : 'NOTE',
            `code=${guard.code}\n${guard.out}`);
        }
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- allowArbitraryExtensions + outside .css.d.ts ---
    {
      const fx = await seed({
        compilerOptions: {
          strict: true, noEmit: true, skipLibCheck: true, types: [],
          allowArbitraryExtensions: true
        },
        include: ['src']
      });
      try {
        const cssDts = path.join(hiddenDir, 'theme.css.d.ts');
        await fsp.writeFile(cssDts, 'export const n: number;\n');
        const cssAbs = cssDts.replace(/\\/g, '/').replace(/\.d\.ts$/, '');
        await fsp.writeFile(
          path.join(fx.repo, 'src', 'index.ts'),
          `import { n } from "${cssAbs}";\nexport const broken: typeof n = 1;\n`
        );
        git(fx.repo, 'add', '-A');
        const compiled = tsc(fx.repo, ['-p', fx.repo, '--noEmit']);
        const listed = tsc(fx.repo, ['-p', fx.repo, '--listFilesOnly']);
        const outside = listedOutside(listed.out, 'theme.css.d.ts');
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'allowArbitraryExtensions/tsc', compiled.ok ? 'PASS' : 'NOTE',
          compiled.ok ? 'allowArbitraryExtensions compiled outside css.d.ts' : compiled.out);
        rec(15, 'allowArbitraryExtensions/list', outside.length ? 'PASS' : 'NOTE',
          outside.length ? `listed ${outside[0]}` : listed.out.slice(0, 400));
        rec(15, 'allowArbitraryExtensions/guard',
          compiled.ok && compileOk(guard) ? 'FAIL' : !compiled.ok ? 'NOTE' : refused(guard) ? 'PASS' : 'NOTE',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // --- honest-green control ---
    {
      const fx = await seed({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
        include: ['src']
      });
      try {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        git(fx.repo, 'add', '-A');
        const guard = runGuard(fx.repo, fx.busRoot);
        rec(15, 'honest-green/guard', compileOk(guard) ? 'PASS' : 'FAIL',
          `code=${guard.code}\n${guard.out}`);
      } finally {
        await fsp.rm(fx.dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
      }
    }

    // ---- item 2 leftovers on patched dist ----
    let EvidenceStore;
    let MailboxStore;
    try {
      ({ EvidenceStore } = require(path.join(PATCHED_DIST, 'evidence.js')));
      ({ MailboxStore } = require(path.join(PATCHED_DIST, 'mailbox.js')));
    } catch (error) {
      rec(2, 'patched-dist-load', 'FAIL', error.message);
    }

    if (EvidenceStore) {
      {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13-lockdir-'));
        try {
          const store = new EvidenceStore(dir);
          await fsp.mkdir(path.join(dir, 'evidence.json.lock'));
          const started = Date.now();
          await store.record({ workId: 7, subject: 'lock-dir', statement: 'x', recordedBy: 'grok' });
          const ms = Date.now() - started;
          rec(2, 'lock-path-is-directory', ms < 2000 ? 'PASS' : 'FAIL', `recovered in ${ms}ms`);
        } catch (error) {
          rec(2, 'lock-path-is-directory', 'FAIL', error.message);
        } finally {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
        }
      }

      {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13-lockbom-'));
        try {
          const store = new EvidenceStore(dir);
          await fsp.writeFile(
            path.join(dir, 'evidence.json.lock'),
            `\uFEFF${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}`
          );
          const started = Date.now();
          let threw = null;
          try {
            await store.record({ workId: 7, subject: 'bom-live', statement: 'x', recordedBy: 'grok' });
          } catch (error) {
            threw = error;
          }
          const ms = Date.now() - started;
          // A BOM in front of a LIVE pid must not be treated as debris (steal the lock)
          // AND must not hang 10s. Either parse-as-live (timeout is correct if we hold it)
          // or refuse quickly. Stealing in <2s while this process is the owner is FAIL.
          if (threw && /Timed out waiting for the evidence lock/i.test(threw.message) && ms >= 2000) {
            rec(2, 'bom-live-pid-not-debris', 'PASS', `treated as live owner, timed out in ${ms}ms`);
          } else if (!threw && ms < 2000) {
            rec(2, 'bom-live-pid-not-debris', 'FAIL', `stole a live-pid lock in ${ms}ms (BOM made it debris)`);
          } else {
            rec(2, 'bom-live-pid-not-debris', threw ? 'NOTE' : 'NOTE',
              threw ? `${ms}ms ${threw.message}` : `recovered in ${ms}ms`);
          }
        } catch (error) {
          rec(2, 'bom-live-pid-not-debris', 'FAIL', error.message);
        } finally {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
        }
      }

      {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13-lockstr-'));
        try {
          const store = new EvidenceStore(dir);
          await fsp.writeFile(
            path.join(dir, 'evidence.json.lock'),
            JSON.stringify({ pid: String(process.pid), at: new Date().toISOString() })
          );
          const started = Date.now();
          await store.record({ workId: 7, subject: 'string-pid', statement: 'x', recordedBy: 'grok' });
          const ms = Date.now() - started;
          // Brief: pid must be a positive integer. String is debris. Recover fast.
          rec(2, 'string-pid-is-debris', ms < 2000 ? 'PASS' : 'FAIL', `recovered in ${ms}ms`);
        } catch (error) {
          rec(2, 'string-pid-is-debris', 'FAIL', error.message);
        } finally {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
        }
      }
    }

    if (MailboxStore) {
      {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r13-opthrow-'));
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
          const leftover = await store.listEvidence(source.seq);
          rec(2, 'operatorClose-survives-consolidate-throw',
            !closeErr && closed && closed.status === 'closed' ? 'PASS' : 'FAIL',
            closeErr
              ? closeErr.message
              : `closed=${Boolean(closed)} status=${closed && closed.status} leftover=${leftover.length}`);
        } catch (error) {
          rec(2, 'operatorClose-survives-consolidate-throw', 'FAIL', error.message);
        } finally {
          await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
        }
      }
    }
  } finally {
    await fsp.rm(tmpHidden, { force: true }).catch(() => {});
    await fsp.rm(hiddenDir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r13-grok-out.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
