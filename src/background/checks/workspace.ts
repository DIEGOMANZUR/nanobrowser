import { fileAction, resolveWorkspaceUpload } from '@src/extension/workspace-actions';
import { getEntries, getRun, listConversations } from '@src/store/conversations';
import { nativeRequest } from '@src/store/native-workspace';
import { createAgentSession } from '@src/extension/agent-session';
import { PageDownloads } from '@src/extension/page-downloads';
import { DEFAULT_WORKSPACE_POLICY, WORKSPACE_POLICY_KEY, updateWorkspacePolicy, workspace } from '@src/store/workspace';
import { toWorkspaceSkill } from '@src/store/skills';
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { defineCheck as registerCheck } from './registry';
import { layer } from '../layer';
import { openTab } from '../tabs';
import { openPanelTab, panel, scriptReplies, seedFixtureModel, waitForText } from './panel-chat';

// These checks change policies and create fixture files. Only an isolated autorun build may register them.
const defineCheck: typeof registerCheck = check => {
  if (import.meta.env.WXT_AUTORUN_URL) registerCheck(check);
};

defineCheck({
  name: 'workspace-learning',
  title: 'Personal memory and skill drafts',
  description: 'Creates a draft, verifies opt-in and recalls persistent Markdown from a separate task.',
  async run() {
    const previous = await chrome.storage.local.get(WORKSPACE_POLICY_KEY);
    const marker = crypto.randomUUID();
    const name = 'learned-' + marker;
    const tab = await openPanelTab();
    try {
      await seedFixtureModel();
      await updateWorkspacePolicy({ ...DEFAULT_WORKSPACE_POLICY, memory: true });
      await scriptReplies([
        {
          toolCalls: [
            {
              name: 'propose_skill',
              input: {
                name,
                description: 'Synthetic reusable task.',
                instructions: 'Read the fixture, then verify its receipt.',
              },
            },
          ],
        },
        { toolCalls: [{ name: 'remember_note', input: { title: 'Synthetic test', body: marker } }] },
        { text: 'Workflow and note recorded.' },
      ]);
      await panel(tab.id!, 'type-send', { text: 'Prepare the workflow and record the synthetic note.' });
      await waitForText(tab.id!, 'Workflow and note recorded.', 25000);
      const draft = await workspace.skill(name);
      if (!draft?.generated || draft.enabled) throw new Error('The generated skill must be an inactive draft.');
      const other = await openPanelTab();
      try {
        await scriptReplies([
          { toolCalls: [{ name: 'recall_notes', input: { query: marker } }] },
          { text: 'Completed memory lookup.' },
        ]);
        const question = 'Look up this fixture note ' + marker;
        await panel(other.id!, 'type-send', { text: question });
        await waitForText(other.id!, 'Completed memory lookup.', 25000);
        const [chat] = await listConversations(question.slice(0, 35));
        const parts = (await getEntries(chat.id)).flatMap(entry =>
          entry.type === 'message' ? entry.message.parts : [],
        );
        if (
          !parts.some(
            p =>
              p.type === 'tool-result' &&
              p.toolName === 'recall_notes' &&
              !p.isError &&
              p.text.includes(marker) &&
              p.text.includes('.md'),
          )
        )
          throw new Error('The new task did not recover the Markdown memory.');
      } finally {
        await chrome.tabs.remove(other.id!);
      }
      return { draftCreated: true, optInPreserved: true, markdownRecoveredInNewTask: true };
    } finally {
      await chrome.tabs.remove(tab.id!);
      if (WORKSPACE_POLICY_KEY in previous) await chrome.storage.local.set(previous);
      else await chrome.storage.local.remove(WORKSPACE_POLICY_KEY);
    }
  },
});

