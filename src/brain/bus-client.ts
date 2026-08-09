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
          const args = ['send', '--seat', seat, '--to', input.to, '--kind', input.kind,
                        '--subject', input.subject, '--body', input.body];
          if (input.keepBaton) args.push('--keep-baton');
          const { stdout } = await run(args, 30_000);
          return parse(stdout);
        },
        async status() {
          const { stdout } = await run(['status', '--seat', seat], 30_000);
          return (parse(stdout) as Record<string, unknown>) ?? {};
        },
        async claim(paths, why) {
          const { stdout } = await run(
            ['claim', '--seat', seat, '--paths', paths.join(','), '--why', why], 30_000);
          return parse(stdout);
        },
        async release(paths) {
          const args = ['release', '--seat', seat];
          if (paths?.length) args.push('--paths', paths.join(','));
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
