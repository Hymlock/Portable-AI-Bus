const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { inventory } = require('../bin/tool-catalog');
require('./helpers/require-fresh-dist')();
const { CapabilityRunner } = require('../dist/capabilities');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pab-tools-'));
  await fs.mkdir(path.join(root, '.ai-bus', 'bin'), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('discovery distinguishes an installed app from a folder of videos and from a working service', async (t) => {
  const root = await setup(t);
  const aiRoot = path.join(root, 'AI');
  await fs.mkdir(path.join(aiRoot, 'ComfyUI_windows_portable', 'ComfyUI'), { recursive: true });
  await fs.writeFile(path.join(aiRoot, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), 'not executed');
  await fs.mkdir(path.join(aiRoot, 'DaVinci Resolve', 'Videos'), { recursive: true });
  await fs.writeFile(path.join(root, '.ai-bus', 'tool-paths.json'), JSON.stringify({ aiRoot }));
  const report = inventory(root, { PATH: '' });
  const comfy = report.tools.find((tool) => tool.id === 'comfyui');
  assert.equal(comfy.installation, 'detected');
  assert.equal(comfy.operationalVerification, 'not-performed');
  assert.equal(report.tools.find((tool) => tool.id === 'davinci-resolve').installation, 'not-detected');
  assert.equal(report.tools.find((tool) => tool.id === 'hyperframes').installation, 'not-detected');
  assert.match(report.policy, /Installed is not automatically better/);
});

test('finding a command does not execute it or install a missing candidate', async (t) => {
  const root = await setup(t);
  const marker = path.join(root, 'must-not-exist');
  const command = path.join(root, 'hyperframes');
  await fs.writeFile(command, `touch '${marker}'`, { mode: 0o755 });
  const tool = inventory(root, { PATH: root }).tools.find((row) => row.id === 'hyperframes');
  assert.equal(tool.installation, 'detected');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(tool.operationalVerification, 'not-performed');
});

test('invalid machine-local locations fail rather than silently using a relative path', async (t) => {
  const root = await setup(t);
  await fs.writeFile(path.join(root, '.ai-bus', 'tool-paths.json'), JSON.stringify({ aiRoot: '../elsewhere' }));
  assert.throws(() => inventory(root, { PATH: '' }), /absolute path/);
});

test('the staged catalog runs through the real recorded capability interface', async (t) => {
  const root = await setup(t);
  const script = path.join(root, '.ai-bus', 'bin', 'tool-catalog.js');
  await fs.copyFile(path.join(__dirname, '..', 'bin', 'tool-catalog.js'), script);
  await fs.copyFile(path.join(__dirname, '..', 'templates', 'tool-catalog.json'), path.join(root, '.ai-bus', 'bin', 'tool-catalog.defaults.json'));
  await fs.writeFile(path.join(root, '.ai-bus', 'capabilities.json'), JSON.stringify({ version: 1, capabilities: [{
    id: 'tools.catalog', command: process.execPath, args: [script, '--root', root], cwd: root, allowedSeats: ['codex']
  }] }));
  const receipt = await new CapabilityRunner(root).run('tools.catalog', { seat: 'codex' });
  assert.equal(receipt.status, 'passed');
  const report = JSON.parse(receipt.stdout.tail);
  assert.ok(report.tools.some((tool) => tool.id === 'comfyui'));
  assert.match(report.policy, /not installation authorization/);
});

test('recorded verification is scoped and becomes stale when the tested tool changes', async (t) => {
  const root = await setup(t);
  const command = path.join(root, 'ffmpeg');
  await fs.writeFile(command, 'tested executable');
  const sha256 = crypto.createHash('sha256').update('tested executable').digest('hex');
  await fs.writeFile(path.join(root, '.ai-bus', 'tool-verification.json'), JSON.stringify({schemaVersion: 1, tools: {
    ffmpeg: {status: 'passed', scope: 'short video and audio export', anchors: [{path: command, sha256}]}
  }}));
  let tool = inventory(root, {PATH: root}).tools.find(x => x.id === 'ffmpeg');
  assert.equal(tool.operationalVerification, 'passed');
  assert.equal(tool.verification.scope, 'short video and audio export');
  await fs.writeFile(command, 'updated executable');
  tool = inventory(root, {PATH: root}).tools.find(x => x.id === 'ffmpeg');
  assert.equal(tool.operationalVerification, 'stale');
});
