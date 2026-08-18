'use strict';
/**
 * Round-4 supplement. Does not replace tmp-audit-r4-grok.cjs.
 * Tightens three questions the first instrument left soft:
 *   15: can a triple-slash / types-root actually HIDE a staged type error?
 *   15: does a relative `..` include still refuse (control)?
 *    2: do the author's four-process consolidate assertions stay green
 *       against UNLOCKED last-write-wins?
 *   20: is operator-close reachable from a seat-facing harness verb?
 */
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { MailboxStore } = require('./dist/mailbox.js');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
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
    return false;
  }
}

function runGuard(repo, busRoot, env = {}) {
  const merged = { ...process.env, ...env };
  if (!Object.prototype.hasOwnProperty.call(env, 'BUS_ALLOW_BROKEN_BUILD')) {
    delete merged.BUS_ALLOW_BROKEN_BUILD;
  }
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe', env: merged
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function rm(dir) {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
}

async function seedRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4b-'));
  const repo = path.join(dir, 'repo');
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'audit@example.com');
  git(repo, 'config', 'user.name', 'audit');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const fine: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  const mailboxDir = path.join(busRoot, '.ai-bus', 'runtime', 'mailbox');
  await fsp.mkdir(mailboxDir, { recursive: true });
  await fsp.writeFile(path.join(mailboxDir, 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }] } }));
  return { dir, repo, busRoot };
}

async function linkWholeModules(repo) {
  return junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));
}

async function attack15extra() {
  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'triple-slash-hides-type-error', 'SKIP', 'no node_modules junction');
      } else {
        const outside = path.join(fx.dir, 'hidden-fix.d.ts');
        await fsp.writeFile(outside, 'declare type HiddenFix = number;\n');
        const refPath = outside.replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'),
          `/// <reference path=${JSON.stringify(refPath)} />\nexport const broken: HiddenFix = 1;\n`);
        git(fx.repo, 'add', 'src', 'tsconfig.json', '.gitignore');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'triple-slash-hides-type-error',
          result.code === 1 ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 900)} (staged file does not typecheck unless tsc reads the OUTSIDE .d.ts)`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'relative-dotdot-include-refused', 'SKIP', 'no node_modules junction');
      } else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['../repo/src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'relative-dotdot-include-refused',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : 'FAIL',
          `code=${result.code} out=${result.out.trim().slice(0, 600)}`);
      }
    } finally { await rm(fx.dir); }
  }

  {
    const fx = await seedRepo();
    try {
      if (!await linkWholeModules(fx.repo)) {
        rec(15, 'mapRoot-outside', 'SKIP', 'no node_modules junction');
      } else {
        const outside = path.join(fx.dir, 'maps').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [],
            sourceMap: true,
            mapRoot: outside,
            sourceRoot: outside
          },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec(15, 'mapRoot-sourceRoot-outside',
          result.code === 1 && /OUTSIDE the staged tree/i.test(result.out) ? 'PASS' : 'NOTE',
          `code=${result.code} out=${result.out.trim().slice(0, 500)} (mapRoot/sourceRoot omitted from walker; write-side, does not hide a type error)`);
      }
    } finally { await rm(fx.dir); }
  }
}

function unlockedConsolidateScript(filePath) {
  return `
    const fs = require('fs');
    const path = require('path');
    const { randomUUID } = require('crypto');
    const filePath = ${JSON.stringify(filePath)};
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const live = file.records.filter((item) => item.workId === 42 && !item.supersededBy && !item.invalidateReason);
    const episodes = live.filter((item) => item.consolidatedFrom === undefined);
    if (episodes.length < 3) {
      console.log(JSON.stringify({ ok: true, absorbed: 0, reason: 'too few', id: null }));
      process.exit(0);
    }
    const at = new Date().toISOString();
    const sourceEventId = file.nextEventId;
    file.nextEventId += 1;
    const summary = {
      id: randomUUID(),
      workId: 42,
      subject: 'consolidated: work #42',
      statement: episodes.map((item) => '[' + item.trust + '] ' + item.subject + ': ' + item.statement).join('\\n'),
      trust: 'untrusted',
      recordedBy: 'unlocked',
      sourceEventId,
      createdAt: at,
      updatedAt: at,
      consolidatedFrom: episodes.map((item) => item.id).sort()
    };
    for (const episode of episodes) {
      episode.supersededBy = summary.id;
      episode.updatedAt = at;
    }
    file.records.push(summary);
    const temporary = filePath + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(file, null, 2) + '\\n');
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* */ }
      console.log(JSON.stringify({ ok: false, error: error.message, code: error.code }));
      process.exit(0);
    }
    console.log(JSON.stringify({ ok: true, absorbed: episodes.length, id: summary.id }));
  `;
}

async function attack2extra() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4b-lww-'));
  try {
    const dir = path.join(root, '.ai-bus', 'runtime', 'mailbox');
    await fsp.mkdir(dir, { recursive: true });
    const filler = 'x'.repeat(2048);
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: `record-${i}`, workId: 42, subject: `step-${i}`, statement: `${filler} ${i}`,
      trust: 'untrusted', recordedBy: 'grok', sourceEventId: i + 1,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    const filePath = path.join(dir, 'evidence.json');
    await fsp.writeFile(filePath, JSON.stringify({ schema: 1, nextEventId: 301, records }, null, 2));
    const startAt = Date.now() + 1500;
    const script = unlockedConsolidateScript(filePath);
    const wrapped = `while (Date.now() < ${startAt}) {}\n${script}`;
    const run = () => new Promise((resolve) => {
      execFile(process.execPath, ['-e', wrapped], { encoding: 'utf8' },
        (error, stdout) => resolve({ error, stdout: stdout.trim() }));
    });
    const childResults = await Promise.all([0, 1, 2, 3].map(run));
    const parsed = childResults.map((r) => {
      try { return JSON.parse(r.stdout); } catch { return { ok: false, error: r.stdout || r.error?.message }; }
    });
    const file = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    const summaries = file.records.filter((item) => item.consolidatedFrom !== undefined);
    const live = file.records.filter((item) => !item.supersededBy && !item.invalidateReason);
    const crashed = parsed.some((p) => !p.ok);
    const authorAssertionsHold = !crashed
      && summaries.length === 1
      && live.length === 1
      && summaries[0].consolidatedFrom.length === 300;
    rec(2, 'unlocked-last-write-wins-satisfies-author-gate',
      authorAssertionsHold ? 'FAIL' : 'PASS',
      `authorAssertionsHold=${authorAssertionsHold} crashed=${crashed} absorbed=${parsed.map((p) => p.absorbed).join(',')} summaries=${summaries.length} live=${live.length} childOk=${parsed.map((p) => p.ok).join(',')} (FAIL means the author's four-process consolidate assertions stay green against unlocked last-write-wins)`);
  } finally { await rm(root); }
}

