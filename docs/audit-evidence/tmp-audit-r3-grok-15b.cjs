'use strict';
/**
 * Round-3 follow-up: attack the 8b5ae78 compiler rule, not the closed 8ea4c35 holes.
 * Rule: tsc may see the materialised index and the declared node_modules junction. Nothing else.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO = __dirname;
const GUARD = path.join(REPO, 'scripts', 'claim-guard-cli.js');
const results = [];

function rec(name, status, detail) {
  results.push({ name, status, detail: String(detail) });
  console.log(`[${status}] ${name}: ${detail}`);
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function junction(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function fileSymlink(link, target) {
  try {
    execFileSync('cmd.exe', ['/c', 'mklink', link, target], { stdio: 'pipe' });
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link, 'file');
      return true;
    } catch {
      return false;
    }
  }
}

function runGuard(repo, busRoot) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, '--repo', repo, '--seat', 'claude', '--root', busRoot], {
      cwd: repo, encoding: 'utf8', stdio: 'pipe'
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

async function fixtureRepo() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pab-r3g-15b-'));
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(path.join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'gate@example.com');
  git(repo, 'config', 'user.name', 'gate');
  git(repo, 'config', 'core.symlinks', 'true');
  await fsp.writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');
  await fsp.writeFile(path.join(repo, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
    include: ['src']
  }, null, 2));
  await fsp.writeFile(path.join(repo, 'src', 'ok.ts'), 'export const fine: number = 1;\n');
  await fsp.writeFile(path.join(repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
  const linked = junction(path.join(repo, 'node_modules'), path.join(REPO, 'node_modules'));
  const busRoot = path.join(dir, 'bus');
  await fsp.mkdir(path.join(busRoot, '.ai-bus', 'runtime', 'mailbox'), { recursive: true });
  await fsp.writeFile(
    path.join(busRoot, '.ai-bus', 'runtime', 'mailbox', 'state.json'),
    JSON.stringify({ claims: { claude: [{ path: 'src' }, { path: 'tsconfig.json' }, { path: '.' }] } })
  );
  return {
    dir, repo, busRoot, linked,
    cleanup: () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch(() => {})
  };
}

function landedBroken(result) {
  return result.code === 0 && /compile OK \(staged index\)/.test(result.out);
}

async function main() {
  // A. include as a STRING, not an array — sanitizer only walks arrays
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('include-as-string', 'SKIP', 'no node_modules');
      else {
        const absSrc = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: absSrc
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (landedBroken(result)) {
          rec('include-as-string', 'FAIL', `string include bypassed the walk: exit=0 ${result.out.trim()}`);
        } else {
          rec('include-as-string', result.code === 1 ? 'PASS' : 'NOTE', `exit=${result.code} ${result.out.slice(0, 220)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  // B. files as a STRING
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('files-as-string', 'SKIP', 'no node_modules');
      else {
        const absIndex = path.resolve(fx.repo, 'src', 'index.ts').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          files: absIndex
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (landedBroken(result)) {
          rec('files-as-string', 'FAIL', `string files bypassed the walk: exit=0 ${result.out.trim()}`);
        } else {
          rec('files-as-string', result.code === 1 ? 'PASS' : 'NOTE', `exit=${result.code} ${result.out.slice(0, 220)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  // C. tsconfig.json is an absolute symlink to the worktree config
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('symlink-tsconfig', 'SKIP', 'no node_modules');
      else {
        const realCfg = path.join(fx.repo, 'tsconfig.real.json');
        await fsp.writeFile(realCfg, JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src']
        }, null, 2));
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.unlink(path.join(fx.repo, 'tsconfig.json'));
        if (!fileSymlink(path.join(fx.repo, 'tsconfig.json'), realCfg)) {
          rec('symlink-tsconfig', 'SKIP', 'could not create file symlink');
        } else {
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          const stagedType = fs.lstatSync(path.join(fx.repo, 'tsconfig.json')).isSymbolicLink() ? 'symlink' : 'file';
          if (landedBroken(result)) {
            rec('symlink-tsconfig', 'FAIL', `absolute symlink tsconfig (${stagedType}) compiled worktree. ${result.out.trim()}`);
          } else {
            rec('symlink-tsconfig', result.code === 1 ? 'PASS' : 'NOTE', `exit=${result.code} type=${stagedType} ${result.out.slice(0, 240)}`);
          }
        }
      }
    } finally { await fx.cleanup(); }
  }

  // D. include a staged junction that points at the worktree src
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('include-staged-junction', 'SKIP', 'no node_modules');
      else {
        const alias = path.join(fx.repo, 'alias-src');
        if (!junction(alias, path.join(fx.repo, 'src'))) {
          rec('include-staged-junction', 'SKIP', 'could not create junction');
        } else {
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
          await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
            compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
            include: ['alias-src']
          }, null, 2));
          git(fx.repo, 'add', '-A');
          await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
          const result = runGuard(fx.repo, fx.busRoot);
          if (landedBroken(result)) {
            rec('include-staged-junction', 'FAIL', `include of a junction to worktree src compiled the restored files. ${result.out.trim()}`);
          } else {
            rec('include-staged-junction', result.code === 1 ? 'PASS' : 'NOTE', `exit=${result.code} ${result.out.slice(0, 240)}`);
          }
        }
      }
    } finally { await fx.cleanup(); }
  }

  // E. ${configDir} + path that tsc expands to worktree; sanitizer sees a relative literal
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('configDir-template', 'SKIP', 'no node_modules');
      else {
        const absSrc = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['${configDir}/src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        // This one should still compile scratch/src (broken) if tsc expands configDir to scratch.
        const resultBroken = runGuard(fx.repo, fx.busRoot);
        rec('configDir-relative-still-checks-index',
          resultBroken.code === 1 && /does not compile|TS2322/.test(resultBroken.out) ? 'PASS' : 'NOTE',
          `exit=${resultBroken.code} ${resultBroken.out.slice(0, 200)}`);

        // Escape via template that sanitizer does not expand.
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [`\${configDir}/src`]
        }, null, 2));
        // Try a template that, if left unexpanded, is inside scratch, but if tsc expands
        // something else... actually try include of an absolute via concatenation that
        // path.resolve will not see as escaping: "${configDir}" only.
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), `{
          "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true, "types": [] },
          "include": ["${absSrc.replace(/\\/g, '/')}"]
        }\n`);
        // already covered. Try configDir with extra .. that tsc might handle differently.
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [absSrc]
        }, null, 2));
        git(fx.repo, 'add', 'tsconfig.json', 'src/index.ts');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const resultAbs = runGuard(fx.repo, fx.busRoot);
        rec('absolute-include-still-refused', resultAbs.code === 1 && /OUTSIDE/.test(resultAbs.out) ? 'PASS' : 'FAIL',
          `exit=${resultAbs.code} ${resultAbs.out.slice(0, 200)}`);
      }
    } finally { await fx.cleanup(); }
  }

  // F. JSONC the sanitizer cannot parse, tsc can — walk skipped
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('jsonc-parse-disagreement', 'SKIP', 'no node_modules');
      else {
        const absSrc = path.resolve(fx.repo, 'src').replace(/\\/g, '/');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        // Trailing comma + comment + single-line; plus a BOM. Also try #! or unknown.
        // tsc accepts JSONC. Try a unicode line separator or unquoted? 
        // Use `include` with a JS-style expression tsc might reject...
        // Attack: JSONC with `//` comment inside and a trailing comma after include,
        // PLUS include as string — if parse fails, walk skipped.
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'),
          `\uFEFF{
            // worktree escape
            "compilerOptions": { "strict": true, "noEmit": true, "skipLibCheck": true, "types": [] },
            "include": "${absSrc}",
          }\n`);
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (landedBroken(result)) {
          rec('jsonc-parse-disagreement', 'FAIL', `sanitizer failed to parse, tsc compiled worktree. ${result.out.trim()}`);
        } else {
          rec('jsonc-parse-disagreement', result.code === 1 ? 'PASS' : 'NOTE', `exit=${result.code} ${result.out.slice(0, 240)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  // G. compilerOptions.plugins absolute path — not walked
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('plugins-absolute', 'SKIP', 'no node_modules');
      else {
        const plugin = path.join(fx.repo, 'skip-check.js');
        await fsp.writeFile(plugin, 'module.exports = () => ({});\n');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: {
            strict: true, noEmit: true, skipLibCheck: true, types: [],
            plugins: [{ name: plugin.replace(/\\/g, '/') }]
          },
          include: ['src']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        // plugins should not stop the type error unless tsc actually loads them as transformers.
        rec('plugins-absolute',
          result.code === 1 && /does not compile|TS2322|OUTSIDE/.test(result.out) ? 'PASS' : (result.code === 0 ? 'NOTE' : 'NOTE'),
          `exit=${result.code} ${result.out.slice(0, 240)}`);
      }
    } finally { await fx.cleanup(); }
  }

  // H. exclude the broken file in the INDEX — declared consequence
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('index-exclude-broken', 'SKIP', 'no node_modules');
      else {
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: ['src'],
          exclude: ['src/index.ts']
        }, null, 2));
        git(fx.repo, 'add', '-A');
        const result = runGuard(fx.repo, fx.busRoot);
        rec('index-exclude-broken', result.code === 0 ? 'NOTE' : 'PASS',
          result.code === 0
            ? `index excluded the broken file and logged it. ${result.out.trim()}`
            : `exit=${result.code} ${result.out.slice(0, 200)}`);
      }
    } finally { await fx.cleanup(); }
  }

  // I. extends as string vs array already walked. Try extends: { path: abs } invalid.

  // J. Windows long-path prefix
  {
    const fx = await fixtureRepo();
    try {
      if (!fx.linked) rec('long-path-prefix', 'SKIP', 'no node_modules');
      else {
        const absSrc = `\\\\?\\${path.resolve(fx.repo, 'src')}`;
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const broken: number = "no";\n');
        await fsp.writeFile(path.join(fx.repo, 'tsconfig.json'), JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] },
          include: [absSrc]
        }, null, 2));
        git(fx.repo, 'add', '-A');
        await fsp.writeFile(path.join(fx.repo, 'src', 'index.ts'), 'export const good: number = 1;\n');
        const result = runGuard(fx.repo, fx.busRoot);
        if (landedBroken(result)) {
          rec('long-path-prefix', 'FAIL', `\\\\?\\ prefix escaped the walk. ${result.out.trim()}`);
        } else {
          rec('long-path-prefix', result.code === 1 ? 'PASS' : 'NOTE', `exit=${result.code} ${result.out.slice(0, 220)}`);
        }
      }
    } finally { await fx.cleanup(); }
  }

  const out = path.join(REPO, 'tmp-audit-r3-grok-15b-out.json');
  await fsp.writeFile(out, JSON.stringify({ results }, null, 2));
  const counts = results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {});
  console.log('\nSUMMARY', JSON.stringify(counts));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
