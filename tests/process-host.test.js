const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const test = require('node:test');

const { runProcess, stripAnsi } = require('../dist/brain/process-host');

test('Windows process host preserves output after the ConPTY viewport scrolls', {
  skip: process.platform !== 'win32'
}, async () => {
  const expected = 'A'.repeat(5_000);
  const result = runWindowsProcessHostProbe("process.stdout.write('A'.repeat(5000))");

  assert.equal(result.code, 0);
  assert.equal(result.stdout, expected);
});

test('Windows process host preserves and parses single-line JSON larger than 64 KiB', {
  skip: process.platform !== 'win32'
}, async () => {
  const expected = JSON.stringify({ text: 'x'.repeat(70_000) });
  const result = runWindowsProcessHostProbe(
    "process.stdout.write(JSON.stringify({text:'x'.repeat(70000)}))"
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, expected);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(expected));
});

test('Windows process host uses headless ConPTY and strips terminal controls', async () => {
  let received;
  const fakePty = {
    spawn(command, args, options) {
      const request = JSON.parse(fs.readFileSync(args[2], 'utf8'));
      received = { command, args, options, request };
      let dataListener;
      let exitListener;
      queueMicrotask(() => {
        fs.writeFileSync(args[3], '{"result":"PONG"}\r\n');
        dataListener('\u001b[?9001h\u001b[?25h');
        exitListener({ exitCode: 0 });
      });
      return {
        onData(listener) { dataListener = listener; },
        onExit(listener) { exitListener = listener; },
        kill() { throw new Error('successful process must not be killed'); }
      };
    }
  };

  const result = await runProcess(process.execPath, ['-p', 'PONG'], {
    cwd: 'C:\\scratch',
    env: { TRACE: 'yes' },
    timeoutMs: 1_000
  }, { platform: 'win32', loadPty: () => fakePty });

  assert.deepEqual(result, { code: 0, stdout: '{"result":"PONG"}\r\n', stderr: '' });
  assert.equal(received.command, process.execPath, 'the capture wrapper remains in ConPTY');
  assert.equal(received.args[0], '-e');
  assert.equal(received.request.command, process.execPath);
  assert.deepEqual(received.request.args, ['-p', 'PONG']);
  assert.equal(received.options.useConpty, true);
  assert.equal(received.options.cwd, 'C:\\scratch');
  assert.equal(received.options.env.TRACE, 'yes');
});

test('Windows fails closed when ConPTY cannot load', async () => {
  let spawnCalled = false;
  const result = await runProcess('provider.exe', [], { timeoutMs: 1_000 }, {
    platform: 'win32',
    loadPty: () => { throw new Error('native addon mismatch'); },
    spawn: () => { spawnCalled = true; }
  });

  assert.equal(result.code, -1);
  assert.match(result.stderr, /ConPTY unavailable: native addon mismatch/);
  assert.equal(spawnCalled, false, 'must not silently fall back to a flashing Windows spawn');
});

test('non-Windows process host preserves stdout and stderr pipes', async () => {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => true;
  let received;

  const pending = runProcess('model', ['ask'], { timeoutMs: 1_000 }, {
    platform: 'linux',
    spawn(command, args, options) {
      received = { command, args, options };
      return child;
    }
  });
  queueMicrotask(() => {
    stdout.emit('data', 'answer');
    stderr.emit('data', 'diagnostic');
    child.emit('close', 7);
  });

  assert.deepEqual(await pending, { code: 7, stdout: 'answer', stderr: 'diagnostic' });
  assert.equal(received.options.shell, false);
  assert.deepEqual(received.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('ConPTY timeout kills the process and returns code 124', async () => {
  let killed = false;
  const result = await runProcess(process.execPath, [], { timeoutMs: 5 }, {
    platform: 'win32',
    loadPty: () => ({
      spawn(_command, args) {
        fs.writeFileSync(args[3], '\u001b[31mpartial\u001b[0m');
        return {
          onData() {},
          onExit() {},
          kill() { killed = true; }
        };
      }
    })
  });

  assert.equal(killed, true);
  assert.deepEqual(result, { code: 124, stdout: 'partial', stderr: 'Process timed out.' });
});

test('stripAnsi handles CSI and OSC commands emitted by ConPTY clients', () => {
  assert.equal(stripAnsi('\u001b[2Jbefore\u001b]0;title\u0007after\u001b[?25h'), 'beforeafter');
});

function runWindowsProcessHostProbe(providerScript) {
  const probe = `
    const { runProcess } = require('./dist/brain/process-host');
    runProcess(process.execPath, ['-e', ${JSON.stringify(providerScript)}], { timeoutMs: 10000 })
      .then((result) => {
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      });
  `;
  const completed = spawnSync(process.execPath, ['-e', probe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
  return JSON.parse(completed.stdout);
}
