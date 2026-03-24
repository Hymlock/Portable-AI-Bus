import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const PHASES = [
  'PLANNING',
  'READY_FOR_CODEX',
  'CODEX_IN_PROGRESS',
  'READY_FOR_REVIEW',
  'CLAUDE_REVIEW_IN_PROGRESS',
  'READY_FOR_FIXES',
  'DONE'
] as const;

export type Phase = (typeof PHASES)[number];

type ProviderRecord = {
  id: string;
  displayName: string;
  markersAny?: string[];
  install?: Array<{ source: string; destination: string }>;
};

type ProvidersConfig = {
  providers: ProviderRecord[];
  recommendedPair: string[];
};

type Manifest = {
  installedAt: string;
  installedFiles: string[];
  providers: string[];
};

type SuspendMarker = {
  suspendedAt: string;
  installedFiles: string[];
};

export type BusStatus = {
  phase: Phase;
  currentTask: string;
  lastUpdate: string;
  log: string;
};

type BusPaths = {
  root: string;
  busDir: string;
  docsDir: string;
  statusPath: string;
  planPath: string;
  handoffPath: string;
  reviewPath: string;
  promptDir: string;
  runtimeDir: string;
  suspendedOverlayDir: string;
  suspendedMarkerPath: string;
  manifestPath: string;
  excludePath: string;
};

const SHARED_TEMPLATE_MAP = [
  { source: 'docs/ai-status.md', destination: 'docs/ai-status.md' },
  { source: 'docs/ai-plan.md', destination: 'docs/ai-plan.md' },
  { source: 'docs/ai-handoff.md', destination: 'docs/ai-handoff.md' },
  { source: 'docs/ai-review.md', destination: 'docs/ai-review.md' },
  { source: 'docs/ai-automation.md', destination: 'docs/ai-automation.md' }
];

const COMPATIBILITY_WRAPPERS = [
  { source: 'Portable-AI-Bus.cmd', destination: 'Portable-AI-Bus.cmd' },
  { source: 'Portable-AI-Bus.ps1', destination: 'Portable-AI-Bus.ps1' },
  { source: 'Start.cmd', destination: 'Start.cmd' },
  { source: 'Suspend.cmd', destination: 'Suspend.cmd' },
  { source: 'Resume.cmd', destination: 'Resume.cmd' },
  { source: 'Status.cmd', destination: 'Status.cmd' },
  { source: 'Prompt.cmd', destination: 'Prompt.cmd' },
  { source: 'Watch.cmd', destination: 'Watch.cmd' },
  { source: 'Remove.cmd', destination: 'Remove.cmd' }
];

const BASE_EXCLUDE_ENTRIES = [
  '.ai-bus/',
  'AGENTS.md',
  'CLAUDE.md',
  'docs/ai-status.md',
  'docs/ai-plan.md',
  'docs/ai-handoff.md',
  'docs/ai-review.md',
  'docs/ai-automation.md',
  'tmp/ai-prompts/'
];

const EXCLUDE_BLOCK_START = '# BEGIN AI_BUS_LOCAL';
const EXCLUDE_BLOCK_END = '# END AI_BUS_LOCAL';

