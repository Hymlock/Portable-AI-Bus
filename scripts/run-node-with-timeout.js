'use strict';

const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const timeoutMs = Number(process.argv[2]);
const script = process.argv[3];
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !script) {
  console.error('Usage: run-node-with-timeout.js TIMEOUT_MS SCRIPT [ARG ...]');
  process.exit(2);
}

const cleanupManifest = path.join(os.tmpdir(), `portable-ai-bus-watchdog-${process.pid}-${randomUUID()}.json`);
const child = spawn(process.execPath, [path.resolve(script), ...process.argv.slice(4)], {
  stdio: 'inherit',
  windowsHide: true,
  detached: process.platform !== 'win32',
  env: { ...process.env, PAB_WATCHDOG_CLEANUP_MANIFEST: cleanupManifest }
});
let timedOut = false;
let terminating = false;
let timeoutWork;

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Timed out after ${timeoutMs} ms; terminating owned test process tree ${child.pid}.`);
  timeoutWork = terminateTree(child.pid).then(() => cleanFromManifest(cleanupManifest));
}, timeoutMs);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void terminateTree(child.pid)
      .then(() => cleanFromManifest(cleanupManifest))
      .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

child.once('error', (error) => {
  clearTimeout(timer);
  console.error(error.stack || error);
  process.exitCode = 1;
});
child.once('exit', async (code, signal) => {
  clearTimeout(timer);
  try {
    if (timeoutWork) await timeoutWork;
    else await fs.rm(cleanupManifest, { force: true });
  } catch (error) {
    console.error(`Watchdog cleanup failed: ${error instanceof Error ? error.stack : error}`);
    process.exitCode = 125;
    return;
  }
  if (timedOut) process.exitCode = 124;
  else if (typeof code === 'number') process.exitCode = code;
  else process.exitCode = signal ? 1 : 0;
});

async function terminateTree(pid) {
  if (terminating || !pid) return;
  terminating = true;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {}
}

async function cleanFromManifest(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const temporaryBase = path.resolve(os.tmpdir());
  const fixtureRoot = path.resolve(manifest.fixtureRoot || '');
  const fixtureName = path.basename(fixtureRoot);
  if (path.dirname(fixtureRoot) !== temporaryBase || !/^portable-ai-bus-(?:vscode|vsix)-/.test(fixtureName)) {
    throw new Error(`Unsafe watchdog fixture target: ${fixtureRoot}`);
  }
  const credentialsBase = path.resolve(os.homedir(), '.portable-ai-bus', 'credentials');
  const credentialParents = Array.isArray(manifest.credentialParents) ? manifest.credentialParents : [];
  for (const candidate of credentialParents) {
    const target = path.resolve(candidate);
    if (path.dirname(target) !== credentialsBase || !/^[a-f0-9]{24}$/.test(path.basename(target))) {
      throw new Error(`Unsafe watchdog credential target: ${target}`);
    }
  }
  for (const candidate of credentialParents) {
    await fs.rm(path.resolve(candidate), { recursive: true, force: true });
  }
  await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await fs.rm(manifestPath, { force: true });
}
