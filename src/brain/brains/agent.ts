/**
 * Model-agnostic agent brain.
 *
 * One prompt shape, one action schema, any ModelProvider (including a chain). There is no
 * Anthropic/OpenAI/xAI branch here â€” if a seat needs a vendor, that belongs in the provider
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
  'Exact action schemas:',
  'send={"type":"send","to":"seat","kind":"ack|report|finding|note","subject":"text","body":"text","keepBaton":true|false};',
  'claim={"type":"claim","paths":["relative/path"],"why":"text"};',
  'release={"type":"release","paths":["relative/path"]};',
  'capability={"type":"capability","id":"bus.doctor","timeoutMs":60000};',
  'done={"type":"done","note":"text"}. Never omit required fields.',
  'Acknowledge each incoming message at most once with a short receipt before other work; never repeat an acknowledgement on a repair or continuation round.',
  // Without this line an agentic CLI reaches for a shell it does not have and ABORTS the whole
  // reply. Measured: the same inspection task, changing only the system prompt -
  //   plain    6s  stopReason=cancelled  {"actions":[{"type":"capability","name":"shell"...}]}
  //   this    19s  stopReason=end_turn   {"actions":[{"type":"send","to":"hymlock"...}]}
  // The grok seat spent two days producing nothing because of it. Vendor-neutral by design: it
  // describes what a SEAT is, not what any product can do.
  // This line said "you cannot run shell commands or inspect the machine yourself" for several
  // hours. It was false: seats are designed to have full functionality in their workdir, and
  // saying otherwise turned capable agents into note-writers. It appeared to fix grok only
  // because grok was cancelling on a permission it could not obtain - the real fix was granting
  // the permission, not denying the capability.
  //
  // What IS true and worth stating: your own tools work in your workdir; bus effects are
  // separate and go through bus actions, where claims and receipts apply.
  'You can read, edit and run things in your working directory using your own tools. Do that when a task needs it.',
  'Bus effects are different: sending mail, claiming paths and running allowlisted capabilities happen ONLY through the bus actions above, so they are recorded. Claim a path before you edit it.',
  'If a task needs something you genuinely cannot obtain, send a report saying exactly what is missing. Never invent an action type, and never claim work you did not do.',
  // Every seat can hold the baton, so every seat can pilot. A seat that treats itself as a
  // subordinate waiting for instructions wastes that: it asks permission for work it already
  // has the authority and the tools to finish.
  'You are a peer, not a subordinate. Any seat can hold the baton and drive the work; when you hold it, decide and act rather than asking what to do next.',
  'Hand the baton on when someone else is better placed, or when you are blocked - and say why in the same message.',
  'Do not name vendors, CLI tools, or API keys. Stay model-agnostic.'
].join(' ');

/**
 * The plan shape, as JSON Schema, for providers that can constrain decoding.
 *
 * Declared once and passed on every `ask`. Providers that support it (xAI's CLI does, via
 * `--json-schema`) can no longer return prose; the rest ignore it and `parsePlan` handles the
 * output exactly as before. No vendor branch enters the brain.
 *
 * This exists because the grok seat replied "I'll identify the code commit and report findings"
 * â€” every wake, ending in `malformed-output`, while authenticated and billing its own vendor.
 * The prompt already said "reply with ONLY a JSON object". A schema is the difference between
 * asking and requiring.
 */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['send', 'claim', 'release', 'capability', 'done'] },
          to: { type: 'string' },
          kind: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          keepBaton: { type: 'boolean' },
          paths: { type: 'array', items: { type: 'string' } },
          why: { type: 'string' },
          id: { type: 'string' },
          timeoutMs: { type: 'number' }
        },
        required: ['type']
      }
    },
    done: { type: 'boolean' },
    note: { type: 'string' }
  },
  required: ['actions', 'done']
};

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
 * rather than a throw â€” a brain that dies on bad model text is the stall we are removing.
 */
