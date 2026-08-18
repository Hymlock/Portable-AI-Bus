#!/usr/bin/env node
/**
 * Check what you are about to commit against your claims.
 *
 * DROP-IN PATCH for scripts/claim-guard-cli.js (item 15 holes 1-4 + noCheck).
 * Tested by tmp-audit-r6-grok.cjs. Do not treat this file as the live hook.
 *
 *   tsc may see the materialised index and the declared node_modules junction.
 *   Nothing else. Unverifiable refuses.
 *
 * Exit 0 clean, 1 refused, 2 misuse.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { guardStagedPaths, formatGuardResult } = require(path.join(__dirname, '..', 'dist', 'claim-guard.js'));

function option(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const seat = option('--seat', process.env.BUS_SEAT);
const root = option('--root', process.env.BUS_ROOT);
const repo = option('--repo', process.cwd());

if (!seat || !root) {
  console.error('usage: claim-guard-cli --root <bus root> --seat <seat> [--repo <git repo>] [--install-hook]');
  console.error('  or set BUS_SEAT and BUS_ROOT');
  process.exit(2);
}

if (process.argv.includes('--install-hook')) {
  const hooksDir = path.join(repo, '.git', 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hook = path.join(hooksDir, 'pre-commit');
  const body = [
    '#!/bin/sh',
    '# Installed by Portable AI Bus. Refuses a commit containing another seat\'s files.',
    '# BUS_SEAT names the assignment used for this commit. It must be supplied by the caller.',
    `BUS_ROOT="${root}" node "${path.join(__dirname, 'claim-guard-cli.js').replace(/\\/g, '/')}" --repo "$(pwd)" || exit 1`,
    ''
  ].join('\n');
  fs.writeFileSync(hook, body, { mode: 0o755 });
  console.log('claim-guard: pre-commit hook installed (set BUS_SEAT to the active assignment)');
  console.log(`             ${hook}`);
  process.exit(0);
}

let staged = [];
try {
  staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: repo, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean);
} catch (error) {
  console.error(`claim-guard: could not read the index: ${error.message}`);
  process.exit(2);
}

if (staged.length === 0) {
  console.log('claim-guard: nothing staged');
  process.exit(0);
}

let claims;
try {
  const statePath = path.join(root, '.ai-bus', 'runtime', 'mailbox', 'state.json');
  claims = JSON.parse(fs.readFileSync(statePath, 'utf8')).claims ?? {};
} catch {
  console.log('claim-guard: no mailbox state found; claim check skipped (not a shared worktree)');
}

if (claims !== undefined) {
  const result = guardStagedPaths(seat, staged, claims);
  console.log(formatGuardResult(seat, result));
  if (!result.ok) process.exit(1);
}

if (process.env.BUS_ALLOW_BROKEN_BUILD === '1') {
  console.log('claim-guard: BUS_ALLOW_BROKEN_BUILD=1 - compile check SKIPPED for this commit');
  console.log('             deliberate WIP. Say so in the commit message.');
  process.exit(0);
}

function refuse(reason, remedy) {
  console.error(`claim-guard: REFUSING - ${reason}\n`);
  if (remedy) console.error(`${remedy}\n`);
  console.error('This check verifies the INDEX - what this commit would actually contain.');
  console.error('If you mean to commit anyway, do it deliberately with BUS_ALLOW_BROKEN_BUILD=1');
  console.error('and say so in the message.');
  process.exit(1);
}

let scratch;
try {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-guard-index-'));
  execFileSync('git', ['checkout-index', '--all', '--prefix', `${scratch.replace(/\\/g, '/')}/`], {
    cwd: repo, encoding: 'utf8', stdio: 'pipe'
  });
} catch (error) {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  refuse(
    `the index could not be materialised (${error.message.split('\n')[0]})`,
    'Without the staged tree there is nothing to verify.'
  );
}

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) { if (ch === '\n') { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i += 1; } continue; }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function comparable(value) {
  const normalized = path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function pathContains(parent, child) {
  const left = comparable(parent);
  const right = comparable(child);
  return left === right || right.startsWith(`${left}/`);
}

function withinScratch(target, scratchRoot) {
  const rel = path.relative(scratchRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realpathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}

/**
 * The declared node_modules junction exists so tsc can resolve types.
 * It is not a permit to compile worktree sources under another name.
 * A path is allowed only if its real location is inside the scratch tree
 * or inside the real repo node_modules.
 */
