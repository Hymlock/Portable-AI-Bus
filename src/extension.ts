import * as vscode from 'vscode';
import { PHASES, Phase, WorkspaceBus } from './bus';

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
  | { kind: 'start'; task: string; goal?: string; validation?: string };

export async function activate(context: vscode.ExtensionContext) {
  const bus = new WorkspaceBus(context);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = 'portableAiBus.showStatus';
  context.subscriptions.push(statusBar);

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
      statusBar.text = bus.phaseLabel(status, suspended);
      statusBar.tooltip = suspended || !status ? 'Portable AI Bus is suspended.' : bus.renderStatus(status);
      statusBar.show();
    } catch (error) {
      statusBar.text = 'AI Bus: Unavailable';
      statusBar.tooltip = asErrorMessage(error);
      statusBar.show();
    }
  };

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
        await bus.suspend(root);
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
        await bus.remove(root);
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
    vscode.workspace.onDidSaveTextDocument(() => {
      void refreshStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('portableAiBus')) {
        void refreshStatusBar();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshStatusBar();
    })
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

  void refreshStatusBar();
}

export function deactivate() {}

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
      await bus.suspend(root);
      stream.markdown('Portable AI Bus suspended. Runtime state remains under `.ai-bus/runtime/`.');
      return;
    case 'resume':
      await bus.resume(root);
      stream.markdown('Portable AI Bus resumed for this workspace.');
      return;
    case 'remove':
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

async function withWorkspaceAction(bus: WorkspaceBus, action: (root: string) => Promise<void>) {
  try {
    const root = await bus.getWorkspaceRoot();
    await action(root);
  } catch (error) {
    void vscode.window.showErrorMessage(asErrorMessage(error));
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
    '- `open settings`'
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