export class WorkspaceBus {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async getWorkspaceRoot(): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      throw new Error('Open a workspace folder before using Portable AI Bus.');
    }
    return folder.uri.fsPath;
  }

  getConfiguration() {
    const config = vscode.workspace.getConfiguration('portableAiBus');
    return {
      instructionsFile: config.get<string>('instructionsFile', '.ai-bus/HUMAN_GUIDE.md'),
      providers: config.get<string[]>('providers', []),
      stageTasksJson: config.get<boolean>('stageTasksJson', false),
      stageCompatibilityWrappers: config.get<boolean>('stageCompatibilityWrappers', false),
      autoInitializeOnOpen: config.get<boolean>('autoInitializeOnOpen', false),
      showStatusBar: config.get<boolean>('showStatusBar', true)
    };
  }

  getPaths(root: string): BusPaths {
    const busDir = path.join(root, '.ai-bus');
    const docsDir = path.join(root, 'docs');
    const runtimeDir = path.join(busDir, 'runtime');
    return {
      root,
      busDir,
      docsDir,
      statusPath: path.join(docsDir, 'ai-status.md'),
      planPath: path.join(docsDir, 'ai-plan.md'),
      handoffPath: path.join(docsDir, 'ai-handoff.md'),
      reviewPath: path.join(docsDir, 'ai-review.md'),
      promptDir: path.join(root, 'tmp', 'ai-prompts'),
      runtimeDir,
      suspendedOverlayDir: path.join(runtimeDir, 'suspended-overlay'),
      suspendedMarkerPath: path.join(runtimeDir, 'suspended.json'),
      manifestPath: path.join(busDir, 'install-state.json'),
      excludePath: path.join(root, '.git', 'info', 'exclude')
    };
  }

  async initializeWorkspace(root: string, options?: { task?: string; goal?: string; validation?: string }) {
    await this.stageBundle(root);
    await this.installOverlay(root);
    if (options?.task) {
      await this.initTask(root, options);
    }
    return this.getStatus(root);
  }

  async installOverlay(root: string): Promise<Manifest> {
    const paths = this.getPaths(root);
    await this.stageBundle(root);
    await fs.mkdir(paths.busDir, { recursive: true });

    const config = await this.readProvidersConfig(paths.busDir);
    const selectedProviders = await this.resolveProvidersToInstall(root, config);
    const providerTemplateMap = this.getProviderTemplateMap(selectedProviders);
    const settings = this.getConfiguration();

    const templateMap = [...SHARED_TEMPLATE_MAP, ...providerTemplateMap];
    if (settings.stageCompatibilityWrappers) {
      templateMap.push(...COMPATIBILITY_WRAPPERS);
    }

    const installedFiles: string[] = [];
    for (const entry of templateMap) {
      const destination = path.join(root, entry.destination);
      await this.copyIfMissingOrManaged(paths.busDir, entry.source, destination);
      installedFiles.push(entry.destination.replace(/\\/g, '/'));
    }

    if (settings.stageTasksJson) {
      const tasksPath = path.join(root, '.vscode', 'tasks.json');
      const tasksTemplate = path.join(paths.busDir, 'templates', '.vscode', 'tasks.json');
      if (!(await this.exists(tasksPath))) {
        await fs.mkdir(path.dirname(tasksPath), { recursive: true });
        await fs.copyFile(tasksTemplate, tasksPath);
        installedFiles.push('.vscode/tasks.json');
      }
    }

    await this.updateExcludeFile(paths, [...BASE_EXCLUDE_ENTRIES, ...installedFiles]);

    const manifest: Manifest = {
      installedAt: new Date().toISOString(),
      installedFiles: Array.from(new Set(installedFiles)).sort(),
      providers: selectedProviders.map((provider) => provider.id)
    };

    await this.writeJson(paths.manifestPath, manifest);
    await this.ensurePromptArtifacts(root);
    return manifest;
  }

  async initTask(root: string, options: { task?: string; goal?: string; validation?: string }) {
    const paths = this.getPaths(root);
    await this.ensureActive(root);

    const task = options.task?.trim() || 'Describe the task here.';
    const goal = options.goal?.trim() || 'Define the desired outcome.';
    const validation = options.validation?.trim() || '- TBD';

    await this.writeFile(
      paths.planPath,
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

    await this.writeFile(
      paths.handoffPath,
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

    await this.writeFile(
      paths.reviewPath,
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

    let statusMarkdown = await this.readFile(paths.statusPath);
    statusMarkdown = this.replaceSection(statusMarkdown, 'Current phase', 'PLANNING');
    statusMarkdown = this.replaceSection(statusMarkdown, 'Current task', task);
    statusMarkdown = this.replaceSection(statusMarkdown, 'Last update', `${this.nowIso()} by system`);
    statusMarkdown = this.replaceSection(statusMarkdown, 'Log', 'No workflow activity yet.');
    await this.writeFile(paths.statusPath, statusMarkdown);
    await this.writePromptArtifacts(root, 'PLANNING');
  }

  async getStatus(root: string): Promise<BusStatus> {
    const paths = this.getPaths(root);
    await this.ensureActive(root);
    const markdown = await this.readFile(paths.statusPath);
    const status = this.parseStatus(markdown);
    if (!PHASES.includes(status.phase)) {
      throw new Error(`Invalid phase: ${status.phase}`);
    }
    return status;
  }

  async setPhase(
    root: string,
    phase: Phase,
    options?: {
      actor?: string;
      task?: string;
      summary?: string;
      tests?: string;
      files?: string;
      result?: string;
      next?: string;
    }
  ) {
    const paths = this.getPaths(root);
    await this.ensureActive(root);

    let statusMarkdown = await this.readFile(paths.statusPath);
    const previous = this.parseStatus(statusMarkdown);
    const actor = options?.actor?.trim() || this.inferNextActor(phase);
    const timestamp = this.nowIso();
    const task = options?.task?.trim() || previous.currentTask;
    const summary = options?.summary?.trim() || `Phase set to ${phase}.`;
    const tests = options?.tests?.trim() || 'Not specified.';
    const files = options?.files?.trim() || 'Not specified.';
    const result = options?.result?.trim() || 'Not specified.';
    const nextActor = options?.next?.trim() || this.inferNextActor(phase);

    statusMarkdown = this.replaceSection(statusMarkdown, 'Current phase', phase);
    statusMarkdown = this.replaceSection(statusMarkdown, 'Current task', task);
    statusMarkdown = this.replaceSection(statusMarkdown, 'Last update', `${timestamp} by ${actor}`);

    const existingLog = this.extractSection(statusMarkdown, 'Log');
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
    statusMarkdown = this.replaceSection(statusMarkdown, 'Log', log);
    await this.writeFile(paths.statusPath, statusMarkdown);
    await this.writePromptArtifacts(root, phase);
    return this.getStatus(root);
  }

  async getPrompt(root: string, phase?: Phase): Promise<string> {
    const effectivePhase = phase ?? (await this.getStatus(root)).phase;
    await this.writePromptArtifacts(root, effectivePhase);
    return this.buildPrompt(effectivePhase);
  }

  async suspend(root: string) {
    const paths = this.getPaths(root);
    await this.ensureActive(root);
    const manifest = await this.readManifest(paths.manifestPath);

    await fs.rm(paths.suspendedOverlayDir, { recursive: true, force: true });
    await fs.mkdir(paths.suspendedOverlayDir, { recursive: true });

    for (const relativePath of manifest.installedFiles) {
      const sourcePath = path.join(root, relativePath);
      if (!(await this.exists(sourcePath))) {
        continue;
      }
      const backupPath = path.join(paths.suspendedOverlayDir, relativePath);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.copyFile(sourcePath, backupPath);
      await fs.rm(sourcePath, { force: true, recursive: true });
    }

    await this.writeJson(paths.suspendedMarkerPath, {
      suspendedAt: this.nowIso(),
      installedFiles: manifest.installedFiles
    } satisfies SuspendMarker);
  }

  async resume(root: string) {
    const paths = this.getPaths(root);
    if (!(await this.exists(paths.suspendedMarkerPath))) {
      throw new Error('Portable AI Bus is not suspended in this workspace.');
    }

    const marker = await this.readJson<SuspendMarker>(paths.suspendedMarkerPath);
    for (const relativePath of marker.installedFiles) {
      const backupPath = path.join(paths.suspendedOverlayDir, relativePath);
      if (!(await this.exists(backupPath))) {
        continue;
      }
      const destinationPath = path.join(root, relativePath);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.copyFile(backupPath, destinationPath);
    }

    await fs.rm(paths.suspendedOverlayDir, { recursive: true, force: true });
    await fs.rm(paths.suspendedMarkerPath, { force: true });
    await this.ensurePromptArtifacts(root);
  }

  async remove(root: string) {
    const paths = this.getPaths(root);
    const manifest = (await this.exists(paths.manifestPath))
      ? await this.readManifest(paths.manifestPath)
      : { installedAt: '', installedFiles: [], providers: [] };

    for (const relativePath of manifest.installedFiles) {
      const targetPath = path.join(root, relativePath);
      if (await this.exists(targetPath)) {
        await fs.rm(targetPath, { force: true, recursive: true });
      }
    }

    await fs.rm(path.join(root, 'tmp', 'ai-prompts'), { recursive: true, force: true });
    await fs.rm(paths.busDir, { recursive: true, force: true });
    await this.clearExcludeFile(paths.excludePath);
  }

  async isInitialized(root: string): Promise<boolean> {
    return this.exists(this.getPaths(root).busDir);
  }

  async isSuspended(root: string): Promise<boolean> {
    return this.exists(this.getPaths(root).suspendedMarkerPath);
  }

  renderStatus(status: BusStatus): string {
    const nextActor = this.inferNextActor(status.phase);
    return this.renderStatusBlock(status, {
      nextActor,
      prompt: this.buildPrompt(status.phase),
      promptFile: 'tmp/ai-prompts/current.txt'
    });
  }

  phaseLabel(status?: BusStatus, suspended = false): string {
    if (suspended) {
      return 'AI Bus: Suspended';
    }
    if (!status) {
      return 'AI Bus: Inactive';
    }
    return `AI Bus: ${status.phase}`;
  }

  humanInstructionsPath(root: string): string {
    return path.join(root, this.getConfiguration().instructionsFile);
  }

  private async stageBundle(root: string) {
    const paths = this.getPaths(root);
    await fs.mkdir(paths.busDir, { recursive: true });

    const copies = [
      { from: 'bin', to: path.join(paths.busDir, 'bin') },
      { from: 'providers', to: path.join(paths.busDir, 'providers') },
      { from: 'templates', to: path.join(paths.busDir, 'templates') },
      { from: 'README.md', to: path.join(paths.busDir, 'README.md') },
      { from: 'HUMAN_GUIDE.md', to: path.join(paths.busDir, 'HUMAN_GUIDE.md') },
      { from: 'OPERATOR.md', to: path.join(paths.busDir, 'OPERATOR.md') }
    ];

    for (const entry of copies) {
      await this.copyFromExtension(entry.from, entry.to);
    }
  }

  private async ensureActive(root: string) {
    const paths = this.getPaths(root);
    if (await this.exists(paths.suspendedMarkerPath)) {
      throw new Error('Portable AI Bus is suspended. Resume it before using workflow actions.');
    }
    await this.requireFiles(root, [paths.statusPath, paths.planPath, paths.handoffPath, paths.reviewPath]);
  }

  private async ensurePromptArtifacts(root: string) {
    const paths = this.getPaths(root);
    if (!(await this.exists(paths.statusPath))) {
      return;
    }
    const status = await this.getStatus(root);
    await this.writePromptArtifacts(root, status.phase);
  }

  private async writePromptArtifacts(root: string, phase: Phase) {
    const paths = this.getPaths(root);
    await fs.mkdir(paths.promptDir, { recursive: true });
    const prompt = `${this.buildPrompt(phase)}\n`;
    await this.writeFile(path.join(paths.promptDir, `${phase.toLowerCase()}.txt`), prompt);
    await this.writeFile(path.join(paths.promptDir, 'current.txt'), prompt);
  }

  private async copyIfMissingOrManaged(busDir: string, sourceRelative: string, destinationPath: string) {
    const sourcePath = path.join(busDir, 'templates', sourceRelative);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (!(await this.exists(destinationPath))) {
      await fs.copyFile(sourcePath, destinationPath);
      return;
    }

    const [sourceContent, destinationContent] = await Promise.all([
      this.readFile(sourcePath),
      this.readFile(destinationPath)
    ]);

    if (destinationContent === sourceContent) {
      return;
    }

    const managedTargets = new Set(['AGENTS.md', 'CLAUDE.md']);
    if (managedTargets.has(path.basename(destinationPath))) {
      await fs.copyFile(sourcePath, destinationPath);
    }
  }

  private async readProvidersConfig(busDir: string): Promise<ProvidersConfig> {
    return this.readJson<ProvidersConfig>(path.join(busDir, 'providers', 'providers.json'));
  }

  private async resolveProvidersToInstall(root: string, config: ProvidersConfig): Promise<ProviderRecord[]> {
    const explicit = this.getConfiguration().providers.filter(Boolean);
    if (explicit.length > 0) {
      return explicit.map((id) => {
        const provider = config.providers.find((item) => item.id === id);
        if (!provider) {
          throw new Error(`Unknown provider in settings: ${id}`);
        }
        return provider;
      });
    }

    const detected: ProviderRecord[] = [];
    for (const provider of config.providers) {
      const markers = provider.markersAny ?? [];
      for (const marker of markers) {
        if (await this.exists(path.join(root, marker))) {
          detected.push(provider);
          break;
        }
      }
    }

    if (detected.length >= 2) {
      return detected;
    }

    return config.recommendedPair
      .map((id) => config.providers.find((provider) => provider.id === id))
      .filter((provider): provider is ProviderRecord => Boolean(provider));
  }

  private getProviderTemplateMap(providers: ProviderRecord[]) {
    return providers.flatMap((provider) => provider.install ?? []);
  }

  private async updateExcludeFile(paths: BusPaths, entries: string[]) {
    if (!(await this.exists(path.dirname(paths.excludePath)))) {
      return;
    }

    const uniqueEntries = Array.from(new Set(entries.map((entry) => entry.replace(/\\/g, '/')))).sort();
    let existing = '';
    if (await this.exists(paths.excludePath)) {
      existing = await this.readFile(paths.excludePath);
    }

    const escapedStart = this.escapeRegExp(EXCLUDE_BLOCK_START);
    const escapedEnd = this.escapeRegExp(EXCLUDE_BLOCK_END);
    const pattern = new RegExp(`(?ms)^${escapedStart}\\r?\\n.*?^${escapedEnd}\\r?\\n?`);
    const cleaned = existing.replace(pattern, '').trimEnd();
    const block = [EXCLUDE_BLOCK_START, ...uniqueEntries, EXCLUDE_BLOCK_END, ''].join('\n');
    const updated = cleaned ? `${cleaned}\n\n${block}` : block;
    await this.writeFile(paths.excludePath, updated);
  }

  private async clearExcludeFile(excludePath: string) {
    if (!(await this.exists(excludePath))) {
      return;
    }
    const existing = await this.readFile(excludePath);
    const escapedStart = this.escapeRegExp(EXCLUDE_BLOCK_START);
    const escapedEnd = this.escapeRegExp(EXCLUDE_BLOCK_END);
    const pattern = new RegExp(`(?ms)^${escapedStart}\\r?\\n.*?^${escapedEnd}\\r?\\n?`);
    const cleaned = existing.replace(pattern, '').trim();
    await this.writeFile(excludePath, cleaned ? `${cleaned}\n` : '');
  }

  private parseStatus(markdown: string): BusStatus {
    return {
      phase: this.extractSection(markdown, 'Current phase') as Phase,
      currentTask: this.extractSection(markdown, 'Current task'),
      lastUpdate: this.extractSection(markdown, 'Last update'),
      log: this.extractSection(markdown, 'Log')
    };
  }

  private buildPrompt(phase: Phase) {
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
    }
  }

  inferNextActor(phase: Phase) {
    switch (phase) {
      case 'PLANNING':
      case 'READY_FOR_REVIEW':
      case 'CLAUDE_REVIEW_IN_PROGRESS':
        return 'Claude';
      case 'READY_FOR_CODEX':
      case 'READY_FOR_FIXES':
      case 'CODEX_IN_PROGRESS':
        return 'Codex';
      case 'DONE':
        return 'None';
    }
  }

  private buildNextInstruction(phase: Phase, nextActor: string) {
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

  private renderStatusBlock(
    status: BusStatus,
    options: { nextActor: string; prompt: string; promptFile: string; title?: string }
  ) {
    const rows = [
      ['Phase', status.phase],
      ['Task', status.currentTask],
      ['Last update', status.lastUpdate],
      ['Next actor', options.nextActor]
    ];

    const fieldWidth = Math.max(...rows.map(([label]) => label.length), 'Field'.length);
    const valueWidth = Math.max(...rows.map(([, value]) => value.length), 'Value'.length);
    const border = `+${'-'.repeat(fieldWidth + 2)}+${'-'.repeat(valueWidth + 2)}+`;
    const lines = [
      options.title ?? 'Portable-AI-Bus Status',
      border,
      `| ${this.padCell('Field', fieldWidth)} | ${this.padCell('Value', valueWidth)} |`,
      border
    ];

    for (const [label, value] of rows) {
      lines.push(`| ${this.padCell(label, fieldWidth)} | ${this.padCell(value, valueWidth)} |`);
    }

    lines.push(border);
    lines.push('');
    lines.push('Next instructions');
    lines.push(`- ${this.buildNextInstruction(status.phase, options.nextActor)}`);
    lines.push(`- Prompt file: ${options.promptFile}`);
    lines.push('');
    lines.push('Next prompt');
    lines.push(options.prompt);
    return lines.join('\n');
  }

  private padCell(value: string, width: number) {
    return value.padEnd(width, ' ');
  }

  private extractSection(markdown: string, heading: string) {
    const pattern = new RegExp(`## ${this.escapeRegExp(heading)}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
    const match = markdown.match(pattern);
    if (!match) {
      throw new Error(`Missing section: ${heading}`);
    }
    return match[1].trim();
  }

  private replaceSection(markdown: string, heading: string, body: string) {
    const normalizedBody = body.trimEnd();
    const block = `## ${heading}\n${normalizedBody}\n`;
    const pattern = new RegExp(`## ${this.escapeRegExp(heading)}\\r?\\n([\\s\\S]*?)(?=\\r?\\n## |$)`);
    if (!pattern.test(markdown)) {
      throw new Error(`Missing section: ${heading}`);
    }
    return markdown.replace(pattern, block);
  }

  private async readManifest(manifestPath: string) {
    if (!(await this.exists(manifestPath))) {
      throw new Error('Portable AI Bus is not initialized in this workspace.');
    }
    return this.readJson<Manifest>(manifestPath);
  }

  private async copyFromExtension(sourceRelative: string, destinationPath: string) {
    const sourcePath = path.join(this.context.extensionUri.fsPath, sourceRelative);
    const sourceStat = await fs.stat(sourcePath);
    if (sourceStat.isDirectory()) {
      await fs.rm(destinationPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.cp(sourcePath, destinationPath, { recursive: true });
      return;
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(sourcePath, destinationPath);
  }

  private async requireFiles(root: string, filePaths: string[]) {
    for (const candidate of filePaths) {
      if (!(await this.exists(candidate))) {
        throw new Error(`Missing required AI Bus file: ${path.relative(root, candidate)}`);
      }
    }
  }

  private async exists(candidate: string) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      return false;
    }
  }

  private async readFile(filePath: string) {
    return fs.readFile(filePath, 'utf8');
  }

  private async writeFile(filePath: string, content: string) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  }

  private async readJson<T>(filePath: string): Promise<T> {
    const raw = await this.readFile(filePath);
    return JSON.parse(raw) as T;
  }

  private async writeJson(filePath: string, value: unknown) {
    await this.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private escapeRegExp(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private nowIso() {
    return new Date().toISOString();
  }
}
