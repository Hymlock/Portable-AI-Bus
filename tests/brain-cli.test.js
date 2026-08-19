const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

require('./helpers/require-fresh-dist')();
const { loadBrain, latestTreeMtimeMs, recordLoadedCode } = require('../dist/brain/cli.js');

test('brain factory receives coordination root and repository workdir separately', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-brain-cli-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const modulePath = path.join(fixture, 'brain.cjs');
  await fs.writeFile(modulePath, [
    'module.exports = ({ root, workdir }) => ({',
    '  name: JSON.stringify({ root, workdir }),',
    '  async takeTurn() { return { done: true }; }',
    '});'
  ].join('\n'));
  const coordinationRoot = path.join(fixture, 'mailbox-root');
  const workdir = path.join(fixture, 'target-repo');
  const brain = await loadBrain(modulePath, 'codex', coordinationRoot, workdir);
  assert.deepEqual(JSON.parse(brain.name), { root: coordinationRoot, workdir });
});

test('a brain records the dist timestamp it loaded for stale-code detection', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'portable-ai-bus-code-version-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const distRoot = path.join(fixture, 'dist');
  await fs.mkdir(path.join(distRoot, 'brain'), { recursive: true });
  await fs.writeFile(path.join(distRoot, 'brain', 'cli.js'), 'old code');

  const expected = await latestTreeMtimeMs(distRoot);
  const marker = await recordLoadedCode(fixture, 'codex', distRoot);
  const recorded = JSON.parse(await fs.readFile(
    path.join(fixture, '.ai-bus', 'runtime', 'brain-codex.code.json'), 'utf8'));

  assert.equal(marker.loadedDistMtimeMs, expected);
  assert.equal(recorded.pid, process.pid);
  assert.equal(recorded.distRoot, distRoot);
});
