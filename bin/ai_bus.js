const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS_DIR = path.resolve(ROOT, 'docs');
const STATUS_PATH = path.resolve(DOCS_DIR, 'ai-status.md');
const PLAN_PATH = path.resolve(DOCS_DIR, 'ai-plan.md');
const HANDOFF_PATH = path.resolve(DOCS_DIR, 'ai-handoff.md');
const REVIEW_PATH = path.resolve(DOCS_DIR, 'ai-review.md');
const PROMPT_DIR = path.resolve(ROOT, 'tmp', 'ai-prompts');
const SUSPEND_MARKER_PATH = path.resolve(ROOT, '.ai-bus', 'runtime', 'suspended.json');

const PHASES = new Set([
  'PLANNING',
  'READY_FOR_CODEX',
  'CODEX_IN_PROGRESS',
  'READY_FOR_REVIEW',
  'CLAUDE_REVIEW_IN_PROGRESS',
  'READY_FOR_FIXES',
  'DONE'
]);

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing file: ${path.relative(ROOT, filePath)}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(markdown, heading) {
  const pattern = new RegExp(`## ${escapeRegExp(heading)}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
  const match = markdown.match(pattern);
  if (!match) {
    throw new Error(`missing section: ${heading}`);
  }
  return match[1].trim();
}

function replaceSection(markdown, heading, body) {
  const normalizedBody = body.trimEnd();
  const block = `## ${heading}\n${normalizedBody}\n`;
  const pattern = new RegExp(`## ${escapeRegExp(heading)}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
  if (!pattern.test(markdown)) {
    throw new Error(`missing section: ${heading}`);
  }
  return markdown.replace(pattern, block);
}

function nowIso() {
  return new Date().toISOString();
}

function parseStatus(markdown) {
  return {
    phase: extractSection(markdown, 'Current phase'),
    currentTask: extractSection(markdown, 'Current task'),
    lastUpdate: extractSection(markdown, 'Last update'),
    log: extractSection(markdown, 'Log')
  };
}

function inferNextActor(phase) {
  switch (phase) {
    case 'PLANNING':
      return 'Claude';
    case 'READY_FOR_CODEX':
    case 'READY_FOR_FIXES':
    case 'CODEX_IN_PROGRESS':
      return 'Codex';
    case 'READY_FOR_REVIEW':
    case 'CLAUDE_REVIEW_IN_PROGRESS':
      return 'Claude';
    case 'DONE':
      return 'None';
    default:
      return 'Unknown';
  }
}

function buildNextInstruction(phase, nextActor) {
  switch (phase) {
    case 'DONE':
      return 'Workflow complete. Start a new task or reset docs/ai-status.md to PLANNING.';
    case 'CODEX_IN_PROGRESS':
      return 'Codex is currently implementing. Wait for the phase to move to READY_FOR_REVIEW.';
    case 'CLAUDE_REVIEW_IN_PROGRESS':
      return 'Claude is currently reviewing. Wait for the phase to move to READY_FOR_FIXES or DONE.';
    default:
      return `${nextActor} is up next. Paste the prompt below into ${nextActor}.`;
  }
}

function buildPrompt(phase) {
  switch (phase) {
    case 'PLANNING':
      return [
        'Read CLAUDE.md plus docs/ai-status.md, docs/ai-plan.md, docs/ai-handoff.md, and docs/ai-review.md.',
        'For the current user task, inspect the repo and write:',
        '- a brief plan in docs/ai-plan.md',
        '- exact implementation steps in docs/ai-handoff.md',
        'Then update docs/ai-status.md to READY_FOR_CODEX.',
        'Do not implement code.'
      ].join('\n');
    case 'READY_FOR_CODEX':
      return [
        'Read AGENTS.md plus docs/ai-status.md, docs/ai-handoff.md, and docs/ai-review.md.',
        'Implement the current task from docs/ai-handoff.md.',
        'Make minimal targeted changes.',
        'Run validation if available.',
        'Then update docs/ai-status.md to READY_FOR_REVIEW.'
      ].join('\n');
    case 'READY_FOR_REVIEW':
      return [
        'Read CLAUDE.md plus docs/ai-status.md, docs/ai-plan.md, docs/ai-handoff.md, and docs/ai-review.md.',
        'Review the current changes against the plan and acceptance criteria.',
        'Write required fixes to docs/ai-review.md.',
        'If acceptable, set docs/ai-status.md to DONE.',
        'If fixes are needed, set docs/ai-status.md to READY_FOR_FIXES.',
        'Do not implement code.'
      ].join('\n');
    case 'READY_FOR_FIXES':
      return [
        'Read AGENTS.md plus docs/ai-status.md, docs/ai-handoff.md, and docs/ai-review.md.',
        'Apply the required fixes from docs/ai-review.md.',
        'Run validation if available.',
        'Then update docs/ai-status.md to READY_FOR_REVIEW.'
      ].join('\n');
    case 'DONE':
      return 'Workflow complete. Start a new task or reset docs/ai-status.md to PLANNING.';
    case 'CODEX_IN_PROGRESS':
      return 'Codex is currently implementing. Wait for docs/ai-status.md to move to READY_FOR_REVIEW.';
    case 'CLAUDE_REVIEW_IN_PROGRESS':
      return 'Claude is currently reviewing. Wait for docs/ai-status.md to move to READY_FOR_FIXES or DONE.';
    default:
      return `No prompt template for phase ${phase}.`;
  }
}

function padCell(value, width) {
  return String(value).padEnd(width, ' ');
}

function renderStatusBlock(status, options = {}) {
  const phase = status.phase;
  const task = status.currentTask;
  const lastUpdate = status.lastUpdate;
  const nextActor = options.nextActor || inferNextActor(phase);
  const prompt = options.prompt || buildPrompt(phase);
  const promptFile = options.promptFile || path.relative(ROOT, promptPathForPhase(phase));
  const title = options.title || 'Portable-AI-Bus Status';
  const nextInstruction = options.nextInstruction || buildNextInstruction(phase, nextActor);
  const rows = [
    ['Phase', phase],
    ['Task', task],
    ['Last update', lastUpdate],
    ['Next actor', nextActor]
  ];
  const fieldWidth = Math.max(...rows.map(([label]) => label.length), 'Field'.length);
  const valueWidth = Math.max(...rows.map(([, value]) => String(value).length), 'Value'.length);
  const border = `+${'-'.repeat(fieldWidth + 2)}+${'-'.repeat(valueWidth + 2)}+`;
  const lines = [
    title,
    border,
    `| ${padCell('Field', fieldWidth)} | ${padCell('Value', valueWidth)} |`,
    border
  ];

  for (const [label, value] of rows) {
    lines.push(`| ${padCell(label, fieldWidth)} | ${padCell(value, valueWidth)} |`);
  }

  lines.push(border);
  lines.push('');
  lines.push('Next instructions');
  lines.push(`- ${nextInstruction}`);
  lines.push(`- Prompt file: ${promptFile}`);
  lines.push('');
  lines.push('Next prompt');
  lines.push(prompt);
  return lines.join('\n');
}

function promptPathForPhase(phase) {
  return path.resolve(PROMPT_DIR, `${phase.toLowerCase()}.txt`);
}

function writePromptArtifacts(phase) {
  fs.mkdirSync(PROMPT_DIR, { recursive: true });
  const prompt = buildPrompt(phase);
  writeFile(promptPathForPhase(phase), `${prompt}\n`);
  writeFile(path.resolve(PROMPT_DIR, 'current.txt'), `${prompt}\n`);
}

function ensureFiles() {
  if (fs.existsSync(SUSPEND_MARKER_PATH)) {
    throw new Error('ai-bus is suspended. Run .ai-bus/resume.ps1 before using the active overlay.');
  }
  [STATUS_PATH, PLAN_PATH, HANDOFF_PATH, REVIEW_PATH].forEach((filePath) => {
    if (!fs.existsSync(filePath)) {
      throw new Error(`missing required bus file: ${path.relative(ROOT, filePath)}`);
    }
  });
}

function validateStatus() {
  ensureFiles();
  const status = parseStatus(readFile(STATUS_PATH));
  if (!PHASES.has(status.phase)) {
    throw new Error(`invalid phase: ${status.phase}`);
  }
  return status;
}

function commandValidate() {
  const status = validateStatus();
  console.log(
    'ai_bus:',
    JSON.stringify(
      {
        phase: status.phase,
        currentTask: status.currentTask,
        nextActor: inferNextActor(status.phase)
      },
      null,
      2
    )
  );
}

function commandStatus() {
  const status = validateStatus();
  const nextActor = inferNextActor(status.phase);
  const promptFile = path.relative(ROOT, promptPathForPhase(status.phase));
  console.log(
    renderStatusBlock(status, {
      nextActor,
      promptFile,
      prompt: buildPrompt(status.phase)
    })
  );
}

function commandPrompt(args) {
  const phase = (args.phase || validateStatus().phase).trim();
  if (!PHASES.has(phase)) {
    throw new Error(`invalid phase: ${phase}`);
  }
  writePromptArtifacts(phase);
  console.log(buildPrompt(phase));
}

function commandSetPhase(args) {
  const phase = (args.phase || '').trim();
  if (!PHASES.has(phase)) {
    throw new Error(`invalid or missing --phase. Expected one of: ${Array.from(PHASES).join(', ')}`);
  }

  const actor = args.actor ? String(args.actor).trim() : inferNextActor(phase);
  const timestamp = nowIso();
  let statusMarkdown = readFile(STATUS_PATH);
  const previous = parseStatus(statusMarkdown);
  const task = args.task ? String(args.task).trim() : previous.currentTask;
  const summary = args.summary ? String(args.summary).trim() : `Phase set to ${phase}.`;
  const tests = args.tests ? String(args.tests).trim() : 'Not specified.';
  const files = args.files ? String(args.files).trim() : 'Not specified.';
  const result = args.result ? String(args.result).trim() : 'Not specified.';
  const nextActor = args.next ? String(args.next).trim() : inferNextActor(phase);

  statusMarkdown = replaceSection(statusMarkdown, 'Current phase', phase);
  statusMarkdown = replaceSection(statusMarkdown, 'Current task', task);
  statusMarkdown = replaceSection(statusMarkdown, 'Last update', `${timestamp} by ${actor}`);

  const existingLog = extractSection(statusMarkdown, 'Log');
  const entry = [
    `- ${timestamp} | actor: ${actor}`,
    `  phase: ${previous.phase} -> ${phase}`,
    `  summary: ${summary}`,
    `  files changed: ${files}`,
    `  tests run: ${tests}`,
    `  result: ${result}`,
    `  next expected actor: ${nextActor}`
  ].join('\n');
  const log = existingLog === 'No workflow activity yet.' ? entry : `${existingLog}\n${entry}`;
  statusMarkdown = replaceSection(statusMarkdown, 'Log', log);

  writeFile(STATUS_PATH, statusMarkdown);
  writePromptArtifacts(phase);

  console.log(
    renderStatusBlock(
      {
        phase,
        currentTask: task,
        lastUpdate: `${timestamp} by ${actor}`
      },
      {
        nextActor,
        promptFile: path.relative(ROOT, promptPathForPhase(phase)),
        prompt: buildPrompt(phase),
        title: 'Portable-AI-Bus Completion'
      }
    )
  );
}

function commandInit(args) {
  const task = args.task ? String(args.task).trim() : 'Describe the task here.';
  const goal = args.goal ? String(args.goal).trim() : 'Define the desired outcome.';
  const validation = args.validation ? String(args.validation).trim() : '- TBD';

  writeFile(
    PLAN_PATH,
    [
      '# AI Plan',
      '',
      '## Task',
      task,
      '',
      '## Goal',
      goal,
      '',
      '## Constraints',
      '- Keep changes minimal unless otherwise stated.',
      '',
      '## Affected files',
      '- TBD',
      '',
      '## Risks',
      '- TBD',
      '',
      '## Step-by-step plan',
      '1. TBD',
      '',
      '## Validation',
      validation
    ].join('\n')
  );

  writeFile(
    HANDOFF_PATH,
    [
      '# AI Handoff for Codex',
      '',
      '## Task',
      task,
      '',
      '## Required changes',
      '- TBD',
      '',
      '## Files to edit',
      '- TBD',
      '',
      '## Acceptance criteria',
      '- TBD',
      '',
      '## Validation commands',
      '```bash',
      '# add project-specific commands here',
      '```',
      '',
      '## Notes',
      'Keep changes minimal.'
    ].join('\n')
  );

  writeFile(
    REVIEW_PATH,
    [
      '# AI Review',
      '',
      '## Review target',
      task,
      '',
      '## Status',
      'PENDING',
      '',
      '## Required fixes',
      '- None yet.',
      '',
      '## Optional improvements',
      '- None yet.',
      '',
      '## Final review decision',
      '- PENDING'
    ].join('\n')
  );

  let statusMarkdown = readFile(STATUS_PATH);
  statusMarkdown = replaceSection(statusMarkdown, 'Current phase', 'PLANNING');
  statusMarkdown = replaceSection(statusMarkdown, 'Current task', task);
  statusMarkdown = replaceSection(statusMarkdown, 'Last update', `${nowIso()} by system`);
  statusMarkdown = replaceSection(statusMarkdown, 'Log', 'No workflow activity yet.');
  writeFile(STATUS_PATH, statusMarkdown);
  writePromptArtifacts('PLANNING');

  console.log(
    renderStatusBlock(
      {
        phase: 'PLANNING',
        currentTask: task,
        lastUpdate: extractSection(statusMarkdown, 'Last update')
      },
      {
        nextActor: inferNextActor('PLANNING'),
        promptFile: path.relative(ROOT, promptPathForPhase('PLANNING')),
        prompt: buildPrompt('PLANNING'),
        title: 'Portable-AI-Bus Initialized'
      }
    )
  );
}

