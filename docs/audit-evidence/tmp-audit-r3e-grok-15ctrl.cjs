'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}
function junction(link, target) {
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-r3e-15ctrl-'));
const repo = path.join(dir, 'repo');
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.mkdirSync(path.join(repo, 'node_modules'), { recursive: true });
git(repo, 'init', '-q');
git(repo, 'config', 'user.email', 'gate@example.com');
git(repo, 'config', 'user.name', 'gate');
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
  include: ['src']
}, null, 2));
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
junction(path.join(repo, 'node_modules', 'typescript'), path.join(REPO, 'node_modules', 'typescript'));
junction(path.join(repo, 'node_modules', '.bin'), path.join(REPO, 'node_modules', '.bin'));
const busRoot = path.join(dir, 'bus');
fs.mkdirSync(path.join(busRoot, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
fs.writeFileSync(
  path.join(busRoot, '.ai-bus', 'runtime', 'mailbox', 'state.json'),
  JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } })
);
git(repo, 'add', '-A');
git(repo, 'commit', '-qm', 'seed');

const pkg = path.join(repo, 'node_modules', 'leak-config');
fs.mkdirSync(pkg, { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'leak-config', version: '1.0.0' }));
fs.writeFileSync(path.join(pkg, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
  include: [path.resolve(repo, 'src').replace(/\\/g, '/')]
}, null, 2));
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({ extends: 'leak-config/tsconfig.json' }, null, 2));
git(repo, 'add', '-A');
// Control A: worktree ALSO broken — tsc should name the WORKTREE path if it follows the leak
const bothBroken = runGuard(repo, busRoot);
console.log('BOTH_BROKEN', JSON.stringify({ code: bothBroken.code, out: bothBroken.out }));

// Control B: restore compiling worktree (the hole)
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({ extends: 'leak-config/tsconfig.json' }, null, 2));
git(repo, 'add', 'tsconfig.json');
const restored = runGuard(repo, busRoot);
console.log('RESTORED_WORKTREE', JSON.stringify({ code: restored.code, out: restored.out }));

// Honest green: stage compiling files
fs.writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
  include: ['src']
}, null, 2));
git(repo, 'add', '-A');
const honest = runGuard(repo, busRoot);
console.log('HONEST_STAGED', JSON.stringify({ code: honest.code, out: honest.out }));

fs.rmSync(dir, { recursive: true, force: true });
