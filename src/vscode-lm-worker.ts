import * as vscode from 'vscode';
import { CapabilityRunner } from './capabilities';
import {
  LanguageModel,
  ModelMessage,
  ModelSelector,
  ModelTool,
  RunLmWorkerOptions,
  WorkerTool,
  runLmWorker
} from './lm-worker';
import { BusHaltedError, MailboxStore } from './mailbox';

export type VscodeLmWorkerOptions = {
  root: string;
  seat: string;
  model: vscode.LanguageModelChat;
  prompt: string;
  allowedTools: string[];
  maxTurns: number;
  token: vscode.CancellationToken;
};

export async function runVscodeLmWorker(options: VscodeLmWorkerOptions) {
  const mailbox = new MailboxStore(options.root);
  await mailbox.registerAgents([options.seat], true);
  const tools = workspaceTools(mailbox, new CapabilityRunner(options.root), options.seat, options.token);
  const selector: ModelSelector = {
    async select(identity) {
      return identity.vendor === options.model.vendor && identity.id === options.model.id
        ? [adaptModel(options.model, options.token)]
        : [];
    }
  };
  const workerOptions: RunLmWorkerOptions = {
    identity: { vendor: options.model.vendor, id: options.model.id },
    prompt: options.prompt,
    selector,
    tools,
    allowedTools: options.allowedTools,
    cancellation: options.token,
    limits: { maxTurns: options.maxTurns },
    beforeTurn: async () => { await requireRunning(mailbox); }
  };
  return runLmWorker(workerOptions);
}

function adaptModel(model: vscode.LanguageModelChat, token: vscode.CancellationToken): LanguageModel {
  return {
    vendor: model.vendor,
    id: model.id,
    async sendRequest(request) {
      const messages = request.messages.map(toVscodeMessage);
      const tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: asSchema(tool.inputSchema)
      }));
      const response = await model.sendRequest(messages, {
        justification: 'Run one user-requested, bounded Portable AI Bus workspace action.',
        tools
      }, token);
      return fromVscodeStream(response.stream);
    }
  };
}

function toVscodeMessage(message: ModelMessage) {
  if (message.role === 'assistant') {
    return vscode.LanguageModelChatMessage.Assistant(message.parts.map((part) => {
      if (part.type === 'text') return new vscode.LanguageModelTextPart(part.text);
      return new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input as object);
    }));
  }
  return vscode.LanguageModelChatMessage.User(message.parts.map((part) => {
    if (part.type === 'text') return new vscode.LanguageModelTextPart(part.text);
    return new vscode.LanguageModelToolResultPart(part.callId, [new vscode.LanguageModelTextPart(JSON.stringify(part.result))]);
  }));
}

async function* fromVscodeStream(stream: AsyncIterable<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | unknown>) {
  for await (const part of stream) {
    if (part instanceof vscode.LanguageModelTextPart) {
      yield { type: 'text', text: part.value };
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      yield { type: 'tool_call', callId: part.callId, name: part.name, input: part.input };
    } else {
      yield { type: 'unsupported_vscode_part' };
    }
  }
}

