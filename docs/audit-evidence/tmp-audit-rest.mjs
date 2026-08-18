import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'path';
import { MailboxStore } from './dist/mailbox.js';

function rec(name, status, detail) {
  console.log(`[${status}] ${name}\n${detail}\n`);
}

function junctionsAvailable(link, target, kind = 'J') {
  try {
    const args = kind === 'D' ? ['/c', 'mklink', '/D', link, target] : ['/c', 'mklink', '/J', link, target];
    execFileSync('cmd.exe', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Directory symlink (/D) to repo root
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i13d-'));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'bus.ts'), 'x');
  const alias = path.join(root, 'alsoroot');
  if (junctionsAvailable(alias, root, 'D')) {
    try {
      await store.claim({ agent: 'codex', paths: ['alsoroot'], why: 'dir symlink to root' });
      rec('13-dir-symlink-to-root', 'FAIL', 'mklink /D to root was accepted');
    } catch (error) {
      rec('13-dir-symlink-to-root', /whole repositor|too broad/i.test(error.message) ? 'PASS' : 'FAIL', error.message);
    }
  } else {
    rec('13-dir-symlink-to-root', 'SKIP', 'mklink /D failed');
  }
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 8 });
}

// Isolated parent junction already confirmed in tmp-audit-parent.mjs

// Item 18: atomic missing supersededAt; two-step same-recipient still enforced
{
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i18b-'));
  const store = new MailboxStore(root);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  const original = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'stale', body: 'old' });
  await store.send({
    from: 'claude', to: 'grok', kind: 'task', subject: 'new', body: 'new',
    supersedes: original.seq, supersedeReason: 'fix'
  });
  const messages = await store.allMessages?.() ?? [];
  const target = messages.find?.((m) => m.seq === original.seq);
  // allMessages may be private; use inbox + recall + doctor-less read via inbox emptiness and find
  rec('18-atomic-target-left-inbox', (await store.inbox('grok')).some((m) => m.seq === original.seq) ? 'FAIL' : 'PASS',
    'atomic retracts unread target from inbox');

  const a = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'A', body: 'a' });
  const b = await store.send({ from: 'claude', to: 'codex', kind: 'task', subject: 'B', body: 'b' });
  try {
    await store.supersedeMessage(a.seq, b.seq, 'redirect', 'claude');
    rec('18-two-step-cross-recipient', 'FAIL', 'two-step allowed different recipients');
  } catch (error) {
    rec('18-two-step-cross-recipient', /addressed to/i.test(error.message) ? 'PASS' : 'NOTE', error.message);
  }
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 8 });
}

// Item 15 overwrite with extra claimed
{
  const pab = path.resolve('c:/Users/hymlo/Downloads/Projects/Portable-AI-Bus');
  const guard = path.join(pab, 'scripts', 'claim-guard-cli.js');
  const tscSrc = path.join(pab, 'node_modules');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-i15f2-'));
  const bus = fs.mkdtempSync(path.join(os.tmpdir(), 'pab-i15f2bus-'));
  fs.mkdirSync(path.join(bus, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  fs.writeFileSync(path.join(bus, '.ai-bus', 'runtime', 'mailbox', 'state.json'), JSON.stringify({
    schema: 1, seq: 1, round: 1, agents: ['grok', 'claude'], claims: {
      grok: [
        { path: 'src', why: 'audit' },
        { path: 'tsconfig.json', why: 'audit' },
        { path: 'extra', why: 'audit' }
      ]
    }, halted: false, maxRounds: 400, haltPolicy: { atRounds: [], everyRounds: null }, baton: null
  }));
  execFileSync('git', ['init'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'audit@example.com'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'audit'], { cwd: repo, stdio: 'pipe' });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, rootDir: 'src' },
    include: ['src']
  }, null, 2));
  fs.writeFileSync(path.join(repo, 'src', 'ok.ts'), 'export const n: number = 1;\n');
  try { fs.symlinkSync(tscSrc, path.join(repo, 'node_modules'), 'junction'); } catch {}
  execFileSync('git', ['add', 'tsconfig.json', 'src/ok.ts'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: repo, stdio: 'pipe' });

  fs.mkdirSync(path.join(repo, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'extra', 'bad.ts'), 'export const n: number = "broken";\n');
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
    include: ['src', 'extra']
  }, null, 2));
  execFileSync('git', ['add', 'tsconfig.json', 'extra/bad.ts'], { cwd: repo, stdio: 'pipe' });
  fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true, rootDir: 'src' },
    include: ['src']
  }, null, 2));
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.execPath, [guard, '--root', bus, '--seat', 'grok', '--repo', repo], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, BUS_SEAT: 'grok', BUS_ROOT: bus }
    });
  } catch (error) {
    code = error.status ?? 1;
    out = `${error.stdout || ''}${error.stderr || ''}`;
  }
  rec('15-staged-tsconfig-overwritten-by-worktree',
    code !== 0 && /REFUSING|does not compile/i.test(out) ? 'PASS' : 'FAIL',
    `exit=${code}\n${out}\n(if FAIL: worktree tsconfig overwrite hid staged extra/bad.ts)`);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(bus, { recursive: true, force: true });
}