function planFromJsonStream(text: string, depth = 0): Partial<AgentPlan> | undefined {
  if (depth >= 12) return undefined;
  let best: Partial<AgentPlan> | undefined;
  let objectStart = -1;
  let braces = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && inString) { escaped = true; continue; }
    if (character === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (character === '{') {
      if (braces === 0) objectStart = index;
      braces += 1;
    } else if (character === '}' && braces > 0) {
      braces -= 1;
      if (braces !== 0 || objectStart < 0) continue;
      try {
        const candidate = JSON.parse(text.slice(objectStart, index + 1)) as Record<string, unknown>;
        if (Array.isArray(candidate.actions)) best = candidate as Partial<AgentPlan>;
        for (const key of ['text', 'result', 'response', 'content', 'message']) {
          const nested = candidate[key];
          if (typeof nested !== 'string' || !nested.trim()) continue;
          const plan = planFromJsonStream(nested, depth + 1);
          if (plan) best = plan;
        }
      } catch { /* keep scanning the provider stream */ }
      objectStart = -1;
    }
  }
  return best;
}

export function parsePlan(text: string): { plan: AgentPlan; malformed: boolean } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { plan: { actions: [], done: true, note: 'empty-model-output' }, malformed: true };
  }

  // Provider adapters normally remove their transport envelopes, but the plan boundary must
  // remain safe when one leaks through. Live Grok output reached this function as
  // `{ "text": "{\"actions\":[...] }" }`; treating that as an empty plan bought an
  // unnecessary repair call. Peel only known answer fields, with a hard bound, until the
  // object itself has an actions array. This also covers nested CLI/SDK transports without
  // weakening action validation below.
  const raw = planFromJsonStream(trimmed);
  if (!raw) {
    return { plan: { actions: [], done: true, note: 'no-json-object' }, malformed: true };
  }
  try {
    const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
    // Normalise BEFORE filtering, and keep the normalised objects. `isAction` is a type guard,
    // so filtering alone would return the originals - validation would accept `reason` and
    // execution would then read `why` as undefined. That is a worse failure than the one being
    // fixed: an action that passes every check and silently does nothing.
    const actions = rawActions
      .map((action) => (action && typeof action === 'object'
        ? normalizeAction(action as Record<string, unknown>)
        : action))
      .filter(isAction);
    // Reject unsafe/meaningless actions individually without throwing away valid siblings.
    // Live Grok output paired a valid acknowledgement with a conceptual task `claim` carrying
    // an id and timeout instead of filesystem paths. The invalid claim was correctly filtered,
    // but marking the whole plan malformed discarded the acknowledgement and bought another
    // repair call. A plan is malformed when its action container is absent, or when it requested
    // actions and NONE are safe to execute. The done-without-report guard still prevents a valid
    // courtesy action from concealing an invalid/missing substantive report.
    const hasOnlyRejectedActions = rawActions.length > 0 && actions.length === 0;
    return {
      plan: {
        actions,
        done: raw.done !== false,
        note: typeof raw.note === 'string' ? raw.note : undefined
      },
      malformed: !Array.isArray(raw.actions) || hasOnlyRejectedActions
    };
  } catch {
    return { plan: { actions: [], done: true, note: 'json-parse-failed' }, malformed: true };
  }
}

/**
 * Accept the synonyms models actually reach for, before validating.
 *
 * The prompt specifies `why`, and the codex seat wrote `reason` anyway — a sensible claim on
 * `src/bus.ts`, dropped by the validator, plan marked malformed, and the seat looped through
 * NINE repair rounds producing nothing. Every round was a paid model call.
 *
 * Strictness at this boundary buys nothing: the field means the same thing whichever word the
 * model picked, and refusing it does not teach the model, it just burns the wake. Normalise the
 * near-misses; keep the validator strict about everything that carries real meaning.
 */
