/**
 * Model-agnostic agent brain.
 *
 * One prompt shape, one action schema, any ModelProvider (including a chain). There is no
 * Anthropic/OpenAI/xAI branch here — if a seat needs a vendor, that belongs in the provider
 * chain, not in the brain. That is Hymlock's hard constraint: no seat tied to one vendor.
 */

import { Brain, BrainFactory, BrainMessage, BrainTools, WakeContext, WakeResult } from '../contract';
import { ChainReply } from '../chain';
import { ModelProvider, ModelReply } from '../providers';

/** Vendor-neutral action the model may request. Keep this tiny on purpose. */
export type BrainAction =
  | { type: 'send'; to: string; kind?: string; subject: string; body: string; keepBaton?: boolean }
  | { type: 'claim'; paths: string[]; why: string }
  | { type: 'release'; paths?: string[] }
  | { type: 'capability'; id: string; timeoutMs?: number }
  | { type: 'done'; note?: string };

export type AgentPlan = {
  actions: BrainAction[];
  /** When true (default), this wake is finished after actions run. */
  done?: boolean;
  note?: string;
};

export type AgentBrainOptions = {
  seat: string;
  /** Usually a chainProviders(...) result. The brain never inspects kind. */
  provider: ModelProvider;
  systemPrompt?: string;
  /** Max model round-trips inside one wake (tool loop). */
  maxRounds?: number;
  log?: (event: string, data?: unknown) => void;
};

const DEFAULT_SYSTEM = [
  'You are a bus seat agent. You receive mail and decide actions.',
  'Reply with ONLY a JSON object (no markdown fences) of the form:',
  '{"actions":[{"type":"send","to":"<seat>","kind":"ack","subject":"...","body":"..."}],"done":true,"note":"..."}',
  'Allowed action types: send, claim, release, capability, done.',
  'Always acknowledge each incoming message with a short receipt send before other work.',
  'Do not name vendors, CLI tools, or API keys. Stay model-agnostic.'
].join(' ');

export function buildWakePrompt(seat: string, messages: BrainMessage[]): string {
  const lines = [
    `Seat: ${seat}`,
    `Incoming messages: ${messages.length}`,
    ''
  ];
  if (messages.length === 0) {
    lines.push('No mail. If you have nothing to do, reply {"actions":[],"done":true}.');
  } else {
    for (const m of messages) {
      lines.push(`--- #${m.seq} from ${m.from} kind=${m.kind}`);
      lines.push(`subject: ${m.subject}`);
      lines.push(m.body.slice(0, 4000));
      lines.push('');
    }
  }
  lines.push('Respond with the JSON plan only.');
  return lines.join('\n');
}

/**
 * Parse model text into a plan. Malformed output becomes a safe empty plan with an error note
 * rather than a throw — a brain that dies on bad model text is the stall we are removing.
 */
export function parsePlan(text: string): { plan: AgentPlan; malformed: boolean } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { plan: { actions: [], done: true, note: 'empty-model-output' }, malformed: true };
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { plan: { actions: [], done: true, note: 'no-json-object' }, malformed: true };
  }
  try {
    const raw = JSON.parse(trimmed.slice(start, end + 1)) as Partial<AgentPlan>;
    const actions = Array.isArray(raw.actions) ? raw.actions.filter(isAction) : [];
    return {
      plan: {
        actions,
        done: raw.done !== false,
        note: typeof raw.note === 'string' ? raw.note : undefined
      },
      malformed: false
    };
  } catch {
    return { plan: { actions: [], done: true, note: 'json-parse-failed' }, malformed: true };
  }
}

function isAction(value: unknown): value is BrainAction {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return type === 'send' || type === 'claim' || type === 'release' ||
    type === 'capability' || type === 'done';
}

export async function executePlan(tools: BrainTools, plan: AgentPlan): Promise<void> {
  for (const action of plan.actions) {
    switch (action.type) {
      case 'send':
        await tools.send({
          to: action.to,
          kind: action.kind ?? 'note',
          subject: action.subject,
          body: action.body,
          keepBaton: action.keepBaton
        });
        break;
      case 'claim':
        await tools.claim(action.paths, action.why);
        break;
      case 'release':
        await tools.release(action.paths);
        break;
      case 'capability':
        await tools.runCapability(action.id, action.timeoutMs);
        break;
      case 'done':
        break;
      default:
        break;
    }
  }
}

