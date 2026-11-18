import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionDecision, fileAction } from '../workspace-actions';
import { pathParts } from '../workspace-files';
import { connectorEndpoint, withConnector } from '@src/store/mcp';
import { googleCall } from '@src/store/google-workspace';
import { DEFAULT_WORKSPACE_POLICY, WORKSPACE_POLICY_KEY, patchWorkspacePolicy } from '@src/store/workspace';
import type { Connector } from '@src/store/workspace';

afterEach(() => vi.unstubAllGlobals());

describe('Workspace permissions', () => {
  it('blocks detected deletion in every mode and confines picker paths to the authorized folder', () => {
    for (const actions of ['chat', 'auto', 'send', 'groups'] as const) {
      expect(
        actionDecision(
          { ...DEFAULT_WORKSPACE_POLICY, actions },
          { category: 'delete', site: 'example.com', tabId: 1 },
          { decision: 'run', canRemember: true },
        ).decision,
      ).toBe('block');
    }
    for (const path of ['../secret.txt', 'C:/secret.txt', 'a/con.txt', 'a/b:secret', 'a//b', 'a\\b']) {
      expect(() => pathParts(path, false)).toThrow();
    }
    expect(pathParts('Informes/año.txt', false)).toEqual(['Informes', 'año.txt']);
  });

  it('forces a card for a send and respects group settings', () => {
    const old = { decision: 'run', canRemember: true, by: 'site-rule' } as const;
    const request = { category: 'upload', site: 'example.com', tabId: 1 } as const;
    expect(actionDecision({ ...DEFAULT_WORKSPACE_POLICY, actions: 'send' }, request, old).decision).toBe('ask');
    expect(
      actionDecision(
        { ...DEFAULT_WORKSPACE_POLICY, actions: 'send' },
        { ...request, category: 'submit', target: 'Continue' },
        old,
      ).decision,
    ).toBe('ask');
    expect(
      actionDecision({ ...DEFAULT_WORKSPACE_POLICY, actions: 'groups', transfers: false }, request, old).decision,
    ).toBe('run');
  });

  it('asks before a local write in a chat set to ask and serializes independent settings changes', async () => {
    let saved = { [WORKSPACE_POLICY_KEY]: { ...DEFAULT_WORKSPACE_POLICY, access: 'full' } };
    const native = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { connectNative: native },
      storage: {
        local: {
          get: async () => structuredClone(saved),
          set: async (patch: typeof saved) => {
            saved = patch;
          },
        },
      },
    });
    const approval = vi.fn().mockResolvedValue(false);
    await expect(
      fileAction(
        'save_workspace_file',
        { folderId: 'windows', path: 'C:/Test/copy.txt', content: 'test' },
        approval,
        text => text,
        new AbortController().signal,
      ),
    ).rejects.toThrow('declined');
    expect(approval).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
    await Promise.all([patchWorkspacePolicy({ access: 'folders' }), patchWorkspacePolicy({ unlimited: true })]);
    expect(saved[WORKSPACE_POLICY_KEY]).toMatchObject({ access: 'folders', unlimited: true });
  });
});

describe('Workspace connectors', () => {
  it('negotiates a session, discovers safe tools and reads a streamed result', async () => {
    const mock = vi.fn(async (_: string, options: RequestInit) => {
      if (options.method === 'DELETE') return new Response(null, { status: 204 });
      const request = JSON.parse(String(options.body));
      const result = (data: unknown) => ({ jsonrpc: '2.0', id: request.id, result: data });
      if (request.method === 'initialize')
        return Response.json(result({ protocolVersion: '2025-06-18' }), { headers: { 'Mcp-Session-Id': 'fixture' } });
      expect((options.headers as Headers).get('mcp-session-id')).toBe('fixture');
      expect(options.redirect).toBe('error');
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.method === 'tools/list') {
        return Response.json(
          result({
            tools: [
              { name: 'list_reports', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
              { name: 'delete_report', annotations: { readOnlyHint: true }, inputSchema: { type: 'object' } },
              { name: 'undocumented_action', inputSchema: { type: 'object' } },
            ],
          }),
        );
      }
      return new Response('data: ' + JSON.stringify(result({ content: [{ type: 'text', text: 'report' }] })) + '\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', mock);
    expect(() => connectorEndpoint('http://example.com/mcp')).toThrow();
    const output = await withConnector(
      { endpoint: 'https://example.com/mcp', token: 'test-token' },
      new AbortController().signal,
      async client => {
        const tools = await client.list();
        expect(tools.map(t => t.name)).toEqual(['list_reports']);
        return client.call('list_reports', {});
      },
    );
    expect(output).toEqual([{ type: 'text', text: 'report' }]);
    expect(mock.mock.calls.at(-1)?.[1].method).toBe('DELETE');
  });

  it('uses only the catalogued read-only tools in a generic connector', async () => {
    const mock = vi.fn(async (_: string, options: RequestInit) => {
      const request = JSON.parse(String(options.body));
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result:
          request.method === 'initialize'
            ? { protocolVersion: '2025-06-18' }
            : {
                tools: [
                  { name: 'read_record', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
                  { name: 'create_record', inputSchema: { type: 'object' }, annotations: { destructiveHint: false } },
                ],
              },
      });
    });
    vi.stubGlobal('fetch', mock);
    await withConnector(
      { endpoint: 'https://example.com/mcp', token: '' },
      new AbortController().signal,
      async client => {
        const tools = await client.list();
        expect(tools.map(tool => tool.name)).toEqual(['read_record']);
        await expect(client.call('create_record', {})).rejects.toThrow('unavailable');
      },
    );
    expect(mock.mock.calls).toHaveLength(3);
  });

  it('prepares new mail for Google and refuses a delete operation', async () => {
    const mock = vi.fn().mockResolvedValue(Response.json({ id: 'test-message' }));
    vi.stubGlobal('fetch', mock);
    const connector: Connector = {
      id: 'fixture',
      kind: 'gmail',
      name: 'test',
      endpoint: 'https://example.com',
      token: 'test-token',
      enabled: true,
      tools: ['send_message', 'delete_message'],
    };
    const signal = new AbortController().signal;
    await expect(googleCall(connector, 'delete_message', { id: 'old' }, signal)).rejects.toThrow();
    await googleCall(connector, 'send_message', { to: 'example@example.com', subject: 'Test', body: 'Body' }, signal);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect(mock.mock.calls[0][1].method).toBe('POST');
  });
});