function compilerMaySee(target, scratchRoot, repoModulesReal) {
  const real = realpathOrSelf(target);
  if (withinScratch(real, scratchRoot)) return true;
  if (repoModulesReal && pathContains(repoModulesReal, real)) return true;
  if (!fs.existsSync(target) && withinScratch(target, scratchRoot)) return true;
  return false;
}

function resolveExtendsEntry(entry, fromDir, scratchRoot) {
  if (typeof entry !== 'string' || entry.length === 0) return null;
  if (entry.startsWith('.') || path.isAbsolute(entry)) {
    return path.resolve(fromDir, entry.endsWith('.json') ? entry : `${entry}.json`);
  }
  const slash = entry.replace(/\\/g, '/');
  const scoped = slash.startsWith('@');
  const segs = slash.split('/');
  const pkgName = scoped ? segs.slice(0, 2).join('/') : segs[0];
  const sub = scoped ? segs.slice(2).join('/') : segs.slice(1).join('/');
  const pkgDir = path.join(scratchRoot, 'node_modules', pkgName);
  if (sub) {
    const asWritten = path.join(pkgDir, sub);
    const asJson = sub.endsWith('.json') ? asWritten : `${asWritten}.json`;
    if (fs.existsSync(asWritten)) return asWritten;
    return asJson;
  }
  const tsconfig = path.join(pkgDir, 'tsconfig.json');
  if (fs.existsSync(tsconfig)) return tsconfig;
  try {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    if (typeof pkgJson.tsconfig === 'string' && pkgJson.tsconfig.length > 0) {
      return path.resolve(pkgDir, pkgJson.tsconfig);
    }
  } catch {
    // missing or unreadable package.json: fall through
  }
  return tsconfig;
}

function decodeConfigText(buf) {
  // tsc reads tsconfig the way an editor does: UTF-8, UTF-16 LE, UTF-16 BE,
  // with or without a BOM. JSON.parse only accepts UTF-8 and rejects a BOM.
  // r17 leftover: UTF-8 BOM + noCheck compiled a type error.
  // r17b leftover: UTF-16 LE/BE + noCheck compiled a type error. Same class.
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  const text = buf.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readConfig(configPath) {
  try {
    const text = decodeConfigText(fs.readFileSync(configPath));
    return JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
}

function findConfigEscapes(configPath, scratchRoot, repoModulesReal, seen = new Set()) {
  const escapes = [];
  const resolved = path.resolve(configPath);
  if (seen.has(resolved)) return escapes;
  seen.add(resolved);

  const config = readConfig(resolved);
  if (!config) return escapes;
  const base = path.dirname(resolved);
  const check = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) return;
    const literal = value.split(/[*?]/)[0];
    const target = path.resolve(base, literal);
    if (!compilerMaySee(target, scratchRoot, repoModulesReal)) escapes.push(`${label}: ${value}`);
  };

  for (const key of ['include', 'files', 'exclude']) {
    for (const entry of Array.isArray(config[key]) ? config[key] : []) check(entry, key);
  }
  for (const reference of Array.isArray(config.references) ? config.references : []) {
    check(reference?.path, 'references');
  }
  const options = config.compilerOptions ?? {};
  for (const key of ['baseUrl', 'rootDir', 'outDir', 'declarationDir', 'tsBuildInfoFile', 'outFile', 'mapRoot', 'sourceRoot']) {
    check(options[key], `compilerOptions.${key}`);
  }
  for (const entry of Array.isArray(options.rootDirs) ? options.rootDirs : []) check(entry, 'compilerOptions.rootDirs');
  for (const entry of Array.isArray(options.typeRoots) ? options.typeRoots : []) check(entry, 'compilerOptions.typeRoots');
  for (const [alias, targets] of Object.entries(options.paths ?? {})) {
    for (const entry of Array.isArray(targets) ? targets : []) check(entry, `compilerOptions.paths["${alias}"]`);
  }
  // compilerOptions.types names packages, not paths. After resolve, the
  // realpath must stay in scratch or the declared node_modules.
  for (const entry of Array.isArray(options.types) ? options.types : []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    const resolved = resolveTypesPackage(entry, scratchRoot);
    if (resolved && !compilerMaySee(resolved, scratchRoot, repoModulesReal)) {
      escapes.push(`compilerOptions.types: ${entry}`);
    }
  }
  if (typeof options.jsxImportSource === 'string' && options.jsxImportSource.length > 0) {
    const resolved = resolveModuleSpecifier(options.jsxImportSource, scratchRoot, scratchRoot);
    if (resolved && !compilerMaySee(resolved, scratchRoot, repoModulesReal)) {
      escapes.push(`compilerOptions.jsxImportSource: ${options.jsxImportSource}`);
    }
  }

  const extend = config.extends;
  for (const entry of Array.isArray(extend) ? extend : extend === undefined ? [] : [extend]) {
    if (typeof entry !== 'string') continue;
    const target = resolveExtendsEntry(entry, base, scratchRoot);
    if (!target) continue;
    if (!fs.existsSync(target)) {
      escapes.push(`extends (missing from the index): ${entry}`);
      continue;
    }
    if (!compilerMaySee(target, scratchRoot, repoModulesReal)) {
      escapes.push(`extends: ${entry}`);
      continue;
    }
    escapes.push(...findConfigEscapes(target, scratchRoot, repoModulesReal, seen));
  }
  return escapes;
}

