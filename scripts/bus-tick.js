#!/usr/bin/env node
/**
 * A heartbeat emitter for a human-facing chat operator session.
 *
 *   node scripts/bus-tick.js --root "<bus root>" [--seat claude] [--interval-s 240]
 *
 * ## Why this exists
 *
 * Brains solved half the stall. A brain is a process, so it wakes on mail, acts, and keeps
 * going. The CHAT OPERATOR — the human-facing Codex, Claude, or Grok session — is still a chat
 * session, and its turn ends when it finishes speaking. It cannot wake itself.
 *
 * Hymlock, 2026-08-10, on watching a heartbeat re-invoke the pilot chat: *"Oh my God we could
 * have done that the whole time?!"* Yes — and the reason it was missed is that every previous
 * fix aimed at the seats, which were never the half that fell asleep.
 *
 * ## What this does, and what it cannot do
 *
 * It prints one line per interval, forever. That is all. The line is the wake signal: a host
 * that can watch a subprocess's stdout and re-enter the named chat operator on each line gets
 * an operator that resumes without the human typing. The bus emits the beat; the host decides
 * how to listen. It does not tick or schedule autonomous brain processes.
 *
 *   Claude Code   Monitor with this as its command
 *   others        any background-task or watch facility that surfaces stdout
 *
 * It does NOT make a chat immortal. When the host session ends, the listener ends with it. This
 * buys continuity ACROSS RESPONSES, not across sessions, and saying otherwise would repeat the
 * mistake of treating a lease as proof of life.
 *
 * Each line carries state worth waking for, so a tick that arrives while nothing has changed is
 * still cheap to dismiss: attended seats, unread counts, baton holder, and any seat that has
 * gone quiet while holding it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const REPO = path.resolve(__dirname, '..');
const root = path.resolve(option('--root', path.resolve(REPO, '..', 'ai-bus')));
const seat = option('--seat', 'hymlock');
const intervalMs = Math.max(30, Number(option('--interval-s', '240'))) * 1000;
const once = process.argv.includes('--once');

const runtime = path.join(root, '.ai-bus', 'runtime');
const { readStaleCodeNotices, readDeadSeatNotices } = require('./bus-supervise');

/** Courtesy kinds, matching the runner's `ackKinds` and the brain's `RECEIPT_KINDS`. */
const RECEIPT_KINDS = new Set(['ack', 'receipt', 'ping']);

/**
 * When did anything last happen on this bus?
 *
 * Taken from the newest durable message rather than from a counter this process has been
 * watching. The first version remembered the round across ticks and compared — which meant a
 * freshly started watcher measured "quiet since I started looking" and was blind to a park that
 * began hours before it. Evidence on disk has no such blind spot: a bus where nobody has sent
 * anything for an hour is quiet whether or not anyone was watching.
 */
function lastActivityMinutes() {
  try {
    const inbox = path.join(runtime, 'mailbox', 'inbox');
    const files = fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).sort();
    const newest = files[files.length - 1];
    if (!newest) return null;
    const at = fs.statSync(path.join(inbox, newest)).mtimeMs;
    return Math.round((Date.now() - at) / 60000);
  } catch {
    return null;
  }
}

/**
 * Seats with a live brain process **for THIS root**, by name.
 *
 * ITEM 23, grok r29: this used to scan the whole machine. A brain belonging to a DIFFERENT
 * bus on the same box made `brains:` look healthy while this root's own dead-seat notice said
 * the seat had been gone for hours - grok observed exactly that mixed line live,
 * `brains:codex,grok` printed alongside `DEAD-SEAT grok`.
 *
 * The supervisor already had this right: it uses `processesForRoot`. The operator line, which
 * is the surface a human actually reads, did not. Same module now, so the two cannot disagree
 * about which machine's seats they are describing.
 *
 * Still Windows-only detection, and that is item 23's remaining half rather than a fix: on
 * any other platform this returns [] and the field reads NONE. Honest, but not portable, and
 * the portability pass owns it.
 */
/**
 * The durable operator notices, as tick fields.
 *
 * ONE definition, used by both the healthy path and the unreadable-mailbox path. They were
 * separate for about ten minutes while fixing item 24 and that is exactly how the two drift
 * apart until one of them silently stops reporting - which is item 22's original failure,
 * where the file existed and the line that should have read it did not.
 *
 * ITEM 22: the DEAD-SEAT line prints the first-seen time, because "gone since 01:42" was the
 * fact that actually mattered when a seat stayed dead for eight hours and every other signal
 * read normal.
 */
