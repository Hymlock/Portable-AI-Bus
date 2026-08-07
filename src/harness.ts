import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { CapabilityRunner } from './capabilities';
import { BusHaltedError, ClaimConflictError, MailboxStore } from './mailbox';

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

type ToolRequest = {
  requestId: string;
  name: string;
  input?: Record<string, unknown>;
};

type StoredRequest = {
  schemaVersion: 1;
  requestId: string;
  fingerprint: string;
  tool: string;
  state: 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  principal: string;
};

type Principal = { kind: 'operator'; id: 'operator' } | { kind: 'seat'; id: string };

type HarnessOptions = {
  token?: string;
  maxBodyBytes?: number;
  maxConcurrentRuns?: number;
  credentialsDir?: string;
  seatTokens?: Record<string, string>;
};

const DEFAULT_PORT = 47_831;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const MAX_WAKE_MS = 30_000;
const MAX_CONCURRENT_WAKES = 8;

export class HarnessServer {
  readonly mailbox: MailboxStore;
  readonly capabilities: CapabilityRunner;
  readonly runtimeDir: string;
  readonly tokenPath: string;
  readonly endpointPath: string;
  readonly auditPath: string;
  readonly requestsDir: string;
  readonly token: string;
  readonly lockPath: string;
  readonly instanceId: string;
  private readonly maxBodyBytes: number;
  private readonly maxConcurrentRuns: number;
  private readonly completed = new Map<string, { fingerprint: string; result: unknown }>();
  private readonly inFlight = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private activeCapabilityRuns = 0;
  private activeWakeRequests = 0;
  private server?: http.Server;
  private ownsLock = false;
  private readonly credentialInstanceDir: string;
  private readonly injectedSeatTokens: Record<string, string>;
  private readonly principals = new Map<string, Principal>();
  private readonly seatTokenPaths = new Map<string, string>();

  constructor(readonly workspaceRoot: string, options: HarnessOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.mailbox = new MailboxStore(this.workspaceRoot);
    this.capabilities = new CapabilityRunner(this.workspaceRoot);
    this.runtimeDir = path.join(this.workspaceRoot, '.ai-bus', 'runtime', 'harness');
    this.instanceId = randomUUID();
    const workspaceKey = createHash('sha256').update(this.workspaceRoot).digest('hex').slice(0, 24);
    const credentialsDir = options.credentialsDir ?? path.join(os.homedir(), '.portable-ai-bus', 'credentials', workspaceKey);
    this.credentialInstanceDir = path.join(credentialsDir, this.instanceId);
    this.tokenPath = path.join(this.credentialInstanceDir, 'operator.token');
    this.endpointPath = path.join(this.runtimeDir, 'endpoint.json');
    this.auditPath = path.join(this.runtimeDir, 'audit.ndjson');
    this.requestsDir = path.join(this.runtimeDir, 'requests');
    this.lockPath = path.join(this.runtimeDir, 'server.lock');
    this.token = options.token ?? mintToken('operator');
    this.injectedSeatTokens = options.seatTokens ?? {};
    this.maxBodyBytes = boundedInteger(options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES, 1_024, 16 * 1024 * 1024, 'maxBodyBytes');
    this.maxConcurrentRuns = boundedInteger(options.maxConcurrentRuns ?? 2, 1, 32, 'maxConcurrentRuns');
  }

