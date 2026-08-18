# Exact edits for tests/audit-round2.test.js

Claude holds this file. I did not edit it. These are the two changes the r5 brief asked for.

## 1. noCheck becomes RED

Replace the test `'ITEM 15: declared consequences of trusting the staged config are stated, not hidden'` so `noCheck: true` is refused. Keep the narrowing-`exclude` NOTE as a separate green if you want it; do not keep `assert.equal(result.code, 0)` on a noCheck config.

Suggested split:

```js
test('ITEM 15 RED: staged noCheck is not a verified index', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [], noCheck: true },
    include: ['src']
  }, null, 2));
  git(repo, 'add', '-A');
  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 1, 'noCheck is the hook turning itself off from inside the artifact');
  assert.match(result.out, /noCheck/);
});

test('ITEM 15: a narrowing exclude is printed, not refused', async (t) => {
  const { repo, busRoot, linked } = await fixtureRepo(t);
  if (!linked) return t.skip('could not link node_modules');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src'], exclude: ['src/nothing.ts']
  }, null, 2));
  git(repo, 'add', '-A');
  const result = runGuard(repo, busRoot);
  assert.equal(result.code, 0);
  assert.match(result.out, /excludes 1 pattern/);
});
```

The current test encodes the defect: it expects exit 0 on `noCheck: true`.

## 2. Sibling of the closeRecovery compact RED

Sit this next to `'ITEM 2 RED: consolidate is reachable - closing an assignment compacts it'`. Same fixture, `operatorCloseRecovery` instead of `closeRecovery`.

```js
test('ITEM 2 RED: operator close also compacts', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-i2op-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }).catch(() => {}));
  const store = new MailboxStore(dir);
  await store.ensureInitialized(['claude', 'grok'], 500);
  const source = await store.send({ from: 'claude', to: 'grok', kind: 'task', subject: 'work', body: 'do it' });
  await store.openRecovery('grok', source.seq, 'started');
  for (let i = 0; i < 3; i += 1) {
    await store.recordEvidence({ agent: 'grok', subject: `step-${i}`, statement: `did ${i}`, workId: source.seq });
  }

  await store.operatorCloseRecovery('grok', source.seq, 'stranded seat');

  const records = await store.listEvidence(source.seq);
  const summary = records.find((item) => item.consolidatedFrom !== undefined);
  assert.ok(summary, 'REGRESSION: operator close ended the assignment and nothing compacted it');
  assert.equal(summary.consolidatedFrom.length, 3);
});
```

I will not certify by running this suite. After you commit, send the new HEAD.
