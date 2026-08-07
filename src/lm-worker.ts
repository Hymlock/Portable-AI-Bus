/**
 * Provider-neutral core for one explicitly requested language-model action.
 *
 * This module deliberately does not import vscode. The extension layer adapts
 * vscode.lm and CancellationToken to these small interfaces.
 */

export type CancellationLike = {
  readonly isCancellationRequested: boolean;
};

export type ModelIdentity = {
  /** Opaque, case-sensitive provider identity. */
  vendor: string;
  /** Opaque, case-sensitive model identity. */
  id: string;
};

export type TextPart = { type: 'text'; text: string };
export type ToolCallPart = { type: 'tool_call'; callId: string; name: string; input: unknown };
export type ToolResultPart = { type: 'tool_result'; callId: string; name: string; result: JsonValue };
export type AssistantPart = TextPart | ToolCallPart;
export type UserPart = TextPart | ToolResultPart;

export type ModelMessage =
  | { role: 'user'; parts: readonly UserPart[] }
  | { role: 'assistant'; parts: readonly AssistantPart[] };

export type ModelTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ModelRequest = {
  messages: readonly ModelMessage[];
  tools: readonly ModelTool[];
  cancellation: CancellationLike;
};

export type LanguageModel = ModelIdentity & {
  sendRequest(request: ModelRequest): Promise<AsyncIterable<unknown>> | AsyncIterable<unknown>;
};

export type ModelSelector = {
  select(identity: Readonly<ModelIdentity>, cancellation: CancellationLike): Promise<readonly LanguageModel[]>;
};

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type WorkerTool = ModelTool & {
  execute(input: Readonly<Record<string, JsonValue>>, cancellation: CancellationLike): Promise<unknown> | unknown;
};

export type LmWorkerLimits = {
  maxTurns: number;
  maxToolCalls: number;
  /** Cumulative UTF-8 bytes of JSON-encoded tool results. */
  maxResultBytes: number;
  /** Maximum parts accepted from all streamed model responses. */
  maxResponseParts: number;
  /** Cumulative UTF-8 bytes of streamed text values. */
  maxResponseTextBytes: number;
  /** Cumulative UTF-8 bytes of validated, JSON-encoded response parts. */
  maxResponseBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxJsonKeys: number;
  /** Cumulative UTF-8 bytes of strings (including object keys) in one JSON value. */
  maxJsonStringBytes: number;
  /** Wall-clock deadline for the entire worker action. */
  maxRunMs: number;
  /** Deadline for one tool invocation, also bounded by the wall-clock deadline. */
  maxToolMs: number;
};

export type LmWorkerTurnContext = {
  turn: number;
  toolCalls: number;
  toolResultBytes: number;
  deadlineAt: number;
};

export type RunLmWorkerOptions = {
  identity: ModelIdentity;
  prompt: string;
  selector: ModelSelector;
  tools: readonly WorkerTool[];
  /** Exact, case-sensitive names. Tools not named here are not exposed. */
  allowedTools: readonly string[];
  cancellation: CancellationLike;
  limits?: Partial<LmWorkerLimits>;
  /** Called immediately before every model turn so adapters can enforce external guards. */
  beforeTurn?: (context: Readonly<LmWorkerTurnContext>, cancellation: CancellationLike) => Promise<void> | void;
};

export type LmWorkerResult = {
  text: string;
  model: ModelIdentity;
  turns: number;
  toolCalls: number;
  toolResultBytes: number;
  transcript: readonly ModelMessage[];
};

export class LmWorkerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'LmWorkerError';
  }
}

const DEFAULT_LIMITS: LmWorkerLimits = {
  maxTurns: 8,
  maxToolCalls: 16,
  maxResultBytes: 256 * 1024,
  maxResponseParts: 1_024,
  maxResponseTextBytes: 1024 * 1024,
  maxResponseBytes: 2 * 1024 * 1024,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxJsonKeys: 10_000,
  maxJsonStringBytes: 1024 * 1024,
  maxRunMs: 2 * 60 * 1000,
  maxToolMs: 30 * 1000
};

