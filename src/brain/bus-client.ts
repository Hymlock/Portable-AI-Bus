/**
 * Binds the brain runner to the real harness over HTTP.
 *
 * Deliberately a thin shim over the same endpoints `worker-client` already uses. A second
 * client would be a second place for the seat/lease/auth rules to drift, and this project has
 * paid for that kind of duplication before.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { BrainMessage, BrainTools } from './contract';
import { BusClient } from './runner';

export type CliBusOptions = {
  root: string;
  /** Directory holding the compiled worker-client.js. Defaults to this package. */
  distDir?: string;
  log?: (event: string, data?: unknown) => void;
};

/**
 * Drives `worker-client.js` as a child process.
 *
 * Chosen over an in-process HTTP client on purpose: `listen` must be able to block for minutes
 * without the runner holding anything open that a crash could strand, and the CLI already owns
 * lease acquisition, heartbeats and the 0/2/3 exit contract. Reusing it means the brain path
 * and the human path cannot disagree about what "attended" means.
 */
export function cliBusClient(options: CliBusOptions): BusClient {
  const distDir = options.distDir ?? __dirname.replace(/[\\/]brain$/, '');
  const client = path.join(distDir, 'worker-client.js');
  const log = options.log ?? (() => {});

  async function run(args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [client, ...args, '--root', options.root], {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout });
      });
    });
  }

  function parse(stdout: string): unknown {
    const start = stdout.indexOf('{');
    if (start < 0) return null;
    try {
      return JSON.parse(stdout.slice(start));
    } catch {
      return null;
    }
  }

  return {
    async listen(seat, deadlineSeconds) {
      // 0 = mail, 3 = timeout. Anything else is a real problem, but the runner must not die of
      // it - an unreachable harness should look like a quiet bus, not a dead agent.
      const { code } = await run(
        ['listen', '--seat', seat, '--deadline-s', String(deadlineSeconds)],
        (deadlineSeconds + 30) * 1000
      );
      if (code === 0) return 'mail';
      if (code !== 3) log('listen-unexpected-exit', { seat, code });
      return 'timeout';
    },

    async read(seat) {
      const { stdout } = await run(['read', '--seat', seat, '--all'], 30_000);
      const payload = parse(stdout) as { result?: BrainMessage[] } | null;
      const result = payload?.result;
      return Array.isArray(result) ? result : [];
    },

    tools(seat): BrainTools {
      return {
        async send(input) {
          // Same reasoning: a model may omit any of these. An empty body is rejected by the
          // mailbox, so a missing one would fail the send and lose the report entirely.
          const args = ['send', '--seat', seat,
                        '--to', String(input?.to ?? '').trim() || 'claude',
                        '--kind', String(input?.kind ?? 'note').trim() || 'note',
                        '--subject', String(input?.subject ?? '(no subject)').slice(0, 200),
                        '--body', String(input?.body ?? '').trim() || '(empty)'];
          if (input.keepBaton) args.push('--keep-baton');
          const { stdout } = await run(args, 30_000);
          return parse(stdout);
        },
        async status() {
          const { stdout } = await run(['status', '--seat', seat], 30_000);
          return (parse(stdout) as Record<string, unknown>) ?? {};
        },
        async claim(paths, why) {
          // Arguments here originate in MODEL OUTPUT, so they can be any shape or missing
          // entirely. `paths.join(...)` on an absent field threw and killed the wake - the
          // runner survived, but the seat then did no work while still looking attended,
          // which is the worst of both. Validate at the boundary between the model and the
          // bus, because that is the only place the shape is still in doubt.
          const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
          if (list.length === 0) {
            return { refused: 'claim needs a non-empty paths array' };
          }
          const { stdout } = await run(
            ['claim', '--seat', seat, '--paths', list.join(','), '--why', why || 'unstated'], 30_000);
          return parse(stdout);
        },
        async release(paths) {
          const args = ['release', '--seat', seat];
          const list = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.trim()) : [];
          if (list.length) args.push('--paths', list.join(','));
          const { stdout } = await run(args, 30_000);
          return parse(stdout);
        },
        async runCapability(id, timeoutMs = 60_000) {
          const { stdout } = await run(
            ['capability', '--seat', seat, '--id', id], timeoutMs + 10_000);
          return parse(stdout);
        }
      };
    }
  };
}