function configSetsNoCheck(configPath, scratchRoot, seen = new Set()) {
  const resolved = path.resolve(configPath);
  if (seen.has(resolved)) return false;
  seen.add(resolved);
  const config = readConfig(resolved);
  if (!config) return false;
  if (config.compilerOptions?.noCheck === true) return true;
  const extend = config.extends;
  for (const entry of Array.isArray(extend) ? extend : extend === undefined ? [] : [extend]) {
    if (typeof entry !== 'string') continue;
    const target = resolveExtendsEntry(entry, path.dirname(resolved), scratchRoot);
    if (target && fs.existsSync(target) && configSetsNoCheck(target, scratchRoot, seen)) return true;
  }
  return false;
}

const TRIPLE_SLASH_PATH = /\/\/\/\s*<reference\b[^>]*\bpath\s*=\s*["']([^"']+)["']/;
const TRIPLE_SLASH_TYPES = /\/\/\/\s*<reference\b[^>]*\btypes\s*=\s*["']([^"']+)["']/;

function isTypeScriptSource(name) {
  return name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.cts') || name.endsWith('.mts');
}

function isOwnProgramSource(file) {
  const name = String(file).replace(/\\/g, '/');
  if (name.endsWith('.d.ts')) return false;
  return /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs)$/i.test(name);
}

/**
 * compilerOptions.noCheck spelled in the source. TypeScript honours a
 * leading // @ts-nocheck (after shebang / comment banner). One file with
 * it is the exclude-NOTE case. Every own program source with it is an
 * unchecked success — same class as noCheck, should-refuse.
 */
function leadingTsNocheck(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/).slice(0, 30)) {
    const t = line.trim();
    if (t === '' || t.startsWith('#!')) continue;
    if (/^\/\/\s*@ts-nocheck\b/.test(t) || /^\/\*\s*@ts-nocheck\b/.test(t)) return true;
    if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    return false;
  }
  return false;
}

function isWalkedSource(name) {
  return isTypeScriptSource(name)
    || name.endsWith('.js') || name.endsWith('.jsx')
    || name.endsWith('.cjs') || name.endsWith('.mjs');
}

function isPathSpecifier(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
}

function resolveTypesPackage(name, scratchRoot) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const slash = name.replace(/\\/g, '/');
  const scoped = slash.startsWith('@');
  const segs = slash.split('/');
  const pkgName = scoped ? segs.slice(0, 2).join('/') : segs[0];
  const atTypes = path.join(scratchRoot, 'node_modules', '@types', scoped ? segs[1] || pkgName : pkgName);
  const pkgDir = path.join(scratchRoot, 'node_modules', pkgName);
  if (fs.existsSync(atTypes)) return atTypes;
  if (fs.existsSync(pkgDir)) return pkgDir;
  return atTypes;
}