  async start(port = DEFAULT_PORT): Promise<{ host: '127.0.0.1'; port: number; tokenPath: string; seatTokenPaths: Record<string, string> }> {
    if (this.server) {
      throw new Error('Harness server is already running.');
    }
    await this.ensureSafeRuntime();
    await this.mailbox.registerAgents([]);
    const registeredAgents = (await this.mailbox.status()).agents;
    await this.acquireLock();
    try {
      this.server = http.createServer((request, response) => {
        void this.handle(request, response).catch((error) => {
          const failure = httpFailure(error);
          this.respond(response, failure.status, {
            ok: false,
            error: { code: failure.code, message: failure.message, retriable: failure.retriable }
          });
        });
      });
      this.server.keepAliveTimeout = 5_000;
      this.server.requestTimeout = 35_000;
      this.server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(port, '127.0.0.1', () => {
          this.server!.off('error', reject);
          resolve();
        });
      });
      const address = this.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Harness server did not bind a TCP address.');
      }
      await this.provisionCredentials(registeredAgents);
      const endpoint = {
        schemaVersion: 1,
        instanceId: this.instanceId,
        host: '127.0.0.1' as const,
        port: address.port,
        authScheme: 'Bearer',
        seats: registeredAgents,
        pid: process.pid,
        startedAt: new Date().toISOString()
      };
      await this.atomicJson(this.endpointPath, endpoint);
      await this.audit({ event: 'server_started', instanceId: this.instanceId, port: address.port }).catch(() => undefined);
      return { host: endpoint.host, port: endpoint.port, tokenPath: this.tokenPath, seatTokenPaths: Object.fromEntries(this.seatTokenPaths) };
    } catch (error) {
      await this.cleanupOwnedArtifacts(true);
      throw error;
    }
  }

  private async provisionCredentials(agents: string[]) {
    await fs.mkdir(this.credentialInstanceDir, { recursive: true, mode: 0o700 });
    const writeToken = async (destination: string, value: string) => {
      const handle = await fs.open(destination, 'wx', 0o600);
      await handle.writeFile(`${value}\n`, 'utf8');
      await handle.close();
      await fs.chmod(destination, 0o600).catch(() => undefined);
    };
    await writeToken(this.tokenPath, this.token);
    this.principals.set(this.token, { kind: 'operator', id: 'operator' });
    const seatsDir = path.join(this.credentialInstanceDir, 'seats');
    await fs.mkdir(seatsDir, { mode: 0o700 });
    for (const agent of agents) {
      const token = this.injectedSeatTokens[agent] ?? mintToken(agent);
      const destination = path.join(seatsDir, `${agent}.token`);
      await writeToken(destination, token);
      this.principals.set(token, { kind: 'seat', id: agent });
      this.seatTokenPaths.set(agent, destination);
    }
  }

  async stop() {
    if (this.server) {
      const current = this.server;
      this.server = undefined;
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
    await this.audit({ event: 'server_stopped', instanceId: this.instanceId }).catch(() => undefined);
    await this.cleanupOwnedArtifacts(false);
  }

  private async ensureSafeRuntime() {
    const realRoot = await fs.realpath(this.workspaceRoot);
    let current = realRoot;
    for (const segment of ['.ai-bus', 'runtime', 'harness', 'requests']) {
      const candidate = path.join(current, segment);
      try {
        const stat = await fs.lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Unsafe harness runtime path: ${candidate}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await fs.mkdir(candidate);
      }
      const resolved = await fs.realpath(candidate);
      const relative = path.relative(realRoot, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Harness runtime escapes the workspace: ${candidate}`);
      }
      current = resolved;
    }
  }

  private async acquireLock() {
    const attempt = async () => {
      const handle = await fs.open(this.lockPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ instanceId: this.instanceId, pid: process.pid, at: new Date().toISOString() })}\n`, 'utf8');
      await handle.close();
      this.ownsLock = true;
    };
    try {
      await attempt();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.readJsonFile<{ pid?: number }>(this.lockPath).catch((): { pid?: number } => ({}));
      if (existing.pid && processAlive(existing.pid)) {
        throw new HarnessHttpError(409, 'server_running', `A harness server already owns this workspace (PID ${existing.pid}).`);
      }
      await fs.rm(this.lockPath, { force: true });
      await attempt();
    }
  }

  private async cleanupOwnedArtifacts(closeServer: boolean) {
    if (closeServer && this.server) {
      const current = this.server;
      this.server = undefined;
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
    const endpoint = await this.readJsonFile<{ instanceId?: string }>(this.endpointPath).catch(() => undefined);
    if (endpoint?.instanceId === this.instanceId) await fs.rm(this.endpointPath, { force: true });
    await fs.rm(this.credentialInstanceDir, { recursive: true, force: true });
    this.principals.clear();
    this.seatTokenPaths.clear();
    if (this.ownsLock) {
      const lock = await this.readJsonFile<{ instanceId?: string }>(this.lockPath).catch(() => undefined);
      if (lock?.instanceId === this.instanceId) await fs.rm(this.lockPath, { force: true });
      this.ownsLock = false;
    }
  }

  private async readJsonFile<T>(filePath: string): Promise<T> {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  }

  tools(): ToolDefinition[] {
    const object = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false
    });
    const agent = { type: 'string', pattern: '^[a-zA-Z0-9_.-]+$' };
    const paths = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 256 };
    return [
      { name: 'mailbox_status', description: 'Read rounds, registered agents, unread counts, claims, and workspace commit.', inputSchema: object({}) },
      { name: 'mailbox_inbox', description: 'Peek at unread messages without acknowledging them.', inputSchema: object({ agent, all: { type: 'boolean' } }, ['agent']) },
      { name: 'mailbox_read', description: 'Read and acknowledge one or all unread messages.', inputSchema: object({ agent, all: { type: 'boolean' } }, ['agent']) },
      {
        name: 'mailbox_send',
        description: 'Send one durable coordination message.',
        inputSchema: object(
          { from: agent, to: agent, kind: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
          ['from', 'to', 'subject', 'body']
        )
      },
      { name: 'mailbox_claim', description: 'Accumulate workspace path claims after conflict checks.', inputSchema: object({ agent, paths, why: { type: 'string' } }, ['agent', 'paths']) },
      { name: 'mailbox_release', description: 'Release exact paths, or all claims when paths is omitted.', inputSchema: object({ agent, paths }, ['agent']) },
      { name: 'capability_list', description: 'List allowlisted workspace capabilities.', inputSchema: object({}) },
      { name: 'capability_run', description: 'Run one allowlisted capability without a shell and write an evidence receipt.', inputSchema: object({ id: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 100 } }, ['id']) }
    ];
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const principal = this.authenticate(request);
    if (!principal) {
      this.respond(response, 401, { ok: false, error: { code: 'unauthorized', message: 'Unauthorized', retriable: false } });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/status') {
      const [mailbox, allCapabilities] = await Promise.all([this.mailbox.status(), this.capabilities.list()]);
      const capabilities = principal.kind === 'operator'
        ? allCapabilities
        : allCapabilities.filter((item) => (item.allowedSeats ?? []).some((seat) => seat === '*' || seat === principal.id));
      this.respond(response, 200, { ok: true, mailbox, capabilities, activeCapabilityRuns: this.activeCapabilityRuns });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/tools') {
      this.respond(response, 200, { ok: true, protocolVersion: 1, tools: this.tools() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/wake') {
      if (this.activeWakeRequests >= MAX_CONCURRENT_WAKES) {
        throw new HarnessHttpError(429, 'wake_concurrency_limit', `Wake concurrency limit reached (${MAX_CONCURRENT_WAKES}).`, true);
      }
      const agent = this.authorizedAgent(principal, url.searchParams.get('agent'));
      const requestedTimeout = Number(url.searchParams.get('timeoutMs') ?? 25_000);
      const timeoutMs = Math.max(0, Math.min(MAX_WAKE_MS, Number.isFinite(requestedTimeout) ? requestedTimeout : 25_000));
      this.activeWakeRequests += 1;
      try {
        const wake = await this.mailbox.waitFor(agent, timeoutMs);
        const messages = wake === 'message' ? await this.mailbox.inbox(agent) : [];
        this.respond(response, 200, { ok: true, wake, messages });
      } finally {
        this.activeWakeRequests -= 1;
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/heartbeat') {
      const body = await this.readBody(request);
      const agent = this.authorizedAgent(principal, body.agent);
      await this.audit({ event: 'heartbeat', principal: principal.id, agent });
      this.respond(response, 200, { ok: true, at: new Date().toISOString() });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/v1/tool') {
      let body: ToolRequest;
      try {
        body = validateToolRequest(await this.readBody(request));
      } catch (error) {
        if (error instanceof HarnessHttpError) throw error;
        throw new HarnessHttpError(400, 'invalid_request', asMessage(error));
      }
      const result = await this.executeIdempotent(principal, body);
      this.respond(response, 200, { ok: true, requestId: body.requestId, result });
      return;
    }
    this.respond(response, 404, { ok: false, error: { code: 'not_found', message: 'Not found', retriable: false } });
  }

  private async executeIdempotent(principal: Principal, request: ToolRequest) {
    const principalKey = `${principal.kind}:${principal.id}`;
    const cacheKey = `${principalKey}:${request.requestId}`;
    const fingerprint = requestFingerprint({ principal: principalKey, request });
    const active = this.inFlight.get(cacheKey);
    if (active) {
      this.assertMatchingFingerprint(request.requestId, fingerprint, active.fingerprint);
      return active.promise;
    }
    const memory = this.completed.get(cacheKey);
    if (memory) {
      this.assertMatchingFingerprint(request.requestId, fingerprint, memory.fingerprint);
      return memory.result;
    }
    const operation = (async () => {
      const stored = await this.loadStoredRequest(request.requestId, principalKey);
      if (stored) {
        this.assertMatchingFingerprint(request.requestId, fingerprint, stored.fingerprint);
        if (stored.state === 'completed') {
          this.rememberCompleted(cacheKey, fingerprint, stored.result);
          return stored.result;
        }
        if (stored.state === 'in_progress') {
          throw new HarnessHttpError(409, 'indeterminate_request', `Request ${request.requestId} was interrupted while in progress; inspect its evidence before choosing a new request id.`);
        }
        throw new HarnessHttpError(409, 'recorded_failure', stored.error ?? `Request ${request.requestId} previously failed.`);
      }
      const startedAt = new Date().toISOString();
      await this.storeRequest({ schemaVersion: 1, requestId: request.requestId, fingerprint, tool: request.name, state: 'in_progress', startedAt, principal: principalKey });
      await this.audit({ event: 'tool_start', principal: principalKey, requestId: request.requestId, tool: request.name });
      try {
        const result = await this.executeTool(principal, request);
        const finishedAt = new Date().toISOString();
        await this.storeRequest({ schemaVersion: 1, requestId: request.requestId, fingerprint, tool: request.name, state: 'completed', startedAt, finishedAt, result, principal: principalKey });
        this.rememberCompleted(cacheKey, fingerprint, result);
        await this.audit({ event: 'tool_complete', principal: principalKey, requestId: request.requestId, tool: request.name, result: summarize(result) }).catch(() => undefined);
        return result;
      } catch (error) {
        await this.storeRequest({
          schemaVersion: 1,
          requestId: request.requestId,
          fingerprint,
          tool: request.name,
          state: 'failed',
          startedAt,
          finishedAt: new Date().toISOString(),
          error: asMessage(error),
          principal: principalKey
        }).catch(() => undefined);
        throw error;
      }
    })().finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, { fingerprint, promise: operation });
    return operation;
  }

  private assertMatchingFingerprint(requestId: string, actual: string, expected: string) {
    if (actual !== expected) {
      throw new HarnessHttpError(409, 'request_id_reuse', `Request id ${requestId} was already bound to a different tool or input.`);
    }
  }

  private rememberCompleted(requestId: string, fingerprint: string, result: unknown) {
    this.completed.set(requestId, { fingerprint, result });
    while (this.completed.size > 1_000) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }

  private storedRequestPath(requestId: string, principal = '') {
    const key = createHash('sha256').update(`${principal}\0${requestId}`).digest('hex');
    return path.join(this.requestsDir, `${key}.json`);
  }

  private async loadStoredRequest(requestId: string, principal: string): Promise<StoredRequest | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.storedRequestPath(requestId, principal), 'utf8')) as StoredRequest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async storeRequest(value: StoredRequest) {
    await fs.mkdir(this.requestsDir, { recursive: true });
    await this.atomicJson(this.storedRequestPath(value.requestId, value.principal), value);
    await this.pruneStoredRequests();
  }

  private async pruneStoredRequests() {
    const entries = await fs.readdir(this.requestsDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => ({ name: entry.name, stat: await fs.stat(path.join(this.requestsDir, entry.name)) }))
    );
    const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
    const ordered = files.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
    for (const entry of ordered) {
      if (entry.stat.mtimeMs < cutoff || ordered.indexOf(entry) >= 1_000) {
        await fs.rm(path.join(this.requestsDir, entry.name), { force: true });
      }
    }
  }

  private async executeTool(principal: Principal, request: ToolRequest) {
    const input = request.input ?? {};
    if (['mailbox_read', 'mailbox_send', 'mailbox_claim', 'mailbox_release', 'capability_run'].includes(request.name)) {
      const status = await this.mailbox.status();
      if (status.halted || status.round >= status.maxRounds) {
        throw new BusHaltedError(status.stopReason ?? `round guard reached (${status.round}/${status.maxRounds}); mutating tools fail closed.`);
      }
    }
    switch (request.name) {
      case 'mailbox_status':
        return this.mailbox.status();
      case 'mailbox_inbox': {
        const messages = await this.mailbox.inbox(this.authorizedAgent(principal, input.agent));
        return input.all === true ? messages : messages.slice(0, 1);
      }
      case 'mailbox_read':
        return this.mailbox.read(this.authorizedAgent(principal, input.agent), input.all === true);
      case 'mailbox_send':
        const from = this.authorizedAgent(principal, input.from);
        const to = requireAgent(input.to);
        await Promise.all([this.assertRegisteredAgent(from), this.assertRegisteredAgent(to)]);
        return this.mailbox.send({
          from,
          to,
          kind: optionalString(input.kind, 100) || 'note',
          subject: requireString(input.subject, 'subject', 1_000),
          body: requireString(input.body, 'body', 256 * 1024)
        });
      case 'mailbox_claim':
        return this.mailbox.claim({
          agent: this.authorizedAgent(principal, input.agent),
          paths: requireStringArray(input.paths, 'paths'),
          why: optionalString(input.why, 1_000)
        });
      case 'mailbox_release':
        return this.mailbox.release(
          this.authorizedAgent(principal, input.agent),
          input.paths === undefined ? undefined : requireStringArray(input.paths, 'paths')
        );
      case 'capability_list':
        return principal.kind === 'operator'
          ? this.capabilities.list()
          : (await this.capabilities.list()).filter((item) => (item.allowedSeats ?? []).some((seat) => seat === '*' || seat === principal.id));
      case 'capability_run': {
        if (this.activeCapabilityRuns >= this.maxConcurrentRuns) {
          throw new HarnessHttpError(429, 'concurrency_limit', `Capability concurrency limit reached (${this.maxConcurrentRuns}).`, true);
        }
        this.activeCapabilityRuns += 1;
        try {
          const id = requireString(input.id, 'id', 100);
          const definition = await this.capabilities.get(id);
          if (principal.kind === 'seat' && !(definition.allowedSeats ?? []).some((seat) => seat === '*' || seat === principal.id)) {
            throw new HarnessHttpError(403, 'capability_denied', `Seat ${principal.id} is not authorized to run capability ${id}.`);
          }
          return await this.capabilities.run(id, {
            timeoutMs: input.timeoutMs === undefined ? undefined : requireInteger(input.timeoutMs, 'timeoutMs'),
            seat: principal.kind === 'seat' ? principal.id : undefined
          });
        } finally {
          this.activeCapabilityRuns -= 1;
        }
      }
      default:
        throw new HarnessHttpError(404, 'unknown_tool', `Unknown harness tool: ${request.name}`);
    }
  }

  private authorizedAgent(principal: Principal, supplied: unknown) {
    if (principal.kind === 'seat') {
      if (supplied !== undefined && supplied !== null && supplied !== '' && requireAgent(supplied) !== principal.id) {
        throw new HarnessHttpError(403, 'seat_scope', `Seat ${principal.id} cannot act as another agent.`);
      }
      return principal.id;
    }
    return requireAgent(supplied);
  }

  private async assertRegisteredAgent(agent: string) {
    if (!(await this.mailbox.status()).agents.includes(agent)) {
      throw new HarnessHttpError(403, 'unknown_seat', `Recipient ${agent} is not a registered seat.`);
    }
  }

  private authenticate(request: http.IncomingMessage): Principal | undefined {
    const header = String(request.headers.authorization ?? '');
    if (!/^Bearer\s+\S+$/i.test(header)) return undefined;
    const supplied = header.replace(/^Bearer\s+/i, '');
    for (const [token, principal] of this.principals) {
      const left = Buffer.from(supplied);
      const right = Buffer.from(token);
      if (left.length === right.length && left.length > 0 && timingSafeEqual(left, right)) return principal;
    }
    return undefined;
  }

  private async readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      total += chunk.length;
      if (total > this.maxBodyBytes) {
        throw new HarnessHttpError(413, 'body_too_large', `Request body exceeds ${this.maxBodyBytes} bytes.`);
      }
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Request body must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  }

  private respond(response: http.ServerResponse, status: number, value: unknown) {
    if (response.headersSent) {
      return;
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(`${JSON.stringify(value)}\n`);
  }

  private async audit(value: Record<string, unknown>) {
    await fs.mkdir(this.runtimeDir, { recursive: true });
    const entry = redact({ at: new Date().toISOString(), ...value });
    await fs.appendFile(this.auditPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  private async atomicJson(destination: string, value: unknown) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, destination);
  }
}