function normalizeAction(value: Record<string, unknown>): Record<string, unknown> {
  const action = { ...value };
  const alias = (from: string, to: string) => {
    if (action[to] === undefined && typeof action[from] === 'string') action[to] = action[from];
  };
  alias('reason', 'why');       // claim
  alias('rationale', 'why');
  alias('recipient', 'to');     // send
  alias('message', 'body');
  alias('title', 'subject');
  alias('capability', 'id');    // capability
  alias('name', 'id');
  // A single path where a list is required is the other common near-miss.
  if (Array.isArray(action.paths) === false && typeof action.path === 'string') {
    action.paths = [action.path];
  }
  return action;
}

function isAction(value: unknown): value is BrainAction {
  if (!value || typeof value !== 'object') return false;
  const action = normalizeAction(value as Record<string, unknown>);
  const strings = (items: unknown) => Array.isArray(items) && items.length > 0 &&
    items.every((item) => typeof item === 'string' && item.trim().length > 0);
  switch (action.type) {
    case 'send':
      return typeof action.to === 'string' && action.to.trim().length > 0 &&
        typeof action.subject === 'string' && typeof action.body === 'string' &&
        (action.kind === undefined || typeof action.kind === 'string') &&
        (action.keepBaton === undefined || typeof action.keepBaton === 'boolean');
    case 'claim':
      return strings(action.paths) && typeof action.why === 'string' && action.why.trim().length > 0;
    case 'release':
      return action.paths === undefined || strings(action.paths);
    case 'capability':
      return typeof action.id === 'string' && action.id.trim().length > 0 && action.id.length <= 100 &&
        (action.timeoutMs === undefined || (Number.isInteger(action.timeoutMs) && Number(action.timeoutMs) > 0));
    case 'done':
      return action.note === undefined || typeof action.note === 'string';
    default:
      return false;
  }
}

/**
 * Message kinds that are pure courtesy. Sending one does not answer a task.
 *
 * Kept in step with the runner's `ackKinds`, which drops wakes carrying only these â€” the two
 * rules are the same idea seen from opposite ends: a receipt neither earns a reply nor counts
 * as one.
 */
const RECEIPT_KINDS = new Set(['ack', 'receipt', 'ping']);

/** What went wrong while carrying out a plan, in the model's own terms. */
export type PlanFailure = { action: string; detail: string };

/**
 * Did a bus tool refuse this call?
 *
 * `cliBusClient` never throws â€” a failing call returns `{ error }` so one bad tool cannot kill
 * a wake. That is right, but it means a discarded return value is a SILENTLY discarded failure.
 */
function toolFailure(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.refused === 'string') return record.refused;
  return undefined;
}

/**
 * Carry out a plan, and REPORT what failed.
 *
 * The first version awaited every tool call and threw the result away. A seat then addressed a
 * report to a seat that does not exist, the harness answered
 * `403 unknown_seat: Recipient orchestrator is not a registered seat`, and the brain â€” never
 * having looked â€” reported `done`. The audit it had been asked for was simply gone, and the log
 * said the wake succeeded.
 *
 * Returning the failures lets the caller do the only correct thing: tell the model its send did
 * not land, and keep the work open instead of closing it.
 */
