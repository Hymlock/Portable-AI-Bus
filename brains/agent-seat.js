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
const { createStallLedger, stallLedgerPath } = require(runtimeModule('stall-ledger.js'));

const SUPPORTED_KINDS = new Set(['codex', 'grok', 'cli', 'oauth', 'api']);
const VENDOR_BY_KIND = {
  cli: 'Anthropic',
  oauth: 'Anthropic',
  api: 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI'
};
const DEFAULT_CHAINS = {
  claude: ['cli', 'oauth', 'api'],
  codex: ['codex'],
  grok: ['grok']
};
const VENDOR_BY_SEAT = {
  claude: 'Anthropic',
  codex: 'OpenAI',
  grok: 'xAI'
};

function providerConfigs(env = process.env, seat = 'default', workdir, log) {
  const seatVendor = VENDOR_BY_SEAT[seat];
  if (!seatVendor) {
    throw new Error(`Unknown funded seat: ${seat}. Expected one of ${Object.keys(VENDOR_BY_SEAT).join(', ')}.`);
  }
  const requested = (env.PORTABLE_AI_BUS_PROVIDER_CHAIN || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  const kinds = requested.length > 0 ? requested : DEFAULT_CHAINS[seat];
  const invalid = kinds.filter((kind) => !SUPPORTED_KINDS.has(kind));
  if (invalid.length > 0) {
    throw new Error(`Unsupported PORTABLE_AI_BUS_PROVIDER_CHAIN entries: ${invalid.join(', ')}`);
  }
  const wrongVendor = kinds.filter((kind) => VENDOR_BY_KIND[kind] !== seatVendor);
  if (wrongVendor.length > 0) {
    throw new Error(
      `Seat ${seat} is bound to ${seatVendor}; refusing cross-vendor provider(s): ` +
      `${wrongVendor.map((kind) => `${kind}=${VENDOR_BY_KIND[kind]}`).join(', ')}. ` +
      `A named brain may not spend another vendor's credits.`
    );
  }
  return kinds.map((kind) => {
    if (!workdir) return { kind };
    if (kind === 'cli') return { kind, cli: { cwd: workdir } };
    if (kind === 'codex') return { kind, codex: { cwd: workdir } };
    if (kind === 'grok') return { kind, grok: { cwd: workdir, ...(log ? { log } : {}) } };
    return { kind };
  });
}

const SYSTEM = [
  'You are a provider-neutral agent seat on the Portable AI Bus.',
  'Reply with ONLY a JSON object, without markdown fences:',
  '{"actions":[{"type":"send","to":"<seat>","kind":"ack","subject":"...","body":"..."}],"done":false,"note":"gates not met"}',
  'Allowed action types: send, claim, release, capability, done.',
  'Acknowledge each incoming message before other work.',
  'Claim paths before editing and never edit another seat\'s claimed paths.',
  'Report evidence and failures plainly. Do not pretend a heartbeat proves progress.',
  'If user clarification is required, send the question and identify the open dependency.',
  'Clarification never completes the open goal.',
  'done:true means the assigned gates passed and were committed. An acknowledgement or a note is not completion. If the gates are unmet, set done:false and leave a note so the task stays open.',
  'Do not declare a goal complete unless its explicit completion requirements were verified.'
].join('\n');

function providerHostOptions(seat, root, log) {
  // Same file the runner opens in cli.ts. Two handles on one path are already
  // the item-5 contract; what was missing is that resolveChain never received
  // either handle, so process-host could not write.
  let stallLedger;
  try {
    stallLedger = createStallLedger({ seat, filePath: stallLedgerPath(root, seat) });
  } catch (error) {
    log?.('stall-ledger-unreadable', { seat, error: error?.message ?? String(error) });
    stallLedger = createStallLedger({ seat });
  }
  return { log, stallLedger, stallSeat: seat };
}

module.exports = ({ seat, root, workdir = root, log }) => {
  // The chain and the provider adapter both emit evidence. Pass the same brain logger into the
  // Grok adapter so `grok-extract-fellback` cannot silently disappear behind its no-op default.
  const provider = resolveChain(
    providerConfigs(process.env, seat, workdir, log),
    providerHostOptions(seat, root, log)
  );
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
module.exports.providerHostOptions = providerHostOptions;
