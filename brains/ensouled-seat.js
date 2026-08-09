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
 * Chain order per seat, set by what this machine can actually do — verified live 2026-08-09:
 *
 *   cli    the `claude` CLI under the existing subscription. Verified: answers, costs nothing
 *          beyond what Hymlock already pays.
 *   codex  the Codex CLI, `Logged in using ChatGPT`. Verified: free probe, ~5s answers, and
 *          crucially billed to a DIFFERENT vendor.
 *   oauth  the SDK `ant auth login` profile. Supported non-interactively, but no profile
 *          exists here yet, so it fails through until one does.
 *   api    ANTHROPIC_API_KEY. Metered, so it is last.
 *
 * The rule that shapes this: NO CHAIN MAY BE SINGLE-VENDOR. A chain of cli→oauth→api reads
 * like three fallbacks and is really one — all Anthropic, one wallet, and one shared
 * concurrency ceiling. That ceiling is what produced "you've hit your session limit" with the
 * account at 30% usage, and marching down the chain hit the same wall three times. Every chain
 * below therefore crosses a vendor boundary before it runs out.
 *
 * Seats lead with a different vendor from each other on purpose, so two working seats are not
 * queueing behind one provider's limit.
 */
const CHAINS = {
  // Each seat LEADS with its own vendor, then falls through to the others. A seat named for a
  // vendor that is signed out still works - it degrades to a sibling instead of going dark -
  // and the reply records who actually served it, so "grok answered" is never assumed.
  codex: [{ kind: 'codex' }, { kind: 'grok' }, { kind: 'cli' }],
  grok: [{ kind: 'grok' }, { kind: 'codex' }, { kind: 'cli' }],
  default: [{ kind: 'cli' }, { kind: 'codex' }, { kind: 'grok' }, { kind: 'oauth' }, { kind: 'api' }]
};

module.exports = ({ seat, log }) => {
  // Built per seat, not at module load: the chain depends on which seat this is, and a
  // module-level chain silently gave every seat the same vendor.
  const provider = resolveChain(CHAINS[seat] ?? CHAINS.default, { log });
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