function commandWatch(args) {
  validateStatus();
  const pollMs = Number.parseInt(args['poll-ms'] || '1500', 10);
  if (!Number.isFinite(pollMs) || pollMs < 250) {
    throw new Error('invalid --poll-ms; expected integer >= 250');
  }

  let previous = '';
  const printState = () => {
    const status = validateStatus();
    const snapshot = JSON.stringify(status);
    if (snapshot === previous) {
      return;
    }
    previous = snapshot;
    const nextActor = inferNextActor(status.phase);
    const prompt = buildPrompt(status.phase);
    writePromptArtifacts(status.phase);
    console.log(
      renderStatusBlock(status, {
        nextActor,
        prompt,
        promptFile: path.relative(ROOT, path.resolve(PROMPT_DIR, 'current.txt'))
      })
    );
    console.log('');
  };

  printState();
  setInterval(printState, pollMs);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  switch (command) {
    case 'validate':
      commandValidate();
      return;
    case 'status':
      commandStatus();
      return;
    case 'prompt':
      commandPrompt(args);
      return;
    case 'set-phase':
      commandSetPhase(args);
      return;
    case 'init':
      commandInit(args);
      return;
    case 'watch':
      commandWatch(args);
      return;
    default:
      throw new Error(
        'usage: node .ai-bus/bin/ai_bus.js <validate|status|prompt|set-phase|init|watch> [--phase PHASE] [--task TEXT]'
      );
  }
}

try {
  main();
} catch (err) {
  console.error(`ai_bus: ${err.message || err}`);
  process.exit(1);
}