function validateToolRequest(value: Record<string, unknown>): ToolRequest {
  const requestId = requireString(value.requestId, 'requestId', 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(requestId)) {
    throw new Error('Invalid requestId.');
  }
  return {
    requestId,
    name: requireString(value.name, 'name', 100),
    input: value.input === undefined ? {} : requireObject(value.input, 'input')
  };
}

class HarnessHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retriable = false
  ) {
    super(message);
    this.name = 'HarnessHttpError';
  }
}

function httpFailure(error: unknown) {
  if (error instanceof HarnessHttpError) return error;
  if (error instanceof BusHaltedError) return new HarnessHttpError(423, 'bus_halted', error.message);
  if (error instanceof ClaimConflictError) return new HarnessHttpError(409, 'claim_conflict', error.message);
  if (error instanceof SyntaxError) return new HarnessHttpError(400, 'invalid_json', error.message);
  return new HarnessHttpError(500, 'internal_error', asMessage(error), true);
}

function requestFingerprint(request: unknown) {
  return createHash('sha256').update(stableJson(request)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireAgent(value: unknown) {
  const agent = requireString(value, 'agent', 100);
  if (!/^[a-zA-Z0-9_.-]+$/.test(agent)) {
    throw new Error('Invalid agent id.');
  }
  return agent;
}

function requireString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new Error(`${field} must be a non-empty string up to ${maxLength} characters.`);
  }
  return value;
}

