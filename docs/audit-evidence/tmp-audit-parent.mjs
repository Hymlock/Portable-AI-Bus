import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MailboxStore } from './dist/mailbox.js';
import { PLAN_SCHEMA } from './dist/brain/brains/agent.js';

function junctionsAvailable(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-parent-'));
const store = new MailboxStore(root);
await store.ensureInitialized(['claude', 'grok', 'codex'], 500);
await fsp.mkdir(path.join(root, 'src'), { recursive: true });
await fsp.writeFile(path.join(root, 'src', 'bus.ts'), 'x');

const parent = path.dirname(root);
const above = path.join(root, 'above');
console.log('root=', root);
console.log('parent=', parent);
console.log('junction-ok=', process.platform === 'win32' && junctionsAvailable(above, parent));

try {
  const held = await store.claim({ agent: 'codex', paths: ['above'], why: 'parent of the claim root' });
  console.log('PARENT CLAIM ACCEPTED', JSON.stringify(held, null, 2));
  try {
    const other = await store.claim({ agent: 'grok', paths: ['src/bus.ts'], why: 'should still be free' });
    console.log('CHILD CLAIM ALSO ACCEPTED — parent did not lock the tree', JSON.stringify(other, null, 2));
  } catch (error) {
    console.log('CHILD CLAIM BLOCKED BY PARENT:', error.message);
  }
} catch (error) {
  console.log('PARENT CLAIM REFUSED:', error.message);
}

const props = PLAN_SCHEMA?.properties?.actions?.items?.properties ?? {};
console.log('PLAN_SCHEMA send-related keys:', Object.keys(props).sort().join(', '));
console.log('PLAN_SCHEMA has supersedes:', Object.prototype.hasOwnProperty.call(props, 'supersedes'));
console.log('PLAN_SCHEMA has supersedeReason:', Object.prototype.hasOwnProperty.call(props, 'supersedeReason'));

await fsp.rm(root, { recursive: true, force: true, maxRetries: 8 });
