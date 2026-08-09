/**
 * `brain` entry point — run a seat as a long-lived process.
 *
 *   node dist/brain/cli.js --root <bus root> --seat grok --brain ./my-brain.js
 *
 * The process stays up until it is signalled. It does not stop when the brain finishes a
 * report, which is the whole reason this exists (`docs/LOOP_ARCHITECTURE.md`).
 */

import * as path from 'node:path';
import { Brain, BrainFactory } from './contract';
import { cliBusClient } from './bus-client';
import { runBrain } from './runner';

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

function integerOption(argv: string[], name: string, fallback: number): number {
  const raw = option(argv, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** An echo brain: acknowledges every message and reports nothing else. */
export const echoBrain: BrainFactory = ({ seat }) => ({
  name: 'echo',
  async takeTurn(context) {
    // Echo-on-receipt is standing policy (OPERATOR.md). Doing it in the default brain means a
    // seat is never silent by accident, which is what made silence ambiguous before: working,
    // never delivered, and dead all looked identical from outside.
    for (const message of context.messages) {
      await context.tools.send({
        to: message.from,
        kind: 'ack',
        subject: `echo #${message.seq}: ${message.subject}`.slice(0, 200),
        body: `${seat} received #${message.seq}. No brain attached yet, so this is receipt only.`,
        keepBaton: true
      });
    }
    return { done: true, note: `echoed ${context.messages.length}` };
  }
});

async function loadBrain(spec: string | undefined, seat: string, root: string): Promise<Brain> {
  const log = (event: string, data?: unknown) => console.log(JSON.stringify({ event, ...(data as object) }));
  if (!spec || spec === 'echo') {
    return echoBrain({ seat, root, log }) as Brain;
  }
  const resolved = path.isAbsolute(spec) ? spec : path.resolve(process.cwd(), spec);
  const module = await import(`file://${resolved.replace(/\\/g, '/')}`);
  const factory: BrainFactory = module.default ?? module.createBrain;
  if (typeof factory !== 'function') {
    throw new Error(`${spec} must export a default BrainFactory or a createBrain function`);
  }
  return factory({ seat, root, log });
}

export async function main(argv: string[]): Promise<number> {
  const root = option(argv, '--root');
  const seat = option(argv, '--seat');
  if (!root || !seat) {
    console.error('usage: brain --root PATH --seat AGENT [--brain MODULE] [--budget N] [--listen-s N]');
    return 2;
  }

  const log = (event: string, data?: unknown) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), seat, event, ...(data as object) }));

  const brain = await loadBrain(option(argv, '--brain'), seat, root);
  log('brain-loaded', { brain: brain.name });

  const stopSignal = new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });

  const summary = await runBrain({
    seat,
    brain,
    bus: cliBusClient({ root, log }),
    budgetPerWake: integerOption(argv, '--budget', 30),
    listenSeconds: integerOption(argv, '--listen-s', 300),
    log,
    stopSignal
  });

  log('exit', summary);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(JSON.stringify({ event: 'fatal', message: (error as Error).message }));
      process.exitCode = 1;
    });
}
