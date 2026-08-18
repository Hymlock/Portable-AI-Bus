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
exports.credentialWorkspaceKey = credentialWorkspaceKey;
exports.filesystemIdentityMaterial = filesystemIdentityMaterial;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const path = __importStar(require("node:path"));
/** Stable credential namespace for aliases that resolve to the same directory. */
function credentialWorkspaceKey(root) {
    const canonical = node_fs_1.realpathSync.native(path.resolve(root));
    const identity = (0, node_fs_1.statSync)(canonical, { bigint: true });
    const material = filesystemIdentityMaterial(identity.dev, identity.ino);
    return (0, node_crypto_1.createHash)('sha256').update(material).digest('hex').slice(0, 24);
}
function filesystemIdentityMaterial(device, inode) {
    if (inode === 0n) {
        throw new Error('Workspace filesystem does not expose a stable directory identity; refusing an ambiguous credential namespace.');
    }
    return `filesystem-v1:${device}:${inode}`;
}
//# sourceMappingURL=workspace-key.js.map