'use strict';
/**
 * Tight re-probe of the two 15b attacks that died on the claim stage.
 * Stage ONLY the intended index entries. Claim those paths.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');

function rec(name, status, detail) {
  console.log(`[${status}] ${name}: ${detail}`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function junction(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch { return false; }
}

function dirSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/D', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try { fs.symlinkSync(target, link, 'dir'); return true; }
    catch { return false; }
  }
}

function fileSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try { fs.symlinkSync(target, link, 'file'); return true; }
    catch { return false; }
  }
}

function runGuard(repo, busRoot) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe'
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function fixture(extraClaims = []) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-15c-'));
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'gate@example.com');
  git(repo, 'config', 'user.name', 'gate');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const fine: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  const linked = junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(busRoot, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  const claims = [{ path: 'src' }, { path: 'tsconfig.json' }, ...extraClaims];
  await fsp.writeFile(
    path.join(busRoot, '.ai-bus', 'runtime', 'mailbox', 'state.json'),
    JSON.stringify({ claims: { claude: claims } })
  );
  return {
    dir, repo, busRoot, linked,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

async function main() {
  // C2: tsconfig.json is an absolute file-symlink to a worktree-only config.
  // Stage ONLY tsconfig.json + the broken src files. Do not stage the symlink target.
  {
    const fx = await fixture();
    try {
      if (!fx.linked) rec('symlink-tsconfig', 'SKIP', 'no node_modules');
      else {
        const realCfg = path.join(fx.repo, 'tsconfig.real.json');
        await fsp.writeFile(realCfg, JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', 'src/index.ts', 'src/ok.ts');
        await fsp.unlink(path.join(fx.repo, 'tsconfig.json'));
        if (!fileSymlink(path.join(fx.repo, 'tsconfig.json'), realCfg)) {
          rec('symlink-tsconfig', 'SKIP', 'no file symlink');
        } else {
          git(fx.repo, 'add', 'tsconfig.json');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const ls = git(fx.repo, 'ls-files', '-s', 'tsconfig.json').trim();
          const result = runGuard(fx.repo, fx.busRoot);
          const landed = result.code === 0 && /compile OK \(staged index\)/.test(result.out);
          rec('symlink-tsconfig', landed ? 'FAIL' : (result.code === 1 ? 'PASS' : 'NOTE'),
            `ls-files=${ls} exit=${result.code} ${result.out.slice(0, 280)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  // D2: staged directory symlink (not junction) whose TARGET is the worktree src.
  // include that link. Stage broken src + the link + tsconfig. Restore worktree to good.
  {
    const fx = await fixture([{ path: 'alias-src' }]);
    try {
      if (!fx.linked) rec('dirlink-include', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', 'src/index.ts', 'src/ok.ts');
        const absSrc = path.resolve(fx.repo, 'src');
        if (!dirSymlink(path.join(fx.repo, 'alias-src'), absSrc)) {
          rec('dirlink-include', 'SKIP', 'no dir symlink');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['alias-src']
          }, null, 2));
          git(fx.repo, 'add', '-f', 'alias-src', 'tsconfig.json');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const ls = git(fx.repo, 'ls-files', '-s').trim();
          const result = runGuard(fx.repo, fx.busRoot);
          const landed = result.code === 0 && /compile OK \(staged index\)/.test(result.out);
          rec('dirlink-include', landed ? 'FAIL' : (result.code === 1 ? 'PASS' : 'NOTE'),
            `exit=${result.code}\nls-files:\n${ls}\n${result.out.slice(0, 400)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  // D3: same but use a FILE symlink as the only `files` entry, pointing at the restored worktree file.
  {
    const fx = await fixture([{ path: 'alias.ts' }]);
    try {
      if (!fx.linked) rec('filelink-files', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', 'src/index.ts', 'src/ok.ts');
        const absIndex = path.resolve(fx.repo, 'src', 'index.ts');
        if (!fileSymlink(path.join(fx.repo, 'alias.ts'), absIndex)) {
          rec('filelink-files', 'SKIP', 'no file symlink');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            files: ['alias.ts']
          }, null, 2));
          git(fx.repo, 'add', 'alias.ts', 'tsconfig.json');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const ls = git(fx.repo, 'ls-files', '-s', 'alias.ts').trim();
          const result = runGuard(fx.repo, fx.busRoot);
          const landed = result.code === 0 && /compile OK \(staged index\)/.test(result.out);
          rec('filelink-files', landed ? 'FAIL' : (result.code === 1 ? 'PASS' : 'NOTE'),
            `ls-files=${ls} exit=${result.code} ${result.out.slice(0, 320)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  // C3: tsconfig.json symlink to ABSOLUTE worktree path of the live tsconfig.json
  // (same path, rewritten after staging the broken files).
  {
    const fx = await fixture();
    try {
      if (!fx.linked) rec('symlink-tsconfig-self', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        git(fx.repo, 'add', 'src/index.ts', 'src/ok.ts');
        // Keep a real config on disk at a path we will point at AFTER replacing tsconfig.json
        const live = path.join(fx.repo, 'tsconfig.live.json');
        await fsp.writeFile(live, JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src']
        }, null, 2));
        await fsp.unlink(path.join(fx.repo, 'tsconfig.json'));
        if (!fileSymlink(path.join(fx.repo, 'tsconfig.json'), live)) {
          rec('symlink-tsconfig-self', 'SKIP', 'no file symlink');
        } else {
          git(fx.repo, 'add', 'tsconfig.json');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          const landed = result.code === 0 && /compile OK \(staged index\)/.test(result.out);
          rec('symlink-tsconfig-self', landed ? 'FAIL' : (result.code === 1 ? 'PASS' : 'NOTE'),
            `exit=${result.code} ${result.out.slice(0, 320)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