defineCheck({
  name: 'workspace-skills',
  title: 'Imported skill in the real agent tool path',
  description: 'Invokes an enabled manual workflow and reads the skill instructions through a scripted model.',
  async run() {
    await seedFixtureModel();
    const skill = toWorkspaceSkill(
      '---\nname: workspace-fixture\ndescription: Workflow fixture.\ndisable-model-invocation: true\n---\nSynthetic workflow approval marker 715.',
    );
    await workspace.addSkill(skill);
    await workspace.setSkillEnabled(skill.name, true);
    const tab = await openPanelTab();
    try {
      const message = 'Use /workspace-fixture to read the example.';
      await scriptReplies([
        { toolCalls: [{ name: 'list_skills', input: {} }] },
        { toolCalls: [{ name: 'read_skill', input: { name: skill.name } }] },
        { text: 'I checked the active workspace skill.' },
      ]);
      await panel(tab.id!, 'type-send', { text: message });
      await waitForText(tab.id!, 'I checked the active workspace skill.');
      const [chat] = await listConversations(message);
      const results =
        chat && (await getEntries(chat.id)).flatMap(entry => (entry.type === 'message' ? entry.message.parts : []));
      if (
        !results?.some(
          part =>
            part.type === 'tool-result' &&
            part.toolName === 'read_skill' &&
            !part.isError &&
            part.text.includes('approval marker 715'),
        )
      ) {
        throw new Error('The enabled skill was not loaded by the agent.');
      }
      return { enabledManualSkillRead: true };
    } finally {
      await workspace.setSkillEnabled(skill.name, false);
      await chrome.tabs.remove(tab.id!);
    }
  },
});

defineCheck({
  name: 'workspace-protected-actions',
  title: 'Workspace destructive dialog protection',
  description: 'Checks the product agent against an ordinary browser confirmation on a fixture page.',
  async run() {
    const { controller } = await layer();
    const session = createAgentSession(controller, { decideWrite: () => ({ decision: 'run', canRemember: false }) });
    const tab = await openTab(FIXTURE_ORIGIN + '/c-dialogs.html');
    session.shareTab(tab.id!);
    try {
      await session.call('snapshot', { tabId: tab.id });
      await session.call('click', { tabId: tab.id, target: { role: 'button', name: 'Ask confirm' } });
      const refused = await session.call('handle_dialog', { tabId: tab.id, accept: true });
      if (refused.error?.code !== 'CAPABILITY_DISABLED')
        throw new Error('The destructive confirmation was not blocked.');
      const dismissed = await session.call('handle_dialog', { tabId: tab.id, accept: false });
      if (!dismissed.ok) throw new Error('The confirmation could not be dismissed.');
      const shortcuts = await chrome.commands.getAll();
      if (
        !shortcuts.some(command => command.name === 'open-activity') ||
        !shortcuts.some(command => command.name === 'open-activity-window')
      ) {
        throw new Error('The activity commands are not registered.');
      }
      return { destructiveDialogBlocked: true, dismissAvailable: true, activityCommandsRegistered: true };
    } finally {
      await controller.closeSession(session);
      await chrome.tabs.remove(tab.id!);
    }
  },
});