/** Run one bounded action. This function never schedules or repeats itself. */
export async function runLmWorker(options: RunLmWorkerOptions): Promise<LmWorkerResult> {
  const limits = validateLimits(options.limits);
  const deadlineAt = Date.now() + limits.maxRunMs;
  validateIdentity(options.identity);
  if (typeof options.prompt !== 'string' || options.prompt.trim().length === 0) {
    fail('invalid_prompt', 'The worker prompt must be a non-empty string.');
  }
  checkCancellation(options.cancellation);

  const allowed = new Set<string>();
  for (const name of options.allowedTools) {
    if (typeof name !== 'string' || name.length === 0 || allowed.has(name)) {
      fail('invalid_allowlist', 'Allowed tool names must be unique, non-empty strings.');
    }
    allowed.add(name);
  }

  const toolsByName = new Map<string, WorkerTool>();
  for (const tool of options.tools) {
    validateTool(tool);
    if (toolsByName.has(tool.name)) {
      fail('duplicate_tool', `Duplicate tool definition: ${tool.name}`);
    }
    toolsByName.set(tool.name, tool);
  }
  const exposedTools = [...allowed].map((name) => {
    const tool = toolsByName.get(name);
    if (!tool) {
      fail('unknown_allowed_tool', `Allowed tool has no definition: ${name}`);
    }
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  });

  // Selection is intentionally performed exactly once. There is no fallback.
  const candidates = await runBounded(
    () => options.selector.select(
      { vendor: options.identity.vendor, id: options.identity.id },
      deadlineCancellation(options.cancellation, deadlineAt)
    ),
    options.cancellation,
    deadlineAt,
    undefined,
    'deadline_exceeded',
    'The language-model action exceeded its wall-clock deadline.'
  );
  checkCancellation(options.cancellation);
  if (!Array.isArray(candidates) || candidates.length !== 1) {
    fail('model_selection_failed', `Expected exactly one model, received ${Array.isArray(candidates) ? candidates.length : 'malformed selection'}.`);
  }
  const model = candidates[0];
  if (!model || model.vendor !== options.identity.vendor || model.id !== options.identity.id) {
    fail('model_identity_mismatch', 'The selected model did not exactly match the requested vendor and id.');
  }
  if (typeof model.sendRequest !== 'function') {
    fail('malformed_model', 'The selected model cannot send requests.');
  }

  const transcript: ModelMessage[] = [{ role: 'user', parts: [{ type: 'text', text: options.prompt }] }];
  const seenCallIds = new Set<string>();
  let toolCalls = 0;
  let toolResultBytes = 0;
  let responseParts = 0;
  let responseTextBytes = 0;
  let responseBytes = 0;

  for (let turn = 1; turn <= limits.maxTurns; turn += 1) {
    checkCancellation(options.cancellation);
    checkDeadline(deadlineAt);
    if (options.beforeTurn) {
      await runBounded(
        () => options.beforeTurn!({ turn, toolCalls, toolResultBytes, deadlineAt }, deadlineCancellation(options.cancellation, deadlineAt)),
        options.cancellation,
        deadlineAt,
        undefined,
        'deadline_exceeded',
        'The language-model action exceeded its wall-clock deadline.'
      );
    }
    const turnCancellation = deadlineCancellation(options.cancellation, deadlineAt);
    const stream = await runBounded(
      () => model.sendRequest({
        messages: transcript.slice(),
        tools: exposedTools,
        cancellation: turnCancellation
      }),
      options.cancellation,
      deadlineAt,
      undefined,
      'deadline_exceeded',
      'The language-model action exceeded its wall-clock deadline.'
    );
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      fail('malformed_response', 'The model response is not an async iterable.');
    }

    const assistantParts: AssistantPart[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    try {
      while (true) {
        const item = await runBounded(
          () => iterator.next(), options.cancellation, deadlineAt, undefined,
          'deadline_exceeded', 'The language-model action exceeded its wall-clock deadline.'
        );
        if (item.done) break;
        checkCancellation(options.cancellation);
        responseParts += 1;
        if (responseParts > limits.maxResponseParts) {
          fail('response_part_limit', `Model responses exceeded the ${limits.maxResponseParts}-part limit.`);
        }
        const part = validateAssistantPart(item.value, limits);
        if (part.type === 'text') {
          responseTextBytes += Buffer.byteLength(part.text, 'utf8');
          if (responseTextBytes > limits.maxResponseTextBytes) {
            fail('response_text_limit', `Model response text exceeded the ${limits.maxResponseTextBytes}-byte limit.`);
          }
        }
        responseBytes += Buffer.byteLength(JSON.stringify(part), 'utf8');
        if (responseBytes > limits.maxResponseBytes) {
          fail('response_byte_limit', `Model responses exceeded the ${limits.maxResponseBytes}-byte limit.`);
        }
        assistantParts.push(part);
      }
    } catch (error) {
      // Do not await cleanup: an adversarial iterator may also hang in return().
      if (typeof iterator.return === 'function') void Promise.resolve(iterator.return()).catch(() => undefined);
      throw error;
    }
    checkCancellation(options.cancellation);
    if (assistantParts.length === 0) {
      fail('empty_response', 'The model returned no response parts.');
    }

    const calls = assistantParts.filter((part): part is ToolCallPart => part.type === 'tool_call');
    if (calls.length === 0) {
      const text = assistantParts.map((part) => part.type === 'text' ? part.text : '').join('');
      if (text.length === 0) {
        fail('empty_completion', 'The model did not return a text completion.');
      }
      transcript.push({ role: 'assistant', parts: assistantParts });
      return {
        text,
        model: { vendor: model.vendor, id: model.id },
        turns: turn,
        toolCalls,
        toolResultBytes,
        transcript
      };
    }

    if (toolCalls + calls.length > limits.maxToolCalls) {
      fail('tool_call_limit', `The model exceeded the ${limits.maxToolCalls} tool-call limit.`);
    }

    // Validate the complete batch before any tool can cause a side effect.
    const batchIds = new Set<string>();
    const validatedCalls: Array<{ call: ToolCallPart; tool: WorkerTool; input: Readonly<Record<string, JsonValue>> }> = [];
    for (const call of calls) {
      if (seenCallIds.has(call.callId) || batchIds.has(call.callId)) {
        fail('duplicate_call_id', `Tool call id was reused: ${call.callId}`);
      }
      batchIds.add(call.callId);
      if (!allowed.has(call.name)) {
        fail('tool_not_allowed', `The model requested a tool that is not allowed: ${call.name}`);
      }
      const tool = toolsByName.get(call.name);
      if (!tool) {
        fail('unknown_tool', `The model requested an unknown tool: ${call.name}`);
      }
      const input = validateToolInput(call.input, limits);
      validatedCalls.push({ call, tool, input });
    }
    for (const callId of batchIds) seenCallIds.add(callId);

    // The assistant tool-call message must precede the corresponding user results.
    transcript.push({ role: 'assistant', parts: assistantParts });
    const results: ToolResultPart[] = [];
    for (const { call, tool, input } of validatedCalls) {
      checkCancellation(options.cancellation);
      const toolState = { timedOut: false };
      const toolCancellation = deadlineCancellation(options.cancellation, deadlineAt, toolState);
      const rawResult = await runBounded(
        () => tool.execute(input, toolCancellation),
        options.cancellation,
        deadlineAt,
        limits.maxToolMs,
        'tool_timeout',
        `Tool ${call.name} exceeded the ${limits.maxToolMs}-millisecond timeout.`,
        toolState
      );
      checkCancellation(options.cancellation);
      const result = validateJson(rawResult, 'tool result', limits);
      const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
      if (toolResultBytes + bytes > limits.maxResultBytes) {
        fail('tool_result_limit', `Tool results exceeded the ${limits.maxResultBytes}-byte limit.`);
      }
      toolResultBytes += bytes;
      toolCalls += 1;
      results.push({ type: 'tool_result', callId: call.callId, name: call.name, result });
    }
    transcript.push({ role: 'user', parts: results });
  }

  fail('turn_limit', `The model exceeded the ${limits.maxTurns}-turn limit without a text completion.`);
}