/**
 * Fallback when the model is exhausted or unusable: still honour echo-on-receipt so silence
 * never means "maybe working".
 */
export function receiptPlan(seat: string, messages: BrainMessage[]): AgentPlan {
  return {
    done: true,
    note: 'receipt-only',
    actions: messages.map((m) => ({
      type: 'send' as const,
      to: m.from,
      kind: 'ack',
      subject: `echo #${m.seq}: ${m.subject}`.slice(0, 200),
      body: `${seat} received #${m.seq} (model unavailable; receipt only).`,
      keepBaton: true
    }))
  };
}

export function createAgentBrain(options: AgentBrainOptions): Brain {
  const {
    seat,
    provider,
    systemPrompt = DEFAULT_SYSTEM,
    maxRounds = 3,
    log = () => {}
  } = options;

  return {
    name: 'agent',

    async takeTurn(context: WakeContext): Promise<WakeResult> {
      const { messages, tools } = context;
      let sessionId: string | undefined;
      let lastNote = '';
      let servedBy: string | undefined;
      let exhausted = false;

      for (let round = 0; round < maxRounds; round += 1) {
        const prompt = buildWakePrompt(seat, messages);
        let reply: ModelReply | ChainReply;
        try {
          reply = await provider.ask(prompt, { systemPrompt, sessionId });
        } catch (error) {
          const detail = (error as Error)?.message ?? String(error);
          log('provider-threw', { seat, detail: detail.slice(0, 200) });
          const plan = receiptPlan(seat, messages);
          await executePlan(tools, plan);
          return { done: true, note: `provider-threw:${detail.slice(0, 80)}` };
        }

        const chain = reply as ChainReply;
        if (typeof chain.servedBy === 'string') servedBy = chain.servedBy;
        if (chain.exhausted === true) {
          exhausted = true;
          log('provider-exhausted', { seat, attempts: chain.attempts });
          const plan = receiptPlan(seat, messages);
          await executePlan(tools, plan);
          // exhausted:true is the runner signal for onExhausted → reassignBaton (5af3b1c).
          return {
            done: true,
            exhausted: true,
            note: `chain-exhausted:attempts=${chain.attempts.map((a) => `${a.kind}:${a.reason}`).join(',')}`
          };
        }

        if (reply.isError || !reply.text.trim()) {
          log('provider-error-reply', { seat, text: reply.text.slice(0, 120) });
          const plan = receiptPlan(seat, messages);
          await executePlan(tools, plan);
          return { done: true, note: 'provider-error-reply' };
        }

        if (reply.sessionId) sessionId = reply.sessionId;
        const { plan, malformed } = parsePlan(reply.text);
        if (malformed) {
          log('malformed-plan', { seat, snippet: reply.text.slice(0, 120) });
          // One retry with a repair prompt; if still bad, receipt-only.
          if (round + 1 < maxRounds) {
            const repair = await provider.ask(
              'Your previous reply was not valid JSON. Reply again with ONLY the JSON plan object.',
              { systemPrompt, sessionId }
            );
            if (!repair.isError && repair.text.trim()) {
              const second = parsePlan(repair.text);
              if (!second.malformed) {
                await executePlan(tools, second.plan);
                return {
                  done: second.plan.done !== false,
                  note: `repaired${servedBy ? `;servedBy=${servedBy}` : ''}`
                };
              }
            }
          }
          const fallback = receiptPlan(seat, messages);
          await executePlan(tools, fallback);
          return { done: true, note: 'malformed-output' };
        }

        await executePlan(tools, plan);
        lastNote = plan.note ?? (servedBy ? `servedBy=${servedBy}` : 'ok');
        if (plan.done !== false) {
          return { done: true, note: lastNote };
        }
        // Model asked to continue; loop with same mail context (tool results are side effects).
      }

      return { done: true, note: lastNote || 'max-rounds', capped: true };
    }
  };
}

/** Factory for cli --brain path. Expects provider to be injected by a thin wrapper module. */
export const agentBrainFactory = (provider: ModelProvider): BrainFactory => {
  return ({ seat, log }) => createAgentBrain({ seat, provider, log });
};
