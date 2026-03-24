const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join('.ai-bus', 'install-state.json');
const REQUIRED_FILES = [
  path.join('docs', 'ai-status.md'),
  path.join('docs', 'ai-plan.md'),
  path.join('docs', 'ai-handoff.md'),
  path.join('docs', 'ai-review.md')
];

const VALID_PHASES = new Set([
  'PLANNING',
  'READY_FOR_CODEX',
  'CODEX_IN_PROGRESS',
  'READY_FOR_REVIEW',
  'CLAUDE_REVIEW_IN_PROGRESS',
  'READY_FOR_FIXES',
  'DONE'
]);

function read(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`missing file: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function extractSection(markdown, heading) {
  const match = markdown.match(new RegExp(`## ${heading}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`));
  if (!match) {
    throw new Error(`missing section: ${heading}`);
  }
  return match[1].trim();
}

function main() {
  const manifest = JSON.parse(read(MANIFEST_PATH));
  const manifestFiles = Array.isArray(manifest.installedFiles) ? manifest.installedFiles : [];
  const filesToCheck = Array.from(new Set([...REQUIRED_FILES, ...manifestFiles]));

  filesToCheck.forEach((relativePath) => {
    read(relativePath);
  });

  const statusMarkdown = read(path.join('docs', 'ai-status.md'));
  const phase = extractSection(statusMarkdown, 'Current phase');
  const currentTask = extractSection(statusMarkdown, 'Current task');
  const lastUpdate = extractSection(statusMarkdown, 'Last update');
  const log = extractSection(statusMarkdown, 'Log');

  if (!VALID_PHASES.has(phase)) {
    throw new Error(`invalid current phase: ${phase}`);
  }
  if (!currentTask) {
    throw new Error('Current task must not be empty');
  }
  if (!lastUpdate) {
    throw new Error('Last update must not be empty');
  }
  if (!log) {
    throw new Error('Log must not be empty');
  }

  console.log(
    'validate_ai_bus:',
    JSON.stringify(
      {
        phase,
        currentTask,
        requiredFiles: filesToCheck.length,
        providers: manifest.providers || []
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (err) {
  console.error(`validate_ai_bus: ${err.message || err}`);
  process.exit(1);
}
