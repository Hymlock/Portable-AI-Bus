import * as vscode from 'vscode';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MailboxStore } from './mailbox';
import { credentialWorkspaceKey } from './workspace-key';

export const PHASES = [
  'PLANNING',
  'READY_FOR_IMPLEMENTATION',
  'IMPLEMENTATION_IN_PROGRESS',
  'READY_FOR_REVIEW',
  'REVIEW_IN_PROGRESS',
  'READY_FOR_FIXES',
  'DONE'
] as const;

export type Phase = (typeof PHASES)[number];

const LEGACY_PHASE_ALIASES: Record<string, Phase> = {
  READY_FOR_CODEX: 'READY_FOR_IMPLEMENTATION',
  CODEX_IN_PROGRESS: 'IMPLEMENTATION_IN_PROGRESS',
  CLAUDE_REVIEW_IN_PROGRESS: 'REVIEW_IN_PROGRESS'
};

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
  schemaVersion?: 1 | 2;
  installedAt: string;
  installedFiles: string[];
  managedFiles?: Record<string, string>;
  providers: string[];
};

type SuspendMarker = {
  suspendedAt: string;
  installedFiles: string[];
};

type OwnershipLedger = {
  schemaVersion: 1;
  workspaceKey: string;
  managedFiles: Record<string, string>;
  suspendedFiles?: string[];
  pendingInstall?: { relativePath: string; previousHash?: string; nextHash: string };
  mac: string;
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
  'tmp/ai-prompts/'
];

