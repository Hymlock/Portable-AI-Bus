import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

type Endpoint = {
  schemaVersion: 1;
  instanceId: string;
  host: '127.0.0.1';
  port: number;
  seats: string[];
};

export type WorkerClientOptions = {
  root: string;
  seat: string;
  timeoutMs?: number;
  credentialsDir?: string;
};

export type WakeResult = { wake: 'message' | 'timeout'; messages: unknown[] };

export async function waitForMailbox(options: WorkerClientOptions): Promise<WakeResult> {
  const connection = await discoverConnection(options);
  await requestJson(connection, '/v1/heartbeat', {
    method: 'POST',
    body: JSON.stringify({ agent: options.seat })
  });
  const timeoutMs = bounded(options.timeoutMs ?? 25_000, 0, 30_000, 'timeoutMs');
  const result = await requestJson(connection, `/v1/wake?timeoutMs=${timeoutMs}`);
  if ((result.wake !== 'message' && result.wake !== 'timeout') || !Array.isArray(result.messages)) {
    throw new Error('Harness returned a malformed wake response.');
  }
  return { wake: result.wake, messages: result.messages };
}

async function discoverConnection(options: WorkerClientOptions) {
  const root = path.resolve(options.root);
  if (!/^[a-zA-Z0-9_.-]+$/.test(options.seat)) throw new Error('Invalid worker seat id.');
  const endpointPath = path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json');
  const endpoint = JSON.parse(await fs.readFile(endpointPath, 'utf8')) as Endpoint;
  if (endpoint.schemaVersion !== 1 || endpoint.host !== '127.0.0.1' ||
      !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535 ||
      typeof endpoint.instanceId !== 'string' || !Array.isArray(endpoint.seats) || !endpoint.seats.includes(options.seat)) {
    throw new Error('Harness endpoint is invalid or does not register this seat.');
  }
  const workspaceKey = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const credentialsRoot = options.credentialsDir ?? path.join(os.homedir(), '.portable-ai-bus', 'credentials', workspaceKey);
  const tokenPath = path.join(credentialsRoot, endpoint.instanceId, 'seats', `${options.seat}.token`);
  const token = (await fs.readFile(tokenPath, 'utf8')).trim();
  if (!/^pab1\.[a-zA-Z0-9_.-]+\.[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error('Worker seat credential is malformed.');
  return { baseUrl: `http://${endpoint.host}:${endpoint.port}`, token };
}

async function requestJson(connection: { baseUrl: string; token: string }, pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${connection.baseUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  const value = await response.json() as Record<string, unknown>;
  if (!response.ok || value.ok !== true) {
    const error = value.error as { code?: string; message?: string } | string | undefined;
    const message = typeof error === 'string' ? error : error?.message;
    throw new Error(`Harness request failed (${response.status}): ${message ?? 'unknown error'}`);
  }
  return value;
}

async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command !== 'wait' && command !== 'watch') {
    throw new Error('Usage: worker-client <wait|watch> --root PATH --seat AGENT [--timeout-ms N] [--credentials-dir PATH]');
  }
  const options: WorkerClientOptions = {
    root: option(argv, '--root') ?? path.resolve(__dirname, '..', '..'),
    seat: requiredOption(argv, '--seat'),
    timeoutMs: Number(option(argv, '--timeout-ms') ?? 25_000),
    credentialsDir: option(argv, '--credentials-dir')
  };
  if (command === 'wait') {
    process.stdout.write(`${JSON.stringify(await waitForMailbox(options))}\n`);
    return;
  }
  let stopped = false;
  process.once('SIGINT', () => { stopped = true; });
  process.once('SIGTERM', () => { stopped = true; });
  const seen = new Set<number>();
  while (!stopped) {
    try {
      const result = await waitForMailbox(options);
      const fresh = result.messages.filter((message) => {
        const seq = message && typeof message === 'object' ? (message as { seq?: unknown }).seq : undefined;
        if (!Number.isInteger(seq) || seen.has(seq as number)) return false;
        seen.add(seq as number);
        return true;
      });
      if (fresh.length > 0) process.stdout.write(`${JSON.stringify({ wake: 'message', messages: fresh })}\n`);
      if (result.wake === 'message' && fresh.length === 0) await delay(500);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ event: 'disconnected', message: asMessage(error) })}\n`);
      await delay(2_000);
    }
  }
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

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function asMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(`${asMessage(error)}\n`);
    process.exitCode = 1;
  });
}
