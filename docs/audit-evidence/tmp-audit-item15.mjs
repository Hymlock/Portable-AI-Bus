import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pab = path.resolve('c:/Users/hymlo/Downloads/Projects/Portable-AI-Bus');
const guard = path.join(pab, 'scripts', 'claim-guard-cli.js');
const tscSrc = path.join(pab, 'node_modules');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

function runGuard(repo, bus, seat) {
  try {
    const out = execFileSync(process.execPath, [guard, '--root', bus, '--seat', seat, '--repo', repo], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, BUS_SEAT: seat, BUS_ROOT: bus }
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function git(repo, args) {
  return run('git', ['-C', repo, ...args]);
}

function setupRepo(label) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), label));
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), label.replace('repo', 'bus')));
  fs.mkdirSync(path.join(bus, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  fs.writeFileSync(path.join(bus, '.ai-bus', 'runtime', 'mailbox', 'state.json'), JSON.stringify({
    schema: 1, seq: 1, round: 1, agents: ['grok', 'claude'], claims: {
      grok: [
        { path: 'src', why: 'audit' },
        { path: 'tsconfig.json', why: 'audit' },
        { path: 'dummy-nm', why: 'audit' },
        { path: 'extra', why: 'audit' },
        { path: 'node_modules', why: 'audit' }
      ]
    }, halted: false,
    maxRounds: 400, haltPolicy: { atRounds: [], everyRounds: null }, baton: null
  }));
  run('git', ['init'], { cwd: repo });
  run('git', ['config', 'user.email', 'audit@example.com'], { cwd: repo });
  run('git', ['config', 'user.name', 'audit'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, rootDir: 'src' },
    include: ['src']
  }, null, 2));
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
  try {
    fs.symlinkSync(tscSrc, path.join(repo, 'node_modules'), 'junction');
  } catch (error) {
    console.log('could not junction node_modules', error.message);
  }
  run('git', ['add', 'tsconfig.json', 'src/ok.ts'], { cwd: repo });
  run('git', ['commit', '-m', 'seed'], { cwd: repo });
  return { repo, bus };
}

const results = [];
function rec(name, status, detail) {
  results.push({ name, status, detail });
  console.log(`[${status}] ${name}\n${detail}\n`);
}

// Attack A: classic — stage a type error, restore a good working tree.
// The fix should REFUSE.
{
  const { repo, bus } = setupRepo('pab-i15a-');
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = "broken";\n');
  run('git', ['add', 'src/ok.ts'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
  const r = runGuard(repo, bus, 'grok');
  rec('classic-staged-error-clean-worktree',
    r.code !== 0 && /REFUSING|does not compile/i.test(r.out) ? 'PASS' : 'FAIL',
    `exit=${r.code}\n${r.out}`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}

// Attack B: working-tree tsconfig exclude hides the staged error.
{
  const { repo, bus } = setupRepo('pab-i15b-');
  fs.writeFileSync(path.join(repo, 'src', 'bad.ts'), 'export const n: number = "broken";\n');
  run('git', ['add', 'src/bad.ts'], { cwd: repo });
  // Working tree tsconfig excludes the staged broken file. Index still has the original include-all tsconfig.
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, rootDir: 'src' },
    include: ['src'],
    exclude: ['src/bad.ts']
  }, null, 2));
  const r = runGuard(repo, bus, 'grok');
  rec('worktree-tsconfig-exclude-hides-staged-error',
    r.code !== 0 && /REFUSING|does not compile/i.test(r.out) ? 'PASS' : 'FAIL',
    `exit=${r.code}\n${r.out}\n(if PASS the guard compiled the INDEX tsconfig; if FAIL a broken commit can land)`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}

// Attack C: stage a dummy node_modules path so checkout-index creates scratch/node_modules
// and the junction fails, falling back to the working tree.
{
  const { repo, bus } = setupRepo('pab-i15c-');
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = "broken";\n');
  run('git', ['add', 'src/ok.ts'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
  fs.mkdirSync(path.join(repo, 'dummy-nm'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'dummy-nm', 'x.txt'), 'x');
  // Force a tracked node_modules entry into the index without touching the live junction.
  run('git', ['add', '-f', '--', 'dummy-nm/x.txt'], { cwd: repo });
  // Put a node_modules *file* into the index via git update-index --add --cacheinfo?
  // Simpler: write a blob named node_modules (file) into the index.
  const blob = run('git', ['hash-object', '-w', path.join(repo, 'dummy-nm', 'x.txt')], { cwd: repo }).trim();
  run('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},node_modules`], { cwd: repo });
  const r = runGuard(repo, bus, 'grok');
  rec('staged-node_modules-forces-worktree-fallback',
    r.code !== 0 && /REFUSING|does not compile/i.test(r.out) ? 'PASS' : 'FAIL',
    `exit=${r.code}\n${r.out}\n(if FAIL: fallback compiled the clean working tree and a broken commit can land)`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}

// Attack D: honest staged compile still passes
{
  const { repo, bus } = setupRepo('pab-i15d-');
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 2;\n');
  run('git', ['add', 'src/ok.ts'], { cwd: repo });
  const r = runGuard(repo, bus, 'grok');
  rec('honest-staged-compile',
    r.code === 0 && /compile OK \(staged index\)/i.test(r.out) ? 'PASS' : 'NOTE',
    `exit=${r.code}\n${r.out}`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}

// Attack E: hide the working-tree tsconfig. Guard checks worktree existence and
// SKIPPED before it ever materialises the index, even if tsconfig is staged.
{
  const { repo, bus } = setupRepo('pab-i15e-');
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = "broken";\n');
  run('git', ['add', 'src/ok.ts'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
  fs.renameSync(path.join(repo, 'tsconfig.json'), path.join(repo, 'tsconfig.json.hidden'));
  const r = runGuard(repo, bus, 'grok');
  rec('hide-worktree-tsconfig-skips-compile',
    r.code !== 0 && /REFUSING|does not compile/i.test(r.out) ? 'PASS' : 'FAIL',
    `exit=${r.code}\n${r.out}\n(if FAIL: no worktree tsconfig => SKIPPED, staged type error lands)`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}

// Attack F: stage a broken tsconfig, restore a good worktree tsconfig.
// checkout-index writes the staged one, then copyFileSync overwrites it from the worktree.
{
  const { repo, bus } = setupRepo('pab-i15f-');
  const brokenTsconfig = JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
    include: ['src', 'does-not-exist-on-purpose/**/*.ts']
  }, null, 2);
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), brokenTsconfig);
  // A staged tsconfig that would pull in a broken extra file.
  fs.mkdirSync(path.join(repo, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extra', 'bad.ts'), 'export const n: number = "broken";\n');
  const stagedTsconfig = JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
    include: ['src', 'extra']
  }, null, 2);
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), stagedTsconfig);
  run('git', ['add', 'tsconfig.json', 'extra/bad.ts'], { cwd: repo });
  // Restore a good worktree tsconfig that only includes src.
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, rootDir: 'src' },
    include: ['src']
  }, null, 2));
  const r = runGuard(repo, bus, 'grok');
  rec('staged-tsconfig-overwritten-by-worktree',
    r.code !== 0 && /REFUSING|does not compile/i.test(r.out) ? 'PASS' : 'FAIL',
    `exit=${r.code}\n${r.out}\n(if FAIL: worktree tsconfig overwrite hid the staged extra/bad.ts)`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}

console.log('===== ITEM 15 SUMMARY =====');
for (const row of results) console.log(`${row.status.padEnd(4)}  ${row.name}`);