export async function executePlan(
  tools: BrainTools,
  plan: AgentPlan,
  routing: { seats?: string[]; fallbackTo?: string } = {}
): Promise<PlanFailure[]> {
  const failures: PlanFailure[] = [];
  const note = (action: string, result: unknown) => {
    const detail = toolFailure(result);
    if (detail) failures.push({ action, detail });
  };

  /**
   * Deliver to a real seat, even when the model names one that does not exist.
   *
   * The grok seat repeatedly addressed reports to `console`. The harness refused each one
   * (`403 unknown_seat`), so the report never landed, so "done requires a report" correctly
   * refused to close the wake, so the repair path ran - TEN paid calls on a task whose actual
   * work had already been committed. A correct guard amplifying one bad recipient.
   *
   * Redirecting to whoever asked is the honest repair: the report reaches a real seat, and the
   * substitution is recorded as a failure so the model is told it got the name wrong. Refusing
   * instead would be principled and would lose the report, which is the outcome that costs.
   */
  const resolveRecipient = (requested: string): { to: string; problem?: string } => {
    const seats = routing.seats ?? [];
    if (seats.length === 0 || seats.includes(requested)) return { to: requested };
    const fallback = routing.fallbackTo && seats.includes(routing.fallbackTo)
      ? routing.fallbackTo
      : undefined;
    if (!fallback) return { to: requested };
    return {
      to: fallback,
      problem: `"${requested}" is not a seat; delivered to "${fallback}" instead. Seats: ${seats.join(', ')}.`
    };
  };

  for (const action of plan.actions) {
    switch (action.type) {
      case 'send': {
        const { to, problem } = resolveRecipient(action.to);
        if (problem) failures.push({ action: `send to ${action.to}`, detail: problem });
        note(`send to ${to}`, await tools.send({
          to,
          kind: action.kind ?? 'note',
          subject: action.subject,
          body: action.body,
          keepBaton: action.keepBaton
        }));
        break;
      }
      case 'claim':
        note('claim', await tools.claim(action.paths, action.why));
        break;
      case 'release':
        note('release', await tools.release(action.paths));
        break;
      case 'capability':
        note(`capability ${action.id}`, await tools.runCapability(action.id, action.timeoutMs));
        break;
      case 'done':
        break;
      default:
        break;
    }
  }
  return failures;
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
    // Raised from 3. Three rounds is enough to acknowledge and stop, which is exactly what two
    // seats did when handed multi-step audits, and not enough to investigate anything. Running
    // out of rounds now returns `done: false`, so this bounds a WAKE rather than the work.
    maxRounds = 12,
    log = () => {}
  } = options;

  return {
    name: 'agent',

    async takeTurn(context: WakeContext): Promise<WakeResult> {
      const { messages, tools } = context;
      let sessionId: string | undefined;
      let lastNote = '';
      let servedBy: string | undefined;

      /**
       * Seats this brain may address, learned from the bus rather than guessed.
       *
       * Without it a model invents plausible names â€” one addressed a report to `orchestrator`,
       * the harness answered `403 unknown_seat`, and the report was lost. Nothing in the prompt
       * had ever told it which seats exist.
       */
      let knownSeats: string[] = [];
      try {
        const status = await tools.status() as { agents?: unknown };
        if (Array.isArray(status?.agents)) {
          knownSeats = status.agents.filter((a): a is string => typeof a === 'string');
        }
      } catch {
        // A roster we could not read is not worth failing a wake over; the prompt just omits it.
      }

      /**
       * Capabilities this seat may actually run, for the same reason as the roster.
       *
       * Three seats burned whole wakes calling `shell`, `workspace_runner` and
       * `read_write_test`. None exists. Nothing had ever told them what does, so each failure
       * earned a repair round and each repair round produced a fresh guess - paid calls all the
       * way down. An inventory costs one cheap call and ends the guessing.
       */
      let knownCapabilities: string[] = [];
      try {
        knownCapabilities = await tools.listCapabilities?.() ?? [];
      } catch {
        // Same rule: not knowing is survivable, failing the wake over it is not.
      }

      const exhaustionNote = (reply: ChainReply) =>
        `chain-exhausted:attempts=${(reply.attempts ?? [])
          .map((a: { kind: string; reason?: string }) => `${a.kind}:${a.reason ?? 'error'}`)
          .join(',') || 'unreported'}`;
      const durableNote = (note?: string) => {
        const base = note?.trim() || 'ok';
        return servedBy && !base.includes(`servedBy=${servedBy}`)
          ? `${base};servedBy=${servedBy}`
          : base;
      };

      const rosterLine = knownSeats.length
        ? `Seats that exist on this bus: ${knownSeats.join(', ')}. Address mail ONLY to these; ` +
          'any other name is refused and your message is lost.'
        : '';

      // State the allowlist, or state that there is none. Silence is what produced the guessing:
      // a seat told nothing assumes a shell exists somewhere and spends the wake looking for it.
      // Two different surfaces, and conflating them cost real work. `capability` is the BUS's
      // allowlisted runner set - small, recorded, shared. A seat's OWN tools are separate and
      // unrestricted, matching what its vendor plugin has.
      //
      // The first version said "There is no shell, and no capability writes files" full stop.
      // Seats read that as a statement about their total powers and refused perfectly ordinary
      // work, quoting it back verbatim: "this bus wake exposes no file-read capability... its
      // capability policy explicitly says there is no shell". They were obeying me exactly. The
      // sentence was true of the bus surface and false of the seat.
      const capabilityLine = knownCapabilities.length
        ? `Bus capabilities (the shared, recorded runners): ${knownCapabilities.join(', ')}. ` +
          'Only these ids exist; any other is refused, and none of them is a shell. ' +
          'This is NOT a limit on you: your own tools work normally, in any directory you can ' +
          'reach, exactly as they do in your vendor\'s editor. Use them to read, edit and run ' +
          'things; use bus actions when the effect should be recorded on the bus.'
        : 'No bus capabilities are registered. That does not restrict your own tools - read, ' +
          'edit and run things normally; the bus simply has no shared runners configured.';

      /** Set when a round ended in `done` with nothing sent; carried into the next prompt. */
      let unreportedTask = false;
      let receiptSent = false;
      const wasAsked = messages.some((m) => String(m.kind ?? '').toLowerCase() === 'task');
      const reportsTask = (plan: AgentPlan) => plan.actions.some(
        (action) => action.type === 'send' && !RECEIPT_KINDS.has(String(action.kind ?? 'note').toLowerCase())
      );
      const executeTrackedPlan = async (plan: AgentPlan) => {
        const actions = receiptSent
          ? plan.actions.filter((action) => !(
              action.type === 'send' && RECEIPT_KINDS.has(String(action.kind ?? 'note').toLowerCase())
            ))
          : plan.actions;
        const filtered = actions === plan.actions ? plan : { ...plan, actions };
        const attemptedReceipt = actions.some((action) =>
          action.type === 'send' && RECEIPT_KINDS.has(String(action.kind ?? 'note').toLowerCase())
        );
        // Route against the real roster, falling back to whoever sent the task. A report
        // addressed to a seat that does not exist is a lost report, and the guard that notices
        // it then costs a repair round per attempt.
        const failures = await executePlan(tools, filtered, {
          seats: knownSeats,
          fallbackTo: messages.find((m) => knownSeats.includes(m.from))?.from ?? 'hymlock'
        });
        if (attemptedReceipt && !failures.some((failure) => failure.action.startsWith('send to '))) {
          receiptSent = true;
        }
        return failures;
      };

      for (let round = 0; round < maxRounds; round += 1) {
        const base = buildWakePrompt(seat, messages);
        const correction = unreportedTask
          ? 'You marked the work done without answering the task. An acknowledgement is NOT an ' +
            'answer - it says you heard the request, not what you found. An acknowledgement ' +
            'already landed; DO NOT send another one. Perform the requested work and send your actual ' +
            'findings to the seat that asked, using a kind such as "report" or "finding" ' +
            '(never "ack"), or set "done":false and keep working.\n\n'
          : '';
        const prompt = [correction, rosterLine, capabilityLine, base]
          .filter((part) => typeof part === 'string' && part.length > 0)
          .join('\n\n');
        let reply: ModelReply | ChainReply;
        try {
          reply = await provider.ask(prompt, { systemPrompt, sessionId, responseSchema: PLAN_SCHEMA });
        } catch (error) {
          const detail = (error as Error)?.message ?? String(error);
          log('provider-threw', { seat, detail: detail.slice(0, 200) });
          const plan = receiptPlan(seat, messages);
          await executeTrackedPlan(plan);
          return { done: true, note: `provider-threw:${detail.slice(0, 80)}` };
        }

        const chain = reply as ChainReply;
        if (typeof chain.servedBy === 'string') servedBy = chain.servedBy;
        else if (!reply.isError && reply.text.trim()) servedBy = provider.kind;
        if (chain.exhausted === true) {
          log('provider-exhausted', { seat, attempts: chain.attempts });
          const plan = receiptPlan(seat, messages);
          await executeTrackedPlan(plan);
          // exhausted:true is the runner signal for onExhausted â†’ reassignBaton (5af3b1c).
          return {
            done: true,
            exhausted: true,
            // `attempts` is only present when the provider IS a chain. A bare provider
            // reports exhaustion without it, and reading .map on undefined killed the
            // wake - which the runner survived, but the seat then did no work while
            // looking attended. Degrade to a plain note instead.
            note: exhaustionNote(chain)
          };
        }

        if (reply.isError || !reply.text.trim()) {
          log('provider-error-reply', { seat, text: reply.text.slice(0, 120) });
          const plan = receiptPlan(seat, messages);
          await executeTrackedPlan(plan);
          return { done: true, note: 'provider-error-reply' };
        }

        if (reply.sessionId) sessionId = reply.sessionId;
        const { plan, malformed } = parsePlan(reply.text);
        if (malformed) {
          log('malformed-plan', { seat, snippet: reply.text.slice(0, 120) });
          // One retry with a repair prompt; if still bad, receipt-only.
          if (round + 1 < maxRounds) {
            let repair: ModelReply | ChainReply;
            try {
              repair = await provider.ask(
                'Your previous reply was not valid JSON. Reply again with ONLY the JSON plan object.',
                { systemPrompt, sessionId, responseSchema: PLAN_SCHEMA }
              );
            } catch (error) {
              const detail = (error as Error)?.message ?? String(error);
              log('provider-threw', { seat, phase: 'repair', detail: detail.slice(0, 200) });
              const fallback = receiptPlan(seat, messages);
              await executeTrackedPlan(fallback);
              return { done: true, note: `provider-threw:${detail.slice(0, 80)}` };
            }
            const repairChain = repair as ChainReply;
            if (typeof repairChain.servedBy === 'string') servedBy = repairChain.servedBy;
            else if (!repair.isError && repair.text.trim()) servedBy = provider.kind;
            if (repairChain.exhausted === true) {
              log('provider-exhausted', { seat, phase: 'repair', attempts: repairChain.attempts });
              const fallback = receiptPlan(seat, messages);
              await executeTrackedPlan(fallback);
              return { done: true, exhausted: true, note: exhaustionNote(repairChain) };
            }
            if (!repair.isError && repair.text.trim()) {
              const second = parsePlan(repair.text);
              if (!second.malformed) {
                await executeTrackedPlan(second.plan);
                if (second.plan.done !== false && wasAsked && !reportsTask(second.plan)) {
                  log('done-without-report', { seat, round, phase: 'malformed-repair' });
                  unreportedTask = true;
                  lastNote = durableNote('repaired plan omitted task report - continuing');
                  continue;
                }
                return {
                  done: second.plan.done !== false,
                  note: durableNote('repaired')
                };
              }
            }
          }
          const fallback = receiptPlan(seat, messages);
          await executeTrackedPlan(fallback);
          return { done: true, note: 'malformed-output' };
        }

        const failures = await executeTrackedPlan(plan);
        // Provider identity is orchestration evidence, not model prose. Always retain it even
        // when the model supplies a friendly note of its own.
        lastNote = durableNote(plan.note);

        if (failures.length > 0) {
          // A refused tool call is NOT a completed turn. Tell the model exactly what the bus
          // said and give it another round, because the alternative is what already happened
          // once: a report addressed to a seat that does not exist, silently discarded, and a
          // wake that logged success.
          log('plan-actions-failed', { seat, failures });
          const detail = failures.map((f) => `${f.action}: ${f.detail}`).join('; ');
          lastNote = durableNote(`action-failed: ${detail}`.slice(0, 200));
          if (round + 1 < maxRounds) {
            try {
              const retry = await provider.ask(
                `These actions were REFUSED by the bus and did NOT happen: ${detail}\n` +
                `Valid seats are: ${knownSeats.join(', ')}. Fix the addressing or arguments and ` +
                `reply with ONLY the corrected JSON plan.`,
                { systemPrompt, sessionId, responseSchema: PLAN_SCHEMA }
              );
              if (!retry.isError && retry.text.trim()) {
                const corrected = parsePlan(retry.text);
                if (!corrected.malformed) {
                  const stillFailing = await executeTrackedPlan(corrected.plan);
                  if (stillFailing.length === 0) {
                    lastNote = durableNote(corrected.plan.note ?? 'recovered after refused action');
                    if (corrected.plan.done !== false) {
                      if (wasAsked && !reportsTask(corrected.plan)) {
                        log('done-without-report', { seat, round, phase: 'action-repair' });
                        unreportedTask = true;
                        lastNote = durableNote('corrected plan omitted task report - continuing');
                        continue;
                      }
                      return { done: true, note: lastNote };
                    }
                  }
                }
              }
            } catch (error) {
              log('provider-threw', { seat, phase: 'action-repair', detail: String((error as Error)?.message).slice(0, 200) });
            }
          }
          // Unfinished on purpose: the runner gives an open seat another turn.
          return { done: false, note: lastNote };
        }

        // DONE REQUIRES EVIDENCE. A seat handed a task may not declare itself finished without
        // having sent something back.
        //
        // Every system-level cause of the stalled audits was fixed - continuation across turns,
        // the seat roster, refused actions surfaced - and the seats STILL acknowledged a
        // multi-step audit and reported done, having sent nothing. The prompt asked them not to.
        // Asking is not a mechanism. This is: an unanswered task keeps the wake open, and the
        // model is told precisely what is missing.
        // A RECEIPT IS NOT A REPORT. The first version of this rule asked only for "a send", and
        // the seats promptly satisfied it with acknowledgements - eight acks and zero findings
        // against a claim-by-claim audit. An ack says "I heard you"; the task asked for verdicts.
        // Courtesy kinds are therefore excluded from what counts as answering.
        const reported = reportsTask(plan);
        if (plan.done !== false && wasAsked && !reported) {
          log('done-without-report', { seat, round });
          if (round + 1 < maxRounds) {
            unreportedTask = true;
            lastNote = durableNote('done claimed without a report - continuing');
            continue;   // same mail context; the next prompt carries the correction
          }
          return { done: false, note: durableNote('done claimed without a report') };
        }

        if (plan.done !== false) {
          return { done: true, note: lastNote };
        }
        // Model asked to continue; loop with same mail context (tool results are side effects).
      }

      // Out of ROUNDS, not out of work. `done: false` is the honest answer - the model asked to
      // continue and we stopped it - so the runner schedules another turn rather than treating a
      // half-finished audit as delivered. `capped` stays for the log; the runner's own budget
      // breach is a different thing and still returns done:true.
      return { done: false, note: lastNote || 'max-rounds', capped: true };
    }
  };
}

/** Factory for cli --brain path. Expects provider to be injected by a thin wrapper module. */
export const agentBrainFactory = (provider: ModelProvider): BrainFactory => {
  return ({ seat, log }) => createAgentBrain({ seat, provider, log });
};
