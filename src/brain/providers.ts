/**
 * How a brain reaches a model. Three routes, chosen by config, all optional.
 *
 * Verified on this machine 2026-08-09:
 *   cli    `claude -p --output-format json` -> {"result":"BRAIN_OK","is_error":false}
 *          Authenticated under the existing Claude Code subscription. No API key needed.
 *   api    @anthropic-ai/sdk with ANTHROPIC_API_KEY. Clean, metered separately.
 *   oauth  the SDK's `ant auth login` profile, where the account allows it.
 *
 * `cli` is the default because it is the only one that costs nothing beyond a subscription the
 * user already pays for. The others exist so a seat is never blocked on one vendor's tooling.
 */

import { spawn } from 'node:child_process';

export type ProviderKind = 'cli' | 'api' | 'oauth' | 'exec';

export type ModelReply = {
  text: string;
  /** Provider-reported cost in USD, when it reports one. Not all do. */
  costUsd?: number;
  /** Opaque handle for continuing this conversation, when the provider supports it. */
  sessionId?: string;
  isError: boolean;
};

export type ModelProvider = {
  readonly kind: ProviderKind;
  /** One prompt, one reply. Continuation is via `sessionId` when supported. */
  ask(prompt: string, options?: { systemPrompt?: string; sessionId?: string; model?: string; timeoutMs?: number }): Promise<ModelReply>;
  /** Cheap check that this provider can actually run. Never throws. */
  probe(): Promise<{ ok: boolean; detail: string }>;
};

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

export type CliProviderOptions = {
  /** Executable name or path. `claude` on PATH by default. */
  command?: string;
  /** Extra args inserted before the prompt. */
  extraArgs?: string[];
  log?: (event: string, data?: unknown) => void;
};

