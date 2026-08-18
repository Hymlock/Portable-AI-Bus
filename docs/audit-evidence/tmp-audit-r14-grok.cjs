#!/usr/bin/env node
'use strict';
/**
 * r14 — close the r13c leftover on the patched dist.
 *
 * r13c measured lock-path-is-directory as FAIL (fs.rm EISDIR) on the REAL
 * lock path. Same class as item 2 hole 1: no live owner = debris.
 * This is not a re-run of r7 (HEAD) or r13c (pre-fix patch).
 */
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const { EvidenceStore } = require(path.join(REPO, 'tmp-audit-r6-patches', 'dist-patched', 'evidence.js'));
const results = [];

function rec(name, status, detail) {
  const row = { name, status, detail: String(detail).slice(0, 4000) };
  results.push(row);
  console.log(`[${status}] ${name}: ${row.detail.split('\n')[0]}`);
}

function lockPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'mailbox', 'evidence.json.lock');
}

async function withRoot(name, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `pab-r14-${name}-`));
  try {
    await fsp.mkdir(path.dirname(lockPath(dir)), { recursive: true });
    await fn(dir, new EvidenceStore(dir));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {});
  }
}

async function main() {
  await withRoot('empty', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), '');
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'empty-lock', statement: 'x', recordedBy: 'grok' });
      rec('empty-lock-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('empty-lock-is-debris', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  await withRoot('badjson', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), '{not-json');
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'bad-json', statement: 'x', recordedBy: 'grok' });
      rec('unparseable-lock-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('unparseable-lock-is-debris', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  await withRoot('nopid', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), JSON.stringify({ at: 'now' }));
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'no-pid', statement: 'x', recordedBy: 'grok' });
      rec('missing-pid-lock-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('missing-pid-lock-is-debris', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  await withRoot('lockdir', async (dir, store) => {
    await fsp.mkdir(lockPath(dir));
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'lock-dir', statement: 'x', recordedBy: 'grok' });
      rec('lock-path-is-directory', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('lock-path-is-directory', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  await withRoot('lockdirnested', async (dir, store) => {
    await fsp.mkdir(lockPath(dir));
    await fsp.writeFile(path.join(lockPath(dir), 'nested.txt'), 'not a lock');
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'lock-dir-nested', statement: 'x', recordedBy: 'grok' });
      rec('lock-path-is-nonempty-directory', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('lock-path-is-nonempty-directory', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  await withRoot('strpid', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: String(process.pid), at: new Date().toISOString() }));
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'string-pid', statement: 'x', recordedBy: 'grok' });
      rec('string-pid-is-debris', Date.now() - started < 2000 ? 'PASS' : 'FAIL', `recovered in ${Date.now() - started}ms`);
    } catch (error) {
      rec('string-pid-is-debris', 'FAIL', `${Date.now() - started}ms ${error.message}`);
    }
  });

  await withRoot('live', async (dir, store) => {
    await fsp.writeFile(lockPath(dir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'live-pid', statement: 'x', recordedBy: 'grok' });
      rec('live-pid-not-debris', 'FAIL', `stole a live-pid lock in ${Date.now() - started}ms`);
    } catch (error) {
      const ms = Date.now() - started;
      rec('live-pid-not-debris',
        /Timed out waiting for the evidence lock/i.test(error.message) && ms >= 2000 ? 'PASS' : 'NOTE',
        `${ms}ms ${error.message}`);
    }
  });

  await withRoot('bom', async (dir, store) => {
    await fsp.writeFile(
      lockPath(dir),
      `\uFEFF${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}`
    );
    const started = Date.now();
    try {
      await store.record({ workId: 7, subject: 'bom-live', statement: 'x', recordedBy: 'grok' });
      rec('bom-live-pid-not-debris', 'FAIL', `stole a live-pid lock in ${Date.now() - started}ms`);
    } catch (error) {
      const ms = Date.now() - started;
      rec('bom-live-pid-not-debris',
        /Timed out waiting for the evidence lock/i.test(error.message) && ms >= 2000 ? 'PASS' : 'NOTE',
        `${ms}ms ${error.message}`);
    }
  });

  const summary = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
    note: results.filter((r) => r.status === 'NOTE').length,
    results
  };
  await fsp.writeFile(path.join(REPO, 'tmp-audit-r14-grok-out.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ pass: summary.pass, fail: summary.fail, note: summary.note }, null, 2));
  if (summary.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
