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

import { processAvailable, runProcess, type ProcessResult } from './process-host';

/**
 * Keep the process-host failure TEXT so `classifyFailure` can tell BROKEN from SPENT.
 *
 * cli/exec used to return `{ text: '', isError: true }` when stdout was empty, which
 * collapsed a missing node-pty into "provider reported an error" and then into
 * chain-exhausted / out of providers. Codex and grok already forwarded stderr; this
 * helper is the same rule for every adapter.
 */
export function providerFailureText(result: ProcessResult, fallback: string): string {
  const detail = (result.stderr || result.stdout || fallback).replace(/\s+/g, ' ').trim();
  if (result.failureKind === 'broken' && detail && !/^broken\b/i.test(detail)) {
    return `BROKEN ${detail}`;
  }
  return detail || fallback;
}

const PROVIDER_STALL_MS = 30_000;

export type ProviderKind = 'cli' | 'api' | 'oauth' | 'exec' | 'codex' | 'grok';

export type ModelReply = {
  text: string;
  /** Provider-reported cost in USD, when it reports one. Not all do. */
  costUsd?: number;
  /** Opaque handle for continuing this conversation, when the provider supports it. */
  sessionId?: string;
  isError: boolean;
};

export type AskOptions = {
  systemPrompt?: string;
  sessionId?: string;
  model?: string;
  timeoutMs?: number;
  /**
   * JSON Schema the reply should match. A **hint**, not a contract.
   *
   * Providers that can constrain decoding honour it; the rest ignore it and the caller parses
   * as before, so this never becomes a vendor branch in the brain. The brain says what shape it
   * wants; each provider does as much about that as it can.
   *
   * Added because the grok seat spent every wake narrating its intent in prose — "I'll identify
   * the code commit and report findings" — instead of emitting the plan. It was authenticated,
   * billing its own vendor, and contributing nothing. Asking harder in the prompt had already
   * failed; xAI's CLI can enforce the shape, so it should.
   */
  responseSchema?: unknown;
};

