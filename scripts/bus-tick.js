#!/usr/bin/env node
/**
 * A heartbeat for the seat a HUMAN is sitting in.
 *
 *   node scripts/bus-tick.js --root "<bus root>" [--seat claude] [--interval-s 240]
 *
 * ## Why this exists
 *
 * Brains solved half the stall. A brain is a process, so it wakes on mail, acts, and keeps
 * going. The PILOT — the chat window a human drives — is still a chat session, and a chat
 * session's turn ends when it finishes speaking. It cannot wake itself.
 *
 * Hymlock, 2026-08-10, on watching a heartbeat re-invoke the pilot chat: *"Oh my God we could
 * have done that the whole time?!"* Yes — and the reason it was missed is that every previous
 * fix aimed at the seats, which were never the half that fell asleep.
 *
 * ## What this does, and what it cannot do
 *
 * It prints one line per interval, forever. That is all. The line is the wake signal: a host
 * that can watch a subprocess's stdout and re-enter the model on each line gets a pilot that
 * resumes without the human typing. The bus emits the beat; the host decides how to listen.
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
    const inbox = path.join(runtime, 'mailbox', 'inbox');
    for (const file of fs.readdirSync(inbox).filter((name) => name.endsWith('.json')).sort()) {
      const message = JSON.parse(fs.readFileSync(path.join(inbox, file), 'utf8'));
      if (message.read !== true && typeof message.to === 'string') {
        counts.set(message.to, (counts.get(message.to) ?? 0) + 1);
      }
    }
    const unread = [...counts].sort(([left], [right]) => left.localeCompare(right))
      .map(([who, n]) => `${who}:${n}`);
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
  // A baton held for a long time by a seat with no brain is the shape of a stall, so name it
  // rather than making the reader compute it from the numbers.
  if (bus.heldSeconds !== null && bus.heldSeconds > 900 && !brains.includes(bus.baton)) {
    parts.push(`STALL? ${bus.baton} holds the baton with no live brain`);
  }
  console.log(parts.join('  '));
}

tick();
if (!once) {
  setInterval(tick, intervalMs);
}
