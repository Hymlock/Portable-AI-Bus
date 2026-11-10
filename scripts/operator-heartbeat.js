#!/usr/bin/env node
/**
 * A record that the operator heartbeat is still beating — and, more usefully, when it stopped.
 *
 * ## Why
 *
 * `bus-tick.js` wakes the chat operator. It has no idea whether it is still running, and
 * neither does anything else: it prints to stdout and stdout goes to whatever host arranged to
 * listen. When the listener dies, the beat simply stops, and a stopped beat looks exactly like
 * a quiet bus.
 *
 * Measured 2026-08-22. The operator heartbeat died at tick 405 and nobody noticed for roughly
 * fourteen hours. In the same window `codex` sat holding the baton for 40,700 seconds with no
 * live brain — and the bus DETECTED that, printing `STALL? codex holds the baton with no live
 * brain` on every tick. The detection was correct and unread, because the only party arranged
 * to read it was the operator whose heartbeat had stopped.
 *
 * That is this project's recurring defect wearing bus colours: the guard exists, and nothing
 * can reach it. A stall-detector reporting to a sleeping reader detects nothing.
 *
 * ## What this adds
 *
 * Each tick writes `{seat, pid, tick, at}` here. That turns "is the operator awake?" from an
 * unanswerable question into a file with a timestamp, so:
 *
 *   - a brain that IS awake can see the operator has gone dark and escalate rather than wait
 *   - the next session's FIRST tick reports the gap instead of starting a fresh count from
 *     zero and looking healthy
 *
 * ## What it deliberately does not do
 *
 * It cannot report its own death — nothing can. The file is evidence for OTHER readers, and its
 * value is entirely in the staleness check, not in the write. A heartbeat file that is only ever
 * written and never compared against a deadline would be pure ceremony.
 *
 * It is also not proof of an attentive operator. It proves a process emitted a line. A chat that
 * wakes and does nothing useful still beats.
 */

const fs = require('node:fs');
const path = require('node:path');

/** A beat older than this means the operator is not being woken any more. */
const STALE_AFTER_MS = 15 * 60 * 1000;

function heartbeatPath(root) {
  return path.join(root, '.ai-bus', 'runtime', 'operator-heartbeat.json');
}

/**
 * Record one beat. Never throws: a heartbeat that can kill the tick it rides on would turn a
 * diagnostic into an outage, and the tick's own docstring says it must not depend on anything
 * being up.
 */
function recordBeat(root, { seat, tick }) {
  const file = heartbeatPath(root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify({ seat, pid: process.pid, tick, at: new Date().toISOString() });
    // Write-then-rename so a reader never sees a half-written beat and calls it corrupt.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
  } catch {
    /* a missing beat is a smaller problem than a dead tick */
  }
}

/**
 * What the last beat says, or null when there has never been one.
 *
 * Returns `{seat, pid, tick, at, ageMs, stale}`. `stale` is the whole point: an unread beat
 * from yesterday is worse than no beat, because a timestamp looks like evidence.
 */
function readBeat(root, { now = Date.now(), staleAfterMs = STALE_AFTER_MS } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(heartbeatPath(root), 'utf8'));
  } catch {
    return null;
  }
  const at = Date.parse(parsed && parsed.at);
  if (!Number.isFinite(at)) return null;
  const ageMs = Math.max(0, now - at);
  return {
    seat: parsed.seat ?? null,
    pid: Number.isInteger(parsed.pid) ? parsed.pid : null,
    tick: Number.isInteger(parsed.tick) ? parsed.tick : null,
    at: parsed.at,
    ageMs,
    stale: ageMs > staleAfterMs
  };
}

/**
 * One line for a tick, or null when there is nothing worth saying.
 *
 * Silent while the beat is fresh — a heartbeat announcing its own health every four minutes is
 * noise that trains the reader to skim. It speaks only when the operator has been dark, which
 * is the case nobody could see before.
 */
function heartbeatNotice(root, options = {}) {
  const beat = readBeat(root, options);
  if (!beat) return 'OPERATOR-HEARTBEAT: none recorded - nothing is waking the chat operator';
  if (!beat.stale) return null;
  return `OPERATOR-HEARTBEAT STALE: last beat ${Math.round(beat.ageMs / 60000)}m ago `
    + `(seat ${beat.seat}, tick ${beat.tick}) - the operator was not being woken`;
}

/**
 * CLI, so this is usable by ANY seat regardless of vendor or host.
 *
 *   node scripts/operator-heartbeat.js --root <bus root> [--check] [--stale-after-s 900]
 *
 * Deliberately a standalone script rather than a `mailbox` subcommand. `mailbox.ts` is compiled
 * TypeScript; reaching from `dist/` into `scripts/` would be a layering violation and a build
 * risk, and duplicating the logic on the TS side would be a second answer to one question -
 * the defect this bus has been fixing all week. One implementation, no build step, callable by
 * a Codex seat, a Grok seat, a shell script, or a cron.
 *
 * Exit 0 = a fresh beat. Exit 1 = stale or absent, i.e. nothing is waking the operator. The
 * exit code is the point: a caller with no JSON parser can still branch on it.
 */
if (require.main === module) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
  };
  const root = path.resolve(arg('--root', path.resolve(__dirname, '..', '..', 'ai-bus')));
  const staleAfterMs = Math.max(60, Number(arg('--stale-after-s', '900'))) * 1000;
  const notice = heartbeatNotice(root, { staleAfterMs });
  if (notice) {
    console.log(notice);
    process.exit(1);
  }
  const beat = readBeat(root, { staleAfterMs });
  console.log(`operator heartbeat fresh: seat ${beat.seat}, tick ${beat.tick}, `
    + `${Math.round(beat.ageMs / 1000)}s ago`);
  process.exit(0);
}

module.exports = { STALE_AFTER_MS, heartbeatPath, recordBeat, readBeat, heartbeatNotice };
