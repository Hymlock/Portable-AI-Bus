import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { filesystemIdentityMaterial } from './workspace-key';

/**
 * Bound the overlap walk without deleting it.
 *
 * Item 14: directoryContainsClaim followed every stat() target, so a junction
 * out of a claimed tree made later overlap checks walk that volume. The walk
 * stays — it is what joins a parent path to a child inode under a third name.
 * The bound is stay-under-claimed-directory: do not descend through a
 * junction or symlink whose realpath leaves the directory being walked.
 */
export type ClaimWalkStats = {
  directoriesVisited: number;
  entriesSeen: number;
  skippedEscapes: number;
};

export type ClaimWalkBound = {
  /**
   * Directory the walk must stay under. Usually the claimed path's realpath.
   * Outbound junctions and symlinks whose realpath is outside this root are
   * neither descended into nor treated as containing the target identity.
   */
  stayUnderRoot: string;
  stats?: ClaimWalkStats;
};

export function comparablePath(value: string) {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

export function pathContains(parent: string, child: string) {
  const left = comparablePath(parent);
  const right = comparablePath(child);
  return left === right || right.startsWith(`${left}/`);
}

export function observedFilesystemIdentity(candidate: string) {
  try {
    const observed = statSync(candidate, { bigint: true });
    return filesystemIdentityMaterial(observed.dev, observed.ino);
  } catch {
    return undefined;
  }
}

function resolvedPath(candidate: string) {
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

function isLink(candidate: string) {
  try {
    return lstatSync(candidate).isSymbolicLink();
  } catch {
    return false;
  }
}

function leavesClaimedTree(entryPath: string, stayUnder: string) {
  // Ordinary files and directories have a realpath inside the tree. A junction
  // or symlink whose realpath is outside is the item-14 escape. If realpath
  // cannot be resolved, treat a link as an escape and a non-link as stay-put
  // so a hardlink or ordinary file is still matched.
  const real = resolvedPath(entryPath);
  if (real) return !pathContains(stayUnder, real);
  return isLink(entryPath);
}

function walkForIdentities(
  parentDirectory: string,
  targets: Set<string>,
  options: { stayUnderRoot?: string; stats?: ClaimWalkStats }
): boolean {
  if (targets.size === 0) return false;

  try {
    if (!statSync(parentDirectory).isDirectory()) return false;
  } catch {
    return false;
  }

  const stayUnder = options.stayUnderRoot
    ? (resolvedPath(options.stayUnderRoot) ?? options.stayUnderRoot)
    : undefined;
  if (stayUnder) {
    const parentReal = resolvedPath(parentDirectory);
    if (parentReal && !pathContains(stayUnder, parentReal)) return false;
  }

  const stats = options.stats;
  const pending = [parentDirectory];
  const visitedDirectories = new Set<string>();

  while (pending.length > 0) {
    const directory = pending.pop()!;
    const directoryIdentity = observedFilesystemIdentity(directory);
    if (!directoryIdentity || visitedDirectories.has(directoryIdentity)) continue;
    visitedDirectories.add(directoryIdentity);
    if (stats) stats.directoriesVisited += 1;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (stats) stats.entriesSeen += 1;

      if (stayUnder && leavesClaimedTree(entryPath, stayUnder)) {
        if (stats) stats.skippedEscapes += 1;
        continue;
      }

      const identity = observedFilesystemIdentity(entryPath);
      if (identity && targets.has(identity)) return true;

      try {
        if (statSync(entryPath).isDirectory()) pending.push(entryPath);
      } catch {
        // A disappearing or unreadable descendant cannot supply an observed identity.
      }
    }
  }

  return false;
}

/**
 * True when `parentDirectory` contains a descendant whose observed filesystem
 * identity is in `targets`. Follows directory links only while they stay under
 * `bound.stayUnderRoot`. Cycle-safe by directory inode.
 */
export function directoryContainsIdentities(
  parentDirectory: string,
  targets: Set<string>,
  bound: ClaimWalkBound
): boolean {
  return walkForIdentities(parentDirectory, targets, bound);
}

/**
 * Historical unbounded walk. Follows every stat() directory, including
 * outbound junctions. Item 14 RED control — do not call from production.
 */
export function directoryContainsIdentitiesUnbounded(
  parentDirectory: string,
  targets: Set<string>,
  stats?: ClaimWalkStats
): boolean {
  return walkForIdentities(parentDirectory, targets, { stats });
}

export function emptyWalkStats(): ClaimWalkStats {
  return { directoriesVisited: 0, entriesSeen: 0, skippedEscapes: 0 };
}
