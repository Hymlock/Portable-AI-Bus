/**
 * Refuse to commit files a seat has not claimed.
 *
 * The failure this exists to stop, from this project's own history:
 *
 *   - claude's commit `5af3b1c` swept in `src/brain/brains/agent.ts`, `index.ts` and
 *     `tests/agent-brain.test.js` - GROK's files - under a message about baton handoff.
 *   - codex reported "the entire untracked claimed directory disappeared" while it was mid-write
 *     on `src/brain/auth/`.
 *
 * One cause: `git add -A` in a worktree three agents share. It stages everyone's work, and the
 * agent running it cannot tell, because staged files look identical whoever wrote them.
 *
 * Claims already record who owns what. This makes them enforceable instead of advisory - the
 * same move as every other guard here: a rule nobody can break beats a rule everyone agrees to.
 */

export type Claim = { path: string; why?: string };

export type GuardResult = {
  ok: boolean;
  violations: { path: string; reason: string }[];
  checked: number;
};

function normalise(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** True when `file` is the claim itself or sits beneath it. */
export function coveredBy(file: string, claim: string): boolean {
  const f = normalise(file);
  const c = normalise(claim);
  return f === c || f.startsWith(`${c}/`);
}

export type GuardOptions = {
  /**
   * Paths every seat may commit without claiming - lockfiles, build output, the claim registry
   * itself. Without this a strict guard blocks routine work and gets switched off, which is
   * worse than no guard.
   */
  shared?: string[];
};

const DEFAULT_SHARED = [
  'package-lock.json',
  'dist',
  '.gitignore'
];

/**
 * @param seat        the committing seat
 * @param staged      output of `git diff --cached --name-only`
 * @param claimsBySeat the mailbox's claim registry
 */
export function guardStagedPaths(
  seat: string,
  staged: string[],
  claimsBySeat: Record<string, Claim[]>,
  options: GuardOptions = {}
): GuardResult {
  const shared = (options.shared ?? DEFAULT_SHARED).map(normalise);
  const mine = (claimsBySeat[seat] ?? []).map((c) => c.path);
  const violations: { path: string; reason: string }[] = [];

  for (const file of staged) {
    if (shared.some((s) => coveredBy(file, s))) continue;
    if (mine.some((claim) => coveredBy(file, claim))) continue;

    // Naming the OTHER owner matters more than refusing. "You staged grok's file" is
    // actionable; "unclaimed path" sends someone hunting.
    const owner = Object.entries(claimsBySeat).find(
      ([other, claims]) => other !== seat && claims.some((c) => coveredBy(file, c.path))
    )?.[0];

    violations.push({
      path: file,
      reason: owner
        ? `claimed by ${owner} - you are about to commit another agent's work`
        : 'not covered by any claim of yours - claim it first, or stage explicitly rather than with `git add -A`'
    });
  }

  return { ok: violations.length === 0, violations, checked: staged.length };
}

export function formatGuardResult(seat: string, result: GuardResult): string {
  if (result.ok) {
    return `claim-guard: ${result.checked} staged path(s), all covered by ${seat}'s claims`;
  }
  const lines = [
    `claim-guard: REFUSING - ${result.violations.length} of ${result.checked} staged path(s) are not yours`,
    ''
  ];
  for (const violation of result.violations) {
    lines.push(`  ${violation.path}`);
    lines.push(`      ${violation.reason}`);
  }
  lines.push('');
  lines.push('Three agents share this worktree. `git add -A` stages their work too, and a');
  lines.push('staged file looks the same whoever wrote it. Stage your own paths by name.');
  return lines.join('\n');
}
