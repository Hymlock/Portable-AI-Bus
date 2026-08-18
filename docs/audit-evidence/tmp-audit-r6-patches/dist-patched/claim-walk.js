"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.comparablePath = comparablePath;
exports.pathContains = pathContains;
exports.observedFilesystemIdentity = observedFilesystemIdentity;
exports.directoryContainsIdentities = directoryContainsIdentities;
exports.directoryContainsIdentitiesUnbounded = directoryContainsIdentitiesUnbounded;
exports.emptyWalkStats = emptyWalkStats;
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
const workspace_key_1 = require("./workspace-key");
function comparablePath(value) {
    const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}
function pathContains(parent, child) {
    const left = comparablePath(parent);
    const right = comparablePath(child);
    return left === right || right.startsWith(`${left}/`);
}
function observedFilesystemIdentity(candidate) {
    try {
        const observed = (0, node_fs_1.statSync)(candidate, { bigint: true });
        return (0, workspace_key_1.filesystemIdentityMaterial)(observed.dev, observed.ino);
    }
    catch {
        return undefined;
    }
}
function resolvedPath(candidate) {
    try {
        return (0, node_fs_1.realpathSync)(candidate);
    }
    catch {
        return undefined;
    }
}
function isLink(candidate) {
    try {
        return (0, node_fs_1.lstatSync)(candidate).isSymbolicLink();
    }
    catch {
        return false;
    }
}
function leavesClaimedTree(entryPath, stayUnder) {
    // Ordinary files and directories have a realpath inside the tree. A junction
    // or symlink whose realpath is outside is the item-14 escape. If realpath
    // cannot be resolved, treat a link as an escape and a non-link as stay-put
    // so a hardlink or ordinary file is still matched.
    const real = resolvedPath(entryPath);
    if (real)
        return !pathContains(stayUnder, real);
    return isLink(entryPath);
}
function walkForIdentities(parentDirectory, targets, options) {
    if (targets.size === 0)
        return false;
    try {
        if (!(0, node_fs_1.statSync)(parentDirectory).isDirectory())
            return false;
    }
    catch {
        return false;
    }
    const stayUnder = options.stayUnderRoot
        ? (resolvedPath(options.stayUnderRoot) ?? options.stayUnderRoot)
        : undefined;
    if (stayUnder) {
        const parentReal = resolvedPath(parentDirectory);
        if (parentReal && !pathContains(stayUnder, parentReal))
            return false;
    }
    const stats = options.stats;
    const pending = [parentDirectory];
    const visitedDirectories = new Set();
    while (pending.length > 0) {
        const directory = pending.pop();
        const directoryIdentity = observedFilesystemIdentity(directory);
        if (!directoryIdentity || visitedDirectories.has(directoryIdentity))
            continue;
        visitedDirectories.add(directoryIdentity);
        if (stats)
            stats.directoriesVisited += 1;
        let entries;
        try {
            entries = (0, node_fs_1.readdirSync)(directory, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (stats)
                stats.entriesSeen += 1;
            if (stayUnder && leavesClaimedTree(entryPath, stayUnder)) {
                if (stats)
                    stats.skippedEscapes += 1;
                continue;
            }
            const identity = observedFilesystemIdentity(entryPath);
            if (identity && targets.has(identity))
                return true;
            try {
                if ((0, node_fs_1.statSync)(entryPath).isDirectory())
                    pending.push(entryPath);
            }
            catch {
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
function directoryContainsIdentities(parentDirectory, targets, bound) {
    return walkForIdentities(parentDirectory, targets, bound);
}
/**
 * Historical unbounded walk. Follows every stat() directory, including
 * outbound junctions. Item 14 RED control — do not call from production.
 */
function directoryContainsIdentitiesUnbounded(parentDirectory, targets, stats) {
    return walkForIdentities(parentDirectory, targets, { stats });
}
function emptyWalkStats() {
    return { directoriesVisited: 0, entriesSeen: 0, skippedEscapes: 0 };
}
//# sourceMappingURL=claim-walk.js.map