/**
 * DROP-IN replacement for EvidenceStore.withLock (src/evidence.ts).
 * Item 2 hole 1: empty / unparseable / pid-less lock is debris, not a live owner.
 * Tested via patched dist/evidence.js in tmp-audit-r6-grok.cjs (empty 5ms, unparseable 3ms, missing pid 3ms).
 * Do not treat this file as compiled source. Copy the method body into src/evidence.ts.
 */
private async withLock<T>(action: () => Promise<T>): Promise<T> {
  const lockPath = `${this.filePath}.lock`;
  await fs.mkdir(path.dirname(this.filePath), { recursive: true });
  const started = Date.now();
  let owns = false;
  while (!owns) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }));
      await handle.close();
      owns = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows reports EEXIST when the lock path is a directory; Unix reports EISDIR.
      // Either way there is no live owner until we read a positive integer pid.
      if (code !== 'EEXIST' && code !== 'EISDIR') throw error;
      const raw = await fs.readFile(lockPath, 'utf8').catch(() => '');
      let owner: { pid?: unknown } | undefined;
      try {
        const text = raw.replace(/^\uFEFF/, '').trim();
        owner = text ? JSON.parse(text) as { pid?: unknown } : undefined;
      } catch {
        owner = undefined;
      }
      const pid = owner?.pid;
      const liveOwner = typeof pid === 'number'
        && Number.isSafeInteger(pid)
        && pid > 0
        && evidenceProcessAlive(pid);
      // A lock whose owner is gone is debris. Unparseable = no owner = debris.
      // A directory at the lock path is not an owner either (r13c leftover).
      if (!liveOwner) {
        await fs.rm(lockPath, { force: true, recursive: true });
        continue;
      }
      if (Date.now() - started >= EVIDENCE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the evidence lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lockPath, { force: true, recursive: true });
  }
}
