'use strict';
/**
 * Focused follow-up: does tsc -p compile a valid composite project-reference
 * whose include is the worktree? And does the walker refuse it?
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}
function junction(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
function runGuard(repo, busRoot) {
  const merged = { ...process.env };
  delete merged.BUS_ALLOW_BROKEN_BUILD;
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe', env: merged
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function main() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4d-ref-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  await fsp.mkdir(path.join(repo, 'packages', 'lib', 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'packages', 'lib', 'src', 'index.ts'), 'export const lib: number = 1;\n');
  const worktreeSrc = path.join(repo, 'src').replace(/\\/g, '/');
  await fsp.writeFile(path.join(repo, 'packages', 'lib', 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true, skipLibCheck: true, types: [],
      composite: true, declaration: true, outDir: 'dist', rootDir: 'src'
    },
    include: [worktreeSrc]
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    files: [],
    references: [{ path: './packages/lib' }]
  }, null, 2));
  await fsp.mkdir(path.join(busRoot, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  await fsp.writeFile(
    path.join(busRoot, '.ai-bus', 'runtime', 'mailbox', 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: 'packages' }] } })
  );
  if (!junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'))) {
    console.log(JSON.stringify({ status: 'SKIP', reason: 'no junction' }));
    return;
  }
  // Attack: staged type error. Two runs — worktree restored vs worktree left broken.
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  git(repo, 'add', '-A');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  const restored = runGuard(repo, busRoot);
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
  const leftBroken = runGuard(repo, busRoot);
  console.log(JSON.stringify({
    restored: {
      code: restored.code,
      out: restored.out,
      compileOk: restored.code === 0 && /compile OK/.test(restored.out)
    },
    leftBroken: {
      code: leftBroken.code,
      out: leftBroken.out,
      namedWorktree: /[.][.][\\/].*repo[\\/]src[\\/]index/.test(leftBroken.out) || leftBroken.out.includes(path.join(repo, 'src', 'index.ts')),
      compileOk: leftBroken.code === 0 && /compile OK/.test(leftBroken.out)
    }
  }, null, 2));
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
