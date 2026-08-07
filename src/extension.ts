import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PHASES, Phase, WorkspaceBus } from './bus';
import { BusMessage, MailboxStatus, MailboxStore } from './mailbox';
import { CapabilityRunner } from './capabilities';
import { runVscodeLmWorker } from './vscode-lm-worker';
import { HarnessManager } from './harness-manager';
import { ReminderTracker } from './reminders';

const activeLmWorkers = new Set<string>();
const LM_WORKER_SEAT = 'pab-lm-worker';
const harnessManager = new HarnessManager();

type ChatAction =
  | { kind: 'help' }
  | { kind: 'instructions' }
  | { kind: 'init' }
  | { kind: 'status' }
  | { kind: 'prompt' }
  | { kind: 'suspend' }
  | { kind: 'resume' }
  | { kind: 'remove' }
  | { kind: 'settings' }
  | { kind: 'setPhase'; phase: Phase }
  | { kind: 'start'; task: string; goal?: string; validation?: string }
  | { kind: 'mailboxStatus' }
  | { kind: 'mailboxInbox'; agent?: string }
  | { kind: 'mailboxSend' }
  | { kind: 'mailboxClaim' }
  | { kind: 'mailboxRelease' };

export async function activate(context: vscode.ExtensionContext) {
  const bus = new WorkspaceBus(context);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'portableAiBus.showStatus';
  context.subscriptions.push(statusBar);
  const mailboxWatcher = vscode.workspace.createFileSystemWatcher('**/.ai-bus/runtime/mailbox/**/*');
  context.subscriptions.push(mailboxWatcher);
  const reminderTracker = new ReminderTracker();
  let reminderTimer: NodeJS.Timeout | undefined;
  let reminderPollActive = false;
  let workflowSync = Promise.resolve();

  const refreshStatusBar = async () => {
    const settings = bus.getConfiguration();
    if (!settings.showStatusBar) {
      statusBar.hide();
      return;
    }

    try {
      const root = await bus.getWorkspaceRoot();
      if (!(await bus.isInitialized(root))) {
        statusBar.text = bus.phaseLabel();
        statusBar.tooltip = 'Portable AI Bus is not initialized in this workspace.';
        statusBar.show();
        return;
      }

      const suspended = await bus.isSuspended(root);
      const status = suspended ? undefined : await bus.getStatus(root);
      let label = bus.phaseLabel(status, suspended);
      let tooltip = suspended || !status ? 'Portable AI Bus is suspended.' : bus.renderStatus(status);

      try {
        const mailbox = await new MailboxStore(root).status();
        const unreadTotal = Object.values(mailbox.unread).reduce((sum, count) => sum + count, 0);
        if (unreadTotal > 0) {
          label = `${label} · ✉${unreadTotal}`;
        }
        tooltip = `${tooltip}\n\n${renderMailboxStatus(mailbox)}`;
        const staleSeats = await readStaleWorkerSeats(root);
        if (staleSeats.length > 0) {
          label = `${label} | stale:${staleSeats.length}`;
          tooltip = `${tooltip}\n\nAdvisory stale worker heartbeats: ${staleSeats.join(', ')}`;
        }
      } catch {
        // Mailbox may not be initialized yet.
      }

      statusBar.text = label;
      statusBar.tooltip = tooltip;
      statusBar.show();
    } catch (error) {
      statusBar.text = 'AI Bus: Unavailable';
      statusBar.tooltip = asErrorMessage(error);
      statusBar.show();
    }
  };

  const checkReminders = async () => {
    if (reminderPollActive) return;
    reminderPollActive = true;
    try {
      const root = await bus.getWorkspaceRoot();
      if (!(await bus.isInitialized(root)) || await bus.isSuspended(root)) {
        reminderTracker.reset(root);
        return;
      }
      const store = mailboxFor(root);
      const mailbox = await store.status();
      const [inboxes, staleSeats] = await Promise.all([
        Promise.all(mailbox.agents.map(async (agent) => [agent, await store.inbox(agent)] as const)),
        readStaleWorkerSeats(root)
      ]);
      const newestUnreadSeq = Object.fromEntries(inboxes.map(([agent, messages]) => [agent, Math.max(0, ...messages.map((message) => message.seq))]));
      const transitions = reminderTracker.observe(root, { unread: mailbox.unread, newestUnreadSeq, staleSeats });
      const config = vscode.workspace.getConfiguration('portableAiBus');
      if (config.get<boolean>('reminders.notifyUnread', true) && transitions.unreadAgents.length > 0) {
        const detail = transitions.unreadAgents.map(({ agent, count }) => `${agent} (${count})`).join(', ');
        void vscode.window.showInformationMessage(`Portable AI Bus: unread work is waiting for ${detail}.`, 'Show Mailbox')
          .then((action) => { if (action === 'Show Mailbox') void vscode.commands.executeCommand('portableAiBus.mailboxStatus'); });
      }
      if (config.get<boolean>('reminders.notifyStaleWorkers', true) && transitions.staleSeats.length > 0) {
        void vscode.window.showWarningMessage(
          `Portable AI Bus: worker heartbeat became stale for ${transitions.staleSeats.join(', ')}. This is advisory and does not prove work progress.`,
          'Show Harness Status'
        ).then((action) => { if (action === 'Show Harness Status') void vscode.commands.executeCommand('portableAiBus.showHarnessStatus'); });
      }
    } catch {
      // Missing workspace/runtime state is normal while folders and bus state change.
    } finally {
      reminderPollActive = false;
      void refreshStatusBar();
    }
  };

  const restartReminderTimer = () => {
    if (reminderTimer) clearInterval(reminderTimer);
    const seconds = vscode.workspace.getConfiguration('portableAiBus').get<number>('reminders.intervalSeconds', 15);
    reminderTimer = setInterval(() => void checkReminders(), Math.max(5, Math.min(600, seconds)) * 1_000);
    reminderTimer.unref();
  };
  context.subscriptions.push(new vscode.Disposable(() => {
    if (reminderTimer) clearInterval(reminderTimer);
  }));

  context.subscriptions.push(
    vscode.commands.registerCommand('portableAiBus.initializeWorkspace', async () => {
      await withWorkspaceAction(bus, async (root) => {
        await bus.initializeWorkspace(root);
        void refreshStatusBar();
        void vscode.window.showInformationMessage('Portable AI Bus initialized in this workspace.');
      });
    }),
    vscode.commands.registerCommand('portableAiBus.startTask', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const task = await vscode.window.showInputBox({
          prompt: 'Task',
          placeHolder: 'Fix checkout race condition'
        });
        if (!task) {
          return;
        }

        const goal = await vscode.window.showInputBox({
          prompt: 'Goal',
          placeHolder: 'Resolve the bug and keep validations green'
        });
        const validation = await vscode.window.showInputBox({
          prompt: 'Validation',
          placeHolder: 'npm test'
        });

        await bus.initializeWorkspace(root, { task, goal, validation });
        await showMarkdownDocument('Portable AI Bus Status', bus.renderStatus(await bus.getStatus(root)));
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.showStatus', async () => {
      await withWorkspaceAction(bus, async (root) => {
        await showMarkdownDocument('Portable AI Bus Status', bus.renderStatus(await bus.getStatus(root)));
      });
    }),
    vscode.commands.registerCommand('portableAiBus.showPrompt', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const prompt = await bus.getPrompt(root);
        await showMarkdownDocument('Portable AI Bus Prompt', ['# Next Prompt', '', '```text', prompt, '```'].join('\n'));
      });
    }),
    vscode.commands.registerCommand('portableAiBus.setPhase', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const selected = await vscode.window.showQuickPick(PHASES, { placeHolder: 'Select the new workflow phase' });
        if (!selected) {
          return;
        }
        await bus.setPhase(root, selected as Phase);
        void refreshStatusBar();
        await showMarkdownDocument('Portable AI Bus Status', bus.renderStatus(await bus.getStatus(root)));
      });
    }),
    vscode.commands.registerCommand('portableAiBus.suspend', async () => {
      await withWorkspaceAction(bus, async (root) => {
        await harnessManager.stop(root);
        await bus.suspend(root);
        reminderTracker.reset(root);
        void refreshStatusBar();
        void vscode.window.showInformationMessage('Portable AI Bus suspended for this workspace.');
      });
    }),
    vscode.commands.registerCommand('portableAiBus.resume', async () => {
      await withWorkspaceAction(bus, async (root) => {
        await bus.resume(root);
        void refreshStatusBar();
        void vscode.window.showInformationMessage('Portable AI Bus resumed for this workspace.');
      });
    }),
    vscode.commands.registerCommand('portableAiBus.remove', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const confirmed = await vscode.window.showWarningMessage(
          'Remove Portable AI Bus from this workspace?',
          { modal: true },
          'Remove'
        );
        if (confirmed !== 'Remove') {
          return;
        }
        await harnessManager.stop(root);
        await bus.remove(root);
        reminderTracker.reset(root);
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.openSettings', async () => {
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-dev.portable-ai-bus');
    }),
    vscode.commands.registerCommand('portableAiBus.openHumanGuide', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const document = await vscode.workspace.openTextDocument(bus.humanInstructionsPath(root));
        await vscode.window.showTextDocument(document);
      });
    }),
    vscode.commands.registerCommand('portableAiBus.mailboxStatus', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const status = await mailboxFor(root).status();
        await showMarkdownDocument('AI Bus Mailbox Status', ['# Mailbox status', '', '```text', renderMailboxStatus(status), '```'].join('\n'));
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.mailboxInbox', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const agent = await pickAgent(root, 'Read inbox for which agent?');
        if (!agent) {
          return;
        }
        const messages = await mailboxFor(root).read(agent, true);
        await showMarkdownDocument(
          `AI Bus Inbox (${agent})`,
          renderMessagesMarkdown(messages, `Unread for \`${agent}\``)
        );
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.mailboxSend', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const store = mailboxFor(root);
        await store.ensureInitialized();
        const from = await pickAgent(root, 'Send from', true);
        if (!from) {
          return;
        }
        const to = await pickAgent(root, 'Send to', true);
        if (!to) {
          return;
        }
        const kind =
          (await vscode.window.showInputBox({
            prompt: 'Kind',
            value: 'note',
            placeHolder: 'note | ack | finding | handoff | coordination'
          })) || 'note';
        const subject = await vscode.window.showInputBox({
          prompt: 'Subject',
          placeHolder: 'One-line subject'
        });
        if (!subject?.trim()) {
          return;
        }
        const body = await vscode.window.showInputBox({
          prompt: 'Body',
          placeHolder: 'Message body'
        });
        if (!body?.trim()) {
          return;
        }
        const message = await store.send({ from, to, kind, subject, body });
        void vscode.window.showInformationMessage(`Sent mailbox #${message.seq} ${from} → ${to}`);
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.mailboxClaim', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const agent = await pickAgent(root, 'Claim as agent', true);
        if (!agent) {
          return;
        }
        const pathsRaw = await vscode.window.showInputBox({
          prompt: 'Paths to claim (comma-separated, workspace-relative)',
          placeHolder: 'src/foo.ts,docs/'
        });
        if (!pathsRaw?.trim()) {
          return;
        }
        const why =
          (await vscode.window.showInputBox({
            prompt: 'Why',
            placeHolder: 'short reason'
          })) || '';
        const paths = pathsRaw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        const held = await mailboxFor(root).claim({ agent, paths, why });
        void vscode.window.showInformationMessage(
          `${agent} holds: ${held.map((claim) => claim.path).join(', ') || 'none'}`
        );
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.mailboxRelease', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const agent = await pickAgent(root, 'Release claims for agent');
        if (!agent) {
          return;
        }
        const pathsRaw = await vscode.window.showInputBox({
          prompt: 'Paths to release (empty = all)',
          placeHolder: 'src/foo.ts'
        });
        if (pathsRaw === undefined) {
          return;
        }
        const paths = pathsRaw
          ?.split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        if (!paths || paths.length === 0) {
          const confirmed = await vscode.window.showWarningMessage(
            `Release every claim held by ${agent}?`,
            { modal: true },
            'Release All'
          );
          if (confirmed !== 'Release All') {
            return;
          }
        }
        const remaining = await mailboxFor(root).release(agent, paths && paths.length > 0 ? paths : undefined);
        void vscode.window.showInformationMessage(
          remaining.length === 0
            ? `${agent} released all claims`
            : `${agent} still holds: ${remaining.map((claim) => claim.path).join(', ')}`
        );
        void refreshStatusBar();
      });
    }),
    vscode.commands.registerCommand('portableAiBus.runLanguageModelWorker', async () => {
      await withWorkspaceAction(bus, async (root) => {
        if (!(await bus.isInitialized(root))) {
          throw new Error('Initialize Portable AI Bus in this workspace before running a language-model worker.');
        }
        if (activeLmWorkers.has(root)) {
          throw new Error('A language-model worker is already running in this workspace.');
        }
        activeLmWorkers.add(root);
        try {
        const config = vscode.workspace.getConfiguration('portableAiBus');
        if (!config.get<boolean>('languageModelWorker.enabled', false)) {
          const choice = await vscode.window.showWarningMessage(
            'Enable the optional language-model worker for this workspace? It can use model quota and invoke only the bus tools and seat capabilities you grant.',
            { modal: true },
            'Enable and Run'
          );
          if (choice !== 'Enable and Run') return;
          await config.update('languageModelWorker.enabled', true, vscode.ConfigurationTarget.WorkspaceFolder);
        }
        const prompt = await vscode.window.showInputBox({
          title: 'Portable AI Bus: Run LM Worker',
          prompt: 'One bounded task for the selected model',
          placeHolder: 'Read your mailbox, perform the requested checks, and report findings',
          ignoreFocusOut: true
        });
        if (!prompt?.trim()) return;
        const model = await pickLanguageModel(config);
        if (!model) return;
        const maxTurns = config.get<number>('languageModelWorker.maxTurns', 8);
        const allowedTools = config.get<string[]>('languageModelWorker.allowedTools', defaultLmWorkerTools());
        const grantedCapabilities = (await new CapabilityRunner(root).list())
          .filter((item) => (item.allowedSeats ?? []).some((seat) => seat === '*' || seat === LM_WORKER_SEAT))
          .map((item) => item.id);
        const confirmed = await vscode.window.showWarningMessage(
          `Run ${model.name} as the isolated ${LM_WORKER_SEAT} seat?`,
          {
            modal: true,
            detail: [
              `Provider/model: ${model.vendor} / ${model.id}`,
              `Private tools: ${allowedTools.join(', ') || 'none'}`,
              `Granted capabilities: ${grantedCapabilities.join(', ') || 'none'}`,
              `Bound: ${maxTurns} model turns. Model and tool use may consume provider quota and send tool results to that provider.`
            ].join('\n')
          },
          'Run'
        );
        if (confirmed !== 'Run') return;
          const result = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `Portable AI Bus: ${model.name}`, cancellable: true },
            async (_progress, token) => runVscodeLmWorker({
              root,
              seat: LM_WORKER_SEAT,
              model,
              prompt,
              allowedTools,
              maxTurns,
              token
            })
          );
          await showMarkdownDocument(
            'Portable AI Bus LM Worker Result',
            [`# Language-model worker result`, '', result.text, '', `---`, `Model: \`${result.model.vendor}\` / \`${result.model.id}\`  `,
              `Turns: ${result.turns}; tool calls: ${result.toolCalls}`].join('\n')
          );
        } finally {
          activeLmWorkers.delete(root);
        }
      });
    }),
    vscode.commands.registerCommand('portableAiBus.startHarness', async () => {
      await withWorkspaceAction(bus, async (root) => {
        if (!(await bus.isInitialized(root))) throw new Error('Initialize Portable AI Bus before starting the harness.');
        if (await bus.isSuspended(root)) throw new Error('Resume Portable AI Bus before starting the harness.');
        const port = vscode.workspace.getConfiguration('portableAiBus').get<number>('harness.port', 0);
        const result = await harnessManager.start(root, port);
        if (result.started) {
          void vscode.window.showInformationMessage(
            `Portable AI Bus harness started on 127.0.0.1:${result.endpoint.port}. Seat credentials were written outside the repository.`
          );
        } else {
          void vscode.window.showInformationMessage('Portable AI Bus harness is already managed by this VS Code window.');
        }
      });
    }),
    vscode.commands.registerCommand('portableAiBus.stopHarness', async () => {
      await withWorkspaceAction(bus, async (root) => {
        if (await harnessManager.stop(root)) {
          void vscode.window.showInformationMessage('Portable AI Bus harness stopped; its instance credentials were removed.');
        } else {
          void vscode.window.showInformationMessage('This VS Code window does not own a harness for the workspace.');
        }
      });
    }),
    vscode.commands.registerCommand('portableAiBus.showHarnessStatus', async () => {
      await withWorkspaceAction(bus, async (root) => {
        await showMarkdownDocument('Portable AI Bus Harness Status', await renderHarnessRuntimeStatus(root, harnessManager.owns(root)));
      });
    }),
    vscode.commands.registerCommand('portableAiBus.configureHalting', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const store = mailboxFor(root);
        const current = await store.status();
        const step = await vscode.window.showQuickPick(
          [{ label: 'Pause', value: true }, { label: 'Continue', value: false }],
          { title: 'After a structured step completion', placeHolder: current.haltPolicy.onStepCompletion ? 'Currently: Pause' : 'Currently: Continue' }
        );
        if (!step) return;
        const goal = await vscode.window.showQuickPick(
          [{ label: 'Pause', value: true }, { label: 'Continue', value: false }],
          { title: 'After structured goal completion', placeHolder: current.haltPolicy.onGoalCompletion ? 'Currently: Pause' : 'Currently: Continue' }
        );
        if (!goal) return;
        const atRaw = await vscode.window.showInputBox({
          title: 'Explicit round checkpoints',
          prompt: 'Comma-separated positive rounds; empty disables explicit checkpoints',
          value: current.haltPolicy.atRounds.join(',')
        });
        if (atRaw === undefined) return;
        const atRounds = atRaw.trim() ? parsePositiveRoundList(atRaw) : [];
        const everyRaw = await vscode.window.showInputBox({
          title: 'Recurring round checkpoint',
          prompt: 'Pause every N rounds; zero disables (for example 12)',
          value: String(current.haltPolicy.everyRounds ?? 0),
          validateInput: (value) => /^\d+$/.test(value.trim()) ? undefined : 'Enter zero or a positive integer.'
        });
        if (everyRaw === undefined) return;
        const state = await store.configureHalting({
          onStepCompletion: step.value,
          onGoalCompletion: goal.value,
          atRounds,
          everyRounds: Number(everyRaw) || null
        });
        void vscode.window.showInformationMessage(
          `Halting: max ${state.maxRounds}; at ${state.haltPolicy.atRounds.join(',') || 'none'}; every ${state.haltPolicy.everyRounds ?? 'off'}; step ${state.haltPolicy.onStepCompletion}; goal ${state.haltPolicy.onGoalCompletion}.`
        );
      });
    }),
    vscode.commands.registerCommand('portableAiBus.completeStep', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const actor = await pickAgent(root, 'Agent completing this step', true);
        if (!actor) return;
        const summary = await vscode.window.showInputBox({ title: 'Step completion summary', prompt: 'What was completed and verified?' });
        if (!summary?.trim()) return;
        const evidenceRaw = await vscode.window.showInputBox({ title: 'Step evidence', prompt: 'Optional comma-separated tests, commits, or receipt IDs' });
        if (evidenceRaw === undefined) return;
        const event = await mailboxFor(root).complete({ scope: 'step', actor, summary, evidence: splitCommaList(evidenceRaw) });
        void vscode.window.showInformationMessage(`Step recorded${event.halted ? '; bus halted for review' : ''}.`);
      });
    }),
    vscode.commands.registerCommand('portableAiBus.completeGoal', async () => {
      await withWorkspaceAction(bus, async (root) => {
        const summary = await vscode.window.showInputBox({ title: 'Goal completion summary', prompt: 'State the evidence proving the overall goal is complete' });
        if (!summary?.trim()) return;
        const evidenceRaw = await vscode.window.showInputBox({ title: 'Goal evidence', prompt: 'Comma-separated tests, commits, PRs, or receipt IDs' });
        if (evidenceRaw === undefined) return;
        const confirmed = await vscode.window.showWarningMessage('Record overall goal completion?', { modal: true, detail: summary }, 'Complete Goal');
        if (confirmed !== 'Complete Goal') return;
        const event = await mailboxFor(root).complete({ scope: 'goal', actor: 'operator', summary, evidence: splitCommaList(evidenceRaw) });
        void vscode.window.showInformationMessage(`Goal completion recorded${event.halted ? '; bus halted' : ''}.`);
      });
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      void refreshStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('portableAiBus')) {
        if (event.affectsConfiguration('portableAiBus.reminders')) restartReminderTimer();
        if (event.affectsConfiguration('portableAiBus.workflow')) {
          workflowSync = workflowSync.then(async () => {
            for (const folder of vscode.workspace.workspaceFolders ?? []) {
              const root = folder.uri.fsPath;
              if (!(await bus.isInitialized(root)) || await bus.isSuspended(root)) continue;
              const ownedHarness = harnessManager.owns(root);
              const externalEndpoint = !ownedHarness && await fileExists(path.join(root, '.ai-bus', 'runtime', 'harness', 'endpoint.json'));
              if (ownedHarness) await harnessManager.stop(root);
              await bus.installOverlay(root);
              if (ownedHarness) {
                const port = vscode.workspace.getConfiguration('portableAiBus', folder.uri).get<number>('harness.port', 0);
                await harnessManager.start(root, port);
              } else if (externalEndpoint) {
                void vscode.window.showWarningMessage('Portable AI Bus workflow seats changed. Restart the external workspace harness to provision credentials for newly assigned seats.');
              }
            }
          }).catch((error) => {
            void vscode.window.showErrorMessage(`Could not synchronize Portable AI Bus workflow seats: ${asErrorMessage(error)}`);
          });
        }
        void refreshStatusBar();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const removed of event.removed) {
        const root = removed.uri.fsPath;
        if (harnessManager.owns(root)) void harnessManager.stop(root);
        reminderTracker.reset(root);
      }
      void refreshStatusBar();
    }),
    mailboxWatcher.onDidCreate(() => { void refreshStatusBar(); void checkReminders(); }),
    mailboxWatcher.onDidChange(() => { void refreshStatusBar(); void checkReminders(); }),
    mailboxWatcher.onDidDelete(() => void refreshStatusBar())
  );

  const participant = vscode.chat.createChatParticipant('portable-ai-bus.assistant', async (request, _chatContext, stream) => {
    try {
      const root = await bus.getWorkspaceRoot();
      const action = parseChatAction(request);
      await handleChatAction(bus, root, action, stream);
      void refreshStatusBar();
    } catch (error) {
      stream.markdown(asMarkdownError(error));
    }
  });
  participant.iconPath = new vscode.ThemeIcon('hubot');
  context.subscriptions.push(participant);

  if (bus.getConfiguration().autoInitializeOnOpen) {
    void maybeOfferInitialization(bus);
  }
  if (vscode.workspace.getConfiguration('portableAiBus').get<boolean>('harness.autoStart', false)) {
    void (async () => {
      try {
        const root = await bus.getWorkspaceRoot();
        if (await bus.isInitialized(root) && !(await bus.isSuspended(root))) {
          await vscode.commands.executeCommand('portableAiBus.startHarness');
        }
      } catch {
        // No active workspace is a valid startup state.
      }
    })();
  }

  restartReminderTimer();
  void checkReminders();
  void refreshStatusBar();
}