export type ModelProvider = {
  readonly kind: ProviderKind;
  /** One prompt, one reply. Continuation is via `sessionId` when supported. */
  ask(prompt: string, options?: AskOptions): Promise<ModelReply>;
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

/**
 * A working directory that is NOT a git repository.
 *
 * This is the fix for the window flashes, and it took a window-creation hook to find because
 * polling never caught it. The captured evidence:
 *
 *   CREATE pid=13796 conhost class=ConsoleWindowClass title=C:\Program Files\Git\...\git.exe
 *   CREATE pid=37952 conhost class=ConsoleWindowClass title=C:\Program Files\Git\...\git.exe
 *
 * Two per model call, every call. An agent CLI started inside a repository shells out to `git`
 * for context. `git` is our GRANDCHILD, so the `windowsHide` we set on the model process never
 * reaches it: it gets a console of its own, and that console flashes.
 *
 * No flag on our side can fix a grandchild we do not spawn. Removing the REASON works: with no
 * repository at the working directory there is nothing for the CLI to ask git about.
 *
 * Safe because a brain reasons about mail, not about files. Anything needing repo context goes
 * through bus tools and capabilities, which run separately and deliberately.
 */
/**
 * Should a spawned model process be given CREATE_NO_WINDOW?
 *
 * Normally yes. But under `bus-console` the whole point is that the brain OWNS a real console
 * and every descendant inherits it â€” and `windowsHide` defeats exactly that. Node maps it to
 * CREATE_NO_WINDOW, which means "no console" and beats the inherited handles, so the model
 * process ends up console-less and the `git` calls IT makes each allocate one. Which is how a
 * shared-console run still flashed.
 *
 * Inheritance is the only mechanism that reaches a grandchild. We do not spawn `git`; the agent
 * CLIs do, for repo context, and no flag of ours can be applied to a process we never launch.
 * A console at the top of the tree covers all of them at once.
 */
function hideWindows(): boolean {
  return process.env.PORTABLE_AI_BUS_INHERIT_CONSOLE !== '1';
}

function nonRepoCwd(): string {
  const nodeOs = require('node:os') as typeof import('node:os');
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const dir = nodePath.join(nodeOs.tmpdir(), 'portable-ai-bus-brain-cwd');
  try {
    nodeFs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return nodeOs.tmpdir();
  }
}

export type CliProviderOptions = {
  /** Executable name or path. `claude` on PATH by default. */
  command?: string;
  /** Extra args inserted before the prompt. */
  extraArgs?: string[];
  /** Working directory. Defaults to a non-repo scratch dir â€” see `nonRepoCwd`. */
  cwd?: string;
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
  const cwd = options.cwd ?? nonRepoCwd();

  async function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
    return runProcess(command, args, {
      cwd, timeoutMs, windowsHide: hideWindows(), stallMs: PROVIDER_STALL_MS, log
    });
  }

  return {
    kind: 'cli',

    async probe() {
      if (!processAvailable(command, process.env, cwd)) {
        return {
          ok: false,
          detail: `\`${command}\` was not found. Install with ` +
                  '`npm i -g @anthropic-ai/claude-code`, or configure a different provider.'
        };
      }
      return { ok: true, detail: 'claude reachable (authentication verified on first call)' };
    },

    async ask(prompt, { systemPrompt, sessionId, model, timeoutMs = 300_000 } = {}) {
      // `bypassPermissions` for the same reason codex gets `danger-full-access`: a seat should
      // have what this vendor's plugin has. In `-p` there is no human to answer a permission
      // prompt, so the default mode silently reduces a capable agent to a reader - the same
      // restriction as codex's old sandbox, wearing different clothes. It is granted here rather
      // than left to chance because a seat that half-works is harder to diagnose than one that
      // cannot work at all: this is precisely how grok looked "broken" for two days.
      const args = ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions'];
      if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
      if (model) args.push('--model', model);
      // Continuing a session reuses the cached system prompt. The first call on this machine
      // reported $0.236, of which nearly all was 23,522 cache-CREATION tokens. A brain that
      // starts fresh every wake pays that repeatedly; resuming pays cache-READ instead.
      if (sessionId) args.push('--resume', sessionId);
      args.push(prompt);

      const result = await run(args, timeoutMs);
      const { code, stdout } = result;
      if (code !== 0 && !stdout.trim()) {
        return { text: providerFailureText(result, `cli exited ${code}`), isError: true };
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
// api / oauth â€” both go through the SDK, differing only in how they authenticate
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
    }, options?: { signal?: AbortSignal }): Promise<{ content: { type: string; text?: string }[] }>;
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

    async ask(prompt, { systemPrompt, timeoutMs = 300_000 } = {}) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      try {
        const anthropic = await client();
        const request = anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: [{ role: 'user', content: prompt }]
        }, { signal: controller.signal });
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Provider request timed out after ${timeoutMs} ms.`));
            controller.abort();
          }, timeoutMs);
        });
        const reply = await Promise.race([request, timeout]);
        const text = reply.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');
        return { text, isError: false };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log('sdk-error', { message: detail });
        // The chain classifies this text (quota/auth/timeout/etc.) to decide what to do next.
        // Swallowing it as an empty error made every SDK failure look identical.
        return { text: detail, isError: true };
      } finally {
        if (timer) clearTimeout(timer);
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
    return runProcess(options.command, args, {
      timeoutMs, windowsHide: true, stallMs: PROVIDER_STALL_MS, log
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
      const result = await run(fill(options.args, prompt, systemPrompt), timeoutMs);
      const { code, stdout, stderr } = result;
      if (code !== 0) {
        log('exec-failed', { command: options.command, code, stderr: stderr.slice(0, 200) });
        return { text: providerFailureText(result, `${options.command} exited ${code}`), isError: true };
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
 * reports "not installed" for a CLI that is present and logged in â€” the same class of mistake
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
  /** Working directory. Defaults to a non-repo scratch dir â€” see `nonRepoCwd`. */
  cwd?: string;
  timeoutMs?: number;
  log?: (event: string, data?: unknown) => void;
};

/**
 * The Codex CLI as a provider, authenticated on ITS OWN ChatGPT subscription.
 *
 * This is the concrete answer to Hymlock's constraint. Every other link in the default chain
 * is Anthropic, so a chain of them shares one wallet AND one concurrency ceiling â€” the ceiling
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
  const cwd = options.cwd ?? nonRepoCwd();
  const nodeFs = require('node:fs') as typeof import('node:fs');
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeOs = require('node:os') as typeof import('node:os');

  async function run(args: string[], timeoutMs: number) {
    // The process host never writes stdin. `codex exec` would otherwise wait for additional
    // piped input forever.
    return runProcess(command, args, {
      cwd, timeoutMs, windowsHide: hideWindows(), stallMs: PROVIDER_STALL_MS, log
    });
  }

  return {
    kind: 'codex',

    async probe() {
      return processAvailable(command, process.env, cwd)
        ? { ok: true, detail: 'codex reachable (authentication verified on first call)' }
        : { ok: false, detail: `codex not usable: command not found (${command})` };
    },

    async ask(prompt, { systemPrompt = '', timeoutMs = options.timeoutMs ?? 600_000 } = {}) {
      const answerFile = nodePath.join(
        nodeOs.tmpdir(), `codex-answer-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
      // `workspace-write`, not `read-only`. Seats are designed to have full functionality in
      // their workdir - Hymlock, 2026-08-10: *"We've always designed them to have full
      // functionality and access."* Pinning this to read-only made codex the only crippled seat
      // of the three, and it failed in a way that looked like the MODEL misbehaving: it reached
      // for `capability shell`, then `workspace_runner`, then `read_write_test`, burning paid
      // rounds hunting for a door I had locked.
      //
      // `--sandbox` still bounds it to the workspace rather than the whole machine, which is the
      // level the design calls for: agents that can do the work, inside the tree they were given.
      // `danger-full-access`, matching what this vendor's own VS Code plugin already has.
      // Hymlock, 2026-08-10: *"They need full permissions like their VSCode plugins."*
      //
      // `workspace-write` was not academic - it broke real work within the hour. A seat asked to
      // audit the BUS source could not read it, because its workdir is the Ensouled repo while
      // the bus lives in a sibling directory, and it correctly reported
      // "BLOCKED: provider code/history unavailable". Confining a seat to one tree makes
      // cross-repository work impossible, which is most of what these seats are for.
      //
      // The safety model is not this flag and never was. It is the bus: a loopback-only harness,
      // per-seat bearer tokens that cannot impersonate another seat, claims recording who owns
      // what, the baton recording who drives, halt returning 423, and git making every edit
      // reversible. Trusted agents whose ACTIONS ARE RECORDED beats a sandbox that also blocks
      // the legitimate work.
      const args = ['exec', '--skip-git-repo-check', '--sandbox', 'danger-full-access',
                    '--output-last-message', answerFile];
      if (options.model) args.push('--model', options.model);
      // Codex has no separate system-prompt flag, so it is prepended. Keeping the shape
      // identical to the other providers is the point: the brain must not know who answered.
      args.push(systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt);

      const result = await run(args, timeoutMs);
      const { code, stdout, stderr } = result;
      let answer = '';
      try {
        answer = nodeFs.readFileSync(answerFile, 'utf8').trim();
      } catch { /* reported below */ }
      try { nodeFs.unlinkSync(answerFile); } catch { /* best effort */ }

      if (code !== 0 || !answer) {
        // The failure TEXT is returned, not swallowed, because `classifyFailure` reads it to
        // decide between backing off and abandoning this link.
        const detail = providerFailureText(result, stderr || stdout || `codex exited ${code}`).slice(0, 400);
        log('codex-failed', { code, detail });
        return { text: detail, isError: true };
      }
      return { text: answer, isError: false };
    }
  };
}