function workspaceTools(mailbox: MailboxStore, capabilities: CapabilityRunner, seat: string, token: vscode.CancellationToken): WorkerTool[] {
  return [
    tool('mailbox_status', 'Read bus rounds, halt state, agents, unread counts, and claims.', {}, async () => mailbox.status()),
    tool('mailbox_inbox', 'Peek at this seat inbox without acknowledging messages.', {
      type: 'object', properties: { all: { type: 'boolean' } }, additionalProperties: false
    }, async (input) => {
      const messages = await mailbox.inbox(seat);
      return input.all === true ? messages : messages.slice(0, 1);
    }),
    tool('mailbox_read', 'Read and acknowledge this seat inbox.', {
      type: 'object', properties: { all: { type: 'boolean' } }, additionalProperties: false
    }, async (input) => {
      await requireRunning(mailbox);
      return mailbox.read(seat, input.all === true);
    }),
    tool('mailbox_send', 'Send a durable message from this seat to a registered seat.', {
      type: 'object',
      properties: {
        to: { type: 'string' }, kind: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' },
        // Item 18, audit finding: `supersedes` existed only on MailboxStore.send, so every
        // caller that reaches the store through a tool surface silently dropped it. A
        // capability no caller can invoke is not implemented.
        supersedes: { type: 'integer', minimum: 1 }, supersedeReason: { type: 'string' }
      },
      required: ['to', 'subject', 'body'], additionalProperties: false
    }, async (input) => {
      const to = requiredString(input.to, 'to', 100);
      const status = await requireRunning(mailbox);
      if (!status.agents.includes(to)) throw new Error(`Unknown mailbox recipient: ${to}`);
      return mailbox.send({
        from: seat,
        to,
        kind: optionalString(input.kind, 'kind', 100) || 'note',
        subject: requiredString(input.subject, 'subject', 1_000),
        body: requiredString(input.body, 'body', 256 * 1024),
        // Forwarded, not defaulted: `undefined` must reach the store so its own rule about
        // what a bare send means stays the single definition.
        ...(input.supersedes === undefined ? {} : { supersedes: requiredInteger(input.supersedes, 'supersedes') }),
        ...(input.supersedeReason === undefined
          ? {}
          : { supersedeReason: optionalString(input.supersedeReason, 'supersedeReason', 1_000) })
      });
    }),
    tool('mailbox_claim', 'Hold existing workspace-relative paths now; a successful result is final and needs no acceptance step.', {
      type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } },
      required: ['paths'], additionalProperties: false
    }, async (input) => {
      await requireRunning(mailbox);
      const requested = stringArray(input.paths, 'paths');
      const held = await mailbox.claim({ agent: seat, paths: requested, why: optionalString(input.why, 'why', 1_000) });
      return {
        status: 'HELD NOW',
        message: 'The requested paths are HELD NOW. No acceptance or further claim step is required.',
        requested,
        held
      };
    }),
    tool('mailbox_release', 'Release exact paths held by this seat, or all when paths is omitted.', {
      type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, additionalProperties: false
    }, async (input) => {
      await requireRunning(mailbox);
      return mailbox.release(seat, input.paths === undefined ? undefined : stringArray(input.paths, 'paths'));
    }),
    tool('capability_list', 'List allowlisted capabilities granted to this seat.', {}, async () =>
      (await capabilities.list()).filter((item) => (item.allowedSeats ?? []).some((allowed) => allowed === '*' || allowed === seat))
    ),
    tool('capability_run', 'Run one capability explicitly granted to this seat and return its evidence receipt.', {
      type: 'object', properties: { id: { type: 'string' }, timeoutMs: { type: 'integer' } },
      required: ['id'], additionalProperties: false
    }, async (input) => {
      await requireRunning(mailbox);
      const controller = new AbortController();
      if (token.isCancellationRequested) controller.abort();
      const subscription = token.onCancellationRequested(() => controller.abort());
      try {
        return await capabilities.run(requiredString(input.id, 'id', 100), {
          seat,
          signal: controller.signal,
          timeoutMs: input.timeoutMs === undefined ? undefined : requiredInteger(input.timeoutMs, 'timeoutMs')
        });
      } finally {
        subscription.dispose();
      }
    })
  ];
}

function tool(name: string, description: string, inputSchema: object, execute: WorkerTool['execute']): WorkerTool {
  return { name, description, inputSchema, execute };
}

async function requireRunning(mailbox: MailboxStore) {
  const status = await mailbox.status();
  if (status.halted || status.round >= status.maxRounds) {
    throw new BusHaltedError(status.stopReason ?? `round guard reached (${status.round}/${status.maxRounds})`);
  }
  return status;
}

function requiredString(value: unknown, field: string, max: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) {
    throw new Error(`${field} must be a non-empty string up to ${max} characters.`);
  }
  return value;
}

function optionalString(value: unknown, field: string, max: number) {
  if (value === undefined || value === null || value === '') return '';
  return requiredString(value, field, max);
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) throw new Error(`${field} must be a non-empty array.`);
  return value.map((item) => requiredString(item, field, 4_096));
}

function requiredInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value)) throw new Error(`${field} must be an integer.`);
  return value as number;
}

function asSchema(value: unknown): object | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as object : undefined;
}