export async function deactivate() {
  await harnessManager.stopAll();
}

async function pickLanguageModel(config: vscode.WorkspaceConfiguration) {
  const vendor = config.get<string>('languageModelWorker.vendor', '').trim();
  const id = config.get<string>('languageModelWorker.modelId', '').trim();
  if ((vendor && !id) || (!vendor && id)) {
    throw new Error('Configure both languageModelWorker.vendor and languageModelWorker.modelId, or leave both empty to choose interactively.');
  }
  if (vendor && id) {
    const exact = await vscode.lm.selectChatModels({ vendor, id });
    if (exact.length !== 1) throw new Error(`Expected one configured model for vendor=${vendor} id=${id}; found ${exact.length}.`);
    return exact[0];
  }
  const models = await vscode.lm.selectChatModels();
  if (models.length === 0) {
    throw new Error('No VS Code language models are available. Install/configure a model provider such as GitHub Copilot or Unify, then try again.');
  }
  const picked = await vscode.window.showQuickPick(
    models.map((model) => ({
      label: model.name,
      description: `${model.vendor} · ${model.family}`,
      detail: model.id,
      model
    })),
    { title: 'Select the exact model for this bounded run', matchOnDescription: true, matchOnDetail: true }
  );
  if (!picked) return undefined;
  await Promise.all([
    config.update('languageModelWorker.vendor', picked.model.vendor, vscode.ConfigurationTarget.WorkspaceFolder),
    config.update('languageModelWorker.modelId', picked.model.id, vscode.ConfigurationTarget.WorkspaceFolder)
  ]);
  return picked.model;
}

