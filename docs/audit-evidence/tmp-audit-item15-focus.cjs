'use strict';
/** Focused item-15 attacks. Does not touch src/ or tests/. */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');

function rec(name, status, detail) {
  console.log(`[${status}] ${name}: ${detail}`);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function runGuard(repo, root) {
  try {
    const out = execFileSync(process.execPath, [
      path.join(__dirname, 'scripts', 'claim-guard-cli.js'),
      '--repo', repo, '--root', root, '--seat', 'grok'
    ], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

(async () => {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-15f-'));
  try {
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'audit@example.com']);
    git(repo, ['config', 'user.name', 'audit']);
    await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const ok: number = 1;\n');
    const goodCfg = JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src']
    }, null, 2);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), goodCfg);
    fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(repo, 'node_modules'), 'junction');

    const store = new MailboxStore(repo);
    await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
    await store.claim({ agent: 'grok', paths: ['src'], why: 'item 15' });
    await store.claim({ agent: 'grok', paths: ['tsconfig.json'], why: 'item 15 cfg' });

    git(repo, ['add', 'src/index.ts', 'src/ok.ts', 'tsconfig.json']);
    git(repo, ['commit', '-m', 'good']);

    // Worktree tsconfig includes only ok.ts; staged index.ts is a type error; index tsconfig still includes src.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src/ok.ts']
    }, null, 2));
    const narrowed = runGuard(repo, repo);
    rec('worktree-tsconfig-narrow-include',
      narrowed.code === 0 ? 'FAIL' : 'PASS',
      `code=${narrowed.code} out=${narrowed.out.slice(0, 500)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // Stage a broken tsconfig, restore a good worktree copy. Guard copies worktree tsconfig over the index.
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), '{ this is not json\n');
    git(repo, ['add', 'tsconfig.json']);
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), goodCfg);
    const stagedBad = runGuard(repo, repo);
    rec('staged-broken-tsconfig-good-worktree',
      stagedBad.code === 0 ? 'FAIL' : 'PASS',
      `code=${stagedBad.code} out=${stagedBad.out.slice(0, 500)}`);
    git(repo, ['reset', '--hard', 'HEAD']);

    // Combined: staged type error + worktree tsconfig that only typechecks ok.ts.
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = "broken";\n');
    git(repo, ['add', 'src/index.ts']);
    await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
    await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
      include: ['src/ok.ts']
    }, null, 2));
    const combo = runGuard(repo, repo);
    rec('staged-error-plus-narrow-worktree-tsconfig',
      combo.code === 0 ? 'FAIL' : 'PASS',
      `code=${combo.code} out=${combo.out.slice(0, 500)}`);
  } finally {
    await fsp.rm(repo, { recursive: true, force: true, maxRetries: 8 }).catch(() => undefined);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