export function cliProvider(options: CliProviderOptions = {}): ModelProvider {
  const command = options.command ?? 'claude';
  const log = options.log ?? (() => {});

  async function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: String(error) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  return {
    kind: 'cli',

    async probe() {
      const { code, stdout, stderr } = await run(['--version'], 20_000);
      if (code !== 0) {
        return {
          ok: false,
          detail: `\`${command} --version\` exited ${code}. Install with ` +
                  '`npm i -g @anthropic-ai/claude-code`, or configure a different provider. ' +
                  (stderr.trim().slice(0, 200) || '')
        };
      }
      return { ok: true, detail: stdout.trim().split('\n')[0] };
    },

    async ask(prompt, { systemPrompt, sessionId, model, timeoutMs = 300_000 } = {}) {
      const args = ['-p', '--output-format', 'json'];
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
      if (model) args.push('--model', model);
      // Continuing a session reuses the cached system prompt. The first call on this machine
      // reported $0.236, of which nearly all was 23,522 cache-CREATION tokens. A brain that
      // starts fresh every wake pays that repeatedly; resuming pays cache-READ instead.
      if (sessionId) args.push('--resume', sessionId);
      args.push(prompt);

      const { code, stdout, stderr } = await run(args, timeoutMs);
      if (code !== 0 && !stdout.trim()) {
        return { text: '', isError: true, ...(stderr ? { } : {}) };
      }
      try {
        const parsed = JSON.parse(stdout.slice(stdout.indexOf('{')));
        return {
          text: String(parsed.result ?? ''),
          isError: Boolean(parsed.is_error),
          costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : undefined,
          sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : undefined
        };
      } catch {
        log('cli-unparseable', { stdout: stdout.slice(0, 200) });
        return { text: stdout.trim(), isError: code !== 0 };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// api / oauth — both go through the SDK, differing only in how they authenticate
// ---------------------------------------------------------------------------

export type SdkProviderOptions = {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  /** Injected in tests. Production resolves `@anthropic-ai/sdk` lazily. */
  clientFactory?: (apiKey?: string) => Promise<AnthropicLike>;
  log?: (event: string, data?: unknown) => void;
};

/** The slice of the SDK we use, so tests need no network and no dependency. */
export type AnthropicLike = {
  messages: {
    create(input: {
      model: string;
      max_tokens: number;
      system?: string;
      messages: { role: 'user' | 'assistant'; content: string }[];
    }): Promise<{ content: { type: string; text?: string }[] }>;
  };
};

const DEFAULT_MODEL = 'claude-opus-5';

export function sdkProvider(kind: 'api' | 'oauth', options: SdkProviderOptions = {}): ModelProvider {
  const log = options.log ?? (() => {});
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? 4096;

  // `api` requires an explicit key. `oauth` deliberately passes none, letting the SDK resolve
  // an `ant auth login` profile the same way its own tooling does.
  const apiKey = kind === 'api' ? (options.apiKey ?? process.env.ANTHROPIC_API_KEY) : undefined;

  async function client(): Promise<AnthropicLike> {
    if (options.clientFactory) return options.clientFactory(apiKey);
    // Resolved by name at runtime so the SDK stays an OPTIONAL dependency. Importing it
    // statically would make every install of the bus require an Anthropic package, which is
    // the opposite of what a vendor-neutral provider layer is for.
    const specifier = '@anthropic-ai/sdk';
    const module = await (Function('s', 'return import(s)')(specifier) as Promise<{
      default: new (init?: { apiKey?: string }) => AnthropicLike;
    }>);
    const Anthropic = module.default;
    return new Anthropic(apiKey ? { apiKey } : {});
  }

  return {
    kind,

    async probe() {
      if (kind === 'api' && !apiKey) {
        return { ok: false, detail: 'ANTHROPIC_API_KEY is not set. Set it, or use provider "cli" or "oauth".' };
      }
      try {
        await client();
        return { ok: true, detail: `@anthropic-ai/sdk ready (${kind}, model ${model})` };
      } catch (error) {
        return {
          ok: false,
          detail: `@anthropic-ai/sdk unavailable: ${(error as Error).message}. ` +
                  'Install it in this workspace, or use provider "cli".'
        };
      }
    },

    async ask(prompt, { systemPrompt, timeoutMs } = {}) {
      void timeoutMs;
      try {
        const anthropic = await client();
        const reply = await anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: [{ role: 'user', content: prompt }]
        });
        const text = reply.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');
        return { text, isError: false };
      } catch (error) {
        log('sdk-error', { message: (error as Error).message });
        return { text: '', isError: true };
      }
    }
  };
}

// ---------------------------------------------------------------------------
// exec - any vendor, no adapter required
// ---------------------------------------------------------------------------

export type ExecProviderOptions = {
  command: string;
  /** `{prompt}` and `{system}` are substituted. Anything else is passed through. */
  args: string[];
  /** Where the reply lives in the JSON output. Omit if the command prints plain text. */
  resultPath?: string;
  timeoutMs?: number;
  log?: (event: string, data?: unknown) => void;
};

/**
 * Drive an arbitrary CLI as a model provider.
 *
 * This exists because of a specific failure mode Hymlock identified: if orchestration is tied
 * to ONE vendor, then that vendor running out of tokens takes the whole system down with it -
 * including the ability to hand off. A per-seat provider is not enough on its own; the seats
 * must be able to sit on DIFFERENT vendors.
 *
 * Rather than write an adapter per vendor, this templates a command line. Anything with a
 * non-interactive mode that prints an answer can back a seat.
 */
export function execProvider(options: ExecProviderOptions): ModelProvider {
  const log = options.log ?? (() => {});

  function fill(args: string[], prompt: string, system: string): string[] {
    return args.map((arg) => arg.replace('{prompt}', prompt).replace('{system}', system));
  }

  async function run(args: string[], timeoutMs: number) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(options.command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += String(c); });
      child.stderr.on('data', (c) => { stderr += String(c); });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }

  return {
    kind: 'exec',

    async probe() {
      const { code, stdout, stderr } = await run(fill(options.args, '', ''), 20_000);
      return code === 0
        ? { ok: true, detail: `${options.command} responded` }
        : { ok: false, detail: `${options.command} exited ${code}: ${(stderr || stdout).slice(0, 200)}` };
    },

    async ask(prompt, { systemPrompt = '', timeoutMs = options.timeoutMs ?? 300_000 } = {}) {
      const { code, stdout, stderr } = await run(fill(options.args, prompt, systemPrompt), timeoutMs);
      if (code !== 0) {
        log('exec-failed', { command: options.command, code, stderr: stderr.slice(0, 200) });
        return { text: '', isError: true };
      }
      if (!options.resultPath) return { text: stdout.trim(), isError: false };
      try {
        let value: unknown = JSON.parse(stdout.slice(stdout.indexOf('{')));
        for (const key of options.resultPath.split('.')) {
          value = (value as Record<string, unknown>)?.[key];
        }
        return { text: String(value ?? ''), isError: false };
      } catch {
        return { text: stdout.trim(), isError: false };
      }
    }
  };
}

// ---------------------------------------------------------------------------

export type ResolveOptions = {
  kind?: ProviderKind;
  cli?: CliProviderOptions;
  sdk?: SdkProviderOptions;
  exec?: ExecProviderOptions;
};

/**
 * Build the configured provider. Defaults to `cli` because it is the only route that adds no
 * cost beyond a subscription the user already holds.
 */
export function resolveProvider(options: ResolveOptions = {}): ModelProvider {
  const kind = options.kind ?? (process.env.PORTABLE_AI_BUS_PROVIDER as ProviderKind | undefined) ?? 'cli';
  if (kind === 'cli') return cliProvider(options.cli);
  if (kind === 'api' || kind === 'oauth') return sdkProvider(kind, options.sdk);
  if (kind === 'exec') {
    if (!options.exec) throw new Error('provider "exec" needs { command, args }');
    return execProvider(options.exec);
  }
  throw new Error(`unknown provider "${kind}" - expected cli, api, oauth, or exec`);
}
