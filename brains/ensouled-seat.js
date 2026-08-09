/**
 * A runnable brain for an Ensouled bus seat.
 *
 * This is the file that actually stops the loop stagnating. Everything else was machinery;
 * this is a thing you can start.
 *
 *   node dist/brain/cli.js --root "<bus root>" --seat <seat> --brain ./brains/ensouled-seat.js
 *
 * Start it DETACHED. The point is that it outlives whatever launched it - a chat turn ending
 * must not end the agent, because reporting and stopping being the same act is the bug.
 *
 * The seat is a ROLE, not a vendor. A seat named `grok` backed by the `claude` CLI is correct
 * and deliberate: Hymlock's constraint is that no seat may be tied to one vendor, so the seat
 * name says what the seat is FOR, and the chain says who is currently able to think for it.
 */

const { agentBrainFactory } = require('../dist/brain/brains/index.js');
const { resolveChain } = require('../dist/brain/providers.js');

const SYSTEM = [
  'You are a seat on the Portable AI Bus, working on the Ensouled project.',
  '',
  'Reply with ONLY a JSON object, no markdown fences:',
  '{"actions":[{"type":"send","to":"<seat>","kind":"ack","subject":"...","body":"..."}],',
  ' "done":true,"note":"..."}',
  '',
  'Action types: send, claim, release, capability, done.',
  '',
  'Rules that matter here, learned the hard way:',
  '- Acknowledge every message you receive with a short receipt BEFORE other work.',
  '  Silence is indistinguishable from working, undelivered, and dead.',
  '- Report what you did, including failures. A green report nobody verified is worse',
  '  than a red one.',
  '- Claim paths before touching them; never touch another seat’s files.',
  '- If you cannot do something, say so plainly rather than doing something adjacent.',
  '- Do not name vendors, CLI tools or API keys. Stay model-agnostic.'
].join('\n');

/**
 * Chain order is set by what this machine can actually do, verified 2026-08-09:
 *
 *   cli    the `claude` CLI under the existing subscription. VERIFIED WORKING - costs
 *          nothing beyond what Hymlock already pays.
 *   oauth  the SDK `ant auth login` profile. Codex confirmed the SDK supports these
 *          non-interactively, but no profile exists on this machine yet, so it sits second
 *          and simply fails through until one does.
 *   api    ANTHROPIC_API_KEY. Metered, so it is last.
 *
 * Every link failing is not a crash: the runner reports `exhausted`, hands the baton to a
 * seat that still has credit, and keeps listening for when credit returns.
 */
const provider = resolveChain([
  { kind: 'cli' },
  { kind: 'oauth' },
  { kind: 'api' }
]);

module.exports = ({ seat, log }) => {
  const factory = agentBrainFactory(provider);
  const brain = factory({ seat, log });
  return {
    ...brain,
    name: `ensouled-seat:${seat}`,
    async start() {
      const health = await provider.probe();
      log('provider-chain', health);
      if (!health.ok) {
        // Loud, and still not fatal. A seat that refuses to start needs a human; a seat that
        // starts and reports no usable provider can recover the moment one appears.
        log('no-usable-provider', { detail: health.detail });
      }
      await brain.start?.();
    }
  };
};
