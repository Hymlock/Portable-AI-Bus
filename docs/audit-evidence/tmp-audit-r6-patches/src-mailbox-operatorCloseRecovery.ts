/**
 * DROP-IN replacement for MailboxStore.operatorCloseRecovery (src/mailbox.ts).
 * Item 2 hole 2: operator close ENDS the assignment, so compact after the mailbox lock.
 * Same shape as closeRecovery. Compaction must not fail the close.
 * inherit / reassignment must still NOT compact.
 * Tested via patched dist/mailbox.js in tmp-audit-r6-grok.cjs (1 summary of 3).
 * Do not treat this file as compiled source. Copy the method body into src/mailbox.ts.
 */
async operatorCloseRecovery(
  seat: string,
  workId: number,
  operatorReason: string
): Promise<RecoveryCheckpoint | undefined> {
  if (typeof operatorReason !== 'string' || operatorReason.trim().length === 0) {
    throw new Error('Operator close refused: a reason is required. Nothing was closed.');
  }
  const checkpoint = await this.withLock(async () => {
    const file = await this.findMessagePathUnsafe(workId);
    if (!file) return undefined;
    const message = await this.readJson<BusMessage>(file);
    const checkpoint = message.recoveryCheckpoints?.find(
      (item) => item.seat === seat && item.status === 'open'
    );
    if (!checkpoint) return undefined;
    const at = nowIso();
    checkpoint.status = 'closed';
    checkpoint.closedAt = at;
    checkpoint.updatedAt = at;
    // Marked as an operator action, not a seat outcome, so it never reads as completed work.
    checkpoint.closeReason = `operator-closed: ${operatorReason.trim()}`;
    await this.atomicJson(file, message);
    return checkpoint;
  });
  if (checkpoint) {
    try {
      await this.evidence.consolidate(workId, seat);
    } catch {
      // Intentionally swallowed. Compaction is an optimisation; the close is the fact.
    }
  }
  return checkpoint;
}
