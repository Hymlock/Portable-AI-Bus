const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('test watchdog terminates its process tree and removes manifest-scoped artifacts', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-timeout-'));
  const cleanupRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-vscode-watchdog-'));
  const credentialParent = path.join(os.homedir(), '.portable-ai-bus', 'credentials', randomBytes(12).toString('hex'));
  await fs.mkdir(credentialParent, { recursive: true });
  await fs.writeFile(path.join(cleanupRoot, 'marker'), 'fixture', 'utf8');
  await fs.writeFile(path.join(credentialParent, 'marker'), 'credential', 'utf8');
  const pidFile = path.join(root, 'grandchild.pid');
  let grandchildPid;
  t.after(async () => {
    if (grandchildPid && processAlive(grandchildPid)) killExactTree(grandchildPid);
    await fs.rm(cleanupRoot, { recursive: true, force: true });
    await fs.rm(credentialParent, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const wrapper = path.resolve(__dirname, '..', 'scripts', 'run-node-with-timeout.js');
  const fixture = path.resolve(__dirname, 'fixtures', 'timeout-tree.js');
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrapper, '300', fixture, pidFile, cleanupRoot, credentialParent], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 124);
  grandchildPid = Number(await fs.readFile(pidFile, 'utf8'));
  assert.equal(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, true);
  await eventually(() => !processAlive(grandchildPid));
  await assert.rejects(fs.access(cleanupRoot), { code: 'ENOENT' });
  await assert.rejects(fs.access(credentialParent), { code: 'ENOENT' });
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killExactTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function eventually(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('owned grandchild process remained alive after watchdog timeout');
}
