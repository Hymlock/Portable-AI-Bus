const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createStallLedger } = require('../dist/brain/stall-ledger');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

test('Windows process host observes a real no-output child exit promptly', {
  skip: process.platform !== 'win32'
}, () => {
  const { result, elapsedMs } = runWindowsProcessHostTimedProbe('process.exit(23)', 10_000);

  assert.ok(elapsedMs < 2_000, 'child exit must not wait for the ten-second backstop');
  assert.equal(result.code, 23);
  assert.match(result.stderr, /exited with code 23/);
});

test('Windows process host does not reap a real running child before it exits', {
  skip: process.platform !== 'win32'
}, () => {
  const { result, elapsedMs } = runWindowsProcessHostTimedProbe('setTimeout(() => {}, 250)', 5_000);

  assert.ok(elapsedMs >= 150, 'live child must be allowed to keep running');
  assert.equal(result.code, 0);
});

test('Windows process host launches a non-EXE command wrapper', {
  skip: process.platform !== 'win32'
}, () => {
  const probe = `
    const { runProcess } = require('./dist/brain/process-host');
    runProcess('npm', ['--version'], { timeoutMs: 10_000 })
      .then((result) => {
        process.stdout.write(JSON.stringify(result));
        process.exit(0);
      });
  `;
  const completed = spawnSync(process.execPath, ['-e', probe], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true
  });
  assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
  const result = JSON.parse(completed.stdout);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\d+\.\d+\.\d+/);
});

test('Windows process host round-trips quoted JSON through a command wrapper', {
  skip: process.platform !== 'win32'
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-cmd-wrapper-'));
  const fixture = path.join(root, 'wrapper fixture');
  fs.mkdirSync(fixture);
  const wrapper = path.join(fixture, 'capture.cmd');
  const capture = path.join(fixture, 'capture.js');
  const schema = JSON.stringify({
    type: 'object',
    properties: { done: { type: 'boolean' } },
    required: ['done']
  });
  fs.writeFileSync(capture, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(wrapper, `@"${process.execPath}" "${capture}" %*\r\n`);

  try {
    const probe = `
      const { runProcess } = require('./dist/brain/process-host');
      runProcess(${JSON.stringify(wrapper)}, ${JSON.stringify([
        '--json-schema', schema, '-p', 'Set done true.'
      ])}, { timeoutMs: 10_000 })
        .then((result) => {
          process.stdout.write(JSON.stringify(result));
          process.exit(0);
        });
    `;
    const completed = spawnSync(process.execPath, ['-e', probe], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true
    });
    assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
    const result = JSON.parse(completed.stdout);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), [
      '--json-schema', schema, '-p', 'Set done true.'
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
        fs.writeFileSync(args[4], JSON.stringify({ code: 0 }));
        dataListener('\u001b[?9001h\u001b[?25h');
        exitListener({ exitCode: 0 });
      });
      return {
        onData(listener) { dataListener = listener; },
        onExit(listener) { exitListener = listener; },
        kill() {
          if (!received) throw new Error('successful process must not be killed before spawn returns');
        }
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
  assert.equal(result.failureKind, 'broken', 'callers must see BROKEN, not a generic exit');
  assert.equal(spawnCalled, false, 'must not silently fall back to a flashing Windows spawn');
});

test('ITEM 11: missing node-pty is a broken ConPTY load, not a spent provider', async () => {
  const result = await runProcess('provider.exe', [], { timeoutMs: 1_000 }, {
    platform: 'win32',
    loadPty: () => { throw new Error("Cannot find module 'node-pty'"); }
  });
  assert.equal(result.code, -1);
  assert.equal(result.failureKind, 'broken');
  assert.match(result.stderr, /ConPTY unavailable: Cannot find module 'node-pty'/);
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
  assert.deepEqual(result, {
    code: 124,
    stdout: 'partial',
    stderr: 'Process timed out while the child was still running.'
  });
});