function resolveModuleSpecifier(spec, fromDir, scratchRoot) {
  if (typeof spec !== 'string' || spec.length === 0) return null;
  if (isPathSpecifier(spec)) return path.resolve(fromDir, spec);
  const slash = spec.replace(/\\/g, '/');
  const scoped = slash.startsWith('@');
  const segs = slash.split('/');
  const pkgName = scoped ? segs.slice(0, 2).join('/') : segs[0];
  const pkgDir = path.join(scratchRoot, 'node_modules', pkgName);
  const typesDir = path.join(scratchRoot, 'node_modules', '@types', scoped ? segs[1] || pkgName : pkgName);
  if (fs.existsSync(pkgDir)) return pkgDir;
  if (fs.existsSync(typesDir)) return typesDir;
  return pkgDir;
}

/**
 * Default typeRoots is node_modules/@types. The walker only saw an
 * explicit typeRoots key. A junction under @types onto the worktree is
 * hole 2 spelled as the default.
 */
function findImplicitTypeRootEscapes(scratchRoot, repoModulesReal) {
  const escapes = [];
  const atTypes = path.join(scratchRoot, 'node_modules', '@types');
  let entries;
  try {
    entries = fs.readdirSync(atTypes, { withFileTypes: true });
  } catch {
    return escapes;
  }
  for (const ent of entries) {
    const full = path.join(atTypes, ent.name);
    if (!compilerMaySee(full, scratchRoot, repoModulesReal)) {
      escapes.push(`typeRoots (default @types): ${ent.name}`);
    }
  }
  return escapes;
}