function optionalString(value: unknown, maxLength: number) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  return requireString(value, 'value', maxLength);
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireStringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw new Error(`${field} must be a non-empty array with at most 256 items.`);
  }
  return value.map((item) => requireString(item, field, 4_096));
}

function requireInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${field} must be an integer.`);
  }
  return value;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /password|authorization|token|secret|api[_-]?key/i.test(key) ? '[REDACTED]' : redact(item)
      ])
    );
  }
  if (typeof value === 'string') {
    return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  }
  return value;
}

function summarize(value: unknown) {
  const text = JSON.stringify(redact(value));
  return text.length <= 2_000 ? JSON.parse(text) : { sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
}

function asMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function mintToken(principal: string) {
  return `pab1.${principal}.${randomBytes(32).toString('base64url')}`;
}

async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command !== 'serve') {
    throw new Error('Usage: harness.js serve [--root PATH] [--port N]');
  }
  const root = option(argv, '--root') ?? path.resolve(__dirname, '..', '..');
  const port = Number(option(argv, '--port') ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port must be an integer from 0 through 65535.');
  }
  const server = new HarnessServer(root);
  const endpoint = await server.start(port);
  process.stdout.write(`Portable AI Bus harness listening at http://${endpoint.host}:${endpoint.port}\n`);
  process.stdout.write(`Bearer token: ${endpoint.tokenPath}\n`);
  const stop = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

function option(argv: string[], name: string) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${asMessage(error)}\n`);
    process.exitCode = 1;
  });
}