defineCheck({
  name: 'workspace-milestone',
  title: 'Workspace milestone in a live run',
  description:
    'Runs 101 tools from the side panel with the regular run cap set to one and checks the recorded milestone.',
  async run() {
    const previous = await chrome.storage.local.get(['nb.settings', 'nb.providers', WORKSPACE_POLICY_KEY]);
    let tab: chrome.tabs.Tab | undefined;
    try {
      await seedFixtureModel();
      const storage = await chrome.storage.local.get('nb.settings');
      await chrome.storage.local.set({ 'nb.settings': { ...(storage['nb.settings'] as object), turnCap: 1 } });
      await updateWorkspacePolicy({ ...DEFAULT_WORKSPACE_POLICY, unlimited: true });
      await scriptReplies([
        ...Array.from({ length: 101 }, () => ({ toolCalls: [{ name: 'list_workspace_folders', input: {} }] })),
        { text: 'Finished the 101 operations.' },
      ]);
      tab = await openPanelTab();
      const message = 'Run the Workspace milestone test';
      await panel(tab.id!, 'type-send', { text: message });
      await waitForText(tab.id!, 'Finished the 101 operations.', 60_000);
      const [conversation] = await listConversations(message);
      if (!conversation) throw new Error('The Workspace fixture conversation is missing.');
      const entries = await getEntries(conversation.id);
      const notices = entries.filter(
        e => e.type === 'ui' && e.kind === 'notice' && JSON.stringify(e.data).includes('100 pasos registrados'),
      );
      const steps = entries
        .flatMap(e => (e.type === 'message' ? e.message.parts : []))
        .filter(p => p.type === 'tool-result' && p.toolName === 'list_workspace_folders' && !p.isError);
      const record = await getRun(conversation.id);
      if (notices.length !== 1 || steps.length !== 101 || record?.workspaceActions !== 101) {
        throw new Error(
          'Unexpected activity count: ' +
            JSON.stringify({ notices: notices.length, steps: steps.length, stored: record?.workspaceActions }),
        );
      }
      return { steps: steps.length, milestone: 100, notices: notices.length };
    } finally {
      if (tab?.id !== undefined) await chrome.tabs.remove(tab.id);
      await chrome.storage.local.remove(
        ['nb.settings', 'nb.providers', WORKSPACE_POLICY_KEY].filter(key => !(key in previous)),
      );
      await chrome.storage.local.set(previous);
    }
  },
});

