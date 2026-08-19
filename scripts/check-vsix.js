#!/usr/bin/env node
'use strict';
/**
 * Assert that a packaged .vsix actually carries what the extension needs to RUN.
 *
 * "It packaged" is not "it will run". CI packaged with --no-dependencies for its whole
 * life, which produces a perfectly valid 1.35 MB VSIX with no node-pty in it at all. It
 * installs cleanly and throws the moment it spawns a brain, because there is no bundler
 * here - compile is plain tsc - and dist/brain/process-host.js requires node-pty at
 * runtime. The failure only shows up on the machine that installed the extension.
 *
 * This reads the zip central directory directly rather than shelling out to `unzip`.
 * The first version of this gate did shell out, and failed on windows-latest with
 * "has no node-pty" against an archive that contained 2340 node_modules files - the
 * message named a product defect and the cause was a missing tool. A check whose
 * failure mode is indistinguishable from the defect it looks for is worse than no check.
 */
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED = [
  { prefix: 'extension/node_modules/node-pty/', why: 'the extension would throw when it spawns a brain' },
  { prefix: 'extension/dist/extension.js', why: 'there is no compiled entry point' }
];

/** Filenames listed in a zip's central directory. Throws if the file is not a zip. */
function zipEntryNames(file) {
  const buf = fs.readFileSync(file);

  // The end-of-central-directory record is last, but a trailing comment may follow it,
  // so scan backwards for its signature rather than assuming a fixed offset.
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${file} has no zip end-of-central-directory record`);

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error(`${file} is zip64; this reader does not handle it`);

  const names = [];
  const CD_SIG = 0x02014b50;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CD_SIG) {
      throw new Error(`${file} central directory entry ${i} has a bad signature`);
    }
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString('utf8', offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function findVsix(dir) {
  const found = fs.readdirSync(dir).filter((f) => f.endsWith('.vsix')).sort();
  if (found.length === 0) throw new Error(`no .vsix found in ${dir}`);
  return path.join(dir, found[0]);
}

function main() {
  const target = process.argv[2] || process.cwd();
  const vsix = fs.statSync(target).isDirectory() ? findVsix(target) : target;

  const names = zipEntryNames(vsix);
  // A zip that parsed to zero entries would satisfy nothing below for the wrong reason.
  if (names.length === 0) throw new Error(`${vsix} lists no entries at all`);

  const missing = REQUIRED.filter((r) => !names.some((n) => n.startsWith(r.prefix)));
  const label = `${path.basename(vsix)} (${names.length} entries)`;

  if (missing.length > 0) {
    for (const m of missing) {
      console.error(`::error::${label} is missing ${m.prefix} - ${m.why}`);
    }
    process.exit(1);
  }

  console.log(`${label} carries node-pty and a compiled entry point`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}

module.exports = { zipEntryNames };
