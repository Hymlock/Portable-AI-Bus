#!/usr/bin/env node
/**
 * Check what you are about to commit against your claims.
 *
 *   node scripts/claim-guard-cli.js --root "<bus root>" --seat claude
 *   node scripts/claim-guard-cli.js --root "<bus root>" --seat claude --install-hook
 *
 * `--install-hook` writes a pre-commit hook so the check runs whether or not anyone remembers
 * it. A guard that depends on being invoked is a guard that fails on the day it matters — and
 * this project has proved that repeatedly.
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
  // No mailbox means no claims to check against: this half of the guard exists for a SHARED
  // worktree, and a missing bus is evidence there is not one.
  //
  // Round 3 (grok): this used to exit(0), which switched off the COMPILE check as well - and
  // a wrong or stale BUS_ROOT reaches it just as surely as a deliberate one. Two unrelated
  // questions were sharing an exit. Only the claim question depends on the mailbox.
  console.log('claim-guard: no mailbox state found; claim check skipped (not a shared worktree)');
}

if (claims !== undefined) {
  const result = guardStagedPaths(seat, staged, claims);
  console.log(formatGuardResult(seat, result));
  if (!result.ok) process.exit(1);
}

/**
 * Item 15: the guard verified CLAIMS and not BUILDS.
 *
 * Measured 2026-08-15: c772aa5 changed acknowledge()'s signature in runner.ts without updating
 * bus-client.ts, and landed with this hook ACTIVE and reporting success. `npm test` then exited
 * 2 before running a single test, and HEAD stayed broken for twenty-five minutes while another
 * seat worked on top of it, with every unrelated failure hidden behind the compile error.
 *
 * The hook answered "is this yours to commit?" and nothing answered "does this work?".
 *
 * Deliberately compile-only, not the full suite. Item 6 spent a whole session proving that a
 * guard which cannot be SATISFIED gets bypassed exactly as surely as one that cannot go RED, so
 * the green case - an honest commit stays fast - is load-bearing. tsc is seconds; the suite is
 * forty and would push seats toward --no-verify, which is the failure this is meant to prevent.
 *
 * The escape hatch is explicit and LOGGED rather than achieved by disabling the hook.
 */
if (process.env.BUS_ALLOW_BROKEN_BUILD === '1') {
  console.log('claim-guard: BUS_ALLOW_BROKEN_BUILD=1 - compile check SKIPPED for this commit');
  console.log('             deliberate WIP. Say so in the commit message.');
  process.exit(0);
}

/**
 * `tsc -p repo` compiles the WORKING TREE, not the INDEX. Stage a type error, restore a
 * compiling working tree, and the guard printed `compile OK` while a non-compiling commit
 * landed. A pre-commit check must verify WHAT IS BEING COMMITTED, so this materialises the
 * index with `git checkout-index` - which writes exactly the staged content - and compiles it.
 *
 * SECOND AUDIT (grok, 2026-08-17). Materialising the index was right; everything around it
 * leaked, and all four holes were the same mistake: consulting the WORKING TREE about a
 * question only the INDEX can answer.
 *
 *   - tsconfig.json was checked for, and then COPIED FROM, the worktree. So renaming it away
 *     skipped the check entirely, and a worktree tsconfig with a narrow `include` compiled a
 *     subset of the staged tree and printed `compile OK (staged index)`. A staged tsconfig
 *     that does not even parse sailed through behind a good worktree one.
 *   - a missing tsconfig and a missing tsc both exited 0.
 *
 * So: the index supplies its own tsconfig, and every path that cannot actually verify the
 * staged tree now REFUSES. The escape hatch is what keeps that satisfiable - item 6 proved a
 * guard that cannot be satisfied gets bypassed exactly as surely as one that cannot go red -
 * and it is explicit and logged rather than achieved by disabling the hook.
 */
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
  // Previously this fell back to compiling the worktree. That is the one thing it must not do:
  // the fallback answers a different question and reports it in the same words.
  refuse(
    `the index could not be materialised (${error.message.split('\n')[0]})`,
    'Without the staged tree there is nothing to verify.'
  );
}

/**
 * ROUND 3 (grok). "The index supplies its own tsconfig" was still an enumeration of guard-side
 * lookups, and it decided two attacks WRONGLY rather than not deciding them:
 *
 *   - a staged tsconfig whose `include` is the ABSOLUTE path of the worktree src/. The index
 *     supplied the config; the config pointed tsc at the worktree; the guard printed
 *     `compile OK (staged index)`.
 *   - a staged tsconfig that `extends` an untracked worktree-only base with a narrow include.
 *     Worse than a bypass: after such a commit lands, local tsc keeps following a base that
 *     is not in the repository at all, so it stays green locally and fails in CI.
 *
 * I stopped the guard reading the worktree and did not stop TSC reading it. So state the rule
 * about the COMPILER, which is the thing that actually reads files:
 *
 *   tsc may see the materialised index and the declared node_modules junction. Nothing else.
 *   A staged tsconfig whose extends/include/files/references resolve outside the scratch tree
 *   is UNVERIFIABLE, and unverifiable refuses.
 *
 * Note what this does NOT claim to stop, because a declared consequence is not a hole: tsc
 * still trusts the staged config's own switches. `noCheck: true` in the index disables
 * checking, and a narrow `exclude` still narrows. Those are the price of running tsc rather
 * than writing a private typechecker; they are logged loudly below rather than pretended away.
 */