test('ConPTY observes an exited provider promptly when node-pty loses its exit event', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, [], { timeoutMs: 2_000 }, {
    platform: 'win32',
    loadPty: () => ({
      spawn(_command, args) {
        setTimeout(() => {
          fs.closeSync(fs.openSync(args[3], 'w'));
          fs.writeFileSync(args[4], JSON.stringify({ code: 23 }));
        }, 10);
        return {
          onData() {},
          onExit() {}, // Simulate node-pty losing the notification from its console agent.
          kill() { /* HPCON close after we already observed completion */ }
        };
      }
    })
  });

  assert.ok(Date.now() - started < 500, 'dead provider should resolve before the backstop');
  assert.deepEqual(result, {
    code: 23,
    stdout: '',
    stderr: 'Provider process exited with code 23.'
  });
});

test('ConPTY does not reap a genuinely running provider early', async () => {
  let killed = false;
  const started = Date.now();
  const result = await runProcess(process.execPath, [], { timeoutMs: 120 }, {
    platform: 'win32',
    loadPty: () => ({
      spawn() {
        return {
          pid: 4242,
          onData() {},
          onExit() {},
          kill() { killed = true; }
        };
      }
    }),
    isProcessAlive: () => true
  });

  assert.ok(Date.now() - started >= 100, 'running provider must remain alive until the backstop');
  assert.equal(killed, true);
  assert.equal(result.code, 124);
  assert.equal(result.stderr, 'Process timed out while the child was still running.');
});

test('ConPTY reports a dead host separately from a live-child timeout', async () => {
  const result = await runProcess(process.execPath, [], { timeoutMs: 2_000 }, {
    platform: 'win32',
    loadPty: () => ({
      spawn() {
        return {
          pid: 4242,
          onData() {},
          onExit() {},
          kill() { /* leftover HPCON still needs ClosePseudoConsole */ }
        };
      }
    }),
    isProcessAlive: () => false
  });

  assert.deepEqual(result, {
    code: -1,
    stdout: '',
    stderr: 'ConPTY host died before reporting provider exit.'
  });
});

test('stripAnsi handles CSI and OSC commands emitted by ConPTY clients', () => {
  assert.equal(stripAnsi('\u001b[2Jbefore\u001b]0;title\u0007after\u001b[?25h'), 'beforeafter');
});

