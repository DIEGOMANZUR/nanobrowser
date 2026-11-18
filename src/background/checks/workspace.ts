import { fileAction, resolveWorkspaceUpload } from '@src/extension/workspace-actions';
import { getEntries, getRun, listConversations } from '@src/store/conversations';
import { nativeRequest } from '@src/store/native-workspace';
import { DEFAULT_WORKSPACE_POLICY, updateWorkspacePolicy } from '@src/store/workspace';
import { FIXTURE_ORIGIN } from '../fixtures-config';
import { defineCheck } from './registry';
import { layer } from '../layer';
import { openTab } from '../tabs';
import { openPanelTab, panel, scriptReplies, seedFixtureModel, waitForText } from './panel-chat';

defineCheck({
  name: 'workspace-milestone',
  title: 'Workspace milestone in a live run',
  description:
    'Runs 101 tools from the side panel with the regular run cap set to one and checks the recorded milestone.',
  async run() {
    await seedFixtureModel();
    const storage = await chrome.storage.local.get('nb.settings');
    await chrome.storage.local.set({ 'nb.settings': { ...(storage['nb.settings'] as object), turnCap: 1 } });
    await updateWorkspacePolicy({ ...DEFAULT_WORKSPACE_POLICY, unlimited: true });
    await scriptReplies([
      ...Array.from({ length: 101 }, () => ({ toolCalls: [{ name: 'list_workspace_folders', input: {} }] })),
      { text: 'Finished the 101 operations.' },
    ]);
    const tab = await openPanelTab();
    try {
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
      await chrome.tabs.remove(tab.id!);
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
    await updateWorkspacePolicy({ ...DEFAULT_WORKSPACE_POLICY, access: 'full' });
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
    if (
      !copied.text.includes('copia.txt') ||
      !(await read(directory + '\\Enviados\\copia.txt')).text.includes(original)
    )
      throw new Error('The copy is missing or differs.');
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
      return {
        windows: hello.version,
        deniedPath: denied,
        originalPreserved: true,
        copyVerified: true,
        upload: upload.receipt.postcondition,
      };
    } finally {
      await controller.closeSession(session);
      await chrome.tabs.remove(tab.id!);
    }
  },
});
