/**
 * Provider-neutral brain contract.
 *
 * A "brain" is whatever decides what a seat does. The runner owns the loop; the brain only
 * decides. That split is the entire point of this module and the reason the loop stops
 * breaking:
 *
 *   Running a seat as a CHAT SESSION makes its unit of work a *turn*, and a turn ends when the
 *   agent finishes speaking. Reporting and stopping become the same act, so an agent cannot say
 *   "here is what I found" and keep working. Every stall this project diagnosed came from that,
 *   and no listener policy could fix it: a listener keeps the SEAT attended, it cannot stop the
 *   TURN ending.
 *
 * Modelled on the brain contract in Hymlock's Star Slug harness
 * (`.harness/lib/brains/contract.js`), which solved this for game-playing agents. Adapted here
 * for bus seats. See `docs/LOOP_ARCHITECTURE.md`.
 */

export type WakeReason = 'mail' | 'timeout' | 'startup' | 'signal';

export type BrainMessage = {
  seq: number;
  from: string;
  to: string;
  kind: string;
  subject: string;
  body: string;
};

/** Everything a brain is given for one wake. */
export type WakeContext = {
  seat: string;
  reason: WakeReason;
  /** Mail drained for this wake. May be empty on a timeout wake. */
  messages: BrainMessage[];
  /**
   * Durable summary supplied by the previous unfinished wake.
   *
   * Model sessions do not survive runner iterations. This is the explicit bridge that lets a
   * continuation wake know what it said it was continuing after the assigning mail was consumed.
   * Absent when there is no unfinished work.
   */
  openWork?: string;
  /** Bus tools, already bound to this seat. Calling them is how a brain acts. */
  tools: BrainTools;
  /** How many tool calls remain before the runner caps this wake. */
  budget: number;
  log: (event: string, data?: unknown) => void;
};

/**
 * The bus surface a brain may use. Deliberately small: a brain that can do everything is a
 * brain nobody can reason about, and `mailbox_send` is how a seat reports without stopping.
 */
export type BrainTools = {
  send(input: { to: string; kind: string; subject: string; body: string; keepBaton?: boolean }): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  claim(paths: string[], why: string): Promise<unknown>;
  release(paths?: string[]): Promise<unknown>;
  /** Allowlisted, non-shell capabilities. Same guarantees as the harness tool. */
  runCapability(id: string, timeoutMs?: number): Promise<unknown>;
  /**
   * The capability ids this seat may actually run.
   *
   * Without it a model guesses, and guesses cost money. Three seats spent whole wakes calling
   * `shell`, `workspace_runner` and `read_write_test` — none of which exist — because nothing
   * ever told them the allowlist. Each failure earned a repair round, and each repair round was
   * a paid call that produced another guess.
   *
   * Same lesson as the seat roster: a model given no inventory invents a plausible one.
   */
  listCapabilities(): Promise<string[]>;
};

export type WakeResult = {
  /**
   * `true` means THIS WAKE's work is finished and the runner should go back to waiting.
   *
   * It does NOT mean the agent is finished, and the runner must never treat it that way.
   * Conflating the two is precisely the chat-session bug this architecture exists to remove,
   * so it is stated on the type rather than left to a comment in the loop.
   */
  done: boolean;
  /** Set by the runner when the budget ran out before the brain said it was done. */
  capped?: boolean;
  /**
   * Optional one-line summary for the runner's log. When `done` is false, this is also the
   * durable description supplied to the next continuation wake.
   */
  note?: string;
  /**
   * Every provider in the chain is spent. NOT the same as an error: an error is a bad wake,
   * this is a seat that cannot have a good one until credit returns. The runner turns this
   * into a baton hand-off rather than letting the seat go quietly silent.
   */
  exhausted?: boolean;
  /**
   * The wake did not produce a usable plan, so mail presented to it must remain unread.
   * The runner normally commits a transactional inbox read after the turn succeeds.
   */
  retainMessages?: boolean;
  /**
   * Work is valid but cannot proceed until an external condition changes (for example, a
   * path claim is held by another seat). Blocked mail remains unread without consuming the
   * poison-message retry budget.
   */
  blocked?: boolean;
};

export type Brain = {
  readonly name: string;
  takeTurn(context: WakeContext): Promise<WakeResult>;
  /** Optional: called once before the first wake. */
  start?(): Promise<void>;
  /** Optional: called on shutdown, best-effort. */
  stop?(): Promise<void>;
};

export type BrainFactory = (options: {
  seat: string;
  /** Durable mailbox/harness root. May be separate from the repository being worked on. */
  root: string;
  /** Repository directory in which model-backed providers inspect and edit files. */
  workdir: string;
  log: (event: string, data?: unknown) => void;
}) => Brain | Promise<Brain>;
