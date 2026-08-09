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

export type ProviderKind = 'cli' | 'api' | 'oauth' | 'exec' | 'codex';

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


/**
 * Find an executable form of `name` that `spawn(..., { shell: false })` can actually run.
 *
 * Returns the bare name when nothing better is found, so the failure surfaces as a normal
 * probe error rather than an exception here.
 */
export function resolveCliCommand(name: string): string {
  if (process.platform !== 'win32') return name;
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');

  // Prefer a REAL executable over the npm shim. Node 24 refuses to spawn a `.cmd` at all
  // (EINVAL, a deliberate hardening), and `shell: true` is not an acceptable workaround here
  // because prompts contain quotes the shell would re-parse. npm records the real binary in
  // the package's `bin`, so go straight to it.
  const appData = process.env.APPDATA;
  if (appData) {
    const packaged = nodePath.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', `${name}.exe`);
    try {
      if (nodeFs.existsSync(packaged)) return packaged;
    } catch {
      // fall through to the search below
    }
  }

  const roots = [
    appData ? nodePath.join(appData, 'npm') : '',
    ...(process.env.PATH ?? '').split(nodePath.delimiter)
  ].filter(Boolean);
  for (const root of roots) {
    // `.exe` first for the same reason: a shim we cannot spawn is worse than no match, because
    // it looks like a resolution succeeded.
    for (const extension of ['.exe', '.cmd', '.bat']) {
      const candidate = nodePath.join(root, name + extension);
      try {
        if (nodeFs.existsSync(candidate)) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return name;
}

export type CliProviderOptions = {
  /** Executable name or path. `claude` on PATH by default. */
  command?: string;
  /** Extra args inserted before the prompt. */
  extraArgs?: string[];
  log?: (event: string, data?: unknown) => void;
};

export function cliProvider(options: CliProviderOptions = {}): ModelProvider {
  const log = options.log ?? (() => {});

  // On Windows an npm-installed CLI is a `.cmd` shim, and `spawn` with `shell: false` cannot
  // execute one - it fails with exit -1 and a message that reads like "not installed", which
  // sent me looking for a missing package that was in fact present. Resolve the shim
  // explicitly rather than turning the shell on: `shell: true` would make every argument a
  // string the shell re-parses, and prompts contain quotes.
  const command = options.command ?? resolveCliCommand('claude');

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
// codex
// ---------------------------------------------------------------------------

/**
 * Locate the Codex CLI.
 *
 * It is usually NOT on PATH: the ChatGPT VS Code extension ships the binary inside its own
 * extension directory, which is where it was found on this machine. Searching PATH alone
 * reports "not installed" for a CLI that is present and logged in — the same class of mistake
 * that made `claude` look missing when only the npm shim was unspawnable.
 */
export function resolveCodexCommand(explicit?: string): string {
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');
  if (explicit) return explicit;
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;

  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of (process.env.PATH ?? '').split(nodePath.delimiter).filter(Boolean)) {
    try {
      const candidate = nodePath.join(dir, exe);
      if (nodeFs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }

  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const extensions = nodePath.join(home, '.vscode', 'extensions');
    try {
      const arch = process.platform === 'win32' ? 'windows-x86_64' : '';
      const match = nodeFs.readdirSync(extensions)
        .filter((name) => name.startsWith('openai.chatgpt'))
        .sort()
        .reverse();
      for (const name of match) {
        const candidate = nodePath.join(extensions, name, 'bin', arch, exe);
        if (nodeFs.existsSync(candidate)) return candidate;
      }
    } catch { /* fall through */ }
  }
  return exe;
}

export type CodexProviderOptions = {
  command?: string;
  /** Passed to `--model`. Omit to use whatever Codex is configured for. */
  model?: string;
  timeoutMs?: number;
  log?: (event: string, data?: unknown) => void;
};

/**
 * The Codex CLI as a provider, authenticated on ITS OWN ChatGPT subscription.
 *
 * This is the concrete answer to Hymlock's constraint. Every other link in the default chain
 * is Anthropic, so a chain of them shares one wallet AND one concurrency ceiling — the ceiling
 * that produced "you've hit your session limit" while the account sat at 30% usage. A Codex
 * link is the first one that fails independently of the others.
 *
 * Two details that `execProvider` cannot express, which is why this is not just a template:
 *
 *   - The answer comes from `--output-last-message`, not stdout. stdout carries a banner, the
 *     session id, and a token count; scraping it would make the reply depend on Codex's
 *     formatting.
 *   - `probe` asks `login status`, which costs nothing. The generic exec probe runs the command
 *     with an empty prompt, which for Codex means a real, billed model call just to ask whether
 *     it is reachable.
 */
export function codexProvider(options: CodexProviderOptions = {}): ModelProvider {
  const log = options.log ?? (() => {});
  const command = resolveCodexCommand(options.command);
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeOs = require('node:os') as typeof import('node:os');

  async function run(args: string[], timeoutMs: number) {
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      // stdin is 'ignore' deliberately: `codex exec` reads stdin when it is a pipe and will
      // sit there printing "Reading additional input from stdin..." forever otherwise.
      const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
    kind: 'codex',

    async probe() {
      const { code, stdout, stderr } = await run(['login', 'status'], 30_000);
      const text = `${stdout}${stderr}`.trim();
      if (code === 0 && /logged in/i.test(text)) {
        return { ok: true, detail: `codex: ${text.split('\n')[0]}` };
      }
      return { ok: false, detail: `codex not usable: ${text.slice(0, 200) || `exit ${code}`}` };
    },

    async ask(prompt, { systemPrompt = '', timeoutMs = options.timeoutMs ?? 600_000 } = {}) {
      const answerFile = nodePath.join(
        nodeOs.tmpdir(), `codex-answer-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only',
                    '--output-last-message', answerFile];
      if (options.model) args.push('--model', options.model);
      // Codex has no separate system-prompt flag, so it is prepended. Keeping the shape
      // identical to the other providers is the point: the brain must not know who answered.
      args.push(systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt);

      const { code, stdout, stderr } = await run(args, timeoutMs);
      let answer = '';
      try {
        answer = nodeFs.readFileSync(answerFile, 'utf8').trim();
      } catch { /* reported below */ }
      try { nodeFs.unlinkSync(answerFile); } catch { /* best effort */ }

      if (code !== 0 || !answer) {
        // The failure TEXT is returned, not swallowed, because `classifyFailure` reads it to
        // decide between backing off and abandoning this link.
        const detail = (stderr || stdout || `codex exited ${code}`).slice(0, 400);
        log('codex-failed', { code, detail });
        return { text: detail, isError: true };
      }
      return { text: answer, isError: false };
    }
  };
}

// ---------------------------------------------------------------------------

export type ResolveOptions = {
  kind?: ProviderKind;
  cli?: CliProviderOptions;
  sdk?: SdkProviderOptions;
  exec?: ExecProviderOptions;
  codex?: CodexProviderOptions;
};

/**
 * Build ONE provider. Prefer `resolveChain` - a single provider means a seat dies when that
 * provider is exhausted, which is the failure Hymlock ruled out. Kept because a chain is built
 * from these.
 */
export function resolveProvider(options: ResolveOptions = {}): ModelProvider {
  const kind = options.kind ?? (process.env.PORTABLE_AI_BUS_PROVIDER as ProviderKind | undefined) ?? 'cli';
  if (kind === 'cli') return cliProvider(options.cli);
  if (kind === 'api' || kind === 'oauth') return sdkProvider(kind, options.sdk);
  if (kind === 'codex') return codexProvider(options.codex);
  if (kind === 'exec') {
    if (!options.exec) throw new Error('provider "exec" needs { command, args }');
    return execProvider(options.exec);
  }
  throw new Error(`unknown provider "${kind}" - expected cli, codex, api, oauth, or exec`);
}

/**
 * Build an ordered chain from a list of provider configs.
 *
 * This is the shape a seat should use. `cli` first because it costs nothing beyond a
 * subscription already paid for; `api` next when a key exists; `exec` last as the vendor-neutral
 * escape hatch. A seat backed by all three survives two of them being exhausted.
 */
export function resolveChain(
  configs: ResolveOptions[],
  chainOptions?: { log?: (event: string, data?: unknown) => void }
) {
  if (configs.length === 0) throw new Error('resolveChain needs at least one provider config');
  // Imported lazily so `providers.ts` stays usable on its own and the two modules do not form
  // an import cycle.
  const { chainProviders } = require('./chain') as typeof import('./chain');
  return chainProviders(configs.map((config) => resolveProvider(config)), chainOptions);
}
