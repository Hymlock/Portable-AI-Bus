import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { credentialWorkspaceKey } from './workspace-key';

type Endpoint = {
  schemaVersion: 1;
  instanceId: string;
  host: '127.0.0.1';
  port: number;
  seats: string[];
};

type Connection = Endpoint & { baseUrl: string; token: string };

type Lease = {
  instanceId: string;
  leaseId: string;
  generation: number;
  renewAt: number;
  mailboxEpoch?: string;
};

type CursorRecord = {
  schemaVersion: 1;
  seat: string;
  clientId: string;
  mailboxEpoch?: string;
  afterSeq: number;
  updatedAt: string;
};

export type WorkerClientOptions = {
  root: string;
  seat: string;
  timeoutMs?: number;
  credentialsDir?: string;
  clientId?: string;
  signal?: AbortSignal;
  renewalIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  cursorPath?: string;
  persistCursor?: boolean;
};

export type WakeResult = {
  wake: 'message' | 'timeout';
  messages: unknown[];
  instanceId: string;
  afterSeq: number;
};

export type WorkerTransition = {
  event: 'connected' | 'disconnected';
  instanceId?: string;
  attempt?: number;
  message?: string;
};

export type WorkerClientRuntime = {
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  transition?: (event: WorkerTransition) => void;
};

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_RENEWAL_MS = 20_000;
const DEFAULT_RECONNECT_MIN_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DUPLICATE_WAKE_DELAY_MS = 100;
const RELEASE_TIMEOUT_MS = 500;
const CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const WAKE_TIMEOUT_GRACE_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Acquire a lease, perform one long poll, and release the lease. */
export async function waitForMailbox(
  options: WorkerClientOptions,
  runtime: WorkerClientRuntime = {}
): Promise<WakeResult> {
  validateOptions(options);
  const clientId = clientIdentity(options.clientId, options.seat);
  const acquisitionId = randomUUID();
  const connection = await discoverConnection(options);
  const lease = await heartbeat(connection, options, clientId, acquisitionId, undefined, runtime);
  let result: WakeResult | undefined;
  let operationError: unknown;
  try {
    result = await wake(connection, options, clientId, lease, 0, requestedTimeout(options), runtime);
  } catch (error) {
    operationError = error;
  }
  try {
    if (options.signal?.aborted) await bestEffortRelease(connection, options, clientId, lease, runtime);
    else await release(connection, options, clientId, lease, runtime, options.signal);
  } catch (releaseError) {
    if (operationError === undefined) throw releaseError;
  }
  if (operationError !== undefined) throw operationError;
  return result as WakeResult;
}

/**
 * Keep one provider-neutral worker lease alive and emit only newly-sequenced mail.
 * The function returns normally when its AbortSignal is aborted.
 */
