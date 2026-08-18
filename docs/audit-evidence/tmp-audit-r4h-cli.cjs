'use strict';
const { execFileSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('path');
const { MailboxStore } = require('./dist/mailbox.js');

(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r4h-cli2-'));
  try {
    const store = new MailboxStore(dir);
    await store.ensureInitialized(['claude', 'grok'], 500);
    const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
    for (let i = 0; i < 3; i += 1) {
      await store.recordEvidence({ agent: 'grok', subject: `cli-${i}`, statement: `did ${i}`, workId: source.seq });
    }
    const cli = path.join(__dirname, 'dist', 'mailbox.js');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [
        cli, 'consolidate-evidence',
        '--root', dir,
        '--work-id', String(source.seq),
        '--agent', 'grok'
      ], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      code = error.status ?? 1;
      out = `${error.stdout || ''}${error.stderr || ''}`;
    }
    const records = await store.listEvidence(source.seq);
    const summaries = records.filter((r) => r.consolidatedFrom !== undefined);
    const live = records.filter((r) => !r.supersededBy && !r.invalidateReason);
    console.log(JSON.stringify({
      code,
      out: String(out).trim(),
      summaries: summaries.length,
      absorbed: summaries[0] && summaries[0].consolidatedFrom.length,
      live: live.length
    }, null, 2));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {});
  }
})().catch((e) => { console.error(e); process.exit(1); });