function tmpStallFile(seat) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-ai-bus-spawn-stall-'));
  return {
    dir,
    filePath: path.join(dir, `${seat}.json`),
    dispose() { fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

// Item 12 remainder: a spawn that never returns is invisible because watchProcessStall
// and timeoutMs are armed only AFTER pty.spawn returns. node-pty's Windows constructor
// blocks in ConnectNamedPipe before CreateProcess. A timer on the blocked loop cannot
// fire. The RED is a sibling process: parent sees open=0 while the child is still
// stuck inside spawn.
test('ITEM 12 RED: a spawn that never returns writes nothing the parent can read', async () => {
  const tmp = tmpStallFile('grok');
  const probe = `
    const { runProcess } = require(${JSON.stringify(path.join(process.cwd(), 'dist', 'brain', 'process-host.js'))});
    const { createStallLedger } = require(${JSON.stringify(path.join(process.cwd(), 'dist', 'brain', 'stall-ledger.js'))});
    const ledger = createStallLedger({ seat: 'grok', filePath: ${JSON.stringify(tmp.filePath)} });
    runProcess(process.execPath, ['-e', 'process.exit(0)'], {
      timeoutMs: 30_000,
      stallMs: 30_000,
      spawnStallMs: 80,
      stallLedger: ledger,
      stallSeat: 'grok'
    }, {
      platform: 'win32',
      loadPty: () => ({
        spawn() {
          while (true) { /* ConnectNamedPipe never returns */ }
        }
      })
    });
  `;
  const child = spawn(process.execPath, ['-e', probe], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    const deadline = Date.now() + 2_000;
    let snap = { started: 0, open: [] };
    while (Date.now() < deadline) {
      if (fs.existsSync(tmp.filePath)) {
        snap = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
        if (snap.open && snap.open.length > 0) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(snap.open.length >= 1, 'a sibling watchdog must record the blocked spawn; the parent loop cannot');
    assert.equal(snap.open[0].source, 'process-host');
    assert.equal(snap.resolved, 0);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    tmp.dispose();
  }
});

test('ITEM 12 GREEN: a fast ConPTY call still writes no stall edges', async () => {
  const tmp = tmpStallFile('grok');
  const ledger = createStallLedger({ seat: 'grok', filePath: tmp.filePath });
  let cleaned = false;
  let exited = false;
  const result = await runProcess(process.execPath, ['-p', 'PONG'], {
    timeoutMs: 1_000,
    stallMs: 30_000,
    spawnStallMs: 80,
    stallLedger: ledger,
    stallSeat: 'grok'
  }, {
    platform: 'win32',
    loadPty: () => ({
      spawn(_command, args) {
        let exitListener;
        queueMicrotask(() => {
          fs.writeFileSync(args[3], 'ok');
          fs.writeFileSync(args[4], JSON.stringify({ code: 0 }));
          exited = true;
          exitListener({ exitCode: 0 });
        });
        return {
          onData() {},
          onExit(listener) { exitListener = listener; },
          kill() {
            if (!exited) throw new Error('successful process must not be killed before it exits');
            cleaned = true;
          }
        };
      }
    })
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(cleaned, true, 'success path must close the HPCON (PtyKill / ClosePseudoConsole)');
  const done = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  assert.equal(done.started, 0, 'a fast call must not invent a stall');
  assert.equal(done.resolved, 0);
  assert.equal(done.open.length, 0);
  tmp.dispose();
});

function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* Codex's 20-40ms synchronous spawn */ }
}

function fakeReturningPty(spawnMs) {
  return {
    spawn(_command, args) {
      busyWait(spawnMs);
      let exitListener;
      queueMicrotask(() => {
        fs.writeFileSync(args[3], 'ok');
        fs.writeFileSync(args[4], JSON.stringify({ code: 0 }));
        exitListener({ exitCode: 0 });
      });
      return {
        onData() {},
        onExit(listener) { exitListener = listener; },
        kill() {}
      };
    }
  };
}

// Codex #1728: 120 returning calls, spawn 20-40ms, spawnStallMs=30, ledger stayed 0/0/0.
// Sibling starts late, its local timer is still waiting, parent writes the marker
// and kills the sibling. A real parent-clock breach is invisible.
test('ITEM 12 RED: late sibling plus returning breach writes nothing on sibling-local clock', async () => {
  const tmp = tmpStallFile('grok');
  const result = await runProcess(process.execPath, ['-p', 'PONG'], {
    timeoutMs: 1_000,
    stallMs: 30_000,
    spawnStallMs: 30,
    stallLedger: createStallLedger({ seat: 'grok', filePath: tmp.filePath }),
    stallSeat: 'grok'
  }, {
    platform: 'win32',
    loadPty: () => fakeReturningPty(40),
    watchdogStartupDelayMs: 50
  });
  assert.equal(result.code, 0, result.stderr);
  const snap = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
  tmp.dispose();
  assert.ok(
    snap.started >= 1,
    `Codex false-negative: spawn 40ms > spawnStallMs 30, late sibling, ledger started=${snap.started} resolved=${snap.resolved} open=${snap.open.length}`
  );
  assert.equal(snap.open.length, 0, 'a returning call must resolve the backfilled row');
});

test('ITEM 12: delayed sibling still records a never-returning spawn', async () => {
  const tmp = tmpStallFile('grok');
  const probe = `
    const { runProcess } = require(${JSON.stringify(path.join(process.cwd(), 'dist', 'brain', 'process-host.js'))});
    const { createStallLedger } = require(${JSON.stringify(path.join(process.cwd(), 'dist', 'brain', 'stall-ledger.js'))});
    const ledger = createStallLedger({ seat: 'grok', filePath: ${JSON.stringify(tmp.filePath)} });
    runProcess(process.execPath, ['-e', 'process.exit(0)'], {
      timeoutMs: 30_000,
      stallMs: 30_000,
      spawnStallMs: 30,
      stallLedger: ledger,
      stallSeat: 'grok'
    }, {
      platform: 'win32',
      watchdogStartupDelayMs: 40,
      loadPty: () => ({ spawn() { while (true) { /* ConnectNamedPipe never returns */ } } })
    });
  `;
  const child = spawn(process.execPath, ['-e', probe], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    const deadline = Date.now() + 2_000;
    let snap = { started: 0, open: [] };
    while (Date.now() < deadline) {
      if (fs.existsSync(tmp.filePath)) {
        snap = JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'));
        if (snap.open && snap.open.length > 0) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(snap.open.length >= 1, 'parent-clock remaining must write even when the sibling starts late');
    assert.equal(snap.open[0].source, 'process-host');
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    tmp.dispose();
  }
});

// Sibling death is fail-open for a never-returning spawn: the parent is blocked
// inside pty.spawn, so it cannot backfill. Say so rather than pretend.
test('ITEM 12: sibling death is fail-open while spawn never returns', async () => {
  const tmp = tmpStallFile('grok');
  const probe = `
    const { runProcess } = require(${JSON.stringify(path.join(process.cwd(), 'dist', 'brain', 'process-host.js'))});
    const { createStallLedger } = require(${JSON.stringify(path.join(process.cwd(), 'dist', 'brain', 'stall-ledger.js'))});
    const ledger = createStallLedger({ seat: 'grok', filePath: ${JSON.stringify(tmp.filePath)} });
    runProcess(process.execPath, ['-e', 'process.exit(0)'], {
      timeoutMs: 30_000,
      stallMs: 30_000,
      spawnStallMs: 30,
      stallLedger: ledger,
      stallSeat: 'grok'
    }, {
      platform: 'win32',
      watchdogDieImmediately: true,
      loadPty: () => ({ spawn() { while (true) { /* parent blocked, sibling already dead */ } } })
    });
  `;
  const child = spawn(process.execPath, ['-e', probe], {
    cwd: process.cwd(),
    stdio: 'ignore',
    windowsHide: true
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const snap = fs.existsSync(tmp.filePath)
      ? JSON.parse(fs.readFileSync(tmp.filePath, 'utf8'))
      : { started: 0, open: [] };
    assert.equal(snap.started, 0, 'dead sibling + blocked parent cannot write; fail-open');
    assert.equal(snap.open.length, 0);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    tmp.dispose();
  }
});

test('ITEM 12: success-path cleanup runs after exit, not instead of waiting for it', async () => {
  let cleaned = false;
  let exited = false;
  const result = await runProcess(process.execPath, ['-p', 'PONG'], {
    timeoutMs: 1_000
  }, {
    platform: 'win32',
    loadPty: () => ({
      spawn(_command, args) {
        let exitListener;
        queueMicrotask(() => {
          fs.writeFileSync(args[3], '{"result":"PONG"}\r\n');
          fs.writeFileSync(args[4], JSON.stringify({ code: 0 }));
          exited = true;
          exitListener({ exitCode: 0 });
        });
        return {
          onData() {},
          onExit(listener) { exitListener = listener; },
          kill() {
            if (!exited) throw new Error('successful process must not be killed before it exits');
            cleaned = true;
          }
        };
      }
    })
  });
  assert.equal(result.code, 0);
  assert.equal(cleaned, true, 'ClosePseudoConsole must run on the success path');
});

function runWindowsProcessHostProbe(providerScript) {
  return runWindowsProcessHostTimedProbe(providerScript, 10_000).result;
}

function runWindowsProcessHostTimedProbe(providerScript, timeoutMs) {
  const probe = `
    const { runProcess } = require('./dist/brain/process-host');
    const started = Date.now();
    runProcess(process.execPath, ['-e', ${JSON.stringify(providerScript)}], { timeoutMs: ${timeoutMs} })
      .then((result) => {
        process.stdout.write(JSON.stringify({ result, elapsedMs: Date.now() - started }));
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