export async function watchMailbox(
  options: WorkerClientOptions,
  emit: (result: WakeResult) => void | Promise<void>,
  runtime: WorkerClientRuntime = {}
): Promise<void> {
  validateOptions(options);
  const clientId = clientIdentity(options.clientId, options.seat);
  const acquisitionId = randomUUID();
  const now = runtime.now ?? Date.now;
  const sleep = runtime.sleep ?? abortableDelay;
  const random = runtime.random ?? Math.random;
  const requestedWakeMs = requestedTimeout(options);
  const reconnectMinMs = bounded(options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS, 1, 60_000, 'reconnectMinMs');
  const reconnectMaxMs = bounded(options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS, reconnectMinMs, 5 * 60_000, 'reconnectMaxMs');
  let connection: Connection | undefined;
  let lastConnection: Connection | undefined;
  let lease: Lease | undefined;
  const cursorPath = workerCursorPath(options, clientId);
  const savedCursor = options.persistCursor === false ? undefined : await loadCursor(cursorPath, options.seat, clientId);
  let afterSeq = savedCursor?.afterSeq ?? 0;
  let mailboxEpoch: string | undefined = savedCursor?.mailboxEpoch;
  let reconnectAttempt = 0;
  let disconnected = false;
  let announcedConnected = false;

  try {
    while (!options.signal?.aborted) {
      try {
        if (!connection) {
          const discovered = await discoverConnection(options);
          if (lease?.instanceId !== discovered.instanceId) lease = undefined;
          connection = discovered;
          lastConnection = discovered;
        }

        if (!lease || lease.instanceId !== connection.instanceId || now() >= lease.renewAt) {
          try {
            lease = await heartbeat(connection, options, clientId, acquisitionId, lease, runtime);
          } catch (error) {
            if (error instanceof HarnessRequestError && (error.status === 404 || error.status === 409)) lease = undefined;
            throw error;
          }
          if (mailboxEpoch !== undefined && lease.mailboxEpoch !== undefined && mailboxEpoch !== lease.mailboxEpoch) {
            afterSeq = 0;
          }
          mailboxEpoch = lease.mailboxEpoch ?? mailboxEpoch;
          if (!announcedConnected || disconnected) {
            runtime.transition?.({ event: 'connected', instanceId: connection.instanceId });
            announcedConnected = true;
            disconnected = false;
          }
        }

        const untilRenewal = Math.max(0, lease.renewAt - now());
        if (untilRenewal === 0) continue;
        const pollMs = Math.min(requestedWakeMs, untilRenewal);
        let result: WakeResult;
        try {
          result = await wake(connection, options, clientId, lease, afterSeq, pollMs, runtime);
        } catch (error) {
          if (error instanceof HarnessRequestError && error.status === 409) lease = undefined;
          throw error;
        }
        if (disconnected) {
          runtime.transition?.({ event: 'connected', instanceId: connection.instanceId });
          disconnected = false;
        }
        reconnectAttempt = 0;
        if (result.afterSeq > afterSeq) {
          await emit(result);
          afterSeq = result.afterSeq;
          if (options.persistCursor !== false) {
            await persistCursor(cursorPath, { schemaVersion: 1, seat: options.seat, clientId, mailboxEpoch, afterSeq, updatedAt: new Date().toISOString() });
          }
        } else if (result.wake === 'message') {
          // A buggy or older harness may return unchanged unread mail. Avoid a hot loop
          // even though afterSeq is sent on every poll.
          await sleep(DUPLICATE_WAKE_DELAY_MS, options.signal);
        }
      } catch (error) {
        if (isAbort(error, options.signal)) break;
        if (!disconnected) {
          runtime.transition?.({ event: 'disconnected', attempt: reconnectAttempt + 1, message: boundedMessage(error) });
          disconnected = true;
        }
        reconnectAttempt += 1;
        connection = undefined;
        const exponential = Math.min(reconnectMaxMs, reconnectMinMs * (2 ** Math.min(reconnectAttempt - 1, 20)));
        const jitter = Math.max(0, Math.min(1, random()));
        const jittered = Math.max(1, Math.min(reconnectMaxMs, Math.round(exponential * (0.5 + jitter))));
        try {
          await sleep(jittered, options.signal);
        } catch (sleepError) {
          if (!isAbort(sleepError, options.signal)) throw sleepError;
        }
      }
    }
  } finally {
    const releasableConnection = connection ?? lastConnection;
    if (releasableConnection && lease?.instanceId === releasableConnection.instanceId) {
      await bestEffortRelease(releasableConnection, options, clientId, lease, runtime);
    }
  }
}

