export type ReminderSnapshot = {
  unread: Record<string, number>;
  newestUnreadSeq: Record<string, number>;
  staleSeats: string[];
};

export type ReminderTransitions = {
  unreadAgents: Array<{ agent: string; count: number }>;
  staleSeats: string[];
};

export class ReminderTracker {
  private readonly previous = new Map<string, ReminderSnapshot>();

  observe(workspaceRoot: string, current: ReminderSnapshot): ReminderTransitions {
    const normalized = {
      unread: { ...current.unread },
      newestUnreadSeq: { ...current.newestUnreadSeq },
      staleSeats: [...new Set(current.staleSeats)].sort()
    };
    const prior = this.previous.get(workspaceRoot);
    this.previous.set(workspaceRoot, normalized);
    if (!prior) return { unreadAgents: [], staleSeats: [] };
    return {
      unreadAgents: Object.entries(normalized.unread)
        .filter(([agent, count]) => count > 0 && (normalized.newestUnreadSeq[agent] ?? 0) > (prior.newestUnreadSeq[agent] ?? 0))
        .map(([agent, count]) => ({ agent, count }))
        .sort((left, right) => left.agent.localeCompare(right.agent)),
      staleSeats: normalized.staleSeats.filter((seat) => !prior.staleSeats.includes(seat))
    };
  }

  reset(workspaceRoot: string) {
    this.previous.delete(workspaceRoot);
  }
}
