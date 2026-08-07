'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const pidFile = process.argv[2];
const fixtureRoot = process.argv[3];
const credentialParent = process.argv[4];
const cleanupManifest = process.env.PAB_WATCHDOG_CLEANUP_MANIFEST;
if (!pidFile || !fixtureRoot || !credentialParent || !cleanupManifest) process.exit(2);
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio: 'ignore',
  windowsHide: true
});
fs.writeFileSync(pidFile, String(grandchild.pid), 'utf8');
fs.writeFileSync(cleanupManifest, JSON.stringify({ fixtureRoot, credentialParents: [credentialParent] }), 'utf8');
setInterval(() => {}, 1_000);