async function discoverConnection(options: WorkerClientOptions): Promise<Connection> {
  throwIfAborted(options.signal);
  const root = path.resolve(options.root);
  const endpointPath = path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json');
  const endpoint = JSON.parse(await fs.readFile(endpointPath, 'utf8')) as Endpoint;
  if (endpoint.schemaVersion !== 1 || endpoint.host !== '127.0.0.1' ||
      !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 ||
      !validOpaqueId(endpoint.instanceId) || !Array.isArray(endpoint.seats) || !endpoint.seats.includes(options.seat)) {
    throw new Error('Harness endpoint is invalid or does not register this seat.');
  }
  const workspaceKey = credentialWorkspaceKey(root);
  const credentialsRoot = options.credentialsDir ?? path.join(os.homedir(), '.portable-ai-bus', 'credentials', workspaceKey);
  const tokenPath = path.join(credentialsRoot, endpoint.instanceId, 'seats', `${options.seat}.token`);
  const token = (await fs.readFile(tokenPath, 'utf8')).trim();
  if (!/^pab1\.[a-zA-Z0-9_.-]+\.[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error('Worker seat credential is malformed.');
  throwIfAborted(options.signal);
  return { ...endpoint, baseUrl: `http://${endpoint.host}:${endpoint.port}`, token };
}

async function heartbeat(
  connection: Connection,
  options: WorkerClientOptions,
  clientId: string,
  acquisitionId: string,
  current: Lease | undefined,
  runtime: WorkerClientRuntime
): Promise<Lease> {
  const body = {
    agent: options.seat,
    clientId,
    ...(current && current.instanceId === connection.instanceId
      ? { leaseId: current.leaseId, generation: current.generation }
      : { acquisitionId })
  };
  const value = await requestJson(connection, '/v1/heartbeat', { method: 'POST', body: JSON.stringify(body), signal: options.signal }, runtime, CONTROL_REQUEST_TIMEOUT_MS);
  assertInstance(value, connection);
  if (!validOpaqueId(value.leaseId) || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1) {
    throw new Error('Harness returned a malformed worker lease.');
  }
  if (current && (value.leaseId !== current.leaseId || value.generation !== current.generation)) {
    throw new Error('Harness changed the lease identity during renewal.');
  }
  const currentTime = (runtime.now ?? Date.now)();
  const requestedRenewal = bounded(options.renewalIntervalMs ?? DEFAULT_RENEWAL_MS, 1, 24 * 60 * 60_000, 'renewalIntervalMs');
  if (value.renewAfterMs !== undefined && optionalPositiveInteger(value.renewAfterMs) === undefined) {
    throw new Error('Harness returned an invalid renewAfterMs.');
  }
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) {
    throw new Error('Harness returned an invalid lease expiry.');
  }
  if (value.mailboxEpoch !== undefined && (typeof value.mailboxEpoch !== 'string' || !Number.isFinite(Date.parse(value.mailboxEpoch)))) {
    throw new Error('Harness returned an invalid mailboxEpoch.');
  }
  const serverRenewal = optionalPositiveInteger(value.renewAfterMs);
  const expiresAt = typeof value.expiresAt === 'string' ? Date.parse(value.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= currentTime) throw new Error('Harness returned an already-expired worker lease.');
  const expiryRenewal = Number.isFinite(expiresAt) ? Math.max(1, Math.floor((expiresAt - currentTime) / 2)) : requestedRenewal;
  const renewalMs = Math.max(1, Math.min(requestedRenewal, serverRenewal ?? requestedRenewal, expiryRenewal));
  return {
    instanceId: connection.instanceId,
    leaseId: value.leaseId as string,
    generation: value.generation as number,
    renewAt: currentTime + renewalMs,
    mailboxEpoch: value.mailboxEpoch as string | undefined
  };
}

async function wake(
  connection: Connection,
  options: WorkerClientOptions,
  clientId: string,
  lease: Lease,
  afterSeq: number,
  timeoutMs: number,
  runtime: WorkerClientRuntime
): Promise<WakeResult> {
  const query = new URLSearchParams({
    clientId,
    leaseId: lease.leaseId,
    generation: String(lease.generation),
    afterSeq: String(afterSeq),
    timeoutMs: String(Math.max(0, Math.floor(timeoutMs)))
  });
  const value = await requestJson(
    connection,
    `/v1/wake?${query}`,
    { signal: options.signal },
    runtime,
    Math.max(WAKE_TIMEOUT_GRACE_MS, timeoutMs + WAKE_TIMEOUT_GRACE_MS)
  );
  assertInstance(value, connection);
  if (value.leaseId !== undefined && value.leaseId !== lease.leaseId) {
    throw new Error('Harness wake response does not match the active leaseId.');
  }
  if (value.generation !== undefined && value.generation !== lease.generation) {
    throw new Error('Harness wake response does not match the active lease generation.');
  }
  if ((value.wake !== 'message' && value.wake !== 'timeout') || !Array.isArray(value.messages)) {
    throw new Error('Harness returned a malformed wake response.');
  }
  if (value.wake === 'timeout' && value.messages.length !== 0) {
    throw new Error('Harness returned messages with a timeout wake response.');
  }
  let nextSeq = afterSeq;
  const fresh: unknown[] = [];
  for (const message of value.messages) {
    const seq = message && typeof message === 'object' ? (message as { seq?: unknown }).seq : undefined;
    if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw new Error('Harness returned a message without a valid sequence.');
    if ((seq as number) > afterSeq) fresh.push(message);
    nextSeq = Math.max(nextSeq, seq as number);
  }
  return { wake: value.wake, messages: fresh, instanceId: connection.instanceId, afterSeq: nextSeq };
}

async function release(
  connection: Connection,
  options: WorkerClientOptions,
  clientId: string,
  lease: Lease,
  runtime: WorkerClientRuntime,
  signal?: AbortSignal
) {
  const value = await requestJson(connection, '/v1/workers/release', {
    method: 'POST',
    body: JSON.stringify({ agent: options.seat, clientId, leaseId: lease.leaseId, generation: lease.generation }),
    signal
  }, runtime, CONTROL_REQUEST_TIMEOUT_MS);
  assertInstance(value, connection);
}

async function bestEffortRelease(
  connection: Connection,
  options: WorkerClientOptions,
  clientId: string,
  lease: Lease,
  runtime: WorkerClientRuntime
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELEASE_TIMEOUT_MS);
  timer.unref?.();
  try {
    await release(connection, options, clientId, lease, runtime, controller.signal);
  } catch {
    // Leases expire server-side. Shutdown must not be held hostage by a dead endpoint.
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(
  connection: Connection,
  pathname: string,
  init: RequestInit,
  runtime: WorkerClientRuntime,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${connection.token}`);
  headers.set('content-type', 'application/json');
  const deadline = deadlineSignal(init.signal ?? undefined, timeoutMs);
  let response: Response;
  let value: Record<string, unknown>;
  try {
    response = await (runtime.fetch ?? fetch)(`${connection.baseUrl}${pathname}`, { ...init, headers, signal: deadline.signal });
    try {
      value = await readBoundedJson(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      throw new HarnessRequestError(response.status, undefined, `Invalid harness response: ${boundedMessage(error)}`);
    }
  } finally {
    deadline.dispose();
  }
  if (!response.ok || value.ok !== true) {
    const error = value.error as { code?: string; message?: string } | string | undefined;
    const message = typeof error === 'string' ? error : error?.message;
    const code = typeof error === 'object' ? error?.code : undefined;
    throw new HarnessRequestError(response.status, code, message ?? 'unknown error');
  }
  return value;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<Record<string, unknown>> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`Harness response exceeds ${maximumBytes} bytes.`);
  }
  if (!response.body) throw new Error('Harness returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Harness response exceeds ${maximumBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const parsed = JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Harness response must be a JSON object.');
  return parsed as Record<string, unknown>;
}

class HarnessRequestError extends Error {
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(`Harness request failed (${status}${code ? ` ${code}` : ''}): ${message}`);
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command !== 'wait' && command !== 'watch') {
    throw new Error('Usage: worker-client <wait|watch> --root PATH --seat AGENT [--timeout-ms N] [--credentials-dir PATH] [--client-id ID]');
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const options: WorkerClientOptions = {
    root: option(argv, '--root') ?? path.resolve(__dirname, '..', '..'),
    seat: requiredOption(argv, '--seat'),
    timeoutMs: Number(option(argv, '--timeout-ms') ?? DEFAULT_TIMEOUT_MS),
    credentialsDir: option(argv, '--credentials-dir'),
    clientId: option(argv, '--client-id'),
    signal: controller.signal
  };
  try {
    if (command === 'wait') {
      await writeLine(process.stdout, `${JSON.stringify(await waitForMailbox(options))}\n`);
      return;
    }
    const logTransition = transitionLogger(process.stderr);
    await watchMailbox(options, (result) => writeLine(process.stdout, `${JSON.stringify(result)}\n`), { transition: logTransition });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

function validateOptions(options: WorkerClientOptions) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(options.seat)) throw new Error('Invalid worker seat id.');
  requestedTimeout(options);
  if (options.clientId !== undefined) clientIdentity(options.clientId, options.seat);
}

function requestedTimeout(options: WorkerClientOptions) {
  return bounded(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 0, 30_000, 'timeoutMs');
}

function assertInstance(value: Record<string, unknown>, connection: Connection) {
  if (value.instanceId !== connection.instanceId) {
    throw new Error('Harness response instanceId does not match the discovered endpoint.');
  }
}

function optionalPositiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function validOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredOption(argv: string[], name: string) {
  const value = option(argv, name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be ${minimum}..${maximum}.`);
  return value;
}

function clientIdentity(value: string | undefined, seat: string) {
  const clientId = value ?? `worker-client:${seat}`;
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(clientId)) throw new Error('Invalid clientId.');
  return clientId;
}