function stripJsonComments(text) {
  // Enough for tsconfig: line and block comments outside strings, plus trailing commas.
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

function withinScratch(target, scratchRoot) {
  const rel = path.relative(scratchRoot, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Walks the staged config and its extends chain, refusing anything that escapes the scratch
 * tree. Returns a list of human-readable escapes; empty means the compiler can only see what
 * this commit contains.
 */
function findConfigEscapes(configPath, scratchRoot, seen = new Set()) {
  const escapes = [];
  const resolved = path.resolve(configPath);
  if (seen.has(resolved)) return escapes;
  seen.add(resolved);

  let config;
  try {
    config = JSON.parse(stripJsonComments(fs.readFileSync(resolved, 'utf8')));
  } catch (error) {
    // A tsconfig that does not parse is its own refusal, handled by tsc. Nothing to walk.
    return escapes;
  }
  const base = path.dirname(resolved);
  const check = (value, label) => {
    if (typeof value !== 'string' || value.length === 0) return;
    // A glob's fixed prefix is what decides where it starts looking.
    const literal = value.split(/[*?]/)[0];
    const target = path.resolve(base, literal);
    if (!withinScratch(target, scratchRoot)) escapes.push(`${label}: ${value}`);
  };

  for (const key of ['include', 'files', 'exclude']) {
    for (const entry of Array.isArray(config[key]) ? config[key] : []) check(entry, key);
  }
  for (const reference of Array.isArray(config.references) ? config.references : []) {
    check(reference?.path, 'references');
  }
  const options = config.compilerOptions ?? {};
  for (const key of ['baseUrl', 'rootDir', 'outDir', 'declarationDir']) check(options[key], `compilerOptions.${key}`);
  for (const entry of Array.isArray(options.rootDirs) ? options.rootDirs : []) check(entry, 'compilerOptions.rootDirs');
  for (const entry of Array.isArray(options.typeRoots) ? options.typeRoots : []) check(entry, 'compilerOptions.typeRoots');
  for (const [alias, targets] of Object.entries(options.paths ?? {})) {
    for (const entry of Array.isArray(targets) ? targets : []) check(entry, `compilerOptions.paths["${alias}"]`);
  }

  const extend = config.extends;
  for (const entry of Array.isArray(extend) ? extend : extend === undefined ? [] : [extend]) {
    if (typeof entry !== 'string') continue;
    // A bare specifier resolves inside node_modules, which is declared and allowed.
    const isRelative = entry.startsWith('.') || path.isAbsolute(entry);
    if (!isRelative) continue;
    const target = path.resolve(base, entry.endsWith('.json') ? entry : `${entry}.json`);
    if (!withinScratch(target, scratchRoot)) {
      escapes.push(`extends: ${entry}`);
      continue;
    }
    if (fs.existsSync(target)) escapes.push(...findConfigEscapes(target, scratchRoot, seen));
    else escapes.push(`extends (missing from the index): ${entry}`);
  }
  return escapes;
}

// The INDEX must carry its own tsconfig. Reading the worktree's here was attacks 3 and 4.
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

// node_modules is deliberately not in the index; without it the compile fails for the wrong
// reason, which is a red that is not about the staged code.
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
  // This used to exit 0 on the reasoning that "no compiler is not a broken build". True, but
  // it is also not a verified build, and the guard printed the same silence for both.
  refuse('no local tsc was found, so nothing verified this commit', 'Run `npm install`.');
}

const escapes = findConfigEscapes(stagedTsconfig, scratch);
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

// Declared consequences, not holes: tsc obeys the STAGED config's own switches. Said out loud
// so nobody reads a green as more than it is.
try {
  const staged = JSON.parse(stripJsonComments(fs.readFileSync(stagedTsconfig, 'utf8')));
  if (staged?.compilerOptions?.noCheck === true) {
    console.log('claim-guard: NOTE - the staged tsconfig sets noCheck; tsc will not type-check.');
    console.log('             The compile below proves only that the config loads.');
  }
  if (Array.isArray(staged?.exclude) && staged.exclude.length > 0) {
    console.log(`claim-guard: NOTE - the staged tsconfig excludes ${staged.exclude.length} pattern(s); excluded files are not checked.`);
  }
} catch {
  // Unparseable is tsc's refusal to make, below.
}

try {
  const isCmd = tsc.endsWith('.cmd');
  execFileSync(isCmd ? process.env.ComSpec || 'cmd.exe' : process.execPath,
    isCmd ? ['/c', tsc, '-p', scratch, '--noEmit'] : [tsc, '-p', scratch, '--noEmit'],
    { cwd: scratch, encoding: 'utf8', stdio: 'pipe' });
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