function noticeLines(coordinationRoot, live = liveBrains()) {
  const lines = [];
  const stale = readStaleCodeNotices(coordinationRoot);
  if (stale.seats.length > 0) {
    lines.push(`STALE-CODE ${stale.seats.map((item) => item.seat).join(',')} - running brains predate dist; bus-restart, do not treat as current`);
  }

  /**
   * ITEM 27: a dead-seat notice can outlive the death it describes.
   *
   * The clear happens only in the supervisor's sweep. grok observed the consequence live: a
   * planted notice and `brains:codex,grok` printed on ONE LINE, because the seat's brain was
   * alive and nothing had cleared the file. Its other paths are just as real - a bus run
   * without a supervisor prints the leftover forever, and brains restarted outside the
   * supervisor stay flagged until the next sweep.
   *
   * The tick deliberately does NOT clear the file. It is a reader; a reader that repairs its
   * own input hides the writer's bug, and item 25 was exactly a writer bug that only became
   * findable because the notice survived. So it cross-checks and SAYS the two disagree.
   *
   * This is only meaningful because item 23 scoped liveBrains() to --root. Before that, a
   * brain from some other bus on the same box would have "confirmed" a seat alive here.
   */
  const dead = readDeadSeatNotices(coordinationRoot);
  if (dead.seats.length > 0) {
    const running = new Set(live);
    const format = (item) => (item.at ? `${item.seat}(since ${String(item.at).slice(11, 19)})` : item.seat);
    const absent = dead.seats.filter((item) => !running.has(item.seat));
    const contradicted = dead.seats.filter((item) => running.has(item.seat));

    if (absent.length > 0) {
      lines.push(`DEAD-SEAT ${absent.map(format).join(',')} - no brain process; restarts exhausted. bus-restart, and do not read the baton as progress`);
    }
    if (contradicted.length > 0) {
      lines.push(`STALE-NOTICE ${contradicted.map(format).join(',')} - flagged dead but a brain for THIS root is running; the supervisor has not swept. Trust the brain, not the file`);
    }
  }
  return lines;
}

function liveBrains() {
  /**
   * grok r34: the `win32` early return here was CARVING, and worse than untidy.
   *
   * `listNodeProcesses` already has a Unix `ps` branch, and the supervisor has no platform
   * gate at all. So on Unix this returned [] and printed `brains:NONE` while the supervisor
   * happily enumerated the same seats - A NEW DISAGREEMENT between the two, which is the exact
   * opposite of why item 23 moved both onto one module. I had labelled it "the portability
   * pass owns it", which was me protecting a number rather than describing a boundary.
   *
   * Seat parsing goes through the same module too. The local regex missed `--seat=grok`,
   * which `identifyNodeProcess` handles - a second way for the tick and the supervisor to
   * describe the same machine differently.
   */
  try {
    const { listNodeProcesses, processesForRoot } = require('./bus-processes');
    return [...new Set(
      processesForRoot(listNodeProcesses(), root)
        .map((item) => item.seat)
        .filter(Boolean)
    )].sort();
  } catch {
    // Cannot see the process list - including the item-28 timeout. Degrade, never hang.
    return [];
  }
}

/**
 * Bus state read from disk rather than over HTTP.
 *
 * A tick must not depend on the harness being up — a heartbeat that goes silent exactly when
 * the harness dies is worse than none, because that is the moment the pilot most needs waking.
 */
