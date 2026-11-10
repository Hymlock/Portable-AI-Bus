const assert = require('node:assert/strict');
const test = require('node:test');
require('./helpers/require-fresh-dist')();
const { HarnessManager } = require('../dist/harness-manager.js');

test('harness manager serializes concurrent starts and stops only owned instances', async () => {
  const calls = [];
  const servers = [];
  const manager = new HarnessManager((root) => {
    const server = {
      async start(port) {
        calls.push(`start:${root}:${port}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { host: '127.0.0.1', port: port || 40000, tokenPath: 'operator', seatTokenPaths: {} };
      },
      async stop() { calls.push(`stop:${root}`); }
    };
    servers.push(server);
    return server;
  });
  const [first, second] = await Promise.all([manager.start('workspace', 0), manager.start('workspace', 0)]);
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  assert.equal(servers.length, 1);
  assert.equal(manager.owns('workspace'), true);
  assert.deepEqual(calls, ['start:workspace:0']);
  assert.equal(await manager.stop('external-workspace'), false);
  assert.equal(await manager.stop('workspace'), true);
  assert.deepEqual(calls, ['start:workspace:0', 'stop:workspace']);
});

test('stopAll waits for in-flight startup and then cleans every owned server', async () => {
  let stopped = 0;
  const manager = new HarnessManager(() => ({
    async start() {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { host: '127.0.0.1', port: 40001, tokenPath: 'operator', seatTokenPaths: {} };
    },
    async stop() { stopped += 1; }
  }));
  const starting = manager.start('workspace', 0);
  await manager.stopAll();
  await starting;
  assert.equal(stopped, 1);
  assert.equal(manager.owns('workspace'), false);
});