defineCheck({
  name: 'workspace-windows',
  title: 'Windows workspace files',
  description: 'Reads, creates, copies and attaches add-only test files using the registered Windows companion.',
  async run(args) {
    const directory = (args as { directory?: string }).directory;
    if (!directory || !/[/\\]workspace-qa-[a-z0-9-]+$/i.test(directory))
      throw new Error('Supply a dedicated workspace-qa fixture directory.');
    const previous = await chrome.storage.local.get(WORKSPACE_POLICY_KEY);
    try {
      const signal = AbortSignal.timeout(30_000);
      const wrap = (text: string) => text;
      const input = { folderId: 'windows', path: directory };
      const approval = async () => true;
      const read = (path: string) => fileAction('read_workspace_file', { ...input, path }, approval, wrap, signal);
      const source = directory + '\\original.txt';
      const original = 'Contenido de prueba original.';
      const rejected = async () => false;
      await updateWorkspacePolicy({ ...DEFAULT_WORKSPACE_POLICY, access: 'ask' });
      const denied = await fileAction('browse_workspace', input, rejected, wrap, signal).then(
        () => false,
        () => true,
      );
      if (!denied) throw new Error('A declined Windows path was opened.');
      await updateWorkspacePolicy({ ...DEFAULT_WORKSPACE_POLICY, access: 'full', actions: 'auto' });
      const hello = await nativeRequest<{ version: number }>({ op: 'hello' }, signal);
      const listing = await fileAction('browse_workspace', input, approval, wrap, signal);
      if (hello.version !== 1 || !listing.text.includes('original.txt'))
        throw new Error('The fixture did not appear in the folder.');
      if (!(await read(source)).text.includes(original)) throw new Error('The expected text was not read.');
      const collision = await fileAction(
        'save_workspace_file',
        { ...input, path: source, content: 'Segunda versión.' },
        approval,
        wrap,
        signal,
      );
      if (!collision.text.includes('original (') || !(await read(source)).text.includes(original))
        throw new Error('The original file changed.');
      const copied = await fileAction(
        'copy_workspace_file',
        { ...input, path: directory + '\\Enviados\\copia.txt', sourceId: 'workspace:windows:' + source },
        approval,
        wrap,
        signal,
      );
      const written = JSON.parse(copied.text.split('\n').at(-1) ?? '{}') as { path?: string };
      if (!written.path?.startsWith(directory + '\\Enviados\\') || !(await read(written.path)).text.includes(original))
        throw new Error('The copy is missing or differs.');
      const found = await fileAction('search_workspace', { ...input, query: 'copia' }, approval, wrap, signal);
      const matches = JSON.parse(found.text) as { entries: { path: string }[] };
      if (!matches.entries.some(item => item.path === written.path))
        throw new Error('Recursive search missed a nested file.');
      const attachments = [await resolveWorkspaceUpload('workspace:windows:' + source, approval, signal)];
      const { controller } = await layer();
      const session = controller.createSession({ capabilities: ['files'], confirm: 'never' });
      const tab = await openTab(FIXTURE_ORIGIN + '/u-upload.html');
      session.shareTab(tab.id!);
      try {
        const snapshot = await session.call('snapshot', { tabId: tab.id! });
        const ref = /\[(\w+)\][^\n]*Document/.exec(snapshot.page?.snapshot ?? snapshot.text)?.[1];
        if (!ref) throw new Error('The fixture file input was missing.');
        const upload = await session.call('upload', { tabId: tab.id!, target: { ref }, attachments });
        if (!upload.ok || upload.receipt?.postcondition?.status !== 'met') throw new Error(upload.text);
        const tracker = new PageDownloads();
        const start = Date.now();
        const click = await session.call('click', {
          tabId: tab.id!,
          target: { role: 'link', name: 'Download receipt' },
        });
        const observed = tracker.observe(click, start);
        const downloadRef = /downloadRef ([a-f0-9-]{36})/.exec(observed.text)?.[1];
        if (!downloadRef) throw new Error('Missing page download receipt: ' + observed.text.slice(0, 300));
        const archived = await tracker.archive(
          { downloadRef, folderId: 'windows', path: directory + '\\Comprobantes\\recibido.txt' },
          approval,
          wrap,
          signal,
          () => false,
        );
        const archivedPath = JSON.parse(archived.text.split('\n').at(-1)!).path;
        if (!(await read(archivedPath)).text.includes('A file the fixture server sent: workspace-site-receipt.txt'))
          throw new Error('Archived download did not contain the server bytes.');
        const automatic = await tracker.archive({ downloadRef }, approval, wrap, signal, () => false);
        const automaticPath = JSON.parse(automatic.text.split('\n').at(-1)!).path;
        if (
          !automaticPath.includes('\\NanobrowserWorkspace\\TestRuns\\Downloads\\') ||
          !(await read(automaticPath)).text.includes('A file the fixture server sent: workspace-site-receipt.txt')
        )
          throw new Error('Automatic download filing did not retain the server bytes.');
        const submitted = await session.call('click', {
          tabId: tab.id!,
          target: { role: 'button', name: 'Send document' },
        });
        if (!submitted.ok) throw new Error(submitted.text);
        const received = (await (await fetch(FIXTURE_ORIGIN + '/__requests')).json()) as {
          posts: { body: string; at: string }[];
        };
        if (
          !received.posts.some(
            post =>
              Date.parse(post.at) >= start &&
              post.body.includes('filename="original.txt"') &&
              post.body.includes(original),
          )
        )
          throw new Error('The portal did not receive the original file bytes.');
        return {
          windows: hello.version,
          deniedPath: denied,
          originalPreserved: true,
          copyVerified: true,
          recursiveSearch: true,
          portalReceivedOriginal: true,
          downloadedBytesVerifiedAtDestination: true,
          automaticDestinationVerified: true,
          upload: upload.receipt.postcondition,
        };
      } finally {
        await controller.closeSession(session);
        await chrome.tabs.remove(tab.id!);
      }
    } finally {
      if (WORKSPACE_POLICY_KEY in previous) await chrome.storage.local.set(previous);
      else await chrome.storage.local.remove(WORKSPACE_POLICY_KEY);
    }
  },
});
