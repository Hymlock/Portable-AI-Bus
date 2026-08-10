/** Runnable, project-neutral Portable AI Bus brain. */
const fs = require('node:fs');
const path = require('node:path');

function runtimeModule(relative) {
  const sourceTree = path.join(__dirname, '..', 'dist', 'brain', relative);
  const stagedTree = path.join(__dirname, '..', 'bin', 'brain', relative);
  return fs.existsSync(sourceTree) ? sourceTree : stagedTree;
}

const { createAgentBrain } = require(runtimeModule('brains/index.js'));
const { resolveChain } = require(runtimeModule('providers.js'));

const SUPPORTED_KINDS = new Set(['codex', 'grok', 'cli', 'oauth', 'api']);
const VENDOR_BY_KIND = {
  cli: 'Anthropic',
  oauth: 'Anthropic',
  api: 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI'
};
const DEFAULT_CHAINS = {
  claude: ['cli', 'codex', 'grok', 'oauth', 'api'],
  codex: ['codex', 'grok', 'cli', 'oauth', 'api'],
  grok: ['grok', 'codex', 'cli', 'oauth', 'api'],
  default: ['codex', 'grok', 'cli', 'oauth', 'api']
};

function providerConfigs(env = process.env, seat = 'default') {
  const requested = (env.PORTABLE_AI_BUS_PROVIDER_CHAIN || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const kinds = requested.length > 0 ? requested : (DEFAULT_CHAINS[seat] || DEFAULT_CHAINS.default);
  const invalid = kinds.filter((kind) => !SUPPORTED_KINDS.has(kind));
  if (invalid.length > 0) {
    throw new Error(`Unsupported PORTABLE_AI_BUS_PROVIDER_CHAIN entries: ${invalid.join(', ')}`);
  }
  const vendors = new Set(kinds.map((kind) => VENDOR_BY_KIND[kind]));
  if (vendors.size < 2) {
    throw new Error(
      `A bus seat provider chain must contain at least two distinct vendors; ` +
      `${kinds.join(',')} resolves only to ${[...vendors].join(',')}.`
    );
  }
  return kinds.map((kind) => ({ kind }));
}

const SYSTEM = [
  'You are a provider-neutral agent seat on the Portable AI Bus.',
  'Reply with ONLY a JSON object, without markdown fences:',
  '{"actions":[{"type":"send","to":"<seat>","kind":"ack","subject":"...","body":"..."}],"done":true,"note":"..."}',
  'Allowed action types: send, claim, release, capability, done.',
  'Acknowledge each incoming message before other work.',
  'Claim paths before editing and never edit another seat\'s claimed paths.',
  'Report evidence and failures plainly. Do not pretend a heartbeat proves progress.',
  'If user clarification is required, send the question and identify the open dependency.',
  'Clarification never completes the open goal. "done" ends only this wake, not the bus goal.',
  'Do not declare a goal complete unless its explicit completion requirements were verified.'
].join('\n');

module.exports = ({ seat, log }) => {
  const provider = resolveChain(providerConfigs(process.env, seat), { log });
  const brain = createAgentBrain({ seat, provider, log, systemPrompt: SYSTEM });
  return {
    ...brain,
    name: `agent-seat:${seat}`,
    async start() {
      const health = await provider.probe();
      log('provider-chain', health);
      if (!health.ok) log('no-usable-provider', { detail: health.detail });
      await brain.start?.();
    }
  };
};

module.exports.providerConfigs = providerConfigs;
