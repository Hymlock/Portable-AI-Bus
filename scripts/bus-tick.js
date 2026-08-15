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
const { readStaleCodeNotices } = require('./bus-supervise');

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

/** Seats with a live brain process, by name. Windows-only detection; empty elsewhere. */
function liveBrains() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'brain[\\\\/]cli\\.js' } | " +
      "ForEach-Object { ($_.CommandLine -split '--seat ')[1].Split(' ')[0] }"
    ], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
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
    // Still a beat. A pilot woken to "the mailbox is unreadable" is exactly right.
    console.log(`tick ${stamp} MAILBOX UNREADABLE: ${bus.error}`);
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

  const stale = readStaleCodeNotices(root);
  if (stale.seats.length > 0) {
    parts.push(`STALE-CODE ${stale.seats.map((item) => item.seat).join(',')} - running brains predate dist; bus-restart, do not treat as current`);
  }

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

tick();
if (!once) {
  setInterval(tick, intervalMs);
}
