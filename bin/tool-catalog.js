#!/usr/bin/env node
'use strict';

// Read-only discovery. Never installs software, launches programs, loads models,
// reads credentials, or treats finding an executable as a successful workflow.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJson(file, optional = false) {
  if (optional && !fs.existsSync(file)) return {};
  if (fs.statSync(file).size > 256 * 1024) throw new Error('Tool catalog configuration is too large.');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function commandPath(command, env) {
  const extensions = process.platform === 'win32'
    ? ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT;.PS1').split(';')]
    : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), command + extension);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
    }
  }
  return null;
}

function inventory(root, env = process.env) {
  const staged = path.join(__dirname, 'tool-catalog.defaults.json');
  const defaults = readJson(fs.existsSync(staged) ? staged : path.join(__dirname, '..', 'templates', 'tool-catalog.json'));
  const locations = readJson(path.join(root, '.ai-bus', 'tool-paths.json'), true);
  const verification = readJson(path.join(root, '.ai-bus', 'tool-verification.json'), true);
  const verificationFor = (id, detected) => {
    const record = verification.schemaVersion === 1 && verification.tools && verification.tools[id];
    if (!record || !['passed', 'partial', 'blocked'].includes(record.status) || typeof record.scope !== 'string') return null;
    let current = Array.isArray(record.anchors) && record.anchors.length > 0 && record.anchors.length <= 8;
    const identity = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
    if (current) current = record.anchors.some(anchor => typeof anchor.path === 'string' && detected.some(p => identity(p) === identity(anchor.path)));
    if (current) current = record.anchors.every((anchor) => {
      try {
        if (!path.isAbsolute(anchor.path) || !/^[a-f0-9]{64}$/.test(anchor.sha256)) return false;
        if (fs.statSync(anchor.path).size > 512 * 1024 * 1024) return false;
        return crypto.createHash('sha256').update(fs.readFileSync(anchor.path)).digest('hex') === anchor.sha256;
      } catch { return false; }
    });
    return { status: current ? record.status : 'stale', scope: record.scope,
      testedAt: record.testedAt || null, evidence: record.evidence || null };
  };
  for (const [name, value] of Object.entries(locations)) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`Tool location ${name} must be an absolute path.`);
  }
  const expand = (pattern) => {
    let missing = false;
    const value = pattern.replace(/\$\{([A-Za-z]+)\}/g, (_, name) => {
      if (!locations[name]) missing = true;
      return locations[name] || '';
    });
    return missing ? null : path.normalize(value);
  };
  return {
    schemaVersion: 1,
    policy: 'Choose by task quality, reliable LLM control and total cost. Installed is not automatically better. Detection is not execution verification. Candidates are not installation authorization.',
    tools: defaults.tools.map((tool) => {
      const detected = [];
      for (const command of tool.commands || []) {
        const found = commandPath(command, env);
        if (found) detected.push(found);
      }
      for (const pattern of tool.paths || []) {
        const candidate = expand(pattern);
        if (candidate && fs.existsSync(candidate)) detected.push(candidate);
      }
      const { commands, paths, ...description } = tool;
      const verified = verificationFor(tool.id, detected);
      return { ...description, detectedPaths: [...new Set(detected)],
        installation: tool.kind === 'instructions' ? 'reference' : detected.length ? 'detected' : 'not-detected',
        operationalVerification: verified ? verified.status : 'not-performed',
        ...(verified ? { verification: verified } : {}) };
    })
  };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--root') throw new Error('Usage: tool-catalog.js --root BUS_ROOT');
    console.log(JSON.stringify(inventory(path.resolve(args[1])), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { inventory, commandPath };