async function attack20extra() {
  {
    const harness = path.join(REPO, 'src', 'harness.ts');
    const text = await fsp.readFile(harness, 'utf8');
    const mentions = /operatorClose|close-recovery|closeRecovery/.test(text);
    rec(20, 'harness-has-no-operator-close-verb',
      !mentions ? 'PASS' : 'FAIL',
      `seat-facing harness mentions operator close? ${mentions} (must stay unreachable to seats)`);
  }

  {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4b-i20-'));
    try {
      const store = new MailboxStore(dir);
      await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
      const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'item 9', body: 'do it' });
      await store.openRecovery('grok', source.seq, 'ONE ACTION: implement item 9');
      await store.operatorCloseRecovery('grok', source.seq, 'item 9 certified hours ago');
      const stillGrok = await store.openRecoveryFor('grok');
      const recallGrok = await store.recallAssignment('grok', source.seq);
      const recallCodex = await store.recallAssignment('codex', source.seq);
      rec(20, 'operator-close-revokes-recall-for-everyone',
        !stillGrok && recallGrok === undefined && recallCodex === undefined ? 'PASS' : 'FAIL',
        `still=${Boolean(stillGrok)} recallGrok=${recallGrok ? 'yes' : 'no'} recallCodex=${recallCodex ? 'yes' : 'no'}`);
    } finally { await rm(dir); }
  }
}

async function main() {
  console.log(`HEAD ${HEAD}`);
  await attack15extra();
  await attack2extra();
  await attack20extra();
  const out = { head: HEAD, results };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4b-grok-out.json'), JSON.stringify(out, null, 2));
  const report = results.map((r) => `[${r.status}] ${r.item}/${r.name}: ${r.detail.split('\n')[0]}`).join('\n');
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r4b-grok-report.txt'), `HEAD ${HEAD}\n${report}\n`);
  console.log('\n--- r4b summary ---\n' + report);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