function findSourceEscapes(scratchRoot, repoModulesReal) {
  const escapes = [];
  const relOf = (full) => path.relative(scratchRoot, full).replace(/\\/g, '/');
  const checkTarget = (target, label) => {
    if (!compilerMaySee(target, scratchRoot, repoModulesReal)) escapes.push(label);
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git') continue;
      const full = path.join(dir, ent.name);
      let lst;
      try {
        lst = fs.lstatSync(full);
      } catch {
        continue;
      }
      // File symlink, directory symlink, or junction: realpath must stay in scratch
      // (or the declared node_modules). Do not walk an outbound reparse.
      if (lst.isSymbolicLink() || (lst.isDirectory() && !compilerMaySee(full, scratchRoot, repoModulesReal))) {
        if (!compilerMaySee(full, scratchRoot, repoModulesReal)) {
          escapes.push(`staged symlink: ${relOf(full)}`);
          continue;
        }
      }
      if (lst.isDirectory() && !lst.isSymbolicLink()) {
        walk(full);
        continue;
      }
      if (lst.isDirectory()) continue;
      if (!isWalkedSource(ent.name)) continue;
      let text;
      try {
        text = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split(/\r?\n/)) {
        const pathRef = line.match(TRIPLE_SLASH_PATH);
        if (pathRef) {
          checkTarget(
            path.resolve(path.dirname(full), pathRef[1]),
            `/// <reference path> in ${relOf(full)}: ${pathRef[1]}`
          );
        }
        const typesRef = line.match(TRIPLE_SLASH_TYPES);
        if (typesRef) {
          const resolved = resolveTypesPackage(typesRef[1], scratchRoot);
          if (resolved) checkTarget(resolved, `/// <reference types> in ${relOf(full)}: ${typesRef[1]}`);
        }
        const specs = [];
        const fromMatch = line.match(/\bfrom\s+['"]([^'"]+)['"]/);
        const importMatch = line.match(/\bimport\s+['"]([^'"]+)['"]/);
        const dynMatch = line.match(/\bimport\s*\(\s*['"]([^'"]+)['"]/);
        const reqMatch = line.match(/\brequire\s*\(\s*['"]([^'"]+)['"]/);
        if (fromMatch) specs.push(fromMatch[1]);
        if (importMatch) specs.push(importMatch[1]);
        if (dynMatch) specs.push(dynMatch[1]);
        if (reqMatch) specs.push(reqMatch[1]);
        for (const spec of specs) {
          const resolved = resolveModuleSpecifier(spec, path.dirname(full), scratchRoot);
          if (resolved) checkTarget(resolved, `import ${spec} in ${relOf(full)}`);
        }
      }
    }
  };
  walk(scratchRoot);
  return escapes;
}

function runTsc(tsc, args, cwd) {
  const isCmd = tsc.endsWith('.cmd');
  return execFileSync(
    isCmd ? process.env.ComSpec || 'cmd.exe' : process.execPath,
    isCmd ? ['/c', tsc, ...args] : [tsc, ...args],
    { cwd, encoding: 'utf8', stdio: 'pipe' }
  );
}

function classifyListedFiles(listText, scratchRoot, repoModulesReal, typescriptReal) {
  const files = listText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const program = [];
  const leaks = [];
  for (const file of files) {
    const real = realpathOrSelf(file);
    // Only the declared repo node_modules, and the typescript package the
    // guard itself invoked (a fixture may junction that package in from
    // another tree). A substring match on "/node_modules/" is not a
    // permit — package.json "types" can name any outside path.
    if (repoModulesReal && pathContains(repoModulesReal, real)) continue;
    if (typescriptReal && pathContains(typescriptReal, real)) continue;
    // r19b (grok): this carried `|| comparable(real).includes(comparable(scratchRoot))`, three
    // lines under a comment saying a substring match is not a permit. `<scratch>x/index.d.ts`
    // contains the scratch path as a substring and is a DIFFERENT directory; a package.json
    // "types" naming it was listed by tsc and the hook printed `compile OK`. Same class as the
    // `/node_modules/` substring from r11 - the lesson was written down and then violated in
    // the same block. Containment needs a separator, so pathContains is the only test.
    if (withinScratch(real, scratchRoot) || pathContains(scratchRoot, real)) {
      program.push(file);
      continue;
    }
    leaks.push(file);
  }
  return { program, leaks };
}

function programSourcesFromList(listText, scratchRoot, repoModulesReal, typescriptReal) {
  return classifyListedFiles(listText, scratchRoot, repoModulesReal, typescriptReal).program;
}

const stagedTsconfig = path.join(scratch, 'tsconfig.json');
if (!fs.existsSync(stagedTsconfig)) {
  fs.rmSync(scratch, { recursive: true, force: true });
  refuse(
    'the index contains no tsconfig.json, so the staged tree cannot be compiled',
    fs.existsSync(path.join(repo, 'tsconfig.json'))
      ? 'There is one in your working tree but it is not tracked or not staged. Stage it.'
      : 'Add a tsconfig.json, or use the escape hatch below.'
  );
}

const modules = path.join(repo, 'node_modules');
if (!fs.existsSync(modules)) {
  fs.rmSync(scratch, { recursive: true, force: true });
  refuse('node_modules is missing, so the staged tree cannot be type-checked',
    'Run `npm install`. On 2026-08-15 an npm install wiped node_modules/.bin for two hours; this is that.');
}
try {
  fs.symlinkSync(modules, path.join(scratch, 'node_modules'), 'junction');
} catch (error) {
  fs.rmSync(scratch, { recursive: true, force: true });
  refuse(`node_modules could not be staged for the index tree (${error.code || error.message})`);
}

const tscCandidates = [
  path.join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'),
  path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc')
];
const tsc = tscCandidates.find((candidate) => fs.existsSync(candidate));
if (!tsc) {
  fs.rmSync(scratch, { recursive: true, force: true });
  refuse('no local tsc was found, so nothing verified this commit', 'Run `npm install`.');
}

let repoModulesReal;
try {
  repoModulesReal = fs.realpathSync(modules);
} catch {
  repoModulesReal = modules;
}

let typescriptReal;
try {
  typescriptReal = fs.realpathSync(path.join(modules, 'typescript'));
} catch {
  typescriptReal = null;
}

const escapes = [
  ...findConfigEscapes(stagedTsconfig, scratch, repoModulesReal),
  ...findSourceEscapes(scratch, repoModulesReal),
  ...findImplicitTypeRootEscapes(scratch, repoModulesReal)
];
if (escapes.length > 0) {
  fs.rmSync(scratch, { recursive: true, force: true });
  refuse(
    'the staged tsconfig points the compiler OUTSIDE the staged tree, so nothing here verifies this commit:\n' +
      escapes.map((item) => `  - ${item}`).join('\n'),
    'tsc may see the materialised index and node_modules, and nothing else. A config that\n' +
      'names the working tree means the guard would be checking files this commit does not\n' +
      'contain - and an `extends` that is not itself staged would keep resolving locally\n' +
      'after the commit lands, staying green here and failing in CI.'
  );
}

if (configSetsNoCheck(stagedTsconfig, scratch)) {
  fs.rmSync(scratch, { recursive: true, force: true });
  refuse(
    'the staged tsconfig sets compilerOptions.noCheck, so tsc will not type-check this commit',
    'A green plus a NOTE is not a verified index. Remove noCheck, or use BUS_ALLOW_BROKEN_BUILD=1.'
  );
}

try {
  const staged = readConfig(stagedTsconfig);
  if (Array.isArray(staged?.exclude) && staged.exclude.length > 0) {
    console.log(`claim-guard: NOTE - the staged tsconfig excludes ${staged.exclude.length} pattern(s); excluded files are not checked.`);
  }
} catch {
  // Unparseable is tsc's refusal to make, below.
}

try {
  runTsc(tsc, ['-p', scratch, '--noEmit'], scratch);
  let listed;
  try {
    listed = runTsc(tsc, ['-p', scratch, '--listFilesOnly'], scratch);
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    refuse(
      'tsc reported success but the compiled program could not be listed, so nothing verified this commit',
      error.message
    );
  }
  const classified = classifyListedFiles(listed, scratch, repoModulesReal, typescriptReal);
  if (classified.leaks.length > 0) {
    fs.rmSync(scratch, { recursive: true, force: true });
    refuse(
      'tsc compiled files outside the staged tree, so nothing here verifies this commit:\n' +
        classified.leaks.map((item) => `  - ${item}`).join('\n'),
      'tsc may see the materialised index and node_modules, and nothing else. listFilesOnly\n' +
        'is what the compiler actually loaded. A package.json types/exports field, a\n' +
        'jsxImportSource package, or an allowJs import that resolves outside is the same leak\n' +
        'as a triple-slash path — the walker is not the authority, tsc is.'
    );
  }
  const program = classified.program;
  if (program.length === 0) {
    fs.rmSync(scratch, { recursive: true, force: true });
    refuse(
      'tsc compiled no program source, so an empty success is not a verified index',
      'A solution-style root with files: [] (or any config that type-checks nothing) does not\n' +
        'verify the staged tree. Point tsc at the staged sources, or use BUS_ALLOW_BROKEN_BUILD=1.'
    );
  }
  const own = program.filter(isOwnProgramSource);
  const nochecked = own.filter(leadingTsNocheck);
  if (own.length > 0 && nochecked.length === own.length) {
    fs.rmSync(scratch, { recursive: true, force: true });
    refuse(
      'every staged program source sets @ts-nocheck, so tsc will not type-check this commit',
      'A green plus a NOTE is not a verified index. @ts-nocheck on the whole program is\n' +
        'compilerOptions.noCheck spelled in the source. Remove it, or use BUS_ALLOW_BROKEN_BUILD=1.'
    );
  }
  if (nochecked.length > 0) {
    console.log(`claim-guard: NOTE - ${nochecked.length} staged file(s) set @ts-nocheck; those files are not checked.`);
  }
  console.log('claim-guard: compile OK (staged index)');
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  fs.rmSync(scratch, { recursive: true, force: true });
  const detail = `${error.stdout || ''}${error.stderr || ''}`.trim().split('\n').slice(0, 6).join('\n');
  console.error('claim-guard: REFUSING - this commit does not compile.\n');
  console.error(detail || error.message);
  console.error('\nA commit that does not build blocks every other seat and hides every other');
  console.error('failure behind it. Fix it, or commit deliberately with BUS_ALLOW_BROKEN_BUILD=1');
  console.error('and say so in the message.');
  process.exit(1);
}
