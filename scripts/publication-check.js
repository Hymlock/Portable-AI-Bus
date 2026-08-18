#!/usr/bin/env node
/**
 * Is this repository safe to publish?
 *
 * Written because my first attempt at this question was WRONG in the way that matters. I ran
 * `git diff --name-only origin/main..HEAD`, found no personal data, and reported the tree
 * clean. That command lists the files CHANGED in those commits; a push publishes the WHOLE
 * TREE. The real answer was 99 of 329 tracked files, including README.md.
 *
 * A check that answers a narrower question than the one asked, and reports it in the words of
 * the broader one. That is the defect class this project has spent a week closing in other
 * people's code, and it nearly published a contributor's machine layout to a public repo.
 *
 * So this asks the question the push actually asks: OF EVERY TRACKED FILE, does anything
 * identify a machine, a person, or a secret?
 *
 * It is deliberately NOISY rather than clever. A publication check that misses something is
 * worth less than one that makes you look at twenty harmless lines.
 *
 *   node scripts/publication-check.js            # scan tracked files
 *   node scripts/publication-check.js --staged   # scan what is staged instead
 *
 * Exit 0 clean, 1 findings, 2 misuse.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = process.cwd();
const stagedOnly = process.argv.includes('--staged');

/**
 * Patterns are intentionally general. `hymlo` is absent from this list on purpose: searching
 * for the identifier you already know about tells you only that you remembered it. These look
 * for the SHAPES that carry identity.
 */
const PATTERNS = [
  { name: 'windows user directory', re: /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}([^\\/\s"'`<>]+)/gi, capture: 1 },
  { name: 'unix home directory', re: /\/(?:home|Users)\/([A-Za-z0-9._-]+)/g, capture: 1 },
  { name: 'windows appdata path', re: /AppData[\\/]{1,2}(?:Local|Roaming)/gi },
  { name: 'absolute drive path', re: /\b[A-Za-z]:[\\/]{2}(?!Users\b)[A-Za-z0-9 ._-]+[\\/]/g },
  { name: 'email address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'bearer or api token', re: /\b(?:sk|pk|ghp|gho|ghs|xox[baprs])[-_][A-Za-z0-9]{16,}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'unc network path', re: /\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9$._-]+/g }
];

// Placeholders a scrub is expected to leave behind. These are the DESIRED end state, so
// matching one is not a finding - but the list is short and explicit so it cannot quietly
// grow into a way of suppressing real hits.
const PLACEHOLDERS = [/<you>/i, /<user>/i, /<username>/i, /YOUR-USER/i, /example\.com/i, /noreply@anthropic\.com/i];

function tracked() {
  const args = stagedOnly ? ['diff', '--cached', '--name-only'] : ['ls-files'];
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\n').map((s) => s.trim()).filter(Boolean);
}

function isProbablyBinary(buffer) {
  const limit = Math.min(buffer.length, 4096);
  for (let i = 0; i < limit; i += 1) if (buffer[i] === 0) return true;
  return false;
}

let files;
try {
  files = tracked();
} catch (error) {
  console.error(`publication-check: could not list files: ${error.message}`);
  process.exit(2);
}

const findings = [];
let scanned = 0;

for (const file of files) {
  const full = path.join(repo, file);
  let buffer;
  try {
    buffer = fs.readFileSync(full);
  } catch {
    // Deleted or unreadable in the working tree. A staged deletion is not a publication risk.
    continue;
  }
  if (isProbablyBinary(buffer)) continue;
  scanned += 1;
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/);

  for (const { name, re, capture } of PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(line)) !== null) {
        const hit = match[0];
        if (PLACEHOLDERS.some((p) => p.test(hit))) continue;
        // For user-directory patterns the captured name is the identity. A placeholder there
        // is the whole point of a scrub.
        if (capture !== undefined && match[capture] && PLACEHOLDERS.some((p) => p.test(match[capture]))) continue;
        findings.push({ file, line: i + 1, name, text: line.trim().slice(0, 140) });
        break; // one finding per pattern per line is enough to send someone looking
      }
    }
  }
}

console.log(`publication-check: scanned ${scanned} text file(s) of ${files.length} tracked`);

if (findings.length === 0) {
  console.log('publication-check: no machine, personal or secret identifiers found');
  console.log('             This is not a promise the repo is safe to publish. It is a promise');
  console.log('             that these patterns are absent. Read the diff too.');
  process.exit(0);
}

const byFile = new Map();
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}

console.error(`\npublication-check: ${findings.length} finding(s) in ${byFile.size} file(s)\n`);
for (const [file, hits] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.error(`  ${file}  (${hits.length})`);
  for (const hit of hits.slice(0, 3)) {
    console.error(`    ${hit.line}: [${hit.name}] ${hit.text}`);
  }
  if (hits.length > 3) console.error(`    ... and ${hits.length - 3} more`);
}
console.error('\nA push publishes the WHOLE TREE, not the diff. Scrub these before publishing.');
process.exit(1);
