'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MailboxStore } = require('./dist/mailbox.js');

(async () => {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i15-badcfg-'));
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init']); git(['config', 'user.email', 'a@b']); git(['config', 'user.name', 'a']);
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const n: number = 1;\n');
  const good = JSON.stringify({
    compilerOptions: { module: 'commonjs', target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
    include: ['src']
  }, null, 2);
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), good);
  fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(repo, 'node_modules'), 'junction');
  const store = new MailboxStore(repo);
  await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
  await store.claim({ agent: 'grok', paths: ['src', 'tsconfig.json'], why: 'item 15' });
  git(['add', 'src/index.ts', 'tsconfig.json']);
  git(['commit', '-m', 'good']);
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), '{ this is not json\n');
  git(['add', 'tsconfig.json']);
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), good);
  let r;
  try {
    r = {
      code: 0,
      out: execFileSync(process.execPath, [
        path.join(__dirname, 'scripts', 'claim-guard-cli.js'),
        '--repo', repo, '--root', repo, '--seat', 'grok'
      ], { encoding: 'utf8' })
    };
  } catch (e) {
    r = { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
  const cached = git(['show', ':tsconfig.json']);
  console.log(JSON.stringify({
    code: r.code,
    out: r.out,
    cached,
    cachedBroken: /not json/.test(cached),
    verdict: r.code === 0 && /compile OK/.test(r.out) && /not json/.test(cached) ? 'FAIL' : (r.code !== 0 ? 'PASS' : 'AMBIGUOUS')
  }, null, 2));
  await fsp.rm(repo, { recursive: true, force: true, maxRetries: 8 });
})().catch((e) => { console.error(e); process.exit(1); });