function workerCursorPath(options: WorkerClientOptions, clientId: string) {
  if (options.cursorPath) return path.resolve(options.cursorPath);
  const root = path.resolve(options.root);
  const workspaceKey = credentialWorkspaceKey(root);
  const credentialsRoot = options.credentialsDir ?? path.join(os.homedir(), '.portable-ai-bus', 'credentials', workspaceKey);
  const key = createHash('sha256').update(`${options.seat}\0${clientId}`).digest('hex');
  return path.join(credentialsRoot, 'cursors', `${key}.json`);
}

async function loadCursor(cursorPath: string, seat: string, clientId: string) {
  try {
    const value = JSON.parse(await fs.readFile(cursorPath, 'utf8')) as CursorRecord;
    if (value.schemaVersion !== 1 || value.seat !== seat || value.clientId !== clientId ||
        !Number.isSafeInteger(value.afterSeq) || value.afterSeq < 0 ||
        (value.mailboxEpoch !== undefined && !Number.isFinite(Date.parse(value.mailboxEpoch)))) {
      throw new Error(`Worker cursor is invalid: ${cursorPath}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function persistCursor(cursorPath: string, value: CursorRecord) {
  await fs.mkdir(path.dirname(cursorPath), { recursive: true, mode: 0o700 });
  const temporary = `${cursorPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, cursorPath);
    await fs.chmod(cursorPath, 0o600).catch(() => undefined);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function abortError() {
  const error = new Error('The worker session was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbort(error: unknown, signal?: AbortSignal) {
  return signal?.aborted === true;
}

function abortableDelay(milliseconds: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(abortError());
    };
    function finish() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function deadlineSignal(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), milliseconds);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    }
  };
}

function boundedMessage(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.length <= 300 ? value : `${value.slice(0, 297)}...`;
}

function transitionLogger(stream: NodeJS.WritableStream) {
  let lastState: WorkerTransition['event'] | undefined;
  return (transition: WorkerTransition) => {
    if (transition.event === lastState) return;
    lastState = transition.event;
    const line = JSON.stringify(transition);
    stream.write(`${line.length <= 1_024 ? line : line.slice(0, 1_024)}\n`);
  };
}

function writeLine(stream: NodeJS.WritableStream, value: string) {
  if (stream.write(value)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.removeListener('drain', drained);
      stream.removeListener('error', failed);
    };
    const drained = () => { cleanup(); resolve(); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    stream.once('drain', drained);
    stream.once('error', failed);
  });
}

if (require.main === module) {
  runCli().catch((error) => {
    if (error instanceof Error && error.name === 'AbortError') return;
    process.stderr.write(`${JSON.stringify({ event: 'fatal', message: boundedMessage(error) })}\n`);
    process.exitCode = 1;
  });
}