function busState() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(runtime, 'mailbox', 'state.json'), 'utf8'));
    // Unread counts are not stored in state.json. They are derived from durable messages by
    // MailboxStore.status(); reading a nonexistent `state.unread` made every tick claim
    // `unread:none`, including when dozens of messages were waiting.
    const counts = new Map();
    const substantive = new Map();
    const inbox = path.join(runtime, 'mailbox', 'inbox');
    for (const file of fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).sort()) {
      const message = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'));
      if (message.read !== true && typeof message.to === 'string') {
        counts.set(message.to, (counts.get(message.to) ?? 0) + 1);
        // Receipts are courtesy traffic and should not compete for a human's attention. A live
        // count of 49 hid the fact that only 13 needed anyone: 36 were acks. A number that is
        // always large is a number nobody reads.
        if (!RECEIPT_KINDS.has(String(message.kind ?? '').toLowerCase())) {
          substantive.set(message.to, (substantive.get(message.to) ?? 0) + 1);
        }
      }
    }
    const unread = [...counts].sort(([left], [right]) => left.localeCompare(right))
      .map(([who, n]) => {
        const real = substantive.get(who) ?? 0;
        return real === n ? `${who}:${n}` : `${who}:${n}(${real} need you)`;
      });
    const heldSeconds = state.baton?.since
      ? Math.round((Date.now() - Date.parse(state.baton.since)) / 1000)
      : null;
    return {
      baton: state.baton?.holder ?? 'unheld',
      heldSeconds,
      round: state.round,
      maxRounds: state.maxRounds,
      halted: state.halted === true,
      unread
    };
  } catch (error) {
    return { error: (error?.message ?? String(error)).slice(0, 80) };
  }
}

function tick() {
  const brains = liveBrains();
  const bus = busState();
  const stamp = new Date().toISOString().slice(11, 19);

  if (bus.error) {
    /**
     * ITEM 24, grok r29: this returned before any notice line, so an unreadable mailbox
     * SUPPRESSED the dead-seat report. A dead seat matters more when the mailbox is broken,
     * not less - those are exactly the conditions where an operator most needs to know which
     * seat stopped, and "MAILBOX UNREADABLE" alone does not say.
     *
     * The notices live on disk and do not depend on the mailbox parsing, so there is no
     * reason for one failure to hide the other. Still a beat, and still the mailbox error
     * first, because that is the more urgent fact.
     */
    const parts = [`tick ${stamp}`, `MAILBOX UNREADABLE: ${bus.error}`, ...noticeLines(root)];
    console.log(parts.join('  '));
    return;
  }

  const parts = [
    `tick ${stamp}`,
    `pilot:${seat}`,
    `brains:${brains.length ? brains.join(',') : 'NONE'}`,
    `baton:${bus.baton}${bus.heldSeconds === null ? '' : `(${bus.heldSeconds}s)`}`,
    `round:${bus.round}/${bus.maxRounds}`,
    bus.unread.length ? `unread:${bus.unread.join(' ')}` : 'unread:none'
  ];
  if (bus.halted) parts.push('HALTED');

  // Pass the brains ALREADY measured for this line. Re-querying would let `brains:` and
  // STALE-NOTICE disagree inside a single tick, which is the contradiction item 27 exists to
  // report rather than to create.
  parts.push(...noticeLines(root, brains));


  const quietMinutes = lastActivityMinutes();

  // Two different stalls, and the first version only caught one of them.
  //
  //   dead    the baton sits with a seat that has no live brain
  //   parked  the baton sits with a LIVE seat that is idle-skipping every wake
  //
  // The second is what actually happened: codex finished an iteration, reported it, and simply
  // never released the baton. Its brain was alive and healthy and logging `wake-idle-skipped`
  // every five minutes, so a liveness-only check called that fine for nearly three hours. The
  // round counter is the tell - nothing is happening if nothing is being sequenced.
  if (bus.heldSeconds !== null && bus.heldSeconds > 900) {
    if (!brains.includes(bus.baton)) {
      parts.push(`STALL? ${bus.baton} holds the baton with no live brain`);
    } else if (quietMinutes !== null && quietMinutes >= 15) {
      parts.push(`PARKED? ${bus.baton} holds the baton; no bus traffic for ${quietMinutes}m`);
    }
  }
  console.log(parts.join('  '));
}

/**
 * Only tick when RUN, not when REQUIRED.
 *
 * Without this guard, `require('./bus-tick')` printed a tick and installed a live interval as
 * a side effect of being imported, which is why nothing had ever imported it - including the
 * tests, which had to drive it through a subprocess. A module that cannot be loaded without
 * doing its job cannot be unit-tested, and item 27's cross-check needed `live` injected
 * rather than measured from the machine running the suite.
 */
if (require.main === module) {
  tick();
  if (!once) {
    setInterval(tick, intervalMs);
  }
}

module.exports = { noticeLines, liveBrains };
