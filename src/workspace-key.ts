import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** Stable credential namespace for aliases that resolve to the same directory. */
export function credentialWorkspaceKey(root: string) {
  const canonical = realpathSync.native(path.resolve(root));
  const identity = statSync(canonical, { bigint: true });
  const material = filesystemIdentityMaterial(identity.dev, identity.ino);
  return createHash('sha256').update(material).digest('hex').slice(0, 24);
}

export function filesystemIdentityMaterial(device: bigint, inode: bigint) {
  if (inode === 0n) {
    throw new Error('Workspace filesystem does not expose a stable directory identity; refusing an ambiguous credential namespace.');
  }
  return `filesystem-v1:${device}:${inode}`;
}