// ---------------------------------------------------------------------------
// grok
// ---------------------------------------------------------------------------

/**
 * Pull the answer out of whatever shape `grok --output-format json` produced.
 *
 * Whole-document parse FIRST, then per-line. The first version only scanned lines, and this CLI
 * pretty-prints ONE object across many of them, so every line failed to parse and the fallback
 * handed the raw envelope back as though it were the answer:
 *
 *   {\n  "text": "pong",\n  "stopReason": "end_turn", ... }
 *
 * Nothing downstream can tell that from a model that genuinely replied in JSON. It is the
 * failure this project keeps paying for: output that looks like success.
 *
 * Exported so it can be tested on strings directly. Testing it through a fake executable meant
 * inventing a binary that accepts the provider's real flags, which tests the fake.
 */
export function extractGrokAnswer(stdout: string): { text: string; error?: string } {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '' };

  const fromObject = (value: Record<string, unknown>): { text: string; error?: string } => {
    if (value.type === 'error' && typeof value.message === 'string') {
      return { text: '', error: value.message };
    }
    // A cancelled Grok turn is an explicit provider failure, not an empty answer and not the
    // raw JSON envelope. Returning the envelope used to send a known provider cancellation into
    // parsePlan, where it was logged as malformed and bought a repair call that could not help.
    if (typeof value.text === 'string' && !value.text.trim() && value.stopReason === 'cancelled') {
      return { text: '', error: 'cancelled' };
    }
    // With --json-schema Grok may emit the structured answer directly, without a `text`
    // envelope. Treating this as an unknown event falls through to the original ConPTY bytes,
    // undoing `undoTerminalStringWraps` and making a valid long plan malformed again.
    if (Array.isArray(value.actions) && typeof value.done === 'boolean') {
      return { text: JSON.stringify(value) };
    }
    for (const key of ['text', 'result', 'response', 'content', 'message']) {
      const candidate = value[key];
      if (typeof candidate === 'string' && candidate.trim()) return { text: candidate };
    }
    return { text: '' };
  };

  // Scan for EVERY top-level JSON object by matching braces, and take the last one that carries
  // an answer.
  //
  // Two earlier attempts failed here, each for a different reason, and both looked from the
  // outside like "the model returned prose":
  //   - first brace to end of document: spans past the first object when several are emitted
  //   - first brace to LAST brace: same failure once the CLI emits tool events plus an answer,
  //     which is exactly what happens with tool execution enabled
  // A compliant reply was being discarded by the parser both times.
  let best: { text: string; error?: string } | undefined;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < trimmed.length; j += 1) {
      const ch = trimmed[j];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = fromObject(JSON.parse(trimmed.slice(i, j + 1)) as Record<string, unknown>);
            if (parsed.error) return parsed;          // an error is decisive; stop at once
            if (parsed.text) best = parsed;            // otherwise keep the LAST answer seen
          } catch { /* not an object we understand; keep scanning */ }
          i = j;                                       // continue after this object
          break;
        }
      }
    }
  }
  if (best) {
    // Unwrap repeatedly. Observed live: the answer can pass through several JSON-producing
    // layers (CLI, ConPTY transport, structured-output wrapper). Three layers was not enough:
    // the live Grok seat still handed an outer `{ "text": "..." }` envelope to `parsePlan`
    // and burned repair calls on a plan that had already complied. Detect a plan by its parsed
    // top-level shape rather than by searching the raw string for `"actions"`; that substring
    // can itself appear escaped inside another envelope. Bounded, because an unbounded unwrap
    // on hostile input is a hang.
    let text = best.text;
    for (let depth = 0; depth < 12; depth += 1) {
      const inner = text.trim();
      if (!inner.startsWith('{')) break;
      try {
        const value = JSON.parse(inner) as Record<string, unknown>;
        if (Array.isArray(value.actions) && typeof value.done === 'boolean') break;
        const parsed = fromObject(value);
        if (parsed.error) return parsed;
        if (!parsed.text || parsed.text === text) break;
        text = parsed.text;
      } catch {
        // Grok can place more than one schema-valid plan inside the envelope's `text` field:
        // a progress plan immediately followed by the final report (`}{`, no delimiter). Run
        // that nested stream through the same object scanner and retain its last answer. This
        // mirrors the top-level JSONL rule and prevents an early progress object from hiding the
        // substantive report. Stop if extraction made no progress to avoid recursive churn.
        const nested = extractGrokAnswer(inner);
        if (nested.error) return nested;
        if (!nested.text || nested.text === text) break;
        text = nested.text;
      }
    }
    return { text };
  }

  let text = '';
  let error: string | undefined;
  for (const line of trimmed.split(/\r?\n/)) {
    const brace = line.indexOf('{');
    if (brace < 0) continue;
    try {
      const parsed = fromObject(JSON.parse(line.slice(brace)) as Record<string, unknown>);
      if (parsed.error) error = parsed.error;
      if (parsed.text) text = parsed.text;
    } catch { /* not JSON - fall through */ }
  }
  if (!text && !error) text = trimmed;   // plain-text output is still an answer
  return { text, error };
}

