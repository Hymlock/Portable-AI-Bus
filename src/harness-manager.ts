import { HarnessServer } from './harness';

export type HarnessEndpoint = Awaited<ReturnType<HarnessServer['start']>>;

type ManagedHarness = { server: HarnessServer; endpoint: HarnessEndpoint };

export class HarnessManager {
  private readonly managed = new Map<string, ManagedHarness>();
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(private readonly factory: (root: string) => HarnessServer = (root) => new HarnessServer(root)) {}

  owns(root: string) {
    return this.managed.has(root);
  }

  endpoint(root: string) {
    return this.managed.get(root)?.endpoint;
  }

  async start(root: string, port: number) {
    return this.serialize(root, async () => {
      const existing = this.managed.get(root);
      if (existing) return { started: false, endpoint: existing.endpoint };
      const server = this.factory(root);
      const endpoint = await server.start(port);
      this.managed.set(root, { server, endpoint });
      return { started: true, endpoint };
    });
  }

  async stop(root: string) {
    return this.serialize(root, async () => {
      const existing = this.managed.get(root);
      if (!existing) return false;
      await existing.server.stop();
      this.managed.delete(root);
      return true;
    });
  }

  async stopAll() {
    await Promise.allSettled([...this.operations.values()]);
    const roots = [...this.managed.keys()];
    await Promise.allSettled(roots.map((root) => this.stop(root)));
  }

  private async serialize<T>(root: string, action: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(root) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    this.operations.set(root, current);
    try {
      return await current;
    } finally {
      if (this.operations.get(root) === current) this.operations.delete(root);
    }
  }
}