const ALLOWED_OVERLAY_DESTINATIONS = new Set([
  ...SHARED_TEMPLATE_MAP,
  ...COMPATIBILITY_WRAPPERS,
  { source: '', destination: 'AGENTS.md' },
  { source: '', destination: 'CLAUDE.md' },
  { source: '', destination: 'GROK.md' },
  { source: '', destination: '.vscode/tasks.json' }
].map((entry) => entry.destination.replace(/\\/g, '/')));

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
      showStatusBar: config.get<boolean>('showStatusBar', true),
      plannerSeat: this.configuredSeat(config.get<string>('workflow.plannerSeat', 'claude'), 'workflow.plannerSeat'),
      implementerSeat: this.configuredSeat(config.get<string>('workflow.implementerSeat', 'codex'), 'workflow.implementerSeat'),
      reviewerSeat: this.configuredSeat(config.get<string>('workflow.reviewerSeat', 'claude'), 'workflow.reviewerSeat')
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
    return this.withOverlayLock(root, async () => {
      await this.installOverlayUnlocked(root);
      if (options?.task) await this.initTaskUnlocked(root, options);
      return this.getStatus(root);
    });
  }

  async installOverlay(root: string): Promise<Manifest> {
    return this.withOverlayLock(root, () => this.installOverlayUnlocked(root));
  }

  private async installOverlayUnlocked(root: string): Promise<Manifest> {
    const paths = this.getPaths(root);
    await this.stageBundle(root);
    const previousOwnership = await this.reconcilePendingInstall(root, await this.readOwnershipLedger(root));
    if (previousOwnership?.suspendedFiles) {
      throw new Error('Resume or remove the suspended overlay before reinitializing it.');
    }
    await fs.mkdir(paths.busDir, { recursive: true });
    const capabilitiesPath = path.join(paths.busDir, 'capabilities.json');
    await this.assertContainedPath(root, capabilitiesPath, 'workspace capability configuration');
    if (!(await this.exists(capabilitiesPath))) {
      await fs.copyFile(path.join(paths.busDir, 'templates', 'capabilities.json'), capabilitiesPath);
    }

    const config = await this.readProvidersConfig(paths.busDir);
    const selectedProviders = await this.resolveProvidersToInstall(root, config);
    const providerTemplateMap = this.getProviderTemplateMap(selectedProviders);
    const settings = this.getConfiguration();

    const templateMap = [...SHARED_TEMPLATE_MAP, ...providerTemplateMap];
    if (settings.stageCompatibilityWrappers) {
      templateMap.push(...COMPATIBILITY_WRAPPERS);
    }

    const managedFiles: Record<string, string> = { ...(previousOwnership?.managedFiles ?? {}) };
    const installedFiles: string[] = this.trustedOwnedFiles(managedFiles);
    for (const entry of templateMap) {
      const relative = entry.destination.replace(/\\/g, '/');
      const destination = path.join(root, entry.destination);
      const templateHash = await this.copyOwnedOverlay(
        paths.busDir,
        entry.source,
        destination,
        managedFiles[relative],
        async (nextHash) => {
          const previousHash = managedFiles[relative];
          await this.writeOwnershipLedger(root, {
            managedFiles,
            pendingInstall: { relativePath: relative, ...(previousHash ? { previousHash } : {}), nextHash }
          });
        }
      );
      if (templateHash) {
        installedFiles.push(relative);
        managedFiles[relative] = templateHash;
        await this.writeOwnershipLedger(root, { managedFiles });
      }
    }

    if (settings.stageTasksJson) {
      const tasksPath = path.join(root, '.vscode', 'tasks.json');
      const relative = '.vscode/tasks.json';
      const templateHash = await this.copyOwnedOverlay(
        paths.busDir,
        '.vscode/tasks.json',
        tasksPath,
        managedFiles[relative],
        async (nextHash) => {
          const previousHash = managedFiles[relative];
          await this.writeOwnershipLedger(root, {
            managedFiles,
            pendingInstall: { relativePath: relative, ...(previousHash ? { previousHash } : {}), nextHash }
          });
        }
      );
      if (templateHash) {
        installedFiles.push(relative);
        managedFiles[relative] = templateHash;
        await this.writeOwnershipLedger(root, { managedFiles });
      }
    }

    await this.updateExcludeFile(paths, [...BASE_EXCLUDE_ENTRIES, ...installedFiles]);

    const manifest: Manifest = {
      schemaVersion: 2,
      installedAt: new Date().toISOString(),
      installedFiles: Array.from(new Set(installedFiles)).sort(),
      managedFiles,
      providers: selectedProviders.map((provider) => provider.id)
    };

    const workflowPath = path.join(paths.busDir, 'workflow.json');
    await this.assertContainedPath(root, workflowPath, 'workspace workflow configuration');
    await this.assertContainedPath(root, paths.manifestPath, 'workspace install manifest');
    await this.writeJson(workflowPath, {
      schemaVersion: 1,
      roles: {
        planner: settings.plannerSeat,
        implementer: settings.implementerSeat,
        reviewer: settings.reviewerSeat
      }
    });
    await this.writeJson(paths.manifestPath, manifest);
    await this.writeOwnershipLedger(root, { managedFiles });
    const assignedSeats = [settings.plannerSeat, settings.implementerSeat, settings.reviewerSeat];
    await new MailboxStore(root).ensureInitialized(Array.from(new Set([
      ...selectedProviders.map((provider) => provider.id),
      ...assignedSeats
    ])));
    await this.ensurePromptArtifacts(root);
    return manifest;
  }

  async initTask(root: string, options: { task?: string; goal?: string; validation?: string }) {
    return this.withOverlayLock(root, () => this.initTaskUnlocked(root, options));
  }

  private async initTaskUnlocked(root: string, options: { task?: string; goal?: string; validation?: string }) {
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
        '# AI Handoff',
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
    return this.withOverlayLock(root, () => this.setPhaseUnlocked(root, phase, options));
  }

  private async setPhaseUnlocked(
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
    return this.withOverlayLock(root, async () => {
      await this.ensureActive(root);
      const effectivePhase = phase ?? (await this.getStatus(root)).phase;
      await this.writePromptArtifacts(root, effectivePhase);
      return this.buildPrompt(effectivePhase);
    });
  }

  async suspend(root: string) {
    return this.withOverlayLock(root, () => this.suspendUnlocked(root));
  }

  private async suspendUnlocked(root: string) {
    const paths = this.getPaths(root);
    await this.ensureActive(root);
    await this.readManifest(paths.manifestPath);
    const ownership = await this.requireOwnershipLedger(root);
    if (ownership.suspendedFiles) throw new Error('Portable AI Bus ownership state is already suspended.');
    const ownedFiles = this.trustedOwnedFiles(ownership.managedFiles);
    const presentFiles: string[] = [];
    for (const relativePath of ownedFiles) {
      const sourcePath = path.join(root, relativePath);
      await this.assertContainedPath(root, sourcePath, `overlay path ${relativePath}`);
      if (!(await this.exists(sourcePath))) {
        continue;
      }
      const sourceStat = await fs.lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Refusing to suspend non-file or symbolic-link overlay path: ${relativePath}`);
      }
      presentFiles.push(relativePath);
    }

    await this.assertContainedPath(root, paths.suspendedOverlayDir, 'suspended overlay directory');
    await fs.rm(paths.suspendedOverlayDir, { recursive: true, force: true });
    await fs.mkdir(paths.suspendedOverlayDir, { recursive: true });
    await this.assertContainedPath(root, paths.suspendedOverlayDir, 'suspended overlay directory');

    await this.writeOwnershipLedger(root, { managedFiles: ownership.managedFiles, suspendedFiles: presentFiles });
    await this.writeJson(paths.suspendedMarkerPath, {
      suspendedAt: this.nowIso(),
      installedFiles: presentFiles
    } satisfies SuspendMarker);

    for (const relativePath of presentFiles) {
      const sourcePath = path.join(root, relativePath);
      const backupPath = path.join(paths.suspendedOverlayDir, relativePath);
      await this.assertContainedPath(root, backupPath, `suspended overlay path ${relativePath}`);
      await fs.mkdir(path.dirname(backupPath), { recursive: true });
      await fs.rename(sourcePath, backupPath);
    }

  }

  async resume(root: string) {
    return this.withOverlayLock(root, () => this.resumeUnlocked(root));
  }

  private async resumeUnlocked(root: string) {
    const paths = this.getPaths(root);
    const [markerExists, ownership] = await Promise.all([
      this.exists(paths.suspendedMarkerPath),
      this.requireOwnershipLedger(root)
    ]);
    if (!ownership.suspendedFiles && !markerExists) {
      throw new Error('Portable AI Bus is not suspended in this workspace.');
    }
    if (!ownership.suspendedFiles) {
      await fs.rm(paths.suspendedOverlayDir, { recursive: true, force: true });
      await fs.rm(paths.suspendedMarkerPath, { force: true });
      await this.ensurePromptArtifacts(root);
      return;
    }
    const restoreFiles = this.trustedOwnedFiles(ownership.managedFiles, ownership.suspendedFiles ?? []);
    if (markerExists) {
      const marker = await this.readJson<SuspendMarker>(paths.suspendedMarkerPath);
      if (!Array.isArray(marker.installedFiles) || !this.sameStringSet(marker.installedFiles, restoreFiles)) {
        throw new Error('Suspended overlay marker does not match the external ownership ledger.');
      }
    }
    await this.restoreSuspendedOverlay(root, restoreFiles);

    await this.writeOwnershipLedger(root, { managedFiles: ownership.managedFiles });
    await fs.rm(paths.suspendedOverlayDir, { recursive: true, force: true });
    await fs.rm(paths.suspendedMarkerPath, { force: true });
    await this.ensurePromptArtifacts(root);
  }

  async remove(root: string) {
    return this.withOverlayLock(root, () => this.removeUnlocked(root));
  }

  private async removeUnlocked(root: string) {
    const paths = this.getPaths(root);
    const ownership = await this.readOwnershipLedger(root);
    if (ownership?.suspendedFiles) {
      const restoreFiles = this.trustedOwnedFiles(ownership.managedFiles, ownership.suspendedFiles);
      await this.restoreSuspendedOverlay(root, restoreFiles);
      await this.writeOwnershipLedger(root, { managedFiles: ownership.managedFiles });
      await fs.rm(paths.suspendedOverlayDir, { recursive: true, force: true });
      await fs.rm(paths.suspendedMarkerPath, { force: true });
    }

    for (const relativePath of this.trustedOwnedFiles(ownership?.managedFiles ?? {})) {
      const targetPath = path.join(root, relativePath);
      await this.assertContainedPath(root, targetPath, `overlay path ${relativePath}`);
      const expectedHash = ownership?.managedFiles[relativePath];
      if (await this.exists(targetPath) && expectedHash && await this.fileHash(targetPath) === expectedHash) {
        await fs.rm(targetPath, { force: true, recursive: true });
      }
    }

    await this.assertContainedPath(root, path.join(root, 'tmp', 'ai-prompts'), 'prompt artifact directory');
    await this.assertContainedPath(root, paths.busDir, 'workspace bus directory');
    await fs.rm(path.join(root, 'tmp', 'ai-prompts'), { recursive: true, force: true });
    const preservedToolchains = await this.removeBusDirectoryPreservingToolchains(paths);
    if (preservedToolchains) {
      // Toolchains are operator-owned payloads, not staged Bus files. Keep the surviving
      // directory out of Git after uninstalling the broader `.ai-bus/` exclusion.
      await this.updateExcludeFile(paths, ['.ai-bus/toolchains/']);
    } else {
      await this.clearExcludeFile(paths);
    }
    await fs.rm(this.ownershipLedgerPath(root), { force: true });
  }

  private async removeBusDirectoryPreservingToolchains(paths: BusPaths): Promise<boolean> {
    let entries: string[];
    try {
      entries = await fs.readdir(paths.busDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }

    const preservedToolchains = entries.includes('toolchains');
    for (const entry of entries) {
      if (entry === 'toolchains') continue;
      // `entry` came from readdir rather than caller input. Removing each immediate child
      // also unlinks a hostile junction instead of traversing it, while the containing
      // `.ai-bus` path has already passed assertContainedPath above.
      await fs.rm(path.join(paths.busDir, entry), { recursive: true, force: true });
    }
    if (!preservedToolchains) {
      await fs.rm(paths.busDir, { recursive: true, force: true });
    }
    return preservedToolchains;
  }

  async isInitialized(root: string): Promise<boolean> {
    const paths = this.getPaths(root);
    return (await this.exists(paths.manifestPath)) &&
      (await this.exists(path.join(paths.busDir, 'bin', 'mailbox.js'))) &&
      (await this.exists(path.join(paths.busDir, 'providers', 'providers.json')));
  }

  async isSuspended(root: string): Promise<boolean> {
    const [marker, ownership] = await Promise.all([
      this.exists(this.getPaths(root).suspendedMarkerPath),
      this.readOwnershipLedger(root)
    ]);
    return marker || ownership?.suspendedFiles !== undefined;
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
    await this.assertContainedPath(root, paths.busDir, 'workspace bus directory');
    await fs.mkdir(paths.busDir, { recursive: true });
    await this.assertContainedPath(root, paths.busDir, 'workspace bus directory');

    const copies = [
      { from: 'bin', to: path.join(paths.busDir, 'bin') },
      { from: 'dist/mailbox.js', to: path.join(paths.busDir, 'bin', 'mailbox.js') },
      { from: 'dist/capabilities.js', to: path.join(paths.busDir, 'bin', 'capabilities.js') },
      { from: 'dist/harness.js', to: path.join(paths.busDir, 'bin', 'harness.js') },
      { from: 'dist/worker-client.js', to: path.join(paths.busDir, 'bin', 'worker-client.js') },
      { from: 'dist/workspace-key.js', to: path.join(paths.busDir, 'bin', 'workspace-key.js') },
      { from: 'dist/adapters/skse-devkit.js', to: path.join(paths.busDir, 'bin', 'skse-devkit.js') },
      { from: 'dist/brain', to: path.join(paths.busDir, 'bin', 'brain') },
      { from: 'brains', to: path.join(paths.busDir, 'brains') },
      { from: 'scripts/bus-up.js', to: path.join(paths.busDir, 'scripts', 'bus-up.js') },
      { from: 'scripts/bus-console.js', to: path.join(paths.busDir, 'scripts', 'bus-console.js') },
      { from: 'scripts/bus-tick.js', to: path.join(paths.busDir, 'scripts', 'bus-tick.js') },
      { from: 'node_modules/node-pty', to: path.join(paths.busDir, 'node_modules', 'node-pty') },
      { from: 'node_modules/@anthropic-ai/sdk', to: path.join(paths.busDir, 'node_modules', '@anthropic-ai', 'sdk') },
      { from: 'node_modules/@babel/runtime', to: path.join(paths.busDir, 'node_modules', '@babel', 'runtime') },
      { from: 'node_modules/@stablelib/base64', to: path.join(paths.busDir, 'node_modules', '@stablelib', 'base64') },
      { from: 'node_modules/fast-sha256', to: path.join(paths.busDir, 'node_modules', 'fast-sha256') },
      { from: 'node_modules/json-schema-to-ts', to: path.join(paths.busDir, 'node_modules', 'json-schema-to-ts') },
      { from: 'node_modules/standardwebhooks', to: path.join(paths.busDir, 'node_modules', 'standardwebhooks') },
      { from: 'node_modules/ts-algebra', to: path.join(paths.busDir, 'node_modules', 'ts-algebra') },
      { from: 'providers', to: path.join(paths.busDir, 'providers') },
      { from: 'templates', to: path.join(paths.busDir, 'templates') },
      { from: 'docs', to: path.join(paths.busDir, 'docs') },
      { from: 'README.md', to: path.join(paths.busDir, 'README.md') },
      { from: 'HUMAN_GUIDE.md', to: path.join(paths.busDir, 'HUMAN_GUIDE.md') },
      { from: 'OPERATOR.md', to: path.join(paths.busDir, 'OPERATOR.md') },
      { from: 'TESTING.md', to: path.join(paths.busDir, 'TESTING.md') }
    ];

    for (const entry of copies) {
      await this.copyFromExtension(root, entry.from, entry.to);
    }
  }

  private async ensureActive(root: string) {
    const paths = this.getPaths(root);
    for (const candidate of [paths.statusPath, paths.planPath, paths.handoffPath, paths.reviewPath, paths.promptDir]) {
      await this.assertContainedPath(root, candidate, `workflow path ${path.relative(root, candidate)}`);
    }
    const [marker, ownership] = await Promise.all([
      this.exists(paths.suspendedMarkerPath),
      this.readOwnershipLedger(root)
    ]);
    if (marker || ownership?.suspendedFiles !== undefined) {
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

  private async copyOwnedOverlay(
    busDir: string,
    sourceRelative: string,
    destinationPath: string,
    previousTemplateHash?: string,
    beforeCopy?: (nextHash: string) => Promise<void>
  ): Promise<string | undefined> {
    const sourcePath = path.join(busDir, 'templates', sourceRelative);
    const root = path.dirname(busDir);
    await this.assertContainedPath(root, destinationPath, `overlay destination ${path.relative(root, destinationPath)}`);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await this.assertContainedPath(root, destinationPath, `overlay destination ${path.relative(root, destinationPath)}`);
    const sourceHash = await this.fileHash(sourcePath);
    if (!(await this.exists(destinationPath))) {
      await beforeCopy?.(sourceHash);
      await this.atomicCopyFile(sourcePath, destinationPath);
      return sourceHash;
    }

    if (!previousTemplateHash) return undefined;
    if (!/^[a-f0-9]{64}$/.test(previousTemplateHash)) return undefined;
    const destinationStat = await fs.lstat(destinationPath);
    if (!destinationStat.isFile() || destinationStat.isSymbolicLink()) {
      throw new Error(`Refusing to update non-file or symbolic-link overlay path: ${destinationPath}`);
    }
    const destinationHash = await this.fileHash(destinationPath);
    if (destinationHash === previousTemplateHash) {
      await beforeCopy?.(sourceHash);
      await this.atomicCopyFile(sourcePath, destinationPath);
      return sourceHash;
    }
    return previousTemplateHash;
  }

  private trustedOwnedFiles(managedFiles: Record<string, string>, candidates = Object.keys(managedFiles)) {
    if (!managedFiles || typeof managedFiles !== 'object' || Array.isArray(managedFiles) || !Array.isArray(candidates)) return [];
    return Array.from(new Set(candidates.filter((relativePath) =>
      typeof relativePath === 'string' &&
      ALLOWED_OVERLAY_DESTINATIONS.has(relativePath) &&
      /^[a-f0-9]{64}$/.test(managedFiles[relativePath] ?? '')
    )));
  }

  private ownershipLedgerPath(root: string) {
    return path.join(this.ownershipDirectory(), `${credentialWorkspaceKey(root)}.json`);
  }

  private ownershipDirectory() {
    return path.join(os.homedir(), '.portable-ai-bus', 'ownership');
  }

  private ownershipKeyPath() {
    return path.join(this.ownershipDirectory(), 'ledger.key');
  }

  private overlayLockPath(root: string) {
    return path.join(this.ownershipDirectory(), `${credentialWorkspaceKey(root)}.lock`);
  }

  private async withOverlayLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.overlayLockPath(root);
    await this.assertContainedPath(os.homedir(), lockPath, 'external overlay lock');
    await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    await this.assertContainedPath(os.homedir(), lockPath, 'external overlay lock');
    const token = randomUUID();
    const candidate = `${lockPath}.${process.pid}.${token}.candidate`;
    await fs.mkdir(candidate, { mode: 0o700 });
    await fs.writeFile(path.join(candidate, 'owner.json'), `${JSON.stringify({ pid: process.pid, token, acquiredAt: this.nowIso() })}\n`, { mode: 0o600 });
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 4 && !acquired; attempt += 1) {
        try {
          await fs.rename(candidate, lockPath);
          acquired = true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') throw error;
          const owner = await this.readJson<{ pid?: unknown; token?: unknown }>(path.join(lockPath, 'owner.json')).catch(() => undefined);
          if (!owner || !Number.isInteger(owner.pid) || (owner.pid as number) < 1 || typeof owner.token !== 'string') {
            throw new Error(`Overlay lifecycle lock is malformed: ${lockPath}`);
          }
          if (this.processAlive(owner.pid as number)) {
            throw new Error(`Another process (${owner.pid}) owns the overlay lifecycle lock.`);
          }
          const stale = `${lockPath}.stale.${token}`;
          try {
            await fs.rename(lockPath, stale);
            await fs.rm(stale, { recursive: true, force: true });
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code !== 'ENOENT') throw recoveryError;
          }
        }
      }
      if (!acquired) throw new Error('Could not acquire the overlay lifecycle lock.');
      return await operation();
    } finally {
      await fs.rm(candidate, { recursive: true, force: true });
      if (acquired) {
        const owner = await this.readJson<{ token?: string }>(path.join(lockPath, 'owner.json')).catch(() => undefined);
        if (owner?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
      }
    }
  }

  private processAlive(pid: number) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  private async readOwnershipLedger(root: string): Promise<OwnershipLedger | undefined> {
    const ledgerPath = this.ownershipLedgerPath(root);
    await this.assertContainedPath(os.homedir(), ledgerPath, 'external ownership ledger');
    if (!(await this.exists(ledgerPath))) return undefined;
    const ledger = await this.readJson<OwnershipLedger>(ledgerPath);
    const workspaceKey = credentialWorkspaceKey(root);
    if (ledger.schemaVersion !== 1 || ledger.workspaceKey !== workspaceKey ||
        !ledger.managedFiles || typeof ledger.managedFiles !== 'object' || Array.isArray(ledger.managedFiles) ||
        (ledger.suspendedFiles !== undefined && !Array.isArray(ledger.suspendedFiles)) ||
        !/^[a-f0-9]{64}$/.test(ledger.mac ?? '') ||
        (ledger.pendingInstall !== undefined && (
          !ledger.pendingInstall || typeof ledger.pendingInstall !== 'object' ||
          !ALLOWED_OVERLAY_DESTINATIONS.has(ledger.pendingInstall.relativePath) ||
          !/^[a-f0-9]{64}$/.test(ledger.pendingInstall.nextHash) ||
          (ledger.pendingInstall.previousHash !== undefined && !/^[a-f0-9]{64}$/.test(ledger.pendingInstall.previousHash))
        ))) {
      throw new Error('Portable AI Bus external ownership ledger is invalid.');
    }
    const key = await this.readOwnershipKey(false);
    if (!key || !this.validOwnershipMac(ledger, key)) {
      throw new Error('Portable AI Bus external ownership ledger failed its integrity check.');
    }
    if (this.trustedOwnedFiles(ledger.managedFiles).length !== Object.keys(ledger.managedFiles).length) {
      throw new Error('Portable AI Bus external ownership ledger contains an invalid path or hash.');
    }
    if (ledger.suspendedFiles && (ledger.suspendedFiles.length !== new Set(ledger.suspendedFiles).size ||
        this.trustedOwnedFiles(ledger.managedFiles, ledger.suspendedFiles).length !== ledger.suspendedFiles.length)) {
      throw new Error('Portable AI Bus external ownership ledger contains an invalid suspended path.');
    }
    return ledger;
  }

  private async reconcilePendingInstall(root: string, ledger: OwnershipLedger | undefined) {
    if (!ledger?.pendingInstall) return ledger;
    const pending = ledger.pendingInstall;
    const candidate = path.join(root, pending.relativePath);
    await this.assertContainedPath(root, candidate, `pending overlay path ${pending.relativePath}`);
    const exists = await this.exists(candidate);
    const currentHash = exists ? await this.fileHash(candidate) : undefined;
    const managedFiles = { ...ledger.managedFiles };
    if (currentHash === pending.nextHash) managedFiles[pending.relativePath] = pending.nextHash;
    else if (pending.previousHash) managedFiles[pending.relativePath] = pending.previousHash;
    else delete managedFiles[pending.relativePath];
    const reconciled = {
      managedFiles,
      ...(ledger.suspendedFiles ? { suspendedFiles: ledger.suspendedFiles } : {})
    };
    await this.writeOwnershipLedger(root, reconciled);
    return this.readOwnershipLedger(root);
  }

  private async requireOwnershipLedger(root: string) {
    const ledger = await this.readOwnershipLedger(root);
    if (!ledger) throw new Error('External overlay ownership evidence is missing; refusing a destructive operation. Reinitialize to establish ownership safely.');
    return ledger;
  }

  private async writeOwnershipLedger(root: string, value: Pick<OwnershipLedger, 'managedFiles'> & Partial<Pick<OwnershipLedger, 'suspendedFiles' | 'pendingInstall'>>) {
    const workspaceKey = credentialWorkspaceKey(root);
    const ledgerPath = this.ownershipLedgerPath(root);
    await this.assertContainedPath(os.homedir(), ledgerPath, 'external ownership ledger');
    const temporary = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true, mode: 0o700 });
    await this.assertContainedPath(os.homedir(), ledgerPath, 'external ownership ledger');
    const key = await this.readOwnershipKey(true);
    const unsigned = { schemaVersion: 1 as const, workspaceKey, ...value };
    const ledger = { ...unsigned, mac: this.ownershipMac(unsigned, key as Buffer) };
    try {
      await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, ledgerPath);
      await fs.chmod(ledgerPath, 0o600).catch(() => undefined);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async readOwnershipKey(create: boolean): Promise<Buffer | undefined> {
    const keyPath = this.ownershipKeyPath();
    await this.assertContainedPath(os.homedir(), keyPath, 'external ownership key');
    try {
      const encoded = (await fs.readFile(keyPath, 'utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(encoded)) throw new Error('Portable AI Bus ownership key is malformed.');
      return Buffer.from(encoded, 'hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    }
    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const encoded = randomBytes(32).toString('hex');
    try {
      await fs.writeFile(keyPath, `${encoded}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return Buffer.from(encoded, 'hex');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.readOwnershipKey(false);
    }
  }

  private ownershipMac(value: Omit<OwnershipLedger, 'mac'>, key: Buffer) {
    return createHmac('sha256', key).update(this.stableJson(value)).digest('hex');
  }

  private validOwnershipMac(ledger: OwnershipLedger, key: Buffer) {
    const { mac, ...unsigned } = ledger;
    const expected = Buffer.from(this.ownershipMac(unsigned, key), 'hex');
    const actual = Buffer.from(mac, 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableJson(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private async restoreSuspendedOverlay(root: string, restoreFiles: string[]) {
    const paths = this.getPaths(root);
    const operations: Array<{ backupPath: string; destinationPath: string; relativePath: string }> = [];
    for (const relativePath of restoreFiles) {
      const backupPath = path.join(paths.suspendedOverlayDir, relativePath);
      const destinationPath = path.join(root, relativePath);
      await this.assertContainedPath(root, backupPath, `suspended overlay path ${relativePath}`);
      await this.assertContainedPath(root, destinationPath, `overlay destination ${relativePath}`);
      const [backupExists, destinationExists] = await Promise.all([this.exists(backupPath), this.exists(destinationPath)]);
      if (backupExists && destinationExists) {
        throw new Error(`Refusing to overwrite a file created while suspended: ${relativePath}`);
      }
      if (!backupExists && !destinationExists) {
        throw new Error(`Suspended overlay path is missing from both active and backup locations: ${relativePath}`);
      }
      if (!backupExists) continue; // A crash may have occurred before this file was moved.
      const backupStat = await fs.lstat(backupPath);
      if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
        throw new Error(`Refusing to restore non-file or symbolic-link overlay path: ${relativePath}`);
      }
      operations.push({ backupPath, destinationPath, relativePath });
    }
    for (const operation of operations) {
      await fs.mkdir(path.dirname(operation.destinationPath), { recursive: true });
      await this.assertContainedPath(root, operation.destinationPath, `overlay destination ${operation.relativePath}`);
      await fs.rename(operation.backupPath, operation.destinationPath);
    }
  }

  private sameStringSet(left: string[], right: string[]) {
    return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item));
  }

  private async assertContainedPath(base: string, candidate: string, label: string) {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(candidate);
    const lexical = path.relative(resolvedBase, resolvedCandidate);
    if (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical)) {
      throw new Error(`Refusing ${label} outside its root: ${resolvedCandidate}`);
    }
    const canonicalBase = await fs.realpath(resolvedBase);
    let existing = resolvedCandidate;
    while (true) {
      try {
        await fs.lstat(existing);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(existing);
        if (parent === existing) throw new Error(`Cannot resolve a safe ancestor for ${label}.`);
        existing = parent;
      }
    }
    const canonicalExisting = await fs.realpath(existing);
    const physical = path.relative(canonicalBase, canonicalExisting);
    if (physical === '..' || physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) {
      throw new Error(`Refusing ${label} through an ancestor outside its root: ${resolvedCandidate}`);
    }
  }

  private async fileHash(candidate: string) {
    return createHash('sha256').update(await fs.readFile(candidate)).digest('hex');
  }

  private async atomicCopyFile(source: string, destination: string) {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.copyFile(source, temporary);
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true });
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
    await this.assertContainedPath(paths.root, paths.excludePath, 'Git exclude file');
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
    const pattern = new RegExp(`^${escapedStart}\\r?\\n.*?^${escapedEnd}\\r?\\n?`, 'ms');
    const cleaned = existing.replace(pattern, '').trimEnd();
    const block = [EXCLUDE_BLOCK_START, ...uniqueEntries, EXCLUDE_BLOCK_END, ''].join('\n');
    const updated = cleaned ? `${cleaned}\n\n${block}` : block;
    await this.writeFile(paths.excludePath, updated);
  }

  private async clearExcludeFile(paths: BusPaths) {
    const excludePath = paths.excludePath;
    await this.assertContainedPath(paths.root, excludePath, 'Git exclude file');
    if (!(await this.exists(excludePath))) {
      return;
    }
    const existing = await this.readFile(excludePath);
    const escapedStart = this.escapeRegExp(EXCLUDE_BLOCK_START);
    const escapedEnd = this.escapeRegExp(EXCLUDE_BLOCK_END);
    const pattern = new RegExp(`^${escapedStart}\\r?\\n.*?^${escapedEnd}\\r?\\n?`, 'ms');
    const cleaned = existing.replace(pattern, '').trim();
    await this.writeFile(excludePath, cleaned ? `${cleaned}\n` : '');
  }

  private parseStatus(markdown: string): BusStatus {
    const rawPhase = this.extractSection(markdown, 'Current phase');
    const phase = (PHASES as readonly string[]).includes(rawPhase)
      ? rawPhase as Phase
      : LEGACY_PHASE_ALIASES[rawPhase];
    if (!phase) throw new Error(`Invalid phase: ${rawPhase}`);
    return {
      phase,
      currentTask: this.extractSection(markdown, 'Current task'),
      lastUpdate: this.extractSection(markdown, 'Last update'),
      log: this.extractSection(markdown, 'Log')
    };
  }

  private buildPrompt(phase: Phase) {
    switch (phase) {
      case 'PLANNING':
        return [
          `You are the assigned planning seat: ${this.getConfiguration().plannerSeat}.`,
          'Read the repository instructions plus docs/ai-status.md, docs/ai-plan.md, docs/ai-handoff.md, and docs/ai-review.md.',
          'For the current user task, inspect the repo and write:',
          '- a brief plan in docs/ai-plan.md',
          '- exact implementation steps in docs/ai-handoff.md',
          'Then update docs/ai-status.md to READY_FOR_IMPLEMENTATION.',
          'Do not implement code.'
        ].join('\n');
      case 'READY_FOR_IMPLEMENTATION':
        return [
          `You are the assigned implementation seat: ${this.getConfiguration().implementerSeat}.`,
          'Read the repository instructions plus docs/ai-status.md, docs/ai-handoff.md, and docs/ai-review.md.',
          'Implement the current task from docs/ai-handoff.md.',
          'Make minimal targeted changes.',
          'Run validation if available.',
          'Then update docs/ai-status.md to READY_FOR_REVIEW.'
        ].join('\n');
      case 'READY_FOR_REVIEW':
        return [
          `You are the assigned review seat: ${this.getConfiguration().reviewerSeat}.`,
          'Read the repository instructions plus docs/ai-status.md, docs/ai-plan.md, docs/ai-handoff.md, and docs/ai-review.md.',
          'Review the current changes against the plan and acceptance criteria.',
          'Write required fixes to docs/ai-review.md.',
          'If acceptable, set docs/ai-status.md to DONE.',
          'If fixes are needed, set docs/ai-status.md to READY_FOR_FIXES.',
          'Do not implement code.'
        ].join('\n');
      case 'READY_FOR_FIXES':
        return [
          `You are the assigned implementation seat: ${this.getConfiguration().implementerSeat}.`,
          'Read the repository instructions plus docs/ai-status.md, docs/ai-handoff.md, and docs/ai-review.md.',
          'Apply the required fixes from docs/ai-review.md.',
          'Run validation if available.',
          'Then update docs/ai-status.md to READY_FOR_REVIEW.'
        ].join('\n');
      case 'DONE':
        return 'Workflow complete. Start a new task or reset docs/ai-status.md to PLANNING.';
      case 'IMPLEMENTATION_IN_PROGRESS':
        return `${this.getConfiguration().implementerSeat} is currently implementing. Wait for docs/ai-status.md to move to READY_FOR_REVIEW.`;
      case 'REVIEW_IN_PROGRESS':
        return `${this.getConfiguration().reviewerSeat} is currently reviewing. Wait for docs/ai-status.md to move to READY_FOR_FIXES or DONE.`;
    }
  }

  inferNextActor(phase: Phase) {
    const roles = this.getConfiguration();
    switch (phase) {
      case 'PLANNING':
        return roles.plannerSeat;
      case 'READY_FOR_REVIEW':
      case 'REVIEW_IN_PROGRESS':
        return roles.reviewerSeat;
      case 'READY_FOR_IMPLEMENTATION':
      case 'READY_FOR_FIXES':
      case 'IMPLEMENTATION_IN_PROGRESS':
        return roles.implementerSeat;
      case 'DONE':
        return 'None';
    }
  }

  private buildNextInstruction(phase: Phase, nextActor: string) {
    switch (phase) {
      case 'DONE':
        return 'Workflow complete. Start a new task or reset docs/ai-status.md to PLANNING.';
      case 'IMPLEMENTATION_IN_PROGRESS':
        return `${nextActor} is currently implementing. Wait for the phase to move to READY_FOR_REVIEW.`;
      case 'REVIEW_IN_PROGRESS':
        return `${nextActor} is currently reviewing. Wait for the phase to move to READY_FOR_FIXES or DONE.`;
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

  private async copyFromExtension(root: string, sourceRelative: string, destinationPath: string) {
    const sourcePath = path.join(this.context.extensionUri.fsPath, sourceRelative);
    await this.assertContainedPath(root, destinationPath, `staged bundle path ${path.relative(root, destinationPath)}`);
    const sourceStat = await fs.stat(sourcePath);
    if (sourceStat.isDirectory()) {
      await fs.rm(destinationPath, { recursive: true, force: true });
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.cp(sourcePath, destinationPath, { recursive: true });
      return;
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await this.assertContainedPath(root, destinationPath, `staged bundle path ${path.relative(root, destinationPath)}`);
    await this.atomicCopyFile(sourcePath, destinationPath);
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
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, content, 'utf8');
      await fs.rename(temporary, filePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
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

  private configuredSeat(value: string, setting: string) {
    const seat = value.trim();
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(seat)) {
      throw new Error(`portableAiBus.${setting} must be a valid seat id.`);
    }
    return seat;
  }

  private nowIso() {
    return new Date().toISOString();
  }
}