/**
 * Locate the xAI Grok CLI.
 *
 * The npm package installs a THIN TRAMPOLINE at `%APPDATA%\npm\grok.cmd`, which Node 24 cannot
 * spawn at all, and which in turn execs the real binary that postinstall unpacks into
 * `~/.grok/bin`. Go straight to the real binary for the same reason as `claude`: a shim that
 * cannot be spawned looks exactly like a missing install.
 */
export function resolveGrokCommand(explicit?: string): string {
  const nodePath = require('node:path') as typeof import('node:path');
  const nodeFs = require('node:fs') as typeof import('node:fs');
  if (explicit) return explicit;
  if (process.env.GROK_CLI_PATH) return process.env.GROK_CLI_PATH;

  const exe = process.platform === 'win32' ? 'grok.exe' : 'grok';
  const home = process.env.GROK_HOME
    ?? nodePath.join(process.env.USERPROFILE || process.env.HOME || '', '.grok');
  const candidates = [
    nodePath.join(home, 'bin', exe),
    ...(process.env.PATH ?? '').split(nodePath.delimiter).filter(Boolean).map((d) => nodePath.join(d, exe))
  ];
  for (const candidate of candidates) {
    try {
      if (nodeFs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  return exe;
}

export type GrokProviderOptions = {
  command?: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
  log?: (event: string, data?: unknown) => void;
};

/** Build a one-shot Grok invocation, keeping every CLI option before the `-p` prompt boundary. */
export function buildGrokArgs(prompt: string, responseSchema?: unknown, model?: string): string[] {
  const args = ['--output-format', 'json', '--always-approve'];
  if (responseSchema) args.push('--json-schema', JSON.stringify(responseSchema));
  if (model) args.push('--model', model);
  args.push('-p', prompt);
  return args;
}

/**
 * The xAI Grok CLI as a provider — the third vendor, and the one that makes the bus genuinely
 * vendor-independent rather than merely two-vendor.
 *
 * Authenticated by `grok login` against a SuperGrok / X Premium Plus subscription, so it follows
 * the same rule as the other two: piggyback the subscription the user already pays for, and
 * treat an API key as optional. `XAI_API_KEY` works if one is ever set, but is not required.
 *
 * `-p/--single` prints one response and exits, and `--output-format json` makes that response
 * parseable rather than scraped. Unlike Codex there is no free auth check — no `login status`
 * subcommand exists — so `probe` verifies REACHABILITY only, and being signed out surfaces on
 * the first real call as an `auth` failure that the chain falls through on.
 */
export function grokProvider(options: GrokProviderOptions = {}): ModelProvider {
  const log = options.log ?? (() => {});
  const command = resolveGrokCommand(options.command);
  const cwd = options.cwd ?? nonRepoCwd();
  const nodePath = require('node:path') as typeof import('node:path');

  async function run(args: string[], timeoutMs: number) {
    const userHome = process.env.USERPROFILE || process.env.HOME || '';
    const grokHome = process.env.GROK_HOME || (userHome ? nodePath.join(userHome, '.grok') : '');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(userHome && !process.env.HOME ? { HOME: userHome } : {}),
      ...(grokHome ? { GROK_HOME: grokHome } : {})
    };
    return runProcess(command, args, {
      cwd, timeoutMs, windowsHide: hideWindows(), env, stallMs: PROVIDER_STALL_MS, log
    });
  }

  return {
    kind: 'grok',

    async probe() {
      // Reachability only. There is no free way to ask "am I signed in", and spending a model
      // call on every startup to find out is the mistake the codex probe deliberately avoids.
      return processAvailable(command, process.env, cwd)
        ? { ok: true, detail: 'grok reachable (authentication verified on first call)' }
        : { ok: false, detail: `grok not usable: command not found (${command})` };
    },

    async ask(prompt, { systemPrompt = '', timeoutMs = options.timeoutMs ?? 600_000, responseSchema } = {}) {
      // `--always-approve` because there is no TTY here to approve anything. Without it the CLI
      // plans a tool call, cannot get consent, and ABORTS the whole reply -
      // `{"text":"","stopReason":"cancelled"}` - which reads downstream as a broken model rather
      // than a withheld permission. Measured: identical prompts returned `cancelled` with tools
      // pending and `end_turn` without them.
      //
      // This grants unattended tool execution, and that is the design: seats have full
      // functionality in their workdir. The boundary that keeps it safe is the WORKDIR plus git,
      // not a prompt telling a capable agent it is powerless.
      // Constrain decoding when the caller says what shape it needs. This is the whole reason
      // the grok seat can be trusted with structured work: the CLI enforces the schema, so
      // "reply with only JSON" stops being a request the model may decline.
      const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
      const args = buildGrokArgs(combinedPrompt, responseSchema, options.model);

      const result = await run(args, timeoutMs);
      const { code, stdout, stderr } = result;
      const { text, error } = extractGrokAnswer(stdout);

      // Diagnostic, not a fix. Three parser rewrites today were aimed at shapes I reconstructed
      // from a 120-character log snippet, and the isolated shape parses fine while the live one
      // does not - so the assumption about what actually arrives is wrong somewhere. Record the
      // raw envelope's size and ENDS when extraction falls back to raw text, because a truncated
      // stream and a differently-shaped one look identical in a snippet and demand opposite fixes.
      if (!error && text === stdout.trim() && stdout.trim().startsWith('{')) {
        log('grok-extract-fellback', {
          rawLength: stdout.length,
          head: stdout.slice(0, 60),
          tail: stdout.slice(-60),
          endsBalanced: stdout.trim().endsWith('}')
        });
      }

      if (error || code !== 0 || !text.trim()) {
        // The failure TEXT is returned rather than swallowed: `classifyFailure` reads it to tell
        // "not signed in" (auth - fall through now) from a rate limit (retry this same link).
        const detail = (error || providerFailureText(result, stderr || stdout || `grok exited ${code}`)).slice(0, 400);
        log('grok-failed', { code, detail });
        return { text: detail, isError: true };
      }
      return { text: text.trim(), isError: false };
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
  grok?: GrokProviderOptions;
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
  if (kind === 'grok') return grokProvider(options.grok);
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