function defaultLmWorkerTools() {
  return [
    'mailbox_status', 'mailbox_inbox', 'mailbox_read', 'mailbox_send',
    'mailbox_claim', 'mailbox_release', 'capability_list', 'capability_run'
  ];
}

function splitCommaList(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function parsePositiveRoundList(value: string) {
  const rounds = splitCommaList(value).map((item) => Number(item));
  if (rounds.some((round) => !Number.isSafeInteger(round) || round < 1)) throw new Error('Round checkpoints must be positive integers.');
  return rounds;
}

async function renderHarnessRuntimeStatus(root: string, ownedByWindow: boolean) {
  const runtime = path.join(root, '.ai-bus', 'runtime', 'harness');
  const readJson = async (name: string) => JSON.parse(await fs.readFile(path.join(runtime, name), 'utf8')) as Record<string, unknown>;
  const endpoint = await readJson('endpoint.json').catch(() => undefined);
  const leases = await readJson('leases.json').catch(() => undefined);
  if (!endpoint) {
    return ['# Harness status', '', 'No active harness endpoint is published for this workspace.', '',
      `Owned by this VS Code window: **${ownedByWindow ? 'yes (starting/stopping)' : 'no'}**`].join('\n');
  }
  const staleAfterMs = Number(leases?.staleAfterMs);
  const leaseRows = Array.isArray((leases as { leases?: unknown[] } | undefined)?.leases)
    ? ((leases as { leases: Array<Record<string, unknown>> }).leases).map((lease) => {
      const lastSeen = String(lease.lastWakeAt ?? lease.lastHeartbeatAt ?? '');
      const live = Number.isFinite(staleAfterMs) && lastSeen && Date.now() - Date.parse(lastSeen) <= staleAfterMs;
      return `| ${String(lease.seat)} | ${String(lease.clientId)} | ${live ? 'live' : 'stale'} | ${String(lease.lastHeartbeatAt ?? '—')} | ${String(lease.lastWakeAt ?? '—')} |`;
    })
    : [];
  return [
    '# Harness status', '',
    `- Endpoint: \`${String(endpoint.host)}:${String(endpoint.port)}\``,
    `- Instance: \`${String(endpoint.instanceId)}\``,
    `- PID: \`${String(endpoint.pid)}\``,
    `- Owned by this VS Code window: **${ownedByWindow ? 'yes' : 'no'}**`,
    `- Lease file state: **${String(leases?.state ?? 'unavailable')}**`,
    '- Worker state is advisory heartbeat freshness, not proof that a worker is processing or progressing.', '',
    '| Seat | Client | Advisory state | Last heartbeat | Last wake |',
    '|---|---|---|---|---|',
    ...(leaseRows.length > 0 ? leaseRows : ['| — | — | — | — | — |'])
  ].join('\n');
}

async function readStaleWorkerSeats(root: string) {
  const leasesPath = path.join(root, '.ai-bus', 'runtime', 'harness', 'leases.json');
  const value = await fs.readFile(leasesPath, 'utf8').then((text) => JSON.parse(text) as {
    state?: string;
    staleAfterMs?: number;
    leases?: Array<{ seat?: string; lastHeartbeatAt?: string; lastWakeAt?: string }>;
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!value) return [];
  if (value.state !== 'running' || !Number.isFinite(value.staleAfterMs) || !Array.isArray(value.leases)) return [];
  const staleAfterMs = Number(value.staleAfterMs);
  const now = Date.now();
  const seen = new Set<string>();
  const live = new Set<string>();
  for (const lease of value.leases) {
    if (!lease.seat) continue;
    seen.add(lease.seat);
    const timestamp = lease.lastWakeAt ?? lease.lastHeartbeatAt;
    if (timestamp && now - Date.parse(timestamp) <= staleAfterMs) live.add(lease.seat);
  }
  return [...seen].filter((seat) => !live.has(seat)).sort();
}

async function handleChatAction(
  bus: WorkspaceBus,
  root: string,
  action: ChatAction,
  stream: vscode.ChatResponseStream
) {
  switch (action.kind) {
    case 'help':
      stream.markdown(helpText());
      return;
    case 'instructions':
      await vscode.commands.executeCommand('portableAiBus.openHumanGuide');
      stream.markdown('Opened the human instructions file for this workspace.');
      return;
    case 'settings':
      await vscode.commands.executeCommand('portableAiBus.openSettings');
      stream.markdown('Opened Portable AI Bus settings.');
      return;
    case 'init':
      await bus.initializeWorkspace(root);
      stream.markdown('Portable AI Bus initialized in this workspace.');
      return;
    case 'status':
      stream.markdown(['```text', bus.renderStatus(await bus.getStatus(root)), '```'].join('\n'));
      return;
    case 'prompt':
      stream.markdown(['```text', await bus.getPrompt(root), '```'].join('\n'));
      return;
    case 'suspend':
      await harnessManager.stop(root);
      await bus.suspend(root);
      stream.markdown('Portable AI Bus suspended. Runtime state remains under `.ai-bus/runtime/`.');
      return;
    case 'resume':
      await bus.resume(root);
      stream.markdown('Portable AI Bus resumed for this workspace.');
      return;
    case 'remove':
      await harnessManager.stop(root);
      await bus.remove(root);
      stream.markdown('Portable AI Bus removed from this workspace.');
      return;
    case 'setPhase':
      await bus.setPhase(root, action.phase);
      stream.markdown(['```text', bus.renderStatus(await bus.getStatus(root)), '```'].join('\n'));
      return;
    case 'start':
      await bus.initializeWorkspace(root, {
        task: action.task,
        goal: action.goal,
        validation: action.validation
      });
      stream.markdown(
        [
          `Started task: **${escapeMarkdown(action.task)}**`,
          '',
          action.goal ? `Goal: ${escapeMarkdown(action.goal)}` : '',
          '```text',
          bus.renderStatus(await bus.getStatus(root)),
          '```'
        ]
          .filter(Boolean)
          .join('\n')
      );
      return;
    case 'mailboxStatus': {
      const status = await mailboxFor(root).status();
      stream.markdown(['```text', renderMailboxStatus(status), '```'].join('\n'));
      return;
    }
    case 'mailboxInbox': {
      const agent = action.agent || (await pickAgent(root, 'Inbox for which agent?'));
      if (!agent) {
        stream.markdown('No agent selected.');
        return;
      }
      const messages = await mailboxFor(root).read(agent, true);
      stream.markdown(renderMessagesMarkdown(messages, `Unread for \`${agent}\``));
      return;
    }
    case 'mailboxSend':
      await vscode.commands.executeCommand('portableAiBus.mailboxSend');
      stream.markdown('Opened **Mailbox: Send Message** (Command Palette flow).');
      return;
    case 'mailboxClaim':
      await vscode.commands.executeCommand('portableAiBus.mailboxClaim');
      stream.markdown('Opened **Mailbox: Claim Paths**.');
      return;
    case 'mailboxRelease':
      await vscode.commands.executeCommand('portableAiBus.mailboxRelease');
      stream.markdown('Opened **Mailbox: Release Claims**.');
      return;
  }
}

function parseChatAction(request: vscode.ChatRequest): ChatAction {
  if (request.command === 'help') {
    return { kind: 'help' };
  }
  if (request.command === 'instructions') {
    return { kind: 'instructions' };
  }
  if (request.command === 'settings') {
    return { kind: 'settings' };
  }
  if (request.command === 'init') {
    return { kind: 'init' };
  }
  if (request.command === 'status') {
    return { kind: 'status' };
  }
  if (request.command === 'prompt') {
    return { kind: 'prompt' };
  }
  if (request.command === 'suspend') {
    return { kind: 'suspend' };
  }
  if (request.command === 'resume') {
    return { kind: 'resume' };
  }
  if (request.command === 'remove') {
    return { kind: 'remove' };
  }
  if (request.command === 'mailboxStatus' || request.command === 'mailbox') {
    return { kind: 'mailboxStatus' };
  }
  if (request.command === 'inbox') {
    const agent = request.prompt.trim().split(/\s+/)[0];
    return { kind: 'mailboxInbox', agent: agent || undefined };
  }
  if (request.command === 'send') {
    return { kind: 'mailboxSend' };
  }
  if (request.command === 'claim') {
    return { kind: 'mailboxClaim' };
  }
  if (request.command === 'release') {
    return { kind: 'mailboxRelease' };
  }
  if (request.command === 'phase') {
    const token = request.prompt.trim().toUpperCase();
    if (!isPhase(token)) {
      throw new Error(`Unknown phase. Use one of: ${PHASES.join(', ')}`);
    }
    return { kind: 'setPhase', phase: token };
  }
  if (request.command === 'start') {
    return parseStartAction(request.prompt);
  }

  const prompt = request.prompt.trim();
  const lower = prompt.toLowerCase();

  if (!prompt || lower === 'help') {
    return { kind: 'help' };
  }
  if (/\b(instructions|guide|human guide)\b/.test(lower)) {
    return { kind: 'instructions' };
  }
  if (/\bsettings\b/.test(lower)) {
    return { kind: 'settings' };
  }
  if (/\b(init|initialize|install|setup)\b/.test(lower)) {
    return { kind: 'init' };
  }
  if (/\bmailbox\s+status\b/.test(lower) || /\bunread\b/.test(lower) || lower === 'mailbox') {
    return { kind: 'mailboxStatus' };
  }
  if (/\binbox\b/.test(lower)) {
    const match = prompt.match(/\binbox\b(?:\s+for)?\s+([a-zA-Z0-9_.-]+)/i);
    return { kind: 'mailboxInbox', agent: match?.[1] };
  }
  if (/\b(send message|mailbox send|send on the bus)\b/.test(lower)) {
    return { kind: 'mailboxSend' };
  }
  if (/\brelease\b/.test(lower) && /\bclaim/.test(lower)) {
    return { kind: 'mailboxRelease' };
  }
  if (/\bclaim\b/.test(lower)) {
    return { kind: 'mailboxClaim' };
  }
  if (/\bstatus\b/.test(lower)) {
    return { kind: 'status' };
  }
  if (/\b(prompt|next step|next prompt)\b/.test(lower)) {
    return { kind: 'prompt' };
  }
  if (/\b(suspend|pause)\b/.test(lower)) {
    return { kind: 'suspend' };
  }
  if (/\b(resume|restore|continue)\b/.test(lower)) {
    return { kind: 'resume' };
  }
  if (/\b(remove|uninstall|delete)\b/.test(lower)) {
    return { kind: 'remove' };
  }

  const phaseMatch = prompt.match(/\b(?:set|move|change)\s+(?:the\s+)?phase\s+(?:to\s+)?([A-Z_]+)/i);
  if (phaseMatch) {
    const phase = phaseMatch[1].toUpperCase();
    if (!isPhase(phase)) {
      throw new Error(`Unknown phase. Use one of: ${PHASES.join(', ')}`);
    }
    return { kind: 'setPhase', phase };
  }

  if (/\b(start|begin|init)\b/.test(lower) && /\btask\b/.test(lower)) {
    return parseStartAction(prompt);
  }

  return { kind: 'help' };
}

function parseStartAction(prompt: string): ChatAction {
  const labeledTask = prompt.match(/task\s*:\s*(.+?)(?=\s+\b(goal|validation)\s*:|$)/i);
  const labeledGoal = prompt.match(/goal\s*:\s*(.+?)(?=\s+\b(validation)\s*:|$)/i);
  const labeledValidation = prompt.match(/validation\s*:\s*(.+)$/i);

  const naturalMatch = prompt.match(
    /\b(?:start|begin|init(?:ialize)?)\b(?:\s+(?:a|the))?\s*task(?:\s+to)?\s+(.+?)(?:\s+goal(?:\s+is)?\s+(.+?))?(?:\s+validation(?:\s+is)?\s+(.+))?$/i
  );

  const task = labeledTask?.[1]?.trim() || naturalMatch?.[1]?.trim();
  const goal = labeledGoal?.[1]?.trim() || naturalMatch?.[2]?.trim();
  const validation = labeledValidation?.[1]?.trim() || naturalMatch?.[3]?.trim();

  if (!task) {
    throw new Error('Could not determine the task. Use `/start task: ... goal: ... validation: ...`.');
  }

  return {
    kind: 'start',
    task,
    goal,
    validation
  };
}

function mailboxFor(root: string) {
  return new MailboxStore(root);
}

async function pickAgent(root: string, title: string, allowCustom = false): Promise<string | undefined> {
  let agents: string[] = [];
  try {
    agents = (await mailboxFor(root).status()).agents;
  } catch {
    agents = ['codex', 'claude', 'grok'];
  }
  if (agents.length === 0) {
    agents = ['codex', 'claude', 'grok'];
  }

  const items = [
    ...agents.map((id) => ({ label: id, description: 'registered agent' })),
    ...(allowCustom ? [{ label: '$(edit) Other…', description: 'type an agent id', id: '__other__' }] : [])
  ];

  const selected = await vscode.window.showQuickPick(items, { title, placeHolder: title });
  if (!selected) {
    return undefined;
  }
  if ('id' in selected && selected.id === '__other__') {
    const custom = await vscode.window.showInputBox({
      prompt: 'Agent id',
      placeHolder: 'codex | claude | grok',
      validateInput: (value) => (/^[a-zA-Z0-9_.-]+$/.test(value.trim()) ? undefined : 'Invalid agent id')
    });
    return custom?.trim() || undefined;
  }
  return selected.label;
}

function renderMailboxStatus(status: MailboxStatus) {
  const unread = Object.entries(status.unread)
    .map(([agent, count]) => `  ${agent}: ${count}`)
    .join('\n');
  const claims = Object.entries(status.claims)
    .map(([agent, held]) => {
      if (held.length === 0) {
        return `  ${agent}: (none)`;
      }
      return held.map((claim) => `  ${agent}: ${claim.path} — ${claim.why || '(no reason)'}`).join('\n');
    })
    .join('\n');
  const commit = status.workspaceCommit
    ? `${status.workspaceCommit.sha.slice(0, 12)}${status.workspaceCommit.dirty ? ' (dirty)' : ''}`
    : '<not a git repo>';

  return [
    `round     ${status.round} / ${status.maxRounds}`,
    `halted    ${status.halted}${status.stopReason ? ` — ${status.stopReason}` : ''}`,
    `agents    ${status.agents.join(', ') || '(none)'}`,
    `commit    ${commit}`,
    'unread',
    unread || '  (none)',
    'claims',
    claims || '  (none)'
  ].join('\n');
}

function renderMessagesMarkdown(messages: BusMessage[], heading: string) {
  if (messages.length === 0) {
    return [`# ${heading}`, '', '_No unread messages._'].join('\n');
  }
  const blocks = messages.map((message) => {
    const commit = message.workspaceCommit
      ? `${message.workspaceCommit.sha.slice(0, 12)}${message.workspaceCommit.dirty ? ' (dirty)' : ''}`
      : 'n/a';
    return [
      `## #${message.seq} ${message.from} → ${message.to} [${message.kind}]`,
      '',
      `**${escapeMarkdown(message.subject)}**`,
      '',
      `- round: ${message.round}`,
      `- commit: \`${commit}\``,
      `- at: ${message.createdAt}`,
      '',
      message.body.trim(),
      ''
    ].join('\n');
  });
  return [`# ${heading}`, '', ...blocks].join('\n');
}

async function withWorkspaceAction(bus: WorkspaceBus, action: (root: string) => Promise<void>) {
  try {
    const root = await bus.getWorkspaceRoot();
    await action(root);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
    throw error;
  }
}

async function fileExists(candidate: string) {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function showMarkdownDocument(title: string, content: string) {
  const document = await vscode.workspace.openTextDocument({
    content,
    language: 'markdown'
  });
  await vscode.window.showTextDocument(document, { preview: true });
  void vscode.window.showInformationMessage(title);
}

async function maybeOfferInitialization(bus: WorkspaceBus) {
  try {
    const root = await bus.getWorkspaceRoot();
    if (await bus.isInitialized(root)) {
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'Portable AI Bus is not initialized in this workspace.',
      'Initialize'
    );
    if (choice === 'Initialize') {
      await bus.initializeWorkspace(root);
    }
  } catch {
    return;
  }
}

function helpText() {
  return [
    '# Portable AI Bus',
    '',
    'Use `@ai-bus` with one of these basic instruction commands:',
    '',
    '- `instructions`',
    '- `initialize the bus for this repo`',
    '- `start task: Fix auth timeout goal: Keep tests green validation: npm test`',
    '- `show status`',
    '- `show next prompt`',
    `- \`set phase to ${PHASES[3]}\``,
    '- `suspend the bus`',
    '- `resume the bus`',
    '- `remove the bus`',
    '- `open settings`',
    '',
    '## Multi-agent mailbox',
    '',
    '- `mailbox status` — rounds, unread, claims',
    '- `inbox for grok` — unread messages (also `/inbox grok`)',
    '- `send message` — Command Palette send flow',
    '- `claim` / `release claims` — path claims',
    '',
    'Agents can also use the staged CLI:',
    '',
    '```bash',
    'node .ai-bus/bin/mailbox.js status',
    'node .ai-bus/bin/mailbox.js read --for grok',
    'node .ai-bus/bin/mailbox.js send --from grok --to codex --kind note --subject "..." --body "..."',
    'node .ai-bus/bin/mailbox.js claim --agent grok --paths src/foo.ts --why "reason"',
    'node .ai-bus/bin/mailbox.js release --agent grok',
    '```',
    '',
    'Providers: **codex**, **claude**, **grok** (see `providers/providers.json`).'
  ].join('\n');
}

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value);
}

function asErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function asMarkdownError(error: unknown) {
  return `**Portable AI Bus error**\n\n${escapeMarkdown(asErrorMessage(error))}`;
}

function escapeMarkdown(value: string) {
  return value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
}