function validateLimits(partial: Partial<LmWorkerLimits> | undefined): LmWorkerLimits {
  const limits = { ...DEFAULT_LIMITS, ...partial };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('invalid_limits', `${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function validateIdentity(identity: ModelIdentity): void {
  if (!identity || typeof identity.vendor !== 'string' || identity.vendor.length === 0 ||
      typeof identity.id !== 'string' || identity.id.length === 0) {
    fail('invalid_model_identity', 'Model vendor and id must be non-empty opaque strings.');
  }
}

function validateTool(tool: WorkerTool): void {
  if (!tool || typeof tool.name !== 'string' || tool.name.length === 0 || typeof tool.execute !== 'function') {
    fail('malformed_tool', 'Every tool must have a non-empty name and an execute function.');
  }
  if (tool.description !== undefined && typeof tool.description !== 'string') {
    fail('malformed_tool', `Tool ${tool.name} has a malformed description.`);
  }
}

function validateAssistantPart(value: unknown, limits: LmWorkerLimits): AssistantPart {
  if (!isRecord(value) || typeof value.type !== 'string') {
    fail('malformed_response', 'The model returned a malformed response part.');
  }
  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      fail('malformed_response', 'The model returned malformed text.');
    }
    return { type: 'text', text: value.text };
  }
  if (value.type === 'tool_call') {
    if (typeof value.callId !== 'string' || value.callId.length === 0 ||
        typeof value.name !== 'string' || value.name.length === 0) {
      fail('malformed_tool_call', 'The model returned a malformed tool call.');
    }
    // Validate now so malformed input cannot be retained in the transcript.
    const input = validateToolInput(value.input, limits);
    return { type: 'tool_call', callId: value.callId, name: value.name, input };
  }
  fail('malformed_response', `The model returned an unsupported response part: ${value.type}`);
}

function validateToolInput(value: unknown, limits: LmWorkerLimits): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value) || Array.isArray(value)) {
    fail('malformed_tool_input', 'Tool input must be a JSON object.');
  }
  return validateJson(value, 'tool input', limits) as Readonly<Record<string, JsonValue>>;
}

function validateJson(value: unknown, label: string, limits: LmWorkerLimits): JsonValue {
  type Assignment = { container: JsonValue[] | Record<string, JsonValue>; key: string | number };
  type Task =
    | { kind: 'value'; input: unknown; depth: number; assignment: Assignment }
    | { kind: 'leave'; input: object };

  const root: JsonValue[] = [];
  const active = new Set<object>();
  const stack: Task[] = [{ kind: 'value', input: value, depth: 0, assignment: { container: root, key: 0 } }];
  let nodes = 0;
  let keys = 0;
  let stringBytes = 0;

  while (stack.length > 0) {
    const task = stack.pop()!;
    if (task.kind === 'leave') {
      active.delete(task.input);
      continue;
    }
    nodes += 1;
    if (nodes > limits.maxJsonNodes) fail('json_node_limit', `${label} exceeded the ${limits.maxJsonNodes}-node limit.`);
    if (task.depth > limits.maxJsonDepth) fail('json_depth_limit', `${label} exceeded the depth limit of ${limits.maxJsonDepth}.`);

    const item = task.input;
    if (item === null || typeof item === 'boolean') {
      task.assignment.container[task.assignment.key as never] = item as never;
      continue;
    }
    if (typeof item === 'string') {
      stringBytes += Buffer.byteLength(item, 'utf8');
      if (stringBytes > limits.maxJsonStringBytes) {
        fail('json_string_limit', `${label} exceeded the ${limits.maxJsonStringBytes}-byte string budget.`);
      }
      task.assignment.container[task.assignment.key as never] = item as never;
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail('malformed_json', `${label} contains a non-finite number.`);
      task.assignment.container[task.assignment.key as never] = item as never;
      continue;
    }
    if (!isRecord(item)) fail('malformed_json', `${label} is not JSON-serializable.`);
    if (active.has(item)) fail('malformed_json', `${label} contains a cycle.`);

    const isArray = Array.isArray(item);
    if (!isArray) {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        fail('malformed_json', `${label} contains a non-plain object.`);
      }
    }
    const output: JsonValue[] | Record<string, JsonValue> = isArray
      ? []
      : Object.create(null) as Record<string, JsonValue>;
    task.assignment.container[task.assignment.key as never] = output as never;
    active.add(item);
    stack.push({ kind: 'leave', input: item });

    if (isArray) {
      const array = item as unknown[];
      for (let index = array.length - 1; index >= 0; index -= 1) {
        stack.push({ kind: 'value', input: array[index], depth: task.depth + 1, assignment: { container: output, key: index } });
      }
    } else {
      const object = item as Record<string, unknown>;
      const objectKeys = Object.keys(object);
      keys += objectKeys.length;
      if (keys > limits.maxJsonKeys) fail('json_key_limit', `${label} exceeded the ${limits.maxJsonKeys}-key limit.`);
      for (let index = objectKeys.length - 1; index >= 0; index -= 1) {
        const key = objectKeys[index];
        stringBytes += Buffer.byteLength(key, 'utf8');
        if (stringBytes > limits.maxJsonStringBytes) {
          fail('json_string_limit', `${label} exceeded the ${limits.maxJsonStringBytes}-byte string budget.`);
        }
        const child = object[key];
        if (child === undefined || typeof child === 'bigint' || typeof child === 'function' || typeof child === 'symbol') {
          fail('malformed_json', `${label} contains a non-JSON value at ${key}.`);
        }
        stack.push({ kind: 'value', input: child, depth: task.depth + 1, assignment: { container: output, key } });
      }
    }
  }
  return root[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkCancellation(cancellation: CancellationLike): void {
  if (!cancellation || typeof cancellation.isCancellationRequested !== 'boolean') {
    fail('invalid_cancellation', 'A cancellation state is required.');
  }
  if (cancellation.isCancellationRequested) {
    fail('cancelled', 'The language-model action was cancelled.');
  }
}

function checkDeadline(deadlineAt: number): void {
  if (Date.now() >= deadlineAt) {
    fail('deadline_exceeded', 'The language-model action exceeded its wall-clock deadline.');
  }
}

function deadlineCancellation(
  parent: CancellationLike,
  deadlineAt: number,
  local?: { timedOut: boolean }
): CancellationLike {
  return {
    get isCancellationRequested() {
      return parent.isCancellationRequested || Date.now() >= deadlineAt || local?.timedOut === true;
    }
  };
}

async function runBounded<T>(
  operation: () => Promise<T> | T,
  cancellation: CancellationLike,
  deadlineAt: number,
  timeoutMs: number | undefined,
  timeoutCode: string,
  timeoutMessage: string,
  local?: { timedOut: boolean }
): Promise<T> {
  checkCancellation(cancellation);
  const wallRemaining = deadlineAt - Date.now();
  if (wallRemaining <= 0) fail('deadline_exceeded', 'The language-model action exceeded its wall-clock deadline.');
  const boundedMs = timeoutMs === undefined ? wallRemaining : Math.min(wallRemaining, timeoutMs);
  const wallWins = timeoutMs === undefined || wallRemaining <= timeoutMs;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          if (local) local.timedOut = true;
          const code = wallWins ? 'deadline_exceeded' : timeoutCode;
          const message = wallWins ? 'The language-model action exceeded its wall-clock deadline.' : timeoutMessage;
          reject(new LmWorkerError(code, message));
        }, boundedMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fail(code: string, message: string): never {
  throw new LmWorkerError(code, message);
}
