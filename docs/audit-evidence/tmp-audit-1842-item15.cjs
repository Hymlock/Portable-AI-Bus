'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function runGuard(repo) {
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'scripts', 'claim-guard-cli.js'),
      '--repo', repo, '--root', repo, '--seat', 'grok'
    ], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function rec(name, status, detail) {
  console.log(`[${status}] ${name}: ${detail}`);
}

(async () => {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-1842-15b-'));
  try {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'audit@example.com']);
    git(repo, ['config', 'user.name', 'audit']);
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const ok: number = 1;\n');
    const goodTsconfig = JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src']
    }, null, 2);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), goodTsconfig);
    fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(repo, 'node_modules'), 'junction');

    const store = new MailboxStore(repo);
    await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
    await store.claim({ agent: 'grok', paths: ['src'], why: 'item 15' });

    git(repo, ['add', 'src/index.ts', 'src/ok.ts', 'tsconfig.json']);
    git(repo, ['commit', '-m', 'good']);

    // A. original attack
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    const a = runGuard(repo);
    rec('A original staged-broken/good-worktree',
      a.code !== 0 && /does not compile/i.test(a.out) ? 'PASS' : 'FAIL',
      `code=${a.code} ${a.out.replace(/\s+/g, ' ').slice(0, 240)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // B. hide worktree tsconfig
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.rename(path.join(repo, 'tsconfig.json'), path.join(repo, 'tsconfig.json.bak'));
    const b = runGuard(repo);
    rec('B hide worktree tsconfig',
      b.code === 0 && /SKIPPED/i.test(b.out) ? 'FAIL' : (b.code !== 0 ? 'PASS' : 'FAIL'),
      `code=${b.code} ${b.out.replace(/\s+/g, ' ').slice(0, 240)}`);
    await fsp.rename(path.join(repo, 'tsconfig.json.bak'), path.join(repo, 'tsconfig.json'));
    git(repo, ['reset', '--hard', 'HEAD']);

    // C. worktree tsconfig noCheck:true, index still has strict tsconfig + type error
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, noCheck: true },
      include: ['src']
    }, null, 2));
    const c = runGuard(repo);
    rec('C worktree noCheck overwrites staged tsconfig',
      c.code === 0 ? 'FAIL' : 'PASS',
      `code=${c.code} ${c.out.replace(/\s+/g, ' ').slice(0, 240)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // D. worktree include only ok.ts (committed, good); staged index.ts is broken
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src/ok.ts']
    }, null, 2));
    const d = runGuard(repo);
    rec('D worktree include only ok.ts',
      d.code === 0 ? 'FAIL' : 'PASS',
      `code=${d.code} ${d.out.replace(/\s+/g, ' ').slice(0, 240)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // E. honest staged compile
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 2;\n');
    git(repo, ['add', 'src/index.ts']);
    const e = runGuard(repo);
    rec('E honest staged compiles',
      e.code === 0 && /staged index/i.test(e.out) ? 'PASS' : 'FAIL',
      `code=${e.code} ${e.out.replace(/\s+/g, ' ').slice(0, 240)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // F. force checkout-index failure → fallback to worktree
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    const f = runGuardWithBadGit(repo);
    rec('F checkout-index fail falls back to worktree',
      f.code === 0 && /WORKING TREE/i.test(f.out) ? 'FAIL' : (f.code !== 0 ? 'PASS' : 'NOTE'),
      `code=${f.code} ${f.out.replace(/\s+/g, ' ').slice(0, 300)}`);
  } finally {
    await fsp.rm(repo, { recursive: true, force: true, maxRetries: 8 }).catch(() => undefined);
  }
})().catch((err) => { console.error(err); process.exit(1); });

function runGuardWithBadGit(repo) {
  // Prepend a fake git that fails checkout-index but allows diff --cached.
  const bin = path.join(repo, 'fake-git');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'git.cmd');
  fs.writeFileSync(stub, [
    '@echo off',
    'echo %* | findstr /C:"checkout-index" >nul',
    'if not errorlevel 1 (echo fake checkout-index fail 1>&2 & exit /b 1)',
    `where /R "${process.env.ProgramFiles}\\Git" git.exe >nul 2>nul`,
    `for /f "delims=" %%I in ('where git') do (`,
    '  echo %%I | findstr /I /C:"fake-git" >nul',
    '  if errorlevel 1 (',
    '    "%%I" %*',
    '    exit /b %ERRORLEVEL%',
    '  )',
    ')',
    'exit /b 1'
  ].join('\r\n'));
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'scripts', 'claim-guard-cli.js'),
      '--repo', repo, '--root', repo, '--seat', 'grok'
    ], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin};${process.env.PATH}` }
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}
